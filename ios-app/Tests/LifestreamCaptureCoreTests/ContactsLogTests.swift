import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

actor FakeAddressBook: ContactReader {
    var book: [String: (card: String, photo: Data?)] = [:]
    var largestAsk = 0
    var largestBytes = 0
    var failsCardsAfter: Int?
    var failsMarks = false
    var access = ContactsAuthorization.authorized
    var answers: [String: String] = [:]

    func read() throws -> ContactsRead {
        if failsMarks { throw POSIXError(.EIO) }
        let cards = try book.mapValues { try ContactCard(id: "", card: Data($0.card.utf8), photo: $0.photo) }
        return ContactsRead(marks: cards.mapValues(\.mark), bytes: cards.mapValues(\.bytes), authorization: access)
    }

    func cards(_ ids: [String]) throws -> [ContactCard] {
        largestAsk = max(largestAsk, ids.count)
        if let left = failsCardsAfter {
            if left == 0 { throw POSIXError(.EIO) }
            failsCardsAfter = left - 1
        }
        let cards = try ids.compactMap { id in
            try book[id].map { try ContactCard(id: answers[id] ?? id, card: Data($0.card.utf8), photo: $0.photo) }
        }
        largestBytes = max(largestBytes, cards.reduce(0) { $0 + $1.bytes })
        return cards
    }

    func set(_ id: String, _ name: String, photo: Data? = nil, prodid: String = "iPhone OS 26.0") {
        book[id] = (FakeAddressBook.card(name, prodid: prodid), photo)
    }
    func remove(_ id: String) { book[id] = nil }
    func failCards(_ fails: Bool, after answered: Int = 0) { failsCardsAfter = fails ? answered : nil }
    func failMarks(_ fails: Bool) { failsMarks = fails }
    func endUnder(_ authorization: ContactsAuthorization) { access = authorization }
    func answer(_ id: String, as other: String?) { answers[id] = other }

    static func card(_ name: String, prodid: String = "iPhone OS 26.0") -> String {
        "BEGIN:VCARD\r\nVERSION:3.0\r\nPRODID:-//Apple Inc.//\(prodid)//EN\r\nFN:\(name)\r\nTEL;type=CELL:+15550000001\r\nEND:VCARD\r\n"
    }
}

final class ContactsLogTests: XCTestCase {
    private let date = Date(timeIntervalSince1970: 1_800_000_000)
    private let photo = Data([0xFF, 0xD8, 0xFF, 0xE0] + Array(repeating: UInt8(7), count: 64))

