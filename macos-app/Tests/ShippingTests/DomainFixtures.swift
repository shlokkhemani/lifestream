import CryptoKit
import Evidence
import Foundation
import HomeLink
import SQLite3
import XCTest
@testable import Shipping

enum DomainFixtures {
    static let imessageSource = "imessage:a@example.com:unit-0001"
    static let whatsappSource = "whatsapp:15550001111:unit-0001"
    static let machineSource = "machine:local:unit-0001"

    static func scratch(_ name: String) throws -> URL {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("\(name)-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    static var settingsFile: URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("mac-settings-\(UUID().uuidString)", isDirectory: true).appendingPathComponent(MacSettings.fileName)
    }

    static func directory(_ url: URL) throws -> URL {
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static func appleAccounts(signedIn account: String, under root: URL) throws -> URL {
        let list = root.appendingPathComponent("MobileMeAccounts.plist")
        try PropertyListSerialization.data(fromPropertyList: ["Accounts": [["AccountID": account]]], format: .binary, options: 0)
            .write(to: list)
        return list
    }

    @discardableResult
    static func write(_ text: String, to url: URL) throws -> URL {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
        return url
    }

    static func sqlite(_ url: URL, _ statements: [String]) throws {
        let handle = try openSqlite(url)
        defer { sqlite3_close(handle) }
        try run("PRAGMA synchronous=OFF", on: handle)
        for statement in statements { try run(statement, on: handle) }
    }

    static func closedWAL(_ url: URL, _ statements: [String]) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try sqlite(url, ["PRAGMA journal_mode=WAL"] + statements + ["PRAGMA wal_checkpoint(TRUNCATE)"])
        for suffix in ["-wal", "-shm"] { try? FileManager.default.removeItem(atPath: url.path + suffix) }
    }

    static func stamps(in folder: URL) throws -> [String: SQLiteHeldCopy.Stamp] {
        var stamps: [String: SQLiteHeldCopy.Stamp] = [:]
        for name in try FileManager.default.contentsOfDirectory(atPath: folder.path) {
            stamps[name] = SQLiteHeldCopy.Stamp.of(folder.appendingPathComponent(name).path)
        }
        return stamps
    }

    static func openSqlite(_ url: URL) throws -> OpaquePointer {
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE
        guard sqlite3_open_v2(url.path, &handle, flags, nil) == SQLITE_OK, let handle else {
            throw FixtureError.sqlite("open \(url.lastPathComponent)")
        }
        return handle
    }

    static func read(_ sql: String, from url: URL) throws -> [[String?]] {
        var handle: OpaquePointer?
        guard sqlite3_open_v2(url.path, &handle, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let handle else {
            throw FixtureError.sqlite("open \(url.lastPathComponent)")
        }
        defer { sqlite3_close(handle) }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw FixtureError.sqlite("\(sql): \(String(cString: sqlite3_errmsg(handle)))")
        }
        defer { sqlite3_finalize(statement) }
        var found: [[String?]] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            found.append((0..<sqlite3_column_count(statement)).map { column in
                sqlite3_column_text(statement, column).map { String(cString: $0) }
            })
        }
        return found
    }

    static func extract(_ member: String, of sealed: SealedBundle) throws -> URL {
        guard let bytes = try StoredZipReader(sealed.file).bytes(member) else { throw FixtureError.file("find \(member)") }
        let copy = sealed.file.deletingLastPathComponent().appendingPathComponent("read-\(UUID().uuidString).db")
        try bytes.write(to: copy)
        return copy
    }

    static func run(_ statement: String, on handle: OpaquePointer) throws {
        guard sqlite3_exec(handle, statement, nil, nil, nil) == SQLITE_OK else {
            throw FixtureError.sqlite("\(statement): \(String(cString: sqlite3_errmsg(handle)))")
        }
    }

