import Foundation
import Network
import XCTest
@testable import HomeLink

final class AskTests: XCTestCase {
    private var folder: URL!
    private let phone = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil)

    private static func fixture(_ name: String) -> URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/" + name)
    }

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func paired(_ name: String, _ transport: any HomeTransport) async throws -> (HomeLink, String) {
        let credentials = MemoryCredentials()
        let pairing = ScriptedTransport([.reply(200, Fixture.paired())])
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: pairing)
            .pair(code: "12345678", name: name, account: Fixture.account)
        let pass = try XCTUnwrap(Fixture.object(pairing.requests[0])["pass"] as? String)
        return (HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport), pass)
    }

    private func all(_ events: AsyncThrowingStream<HomeLink.Ask.Event, Error>) async throws -> [HomeLink.Ask.Event] {
        var all: [HomeLink.Ask.Event] = []
        for try await event in events { all.append(event) }
        return all
    }


    func testATurnStreamsItsEventsAsTheDoorWritesThem() async throws {
        let stub = try await AskStub.start()
        defer { stub.stop() }
        let (link, pass) = try await paired(stub.name, URLSessionTransport())
        let events = try await link.ask("Where was I on Friday?", chat: "1792396847000-3fa9c2", level: nil, pick: nil)
        var iterator = events.makeAsyncIterator()

        let first = try await iterator.next()
        XCTAssertEqual(first, .chat(chat: "1792396847000-3fa9c2", n: 4))
        stub.release()
        var rest: [HomeLink.Ask.Event] = []
        while let event = try await iterator.next() { rest.append(event) }
        XCTAssertEqual(rest, [
            .stepBegan(call: 1, words: "Searching messages for “dinner”", said: "Looking at your messages"),
            .stepEnded(call: 1, words: "Searched messages for “dinner”", error: nil),
            .text("You were at Synthetic Cafe\u{2028}with Person A "),
            .text("[r1]."),
            .done(AskStub.done),
            .title(chat: "1792396847000-3fa9c2", title: "Friday night"),
        ])

        let request = try XCTUnwrap(stub.requests.first)
        XCTAssertEqual(request.line, "POST /v1/ask HTTP/1.1")
        XCTAssertEqual(request.header("authorization"), "Bearer \(pass)")
        XCTAssertEqual(request.header("lifestream-device"), "phone/1.4.0")
        XCTAssertEqual(request.header("content-type"), "application/json")
        var body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.body) as? [String: String])
        XCTAssertTrue(body.removeValue(forKey: "submission").map(HomeLink.Ask.isNote) == true, "a question goes under a submission")
        XCTAssertEqual(body, ["question": "Where was I on Friday?", "chat": "1792396847000-3fa9c2"])
    }

    func testAConnectionDroppedMidTurnIsNoAnswerNotAnEnd() async throws {
        let stub = try await AskStub.start(dropping: true)
        defer { stub.stop() }
        let (link, _) = try await paired(stub.name, URLSessionTransport())
        let events = try await link.ask("Where was I on Friday?", chat: "1792396847000-3fa9c2", level: nil, pick: nil)
        var seen: [HomeLink.Ask.Event] = []
        do {
            for try await event in events {
                seen.append(event)
                if seen.count == 1 { stub.release() }
            }
            XCTFail("a dropped turn ended as if done: \(seen)")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .noAnswer(sent: true))
        }
        XCTAssertEqual(seen.first, .chat(chat: "1792396847000-3fa9c2", n: 4), "what came before the drop is handed on")
        XCTAssertFalse(seen.contains { if case .done = $0 { true } else { false } })

        let (cut, _) = try await paired("https://lifestream.example.ts.net",
                                        ScriptedTransport([.reply(200, #"{"type":"chat","chat":"1792396847000-3fa9c2","n":4}"# + "\n")]))
        do {
            _ = try await all(try await cut.ask("Where was I on Friday?", chat: "1792396847000-3fa9c2", level: nil, pick: nil))
            XCTFail("a turn that ended before its done read as whole")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .noAnswer(sent: true))
        }
    }

    func testATurnThatCannotBeginEndsWithItsErrorNotNoAnswer() async throws {
        let refusal = #"{"type":"error","error":"login","message":"Chat needs your Claude sign-in on your Mac."}"# + "\n"
        let (link, _) = try await paired("https://lifestream.example.ts.net", ScriptedTransport([.reply(200, refusal)]))
        let events = try await all(try await link.ask("Where was I on Friday?", chat: "1792396847000-3fa9c2", level: nil, pick: nil))
        XCTAssertEqual(events, [.error(kind: "login", message: "Chat needs your Claude sign-in on your Mac.")])

        let begun = [#"{"type":"chat","chat":"1792396847000-3fa9c2","n":4}"#, #"{"type":"text","delta":"You were"}"#,
                     #"{"type":"error","error":"model","message":"ChatGPT didn't answer: you're offline."}"#].joined(separator: "\n") + "\n"
        let (cut, _) = try await paired("https://lifestream.example.ts.net", ScriptedTransport([.reply(200, begun)]))
        do {
            _ = try await all(try await cut.ask("Where was I on Friday?", chat: "1792396847000-3fa9c2", level: nil, pick: nil))
            XCTFail("a begun turn that ended with an error and no done read as whole")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .noAnswer(sent: true))
        }
    }


    func testFollowingAndStoppingAskTheirRoutes() async throws {
        let transport = ScriptedTransport([
            .reply(200, AskLines.turn), .reply(204, ""), .reply(200, #"{"stopped":true}"#),
        ])
        let (link, pass) = try await paired("https://lifestream.example.ts.net", transport)
        let followed = try await link.follow(chat: "1792396847000-3fa9c2")
        let replayed = try await all(try XCTUnwrap(followed))
        XCTAssertEqual(replayed.count, 8)
        XCTAssertEqual(replayed[1], .waiting("Downloading the hiding model: 340 of 900 MB"), "the turn's wait for hiding is lost")
        guard case .done(let done) = replayed[7] else { return XCTFail("the turn ends with \(replayed[7])") }
        XCTAssertEqual(done.thoughtMs, 9_100, "the time from the question to the answer's first word is lost")
        guard case .ref("r1", let r1) = replayed[4], case .ref("r3", let r3) = replayed[5] else {
            return XCTFail("a citation told before the words that cite it is lost: \(replayed[4]), \(replayed[5])")
        }
        XCTAssertEqual(r1.citation?.words, "Chat with Person A")
        XCTAssertEqual(r3, .ref("line.l40"), "a ref the home could not describe is told by its ref")
        XCTAssertEqual(done.refs, ["r1": r1, "r3": r3], "done keeps the refs told before it")
        let none = try await link.follow(chat: "1792396847000-3fa9c2")
        XCTAssertNil(none, "204: no turn runs")
        let stopped = try await link.stopAsking(chat: "1792396847000-3fa9c2")
        XCTAssertTrue(stopped)

        XCTAssertEqual(transport.requests.map { "\($0.method) \($0.url.path)" }, [
            "GET /v1/ask/chats/1792396847000-3fa9c2/events",
            "GET /v1/ask/chats/1792396847000-3fa9c2/events",
            "POST /v1/ask/stop",
        ])
        XCTAssertEqual(try Fixture.object(transport.requests[2]) as? [String: String], ["chat": "1792396847000-3fa9c2"])
        for request in transport.requests {
            XCTAssertEqual(request.headers["Authorization"], "Bearer \(pass)")
            XCTAssertEqual(request.headers["Lifestream-Device"], "phone/1.4.0")
        }
    }

    func testAConversationsLevelIsReadOnItsRouteAndPickedOnItsQuestion() async throws {
        let transport = ScriptedTransport([
            .reply(200, #"{"chat":"1792396847000-3fa9c2","level":"none","epoch":2,"later":true}"#),
            .reply(200, AskLines.turn), .reply(200, AskLines.turn), .reply(200, AskLines.turn),
        ])
        let (link, pass) = try await paired("https://lifestream.example.ts.net", transport)
        let read = try await link.chatPrivacy("1792396847000-3fa9c2")
        XCTAssertEqual(read, HomeLink.Ask.Privacy(chat: "1792396847000-3fa9c2", level: .none, epoch: 2))
        _ = try await link.ask("Where was I?", chat: nil, level: .all, pick: nil)
        _ = try await link.ask("And after?", chat: "1792396847000-3fa9c2", level: .names, pick: nil)
        _ = try await link.ask("And then?", chat: "1792396847000-3fa9c2", level: nil, pick: nil)
        XCTAssertEqual(transport.requests.map { "\($0.method) \($0.url.path)" }, [
            "GET /v1/privacy/chat/1792396847000-3fa9c2", "POST /v1/ask", "POST /v1/ask", "POST /v1/ask",
        ])
        XCTAssertEqual(try transport.requests[1...].map { try (Fixture.object($0) as? [String: String])?.filter { $0.key != "submission" } }, [
            ["question": "Where was I?", "level": "all"],
            ["question": "And after?", "chat": "1792396847000-3fa9c2", "level": "names"],
            ["question": "And then?", "chat": "1792396847000-3fa9c2"],
        ])
        for request in transport.requests {
            XCTAssertEqual(request.headers["Authorization"], "Bearer \(pass)")
            XCTAssertEqual(request.headers["Lifestream-Device"], "phone/1.4.0")
        }
    }

    func testTheReadyAnswerSaysWhichModelsCanAnswerAndDrawsTheirMenu() async throws {
        let withDefault = try String(contentsOf: Self.fixture("ask-ready-default.json"), encoding: .utf8)
        let withNone = try String(contentsOf: Self.fixture("ask-ready-no-default.json"), encoding: .utf8)
        var unnamed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(withDefault.utf8)) as? [String: Any])
        unnamed["default"] = nil
        let transport = ScriptedTransport([
            .reply(200, withDefault), .reply(200, withNone),
            .reply(200, String(decoding: try JSONSerialization.data(withJSONObject: unnamed), as: UTF8.self)),
        ])
        let (link, pass) = try await paired("https://lifestream.example.ts.net", transport)

        let ready = try await link.askReady(pick: nil)
        XCTAssertEqual(ready.default, .init(model: "openrouter:openai/gpt-6-luna", thinking: "medium", shown: "openrouter:openai/gpt-6-luna", choose: nil))
        XCTAssertNil(ready.said)
        XCTAssertNil(ready.gone)
        let luna = try XCTUnwrap(ready.models.first { $0.id == "openrouter:openai/gpt-6-luna" })
        XCTAssertTrue(luna.ready)
        XCTAssertEqual(luna.thinking, ["low", "medium", "high"])
        XCTAssertEqual(luna.default, "medium")
        XCTAssertNil(luna.photosOff)
        XCTAssertTrue(luna.hides)
        let local = try XCTUnwrap(ready.models.first { $0.id == "fake:fake-chat" })
        XCTAssertEqual(local.photosOff, "Fake chat can't see photos.", "text alone: no photos, in the home's words")
        XCTAssertFalse(local.hides, "a model that stays: its turns are not hidden")
        let small = try XCTUnwrap(ready.models.first { $0.id == "fake:fake-small" })
        XCTAssertEqual(small.thinking, [])
        XCTAssertEqual(small.default, "")
        XCTAssertEqual(ready.menu.rows.map(\.name), ["GPT-6 Luna", "Fake chat", "Fake small"], "the menu's rows: names, the home's order")
        XCTAssertEqual(ready.menu.rows.map(\.chosen), [true, false, false])
        XCTAssertEqual(ready.menu.more.words, "More")
        XCTAssertEqual(ready.menu.more.use, .chat)
        XCTAssertNil(ready.menu.off, "Chat has no Off")

        let none = try await link.askReady(pick: nil)
        XCTAssertEqual(none.default, .init(model: nil, thinking: "medium", shown: nil, choose: "Choose a model"),
                       "no model to answer: the home says none, names no model for the chip, and gives its words")
        XCTAssertEqual(none.said, "Chat has no default model: choose one from the menu.")
        XCTAssertEqual(none.models.map(\.id), ready.models.map(\.id))
        XCTAssertFalse(none.menu.rows.contains { $0.chosen }, "no default: no row is chosen")

        do {
            _ = try await link.askReady(pick: nil)
            XCTFail("an answer with no default read as an answer")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unreadable(200))
        }
        XCTAssertEqual(transport.requests.map { "\($0.method) \($0.url.path)" }, Array(repeating: "GET /v1/ask", count: 3))
        XCTAssertTrue(transport.requests.allSatisfy { $0.headers["Authorization"] == "Bearer \(pass)" })
    }

    func testTheReadyAnswerNeedsNoneOfTheMembersAShippedPhoneReads() throws {
        for name in ["ask-ready-default.json", "ask-ready-no-default.json"] {
            var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.fixture(name))) as? [String: Any])
            for member in ["login", "model", "name", "thinking"] { object[member] = nil }
            let ready = try JSONDecoder().decode(HomeLink.Ask.Ready.self, from: JSONSerialization.data(withJSONObject: object))
            XCTAssertEqual(ready.models.count, 3, name)
            XCTAssertNil(ready.login, name)
        }
    }

    func testAPhoneAtTheFloorStillReadsTheNewAnswer() throws {
        let withDefault = try JSONDecoder().decode(ShippedReady.self, from: Data(contentsOf: Self.fixture("ask-ready-default.json")))
        XCTAssertEqual([withDefault.model, withDefault.name, withDefault.thinking], ["openrouter:openai/gpt-6-luna", "GPT-6 Luna", "medium"])
        XCTAssertEqual(withDefault.login, .ready)
        XCTAssertNil(withDefault.said)
        XCTAssertEqual(withDefault.models.first { $0.id == "fake:fake-chat" }?.photos, false)
        XCTAssertEqual(withDefault.models.first { $0.id == "fake:fake-small" }?.photos, true)
        XCTAssertEqual(withDefault.limits, .init(photos: 10, photoBytes: 26_214_400, voiceMs: 600_000))

        let withNone = try JSONDecoder().decode(ShippedReady.self, from: Data(contentsOf: Self.fixture("ask-ready-no-default.json")))
        XCTAssertEqual([withNone.model, withNone.name, withNone.thinking], ["openrouter:openai/gpt-6-luna", "GPT-6 Luna", "low"],
                       "no default: the first row, at its first level")
        XCTAssertEqual(withNone.login, .missing)
        XCTAssertEqual(withNone.said, "Chat has no default model: choose one from the menu.")

        let readyFirst = try JSONDecoder().decode(ShippedReady.self, from: Data(contentsOf: Self.fixture("ask-ready-no-default-ready.json")))
        XCTAssertEqual(readyFirst.model, "openrouter:openai/gpt-6-luna", "no default: still the first row's strings")
        XCTAssertEqual(readyFirst.login, .missing, "no default, a ready first row: nothing to ask with, so not ready")
        XCTAssertEqual(readyFirst.said, "Chat has no default model: choose one from the menu.")
        let read = try JSONDecoder().decode(HomeLink.Ask.Ready.self, from: Data(contentsOf: Self.fixture("ask-ready-no-default-ready.json")))
        XCTAssertEqual(read.default, .init(model: nil, thinking: "medium", shown: nil, choose: "Choose a model"))
    }

    func testThePickGoesWithEveryQuestionAndEveryReadinessRead() async throws {
        let answer = try String(contentsOf: Self.fixture("ask-ready-default.json"), encoding: .utf8)
        let transport = ScriptedTransport([
            .reply(200, AskLines.turn), .reply(200, AskLines.turn), .reply(200, AskLines.turn),
            .reply(200, answer), .reply(200, answer), .reply(200, answer),
        ])
        let (link, _) = try await paired("https://lifestream.example.ts.net", transport)
        _ = try await link.ask("Where was I?", chat: "1792396847000-3fa9c2", level: nil, pick: .init(model: "gpt-6-sol", thinking: "low"))
        _ = try await link.ask("Where was I?", chat: "1792396847000-3fa9c2", level: nil, pick: .init(model: "claude/opus"))
        _ = try await link.ask("Where was I?", chat: "1792396847000-3fa9c2", level: nil, pick: nil)
        _ = try await link.askReady(pick: .init(model: "gpt-6-sol", thinking: "low"))
        _ = try await link.askReady(pick: .init(model: "claude/opus"))
        _ = try await link.askReady(pick: nil)

        XCTAssertEqual(try transport.requests[0...2].map { request in
            var body = try XCTUnwrap(Fixture.object(request) as? [String: String])
            XCTAssertEqual(body.removeValue(forKey: "submission")?.count, 32)
            return body
        }, [
            ["question": "Where was I?", "chat": "1792396847000-3fa9c2", "model": "gpt-6-sol", "thinking": "low"],
            ["question": "Where was I?", "chat": "1792396847000-3fa9c2", "model": "claude/opus"],
            ["question": "Where was I?", "chat": "1792396847000-3fa9c2"],
        ])
        XCTAssertEqual(transport.requests[3...].map(\.url.absoluteString), [
            "https://lifestream.example.ts.net/v1/ask?model=gpt-6-sol&thinking=low",
            "https://lifestream.example.ts.net/v1/ask?model=claude%2Fopus",
            "https://lifestream.example.ts.net/v1/ask",
        ])
    }

    func testTheAskServerNotAnsweringAndAConversationStillAnsweringAreRefusals() async throws {
        let transport = ScriptedTransport([
            .reply(503, #"{"code":"ASK_DOWN","message":"Ask is not answering on the home's Mac"}"#),
            .reply(409, #"{"error":"This conversation is still answering its last question."}"#),
        ])
        let (link, _) = try await paired("https://lifestream.example.ts.net", transport)
        do {
            _ = try await link.ask("Where was I?", chat: "1792396847000-3fa9c2", level: nil, pick: nil)
            XCTFail("a 503 read as a turn")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unavailable(code: "ASK_DOWN", message: "Ask is not answering on the home's Mac", retryAfter: nil))
        }
        do {
            _ = try await link.ask("And after?", chat: "1792396847000-3fa9c2", level: nil, pick: nil)
            XCTFail("a 409 read as a turn")
        } catch let failure as LinkFailure {
            guard case .refused(409, _, _) = failure else { return XCTFail("409 read as \(failure)") }
        }
    }

    func testALineThatIsNoEventEndsTheTurnAndAnUnknownTypeIsPassedOver() async throws {
        let transport = ScriptedTransport([
            .reply(200, #"{"type":"chat","chat":"1792396847000-3fa9c2","n":2}"# + "\n" + #"{"type":"reasoning","delta":"…"}"# + "\n"
                + #"{"type":"text","delta":"You were"}"# + "\n" + #"{"type":"done","message":{"chat":"1792396847000-3fa9c2","n":2,"at_ms":1792396861000,"role":"assistant","text":"You were at Synthetic Cafe.","end":"done"}}"#),
            .reply(200, #"{"type":"chat","chat":"1792396847000-3fa9c2","n":2}"# + "\n" + #"{"type":"step","call":1,"ms":412}"#),
        ])
        let (link, _) = try await paired("https://lifestream.example.ts.net", transport)
        let read = try await all(try await link.ask("Where was I?", chat: "1792396847000-3fa9c2", level: nil, pick: nil))
        XCTAssertEqual(read.prefix(2), [.chat(chat: "1792396847000-3fa9c2", n: 2), .text("You were")], "an unknown type is passed over")
        XCTAssertEqual(read.count, 3)
        var seen: [HomeLink.Ask.Event] = []
        do {
            for try await event in try await link.ask("Where was I?", chat: "1792396847000-3fa9c2", level: nil, pick: nil) { seen.append(event) }
            XCTFail("a step's end without its words was read")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unreadable(200))
        }
        XCTAssertEqual(seen, [.chat(chat: "1792396847000-3fa9c2", n: 2)])
    }

    static let chatFiles = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Fixtures/agents/ask")

    func testChatsChangesOfAccessReadAsTheTurnStreamsThemAndAsItsKeptAnswerStatesThem() async throws {
        let streamed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.chatFiles.appendingPathComponent("events.json"))) as? [[String: Any]])
        let kept = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.chatFiles.appendingPathComponent("kept.json"))) as? [String: Any])
        let chat = try XCTUnwrap(kept["chat"] as? String)
        let n = try XCTUnwrap(kept["n"] as? Int)
        let lines = try [#"{"type":"chat","chat":"\#(chat)","n":\#(n)}"#] + streamed.map(AgentsTests.canonical)
            + [#"{"type":"done","message":"# + (try AgentsTests.canonical(kept)) + "}"]
        let transport = ScriptedTransport([
            .reply(200, lines.joined(separator: "\n")),
            .reply(200, #"{"chat":"\#(chat)","title":"Agents","messages":["# + (try AgentsTests.canonical(kept)) + "]}"),
        ])
        let (link, _) = try await paired("https://lifestream.example.ts.net", transport)
        let read = try await all(try await link.ask("allow Synthetic Agent only the past day", chat: chat, level: nil, pick: nil))

        XCTAssertEqual(read.count, streamed.count + 2, "every line of the turn read as an event")
        XCTAssertEqual(read.first, .chat(chat: chat, n: n))
        let changes = read.dropFirst().prefix(streamed.count).compactMap { event -> HomeLink.AccessChange? in
            guard case .access(let change) = event else { return nil }
            return change
        }
        XCTAssertEqual(changes.count, streamed.count, "each access line is an access event")
        XCTAssertEqual(try changes.map(AgentsTests.encoded), try streamed.map { try AgentsTests.canonical(XCTUnwrap($0["change"])) },
                       "each change read whole and written back as the turn streamed it")
        guard case .narrowed(let id, let reader, let narrowed) = try XCTUnwrap(changes.first) else { return XCTFail("a narrowing first") }
        XCTAssertEqual([id, reader], ["ch-12", "p-00000001"])
        XCTAssertEqual(narrowed.words, [.init("Saved. Synthetic Agent now sees the "), .init("past 24 hours", bold: true), .init(".")])
        XCTAssertEqual(narrowed.undo.expect, 3, "Undo puts back the version the narrowing made")
        guard case .asked(let asked, let snapshot) = try XCTUnwrap(changes.last) else { return XCTFail("a widening asked last") }
        XCTAssertEqual(asked, snapshot.id)
        XCTAssertEqual(snapshot.by, .chat)
        XCTAssertEqual(snapshot.head, "Let Synthetic Agent read more?")
        XCTAssertEqual(snapshot.line, "Chat proposes All time", "Chat's proposal says it is Chat's")
        XCTAssertNil(snapshot.reason)

        guard case .done(let message) = try XCTUnwrap(read.last) else { return XCTFail("the turn ends with its kept answer") }
        XCTAssertEqual(message.access, changes, "the kept answer states the turn's changes, in order")
        XCTAssertEqual(message.steps?.map(\.error), [nil, nil, nil, "The door refused: 422 BAD_REQUEST: access: not must be empty."],
                       "a refused proposal is a step's error, no change")
        XCTAssertEqual(message.end, .done)
        let conversation = try await link.chat(chat)
        XCTAssertEqual(conversation.messages, [message], "the kept answer read on its conversation is the one the turn ended with")
    }

    func testAVoiceQuestionsChatLineNamesItsAudio() async throws {
        let audio = "sha256:" + String(repeating: "ab", count: 32)
        let transport = ScriptedTransport([
            .reply(200, #"{"type":"chat","chat":"1792396847000-3fa9c2","n":2,"audio":"\#(audio)"}"# + "\n"
                + #"{"type":"done","message":{"chat":"1792396847000-3fa9c2","n":2,"at_ms":1792396861000,"role":"assistant","text":"You were at Synthetic Cafe.","end":"done"}}"#),
        ])
        let (link, _) = try await paired("https://lifestream.example.ts.net", transport)
        let read = try await all(try await link.ask("Where was I?", level: nil, pick: nil))
        XCTAssertEqual(read.first, .chat(chat: "1792396847000-3fa9c2", n: 2, audio: audio))
    }

    static let voiceCite = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Fixtures/ask-voice-cite.json")

    func testACitedVoiceNoteIsToldAndKeptWithItsVoiceAsTheJourneyWroteIt() async throws {
        let written = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.voiceCite)) as? [String: Any])
        let lines = try XCTUnwrap(written["lines"] as? [[String: Any]])
        let conversation = try XCTUnwrap(written["conversation"] as? [String: Any])
        let chat = try XCTUnwrap(conversation["chat"] as? String)
        let text = { (value: Any) throws -> String in String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self) }
        let transport = ScriptedTransport([
            .reply(200, try lines.map(text).joined(separator: "\n")),
            .reply(200, try text(conversation)),
        ])
        let (link, _) = try await paired("https://lifestream.example.ts.net", transport)
        let read = try await all(try await link.ask("What did Person A say that evening, and what did I record?", chat: chat, level: nil, pick: nil))

        XCTAssertEqual(read.count, lines.count, "every line of the turn read as an event")
        let told = read.compactMap { event -> (handle: String, cited: HomeLink.Ask.Cited)? in
            guard case .ref(let handle, let cited) = event else { return nil }
            return (handle, cited)
        }
        let voices = told.compactMap { $0.cited.citation?.voice }
        XCTAssertEqual(voices.count, 2, "both cited notes told with their voice")
        for voice in voices {
            XCTAssertTrue(voice.audio.hasPrefix("sha256:"), voice.audio)
            XCTAssertTrue(voice.record.hasPrefix("record."), voice.record)
            XCTAssertEqual(voice.seconds, 3)
        }
        let heard = try XCTUnwrap(voices.first { !$0.mine }, "Person A's note")
        XCTAssertNotNil(heard.from, "a note someone else said names them")
        let own = try XCTUnwrap(voices.first { $0.mine }, "the person's own recording")
        XCTAssertNil(own.from, "the person's own note names no one")

        let done = read.compactMap { event -> HomeLink.Ask.Message? in
            guard case .done(let message) = event else { return nil }
            return message
        }
        let message = try XCTUnwrap(done.first)
        for (handle, cited) in told {
            XCTAssertEqual(message.refs?[handle], cited, "\(handle) kept as it was told")
        }
        let kept = try await link.chat(chat)
        XCTAssertEqual(kept.messages.last, message, "the kept answer read on its conversation keeps each note's voice")
    }

    func testTheListAndAConversationReadEveryMemberTheyNeed() async throws {
        let transport = ScriptedTransport([.reply(200, AskAnswers.chats), .reply(200, AskAnswers.chat)])
        let (link, _) = try await paired("https://lifestream.example.ts.net", transport)
        let page = try await link.chats(after: "WzE3OTJd")
        XCTAssertEqual(page.chats.map(\.title), ["Friday night", "Who did I see most this month"])
        XCTAssertEqual(page.chats[0].lastMs, 1_792_400_000_000)
        XCTAssertEqual(page.next, "WzE3OTFd")
        let chat = try await link.chat("1792396847000-3fa9c2")
        XCTAssertEqual(chat.running, .init(n: 4))
        XCTAssertEqual(chat.messages.map(\.role), [.user, .assistant, .user])
        let answer = chat.messages[1]
        XCTAssertEqual(answer.end, .done)
        XCTAssertEqual(answer.steps, [.init(words: "Searched messages for “dinner”")])
        XCTAssertEqual(answer.ms, 14_200)
        XCTAssertEqual(answer.thoughtMs, 9_400, "a kept answer says how long it thought")
        XCTAssertEqual(answer.refs?["r1"]?.citation?.opens, .days(day: "2026-10-16", focus: "rec:whatsapp:15550000000:phone-aa01 msg m157"))
        XCTAssertEqual(answer.refs?["r1"]?.citation?.chat, "chat.c1")
        XCTAssertEqual(answer.refs?["r2"]?.citation?.opens, .days(day: "2026-10-16", focus: "u:photos/burst-1"))
        XCTAssertEqual(answer.refs?["r2"]?.citation?.image, "sha256:" + String(repeating: "ab", count: 32))
        XCTAssertEqual(answer.refs?["r3"], .ref("line.l40"), "a ref the restore described none of is kept alone")
        XCTAssertEqual(transport.requests.map(\.url.absoluteString), [
            "https://lifestream.example.ts.net/v1/ask/chats?after=WzE3OTJd",
            "https://lifestream.example.ts.net/v1/ask/chats/1792396847000-3fa9c2",
        ])
    }

    func testEachCitationOfTheContractDecodesAndOneNoReleaseKnowsLosesNothing() throws {
        let contract = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("packages/home/test/contract")
        let citations = try JSONSerialization.jsonObject(with: Data(contentsOf: contract.appendingPathComponent("citations.json")))
        var refs = try XCTUnwrap(citations as? [String: Any])
        refs["r20"] = ["ref": "record.kept-alone"]
        refs["r21"] = ["ref": "map.m1", "kind": "map", "title": "Synthetic Map"]
        refs["r22"] = ["ref": ["source": "notes:local:device-a", "kind": "note", "key": "n1"], "day": "2026-10-01", "title": "Synthetic note"]
        refs["r23"] = ["ref": "record.r23", "kind": "record", "day": "2026-10-01", "opens": ["page": "map", "id": "m1"]]
        let message: [String: Any] = ["chat": "1792396847000-3fa9c2", "n": 2, "at_ms": 1792396861000, "role": "assistant",
                                      "text": "Person A [r9] wrote [r3].", "refs": refs, "end": "done"]
        let decoded = try JSONDecoder().decode(HomeLink.Ask.Message.self, from: JSONSerialization.data(withJSONObject: message))
        let cited = try XCTUnwrap(decoded.refs)
        XCTAssertEqual(cited.count, refs.count - 2, "only the citations this build cannot read are left out")
        XCTAssertNil(cited["r22"], "a citation of a shape this build cannot read is left out, never the answer")
        XCTAssertNil(cited["r23"], "a page this build does not open is left out, never the answer")
        let written = try XCTUnwrap(citations as? [String: [String: Any]])
        for (handle, citation) in written {
            let described = try XCTUnwrap(cited[handle]?.citation, handle)
            XCTAssertEqual(described.ref, citation["ref"] as? String, handle)
            XCTAssertEqual(described.kind.rawValue, citation["kind"] as? String, handle)
            XCTAssertEqual(described.opens == nil, citation["opens"] == nil, "\(handle) keeps where it opens")
        }
        XCTAssertEqual(cited["r3"]?.citation?.opens, .days(day: "2026-10-04", focus: "rec:whatsapp:15550000009:iphone-aa01 message a1"))
        XCTAssertEqual(cited["r3"]?.citation?.words, "Person A")
        XCTAssertEqual(cited["r8"]?.citation?.opens, .read, "a count's row opens through read")
        XCTAssertEqual(cited["r8"]?.citation?.words, "sum of amount over payments, by item")
        XCTAssertEqual(cited["r8"]?.citation?.n, 7)
        XCTAssertEqual(cited["r9"]?.citation?.opens, .people("phone:+15550000001"))
        XCTAssertEqual(cited["r10"]?.citation?.opens, .people("whatsapp:120363000000000004@g.us", group: "whatsapp:120363000000000004@g.us"))
        XCTAssertEqual(cited["r7"]?.citation?.opens, .days(day: "2026-11-02", focus: "u:screen:local:macbook-pro-0001/1793595600000@1793595780000-1793595840000"))
        XCTAssertEqual(cited["r20"], .ref("record.kept-alone"), "a ref kept alone is no citation")
        XCTAssertEqual(cited["r21"]?.citation?.kind, .other, "a kind no release knows keeps its words")
        XCTAssertEqual(cited["r21"]?.citation?.words, "Synthetic Map")
        XCTAssertEqual(cited["r12"]?.citation?.words, written["r12"]?["why"] as? String, "a gone citation says why")

        let unknown = #"{"described":[{"ref":"record.r23","kind":"record","opens":{"page":"map"}},"#
            + #"{"ref":"place.p1","kind":"place","name":"Example Cafe","opens":{"page":"places","id":"example-cafe"}}]}"#
        let described = try JSONDecoder().decode(HomeLink.Described.self, from: Data(unknown.utf8))
        XCTAssertEqual(described.described.map(\.ref), ["place.p1"], "a describe keeps what this build can open")
    }

    func testWhatTheModelSawDecodesAndAShapeThisBuildDoesNotKnowIsNoEyeNeverNoConversation() throws {
        func message(_ seen: Any?) throws -> HomeLink.Ask.Message {
            var message: [String: Any] = ["chat": "1792396847000-3fa9c2", "n": 2, "at_ms": 1792396861000, "role": "assistant",
                                          "text": "That's Person A on the left.", "end": "done"]
            message["seen"] = seen
            return try JSONDecoder().decode(HomeLink.Ask.Message.self, from: JSONSerialization.data(withJSONObject: message))
        }
        let seen: [String: Any] = [
            "asked": [["start": 18, "end": 26, "placeholder": "[[Person 1]]"], ["start": 32, "end": 32, "added": "]"]],
            "answered": [["start": 7, "end": 15, "placeholder": "[[Person 1]]"]],
            "photos": ["sha256:0000000000000000000000000000000000000000000000000000000000000001", NSNull()],
        ]
        XCTAssertEqual(try message(seen).seen, HomeLink.Ask.Message.Seen(
            asked: [.init(start: 18, end: 26, placeholder: "[[Person 1]]"), .init(start: 32, end: 32, added: "]")],
            answered: [.init(start: 7, end: 15, placeholder: "[[Person 1]]")],
            photos: ["sha256:0000000000000000000000000000000000000000000000000000000000000001", nil]))
        XCTAssertNil(try message(nil).seen, "an answer from before the release has no eye")
        var spoken = seen
        spoken["spoken"] = "Call Person A tomorrow"
        XCTAssertEqual(try message(spoken).seen?.spoken, "Call Person A tomorrow")
        for unknown: Any in [["asked": "all"], ["asked": [], "answered": [["start": 7, "end": 15, "shape": "x"]]],
                             ["asked": [], "answered": [["start": 7, "end": 15, "placeholder": "[[a]]", "added": "b"]]],
                             ["asked": [["start": 3, "end": 5, "added": "b"]], "answered": []], 42] {
            let read = try message(unknown)
            XCTAssertNil(read.seen, "a seen of a shape this build cannot read is no eye: \(unknown)")
            XCTAssertEqual(read.text, "That's Person A on the left.", "the answer itself still loads")
        }
    }

    func testACitedRowIsReadByItsRefAndAKeptRefIsDescribedOnItsRoute() async throws {
        let contract = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("packages/home/test/contract")
        let row = try String(contentsOf: contract.appendingPathComponent("read-row.json"), encoding: .utf8)
        let described = try String(contentsOf: contract.appendingPathComponent("describe.json"), encoding: .utf8)
        let transport = ScriptedTransport([.reply(200, row), .reply(200, described)])
        let (link, _) = try await paired("https://lifestream.example.ts.net", transport)
        guard case .row(let facts) = try await link.read(ref: "row.r1") else { return XCTFail("a row") }
        XCTAssertEqual([facts.n, facts.now], [7, 8], "the count it was given with, and now")
        XCTAssertEqual(facts.asked, "sum of amount over payments, by item")
        let answer = try await link.describe(["record.a1", "row.r1"])
        XCTAssertEqual(answer.described.map(\.kind), [.message, .window, .row, .person, .gone])
        do {
            _ = try await link.describe(Array(repeating: "record.a1", count: HomeLink.describedAtOnce + 1))
            XCTFail("more refs than the door takes")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unusableID)
        }
        XCTAssertEqual(transport.requests.map(\.url.absoluteString), [
            "https://lifestream.example.ts.net/v1/read?ref=row.r1",
            "https://lifestream.example.ts.net/v1/describe?ref=record.a1&ref=row.r1",
        ])
    }

    func testNothingIsSentUnpairedAndACancelledTurnIsACancellation() async throws {
        let transport = ScriptedTransport([.reply(200, AskLines.turn)])
        let unpaired = HomeLink(device: phone, credentials: MemoryCredentials(), folder: folder, transport: transport)
        do {
            _ = try await unpaired.ask("Where was I?", chat: "1792396847000-3fa9c2", level: nil, pick: nil)
            XCTFail("an unpaired phone asked")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unpaired)
        }
        XCTAssertTrue(transport.requests.isEmpty)

        let (link, _) = try await paired("https://lifestream.example.ts.net", ScriptedTransport([.cancelled]))
        do {
            _ = try await link.ask("Where was I?", chat: "1792396847000-3fa9c2", level: nil, pick: nil)
            XCTFail("a cancelled turn brought an answer")
        } catch is CancellationError {
        }
    }
}


