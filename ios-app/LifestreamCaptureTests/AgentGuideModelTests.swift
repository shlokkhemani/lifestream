import Cockpit
import Foundation
import HomeLink
import LifestreamCaptureCore
import XCTest

@testable import Lifestream

@MainActor
final class AgentGuideModelTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("agent-guides-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testEverySignInStateOfTheTableIsTheGuides() throws {
        let rows = try XCTUnwrap(try Self.table()["sign-in"] as? [[String: Any]])
        XCTAssertFalse(rows.isEmpty)
        for row in rows {
            let name = row["case"] as? String ?? ""
            let guide = try Self.guide(row["app"], device: "phone")
            let dialog = try XCTUnwrap(row["dialog"] as? [String: Any], name)
            let read = (row["read"] as? [String: Any]).map { read in
                AgentGuideState.Read(id: read["id"] as? String ?? "", state: HomeLink.SignInRead.State(rawValue: read["state"] as? String ?? "") ?? .waiting,
                                     reader: read["reader"] as? String)
            }
            let drawn = AgentGuideState.signIn(guide, Self.signIn(dialog), address: try Self.address(row["address"]),
                                               waiting: Self.waiting(row["waiting"]), read: read)
            XCTAssertEqual(Self.json(drawn, signIn: true), row["state"] as? NSDictionary, name)
        }
    }

    func testEveryKeyStateOfTheTableIsTheGuides() throws {
        let rows = try XCTUnwrap(try Self.table()["key"] as? [[String: Any]])
        XCTAssertFalse(rows.isEmpty)
        for row in rows {
            let name = row["case"] as? String ?? ""
            let guide = try Self.guide(row["app"], device: row["device"] as? String ?? "phone")
            let dialog = try XCTUnwrap(row["dialog"] as? [String: Any], name)
            let drawn = AgentGuideState.key(guide, Self.key(dialog), address: try Self.address(row["address"]))
            XCTAssertEqual(Self.json(drawn, signIn: false), row["state"] as? NSDictionary, name)
        }
    }

    func testEveryLineTheTableDrawsHasItsWordsInTheGuide() throws {
        let table = try Self.table()
        for part in ["sign-in", "key"] {
            for row in try XCTUnwrap(table[part] as? [[String: Any]]) {
                let name = "\(row["case"] as? String ?? ""), \(part)"
                let guide = try Self.guide(row["app"], device: row["device"] as? String ?? "phone")
                let named = try XCTUnwrap((row["state"] as? [String: Any])?["lines"] as? [String], name)
                let lines = named.compactMap(AgentGuideState.Line.init(rawValue:))
                XCTAssertEqual(lines.map(\.rawValue), named, "\(name): every line the table names is one the app draws")
                for line in lines where line.rawValue.hasPrefix("yes.") || line.rawValue.hasPrefix("give.") {
                    XCTAssertNotNil(AgentGuideState.words(line, in: guide), "\(name): the guide holds \(line.rawValue)")
                }
                if part == "sign-in" {
                    let yes = try XCTUnwrap(AgentGuideState.yes(guide), "\(name): a sign-in guide has its yes")
                    XCTAssertTrue(yes.other.contains(AgentGuideState.hostSlot), "\(name): the waiting sign-in's host is the app's to fill")
                }
            }
        }
    }

    func testTwoCopiesSendOneTurnOnAndTheAddressShowsOn() async throws {
        let (model, door) = try await guided("claude")
        door.reply("GET /v1/agents/address", 200, try Self.answer("address-off"))
        door.reply("POST /v1/agents/address", 200, try Self.answer("address-on"))
        await model.start()
        guard case .off? = model.address else { return XCTFail("the address read before the copy") }
        let value = try XCTUnwrap(model.guide.steps.lazy.compactMap { step -> HomeLink.Pages.GuideValue? in
            if case .add(_, _, _, let values, _, _) = step { values.first(where: \.address) } else { nil }
        }.first)
        XCTAssertNotNil(model.text(value), "the address shows before the copy")
        model.copied(value)
        model.copied(value)
        try await waitUntil("the address on") { if case .on? = model.address { true } else { false } }
        XCTAssertEqual(door.asked("POST /v1/agents/address"), 1, "the second copy joined the first turn-on")
        XCTAssertEqual(model.drawn.lines, [.addrOn])
        XCTAssertEqual(model.drawn.shows, [.copied, .waiting])
    }

    func testAYesOnTheOtherDeviceLandsConnectedHere() async throws {
        let (model, door) = try await guided("claude")
        door.reply("GET /v1/agents/address", 200, try Self.answer("address-on"))
        await model.start()
        let signIn = try Self.claudeSignIn()
        model.heard([signIn])
        XCTAssertEqual(model.drawn.signin, signIn.id, "the sign-in shows inside step 2")
        XCTAssertEqual(model.shownSignIn?.id, signIn.id)

        var connected = try XCTUnwrap(try Self.answer("signin-connected") as? [String: Any])
        connected["id"] = signIn.id
        door.reply("GET /v1/agents/signins/\(signIn.id)", 200, connected)
        model.heard([])
        try await waitUntil("Connected") { model.drawn.shows == [.oneLine, .connected] }
        XCTAssertEqual(model.drawn.head, .done)
        XCTAssertEqual(model.connectedLine, (connected["connected"] as? [String: Any])?["line"] as? String)
        XCTAssertTrue(door.sent("POST /v1/agents/answer").isEmpty, "nothing answered here")
    }

    func testAnApprovedYesFinishesThenAGoneReadSaysItDidNotFinish() async throws {
        let (model, door) = try await guided("claude")
        door.reply("GET /v1/agents/address", 200, try Self.answer("address-on"))
        await model.start()
        let signIn = try Self.claudeSignIn()
        model.heard([signIn])
        door.answer("POST /v1/agents/answer", "answer-sign-in")
        model.pick(.number(64))
        try await waitUntil("Finishing") { model.drawn.shows == [.oneLine, .finishing] }

        door.reply("GET /v1/agents/signins/\(signIn.id)", 200, try Self.answer("signin-gone"))
        model.heard([])
        try await waitUntil("did not finish") { model.drawn.lines == [.yesUnfinished] }
        XCTAssertEqual(model.drawn.shows, [.oneLine, .waiting])
    }

    func testInstinctsKeyTurnsTheAddressOnFirstThenShowsItsRows() async throws {
        let proofs = Proofs(pass: true)
        let (model, door) = try await guided("instinct", proofs: proofs)
        door.reply("GET /v1/agents/address", 200, try Self.answer("address-off"))
        door.reply("POST /v1/agents/address", 200, try Self.answer("address-on"))
        door.reply("POST /v1/agents/keys", 200, try Self.answer("keys-instinct"))
        await model.start()
        XCTAssertEqual(model.drawn.foot, [], "the key waits for the link")
        model.linked()
        XCTAssertEqual(model.drawn.foot, [.make])
        model.make()
        try await waitUntil("the key made") { model.drawn.shows == [.message, .seesDone, .rows] }
        XCTAssertEqual(proofs.asked, 1, "Face ID or the passcode before the key")
        XCTAssertEqual(door.asked("POST /v1/agents/address"), 1, "the address turned on before the key")
        XCTAssertEqual(model.made?.rows.map(\.label), ["Address", "Key"])
        XCTAssertFalse(model.finish(), "Done moves to Connected first")
        XCTAssertEqual(model.drawn.head, .done)
        XCTAssertTrue(model.finish(), "then Done closes")
    }

    func testAKeyIsMadeOnlyOnceFaceIDPasses() async throws {
        let proofs = Proofs(pass: false)
        let (model, door) = try await guided("instinct", proofs: proofs)
        door.reply("GET /v1/agents/address", 200, try Self.answer("address-on"))
        door.reply("POST /v1/agents/address", 200, try Self.answer("address-on"))
        door.reply("POST /v1/agents/keys", 200, try Self.answer("keys-instinct"))
        await model.start()
        model.linked()
        model.make()
        try await waitUntil("Face ID refused") { model.failed == AgentAsks.unproved && !model.keyDialog.making }
        XCTAssertEqual(proofs.asked, 1)
        XCTAssertEqual(door.asked("POST /v1/agents/keys"), 0, "no key without the proof")
        XCTAssertEqual(door.asked("POST /v1/agents/address"), 0, "nothing turned on without the proof")
        XCTAssertNil(model.keyDialog.made)
        XCTAssertEqual(model.drawn.foot, [.make], "Make the key stands to try again")
    }

    func testComingToTheFrontOnlyReadsAndTheTailscaleStepTurnsTheAddressOn() async throws {
        let (model, door) = try await guided("claude")
        door.reply("GET /v1/agents/address", 200, try Self.answer("address-off"))
        door.reply("POST /v1/agents/address", 200, try Self.answer("address-fix-turn-on"))
        await model.start()
        XCTAssertNil(model.drawn.address, "a first read of off shows no Tailscale step")
        let value = try Self.addressValue(model)
        model.copied(value)
        try await waitUntil("the copy answered fix") { model.drawn.address == .fix }
        XCTAssertEqual(model.drawn.shows, [.tailscale, .line, .line], "Tailscale is step 1, the rest waits")
        XCTAssertNil(model.steps.first?.step, "step 1 is the guide's Tailscale step, not one of the app's")

        await model.cameToFront()
        await model.cameToFront()
        XCTAssertEqual(door.asked("POST /v1/agents/address"), 1, "coming to the front turned nothing on")
        XCTAssertEqual(model.drawn.address, .turnOn, "Funnel allowed: the step says Tailscale is ready, with Turn on")

        door.reply("POST /v1/agents/address", 200, try Self.answer("address-on"))
        await model.turnOn()
        XCTAssertEqual(door.asked("POST /v1/agents/address"), 2)
        XCTAssertEqual(model.drawn.marks, [.done, .here, .here], "Tailscale ticked done, the guide goes on")
        XCTAssertEqual(model.drawn.shows, [.tailscale, .copied, .waiting])
    }

    func testOnTheIPhoneAFixOnTheMacSaysSoAndChecksAgain() async throws {
        let (model, door) = try await guided("instinct")
        door.reply("GET /v1/agents/address", 200, try Self.answer("address-fix-phone"))
        await model.start()
        XCTAssertEqual(model.drawn.address, .check, "no act the phone can do: Check again")
        XCTAssertEqual(model.drawn.shows, [.tailscale, .line, .line, .line])
        door.reply("GET /v1/agents/address", 200, try Self.answer("address-on"))
        await model.readAddress()
        XCTAssertNil(model.drawn.address)
        XCTAssertEqual(model.drawn.marks, [.done, .here, .later, .later])
        XCTAssertEqual(door.asked("POST /v1/agents/address"), 0, "a read never turns it on")
    }

    func testTheTailscaleStepReadsTheAddressEachRoundUntilItIsOnWithNoComingToTheFront() async throws {
        let rounds = Rounds()
        let (model, door) = try await guided("instinct", rounds: rounds)
        door.reply("GET /v1/agents/address", 200, try Self.answer("address-fix-phone"))
        await model.start()
        XCTAssertEqual(model.drawn.address, .check, "Tailscale not ready: step 1")
        try await waitUntil("the round rests before its next read") { rounds.resting }

        door.reply("GET /v1/agents/address", 200, try Self.answer("address-off"))
        rounds.next()
        try await waitUntil("the next round read off") { model.drawn.address == .turnOn }
        XCTAssertEqual(model.drawn.shows.first, .tailscale, "ready, Turn on, with no coming to the front")
        XCTAssertEqual(door.asked("GET /v1/agents/address"), 2, "one read a round")
        XCTAssertEqual(door.asked("POST /v1/agents/address"), 0, "a round never turns it on")

        try await waitUntil("ready is not done: the round rests again") { rounds.resting }
        door.reply("GET /v1/agents/address", 200, try Self.answer("address-on"))
        rounds.next()
        try await waitUntil("the address on: the step done, the round ends") { !model.roundsAddress }
        XCTAssertEqual(model.drawn.marks.first, .done)
        XCTAssertFalse(rounds.resting, "no round after the step is done")
        XCTAssertEqual(door.asked("POST /v1/agents/address"), 0)
    }

    func testNothingYetShowsOnlyAfterComingBackToTheFrontFromTheCopy() async throws {
        let (model, door) = try await guided("claude")
        door.reply("GET /v1/agents/address", 200, try Self.answer("address-on"))
        door.reply("POST /v1/agents/address", 200, try Self.answer("address-on"))
        await model.start()
        await model.cameToFront()
        model.copied(try Self.addressValue(model))
        try await waitUntil("waiting for Claude") { model.drawn.shows.last == .waiting }
        XCTAssertFalse(model.drawn.lines.contains(.yesHint), "a return before the copy is no return from it")
        await model.cameToFront()
        XCTAssertTrue(model.drawn.lines.contains(.yesHint), "back after the copy, nothing arrived: the hint")
    }

    func testMusesCopiedStepKeepsItsMessage() async throws {
        let (model, door) = try await guided("muse")
        door.reply("GET /v1/agents/address", 200, try Self.answer("address-off"))
        door.reply("POST /v1/agents/address", 200, try Self.answer("address-on"))
        await model.start()
        model.copied(try Self.addressValue(model))
        try await waitUntil("the address on") { if case .on? = model.address { true } else { false } }
        let first = try XCTUnwrap(model.steps.first)
        XCTAssertEqual(first.show, .copied)
        guard case .message? = first.step else { return XCTFail("the copied step is still Muse's message, with Open Muse") }
        XCTAssertEqual(model.drawn.lines, [.addrOn])
    }

    func testTheShownSignInIsReadBeforeAnotherShowsAndAFailedReadIsReadAgain() async throws {
        let (model, door) = try await guided("claude")
        door.reply("GET /v1/agents/address", 200, try Self.answer("address-on"))
        await model.start()
        let shown = try Self.claudeSignIn()
        let next = try Self.claudeSignIn(id: "agent-claude-older", atMs: shown.atMs - 1)
        model.heard([shown, next])
        XCTAssertEqual(model.drawn.signin, shown.id)

        door.replyLost("GET /v1/agents/signins/\(shown.id)")
        model.heard([next])
        XCTAssertEqual(model.drawn.signin, shown.id, "the one that left stands while it is read")
        try await waitUntil("the first read failed") { door.asked("GET /v1/agents/signins/\(shown.id)") >= 1 && model.read == nil }
        XCTAssertEqual(model.drawn.signin, shown.id, "a failed read skips nothing")

        var denied = try XCTUnwrap(try Self.answer("signin-gone") as? [String: Any])
        denied["id"] = shown.id
        denied["state"] = "denied"
        door.reply("GET /v1/agents/signins/\(shown.id)", 200, denied)
        try await waitUntil("read again on a later round") {
            model.heard([next])
            return model.read?.state == .denied
        }
        XCTAssertEqual(model.drawn.lines, [.yesDenied], "the answer given on the other device lands here")
        XCTAssertEqual(model.drawn.signin, next.id, "then the next of this app shows")
    }

    private func guided(_ app: String, proofs: Proofs? = nil, rounds: Rounds = Rounds()) async throws -> (AgentGuideModel, AgentAsksTests.Door) {
        let proofs = proofs ?? Proofs(pass: true)
        let door = AgentAsksTests.Door()
        let link = HomeLink(device: HomeLink.Device(kind: .phone, version: "1.0.0", model: "iPhone", serial4: nil),
                            credentials: MemoryPass(), folder: folder.appendingPathComponent(UUID().uuidString), transport: door,
                            network: TestNetwork(NetworkFacts(online: true, onLocalNetwork: false, tunnelUp: true, path: 1, cost: .free)))
        _ = try await link.pair(code: "12345678", name: "http://100.64.0.42:4680", account: "person-a@example.com")
        let guides = try Self.guides("phone")
        let guide = try XCTUnwrap(guides.apps.first { $0.app.rawValue == app })
        return (AgentGuideModel(guide: guide, sees: guides.sees[guide.app], link: link, asks: nil, prove: { proofs.prove() },
                                rest: { await rounds.rest() }), door)
    }

    private static func table() throws -> [String: Any] {
        let file = try XCTUnwrap(Bundle.main.url(forResource: "guide-states", withExtension: "json", subdirectory: "agents"))
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
    }

    private static func guides(_ device: String) throws -> HomeLink.AgentGuides {
        let file = try XCTUnwrap(Bundle.main.url(forResource: "agentGuides." + device, withExtension: "json", subdirectory: "pages"))
        return try JSONDecoder().decode(HomeLink.AgentGuides.self, from: Data(contentsOf: file))
    }

    private static func guide(_ app: Any?, device: String) throws -> HomeLink.Pages.Guide {
        try XCTUnwrap(try guides(device).apps.first { $0.app.rawValue == app as? String }, "\(device) has \(app ?? "")")
    }

    private static func answer(_ name: String) throws -> Any {
        try XCTUnwrap(CannedHome.Agents.contract(name, in: "agents/guide-door")["answer"], name)
    }

    private static func claudeSignIn(id: String? = nil, atMs: Int64? = nil) throws -> HomeLink.SignIn {
        let file = try XCTUnwrap(Bundle.main.url(forResource: "agentsWaiting.claude-hermes-atlas", withExtension: "json", subdirectory: "pages/canned"))
        let page = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        var claude = try XCTUnwrap((page["requests"] as? [[String: Any]])?.first { $0["app"] as? String == "claude" })
        if let id { claude["id"] = id }
        if let atMs { claude["at_ms"] = atMs }
        return try JSONDecoder().decode(HomeLink.SignIn.self, from: JSONSerialization.data(withJSONObject: claude))
    }

    private static func addressValue(_ model: AgentGuideModel) throws -> HomeLink.Pages.GuideValue {
        try XCTUnwrap(model.guide.steps.lazy.compactMap { step -> HomeLink.Pages.GuideValue? in
            switch step {
            case .add(_, _, _, let values, _, _): values.first(where: \.address)
            case .message(_, _, let value, _, _): value.address ? value : nil
            default: nil
            }
        }.first)
    }

    private static func address(_ seen: Any?) throws -> HomeLink.AgentAddress? {
        guard let seen = seen as? [String: Any], let state = seen["state"] as? String else { return nil }
        let written: [String: Any] = switch state {
        case "on": ["state": "on", "url": "https://macbook-pro-0001.tail0000.ts.net/mcp", "line": "on"]
        case "off": ["state": "off", "url": NSNull()]
        default: ["state": "fix", "url": NSNull(), "words": "fix",
                  "act": (seen["act"] as? String).map { ["label": "act", "to": $0, "url": NSNull()] as [String: Any] } ?? NSNull()]
        }
        return try JSONDecoder().decode(HomeLink.AgentAddress.self, from: JSONSerialization.data(withJSONObject: written))
    }

    private static func waiting(_ seen: Any?) -> [AgentGuideState.Waiting] {
        (seen as? [[String: Any]] ?? []).map { each in
            AgentGuideState.Waiting(id: each["id"] as? String ?? "", app: each["app"] as? String, host: each["host"] as? String,
                                    atMs: (each["at_ms"] as? NSNumber)?.int64Value ?? 0)
        }
    }

    private static func signIn(_ dialog: [String: Any]) -> AgentGuideState.SignInDialog {
        AgentGuideState.SignInDialog(copied: dialog["copied"] as? Bool ?? false, setup: dialog["setup"] as? Bool ?? false,
                                     returned: dialog["returned"] as? Bool ?? false, shown: dialog["shown"] as? String,
                                     outcome: (dialog["outcome"] as? String).flatMap(AgentGuideState.SignInDialog.Outcome.init(rawValue:)),
                                     editing: dialog["editing"] as? Bool ?? false)
    }

    private static func key(_ dialog: [String: Any]) -> AgentGuideState.KeyDialog {
        AgentGuideState.KeyDialog(linked: dialog["linked"] as? Bool ?? false, named: dialog["named"] as? String,
                                  setup: dialog["setup"] as? Bool ?? false, making: dialog["making"] as? Bool ?? false,
                                  made: (dialog["made"] as? String).flatMap(AgentGuideState.KeyDialog.Made.init(rawValue:)),
                                  done: dialog["done"] as? Bool ?? false)
    }

    private static func json(_ drawn: AgentGuideState.Drawn, signIn: Bool) -> NSDictionary {
        var state: [String: Any] = [
            "address": drawn.address?.rawValue ?? NSNull(),
            "head": drawn.head.rawValue,
            "marks": drawn.marks.map(\.rawValue),
            "shows": drawn.shows.map(\.rawValue),
            "lines": drawn.lines.map(\.rawValue),
            "foot": drawn.foot.map(\.rawValue),
        ]
        if signIn {
            state["signin"] = drawn.signin ?? NSNull()
            state["other"] = drawn.other ?? NSNull()
        }
        return state as NSDictionary
    }

    @MainActor final class Rounds {
        private var waiting: CheckedContinuation<Void, Never>?

        var resting: Bool { waiting != nil }

        func rest() async {
            await withCheckedContinuation { waiting = $0 }
        }

        func next() {
            let resting = waiting
            waiting = nil
            resting?.resume()
        }
    }

    @MainActor final class Proofs {
        private let pass: Bool
        private(set) var asked = 0

        init(pass: Bool) { self.pass = pass }

        func prove() -> Bool {
            asked += 1
            return pass
        }
    }
}
