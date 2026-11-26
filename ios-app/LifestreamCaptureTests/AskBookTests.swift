import Cockpit
import Combine
import CryptoKit
import Foundation
import UIKit
import HomeLink
import LifestreamCaptureCore
import XCTest

@testable import Lifestream

@MainActor
final class AskBookTests: XCTestCase {
    private let microphone = TestMicrophone()
    private let plays = Plays()
    private var folder: URL!
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("ask-book-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        suite = "ask-book-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: folder)
    }

    func testAChoiceIsDrawnAtOnceKeptForTheIPhoneAndKeepsOnlyALevelTheNewModelTakes() async throws {
        let (book, door) = try await made()
        await book.readReady()
        XCTAssertEqual(book.asks, .init(model: "gpt-6.1-terra", name: "GPT-6.1 Terra", thinking: "high"), "the default, as the server says it")
        XCTAssertNil(book.pick)

        book.choose(model: "gpt-6-luna")
        XCTAssertEqual(book.pick, .init(model: "gpt-6-luna"), "no level was kept: none")
        XCTAssertEqual(book.asks, .init(model: "gpt-6-luna", name: "GPT-6 Luna", thinking: "high"), "drawn at once, at its own level")
        try await until("the read with Luna answers") { door.answered.last == "gpt-6-luna" && book.chosen == nil }

        book.choose(thinking: "xhigh")
        XCTAssertEqual(book.asks?.thinking, "xhigh")
        try await until("the read at Extra high answers") { door.readiness.count == 3 && book.chosen == nil }

        book.choose(model: "gpt-6.1-terra")
        XCTAssertEqual(book.pick, .init(model: "gpt-6.1-terra", thinking: "xhigh"), "Terra takes Extra high: kept")
        try await until("the read with Terra answers") { door.answered.last == "gpt-6.1-terra" && book.chosen == nil }
        XCTAssertEqual(book.asks?.thinking, "xhigh")

        book.choose(model: "gpt-6-sol")
        XCTAssertEqual(book.pick, .init(model: "gpt-6-sol"), "Sol takes no Extra high: none kept")
        XCTAssertEqual(book.asks, .init(model: "gpt-6-sol", name: "GPT-6 Sol", thinking: "medium"), "drawn at Sol's own level")
        try await until("the read with Sol answers") { door.answered.last == "gpt-6-sol" && book.chosen == nil }
        XCTAssertEqual(door.readiness.last, "/v1/ask?model=gpt-6-sol", "read again with the pick, no level")

        let relaunched = AskBook(defaults: defaults)
        XCTAssertEqual(relaunched.pick, .init(model: "gpt-6-sol"), "the pick outlives the book: one per iPhone")
    }

    func testWhatAQuestionRunsOnAndTheMenuOfModelsAreTheHomes() async throws {
        let (book, door) = try await made()
        door.chatDefault = ("gpt-6-luna", "low")
        await book.readReady()
        XCTAssertEqual(book.asks, .init(model: "gpt-6-luna", name: "GPT-6 Luna", thinking: "low"), "the home's default, at its thinking")
        XCTAssertTrue(book.askable)
        XCTAssertNil(book.unattachable(holding: 0))
        XCTAssertFalse(book.stays, "a model that leaves: the level chip is drawn")
        XCTAssertEqual(book.menu?.rows.map(\.name), ["GPT-6.1 Terra", "GPT-6 Luna", "GPT-6 Sol"], "the home's menu, names only")
        XCTAssertEqual(book.menu?.local?.rows.map(\.name), ["Qwen 3.5 9B"], "under Local")

        book.choose(model: "runner:macbook-pro-0001/qwen-3.5-9b")
        XCTAssertEqual(book.asks, .init(model: "runner:macbook-pro-0001/qwen-3.5-9b", name: "Qwen 3.5 9B", thinking: ""), "no levels")
        XCTAssertTrue(book.stays, "a model that stays: nothing is hidden, no level chip")
        XCTAssertEqual(book.unattachable(holding: 0), "Qwen 3.5 9B can't see photos.", "the photo button off, saying why")

        door.chatDefault = (nil, "medium")
        door.said = "Chat has no default model: choose one from the menu."
        book.reset()
        try await until("the read with no default answers") { door.answered.count == 3 && book.ready?.default.model == nil }
        XCTAssertNil(book.asks, "no default: the home names no model for the chip")
        XCTAssertEqual(book.chooseWords, "Choose a model", "the chip's words, the home's")
        XCTAssertTrue(book.stays, "no model: no level chip")
        XCTAssertTrue(book.waits, "no model answers: the composer waits")
        XCTAssertEqual(book.ready?.said, door.said)

        door.chatDefault = ("gpt-6.1-terra", "high")
        door.signedIn = false
        door.said = "Chat needs your Claude sign-in on your Mac."
        await book.readReady()
        XCTAssertTrue(book.waits, "the default not ready: the composer waits")
        XCTAssertEqual(book.menu?.rows, [], "a model not ready is left out of the menu")
    }

    func testResetForgetsThePickAndAPickGoneIsForgottenWithNothingSaid() async throws {
        keep(.init(model: "gpt-6-sol", thinking: "low"))
        let (book, door) = try await made()
        XCTAssertEqual(book.pick, .init(model: "gpt-6-sol", thinking: "low"), "read from the defaults")
        await book.readReady()
        XCTAssertEqual(door.readiness, ["/v1/ask?model=gpt-6-sol&thinking=low"])
        XCTAssertEqual(book.asks?.thinking, "low")

        book.reset()
        XCTAssertNil(book.pick)
        XCTAssertNil(defaults.data(forKey: "ask.pick"), "forgotten on the iPhone")
        try await until("the default is read") { door.answered.count == 2 }
        XCTAssertEqual(door.readiness.last, "/v1/ask", "read with no pick")
        book.reset()
        XCTAssertEqual(door.readiness.count, 2, "Reset with nothing kept reads nothing")

        keep(.init(model: "gpt-6-retired", thinking: "high"))
        let (gone, _) = try await made()
        await gone.readReady()
        XCTAssertNil(gone.pick, "a pick gone is forgotten")
        XCTAssertNil(defaults.data(forKey: "ask.pick"))
        XCTAssertEqual(gone.asks?.model, "gpt-6.1-terra", "the default answers")
        XCTAssertNil(gone.ready?.said, "nothing said")
    }

    func testALateAnswerForARetiredPickNeverErasesTheNewerPick() async throws {
        keep(.init(model: "gpt-6-luna"))
        let (book, door) = try await made()
        await book.readReady()
        XCTAssertEqual(book.asks?.model, "gpt-6-luna")

        door.hold("gpt-6-luna")
        let late = Task { await book.readReady() }
        try await until("the read for Luna is at the door") { door.holding("gpt-6-luna") }
        door.retire("gpt-6-luna")
        book.choose(model: "gpt-6-sol")
        try await until("the read for Sol answers") { door.answered.last == "gpt-6-sol" && book.chosen == nil }

        door.release("gpt-6-luna")
        await late.value
        XCTAssertEqual(door.answered.last, "gone", "the late answer was the retired pick's gone")
        XCTAssertEqual(book.pick, .init(model: "gpt-6-sol"), "the newer pick is kept")
        XCTAssertNotNil(defaults.data(forKey: "ask.pick"))
        XCTAssertEqual(book.asks, .init(model: "gpt-6-sol", name: "GPT-6 Sol", thinking: "medium"), "and drawn")
    }

    func testUnpairingForgetsThePickAndAReadOutBeforeItLandsOnNothing() async throws {
        keep(.init(model: "gpt-6-luna", thinking: "low"))
        let (book, door) = try await made()
        await book.readReady()
        door.hold("gpt-6-luna")
        let late = Task { await book.readReady() }
        try await until("the read for Luna is at the door") { door.holding("gpt-6-luna") }

        book.forget()
        XCTAssertNil(book.pick)
        XCTAssertNil(defaults.data(forKey: "ask.pick"), "forgotten on the iPhone")
        door.release("gpt-6-luna")
        await late.value
        XCTAssertNil(book.ready, "the last home's answer is not drawn")
        XCTAssertNil(book.asks)
        XCTAssertNil(book.pick)
    }

    func testChatsChangesOfAccessLandOnTheTurnAsTheyStreamAndStayOnItsKeptAnswer() async throws {
        let file = { (name: String) throws -> Any in
            let url = try XCTUnwrap(Bundle.main.url(forResource: name, withExtension: "json", subdirectory: "agents/ask"), "agents/ask/\(name).json")
            return try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        }
        let events = try XCTUnwrap(try file("events") as? [[String: Any]])
        let kept = try XCTUnwrap(try file("kept") as? [String: Any])
        let changes = try events.map { try JSONDecoder().decode(HomeLink.AccessChange.self, from: JSONSerialization.data(withJSONObject: XCTUnwrap($0["change"]))) }
        XCTAssertEqual(try JSONDecoder().decode([HomeLink.AccessChange].self, from: JSONSerialization.data(withJSONObject: XCTUnwrap(kept["access"]))), changes,
                       "the kept answer states the changes the turn streamed")
        let door = AskDoor()
        door.changingAccess = (events, kept)
        let (book, _) = try await made(door: door)

        let conversation = try book.asked("allow Synthetic Agent only the past day")
        try await until("the turn is answered") { conversation.turns.last?.answer.end == .done }
        XCTAssertEqual(conversation.turns.last?.answer.access, changes, "each change once, in the order it streamed")
        guard case .narrowed(_, _, let narrowed)? = changes.first, case .asked(_, let snapshot)? = changes.last else {
            return XCTFail("a narrowing, then Chat's proposal")
        }
        XCTAssertEqual(AgentsWords.plain(narrowed.words), "Saved. Synthetic Agent now sees the past 24 hours.")
        XCTAssertEqual(snapshot.by, .chat)
        XCTAssertEqual(snapshot.head, "Let Synthetic Agent read more?")

        await conversation.open()
        XCTAssertEqual(conversation.turns.map(\.answer.access), [changes], "read back, the kept answer holds them, none twice")
    }

    func testEveryQuestionSendsThePick() async throws {
        let (book, door) = try await made()
        await book.readReady()
        book.choose(model: "gpt-6-sol")
        book.choose(thinking: "low")
        try await until("the read for Sol at Low answers") { door.readiness.last == "/v1/ask?model=gpt-6-sol&thinking=low" && book.chosen == nil }

        let conversation = try book.asked("Where was I on Friday?")
        try await until("the first turn is answered") { conversation.turns.last?.answer.end == .done }
        XCTAssertEqual(door.questions.last, ["question": "Where was I on Friday?", "model": "gpt-6-sol", "thinking": "low"])

        book.reset()
        try await until("the default is read") { door.readiness.last == "/v1/ask" && door.answered.last == "gpt-6.1-terra" }
        conversation.ask("And after?")
        try await until("the second turn is answered") { conversation.turns.count == 2 && conversation.turns[1].answer.end == .done }
        let chat = try XCTUnwrap(conversation.chat)
        XCTAssertEqual(door.questions.last, ["question": "And after?", "chat": chat], "no pick kept: none sent")
    }

    func testWhatStopsChatIsTheServersToSay() async throws {
        let (book, door) = try await made()
        door.said = "Your pick needs your Claude sign-in on your Mac. Asking GPT-6.1 Terra."
        await book.readReady()
        XCTAssertEqual(book.ready?.said, door.said)
        XCTAssertFalse(book.waits, "a line beside a ready sign-in leaves Chat askable")

        let old = try book.asked("Where was I?")
        try await until("the old conversation is answered") { old.turns.last?.answer.end == .done }

        door.said = "Chat needs your Claude sign-in on your Mac."
        door.signedIn = false
        let conversation = try book.asked("Use my sign-in")
        try await until("the turn ends") { conversation.turns.last.map { $0.answer.end != .running } ?? false }
        XCTAssertEqual(conversation.turns.map(\.question), ["Use my sign-in"], "the question stays")
        XCTAssertEqual(conversation.turns.last?.answer.end, .failed("Chat needs your Claude sign-in on your Mac."), "the server's words, as given")
        XCTAssertEqual(conversation.turns.last?.answer.signIn, true)
        try await until("readiness is read again") { book.waits }
        XCTAssertTrue(book.waits, "the composer waits")

        old.ask("And now?")
        try await until("the follow-up ends") { old.turns.count == 2 && old.turns[1].answer.end != .running }
        XCTAssertEqual(old.turns.map(\.question), ["Where was I?", "And now?"], "the question stays")
        XCTAssertEqual(old.turns[1].answer.end, .failed("Chat needs your Claude sign-in on your Mac."))

        door.down = true
        await book.readReady()
        XCTAssertEqual(book.down, "Chat isn't answering on your Mac", "the Ask server not answering is said, in the door's words")
        XCTAssertTrue(book.waits)
        door.down = false
        door.signedIn = true
        door.said = nil
        await book.readReady()
        XCTAssertNil(book.down)
        XCTAssertFalse(book.waits)
    }

    func testAFirstReadinessReadThatFailsForReachIsOwedUntilOneAnswers() async throws {
        let (book, door) = try await made()
        XCTAssertTrue(book.unread, "nothing read yet")
        door.unreached = true
        await book.readReady()
        XCTAssertNil(book.ready)
        XCTAssertTrue(book.unread, "the home out of reach: still owed, so the foot reads again when the home heals")
        door.unreached = false
        await book.readReady()
        XCTAssertEqual(book.asks?.model, "gpt-6.1-terra")
        XCTAssertFalse(book.unread)
    }

    func testAQuestionThatReachedNoHomeIsDrawnSendingAndGoesWhenTheHomeAnswers() async throws {
        let (book, door) = try await made()
        await book.readReady()
        door.unreached = true
        let conversation = try book.asked("Where was I?")
        try await until("drawn sending, waiting for the home") { conversation.turns.last?.answer.waiting == AskConversation.Answer.held }
        XCTAssertEqual(conversation.turns.last?.answer.end, .running, "never failed: it goes when the home answers")
        XCTAssertEqual(book.outbox.waiting.map(\.words), ["Where was I?"])

        door.unreached = false
        door.failing = "door"
        let next = try book.asked("And now?")
        try await until("the second turn ends") { next.turns.last.map { $0.answer.end != .running } ?? false }
        XCTAssertEqual(next.turns.last?.answer.end, .failed("fetch failed"), "the Ask server's door out of reach, in its words")
        XCTAssertEqual(book.outbox.entries.first { $0.words == "And now?" }?.failed, "fetch failed", "kept for Try again")

        door.failing = nil
        await book.readReady()
        try await until("the held question goes once the home answers") { conversation.turns.last?.answer.end == .done }
        XCTAssertEqual(door.questions.map { $0["question"] }, ["And now?", "Where was I?"])
        XCTAssertEqual(next.turns.last?.answer.end, .failed("fetch failed"), "one a refusal holds waits for Try again")
        next.retry(try XCTUnwrap(next.turns.last))
        try await until("Try again posts it") { next.turns.last?.answer.end == .done }
        XCTAssertEqual(door.submissions.map(\.submission).filter { $0 == door.submissions[0].submission }.count, 2, "the same submission")
        XCTAssertTrue(book.outbox.entries.isEmpty)
    }

    func testAPhotoGoesAtPickOnceAndTheQuestionNamesItByTheStagesName() async throws {
        let (book, door) = try await made()
        await book.readReady()
        let outbox = book.outbox
        let photo = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 4, height: 3)).jpegData(withCompressionQuality: 0.9) { context in
            UIColor.orange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 4, height: 3))
        })
        let name = "sha256:" + SHA256.hash(data: photo).map { String(format: "%02x", $0) }.joined()
        let limits = try XCTUnwrap(book.limits, "what a question may carry, as readiness says it")
        let id = try XCTUnwrap(outbox.pick(photo, ext: "jpg", holding: [], limits: limits))
        XCTAssertEqual(outbox.photos[id]?.state, .uploading, "posted at pick, before any question")
        try await until("the stage answers") { outbox.photos[id]?.state == .staged(name) }
        XCTAssertNil(outbox.pick(photo, ext: "jpg", holding: [id], limits: limits), "the same photo twice is attached once")
        XCTAssertEqual(door.staged[name], 1)

        let bad = try XCTUnwrap(outbox.pick(Data("BAD-photo".utf8), ext: "jpg", holding: [id], limits: limits))
        try await until("the door refuses it") { outbox.photos[bad]?.state != .uploading }
        XCTAssertEqual(outbox.refusal([id, bad], limits: limits), "Lifestream can't read this picture.", "in the door's words")
        let small = HomeLink.Ask.Ready.Limits(photos: 10, photoBytes: 4, voiceMs: 600_000)
        let large = try XCTUnwrap(outbox.pick(Data("too-large".utf8), ext: "jpg", holding: [id], limits: small))
        XCTAssertEqual(outbox.photos[large]?.state, .tooLarge, "refused at pick, never posted")
        XCTAssertEqual(outbox.refusal([large], limits: small), "Too large to send: over 0 MB.")
        XCTAssertNil(outbox.file(large).flatMap { try? Data(contentsOf: $0) }, "nothing of it written to post")

        let conversation = try book.asked("Where did I take this?", photos: [id])
        XCTAssertEqual(conversation.turns.last?.photos, [.own(id)], "drawn at once from the device's own thumbnail")
        XCTAssertNotNil(outbox.thumbnails[id])
        try await until("the turn is answered") { conversation.turns.last?.answer.end == .done }
        XCTAssertEqual(door.submissions.last?.photos, [name], "named as the stage named it")
        XCTAssertEqual(conversation.turns.last?.photos, [.held(name)], "drawn from the home by its name")
        XCTAssertTrue(outbox.entries.isEmpty, "gone at chat")
        XCTAssertNil(outbox.photos[id], "its photo's file with it")
        XCTAssertNil(outbox.thumbnails[id], "and its thumbnail: nothing sent is kept here")

        XCTAssertNil(book.unattachable(holding: 0))
        XCTAssertEqual(book.unattachable(holding: 10), "At most 10 photos a question.")
    }

    func testAQuestionThatReachedNoHomeSurvivesARelaunchAndGoesUnderItsSubmission() async throws {
        let place = folder.appendingPathComponent("outbox")
        let (book, door) = try await made(outbox: place)
        await book.readReady()
        door.unreached = true
        let conversation = try book.asked("Where was I?")
        try await until("drawn sending") { conversation.turns.last?.answer.waiting == AskConversation.Answer.held }
        let held = try XCTUnwrap(book.outbox.entries.first, "kept: the home never answered")
        XCTAssertEqual(held.words, "Where was I?")
        XCTAssertTrue(FileManager.default.fileExists(atPath: place.appendingPathComponent(held.submission + "/question.json").path),
                      "on disk before it was drawn")

        let (again, home) = try await made(outbox: place)
        XCTAssertEqual(again.outbox.entries.map(\.submission), [held.submission], "read back from disk")
        await again.read()
        try await until("posted again and answered") { home.submissions.count == 1 && again.outbox.entries.isEmpty }
        XCTAssertEqual(home.submissions.first?.submission, held.submission, "under the same submission: never a second question")
        XCTAssertEqual(home.questions.first?["question"], "Where was I?")
        let resumed = try XCTUnwrap(again.conversations.first)
        XCTAssertEqual(resumed.title, "Where was I?", "drawn as its own conversation")
        XCTAssertFalse(FileManager.default.fileExists(atPath: place.appendingPathComponent(held.submission).path), "its folder gone at chat")
    }

    func testAVoiceNoteGoesAsItIsRecordedAndItsQuestionNamesItsSecondsThenItsWordsReachItsBubble() async throws {
        let (book, door) = try await made()
        await book.readReady()
        book.record(for: "page")
        XCTAssertEqual(book.recorder.phase, .recording)
        let note = try XCTUnwrap(book.recorder.note)
        try await until("opened at the tap, so the speech model warms") { door.notes[note]?.opened == true }
        microphone.speak(seconds: 1.5)
        try await until("the whole second posted as it filled") { door.notes[note]?.seconds[0]?.count == ChatRecorder.second }
        try await until("every sample heard") { book.recorder.samples == 24_000 }
        XCTAssertNil(door.notes[note]?.seconds[1], "the half second waits for Send")
        XCTAssertEqual(book.recorder.levels.count, 15, "a level each tenth of a second")
        XCTAssertEqual(ChatRecorder.time(ms: book.recorder.ms), "0:01")

        let taken = try await book.recorder.taken()
        XCTAssertEqual(taken.seconds, 2)
        XCTAssertEqual(taken.ms, 1_500)
        XCTAssertFalse(microphone.on, "the microphone let go at Send")
        XCTAssertEqual(try XCTUnwrap(book.outbox.sound(note)).count, 44 + 48_000, "the whole note, 1.5 s at 16 kHz, in its WAV")
        let conversation = try book.asked(voice: taken)
        XCTAssertEqual(conversation.turns.last?.note?.sound, .own(note), "drawn at once from the device's own copy")
        XCTAssertEqual(conversation.turns.last?.note?.writing, true, "Writing it out… until its words")
        try await until("the turn is answered") { conversation.turns.last?.answer.end == .done }
        XCTAssertEqual(door.notes[note]?.seconds[1]?.count, 16_000, "the last part posted before the question")
        XCTAssertEqual(door.voices.last as? [String: AnyHashable], ["note": note, "seconds": 2], "named by its id and seconds")
        XCTAssertNil(door.questions.last?["question"], "a note sends no words")
        XCTAssertEqual(conversation.turns.last?.note?.words, AskDoor.noteWords, "its words, from the words event")
        XCTAssertEqual(conversation.turns.last?.note?.writing, false)
        XCTAssertTrue(book.outbox.entries.isEmpty, "gone at chat")
        XCTAssertNil(book.outbox.notes[note], "its seconds with it")
        XCTAssertNil(book.outbox.sound(note), "and its sound: the home plays it")
    }

    func testANoteNotSentPlaysItsOwnSoundAndASentOnePlaysTheHomesByItsAudio() async throws {
        let (book, door) = try await made()
        await book.readReady()
        door.unreached = true
        book.record(for: "page")
        let note = try XCTUnwrap(book.recorder.note)
        microphone.speak(seconds: 1)
        try await until("every sample heard") { book.recorder.samples == 16_000 }
        let conversation = try book.asked(voice: try await book.recorder.taken())
        try await until("held") { book.outbox.waiting.count == 1 }
        let held = try XCTUnwrap(conversation.turns.last)
        conversation.play(held)
        try await until("its own sound read") { plays.sounds == [.own(note)] }

        door.unreached = false
        await book.readReady()
        try await until("answered") { conversation.turns.last?.answer.end == .done && book.outbox.entries.isEmpty }
        let sent = try XCTUnwrap(conversation.turns.last)
        let audio = AskDoor.audio(of: note)
        XCTAssertEqual(sent.note?.sound, .held(audio), "named by the chat event's audio")
        let reads = door.chatReads
        conversation.play(sent)
        try await until("the home's audio read by its name") { plays.sounds == [.own(note), .held(audio)] }
        XCTAssertEqual(door.chatReads, reads, "the conversation read to learn the note's name")
    }

    func testASecondTheClaimFoundMissingIsSentAgainUnderTheSameSubmission() async throws {
        let (book, door) = try await made()
        await book.readReady()
        book.record(for: "page")
        let note = try XCTUnwrap(book.recorder.note)
        microphone.speak(seconds: 2)
        try await until("both seconds posted") { door.notes[note]?.seconds.count == 2 }
        door.forget(note: note, second: 1)
        let conversation = try book.asked(voice: try await book.recorder.taken())
        try await until("the turn is answered") { conversation.turns.last?.answer.end == .done }
        XCTAssertEqual(door.notes[note]?.puts[1], 2, "posted again once the claim said it was missing")
        XCTAssertEqual(Set(door.submissions.map(\.submission)).count, 1, "the same submission")
        XCTAssertEqual(door.submissions.count, 2)
    }

    func testACancelledNoteIsLetGoAtTheHomeAndAsksNothing() async throws {
        let (book, door) = try await made()
        await book.readReady()
        book.record(for: "page")
        let note = try XCTUnwrap(book.recorder.note)
        microphone.speak(seconds: 1.2)
        try await until("every sample heard") { book.recorder.samples == 19_200 }
        try await until("a second posted") { door.notes[note]?.seconds[0] != nil }
        book.recorder.cancel()
        XCTAssertEqual(book.recorder.phase, .idle)
        XCTAssertFalse(microphone.on)
        try await until("let go at the home") { door.notes[note]?.cancelled == true }
        XCTAssertNil(book.outbox.notes[note])
        XCTAssertFalse(FileManager.default.fileExists(atPath: book.outbox.folder.appendingPathComponent("notes/\(note)").path),
                       "its seconds gone from the phone")
        XCTAssertTrue(door.submissions.isEmpty, "nothing asked")
    }

    func testAVoiceQuestionThatReachedNoHomeSurvivesARelaunchWithItsSeconds() async throws {
        let place = folder.appendingPathComponent("outbox")
        let (book, door) = try await made(outbox: place)
        await book.readReady()
        book.record(for: "page")
        let note = try XCTUnwrap(book.recorder.note)
        try await until("opened") { door.notes[note]?.opened == true }
        door.unreached = true
        microphone.speak(seconds: 1.4)
        try await until("every sample heard") { book.recorder.samples == 22_400 }
        let conversation = try book.asked(voice: try await book.recorder.taken())
        try await until("drawn sending") { conversation.turns.last?.answer.waiting == AskConversation.Answer.held }
        let held = try XCTUnwrap(book.outbox.entries.first, "kept: the home never answered")
        XCTAssertEqual(held.voice, .note(note, seconds: 2))
        XCTAssertNil(door.notes[note]?.seconds[0], "no second reached it")

        let (again, home) = try await made(outbox: place)
        XCTAssertEqual(again.outbox.notes[note]?.seconds, 2, "its seconds read back from disk")
        await again.read()
        try await until("posted again and answered") {
            again.outbox.entries.isEmpty && again.conversations.first.map { again.conversation($0.key).turns.last?.answer.end == .done } == true
        }
        XCTAssertEqual(home.submissions.map(\.submission), [held.submission], "under the same submission")
        XCTAssertEqual(home.notes[note]?.seconds.count, 2, "every second sent before the question")
        let resumed = try XCTUnwrap(again.conversations.first)
        XCTAssertEqual(again.conversation(resumed.key).turns.last?.note?.words, AskDoor.noteWords)
    }

    func testTheAskServerDownBeforeChatKeepsTheQuestionInTheOutbox() async throws {
        let (book, door) = try await made()
        await book.readReady()
        door.down = true
        let conversation = try book.asked("Where was I?")
        try await until("drawn sending, in the door's words") { conversation.turns.last?.answer.waiting == "Chat isn't answering on your Mac" }
        XCTAssertEqual(conversation.turns.last?.answer.end, .running)
        XCTAssertEqual(book.outbox.entries.map(\.words), ["Where was I?"], "kept: the Ask server never had it")
        door.down = false
        book.resend()
        try await until("posted again once it answers") { book.outbox.entries.isEmpty && conversation.turns.last?.answer.end == .done }
    }

    func testTheMicWithNoVoiceModelSaysTheFixAndASlipOrALimitEndsTheNote() async throws {
        let (book, door) = try await made()
        door.voiceReady = false
        await book.readReady()
        book.record(for: "page")
        XCTAssertEqual(book.recorder.phase, .idle, "nothing recorded")
        XCTAssertEqual(book.recorder.said, AskDoor.voiceLine, "the home's line said")
        XCTAssertEqual(microphone.starts, 0)
        door.voiceReady = true
        await book.readReady()
        XCTAssertNil(book.recorder.said, "made: said no more")

        book.record(for: "page")
        let slip = try XCTUnwrap(book.recorder.note)
        microphone.speak(seconds: 0.3)
        try await until("heard") { book.recorder.samples == 4_800 }
        let slipped = await book.recorder.take()
        XCTAssertNil(slipped, "a slip is no note")
        try await until("let go at the home") { door.notes[slip]?.cancelled == true }

        door.voiceMs = 1_000
        await book.readReady()
        book.record(for: "page")
        microphone.speak(seconds: 1.5)
        try await until("it stops itself at its limit") { book.recorder.phase == .stopped }
        XCTAssertEqual(book.recorder.ms, 1_000)
        XCTAssertTrue(book.recorder.holds("page"), "waiting for Send in its composer")
        XCTAssertFalse(book.recorder.holds("new-1"), "another composer's is not")
        let stopped = await book.recorder.take()
        XCTAssertEqual(stopped?.seconds, 1)
    }

    func testTheVoiceRowSendsItsChoiceWithTheValueItReplacesThenReadsReadiness() async throws {
        let (book, door) = try await made()
        await book.readReady()
        XCTAssertEqual(book.voice?.words, "Parakeet · your Mac")
        XCTAssertEqual(book.voiceChoice, AskDoor.parakeet, "the default's route checked by its words")
        let reads = door.readiness.count
        book.chooseVoice(AskDoor.cloud)
        try await until("readiness read after the choice") { door.readiness.count == reads + 1 && book.voice?.caution != nil }
        XCTAssertEqual(door.settings.last, ["connector": "ask", "member": "llm.voice", "value": AskDoor.cloud, "was": "default"])
        XCTAssertEqual(book.voiceChoice, AskDoor.cloud)
        XCTAssertEqual(book.voice?.caution, AskDoor.caution, "the caution while a note leaves as it is")
        book.chooseVoice(AskDoor.cloud)
        XCTAssertEqual(door.settings.count, 1, "the route chosen already sends nothing")
    }

    func testAPhotoTheStageDroppedIsSentAgainUnderTheSameSubmission() async throws {
        let (book, door) = try await made()
        await book.readReady()
        let photo = Data("photo-2".utf8)
        let name = "sha256:" + SHA256.hash(data: photo).map { String(format: "%02x", $0) }.joined()
        let id = try XCTUnwrap(book.outbox.pick(photo, ext: "jpg", holding: [], limits: try XCTUnwrap(book.limits)))
        try await until("staged") { book.outbox.photos[id]?.state == .staged(name) }
        door.drop(name)
        let conversation = try book.asked("Where is this?", photos: [id])
        try await until("the turn is answered") { conversation.turns.last?.answer.end == .done }
        XCTAssertEqual(door.staged[name], 2, "posted again once the claim said it was missing")
        XCTAssertEqual(door.submissions.map(\.submission).count, 2)
        XCTAssertEqual(Set(door.submissions.map(\.submission)).count, 1, "the same submission")
    }

    func testARefusalBeforeChatKeepsTheNoteAndPhotosAndTryAgainPostsTheSameBody() async throws {
        let (book, door) = try await made()
        await book.readReady()
        let photo = Data("photo-3".utf8)
        let id = try XCTUnwrap(book.outbox.pick(photo, ext: "jpg", holding: [], limits: try XCTUnwrap(book.limits)))
        book.record(for: "page")
        let note = try XCTUnwrap(book.recorder.note)
        microphone.speak(seconds: 1.2)
        try await until("every sample heard") { book.recorder.samples == 19_200 }
        door.failing = "model"
        let taken = try await book.recorder.taken()
        let key = try XCTUnwrap(book.begin(voice: taken, photos: [id]))
        let conversation = book.conversation(key)
        try await until("the turn fails") { conversation.turns.last.map { $0.answer.end != .running } ?? false }
        XCTAssertEqual(conversation.turns.last?.answer.end, .failed("fetch failed"), "the server's words")
        let held = try XCTUnwrap(book.outbox.entries.first, "kept: only chat, a 422 or an erasure ends it")
        XCTAssertEqual(held.failed, "fetch failed")
        XCTAssertNotNil(book.outbox.notes[note], "its seconds kept")
        XCTAssertNotNil(book.outbox.photos[id], "its photo kept")
        XCTAssertEqual(book.outbox.waiting.count, 0, "waiting for Try again, not posted by itself")

        door.failing = nil
        conversation.retry(try XCTUnwrap(conversation.turns.last))
        try await until("Try again answered") { conversation.turns.last?.answer.end == .done }
        XCTAssertEqual(door.submissions.map(\.submission), [held.submission, held.submission], "the same submission")
        XCTAssertEqual(door.submissions.last?.photos.count, 1, "with its photo")
        XCTAssertEqual(door.voices.last as? [String: AnyHashable], ["note": note, "seconds": 2], "and its note")
        XCTAssertEqual(conversation.turns.count, 1)
        XCTAssertTrue(book.outbox.entries.isEmpty)
    }

    func testA422DropsTheQuestionAnErasureForgetsTheConversationAndA404KeepsIt() async throws {
        let (book, door) = try await made()
        await book.readReady()
        door.refusing = 422
        let refused = try book.asked("Where was I?")
        try await until("the turn fails") { refused.turns.last.map { $0.answer.end != .running } ?? false }
        XCTAssertEqual(refused.turns.last?.answer.end, .failed("The home refused it with 422."), "in the door's words")
        XCTAssertTrue(book.outbox.entries.isEmpty, "a question's shape refused: never posted again")
        door.refusing = 0

        let kept = try book.asked("And then?")
        try await until("answered") { kept.turns.last?.answer.end == .done }
        let chat = try XCTUnwrap(kept.chat)
        book.record(for: "page")
        let note = try XCTUnwrap(book.recorder.note)
        microphone.speak(seconds: 1)
        try await until("every sample heard") { book.recorder.samples == 16_000 }
        door.erasing = true
        let taken = try await book.recorder.taken()
        XCTAssertTrue(kept.ask(voice: taken))
        try await until("erased") { kept.turns.isEmpty }
        XCTAssertEqual(kept.read, .failed(.missing))
        XCTAssertTrue(book.outbox.entries.isEmpty, "its questions gone")
        XCTAssertNil(book.outbox.notes[note], "its seconds gone")
        XCTAssertNil(book.outbox.sound(note), "and its sound")
        XCTAssertFalse(book.conversations.contains { $0.key == chat }, "the conversation gone from the device")

        door.erasing = false
        let other = try book.asked("Somewhere else?")
        try await until("answered") { other.turns.last?.answer.end == .done }
        door.refusing = 410
        XCTAssertTrue(other.ask("Still there?"))
        try await until("a conversation the server says is erased is erased here") { other.turns.isEmpty }
        XCTAssertTrue(book.outbox.entries.isEmpty)

        door.refusing = 0
        let unknown = try book.asked("Where now?")
        try await until("answered") { unknown.turns.last?.answer.end == .done }
        door.refusing = 404
        XCTAssertTrue(unknown.ask("And here?"))
        try await until("the turn fails") { unknown.turns.last.map { $0.answer.end != .running } ?? false }
        XCTAssertEqual(unknown.turns.last?.answer.end, .failed("The home refused it with 404."))
        XCTAssertEqual(unknown.turns.count, 2, "a conversation the server does not know is no erasure")
        let held = try XCTUnwrap(book.outbox.entries.first, "kept for Try again")
        XCTAssertEqual(held.again, .same)
        door.refusing = 0
        unknown.retry(try XCTUnwrap(unknown.turns.last))
        try await until("Try again answered") { unknown.turns.last?.answer.end == .done && book.outbox.entries.isEmpty }
        XCTAssertEqual(door.submissions.suffix(2).map(\.submission), [held.submission, held.submission], "the same submission")
    }

    func testAQuestionHeldForOneHomeIsNeverPostedToAnotherAndUnpairForgetsIt() async throws {
        let place = folder.appendingPathComponent("outbox")
        let (book, door) = try await made(outbox: place)
        await book.readReady()
        let id = try XCTUnwrap(book.outbox.pick(Data("photo-4".utf8), ext: "jpg", holding: [], limits: try XCTUnwrap(book.limits)))
        try await until("staged") { book.outbox.name(id) != nil }
        door.unreached = true
        _ = try book.asked("A private question", photos: [id])
        try await until("kept") { book.outbox.entries.count == 1 && book.outbox.waiting.count == 1 }

        let (other, home) = try await made(outbox: place, at: "http://100.64.0.43:4680")
        await other.readReady()
        await other.read()
        try await until("the last home's question let go") { other.outbox.entries.isEmpty && other.outbox.photos.isEmpty }
        XCTAssertTrue(home.submissions.isEmpty, "never posted to another home")
        XCTAssertTrue(home.staged.isEmpty, "nor its photo")

        let (again, away) = try await made()
        away.unreached = true
        _ = try again.asked("Another")
        try await until("kept") { again.outbox.entries.count == 1 }
        again.forget()
        XCTAssertTrue(again.outbox.entries.isEmpty, "Unpair forgets what was held for the home")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: again.outbox.folder.path).filter { $0 != "outbox.json" }, [])
    }

    func testAQuestionThatCannotBeWrittenIsNotDrawnAndIsSaid() async throws {
        let (book, door) = try await made()
        await book.readReady()
        let place = book.outbox.folder
        try FileManager.default.createDirectory(at: place, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: place.path)
        XCTAssertNil(book.begin("Where was I?"), "nothing begun")
        XCTAssertEqual(book.unkept, AskOutbox.unkept, "said over the composer")
        XCTAssertTrue(book.outbox.entries.isEmpty)
        XCTAssertTrue(book.conversations.isEmpty, "nothing drawn as sending")
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: place.path)
        let asked = try book.asked("Where was I?")
        XCTAssertNil(book.unkept, "said no more once one is kept")
        try await until("answered") { asked.turns.last?.answer.end == .done }
        XCTAssertEqual(door.questions.count, 1)
    }

    func testASecondThatCannotBeWrittenIsNotCountedAndItsSamplesAreKept() async throws {
        let (book, door) = try await made()
        await book.readReady()
        book.record(for: "page")
        let note = try XCTUnwrap(book.recorder.note)
        microphone.speak(seconds: 1)
        try await until("the first second posted") { door.notes[note]?.seconds[0] != nil }
        let seconds = book.outbox.folder.appendingPathComponent("notes/\(note)")
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: seconds.path)
        microphone.speak(seconds: 1)
        try await until("every sample heard") { book.recorder.samples == 32_000 }
        XCTAssertEqual(book.recorder.said, ChatRecorder.unkept, "the person told")
        XCTAssertEqual(book.outbox.notes[note]?.seconds, 1, "the second not written is not counted")
        let refused = await book.recorder.take()
        XCTAssertNil(refused, "a note a part of which is not on disk is not handed over")
        XCTAssertEqual(book.recorder.phase, .stopped, "it waits in its composer")
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: seconds.path)
        let taken = try await book.recorder.taken()
        XCTAssertEqual(taken.seconds, 2)
        XCTAssertEqual(taken.ms, 2_000)
        let conversation = try book.asked(voice: taken)
        XCTAssertEqual(book.recorder.phase, .idle, "free once its question is on disk")
        try await until("answered") { conversation.turns.last?.answer.end == .done }
        XCTAssertEqual(door.notes[note]?.seconds[1]?.count, ChatRecorder.second, "the kept samples reached the home")
    }

    func testSendTakesAQuestionWhileTheHomeIsAway() async throws {
        let lacking = Lacking()
        let (book, door) = try await made(lacks: { lacking.now })
        await book.readReady()
        door.unreached = true
        XCTAssertTrue(book.askable, "the reach lacking: Send still takes it")
        let conversation = try book.asked("Where was I?")
        let held = try XCTUnwrap(book.outbox.entries.first)
        XCTAssertTrue(FileManager.default.fileExists(atPath: book.outbox.folder.appendingPathComponent(held.submission + "/question.json").path))
        try await until("drawn sending") { conversation.turns.last?.answer.waiting == AskConversation.Answer.held }
        door.unreached = false
        lacking.now = false
        await book.readReady()
        try await until("sent when the home answers") { conversation.turns.last?.answer.end == .done && book.outbox.entries.isEmpty }
    }

    func testANoteCancelledWhileTheHomeIsAwayIsLetGoThereWhenItAnswers() async throws {
        let (book, door) = try await made()
        await book.readReady()
        book.record(for: "page")
        let note = try XCTUnwrap(book.recorder.note)
        microphone.speak(seconds: 1.2)
        try await until("a second staged at the home") { door.notes[note]?.seconds[0] != nil }
        door.unreached = true
        book.recorder.cancel()
        XCTAssertNil(book.outbox.sound(note), "its sound gone at once")
        XCTAssertNil(book.outbox.notes[note], "its seconds gone from the phone")
        XCTAssertEqual(book.outbox.cancels, [note], "to cancel")
        let (relaunched, home) = try await made(outbox: book.outbox.folder)
        XCTAssertEqual(relaunched.outbox.cancels, [note], "to cancel, on disk")
        await relaunched.read()
        try await until("let go at the home once it answers") { home.notes[note]?.cancelled == true && relaunched.outbox.cancels.isEmpty }
        XCTAssertTrue(home.submissions.isEmpty, "nothing asked")
    }

    func testTheTimeGrantedAPostEndsAtChatNotAtTheAnswer() async throws {
        let held = Held()
        let (book, door) = try await made(background: { held.begin() })
        await book.readReady()
        door.holdsAnswer = true
        let conversation = try book.asked("Where was I?")
        try await until("the answer waits after chat") { door.answerHeld && book.outbox.entries.isEmpty }
        XCTAssertEqual(held.begun, 1)
        XCTAssertEqual(held.ended, 1, "ended at chat: the question is on the server's disk")
        XCTAssertEqual(conversation.turns.last?.answer.end, .running, "while the answer runs on")
        door.releaseAnswer()
        try await until("answered") { conversation.turns.last?.answer.end == .done }
        XCTAssertEqual(held.ended, 1, "ended once")
    }

    func testAPhotoNotFinishedBeforeTheAppLeftGoesAtTheNextStart() async throws {
        let stage = Stage()
        let place = folder.appendingPathComponent("roads")
        let notes = AskOutbox.NoteRoutes(open: { _ in }, second: { _, _, _ in }, cancel: { _ in })
        let outbox = AskOutbox(folder: place, stage: { try await stage.post($0) }, notes: notes, here: { "home-a" })
        let id = try XCTUnwrap(outbox.pick(Data("photo-5".utf8), ext: "jpg", holding: [],
                                           limits: .init(photos: 10, photoBytes: 1_000_000, voiceMs: 600_000)))
        try await until("on its way") { stage.asked }
        outbox.retry()
        XCTAssertEqual(stage.posts, 1, "on its way: never posted twice")
        stage.answer(false)
        XCTAssertEqual(outbox.photos[id]?.state, .uploading, "not finished: still to send")

        let again = AskOutbox(folder: place, stage: { try await stage.post($0) }, notes: notes, here: { "home-a" })
        _ = try again.keep(words: "Where is this?", photos: [id], key: "new-1", chat: nil, pick: nil)
        again.start()
        try await until("posted again at the next start") { stage.posts == 2 && stage.asked }
        stage.answer(true)
        try await until("staged") { again.name(id) == "sha256:roads" }
    }

    func testSendAsksForWords() async throws {
        let (book, door) = try await made()
        await book.readReady()
        let id = try XCTUnwrap(book.outbox.pick(Data("photo-6".utf8), ext: "jpg", holding: [], limits: try XCTUnwrap(book.limits)))
        XCTAssertFalse(Composer.sends(" "), "no words: no Send, photos or not")
        XCTAssertTrue(Composer.sends(" Where? "))
        XCTAssertNil(book.begin("", photos: [id]), "a photo alone is no question")
        XCTAssertNotNil(book.outbox.photos[id], "the photo stays picked")
        XCTAssertTrue(book.outbox.entries.isEmpty)
        XCTAssertTrue(door.submissions.isEmpty)
    }

    func testHeldQuestionsOfAConversationGoInOrderAndTryAgainReachesAnOlderOne() async throws {
        let place = folder.appendingPathComponent("outbox")
        let (book, door) = try await made(outbox: place)
        await book.readReady()
        let first = try book.asked("First?")
        try await until("answered") { first.turns.last?.answer.end == .done }
        let chat = try XCTUnwrap(first.chat)
        door.unreached = true
        XCTAssertTrue(first.ask("Second?"))
        try await until("held") { book.outbox.waiting.count == 1 }
        let held = try XCTUnwrap(book.outbox.entries.first)
        _ = try book.outbox.keep(words: "Third?", photos: [], key: chat, chat: chat, pick: nil)

        let (again, home) = try await made(outbox: place)
        await again.readReady()
        try await until("both posted, in order, the last answered") {
            home.questions.count == 2 && again.outbox.entries.isEmpty && again.conversation(chat).turns.last?.answer.end == .done
        }
        XCTAssertEqual(home.questions.map { $0["question"] }, ["Second?", "Third?"])
        XCTAssertEqual(home.submissions.first?.submission, held.submission)
        XCTAssertEqual(again.conversation(chat).turns.map(\.question), ["Second?", "Third?"])

        let resumed = again.conversation(chat)
        home.failing = "model"
        XCTAssertTrue(resumed.ask("Fourth?"))
        try await until("refused") { resumed.turns.last.map { $0.answer.end != .running } ?? false }
        home.failing = nil
        XCTAssertTrue(resumed.ask("Fifth?"))
        try await until("answered") { resumed.turns.last?.question == "Fifth?" && resumed.turns.last?.answer.end == .done }
        resumed.retry(try XCTUnwrap(resumed.turns.first { $0.question == "Fourth?" }))
        try await until("the older one posted again, at the end") { resumed.turns.last?.question == "Fourth?" && resumed.turns.last?.answer.end == .done }
        XCTAssertTrue(again.outbox.entries.isEmpty)
    }

    func testWhatAQuestionMayCarryIsReadinessAndAnAudioTheHomeLostIsKeptFailedForRemoveAlone() async throws {
        let (book, door) = try await made()
        XCTAssertNil(book.limits, "no limits of the phone's own before readiness says them")
        book.record(for: "page")
        XCTAssertEqual(book.recorder.phase, .idle, "nothing recorded before readiness")
        await book.readReady()
        XCTAssertEqual(book.limits?.voiceMs, 600_000)

        let conversation = try book.asked("Where was I?")
        try await until("answered") { conversation.turns.last?.answer.end == .done }
        let audio = "sha256:" + String(repeating: "ab", count: 32)
        door.lostAudio = [audio]
        var failed = AskConversation.Answer()
        failed.end = .failed("Couldn't write out your voice note.")
        let turn = AskConversation.Turn(id: 99, question: "", at: Date(), answer: failed,
                                        note: .init(sound: .held(audio), ms: 1_500, levels: [], words: nil, writing: false))
        let posted = door.submissions.count
        conversation.retry(turn)
        try await until("said") { conversation.turns.last?.answer.end == .failed(AskDoor.lostWords) }
        XCTAssertEqual(door.submissions.count, posted + 1, "asked once, never again for nothing")
        let held = try XCTUnwrap(book.outbox.entries.first, "a missing audio keeps the question: no 422 the server never sent")
        XCTAssertEqual(held.failed, AskDoor.lostWords, "in the server's words")
        XCTAssertEqual(held.again, HomeLink.Ask.Outcome.Again.none)
        XCTAssertEqual(book.outbox.waiting.count, 0, "the person's to let go")
        let lost = try XCTUnwrap(conversation.turns.last)
        XCTAssertEqual(conversation.mend(lost), .remove, "no Try again: Remove alone")
        conversation.retry(lost)
        XCTAssertEqual(door.submissions.count, posted + 1, "Try again sends nothing")
        XCTAssertEqual(book.outbox.entries.count, 1)
        conversation.withdraw(lost)
        XCTAssertTrue(book.outbox.entries.isEmpty)
        XCTAssertFalse(conversation.turns.contains { $0.id == lost.id })
    }

    func testAPhotoTheDoorCannotReadKeepsItsVoiceQuestionAndTryAgainGoesOnceItIsTakenOut() async throws {
        let (book, door) = try await made()
        await book.readReady()
        let bad = try XCTUnwrap(book.outbox.pick(Data("BAD-photo-2".utf8), ext: "jpg", holding: [], limits: try XCTUnwrap(book.limits)))
        book.record(for: "page")
        let note = try XCTUnwrap(book.recorder.note)
        microphone.speak(seconds: 1)
        try await until("every sample heard") { book.recorder.samples == 16_000 }
        let taken = try await book.recorder.taken()
        let conversation = book.conversation(try XCTUnwrap(book.begin(voice: taken, photos: [bad])))
        try await until("the turn fails") { conversation.turns.last.map { $0.answer.end != .running } ?? false }
        XCTAssertEqual(conversation.turns.last?.answer.end, .failed("Lifestream can't read this picture."), "in the door's words")
        let held = try XCTUnwrap(book.outbox.entries.first, "one photo's refusal keeps its question")
        XCTAssertEqual(held.again, .photoRemoved)
        XCTAssertNotNil(book.outbox.notes[note], "its voice note kept")
        XCTAssertTrue(door.submissions.isEmpty, "never posted with the photo")
        let failed = try XCTUnwrap(conversation.turns.last)
        XCTAssertEqual(conversation.mend(failed), .photo, "Remove photo first")
        conversation.retry(failed)
        XCTAssertTrue(door.submissions.isEmpty, "Try again waits for the photo to be taken out")

        conversation.unrefuse(failed)
        XCTAssertNil(book.outbox.photos[bad], "the photo gone")
        XCTAssertEqual(conversation.turns.last?.photos, [], "from its turn too")
        let mended = try XCTUnwrap(conversation.turns.last)
        XCTAssertEqual(conversation.mend(mended), .again)
        conversation.retry(mended)
        try await until("answered") { conversation.turns.last?.answer.end == .done && book.outbox.entries.isEmpty }
        XCTAssertEqual(door.submissions.map(\.submission), [held.submission], "the same submission")
        XCTAssertEqual(door.submissions.last?.photos, [], "without the photo")
        XCTAssertEqual(door.voices.last as? [String: AnyHashable], ["note": note, "seconds": 1], "with its note")
    }

    func testAPhotoTheStageRefusedForNowKeepsItsQuestionAndTryAgainPostsItAgain() async throws {
        let (book, door) = try await made()
        await book.readReady()
        door.stageFull = true
        let id = try XCTUnwrap(book.outbox.pick(Data("photo-full".utf8), ext: "jpg", holding: [], limits: try XCTUnwrap(book.limits)))
        let conversation = try book.asked("Where was this?", photos: [id])
        try await until("the turn fails") { conversation.turns.last.map { $0.answer.end != .running } ?? false }
        XCTAssertEqual(conversation.turns.last?.answer.end, .failed(AskDoor.fullWords), "in the door's words")
        XCTAssertEqual(book.outbox.photos[id]?.state, .refused(507, AskDoor.fullWords))
        let held = try XCTUnwrap(book.outbox.entries.first, "a refusal for now is no 422: the question is kept")
        XCTAssertEqual(book.outbox.waiting.count, 0, "for Try again")

        door.stageFull = false
        conversation.retry(try XCTUnwrap(conversation.turns.last))
        try await until("answered") { conversation.turns.last?.answer.end == .done }
        XCTAssertEqual(door.submissions.map(\.submission), [held.submission], "posted once its photo was staged")
        XCTAssertTrue(book.outbox.entries.isEmpty)
    }

    func testTheServersWordsForAQuestionItCouldNotBeginAreSaid() async throws {
        let (book, door) = try await made()
        await book.readReady()
        door.failing = "door"
        door.failingSays = "Chat has no place on your home yet: update Lifestream on your Mac."
        let said = try book.asked("Where was I?")
        try await until("the turn fails") { said.turns.last.map { $0.answer.end != .running } ?? false }
        XCTAssertEqual(said.turns.last?.answer.end, .failed("Chat has no place on your home yet: update Lifestream on your Mac."))
        XCTAssertEqual(book.outbox.entries.first?.failed, "Chat has no place on your home yet: update Lifestream on your Mac.", "kept so")

        door.failingSays = nil
        let unsaid = try book.asked("And then?")
        try await until("the turn fails") { unsaid.turns.last.map { $0.answer.end != .running } ?? false }
        XCTAssertEqual(unsaid.turns.last?.answer.end, .failed(ReachWords.notSent), "the phone's words only where the server said none")
    }

    func testOnlyARead410PurgesWhatTheDeviceHoldsAndUnpairPurgesEverything() async throws {
        let (book, door) = try await made()
        await book.readReady()
        let limits = try XCTUnwrap(book.limits)
        let kept = try book.asked("Where was I?")
        try await until("answered") { kept.turns.last?.answer.end == .done }
        let chat = try XCTUnwrap(kept.chat)
        func photo(_ color: UIColor) -> Data {
            UIGraphicsImageRenderer(size: CGSize(width: 4, height: 3)).jpegData(withCompressionQuality: 0.9) { context in
                color.setFill()
                context.fill(CGRect(x: 0, y: 0, width: 4, height: 3))
            }
        }
        let id = try XCTUnwrap(book.outbox.pick(photo(.blue), ext: "jpg", holding: [], limits: limits))
        try await until("staged") { book.outbox.name(id) != nil }
        door.unreached = true
        XCTAssertTrue(kept.ask("And this?", photos: [id]))
        try await until("held") { book.outbox.waiting.count == 1 }
        let picked = try XCTUnwrap(book.outbox.pick(photo(.green), ext: "jpg", holding: [], limits: limits))
        kept.picked = [picked]
        door.unreached = false

        for status in [404, 503] {
            door.reading = status
            await kept.open()
            XCTAssertEqual(kept.turns.count, 2, "a \(status) is no erasure")
            XCTAssertEqual(book.outbox.entries.count, 1, "its held question kept on a \(status)")
            XCTAssertNotNil(book.outbox.thumbnails[id], "its held question's photo kept on a \(status)")
            XCTAssertNotNil(book.outbox.thumbnails[picked], "its composer's photo kept on a \(status)")
        }
        guard case .failed(let unreadable) = kept.read else { return XCTFail("a read the server could not answer now is said") }
        XCTAssertTrue(unreadable.later, "and read again by itself")

        door.reading = 410
        await kept.open()
        XCTAssertTrue(kept.turns.isEmpty, "a 410 is its erasure")
        XCTAssertTrue(book.outbox.entries.isEmpty, "its held question gone")
        XCTAssertNil(book.outbox.photos[id], "its photo with it")
        XCTAssertNil(book.outbox.thumbnails[id])
        XCTAssertNil(book.outbox.photos[picked], "and its composer's")
        XCTAssertFalse(book.conversations.contains { $0.key == chat })
        door.reading = 0

        let other = try book.asked("Somewhere else?")
        try await until("answered") { other.turns.last?.answer.end == .done }
        let left = try XCTUnwrap(book.outbox.pick(photo(.red), ext: "jpg", holding: [], limits: limits))
        XCTAssertNotNil(book.outbox.thumbnails[left])
        book.forget()
        XCTAssertTrue(book.outbox.photos.isEmpty && book.outbox.thumbnails.isEmpty, "Unpair purges every composer's photo")
    }

    func testAFailedPlayDescribesItsNoteAndTheNewerAnswerIsDrawnOverTheKeptCitation() async throws {
        let (book, door) = try await made()
        let record = "record.note-1"
        let kept = HomeLink.Citation.Voice(audio: "sha256:" + String(repeating: "aa", count: 32), record: record, seconds: 23, from: "Person A")
        let newer = HomeLink.Citation.Voice(audio: "sha256:" + String(repeating: "bb", count: 32), record: record, seconds: 23, from: "Person A")
        let conversation = try await citing(kept, book: book, door: door)
        let look = { AskVoice.look(book.player.state(of: .held(conversation.voice(kept)?.audio ?? kept.audio)), conversation.replays[record]) }
        XCTAssertEqual(look(), .ready, "the kept citation's bar, before any play")
        XCTAssertEqual(conversation.voice(kept), kept)

        door.described[record] = ["ref": record, "kind": "gone", "why": "this record is no longer held"]
        conversation.play(kept)
        try await until("the play failed: the note's own record is described") { conversation.replays[record] == .erased }
        XCTAssertEqual(door.describes, [record])
        XCTAssertEqual(look(), .erased, "only the note's own record gone says it was erased")
        XCTAssertEqual(conversation.voice(kept), kept, "its bar stays, as the erased line")

        door.described[record] = Self.held(newer, kind: "message")
        conversation.play(kept)
        try await until("still held: it didn't play") { conversation.replays[record] == .unplayed(newer) }
        XCTAssertEqual(conversation.voice(kept), newer, "the newer describe is drawn over the kept citation")
        XCTAssertEqual(look(), .unplayed)
        conversation.play(newer)
        try await until("Try again played the newer describe's audio, and failing, described it again") { door.describes.count == 3 }
        XCTAssertEqual(plays.sounds.last, .held(newer.audio))

        door.unreached = true
        conversation.play(newer)
        try await until("the describe did not answer") { if case .unreached? = conversation.replays[record] { true } else { false } }
        guard case .unreached(let words)? = conversation.replays[record] else { return XCTFail("unreached") }
        XCTAssertFalse(words.isEmpty)
        XCTAssertEqual(look(), .unreached(words), "the reach words, with Try again")
        XCTAssertEqual(conversation.voice(kept), kept, "the kept bar stays under them")

        door.unreached = false
        door.described[record] = ["ref": record, "kind": "message", "day": "2026-11-04", "title": "Person A"]
        conversation.play(kept)
        try await until("the home no longer holds the audio") { conversation.replays[record] == .plain }
        XCTAssertNil(conversation.voice(kept), "the bar goes, the citation stays")
    }

    func testAFailedPlayFromAnySurfaceDescribesTheNoteItsAnswerCites() async throws {
        let (book, door) = try await made()
        let record = "record.note-1"
        let kept = HomeLink.Citation.Voice(audio: "sha256:" + String(repeating: "aa", count: 32), record: record, seconds: 23, from: "Person A")
        let conversation = try await citing(kept, book: book, door: door)
        door.described[record] = ["ref": record, "kind": "gone", "why": "this record is no longer held"]

        await book.player.toggle(.held("sha256:" + String(repeating: "cc", count: 32)), of: NSObject())?.value
        await book.player.toggle(.held(kept.audio), of: NSObject())?.value
        try await until("the thread's failed play is described for the answer") { conversation.replays[record] == .erased }
        XCTAssertEqual(door.describes, [record], "a sound no answer cites describes nothing")
        XCTAssertEqual(AskVoice.look(book.player.state(of: .held(kept.audio)), conversation.replays[record]), .erased,
                       "the answer's bar says it was erased, with no tap of its own")
    }

    func testALateDescribeOfAnOlderPlayNeverDrawsOverANewerPlay() async throws {
        let (book, door) = try await made()
        let record = "record.note-1"
        let kept = HomeLink.Citation.Voice(audio: "sha256:" + String(repeating: "aa", count: 32), record: record, seconds: 23, from: "Person A")
        let conversation = try await citing(kept, book: book, door: door)
        door.described[record] = Self.held(kept, kind: "message")
        let sound = NotePlayer.Sound.held(kept.audio)

        door.holdingDescribes = true
        let older = try XCTUnwrap(conversation.heard(NotePlayer.Heard(sound: sound, play: 1, outcome: .failed(.unplayable)), of: kept))
        try await until("its describe waits") { door.describesHeld == 1 }
        XCTAssertNil(conversation.heard(NotePlayer.Heard(sound: sound, play: 2, outcome: .sounded), of: kept), "a newer play sounds")
        door.releaseDescribes()
        await older.value
        XCTAssertNil(conversation.replays[record], "the older play's describe is dropped: no \u{201C}didn't play\u{201D} under a note that plays")

        await conversation.heard(NotePlayer.Heard(sound: sound, play: 3, outcome: .failed(.unplayable)), of: kept)?.value
        XCTAssertEqual(conversation.replays[record], .unplayed(kept), "the newest play's describe lands")
    }

    func testAFailedPlaysLateDescribeIsDroppedOnceANewerPlayOfItsNoteBegins() async throws {
        let (book, door) = try await made()
        let record = "record.note-1"
        let kept = HomeLink.Citation.Voice(audio: "sha256:" + String(repeating: "aa", count: 32), record: record, seconds: 23, from: "Person A")
        let conversation = try await citing(kept, book: book, door: door)
        door.described[record] = Self.held(kept, kind: "message")
        let sound = NotePlayer.Sound.held(kept.audio)

        door.holdingDescribes = true
        let older = try XCTUnwrap(conversation.heard(NotePlayer.Heard(sound: sound, play: 1, outcome: .failed(.unplayable)), of: kept))
        try await until("its describe waits") { door.describesHeld == 1 }
        XCTAssertNil(conversation.heard(NotePlayer.Heard(sound: sound, play: 2, outcome: .began), of: kept), "a newer play is tapped and loads")
        door.releaseDescribes()
        await older.value
        XCTAssertNil(conversation.replays[record], "the newer play won at its tap: no \u{201C}didn't play\u{201D} while it loads")
        door.holdingDescribes = false

        await conversation.heard(NotePlayer.Heard(sound: sound, play: 2, outcome: .failed(.unplayable)), of: kept)?.value
        XCTAssertEqual(conversation.replays[record], .unplayed(kept), "the newer play failing describes its note")
    }

    func testATapRefusedWhileRecordingAndATapThatCancelsLoadingDescribeNothing() async throws {
        let (book, door) = try await made()
        let kept = HomeLink.Citation.Voice(audio: "sha256:" + String(repeating: "aa", count: 32), record: "record.note-1", seconds: 23)
        let conversation = try await citing(kept, book: book, door: door)
        plays.recording = true
        XCTAssertNil(conversation.play(kept), "refused while a question records")
        XCTAssertEqual(AskVoice.look(book.player.state(of: .held(kept.audio)), conversation.replays[kept.record]), .ready)
        plays.recording = false

        let gate = ReadGate()
        plays.gate = gate
        let first = try XCTUnwrap(conversation.play(kept))
        try await until("the read waits") { gate.waiting }
        XCTAssertEqual(AskVoice.look(book.player.state(of: .held(kept.audio)), nil), .loading)
        XCTAssertNil(conversation.play(kept), "a second tap cancels")
        gate.answer(nil)
        await first.value
        XCTAssertEqual(AskVoice.look(book.player.state(of: .held(kept.audio)), conversation.replays[kept.record]), .ready, "back to Ready")
        XCTAssertTrue(door.describes.isEmpty, "neither is a failure: nothing described")
    }

    func testAPlayThatLandsKeepsTheNewerVoiceAndClearsTheReachWords() async throws {
        let (book, door) = try await made()
        let record = "record.note-1"
        let kept = HomeLink.Citation.Voice(audio: "sha256:" + String(repeating: "aa", count: 32), record: record, seconds: 2, mine: true)
        let newer = HomeLink.Citation.Voice(audio: "sha256:" + String(repeating: "bb", count: 32), record: record, seconds: 2, mine: true)
        let conversation = try await citing(kept, book: book, door: door)
        door.described[record] = Self.held(newer, kind: "record")
        conversation.play(kept)
        try await until("described") { conversation.replays[record] == .unplayed(newer) }

        plays.bytes = try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(forResource: "iphone", withExtension: "m4a", subdirectory: "audio")))
        conversation.play(newer)
        try await until("it played: no longer \u{201C}didn't play\u{201D}, still the newer voice") { conversation.replays[record] == .held(newer) }
        guard case .playing = book.player.state(of: .held(newer.audio)) else { return XCTFail("the newer audio plays") }
        book.player.stop(conversation)
        XCTAssertEqual(AskVoice.look(book.player.state(of: .held(newer.audio)), conversation.replays[record]), .ready, "stopped with its conversation: Ready")
        XCTAssertEqual(conversation.voice(kept), newer)
    }

    private func citing(_ voice: HomeLink.Citation.Voice, book: AskBook, door: AskDoor) async throws -> AskConversation {
        let chat = "1792396900000-voice"
        door.hold(chat, messages: [
            ["chat": chat, "n": 1, "at_ms": 1_792_396_860_000, "role": "user", "text": "What did Person A say?", "photos": [String]()],
            ["chat": chat, "n": 2, "at_ms": 1_792_396_861_000, "role": "assistant", "text": "Person A said it [r1].", "ms": 1_200, "end": "done",
             "refs": ["r1": Self.held(voice, kind: "message")]],
        ])
        let conversation = book.conversation(chat)
        await conversation.open()
        XCTAssertEqual(conversation.cited(voice.audio), voice, "the answer cites the note")
        return conversation
    }

    private static func held(_ voice: HomeLink.Citation.Voice, kind: String) -> [String: Any] {
        var heard: [String: Any] = ["audio": voice.audio, "record": voice.record, "mine": voice.mine]
        if let seconds = voice.seconds { heard["seconds"] = seconds }
        if let from = voice.from { heard["from"] = from }
        return ["ref": voice.record, "kind": kind, "day": "2026-11-04", "title": voice.from ?? "Voice note", "voice": heard]
    }

    func testAConversationsPrivacyIsReadFromTheDoorAndRidesItsNextQuestion() async throws {
        let (book, door) = try await made()
        await book.readReady()
        let conversation = try book.asked("Where was I on Friday?")
        try await until("the first turn is answered") { conversation.turns.last?.answer.end == .done }
        let chat = try XCTUnwrap(conversation.chat)
        try await until("the level kept is read back as the turn began and ended: where it started, the person's setting") {
            conversation.level == .all && door.levelReads(chat) == 2
        }
        XCTAssertEqual(door.questions.last, ["question": "Where was I on Friday?"], "no level the person never picked")

        let asked = door.requests
        conversation.pick(level: .none)
        XCTAssertEqual(conversation.level, HomeLink.Ask.Level.none, "drawn at once")
        XCTAssertEqual(door.requests, asked, "no request of its own")
        XCTAssertTrue(conversation.ask("And who was there?"))
        try await until("the follow-up is answered") { conversation.turns.count == 2 && conversation.turns[1].answer.end == .done }
        XCTAssertEqual(door.questions.last, ["question": "And who was there?", "chat": chat, "level": "none"], "the pick rides the question")
        XCTAssertEqual(door.level(chat), "none")
        try await until("the level kept is read back as the turn began and as it ended") { door.levelReads(chat) == 4 }
        XCTAssertEqual(conversation.level, HomeLink.Ask.Level.none)
        door.keep(chat, "all")
        XCTAssertTrue(conversation.ask("And after?"))
        try await until("the third turn is answered") { conversation.turns.count == 3 && conversation.turns[2].answer.end == .done }
        XCTAssertEqual(door.questions.last, ["question": "And after?", "chat": chat], "sent once: the conversation's level is the door's")
        XCTAssertEqual(door.level(chat), "all")
        try await until("the level kept is read back") { conversation.level == .all }

        let other = try book.asked("And on Saturday?")
        try await until("the other is answered") { other.turns.last?.answer.end == .done }
        XCTAssertEqual(door.questions.last, ["question": "And on Saturday?"])
        XCTAssertEqual(door.level(try XCTUnwrap(other.chat)), "all")
    }

    func testANewConversationsLevelIsPickedBeforeItsFirstQuestionWhichCarriesIt() async throws {
        let (book, door) = try await made()
        await book.readReady()
        door.setting = "names"
        let upcoming = book.upcoming()
        await upcoming.readLevel()
        XCTAssertNil(upcoming.chat)
        XCTAssertEqual(upcoming.level, .names)
        XCTAssertTrue(book.upcoming() === upcoming, "the page's next conversation, until its question leaves")

        upcoming.pick(level: .none)
        XCTAssertEqual(upcoming.level, HomeLink.Ask.Level.none)
        let key = try XCTUnwrap(book.begin("Where was I on Friday?"))
        XCTAssertEqual(key, upcoming.key)
        try await until("the first turn is answered") { upcoming.turns.last?.answer.end == .done }
        XCTAssertEqual(door.questions, [["question": "Where was I on Friday?", "level": "none"]])
        let chat = try XCTUnwrap(upcoming.chat)
        XCTAssertEqual(door.named, [chat])
        XCTAssertEqual(door.level(chat), "none")
        XCTAssertFalse(book.upcoming() === upcoming)
    }

    func testALevelReadBegunBeforeAPickNeverDrawsOverIt() async throws {
        let (book, door) = try await made()
        await book.readReady()
        let conversation = try book.asked("Where was I on Friday?")
        try await until("the first turn is answered and its level read back as it began and ended") {
            conversation.turns.last?.answer.end == .done && conversation.level == .all && conversation.chat.map { door.levelReads($0) == 2 } == true
        }
        door.holdingReads = true
        let reading = Task { await conversation.readLevel() }
        try await until("the read is held at the door") { door.readsHeld == 1 }
        conversation.pick(level: .none)
        door.releaseReads()
        await reading.value
        XCTAssertEqual(conversation.level, HomeLink.Ask.Level.none, "the older read draws nothing over the pick")
    }

    func testTheSettingReadForANewConversationNeverDrawsOverTheLevelItsFirstQuestionStartedItAt() async throws {
        let (book, door) = try await made()
        await book.readReady()
        let upcoming = book.upcoming()
        door.holdingReads = true
        let reading = Task { await upcoming.readLevel() }
        try await until("the setting's read is held at the door") { door.readsHeld == 1 }
        door.setting = "none"
        XCTAssertNotNil(book.begin("Where was I on Friday?"))
        try await until("the first turn is answered, its level reads held") { upcoming.turns.last?.answer.end == .done && door.readsHeld == 3 }
        let chat = try XCTUnwrap(upcoming.chat)
        XCTAssertEqual(door.questions, [["question": "Where was I on Friday?"]])
        XCTAssertEqual(door.level(chat), "none")
        door.releaseLast()
        door.releaseLast()
        try await until("the level kept is drawn") { upcoming.level == HomeLink.Ask.Level.none }
        door.releaseReads()
        await reading.value
        XCTAssertEqual(upcoming.level, HomeLink.Ask.Level.none, "the setting read for the draft draws nothing over the level kept")
    }

    func testAPickSentOnAQuestionThatFailedBeforeItsTurnBeganIsNotSentAgain() async throws {
        let (book, door) = try await made()
        await book.readReady()
        let conversation = try book.asked("Where was I on Friday?")
        try await until("the first turn is answered") { conversation.turns.last?.answer.end == .done }
        let chat = try XCTUnwrap(conversation.chat)
        try await until("its level read back as it began and ended") { conversation.level == .all && door.levelReads(chat) == 2 }
        conversation.pick(level: .none)
        door.signedIn = false
        door.said = "Sign in to Claude again."
        XCTAssertTrue(conversation.ask("And who was there?"))
        try await until("the follow-up has failed") { conversation.turns.count == 2 && conversation.turns[1].answer.end != .running }
        XCTAssertEqual(door.questions.last, ["question": "And who was there?", "chat": chat, "level": "none"], "the pick rides the question")
        XCTAssertEqual(door.level(chat), "all", "a turn that never began keeps nothing")
        try await until("the level is read back after the failure") { conversation.level == .all && door.levelReads(chat) == 3 }
        door.keep(chat, "all")
        door.signedIn = true
        door.said = nil
        XCTAssertTrue(conversation.ask("And who was there?"))
        try await until("the retry is answered") { conversation.turns.count == 3 && conversation.turns[2].answer.end == .done }
        XCTAssertEqual(door.questions.last, ["question": "And who was there?", "chat": chat], "sent once, whatever the answer")
        XCTAssertEqual(door.level(chat), "all")
        try await until("the level kept is read back") { door.levelReads(chat) == 5 }
        XCTAssertEqual(conversation.level, .all)
    }

    func testAPickSpentOnAQuestionWhoseAnswerWasLostIsReadBack() async throws {
        let (book, door) = try await made()
        await book.readReady()
        let conversation = try book.asked("Where was I on Friday?")
        try await until("the first turn is answered") { conversation.turns.last?.answer.end == .done }
        let chat = try XCTUnwrap(conversation.chat)
        try await until("its level read back as it began and ended") { conversation.level == .all && door.levelReads(chat) == 2 }
        conversation.pick(level: .none)
        XCTAssertEqual(conversation.level, HomeLink.Ask.Level.none, "drawn at once")
        door.signedIn = false
        door.losing = true
        XCTAssertTrue(conversation.ask("And who was there?"))
        try await until("the question was posted") { door.questions.count == 2 }
        XCTAssertEqual(door.questions.last, ["question": "And who was there?", "chat": chat, "level": "none"], "the pick rides the question")
        XCTAssertEqual(door.level(chat), "all", "a turn that never began keeps nothing")
        try await until("the level kept is read back after the lost answer") { conversation.level == .all && door.levelReads(chat) >= 3 }
    }


    private func keep(_ pick: HomeLink.Ask.Pick) {
        defaults.set(try? JSONEncoder().encode(pick), forKey: "ask.pick")
    }

    func testTheBlankPageDrawsOnlyAFreshHomesStarters() async throws {
        let (book, door) = try await made()
        await book.readReady()
        XCTAssertEqual(book.starters, [], "the list not read yet: nothing, never the starters first")

        await book.read()
        XCTAssertEqual(book.starters.map(\.question), ["Where have I been today?", "How far did I walk today?", "What did I photograph this week?"],
                       "a home asked nothing: the server's, in its order")
        XCTAssertEqual(book.starters.map(\.kind), ["places", "walking", "photos"])

        door.listed = (1...5).map { (chat: "c\($0)", title: "Conversation \($0)", lastMs: Int64(1_800_000_000_000 + $0 * 1000)) }
        await book.read()
        XCTAssertEqual(book.starters, [], "a home asked before: the heading alone over the composer")

        door.listed = []
        door.starters = []
        await book.readReady()
        await book.read()
        XCTAssertEqual(book.starters, [], "a home holding nothing to ask about: nothing over the composer")
    }

    func testAStarterObeysWhatTheComposerObeys() async throws {
        let (book, door) = try await made()
        door.signedIn = false
        await book.readReady()
        await book.read()
        XCTAssertFalse(book.askable, "no sign-in: the composer waits")
        XCTAssertEqual(book.starters, [], "and no starter is drawn")
        door.signedIn = true
        await book.readReady()
        XCTAssertTrue(book.askable)
        XCTAssertFalse(book.starters.isEmpty, "signed in: the starters")

        let lacking = Lacking()
        let (out, _) = try await made(lacks: { lacking.now })
        await out.readReady()
        await out.read()
        XCTAssertTrue(out.askable, "the home's reach lacking: Send still takes a question, kept until the home answers")
        XCTAssertEqual(out.starters, [], "but no starter is drawn")
        lacking.now = false
        XCTAssertFalse(out.starters.isEmpty, "reached: the starters")
    }

    func testTheListIsReadEveryPage() async throws {
        let (book, door) = try await made()
        door.listed = (1...5).map { (chat: "c\($0)", title: "Conversation \($0)", lastMs: Int64(1_800_000_000_000 + $0 * 1000)) }
        door.page = 2
        await book.read()
        XCTAssertEqual(book.listed?.map(\.chat), ["c5", "c4", "c3", "c2", "c1"], "every page, in the list's order")
        XCTAssertEqual(door.lists, ["/v1/ask/chats", "/v1/ask/chats?after=2", "/v1/ask/chats?after=4"], "each page after the one before")
        XCTAssertEqual(book.conversations.count, 5, "the drawer and its search hold them all")
    }

    private func made(lacks: @escaping @MainActor () -> Bool = { false }, outbox place: URL? = nil,
                      door: AskDoor = AskDoor(), at name: String = "http://100.64.0.42:4680",
                      background: @escaping @MainActor () -> Background = { Background {} }) async throws -> (AskBook, AskDoor) {
        let home = folder.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let network = TestNetwork(NetworkFacts(online: true, onLocalNetwork: false, tunnelUp: true, path: 1, cost: .free))
        let link = HomeLink(device: HomeLink.Device(kind: .phone, version: "1.0.0", model: "iPhone", serial4: nil),
                            credentials: MemoryPass(), folder: home, transport: door,
                            network: network)
        _ = try await link.pair(code: "12345678", name: name, account: "person-a@example.com")
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let life = LifeReader(link: link, clock: { now })
        let notes = AskOutbox.NoteRoutes(open: { try await life.openNote($0) }, second: { try await life.sendSecond(note: $0, $1, file: $2) },
                                         cancel: { try await life.cancelNote($0) })
        let plays = self.plays
        let player = NotePlayer(folder: home.appendingPathComponent("notes"), read: { sound throws(NotePlayer.Unplayed) in
            plays.sounds.append(sound)
            var bytes = plays.bytes
            if let gate = plays.gate { bytes = await gate.read() }
            guard let bytes else { throw .unplayable }
            return bytes
        }, recording: { plays.recording }, activate: {}, giveBack: {}, muted: true)
        let outbox = AskOutbox(folder: place ?? home.appendingPathComponent("outbox"), stage: { try await life.stage(photo: $0) },
                               notes: notes, here: { life.home })
        let microphone = self.microphone
        return (AskBook(defaults: defaults, life: { life }, lacks: lacks, outbox: outbox,
                        recorder: { ChatRecorder(outbox: $0, microphone: microphone, permission: { .granted }, askPermission: { true }, giveBack: {}) },
                        player: player, background: background), door)
    }
}

