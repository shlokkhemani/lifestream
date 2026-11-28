import DeviceFiles
import Evidence
import Foundation
import HomeLink
import os
import SQLite3

enum Differences {
    static let liveSpan: TimeInterval = 7 * 86_400
    static let pageRows = 20_000
    static let log: @Sendable (String) -> Void = { ShippingState.log.error("\($0, privacy: .public)") }
    static let forgotten = 0
    static let tail = 500

    static func changed(_ table: String) -> String {
        "(SELECT t_key FROM temp.touched WHERE t_name = \(SQLiteDelta.literal(table)))"
    }

    struct Store {
        let member: String
        let database: URL
        let identity: DatabaseIdentity.Kind
        let schema: (Set<String>) -> StoreSchema
        let attachments: Attachments?
        let fileRoot: URL?
        var named: (String, URL) -> URL? = { ArtifactPath.regularFile($0, under: $1) }
        var opener: FileOpener = .own
        let optional: Bool
        let vet: ((URL) throws -> Void)?
        var declared: String?

        init(member: String, database: URL, identity: DatabaseIdentity.Kind, schema: @escaping (Set<String>) -> StoreSchema,
             attachments: Attachments? = nil, fileRoot: URL? = nil, optional: Bool = false, vet: ((URL) throws -> Void)? = nil) {
            self.member = member
            self.database = database
            self.identity = identity
            self.schema = schema
            self.attachments = attachments
            self.fileRoot = fileRoot
            self.optional = optional
            self.vet = vet
        }
    }

    struct Attachments {
        let member: String
        let locators: (URL) throws -> [String]
    }

    static func seal(_ request: SealRequest, sourceId: String, feeder: String, memory: URL, stores: [Store],
                     files: DeviceFiles, cache: inout HashCache, report: (String) -> Void)
        throws -> (bundles: [SealedBundle], owesHistory: Bool, through: Through?) {
        let custody = request.custody
        let paced = HistoryPage.paced(custody)
        let cutoff = Int64((request.fetchedAt.timeIntervalSince1970 - liveSpan).rounded(.down))
        let start = request.start.map { Int64($0.timeIntervalSince1970.rounded(.down)) }
        let work = try SealWork.directory(prefix: "differences-", in: request.scratch)
        defer { try? FileManager.default.removeItem(at: work) }

        let now = Int(request.fetchedAt.timeIntervalSince1970.rounded(.down))
        let interval = Int(request.coldInterval.rounded(.up))
        var opened: [(store: Store, memory: StoreMemory, stamp: String, source: SQLiteSource, scope: Scope, coldDueAt: Int?)] = []
        defer { opened.forEach { $0.source.close() } }
        var unreadOwed = 0
        var months = Months()
        var absent: [Store] = []
        for store in stores {
            let stamp = FileStamp.of(store.database) + (start.map { " start \($0)" } ?? "") + (store.declared.map { " declared \($0)" } ?? "")
            let memory = StoreMemory(file: memory.appendingPathComponent("memory-" + files.name(store.member)), files: files)
            let begun = try memory.begin(received: custody.received)
            let reconcile = begun.hadFastPass && begun.coldDue(at: now, forced: request.forceCold, within: interval)
            let quiet = begun.stamp == memory.named(stamp) && (begun.owed == 0 || (!paced && !request.owesThrough)) && !request.forceCold && !reconcile
            let unchanged = quiet && !begun.hasPendingMedia
            if unchanged, !begun.countDue(at: request.fetchedAt), let held = begun.months {
                unreadOwed += begun.owed
                months.add(held)
                continue
            }
            let source: SQLiteSource
            do { source = try SQLiteSource(store.database, opener: store.opener, scratch: request.scratch) } catch SQLiteError.missing {
                absent.append(store)
                continue
            }
            var adopted = false
            do {
                try store.vet?(source.url)
                let identity = try DatabaseIdentity.of(store.identity, database: store.database, readable: source.url)
                adopted = try memory.adopt(identity: identity, declared: store.declared)
                if adopted || begun.countDue(at: request.fetchedAt) || begun.months == nil {
                    let counted = try count(store, at: source.url)
                    try memory.counted(counted, at: request.fetchedAt)
                    months.add(counted)
                } else if let held = begun.months {
                    months.add(held)
                }
            } catch {
                source.close()
                throw error
            }
            if unchanged {
                unreadOwed += begun.owed
                source.close()
                continue
            }
            let fast = !adopted && !request.forceCold && begun.stamp != nil && begun.owed == 0
                && begun.start == memory.named(StoreMemory.started(start)) && !begun.coldDue(at: now, forced: false, within: interval)
            opened.append((store, memory, stamp, source, fast ? .fast(pendingOnly: quiet, schemaVersion: begun.schemaVersion) : .cold,
                           begun.coldDueAt))
        }
        if absent.count < stores.count, let needed = absent.first(where: { !$0.optional }) {
            throw SQLiteError.missing(needed.database.lastPathComponent)
        }

        var bundles: [SealedBundle] = []
        let counted = request.owed(months)
        var owed: [String: Int] = [:]
        let left = { owed.values.reduce(unreadOwed, +) }
        var seal = custody.seal
        var live: [Sealing] = []
        var lost: [Lost] = []
        var passes: [String: StoreMemory.Pass] = [:]
        func measure(_ locator: String, in store: Store) throws -> Large? {
            guard let root = store.fileRoot, let file = store.named(locator, root),
                  let measured = try cache.measureNamed(locator: locator, file: file, opener: store.opener, at: request.fetchedAt)
            else { return nil }
            return Large(locator: locator, sha256: measured.sha256, file: file, bytes: Int64(measured.bytes))
        }
        for each in opened {
            let file = work.appendingPathComponent("live-" + each.store.member)
            let filled = try fill(each.store, from: each.source, memory: each.memory.file, into: file,
                                  part: .live(cutoff: cutoff, start: start), seal: seal, files: files, at: request.fetchedAt, scope: each.scope,
                                  staged: request.staged, measure: { try measure($0, in: each.store) })
            passes[each.store.member] = StoreMemory.Pass(fast: filled.fast, schemaVersion: filled.schemaVersion,
                                                         coldDueAt: filled.fast ? each.coldDueAt : now + interval,
                                                         at: request.fetchedAt, start: start)
            owed[each.store.member] = filled.owed
            lost += filled.lost.map { [$0] } ?? []
            if filled.holds { live.append(Sealing(store: each.store, memory: each.memory, file: file, deferred: filled.deferred)) }
        }
        if !live.isEmpty {
            bundles.append(try write(live, request: request, at: request.fetchedAt, seal: seal, lost: lost, history: false,
                                     left: left(), months: counted, sourceId: sourceId, feeder: feeder, cache: &cache,
                                     through: files))
            seal += 1
        }
        if paced, let each = opened.first(where: { (owed[$0.store.member] ?? 0) > 0 }) {
            do {
                let file = work.appendingPathComponent("page-" + each.store.member)
                let filled = try fill(each.store, from: each.source, memory: each.memory.file, into: file,
                                      part: .page(cutoff: cutoff, rows: pageRows, start: start), seal: seal, files: files,
                                      at: request.fetchedAt)
                owed[each.store.member] = filled.owed
                if filled.holds {
                    bundles.append(try write([Sealing(store: each.store, memory: each.memory, file: file, deferred: [])], request: request,
                                             at: request.fetchedAt.addingTimeInterval(0.001), seal: seal,
                                             lost: filled.lost.map { [$0] } ?? [], history: true, left: left(),
                                             months: bundles.isEmpty ? counted : nil, sourceId: sourceId, feeder: feeder,
                                             cache: &cache, through: files))
                }
            } catch let refused as StoreFiles.Unsafe {
                throw refused
            } catch where !bundles.isEmpty {
                owed[each.store.member] = 0
                passes[each.store.member] = StoreMemory.Pass(fast: false, schemaVersion: nil, coldDueAt: 0, at: request.fetchedAt, start: start)
                let reason = ShipperRunRow.reason(error)
                if (try? each.memory.refused(page: seal, reason: reason)) ?? true {
                    report("\(feeder): a history page of \(each.store.member) was not sealed: \(reason)")
                }
            }
        }
        for each in opened {
            try each.memory.settle(stamp: each.stamp, owed: owed[each.store.member] ?? 0, pass: passes[each.store.member])
        }
        let through = bundles.isEmpty && request.owesThrough ? request.through(readThrough: request.fetchedAt, left: left(), months: months) : nil
        return (bundles, left() > 0, through)
    }

