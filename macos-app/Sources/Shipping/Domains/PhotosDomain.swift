import DeviceFiles
import Evidence
import Foundation
import HomeLink
import PhotoLibrary
import SQLite3

public final class PhotosDomain: ShippingDomain {
    static let feeder = "photos-mac-bundle"
    static let file = "photos.jsonl"
    static let maximumEntries = 20_000
    static let maximumBytes = 256 << 20

    public let sourceId: String
    public let name = "photos"
    public let photos: PhotoSpool
    let ledgers: Ledgers

    public init(sourceId: String, root: URL, ledgers: Ledgers) {
        self.sourceId = sourceId
        photos = PhotoSpool(root: root.appendingPathComponent(ledgers.fileName(forSource: sourceId), isDirectory: true), files: ledgers.files)
        self.ledgers = ledgers
    }

    public func seal(_ request: SealRequest) throws -> [SealedBundle] {
        let ledger = ledgers.ledger(PhotosEntry.self, pass: request.custody.pass, source: sourceId)
        var through = try ledger.newest(through: request.custody.received)?.through ?? 0
        var lines = Data()
        var named = Set<String>()
        var here: [String: URL] = [:]
        var carried = 0
        var bytes = 0
        reading: while carried < Self.maximumEntries {
            let page = try photos.entries(after: through, limit: min(1_000, Self.maximumEntries - carried))
            guard !page.isEmpty else { break }
            for entry in page {
                let line = Data(#"{"kind":"#.utf8) + JSONText.string(entry.kind).data + Data(#","observed_at":"#.utf8)
                    + JSONText.string(entry.observedAt).data + Data(#","payload":"#.utf8) + entry.payload + Data("}\n".utf8)
                let new = Set(entry.blobs).subtracting(named)
                let files = new.compactMap { hex in photos.blob(hex).map { (hex, $0) } }
                let size = line.count + files.reduce(0) { $0 + photos.size(of: $1.1) }
                guard carried == 0 || bytes + size <= Self.maximumBytes else { break reading }
                lines += line
                named.formUnion(new)
                for (hex, file) in files { here[hex] = file }
                bytes += size
                carried += 1
                through = entry.sequence
            }
        }
        guard carried > 0 else { return [] }
        let written = try BundleWriter.write(
            into: request.workDirectory, sourceId: sourceId, feeder: Self.feeder, fetchedAt: request.fetchedAt,
            files: [BundleWriter.File(name: Self.file, content: .bytes(lines))],
            blobs: named.map { BundleWriter.Blob(sha256: $0, file: here[$0], kept: true) }, held: request.held,
            facts: [("entries", .int(carried)), ("snapshot_taken_at", .string(UTCInstant.rfc3339(request.fetchedAt)))],
            custody: (request.custody, []), through: ledgers.files)
        try ledger.record(PhotosEntry(through: through), at: request.custody.seal)
        return [SealedBundle(file: written.file, sidecar: BundleSidecar(id: written.id, sourceId: sourceId, custody: request.custody, write: .later))]
    }

    public func applied(_ answer: FreshAnswer) {
        guard let custody = answer.sources[sourceId] else { return }
        let ledger = ledgers.ledger(PhotosEntry.self, pass: answer.pass, source: sourceId)
        try? ledger.prune(imported: custody.imported)
        let carried: PhotosEntry?
        do { carried = try ledger.newest(through: custody.imported) } catch { return }
        try? photos.sweep(keepingAfter: carried?.through ?? 0)
    }

    public func home(_ answer: FreshAnswer, link: HomeLink, settings: MacSettings) -> PhotoPass.Home {
        let source = sourceId
        let custody = answer.sources[source]
        return PhotoPass.Home(caughtUp: caughtUp(pass: answer.pass, custody: custody), history: custody?.history ?? true,
                              start: settings.start(of: ShippingDomains.connector(of: source, stores: nil)),
                              wanted: { owed in try await link.photosWanted(source: source, owed: owed) })
    }

    public func settled(_ report: PhotoPass.Report?, failing: PhotoPassFailure?, pass: String, link: HomeLink,
                        at now: Date) -> ShipperRunRow? {
        if let stated = report?.stated { state(stated, pass: pass, link: link, at: now) }
        return row(report, failing: failing)
    }

    private func state(_ stated: PhotoPass.Stated, pass: String, link: HomeLink, at now: Date) {
        let months = stated.months.mapValues { Through.Month(items: $0.items, bytes: $0.bytes) }
        let held = link.through(of: sourceId)
        guard held?.left != stated.left || held?.start != stated.start || held?.months != months else { return }
        link.tell(through: Through(readThrough: stated.readThrough, statedAt: max(now, stated.readThrough), left: stated.left,
                                   start: stated.start, months: months),
                  of: sourceId, pass: pass)
    }

    func row(_ report: PhotoPass.Report?, failing: PhotoPassFailure?) -> ShipperRunRow? {
        if let failure = report?.failure {
            return ShipperRunRow(outcome: "refused", code: "LOCAL_ACCESS", message: "\(failure)",
                                 reason: ShipperRunRow.reason(failure), domain: self)
        }
        guard report == nil, let failing else { return nil }
        return ShipperRunRow(outcome: "refused", code: "LOCAL_ACCESS", message: failing.error,
                             reason: "the photo pass waits after \(failing.passes) failed", domain: self)
    }

    func caughtUp(pass: String, custody: Answer.Custody?) -> Bool {
        guard let custody, custody.imported == custody.received, let written = try? photos.lastSequence() else { return false }
        let carried = (try? ledgers.ledger(PhotosEntry.self, pass: pass, source: sourceId)
            .newest(through: custody.imported))??.through ?? 0
        return carried >= written
    }
}

struct PhotosEntry: LedgerEntry {
    var through: Int

    func absorbing(_ older: PhotosEntry) -> PhotosEntry { PhotosEntry(through: max(through, older.through)) }
}

public struct PhotoSpool: PhotoPassStore {
    public let root: URL
    let files: DeviceFiles

    public init(root: URL, files: DeviceFiles) {
        self.root = root
        self.files = files
    }

    var database: URL { root.appendingPathComponent("entries.sqlite") }
    var blobs: URL { root.appendingPathComponent("blobs", isDirectory: true) }
    var stateFile: URL { root.appendingPathComponent("pass.json") }

    static let plainSchema = "CREATE TABLE IF NOT EXISTS entries (sequence INTEGER PRIMARY KEY AUTOINCREMENT, "
        + "replay_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, observed_at TEXT NOT NULL, payload TEXT NOT NULL)"
    static let keyedSchema = "CREATE TABLE IF NOT EXISTS entries (sequence INTEGER PRIMARY KEY AUTOINCREMENT, "
        + "replay_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, observed_at TEXT NOT NULL, payload TEXT NOT NULL, "
        + "asset TEXT NOT NULL, key TEXT NOT NULL); CREATE INDEX IF NOT EXISTS entries_asset ON entries (asset)"

    public func written(prefix: String) async throws -> [PhotoEntry] {
        guard files.keyed else { return try writtenPlain(prefix: prefix) }
        let values = files.values()
        var found: [PhotoEntry] = []
        try reading("SELECT kind, key, observed_at, payload FROM entries WHERE asset = "
                    + "\(SQLiteDelta.literal(files.name(Self.assetPart(of: prefix)))) ORDER BY sequence") { cells in
            guard let kind = cells[0].flatMap(PhotoEntry.Kind.init), let kept = cells[1], let at = cells[2], let payload = cells[3] else {
                throw PhotosDomainError.entry
            }
            let key = try values.decrypt(kept)
            guard key.utf8.starts(with: prefix.utf8) else { return }
            found.append(PhotoEntry(kind: kind, replayKey: key, observedAt: try values.decrypt(at),
                                    payload: Data(try values.decrypt(payload).utf8)))
        }
        return found
    }

    private func writtenPlain(prefix: String) throws -> [PhotoEntry] {
        guard let last = prefix.unicodeScalars.last, let next = UnicodeScalar(last.value + 1) else { return [] }
        let end = String(prefix.unicodeScalars.dropLast()) + String(next)
        var found: [PhotoEntry] = []
        try reading("SELECT kind, replay_key, observed_at, payload FROM entries WHERE replay_key >= \(SQLiteDelta.literal(prefix)) "
                    + "AND replay_key < \(SQLiteDelta.literal(end)) ORDER BY sequence") { cells in
            guard let kind = cells[0].flatMap(PhotoEntry.Kind.init), let key = cells[1], let at = cells[2], let payload = cells[3] else {
                throw PhotosDomainError.entry
            }
            found.append(PhotoEntry(kind: kind, replayKey: key, observedAt: at, payload: Data(payload.utf8)))
        }
        return found
    }

    public func append(_ entries: [PhotoEntry]) async throws -> Int {
        guard !entries.isEmpty else { return 0 }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let keyed = files.keyed
        let values = files.values()
        let handle = try SQLite.open(database, flags: SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)
        defer { sqlite3_close(handle) }
        try SQLite.exec("BEGIN IMMEDIATE", on: handle)
        do {
            try SQLite.exec(keyed ? Self.keyedSchema : Self.plainSchema, on: handle)
            var count = 0
            for entry in entries {
                guard let payload = String(data: entry.payload, encoding: .utf8) else { throw PhotosDomainError.entry }
                let row = keyed
                    ? [files.name(entry.replayKey), entry.kind.rawValue, values.encrypt(entry.observedAt), values.encrypt(payload),
                       files.name(Self.assetPart(of: entry.replayKey)), values.encrypt(entry.replayKey)]
                    : [entry.replayKey, entry.kind.rawValue, entry.observedAt, payload]
                let columns = keyed ? "replay_key, kind, observed_at, payload, asset, key" : "replay_key, kind, observed_at, payload"
                try SQLite.exec("INSERT OR IGNORE INTO entries (\(columns)) VALUES ("
                                + row.map(SQLiteDelta.literal).joined(separator: ", ") + ")", on: handle)
                count += Int(sqlite3_changes(handle))
            }
            try SQLite.exec("COMMIT", on: handle)
            return count
        } catch {
            if sqlite3_get_autocommit(handle) == 0 { try? SQLite.exec("ROLLBACK", on: handle) }
            throw error
        }
    }

    public func store(_ url: URL) async throws -> (hash: String, bytes: UInt64) {
        let measured = try FileChunks.measure(url)
        try FileManager.default.createDirectory(at: blobs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let target = blobs.appendingPathComponent(files.name(measured.sha256))
        if FileFacts.isRegularFile(target.path) {
            try FileManager.default.removeItem(at: url)
        } else {
            try files.place(url, at: target, flush: .data)
        }
        return ("sha256:" + measured.sha256, UInt64(measured.bytes))
    }

    public func readState() -> Data? { (try? files.read(stateFile, maximumBytes: ShippingState.mostKept)) ?? nil }

    public func writeState(_ bytes: Data) throws { try ShippingState.replace(stateFile, with: bytes, files: files) }


    struct Owed {
        let sequence: Int
        let kind: String
        let observedAt: String
        let payload: Data
        let blobs: [String]
    }

    func entries(after sequence: Int, limit: Int) throws -> [Owed] {
        let values = files.values()
        var owed: [Owed] = []
        try reading("SELECT CAST(sequence AS TEXT), kind, observed_at, payload FROM entries WHERE sequence > \(sequence) "
                    + "ORDER BY sequence LIMIT \(limit)") { cells in
            guard let at = cells[0].flatMap(Int.init), let kind = cells[1], let observed = cells[2], let payload = cells[3] else {
                throw PhotosDomainError.entry
            }
            let bytes = Data(try values.decrypt(payload).utf8)
            owed.append(Owed(sequence: at, kind: kind, observedAt: try values.decrypt(observed), payload: bytes,
                             blobs: kind == PhotoEntry.Kind.availability.rawValue ? Self.hashes(in: bytes) : []))
        }
        return owed
    }

    func lastSequence() throws -> Int {
        var last = 0
        try reading("SELECT CAST(coalesce(max(sequence), 0) AS TEXT) FROM entries") { last = $0[0].flatMap(Int.init) ?? 0 }
        return last
    }

    func blob(_ hex: String) -> URL? {
        guard ShippingState.isHexSHA256(hex) else { return nil }
        let file = blobs.appendingPathComponent(files.name(hex))
        return FileFacts.isRegularFile(file.path) ? file : nil
    }

    func size(of blob: URL) -> Int {
        (try? files.size(of: blob)) ?? 0
    }

    func sweep(keepingAfter sequence: Int) throws {
        guard let held = try? FileManager.default.contentsOfDirectory(atPath: blobs.path), !held.isEmpty else { return }
        let values = files.values()
        var named = Set<String>()
        try reading("SELECT payload FROM entries WHERE sequence > \(sequence) "
                    + "AND kind = \(SQLiteDelta.literal(PhotoEntry.Kind.availability.rawValue))") { cells in
            named.formUnion(Self.hashes(in: Data(try values.decrypt(cells[0] ?? "").utf8)).map(files.name))
        }
        for name in held where !named.contains(name) {
            try? FileManager.default.removeItem(at: blobs.appendingPathComponent(name))
        }
    }

    static func hashes(in payload: Data) -> [String] {
        guard let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
              let resources = object["resources"] as? [[String: Any]] else { return [] }
        let hexes = resources.compactMap { ($0["blob"] as? [String: Any])?["hash"] as? String }
            .filter { $0.hasPrefix("sha256:") }.map { String($0.dropFirst("sha256:".count)) }
        return Array(Set(hexes)).sorted()
    }

    static func assetPart(of key: String) -> String {
        var colons = 0
        for index in key.indices where key[index] == ":" {
            colons += 1
            if colons == 2 { return String(key[...index]) }
        }
        return key
    }

    private func reading(_ sql: String, _ row: ([String?]) throws -> Void) throws {
        guard FileFacts.isRegularFile(database.path) else { return }
        try SQLite.query(sql, in: database, row)
    }
}

enum PhotosDomainError: PathFreeError, Equatable {
    case entry

    var description: String {
        switch self {
        case .entry: return "the photos spool holds an entry that does not read"
        }
    }
}