extension ChatRecorder {
    func taken() async throws -> Note {
        let note = await take()
        return try XCTUnwrap(note, "a note taken")
    }
}

extension AskBook {
    func asked(_ question: String, photos: [String] = []) throws -> AskConversation {
        conversation(try XCTUnwrap(begin(question, photos: photos), "asked"))
    }

    func asked(voice note: ChatRecorder.Note) throws -> AskConversation {
        conversation(try XCTUnwrap(begin(voice: note), "asked"))
    }
}

final class TestMicrophone: ChatMicrophone, @unchecked Sendable {
    private let lock = NSLock()
    private var heard: (@Sendable ([Int16]) -> Void)?
    private(set) var starts = 0

    var on: Bool { lock.withLock { heard != nil } }

    func start(_ heard: @escaping @Sendable ([Int16]) -> Void) throws {
        lock.withLock {
            self.heard = heard
            starts += 1
        }
    }

    func stop() { lock.withLock { heard = nil } }

    func speak(seconds: Double) {
        let tenths = Int((seconds * 10).rounded())
        for n in 0..<tenths {
            let tone = (0..<1_600).map { Int16(8_000 * sin(Double($0 + n * 1_600) * 2 * .pi * 220 / 16_000)) }
            lock.withLock { heard }?(tone)
        }
    }
}