private enum AskLines {
    static let turn = [
        #"{"type":"chat","chat":"1792396847000-3fa9c2","n":4}"#,
        #"{"type":"waiting","words":"Downloading the hiding model: 340 of 900 MB"}"#,
        #"{"type":"step","call":1,"name":"search","words":"Searching messages for “dinner”"}"#,
        #"{"type":"step","call":1,"words":"Searched messages for “dinner”","ms":412}"#,
        #"{"type":"ref","handle":"r1","cited":\#(r1)}"#,
        #"{"type":"ref","handle":"r3","cited":{"ref":"line.l40"}}"#,
        #"{"type":"text","delta":"You were at Synthetic Cafe [r1], all evening [r3]."}"#,
        #"{"type":"done","message":{"chat":"1792396847000-3fa9c2","n":2,"at_ms":1792396861000,"role":"assistant","text":"You were at Synthetic Cafe [r1], all evening [r3].","#
            + #""refs":{"r1":\#(r1),"r3":{"ref":"line.l40"}},"model":"gpt-6-luna","thinking":"high","thought_ms":9100,"end":"done"}}"#,
    ].joined(separator: "\n") + "\n"

    static let r1 = #"{"ref":"record.m157","kind":"message","day":"2026-10-16","title":"Chat with Person A","chat":"chat.c1","#
        + #""opens":{"page":"days","day":"2026-10-16","focus":"rec:whatsapp:15550000000:phone-aa01 msg m157"}}"#
}