    static func sha256(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func instant(_ spelling: String) throws -> Date {
        guard let date = UTCInstant.date(rfc3339: spelling) else { throw FixtureError.instant(spelling) }
        return date
    }

    static func identify(_ database: URL, uuid: String = storeUUID) throws {
        try sqlite(database, [identity(uuid)])
    }

    static let storeUUID = "00000000-0000-4000-8000-0000000000aa"

    static func identity(_ uuid: String = storeUUID) -> String {
        "CREATE TABLE IF NOT EXISTS Z_METADATA (Z_VERSION INTEGER PRIMARY KEY, Z_UUID VARCHAR(255), Z_PLIST BLOB); "
            + "DELETE FROM Z_METADATA; INSERT INTO Z_METADATA (Z_VERSION, Z_UUID) VALUES (1, '\(uuid)')"
    }

    static func request(work: URL, at spelling: String = "2026-09-23T04:00:00.000Z",
                        custody: SealCustody = ShippingFixture.first, owesThrough: Bool = false, start: Date? = nil,
                        monthsOwed: @escaping @Sendable ([String: Through.Month]) -> [String: Through.Month]? = { _ in nil },
                        held: @escaping @Sendable (Set<String>) -> Set<String> = { _ in [] }, staged: StagedBlobs? = nil)
        throws -> SealRequest {
        SealRequest(fetchedAt: try instant(spelling), workDirectory: try directory(work), scratch: sealScratch, custody: custody,
                    owesThrough: owesThrough, start: start, held: held, monthsOwed: monthsOwed, staged: staged)
    }

    static func facts(of bundle: SealedBundle) throws -> [String: Any] {
        let manifest = try XCTUnwrap(try JSONSerialization.jsonObject(
            with: try XCTUnwrap(try StoredZipReader(bundle.file).bytes("manifest.json"))) as? [String: Any])
        return try XCTUnwrap(manifest["facts"] as? [String: Any])
    }

    static func stated(_ domain: any ShippingDomain, _ request: SealRequest) throws -> Through? {
        XCTAssertEqual(try domain.seal(request), [], "\(domain.name): a read-through is no bundle")
        return domain.through
    }

    static func received<Entry: LedgerEntry>(_ entry: Entry, source: String, ledgers: Ledgers, seal: Int = 1,
                                            imported: Int = 0) throws -> SealCustody {
        try ledgers.ledger(pass: ShippingFixture.pass, source: source).record(entry, at: seal)
        return SealCustody(pass: ShippingFixture.pass, received: seal, imported: imported)
    }

    static func fresh(_ source: String, received: Int, imported: Int, folder: URL) async throws -> FreshAnswer {
        let home = FakeHome(sources: [source], clock: { Date() })
        home.restore(source, received: received, imported: imported)
        return try await ShippingFixture.link(home, folder: folder).exchange()
    }

    static func entry<Entry: LedgerEntry>(_ type: Entry.Type, of sealed: SealedBundle, ledgers: Ledgers) throws -> Entry {
        let seal = try XCTUnwrap(sealed.sidecar.seal, "a bundle with no seal records nothing")
        return try XCTUnwrap(try ledgers.ledger(Entry.self, pass: ShippingFixture.pass, source: sealed.sidecar.sourceId)
            .read()[seal], "seal \(seal) recorded nothing")
    }

    static func custody(of sealed: SealedBundle) throws -> [String: Any] {
        let manifest = try XCTUnwrap(JSONSerialization.jsonObject(
            with: try XCTUnwrap(try StoredZipReader(sealed.file).bytes("manifest.json"))) as? [String: Any])
        return try XCTUnwrap((manifest["custody"] as? [String: Any])?[sealed.sidecar.sourceId] as? [String: Any])
    }

    static let sealScratch = FileManager.default.temporaryDirectory
        .appendingPathComponent("shipping-tests-\(getpid())", isDirectory: true)
        .appendingPathComponent("scratch/mac/app", isDirectory: true)

    static func workspaces(_ prefix: String) -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: sealScratch.path)) ?? []
        return names.filter { $0.hasPrefix(SealWork.named(prefix)) }
    }

    static func fixture(_ name: String) throws -> String {
        try String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Fixtures/\(name).sql"), encoding: .utf8)
    }

    static func keys(in file: URL) throws -> [String: [Int]] {
        var kept: [String: [Int]] = [:]
        for case let table? in try read("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'", from: file)
            .map({ $0.first ?? nil }) {
            let rows = try read("SELECT rowid FROM \"\(table)\" ORDER BY rowid", from: file).compactMap { $0.first.flatMap { $0 }.flatMap { Int($0) } }
            if !rows.isEmpty { kept[table] = rows }
        }
        return kept
    }

    static var repository: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
    }

    static func connectorFixture(_ bundle: SealedBundle, connector: String, named name: String = "changes-bundle.zip",
                                 file: StaticString = #filePath, line: UInt = #line) throws {
        let target = repository.appendingPathComponent("packages/connect/\(connector)/test/\(name)")
        if ProcessInfo.processInfo.environment["LIFESTREAM_WRITE_FIXTURES"] == "1" {
            try? FileManager.default.removeItem(at: target)
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: bundle.file, to: target)
            return
        }
        let fresh = try StoredZipReader(bundle.file)
        let held = try StoredZipReader(target)
        XCTAssertEqual(fresh.names, held.names, file: file, line: line)
        for name in fresh.names where held.names.contains(name) {
            if name.hasSuffix(".sqlite") || name.hasSuffix(".db") {
                let mine = try extract(name, of: bundle)
                let theirs = bundle.file.deletingLastPathComponent().appendingPathComponent("held-\(UUID().uuidString).db")
                try XCTUnwrap(held.bytes(name)).write(to: theirs)
                XCTAssertEqual(try dump(mine), try dump(theirs), name, file: file, line: line)
            } else if name == "manifest.json" {
                XCTAssertEqual(try manifestShape(XCTUnwrap(fresh.bytes(name))), try manifestShape(XCTUnwrap(held.bytes(name))),
                               file: file, line: line)
            } else {
                XCTAssertEqual(fresh.bytes(name), held.bytes(name), name, file: file, line: line)
            }
        }
    }

    private static func manifestShape(_ data: Data) throws -> NSDictionary {
        var manifest = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        manifest["files"] = (manifest["files"] as? [[String: Any]])?.map { listed -> [String: Any] in
            guard let name = listed["file"] as? String, name.hasSuffix(".sqlite") || name.hasSuffix(".db") else { return listed }
            return ["file": name]
        }
        return manifest as NSDictionary
    }

    static func dump(_ file: URL) throws -> [String] {
        let handle = try SQLite.open(file)
        defer { sqlite3_close(handle) }
        var lines: [String] = []
        for case let table? in try read("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
                                        from: file).map({ $0.first ?? nil }) {
            lines.append("table \(table)")
            var statement: OpaquePointer?
            let sql = "SELECT rowid, * FROM \(SQLiteDelta.quoted(table)) ORDER BY rowid"
            guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
                throw FixtureError.sqlite(sql)
            }
            defer { sqlite3_finalize(statement) }
            var step = sqlite3_step(statement)
            while step == SQLITE_ROW {
                lines.append((0..<sqlite3_column_count(statement)).map { column in
                    switch sqlite3_column_type(statement, column) {
                    case SQLITE_NULL: return "null"
                    case SQLITE_INTEGER: return "integer:\(sqlite3_column_int64(statement, column))"
                    case SQLITE_FLOAT: return "real:\(sqlite3_column_double(statement, column).bitPattern)"
                    default:
                        let text = sqlite3_column_type(statement, column) == SQLITE_TEXT
                        let pointer = text ? UnsafeRawPointer(sqlite3_column_text(statement, column)) : sqlite3_column_blob(statement, column)
                        let count = Int(sqlite3_column_bytes(statement, column))
                        let bytes = pointer.map { Data(bytes: $0, count: count) } ?? Data()
                        return (text ? "text:" : "blob:") + bytes.map { String(format: "%02x", $0) }.joined()
                    }
                }.joined(separator: "|"))
                step = sqlite3_step(statement)
            }
            guard step == SQLITE_DONE else { throw FixtureError.sqlite(sql) }
        }
        return lines
    }

    enum FixtureError: Error, CustomStringConvertible {
        case sqlite(String)
        case file(String)
        case instant(String)

        var description: String {
            switch self {
            case .sqlite(let why): return "fixture sqlite could not \(why)"
            case .file(let why): return "the fixture could not \(why)"
            case .instant(let spelling): return "the fixture instant \(spelling) is not that spelling"
            }
        }
    }
}