@MainActor
private final class ReadGate {
    private var held: CheckedContinuation<Data?, Never>?
    var waiting: Bool { held != nil }

    func read() async -> Data? {
        await withCheckedContinuation { held = $0 }
    }

    func answer(_ data: Data?) {
        let held = held
        self.held = nil
        held?.resume(returning: data)
    }
}

@MainActor
private final class Lacking {
    var now = true
}

@MainActor
private final class Held {
    var begun = 0
    var ended = 0

    func begin() -> Background {
        begun += 1
        return Background { self.ended += 1 }
    }
}

@MainActor
private final class Plays {
    var sounds: [NotePlayer.Sound] = []
    var gate: ReadGate?
    var bytes: Data?
    var recording = false
}

@MainActor
private final class Stage {
    private(set) var posts = 0
    private var waiting: CheckedContinuation<Bool, Never>?
    var asked: Bool { waiting != nil }

    func post(_ file: URL) async throws -> HomeLink.Ask.Staged {
        posts += 1
        guard await withCheckedContinuation({ waiting = $0 }) else { throw URLError(.networkConnectionLost) }
        return HomeLink.Ask.Staged(file: "sha256:roads")
    }

    func answer(_ answered: Bool) {
        let waiting = waiting
        self.waiting = nil
        waiting?.resume(returning: answered)
    }
}

