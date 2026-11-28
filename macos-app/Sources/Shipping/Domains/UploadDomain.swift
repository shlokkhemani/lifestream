import Darwin
import Evidence
import Foundation
import HomeLink
import UniformTypeIdentifiers

public final class UploadDomain: ShippingDomain {
    static let feeder = "upload-folder"
    static let indexName = "upload.json"
    static let indexFormat = "org.lifestreamprotocol.upload/1"
    static let filesPrefix = "files/"
    public static let folderNameKey = "uploadFolderName"
    public static let defaultFolderName = "Lifestream Drop"
    static let settle: TimeInterval = 3
    public static let defaultBundleBytes = 4 << 30
    static let partialSuffixes = [".download", ".crdownload", ".part", ".partial"]

    public let sourceId: String
    public let name = "upload"
    let folder: URL
    let hashCache: URL
    let bundleBytes: Int
    let disk: Volume
    let ledgers: Ledgers
    private let sealedUnsettled = SealNote(false)

    public init(sourceId: String, folder: URL, hashCache: URL, ledgers: Ledgers, bundleBytes: Int = UploadDomain.defaultBundleBytes,
                disk: Volume) {
        self.ledgers = ledgers
        self.sourceId = sourceId
        self.folder = folder
        self.hashCache = hashCache
        self.bundleBytes = bundleBytes
        self.disk = disk
    }

    public static func folder(home: URL = FileManager.default.homeDirectoryForCurrentUser,
                              defaults: UserDefaults = .standard) -> URL {
        let stated = defaults.string(forKey: folderNameKey)?.trimmingCharacters(in: .whitespaces)
        let name = (stated?.isEmpty ?? true) ? defaultFolderName : stated!
        return home.appendingPathComponent(name, isDirectory: true)
    }

    @discardableResult
    public static func drop(_ file: URL, into folder: URL) throws -> URL {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let stem = file.deletingPathExtension().lastPathComponent
        let suffix = file.pathExtension.isEmpty ? "" : "." + file.pathExtension
        var target = folder.appendingPathComponent(file.lastPathComponent)
        var number = 2
        while FileManager.default.fileExists(atPath: target.path) {
            target = folder.appendingPathComponent("\(stem) \(number)\(suffix)")
            number += 1
        }
        try FileManager.default.copyItem(at: file, to: target)
        return target
    }

    public func seal(_ request: SealRequest) throws -> [SealedBundle] {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let ledger = ledgers.ledger(HashEntry.self, pass: request.custody.pass, source: sourceId)
        let shipped = try HashEntry.shipped(ledger, through: request.custody.received)
        var counts = Counts()
        var settling = false
        defer { sealedUnsettled.value = settling }
        var cache = HashCache(file: hashCache, files: ledgers.files)
        var chosen: [Chosen] = []
        var seen: Set<String> = []
        var carrying = 0
        for found in try listing(&counts) {
            guard Self.listable(found.locator) else { counts.unnamed += 1; continue }
            guard let stamp = FileFacts.of(found.file.path),
                  request.fetchedAt.timeIntervalSince(Self.date(stamp.st_mtimespec)) >= Self.settle else {
                counts.unsettled += 1
                settling = true
                continue
            }
            guard let measured = try? cache.measure(locator: found.locator, file: found.file) ?? nil else {
                counts.unreadable += 1
                continue
            }
            guard !shipped.contains(measured.sha256), seen.insert(measured.sha256).inserted else { continue }
            if !chosen.isEmpty && carrying + measured.bytes > bundleBytes { counts.waiting += 1; continue }
            guard disk.fits(.later, bytes: Int64(carrying + measured.bytes)) else { counts.noRoom += 1; continue }
            chosen.append(Chosen(locator: found.locator, file: found.file, sha256: measured.sha256,
                                 created: Self.date(stamp.st_birthtimespec), modified: Self.date(stamp.st_mtimespec)))
            carrying += measured.bytes
        }
        try cache.save()

        while !chosen.isEmpty {
            let written: BundleWriter.Written
            do { written = try write(chosen, counts: counts, request: request) } catch BundleWriterError.changed(let name)
                where name.hasPrefix(Self.filesPrefix) {
                let locator = String(name.dropFirst(Self.filesPrefix.count))
                chosen.removeAll { $0.locator == locator }
                counts.unsettled += 1
                settling = true
                continue
            }
            let copied = Dictionary(written.files.map { ($0.name, $0.sha256) }, uniquingKeysWith: { first, _ in first })
            let moved = Set(chosen.filter { copied[Self.filesPrefix + $0.locator] != $0.sha256 }.map(\.locator))
            guard !moved.isEmpty else {
                try ledger.record(HashEntry(mark: nil, hashes: Set(chosen.map(\.sha256)).sorted()), at: request.custody.seal)
                return [SealedBundle(file: written.file, sidecar: BundleSidecar(id: written.id, sourceId: sourceId, custody: request.custody, write: .later))]
            }
            try? FileManager.default.removeItem(at: written.file)
            chosen.removeAll { moved.contains($0.locator) }
            counts.unsettled += moved.count
            settling = true
        }
        return []
    }