    static func count(_ store: Store, at database: URL) throws -> Months {
        let handle = try SQLite.source(database)
        defer { sqlite3_close(handle) }
        let declared = try StoreSQL.declared(on: handle)
        let tables = store.schema(declared).tables.filter { declared.contains($0.name) }
        var months = Months()
        for table in tables {
            guard case .main(let time, _) = table.role else { continue }
            var counted: [(month: String?, items: Int)] = []
            try SQLite.rows("SELECT strftime('%Y-%m', (\(time)), 'unixepoch'), CAST(count(*) AS TEXT) FROM source.\(SQLiteDelta.quoted(table.name)) "
                            + "GROUP BY 1", on: handle) { cells in
                guard cells.count == 2, case .text(let items) = cells[1], let items = Int(items) else { return }
                if case .text(let month) = cells[0] { counted.append((month, items)) } else { counted.append((nil, items)) }
            }
            for (month, items) in counted { months.add(month, items: items, bytes: 0) }
        }
        guard let root = store.fileRoot else { return months }
        var locators = Set(try store.attachments?.locators(database) ?? [])
        for table in tables where !table.files.isEmpty {
            let named = table.files.map { "SELECT (\($0)) FROM source.\(SQLiteDelta.quoted(table.name))" }.joined(separator: " UNION ")
            try SQLite.rows(named, on: handle) { cells in
                if case .text(let locator) = cells.first, !locator.isEmpty { locators.insert(locator) }
            }
        }
        for locator in locators {
            guard let facts = StatedFile.facts(locator, under: root) else { continue }
            months.add(Months.key(seconds: Int64(facts.st_mtimespec.tv_sec)), items: 0, bytes: Int64(facts.st_size))
        }
        return months
    }

    struct Sealing {
        let store: Store
        let memory: StoreMemory
        let file: URL
        let deferred: Set<String>
    }

