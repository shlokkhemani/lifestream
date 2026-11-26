import Foundation
import HomeLink
import Synchronization

public struct CaptureDraft: Sendable, Equatable {
    public let kind: String
    public let observedAt: String
    public let captured: WallAndMonotonicTime
    public let payload: JSONValue

    public init(
        kind: String,
        observedAt: String,
        captured: WallAndMonotonicTime = .init(),
        payload: JSONValue
    ) {
        self.kind = kind
        self.observedAt = observedAt
        self.captured = captured
        self.payload = payload
    }
}

public struct ReplayCaptureDraft: Sendable, Equatable {
    public let replayKey: String
    public let draft: CaptureDraft

    public init(replayKey: String, draft: CaptureDraft) {
        self.replayKey = replayKey
        self.draft = draft
    }
}

public struct CaptureStatusSummary: Sendable, Equatable {
    public var localDay: String
    public var locationFixesToday: Int
    public var locationEventsToday: Int
    public var motionEntriesToday: Int
    public var healthEntriesToday: Int
    public var cameraEntriesToday: Int
    public var photosEntriesToday: Int
    public var voiceEntriesToday: Int
    public var lastFixObservedAt: String?
    public var recorderHealthEventWallTimes: [Double]
    public var week: [CaptureDomain: [Int]] = [:]
    public var last: [CaptureDomain: Date] = [:]
}

public struct CaptureInstall: Sendable, Equatable {
    public let id: String
    public let createdAt: String
}

extension CaptureDomain {
    var table: String { "\"\(rawValue)\"" }
}

