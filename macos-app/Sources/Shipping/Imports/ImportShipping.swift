import DeviceFiles
import Evidence
import Foundation
import HomeLink

public struct ImportRoom: Sendable {
    public let onPower: @Sendable () -> Bool
    public let disk: Volume
    public let homeFree: @Sendable () -> Int64?

    public static let batteryBytes: Int64 = 1_000_000_000

    public init(onPower: @escaping @Sendable () -> Bool, disk: Volume, homeFree: @escaping @Sendable () -> Int64?) {
        self.onPower = onPower
        self.disk = disk
        self.homeFree = homeFree
    }
}

public struct ImportTold: Sendable {
    public let changed: @Sendable () -> Void
    public let sent: @Sendable (_ id: String, _ bytes: Int64) -> Void

    public init(changed: @escaping @Sendable () -> Void, sent: @escaping @Sendable (_ id: String, _ bytes: Int64) -> Void) {
        self.changed = changed
        self.sent = sent
    }

    public static let nobody = ImportTold(changed: {}, sent: { _, _ in })
}

final class UploadLane: ShippingDomain {
    let sourceId: String
    let name = "upload"
    let folder: UploadDomain?
    let imports: ImportShipping?

    init(sourceId: String, folder: UploadDomain?, imports: ImportShipping?) {
        self.sourceId = sourceId
        self.folder = folder
        self.imports = imports
    }

    var behindLive: Bool { imports != nil }
    var owes: Bool { imports?.owes ?? false }
    var unsettled: Bool { folder?.unsettled ?? false }

    func seal(_ request: SealRequest) throws -> [SealedBundle] {
        var sealed = try folder?.seal(request) ?? []
        guard let imports else { return sealed }
        let after = SealRequest(fetchedAt: request.fetchedAt.addingTimeInterval(0.001 * Double(sealed.count)),
                                workDirectory: request.workDirectory, scratch: request.scratch,
                                custody: SealCustody(pass: request.custody.pass, received: request.custody.received + sealed.count,
                                                     imported: request.custody.imported),
                                held: request.held, admitted: request.admitted)
        do {
            if let bundle = try imports.seal(after, received: request.custody.received) { sealed.append(bundle) }
        } catch where !sealed.isEmpty {
            ShippingState.log.error("imports: no file sealed beside the drop folder's bundle: \(ShipperRunRow.reason(error), privacy: .public)")
        }
        return sealed
    }

    func applied(_ answer: FreshAnswer) {
        folder?.applied(answer)
        imports?.applied(answer)
    }

    func holds(_ bundle: SealedBundle) -> Bool {
        bundle.sidecar.kind == ImportShipping.kind && imports?.holds(bundle) == true
    }

    func moved(_ bundle: SealedBundle, sent bytes: Int64) {
        guard bundle.sidecar.kind == ImportShipping.kind else { return }
        imports?.moved(bundle, sent: bytes)
    }

    func taken(_ bundle: SealedBundle, answer: FreshAnswer) {
        guard bundle.sidecar.kind == ImportShipping.kind else { return }
        imports?.applied(answer)
    }

    func kept(_ bundles: [SealedBundle]) {
        imports?.kept(bundles.filter { $0.sidecar.kind == ImportShipping.kind })
    }
}

struct ImportShipping: Sendable {
    static let kind = "import"
    static let feeder = "import-mac"

    let sourceId: String
    let ledger: ImportLedger
    let ledgers: Ledgers
    let room: ImportRoom
    var told: ImportTold = .nobody

    var owes: Bool {
        guard let contents = try? ledger.read() else { return false }
        return contents.files.contains { $0.state == .waiting && $0.why == .turn || $0.state == .sending && $0.seal == nil }
    }