    private static func write(_ files: [Sealing], request: SealRequest, at fetchedAt: Date,
                              seal: Int, lost: [Lost], history: Bool, left: Int, months: [String: Through.Month]?, sourceId: String,
                              feeder: String, cache: inout HashCache, through deviceFiles: DeviceFiles) throws -> SealedBundle {
        let custody = SealCustody(pass: request.custody.pass, received: seal - 1, imported: request.custody.imported,
                                  history: request.custody.history)
        var named: [(index: BlobIndex, files: [String: URL])?] = []
        for each in files {
            guard let attachments = each.store.attachments, let root = each.store.fileRoot else { named.append(nil); continue }
            var index = BlobIndex()
            var paths: [String: URL] = [:]
            for locator in try attachments.locators(each.file) where !index.contains(locator) && !each.deferred.contains(locator) {
                guard let file = each.store.named(locator, root),
                      let measured = try cache.measureNamed(locator: locator, file: file, opener: each.store.opener, at: fetchedAt) else { continue }
                index.set(locator, BlobIndex.Entry(sha256: measured.sha256, bytes: measured.bytes))
                if paths[measured.sha256] == nil { paths[measured.sha256] = file }
            }
            named.append((index, paths))
        }
        var facts: [(String, JSONText)] = [("snapshot_taken_at", .string(UTCInstant.rfc3339(fetchedAt))), ("kind", .string("changes"))]
        if history { facts.append(HistoryPage.fact) }
        facts.append(("left", .int(left)))
        facts.append(("start_ms", request.start.map { .int(Int(($0.timeIntervalSince1970 * 1000).rounded(.down))) } ?? .null))
        facts += Months.facts(months)
        var unsent: [[String]] = []
        for (each, named) in zip(files, named) {
            unsent.append(try named.map { try each.memory.unsent($0.files.keys) } ?? [])
        }
        let asked = Set(unsent.joined())
        let held = asked.isEmpty ? [] : request.held(asked).intersection(asked)
        var uncarried: Set<String> = []
        while true {
            var members: [BundleWriter.File] = []
            var blobs: [BundleWriter.Blob] = []
            var carriedBy: [(memory: StoreMemory, hashes: Set<String>, index: BlobIndex, store: Store, file: URL)] = []
            for ((each, named), unsent) in zip(zip(files, named), unsent) {
                members.append(BundleWriter.File(name: each.store.member, content: .file(each.file)))
                guard let named, let attachments = each.store.attachments else { continue }
                let index = named.index.without(uncarried)
                members.append(BundleWriter.File(name: attachments.member, content: .bytes(index.data)))
                let carried = unsent.filter { !uncarried.contains($0) }
                blobs += carried.map { BundleWriter.Blob(sha256: $0, file: named.files[$0]!, opener: each.store.opener) }
                carriedBy.append((each.memory, Set(carried), index, each.store, each.file))
            }
            let staged = history ? [] : self.staged(blobs, of: named.compactMap { $0?.index }, request: request, held: held)
            let written: BundleWriter.Written
            do {
                written = try BundleWriter.write(into: request.workDirectory, sourceId: sourceId, feeder: feeder, fetchedAt: fetchedAt,
                                                 files: members, blobs: blobs.filter { !staged.contains($0.sha256) },
                                                 stagedBlobs: staged.sorted(), held: { held.intersection($0) }, facts: facts,
                                                 custody: (custody, lost), through: deviceFiles)
            } catch let error as BundleWriterError {
                guard let blob = error.uncarriedBlob, !uncarried.contains(blob.sha256) else { throw error }
                uncarried.insert(blob.sha256)
                for named in named.compactMap({ $0 }) {
                    for (locator, entry) in named.index.entries where entry.sha256 == blob.sha256 {
                        cache.failed(locator: locator, why: blob.why, at: fetchedAt)
                    }
                }
                continue
            }
            for each in carriedBy {
                try each.memory.record(blobs: written.named.filter(each.hashes.contains), seal: seal)
                guard let root = each.store.fileRoot else { continue }
                try each.memory.record(files: each.index, from: each.file, schema: each.store.schema, seal: seal, at: fetchedAt,
                                       root: root)
                cache.shipped(each.index.entries.keys)
            }
            return SealedBundle(file: written.file, sidecar: BundleSidecar(id: written.id, sourceId: sourceId, custody: custody,
                                                                           history: history, live: "changes", months: months,
                                                                           stagedBlobs: written.staged))
        }
    }

    private static func staged(_ blobs: [BundleWriter.Blob], of indexes: [BlobIndex], request: SealRequest, held: Set<String>) -> Set<String> {
        guard let staged = request.staged else { return [] }
        var bytes: [String: Int] = [:]
        for index in indexes {
            for entry in index.entries.values { bytes[entry.sha256] = entry.bytes }
        }
        return Set(blobs.map(\.sha256).filter { Int64(bytes[$0] ?? 0) > staged.thresholdBytes && staged.isReady($0) }).subtracting(held)
    }

    enum Part {
        case live(cutoff: Int64, start: Int64?)
        case page(cutoff: Int64, rows: Int, start: Int64?)
    }

    struct Filled {
        let holds: Bool
        let owed: Int
        let lost: Lost?
        var fast = false
        var schemaVersion: Int? = nil
        var deferred: Set<String> = []
    }

    enum Scope: Equatable {
        case cold
        case fast(pendingOnly: Bool, schemaVersion: Int?)
    }

    struct Large {
        let locator: String
        let sha256: String
        let file: URL
        let bytes: Int64
    }

