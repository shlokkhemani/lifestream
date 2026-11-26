import Foundation
import XCTest
@testable import HomeLink

final class ChatMediaTests: XCTestCase {
    private var folder: URL!
    private let phone = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil)
    private static let photo = "sha256:" + String(repeating: "ab", count: 32)
    private static let audio = "sha256:" + String(repeating: "cd", count: 32)
    private static let note = String(repeating: "0f", count: 16)

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func paired(_ transport: any HomeTransport) async throws -> (HomeLink, String) {
        let credentials = MemoryCredentials()
        let pairing = ScriptedTransport([.reply(200, Fixture.paired())])
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: pairing)
            .pair(code: "12345678", name: "https://lifestream.example.ts.net", account: Fixture.account)
        let pass = try XCTUnwrap(Fixture.object(pairing.requests[0])["pass"] as? String)
        return (HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport), pass)
    }

    func testAPhotoIsStreamedToTheStageAndItsAnswerOrRefusalRead() async throws {
        let file = folder.appendingPathComponent("photo.jpg")
        try Data([0xFF, 0xD8, 0xFF, 0xE0]).write(to: file)
        let transport = ScriptedTransport([
            .reply(200, #"{"file":"\#(Self.photo)","kind":"photo","width":4032,"height":3024}"#),
            .reply(200, #"{"file":"\#(Self.photo)","kind":"photo","read":false}"#),
            .reply(422, #"{"code":"PICTURE_UNREADABLE","message":"Lifestream can't read this picture."}"#),
            .reply(413, #"{"code":"FILE_TOO_LARGE","message":"Too large to send: over 25 MB."}"#),
            .reply(507, #"{"code":"STAGE_FULL","message":"Lifestream has too many unsent photos: send or remove some."}"#),
        ])
        let (link, pass) = try await paired(transport)
        let staged = try await link.stage(photo: file)
        XCTAssertEqual(staged, .init(file: Self.photo, kind: "photo", width: 4032, height: 3024))
        let unread = try await link.stage(photo: file)
        XCTAssertEqual(unread.read, false)
        for code in ["PICTURE_UNREADABLE", "FILE_TOO_LARGE", "STAGE_FULL"] {
            do {
                _ = try await link.stage(photo: file)
                XCTFail("\(code) read as staged")
            } catch let failure as LinkFailure {
                XCTAssertEqual(failure.code, code)
            }
        }
        let first = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual("\(first.method) \(first.url.path)", "POST /v1/ask/files")
        XCTAssertEqual(first.body, .file(file), "streamed from its file")
        XCTAssertEqual(first.headers["Authorization"], "Bearer \(pass)")

        XCTAssertEqual(try HomeLink.Ask.Staged.read(HomeResponse(status: 200, body: Data(#"{"file":"\#(Self.photo)","kind":"photo"}"#.utf8))).file,
                       Self.photo)
        XCTAssertThrowsError(try HomeLink.Ask.Staged.read(HomeResponse(status: 415, body: Data(#"{"code":"FILE_KIND","message":"Not a photo."}"#.utf8)))) {
            XCTAssertEqual($0 as? LinkFailure, .refused(status: 415, code: "FILE_KIND", message: "Not a photo."))
        }
    }

    func testANotesOpenSecondsAndCancelGoToTheirRoutes() async throws {
        let second = folder.appendingPathComponent("0.pcm")
        try Data(count: 32_000).write(to: second)
        let transport = ScriptedTransport([.reply(200, "{}"), .reply(200, "{}"), .reply(200, "{}"),
                                           .reply(409, #"{"code":"NOTE_CLOSED","message":"This note was sent."}"#)])
        let (link, _) = try await paired(transport)
        try await link.openNote(Self.note)
        try await link.sendSecond(note: Self.note, 7, file: second)
        try await link.cancelNote(Self.note)
        do {
            try await link.sendSecond(note: Self.note, 8, file: second)
            XCTFail("a closed note's second read as kept")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure.code, "NOTE_CLOSED")
        }
        XCTAssertEqual(transport.requests.map { "\($0.method) \($0.url.path)" }, [
            "POST /v1/ask/notes/\(Self.note)", "PUT /v1/ask/notes/\(Self.note)/7", "DELETE /v1/ask/notes/\(Self.note)",
            "PUT /v1/ask/notes/\(Self.note)/8",
        ])
        XCTAssertEqual(transport.requests[1].body, .file(second))
        do {
            try await link.openNote("not-a-note")
            XCTFail("an id that is no note's was sent")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unusableID)
        }
        XCTAssertEqual(transport.requests.count, 4)
    }

    func testAQuestionCarriesItsSubmissionPhotosAndNoteAndHearsWhatIsMissing() async throws {
        let turn = [#"{"type":"chat","chat":"1792396847000-3fa9c2","n":3}"#, #"{"type":"words","words":"Where was this taken?"}"#,
                    #"{"type":"done","message":{"chat":"1792396847000-3fa9c2","n":4,"at_ms":1792396861000,"role":"assistant","text":"At home.","end":"done"}}"#]
            .joined(separator: "\n")
        let transport = ScriptedTransport([
            .reply(409, #"{"error":"Some files are missing.","missing":{"photos":["\#(Self.photo)"],"seconds":[3,4]}}"#),
            .reply(200, turn), .reply(200, turn),
            .reply(409, #"{"error":"Your Mac no longer has this voice note.","missing":{"photos":[],"seconds":[],"audio":["\#(Self.audio)"]}}"#),
            .reply(200, #"{"type":"chat","chat":"1792396847000-3fa9c2","n":5}"# + "\n" + #"{"type":"error","error":"erased"}"#),
        ])
        let (link, _) = try await paired(transport)
        let question = HomeLink.Ask.Question(words: nil, photos: [Self.photo], voice: .note(Self.note, seconds: 12))
        do {
            _ = try await link.ask(question, level: nil, pick: nil)
            XCTFail("a seal's missing files read as a turn")
        } catch let missing as HomeLink.Ask.Missing {
            XCTAssertEqual(missing, .init(photos: [Self.photo], seconds: [3, 4], words: "Some files are missing."))
        }
        var events: [HomeLink.Ask.Event] = []
        for try await event in try await link.ask(question, chat: "1792396847000-3fa9c2", level: nil, pick: nil) { events.append(event) }
        XCTAssertEqual(events.dropFirst().first, .words("Where was this taken?"))
        _ = try await link.ask(HomeLink.Ask.Question(words: "And this?", photos: [Self.photo], voice: nil), level: nil, pick: nil)
        do {
            _ = try await link.ask(HomeLink.Ask.Question(words: nil, voice: .audio(Self.audio)), chat: "1792396847000-3fa9c2", level: nil, pick: nil)
            XCTFail("a held audio the home lost read as a turn")
        } catch let missing as HomeLink.Ask.Missing {
            XCTAssertEqual(missing, .init(photos: [], seconds: [], audio: [Self.audio], words: "Your Mac no longer has this voice note."),
                           "the audio it can't send, read, in the server's words")
        }
        var erased: [HomeLink.Ask.Event] = []
        for try await event in try await link.ask(HomeLink.Ask.Question(words: "Still there?"), chat: "1792396847000-3fa9c2", level: nil, pick: nil) {
            erased.append(event)
        }
        XCTAssertEqual(erased, [.chat(chat: "1792396847000-3fa9c2", n: 5), .error(kind: "erased", message: "")],
                       "an erasure after chat ends the turn: no dropped connection to follow")

        let sent = try transport.requests.map { try Fixture.object($0) }
        XCTAssertEqual(sent[0]["submission"] as? String, question.submission)
        XCTAssertEqual(sent[1]["submission"] as? String, question.submission, "a replay goes under its submission")
        XCTAssertNil(sent[0]["question"], "a voice question sends no words")
        XCTAssertEqual(sent[0]["photos"] as? [String], [Self.photo])
        XCTAssertEqual(sent[0]["voice"] as? [String: AnyHashable], ["note": Self.note, "seconds": 12])
        XCTAssertEqual(sent[2]["question"] as? String, "And this?")
        XCTAssertNil(sent[2]["voice"])
        XCTAssertNotEqual(sent[2]["submission"] as? String, question.submission)
        let held = HomeLink.Ask.Question(words: nil, voice: .audio(Self.audio)).body
        XCTAssertEqual(held["voice"] as? [String: String], ["audio": Self.audio])
        XCTAssertNil(held["photos"], "no photos, no member")
        XCTAssertNil(HomeLink.Ask.Question(words: "", voice: .audio(Self.audio)).words, "empty words are none")
    }

    func testAnAskServerRefusalBeforeAnyEventKeepsTheServersWords() async throws {
        let transport = ScriptedTransport([
            .reply(409, #"{"error":"A turn is still answering in this conversation."}"#),
            .reply(422, #"{"code":"REFUSED","message":"The door's own words."}"#),
            .reply(400, "{}"),
        ])
        let (link, _) = try await paired(transport)
        for expected in [LinkFailure.refused(status: 409, code: "HTTP_409", message: "A turn is still answering in this conversation."),
                         .refused(status: 422, code: "REFUSED", message: "The door's own words."),
                         .refused(status: 400, code: "HTTP_400", message: "Lifestream refused with 400")] {
            do {
                _ = try await link.ask(HomeLink.Ask.Question(words: "Where was I?"), chat: "1792396847000-3fa9c2", level: nil, pick: nil)
                XCTFail("a refusal read as a turn")
            } catch {
                XCTAssertEqual(error as? LinkFailure, expected)
            }
        }
    }

    func testAKeptQuestionTellsItsPhotosAndItsNotesWords() throws {
        let body = #"{"chat":"c","title":"t","messages":["#
            + #"{"chat":"c","n":1,"at_ms":1,"role":"user","text":"Where?","photos":["\#(Self.photo)"]},"#
            + #"{"chat":"c","n":3,"at_ms":2,"role":"user","text":"","voice":{"audio":"\#(Self.audio)","ms":38000,"writing":true}},"#
            + #"{"chat":"c","n":5,"at_ms":3,"role":"user","text":"","voice":{"audio":"\#(Self.audio)","ms":4000,"words":"And after?"}},"#
            + #"{"chat":"c","n":7,"at_ms":4,"role":"user","text":"","voice":{"audio":"\#(Self.audio)","ms":4000,"failed":"Your voice note had no words in it."}}]}"#
        let chat = try JSONDecoder().decode(HomeLink.Ask.Chat.self, from: Data(body.utf8))
        XCTAssertEqual(chat.messages[0].photos, [Self.photo])
        XCTAssertEqual(chat.messages[1].voice, .init(audio: Self.audio, ms: 38_000, writing: true))
        XCTAssertEqual(chat.messages[2].voice?.words, "And after?")
        XCTAssertEqual(chat.messages[3].voice?.failed, "Your voice note had no words in it.")
        XCTAssertNil(chat.messages[0].voice)
    }

    func testReadinessTellsPhotosTheVoiceRowAndTheLimits() throws {
        let body = #"{"default":{"model":"codex:gpt-6.1-terra","thinking":"high","shown":"codex:gpt-6.1-terra"},"starters":[],"#
            + #""models":[{"id":"codex:gpt-6.1-terra","name":"GPT-6.1 Terra","thinking":["high"],"default":"high","#
            + #""state":"ready","photos_off":null,"hides":true},"#
            + #"{"id":"runner:macbook-pro-0001/text-only","name":"Text Only","thinking":[],"default":"","#
            + #""state":"ready","photos_off":"Text Only can't see photos.","hides":false}],"#
            + #""menu":{"default":null,"rows":[{"value":"codex:gpt-6.1-terra","name":"GPT-6.1 Terra","account":null,"chosen":true}],"#
            + #""local":{"label":"Local","rows":[{"value":"runner:macbook-pro-0001/text-only","name":"Text Only","account":null,"chosen":false}]},"#
            + #""more":{"words":"More","use":"chat","work":null},"off":null},"#
            + #""voice":{"ready":true,"words":"Parakeet · your Mac","line":null,"caution":"Voice notes go to OpenRouter as they are: sound can't be hidden.","value":"default","#
            + #""choices":[{"value":"runner:macbook-pro-0001/parakeet-unified-en-0.6b","words":"Parakeet · your Mac","sent":false},"#
            + #"{"value":"openrouter:scribe-v2","words":"Scribe v2 · Sent as it is","sent":true}]},"#
            + #""limits":{"photos":10,"photo_bytes":26214400,"voice_ms":600000}}"#
        let ready = try JSONDecoder().decode(HomeLink.Ask.Ready.self, from: Data(body.utf8))
        XCTAssertEqual(ready.models.map(\.photosOff), [nil, "Text Only can't see photos."])
        XCTAssertEqual(ready.models.map(\.hides), [true, false], "a model that stays hides nothing: the home says so")
        XCTAssertEqual(ready.voice.words, "Parakeet · your Mac")
        XCTAssertEqual(ready.voice.ready, true)
        XCTAssertEqual(ready.voice.caution, "Voice notes go to OpenRouter as they are: sound can't be hidden.")
        XCTAssertEqual(ready.voice.value, "default")
        XCTAssertEqual(ready.voice.choices.map(\.sent), [false, true])
        XCTAssertEqual(ready.limits, .init(photos: 10, photoBytes: 26_214_400, voiceMs: 600_000))

        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any])
        XCTAssertEqual(ready.menu.local?.rows.map(\.name), ["Text Only"])
        for member in ["voice", "limits", "menu"] {
            var without = object
            without[member] = nil
            XCTAssertThrowsError(try JSONDecoder().decode(HomeLink.Ask.Ready.self, from: JSONSerialization.data(withJSONObject: without)),
                                 "an answer with no \(member) is no answer of this home's")
        }
        var models = try XCTUnwrap(object["models"] as? [[String: Any]])
        models[0]["hides"] = nil
        object["models"] = models
        XCTAssertThrowsError(try JSONDecoder().decode(HomeLink.Ask.Ready.self, from: JSONSerialization.data(withJSONObject: object)),
                             "a model that says nothing of whether its turns are hidden is no answer of this home's")
    }

    func testPrivacyTellsWhereVoiceNotesGoAndAnOutboundRowWhatItWasAbout() throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Fixtures/privacy.json")
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [String: Any])
        var fresh = try XCTUnwrap(object["fresh"] as? [String: Any])
        XCTAssertNil(try JSONDecoder().decode(HomeLink.PrivacyState.self, from: JSONSerialization.data(withJSONObject: fresh)).voice)
        fresh["voice"] = ["leaves": "OpenRouter"]
        object["fresh"] = fresh
        let state = try JSONDecoder().decode(HomeLink.PrivacyState.self, from: JSONSerialization.data(withJSONObject: fresh))
        XCTAssertEqual(state.voice?.leaves, "OpenRouter")

        let row = #"{"seq":4,"at_ms":1,"day":"2026-11-16","receiver":"openrouter","what":"ask","level":"none","counts":{},"chars":0,"pictures":0,"about":"chat-voice"}"#
        XCTAssertEqual(try JSONDecoder().decode(HomeLink.Outbound.self, from: Data(row.utf8)).about, "chat-voice")
    }

    func testTheStageIsAnsweredAgainSoALostAnswerGoesOn() {
        for route in ["POST /v1/ask/files", "POST /v1/ask/notes/<id>", "PUT /v1/ask/notes/<id>/<k>", "DELETE /v1/ask/notes/<id>"] {
            XCTAssertTrue(HomeLink.sentAgain(route), route)
        }
        XCTAssertFalse(HomeLink.sentAgain("POST /v1/ask"), "a question is sent again only by its submission, by the device")
    }

    func testA410IsTheConversationErasedOnAQuestionAFollowAndARead() async throws {
        let erased = #"{"error":"erased"}"#
        let transport = ScriptedTransport([.reply(410, erased), .reply(410, erased), .reply(410, erased),
                                           .reply(404, #"{"error":"No conversation."}"#)])
        let (link, _) = try await paired(transport)
        let chat = "1792396847000-3fa9c2"
        do {
            _ = try await link.ask(HomeLink.Ask.Question(words: "Where was I?"), chat: chat, level: nil, pick: nil)
            XCTFail("an erased conversation read as a turn")
        } catch {
            XCTAssertEqual(error as? HomeLink.Ask.Erased, HomeLink.Ask.Erased())
        }
        do {
            _ = try await link.follow(chat: chat)
            XCTFail("an erased conversation followed")
        } catch {
            XCTAssertEqual(error as? HomeLink.Ask.Erased, HomeLink.Ask.Erased())
        }
        do {
            _ = try await link.chat(chat)
            XCTFail("an erased conversation read")
        } catch {
            XCTAssertEqual(error as? HomeLink.Ask.Erased, HomeLink.Ask.Erased())
        }
        do {
            _ = try await link.chat(chat)
            XCTFail("an unknown conversation read")
        } catch {
            XCTAssertEqual(error as? LinkFailure, .refused(status: 404, code: "HTTP_404", message: "Lifestream refused with 404"),
                           "a conversation the server does not know is no erasure")
        }
    }
}