    public var unsettled: Bool { sealedUnsettled.value }

    public func applied(_ answer: FreshAnswer) {
        guard let custody = answer.sources[sourceId] else { return }
        try? ledgers.ledger(HashEntry.self, pass: answer.pass, source: sourceId).prune(imported: custody.imported)
    }


    private func write(_ chosen: [Chosen], counts: Counts, request: SealRequest) throws -> BundleWriter.Written {
        let entries = chosen.map { file -> JSONText in
            var members: [(String, JSONText)] = [("path", .string(file.locator))]
            if let type = Self.mediaType(file.locator) { members.append(("media_type", .string(type))) }
            members.append(("created_at", .string(UTCInstant.rfc3339(file.created))))
            members.append(("modified_at", .string(UTCInstant.rfc3339(file.modified))))
            return .object(members)
        }
        let index = JSONText.object([("format", .string(Self.indexFormat)), ("files", .array(entries))]).data + Data("\n".utf8)
        return try BundleWriter.write(
            into: request.workDirectory, sourceId: sourceId, feeder: Self.feeder, fetchedAt: request.fetchedAt,
            files: [BundleWriter.File(name: Self.indexName, content: .bytes(index))]
                + chosen.map { BundleWriter.File(name: Self.filesPrefix + $0.locator, content: .file($0.file)) },
            facts: [("files", .int(chosen.count)), ("unsettled", .int(counts.unsettled)), ("waiting", .int(counts.waiting)),
                    ("unnamed", .int(counts.unnamed)), ("unreadable", .int(counts.unreadable)), ("no_room", .int(counts.noRoom)),
                    ("snapshot_taken_at", .string(UTCInstant.rfc3339(request.fetchedAt)))],
            custody: (request.custody, []), through: ledgers.files)
    }


    private func listing(_ counts: inout Counts) throws -> [(locator: String, file: URL)] {
        guard let walk = FileManager.default.enumerator(atPath: folder.path) else { throw UploadDomainError.unreadable(folder.path) }
        var found: [(String, URL)] = []
        while let path = walk.nextObject() as? String {
            let name = (path as NSString).lastPathComponent
            let type = walk.fileAttributes?[.type] as? FileAttributeType
            if name.hasPrefix(".") {
                if type == .typeDirectory { walk.skipDescendants() }
                continue
            }
            if Self.partialSuffixes.contains(where: { name.lowercased().hasSuffix($0) }) {
                if type == .typeDirectory { walk.skipDescendants() }
                counts.unsettled += 1
                continue
            }
            guard type == .typeRegular else { continue }
            found.append((path, folder.appendingPathComponent(path)))
        }
        return found.sorted { JSONText.javaScriptOrder($0.0, $1.0) }
    }

    static func listable(_ locator: String) -> Bool {
        !locator.contains("\\") && !locator.contains("\0")
            && locator.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }

    static func mediaType(_ locator: String) -> String? {
        let ext = (locator as NSString).pathExtension
        guard !ext.isEmpty else { return nil }
        return UTType(filenameExtension: ext)?.preferredMIMEType
    }

    private static func date(_ time: timespec) -> Date {
        Date(timeIntervalSince1970: TimeInterval(time.tv_sec) + TimeInterval(time.tv_nsec) / 1_000_000_000)
    }

    private struct Chosen {
        let locator: String
        let file: URL
        let sha256: String
        let created: Date
        let modified: Date
    }

    private struct Counts {
        var unsettled = 0
        var waiting = 0
        var unnamed = 0
        var unreadable = 0
        var noRoom = 0
    }
}

enum UploadDomainError: Error, Equatable, CustomStringConvertible {
    case unreadable(String)

    var description: String {
        switch self {
        case .unreadable(let path): return "\(path) cannot be listed"
        }
    }
}
