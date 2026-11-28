import Foundation
import SQLite3

enum SQLiteDelta {
    static let pageSize = 4096
    static let indexedRows = 500

    struct Table: Equatable {
        let name: String
        let keep: String?

        init(_ name: String, keep: String? = nil) {
            self.name = name
            self.keep = keep
        }
    }

    static func write(from source: SQLiteSource, to output: URL, attaching: [(name: String, file: URL)] = [],
                      tables: (OpaquePointer, [String]) throws -> [Table],
                      finish: (OpaquePointer) throws -> Void = { _ in }) throws {
        try? FileManager.default.removeItem(at: output)
        removeJournals(beside: output)
        do {
            try fill(output, from: source.url, attaching: attaching, tables: tables, finish: finish)
            removeJournals(beside: output)
        } catch {
            try? FileManager.default.removeItem(at: output)
            removeJournals(beside: output)
            throw error
        }
    }

    private static func check(_ tables: [Table]) throws {
        var named = Set<String>()
        for table in tables {
            guard isTableName(table.name), !table.name.lowercased().hasPrefix("sqlite_") else {
                throw SQLiteDeltaError.table(table.name)
            }
            guard named.insert(table.name.lowercased()).inserted else { throw SQLiteDeltaError.twice(table.name) }
            if let keep = table.keep, keep.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                throw SQLiteDeltaError.predicate(table.name)
            }
        }
    }

    static func isTableName(_ table: String) -> Bool {
        var scalars = table.unicodeScalars.makeIterator()
        guard let first = scalars.next(), first == "_" || isLetter(first) else { return false }
        while let next = scalars.next() {
            guard next == "_" || isLetter(next) || ("0"..."9").contains(next) else { return false }
        }
        return true
    }

    private static func isLetter(_ scalar: Unicode.Scalar) -> Bool {
        ("a"..."z").contains(scalar) || ("A"..."Z").contains(scalar)
    }

    static func quoted(_ name: String) -> String {
        "\"\(name.replacingOccurrences(of: "\"", with: "\"\""))\""
    }

    static func literal(_ text: String) -> String {
        "'\(text.replacingOccurrences(of: "'", with: "''"))'"
    }

    private static func removeJournals(beside output: URL) {
        for suffix in ["-wal", "-shm", "-journal"] {
            try? FileManager.default.removeItem(at: URL(fileURLWithPath: output.path + suffix))
        }
    }


    private static func fill(_ output: URL, from source: URL, attaching: [(name: String, file: URL)],
                             tables ask: (OpaquePointer, [String]) throws -> [Table],
                             finish: (OpaquePointer) throws -> Void) throws {
        let handle = try SQLite.open(output, flags: SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_URI)
        defer { sqlite3_close(handle) }
        let exec = { (sql: String) in try SQLite.exec(sql, on: handle) }
        let integer = { (sql: String) in try SQLite.integer(sql, on: handle) ?? 0 }
        try exec("PRAGMA main.journal_mode=OFF")
        try exec("PRAGMA main.synchronous=OFF")
        try exec("PRAGMA foreign_keys=OFF")
        try exec("PRAGMA temp_store=MEMORY")
        try attach(source, on: handle)
        for (name, file) in attaching {
            try exec("ATTACH \(literal(file.path)) AS \(quoted(name))")
        }
        try exec("BEGIN")
        do {
            var schema: [(type: String, name: String, table: String, sql: String, unique: Bool)] = []
            try SQLite.rows("SELECT type, name, tbl_name, sql, CASE WHEN object.type = 'index' AND (SELECT list.\"unique\" "
                                    + "FROM pragma_index_list(object.tbl_name, 'source') AS list WHERE list.name = object.name) = 1 "
                                    + "THEN 'unique' ELSE '' END FROM source.sqlite_master AS object "
                                    + "WHERE sql IS NOT NULL AND type IN ('table', 'index') ORDER BY rowid", on: handle) { cells in
                guard cells.count == 5, case .text(let type) = cells[0], case .text(let name) = cells[1],
                      case .text(let table) = cells[2], case .text(let sql) = cells[3], case .text(let unique) = cells[4] else { return }
                schema.append((type, name, table, sql, unique == "unique"))
            }
            try exec("PRAGMA main.page_size = \(pageSize)")
            var reserve: Int32 = -1
            guard sqlite3_file_control(handle, "source", SQLITE_FCNTL_RESERVE_BYTES, &reserve) == SQLITE_OK,
                  sqlite3_file_control(handle, "main", SQLITE_FCNTL_RESERVE_BYTES, &reserve) == SQLITE_OK else {
                throw SQLiteError.sqlite("state the reserved bytes", String(cString: sqlite3_errmsg(handle)))
            }
            let autoVacuum = try integer("PRAGMA source.auto_vacuum")
            try exec("PRAGMA main.auto_vacuum = \(autoVacuum)")
            let declared = schema.filter { $0.type == "table" }.map(\.name)
            let tables = try ask(handle, declared)
            try check(tables)
            for table in tables where !declared.contains(table.name) {
                throw SQLiteDeltaError.noTable(table.name)
            }
            let held = Set(tables.map(\.name))
            let holds = { (name: String) in held.contains(name) }
            if schema.contains(where: { holds($0.name) && $0.sql.range(of: #"^CREATE\s+VIRTUAL\s"#, options: [.regularExpression, .caseInsensitive]) != nil }) {
                throw SQLiteDeltaError.virtualTable
            }

            let reserved = { (name: String) in name.lowercased().hasPrefix("sqlite_") }
            let objects = schema.filter { !reserved($0.name) && holds($0.table) }
            for object in objects where object.type == "table" { try exec(object.sql) }
            let indexes = objects.filter { $0.type == "index" }
            for index in indexes where index.unique { try exec(index.sql) }
            var rows = 0
            for table in tables where table.keep == nil {
                rows += try copy(table.name, keep: nil, on: handle)
            }
            let filled = tables.filter { $0.keep != nil }
            for table in filled {
                try exec("CREATE TEMP VIEW \(quoted(table.name)) AS SELECT * FROM source.\(quoted(table.name))")
            }
            for table in filled {
                rows += try copy(table.name, keep: table.keep, on: handle)
                try exec("DROP VIEW temp.\(quoted(table.name))")
            }
            let naming = { (column: String) in "\(column) IN (\(held.sorted().map(literal).joined(separator: ", ")))" }
            let indexed = rows >= indexedRows
            if indexed {
                for index in indexes where !index.unique { try exec(index.sql) }
            }
            let statistics = indexed ? declared.filter { reserved($0) && $0 != "sqlite_sequence" } : []
            if !statistics.isEmpty {
                try exec("ANALYZE main.sqlite_master")
                var made: [String] = []
                try SQLite.rows("SELECT name FROM main.sqlite_master WHERE name GLOB 'sqlite_stat*'", on: handle) { cells in
                    if case .text(let name) = cells.first { made.append(name) }
                }
                for name in made {
                    try exec(statistics.contains(name) ? "DELETE FROM main.\(quoted(name))" : "DROP TABLE main.\(quoted(name))")
                }
                for name in statistics where !made.contains(name) { throw SQLiteDeltaError.reservedTable(name) }
                for name in statistics { _ = try copy(name, keep: naming("tbl"), on: handle) }
            }
            if try integer("SELECT count(*) FROM main.sqlite_master WHERE name = 'sqlite_sequence'") > 0 {
                try exec("DELETE FROM main.sqlite_sequence")
                _ = try copy("sqlite_sequence", keep: naming("name"), on: handle)
            }
            for pragma in ["user_version", "application_id"] {
                let value = try integer("PRAGMA source.\(pragma)")
                try exec("PRAGMA main.\(pragma) = \(value)")
            }
            try finish(handle)
            try exec("COMMIT")
        } catch {
            if sqlite3_get_autocommit(handle) == 0 { try? exec("ROLLBACK") }
            throw error
        }
        try exec("DETACH source")
        for (name, _) in attaching { try exec("DETACH \(quoted(name))") }
        guard try SQLite.passesQuickCheck(handle) else {
            throw SQLiteDeltaError.integrity(output.lastPathComponent)
        }
    }

    private static func attach(_ source: URL, on handle: OpaquePointer) throws {
        let uri = source.absoluteString + "?mode=ro"
        guard sqlite3_exec(handle, "ATTACH \(literal(uri)) AS source", nil, nil, nil) == SQLITE_OK else {
            let why = SQLite.message(handle).replacingOccurrences(of: uri, with: source.lastPathComponent)
            throw SQLiteError.sqlite("attach \(source.lastPathComponent) read-only", why)
        }
    }

    private static func copy(_ table: String, keep: String?, on handle: OpaquePointer) throws -> Int {
        let name = literal(table)
        var columns: [String] = []
        try SQLite.rows("SELECT name FROM pragma_table_xinfo(\(name), 'source') WHERE hidden = 0 ORDER BY cid",
                                on: handle) { cells in
            if case .text(let column) = cells.first { columns.append(column) }
        }
        let carried = try SQLite.integer(
            "SELECT (SELECT wr FROM pragma_table_list WHERE schema = 'source' AND name = \(name)) "
                + "OR (EXISTS (SELECT 1 FROM pragma_table_info(\(name), 'source') WHERE pk > 0) "
                + "AND NOT EXISTS (SELECT 1 FROM pragma_index_list(\(name), 'source') WHERE origin = 'pk'))", on: handle)
        var list = columns.map(quoted).joined(separator: ", ")
        if carried == 0 {
            guard let rowid = ["rowid", "_rowid_", "oid"].first(where: { alias in
                !columns.contains { $0.lowercased() == alias }
            }) else { throw SQLiteDeltaError.rowid(table) }
            list = "\(rowid), \(list)"
        }
        let filter = keep.map { " WHERE (\($0)) IS TRUE" } ?? ""
        try SQLite.exec("INSERT INTO main.\(quoted(table)) (\(list)) SELECT \(list) "
                                + "FROM source.\(quoted(table))\(filter)", on: handle)
        return Int(sqlite3_changes(handle))
    }
}

enum SQLiteDeltaError: PathFreeError, Equatable {
    case table(String)
    case twice(String)
    case predicate(String)
    case noTable(String)
    case virtualTable
    case reservedTable(String)
    case rowid(String)
    case integrity(String)

    var description: String {
        switch self {
        case .table(let name): return "a delta names an invalid table \(name)"
        case .twice(let name): return "a delta names \(name) twice"
        case .predicate(let table): return "a delta's predicate for \(table) is empty"
        case .noTable(let table): return "no such table: \(table)"
        case .virtualTable: return "a delta names a virtual table, which it does not copy"
        case .reservedTable(let name): return "the source declares \(name), which this SQLite does not make"
        case .rowid(let table): return "the table \(table) names every rowid alias as a column"
        case .integrity(let name): return "the delta \(name) failed quick_check"
        }
    }
}