    static func fill(_ store: Store, from source: SQLiteSource, memory: URL, into output: URL, part: Part,
                     seal: Int, files: DeviceFiles, at now: Date, scope: Scope = .cold, staged: StagedBlobs? = nil,
                     measure: (String) throws -> Large? = { _ in nil }) throws -> Filled {
        var owed = 0
        var lost: (lost: Lost, through: Int)?
        var holds = false
        var tables: [StoreSchema.Table] = []
        var fast = false
        var schemaVersion: Int?
        var deferring = false
        var deferred: Set<String> = []
        let live: Bool
        if case .live = part { live = true } else { live = false }
        try SQLiteDelta.write(from: source, to: output, attaching: [("memory", memory)], tables: { handle, declared in
            Fingerprint.register(on: handle, files: files)
            if let root = store.fileRoot { StatedFile.register(on: handle, root: root) }
            tables = try store.schema(try StoreSQL.declared(on: handle)).tables.filter { table in
                if declared.contains(table.name) { return true }
                if table.whenDeclared { return false }
                throw SQLiteDeltaError.noTable(table.name)
            }
            schemaVersion = try SQLite.integer("PRAGMA source.schema_version", on: handle)
            fast = live ? try candidates(scope, of: tables, schemaVersion: schemaVersion, on: handle) : false
            try changes(of: tables, filtered: fast, on: handle)
            owed = try choose(tables, part: part, on: handle)
            if live, let staged, store.fileRoot != nil {
                deferring = true
                deferred = try deferLarge(tables, staged: staged, files: files, measure: measure, on: handle)
            }
            if let main = tables.first(where: \.isMain) { lost = try loss(of: main, on: handle) }
            return tables.map(\.held)
        }, finish: { handle in
            for table in tables where table.role != .whole {
                let key = SQLiteDelta.quoted(table.key ?? "rowid")
                let chosen = "SELECT 1 FROM main.\(SQLiteDelta.quoted(table.name)) WHERE \(key) IN \(selected(table.name)) LIMIT 1"
                if try SQLite.integer(chosen, on: handle) != nil { holds = true }
            }
            let tag = holds ? seal : seal - 1
            if live { try examined(tables, seal: tag, on: handle) }
            if deferring {
                try SQLite.exec("INSERT OR REPLACE INTO memory.pending_media (tbl, key, added_at, seal) "
                                + "SELECT t_name, t_key, \(Int(now.timeIntervalSince1970.rounded(.down))), \(tag) FROM temp.deferred", on: handle)
            }
            guard holds else { return }
            if fast { try shippedBeside(tables, seal: seal, on: handle) }
            for table in tables {
                guard let key = table.key else { continue }
                try SQLite.exec("INSERT OR REPLACE INTO memory.rows (tbl, key, fingerprint, files, seal) "
                                + "SELECT t_name, t_key, t_fp, NULL, \(seal) FROM temp.fresh WHERE t_name = \(SQLiteDelta.literal(table.name)) "
                                + "AND t_key IN (SELECT \(SQLiteDelta.quoted(key)) FROM main.\(SQLiteDelta.quoted(table.name)))", on: handle)
                guard table.files.isEmpty else { continue }
                try SQLite.exec("DELETE FROM memory.pending_media WHERE tbl = \(SQLiteDelta.literal(table.name)) "
                                + "AND key IN (SELECT \(SQLiteDelta.quoted(key)) FROM main.\(SQLiteDelta.quoted(table.name)))", on: handle)
            }
            if let main = tables.first(where: \.isMain), let key = main.key {
                let name = SQLiteDelta.literal(main.name)
                try SQLite.exec("UPDATE memory.rows SET fingerprint = \(forgotten) WHERE tbl = \(name) "
                                + "AND key IN (SELECT t_key FROM temp.touched WHERE t_name = \(name) "
                                + "AND t_key NOT IN (SELECT \(SQLiteDelta.quoted(key)) FROM main.\(SQLiteDelta.quoted(main.name))))", on: handle)
            }
            if let lost, let main = tables.first(where: \.isMain) {
                try SQLite.exec("INSERT OR IGNORE INTO memory.rows (tbl, key, fingerprint, seal) VALUES "
                                + "(\(SQLiteDelta.literal(main.name)), \(lost.through), \(forgotten), \(seal))", on: handle)
            }
        })
        return Filled(holds: holds, owed: owed, lost: holds ? lost?.lost : nil, fast: fast, schemaVersion: schemaVersion,
                      deferred: holds ? deferred : [])
    }

    static func ancestors(of table: String, key: String, parent: String) -> String {
        "\(key) IN (WITH RECURSIVE up(k) AS (SELECT \(parent) FROM \(table) WHERE \(key) IN \(selected(table)) "
            + "UNION SELECT row.\(parent) FROM \(table) AS row JOIN up ON row.\(key) = up.k) SELECT k FROM up)"
    }

    static func selected(_ table: String) -> String {
        "(SELECT t_key FROM temp.selected WHERE t_name = \(SQLiteDelta.literal(table)))"
    }

    static func keyed(_ tables: [StoreSchema.Table]) -> [(table: StoreSchema.Table, key: String)] {
        tables.compactMap { table in table.role == .whole ? nil : table.key.map { (table, $0) } }
    }

    private static func keyTable(_ name: String, on handle: OpaquePointer) throws {
        try SQLite.exec("CREATE TEMP TABLE \(name) (t_name TEXT NOT NULL, t_key INTEGER NOT NULL, PRIMARY KEY (t_name, t_key)) WITHOUT ROWID",
                        on: handle)
    }

    private static func keyNotInteger(_ table: StoreSchema.Table, key: String, above floor: Int?, on handle: OpaquePointer) throws {
        let above = floor.map { " AND \(SQLiteDelta.quoted(key)) > \($0)" } ?? ""
        if try SQLite.integer("SELECT 1 FROM source.\(SQLiteDelta.quoted(table.name)) "
                              + "WHERE typeof(\(SQLiteDelta.quoted(key))) NOT IN ('integer', 'null')\(above) LIMIT 1", on: handle) != nil {
            throw DifferencesError.keyNotInteger(table.name)
        }
    }

