import Combine
import Foundation
import HomeLink
import LifestreamCaptureCore
import XCTest

@testable import Lifestream

@MainActor
final class PersonTalkTests: XCTestCase {
    private var folder: URL!
    private var pauses: Pauses!
    private let older: Int64 = 1_794_312_000_000

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("person-talk-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        pauses = Pauses()
    }

    override func tearDown() async throws {
        pauses.end()
        try? FileManager.default.removeItem(at: folder)
    }


    func testAMergedAwayPersonIsDrawnAndReadAgainUnderTheSurvivor() async throws {
        let (book, life, door, shelf) = try await made()
        door.became = ["person:person-k": "person:person-c"]
        let model = PersonModel(id: "person:person-k", life: life, book: book, shelf: { shelf })
        await model.read()
        XCTAssertEqual(model.page?.head.name, "Person C", "the survivor's page, as the home answers it")
        XCTAssertEqual(model.pages.key.query["id"], "person:person-c", "followed to the id the page names")
        await model.read()
        XCTAssertEqual(door.pages.last?.id, "person:person-c", "read again under the survivor")
    }

    func testAnEditThatDidNotLandSaysWhatEveryActSays() async throws {
        let (book, life, door, shelf) = try await made(now: AppClock.now)
        let model = PersonModel(id: "person:person-k", life: life, book: book, shelf: { shelf })
        let confirm = HomeLink.Confirm(id: "person:person-k")
        door.acting = HomeResponse(status: 503, body: Data(#"{"code":"HOME_FAILED","message":"Lifestream failed at this. Its log says why.","detail":null,"acts":[]}"#.utf8))
        var saved = await model.save(confirm, words: "Saved")
        XCTAssertEqual(saved, .failed(.notSent), "the home failing at it is not sent, with Try again")
        door.acting = HomeResponse(status: 422, body: Data(#"{"code":"BAD_NAME","message":"That name can't be used."}"#.utf8))
        saved = await model.save(confirm, words: "Saved")
        XCTAssertEqual(saved, .failed(.refused("That name can't be used.")), "a refusal in the home's words")
        door.acting = HomeResponse(status: 503, body: Data(#"{"code":"OUTCOME_UNKNOWN","message":"Lifestream didn't answer.","again":true,"began":false}"#.utf8))
        saved = await model.save(confirm, words: "Saved")
        XCTAssertEqual(saved, .failed(.unknown(ReachWords.unknown)), "sent with nothing back: not known whether saved")
        let request = door.requests.last
        door.acting = HomeResponse(status: 503, body: Data(#"{"code":"OUTCOME_UNKNOWN","message":"Lifestream is still working on this.","again":true,"began":true}"#.utf8))
        saved = await model.save(confirm, words: "Saved")
        XCTAssertEqual(saved, .failed(.saving), "begun on the home with no answer yet: still saving")
        XCTAssertEqual(Set(door.requests.drop { $0 != request }), Set([request].compactMap { $0 }),
                       "Save again on the act not known is Check: the same request")
    }

    func testASaveEndsOnceTheHomesAnswerIsReadAndNothingIsDrawnOverIt() async throws {
        let (book, life, door, shelf) = try await made()
        let model = PersonModel(id: "person:person-k", life: life, book: book, shelf: { shelf })
        door.list = ("1:1000", older)
        await model.read()
        await book.read()
        door.acting = Self.answer(act: "act-1", position: "5:5000")
        door.name = "Person K2"
        let lists = door.lists
        var renamed = HomeLink.Confirm(id: "person:person-k")
        renamed.name = .some("Person K2")
        let saved = await model.save(renamed, words: "Saved")
        XCTAssertEqual(saved, .saved)
        XCTAssertEqual(model.page?.head.name, "Person K2", "the page draws the home's answer as Save ends")
        XCTAssertEqual(book.person("person:person-k")?.name, "Person K2", "the list too, read once after the answer")
        XCTAssertEqual(door.lists, lists + 1, "one read, no waiting for a position")
        XCTAssertEqual(door.pages.last?.settled, true, "the page read again after its own save, settled")
        XCTAssertEqual(model.line, .done("Saved", act: "act-1"))
        XCTAssertFalse(book.polls, "an answered act owes nothing")
        XCTAssertTrue(pauses.waits.isEmpty)
    }

    func testASecondActOnAPersonWaitingIsNotTakenAndUndoIsTheNewestsOnly() async throws {
        let (book, life, door, shelf) = try await made()
        let model = PersonModel(id: "person:person-k", life: life, book: book, shelf: { shelf })
        door.list = ("1:1000", older)
        await model.read()
        let renamed = { (name: String) -> HomeLink.Confirm in
            var confirm = HomeLink.Confirm(id: "person:person-k")
            confirm.name = .some(name)
            return confirm
        }
        door.acting = Self.begun
        var saved = await model.save(renamed("Person K2"), words: "Saved")
        XCTAssertEqual(saved, .failed(.saving))
        XCTAssertEqual(model.line, .unanswered(.saving))
        XCTAssertEqual(model.page?.head.name, "Person K", "nothing drawn the home has not answered")
        XCTAssertNil(book.undoes(model.subject))

        saved = await model.save(renamed("Person K3"), words: "Saved")
        XCTAssertEqual(saved, .failed(.saving), "the person's Save draws the pending state")
        XCTAssertEqual(Set(door.requests).count, 1, "a second act on a person with one pending is not taken")

        door.acting = Self.answer(act: "act-1", position: "5:5000")
        try await until("the one poller waits") { self.pauses.waiting }
        pauses.pass()
        try await until("its check sends the same request, answered") { book.pending(model.subject) == nil }
        XCTAssertEqual(Set(door.requests), [door.requests[0]], "the check is the same request")
        XCTAssertEqual(model.line, .done("Saved", act: "act-1"))

        let other = PeopleBook.Subject.person("person:person-j")
        door.acting = Self.answer(act: "act-2", position: "6:6000")
        let sent = await book.send(other, { .people(request: $0, .confirm(HomeLink.Confirm(id: "person:person-j"))) }, words: "Saved")
        XCTAssertEqual(sent, .answered(HomeLink.OwnerAnswer(act: "act-2", id: nil, position: "6:6000")))
        XCTAssertNil(book.undoes(model.subject), "Undo is never offered on an older act")
        XCTAssertEqual(book.undoes(other), "act-2")
        door.acting = Self.begun
        saved = await model.save(renamed("Person K4"), words: "Saved")
        XCTAssertEqual(saved, .failed(.saving))
        XCTAssertNil(book.undoes(other), "nor while another act is pending")

        door.acting = Self.answer(act: "act-3", position: "7:7000")
        _ = await book.check(model.subject)
        XCTAssertEqual(model.line, .done("Saved", act: "act-3"))
        door.acting = Self.answer(act: "act-4", position: "8:8000")
        await model.undo()
        XCTAssertEqual(door.last?["kind"] as? String, "undo")
        XCTAssertEqual(door.last?["act"] as? String, "act-3")
        XCTAssertNil(model.line, "an undo is not undone")
    }

    func testStillSavingHoldsWhenALaterCheckHearsNothing() async throws {
        let (book, life, door, shelf) = try await made()
        let model = PersonModel(id: "person:person-k", life: life, book: book, shelf: { shelf })
        door.list = ("1:1000", older)
        await book.read()
        door.acting = Self.begun
        let saved = await model.save(HomeLink.Confirm(id: "person:person-k"), words: "Saved")
        XCTAssertEqual(saved, .failed(.saving))
        door.acting = HomeResponse(status: 503, body: Data(#"{"code":"OUTCOME_UNKNOWN","message":"Lifestream didn't answer.","again":true,"began":false}"#.utf8))
        let checked = await book.check(model.subject)
        XCTAssertEqual(checked, .said(.saving), "a check that hears no line says nothing new: the home began it")
        XCTAssertEqual(book.pending(model.subject), .unanswered(.saving))
        XCTAssertEqual(model.line, .unanswered(.saving), "still saving, with Check, never didn't say")
    }

    func testAMergeIsReadFromTheHomeOnceAnswered() async throws {
        let (book, life, door, shelf) = try await made()
        let model = PersonModel(id: "person:person-k", life: life, book: book, shelf: { shelf })
        door.list = ("1:1000", older)
        door.others = ["person:person-j"]
        await book.read()
        XCTAssertEqual(Set(book.people?.people.map(\.id) ?? []), ["person:person-k", "person:person-j"])

        var merge = HomeLink.Confirm(id: "person:person-k")
        merge.add = ["person:person-j"]
        door.acting = Self.answer(act: "act-1", position: "5:5000")
        door.others = []
        let saved = await model.save(merge, words: "Saved")
        XCTAssertEqual(saved, .saved)
        XCTAssertEqual(book.people?.people.map(\.id), ["person:person-k"], "the list read after the answer, as the home holds it")
    }

    func testARefusedActLeavesNothingAndAQuietChoiceIsDrawnOnlyWhileInFlight() async throws {
        let (book, life, door, shelf) = try await made()
        let model = PersonModel(id: "person:person-k", life: life, book: book, shelf: { shelf })
        door.list = ("1:1000", older)
        await model.read()
        await book.read()
        door.acting = HomeResponse(status: 422, body: Data(#"{"code":"BAD_NAME","message":"That name can't be used."}"#.utf8))
        var renamed = HomeLink.Confirm(id: "person:person-k")
        renamed.name = .some("Person K2")
        let saved = await model.save(renamed, words: "Saved")
        XCTAssertEqual(saved, .failed(.refused("That name can't be used.")))
        XCTAssertEqual(model.page?.head.name, "Person K")
        XCTAssertTrue(book.acts.isEmpty)

        let word = GroupWord(book: book)
        door.acting = Self.begun
        await word.choose(.quiet, key: "whatsapp:d")
        XCTAssertEqual(word.drawn("whatsapp:d", over: .rule), .quiet, "the choice in flight, drawn as it saves")
        door.acting = Self.answer(act: "act-1", position: "5:5000")
        _ = await book.check(.chat("whatsapp:d"))
        XCTAssertNil(book.pending(.chat("whatsapp:d")))
        XCTAssertEqual(word.drawn("whatsapp:d", over: .rule), .rule, "answered: the page draws what the home holds")
    }

    private static let begun = HomeResponse(status: 503, body: Data(#"{"code":"OUTCOME_UNKNOWN","message":"Lifestream is still working on this.","again":true,"began":true}"#.utf8))

    private static func answer(act: String, position: String) -> HomeResponse {
        HomeResponse(status: 200, body: Data(#"{"act":"\#(act)","id":null,"position":"\#(position)"}"#.utf8))
    }

    private func made(now: Date = Date(timeIntervalSince1970: 1_800_000_000)) async throws -> (PeopleBook, LifeReader, PeopleDoor, PageShelf) {
        let door = PeopleDoor()
        let home = folder.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let network = TestNetwork(NetworkFacts(online: true, onLocalNetwork: false, tunnelUp: true, path: 1, cost: .free))
        let link = HomeLink(device: HomeLink.Device(kind: .phone, version: "1.0.0", model: "iPhone", serial4: nil),
                            credentials: MemoryPass(), folder: home, transport: door, network: network)
        _ = try await link.pair(code: "12345678", name: "http://100.64.0.42:4680", account: "person-a@example.com")
        let life = LifeReader(link: link, clock: { now })
        let pauses = pauses!
        let book = PeopleBook(life: life, kept: home.appendingPathComponent("people", isDirectory: true),
                              pause: { await pauses.pause($0) })
        return (book, life, door, PageShelf(root: home.appendingPathComponent("pages", isDirectory: true), link: link))
    }
}

@MainActor
private final class Pauses {
    private(set) var waits: [Duration] = []
    private var held: [CheckedContinuation<Void, Never>] = []

    var waiting: Bool { !held.isEmpty }

    func pause(_ wait: Duration) async {
        waits.append(wait)
        await withCheckedContinuation { held.append($0) }
    }

    func pass() {
        let passing = held
        held = []
        passing.forEach { $0.resume() }
    }

    func end() {
        pass()
    }
}

private final class PeopleDoor: HomeTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var paired = false
    private var state: (String, Int64) = ("1:1000", 0)
    private var count = 0
    private var acted: HomeResponse?
    private var sent: [[String: Any]] = []
    private var listed: [String] = []
    private var heldName = "Person K"
    private var asked: [(id: String?, settled: Bool)] = []
    private var merged: [String: String] = [:]

    var requests: [String] { lock.withLock { sent.compactMap { $0["request"] as? String } } }
    var last: [String: Any]? { lock.withLock { sent.last } }
    var others: [String] {
        get { lock.withLock { listed } }
        set { lock.withLock { listed = newValue } }
    }

    var acting: HomeResponse? {
        get { lock.withLock { acted } }
        set { lock.withLock { acted = newValue } }
    }

    var list: (String, Int64) {
        get { lock.withLock { state } }
        set { lock.withLock { state = newValue } }
    }
    var lists: Int { lock.withLock { count } }
    var pages: [(id: String?, settled: Bool)] { lock.withLock { asked } }
    var became: [String: String] {
        get { lock.withLock { merged } }
        set { lock.withLock { merged = newValue } }
    }
    var name: String {
        get { lock.withLock { heldName } }
        set { lock.withLock { heldName = newValue } }
    }

    func perform(_ request: HomeRequest) async throws -> HomeResponse {
        let first = lock.withLock { () -> Bool in
            defer { paired = true }
            return !paired
        }
        if first {
            let answer = #"{"home":{"id":"h-0001","version":"0.2.0","floors":{"mac":"0.1.0","phone":"1.0.0","extension":"0.1.0"}},"#
                + #""pass":"p-0000aa00","unit":"iphone-aa00","sources":{},"owner":[],"needs":[],"calls":[],"settings":{},"#
                + #""turn":{"run":"0000000000000001","n":1}}"#
            return HomeResponse(status: 200, body: Data(#"{"unit":"iphone-aa00","answer":\#(answer)}"#.utf8))
        }
        let query = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        switch request.url.path {
        case "/v1/owner/act" where acting != nil:
            if case .json(let body) = request.body, let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] {
                lock.withLock { sent.append(object) }
            }
            return acting ?? HomeResponse(status: 404, body: Data())
        case HomeLink.Pages.Person.route:
            let id = query.first { $0.name == "id" }?.value
            lock.withLock { asked.append((id, query.contains { $0.name == "settled" && $0.value == "1" })) }
            var page = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.page)) as? [String: Any])
            let survivor = id.flatMap { became[$0] }
            page["became"] = survivor ?? NSNull()
            if survivor == nil, var head = page["head"] as? [String: Any] {
                head["name"] = name
                page["head"] = head
            }
            return HomeResponse(status: 200, headers: ["ETag": "\"page-\(id ?? "")\""], body: try JSONSerialization.data(withJSONObject: page))
        case "/v1/people":
            lock.withLock { count += 1 }
            let (at, lastMs) = list
            let chat: [String: Any] = ["key": "whatsapp:d", "network": "whatsapp", "chat": "d", "group": false, "label": NSNull(),
                                       "total": 10, "mine": 4, "first_ms": NSNull(), "last_ms": NSNumber(value: lastMs),
                                       "quiet": NSNull(), "word": NSNull()]
            let people = [Self.person(name: name, days: [:], lastMs: lastMs)] + others.map { Self.person(id: $0, days: [:], lastMs: lastMs) }
            return Self.reply(["people": people, "chats": [chat], "zone": "UTC", "day_start_hour": 4], at: at)
        default:
            return HomeResponse(status: 404, body: Data(#"{"code":"MISSING","message":"none"}"#.utf8))
        }
    }

    private static let page = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("homelink/Tests/Fixtures/pages/canned/person.person-c.json")

    private static func person(id: String = "person:person-k", name: String = "Person K", days: [String: Int], lastMs: Int64) -> [String: Any] {
        ["id": id, "name": name, "call_name": name, "full_name": NSNull(), "show": "name",
         "by": "registry", "person": NSNull(), "entity": "person", "me": false, "hidden": false, "organised": true,
         "handles": [], "networks": ["whatsapp"], "chats": [["key": "whatsapp:d", "count": 4]], "received": 3, "sent": 1,
         "first_ms": NSNull(), "last_ms": NSNumber(value: lastMs), "last_30": 0, "days_count": days.count, "photo": NSNull(),
         "days": days, "suggestions": [], "names_seen": [], "record": NSNull()]
    }

    private static func reply(_ object: [String: Any], at position: String) -> HomeResponse {
        HomeResponse(status: 200, headers: ["Lifestream-Position": position],
                     body: (try? JSONSerialization.data(withJSONObject: object)) ?? Data())
    }
}
