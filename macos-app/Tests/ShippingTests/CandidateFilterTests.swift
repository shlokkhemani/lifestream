import DeviceFiles
import Foundation
import HomeLink
import XCTest
@testable import Shipping

class CandidateFilterTests: XCTestCase {
    private var root: URL!
    private var files: DeviceFiles!

    class var form: DeviceFiles.Form { .plain }
    private let opens = Collected<Int>()
    private let ready = Collected<String>()
    private let enqueued = Collected<(sha256: String, bytes: Int64, kept: Bool, kind: WriteKind)>()

    private static let source = DomainFixtures.whatsappSource
    private static let chatsFile = "chats.sqlite"
    private static let fetchedAt = "2026-09-23T04:00:00.000Z"
    private static let newLocator = "Media/15550000001-1700000000/new.jpg"
    private static let messagesFile = "messages.db"
    private static let notesFile = "notes.sqlite"
    private static let notesSource = "apple-notes:person-a@example.com:unit-0001"

    override func setUpWithError() throws {
        files = DeviceFiles(type(of: self).form)
        root = try DomainFixtures.scratch("candidate-filter-tests")
        try DomainFixtures.write("old media bytes", to: media.appendingPathComponent("Media/15550000002/old.jpg"))
        try DomainFixtures.write("new media bytes", to: media.appendingPathComponent(Self.newLocator))
        try DomainFixtures.sqlite(chats, [try DomainFixtures.fixture("whatsapp-store")])
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var container: URL { root.appendingPathComponent("Library/Group Containers/group.net.whatsapp.WhatsApp.shared", isDirectory: true) }
    private var chats: URL { container.appendingPathComponent("ChatStorage.sqlite") }
    private var media: URL { container.appendingPathComponent("Message", isDirectory: true) }
    private var work: URL { root.appendingPathComponent("work", isDirectory: true) }
    private var ledgers: Ledgers { Ledgers(root: root.appendingPathComponent("ledger", isDirectory: true), files: files) }
    private var memory: URL { memory(of: Self.chatsFile, in: Self.source) }

    private func memory(of member: String, in source: String) -> URL {
        ledgers.memory(pass: ShippingFixture.pass, source: source).appendingPathComponent("memory-" + files.name(member))
    }

    private func domain() throws -> DifferencesDomain {
        guard case .sqlite(let declared) = try StoreFixtures.declaration(of: Self.source).store.engine else {
            throw StoreFixtures.StoreFixtureError.noMember(Self.source, "sqlite")
        }
        let chats = try XCTUnwrap(declared.first { $0.member == Self.chatsFile })
        let opens = opens
        let stores = try SqliteEngine.differences(of: chats, folder: nil, files: StoreFiles(home: root, lifestream: [])).map { found in
            var counted = Differences.Store(member: found.member, database: found.database, identity: found.identity, schema: found.schema,
                                            attachments: found.attachments, fileRoot: found.fileRoot, optional: found.optional,
                                            vet: { url in
                                                opens.append(1)
                                                try found.vet?(url)
                                            })
            counted.named = found.named
            counted.opener = found.opener
            counted.declared = found.declared
            return counted
        }
        return DifferencesDomain(sourceId: Self.source, name: "whatsapp", feeder: "whatsapp-mac", ledgers: ledgers,
                                 hashCache: root.appendingPathComponent("hash-cache.json")) { stores }
    }

    private var staged: StagedBlobs {
        let ready = ready, enqueued = enqueued
        return StagedBlobs(isReady: { ready.all.contains($0) }, enqueue: { sha256, _, bytes, kept, kind in
            enqueued.append((sha256, bytes, kept, kind))
        })
    }

    private func seal(_ received: Int, imported: Int? = nil, minute: Int, staged: StagedBlobs? = nil,
                      forceCold: Bool = false, start: Date? = nil, on given: (any ShippingDomain)? = nil) throws -> [SealedBundle] {
        let at = try DomainFixtures.instant(Self.fetchedAt).addingTimeInterval(Double(minute) * 60)
        return try (given ?? domain()).seal(SealRequest(fetchedAt: at, workDirectory: try DomainFixtures.directory(work),
                                                        scratch: try DomainFixtures.directory(work),
                                                        custody: SealCustody(pass: ShippingFixture.pass, received: received,
                                                                             imported: imported ?? received),
                                                        start: start, staged: staged, forceCold: forceCold))
    }

    private func keys(_ bundle: SealedBundle, _ member: String = chatsFile) throws -> [String: [Int]] {
        try DomainFixtures.keys(in: try DomainFixtures.extract(member, of: bundle))
    }

    private func meta(_ name: String, in memory: URL? = nil) throws -> String? {
        try DomainFixtures.read("SELECT value FROM meta WHERE name = '\(name)'", from: memory ?? self.memory).first?.first ?? nil
    }

    private func pending(in memory: URL? = nil) throws -> [[String?]] {
        try DomainFixtures.read("SELECT tbl, key FROM pending_media ORDER BY tbl, key", from: memory ?? self.memory)
    }

    private func carries(_ bundle: SealedBundle, _ sha256: String) throws -> Bool {
        try StoredZipReader(bundle.file).names.contains("blobs/\(sha256)")
    }

    private func stagedBlobs(_ bundle: SealedBundle) throws -> [String]? {
        let reader = try StoredZipReader(bundle.file)
        let manifest = try XCTUnwrap(try JSONSerialization.jsonObject(with: try XCTUnwrap(reader.bytes("manifest.json"))) as? [String: Any])
        return manifest["staged_blobs"] as? [String]
    }

    private func store(_ fixture: String, _ id: String, _ member: String) throws -> URL {
        let url = try StoreFixtures.store(id, member: member, home: root)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try DomainFixtures.sqlite(url, [try DomainFixtures.fixture(fixture)])
        return url
    }

    private func large(_ text: String) -> String {
        String(repeating: text, count: 20_000)
    }

    private func change(_ statements: String...) throws {
        try DomainFixtures.sqlite(chats, statements)
    }

    private func names() throws -> String {
        "WITH RECURSIVE n(k) AS (SELECT 101 UNION ALL SELECT k + 1 FROM n WHERE k < 1100) "
            + "INSERT INTO ZWAPROFILEPUSHNAME (Z_PK, Z_ENT, Z_OPT, ZJID, ZPUSHNAME) "
            + "SELECT k, 12, 1, 'synthetic-' || k || '@example.invalid', 'Synthetic Name ' || k FROM n"
    }

    func testAQuietStoreIsNotOpenedAndAFastPassReadsOnlyNewRowsTheTailAndWhatTheyTouch() throws {
        try change(try names())
        XCTAssertEqual(try seal(0, minute: 0).map(\.sidecar.kind), ["changes", "history"])
        XCTAssertEqual(opens.count, 1)
        XCTAssertEqual(try meta("had_fast_pass"), "0", "the first pass is cold")
        XCTAssertEqual(try DomainFixtures.read("SELECT through FROM examined WHERE tbl = 'ZWAPROFILEPUSHNAME'", from: memory), [["1100"]])

        XCTAssertEqual(try seal(2, minute: 1), [])
        XCTAssertEqual(opens.count, 1, "an unchanged store with nothing waiting is not opened")

        try change("UPDATE ZWAPROFILEPUSHNAME SET ZPUSHNAME = 'renamed far back' WHERE Z_PK = 101",
                   "UPDATE ZWAPROFILEPUSHNAME SET ZPUSHNAME = 'renamed in the tail' WHERE Z_PK = 1000",
                   "INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCHATSESSION, ZSTANZAID, ZTEXT, ZFROMJID, ZMESSAGEDATE, ZISFROMME) "
                       + "VALUES (6, 9, 1, 3, 'SYNTH-6', 'synthetic message six', '15550000004@s.whatsapp.net', 811600000, 0)",
                   "INSERT INTO ZWAMESSAGEINFO VALUES (6, 10, 1, 5, X'06')")
        let fast = try seal(2, minute: 2)
        XCTAssertEqual(fast.map(\.sidecar.kind), ["changes"])
        XCTAssertEqual(try keys(fast[0])["ZWAPROFILEPUSHNAME"], [1000], "an edit behind the tail waits for the cold pass")
        XCTAssertEqual(try keys(fast[0])["ZWAMESSAGEINFO"]?.contains(6), true, "a new follows row is read")
        let messages = try XCTUnwrap(try keys(fast[0])["ZWAMESSAGE"])
        XCTAssertTrue(messages.contains(6), "a new main row is read")
        XCTAssertTrue(messages.contains(5), "the message a new follows row names ships with it")
        XCTAssertEqual(try meta("had_fast_pass"), "1")

        XCTAssertEqual(try seal(3, minute: 30), [], "before the cold pass is due an unchanged store stays shut")
        XCTAssertEqual(opens.count, 2)

        let cold = try seal(3, minute: 61)
        XCTAssertEqual(cold.map(\.sidecar.kind), ["changes"])
        XCTAssertEqual(try keys(cold[0])["ZWAPROFILEPUSHNAME"], [101], "the cold pass reconciles the edit behind the tail")
        XCTAssertEqual(try meta("had_fast_pass"), "0")
        let due = try DomainFixtures.instant(Self.fetchedAt).addingTimeInterval(61 * 60 + SealRequest.coldInterval)
        XCTAssertEqual(try meta("cold_due_at"), String(Int(due.timeIntervalSince1970)))

        XCTAssertEqual(try seal(4, minute: 62), [])
        XCTAssertEqual(opens.count, 3, "no fast pass since the cold one: quiet again")
    }

    func testAPassWhileHistoryIsOwedReadsTheWholeStore() throws {
        try change(try names())
        XCTAssertEqual(try seal(1, imported: 0, minute: 0).map(\.sidecar.kind), ["changes"], "the page waits for the pace")
        XCTAssertEqual(try meta("owed"), "3")
        try change("UPDATE ZWAPROFILEPUSHNAME SET ZPUSHNAME = 'renamed far back' WHERE Z_PK = 101")
        let sealed = try seal(2, imported: 1, minute: 1)
        XCTAssertEqual(sealed.map(\.sidecar.kind), ["changes"])
        XCTAssertEqual(try keys(sealed[0])["ZWAPROFILEPUSHNAME"], [101], "owed history keeps every pass cold")
        XCTAssertEqual(try meta("had_fast_pass"), "0")
    }

    func testARefreshReadsTheWholeStore() throws {
        try change(try names())
        XCTAssertEqual(try seal(0, minute: 0).count, 2)
        try change("UPDATE ZWAPROFILEPUSHNAME SET ZPUSHNAME = 'renamed far back' WHERE Z_PK = 101")
        let sealed = try seal(2, minute: 1, forceCold: true)
        XCTAssertEqual(try keys(sealed[0])["ZWAPROFILEPUSHNAME"], [101])
        XCTAssertEqual(try meta("had_fast_pass"), "0")
    }

    func testARowWaitingOnItsFileIsReadAloneAndItsMemoryNamesNoFile() throws {
        try change("UPDATE ZWAMEDIAITEM SET ZTHUMBNAILLOCALPATH = 'Media/15550000001-1700000000/thumb.jpg' WHERE Z_PK = 2")
        XCTAssertEqual(try seal(0, minute: 0).count, 2)
        XCTAssertEqual(try pending(), [["ZWAMEDIAITEM", "2"]])
        let columns = try DomainFixtures.read("SELECT name FROM pragma_table_info('pending_media') ORDER BY cid", from: memory)
        XCTAssertEqual(columns.compactMap { $0.first ?? nil }, ["tbl", "key", "added_at", "seal"])
        for row in try DomainFixtures.read("SELECT * FROM pending_media", from: memory) {
            for value in row.compactMap({ $0 }) {
                XCTAssertFalse(value.contains("Media") || value.contains(".jpg") || value.contains("/"), "no file named: \(value)")
            }
        }

        XCTAssertEqual(try seal(2, minute: 1), [])
        XCTAssertEqual(opens.count, 2, "a row waiting on its file opens the unchanged store")
        XCTAssertEqual(try meta("had_fast_pass"), "1", "and reads only that row")

        try DomainFixtures.write("synthetic thumbnail bytes", to: media.appendingPathComponent("Media/15550000001-1700000000/thumb.jpg"))
        let sealed = try seal(2, minute: 2)
        XCTAssertEqual(sealed.map(\.sidecar.kind), ["changes"])
        XCTAssertEqual(try keys(sealed[0])["ZWAMESSAGE"], [5])
        XCTAssertTrue(try StoredZipReader(sealed[0].file).names.contains("blobs/\(DomainFixtures.sha256("synthetic thumbnail bytes"))"))
        XCTAssertEqual(try pending(), [], "its file carried, the row waits no more")

        XCTAssertEqual(try seal(3, minute: 3), [])
        XCTAssertEqual(opens.count, 3, "nothing waiting: the unchanged store is not opened")
    }

    func testALargeFileHoldsBackOnlyItsMessageUntilItIsStaged() throws {
        let large = String(repeating: "synthetic video ", count: 20_000)
        try DomainFixtures.write(large, to: media.appendingPathComponent(Self.newLocator))
        let sha256 = DomainFixtures.sha256(large)

        let first = try seal(0, minute: 0, staged: staged)
        XCTAssertEqual(first.map(\.sidecar.kind), ["changes", "history"])
        let live = try XCTUnwrap(try keys(first[0])["ZWAMESSAGE"])
        XCTAssertTrue(live.contains(4), "the text beside it ships at once")
        XCTAssertFalse(live.contains(5), "the message whose file is not staged waits")
        XCTAssertFalse(try StoredZipReader(first[0].file).names.contains("blobs/\(sha256)"))
        XCTAssertEqual(enqueued.all.map(\.sha256), [sha256])
        XCTAssertEqual(enqueued.all.first?.bytes, Int64(large.utf8.count))
        XCTAssertEqual(enqueued.all.first?.kept, false)
        XCTAssertEqual(enqueued.all.first?.kind, .new)
        XCTAssertEqual(try pending(), [["ZWAMEDIAITEM", "2"], ["ZWAMESSAGE", "5"]])

        XCTAssertEqual(try seal(2, minute: 1, staged: staged), [], "still uploading: still held back")

        ready.append(sha256)
        let shipped = try seal(2, minute: 2, staged: staged)
        XCTAssertEqual(shipped.map(\.sidecar.kind), ["changes"])
        XCTAssertEqual(try keys(shipped[0])["ZWAMESSAGE"], [5])
        let reader = try StoredZipReader(shipped[0].file)
        XCTAssertFalse(reader.names.contains("blobs/\(sha256)"), "a staged file is named, not carried")
        let manifest = try XCTUnwrap(try JSONSerialization.jsonObject(with: try XCTUnwrap(reader.bytes("manifest.json"))) as? [String: Any])
        XCTAssertEqual(manifest["staged_blobs"] as? [String], ["sha256:\(sha256)"])
        let index = try XCTUnwrap(try JSONSerialization.jsonObject(with: try XCTUnwrap(reader.bytes("media.json"))) as? [String: Any])
        let entry = try XCTUnwrap((index["entries"] as? [String: Any])?[Self.newLocator] as? [String: Any])
        XCTAssertEqual(entry["sha256"] as? String, sha256, "the index still names it")
        XCTAssertEqual(try pending(), [])

        XCTAssertEqual(try seal(3, minute: 3, staged: staged), [], "shipped once")
    }

    func testARollbackAndARefusedPageForgetTheStampAndTheColdPassDurably() throws {
        let memory = StoreMemory(file: root.appendingPathComponent("memory-unit"), files: files)
        let at = try DomainFixtures.instant(Self.fetchedAt)
        try memory.adopt(identity: "synthetic identity")
        try memory.settle(stamp: "synthetic stamp", owed: 0, pass: StoreMemory.Pass(fast: true, schemaVersion: 7, coldDueAt: 9_000, at: at))
        try DomainFixtures.sqlite(memory.file, ["INSERT INTO examined VALUES ('ZWAMESSAGE', 5, 4)",
                                                "INSERT INTO pending_media VALUES ('ZWAMEDIAITEM', 2, \(Int(at.timeIntervalSince1970)), 4)"])
        let held = try memory.begin(received: 4)
        XCTAssertEqual(held.stamp, memory.named("synthetic stamp"))
        XCTAssertEqual(held.coldDueAt, 9_000)
        XCTAssertEqual(held.schemaVersion, 7)
        XCTAssertTrue(held.hadFastPass)
        XCTAssertTrue(held.hasPendingMedia)

        let rolledBack = try memory.begin(received: 3)
        XCTAssertNil(rolledBack.stamp)
        XCTAssertEqual(rolledBack.coldDueAt, 0)
        XCTAssertNil(rolledBack.schemaVersion)
        XCTAssertFalse(rolledBack.hadFastPass)
        XCTAssertFalse(rolledBack.hasPendingMedia)
        XCTAssertEqual(try DomainFixtures.read("SELECT count(*) FROM examined", from: memory.file), [["0"]])
        let again = try memory.begin(received: 3)
        XCTAssertNil(again.stamp, "forgotten on disk, not only in the answer")
        XCTAssertEqual(again.coldDueAt, 0)

        try memory.settle(stamp: "synthetic stamp", owed: 0, pass: StoreMemory.Pass(fast: true, schemaVersion: 7, coldDueAt: 9_000, at: at))
        try DomainFixtures.sqlite(memory.file, ["INSERT INTO examined VALUES ('ZWAMESSAGE', 5, 9)",
                                                "INSERT INTO pending_media VALUES ('ZWAMEDIAITEM', 2, \(Int(at.timeIntervalSince1970)), 9)"])
        XCTAssertTrue(try memory.refused(page: 9, reason: "a synthetic refusal"))
        let refused = try memory.begin(received: 20)
        XCTAssertNil(refused.stamp)
        XCTAssertEqual(refused.coldDueAt, 0)
        XCTAssertFalse(refused.hadFastPass)
        XCTAssertFalse(refused.hasPendingMedia)
        XCTAssertEqual(try DomainFixtures.read("SELECT count(*) FROM examined", from: memory.file), [["0"]])
    }

    func testARowWaitsOnItsFileForADayAtMost() throws {
        let memory = StoreMemory(file: root.appendingPathComponent("memory-unit"), files: files)
        let at = try DomainFixtures.instant(Self.fetchedAt)
        try memory.adopt(identity: "synthetic identity")
        try DomainFixtures.sqlite(memory.file, ["INSERT INTO pending_media VALUES ('ZWAMEDIAITEM', 1, \(Int(at.timeIntervalSince1970)), 1)",
                                                "INSERT INTO pending_media VALUES ('ZWAMEDIAITEM', 2, \(Int(at.timeIntervalSince1970) + 3_600), 1)"])
        try memory.settle(stamp: "synthetic stamp", owed: 0,
                          pass: StoreMemory.Pass(fast: true, schemaVersion: 7, coldDueAt: 0, at: at.addingTimeInterval(86_400 + 60)))
        XCTAssertEqual(try DomainFixtures.read("SELECT key FROM pending_media", from: memory.file), [["2"]])
    }

    func testANewSchemaReadsTheWholeStore() throws {
        try change(try names())
        XCTAssertEqual(try seal(0, minute: 0).count, 2)
        try change("CREATE INDEX synthetic_push_names ON ZWAPROFILEPUSHNAME (ZPUSHNAME)",
                   "UPDATE ZWAPROFILEPUSHNAME SET ZPUSHNAME = 'renamed far back' WHERE Z_PK = 101")
        let sealed = try seal(2, minute: 1)
        XCTAssertEqual(try keys(sealed[0])["ZWAPROFILEPUSHNAME"], [101], "the store's schema moved: every row is read")
        XCTAssertEqual(try meta("had_fast_pass"), "0")
    }

    func testAStartMovedEarlierReadsTheWholeStoreAtOnce() throws {
        let at = try DomainFixtures.instant(Self.fetchedAt)
        let later = at.addingTimeInterval(-30 * 86_400), earlier = at.addingTimeInterval(-3_650 * 86_400)
        try change(try names())
        let first = try seal(0, minute: 0, start: later)
        try change("UPDATE ZWAPROFILEPUSHNAME SET ZPUSHNAME = 'renamed in the tail' WHERE Z_PK = 1000")
        let fast = try seal(first.count, minute: 1, start: later)
        XCTAssertEqual(try keys(fast[0])["ZWAPROFILEPUSHNAME"], [1000])
        XCTAssertEqual(try meta("had_fast_pass"), "1", "the same start: only new rows and the tail")

        try change("UPDATE ZWAPROFILEPUSHNAME SET ZPUSHNAME = 'renamed far back' WHERE Z_PK = 101")
        let moved = try seal(first.count + fast.count, minute: 2, start: earlier)
        XCTAssertEqual(try meta("had_fast_pass"), "0", "a start moved earlier never waits for the cold pass")
        XCTAssertEqual(try keys(moved[0])["ZWAPROFILEPUSHNAME"], [101])
    }

    func testARefusedPageLeavesTheStoreQuietAndItsNextReadCold() throws {
        XCTAssertEqual(try seal(0, minute: 0).count, 2)
        try change("UPDATE ZWAMEDIAITEM SET ZMEDIALOCALPATH = X'07' WHERE Z_PK = 1",
                   "INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCHATSESSION, ZSTANZAID, ZTEXT, ZFROMJID, ZMESSAGEDATE, ZISFROMME) "
                       + "VALUES (6, 9, 1, 3, 'SYNTH-6', 'synthetic message six', '15550000004@s.whatsapp.net', 811600000, 0)")
        let sealed = try seal(2, minute: 1)
        XCTAssertEqual(sealed.map(\.sidecar.kind), ["changes"], "the page did not seal; the live bundle did")
        XCTAssertEqual(try meta("cold_due_at"), "0", "the refusal outlives the pass that settles after it")
        XCTAssertEqual(try meta("had_fast_pass"), "0")
        XCTAssertNotNil(try meta("stamp"))

        XCTAssertEqual(try seal(3, minute: 2), [])
        XCTAssertEqual(opens.count, 2, "a quiet store is still not opened")

        try change("INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCHATSESSION, ZSTANZAID, ZMESSAGEDATE) VALUES (7, 9, 1, 3, 'SYNTH-7', 811600100)")
        let again = try seal(3, minute: 3)
        XCTAssertEqual(try keys(again[0])["ZWAMESSAGE"], [7])
        XCTAssertEqual(try meta("had_fast_pass"), "0", "the next read of the store is cold")
    }

    func testAReleasedMessageAndTheRowsBesideItShipOnce() throws {
        let large = large("synthetic video ")
        try DomainFixtures.write(large, to: media.appendingPathComponent(Self.newLocator))
        let sha256 = DomainFixtures.sha256(large)

        let first = try seal(0, minute: 0, staged: staged)
        XCTAssertFalse(try XCTUnwrap(try keys(first[0])["ZWAMESSAGE"]).contains(5))
        XCTAssertFalse(try XCTUnwrap(try keys(first[0])["ZWAMESSAGEINFO"]).contains(5))
        ready.append(sha256)
        let shipped = try seal(2, minute: 1, staged: staged)
        XCTAssertEqual(try keys(shipped[0])["ZWAMESSAGE"], [5])
        XCTAssertEqual(try keys(shipped[0])["ZWAMESSAGEINFO"], [5], "the row beside it ships with it")
        XCTAssertEqual(try meta("had_fast_pass"), "1")

        XCTAssertEqual(try seal(3, minute: 2, staged: staged, forceCold: true), [], "the cold pass finds every shipped row already carried")
    }

    func testALargeAttachmentTwoJoinsAwayHoldsBackOnlyItsMessage() throws {
        let messages = try StoreFixtures.fileRoot("imessage", member: Self.messagesFile, home: root)
        _ = try store("imessage-store", "imessage", Self.messagesFile)
        try DomainFixtures.write("old bytes", to: messages.appendingPathComponent("Attachments/aa/01/old.jpg"))
        let large = large("synthetic attachment ")
        try DomainFixtures.write(large, to: messages.appendingPathComponent("Attachments/bb/02/new.jpg"))
        let sha256 = DomainFixtures.sha256(large)
        let domain = try StoreFixtures.domain(DomainFixtures.imessageSource, home: root, ledgers: ledgers)
        let memory = memory(of: Self.messagesFile, in: DomainFixtures.imessageSource)

        let first = try seal(0, minute: 0, staged: staged, on: domain)
        XCTAssertEqual(first.map(\.sidecar.kind), ["changes", "history"])
        let live = try keys(first[0], Self.messagesFile)
        XCTAssertNil(live["message"], "the message whose attachment is not staged waits")
        XCTAssertNil(live["attachment"])
        XCTAssertNil(live["message_attachment_join"])
        XCTAssertEqual(live["chat"], [1, 2], "the rest of the store ships at once")
        XCTAssertFalse(try carries(first[0], sha256))
        XCTAssertEqual(enqueued.all.map(\.sha256), [sha256])
        XCTAssertEqual(try pending(in: memory), [["attachment", "2"], ["message", "102"]])
        XCTAssertEqual(try keys(first[1], Self.messagesFile)["message"], [101], "a history page is never held back")

        XCTAssertEqual(try seal(2, minute: 1, staged: staged, on: domain), [], "still uploading: still held back")

        ready.append(sha256)
        let shipped = try seal(2, minute: 2, staged: staged, on: domain)
        XCTAssertEqual(shipped.map(\.sidecar.kind), ["changes"])
        let released = try keys(shipped[0], Self.messagesFile)
        XCTAssertEqual(released["message"], [102])
        XCTAssertEqual(released["attachment"], [2])
        XCTAssertFalse(try carries(shipped[0], sha256), "a staged file is named, not carried")
        XCTAssertEqual(try stagedBlobs(shipped[0]), ["sha256:\(sha256)"])
        XCTAssertEqual(try pending(in: memory), [])

        XCTAssertEqual(try seal(3, minute: 3, staged: staged, forceCold: true, on: domain), [],
                       "the cold pass finds the message and its joins already carried")
    }

    func testANoteWaitingOnItsLargeMediaHoldsBackOnlyThatNote() throws {
        let container = try StoreFixtures.fileRoot("apple-notes", member: Self.notesFile, home: root)
        let database = try store("notes-store", "apple-notes", Self.notesFile)
        let locator = try XCTUnwrap(try StoreFixtures.locators("apple-notes", member: Self.notesFile, in: database).first)
        let large = large("synthetic pasted graphic ")
        try DomainFixtures.write(large, to: container.appendingPathComponent(locator))
        let sha256 = DomainFixtures.sha256(large)
        let domain = try StoreFixtures.domain(Self.notesSource, home: root, ledgers: ledgers)
        let memory = memory(of: Self.notesFile, in: Self.notesSource)

        let first = try seal(0, minute: 0, staged: staged, on: domain)
        XCTAssertEqual(first.count, 1)
        let shipped = try XCTUnwrap(try keys(first[0], Self.notesFile)["ZICCLOUDSYNCINGOBJECT"])
        XCTAssertFalse(shipped.contains(100), "the note whose media is not staged waits")
        XCTAssertTrue(shipped.contains(101), "the other notes ship at once")
        XCTAssertTrue(shipped.contains(300), "the media row rides along with every note")
        XCTAssertFalse(try carries(first[0], sha256), "but never its unstaged bytes")
        XCTAssertEqual(enqueued.all.map(\.sha256), [sha256])

        try DomainFixtures.sqlite(database, ["UPDATE ZICNOTEDATA SET ZDATA = X'1F8B' WHERE ZNOTE = 101"])
        let fast = try seal(1, minute: 1, staged: staged, on: domain)
        XCTAssertEqual(try meta("had_fast_pass", in: memory), "1")
        let edited = try XCTUnwrap(try keys(fast[0], Self.notesFile)["ZICCLOUDSYNCINGOBJECT"])
        XCTAssertTrue(edited.contains(101))
        XCTAssertFalse(edited.contains(100))
        XCTAssertFalse(try carries(fast[0], sha256), "another note's fast bundle never carries the unstaged file")

        ready.append(sha256)
        let released = try seal(2, minute: 2, staged: staged, on: domain)
        XCTAssertTrue(try XCTUnwrap(try keys(released[0], Self.notesFile)["ZICCLOUDSYNCINGOBJECT"]).contains(100))
        XCTAssertEqual(try stagedBlobs(released[0]), ["sha256:\(sha256)"])
    }

    func testAColdPassDueFarAheadOfTheClockIsDueNow() {
        let begun = StoreMemory.Begun(identity: nil, stamp: "synthetic", owed: 0, months: nil, countedAt: nil, coldDueAt: 100_000)
        XCTAssertFalse(begun.coldDue(at: 99_000, forced: false, within: 3_600))
        XCTAssertTrue(begun.coldDue(at: 90_000, forced: false, within: 3_600), "the clock went back: reconcile now")
        XCTAssertTrue(begun.coldDue(at: 100_000, forced: false, within: 3_600))
    }
}

final class KeyedCandidateFilterTests: CandidateFilterTests {
    override class var form: DeviceFiles.Form { .keyed(ShippingFixture.macKey) }
}