private enum AskAnswers {
    static let chats = #"{"chats":[{"chat":"1792396847000-3fa9c2","title":"Friday night","first_ms":1792396847000,"last_ms":1792400000000,"messages":4,"later":true},{"chat":"1792300000000-00aa11","title":"Who did I see most this month","first_ms":1792300000000,"last_ms":1792300090000,"messages":2}],"next":"WzE3OTFd"}"#

    static let chat = #"{"chat":"1792396847000-3fa9c2","title":"Friday night","messages":["#
        + #"{"type":"ask.msg","chat":"1792396847000-3fa9c2","n":1,"at_ms":1792396847000,"role":"user","text":"Where was I on Friday?"},"#
        + #"{"type":"ask.msg","chat":"1792396847000-3fa9c2","n":2,"at_ms":1792396861000,"role":"assistant","text":"At Synthetic Cafe [r1][r2], all evening [r3].","#
        + #""refs":{"r1":{"ref":"record.m157","kind":"message","day":"2026-10-16","title":"Chat with Person A","chat":"chat.c1","#
        + #""opens":{"page":"days","day":"2026-10-16","focus":"rec:whatsapp:15550000000:phone-aa01 msg m157"}},"#
        + #""r2":{"ref":"record.p12","kind":"photo","day":"2026-10-16","title":"Photo at Synthetic Cafe","image":"sha256:\#(String(repeating: "ab", count: 32))","#
        + #""opens":{"page":"days","day":"2026-10-16","focus":"u:photos/burst-1"}},"#
        + #""r3":{"ref":"line.l40"}},"#
        + #""steps":[{"name":"search","words":"Searched messages for “dinner”","ms":412}],"model":"gpt-6-luna","ms":14200,"thought_ms":9400,"end":"done"},"#
        + #"{"type":"ask.msg","chat":"1792396847000-3fa9c2","n":3,"at_ms":1792400000000,"role":"user","text":"And after?"}],"#
        + #""running":{"n":4}}"#
}


