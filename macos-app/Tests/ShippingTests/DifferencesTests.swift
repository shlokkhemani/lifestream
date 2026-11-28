import DeviceFiles
import Foundation
import HomeLink
import SQLite3
import XCTest
@testable import Shipping

class DifferencesTests: XCTestCase {
    private var root: URL!
    private var files: DeviceFiles!

    class var form: DeviceFiles.Form { .plain }

    override func setUpWithError() throws {
        files = DeviceFiles(type(of: self).form)
        root = try DomainFixtures.scratch("differences-tests")
        try DomainFixtures.write("old media bytes", to: media.appendingPathComponent("Media/15550000002/old.jpg"))
        try DomainFixtures.write("new media bytes", to: media.appendingPathComponent("Media/15550000001-1700000000/new.jpg"))
        try modified(media.appendingPathComponent("Media/15550000002/old.jpg"), at: "2026-08-15T00:00:00.000Z")
        try modified(media.appendingPathComponent("Media/15550000001-1700000000/new.jpg"), at: "2026-09-20T00:00:00.000Z")
        try DomainFixtures.sqlite(chats, [try DomainFixtures.fixture("whatsapp-store")])
        try DomainFixtures.sqlite(calls, [try DomainFixtures.fixture("whatsapp-calls")])
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var container: URL { root.appendingPathComponent("Library/Group Containers/group.net.whatsapp.WhatsApp.shared", isDirectory: true) }
    private var chats: URL { container.appendingPathComponent("ChatStorage.sqlite") }
    private var calls: URL { container.appendingPathComponent("CallHistory.sqlite") }
    private var media: URL { container.appendingPathComponent("Message", isDirectory: true) }
    private static let chatsFile = "chats.sqlite"
    private static let callsFile = "calls.sqlite"
    private static let businessFile = "business.sqlite"
    private var work: URL { root.appendingPathComponent("work", isDirectory: true) }
    private var ledgers: Ledgers { Ledgers(root: root.appendingPathComponent("ledger", isDirectory: true), files: files) }
    private static let source = DomainFixtures.whatsappSource
    static let fetchedAt = "2026-09-23T04:00:00.000Z"

    private let said = Collected<String>()

    private func domain() throws -> DifferencesDomain {
        try StoreFixtures.sqlite(Self.source, home: root, ledgers: ledgers, hashCache: root.appendingPathComponent("hash-cache/whatsapp.json"),
                                 report: { [said] in said.append($0) })
    }

    private func custody(_ received: Int, imported: Int? = nil, pass: String = ShippingFixture.pass) -> SealCustody {
        SealCustody(pass: pass, received: received, imported: imported ?? received)
    }

    private func seal(_ custody: SealCustody, minute: Int = 0, owesThrough: Bool = false, start: Date? = nil,
                      owed: @escaping @Sendable ([String: Through.Month]) -> [String: Through.Month]? = { _ in nil },
                      forceCold: Bool = false, on given: DifferencesDomain? = nil) throws -> [SealedBundle] {
        let at = try DomainFixtures.instant(Self.fetchedAt).addingTimeInterval(Double(minute) * 60)
        return try (given ?? domain()).seal(SealRequest(fetchedAt: at, workDirectory: try DomainFixtures.directory(work), scratch: try DomainFixtures.directory(work), custody: custody,
                                             owesThrough: owesThrough, start: start, monthsOwed: owed, forceCold: forceCold))
    }

    private func stated(_ custody: SealCustody, minute: Int, start: Date? = nil) throws -> Through? {
        let domain = try domain()
        XCTAssertEqual(try seal(custody, minute: minute, owesThrough: true, start: start, on: domain), [],
                       "a read-through is no bundle")
        return domain.through
    }

    private func keys(_ bundle: SealedBundle, _ member: String = DifferencesTests.chatsFile) throws -> [String: [Int]] {
        let file = try DomainFixtures.extract(member, of: bundle)
        XCTAssertEqual(try DomainFixtures.read("PRAGMA quick_check", from: file), [["ok"]])
        return try DomainFixtures.keys(in: file)
    }

    private func facts(_ bundle: SealedBundle) throws -> [String: Any] {
        let manifest = try XCTUnwrap(try JSONSerialization.jsonObject(
            with: try XCTUnwrap(try StoredZipReader(bundle.file).bytes("manifest.json"))) as? [String: Any])
        return try XCTUnwrap(manifest["facts"] as? [String: Any])
    }

    private func modified(_ file: URL, at spelling: String) throws {
        try FileManager.default.setAttributes([.modificationDate: try DomainFixtures.instant(spelling)], ofItemAtPath: file.path)
    }

    static let months = ["2026-05": Through.Month(items: 3, bytes: 0), "2026-08": Through.Month(items: 0, bytes: 15),
                         "2026-09": Through.Month(items: 2, bytes: 15)]

    private func firstSync() throws {
        XCTAssertEqual(try seal(custody(0)).count, 2)
    }

    private func change(_ statements: String...) throws {
        try DomainFixtures.sqlite(chats, statements)
    }

    func testAStoreFileHoldsOnlyItsDeclaredTablesAtSmallPages() throws {
        let store = root.appendingPathComponent("places.sqlite")
        let handle = try DomainFixtures.openSqlite(store)
        try DomainFixtures.run("PRAGMA page_size=32768", on: handle)
        for index in 0..<19 {
            try DomainFixtures.run("CREATE TABLE t\(index) (id INTEGER PRIMARY KEY, url TEXT, title TEXT)", on: handle)
            try DomainFixtures.run("CREATE INDEX t\(index)_url ON t\(index) (url)", on: handle)
            if index == 7 { continue }
            try DomainFixtures.run("WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 400) "
                                   + "INSERT INTO t\(index) (url, title) SELECT 'https://example.com/' || value, 'page ' || value FROM n",
                                   on: handle)
        }
        try DomainFixtures.run("CREATE VIEW recent AS SELECT url FROM t0", on: handle)
        try DomainFixtures.run("INSERT INTO t7 (url, title) VALUES ('https://example.com/visited', 'one visit')", on: handle)
        sqlite3_close(handle)
        let declared = Differences.Store(member: "places.sqlite", database: store, identity: .file, schema: { _ in
            StoreSchema(tables: [.init("t7", key: "id", .changes)])
        })
        let domain = DifferencesDomain(sourceId: "example-store:local:macbook-pro-0001", name: "example-store", feeder: "example-store-mac",
                                       ledgers: ledgers, hashCache: root.appendingPathComponent("places-cache.json")) { [declared] in [declared] }
        let sealed = try domain.seal(DomainFixtures.request(work: work, custody: custody(0)))
        XCTAssertEqual(sealed.count, 1)
        let file = try DomainFixtures.extract("places.sqlite", of: try XCTUnwrap(sealed.first))
        XCTAssertLessThan(try XCTUnwrap(try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int), 64 * 1024)
        XCTAssertEqual(try DomainFixtures.read("PRAGMA quick_check", from: file), [["ok"]])
        XCTAssertEqual(try DomainFixtures.read("PRAGMA page_size", from: file), [["4096"]])
        XCTAssertEqual(try DomainFixtures.read("SELECT type, name FROM sqlite_master ORDER BY name", from: file),
                       [["table", "t7"]])
        XCTAssertEqual(try DomainFixtures.read("SELECT url, title FROM t7", from: file), [["https://example.com/visited", "one visit"]])
    }

    func testAMediaFileOmittedFromTheIndexStaysEligible() throws {
        let locator = "Media/15550000001-1700000000/new.jpg"
        let file = media.appendingPathComponent(locator)
        let store = Differences.Store(member: Self.chatsFile, database: chats, identity: .coreData,
                                      schema: try StoreFixtures.schema("whatsapp", member: Self.chatsFile), attachments: Differences.Attachments(member: "media.json", locators: { _ in
            try? FileManager.default.removeItem(at: file)
            return [locator]
        }), fileRoot: media)
        let request = try DomainFixtures.request(work: work, custody: custody(1, imported: 0))
        let collecting = DifferencesDomain(sourceId: Self.source, name: "whatsapp", feeder: "whatsapp-mac",
                                            ledgers: ledgers, hashCache: root.appendingPathComponent("omitted-cache.json")) { [store] }
        let first = try collecting.seal(request)
        XCTAssertEqual(first.count, 1)
        XCTAssertEqual(try StoredZipReader(first[0].file).names.filter { $0.hasPrefix("blobs/") }, [])
        try DomainFixtures.write("new media bytes", to: file)
        let returned = try seal(custody(2, imported: 1), minute: 1, owesThrough: true)
        let live = try XCTUnwrap(returned.first { $0.sidecar.kind == "changes" })
        XCTAssertEqual(try keys(live)["ZWAMESSAGE"], [5])
        XCTAssertTrue(try StoredZipReader(live.file).names.contains("blobs/\(DomainFixtures.sha256("new media bytes"))"))
    }

    func testRejectedMediaLocatorsShipTheirRowsOnlyOnce() throws {
        let outside = root.appendingPathComponent("outside.jpg")
        try DomainFixtures.write("synthetic outside bytes", to: outside)
        try FileManager.default.createSymbolicLink(at: media.appendingPathComponent("escape.jpg"), withDestinationURL: outside)
        try FileManager.default.createSymbolicLink(at: media.appendingPathComponent("escape"), withDestinationURL: root)
        let locators = ["", "../outside.jpg", outside.path, "escape.jpg", "escape/outside.jpg",
                        "Media/../escape.jpg", "C:\\outside.jpg", "escape.jpg\0ignored"]
        for (index, locator) in locators.enumerated() {
            let hex = Data(locator.utf8).map { String(format: "%02x", $0) }.joined()
            try change("UPDATE ZWAMEDIAITEM SET ZMEDIALOCALPATH = CAST(X'\(hex)' AS TEXT)",
                       "UPDATE ZWAMESSAGE SET ZPARENTMESSAGE = NULL")
            let domain = try StoreFixtures.sqlite(Self.source, home: root, ledgers: Ledgers(root: root.appendingPathComponent("rejected-ledger-\(index)"), files: DeviceFiles(.plain)),
                                                  hashCache: root.appendingPathComponent("rejected-cache-\(index).json"))
            let first = try domain.seal(DomainFixtures.request(work: work, custody: custody(0)))
            XCTAssertEqual(first.map(\.sidecar.kind), ["changes", "history"], locator)
            XCTAssertEqual(try keys(first[0])["ZWAMESSAGE"], [4, 5], locator)
            XCTAssertEqual(try keys(first[1])["ZWAMESSAGE"], [1, 2, 3], locator)
            for bundle in first {
                XCTAssertEqual(try StoredZipReader(bundle.file).names.filter { $0.hasPrefix("blobs/") }, [], locator)
            }
            let next = try domain.seal(DomainFixtures.request(work: work, custody: custody(2), owesThrough: true))
            XCTAssertEqual(next, [], locator)
            XCTAssertNotNil(domain.through, "its read-through: \(locator)")
            XCTAssertEqual(try domain.seal(DomainFixtures.request(work: work, custody: custody(2))), [], locator)
        }
    }

    func testDeletingTheRollbackJournalMakesTheStoreDue() throws {
        let writer = try DomainFixtures.openSqlite(chats)
        defer { sqlite3_close(writer) }
        try DomainFixtures.run("PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE; UPDATE ZWAMESSAGE SET ZTEXT = 'committed edit' WHERE Z_PK = 5", on: writer)
        XCTAssertEqual(sqlite3_db_cacheflush(writer), SQLITE_OK)
        let journal = URL(fileURLWithPath: chats.path + "-journal")
        let rollback = try Data(contentsOf: journal)
        try DomainFixtures.run("COMMIT", on: writer)
        try rollback.write(to: journal)
        let first = try seal(custody(0))
        let old = try DomainFixtures.extract(Self.chatsFile, of: first[0])
        XCTAssertNotEqual(try DomainFixtures.read("SELECT ZTEXT FROM ZWAMESSAGE WHERE Z_PK = 5", from: old), [["committed edit"]])
        let databaseStamp = SQLiteHeldCopy.Stamp.of(chats.path)
        try FileManager.default.removeItem(at: journal)
        XCTAssertEqual(SQLiteHeldCopy.Stamp.of(chats.path), databaseStamp)
        let committed = try XCTUnwrap(try seal(custody(2), minute: 1).first)
        XCTAssertEqual(try keys(committed)["ZWAMESSAGE"], [5])
        XCTAssertEqual(try DomainFixtures.read("SELECT ZTEXT FROM ZWAMESSAGE WHERE Z_PK = 5",
                                              from: DomainFixtures.extract(Self.chatsFile, of: committed)), [["committed edit"]])
    }

    func testAnUnsetMessageTimeShipsLive() throws {
        try change("UPDATE ZWAMESSAGE SET ZMESSAGEDATE = 0, ZPARENTMESSAGE = NULL")
        let sealed = try seal(custody(0))
        XCTAssertEqual(sealed.map(\.sidecar.kind), ["changes"])
        XCTAssertEqual(try keys(sealed[0])["ZWAMESSAGE"], [1, 2, 3, 4, 5])
    }

    func testACorruptStoreCannotSealABundle() throws {
        var bytes = try Data(contentsOf: chats)
        for index in 4096..<bytes.count { bytes[index] = 0x7f }
        try bytes.write(to: chats)
        XCTAssertThrowsError(try seal(custody(0)))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: work.path), [])
    }


    func testAFirstSyncSealsTheLiveSpanThenOneHistoryPage() throws {
        let sealed = try seal(custody(0))
        XCTAssertEqual(sealed.map(\.sidecar.seal), [1, 2])
        XCTAssertEqual(sealed.map(\.sidecar.kind), ["changes", "history"])
        let live = try keys(sealed[0])
        XCTAssertEqual(live["ZWAMESSAGE"], [1, 4, 5], "the live span, and the old message 4 replies to")
        XCTAssertEqual(live["ZWAMEDIAITEM"], [1, 2])
        XCTAssertEqual(live["ZWAMESSAGEINFO"], [1, 4, 5])
        XCTAssertEqual(live["ZWACHATSESSION"], [1, 2, 3, 4], "every chat: a chat with no message among them")
        XCTAssertEqual(live["ZWAGROUPINFO"], [1, 2])
        XCTAssertEqual(live["ZWAGROUPMEMBER"], [2], "the member a live message names")
        XCTAssertEqual(live["ZWAPROFILEPUSHNAME"], [1, 2, 3])
        XCTAssertNil(live["ZWAPROFILEPICTUREITEM"], "a table the connector does not read is left out")
        XCTAssertNil(live["Z_METADATA"])
        XCTAssertEqual(try keys(sealed[0], Self.callsFile)["ZWACDCALLEVENT"], [1, 2])
        XCTAssertEqual(try facts(sealed[0])["kind"] as? String, "changes")
        XCTAssertNil(try facts(sealed[0])["history"])
        XCTAssertEqual(try facts(sealed[0])["left"] as? Int, 3, "the live bundle states the rows older than its span, the page not yet sent")

        let page = try keys(sealed[1])
        XCTAssertEqual(page["ZWAMESSAGE"], [2, 3], "the older messages the live bundle did not carry")
        XCTAssertEqual(page["ZWACHATSESSION"], [2, 3], "the chats the page's messages belong to, for lookup")
        XCTAssertEqual(try facts(sealed[1])["history"] as? Bool, true)
        XCTAssertEqual(try facts(sealed[1])["kind"] as? String, "changes")
        XCTAssertEqual(try facts(sealed[1])["left"] as? Int, 0, "the page carried every row owed")
        XCTAssertEqual(try StoredZipReader(sealed[1].file).names.filter { $0.hasSuffix(".sqlite") }, [Self.chatsFile])
        XCTAssertEqual(try DomainFixtures.custody(of: sealed[1])["seal"] as? Int, 2)
        try DomainFixtures.connectorFixture(sealed[0], connector: "messages/whatsapp")
    }

    func testTheMediaTheSealedRowsNameShipOnce() throws {
        let first = try seal(custody(0))
        let zip = try StoredZipReader(first[0].file)
        XCTAssertEqual(zip.names.filter { $0.hasPrefix("blobs/") }.count, 2)
        try change("UPDATE ZWAMESSAGE SET ZTEXT = 'synthetic message five, edited' WHERE Z_PK = 5")
        let edited = try seal(custody(2), minute: 1)
        let again = try StoredZipReader(edited[0].file)
        XCTAssertEqual(again.names.filter { $0.hasPrefix("blobs/") }, [], "the home holds the bytes")
        XCTAssertTrue(try XCTUnwrap(again.text("media.json")).contains("Media/15550000001-1700000000/new.jpg"))
    }

    func testAPointerNamesBytesOnlyInsideTheTreeAndOnlyAsText() throws {
        try DomainFixtures.write("escaped", to: root.appendingPathComponent("outside/escape.jpg"))
        try change("UPDATE ZWAMEDIAITEM SET ZXMPPTHUMBPATH = '../outside/escape.jpg', ZTHUMBNAILLOCALPATH = 'Media/gone.jpg' WHERE Z_PK = 2")
        let index = try XCTUnwrap(try StoredZipReader(try seal(custody(0))[0].file).text("media.json"))
        XCTAssertFalse(index.contains("escape"))
        XCTAssertFalse(index.contains("gone"))
        XCTAssertTrue(index.contains("Media/15550000001-1700000000/new.jpg"))

        try change("UPDATE ZWAMEDIAITEM SET ZMEDIALOCALPATH = X'07' WHERE Z_PK = 2")
        XCTAssertThrowsError(try seal(custody(2), minute: 1)) { error in
            XCTAssertEqual("\(error)", "ZWAMEDIAITEM.ZMEDIALOCALPATH is not text or NULL")
        }
    }


    func testAnEditAnUnsendAndANewRowEachShipAloneWithWhatTheyPull() throws {
        try firstSync()
        try change("UPDATE ZWAMESSAGE SET ZTEXT = 'a synthetic reply, edited' WHERE Z_PK = 4")
        var sealed = try seal(custody(2), minute: 1)
        XCTAssertEqual(sealed.count, 1)
        XCTAssertEqual(try keys(sealed[0])["ZWAMESSAGE"], [1, 4], "the edit, and the parent it replies to for lookup")
        XCTAssertEqual(try keys(sealed[0])["ZWACHATSESSION"], [1])
        XCTAssertNil(try keys(sealed[0])["ZWAPROFILEPUSHNAME"])

        try change("UPDATE ZWAMESSAGE SET ZTEXT = NULL, ZMESSAGETYPE = 14 WHERE Z_PK = 5")
        sealed = try seal(custody(3), minute: 2)
        XCTAssertEqual(try keys(sealed[0])["ZWAMESSAGE"], [5], "the unsend")

        try change("INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCHATSESSION, ZSTANZAID, ZTEXT, ZFROMJID, ZMESSAGEDATE, ZISFROMME) "
                   + "VALUES (6, 9, 1, 3, 'SYNTH-6', 'synthetic message six', '15550000004@s.whatsapp.net', 811600000, 0)")
        sealed = try seal(custody(4), minute: 3)
        XCTAssertEqual(try keys(sealed[0])["ZWAMESSAGE"], [6])
        XCTAssertEqual(try keys(sealed[0])["ZWACHATSESSION"], [3])
    }

    func testAReplyCarriesEveryMessageUpItsThread() throws {
        try firstSync()
        try change("UPDATE ZWAMESSAGE SET ZPARENTMESSAGE = 4, ZTEXT = 'a reply to the reply' WHERE Z_PK = 5")
        XCTAssertEqual(try keys(try seal(custody(2), minute: 1)[0])["ZWAMESSAGE"], [1, 4, 5])
    }

    func testAReactionShipsItsMessage() throws {
        try firstSync()
        try change("UPDATE ZWAMESSAGEINFO SET ZRECEIPTINFO = X'0405' WHERE ZMESSAGE = 4",
                   "UPDATE ZWAMESSAGEINFO SET ZRECEIPTINFO = X'0205' WHERE ZMESSAGE = 2")
        let sealed = try seal(custody(2), minute: 1)
        XCTAssertEqual(sealed.map(\.sidecar.kind), ["changes", "history"])
        XCTAssertEqual(try keys(sealed[0])["ZWAMESSAGE"], [1, 4])
        XCTAssertEqual(try keys(sealed[0])["ZWAMESSAGEINFO"], [1, 4])
        XCTAssertEqual(try keys(sealed[1])["ZWAMESSAGE"], [2])
        XCTAssertEqual(try keys(sealed[1])["ZWAMESSAGEINFO"], [2])
    }

    func testAChangedChatRowWithNoChangedMessageShips() throws {
        try firstSync()
        try change("UPDATE ZWACHATSESSION SET ZPARTNERNAME = 'Synthetic Group H, renamed' WHERE Z_PK = 4",
                   "UPDATE ZWAGROUPINFO SET ZSUBJECTTIMESTAMP = 811600000 WHERE Z_PK = 1")
        let sealed = try seal(custody(2), minute: 1)
        XCTAssertEqual(sealed.count, 1)
        let kept = try keys(sealed[0])
        XCTAssertNil(kept["ZWAMESSAGE"])
        XCTAssertEqual(kept["ZWACHATSESSION"], [2, 4], "the renamed chat, and the chat whose group changed")
        XCTAssertEqual(kept["ZWAGROUPINFO"], [1, 2])
    }

    func testAGroupMemberThatChangesShipsItsMessages() throws {
        try firstSync()
        try change("UPDATE ZWAGROUPMEMBER SET ZCONTACTIDENTIFIER = '90000000000099@lid' WHERE Z_PK = 2")
        let sealed = try seal(custody(2), minute: 1)
        XCTAssertEqual(try keys(sealed[0])["ZWAMESSAGE"], [5])
        XCTAssertEqual(try keys(sealed[0])["ZWAGROUPMEMBER"], [2])
    }

    func testAMediaItemThatChangesShipsItsMessage() throws {
        try firstSync()
        try DomainFixtures.write("later media bytes", to: media.appendingPathComponent("Media/15550000002/later.jpg"))
        try change("UPDATE ZWAMEDIAITEM SET ZTHUMBNAILLOCALPATH = 'Media/15550000002/later.jpg' WHERE Z_PK = 1")
        let sealed = try seal(custody(2), minute: 1)
        XCTAssertEqual(sealed.map(\.sidecar.kind), ["history"], "message 1 is old: its page")
        XCTAssertEqual(try keys(sealed[0])["ZWAMESSAGE"], [1])
        XCTAssertEqual(try keys(sealed[0])["ZWAMEDIAITEM"], [1])
        XCTAssertEqual(try StoredZipReader(sealed[0].file).names.filter { $0.hasPrefix("blobs/") },
                       ["blobs/\(DomainFixtures.sha256("later media bytes"))"])
    }

    func testAMediaFileThatAppearsAfterItsRowShipsItsMessage() throws {
        try change("UPDATE ZWAMEDIAITEM SET ZTHUMBNAILLOCALPATH = 'Media/15550000002/later.jpg' WHERE Z_PK = 1",
                   "UPDATE ZWAMEDIAITEM SET ZXMPPTHUMBPATH = 'Media/15550000002/never.jpg' WHERE Z_PK = 2")
        try firstSync()
        XCTAssertNotNil(try stated(custody(2), minute: 1), "a file still absent: its read-through")
        try DomainFixtures.write("later media bytes", to: media.appendingPathComponent("Media/15550000002/later.jpg"))
        let sealed = try seal(custody(2), minute: 2)
        XCTAssertEqual(sealed.map(\.sidecar.kind), ["history"], "the row waiting on its file is read again at the next wake: message 1 is old, its page")
        XCTAssertEqual(try keys(sealed[0])["ZWAMESSAGE"], [1])
        XCTAssertEqual(try StoredZipReader(sealed[0].file).names.filter { $0.hasPrefix("blobs/") },
                       ["blobs/\(DomainFixtures.sha256("later media bytes"))"])
        XCTAssertNotNil(try stated(custody(3), minute: 3), "shipped once")
    }

    func testAMediaFileTheDeviceClearsShipsNothing() throws {
        let old = media.appendingPathComponent("Media/15550000002/old.jpg")
        let new = media.appendingPathComponent("Media/15550000001-1700000000/new.jpg")
        try firstSync()
        try FileManager.default.removeItem(at: old)
        try FileManager.default.removeItem(at: new)
        XCTAssertNotNil(try stated(custody(2), minute: 1), "cleared: its read-through")
        try DomainFixtures.write("old media bytes", to: old)
        XCTAssertNotNil(try stated(custody(2), minute: 2), "back the same: its read-through")
        try DomainFixtures.write("new media bytes, downloaded whole", to: new)
        XCTAssertNotNil(try stated(custody(2), minute: 3), "an unchanged store with no file waiting is not read between cold passes")
        let sealed = try seal(custody(2), minute: 4, owesThrough: true, forceCold: true)
        XCTAssertEqual(sealed.map(\.sidecar.kind), ["changes"])
        XCTAssertEqual(try keys(sealed[0])["ZWAMESSAGE"], [5])
        XCTAssertEqual(try StoredZipReader(sealed[0].file).names.filter { $0.hasPrefix("blobs/") },
                       ["blobs/\(DomainFixtures.sha256("new media bytes, downloaded whole"))"])
    }

    func testAMemoryWhoseRowsStateNoFilesShipsTheirFilesOnce() throws {
        try firstSync()
        let memory = ledgers.memory(pass: ShippingFixture.pass, source: Self.source).appendingPathComponent("memory-" + files.name(Self.chatsFile))
        try DomainFixtures.sqlite(memory, [
            "CREATE TABLE old (tbl TEXT NOT NULL, key INTEGER NOT NULL, fingerprint INTEGER NOT NULL, seal INTEGER NOT NULL, "
                + "PRIMARY KEY (tbl, key)) WITHOUT ROWID",
            "INSERT INTO old SELECT tbl, key, fingerprint, seal FROM rows", "DROP TABLE rows", "ALTER TABLE old RENAME TO rows",
            "CREATE INDEX rows_seal ON rows (seal)",
        ])
        let sealed = try seal(custody(2), minute: 1, owesThrough: true)
        XCTAssertEqual(sealed.map(\.sidecar.kind), ["changes", "history"])
        XCTAssertEqual(try keys(sealed[0])["ZWAMESSAGE"], [5])
        XCTAssertEqual(try keys(sealed[1])["ZWAMESSAGE"], [1])
        XCTAssertNotNil(try stated(custody(4), minute: 2))
    }

    func testTheCallHistoryShipsWhatChanged() throws {
        try firstSync()
        try DomainFixtures.sqlite(calls, ["UPDATE ZWAAGGREGATECALLEVENT SET ZMISSED = 1 WHERE Z_PK = 10"])
        let sealed = try seal(custody(2), minute: 1)
        XCTAssertEqual(try StoredZipReader(sealed[0].file).names.filter { $0.hasSuffix(".sqlite") }, [Self.callsFile],
                       "the chat store changed nothing")
        XCTAssertEqual(try keys(sealed[0], Self.callsFile)["ZWACDCALLEVENT"], [1, 2])
        XCTAssertEqual(try keys(sealed[0], Self.callsFile)["ZWACDCALLEVENTPARTICIPANT"], [100, 101])
    }

    func testTheBusinessListShipsItsVerifiedNamesAlone() throws {
        let business = container.appendingPathComponent("Biz/Biz.sqlite")
        try FileManager.default.createDirectory(at: business.deletingLastPathComponent(), withIntermediateDirectories: true)
        try DomainFixtures.sqlite(business, [try DomainFixtures.fixture("whatsapp-business")])
        let first = try seal(custody(0))
        let live = try XCTUnwrap(first.first { $0.sidecar.kind == "changes" })
        XCTAssertEqual(try keys(live, Self.businessFile), ["ZWABIZVERIFIEDNAMEDATA": [1, 2]], "no profile table travels")
        XCTAssertNotNil(try keys(live)["ZWAMESSAGE"], "the chats ship beside it")
        try DomainFixtures.sqlite(business, ["UPDATE ZWABIZVERIFIEDNAMEDATA SET ZVERIFICATIONLEVEL = 3, Z_OPT = 2 WHERE Z_PK = 2"])
        let sealed = try seal(custody(2), minute: 1)
        XCTAssertEqual(try StoredZipReader(sealed[0].file).names.filter { $0.hasSuffix(".sqlite") }, [Self.businessFile])
        XCTAssertEqual(try keys(sealed[0], Self.businessFile), ["ZWABIZVERIFIEDNAMEDATA": [2]])
    }


    func testARowTheAppDeletesSendsNothing() throws {
        try firstSync()
        try change("DELETE FROM ZWAMESSAGE WHERE Z_PK = 5")
        XCTAssertEqual(try seal(custody(2), minute: 1), [])
    }

    func testAQuietStoreStatesItsReadThrough() throws {
        try firstSync()
        let quiet = try domain()
        XCTAssertEqual(try seal(custody(2), minute: 1, on: quiet), [])
        XCTAssertNil(quiet.through, "none owed: none stated")
        let at = try DomainFixtures.instant("2026-09-23T04:02:00.000Z")
        XCTAssertEqual(try stated(custody(2), minute: 2), Through(readThrough: at, statedAt: at, left: 0, months: Self.months),
                       "its past has all shipped")
    }

    func testTheFirstBundleOfASealCarriesTheStoresCountWhileTheHomeHasNotKeptIt() throws {
        let sealed = try seal(custody(0), owed: { $0 })
        XCTAssertEqual(sealed.map(\.sidecar.kind), ["changes", "history"])
        let spelled: NSDictionary = ["2026-05": [3, 0], "2026-08": [0, 15], "2026-09": [2, 15]]
        XCTAssertEqual(try facts(sealed[0])["months"] as? NSDictionary, spelled, "the live bundle carries the count, beside left")
        XCTAssertNotNil(try facts(sealed[0])["left"])
        XCTAssertEqual(sealed[0].sidecar.months, Self.months, "the sidecar keeps it, for the home's acknowledgement on delivery")
        XCTAssertNil(try facts(sealed[1])["months"], "once per seal")
        XCTAssertNil(sealed[1].sidecar.months)

        try DomainFixtures.sqlite(chats, ["INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCHATSESSION, ZSTANZAID, ZMESSAGEDATE) "
                                          + "VALUES (6, 9, 1, 3, 'SYNTH-6', 811500300)"])
        let kept = try seal(custody(2), minute: 1)
        XCTAssertEqual(kept.map(\.sidecar.kind), ["changes"])
        XCTAssertNil(try facts(kept[0])["months"], "a count the home holds is not carried again")
        XCTAssertNil(kept[0].sidecar.months)
    }

    func testAStoreTheAppHasNeverWrittenHoldsNothingAndStatesAnEmptyCount() throws {
        try FileManager.default.removeItem(at: container)
        XCTAssertEqual(try stated(custody(0), minute: 0), Through(readThrough: try DomainFixtures.instant(Self.fetchedAt),
                                                                    statedAt: try DomainFixtures.instant(Self.fetchedAt), left: 0, months: [:]),
                       "no database is no history, never a failure to send")
    }

    func testARequiredStoreMissingBesideOneThatIsThereCannotSeal() throws {
        try FileManager.default.removeItem(at: chats)
        XCTAssertThrowsError(try seal(custody(0))) { error in
            XCTAssertEqual(error as? SQLiteError, .missing("ChatStorage.sqlite"))
        }
    }

    func testAReadThroughOfAStoreStillPagingStatesWhatItOwes() throws {
        let live = try seal(custody(1, imported: 0))
        XCTAssertEqual(live.map(\.sidecar.kind), ["changes"], "the page waits for the home's imports")
        XCTAssertEqual(try facts(live[0])["left"] as? Int, 3)
        XCTAssertEqual(try stated(custody(2, imported: 1), minute: 1)?.left, 2,
                       "messages 2 and 3, still owed to a page (message 4 went live)")
    }


    func testARestoreThatDropsTwoSealsSendsTheirRowsAgain() throws {
        try firstSync()
        try change("UPDATE ZWAMESSAGE SET ZTEXT = 'edit three' WHERE Z_PK = 4")
        _ = try seal(custody(2), minute: 1)
        try change("UPDATE ZWACHATSESSION SET ZUNREADCOUNT = 9 WHERE Z_PK = 3")
        _ = try seal(custody(3), minute: 2)
        let restored = try seal(custody(2), minute: 3)
        XCTAssertEqual(restored.map(\.sidecar.seal), [3])
        XCTAssertEqual(try keys(restored[0])["ZWAMESSAGE"], [1, 4])
        XCTAssertEqual(try keys(restored[0])["ZWACHATSESSION"], [1, 3])
    }

    func testABundleTheHomeNeverTookShipsAgainUnderItsSeal() throws {
        try firstSync()
        try change("UPDATE ZWAMESSAGE SET ZTEXT = 'edit four' WHERE Z_PK = 5")
        XCTAssertEqual(try seal(custody(2), minute: 1).map(\.sidecar.seal), [3])
        let again = try seal(custody(2), minute: 2)
        XCTAssertEqual(again.map(\.sidecar.seal), [3])
        XCTAssertEqual(try keys(again[0])["ZWAMESSAGE"], [5])
    }

    func testAStoreWithANewIdentityShipsWholeAgain() throws {
        try firstSync()
        try change("UPDATE Z_METADATA SET Z_UUID = '00000000-0000-4000-8000-0000000000bb'")
        let sealed = try seal(custody(2), minute: 1)
        XCTAssertEqual(sealed.map(\.sidecar.kind), ["changes", "history"])
        XCTAssertEqual(try keys(sealed[0])["ZWAMESSAGE"], [1, 4, 5])
        XCTAssertNil(try DomainFixtures.custody(of: sealed[0])["lost"])
    }

    private func domain(redeclaring member: String) throws -> DifferencesDomain {
        let declared = try StoreFixtures.declaration(of: Self.source).store
        var json = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(declared)) as? [String: Any])
        var engine = try XCTUnwrap(json["engine"] as? [String: Any])
        var stores = try XCTUnwrap(engine["stores"] as? [[String: Any]])
        let at = try XCTUnwrap(stores.firstIndex { $0["member"] as? String == member })
        XCTAssertNil(stores[at]["optional"])
        stores[at]["optional"] = false
        engine["stores"] = stores
        json["engine"] = engine
        let store = try JSONDecoder().decode(HomeLink.MacStore.self, from: JSONSerialization.data(withJSONObject: json))
        guard case .sqlite(let files) = store.engine else { throw StoreFixtures.StoreFixtureError.noMember(Self.source, "sqlite") }
        return SqliteEngine.domain(sourceId: Self.source, store: store, stores: files, folder: nil, files: StoreFiles(home: root, lifestream: []),
                                   ledgers: ledgers, hashCache: root.appendingPathComponent("hash-cache/whatsapp.json"), wake: nil,
                                   report: { [said] in said.append($0) })
    }

    func testAStoreWhoseDeclarationChangedShipsWholeUnderTheNewOne() throws {
        try firstSync()
        XCTAssertEqual(try seal(custody(2), minute: 1), [], "a quiet store shipped")
        let redeclared = try domain(redeclaring: Self.chatsFile)
        let sealed = try seal(custody(2), minute: 2, on: redeclared)
        XCTAssertEqual(sealed.map(\.sidecar.kind), ["changes", "history"], "a changed declaration was skipped by its file's stamp")
        XCTAssertEqual(try keys(sealed[0])["ZWAMESSAGE"], [1, 4, 5])
        XCTAssertNil(try StoredZipReader(sealed[0].file).bytes(Self.callsFile), "a file whose declaration did not change shipped again")
        XCTAssertNil(try DomainFixtures.custody(of: sealed[0])["lost"])
        XCTAssertEqual(try seal(custody(4), minute: 3, on: try domain(redeclaring: Self.chatsFile)), [], "the new declaration shipped twice")
    }

    func testARepairSendsEverythingAgain() throws {
        try firstSync()
        let sealed = try seal(custody(0, pass: "p-00000002"), minute: 1)
        XCTAssertEqual(sealed.map(\.sidecar.seal), [1, 2])
        XCTAssertEqual(try keys(sealed[0])["ZWAMESSAGE"], [1, 4, 5])
        XCTAssertEqual(sealed[0].sidecar.pass, "p-00000002")
    }

    func testRowsThePrunedAppLostAreStatedOnce() throws {
        try firstSync()
        try change("INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCHATSESSION, ZSTANZAID, ZMESSAGEDATE) VALUES "
                   + "(20, 9, 1, 1, 'SYNTH-20', 811600000), (21, 9, 1, 1, 'SYNTH-21', 811600100)",
                   "DELETE FROM ZWAMESSAGE WHERE Z_PK < 20")
        let sealed = try seal(custody(2), minute: 1)
        let lost = try XCTUnwrap((try DomainFixtures.custody(of: sealed[0])["lost"] as? [[String: Any]])?.first)
        XCTAssertEqual(lost["items"] as? Int, 14, "ids 6 to 19 passed unseen")
        XCTAssertEqual(lost["what"] as? String, "message rows with ids 6 to 19 left the app before this Mac carried them")
        try change("UPDATE ZWAMESSAGE SET ZTEXT = 'later' WHERE Z_PK = 21")
        XCTAssertNil(try DomainFixtures.custody(of: try seal(custody(3), minute: 2)[0])["lost"])
    }


    func testATextKeyedStoreIsRefusedWithItsReason() throws {
        let store = root.appendingPathComponent("texts.sqlite")
        try DomainFixtures.sqlite(store, ["CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT)",
                                          "INSERT INTO notes (id, body) VALUES ('note-a', 'synthetic note')"])
        let declared = Differences.Store(member: "texts.sqlite", database: store, identity: .file, schema: { _ in
            StoreSchema(tables: [.init("notes", key: "id", .changes)])
        })
        let domain = DifferencesDomain(sourceId: "example-store:local:macbook-pro-0001", name: "example-store", feeder: "example-store-mac",
                                       ledgers: ledgers, hashCache: root.appendingPathComponent("texts-cache.json")) { [declared] in [declared] }
        XCTAssertThrowsError(try domain.seal(DomainFixtures.request(work: work, custody: custody(0)))) { error in
            XCTAssertEqual(error as? DifferencesError, .keyNotInteger("notes"))
            XCTAssertEqual(ShipperRunRow.reason(error),
                           "the table notes keys a row by a value that is not an integer, which a store's key must be")
        }
        let memory = ledgers.memory(pass: ShippingFixture.pass, source: "example-store:local:macbook-pro-0001")
            .appendingPathComponent("memory-" + files.name("texts.sqlite"))
        XCTAssertEqual(try DomainFixtures.read("SELECT count(*) FROM rows", from: memory), [["0"]], "no text key reaches the memory")
    }

    func testABundleSealedBeforeACrashIsNotSealedAgain() throws {
        try firstSync()
        try change("UPDATE ZWAMESSAGE SET ZTEXT = 'edit before the crash' WHERE Z_PK = 5")
        XCTAssertEqual(try seal(custody(2), minute: 1).map(\.sidecar.seal), [3], "the bundle waits in pending, the run never ends")
        XCTAssertEqual(try seal(custody(3), minute: 2), [], "the memory already holds its rows")
    }

    func testAStoreMemoryHoldsKeyedValuesOnlyInTheKeyedForm() throws {
        try firstSync()
        let memory = ledgers.memory(pass: ShippingFixture.pass, source: Self.source).appendingPathComponent("memory-" + files.name(Self.chatsFile))
        let hashes = Set(try DomainFixtures.read("SELECT hash FROM blobs", from: memory).compactMap { $0.first ?? nil })
        let media = [DomainFixtures.sha256("old media bytes"), DomainFixtures.sha256("new media bytes")]
        XCTAssertEqual(hashes, Set(media.map(files.name)))
        let meta = try DomainFixtures.read("SELECT name, value FROM meta WHERE name IN ('identity', 'stamp') ORDER BY name", from: memory)
        XCTAssertEqual(meta.map { $0[0] }, ["identity", "stamp"])
        let stamp = try XCTUnwrap(meta[1][1])
        let months = try XCTUnwrap(try DomainFixtures.read("SELECT value FROM meta WHERE name = 'months'", from: memory).first?.first ?? nil)
        XCTAssertEqual(months.contains("2026-05"), !files.keyed, "the count is the store's own value, encrypted when keyed")
        if files.keyed {
            XCTAssertFalse(memory.lastPathComponent.contains(Self.chatsFile), "no member's name in the keyed memory's name")
            XCTAssertTrue(hashes.isDisjoint(with: media), "no content hash in the keyed memory")
            for value in meta.map({ $0[1] }) { XCTAssertTrue(ShippingState.isHexSHA256(try XCTUnwrap(value)), "a keyed name") }
        } else {
            XCTAssertTrue(stamp.contains(":"), "the plain stamp is today's: device, inode, size and time")
        }
        XCTAssertEqual(try seal(custody(2), minute: 1), [], "the stamp still matches, so a quiet store is not read")
    }

    func testTheFingerprintIsTheSameInEveryRelease() throws {
        let handle = try SQLite.open(root.appendingPathComponent("fingerprint.db"), flags: SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)
        defer { sqlite3_close(handle) }
        Fingerprint.register(on: handle, files: DeviceFiles(.plain))
        let rows = ["fingerprint(1, -2, 3.5, 'text', x'00ff', NULL, '')", "fingerprint(NULL)", "fingerprint('é', 9223372036854775807)",
                    Fingerprint.sql((0..<250).map { "'column \($0)'" })]
        let values = try rows.map { try XCTUnwrap(try SQLite.integer("SELECT \($0)", on: handle)) }
        XCTAssertEqual(values, [-5115860939135311223, -1766648438673175795, 2929041140418454171, -8911969144844124689])
    }

    func testALossFoundByAReadThatSealsOnlyAPageIsStated() throws {
        try firstSync()
        try change("INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCHATSESSION, ZSTANZAID, ZMESSAGEDATE) VALUES "
                   + "(20, 9, 1, 3, 'SYNTH-20', 700000000), (21, 9, 1, 3, 'SYNTH-21', 700000100)",
                   "DELETE FROM ZWAMESSAGE WHERE Z_PK < 20")
        let sealed = try seal(custody(2), minute: 1)
        XCTAssertEqual(sealed.map(\.sidecar.kind), ["history"])
        XCTAssertEqual(try keys(sealed[0])["ZWAMESSAGE"], [20, 21])
        let lost = try XCTUnwrap((try DomainFixtures.custody(of: sealed[0])["lost"] as? [[String: Any]])?.first)
        XCTAssertEqual(lost["what"] as? String, "message rows with ids 6 to 19 left the app before this Mac carried them")
        try change("UPDATE ZWAMESSAGE SET ZTEXT = 'later' WHERE Z_PK = 21")
        XCTAssertNil(try DomainFixtures.custody(of: try seal(custody(3), minute: 2)[0])["lost"], "stated once")
    }

    func testALossAfterRowsLeftForAPageIsStatedFromTheHighestCarried() throws {
        try change("UPDATE ZWAMESSAGE SET ZMESSAGEDATE = ZMESSAGEDATE - 2592000")
        XCTAssertEqual(try seal(custody(0)).map(\.sidecar.kind), ["changes", "history"])
        try change("UPDATE ZWAMESSAGEINFO SET ZRECEIPTINFO = X'09'",
                   "UPDATE ZWAPROFILEPUSHNAME SET ZPUSHNAME = 'Synthetic Peer B, renamed' WHERE Z_PK = 1")
        XCTAssertEqual(try seal(custody(2, imported: 1), minute: 1).map(\.sidecar.kind), ["changes"], "the page waits for the pace")
        try change("DELETE FROM ZWAMESSAGE",
                   "INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCHATSESSION, ZSTANZAID, ZMESSAGEDATE) VALUES (30, 9, 1, 1, 'SYNTH-30', 811600000)")
        let sealed = try seal(custody(3), minute: 2)
        XCTAssertEqual(try keys(sealed[0])["ZWAMESSAGE"], [30])
        let lost = try XCTUnwrap((try DomainFixtures.custody(of: sealed[0])["lost"] as? [[String: Any]])?.first)
        XCTAssertEqual(lost["what"] as? String, "message rows with ids 6 to 29 left the app before this Mac carried them")
    }

    func testAPageThatCannotBeSealedNeverHoldsBackLive() throws {
        try firstSync()
        try change("UPDATE ZWAMEDIAITEM SET ZMEDIALOCALPATH = X'07' WHERE Z_PK = 1",
                   "INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCHATSESSION, ZSTANZAID, ZTEXT, ZFROMJID, ZMESSAGEDATE, ZISFROMME) "
                   + "VALUES (6, 9, 1, 3, 'SYNTH-6', 'synthetic message six', '15550000004@s.whatsapp.net', 811600000, 0)")
        let sealed = try seal(custody(2), minute: 1)
        XCTAssertEqual(sealed.map(\.sidecar.kind), ["changes"])
        XCTAssertEqual(try keys(sealed[0])["ZWAMESSAGE"], [6])
        XCTAssertEqual(try seal(custody(3), minute: 2), [], "the store's stamp stands: not read again")
        try change("INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCHATSESSION, ZSTANZAID, ZMESSAGEDATE) VALUES (7, 9, 1, 3, 'SYNTH-7', 811600100)")
        let again = try seal(custody(3), minute: 3)
        XCTAssertEqual(again.map(\.sidecar.kind), ["changes"])
        XCTAssertEqual(try keys(again[0])["ZWAMESSAGE"], [7])
        XCTAssertEqual(said.all, ["whatsapp-mac: a history page of chats.sqlite was not sealed: ZWAMEDIAITEM.ZMEDIALOCALPATH is not text or NULL"])
        try change("UPDATE ZWAPROFILEPICTUREITEM SET ZTHUMBNAILDATA = X'5B5B'")
        XCTAssertThrowsError(try seal(custody(4), minute: 4)) { error in
            XCTAssertEqual("\(error)", "ZWAMEDIAITEM.ZMEDIALOCALPATH is not text or NULL")
        }
    }


    func testHistoryPagesAreBoundedNewestFirstAndPacedByTheHome() throws {
        try change("WITH RECURSIVE n(x) AS (SELECT 100 UNION ALL SELECT x + 1 FROM n WHERE x < 25099) "
                   + "INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCHATSESSION, ZSTANZAID, ZMESSAGEDATE) "
                   + "SELECT x, 9, 1, 3, 'SYNTH-OLD-' || x, 700000000 + x FROM n")
        let first = try seal(custody(0))
        XCTAssertEqual(first.map(\.sidecar.kind), ["changes", "history"])
        let page = try XCTUnwrap(try keys(first[1])["ZWAMESSAGE"])
        XCTAssertEqual(page.count, Differences.pageRows)
        XCTAssertEqual(Array(page.prefix(3)), [2, 3, 5102])
        XCTAssertEqual(page.last, 25099)

        XCTAssertEqual(try seal(custody(2, imported: 1), minute: 1), [], "the first page is not imported yet")
        let next = try seal(custody(2, imported: 2), minute: 2)
        XCTAssertEqual(next.map(\.sidecar.kind), ["history"])
        let rest = try XCTUnwrap(try keys(next[0])["ZWAMESSAGE"])
        XCTAssertEqual(rest, Array(100...5101), "the 5,002 the first page left")
        XCTAssertEqual(try seal(custody(3), minute: 3), [])
    }

    func testTheSourceOwesHistoryUntilThePageThatCarriesItsLastRowsIsSealed() throws {
        try change("WITH RECURSIVE n(x) AS (SELECT 100 UNION ALL SELECT x + 1 FROM n WHERE x < 25099) "
                   + "INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCHATSESSION, ZSTANZAID, ZMESSAGEDATE) "
                   + "SELECT x, 9, 1, 3, 'SYNTH-OLD-' || x, 700000000 + x FROM n")
        let domain = try domain()
        let held = SealCustody(pass: ShippingFixture.pass, received: 0, imported: 0, history: false)
        XCTAssertEqual(try seal(held, on: domain).map(\.sidecar.kind), ["changes"])
        XCTAssertTrue(domain.owesHistory, "held back, every old row is owed")
        XCTAssertEqual(try seal(custody(1), minute: 1, on: domain).map(\.sidecar.kind), ["history"])
        XCTAssertTrue(domain.owesHistory, "the first page left 5,002 rows")
        XCTAssertEqual(try seal(custody(2), minute: 2, on: domain).map(\.sidecar.kind), ["history"])
        XCTAssertFalse(domain.owesHistory, "the page that carried the last of them was sealed")
    }

    func testAPageSelectsNothingBelowTheStartAndAMovedStartIsReadAgain() throws {
        try change("WITH RECURSIVE n(x) AS (SELECT 100 UNION ALL SELECT x + 1 FROM n WHERE x < 25099) "
                   + "INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCHATSESSION, ZSTANZAID, ZMESSAGEDATE) "
                   + "SELECT x, 9, 1, 3, 'SYNTH-OLD-' || x, 700000000 + x FROM n")
        let start = Date(timeIntervalSinceReferenceDate: 700_010_000)
        let startMs = Int(start.timeIntervalSince1970 * 1000)
        let first = try seal(custody(0), start: start)
        XCTAssertEqual(first.map(\.sidecar.kind), ["changes", "history"])
        XCTAssertEqual(try facts(first[0])["left"] as? Int, 15_103, "the live bundle counted rows older than the start (message 1, which went live, is counted as ever)")
        XCTAssertEqual(try keys(first[1])["ZWAMESSAGE"], [2, 3] + Array(10_000...25_099), "a page selected a row below the start")
        XCTAssertEqual(try facts(first[1])["left"] as? Int, 0, "the page carried every row owed from the start on")
        XCTAssertEqual(try first.map { try facts($0)["start_ms"] as? Int }, [startMs, startMs], "left stated without the start it was counted under")
        XCTAssertEqual(try seal(custody(2), minute: 1, start: start), [], "a row below the start was owed to a page")
        let quiet = try stated(custody(2), minute: 1, start: start)
        XCTAssertEqual(quiet?.left, 0)
        XCTAssertEqual(quiet?.start, start, "a read-through stated left without its start")

        XCTAssertEqual(try seal(custody(2), minute: 2, start: Date(timeIntervalSinceReferenceDate: 700_020_000)), [],
                       "a start moved later shipped what it leaves out")

        let widened = try seal(custody(2), minute: 3)
        XCTAssertEqual(widened.map(\.sidecar.kind), ["history"], "a start moved earlier waited for the store's file to change")
        XCTAssertEqual(try keys(widened[0])["ZWAMESSAGE"], Array(100...9_999), "the rows the later start skipped")
        XCTAssertEqual(try facts(widened[0])["left"] as? Int, 0)
        XCTAssertTrue(try facts(widened[0])["start_ms"] is NSNull, "a start of all is stated as null")
    }

    func testAnEditToAHeldRowBelowTheStartIsNotSent() throws {
        try change("UPDATE ZWAMEDIAITEM SET ZTHUMBNAILLOCALPATH = 'Media/15550000002/later.jpg' WHERE Z_PK = 1")
        try firstSync()
        let start = Date(timeIntervalSinceReferenceDate: 805_000_000)
        try change("UPDATE ZWAMESSAGE SET ZTEXT = 'synthetic message two, edited' WHERE Z_PK = 2",
                   "UPDATE ZWAMESSAGE SET ZTEXT = 'synthetic message five, edited' WHERE Z_PK = 5")
        try DomainFixtures.write("later media bytes", to: media.appendingPathComponent("Media/15550000002/later.jpg"))
        let sealed = try seal(custody(2), minute: 1, owesThrough: true, start: start)
        XCTAssertEqual(sealed.map(\.sidecar.kind), ["changes"], "an edit below the start went to a page")
        XCTAssertEqual(try keys(sealed[0])["ZWAMESSAGE"], [5], "an edit to a held row below the start was sent")
        XCTAssertEqual(try StoredZipReader(sealed[0].file).names.filter { $0.hasPrefix("blobs/") }, [],
                       "the file of a message below the start was carried")
        XCTAssertEqual(try stated(custody(3), minute: 2, start: start)?.left, 0, "a held row below the start was owed")
    }

    func testAStoreCountsItsRowsByTheMonthOfTheirTimeAndItsFilesByTheMonthTheyWereModifiedBelowTheStartToo() throws {
        try change("INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCHATSESSION, ZSTANZAID, ZMESSAGEDATE) VALUES (6, 9, 1, 3, 'SYNTH-6', 0)",
                   "INSERT INTO ZWAMEDIAITEM (Z_PK, Z_ENT, Z_OPT, ZMEDIALOCALPATH, ZTHUMBNAILLOCALPATH) "
                       + "VALUES (3, 8, 1, 'Media/15550000002/gone.jpg', 'Media/15550000002/old.jpg')")
        let start = try DomainFixtures.instant("2026-09-01T00:00:00.000Z")
        XCTAssertEqual(try seal(custody(0), start: start).map(\.sidecar.kind), ["changes"], "nothing below the start is paged")
        var months = Self.months
        months["undated"] = Through.Month(items: 1, bytes: 0)
        XCTAssertEqual(try stated(custody(1), minute: 1, start: start)?.months, months,
                       "rows by the month of their declared time, each file named once by the month it was modified, "
                           + "a file that is not there not at all, the months below the start counted too")
    }

    func testAStoreWithNoFilesCountsNoBytes() throws {
        let chats = Differences.Store(member: Self.chatsFile, database: self.chats, identity: .coreData,
                                      schema: try StoreFixtures.schema("whatsapp", member: Self.chatsFile))
        XCTAssertEqual(try Differences.count(chats, at: self.chats).stated,
                       ["2026-05": Through.Month(items: 3, bytes: 0), "2026-09": Through.Month(items: 2, bytes: 0)])
    }

    func testAStoreIsCountedAtItsFirstReadThenAtMostDaily() throws {
        try firstSync()
        try change("INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCHATSESSION, ZSTANZAID, ZMESSAGEDATE) VALUES (6, 9, 1, 3, 'SYNTH-6', 811500300)")
        XCTAssertEqual(try seal(custody(2), minute: 1).map(\.sidecar.kind), ["changes"])
        XCTAssertEqual(try stated(custody(3), minute: 2)?.months, Self.months, "counted again within a day of the last count")
        var grown = Self.months
        grown["2026-09"] = Through.Month(items: 3, bytes: 15)
        XCTAssertEqual(try stated(custody(3), minute: 24 * 60)?.months, grown, "a quiet store was not counted again a day on")
        XCTAssertEqual(try stated(custody(3), minute: 24 * 60 + 5)?.months, grown, "the count read back from the store's memory")
    }

    func testALiveChangeNeverWaitsForAPage() throws {
        try change("WITH RECURSIVE n(x) AS (SELECT 100 UNION ALL SELECT x + 1 FROM n WHERE x < 20199) "
                   + "INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCHATSESSION, ZSTANZAID, ZMESSAGEDATE) "
                   + "SELECT x, 9, 1, 3, 'SYNTH-OLD-' || x, 700000000 + x FROM n")
        _ = try seal(custody(0))
        try change("UPDATE ZWAMESSAGE SET ZTEXT = 'live edit' WHERE Z_PK = 5")
        let sealed = try seal(custody(2, imported: 1), minute: 1)
        XCTAssertEqual(sealed.map(\.sidecar.kind), ["changes"])
        XCTAssertEqual(try keys(sealed[0])["ZWAMESSAGE"], [5])
    }
}

final class KeyedDifferencesTests: DifferencesTests {
    override class var form: DeviceFiles.Form { .keyed(ShippingFixture.macKey) }
}