    private static func candidates(_ scope: Scope, of tables: [StoreSchema.Table], schemaVersion: Int?,
                                   on handle: OpaquePointer) throws -> Bool {
        guard case .fast(let pendingOnly, let held) = scope, held != nil, held == schemaVersion else { return false }
        var floors: [(table: StoreSchema.Table, key: String, floor: Int)] = []
        for (table, key) in keyed(tables) {
            guard let through = try SQLite.integer("SELECT through FROM memory.examined WHERE tbl = \(SQLiteDelta.literal(table.name))",
                                                   on: handle) else { return false }
            floors.append((table, key, through - tail))
        }
        try keyTable("candidates", on: handle)
        try SQLite.exec("INSERT OR IGNORE INTO temp.candidates (t_name, t_key) SELECT tbl, key FROM memory.pending_media", on: handle)
        if pendingOnly { return true }
        for (table, key, floor) in floors {
            try keyNotInteger(table, key: key, above: floor, on: handle)
            try SQLite.exec("INSERT OR IGNORE INTO temp.candidates (t_name, t_key) SELECT \(SQLiteDelta.literal(table.name)), "
                            + "\(SQLiteDelta.quoted(key)) FROM source.\(SQLiteDelta.quoted(table.name)) "
                            + "WHERE \(SQLiteDelta.quoted(key)) > \(floor)", on: handle)
        }
        return true
    }

    private static func examined(_ tables: [StoreSchema.Table], seal: Int, on handle: OpaquePointer) throws {
        for (table, key) in keyed(tables) {
            try SQLite.exec("INSERT OR REPLACE INTO memory.examined (tbl, through, seal) SELECT \(SQLiteDelta.literal(table.name)), "
                            + "CASE WHEN typeof(m) = 'integer' THEN m ELSE 0 END, \(seal) "
                            + "FROM (SELECT max(\(SQLiteDelta.quoted(key))) AS m FROM source.\(SQLiteDelta.quoted(table.name)))", on: handle)
        }
    }

    private static func columns(of table: StoreSchema.Table, on handle: OpaquePointer) throws -> [String] {
        var columns: [String] = []
        try SQLite.rows("SELECT name FROM pragma_table_xinfo(\(SQLiteDelta.literal(table.name)), 'source') WHERE hidden = 0 "
                        + "ORDER BY cid", on: handle) { cells in
            if case .text(let column) = cells.first { columns.append(SQLiteDelta.quoted(column)) }
        }
        return columns
    }

    private static func shippedBeside(_ tables: [StoreSchema.Table], seal: Int, on handle: OpaquePointer) throws {
        for (table, key) in keyed(tables) {
            let name = SQLiteDelta.literal(table.name), quoted = SQLiteDelta.quoted(key)
            try SQLite.exec("INSERT OR IGNORE INTO memory.rows (tbl, key, fingerprint, files, seal) "
                            + "SELECT \(name), k, f, NULL, \(seal) FROM (SELECT \(quoted) AS k, "
                            + "\(Fingerprint.sql(try columns(of: table, on: handle))) AS f FROM source.\(SQLiteDelta.quoted(table.name)) "
                            + "WHERE \(quoted) IN (SELECT \(quoted) FROM main.\(SQLiteDelta.quoted(table.name))) "
                            + "AND \(quoted) NOT IN (SELECT t_key FROM temp.fresh WHERE t_name = \(name))) WHERE typeof(k) = 'integer'",
                            on: handle)
        }
    }

    private static func changes(of tables: [StoreSchema.Table], filtered: Bool, on handle: OpaquePointer) throws {
        let exec = { (sql: String) in try SQLite.exec(sql, on: handle) }
        for name in ["touched", "selected"] { try keyTable(name, on: handle) }
        try exec("CREATE TEMP TABLE fresh (t_name TEXT NOT NULL, t_key INTEGER NOT NULL, t_fp INTEGER NOT NULL, "
                 + "PRIMARY KEY (t_name, t_key)) WITHOUT ROWID")
        for table in tables {
            guard let key = table.key else { continue }
            let whole = !filtered || table.role == .whole
            if whole { try keyNotInteger(table, key: key, above: nil, on: handle) }
            let scoped = whole ? ""
                : " WHERE \(SQLiteDelta.quoted(key)) IN (SELECT t_key FROM temp.candidates WHERE t_name = \(SQLiteDelta.literal(table.name)))"
            let columns = try self.columns(of: table, on: handle)
            let name = SQLiteDelta.literal(table.name)
            let files = table.files.isEmpty ? "NULL"
                : "json_array(\(table.files.map { "\(StatedFile.function)(\($0))" }.joined(separator: ", ")))"
            try exec("WITH r AS MATERIALIZED (SELECT \(SQLiteDelta.quoted(key)) AS k, \(Fingerprint.sql(columns)) AS f, \(files) AS s "
                     + "FROM source.\(SQLiteDelta.quoted(table.name))\(scoped)) "
                     + "INSERT INTO temp.fresh (t_name, t_key, t_fp) SELECT \(name), k, f FROM r WHERE typeof(k) = 'integer' "
                     + "AND NOT EXISTS (SELECT 1 FROM memory.rows AS m WHERE m.tbl = \(name) AND m.key = r.k AND m.fingerprint = r.f "
                     + "AND NOT EXISTS (SELECT 1 FROM json_each(r.s) AS now WHERE now.value IS NOT NULL "
                     + "AND now.value IS NOT json_extract(m.files, '$[' || now.key || ']')))")
        }
        for table in tables.reversed() where table.key != nil {
            let name = SQLiteDelta.literal(table.name)
            try exec("INSERT OR IGNORE INTO temp.touched (t_name, t_key) SELECT t_name, t_key FROM temp.fresh WHERE t_name = \(name)")
            for (part, select) in table.touchedBy where tables.contains(where: { $0.name == part }) {
                guard try SQLite.integer("SELECT 1 FROM temp.touched WHERE t_name = \(SQLiteDelta.literal(part)) LIMIT 1",
                                         on: handle) != nil else { continue }
                try exec("INSERT OR IGNORE INTO temp.touched (t_name, t_key) SELECT \(name), k FROM (\(select)) WHERE k IS NOT NULL")
            }
        }
    }