private final class AskStub: @unchecked Sendable {
    struct Request {
        let line: String
        let headers: [String: String]
        let body: Data

        func header(_ name: String) -> String? { headers[name] }
    }

    static let done = HomeLink.Ask.Message(
        chat: "1792396847000-3fa9c2", n: 4, atMs: 1_792_400_014_000, role: .assistant,
        text: "You were at Synthetic Cafe\u{2028}with Person A [r1].",
        refs: ["r1": .described(.init(ref: "record.m157", kind: .message, opens: .days(day: "2026-10-16", focus: "rec:whatsapp:15550000000:phone-aa01 msg m157"),
                                      day: "2026-10-16", title: "Chat with Person A"))],
        steps: [.init(words: "Searched messages for “dinner”")], ms: 14_000, thoughtMs: 9_000, end: .done)

    private static let rest = [
        #"{"type":"step","call":1,"name":"search","words":"Searching messages for “dinner”","said":"Looking at your messages"}"#,
        #"{"type":"step","call":1,"words":"Searched messages for “dinner”","ms":412}"#,
        "{\"type\":\"text\",\"delta\":\"You were at Synthetic Cafe\u{2028}with Person A \"}",
        #"{"type":"text","delta":"[r1]."}"#,
        "{\"type\":\"done\",\"message\":{\"type\":\"ask.msg\",\"chat\":\"1792396847000-3fa9c2\",\"n\":4,\"at_ms\":1792400014000,\"role\":\"assistant\","
            + "\"text\":\"You were at Synthetic Cafe\u{2028}with Person A [r1].\",\"refs\":{\"r1\":{\"ref\":\"record.m157\",\"kind\":\"message\","
            + "\"opens\":{\"page\":\"days\",\"day\":\"2026-10-16\",\"focus\":\"rec:whatsapp:15550000000:phone-aa01 msg m157\"},"
            + "\"day\":\"2026-10-16\",\"title\":\"Chat with Person A\"}},\"steps\":[{\"name\":\"search\","
            + "\"words\":\"Searched messages for “dinner”\",\"ms\":412}],\"model\":\"gpt-6-luna\",\"ms\":14000,\"thought_ms\":9000,\"end\":\"done\"}}",
        #"{"type":"title","chat":"1792396847000-3fa9c2","title":"Friday night"}"#,
    ].joined(separator: "\n") + "\n"