    func seal(_ request: SealRequest, received: Int) throws -> SealedBundle? {
        let custody = request.custody
        let held = try held(request)
        while let file = try choose(request, received: received, held: held) {
            if let digest = admitted(file, request) {
                try ledger.change { contents in
                    guard let at = contents.files.firstIndex(where: { $0.id == file.id && $0.state == .sending }) else { return }
                    contents.files[at].state = .already
                    contents.files[at].why = nil
                    contents.files[at].sha256 = digest
                }
                continue
            }
            guard let written = try write(file, request: request, held: held) else {
                try ledger.change { contents in
                    guard let at = contents.files.firstIndex(where: { $0.id == file.id }) else { return }
                    contents.files[at].state = .missing
                    contents.files[at].why = nil
                }
                continue
            }
            let upload = ledgers.ledger(HashEntry.self, pass: custody.pass, source: sourceId)
            try upload.record(HashEntry(mark: nil, hashes: [written.hash]), at: custody.seal)
            try ledger.change { contents in
                guard let at = contents.files.firstIndex(where: { $0.id == file.id }) else { return }
                contents.files[at].sha256 = written.hash
                contents.files[at].seal = custody.seal
                contents.files[at].pass = custody.pass
                if file.blobs != nil { contents.files[at].bundle = written.bundleBytes }
            }
            return written.bundle
        }
        return nil
    }

    private func held(_ request: SealRequest) throws -> Set<String> {
        let named = Set(try ledger.read().files.filter(\.unsent).flatMap { ($0.blobs ?? []).map(\.sha256) })
        return named.isEmpty ? [] : request.held(named).intersection(named)
    }

    func kept(_ bundles: [SealedBundle]) {
        guard !bundles.isEmpty else { return }
        try? ledger.change { contents in
            for bundle in bundles {
                guard let at = contents.files.firstIndex(where: {
                    $0.backup != nil && $0.seal == bundle.sidecar.seal && $0.pass == bundle.sidecar.pass
                }) else { continue }
                contents.files[at].bundled = true
            }
        }
    }

    private func choose(_ request: SealRequest, received: Int, held: Set<String>) throws -> ImportLedger.Record? {
        let custody = request.custody
        return try ledger.change { contents -> ImportLedger.Record? in
            for index in contents.files.indices {
                guard let seal = contents.files[index].seal else { continue }
                if contents.files[index].pass == custody.pass, seal <= received {
                    contents.files[index].state = .sent
                    contents.files[index].why = nil
                    continue
                }
                contents.files[index].seal = nil
                contents.files[index].pass = nil
                contents.files[index].bundled = nil
                if contents.files[index].state == .sent {
                    contents.files[index].state = .waiting
                    contents.files[index].why = .turn
                }
            }
            for index in contents.files.indices {
                var file = contents.files[index]
                defer { contents.files[index] = file }
                guard file.unsent else { continue }
                guard let now = ImportFiles.stamp(URL(fileURLWithPath: file.path), kept: ledger.kept(file)), now.bytes == file.bytes,
                      abs(now.modified.timeIntervalSince(file.modified)) < 1 else {
                    file.state = .missing
                    file.why = nil
                    continue
                }
                if let blobs = file.blobs {
                    file.bundle = file.bytes + blobs.filter { !held.contains($0.sha256) }.reduce(0) { $0 + $1.bytes }
                }
                if let wait = wait(for: file) {
                    file.state = .waiting
                    file.why = wait
                    continue
                }
                file.state = .sending
                file.why = nil
                file.seal = nil
                file.pass = nil
                file.bundled = nil
                return file
            }
            return nil
        }
    }

    func applied(_ answer: FreshAnswer) {
        guard let custody = answer.sources[sourceId] else { return }
        try? ledger.change { contents in
            for index in contents.files.indices where contents.files[index].state != .sent {
                guard let seal = contents.files[index].seal, contents.files[index].pass == answer.pass, seal <= custody.received else { continue }
                contents.files[index].state = .sent
                contents.files[index].why = nil
            }
        }
    }

    func holds(_ bundle: SealedBundle) -> Bool {
        let held = !room.onPower() && (try? ledgers.files.size(of: bundle.file)).map { Int64($0) > ImportRoom.batteryBytes } == true
        try? ledger.change { contents in
            guard let at = contents.files.firstIndex(where: { $0.seal == bundle.sidecar.seal && $0.pass == bundle.sidecar.pass }),
                  contents.files[at].unsent else { return }
            contents.files[at].state = held ? .waiting : .sending
            contents.files[at].why = held ? .battery : nil
        }
        return held
    }