private final class AskDoor: HomeTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var paired = false
    private var offered: [[String: Any]] = [
        ["id": "gpt-6.1-terra", "name": "GPT-6.1 Terra", "thinking": ["low", "medium", "high", "xhigh", "max"],
         "default": "high", "photos_off": NSNull(), "hides": true],
        ["id": "gpt-6-luna", "name": "GPT-6 Luna", "thinking": ["low", "medium", "high", "xhigh", "max"],
         "default": "high", "photos_off": NSNull(), "hides": true],
        ["id": "gpt-6-sol", "name": "GPT-6 Sol", "thinking": ["low", "medium"],
         "default": "medium", "photos_off": NSNull(), "hides": true],
        ["id": "runner:macbook-pro-0001/qwen-3.5-9b", "name": "Qwen 3.5 9B", "thinking": [String](),
         "default": "", "photos_off": "Qwen 3.5 9B can't see photos.", "hides": false],
    ]
    private var chat: (model: String?, thinking: String?) = ("gpt-6.1-terra", "high")
    private var held: Set<String> = []
    private var waiting: [String: CheckedContinuation<Void, Never>] = [:]
    private var reads: [String] = []
    private var answers: [String] = []
    private var asked: [[String: String]] = []
    private var sent: [(submission: String, photos: [String])] = []
    private var voiced: [[String: Any]] = []
    private var heldNotes: [String: Note] = [:]
    private var set: [[String: String]] = []
    private var voice: (ready: Bool, value: String, ms: Int) = (true, "default", 600_000)
    static let noteWords = "Where did I have dinner with Person A last week?"
    static let voiceLine = "Choose a model for Voice notes"
    static let parakeet = "runner:macbook-pro-0001/parakeet-unified-en-0.6b"
    static let cloud = "openrouter:elevenlabs/scribe-v2"
    static let caution = "Voice notes go to OpenRouter as they are: sound can't be hidden."

    struct Note {
        var opened = false
        var seconds: [Int: Data] = [:]
        var puts: [Int: Int] = [:]
        var cancelled = false
    }
    private var stagedHere: [String: Int] = [:]
    private var dropped: Set<String> = []
    private var state: (signedIn: Bool, said: String?, down: Bool, unreached: Bool, failing: String?) = (true, nil, false, false, nil)
    private var failure: (says: String?, full: Bool) = ("fetch failed", false)
    static let lostWords = "Your Mac no longer has this voice note."
    static let fullWords = "Your Mac holds too many photos not sent yet. Send or remove some."
    private var refusal: (status: Int, erased: Bool, lost: Set<String>, holds: Bool) = (0, false, [], false)
    private var heldAnswer: CheckedContinuation<Void, Never>?
    private var kept: [String: [[String: Any]]] = [:]
    private var chatRead: (status: Int, count: Int) = (0, 0)
    private var chats: [(chat: String, title: String, lastMs: Int64)] = []
    private var describing: [String: [String: Any]] = [:]
    private var describeReads: [String] = []
    private var pageSize: Int?
    private var listReads: [String] = []
    private var kinds: [[String: String]] = [["kind": "places", "question": "Where have I been today?"],
                                             ["kind": "walking", "question": "How far did I walk today?"],
                                             ["kind": "photos", "question": "What did I photograph this week?"]]
    private var levels: [String: String] = [:]
    private var privacy = "all"
    private var made: [String] = []
    private var count = 0
    private var holdingRead = false
    private var holdingDescribe = false
    private var heldDescribes: [CheckedContinuation<Void, Never>] = []
    private var heldReads: [CheckedContinuation<Void, Never>] = []
    private var levelsRead: [String: Int] = [:]
    private var madeFor: [String: String] = [:]
    private var losingAnswers = false
    private var accessTurn: (events: [[String: Any]], kept: [String: Any])?

    var named: [String] { lock.withLock { made } }
    func level(_ chat: String) -> String { lock.withLock { levels[chat] ?? privacy } }
    func keep(_ chat: String, _ level: String) { lock.withLock { levels[chat] = level } }
    func levelReads(_ chat: String) -> Int { lock.withLock { levelsRead[chat] ?? 0 } }
    var losing: Bool {
        get { lock.withLock { losingAnswers } }
        set { lock.withLock { losingAnswers = newValue } }
    }
    var changingAccess: (events: [[String: Any]], kept: [String: Any])? {
        get { lock.withLock { accessTurn } }
        set { lock.withLock { accessTurn = newValue } }
    }
    var setting: String {
        get { lock.withLock { privacy } }
        set { lock.withLock { privacy = newValue } }
    }
    var requests: Int { lock.withLock { count } }
    var holdingReads: Bool {
        get { lock.withLock { holdingRead } }
        set { lock.withLock { holdingRead = newValue } }
    }
    var readsHeld: Int { lock.withLock { heldReads.count } }
    func releaseReads() {
        let waiters = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            holdingRead = false
            defer { heldReads = [] }
            return heldReads
        }
        for waiter in waiters { waiter.resume() }
    }
    func releaseLast() {
        lock.withLock { heldReads.popLast() }?.resume()
    }

    var readiness: [String] { lock.withLock { reads } }
    var answered: [String] { lock.withLock { answers } }
    var questions: [[String: String]] { lock.withLock { asked } }
    var submissions: [(submission: String, photos: [String])] { lock.withLock { sent } }
    var staged: [String: Int] { lock.withLock { stagedHere } }
    func drop(_ name: String) { lock.withLock { _ = dropped.insert(name) } }
    var voices: [Any] { lock.withLock { voiced } }
    var notes: [String: Note] { lock.withLock { heldNotes } }
    func forget(note: String, second k: Int) { lock.withLock { _ = heldNotes[note]?.seconds.removeValue(forKey: k) } }
    var settings: [[String: String]] { lock.withLock { set } }
    var voiceReady: Bool {
        get { lock.withLock { voice.ready } }
        set { lock.withLock { voice.ready = newValue } }
    }
    var voiceMs: Int {
        get { lock.withLock { voice.ms } }
        set { lock.withLock { voice.ms = newValue } }
    }
    var signedIn: Bool {
        get { lock.withLock { state.signedIn } }
        set { lock.withLock { state.signedIn = newValue } }
    }
    var chatDefault: (model: String?, thinking: String?) {
        get { lock.withLock { chat } }
        set { lock.withLock { chat = newValue } }
    }
    var said: String? {
        get { lock.withLock { state.said } }
        set { lock.withLock { state.said = newValue } }
    }
    var down: Bool {
        get { lock.withLock { state.down } }
        set { lock.withLock { state.down = newValue } }
    }
    var failing: String? {
        get { lock.withLock { state.failing } }
        set { lock.withLock { state.failing = newValue } }
    }
    var failingSays: String? {
        get { lock.withLock { failure.says } }
        set { lock.withLock { failure.says = newValue } }
    }
    var stageFull: Bool {
        get { lock.withLock { failure.full } }
        set { lock.withLock { failure.full = newValue } }
    }
    var refusing: Int {
        get { lock.withLock { refusal.status } }
        set { lock.withLock { refusal.status = newValue } }
    }
    var erasing: Bool {
        get { lock.withLock { refusal.erased } }
        set { lock.withLock { refusal.erased = newValue } }
    }
    var lostAudio: Set<String> {
        get { lock.withLock { refusal.lost } }
        set { lock.withLock { refusal.lost = newValue } }
    }
    var holdsAnswer: Bool {
        get { lock.withLock { refusal.holds } }
        set { lock.withLock { refusal.holds = newValue } }
    }
    var answerHeld: Bool { lock.withLock { heldAnswer != nil } }
    var reading: Int {
        get { lock.withLock { chatRead.status } }
        set { lock.withLock { chatRead.status = newValue } }
    }
    var chatReads: Int { lock.withLock { chatRead.count } }
    static func audio(of note: String) -> String {
        "sha256:" + SHA256.hash(data: Data(note.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    func releaseAnswer() {
        let held = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            defer { heldAnswer = nil }
            return heldAnswer
        }
        held?.resume()
    }

    func stream(_ request: HomeRequest) async throws -> HomeStream {
        let response = try await perform(request)
        let lines = response.body.split(separator: 0x0A).map { Data($0) }
        guard holdsAnswer, request.url.path == "/v1/ask", response.status == 200, lines.count > 1 else {
            return HomeStream(status: response.status, headers: response.headers, lines: HomeStream.lines(of: response.body))
        }
        let (stream, line) = AsyncThrowingStream<Data, Error>.makeStream()
        line.yield(lines[0])
        Task {
            await withCheckedContinuation { continuation in lock.withLock { heldAnswer = continuation } }
            for each in lines.dropFirst() { line.yield(each) }
            line.finish()
        }
        return HomeStream(status: response.status, headers: response.headers, lines: stream)
    }

    var unreached: Bool {
        get { lock.withLock { state.unreached } }
        set { lock.withLock { state.unreached = newValue } }
    }

    var described: [String: [String: Any]] {
        get { lock.withLock { describing } }
        set { lock.withLock { describing = newValue } }
    }
    var describes: [String] { lock.withLock { describeReads } }
    func hold(_ chat: String, messages: [[String: Any]]) { lock.withLock { kept[chat] = messages } }
    var holdingDescribes: Bool {
        get { lock.withLock { holdingDescribe } }
        set { lock.withLock { holdingDescribe = newValue } }
    }
    var describesHeld: Int { lock.withLock { heldDescribes.count } }
    func releaseDescribes() {
        let waiters = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            holdingDescribe = false
            defer { heldDescribes = [] }
            return heldDescribes
        }
        for waiter in waiters { waiter.resume() }
    }

    var listed: [(chat: String, title: String, lastMs: Int64)] {
        get { lock.withLock { chats } }
        set { lock.withLock { chats = newValue } }
    }
    var page: Int? {
        get { lock.withLock { pageSize } }
        set { lock.withLock { pageSize = newValue } }
    }
    var lists: [String] { lock.withLock { listReads } }
    var starters: [[String: String]] {
        get { lock.withLock { kinds } }
        set { lock.withLock { kinds = newValue } }
    }

    func hold(_ model: String) { lock.withLock { _ = held.insert(model) } }
    func holding(_ model: String) -> Bool { lock.withLock { waiting[model] != nil } }
    func release(_ model: String) {
        let waiter = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            held.remove(model)
            return waiting.removeValue(forKey: model)
        }
        waiter?.resume()
    }
    func retire(_ model: String) { lock.withLock { offered.removeAll { $0["id"] as? String == model } } }

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
        if unreached { throw URLError(.cannotConnectToHost) }
        lock.withLock { count += 1 }
        if down { return Self.reply(503, ["code": "ASK_DOWN", "message": "Ask is not answering on the home's Mac"]) }
        switch (request.method, request.url.path) {
        case ("GET", "/v1/ask"):
            let query = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let model = query.first { $0.name == "model" }?.value
            lock.withLock { reads.append(request.url.path + (request.url.query.map { "?" + $0 } ?? "")) }
            if let model, lock.withLock({ held.contains(model) }) {
                await withCheckedContinuation { continuation in lock.withLock { waiting[model] = continuation } }
            }
            return Self.reply(200, ready(model, query.first { $0.name == "thinking" }?.value))
        case ("GET", "/v1/describe"):
            let refs = (URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []).filter { $0.name == "ref" }.compactMap(\.value)
            let described = lock.withLock { () -> [[String: Any]] in
                describeReads += refs
                return refs.map { describing[$0] ?? ["ref": $0, "kind": "gone"] }
            }
            if lock.withLock({ holdingDescribe }) {
                await withCheckedContinuation { continuation in lock.withLock { heldDescribes.append(continuation) } }
            }
            return Self.reply(200, ["described": described])
        case ("GET", "/v1/privacy"):
            let setting = self.setting
            if lock.withLock({ holdingRead }) {
                await withCheckedContinuation { continuation in lock.withLock { heldReads.append(continuation) } }
            }
            return Self.reply(200, [
                "epoch": 0, "ready": true, "line": NSNull(), "marking": NSNull(), "level": "all", "chat": setting,
                "detector": ["runner": "off", "file": NSNull(), "state": "off", "line": NSNull(), "bytes": NSNull(), "total": NSNull(), "model": NSNull()],
                "levels": [String: [String]](), "links": "tokens", "always": [String](), "never": [String](), "types": [Any](), "today": [Any](),
            ])
        case ("GET", let path) where path.hasPrefix("/v1/privacy/chat/"):
            let chat = String(path.dropFirst("/v1/privacy/chat/".count))
            let kept = self.level(chat)
            if lock.withLock({ holdingRead }) {
                await withCheckedContinuation { continuation in lock.withLock { heldReads.append(continuation) } }
            }
            lock.withLock { levelsRead[chat, default: 0] += 1 }
            return Self.reply(200, ["chat": chat, "level": kept, "epoch": 0])
        case ("GET", "/v1/ask/chats"):
            let (all, size) = lock.withLock { () -> ([(chat: String, title: String, lastMs: Int64)], Int?) in
                listReads.append(request.url.path + (request.url.query.map { "?" + $0 } ?? ""))
                return (chats, pageSize)
            }
            let rows = all.sorted { $0.lastMs > $1.lastMs }
            let from = (URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "after" }?.value).flatMap { Int($0) } ?? 0
            let to = min(rows.count, from + (size ?? rows.count))
            return Self.reply(200, ["chats": rows[from..<to].map { ["chat": $0.chat, "title": $0.title, "first_ms": $0.lastMs, "last_ms": $0.lastMs, "messages": 2] },
                                    "next": to < rows.count ? String(to) as Any : NSNull()])
        case ("GET", let path) where path.hasPrefix("/v1/ask/chats/") && !path.hasSuffix("/events"):
            let chat = String(path.dropFirst("/v1/ask/chats/".count))
            let (status, messages) = lock.withLock { () -> (Int, [[String: Any]]?) in
                chatRead.count += 1
                return (chatRead.status, kept[chat])
            }
            switch status {
            case 410: return Self.reply(410, ["error": "erased"])
            case 503: return Self.reply(503, ["code": "ASK_UNREADABLE", "message": "Chat can't read this conversation yet."])
            case 0: break
            default: return Self.reply(status, ["error": "No conversation \(chat)."])
            }
            guard let messages else { return Self.reply(404, ["error": "No conversation \(chat)."]) }
            return Self.reply(200, ["chat": chat, "title": "Where was I?", "messages": messages, "running": NSNull()])
        case ("POST", "/v1/ask/files"):
            guard case .file(let file) = request.body, let data = try? Data(contentsOf: file) else { return Self.reply(400, ["error": "Send a file."]) }
            if data.starts(with: Data("BAD".utf8)) {
                return Self.reply(422, ["code": "PICTURE_UNREADABLE", "message": "Lifestream can't read this picture."])
            }
            if stageFull { return Self.reply(507, ["code": "STAGE_FULL", "message": Self.fullWords]) }
            let name = "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            lock.withLock { stagedHere[name, default: 0] += 1 }
            return Self.reply(200, ["file": name, "kind": "photo", "width": 4, "height": 3])
        case ("POST", "/v1/ask"):
            guard case .json(let body) = request.body, let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let submission = object["submission"] as? String else {
                return Self.reply(400, ["error": "Send JSON."])
            }
            let photos = object["photos"] as? [String] ?? []
            let voice = object["voice"] as? [String: Any]
            let (gone, missing) = lock.withLock { () -> ([String], [Int]) in
                sent.append((submission, photos))
                if let voice { voiced.append(voice) }
                let gone = photos.filter(dropped.contains)
                dropped.subtract(gone)
                let note = voice?["note"] as? String
                let missing = note.map { note in (0..<(voice?["seconds"] as? Int ?? 0)).filter { heldNotes[note]?.seconds[$0] == nil } } ?? []
                return (gone, missing)
            }
            if !gone.isEmpty || !missing.isEmpty {
                return Self.reply(409, ["error": "Some files are missing.", "missing": ["photos": gone, "seconds": missing]])
            }
            if let audio = voice?["audio"] as? String, lostAudio.contains(audio) {
                return Self.reply(409, ["error": Self.lostWords, "missing": ["photos": [String](), "seconds": [Int](), "audio": [audio]]])
            }
            if refusing != 0 { return Self.reply(refusing, ["code": "REFUSED", "message": "The home refused it with \(refusing)."]) }
            return turn(object.compactMapValues { $0 as? String }.filter { $0.key != "submission" }, submission: submission, photos: photos, voice: voice)
        case ("POST", "/v1/settings"):
            guard case .json(let body) = request.body, let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
                return Self.reply(400, ["error": "Send JSON."])
            }
            let asked = object.compactMapValues { $0 as? String }
            lock.withLock {
                set.append(asked)
                if asked["was"] == voice.value, let value = asked["value"] { voice.value = value }
            }
            return Self.reply(200, ["value": asked["value"] ?? ""])
        case (let method, let path) where path.hasPrefix("/v1/ask/notes/"):
            let parts = path.dropFirst("/v1/ask/notes/".count).split(separator: "/").map(String.init)
            let data: Data? = if case .file(let file) = request.body { try? Data(contentsOf: file) } else { nil }
            lock.withLock {
                var note = heldNotes[parts[0]] ?? Note()
                switch (method, parts.count) {
                case ("POST", 1): note.opened = true
                case ("PUT", 2):
                    let k = Int(parts[1]) ?? -1
                    note.seconds[k] = data
                    note.puts[k, default: 0] += 1
                case ("DELETE", 1):
                    note.cancelled = true
                    note.seconds = [:]
                default: break
                }
                heldNotes[parts[0]] = note
            }
            return Self.reply(200, ["note": parts[0]])
        default:
            return Self.reply(404, ["error": "No route \(request.url.path)."])
        }
    }

    private func answering(_ model: String?, _ thinking: String?) -> (id: String, thinking: String, gone: Bool) {
        let listed = model.flatMap { id in offered.first { $0["id"] as? String == id } }
        let chosen = listed ?? offered.first { $0["id"] as? String == chat.model } ?? offered[0]
        let wanted = listed == nil ? chat.thinking : thinking
        let level = wanted.flatMap { (chosen["thinking"] as? [String] ?? []).contains($0) ? $0 : nil } ?? chosen["default"] as! String
        return (chosen["id"] as! String, level, model != nil && listed == nil)
    }

    private func ready(_ model: String?, _ thinking: String?) -> [String: Any] {
        lock.withLock {
            let runs = answering(model, thinking)
            let models = offered.map { row in row.merging(["state": state.signedIn ? "ready" : "unavailable"]) { $1 } }
            let row = { (model: [String: Any]) -> [String: Any] in
                ["value": model["id"] ?? "", "name": model["name"] ?? "", "account": NSNull(), "chosen": model["id"] as? String == runs.id]
            }
            let usable = state.signedIn ? offered : []
            let stays = { (model: [String: Any]) in model["hides"] as? Bool == false }
            let local = usable.filter(stays).map(row)
            let shown = offered.first { $0["id"] as? String == chat.model }?["id"] as? String
            let menu: [String: Any] = ["default": NSNull(), "rows": usable.filter { !stays($0) }.map(row),
                                       "local": local.isEmpty ? NSNull() as Any : ["label": "Local", "rows": local] as Any,
                                       "more": ["words": "More", "use": "chat", "work": NSNull()], "off": NSNull()]
            var answer: [String: Any] = ["models": models, "menu": menu, "default": ["model": chat.model as Any, "thinking": chat.thinking as Any, "shown": shown as Any,
                                                                       "choose": shown == nil ? "Choose a model" : NSNull() as Any],
                                         "starters": kinds, "limits": ["photos": 10, "photo_bytes": 26_214_400, "voice_ms": voice.ms]]
            let leaves = voice.value == Self.cloud
            answer["voice"] = ["ready": voice.ready, "words": leaves ? "Scribe v2 · Sent as it is" : "Parakeet · your Mac",
                               "line": voice.ready ? NSNull() : Self.voiceLine as Any, "caution": leaves ? Self.caution : NSNull() as Any,
                               "value": voice.value,
                               "choices": [["value": Self.parakeet, "words": "Parakeet · your Mac", "sent": false],
                                           ["value": Self.cloud, "words": "Scribe v2 · Sent as it is", "sent": true]]]
            if runs.gone { answer["gone"] = true }
            if let said = state.said { answer["said"] = said }
            answers.append(runs.gone ? "gone" : runs.id)
            return answer
        }
    }

    private func turn(_ question: [String: String], submission: String, photos: [String] = [], voice: [String: Any]? = nil) -> HomeResponse {
        let (chat, words, signedIn, failing, says, runs) = lock.withLock { () -> (String, String?, Bool, String?, String?, (id: String, thinking: String, gone: Bool)) in
            asked.append(question)
            let chat = question["chat"] ?? madeFor[submission] ?? "\(1_792_396_900_000 + made.count)-abcdef"
            if question["chat"] == nil, madeFor[submission] == nil {
                made.append(chat)
                madeFor[submission] = chat
            }
            return (chat, state.said, state.signedIn, state.failing, failure.says, answering(question["model"], question["thinking"]))
        }
        if losing { return HomeResponse(status: 200, headers: ["Content-Type": "application/x-ndjson"], body: Data()) }
        let audio = voice.map { ($0["audio"] as? String) ?? Self.audio(of: $0["note"] as? String ?? "") }
        let changing = changingAccess
        let message: [String: Any] = changing.map { $0.kept.merging(["chat": chat, "n": 2]) { $1 } }
            ?? ["chat": chat, "n": 2, "at_ms": 1_792_396_861_000, "role": "assistant", "text": "At Synthetic Cafe.",
                "model": runs.id, "thinking": runs.thinking, "ms": 1_200, "end": "done"]
        let events: [[String: Any]] = if erasing {
            [["type": "error", "error": "erased"]]
        } else if let failing {
            [["type": "error", "error": failing].merging(says.map { ["message": $0] } ?? [:]) { $1 }]
        } else if signedIn {
            [["type": "chat", "chat": chat, "n": 2].merging(audio.map { ["audio": $0] } ?? [:]) { $1 }]
                + (voice != nil ? [["type": "words", "words": Self.noteWords]] : [])
                + (changing?.events ?? [])
                + [["type": "done", "message": message]]
        } else {
            [["type": "error", "error": "login", "message": words ?? ""]]
        }
        if events.contains(where: { $0["type"] as? String == "chat" }) {
            lock.withLock {
                if let level = question["level"] { levels[chat] = level } else if levels[chat] == nil { levels[chat] = privacy }
                var messages = kept[chat] ?? []
                var asked: [String: Any] = ["chat": chat, "n": messages.count + 1, "at_ms": 1_792_396_860_000, "role": "user",
                                            "text": question["question"] ?? "", "photos": photos]
                if let audio {
                    asked["voice"] = ["audio": audio, "ms": 1_000,
                                      "words": Self.noteWords]
                }
                messages.append(asked)
                messages.append(message.merging(["n": messages.count + 1]) { $1 })
                kept[chat] = messages
            }
        }
        let lines = events.compactMap { try? JSONSerialization.data(withJSONObject: $0) }
        return HomeResponse(status: 200, headers: ["Content-Type": "application/x-ndjson"],
                            body: lines.reduce(Data()) { $0 + $1 + Data([0x0A]) })
    }

    private static func reply(_ status: Int, _ object: [String: Any]) -> HomeResponse {
        HomeResponse(status: status, body: (try? JSONSerialization.data(withJSONObject: object)) ?? Data())
    }
}
