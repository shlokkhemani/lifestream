import Cockpit
import Foundation
import HomeLink
import LifestreamCaptureCore
import XCTest

@testable import Lifestream

@MainActor
final class AgentAsksTests: XCTestCase {
    private var folder: URL!
    private let before: Int64 = 1_794_650_000_000

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("agent-asks-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testACardLeavesWhenTheHomeStopsListingItOrItsEndPasses() async throws {
        let (agents, door, clock) = try await paired()
        door.reply("GET /v1/agents/waiting", 200, try listing())
        await agents.list()
        XCTAssertEqual(agents.shown?.id, "rq-0000000000000002", "the first agent's ask, Chat's left to its card")
        XCTAssertEqual(agents.asks.count, 4, "every open ask, Chat's among them")

        door.answer("GET /v1/agents/waiting", "waiting-none")
        door.answer("GET /v1/agents/asks/rq-0000000000000002", "ask-allowed")
        await agents.list()
        XCTAssertTrue(agents.checking, "the home stopped listing it: its card takes no tap while the ask is read")
        let allowed = try outcome("ask-allowed")
        try await waitUntil("how it ended elsewhere, in the home's words") { agents.outcome == AgentRequestCard.Ended(allowed) }
        XCTAssertEqual(agents.shown?.id, "rq-0000000000000002", "the outcome stands on its own card, never on the next")
        XCTAssertFalse(agents.checking)
        agents.close()
        XCTAssertNil(agents.shown, "Done closes it")

        door.reply("GET /v1/agents/waiting", 200, try listing())
        await agents.list()
        let again = try XCTUnwrap(agents.shown?.id)
        door.replyLost("GET /v1/agents/waiting")
        door.answer("GET /v1/agents/asks/\(again)", "ask-lapsed")
        clock.ms = 1_794_733_200_000
        await agents.list()
        try await waitUntil("its end passed while the home did not answer") { agents.outcome == AgentRequestCard.Ended("This request is over.") }
        XCTAssertTrue(agents.asks.isEmpty)
        agents.close()
        XCTAssertNil(agents.shown)
    }

    func testAnAskAnsweredElsewhereSaysHowItEndedBeforeTheNext() async throws {
        let (agents, door, _) = try await paired()
        door.reply("GET /v1/agents/waiting", 200, try listing())
        await agents.list()
        XCTAssertEqual(agents.shown?.id, "rq-0000000000000002")
        door.reply("GET /v1/agents/waiting", 200, try listing(without: "rq-0000000000000002"))
        door.answer("GET /v1/agents/asks/rq-0000000000000002", "ask-declined")
        await agents.list()
        agents.answer(.no)
        XCTAssertNil(agents.sending, "a tap while the ask is read lands on nothing")
        try await said(agents, try outcome("ask-declined"))
        XCTAssertEqual(agents.shown?.id, "rq-0000000000000003", "Done opens the next")
        XCTAssertTrue(door.sent("POST /v1/agents/answer").isEmpty)
    }

    func testASignInThatEndsUnansweredSaysTheHomesWordsByTheHomesClock() async throws {
        let (agents, door, clock) = try await paired()
        clock.ms = 1_794_646_800_000
        door.answer("GET /v1/agents/waiting", "waiting-sign-in")
        await agents.list()
        guard case .signIn(let signIn)? = agents.shown else { return XCTFail("the sign-in's sheet") }
        clock.ms = signIn.untilMs + 3_600_000
        await agents.list()
        XCTAssertEqual(agents.shown?.id, signIn.id, "the phone's clock is past its end, the home still lists it: it stands")
        XCTAssertNil(agents.outcome)
        XCTAssertEqual(door.asked("GET /v1/agents/signins/\(signIn.id)"), 0)

        door.answer("GET /v1/agents/waiting", "waiting-none")
        door.answer("GET /v1/agents/signins/\(signIn.id)", "signin-over")
        await agents.list()
        try await waitUntil("the home no longer holds it") { agents.outcome == AgentRequestCard.Ended(signIn.head, words: signIn.over) }
        XCTAssertEqual(agents.shown?.id, signIn.id, "the agent stays shown, the home's words under it")
    }

    func testASignInAnsweredOnAnotherDeviceSaysWhereAndHow() async throws {
        let (agents, door, _) = try await paired()
        door.answer("GET /v1/agents/waiting", "waiting-sign-in")
        await agents.list()
        guard case .signIn(let signIn)? = agents.shown else { return XCTFail("the sign-in's sheet") }
        door.answer("GET /v1/agents/waiting", "waiting-none")
        door.answer("GET /v1/agents/signins/\(signIn.id)", "signin-answered")
        let words = try outcome("signin-answered")
        await agents.list()
        XCTAssertTrue(agents.checking, "it left the list: its numbers take no tap while it is read")
        try await waitUntil("how it was answered elsewhere") { agents.outcome == AgentRequestCard.Ended(signIn.head, words: words) }
        XCTAssertFalse(agents.checking)
        XCTAssertTrue(door.sent("POST /v1/agents/answer").isEmpty)
        agents.close()
        XCTAssertNil(agents.shown, "Done closes it")
    }

    func testAFailureSaysWhatTheDeviceKnows() {
        XCTAssertEqual(AgentAsks.failed(LinkFailure.unanswered(again: false, began: true)), .unsure,
                       "an answer that cannot be sent again is not known done: the ask is read again")
        XCTAssertEqual(AgentAsks.failed(LinkFailure.unanswered(again: true, began: true)), .unsure, "still saving: the ask is read again")
        XCTAssertEqual(AgentAsks.failed(LinkFailure.unavailable(code: "HOME_FAILED", message: "Your home failed at this. Its log says why.", retryAfter: nil)),
                       .said(ReachWords.notSent))
        XCTAssertEqual(AgentAsks.failed(LinkFailure.noAnswer(sent: true)), .unsure)
        XCTAssertEqual(AgentAsks.failed(LinkFailure.refused(status: 422, code: "BAD_ANSWER", message: "That number is not one of the three.")),
                       .said("That number is not one of the three."), "a refusal in the home's words")
    }