    func moved(_ bundle: SealedBundle, sent bytes: Int64) {
        guard let record = (try? ledger.read())?.files.first(where: {
            $0.seal == bundle.sidecar.seal && $0.pass == bundle.sidecar.pass && $0.state == .sending
        }) else { return }
        told.sent(record.id, bytes)
    }


    private func admitted(_ file: ImportLedger.Record, _ request: SealRequest) -> String? {
        guard let digest = file.sha256 ?? ImportFiles.digest(URL(fileURLWithPath: file.path), kept: ledger.kept(file)) else { return nil }
        return request.admitted(file.kind, digest) ? digest : nil
    }


    private func wait(for file: ImportLedger.Record) -> ImportLedger.Why? {
        let bytes = file.waitBytes
        if bytes > ImportRoom.batteryBytes, !room.onPower() { return .battery }
        if !room.disk.fits(.later, bytes: bytes) { return .macRoom }
        if let free = room.homeFree(), !Room.fits(.later, bytes: 2 * bytes, free: free) { return .homeRoom }
        return nil
    }


    private struct Written {
        let bundle: SealedBundle
        let hash: String
        let bundleBytes: Int64
    }

    private func write(_ file: ImportLedger.Record, request: SealRequest, held: Set<String>) throws -> Written? {
        let url = URL(fileURLWithPath: file.path)
        let kept = ledger.kept(file)
        guard let members = try? ImportFiles.members(of: url) else { return nil }
        let index = JSONText.object([("format", .string(UploadDomain.indexFormat)), ("files", .array(members.map { member in
            var fields: [(String, JSONText)] = [("path", .string(member.locator))]
            if let type = UploadDomain.mediaType(member.locator) { fields.append(("media_type", .string(type))) }
            fields.append(("created_at", .string(UTCInstant.rfc3339(member.created))))
            fields.append(("modified_at", .string(UTCInstant.rfc3339(member.modified))))
            return .object(fields)
        }))]).data + Data("\n".utf8)
        let facts: [(String, JSONText)] = [("import", .object([("kind", .string(file.kind))])), HistoryPage.fact]
        let blobs = (file.blobs ?? []).map { blob in
            BundleWriter.Blob(sha256: blob.sha256, file: FileManager.default.fileExists(atPath: blob.path) ? URL(fileURLWithPath: blob.path) : nil,
                              kept: kept != nil)
        }
        let written = try BundleWriter.write(
            into: request.workDirectory, sourceId: sourceId, feeder: Self.feeder, fetchedAt: request.fetchedAt,
            files: [BundleWriter.File(name: UploadDomain.indexName, content: .bytes(index))]
                + members.map { BundleWriter.File(name: UploadDomain.filesPrefix + $0.locator, content: kept == nil ? .file($0.file) : .kept($0.file)) },
            blobs: blobs, held: { held.intersection($0) }, facts: facts, custody: (request.custody, []), through: ledgers.files)
        guard let after = ImportFiles.stamp(url, kept: kept), after.bytes == file.bytes, abs(after.modified.timeIntervalSince(file.modified)) < 1 else {
            try? FileManager.default.removeItem(at: written.file)
            return nil
        }
        let copied = written.files.filter { $0.name.hasPrefix(UploadDomain.filesPrefix) }
        let hash = members.count == 1 && members[0].file == url ? copied[0].sha256 : ImportFiles.folderHash(copied.map {
            (String($0.name.dropFirst(UploadDomain.filesPrefix.count)), $0.sha256)
        })
        let carried = Set(written.carried)
        let carriedBytes = (file.blobs ?? []).filter { carried.contains($0.sha256) }.reduce(Int64(0)) { $0 + $1.bytes }
        return Written(bundle: SealedBundle(file: written.file, sidecar: BundleSidecar(id: written.id, sourceId: sourceId,
                                                                                       custody: request.custody, kind: Self.kind, write: .later)),
                       hash: hash, bundleBytes: file.bytes + carriedBytes)
    }
}

public enum ImportFiles {
    public static let doorMost: Int64 = 64 << 30

    public struct Stamp: Equatable, Sendable {
        public let bytes: Int64
        public let modified: Date
    }