    private static func choose(_ tables: [StoreSchema.Table], part: Part, on handle: OpaquePointer) throws -> Int {
        let exec = { (sql: String) in try SQLite.exec(sql, on: handle) }
        var owed = 0
        for table in tables {
            let name = SQLiteDelta.literal(table.name)
            switch table.role {
            case .changes:
                guard case .live = part else { continue }
                if let chosen = table.chosen {
                    try exec("INSERT INTO temp.selected SELECT \(name), t.t_key FROM temp.touched AS t JOIN source.\(SQLiteDelta.quoted(table.name)) "
                             + "AS r ON r.\(SQLiteDelta.quoted(table.key ?? "rowid")) = t.t_key WHERE t.t_name = \(name) AND (\(chosen))")
                } else {
                    try exec("INSERT INTO temp.selected SELECT t_name, t_key FROM temp.touched WHERE t_name = \(name)")
                }
            case .main(let time, _):
                let rows = "FROM temp.touched AS t JOIN source.\(SQLiteDelta.quoted(table.name)) AS r "
                    + "ON r.\(SQLiteDelta.quoted(table.key ?? "rowid")) = t.t_key WHERE t.t_name = \(name)"
                switch part {
                case .live(let cutoff, let start):
                    try exec("INSERT INTO temp.selected SELECT \(name), t.t_key \(rows) "
                             + "AND ((\(time)) IS NULL OR (\(time)) >= \(max(cutoff, start ?? cutoff)))")
                    owed = try SQLite.integer("SELECT count(*) \(rows) \(older(than: cutoff, from: start, time))", on: handle) ?? 0
                case .page(let cutoff, let limit, let start):
                    let span = older(than: cutoff, from: start, time)
                    try exec("INSERT INTO temp.selected SELECT \(name), k FROM (SELECT t.t_key AS k, (\(time)) AS at \(rows) "
                             + "\(span) ORDER BY at DESC, k DESC LIMIT \(limit))")
                    let owing = try SQLite.integer("SELECT count(*) \(rows) \(span)", on: handle) ?? 0
                    owed = max(0, owing - limit)
                }
            case .follows, .whole:
                continue
            }
        }
        return owed
    }

    struct Seed {
        let table: String
        let key: Int
        let locators: [String]
    }

    private static func deferLarge(_ tables: [StoreSchema.Table], staged: StagedBlobs, files: DeviceFiles,
                                   measure: (String) throws -> Large?, on handle: OpaquePointer) throws -> Set<String> {
        try keyTable("deferred", on: handle)
        let seeds = try large(tables, above: staged.thresholdBytes, on: handle)
        guard !seeds.isEmpty else { return [] }
        let owned = try probing(on: handle) { try attribute(seeds[...], in: tables, on: handle) }
        var waiting: [(seed: Seed, owners: [(String, Int)], files: [Large])] = []
        for (seed, owners) in owned {
            let files = try seed.locators.compactMap(measure).filter { $0.bytes > staged.thresholdBytes && !staged.isReady($0.sha256) }
            if !files.isEmpty { waiting.append((seed, owners, files)) }
        }
        let sent = try carried(Set(waiting.flatMap { $0.files.map(\.sha256) }), files: files, on: handle)
        var deferred: Set<String> = []
        var enqueued: Set<String> = []
        for each in waiting {
            let files = each.files.filter { !sent.contains($0.sha256) }
            guard !files.isEmpty else { continue }
            for (name, key) in each.owners + [(each.seed.table, each.seed.key)] {
                try SQLite.exec("INSERT OR IGNORE INTO temp.deferred (t_name, t_key) VALUES (\(SQLiteDelta.literal(name)), \(key))", on: handle)
            }
            for (name, key) in each.owners {
                try SQLite.exec("DELETE FROM temp.selected WHERE t_name = \(SQLiteDelta.literal(name)) AND t_key = \(key)", on: handle)
            }
            for file in files {
                deferred.insert(file.locator)
                if enqueued.insert(file.sha256).inserted { staged.enqueue(file.sha256, file.file, file.bytes, false, .new) }
            }
        }
        return deferred
    }

    private static func large(_ tables: [StoreSchema.Table], above threshold: Int64, on handle: OpaquePointer) throws -> [Seed] {
        var seeds: [Seed] = []
        for table in tables where !table.files.isEmpty {
            guard let key = table.key else { continue }
            let stated = table.files.enumerated().map { "(\($1)) AS l\($0), \(StatedFile.function)((\($1))) AS b\($0)" }.joined(separator: ", ")
            let named = table.files.indices.map { "CASE WHEN b\($0) > \(threshold) THEN l\($0) END" }.joined(separator: ", ")
            let over = table.files.indices.map { "b\($0) > \(threshold)" }.joined(separator: " OR ")
            try SQLite.rows("WITH s AS MATERIALIZED (SELECT \(SQLiteDelta.quoted(key)) AS k, \(stated) FROM source.\(SQLiteDelta.quoted(table.name)) "
                            + "WHERE \(SQLiteDelta.quoted(key)) IN \(changed(table.name))) "
                            + "SELECT CAST(k AS TEXT), \(named) FROM s WHERE typeof(k) = 'integer' AND (\(over))", on: handle) { cells in
                guard case .text(let spelled) = cells.first, let key = Int(spelled) else { return }
                let locators = cells.dropFirst().compactMap { cell -> String? in
                    if case .text(let locator) = cell, !locator.isEmpty { return locator }
                    return nil
                }
                if !locators.isEmpty { seeds.append(Seed(table: table.name, key: key, locators: locators)) }
            }
        }
        return seeds
    }