    func testOneCardSendsOneAnswerMadeFromItsVersionOnceFaceIDPasses() async throws {
        let (refused, refusedDoor, _) = try await paired(proving: false)
        refusedDoor.reply("GET /v1/agents/waiting", 200, try listing())
        await refused.list()
        refused.answer(.once)
        try await waitUntil("Face ID refused") { refused.failed == AgentAsks.unproved }
        XCTAssertTrue(refusedDoor.sent("POST /v1/agents/answer").isEmpty, "nothing sent before Face ID passes")

        let (agents, door, _) = try await paired()
        door.reply("GET /v1/agents/waiting", 200, try listing())
        door.answer("POST /v1/agents/answer", "answer-once")
        await agents.list()
        agents.answer(.once)
        agents.answer(.always)
        try await said(agents, try outcome("answer-once"))
        XCTAssertEqual(door.sent("POST /v1/agents/answer"), [#"{"answer":"once","expect":1,"id":"rq-0000000000000002"}"#],
                       "one answer, naming the ask's version")
        XCTAssertEqual(agents.shown?.id, "rq-0000000000000003", "Done opens the next")
    }

    func testAReplyThatNeverCameReadsTheAskBeforeItsButtons() async throws {
        let (agents, door, _) = try await paired()
        door.reply("GET /v1/agents/waiting", 200, try listing())
        await agents.list()
        door.replyLost("POST /v1/agents/answer")
        door.answer("GET /v1/agents/asks/rq-0000000000000002", "ask-open")
        agents.answer(.no)
        try await waitUntil("the ask read again") { !agents.checking && agents.failed == AgentAsks.unsure }
        XCTAssertEqual(agents.shown?.id, "rq-0000000000000002", "still open: its buttons come back, the line kept")

        door.answer("GET /v1/agents/asks/rq-0000000000000002", "ask-allowed")
        agents.answer(.no)
        let allowed = try outcome("ask-allowed")
        try await waitUntil("the ended ask says how it ended") { agents.outcome == AgentRequestCard.Ended(allowed) }
        XCTAssertFalse(agents.checking)
        XCTAssertNil(agents.failed)
        agents.close()
        XCTAssertEqual(agents.shown?.id, "rq-0000000000000003", "Done opens the next")
    }

    func testARequestTheHomeNoLongerKnowsClosesItsSheet() async throws {
        let (agents, door, _) = try await paired()
        door.reply("GET /v1/agents/waiting", 200, try listing())
        await agents.list()
        door.answer("POST /v1/agents/answer", "answer-unknown")
        agents.answer(.no)
        try await said(agents, "This request is over.")
        XCTAssertNil(agents.failed, "nothing left to answer: how it ended, never a failure")
        XCTAssertEqual(agents.shown?.id, "rq-0000000000000003", "Done opens the next")
    }

    func testAnUndoAfterTheAccessMovedIsNotOfferedAgain() async throws {
        let (agents, door, _) = try await paired()
        guard case .narrowed(let id, let reader, let narrowed)? = CannedHome.Agents.decoded(HomeLink.AccessChange.self, "propose-narrowed") else {
            return XCTFail("the door's narrowing")
        }
        let undo = narrowed.undo
        door.answer("POST /v1/agents/\(reader)/access", "access-stale")
        agents.undo(id, reader: reader, undo)
        try await waitUntil("the Undo refused") { if case .failed = agents.undos[id] { true } else { false } }
        let stale = try XCTUnwrap((CannedHome.Agents.contract("access-stale")["answer"] as? [String: Any])?["message"] as? String)
        XCTAssertEqual(agents.undos[id], .failed(stale, again: false))
        agents.undo(id, reader: reader, undo)
        XCTAssertEqual(door.sent("POST /v1/agents/\(reader)/access").count, 1, "no second Undo of an access that moved")
        XCTAssertEqual(try XCTUnwrap(door.sent("POST /v1/agents/\(reader)/access").first),
                       String(decoding: try JSONEncoder.sorted.encode(Write(access: undo.access, expect: undo.expect)), as: UTF8.self),
                       "the access before, made from the version the narrowing made")
    }

    func testAnAgentsOwnRequestHasTheSheetAndChatsProposalForItKeepsItsCard() async throws {
        let (agents, door, _) = try await paired()
        let asks = try XCTUnwrap((CannedHome.Agents.contract("waiting")["answer"] as? [String: Any])?["asks"] as? [[String: Any]])
        let own = try XCTUnwrap(asks.first { $0["by"] as? String == "agent" })
        let proposal = try XCTUnwrap(asks.first { $0["by"] as? String == "chat" }).merging(["reader": own["reader"]!]) { $1 }
        door.reply("GET /v1/agents/waiting", 200, try waitingAnswer(requests: [], asks: [proposal, own]))
        door.answer("POST /v1/agents/answer", "answer-once")
        await agents.list()
        XCTAssertEqual(agents.asks.map(\.by), [.chat, .agent], "both wait for one agent")
        XCTAssertEqual(agents.shown?.id, own["id"] as? String, "the agent's own request has the sheet")
        let chats = try XCTUnwrap(agents.listed(try XCTUnwrap(proposal["id"] as? String)), "Chat's proposal waits on its card")
        XCTAssertEqual(chats.head, proposal["head"] as? String)

        agents.answer(.once)
        try await said(agents, try outcome("answer-once"))
        XCTAssertNil(agents.shown, "Chat's proposal never takes the sheet")
        XCTAssertEqual(agents.listed(chats.id), chats, "answering the agent's request leaves Chat's proposal")
    }

    func testChatsCardSaysHowItsAskEndedInTheHomesWords() async throws {
        let (agents, door, _) = try await paired()
        door.answer("GET /v1/agents/waiting", "waiting-none")
        door.answer("GET /v1/agents/asks/rq-0000000000000001", "ask-replaced")
        await agents.list()
        agents.follow("rq-0000000000000001")
        try await waitUntil("the ask read by id") { agents.ended["rq-0000000000000001"] != nil }
        XCTAssertEqual(agents.ended["rq-0000000000000001"]?.outcome, HomeLink.Phrase([.words("Claude asked again.")]), "replaced is never 'Not allowed'")
        XCTAssertNil(agents.listed("rq-0000000000000001"), "no buttons")
    }

    func testAnErasedAskOffersOnlyNo() async throws {
        let (agents, door, _) = try await paired()
        let erased = try XCTUnwrap(CannedHome.Agents.contract("ask-erased")["answer"])
        door.reply("GET /v1/agents/waiting", 200, try waitingAnswer(requests: [], asks: [erased]))
        door.answer("POST /v1/agents/answer", "answer-no")
        await agents.list()
        guard case .ask(let ask)? = agents.shown else { return XCTFail("the erased ask's sheet") }
        XCTAssertEqual(ask.line, "What Instinct asked for was erased.")
        XCTAssertEqual(agents.choices(ask).map(\.answer), [.no], "No alone")
        XCTAssertFalse(agents.changes(ask), "no Change: nothing is left to allow")
        agents.change()
        XCTAssertNil(agents.editor)
        agents.answer(.always)
        XCTAssertNil(agents.sending, "an allow it does not offer is not sent")
        agents.answer(.no)
        try await said(agents, try outcome("answer-no"))
        XCTAssertNil(agents.shown)
        XCTAssertEqual(door.sent("POST /v1/agents/answer"), [#"{"answer":"no","id":"rq-0000000000000001"}"#])
    }

    func testAnApprovalRefusedAsErasedSaysTheDoorsWordsAndLeavesNo() async throws {
        let (agents, door, _) = try await paired()
        door.reply("GET /v1/agents/waiting", 200, try listing())
        door.answer("POST /v1/agents/answer", "answer-erased")
        await agents.list()
        guard case .ask(let ask)? = agents.shown else { return XCTFail("an ask's sheet") }
        XCTAssertTrue(agents.changes(ask))
        agents.answer(.once)
        let words = try XCTUnwrap((CannedHome.Agents.contract("answer-erased")["answer"] as? [String: Any])?["message"] as? String)
        try await waitUntil("the refusal said") { agents.failed == words }
        XCTAssertEqual(agents.shown?.id, ask.id, "the sheet stands: No still ends it")
        XCTAssertEqual(agents.choices(ask).map(\.answer), [.no], "No alone is left")
        XCTAssertFalse(agents.changes(ask))
        agents.answer(.always)
        XCTAssertEqual(door.sent("POST /v1/agents/answer").count, 1, "no second allow")
        door.answer("POST /v1/agents/answer", "answer-no")
        agents.answer(.no)
        try await said(agents, try outcome("answer-no"))
        XCTAssertNotEqual(agents.shown?.id, ask.id)
        XCTAssertEqual(door.sent("POST /v1/agents/answer").last, #"{"answer":"no","id":"\#(ask.id)"}"#)
    }

    func testAWrongNumberSaysTheHomesLineAndDoneOpensTheNext() async throws {
        let (agents, door, clock) = try await paired()
        clock.ms = 1_794_646_800_000
        let signIn = try XCTUnwrap(((CannedHome.Agents.contract("waiting-sign-in")["answer"] as? [String: Any])?["requests"] as? [Any])?.first)
        let asks = try XCTUnwrap((CannedHome.Agents.contract("waiting")["answer"] as? [String: Any])?["asks"])
        door.reply("GET /v1/agents/waiting", 200, try waitingAnswer(requests: [signIn], asks: asks))
        door.answer("POST /v1/agents/answer", "answer-sign-in-wrong")
        await agents.list()
        guard case .signIn(let shown)? = agents.shown else { return XCTFail("the sign-in's sheet") }
        agents.pick(.number(shown.choices[0]))
        let said = AgentRequestCard.Ended(shown.head, words: try outcome("answer-sign-in-wrong"))
        try await waitUntil("the home's line said") { agents.outcome == said }
        XCTAssertEqual(agents.shown?.id, shown.id, "the sheet keeps the home's line until Done")
        XCTAssertNil(agents.failed, "how it ended, never a failure under buttons")

        await agents.list()
        XCTAssertEqual(agents.outcome, said, "a list while the line stands leaves it")
        agents.close()
        XCTAssertNil(agents.outcome)
        XCTAssertEqual(agents.shown?.id, "rq-0000000000000002", "Done opens the next waiting")

        await agents.list()
        XCTAssertEqual(agents.shown?.id, "rq-0000000000000002", "a sign-in answered here is not drawn again while the home still lists it")
        XCTAssertEqual(door.sent("POST /v1/agents/answer").count, 1)
    }

    func testEachSignInAnswerSaysTheHomesOutcomeUntilDone() async throws {
        for (name, tap) in [("answer-sign-in", true), ("answer-sign-in-deny", false), ("answer-sign-in-ended", true)] {
            let (agents, door, clock) = try await paired()
            clock.ms = 1_794_646_800_000
            door.answer("GET /v1/agents/waiting", "waiting-sign-in")
            door.answer("POST /v1/agents/answer", name)
            await agents.list()
            guard case .signIn(let shown)? = agents.shown else { return XCTFail("\(name): the sign-in's sheet") }
            agents.pick(tap ? .number(shown.choices[0]) : .deny)
            let said = AgentRequestCard.Ended(shown.head, words: try outcome(name))
            try await waitUntil("\(name): the home's words said under its question") { agents.outcome == said }
            XCTAssertEqual(agents.shown?.id, "c2lnbi1pbi0wMDAwMDAwMQ", name)
            XCTAssertNil(agents.failed, name)
            agents.close()
            XCTAssertNil(agents.shown, "\(name): Done closes it")
        }
    }

    private func said(_ agents: AgentAsks, _ title: String) async throws {
        try await waitUntil("the home's words for how it ended: \(title)") { agents.outcome == AgentRequestCard.Ended(title) }
        agents.close()
    }

    private func outcome(_ name: String) throws -> String {
        let said = try XCTUnwrap((CannedHome.Agents.contract(name)["answer"] as? [String: Any])?["outcome"], name)
        return Words.phrase(try JSONDecoder().decode(HomeLink.Phrase.self, from: JSONSerialization.data(withJSONObject: said)),
                            now: Date(timeIntervalSince1970: Double(before) / 1000))
    }

    func testAnOpenEditorStandsWhileOnlyTheProposalsTimeMoves() async throws {
        let (agents, door, _) = try await paired()
        door.reply("GET /v1/agents/waiting", 200, try listing())
        await agents.list()
        guard case .ask(let first)? = agents.shown else { return XCTFail("Claude's ask") }
        agents.change()
        let editor = try XCTUnwrap(agents.editor, "Change open over Claude's ask")

        door.reply("GET /v1/agents/waiting", 200, try listing { ask in
            var proposed = ask["proposed"] as? [String: Any] ?? [:]
            var allow = proposed["allow"] as? [[String: Any]] ?? []
            allow[1]["lasts_ms"] = 3_602_000
            proposed["allow"] = allow
            ask["proposed"] = proposed
        })
        await agents.list()
        guard case .ask(let shown)? = agents.shown else { return XCTFail("Claude's ask") }
        XCTAssertNotEqual(shown.proposed, first.proposed, "the sheet reads the newest proposal")
        XCTAssertTrue(agents.editor === editor, "the proposal's time moved, not the access: Change stands")

        door.reply("GET /v1/agents/waiting", 200, try listing { $0["version"] = 2 })
        await agents.list()
        XCTAssertNil(agents.editor, "the saved access moved: the draft was made from another")
    }

    func testAChatCardWhoseReplyNeverCameIsReadAgainAtEachList() async throws {
        let (agents, door, _) = try await paired()
        door.reply("GET /v1/agents/waiting", 200, try listing())
        await agents.list()
        let ask = try XCTUnwrap(agents.listed("rq-0000000000000001"), "Chat's ask, listed")
        door.replyLost("POST /v1/agents/answer")
        door.replyLost("GET /v1/agents/asks/rq-0000000000000001")
        agents.answerChat(ask, .no)
        try await waitUntil("the reply never came, the ask unread") {
            agents.cards[ask.id]?.checking == true && door.asked("GET /v1/agents/asks/rq-0000000000000001") == 1
        }
        XCTAssertEqual(agents.cards[ask.id]?.failed, AgentAsks.unsure)

        door.answer("GET /v1/agents/asks/rq-0000000000000001", "ask-chat")
        try await waitUntil("read again at a list the home answered, its buttons back") {
            await agents.list()
            return agents.cards[ask.id]?.checking == false
        }
        XCTAssertNotNil(agents.listed(ask.id), "still waiting: its buttons stand")
    }

    func testASignInsButtonsComeBackOnlyOnAListTheHomeAnswered() async throws {
        let (agents, door, clock) = try await paired()
        clock.ms = 1_794_646_800_000
        door.answer("GET /v1/agents/waiting", "waiting-sign-in")
        door.replyLost("POST /v1/agents/answer")
        await agents.list()
        agents.pick(.deny)
        try await waitUntil("the reply never came") { agents.checking && agents.sending == nil }

        door.replyLost("GET /v1/agents/waiting")
        await agents.list()
        XCTAssertTrue(agents.checking, "no list came: nothing says the sign-in still waits")
        XCTAssertEqual(agents.shown?.id, "c2lnbi1pbi0wMDAwMDAwMQ", "its end has not passed: it stands")

        door.answer("GET /v1/agents/waiting", "waiting-sign-in")
        await agents.list()
        XCTAssertFalse(agents.checking, "the home lists it still: its buttons come back")
        XCTAssertEqual(agents.failed, AgentAsks.unsure, "the line stands with them")
    }

    func testAListThatFailedKeepsTheGuidesSignIn() async throws {
        let (agents, door, _) = try await paired()
        let file = try XCTUnwrap(Bundle.main.url(forResource: "agentsWaiting.claude-hermes-atlas", withExtension: "json", subdirectory: "pages/canned"))
        let page = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        let claude = try XCTUnwrap((page["requests"] as? [[String: Any]])?.first { $0["app"] as? String == "claude" })
        agents.guide("claude")
        door.reply("GET /v1/agents/waiting", 200, try waitingAnswer(requests: [claude], asks: []))
        await agents.list()
        XCTAssertEqual(agents.signIns.map(\.app), ["claude"], "the guide's sign-in, listed")
        XCTAssertNil(agents.shown, "the open guide shows it, not the sheet")

        door.replyLost("GET /v1/agents/waiting")
        await agents.list()
        XCTAssertEqual(agents.signIns.map(\.app), ["claude"], "a list that failed drops nothing the guide shows")
    }

    func testTheAccessPageAllowsAndUndoesOnlyOnceFaceIDPasses() async throws {
        let door = Door()
        let reader = try XCTUnwrap(CannedHome.Agents.decoded(HomeLink.AgentRead.self, "reader-reads"))
        let model = AccessEditorModel(link: try await linked(door), reader: reader, prove: { false })
        door.answer("POST /v1/agents/edit", "edit-widening")
        model.tap(.type("health", on: true))
        try await waitUntil("the widening waits") { model.waits && !model.busy }
        model.allow()
        try await waitUntil("Face ID refused") { model.trouble == AgentAsks.unproved && !model.busy }
        XCTAssertTrue(model.waits, "Cancel and Allow stand")
        door.answer("POST /v1/agents/edit", "edit-narrowed")
        model.cancel()
        model.tap(.type("messages", on: false))
        try await waitUntil("the narrowing saved") { model.narrowed != nil && !model.busy }
        model.undo()
        try await waitUntil("Face ID refused") { model.trouble == AgentAsks.unproved && !model.busy }
        XCTAssertTrue(door.sent("POST /v1/agents/\(reader.id)/access").isEmpty, "nothing that reads more is sent before Face ID passes")
    }

    func testAnAccessThatMovedIsReadAgainAndItsUndoGoes() async throws {
        let door = Door()
        let reader = try XCTUnwrap(CannedHome.Agents.decoded(HomeLink.AgentRead.self, "reader-reads"))
        let model = AccessEditorModel(link: try await linked(door), reader: reader, prove: { true })
        door.answer("POST /v1/agents/edit", "edit-narrowed")
        model.tap(.type("messages", on: false))
        try await waitUntil("the narrowing saved") { model.narrowed != nil && !model.busy }
        door.answer("POST /v1/agents/\(reader.id)/access", "access-stale")
        door.answer("GET /v1/agents/\(reader.id)", "reader-reads")
        model.undo()
        let stale = try XCTUnwrap((CannedHome.Agents.contract("access-stale")["answer"] as? [String: Any])?["message"] as? String)
        try await waitUntil("drawn again from the home's access") { model.narrowed == nil && !model.busy && model.editing.draft?.access == reader.access }
        XCTAssertEqual(model.trouble, stale, "the home's words stay on screen")
        XCTAssertEqual(model.saved, model.editing.draft)
        XCTAssertEqual(door.asked("GET /v1/agents/\(reader.id)"), 1)
    }

    func testCancelPutsTheSavedAccessBackAndTheNarrowingsUndoStaysWhileItsVersionStands() async throws {
        let door = Door()
        let reader = try XCTUnwrap(CannedHome.Agents.decoded(HomeLink.AgentRead.self, "reader-reads"))
        let model = AccessEditorModel(link: try await linked(door), reader: reader, prove: { true })
        door.answer("POST /v1/agents/edit", "edit-narrowed")
        model.tap(.type("messages", on: false))
        try await waitUntil("the narrowing saved") { model.narrowed != nil && !model.busy }
        let narrowed = try XCTUnwrap(model.editing.draft?.access)
        let undo = try XCTUnwrap(model.narrowed)
        door.answer("POST /v1/agents/edit", "edit-widening")
        model.tap(.type("health", on: true))
        try await waitUntil("the widening waits") { model.waits && !model.busy }
        XCTAssertNotNil(model.widening, "a waiting widening says what it adds")
        model.cancel()
        XCTAssertFalse(model.waits)
        XCTAssertEqual(model.editing.draft?.expect, model.editing.draft?.narrowed?.undo.expect, "the widening was drawn over the narrowing's version")
        XCTAssertEqual(model.narrowed, undo, "the version the narrowing made still stands: its Undo stays")
        XCTAssertEqual(model.editing.draft?.access, narrowed, "the saved access, drawn again")
    }

    func testANarrowingWhileAWideningWaitsIsSavedAndCancelKeepsItsUndo() async throws {
        let door = Door()
        let reader = try XCTUnwrap(CannedHome.Agents.decoded(HomeLink.AgentRead.self, "reader-reads"))
        let model = AccessEditorModel(link: try await linked(door), reader: reader, prove: { true })
        door.answer("POST /v1/agents/edit", "edit-widening")
        model.tap(.type("health", on: true))
        try await waitUntil("the widening waits") { model.waits && !model.busy }
        door.answer("POST /v1/agents/edit", "edit-narrowed-widening-waits")
        model.tap(.type("mail", on: false))
        try await waitUntil("the narrowing saved, the widening waiting on top") { model.narrowed != nil && model.waits && !model.busy }
        let answered = try XCTUnwrap(model.editing.draft)
        let kept = try XCTUnwrap(answered.saved)
        XCTAssertEqual(model.saved?.access, kept.access, "the saved access is the narrowing's, never the widening's")
        XCTAssertEqual(model.saved?.view, kept.view)
        XCTAssertEqual(model.state, [answered.narrowed?.words, answered.view.widening].compactMap { $0 }.map(AgentsWords.plain),
                       "the foot says what was saved and what waits")
        XCTAssertTrue(door.sent("POST /v1/agents/\(reader.id)/access").isEmpty, "the home saved the narrowing: the phone saves nothing")

        model.cancel()
        XCTAssertFalse(model.waits, "Cancel drops only the widening")
        XCTAssertEqual(model.editing.draft?.access, kept.access, "the saved access, the narrowing in it")
        XCTAssertNotNil(model.narrowed, "the narrowing's Undo stands")
    }

    func testAllowAfterANarrowingSendsTheWideningOverTheVersionTheNarrowingMade() async throws {
        let door = Door()
        let reader = try XCTUnwrap(CannedHome.Agents.decoded(HomeLink.AgentRead.self, "reader-reads"))
        let model = AccessEditorModel(link: try await linked(door), reader: reader, prove: { true })
        door.answer("POST /v1/agents/edit", "edit-narrowed-widening-waits")
        model.tap(.type("mail", on: false))
        try await waitUntil("the narrowing saved, the widening waiting") { model.narrowed != nil && model.waits && !model.busy }
        let answered = try XCTUnwrap(model.editing.draft)
        door.answer("POST /v1/agents/\(reader.id)/access", "access-widened")
        model.allow()
        try await waitUntil("Allow sent") { door.sent("POST /v1/agents/\(reader.id)/access").count == 1 && !model.busy }
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(door.sent("POST /v1/agents/\(reader.id)/access").first).utf8))
            as? [String: Any])
        XCTAssertEqual(sent["expect"] as? Int, answered.expect, "over the version the narrowing made, never the one before it")
        XCTAssertFalse(model.waits)
    }

    func testAChangeThatNeitherNarrowsNorWidensIsSavedAtOnce() async throws {
        let door = Door()
        let reader = try XCTUnwrap(CannedHome.Agents.decoded(HomeLink.AgentRead.self, "reader-reads"))
        let model = AccessEditorModel(link: try await linked(door), reader: reader, prove: { false })
        door.answer("POST /v1/agents/edit", "edit-hide")
        door.answer("POST /v1/agents/\(reader.id)/access", "access-narrowed")
        model.tap(.hide(.all))
        try await waitUntil("saved") { door.sent("POST /v1/agents/\(reader.id)/access").count == 1 && !model.busy }
        XCTAssertFalse(model.waits, "nothing waits under Allow")
        XCTAssertEqual(model.saved, model.editing.draft)
    }

    func testSinceSendsThePickedDaysStartInTheHomesZone() throws {
        let kolkata = try XCTUnwrap(TimeZone(identifier: "Asia/Kolkata"))
        let angeles = try XCTUnwrap(TimeZone(identifier: "America/Los_Angeles"))
        XCTAssertEqual(AccessEditorModel.since(Date(timeIntervalSince1970: 1_792_031_400), zone: kolkata), .since(ms: 1_792_002_600_000))
        XCTAssertEqual(AccessEditorModel.since(Date(timeIntervalSince1970: 1_792_119_600), zone: angeles), .since(ms: 1_792_047_600_000))
    }


    func testTheListAndTheAgentsPageDrawTheHomesWords() throws {
        let listed = try XCTUnwrap(CannedHome.Agents.contract("list")["answer"] as? [String: Any])
        let readers = try XCTUnwrap(listed["readers"] as? [[String: Any]])
        let listing = AgentsListing(try XCTUnwrap(CannedHome.Agents.decoded(HomeLink.AgentList.self, "list")))
        let rows = listing.connected + listing.chat + listing.disconnected
        XCTAssertEqual(Set(rows.map(\.id)), Set(readers.compactMap { $0["id"] as? String }), "every reader has a row")
        for reader in readers {
            let row = try XCTUnwrap(rows.first { $0.id == reader["id"] as? String })
            XCTAssertEqual(row.line, reader["summary"] as? String, "the amount is the home's summary")
            let last = (reader["reads"] as? [String: Any])?["last"] as? String
            XCTAssertEqual(row.end, reader["state"] as? String == "connected" ? last : nil)
        }
        XCTAssertEqual(listing.chat.map(\.id), readers.filter { $0["kind"] as? String == "chat" }.compactMap { $0["id"] as? String })

        let answer = try XCTUnwrap(CannedHome.Agents.contract("reader-reads")["answer"] as? [String: Any])
        let read = try XCTUnwrap(CannedHome.Agents.decoded(HomeLink.AgentRead.self, "reader-reads"))
        let parts = AgentPageParts(read, view: read.view)
        let reads = try XCTUnwrap(answer["reads"] as? [String: Any])
        let figure = try XCTUnwrap(answer["figure"] as? [String: Any])
        let view = try XCTUnwrap(answer["view"] as? [String: Any])
        let recent = try XCTUnwrap((answer["recent"] as? [String: Any])?["lines"] as? [[String: Any]])
        let disconnect = try XCTUnwrap(answer["disconnect"] as? [String: Any])
        XCTAssertEqual(parts.line, reads["short"] as? String)
        XCTAssertEqual(parts.noun, figure["words"] as? String)
        XCTAssertEqual(parts.reads, view["reads"] as? String)
        XCTAssertEqual(parts.far, (view["window"] as? [String: Any])?["words"] as? String)
        XCTAssertEqual(parts.hides, (view["hide"] as? [String: Any])?["words"] as? String)
        XCTAssertEqual(parts.recent?.words, recent.first?["words"] as? String)
        XCTAssertEqual(parts.recent?.line, recent.first?["line"] as? String)
        XCTAssertEqual(parts.connection, answer["how"] as? String)
        XCTAssertEqual(parts.disconnect, (disconnect["confirm"] as? String).map { $0 + "\u{2026}" })

        let gone = try XCTUnwrap(CannedHome.Agents.decoded(HomeLink.AgentRead.self, "disconnect"))
        let goneParts = AgentPageParts(gone, view: gone.view)
        XCTAssertEqual(goneParts.line, (CannedHome.Agents.contract("disconnect")["answer"] as? [String: Any])?["disconnected"] as? String)
        XCTAssertNil(goneParts.disconnect, "a disconnected agent offers Remove from the list instead")
    }

    func testAMenuSaveHoldsUndoInTheDockAndUndoSendsTheNarrowingsUndo() async throws {
        let door = Door()
        let reader = try XCTUnwrap(CannedHome.Agents.decoded(HomeLink.AgentRead.self, "reader-agent"))
        let model = AccessEditorModel(link: try await linked(door), reader: reader, prove: { true })
        XCTAssertEqual(model.dock, .none, "nothing to say before a change")
        let thirty = try XCTUnwrap(reader.view.times.first { $0.window == .past(ms: 2_592_000_000) })
        door.answer("POST /v1/agents/edit", "edit-window")
        model.far(thirty)
        try await waitUntil("the narrowing saved") { model.narrowed != nil && !model.busy }
        XCTAssertEqual(model.dock, .undo)
        XCTAssertFalse(model.state.isEmpty, "the dock says what was saved")
        XCTAssertTrue(door.sent("POST /v1/agents/\(reader.id)/access").isEmpty, "the home saved the narrowing")
        let undo = try XCTUnwrap(model.editing.draft?.narrowed?.undo)
        door.answer("POST /v1/agents/\(reader.id)/access", "access-undo")
        model.undo()
        try await waitUntil("Undo sent") { door.sent("POST /v1/agents/\(reader.id)/access").count == 1 && !model.busy }
        let sent = try JSONDecoder().decode(Sent.self, from: Data(try XCTUnwrap(door.sent("POST /v1/agents/\(reader.id)/access").first).utf8))
        XCTAssertEqual(sent.access, undo.access)
        XCTAssertEqual(sent.expect, undo.expect)
    }

    func testPickingAChipAsksTheHomeForThatKindAndPickingItAgainClearsIt() async throws {
        let door = Door()
        let store = AgentsStore(link: try await linked(door))
        let route = "GET /v1/agents/p-00000001/history"
        door.answer(route, "history")
        await store.readHistory("p-00000001")
        XCTAssertNil(store.histories["p-00000001"]?.kind)
        door.answer(route, "history-kind")
        await store.pick("p-00000001", kind: "messages")
        XCTAssertEqual(door.requests(route).last?.url.query, "kind=messages", "the filter is the home's, asked again")
        XCTAssertEqual(store.histories["p-00000001"], CannedHome.Agents.decoded(HomeLink.HistoryPage.self, "history-kind"))
        XCTAssertTrue(store.picking.isEmpty)
        door.answer(route, "history")
        await store.pick("p-00000001", kind: nil)
        XCTAssertNil(door.requests(route).last?.url.query, "a second tap clears the filter")
        XCTAssertEqual(door.requests(route).count, 3)
        await store.pick("p-00000001", kind: nil)
        XCTAssertEqual(door.requests(route).count, 3, "the kind in force is not asked again")
    }

    func testTheThingsAreAskedWithThePersonsOwnPassAndARefusalSaysTheHomesWords() async throws {
        let door = Door()
        let store = AgentsStore(link: try await linked(door))
        let route = "GET /v1/agents/p-00000001/reads/call-0000000000000001/things"
        door.answer(route, "things")
        await store.readThings("p-00000001", call: "call-0000000000000001")
        let sent = try XCTUnwrap(door.requests(route).first)
        guard case .json(let pairing) = try XCTUnwrap(door.requests("POST /v1/pair").first).body else { return XCTFail("the pairing names its pass") }
        let pass = try XCTUnwrap((try JSONSerialization.jsonObject(with: pairing) as? [String: Any])?["pass"] as? String)
        XCTAssertEqual(sent.headers["Authorization"], "Bearer \(pass)", "the paired person's pass, never a Chat principal")
        XCTAssertEqual(store.things[AgentsStore.key("p-00000001", "call-0000000000000001")],
                       CannedHome.Agents.decoded(HomeLink.ThingsPage.self, "things"))

        door.answer("GET /v1/agents/p-00000001/reads/call-0000000000000002/things", "things-chat")
        await store.readThings("p-00000001", call: "call-0000000000000002")
        let refusal = try XCTUnwrap(CannedHome.Agents.contract("things-chat")["answer"] as? [String: Any])
        XCTAssertEqual(store.thingsFailed[AgentsStore.key("p-00000001", "call-0000000000000002")], refusal["message"] as? String)
    }

    func testAReadsPageIsTheHomesAndAnUnknownReadSaysSo() async throws {
        let door = Door()
        let store = AgentsStore(link: try await linked(door))
        door.answer("GET /v1/agents/p-00000001/reads/call-0000000000000001", "read")
        await store.readPage("p-00000001", call: "call-0000000000000001")
        XCTAssertEqual(store.readPages[AgentsStore.key("p-00000001", "call-0000000000000001")],
                       CannedHome.Agents.decoded(HomeLink.ReadPage.self, "read"))
        door.answer("GET /v1/agents/p-00000001/reads/call-0000000000000009", "read-unknown")
        await store.readPage("p-00000001", call: "call-0000000000000009")
        let unknown = try XCTUnwrap(CannedHome.Agents.contract("read-unknown")["answer"] as? [String: Any])
        XCTAssertEqual(store.readFailed[AgentsStore.key("p-00000001", "call-0000000000000009")], unknown["message"] as? String)
    }

    func testASearchsLaterPagesAreOneRowAndADayIsOneSectionWithTheHomesCount() throws {
        let joined = try XCTUnwrap(CannedHome.Agents.decoded(HomeLink.HistoryPage.self, "history-pages"))
        let reads = HistoryDays(joined.sessions).days.flatMap(\.lines).compactMap { line -> HomeLink.HistoryRead? in
            if case .read(let read) = line { read } else { nil }
        }
        XCTAssertEqual(reads.count, 1, "the later pages joined their read")
        XCTAssertEqual(reads.first?.more, 3)

        let page = try XCTUnwrap(CannedHome.Agents.decoded(HomeLink.HistoryPage.self, "history"))
        let days = HistoryDays(page.sessions).days
        XCTAssertEqual(days.map(\.id), page.sessions.map(\.day.day).reduce(into: [String]()) { if $0.last != $1 { $0.append($1) } })
        XCTAssertEqual(days.flatMap(\.lines), page.sessions.flatMap(\.lines), "every line, in the home's order")
        XCTAssertEqual(days.map(\.reads), days.map { day in page.sessions.first { $0.day.day == day.id }?.day.reads },
                       "a day's count is the home's, whatever its sittings")
        XCTAssertNotNil(days.first?.reads, "a day of several sittings still says its count")
    }

    func testMoreThingsJoinTheirKindsAndKeepTheFirstPagesWords() throws {
        let first = try XCTUnwrap(CannedHome.Agents.decoded(HomeLink.ThingsPage.self, "things"))
        let more = try XCTUnwrap(CannedHome.Agents.decoded(HomeLink.ThingsPage.self, "things-gone"))
        let joined = first.joined(more)
        XCTAssertEqual(joined.title, first.title)
        XCTAssertEqual(joined.groups.map(\.kind), first.groups.map(\.kind))
        XCTAssertEqual(joined.groups.flatMap(\.things), first.groups.flatMap(\.things) + more.groups.flatMap(\.things))
        XCTAssertEqual(joined.next, more.next)
        XCTAssertEqual(joined.gone, more.gone)
    }

    func testAWideningWaitsOnItsKindsSwitchUntilAllowed() async throws {
        let door = Door()
        let reader = try XCTUnwrap(CannedHome.Agents.decoded(HomeLink.AgentRead.self, "reader-agent"))
        let model = AccessEditorModel(link: try await linked(door), reader: reader, prove: { true })
        let off = try XCTUnwrap(reader.view.categories.first { $0.state == .off })
        XCTAssertFalse(model.waiting(off))
        door.answer("POST /v1/agents/edit", "edit-widening")
        model.tap(.type(off.type, on: true))
        try await waitUntil("the widening drawn") { model.waits && !model.busy }
        let widened = try XCTUnwrap(model.view?.categories.filter { $0.state != .off && model.waiting($0) })
        XCTAssertFalse(widened.isEmpty, "a kind turned on and not yet allowed waits")
        XCTAssertTrue(reader.view.categories.filter { $0.state != .off }.allSatisfy { kind in
            model.view?.categories.first { $0.type == kind.type }.map(model.waiting) != true
        }, "what was already allowed never waits")
    }

    private struct Sent: Decodable {
        let access: HomeLink.Access
        let expect: HomeLink.Version
    }

    private func listing(_ change: (inout [String: Any]) -> Void = { _ in }) throws -> [String: Any] {
        let listed = try XCTUnwrap(CannedHome.Agents.contract("waiting")["answer"] as? [String: Any])
        var asks = try XCTUnwrap(listed["asks"] as? [[String: Any]])
        let at = try XCTUnwrap(asks.firstIndex { $0["id"] as? String == "rq-0000000000000002" })
        change(&asks[at])
        return try waitingAnswer(requests: [], asks: asks)
    }

    private func listing(without id: String) throws -> [String: Any] {
        let listed = try XCTUnwrap(CannedHome.Agents.contract("waiting")["answer"] as? [String: Any])
        let asks = try XCTUnwrap(listed["asks"] as? [[String: Any]])
        XCTAssertTrue(asks.contains { $0["id"] as? String == id }, "the listing held \(id) before")
        return try waitingAnswer(requests: [], asks: asks.filter { $0["id"] as? String != id })
    }

    private func waitingAnswer(requests: [Any], asks: Any) throws -> [String: Any] {
        let none = try XCTUnwrap(CannedHome.Agents.contract("waiting-none")["answer"] as? [String: Any])
        return none.merging(["requests": requests, "asks": asks]) { $1 }
    }

    private struct Write: Encodable {
        let access: HomeLink.Access
        let expect: Int
    }

    final class Clock: @unchecked Sendable {
        private let lock = NSLock()
        private var now: Int64

        init(_ ms: Int64) { now = ms }

        var ms: Int64 {
            get { lock.withLock { now } }
            set { lock.withLock { now = newValue } }
        }
    }

    private func linked(_ door: Door) async throws -> HomeLink {
        let link = HomeLink(device: HomeLink.Device(kind: .phone, version: "1.0.0", model: "iPhone", serial4: nil),
                            credentials: MemoryPass(), folder: folder.appendingPathComponent(UUID().uuidString), transport: door,
                            network: TestNetwork(NetworkFacts(online: true, onLocalNetwork: false, tunnelUp: true, path: 1, cost: .free)))
        _ = try await link.pair(code: "12345678", name: "http://100.64.0.42:4680", account: "person-a@example.com")
        return link
    }

    private func paired(proving: Bool = true) async throws -> (AgentAsks, Door, Clock) {
        let door = Door()
        let link = try await linked(door)
        let clock = Clock(before)
        let agents = AgentAsks(link: link, pages: PageShelf(root: folder.appendingPathComponent(UUID().uuidString), link: link), paired: { true },
                               clock: { Date(timeIntervalSince1970: Double(clock.ms) / 1000) },
                               prove: { proving })
        return (agents, door, clock)
    }

    final class Door: HomeTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var answers: [String: HomeResponse?] = [:]
        private var bodies: [String: [String]] = [:]
        private var counts: [String: Int] = [:]
        private var asked: [String: [HomeRequest]] = [:]

        func answer(_ route: String, _ name: String) {
            let contract = CannedHome.Agents.contract(name)
            let body = (try? JSONSerialization.data(withJSONObject: contract["answer"] ?? [:])) ?? Data()
            lock.withLock { answers[route] = HomeResponse(status: contract["status"] as? Int ?? 500, body: body) }
        }

        func reply(_ route: String, _ status: Int, _ object: Any) {
            let body = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
            lock.withLock { answers[route] = HomeResponse(status: status, body: body) }
        }

        func replyLost(_ route: String) {
            lock.withLock { answers[route] = .some(nil) }
        }

        func sent(_ route: String) -> [String] {
            lock.withLock { bodies[route] ?? [] }
        }

        func requests(_ route: String) -> [HomeRequest] {
            lock.withLock { asked[route] ?? [] }
        }

        func asked(_ route: String) -> Int {
            lock.withLock { counts[route] ?? 0 }
        }

        func perform(_ request: HomeRequest) async throws -> HomeResponse {
            if request.url.path == "/v1/pair" {
                lock.withLock { asked["POST /v1/pair", default: []].append(request) }
                return Self.paired
            }
            let route = request.method + " " + request.url.path
            let answer = lock.withLock { () -> HomeResponse?? in
                counts[route, default: 0] += 1
                asked[route, default: []].append(request)
                if case .json(let body) = request.body { bodies[route, default: []].append(String(decoding: body, as: UTF8.self)) }
                return answers[route]
            }
            guard case .some(.some(let response)) = answer else { throw URLError(.networkConnectionLost) }
            return response
        }

        private static let paired: HomeResponse = {
            let answer = #"{"home":{"id":"h-0001","version":"0.2.0","floors":{"mac":"0.1.0","phone":"1.0.0","extension":"0.1.0"}},"#
                + #""pass":"p-0000aa00","unit":"iphone-aa00","sources":{},"owner":[],"needs":[],"calls":[],"settings":{},"#
                + #""turn":{"run":"0000000000000001","n":1}}"#
            return HomeResponse(status: 200, body: Data(#"{"unit":"iphone-aa00","answer":\#(answer)}"#.utf8))
        }()
    }
}

private extension JSONEncoder {
    static var sorted: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}