    struct Member {
        let locator: String
        let file: URL
        let created: Date
        let modified: Date
    }

    public static func stamp(_ url: URL, kept: DeviceFiles?) -> Stamp? {
        var isFolder: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isFolder) else { return nil }
        if !isFolder.boolValue {
            let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            guard let modified = values?.contentModificationDate else { return nil }
            guard let kept else { return Stamp(bytes: Int64(values?.fileSize ?? 0), modified: modified) }
            guard let bytes = try? kept.size(of: url) else { return nil }
            return Stamp(bytes: Int64(bytes), modified: modified)
        }
        var bytes: Int64 = 0
        var newest = Date.distantPast
        for member in (try? members(of: url)) ?? [] {
            if let kept {
                guard let size = try? kept.size(of: member.file) else { return nil }
                bytes += Int64(size)
            } else {
                bytes += Int64(FileFacts.regularFileSize(member.file.path) ?? 0)
            }
            newest = max(newest, member.modified)
        }
        return Stamp(bytes: bytes, modified: newest)
    }

    public static func check(_ url: URL, bytes: Int64, modified: Date, against kind: ImportCheck, most: Int64, bundle: Int64? = nil,
                             kept: DeviceFiles?) -> (state: ImportLedger.State, why: ImportLedger.Why?) {
        guard let now = stamp(url, kept: kept), now.bytes == bytes, abs(now.modified.timeIntervalSince(modified)) < 1 else { return (.missing, nil) }
        guard (bundle ?? bytes) <= most else { return (.refused, .tooLarge) }
        guard let listing = try? ImportListing.of(url) else { return (.refused, .damaged) }
        if MemberPattern.any(kind.recognise, in: listing.members) { return (.waiting, .turn) }
        if MemberPattern.any(kind.leaves, in: listing.members) { return (.refused, .nothingRead) }
        if let root = kind.root, MemberPattern.any([root.hasSuffix("/") ? root + "**" : root + "/**"], in: listing.members) {
            return (.refused, .nothingRead)
        }
        return (.refused, .notThisKind)
    }

    static func members(of url: URL) throws -> [Member] {
        var isFolder: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isFolder) else { throw ImportListingError.unlisted(url.lastPathComponent) }
        func member(_ locator: String, _ file: URL) -> Member {
            let values = try? file.resourceValues(forKeys: [.creationDateKey, .contentModificationDateKey])
            let modified = values?.contentModificationDate ?? Date(timeIntervalSince1970: 0)
            return Member(locator: locator, file: file, created: values?.creationDate ?? modified, modified: modified)
        }
        guard isFolder.boolValue else { return [member(url.lastPathComponent, url)] }
        guard let walk = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles]) else {
            throw ImportListingError.unlisted(url.lastPathComponent)
        }
        let base = url.standardizedFileURL.pathComponents.count
        var found: [Member] = []
        for case let file as URL in walk where (try? file.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true {
            let locator = ([url.lastPathComponent] + file.standardizedFileURL.pathComponents.dropFirst(base)).joined(separator: "/")
            guard UploadDomain.listable(locator) else { continue }
            found.append(member(locator, file))
        }
        return found.sorted { JSONText.javaScriptOrder($0.locator, $1.locator) }
    }

    static func digest(_ url: URL, kept: DeviceFiles?) -> String? {
        func measure(_ file: URL) throws -> (sha256: String, bytes: Int) {
            guard let kept else { return try FileChunks.measure(file) }
            return try FileChunks.measure(file, through: kept)
        }
        guard let members = try? members(of: url) else { return nil }
        if members.count == 1, members[0].file == url { return try? measure(url).sha256 }
        var hashes: [(String, String)] = []
        for member in members {
            guard let measured = try? measure(member.file) else { return nil }
            hashes.append((member.locator, measured.sha256))
        }
        return folderHash(hashes)
    }

    static func folderHash(_ members: [(String, String)]) -> String {
        var digest = StreamDigest()
        for (path, hash) in members.sorted(by: { JSONText.javaScriptOrder($0.0, $1.0) }) {
            digest.update(Data("\(path)\t\(hash)\n".utf8))
        }
        return digest.hex()
    }
}
