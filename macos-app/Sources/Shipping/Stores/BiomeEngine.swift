import CryptoKit
import Evidence
import Foundation
import HomeLink

final class BiomeEngine: ShippingDomain {
    static let acSpacing: TimeInterval = 5 * 60
    static let batterySpacing: TimeInterval = 15 * 60
    static let lowPowerSpacing: TimeInterval = 30 * 60
    static let workPrefix = "biome-bundle-"
    static let suffix = ".segb"
    static let thisMac = "SELECT device_identifier FROM DevicePeer WHERE me = 1"

    let sourceId: String
    let name: String
    private let feeder: String
    private let stream: String
    private let road: StoreFiles
    let ledgers: Ledgers
    private let stated = SealNote<Through?>(nil)
    private let spacing: @Sendable () -> TimeInterval
    static let syncDatabase = "~/Library/Biome/sync/sync.db"

    init(sourceId: String, store: HomeLink.MacStore, stream: String, road: StoreFiles, ledgers: Ledgers,
         spacing: @escaping @Sendable () -> TimeInterval = { BiomeEngine.acSpacing }) throws {
        self.sourceId = sourceId
        self.spacing = spacing
        self.ledgers = ledgers
        name = store.name
        feeder = store.feeder
        self.stream = stream
        self.road = road
        _ = try road.path(Self.folder(of: stream))
        _ = try road.path(Self.syncDatabase)
    }

    static func spacing(onBattery: Bool, lowPower: Bool) -> TimeInterval {
        lowPower ? lowPowerSpacing : onBattery ? batterySpacing : acSpacing
    }

    static func powerSpacing() -> TimeInterval {
        let power = PowerMode.current()
        return spacing(onBattery: power == .battery, lowPower: power == .lowPower)
    }

    static func folder(of stream: String) -> String { "~/Library/Biome/streams/restricted/\(stream)/" }

    func seal(_ request: SealRequest) throws -> [SealedBundle] {
        stated.value = nil
        let ledger = ledgers.ledger(HashEntry.self, pass: request.custody.pass, source: sourceId)
        let held = try ledger.held(through: request.custody.received)
        let last = held.last?.entry.mark.flatMap { UTCInstant.date(rfc3339: $0) }
        let quiet = { (readThrough: Date?, segments: [(locator: String, file: URL)]?) in
            guard request.owesThrough, let readThrough else { return }
            self.stated.value = request.through(readThrough: readThrough, months: segments.map(Self.months))
        }
        if let last, request.fetchedAt < last.addingTimeInterval(spacing()) {
            quiet(last, try? segmentFiles())
            return []
        }
        let segments = try segmentFiles()
        guard !segments.isEmpty else {
            quiet(request.fetchedAt, segments)
            return []
        }
        let shipped = Set(held.flatMap(\.entry.hashes))

        let work = try SealWork.directory(prefix: Self.workPrefix, in: request.scratch)
        defer { try? FileManager.default.removeItem(at: work) }

        var files: [BundleWriter.File] = []
        var unsettled = 0
        for (index, segment) in segments.enumerated() {
            guard let bytes = try settled(segment.file) else {
                unsettled += 1
                continue
            }
            if let start = request.start, (Self.lastWritten(bytes).map { $0 < start } ?? true) { continue }
            let sha256 = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            if shipped.contains(sha256) { continue }
            let copy = work.appendingPathComponent(String(index))
            try bytes.write(to: copy)
            files.append(BundleWriter.File(name: segment.locator, content: .file(copy)))
        }
        guard !files.isEmpty else {
            quiet(unsettled == 0 ? request.fetchedAt : last, segments)
            return []
        }

        var facts: [(String, JSONText)] = []
        if files.contains(where: { $0.name.hasPrefix("local/") }) {
            facts.append(("local_device", .string(try localDevice(scratch: request.scratch))))
        }
        facts += [("segments", .int(files.count)), ("unsettled", .int(unsettled)),
                  ("snapshot_taken_at", .string(UTCInstant.rfc3339(request.fetchedAt)))]
        let counted = request.owed(Self.months(segments))
        facts += Months.facts(counted)
        let written = try BundleWriter.write(
            into: request.workDirectory, sourceId: sourceId, feeder: feeder, fetchedAt: request.fetchedAt,
            files: files, facts: facts, custody: (request.custody, []), through: ledgers.files)
        try ledger.record(HashEntry(mark: UTCInstant.rfc3339(request.fetchedAt), hashes: Set(written.files.map(\.sha256)).sorted()),
                          at: request.custody.seal)
        return [SealedBundle(file: written.file, sidecar: BundleSidecar(id: written.id, sourceId: sourceId, custody: request.custody,
                                                                        write: .new, months: counted))]
    }

    var through: Through? { stated.value }

    func applied(_ answer: FreshAnswer) {
        guard let custody = answer.sources[sourceId] else { return }
        try? ledgers.ledger(HashEntry.self, pass: answer.pass, source: sourceId).prune(imported: custody.imported)
    }


