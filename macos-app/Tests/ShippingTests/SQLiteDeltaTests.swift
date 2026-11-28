import Foundation
import SQLite3
import XCTest
@testable import Shipping

final class SQLiteDeltaTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("sqlite-delta-tests")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var source: URL { root.appendingPathComponent("source.db") }
    private var output: URL { root.appendingPathComponent("delta.db") }

    private func buildSource(_ extra: [String] = []) throws {
        try DomainFixtures.sqlite(source, [
            "CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)",
            "INSERT INTO message (ROWID, body) VALUES (1, 'one'), (2, 'two'), (3, 'three')",
            "CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER)",
            "INSERT INTO message_attachment_join VALUES (1, 1), (3, 2)",
            "CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT)",
            "INSERT INTO attachment (ROWID, filename) VALUES (1, 'old.png'), (2, 'new.png')",
        ] + extra)
    }

    private func tables(after: Int) -> [SQLiteDelta.Table] {
        [SQLiteDelta.Table("message", keep: "ROWID > \(after)"),
         SQLiteDelta.Table("message_attachment_join", keep: "message_id IN (SELECT ROWID FROM message)"),
         SQLiteDelta.Table("attachment", keep: "ROWID IN (SELECT attachment_id FROM message_attachment_join)")]
    }


    func testThePredicatesApplyInOrder() throws {
        try buildSource()
        try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output, tables: { _, _ in self.tables(after: 2) })

        XCTAssertEqual(try DomainFixtures.read("SELECT ROWID, body FROM message", from: output),
                       [["3", "three"]])
        XCTAssertEqual(try DomainFixtures.read("SELECT filename FROM attachment", from: output),
                       [["new.png"]])
    }

    func testATableNamedWithNoPredicateTravelsWhole() throws {
        try buildSource(["CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT)",
                         "INSERT INTO handle VALUES (1, '+15550000001'), (2, 'person-a@example.com')"])
        try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output,
                              tables: { _, _ in self.tables(after: 2) + [SQLiteDelta.Table("handle")] })
        XCTAssertEqual(try DomainFixtures.read("SELECT count(*) FROM handle", from: output), [["2"]])
    }

    func testATableNotNamedIsLeftOutWithItsIndexesAndEveryView() throws {
        try buildSource(["CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT)",
                         "CREATE INDEX handle_id ON handle (id)",
                         "INSERT INTO handle VALUES (1, '+15550000001'), (2, 'person-a@example.com')",
                         "CREATE INDEX message_body ON message (body)",
                         "CREATE VIEW bodies AS SELECT body FROM message",
                         "ANALYZE"])
        try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output, tables: { _, _ in
            [SQLiteDelta.Table("message", keep: "ROWID IN (SELECT ROWID FROM handle)")]
        })
        XCTAssertEqual(try DomainFixtures.read("SELECT type, name FROM sqlite_master WHERE name NOT GLOB 'sqlite_autoindex*' ORDER BY name",
                                               from: output),
                       [["table", "message"], ["table", "sqlite_sequence"]])
        XCTAssertEqual(try DomainFixtures.read("SELECT ROWID FROM message ORDER BY ROWID", from: output), [["1"], ["2"]])
        XCTAssertEqual(try DomainFixtures.read("SELECT name FROM sqlite_sequence", from: output), [["message"]])
    }

    private func buildKeyed(items: Int, lookups: Int) throws {
        try DomainFixtures.sqlite(source, [
            "CREATE TABLE item (id INTEGER PRIMARY KEY, code TEXT UNIQUE, body TEXT)",
            "CREATE INDEX item_body ON item (body)",
            "CREATE UNIQUE INDEX item_pair ON item (body, code)",
            "WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < \(items)) "
                + "INSERT INTO item (id, code, body) SELECT value, 'code-' || value, 'body ' || (value % 7) FROM n WHERE value <= \(items)",
            "CREATE TABLE lookup (k TEXT PRIMARY KEY, v TEXT)",
            "CREATE INDEX lookup_v ON lookup (v)",
            "WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < \(lookups)) "
                + "INSERT INTO lookup (k, v) SELECT 'key-' || value, 'value ' || (value % 3) FROM n WHERE value <= \(lookups)",
            "CREATE TABLE extra (id INTEGER PRIMARY KEY, tag TEXT)",
            "CREATE INDEX extra_tag ON extra (tag)",
            "WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 50) "
                + "INSERT INTO extra (id, tag) SELECT value, 'tag ' || (value % 5) FROM n",
            "ANALYZE",
        ])
    }

    private func schema() throws -> [[String?]] {
        try DomainFixtures.read("SELECT type, name FROM sqlite_master ORDER BY name", from: output)
    }

    private let keys: [[String?]] = [["table", "item"], ["index", "item_pair"], ["table", "lookup"],
                                     ["index", "sqlite_autoindex_item_1"], ["index", "sqlite_autoindex_lookup_1"]]

    func testADeltaOfFewerThanFiveHundredRowsKeepsEveryKeyAndLeavesOutPlainIndexesAndStatistics() throws {
        try buildKeyed(items: 600, lookups: 0)
        try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output,
                              tables: { _, _ in [SQLiteDelta.Table("item", keep: "id < 500"), SQLiteDelta.Table("lookup")] })
        XCTAssertEqual(try DomainFixtures.read("SELECT count(*) FROM item", from: output), [["499"]])
        XCTAssertEqual(try schema(), keys)
        XCTAssertEqual(try DomainFixtures.read("SELECT name, \"unique\" FROM pragma_index_list('item') ORDER BY name", from: output),
                       [["item_pair", "1"], ["sqlite_autoindex_item_1", "1"]])
        XCTAssertEqual(try DomainFixtures.read("SELECT pk FROM pragma_table_info('item') WHERE name = 'id'", from: output), [["1"]])
        XCTAssertEqual(try DomainFixtures.read("PRAGMA quick_check", from: output), [["ok"]])
    }

    func testADeltaOfFiveHundredRowsKeepsEveryIndexAndTheStatisticsOfItsTables() throws {
        try buildKeyed(items: 600, lookups: 10)
        try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output,
                              tables: { _, _ in [SQLiteDelta.Table("item", keep: "id <= 490"), SQLiteDelta.Table("lookup")] })
        XCTAssertEqual(try DomainFixtures.read("SELECT count(*) FROM item", from: output), [["490"]])
        XCTAssertEqual(try schema(), [["table", "item"], ["index", "item_body"], ["index", "item_pair"], ["table", "lookup"],
                                      ["index", "lookup_v"], ["index", "sqlite_autoindex_item_1"],
                                      ["index", "sqlite_autoindex_lookup_1"], ["table", "sqlite_stat1"]])
        XCTAssertEqual(try DomainFixtures.read("SELECT DISTINCT tbl FROM sqlite_stat1 ORDER BY tbl", from: source),
                       [["extra"], ["item"], ["lookup"]])
        XCTAssertEqual(try DomainFixtures.read("SELECT DISTINCT tbl FROM sqlite_stat1 ORDER BY tbl", from: output),
                       [["item"], ["lookup"]], "only the statistics of the tables it holds")
        XCTAssertEqual(try DomainFixtures.read("SELECT tbl, idx, stat FROM sqlite_stat1 ORDER BY tbl, idx", from: output),
                       try DomainFixtures.read("SELECT tbl, idx, stat FROM sqlite_stat1 WHERE tbl IN ('item', 'lookup') "
                                               + "ORDER BY tbl, idx", from: source),
                       "the source's statistics, not the delta's")
        XCTAssertEqual(try DomainFixtures.read("PRAGMA quick_check", from: output), [["ok"]])
        let tables = { (after: Int) in [SQLiteDelta.Table("item", keep: "id > \(after)"), SQLiteDelta.Table("lookup")] }
        try SQLiteDeltaReference.assertEquivalent(source, cursors: [0, 50, 100], tables: tables, "five hundred rows or more")
    }

    func testTheRowsOfAWholeTableCountTowardFiveHundred() throws {
        try buildKeyed(items: 600, lookups: 300)
        try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output,
                              tables: { _, _ in [SQLiteDelta.Table("item", keep: "id < 200"), SQLiteDelta.Table("lookup")] })
        XCTAssertEqual(try schema(), keys, "199 and 300 rows")
        try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output,
                              tables: { _, _ in [SQLiteDelta.Table("item", keep: "id <= 200"), SQLiteDelta.Table("lookup")] })
        XCTAssertEqual(try schema().map { $0[1] ?? "" }.filter { $0 == "item_body" || $0 == "lookup_v" || $0 == "sqlite_stat1" },
                       ["item_body", "lookup_v", "sqlite_stat1"], "200 and 300 rows")
    }

    func testAVirtualTableIsLeftOutUnlessNamed() throws {
        try buildSource(["CREATE VIRTUAL TABLE search USING fts5(body)", "INSERT INTO search VALUES ('one'), ('two')"])
        try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output, tables: { _, _ in self.tables(after: 2) })
        XCTAssertEqual(try DomainFixtures.read("SELECT count(*) FROM sqlite_master WHERE name GLOB 'search*'", from: output), [["0"]])
        XCTAssertThrowsError(try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output,
                                                   tables: { _, _ in [SQLiteDelta.Table("search")] })) {
            XCTAssertEqual($0 as? SQLiteDeltaError, .virtualTable)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
    }

    func testADeltaOfOneRowOfOneTableOfALargePagedStoreCostsAFewSmallPages() throws {
        let handle = try DomainFixtures.openSqlite(source)
        try DomainFixtures.run("PRAGMA page_size=32768", on: handle)
        for index in 0..<19 {
            try DomainFixtures.run("CREATE TABLE t\(index) (id INTEGER PRIMARY KEY, url TEXT, title TEXT)", on: handle)
            try DomainFixtures.run("CREATE INDEX t\(index)_url ON t\(index) (url)", on: handle)
            try DomainFixtures.run("WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 400) "
                                   + "INSERT INTO t\(index) (url, title) SELECT 'https://example.com/' || value, 'page ' || value FROM n",
                                   on: handle)
        }
        sqlite3_close(handle)
        XCTAssertGreaterThan(try FileManager.default.attributesOfItem(atPath: source.path)[.size] as? Int ?? 0, 1_200_000)
        try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output, tables: { _, _ in [SQLiteDelta.Table("t7", keep: "id = 5")] })
        let size = try FileManager.default.attributesOfItem(atPath: output.path)[.size] as? Int ?? .max
        XCTAssertLessThanOrEqual(size, 2 * SQLiteDelta.pageSize, "the schema and the table")
        XCTAssertEqual(try SQLiteDeltaReference.fingerprint(output).header["page_size"], SQLiteDelta.pageSize)
        XCTAssertEqual(try DomainFixtures.read("SELECT name FROM sqlite_master ORDER BY name", from: output), [["t7"]])
        XCTAssertEqual(try DomainFixtures.read("SELECT id, url FROM t7", from: output), [["5", "https://example.com/5"]])
    }

    func testATriggerCallingAFunctionNoOneDefinedIsDroppedBeforeTheDeletes() throws {
        try buildSource([
            """
            CREATE TRIGGER after_delete_message AFTER DELETE ON message
            BEGIN SELECT application_only_function(OLD.ROWID); END
            """,
        ])
        XCTAssertEqual(try DomainFixtures.read(
            "SELECT count(*) FROM sqlite_master WHERE type = 'trigger'", from: source), [["1"]],
            "the fixture must hold the trigger the delta drops")

        try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output, tables: { _, _ in self.tables(after: 2) })

        XCTAssertEqual(try DomainFixtures.read(
            "SELECT count(*) FROM sqlite_master WHERE type = 'trigger'", from: output), [["0"]])
        XCTAssertEqual(try DomainFixtures.read("SELECT ROWID FROM message", from: output), [["3"]])
    }

    func testASparseRowIdSurvivesUnchanged() throws {
        var statements = ["CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)"]
        statements.append("INSERT INTO message (ROWID, body) VALUES "
            + (1...41).map { "(\($0), 'line \($0)')" }.joined(separator: ", "))
        try DomainFixtures.sqlite(source, statements)

        try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output,
                              tables: { _, _ in [SQLiteDelta.Table("message", keep: "ROWID > 39")] })

        XCTAssertEqual(try DomainFixtures.read("SELECT ROWID, body FROM message ORDER BY ROWID", from: output),
                       [["40", "line 40"], ["41", "line 41"]],
                       "nothing renumbers a table's declared primary key")
    }

    func testARowWhosePredicateAnswersNullIsDeleted() throws {
        try buildSource(["INSERT INTO message_attachment_join VALUES (NULL, 1)"])
        try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output, tables: { _, _ in self.tables(after: 2) })
        XCTAssertEqual(try DomainFixtures.read("SELECT message_id FROM message_attachment_join", from: output),
                       [["3"]])
    }


    private func cascade() throws -> (cursors: [Int], tables: (Int) -> [SQLiteDelta.Table]) {
        let stem = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Fixtures/delta-cascade")
        try DomainFixtures.sqlite(source, [try String(contentsOf: stem.appendingPathExtension("sql"), encoding: .utf8)])
        let spec = try JSONSerialization.jsonObject(with: Data(contentsOf: stem.appendingPathExtension("json")))
        guard let spec = spec as? [String: Any], let cursors = spec["cursors"] as? [Int],
              let tables = spec["tables"] as? [[String: Any]] else { throw DomainFixtures.FixtureError.file("read delta-cascade.json") }
        return (cursors, { after in
            tables.map { table in
                SQLiteDelta.Table(table["name"] as? String ?? "",
                                  keep: (table["keep"] as? String)?.replacingOccurrences(of: "{after}", with: String(after)))
            }
        })
    }

    private func holdWal() throws -> OpaquePointer {
        let holder = try DomainFixtures.openSqlite(source)
        try DomainFixtures.run("PRAGMA wal_autocheckpoint=0", on: holder)
        try DomainFixtures.run("INSERT INTO item (id, parent, reply, body) VALUES (13, 2, 9, X'0d'), (14, NULL, NULL, X'0e')", on: holder)
        try DomainFixtures.run("INSERT INTO link VALUES (13, 1), (14, 2)", on: holder)
        return holder
    }

    func testTheDeltaHoldsWhatTheDeltaByDefinitionHoldsAtEveryCursor() throws {
        let (cursors, tables) = try cascade()
        let holder = try holdWal()
        defer { sqlite3_close(holder) }
        try SQLiteDeltaReference.assertEquivalent(source, cursors: cursors, tables: tables, "cascade")
    }

    func testTheBytesEachPageReservesAreTheSources() throws {
        let handle = try DomainFixtures.openSqlite(source)
        try DomainFixtures.run("PRAGMA page_size=4096", on: handle)
        var reserve: Int32 = 12
        XCTAssertEqual(sqlite3_file_control(handle, "main", SQLITE_FCNTL_RESERVE_BYTES, &reserve), SQLITE_OK)
        for statement in ["PRAGMA auto_vacuum=INCREMENTAL",
                          "CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)",
                          "INSERT INTO message (body) VALUES ('one'), ('two'), ('three')"] {
            try DomainFixtures.run(statement, on: handle)
        }
        sqlite3_close(handle)
        let tables = { (after: Int) in [SQLiteDelta.Table("message", keep: "ROWID > \(after)")] }
        try SQLiteDeltaReference.assertEquivalent(source, cursors: [0, 2, 3], tables: tables, "reserved bytes")
        try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output, tables: { _, _ in tables(1) })
        XCTAssertEqual(try SQLiteDeltaReference.fingerprint(output).header["reserved_bytes"], 12)
        XCTAssertEqual(try SQLiteDeltaReference.fingerprint(output).header["auto_vacuum"], 2)
    }

    func testTheWalsRowsAreReadAndTheSourceIsLeftAsItWas() throws {
        let (_, tables) = try cascade()
        let holder = try holdWal()
        defer { sqlite3_close(holder) }
        let wal = URL(fileURLWithPath: source.path + "-wal")
        let before = try FileManager.default.attributesOfItem(atPath: wal.path)
        let sourceBefore = try Data(contentsOf: source)

        try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output, tables: { _, _ in tables(9) })

        XCTAssertEqual(try DomainFixtures.read("SELECT count(*) FROM item", from: output), [["8"]])
        XCTAssertEqual(try DomainFixtures.read("SELECT group_concat(id) FROM (SELECT id FROM item WHERE id > 9 ORDER BY id)",
                                               from: output), [["10,11,12,13,14"]])
        let after = try FileManager.default.attributesOfItem(atPath: wal.path)
        XCTAssertEqual(after[.size] as? Int, before[.size] as? Int)
        XCTAssertEqual(after[.modificationDate] as? Date, before[.modificationDate] as? Date)
        XCTAssertEqual(try Data(contentsOf: source), sourceBefore)
        XCTAssertEqual(try DomainFixtures.read("PRAGMA journal_mode", from: output), [["delete"]])
    }


    func testADeltaNamingATableTwiceOrNamingSQLitesOwnTablesRefuses() throws {
        try buildSource()
        for tables in [[SQLiteDelta.Table("message", keep: "TRUE"), SQLiteDelta.Table("MESSAGE")],
                       [SQLiteDelta.Table("sqlite_sequence")]] {
            XCTAssertThrowsError(try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output, tables: { _, _ in tables })) {
                XCTAssertTrue($0 is SQLiteDeltaError, "\($0)")
            }
            XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
        }
    }

    func testADeltaNamingAnInvalidTableOrStatingAnEmptyPredicateRefusesBeforeAnyCopy() throws {
        try buildSource()
        for table in [SQLiteDelta.Table("message; DROP TABLE message", keep: "ROWID > 1"),
                      SQLiteDelta.Table(""),
                      SQLiteDelta.Table("9lives", keep: "ROWID > 1"),
                      SQLiteDelta.Table("message", keep: "   ")] {
            XCTAssertThrowsError(try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output, tables: { _, _ in [table] }), table.name) {
                XCTAssertTrue($0 is SQLiteDeltaError, "\($0)")
            }
            XCTAssertFalse(FileManager.default.fileExists(atPath: output.path), "no copy was taken")
        }
    }

    func testAFailedDeltaLeavesNoOutputAndNoJournalBesideIt() throws {
        try buildSource()
        XCTAssertThrowsError(try SQLiteDelta.write(
            from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output,
            tables: { _, _ in [SQLiteDelta.Table("message", keep: "ROWID > 1"), SQLiteDelta.Table("absent", keep: "1 = 1")] }))

        for suffix in ["", "-wal", "-shm", "-journal"] {
            XCTAssertFalse(FileManager.default.fileExists(atPath: output.path + suffix), suffix)
        }
    }

    func testAKeptDeltaLeavesNoJournalFilesBesideIt() throws {
        try buildSource()
        try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output, tables: { _, _ in self.tables(after: 2) })
        for suffix in ["-wal", "-shm", "-journal"] {
            XCTAssertFalse(FileManager.default.fileExists(atPath: output.path + suffix), suffix)
        }
    }

    func testADatabaseThatCannotPassTheIntegrityCheckLeavesNoDelta() throws {
        try buildSource()
        var bytes = try Data(contentsOf: source)
        for index in 4096..<bytes.count { bytes[index] = 0x7f }
        try bytes.write(to: source)

        XCTAssertThrowsError(try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output, tables: { _, _ in self.tables(after: 0) }))
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
    }

    func testADeltaTheWriterKeptAnswersQuickCheckOK() throws {
        try buildSource()
        try SQLiteDelta.write(from: try SQLiteSource(source, scratch: DomainFixtures.sealScratch), to: output, tables: { _, _ in self.tables(after: 2) })
        XCTAssertEqual(try DomainFixtures.read("PRAGMA quick_check", from: output), [["ok"]])
    }
}
