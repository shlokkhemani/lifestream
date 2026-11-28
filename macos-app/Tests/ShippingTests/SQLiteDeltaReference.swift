import CryptoKit
import Foundation
import SQLite3
import XCTest
@testable import Shipping

enum SQLiteDeltaReference {
    struct Fingerprint: Equatable, CustomStringConvertible {
        let header: [String: Int]
        let schema: [String]
        let tables: [String: String]

        var description: String { "header \(header)\nschema \(schema)\ntables \(tables.sorted { $0.key < $1.key })" }

        var withoutPageSize: Fingerprint {
            Fingerprint(header: header.filter { $0.key != "page_size" }, schema: schema, tables: tables)
        }
    }

    static func fingerprint(_ url: URL) throws -> Fingerprint {
        let bytes = try Data(contentsOf: url).prefix(100)
        func u16(_ at: Int) -> Int { Int(bytes[at]) << 8 | Int(bytes[at + 1]) }
        func u32(_ at: Int) -> Int { (0..<4).reduce(0) { $0 << 8 | Int(bytes[at + $1]) } }
        let header = ["page_size": u16(16) == 1 ? 65_536 : u16(16), "write_version": Int(bytes[18]),
                      "read_version": Int(bytes[19]), "reserved_bytes": Int(bytes[20]),
                      "auto_vacuum": u32(52) == 0 ? 0 : u32(64) == 0 ? 1 : 2, "text_encoding": u32(56),
                      "user_version": u32(60), "application_id": u32(68)]
        let handle = try SQLite.open(url)
        defer { sqlite3_close(handle) }
        var schema: [String] = []
        try each("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type <> 'trigger' ORDER BY type, name",
                 on: handle) { schema.append($0.joined(separator: "|")) }
        let names = try texts("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", on: handle)
        var tables: [String: String] = [:]
        for name in names {
            let quoted = "\"\(name.replacingOccurrences(of: "\"", with: "\"\""))\""
            let withoutRowid = try SQLite.integer("SELECT wr FROM pragma_table_list WHERE schema = 'main' "
                + "AND name = '\(name.replacingOccurrences(of: "'", with: "''"))'", on: handle) == 1
            var width = 0
            try each("PRAGMA table_info(\(quoted))", on: handle) { _ in width += 1 }
            let order = withoutRowid ? (1...width).map(String.init).joined(separator: ", ") : "rowid"
            var hash = SHA256()
            var rows = 0
            try each("SELECT \(withoutRowid ? "" : "rowid, ")* FROM \(quoted) ORDER BY \(order)", on: handle) { cells in
                hash.update(data: Data((cells.joined(separator: "\u{1f}") + "\n").utf8))
                rows += 1
            }
            tables[name] = "\(rows) \(hash.finalize().map { String(format: "%02x", $0) }.joined())"
        }
        return Fingerprint(header: header, schema: schema, tables: tables)
    }

    private static func texts(_ sql: String, on handle: OpaquePointer) throws -> [String] {
        var found: [String] = []
        try SQLite.rows(sql, on: handle) { if case .text(let text) = $0.first { found.append(text) } }
        return found
    }

    private static func each(_ sql: String, on handle: OpaquePointer, _ row: ([String]) throws -> Void) throws {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw DomainFixtures.FixtureError.sqlite("\(sql): \(String(cString: sqlite3_errmsg(handle)))")
        }
        defer { sqlite3_finalize(statement) }
        while sqlite3_step(statement) == SQLITE_ROW {
            try row((0..<sqlite3_column_count(statement)).map { column in
                switch sqlite3_column_type(statement, column) {
                case SQLITE_NULL: return "null"
                case SQLITE_INTEGER: return "integer:\(sqlite3_column_int64(statement, column))"
                case SQLITE_FLOAT: return "real:\(sqlite3_column_double(statement, column).bitPattern)"
                case SQLITE_TEXT: return "text:" + String(cString: sqlite3_column_text(statement, column))
                default:
                    let count = Int(sqlite3_column_bytes(statement, column))
                    let bytes = sqlite3_column_blob(statement, column).map { Data(bytes: $0, count: count) } ?? Data()
                    return "blob:" + bytes.map { String(format: "%02x", $0) }.joined()
                }
            })
        }
    }

    static func byCopy(from source: URL, to output: URL, tables: [SQLiteDelta.Table]) throws {
        try? FileManager.default.removeItem(at: output)
        let handle = try SQLite.open(output, flags: SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)
        defer { sqlite3_close(handle) }
        let reading = try SQLite.open(source)
        let backup = sqlite3_backup_init(handle, "main", reading, "main")
        let copied = sqlite3_backup_step(backup, -1)
        sqlite3_backup_finish(backup)
        sqlite3_close(reading)
        guard copied == SQLITE_DONE else { throw DomainFixtures.FixtureError.sqlite("back up \(source.lastPathComponent)") }
        let exec = { (sql: String) in try SQLite.exec(sql, on: handle) }
        try exec("PRAGMA journal_mode=DELETE")
        try exec("BEGIN IMMEDIATE")
        for trigger in try texts("SELECT name FROM sqlite_master WHERE type = 'trigger'", on: handle) {
            try exec("DROP TRIGGER \(SQLiteDelta.quoted(trigger))")
        }
        for table in tables {
            if let keep = table.keep { try exec("DELETE FROM \(SQLiteDelta.quoted(table.name)) WHERE (\(keep)) IS NOT TRUE") }
        }
        for view in try texts("SELECT name FROM sqlite_master WHERE type = 'view'", on: handle) {
            try exec("DROP VIEW \(SQLiteDelta.quoted(view))")
        }
        let held = Set(tables.map(\.name))
        for table in try texts("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*'", on: handle) where !held.contains(table) {
            try exec("DROP TABLE \(SQLiteDelta.quoted(table))")
        }
        var rows = 0
        for table in tables { rows += try SQLite.integer("SELECT count(*) FROM \(SQLiteDelta.quoted(table.name))", on: handle) ?? 0 }
        if rows < SQLiteDelta.indexedRows {
            for index in try texts("SELECT m.name FROM sqlite_master AS m WHERE m.type = 'index' AND m.sql IS NOT NULL AND NOT EXISTS "
                                   + "(SELECT 1 FROM pragma_index_list(m.tbl_name) AS l WHERE l.name = m.name AND l.\"unique\" = 1)", on: handle) {
                try exec("DROP INDEX \(SQLiteDelta.quoted(index))")
            }
            for statistics in try texts("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'sqlite_stat*'", on: handle) {
                try exec("DROP TABLE \(SQLiteDelta.quoted(statistics))")
            }
        }
        try exec("COMMIT")
    }

    static func dress(_ database: URL, watched: String, indexes: [String] = []) throws -> OpaquePointer {
        try DomainFixtures.sqlite(database, ["PRAGMA auto_vacuum=INCREMENTAL", "VACUUM", "PRAGMA user_version=3"] + indexes + [
            "CREATE TRIGGER dressed_after_delete AFTER DELETE ON \(watched) BEGIN SELECT application_only_function(OLD.rowid); END",
            "ANALYZE",
            "PRAGMA journal_mode=WAL",
        ])
        let holder = try DomainFixtures.openSqlite(database)
        try DomainFixtures.run("PRAGMA wal_autocheckpoint=0", on: holder)
        try DomainFixtures.run("CREATE TABLE dressed_side (k TEXT PRIMARY KEY, v BLOB) WITHOUT ROWID", on: holder)
        try DomainFixtures.run("INSERT INTO dressed_side VALUES ('a', X'01'), ('b', X'02')", on: holder)
        return holder
    }

    static func assertEquivalent(_ source: URL, cursors: [Int], tables: (Int) -> [SQLiteDelta.Table],
                                 _ label: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let dir = source.deletingLastPathComponent().appendingPathComponent("equivalence-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        for after in cursors {
            let byCopy = dir.appendingPathComponent("by-copy-\(after).sqlite")
            let byRows = dir.appendingPathComponent("by-rows-\(after).sqlite")
            try Self.byCopy(from: source, to: byCopy, tables: tables(after))
            try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: byRows, tables: { _, _ in tables(after) })
            let written = try fingerprint(byRows)
            XCTAssertEqual(written.header["page_size"], SQLiteDelta.pageSize, "\(label) after \(after)", file: file, line: line)
            XCTAssertEqual(written.withoutPageSize, try fingerprint(byCopy).withoutPageSize, "\(label) after \(after)",
                           file: file, line: line)
        }
    }

    static func cursors(_ column: String, of table: String, in database: URL) throws -> [Int] {
        let range = try DomainFixtures.read("SELECT min(\(column)), max(\(column)) FROM \(table)", from: database)[0]
        let (lo, hi) = (Int(range[0] ?? "0") ?? 0, Int(range[1] ?? "0") ?? 0)
        return Array(Set([0, lo, (lo + hi) / 2, hi - 1, hi, hi + 5])).filter { $0 >= 0 }.sorted()
    }
}