public actor CaptureStore {
    enum Fact {
        static let installID = "install_id"
        static let installedAt = "installed_at"
        static let photosClearedThrough = "photos_cleared_through"
        static let contactsClearedThrough = "contacts_cleared_through"
        static let photoCleanup = "photo_cleanup"
        static let pendingBundle = "pending_bundle"
        static let answeredPass = "answered_pass"
    }

    public let root: URL
    public let processInstanceID: UUID
    public nonisolated let volume: Volume
    public nonisolated let install: CaptureInstall

    nonisolated let databaseURL: URL
    let blobsDirectory: URL
    let exportStagingRoot: URL
    let database: SQLiteDatabase
    var restoredBy: String?
    var paired = true
    var stopped = false
    public nonisolated let firstRunAtOpen: FirstRun
    public nonisolated let madeAtOpen: Bool

    private struct Waiting {
        let entry: CaptureEntry
        let line: Data
    }
    private var waiting: [Waiting] = []
    private var waitingBytes = 0
    private var waitTimer: Task<Void, Never>?
    nonisolated let waitSeconds: Double
    static let waitingByteCap = 4 * 1_024 * 1_024
    public var transactions: Int { database.transactions }
    private nonisolated let appended = Appended()

    public init(
        root: URL,
        processInstanceID: UUID = UUID(),
        waitSeconds: Double = 60,
        volume: Volume? = nil
    ) throws {
        self.root = root
        self.volume = volume ?? Volume(root)
        self.waitSeconds = waitSeconds
        self.processInstanceID = processInstanceID
        blobsDirectory = root.appendingPathComponent("blobs", isDirectory: true)
        exportStagingRoot = root.appendingPathComponent("export-staging", isDirectory: true)
        databaseURL = root.appendingPathComponent("capture.sqlite")
        try FileDurability.createDirectoryDurably(at: root)
        try FileDurability.createDirectoryDurably(at: blobsDirectory)
        try FileDurability.removePrivateDirectoryIfPresent(at: exportStagingRoot)
        try FileDurability.createPrivateDirectoryDurably(at: exportStagingRoot)
        #if os(iOS)
            try FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: root.path)
        #endif
        try FileDurability.excludeFromBackup(root)

        let database = try SQLiteDatabase(url: databaseURL, create: true)
        var restored: String?
        var made = false
        install = try database.write {
            for domain in CaptureDomain.allCases {
                try database.execute("""
                    CREATE TABLE IF NOT EXISTS \(domain.table) (
                        sequence INTEGER PRIMARY KEY,
                        kind TEXT NOT NULL,
                        captured_wall REAL NOT NULL,
                        replay_key TEXT,
                        line BLOB NOT NULL);
                    CREATE UNIQUE INDEX IF NOT EXISTS "\(domain.rawValue)_replay"
                        ON \(domain.table) (replay_key) WHERE replay_key IS NOT NULL;
                    CREATE INDEX IF NOT EXISTS "\(domain.rawValue)_captured"
                        ON \(domain.table) (captured_wall, kind);
                    CREATE TRIGGER IF NOT EXISTS "\(domain.rawValue)_kept" BEFORE DELETE ON \(domain.table)
                        BEGIN SELECT RAISE(ABORT, 'a capture entry is never deleted'); END;
                    """)
            }
            try database.execute(
                "CREATE TABLE IF NOT EXISTS fact (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            try Self.createLedger(in: database)
            try Self.createAnchors(in: database)
            if let id = try Self.fact(Fact.installID, in: database) {
                guard let createdAt = try Self.fact(Fact.installedAt, in: database) else {
                    throw CaptureError.corruptState("the capture database names an install without its start")
                }
                switch try Self.fact(Self.restoredFact, in: database) {
                case Self.restoreOwed: restored = nil
                case let mark: restored = mark
                }
                return CaptureInstall(id: id, createdAt: createdAt)
            }
            made = true
            let install = CaptureInstall(id: UUID().uuidString, createdAt: CaptureTime.rfc3339(AppClock.now))
            try Self.setFact(Fact.installID, install.id, in: database)
            try Self.setFact(Fact.installedAt, install.createdAt, in: database)
            try Self.setFact(Self.restoredFact, Self.restoreOwed, in: database)
            return install
        }
        restoredBy = restored
        stopped = try Self.fact(Self.stoppedFact, in: database) != nil
        madeAtOpen = made
        firstRunAtOpen = try Self.fact(Self.firstRunFact, in: database)
            .flatMap { try? JSONDecoder().decode(FirstRun.self, from: Data($0.utf8)) } ?? FirstRun()
        self.database = database
    }


    @discardableResult
    public func append(domain: CaptureDomain, draft: CaptureDraft, waiting wait: Bool = false) throws -> CaptureEntry {
        try appendBatch(domain: domain, drafts: [draft], waiting: wait)[0]
    }

    @discardableResult
    public func appendBatch(
        domain: CaptureDomain,
        drafts: [CaptureDraft],
        waiting wait: Bool = false
    ) throws -> [CaptureEntry] {
        guard wait else { return try insert(domain: domain, drafts: drafts.map { ($0, nil) }, anchors: [:]) }
        guard !drafts.isEmpty else { return [] }
        try admit(domain)
        let encoder = JSONEncoder.lifestream()
        var next = try nextSequence(domain)
        var added: [Waiting] = []
        for draft in drafts {
            let entry = try entry(domain, draft, sequence: next, replayKey: nil)
            added.append(Waiting(entry: entry, line: try encoder.encode(entry)))
            next += 1
        }
        let bytes = added.reduce(0) { $0 + $1.line.count }
        if waitingBytes + bytes > Self.waitingByteCap { try flush(cause: "cap") }
        waiting += added
        waitingBytes += bytes
        EnergyLedger.shared.count("store_waited", added.count)
        if waitTimer == nil { armTimer() }
        let entries = added.map(\.entry)
        appended.tell(domain, entries)
        return entries
    }

    @discardableResult
    public func appendBatch(domain: CaptureDomain, drafts: [CaptureDraft], anchors: [String: Data?]) throws -> [CaptureEntry] {
        try insert(domain: domain, drafts: drafts.map { ($0, nil) }, anchors: anchors)
    }

    @discardableResult
    public func appendReplayBatch(
        domain: CaptureDomain,
        drafts: [ReplayCaptureDraft]
    ) async throws -> [CaptureEntry] {
        return try insert(domain: domain, drafts: drafts.map { ($0.draft, $0.replayKey) }, anchors: [:])
    }

    public func flush() throws { try flush(cause: "call") }

    public func flushForSend() throws { try flush(cause: "send") }

    public nonisolated func observe(_ observer: @escaping @Sendable (CaptureDomain, [CaptureEntry]) -> Void) {
        appended.set(observer)
    }

    private func flush(cause: String) throws {
        guard !waiting.isEmpty else { return }
        try save(cause: cause, transaction: "flush") {}
    }

    private func waitEnded() {
        waitTimer = nil
        guard !waiting.isEmpty else { return }
        do {
            try EnergyLedger.shared.measure(.location) { try flush(cause: "timer") }
        } catch {
            armTimer()
        }
    }

    private func armTimer() {
        let seconds = waitSeconds
        waitTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            await self?.waitEnded()
        }
    }

    func save<T>(cause: String, transaction: String = "other", _ body: () throws -> T) throws -> T {
        let flushing = waiting.count
        let result = try database.write(cause: transaction) {
            for item in waiting {
                try insertRow(item.entry.domain, item.entry, line: item.line, replayKey: nil)
            }
            return try body()
        }
        if flushing > 0 {
            EnergyLedger.shared.count("store_flushes_\(cause)")
            waiting.removeAll()
            waitingBytes = 0
        }
        return result
    }

    private func insert(
        domain: CaptureDomain,
        drafts: [(CaptureDraft, String?)],
        anchors: [String: Data?]
    ) throws -> [CaptureEntry] {
        guard !drafts.isEmpty || !anchors.isEmpty else { return [] }
        try admit(domain)
        let encoder = JSONEncoder.lifestream()
        let entries = try save(cause: "durable", transaction: domain.rawValue) {
            var next = try lastSequence(domain) + 1
            var entries: [CaptureEntry] = []
            for (draft, replayKey) in drafts {
                if let replayKey, try database.integer(
                    "SELECT 1 FROM \(domain.table) WHERE replay_key = ?", .text(replayKey)) != nil
                {
                    continue
                }
                let entry = try entry(domain, draft, sequence: next, replayKey: replayKey)
                try insertRow(domain, entry, line: try encoder.encode(entry), replayKey: replayKey)
                entries.append(entry)
                next += 1
            }
            for (key, value) in anchors { try writeAnchor(key, value) }
            return entries
        }
        appended.tell(domain, entries)
        return entries
    }

    private func entry(
        _ domain: CaptureDomain, _ draft: CaptureDraft, sequence: UInt64, replayKey: String?
    ) throws -> CaptureEntry {
        guard sequence < UInt64(Int64.max) else {
            throw CaptureError.corruptState("\(domain.rawValue) sequence space is exhausted")
        }
        return try CaptureEntry(
            domain: domain, kind: draft.kind, sequence: sequence, observedAt: draft.observedAt,
            captured: draft.captured, processInstanceID: processInstanceID,
            captureReplayKey: replayKey, payload: draft.payload)
    }

    private func insertRow(_ domain: CaptureDomain, _ entry: CaptureEntry, line: Data, replayKey: String?) throws {
        try database.run(
            "INSERT INTO \(domain.table) (sequence, kind, captured_wall, replay_key, line) VALUES (?, ?, ?, ?, ?)",
            .integer(Int64(entry.sequence)), .text(entry.kind), .real(entry.captured.wallUnixSeconds),
            replayKey.map { .text($0) } ?? .null, .blob(line))
    }

    private func nextSequence(_ domain: CaptureDomain) throws -> UInt64 {
        let waited = waiting.last(where: { $0.entry.domain == domain })?.entry.sequence ?? 0
        return max(try lastSequence(domain), waited) + 1
    }


    public func capturedThrough() throws -> [CaptureDomain: UInt64] {
        var result: [CaptureDomain: UInt64] = [:]
        for domain in CaptureDomain.allCases { result[domain] = try lastSequence(domain) }
        return result
    }

    public func levels() throws -> [String: Int] {
        var levels: [String: Int] = [:]
        for domain in CaptureDomain.allCases { levels["store_level_rows_\(domain.rawValue)"] = Int(try lastSequence(domain)) }
        let files = [databaseURL, URL(fileURLWithPath: databaseURL.path + "-wal")]
        levels["store_level_bytes"] = files.reduce(0) { total, file in
            total + ((try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.intValue ?? 0)
        }
        return levels
    }

    func lastSequence(_ domain: CaptureDomain) throws -> UInt64 {
        UInt64(try database.integer("SELECT max(sequence) FROM \(domain.table)") ?? 0)
    }

    func oldestUnsent(_ domain: CaptureDomain, after: UInt64) throws -> (fix: Date?, other: Date?) {
        let own = SendClock.own[domain] ?? []
        func first(fix: Bool) throws -> Double? {
            var wall: Double?
            let excluded = (domain == .location ? ["fix"] : []) + own.sorted()
            let kinds = fix ? "AND kind = 'fix'"
                : excluded.isEmpty ? "" : "AND kind NOT IN (\(excluded.map { "'\($0)'" }.joined(separator: ", ")))"
            try database.query("SELECT captured_wall FROM \(domain.table) WHERE sequence > ? \(kinds) ORDER BY sequence LIMIT 1",
                               .integer(Int64(clamping: after))) { wall = $0.real(0) }
            return wall
        }
        let waited = waiting.map(\.entry).filter { $0.domain == domain && $0.sequence > after && !own.contains($0.kind) }
        func earliest(_ saved: Double?, _ waiting: [CaptureEntry]) -> Date? {
            ([saved].compactMap { $0 } + waiting.map(\.captured.wallUnixSeconds)).min().map { Date(timeIntervalSince1970: $0) }
        }
        guard domain == .location else {
            return (nil, earliest(try first(fix: false), waited))
        }
        return (earliest(try first(fix: true), waited.filter { $0.kind == "fix" }),
                earliest(try first(fix: false), waited.filter { $0.kind != "fix" }))
    }

    public func entries(domain: CaptureDomain, afterSequence: UInt64 = 0) async throws -> [CaptureEntry] {
        try await foldEntries(domain: domain, afterSequence: afterSequence, initial: []) { $0.append($1) }
    }

    public func foldEntries<Value: Sendable>(
        domain: CaptureDomain,
        afterSequence: UInt64 = 0,
        initial: Value,
        update: @escaping @Sendable (inout Value, CaptureEntry) throws -> Void
    ) async throws -> Value {
        return try await snapshot { database in
            var value = initial
            let decoder = JSONDecoder.lifestream()
            try Self.forEachLine(domain, after: afterSequence, in: database) { _, line in
                try update(&value, try decoder.decode(CaptureEntry.self, from: line))
                return true
            }
            return value
        }
    }

    public func latestEntry(domain: CaptureDomain) async throws -> CaptureEntry? {
        var line: Data?
        try database.query("SELECT line FROM \(domain.table) ORDER BY sequence DESC LIMIT 1") {
            line = $0.blob(0)
        }
        return try line.map { try JSONDecoder.lifestream().decode(CaptureEntry.self, from: $0) }
    }

    public func latestEntries(domain: CaptureDomain, kind: String, limit: Int) async throws -> [CaptureEntry] {
        var lines: [Data] = []
        try database.query(
            "SELECT line FROM \(domain.table) WHERE kind = ? ORDER BY sequence DESC LIMIT ?",
            .text(kind), .integer(Int64(limit))
        ) { row in
            lines.append(row.blob(0))
        }
        let decoder = JSONDecoder.lifestream()
        return try lines.map { try decoder.decode(CaptureEntry.self, from: $0) }
    }

    public func entries(_ domain: CaptureDomain, replayKeyPrefix prefix: String) throws -> [CaptureEntry] {
        var lines: [Data] = []
        let end = String(prefix.unicodeScalars.dropLast()) + String(UnicodeScalar(prefix.unicodeScalars.last!.value + 1)!)
        try database.query("""
            SELECT line FROM \(domain.table) WHERE replay_key >= ? AND replay_key < ? ORDER BY sequence
            """, .text(prefix), .text(end)) { lines.append($0.blob(0)) }
        let decoder = JSONDecoder.lifestream()
        return try lines.map { try decoder.decode(CaptureEntry.self, from: $0) }
    }

    public func photosStatedLive() throws -> Set<String> {
        let table = CaptureDomain.photos.table
        let digest = String(repeating: "?", count: 64)
        var live = Set<String>()
        try database.query("""
            SELECT a.replay_key FROM \(table) a
            WHERE a.replay_key >= 'photos:' AND a.replay_key < 'photos;' AND a.replay_key GLOB '*:sha256:\(digest)'
              AND NOT EXISTS (SELECT 1 FROM \(table) g WHERE g.replay_key = a.replay_key || ':gone')
            """) { row in
            guard let key = row.text(0)?.dropFirst("photos:".count), let end = key.firstIndex(of: ":") else { return }
            live.insert(String(key[..<end]))
        }
        return live
    }

    public func statusSummary(now: Date = AppClock.now) throws -> CaptureStatusSummary {
        try flush(cause: "status")
        let calendar = Self.localCalendar
        let dayStart = calendar.startOfDay(for: now)
        let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) ?? now
        func today(_ domain: CaptureDomain) throws -> (all: Int, fixes: Int) {
            var counts = (all: 0, fixes: 0)
            try database.query("""
                SELECT count(*), coalesce(sum(kind = 'fix'), 0) FROM \(domain.table)
                WHERE captured_wall >= ? AND captured_wall < ?
                """, .real(dayStart.timeIntervalSince1970), .real(dayEnd.timeIntervalSince1970)
            ) { counts = (Int($0.integer(0)), Int($0.integer(1))) }
            return counts
        }
        var events: [Double] = []
        try database.query("""
            SELECT captured_wall FROM location WHERE captured_wall > ? AND kind = 'recorder_event'
                AND json_extract(CAST(line AS TEXT), '$.payload.event') <> 'experiment_marker'
            ORDER BY captured_wall DESC LIMIT 10000
            """, .real(now.timeIntervalSince1970 - 24 * 60 * 60)
        ) { events.append($0.real(0)) }
        var lastFix: (date: Date, text: String)?
        try database.query("""
            SELECT json_extract(CAST(line AS TEXT), '$.observed_at') FROM location
            WHERE kind = 'fix' ORDER BY sequence DESC LIMIT 100
            """
        ) { row in
            guard let text = row.text(0), let date = CaptureTime.date(rfc3339: text) else { return }
            if lastFix.map({ date > $0.date }) ?? true { lastFix = (date, text) }
        }
        let starts = (0...6).reversed().compactMap { calendar.date(byAdding: .day, value: -$0, to: dayStart) } + [dayEnd]
        let bounds = (0..<7).flatMap { [SQLiteValue.real(starts[$0].timeIntervalSince1970), .real(starts[$0 + 1].timeIntervalSince1970)] }
        var week: [CaptureDomain: [Int]] = [:]
        var last: [CaptureDomain: Date] = [:]
        for (domain, count) in Self.weekCounts {
            let buckets = (0..<7).map { _ in "coalesce(sum(CASE WHEN captured_wall >= ? AND captured_wall < ? THEN \(count.each) END), 0)" }
                .joined(separator: ", ")
            let counted = count.records
            try database.query("""
                SELECT \(buckets) FROM \(domain.table)
                WHERE captured_wall >= ? AND captured_wall < ? AND \(counted)
                """, bounds + [.real(starts[0].timeIntervalSince1970), .real(dayEnd.timeIntervalSince1970)]
            ) { row in week[domain] = (0..<7).map { Int(row.integer(Int32($0))) } }
            try database.query("""
                SELECT captured_wall FROM \(domain.table) WHERE \(counted)
                ORDER BY captured_wall DESC LIMIT 1
                """
            ) { row in last[domain] = Date(timeIntervalSince1970: row.real(0)) }
        }
        let location = try today(.location)
        return CaptureStatusSummary(
            localDay: Self.localDay(for: now),
            locationFixesToday: location.fixes,
            locationEventsToday: location.all - location.fixes,
            motionEntriesToday: try today(.motion).all,
            healthEntriesToday: try today(.health).all,
            cameraEntriesToday: try today(.camera).all,
            photosEntriesToday: try today(.photos).all,
            voiceEntriesToday: try today(.voice).all,
            lastFixObservedAt: lastFix?.text,
            recorderHealthEventWallTimes: events.reversed(),
            week: week,
            last: last)
    }

    static let weekCounts: [CaptureDomain: (records: String, each: String)] = [
        .location: ("kind = 'fix'", "1"), .motion: ("kind = 'activity'", "1"), .health: ("kind = 'sample'", "1"),
        .photos: ("kind = 'asset'", "1"),
        .contacts: ("kind = 'card'", "1"),
        .usage: ("kind = 'activity_segment'", "1"), .voice: ("kind = 'voice_note'", "1"), .camera: ("kind = 'photo'", "1"),
        .notes: ("kind = 'note' AND json_extract(CAST(line AS TEXT), '$.payload.purged') IS NULL", "1"),
    ]


    nonisolated func snapshot<T: Sendable>(
        _ body: @escaping @Sendable (SQLiteDatabase) throws -> T
    ) async throws -> T {
        let url = databaseURL
        let worker = Task.detached(priority: Task.currentPriority) {
            let database = try SQLiteDatabase(url: url)
            return try database.read { try body(database) }
        }
        return try await withTaskCancellationHandler { try await worker.value } onCancel: {
            worker.cancel()
        }
    }

    static func forEachLine(
        _ domain: CaptureDomain,
        after: UInt64,
        in database: SQLiteDatabase,
        _ body: (UInt64, Data) throws -> Bool
    ) throws {
        var expected = after + 1
        do {
            try database.query(
                "SELECT sequence, line FROM \(domain.table) WHERE sequence > ? ORDER BY sequence",
                .integer(Int64(clamping: after))
            ) { row in
                try Task.checkCancellation()
                guard row.integer(0) == Int64(clamping: expected) else {
                    throw CaptureError.corruptState("\(domain.rawValue) history has no sequence \(expected)")
                }
                guard try body(expected, row.blob(1)) else { throw LinesEnd() }
                expected += 1
            }
        } catch is LinesEnd {
        }
    }

    private struct LinesEnd: Error {}

    static func fact(_ key: String, in database: SQLiteDatabase) throws -> String? {
        var value: String?
        try database.query("SELECT value FROM fact WHERE key = ?", .text(key)) { value = $0.text(0) }
        return value
    }

    static func setFact(_ key: String, _ value: String?, in database: SQLiteDatabase) throws {
        if let value {
            try database.run(
                "INSERT INTO fact (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                .text(key), .text(value))
        } else {
            try database.run("DELETE FROM fact WHERE key = ?", .text(key))
        }
    }

    static var localCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .autoupdatingCurrent
        return calendar
    }

    static func localDay(for date: Date) -> String {
        let parts = localCalendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
}

final class Appended: Sendable {
    private struct Observer { let call: @Sendable (CaptureDomain, [CaptureEntry]) -> Void }

    private let observer = Mutex<Observer?>(nil)

    func set(_ observer: @escaping @Sendable (CaptureDomain, [CaptureEntry]) -> Void) {
        self.observer.withLock { $0 = Observer(call: observer) }
    }

    func tell(_ domain: CaptureDomain, _ entries: [CaptureEntry]) {
        guard !entries.isEmpty, let observer = observer.withLock({ $0 }) else { return }
        observer.call(domain, entries)
    }
}