    private let listener: NWListener
    private let queue = DispatchQueue(label: "ask-stub")
    private let dropping: Bool
    private let lock = NSLock()
    private var made: [Request] = []
    private var released = false
    private var waiting: (() -> Void)?

    private init(listener: NWListener, dropping: Bool) {
        self.listener = listener
        self.dropping = dropping
    }

    static func start(dropping: Bool = false) async throws -> AskStub {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let stub = AskStub(listener: try NWListener(using: parameters), dropping: dropping)
        stub.listener.newConnectionHandler = { [stub] connection in stub.serve(connection) }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            stub.listener.stateUpdateHandler = { state in
                switch state {
                case .ready: continuation.resume()
                case .failed(let error): continuation.resume(throwing: error)
                default: break
                }
            }
            stub.listener.start(queue: stub.queue)
        }
        stub.listener.stateUpdateHandler = nil
        return stub
    }

    var name: String { "http://127.0.0.1:\(listener.port!.rawValue)" }
    var requests: [Request] { lock.withLock { made } }

    func release() {
        let go = lock.withLock { () -> (() -> Void)? in
            released = true
            defer { waiting = nil }
            return waiting
        }
        go?()
    }

    func stop() { listener.cancel() }

    private func serve(_ connection: NWConnection) {
        connection.start(queue: queue)
        read(connection, Data())
    }

    private func read(_ connection: NWConnection, _ held: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [self] data, _, done, _ in
            let got = held + (data ?? Data())
            guard let end = got.range(of: Data("\r\n\r\n".utf8)) else {
                if !done { read(connection, got) }
                return
            }
            let head = String(decoding: got[..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
            var headers: [String: String] = [:]
            for line in head.dropFirst() {
                guard let colon = line.firstIndex(of: ":") else { continue }
                headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            }
            let body = got[end.upperBound...]
            guard body.count >= Int(headers["content-length"] ?? "0") ?? 0 else { return read(connection, got) }
            lock.withLock { made.append(Request(line: head[0], headers: headers, body: Data(body))) }
            answer(connection)
        }
    }

    private func answer(_ connection: NWConnection) {
        let head = "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson; charset=utf-8\r\nTransfer-Encoding: chunked\r\n\r\n"
        connection.send(content: Data(head.utf8) + Self.chunk(#"{"type":"chat","chat":"1792396847000-3fa9c2","n":4}"# + "\n"),
                        completion: .idempotent)
        let rest = Data(Self.rest.utf8)
        let write = { [self] in
            let mid = rest.range(of: Data("\u{2028}".utf8))!.lowerBound + 1
            let pieces = [rest[..<30], rest[30..<mid], rest[mid...]]
            if dropping {
                connection.send(content: Self.chunk(pieces[0]), completion: .contentProcessed { _ in connection.cancel() })
                return
            }
            for piece in pieces { connection.send(content: Self.chunk(piece), completion: .idempotent) }
            connection.send(content: Data("0\r\n\r\n".utf8), completion: .contentProcessed { _ in connection.cancel() })
        }
        let now = lock.withLock { () -> Bool in
            if released { return true }
            waiting = { [queue] in queue.async(execute: write) }
            return false
        }
        if now { write() }
    }

    private static func chunk(_ text: String) -> Data { chunk(Data(text.utf8)) }

    private static func chunk(_ bytes: Data) -> Data {
        Data((String(bytes.count, radix: 16) + "\r\n").utf8) + bytes + Data("\r\n".utf8)
    }
}