    private func segmentFiles() throws -> [(locator: String, file: URL)] {
        let streamRoot = try road.path(Self.folder(of: stream))
        guard FileManager.default.fileExists(atPath: streamRoot.path) else { return [] }
        var found: [(String, URL)] = []
        func segments(in folder: String) throws {
            let directory = streamRoot.appendingPathComponent(folder, isDirectory: true)
            guard FileFacts.isDirectory(directory.path) else { return }
            for name in try list(directory) {
                let file = directory.appendingPathComponent(name)
                if Self.isSegmentName(name), FileFacts.isRegularFile(file.path) { found.append(("\(folder)/\(name)\(Self.suffix)", file)) }
            }
        }
        try segments(in: "local")
        try segments(in: "local/tombstone")
        let remote = streamRoot.appendingPathComponent("remote", isDirectory: true)
        if FileFacts.isDirectory(remote.path) {
            for device in try list(remote) where FileFacts.isDirectory(remote.appendingPathComponent(device).path) {
                try segments(in: "remote/\(device)")
                try segments(in: "remote/\(device)/tombstone")
            }
        }
        return found.sorted { JSONText.javaScriptOrder($0.0, $1.0) }
    }

    private func list(_ directory: URL) throws -> [String] {
        do { return try FileManager.default.contentsOfDirectory(atPath: directory.path) } catch {
            throw BiomeEngineError.unreadable(directory.path)
        }
    }

    static func months(_ segments: [(locator: String, file: URL)]) -> Months {
        var months = Months()
        for segment in segments {
            guard let facts = FileFacts.entry(segment.file.path) else { continue }
            months.add(Months.key(seconds: Int64(facts.st_mtimespec.tv_sec)), items: 1, bytes: Int64(facts.st_size))
        }
        return months
    }

    static func isSegmentName(_ name: String) -> Bool {
        !name.isEmpty && name.utf8.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
    }

    private func localDevice(scratch: URL) throws -> String {
        var ids: [String] = []
        let database = try road.path(Self.syncDatabase)
        do {
            let source = try SQLiteSource(database, opener: road.opener, scratch: scratch)
            defer { source.close() }
            try SQLite.query(Self.thisMac, in: source.url) { row in ids.append(row.first.flatMap { $0 } ?? "") }
        } catch let refused as StoreFiles.Unsafe {
            throw refused
        } catch {
            throw BiomeEngineError.syncDatabase("\(error)")
        }
        guard ids.count == 1, let id = ids.first, !id.isEmpty, !id.contains(":"), !id.contains("/") else {
            throw BiomeEngineError.thisMac(ids.count)
        }
        return id
    }


    private func settled(_ file: URL) throws -> Data? {
        for _ in 0..<2 {
            guard let opened = try StoreFiles.unlessRefused({ try road.open(file, spelled: nil) }) ?? nil,
                  let bytes = try? opened.bytes() else { return nil }
            if Self.isWhole(bytes) { return bytes }
        }
        return nil
    }

    static func isWhole(_ bytes: Data) -> Bool {
        let data = [UInt8](bytes)
        guard data.count >= 32, data[0] == 0x53, data[1] == 0x45, data[2] == 0x47, data[3] == 0x42 else { return false }
        let count = Int(u32(data, 4))
        guard count <= (data.count - 32) / 16 else { return false }
        let indexStart = data.count - count * 16
        var previousEnd = 0
        for index in 0..<count {
            let at = data.count - 16 * (index + 1)
            let end = Int(u32(data, at))
            let state = u32(data, at + 4)
            if state == 4 { continue }
            let start = 32 + ((previousEnd + 3) & ~3)
            let stop = 32 + end
            guard stop >= start + 8, stop <= indexStart else { return false }
            previousEnd = end
            guard state == 1 else { continue }
            guard CRC32.update(0, bytes.subdata(in: (start + 8)..<stop)) == u32(data, start) else { return false }
        }
        return true
    }

    static func lastWritten(_ bytes: Data) -> Date? {
        let data = [UInt8](bytes)
        let count = Int(u32(data, 4))
        let times = (0..<count).compactMap { index -> Double? in
            let at = data.count - 16 * (index + 1)
            guard u32(data, at + 4) == 1 else { return nil }
            return Double(bitPattern: UInt64(u32(data, at + 8)) | UInt64(u32(data, at + 12)) << 32)
        }
        return times.max().map { Date(timeIntervalSinceReferenceDate: $0) }
    }

    private static func u32(_ data: [UInt8], _ at: Int) -> UInt32 {
        UInt32(data[at]) | UInt32(data[at + 1]) << 8 | UInt32(data[at + 2]) << 16 | UInt32(data[at + 3]) << 24
    }
}

enum BiomeEngineError: Error, Equatable, CustomStringConvertible {
    case unreadable(String)
    case syncDatabase(String)
    case thisMac(Int)

    var description: String {
        switch self {
        case .unreadable(let path): return "\(path) cannot be listed"
        case .syncDatabase(let why): return "Biome's sync database does not read: \(why)"
        case .thisMac(let rows): return "Biome's sync database names \(rows) devices as this Mac, not one"
        }
    }
}