    private static func probing<T>(on handle: OpaquePointer, _ body: () throws -> T) throws -> T {
        try SQLite.exec("ALTER TABLE temp.touched RENAME TO held_touched", on: handle)
        try keyTable("touched", on: handle)
        let restore = {
            try SQLite.exec("DROP TABLE temp.touched", on: handle)
            try SQLite.exec("ALTER TABLE temp.held_touched RENAME TO touched", on: handle)
        }
        do {
            let value = try body()
            try restore()
            return value
        } catch {
            try? restore()
            throw error
        }
    }

    private static func attribute(_ seeds: ArraySlice<Seed>, in tables: [StoreSchema.Table],
                                  on handle: OpaquePointer) throws -> [(seed: Seed, owners: [(String, Int)])] {
        let owners = try reach(seeds, in: tables, on: handle)
        guard !owners.isEmpty else { return [] }
        guard seeds.count > 1 else { return [(seeds[seeds.startIndex], owners)] }
        let middle = seeds.startIndex + seeds.count / 2
        return try attribute(seeds[..<middle], in: tables, on: handle) + attribute(seeds[middle...], in: tables, on: handle)
    }

    private static func reach(_ seeds: ArraySlice<Seed>, in tables: [StoreSchema.Table], on handle: OpaquePointer) throws -> [(String, Int)] {
        let exec = { (sql: String) in try SQLite.exec(sql, on: handle) }
        try exec("DELETE FROM temp.touched")
        for chunk in stride(from: seeds.startIndex, to: seeds.endIndex, by: 500) {
            let values = seeds[chunk..<min(chunk + 500, seeds.endIndex)].map { "(\(SQLiteDelta.literal($0.table)), \($0.key))" }
            try exec("INSERT OR IGNORE INTO temp.touched (t_name, t_key) VALUES \(values.joined(separator: ", "))")
        }
        let names = Set(tables.map(\.name))
        for _ in 0..<(tables.count + 2) {
            let before = try SQLite.integer("SELECT count(*) FROM temp.touched", on: handle) ?? 0
            for table in tables where table.key != nil {
                for (part, select) in table.touchedBy where names.contains(part) {
                    guard try SQLite.integer("SELECT 1 FROM temp.touched WHERE t_name = \(SQLiteDelta.literal(part)) LIMIT 1",
                                             on: handle) != nil else { continue }
                    try exec("INSERT OR IGNORE INTO temp.touched (t_name, t_key) SELECT \(SQLiteDelta.literal(table.name)), k "
                             + "FROM (\(select)) WHERE k IS NOT NULL")
                }
            }
            if try SQLite.integer("SELECT count(*) FROM temp.touched", on: handle) ?? 0 == before { break }
        }
        var owners: [(String, Int)] = []
        try SQLite.rows("SELECT t.t_name, CAST(t.t_key AS TEXT) FROM temp.touched AS t JOIN temp.selected AS s "
                        + "ON s.t_name = t.t_name AND s.t_key = t.t_key", on: handle) { cells in
            guard cells.count == 2, case .text(let name) = cells[0], case .text(let spelled) = cells[1], let key = Int(spelled) else { return }
            owners.append((name, key))
        }
        return owners
    }

    private static func carried(_ hashes: Set<String>, files: DeviceFiles, on handle: OpaquePointer) throws -> Set<String> {
        guard !hashes.isEmpty else { return [] }
        let named = Dictionary(hashes.map { (files.name($0), $0) }, uniquingKeysWith: { first, _ in first })
        var sent: Set<String> = []
        try SQLite.rows("SELECT hash FROM memory.blobs WHERE hash IN (\(named.keys.sorted().map(SQLiteDelta.literal).joined(separator: ", ")))",
                        on: handle) { cells in
            if case .text(let hash) = cells.first, let plain = named[hash] { sent.insert(plain) }
        }
        return sent
    }

    private static func older(than cutoff: Int64, from start: Int64?, _ time: String) -> String {
        "AND (\(time)) < \(cutoff)" + (start.map { " AND (\(time)) >= \($0)" } ?? "")
    }

    private static func loss(of main: StoreSchema.Table, on handle: OpaquePointer) throws -> (lost: Lost, through: Int)? {
        guard case .main(_, let rows) = main.role else { return nil }
        let key = SQLiteDelta.quoted(main.key ?? "rowid")
        guard let held = try SQLite.integer("SELECT max(key) FROM memory.rows WHERE tbl = \(SQLiteDelta.literal(main.name))", on: handle),
              let lowest = try SQLite.integer("SELECT min(\(key)) FROM source.\(SQLiteDelta.quoted(main.name))", on: handle),
              lowest > held + 1 else { return nil }
        return (Lost(items: lowest - held - 1, what: "\(rows) with ids \(held + 1) to \(lowest - 1) left the app before this Mac carried them"),
                lowest - 1)
    }
}

enum DifferencesError: PathFreeError, Equatable {
    case keyNotInteger(String)

    var description: String {
        switch self {
        case .keyNotInteger(let table): return "the table \(table) keys a row by a value that is not an integer, which a store's key must be"
        }
    }
}

struct StoreSchema {
    struct Table {
        enum Role: Equatable {
            case changes
            case follows
            case main(time: String, rows: String)
            case whole
        }

        let name: String
        let key: String?
        let role: Role
        let keep: String?
        let touchedBy: [(String, String)]
        let chosen: String?
        let whenDeclared: Bool
        let files: [String]

        init(_ name: String, key: String?, _ role: Role, keep: String? = nil, touchedBy: [(String, String)] = [],
             chosen: String? = nil, whenDeclared: Bool = false, files: [String] = []) {
            self.name = name
            self.key = key
            self.role = role
            self.keep = keep
            self.touchedBy = touchedBy
            self.chosen = chosen
            self.whenDeclared = whenDeclared
            self.files = files
        }