    private func rig(process: UUID = UUID()) throws -> (CaptureStore, ContactsLog, FakeAddressBook) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lifestream-contacts-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let store = try CaptureStore(root: root.appendingPathComponent("capture"), processInstanceID: process)
        return (store, ContactsLog(store: store), FakeAddressBook())
    }

    @discardableResult
    private func pass(_ log: ContactsLog, _ book: FakeAddressBook?, _ authorization: ContactsAuthorization = .authorized,
                      endsUnder: ContactsAuthorization? = nil) async throws -> ContactsTable {
        await book?.endUnder(endsUnder ?? authorization)
        return try await log.pass(try await log.table(), authorization: authorization, reader: book, at: date)
    }

    private func lines(_ store: CaptureStore, after: UInt64 = 0) async throws -> [String] {
        try await store.entries(domain: .contacts, afterSequence: after).map { entry in
            guard case .object(let payload) = entry.payload else { return entry.kind }
            if case .string(let id)? = payload["id"] { return "\(entry.kind) \(id)" }
            if case .string(let access)? = payload["authorization"] { return "\(entry.kind) \(access)" }
            return entry.kind
        }
    }

    private func through(_ store: CaptureStore) async throws -> UInt64 { try await store.capturedThrough()[.contacts] ?? 0 }


    func testOnlyWhatDiffersIsWrittenKeyedByIdentifierWithItsPhotoStoredOnce() async throws {
        let (store, log, book) = try rig()
        await book.set("A", "Person A", photo: photo)
        await book.set("B", "Person B", photo: photo)
        await book.set("C", "Person C")
        try await pass(log, book)
        let first = try await lines(store)
        XCTAssertEqual(first, ["access authorized", "card A", "card B", "card C"])
        let files = try await store.blobInventory()
        XCTAssertEqual(files.map(\.hash), [SHA256Digest.tagged(photo)], "one file for the photo two contacts share")

        let written = try await store.entries(domain: .contacts)
        let card = try XCTUnwrap(written.first { $0.kind == "card" })
        guard case .object(let payload) = card.payload else { return XCTFail("a card line is an object") }
        XCTAssertEqual(Set(payload.keys), ["id", "card", "serializer", "photo"])
        XCTAssertEqual(payload["card"], .string(FakeAddressBook.card("Person A")), "the card as the serializer gave it, no photo line added")
        XCTAssertEqual(payload["serializer"], .string("CNContactVCardSerialization"))
        XCTAssertEqual(payload["photo"], .object(["hash": .string(SHA256Digest.tagged(photo)), "bytes": .integer(Int64(photo.count)),
                                                  "media_type": .string("image/jpeg")]))
        let plain = try XCTUnwrap(written.last)
        guard case .object(let none) = plain.payload else { return XCTFail() }
        XCTAssertNil(none["photo"], "a contact with no image names none")

        var mark = try await through(store)
        try await pass(log, book)
        for id in ["A", "B", "C"] { await book.set(id, "Person \(id)", photo: id == "C" ? nil : photo, prodid: "iPhone OS 27.0") }
        try await pass(log, book)
        var after = try await lines(store, after: mark)
        XCTAssertEqual(after, [], "an unchanged book and a new PRODID write nothing")

        let other = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3])
        await book.set("A", "Person A Edited", photo: photo)
        await book.set("C", "Person C", photo: other, prodid: "iPhone OS 27.1")
        await book.set("D", "Person D")
        mark = try await through(store)
        try await pass(log, book)
        after = try await lines(store, after: mark)
        XCTAssertEqual(after, ["card A", "card C", "card D"])
        let editedLines = try await store.entries(domain: .contacts, afterSequence: mark)
        let photoOnly = editedLines[1]
        guard case .object(let edited) = photoOnly.payload, case .object(let named)? = edited["photo"] else { return XCTFail() }
        XCTAssertEqual(named["media_type"], .string("image/png"))
        XCTAssertEqual(edited["card"], .string(FakeAddressBook.card("Person C", prodid: "iPhone OS 27.1")), "the card as read now")
    }


    func testGoneOnlyUnderFullAccessUnchangedSinceTheReadBefore() async throws {
        let (store, log, book) = try rig()
        for id in ["A", "B", "C"] { await book.set(id, "Person \(id)") }
        try await pass(log, book)
        await book.remove("C")
        var mark = try await through(store)
        try await pass(log, book)
        var after = try await lines(store, after: mark)
        XCTAssertEqual(after, ["gone C"], "a whole read under full access states what it no longer finds")

        await book.remove("B")
        mark = try await through(store)
        let limited = try await pass(log, book, .limited)
        after = try await lines(store, after: mark)
        XCTAssertEqual(after, ["access limited"])
        XCTAssertNotNil(limited.contacts["B"], "a limited read removes no identifier")

        mark = try await through(store)
        try await pass(log, book)
        after = try await lines(store, after: mark)
        XCTAssertEqual(after, ["access authorized"], "access changed since the read before: nothing gone")
        mark = try await through(store)
        try await pass(log, book)
        after = try await lines(store, after: mark)
        XCTAssertEqual(after, ["gone B"])

        await book.remove("A")
        try await pass(log, nil, .denied)
        mark = try await through(store)
        try await pass(log, book)
        after = try await lines(store, after: mark)
        XCTAssertEqual(after, ["access authorized"])

        await book.set("D", "Person D")
        await book.set("E", "Person E")
        try await pass(log, book)
        mark = try await through(store)
        await book.failMarks(true)
        do { try await pass(log, book, .limited); XCTFail("the read failed") } catch {}
        await book.failMarks(false)
        await book.remove("E")
        try await pass(log, book)
        after = try await lines(store, after: mark)
        XCTAssertEqual(after, ["access limited", "access authorized"], "no read is judged across a change of access")
        mark = try await through(store)
        try await pass(log, book)
        after = try await lines(store, after: mark)
        XCTAssertEqual(after, ["gone E"])

        await book.remove("D")
        mark = try await through(store)
        try await pass(log, book, endsUnder: .limited)
        after = try await lines(store, after: mark)
        XCTAssertEqual(after, ["access limited"], "a read that ended under narrower access states nothing gone")
        try await pass(log, book)
        try await pass(log, book)
        after = try await lines(store, after: mark)
        XCTAssertEqual(after, ["access limited", "access authorized", "gone D"])

        await book.set("U", "Person U")
        await book.answer("U", as: "N")
        mark = try await through(store)
        try await pass(log, book)
        after = try await lines(store, after: mark)
        XCTAssertEqual(after, [], "no card N, and no gone N with it")
        await book.answer("U", as: nil)
        try await pass(log, book)
        after = try await lines(store, after: mark)
        XCTAssertEqual(after, ["card U"])
    }


    func testAReadThatFailsWritesNothingOrIsNeverJudgedAgainstAndAPassHoldsABatch() async throws {
        let (store, log, book) = try rig()
        for index in 0..<45 { await book.set(String(format: "id-%02d", index), "Person \(index)") }
        await book.failMarks(true)
        do { try await pass(log, book); XCTFail("the read failed") } catch {}
        let none = try await lines(store)
        XCTAssertEqual(none, ["access authorized"], "a read that fails at once writes nothing but the access said before it")
        await book.failMarks(false)
        await book.failCards(true)
        do { try await pass(log, book); XCTFail("the read failed part-way") } catch {}
        await book.failCards(false)
        try await pass(log, book)
        let all = try await lines(store)
        XCTAssertEqual(all.count, 46, "the access line and every card once")
        let asked = await book.largestAsk
        XCTAssertEqual(asked, 45, "small cards, one batch")

        await book.remove("id-00")
        await book.set("id-01", "Person 1 Edited")
        await book.failCards(true)
        var mark = try await through(store)
        do { try await pass(log, book); XCTFail() } catch {}
        var after = try await lines(store, after: mark)
        XCTAssertEqual(after, [])
        await book.failCards(false)
        mark = try await through(store)
        try await pass(log, book)
        after = try await lines(store, after: mark)
        XCTAssertEqual(after, ["card id-01", "gone id-00"])

        await book.remove("id-02")
        let tenth = Data([0xFF, 0xD8, 0xFF, 0xE0] + Array(repeating: UInt8(3), count: ContactsLog.batchBytes / 10 - 1_000))
        for index in 3...27 { await book.set(String(format: "id-%02d", index), "Person \(index) Edited", photo: tenth) }
        await book.failCards(true, after: 1)
        mark = try await through(store)
        do { try await pass(log, book); XCTFail() } catch {}
        after = try await lines(store, after: mark)
        XCTAssertEqual(after, (3...12).map { String(format: "card id-%02d", $0) }, "the first batch stands; nothing gone")
        let kept = try await log.table()
        XCTAssertTrue(kept.whole, "the failed read is not the read before; the last whole one still is")
        let logged = try await through(store)
        XCTAssertEqual(kept.sequence, logged, "its cards are in the table kept, not folded again")
        XCTAssertNotNil(kept.contacts["id-02"], "a read that failed removes no identifier")
        await book.failCards(false)
        mark = try await through(store)
        try await pass(log, book)
        after = try await lines(store, after: mark)
        XCTAssertEqual(after, (13...27).map { String(format: "card id-%02d", $0) } + ["gone id-02"])
    }

    func testAPassHoldsAtMostABatchOfBytes() async throws {
        let (store, log, book) = try rig()
        let large = Data([0xFF, 0xD8, 0xFF, 0xE0] + Array(repeating: UInt8(1), count: ContactsLog.batchBytes / 3))
        for index in 0..<7 { await book.set(String(format: "id-%02d", index), "Person \(index)", photo: large) }
        let huge = Data([0xFF, 0xD8, 0xFF, 0xE0] + Array(repeating: UInt8(2), count: ContactsLog.batchBytes))
        await book.set("id-07", "Person 7", photo: huge)
        try await pass(log, book)
        let all = try await lines(store)
        XCTAssertEqual(all, ["access authorized"] + (0..<8).map { String(format: "card id-%02d", $0) })
        let held = await book.largestBytes, asked = await book.largestAsk
        XCTAssertEqual(asked, 2, "two photos of a third of the batch fit it, a third would not")
        XCTAssertLessThan(held, ContactsLog.batchBytes + 2 * 1_000, "never more than a batch at once")
        let sizes = ["a": 3, "b": 3, "c": ContactsLog.batchBytes, "d": 1]
        XCTAssertEqual(ContactsLog.batches(["a", "b", "c", "d"], bytes: sizes), [["a", "b"], ["c"], ["d"]],
                       "a contact past the batch alone is a batch of its own")
    }


    func testTheTableIsNeverTrustedPastTheLog() async throws {
        let (store, log, book) = try rig()
        await book.set("A", "Person A", photo: photo)
        await book.set("B", "Person B")
        try await pass(log, book)
        let behind = try await store.anchor(ContactsLog.tableKey)
        await book.set("A", "Person A Edited", photo: photo)
        try await pass(log, book)
        let folded = try await store.foldEntries(domain: .contacts, initial: ContactsTable(seed: nil)) { $0.include($1) }

        try await store.setAnchor(ContactsLog.tableKey, behind)
        var mark = try await through(store)
        var table = try await log.table()
        XCTAssertEqual(table.contacts, folded.contacts, "folded again from the log")
        try await pass(log, book)
        var after = try await lines(store, after: mark)
        XCTAssertEqual(after, [], "the edit is not written twice")

        for kept in [nil, Data("not a table".utf8)] as [Data?] {
            try await store.setAnchor(ContactsLog.tableKey, kept)
            mark = try await through(store)
            table = try await log.table()
            XCTAssertFalse(table.whole, "a fold judges no read: none is in the log")
            try await pass(log, book)
            after = try await lines(store, after: mark)
            XCTAssertEqual(after, [], "nothing restated")
        }
        await book.remove("B")
        try await store.setAnchor(ContactsLog.tableKey, nil)
        mark = try await through(store)
        try await pass(log, book)
        try await pass(log, book)
        after = try await lines(store, after: mark)
        XCTAssertEqual(after, ["gone B"])

    }


    func testAReinstallRestatesEveryContactAndStatesGoneOneDeletedWhileAway() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lifestream-contacts-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let clock = TestClock(Date(timeIntervalSince1970: 1_791_000_000))
        let home = FakeHome(clock: { clock.now })
        let link = HomeLink(device: .init(kind: .phone, version: "1.0.0", model: "iPhone", serial4: nil), credentials: MemoryCredentials(),
                            folder: root.appendingPathComponent("exports"), transport: home, clock: { clock.now })
        _ = try await link.pair(code: FakeHome.code, name: "https://lifestream.example.ts.net", account: FakeHome.account)
        let source = "apple-contacts:\(FakeHome.account):\(FakeHome.unit)"
        home.restoring(domains: [:], since: [:], contacts: [source: ["A", "B", "C"]])
        let store = try CaptureStore(root: root.appendingPathComponent("capture"))
        let restore = try await link.restore()
        XCTAssertEqual(restore.contacts, [source: ["A", "B", "C"]])
        try await store.restore(restore, pass: restore.pass)
        let log = ContactsLog(store: store)
        let book = FakeAddressBook()
        await book.set("A", "Person A", photo: photo)
        await book.set("B", "Person B")

        try await store.setAnchor(ContactsLog.tableKey, Data("lost".utf8))
        try await pass(log, book)
        let first = try await lines(store)
        XCTAssertEqual(first, ["access authorized", "card A", "card B", "gone C"])

        let later = try CaptureStore(root: root.appendingPathComponent("capture-later"))
        let laterLog = ContactsLog(store: later)
        try await pass(laterLog, book)
        try await later.restore(Restore(pass: "p-later", unit: FakeHome.unit, sources: [source], contacts: [source: ["A", "B", "Z"]]),
                                pass: "p-later")
        let merged = try await laterLog.table()
        XCTAssertEqual(merged.contacts["Z"], ContactMark(), "the seed's own identifier, with no mark")
        try await pass(laterLog, book)
        let gone = try await lines(later)
        XCTAssertEqual(gone, ["access authorized", "card A", "card B", "gone Z"])
        try report("reinstall", ["seeded": ["A", "B", "C"], "found": ["A", "B"], "lines": first])
    }


    func testAFirstDeliveryAnEditAndADeletionShipOnlyWhatChangedAndTheHomesPhotosAreCleared() async throws {
        let (store, log, book) = try rig(process: UUID(uuidString: "00000000-0000-4000-8000-0000000000c1")!)
        let exporter = CaptureExporter(store: store, exportsDirectory: await store.root.deletingLastPathComponent().appendingPathComponent("exports"))
        let source = "apple-contacts:local:unit-0001"
        func seal(_ seal: Int, after: UInt64, held: Set<String>) async throws -> BuiltExportBundle {
            let sealed = try await exporter.seal([SealedSource(domain: .contacts, source: source, seal: seal, after: after)], held: held,
                                                 hardware: .synthetic, appVersion: "1")
            return try XCTUnwrap(sealed.bundles.first)
        }
        func carried(_ bundle: BuiltExportBundle) -> Set<String> {
            Set(bundle.files.map(\.name))
        }
        let other = Data([0xFF, 0xD8, 0xFF, 0xE1, 9, 9, 9])
        await book.set("A", "Person A", photo: photo)
        await book.set("B", "Person B", photo: other)
        await book.set("C", "Person C")
        try await pass(log, book)
        let first = try await seal(1, after: 0, held: [])
        XCTAssertEqual(carried(first), [SHA256Digest.tagged(photo), SHA256Digest.tagged(other)])
        let firstThrough = try await through(store)

        try await store.clearImportedContactPhotos(through: firstThrough)
        var kept = try await log.photosKept()
        XCTAssertEqual(kept.count, 0)

        await book.set("A", "Person A Edited", photo: photo)
        await book.remove("C")
        try await pass(log, book)
        let held = Set([SHA256Digest.tagged(photo), SHA256Digest.tagged(other)])
        let next = try await seal(2, after: firstThrough, held: held)
        XCTAssertEqual(next.manifest.files["contacts.jsonl"]?.firstSequence, firstThrough + 1)
        XCTAssertEqual(carried(next), [], "the edit names its photo, which the home holds, and sends none")
        let edit = try await lines(store, after: firstThrough)
        XCTAssertEqual(edit, ["card A", "gone C"])
        kept = try await log.photosKept()
        XCTAssertEqual(kept.count, 1, "stored again for the line that names it, until the home imports it")

        let shared = try await store.storeBlob(other)
        _ = try await store.append(domain: .camera, draft: .init(kind: "photo", observedAt: CaptureTime.rfc3339(date),
                                                                 payload: .object(["blob": .object(["hash": .string(shared)])])))
        await book.set("D", "Person D", photo: photo)
        let before = try await through(store)
        try await pass(log, book)
        try await store.clearImportedContactPhotos(through: before)
        let files = Set(try await store.blobInventory().map(\.hash))
        XCTAssertEqual(files, [SHA256Digest.tagged(photo), shared], "D's line is not imported; the camera's names the other")

        let week = try await store.statusSummary().week[.contacts]?.reduce(0, +)
        XCTAssertEqual(week, 5, "A, B, C, A again and D; no access, no gone")
        let delivered = try await lines(store)
        try contract(try await store.entries(domain: .contacts), photos: [photo, other])
        try report("journey", ["lines": delivered, "edit": edit,
                               "first_carried": carried(first).count, "edit_carried": carried(next).count])
    }

    func testOnlyAFreshAnswerThatImportedTheSealClearsItsPhotos() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("lifestream-contacts-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let clock = TestClock(Date(timeIntervalSince1970: 1_791_000_000))
        let home = FakeHome(clock: { clock.now })
        let link = HomeLink(device: .init(kind: .phone, version: "1.0.0", model: "iPhone", serial4: nil), credentials: MemoryCredentials(),
                            folder: root.appendingPathComponent("exports"), transport: home, clock: { clock.now })
        _ = try await link.pair(code: FakeHome.code, name: "https://lifestream.example.ts.net", account: FakeHome.account)
        let store = try await CaptureStore.restored(root: root.appendingPathComponent("capture"))
        let custody = PhoneCustody(exporter: CaptureExporter(store: store, exportsDirectory: root.appendingPathComponent("exports")))
        let log = ContactsLog(store: store)
        let book = FakeAddressBook()
        func ship() async throws {
            let answer = try await link.exchange()
            try await custody.applied(answer)
            for pending in try await custody.seal(answer, hardware: .synthetic, appVersion: "1.0.0", now: clock.now).bundles {
                try await custody.applied(try await link.deliver(pending, of: custody))
            }
            clock.advance(60)
        }
        func held() async throws -> Set<String> { Set(try await store.blobInventory().map(\.hash)) }
        let other = Data([0xFF, 0xD8, 0xFF, 0xE1, 4, 4, 4])
        await book.set("A", "Person A", photo: photo)
        await book.set("B", "Person B", photo: other)
        try await pass(log, book)
        try await ship()

        try await custody.clearImportedContacts(try await link.exchange())
        var files = try await held()
        XCTAssertEqual(files, [SHA256Digest.tagged(photo), SHA256Digest.tagged(other)])

        home.importAll()
        try await custody.clearImportedContacts(try await link.exchange())
        files = try await held()
        XCTAssertEqual(files, [])
        await book.set("A", "Person A Edited", photo: photo)
        try await pass(log, book)
        try await ship()
        try await custody.clearImportedContacts(try await link.exchange())
        files = try await held()
        XCTAssertEqual(files, [SHA256Digest.tagged(photo)], "the edit's seal is received, not imported")
        home.importAll()
        try await custody.clearImportedContacts(try await link.exchange())
        files = try await held()
        XCTAssertEqual(files, [])
        let deleted = Data([0xFF, 0xD8, 0xFF, 0xE1, 5, 5, 5])
        await book.set("C", "Person C", photo: deleted)
        try await pass(log, book)
        try await ship()
        await book.remove("C")
        try await pass(log, book)
        try await ship()
        home.importAll()
        try await custody.clearImportedContacts(try await link.exchange())
        files = try await held()
        XCTAssertEqual(files, [])

        try link.forget()
        _ = try await link.pair(code: FakeHome.code, name: "https://lifestream.example.ts.net", account: FakeHome.account)
        let mark = try await store.capturedThrough()[.contacts] ?? 0
        let old = home.deliveries.count
        try await ship()
        let source = "apple-contacts:\(FakeHome.account):\(FakeHome.unit)"
        let resent = try XCTUnwrap(home.deliveries.dropFirst(old).first { $0.seals[source] != nil })
        XCTAssertEqual(resent.ranges["contacts.jsonl"]?.first, 1, "the whole old log")
        XCTAssertEqual(resent.lost[source], [Lost(items: 3, what: CaptureExporter.clearedPhotoCopies)], "A's, B's and C's photos")
        let before = home.deliveries.count
        try await pass(log, book)
        var restated = try await lines(store, after: mark)
        XCTAssertEqual(restated, ["card A", "card B"], "every contact the old home imported, again")
        try await ship()
        let restatedDeliveries = home.deliveries.dropFirst(before)
        let named = restatedDeliveries.reduce(Set<String>()) { $0.union($1.named) }
        XCTAssertEqual(named, [SHA256Digest.tagged(photo), SHA256Digest.tagged(other)], "and both photos")
        XCTAssertEqual(restatedDeliveries.reduce(Set<String>()) { $0.union($1.blobs) }, [], "which the home's store holds: neither is sent again")
        try await pass(log, book)
        restated = try await lines(store, after: mark)
        XCTAssertEqual(restated.count, 2, "once")
    }

    private func contract(_ entries: [CaptureEntry], photos: [Data]) throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("packages/connect/ios-app/test/phone-contacts.json")
        let lines = try entries.map { String(decoding: try JSONEncoder.lifestream().encode($0), as: UTF8.self) }
        let fixture: [String: Any] = ["lines": lines, "photos": photos.map { $0.base64EncodedString() }]
        if ProcessInfo.processInfo.environment["LIFESTREAM_FIXTURES"] == "write" {
            var data = try JSONSerialization.data(withJSONObject: fixture, options: [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes])
            data.append(0x0A)
            try data.write(to: file)
        }
        let kept = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        func shape(_ line: String) throws -> NSDictionary {
            var object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
            object["captured"] = nil
            return object as NSDictionary
        }
        let message = "packages/connect/ios-app/test/phone-contacts.json is the lines the phone writes: LIFESTREAM_FIXTURES=write writes it"
        XCTAssertEqual(try (kept["lines"] as? [String] ?? []).map(shape), try lines.map(shape), message)
        XCTAssertEqual(kept["photos"] as? [String], fixture["photos"] as? [String], message)
    }

    private func report(_ name: String, _ scenario: [String: Any]) throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent(".build/e2e/contacts.json")
        var all = (try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [String: Any] ?? [:]
        all[name] = scenario
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: all, options: [.sortedKeys, .prettyPrinted]).write(to: file)
    }
}