        var isMain: Bool {
            if case .main = role { return true }
            return false
        }

        var held: SQLiteDelta.Table {
            guard role != .whole else { return SQLiteDelta.Table(name) }
            let key = SQLiteDelta.quoted(self.key ?? "rowid")
            let chosen = "\(key) IN (SELECT t_key FROM temp.selected WHERE t_name = \(SQLiteDelta.literal(name)))"
            return SQLiteDelta.Table(name, keep: keep.map { "\(chosen) OR (\($0))" } ?? chosen)
        }
    }

    let tables: [Table]
}

enum StatedFile {
    static let function = "stated_file"
    static let placed = "placed_file"

    static func facts(_ locator: String, under root: URL) -> stat? {
        var facts = stat()
        guard let file = ArtifactPath.file(locator, under: root),
              fstatat(AT_FDCWD, file.path, &facts, AT_SYMLINK_NOFOLLOW) == 0,
              facts.st_mode & S_IFMT == S_IFREG else { return nil }
        return facts
    }

    static func register(on handle: OpaquePointer, root: URL) {
        register(function, on: handle, root: root) { locator, root in facts(locator, under: root).map { Int64($0.st_size) } }
    }

    static func registerPlaced(on handle: OpaquePointer, root: URL) {
        register(placed, on: handle, root: root) { locator, root in ArtifactPath.file(locator, under: root) == nil ? nil : 1 }
    }

    private final class Answer {
        let root: URL
        let value: (String, URL) -> Int64?

        init(root: URL, value: @escaping (String, URL) -> Int64?) {
            self.root = root
            self.value = value
        }
    }

    private static func register(_ name: String, on handle: OpaquePointer, root: URL, value: @escaping (String, URL) -> Int64?) {
        let held = Unmanaged.passRetained(Answer(root: root, value: value)).toOpaque()
        sqlite3_create_function_v2(handle, name, 1, SQLITE_UTF8, held, { context, _, values in
            let answer = Unmanaged<Answer>.fromOpaque(sqlite3_user_data(context)!).takeUnretainedValue()
            guard sqlite3_value_type(values?[0]) == SQLITE_TEXT, let text = sqlite3_value_text(values?[0]) else {
                return sqlite3_result_null(context)
            }
            let locator = String(decoding: UnsafeBufferPointer(start: text, count: Int(sqlite3_value_bytes(values?[0]))), as: UTF8.self)
            guard let value = answer.value(locator, answer.root) else { return sqlite3_result_null(context) }
            sqlite3_result_int64(context, value)
        }, nil, nil, { held in
            Unmanaged<Answer>.fromOpaque(held!).release()
        })
    }
}

enum Fingerprint {
    static let arguments = 100

    static func sql(_ columns: [String]) -> String {
        var call = "fingerprint(\(columns.prefix(arguments).joined(separator: ", ")))"
        var rest = columns.dropFirst(arguments)
        while !rest.isEmpty {
            call = "fingerprint(\(([call] + rest.prefix(arguments - 1)).joined(separator: ", ")))"
            rest = rest.dropFirst(arguments - 1)
        }
        return call
    }

    static func register(on handle: OpaquePointer, files: DeviceFiles) {
        let held = Unmanaged.passRetained(files).toOpaque()
        sqlite3_create_function_v2(handle, "fingerprint", -1, SQLITE_UTF8 | SQLITE_DETERMINISTIC, held, { context, count, values in
            let files = Unmanaged<DeviceFiles>.fromOpaque(sqlite3_user_data(context)!).takeUnretainedValue()
            var size = 0
            for index in 0..<Int(count) {
                let value = values?[index]
                switch sqlite3_value_type(value) {
                case SQLITE_INTEGER, SQLITE_FLOAT: size += 9
                case SQLITE_TEXT: _ = sqlite3_value_text(value); size += 9 + Int(sqlite3_value_bytes(value))
                case SQLITE_BLOB: size += 9 + Int(sqlite3_value_bytes(value))
                default: size += 1
                }
            }
            let digest = withUnsafeTemporaryAllocation(byteCount: size, alignment: 8) { buffer -> Data in
                let start = buffer.baseAddress!
                var at = 0
                func word(_ value: UInt64) {
                    start.storeBytes(of: value.bigEndian, toByteOffset: at, as: UInt64.self)
                    at += 8
                }
                func framed(_ bytes: UnsafeRawPointer?, _ length: Int32) {
                    word(UInt64(length))
                    if let bytes, length > 0 { (start + at).copyMemory(from: bytes, byteCount: Int(length)) }
                    at += Int(max(length, 0))
                }
                for index in 0..<Int(count) {
                    let value = values?[index]
                    let type = sqlite3_value_type(value)
                    start.storeBytes(of: UInt8(type), toByteOffset: at, as: UInt8.self)
                    at += 1
                    switch type {
                    case SQLITE_INTEGER: word(UInt64(bitPattern: sqlite3_value_int64(value)))
                    case SQLITE_FLOAT: word(sqlite3_value_double(value).bitPattern)
                    case SQLITE_TEXT: framed(UnsafeRawPointer(sqlite3_value_text(value)), sqlite3_value_bytes(value))
                    case SQLITE_BLOB: framed(sqlite3_value_blob(value), sqlite3_value_bytes(value))
                    default: break
                    }
                }
                return files.digest(UnsafeRawBufferPointer(start: start, count: at))
            }
            let prefix = digest.prefix(8).reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
            sqlite3_result_int64(context, Int64(bitPattern: prefix))
        }, nil, nil, { held in
            Unmanaged<DeviceFiles>.fromOpaque(held!).release()
        })
    }
}
