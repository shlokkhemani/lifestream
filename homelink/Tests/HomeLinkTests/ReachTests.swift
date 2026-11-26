import Foundation
import XCTest
@testable import HomeLink

final class ReachTests: XCTestCase {
    private var folder: URL!
    private var clock: TestClock!
    private var pacer: ManualPacer!
    private let start = Date(timeIntervalSince1970: 1_792_000_000)
    private let phone = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil)
    private let mac = HomeLink.Device(kind: .mac, version: "0.2.0", model: "MacBook Pro", serial4: "0001")
    private let home = "https://lifestream.example.ts.net"

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-reach-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        clock = TestClock(start)
        pacer = ManualPacer(clock)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func paired(_ door: Door, device: HomeLink.Device? = nil, network: (any NetworkWatch)? = nil,
                        pairing: String = Fixture.paired(), grace: TimeInterval = HomeLink.grace) async throws -> (HomeLink, MemoryCredentials) {
        let credentials = MemoryCredentials()
        let device = device ?? phone
        _ = try await HomeLink(device: device, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, pairing)]),
                               clock: { [clock] in clock!.now })
            .pair(code: "12345678", name: home, account: device.kind == .phone ? Fixture.account : nil)
        return (link(door, device: device, network: network, credentials: credentials, grace: grace), credentials)
    }

    private func link(_ door: Door, device: HomeLink.Device, network: (any NetworkWatch)? = nil,
                      credentials: MemoryCredentials, grace: TimeInterval = HomeLink.grace) -> HomeLink {
        let link = HomeLink(device: device, credentials: credentials, folder: folder, transport: door, network: network,
                            clock: { [clock] in clock!.now }, pacer: pacer.pacer, grace: grace)
        link.probe { _ = try await $0.get("/v1/status") }
        return link
    }

    @discardableResult
    private func read(_ link: HomeLink, at path: String = "/v1/status") async -> HomeLink.RequestState? {
        do {
            _ = try await link.get(path)
            return nil
        } catch {
            return HomeLink.state(of: error, now: clock.now)
        }
    }

    private func act(_ link: HomeLink) async -> HomeLink.RequestState? {
        do {
            try await link.act(need: "disk", do: "try")
            return nil
        } catch {
            return HomeLink.state(of: error, now: clock.now)
        }
    }

    private func probe(after seconds: TimeInterval, _ link: HomeLink) async {
        pacer.pass(seconds)
        await link.probesEnded()
    }

    private static let held = #"{"code":"NOT_NOW","wait":"needs","message":"Your home is held The drive holding it went away.","title":"Your home is held","line":"The drive holding it went away.","acts":[{"do":"verify","label":"Check again"}]}"#
    private static let starting = #"{"code":"NOT_NOW","wait":"starting","message":"Your home is starting: it answers in a moment.","title":"Your home is starting","line":"It answers in a moment.","acts":[]}"#
    private static let preparing = #"{"code":"NOT_NOW","wait":"busy","message":"Your people are being prepared.","title":null,"line":null,"acts":[]}"#
    private static let said = HomeLink.Starting(title: "Your home is starting", line: "It answers in a moment.")
    private static let unknown = #"{"code":"OUTCOME_UNKNOWN","message":"Lifestream did not answer in time: it may have done it."}"#


    func testBeganBelongsToTheRequestSoOnlyAnAnswerOrARefusalEndsSaving() async throws {
        let (_, credentials) = try await paired(Door())
        let began = #"{"code":"OUTCOME_UNKNOWN","message":"Lifestream is still working on this.","again":true,"began":true}"#
        let none = #"{"code":"OUTCOME_UNKNOWN","message":"Lifestream didn't answer.","again":true,"began":false}"#
        let busy = #"{"code":"NOT_NOW","wait":"busy","message":"Not saved: Lifestream is busy.","acts":[]}"#
        let rows: [(second: ScriptedTransport.Step, state: HomeLink.RequestState?, why: String)] = [
            (.reply(503, none), .saving, "the resend heard no line while the first copy still runs"),
            (.reply(503, busy), .saving, "a later copy refused busy says nothing of the copy that began"),
            (.reply(503, Self.starting), .saving, "nor a later starting"),
            (.unreachable, .saving, "nor a resend whose connection fell"),
            (.reply(200, #"{"act":"a-2","id":"person:a","position":"2:1800000000000"}"#), nil, "an answer ends it"),
            (.reply(409, #"{"code":"NOT_OFFERED","message":"That suggestion is no longer offered."}"#),
             .refused("That suggestion is no longer offered."), "a refusal that is not NOT_NOW ends it"),
        ]
        for row in rows {
            let transport = ScriptedTransport([.reply(503, began), row.second])
            let state = await acted(transport, credentials: credentials) { _ = try await $0.act(.people(request: "r-1", .undo(act: "a-1"))) }
            XCTAssertEqual(state, row.state, row.why)
            XCTAssertEqual(transport.requests.map(\.url.path), ["/v1/owner/act", "/v1/owner/act"], "\(row.why): two sends, no more")
            XCTAssertEqual(transport.requests[0].body, transport.requests[1].body, "the same request")
        }
        let saving = await acted(ScriptedTransport([.reply(503, began)]), credentials: credentials) {
            _ = try await $0.act(.people(request: "r-1", .undo(act: "a-1")))
        }
        XCTAssertEqual(saving.flatMap(ReachWords.act), .saving)

        let unheard = ScriptedTransport([.reply(503, none)])
        let unknown = await acted(unheard, credentials: credentials) { _ = try await $0.act(.people(request: "r-1", .undo(act: "a-1"))) }
        XCTAssertEqual(unknown, .unknown(ReachWords.unknown), "sent twice, no copy heard to begin: not known whether saved")
        XCTAssertEqual(unheard.requests.count, 2)

        let once = ScriptedTransport([.reply(503, #"{"code":"OUTCOME_UNKNOWN","message":"Lifestream is still working on this.","again":false,"began":true}"#)])
        let done = await acted(once, credentials: credentials) { try await $0.act(need: "disk", do: "try") }
        XCTAssertEqual(done, .unknown(ReachWords.unknownDone), "begun on a route without again: never Still saving")
        XCTAssertEqual(done.flatMap(ReachWords.act), .unknown(ReachWords.unknownDone))
        XCTAssertEqual(once.requests.count, 1, "it cannot be sent again safely")
    }

    private func acted(_ transport: ScriptedTransport, credentials: MemoryCredentials,
                       _ act: (HomeLink) async throws -> Void) async -> HomeLink.RequestState? {
        let link = HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport,
                            clock: { [clock] in clock!.now }, pacer: pacer.pacer)
        do {
            try await act(link)
            return nil
        } catch {
            return HomeLink.state(of: error, now: clock.now)
        }
    }

    func testEachOutcomeMovesReachAndSaysItsRequestsStateByOneTable() async throws {
        struct Row {
            let reply: Door.Answer
            let said: String
            let state: HomeLink.RequestState?
            let moves: Bool
        }
        let at = { (seconds: TimeInterval) in self.start.addingTimeInterval(seconds) }
        let rows: [Row] = [
            Row(reply: .reply(200, "{}", [:]), said: "answering r0", state: nil, moves: true),
            Row(reply: .reply(426, #"{"code":"DEVICE_TOO_OLD","message":"update","floor":"2.0.0"}"#, [:]), said: "update device 2.0.0",
                state: .reach, moves: true),
            Row(reply: .reply(401, #"{"code":"PRINCIPAL_UNKNOWN","message":"no"}"#, [:]), said: "pass refused", state: .reach, moves: true),
            Row(reply: .silent, said: "waiting 4 r0", state: .reach, moves: false),
            Row(reply: .reply(503, Self.held, [:]), said: "held Your home is held", state: .reach, moves: false),
            Row(reply: .reply(503, Self.starting, ["Retry-After": "5"]), said: "starting 6 r0", state: .reach, moves: false),
            Row(reply: .reply(503, Self.preparing, ["Retry-After": "5"]), said: "answering r0",
                state: .wait(words: "Your people are being prepared.", until: at(7 + 5)), moves: true),
            Row(reply: .reply(503, Self.unknown, [:]), said: "answering r0", state: .unknown(ReachWords.unknownDone), moves: true),
            Row(reply: .reply(503, #"{"code":"INDEX_BUSY","message":"Your home is building its index."}"#, ["Retry-After": "5"]),
                said: "answering r0", state: .wait(words: "Your home is building its index.", until: at(9 + 5)), moves: true),
            Row(reply: .reply(503, #"{"code":"DISK_LOW","message":"12 bytes free, 40 taken"}"#, ["Retry-After": "300"]),
                said: "answering r0", state: .wait(words: "Waiting for space on Lifestream's disk", until: at(10 + 300)), moves: true),
            Row(reply: .reply(503, #"{"code":"HOME_FAILED","message":"it failed"}"#, [:]), said: "answering r0", state: .failed, moves: true),
            Row(reply: .reply(500, "", [:]), said: "answering r0", state: .failed, moves: true),
            Row(reply: .reply(422, #"{"code":"NOT_A_DAY","message":"That isn't a day."}"#, [:]), said: "answering r0",
                state: .refused("That isn't a day."), moves: true),
        ]
        for (index, row) in rows.enumerated() {
            let door = Door()
            let (link, _) = try await paired(door)
            clock.advance(1)
            let before = link.snapshot.lastReached
            door.answers(row.reply)
            let state = await read(link)
            await link.probesEnded()
            XCTAssertEqual(Said.of(link.snapshot, from: start), row.said, "row \(index)")
            XCTAssertEqual(state, row.state, "row \(index)")
            XCTAssertEqual(link.snapshot.lastReached, row.moves ? clock.now : before, "row \(index): the clock")
        }

        let door = Door()
        let (link, _) = try await paired(door)
        try link.forget()
        let state = await read(link)
        XCTAssertEqual(state, .reach)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "unpaired")
        XCTAssertEqual(door.requests, 0)

        XCTAssertNil(HomeLink.state(of: CancellationError(), now: start))
        XCTAssertNil(HomeLink.state(of: LinkFailure.credentials, now: start))
        XCTAssertNil(HomeLink.state(of: LinkFailure.unusableID, now: start))
        XCTAssertNil(HomeLink.state(of: URLError(.badURL), now: start))
        XCTAssertEqual(HomeLink.state(of: LinkFailure.clockAhead, now: start), .refused(LinkFailure.clockAhead.description))
        let hold = HomeLink.Held(title: "Your home is held", detail: "The drive holding it went away.", acts: [])
        XCTAssertEqual(HomeLink.state(of: LinkFailure.unavailable(code: "NOT_NOW", message: "Your home is held", retryAfter: 60, notNow: .needs(hold)),
                                      now: start), .reach, "a wait on the person is the home's, wherever it is met")
        XCTAssertEqual(HomeLink.state(of: LinkFailure.unavailable(code: "NOT_NOW", message: "starting", retryAfter: 5, notNow: .starting(Self.said)),
                                      now: start), .reach, "a start is the home's: the strip says it")
        XCTAssertEqual(HomeLink.state(of: LinkFailure.unavailable(code: "NOT_NOW", message: "Your people are being prepared.", retryAfter: 5, notNow: .busy),
                                      now: start), .wait(words: "Your people are being prepared.", until: at(5)))

        XCTAssertEqual(HomeLink.state(status: 503, code: "NOT_NOW", words: "starting", retryAfter: 5, notNow: .busy, now: start),
                       .wait(words: "starting", until: at(5)), "a request's own not-now is its wait")
        XCTAssertEqual(HomeLink.state(status: 503, code: "NOT_NOW", words: nil, retryAfter: nil, now: start),
                       .wait(words: ReachWords.waiting, until: at(HomeLink.probeEvery)))
        XCTAssertEqual(HomeLink.state(status: 503, code: "NOT_NOW", words: "held", retryAfter: 60, notNow: .needs(hold), now: start), .reach)
        XCTAssertEqual(HomeLink.state(status: 503, code: "INDEX_BUSY", words: "busy", retryAfter: 5, now: start),
                       .wait(words: "busy", until: at(5)))
        XCTAssertEqual(HomeLink.state(status: 503, code: "MEANING_NOT_NOW", words: nil, retryAfter: nil, now: start),
                       .wait(words: ReachWords.waiting, until: at(HomeLink.probeEvery)))
        XCTAssertEqual(HomeLink.state(status: 503, code: "ASK_DOWN", words: "Ask is not answering (ECONNREFUSED)", retryAfter: 5, now: start),
                       .wait(words: "Chat isn't answering on your Mac", until: at(5)), "the door's raw words are no person's")
        XCTAssertEqual(HomeLink.state(status: 500, code: "HOME_FAILED", words: "it failed", retryAfter: nil, now: start), .failed)
        XCTAssertEqual(HomeLink.state(status: 503, code: nil, words: nil, retryAfter: nil, now: start), .failed)
        XCTAssertEqual(HomeLink.state(status: 502, code: "BAD_GATEWAY", words: nil, retryAfter: nil, now: start), .failed)
        XCTAssertEqual(HomeLink.state(status: 403, code: "PRINCIPAL_SCOPE", words: "Not from this device.", retryAfter: nil, now: start),
                       .refused("Not from this device."))
        XCTAssertEqual(HomeLink.state(status: 401, code: "PRINCIPAL_UNKNOWN", words: "no", retryAfter: nil, now: start), .reach)
        XCTAssertEqual(HomeLink.state(status: 426, code: nil, words: nil, retryAfter: nil, now: start), .reach)
    }


    func testATooOldHomesAnswerIsNeedsUpdateWithNoAnsweringFirstAndMovesTheClock() async throws {
        let stamped = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil, stamp: 500)
        let checkout = #"{"unit":"iphone-17-pro-0042","answer":"# + Self.answer(version: "checkout", generation: nil) + "}"
        let door = Door()
        let (link, _) = try await paired(door, device: stamped, pairing: checkout)
        let seen = Recorder(link, from: start)

        clock.advance(1)
        door.answers(.reply(200, Self.answer(version: "4f2a9c1", generation: 400), [:]))
        do {
            _ = try await link.exchange()
            XCTFail("a home older than the stamp was answered")
        } catch {
            XCTAssertEqual(HomeLink.state(of: error, now: clock.now), .reach)
        }
        XCTAssertEqual(link.snapshot.lastReached, clock.now, "the home answered")

        clock.advance(1)
        let asked = door.requests
        let state = await read(link)
        XCTAssertEqual(state, .reach)
        XCTAssertEqual(door.requests, asked)
        XCTAssertEqual(link.snapshot.lastReached, clock.now.addingTimeInterval(-1))

        door.answers(.reply(200, Self.answer(version: "5a0b1c2", generation: 600), [:]))
        _ = try await link.exchange()
        await fulfillment(of: [seen.count(3)], timeout: 30)
        XCTAssertEqual(seen.said, ["answering r0", "update home", "answering r1"], "never answering between")
    }

    private static func answer(version: String, generation: Int?) -> String {
        Fixture.answer(received: 1, imported: 0).replacingOccurrences(
            of: #""version":"0.2.0""#, with: #""version":"\#(version)""# + (generation.map { #","generation":\#($0)"# } ?? ""))
    }


    private static let chat = #"{"type":"chat","chat":"1792396847000-3fa9c2","n":4}"#
    private static let text = #"{"type":"text","delta":"You were"}"#
    private static let done = #"{"type":"done","message":{"chat":"1792396847000-3fa9c2","n":4,"at_ms":1792396861000,"role":"assistant","text":"You were","end":"done"}}"#
    private static let cannotBegin = #"{"type":"error","error":"login","message":"Chat needs your Claude sign-in on your Mac."}"#

    private func events(_ stream: AsyncThrowingStream<HomeLink.Ask.Event, Error>) async throws {
        for try await _ in stream {}
    }

    func testAStreamThatDropsAfterItsHeadersIsSilentAndOneThatEndsWellAnswersOnce() async throws {
        let door = Door()
        let (link, _) = try await paired(door)
        let seen = Recorder(link, from: start)

        door.answers(.lines([Self.chat, Self.text], drops: true))
        let cut = try await link.ask("Where was I?", level: nil, pick: nil)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "answering r0", "the headers alone observe nothing")
        do {
            try await events(cut)
            XCTFail("a turn cut after its headers read whole")
        } catch {
            XCTAssertEqual(error as? LinkFailure, .noAnswer(sent: true))
        }
        XCTAssertEqual(Said.of(link.snapshot, from: start), "waiting 0 r0")

        clock.advance(2)
        door.answers(.lines([Self.chat, Self.text, Self.done], drops: false))
        try await events(try await link.ask("Where was I?", level: nil, pick: nil))
        XCTAssertEqual(link.snapshot.lastReached, clock.now)

        door.answers(.silent)
        await read(link)
        clock.advance(2)
        door.answers(.lines([Self.cannotBegin], drops: false))
        try await events(try await link.ask("Where was I?", level: nil, pick: nil))
        XCTAssertEqual(link.snapshot.lastReached, clock.now)

        door.answers(.silent)
        await read(link)
        clock.advance(2)
        door.answers(.reply(204, "", [:]))
        let none = try await link.follow(chat: "1792396847000-3fa9c2")
        XCTAssertNil(none)
        XCTAssertEqual(link.snapshot.lastReached, clock.now)

        await fulfillment(of: [seen.count(7)], timeout: 30)
        XCTAssertEqual(seen.said, ["answering r0", "waiting 0 r0", "answering r1", "waiting 2 r1", "answering r2", "waiting 4 r2",
                                   "answering r3"])
    }

    func testAStreamedNotNowIsTheHomeStartingInTheDoorsWords() async throws {
        let door = Door()
        let (link, _) = try await paired(door)
        door.answers(.reply(503, Self.starting, ["Retry-After": "5"]))
        do {
            _ = try await link.ask("Where was I?", level: nil, pick: nil)
            XCTFail("a not-now read as a turn")
        } catch {
            XCTAssertEqual(HomeLink.state(of: error, now: clock.now),
                           .reach, "a start is the home's: the strip says it")
        }
        await link.probesEnded()
        XCTAssertEqual(door.requests, 2)
        XCTAssertEqual(link.snapshot.reach, .starting(Self.said, since: start))
        await probe(after: 10, link)
        await probe(after: 10, link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "starting 0 r0", "past the grace too: the door answers")
        XCTAssertEqual(link.snapshot.lastReached, start, "a not-now moves no clock")
    }


    func testALateUncertainActIsUnknownNeverNotSent() async throws {
        let door = Door()
        let (link, _) = try await paired(door)
        let seen = Recorder(link, from: start)
        let arrived = door.holdNext()
        let late = Task { await act(link) }
        await fulfillment(of: [arrived], timeout: 30)

        door.answers(.silent)
        await read(link)
        door.answers(.reply(200, "{}", [:]))
        await read(link)
        XCTAssertEqual(link.snapshot.revision, 1)

        door.answers(.reply(503, Self.unknown, [:]))
        door.release()
        let state = await late.value
        XCTAssertEqual(state, .unknown(ReachWords.unknownDone))
        XCTAssertEqual(state.flatMap(ReachWords.act), .unknown(ReachWords.unknownDone))
        await fulfillment(of: [seen.count(3)], timeout: 30)
        XCTAssertEqual(seen.said, ["answering r0", "waiting 0 r0", "answering r1"])
        XCTAssertEqual(Said.of(link.snapshot, from: start), "answering r1")
    }


    func testADoorRestartInsideTheGraceIsNeverSaid() async throws {
        let door = Door()
        let (link, _) = try await paired(door)
        let seen = Recorder(link, from: start)
        door.answers(.silent)
        await read(link)
        await probe(after: 10, link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "waiting 0 r0", "a probe at 10 s fails inside the grace")
        clock.advance(5)
        door.answers(.reply(200, "{}", [:]))
        await read(link)
        await probe(after: 10, link)
        await fulfillment(of: [seen.count(3)], timeout: 30)
        XCTAssertEqual(seen.said, ["answering r0", "waiting 0 r0", "answering r1"])
        XCTAssertEqual(door.requests, 3, "no probe once it answers")
    }

    func testOneLostRequestIsSaidOnlyThroughAProbeThatFailsPastTheGrace() async throws {
        let door = Door()
        let (link, _) = try await paired(door)
        let seen = Recorder(link, from: start)
        door.answers(.silent)
        await read(link)
        let probing = door.holdNext()
        pacer.pass(10)
        await fulfillment(of: [probing], timeout: 30)
        pacer.pass(15)
        await read(link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "waiting 0 r0", "past the grace, but no probe has failed")
        door.release()
        await link.probesEnded()
        await fulfillment(of: [seen.count(3)], timeout: 30)
        XCTAssertEqual(seen.said, ["answering r0", "waiting 0 r0", "unreachable silent 0"])
        let pressed = await act(link)
        XCTAssertEqual(pressed.flatMap(ReachWords.act), .notSent)
    }


    func testTheNetworksCauseIsSaidAtOnceAndARoadBackAsksOneProbe() async throws {
        let door = Door()
        let network = MovableNetwork(.offline)
        let (link, _) = try await paired(door, network: network)
        let seen = Recorder(link, from: start)
        await fulfillment(of: [seen.count(2)], timeout: 30)
        XCTAssertEqual(seen.said, ["answering r0", "unreachable offline 0"])
        XCTAssertEqual(door.requests, 0, "no request was asked")

        door.answers(.silent)
        clock.advance(30)
        let probed = door.arrived(1)
        network.set(.home)
        await fulfillment(of: [probed], timeout: 30)
        await link.probesEnded()
        await fulfillment(of: [seen.count(3)], timeout: 30)
        XCTAssertEqual(seen.said, ["answering r0", "unreachable offline 0", "unreachable silent 0"], "since kept")
        XCTAssertEqual(door.requests, 1)
    }

    func testLosingTheRoadWhileHeldNeedingAnUpdateOrRefusedSaysTheNetworkThenThatStateAgain() async throws {
        let replies: [(Door.Answer, String)] = [
            (.reply(503, Self.held, [:]), "held Your home is held"),
            (.reply(426, #"{"code":"DEVICE_TOO_OLD","floor":"2.0.0"}"#, [:]), "update device 2.0.0"),
            (.reply(401, #"{"code":"PRINCIPAL_UNKNOWN","message":"no"}"#, [:]), "pass refused"),
        ]
        for (reply, said) in replies {
            let door = Door()
            let network = MovableNetwork(.home)
            let (link, _) = try await paired(door, network: network)
            let seen = Recorder(link, from: start)
            door.answers(reply)
            await read(link)
            clock.advance(1)
            let gone = Int(clock.now.timeIntervalSince(start))
            network.set(.offline)
            await fulfillment(of: [seen.count(3)], timeout: 30)
            let probed = door.arrived(2)
            network.set(.home)
            await fulfillment(of: [probed], timeout: 30)
            await link.probesEnded()
            await fulfillment(of: [seen.count(4)], timeout: 30)
            XCTAssertEqual(seen.said, ["answering r0", said, "unreachable offline \(gone)", said])
        }
    }


    func testARequestThatSpannedATripSaysNothingAndAReadIsAskedAgain() async throws {
        let door = Door()
        let (link, _) = try await paired(door)
        let seen = Recorder(link, from: start)

        var arrived = door.holdNext()
        let pressed = Task { await act(link) }
        await fulfillment(of: [arrived], timeout: 30)
        link.inFront(false)
        door.release(answering: .silent)
        let state = await pressed.value
        XCTAssertEqual(state, .reach)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "answering r0")
        XCTAssertEqual(door.requests, 1)

        link.inFront(true)
        arrived = door.holdNext()
        let reading = Task { await read(link) }
        await fulfillment(of: [arrived], timeout: 30)
        link.inFront(false)
        door.answers(.reply(200, "{}", [:]))
        door.release(answering: .silent)
        let read = await reading.value
        XCTAssertEqual(door.requests, 3)
        XCTAssertNil(read, "asked again, and answered")

        door.answers(.silent)
        link.inFront(true)
        await self.read(link)
        link.inFront(false)
        let probed = door.arrived(5)
        link.inFront(true)
        await fulfillment(of: [probed], timeout: 30)
        await link.probesEnded()
        await fulfillment(of: [seen.count(2)], timeout: 30)
        XCTAssertEqual(seen.said, ["answering r0", "waiting 0 r0"])
    }

    func testALateFailureFromBeforeAHealOpensNoEpisode() async throws {
        let door = Door()
        let (link, _) = try await paired(door)
        let seen = Recorder(link, from: start)
        let arrived = door.holdNext()
        let late = Task { await act(link) }
        await fulfillment(of: [arrived], timeout: 30)
        door.answers(.silent)
        await read(link)
        door.answers(.reply(200, "{}", [:]))
        await probe(after: 10, link)
        door.answers(.silent)
        door.release()
        _ = await late.value
        await fulfillment(of: [seen.count(3)], timeout: 30)
        XCTAssertEqual(seen.said, ["answering r0", "waiting 0 r0", "answering r1"])
        XCTAssertEqual(Said.of(link.snapshot, from: start), "answering r1")
    }

    func testALateAnswerNeverHealsAnEpisodeItPredatesButMovesTheClock() async throws {
        let door = Door()
        let network = MovableNetwork(.home)
        let (link, _) = try await paired(door, network: network)
        let seen = Recorder(link, from: start)
        let arrived = door.holdNext()
        let late = Task { await act(link) }
        await fulfillment(of: [arrived], timeout: 30)
        network.set(.offline)
        await fulfillment(of: [seen.count(2)], timeout: 30)
        clock.advance(3)
        door.answers(.reply(200, "{}", [:]))
        door.release()
        _ = await late.value
        XCTAssertEqual(Said.of(link.snapshot, from: start), "unreachable offline 0")
        XCTAssertEqual(link.snapshot.lastReached, clock.now, "it still moves when the home last answered")
        await fulfillment(of: [seen.count(3)], timeout: 30)
        XCTAssertEqual(seen.said, ["answering r0", "unreachable offline 0", "unreachable offline 0"], "only its clock moved")
    }


    func testForgetDeletesReachAndDropsTheOldPairingsFailures() async throws {
        let door = Door()
        let (link, _) = try await paired(door)
        let file = folder.appendingPathComponent("reach.json")
        clock.advance(1)
        await read(link)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))

        let arrived = door.holdNext()
        let late = Task { await act(link) }
        await fulfillment(of: [arrived], timeout: 30)
        try link.forget()
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertEqual(link.snapshot, HomeLink.ReachSnapshot(reach: .unpaired, lastReached: nil, revision: 0))

        door.answers(.reply(200, Fixture.paired(), [:]))
        _ = try await link.pair(code: "12345678", name: home, account: Fixture.account)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "answering r1")
        door.answers(.silent)
        door.release()
        _ = await late.value
        XCTAssertEqual(Said.of(link.snapshot, from: start), "answering r1", "the old pairing's silence is dropped")
    }


    func testAnOutcomeUnknownAndABusyIndexAreTheHomeAnswering() async throws {
        let door = Door()
        let (link, _) = try await paired(door)
        door.answers(.reply(503, Self.unknown, [:]))
        let unknown = await act(link)
        XCTAssertEqual(unknown, .unknown(ReachWords.unknownDone))
        door.answers(.reply(503, #"{"code":"INDEX_BUSY","message":"Your home is building its index."}"#, ["Retry-After": "5"]))
        let busy = await read(link)
        XCTAssertEqual(busy, .wait(words: "Your home is building its index.", until: clock.now.addingTimeInterval(5)))
        XCTAssertEqual(busy.flatMap(ReachWords.act), .refused("Your home is building its index."), "an act never retries itself")
        XCTAssertEqual(Said.of(link.snapshot, from: start), "answering r0")
        XCTAssertEqual(link.snapshot.lastReached, clock.now)
    }


    func testLastReachedIsWrittenOnceAMinuteMovedByRefusalsNotByANotNowAndReadBack() async throws {
        let door = Door()
        let (link, credentials) = try await paired(door)
        door.answers(.reply(200, "{}", [:]))
        for _ in 0..<100 {
            clock.advance(0.5)
            await read(link)
        }
        XCTAssertEqual(link.reachWrites, 1, "100 answers within a minute are one write")
        XCTAssertEqual(link.snapshot.lastReached, clock.now)

        clock.advance(1)
        door.answers(.reply(401, #"{"code":"PRINCIPAL_UNKNOWN","message":"no"}"#, [:]))
        await read(link)
        XCTAssertEqual(link.snapshot.lastReached, clock.now, "a refused pass is the home answering")
        clock.advance(1)
        door.answers(.reply(426, #"{"code":"DEVICE_TOO_OLD","floor":"2.0.0"}"#, [:]))
        await read(link)
        let answered = clock.now
        XCTAssertEqual(link.snapshot.lastReached, answered, "so is a floor")
        clock.advance(1)
        door.answers(.reply(503, Self.starting, [:]))
        await read(link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "update device 2.0.0", "a read's not-now joins the probe due")
        await probe(after: HomeLink.probeEvery, link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "starting 63 r0", "the probe due meets it: the home's")
        XCTAssertEqual(link.snapshot.lastReached, answered, "a not-now is the door saying the home may not answer")
        XCTAssertEqual(link.reachWrites, 4, "each change of state writes")

        let relaunched = self.link(Door(), device: phone, credentials: credentials)
        XCTAssertEqual(relaunched.snapshot.lastReached, answered)
    }


    func testTheMacsDeployRaisesNoBanner() async throws {
        let door = Door()
        let (link, _) = try await paired(door, device: mac)
        let seen = Recorder(link, from: start)
        let gate = Gate()
        let heal = Task { await link.restarting { await gate.pass() } }
        await fulfillment(of: [gate.entered], timeout: 30)
        door.answers(.reply(503, Self.starting, ["Retry-After": "5"]))
        await read(link)
        await link.probesEnded()
        for _ in 0..<6 { await probe(after: 10, link) }
        gate.open()
        await heal.value
        for _ in 0..<7 { await probe(after: 10, link) }
        XCTAssertEqual(clock.now, start.addingTimeInterval(130))
        door.answers(.reply(200, "{}", [:]))
        await read(link)
        await fulfillment(of: [seen.count(3)], timeout: 30)
        XCTAssertEqual(seen.said, ["answering r0", "starting 0 r0", "answering r1"], "starting, never unreachable")
    }

    func testAFailedHealEndsTheMarkAndTheGraceRunsFromIt() async throws {
        let door = Door()
        let (link, _) = try await paired(door, device: mac)
        let gate = Gate()
        struct Refused: Error {}
        let heal = Task { try await link.restarting { await gate.pass(); throw Refused() } }
        await fulfillment(of: [gate.entered], timeout: 30)
        door.answers(.silent)
        await read(link)
        for _ in 0..<4 { await probe(after: 10, link) }
        XCTAssertEqual(Said.of(link.snapshot, from: start), "waiting 0 r0", "marked")
        gate.open()
        do {
            try await heal.value
            XCTFail("a failed heal returned")
        } catch {}
        XCTAssertEqual(Said.of(link.snapshot, from: start), "waiting 40 r0")
        await probe(after: 10, link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "waiting 40 r0")
        await probe(after: 10, link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "unreachable silent 40")
    }

    func testACancelledHealEndsTheMarkAsItIsCancelledItsBodyStillRunning() async throws {
        let door = Door()
        let (link, _) = try await paired(door, device: mac)
        let gate = Gate()
        let heal = Task { await link.restarting { await gate.pass() } }
        await fulfillment(of: [gate.entered], timeout: 30)
        door.answers(.silent)
        await read(link)
        for _ in 0..<4 { await probe(after: 10, link) }
        heal.cancel()
        XCTAssertEqual(Said.of(link.snapshot, from: start), "waiting 40 r0", "the mark ends at the cancel, not when its body returns")
        await probe(after: 10, link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "waiting 40 r0")
        await probe(after: 10, link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "unreachable silent 40")
        gate.open()
        await heal.value
        XCTAssertEqual(Said.of(link.snapshot, from: start), "unreachable silent 40", "its body's late return marks nothing")
    }

    func testTheMarkEndsAtItsBoundAndARelaunchHasNone() async throws {
        let door = Door()
        let (link, credentials) = try await paired(door, device: mac)
        let gate = Gate()
        let heal = Task { await link.restarting { await gate.pass() } }
        await fulfillment(of: [gate.entered], timeout: 30)
        door.answers(.silent)
        await read(link)
        for _ in 0..<18 { await probe(after: 10, link) }
        XCTAssertEqual(Said.of(link.snapshot, from: start), "waiting 180 r0", "the bound ends the mark, since the bound")
        await probe(after: 10, link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "waiting 180 r0")
        await probe(after: 10, link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "unreachable silent 180")
        gate.open()
        await heal.value

        let relaunched = self.link(door, device: mac, credentials: credentials)
        let at = clock.now
        await read(relaunched)
        await probe(after: 10, relaunched)
        await probe(after: 10, relaunched)
        XCTAssertEqual(Said.of(relaunched.snapshot, from: start), "unreachable silent \(Int(at.timeIntervalSince(start)))", "no mark")
    }


    func testProbesAskedTogetherAreOneRequest() async throws {
        let door = Door()
        let (link, _) = try await paired(door, device: mac)
        door.answers(.silent)
        let arrived = door.holdNext()
        async let first = link.probeSoon()
        await fulfillment(of: [arrived], timeout: 30)
        async let second = link.probeSoon()
        door.release()
        let (one, other) = await (first, second)
        XCTAssertEqual(door.requests, 1)
        XCTAssertEqual(one, other)
        XCTAssertEqual(Said.of(one, from: start), "waiting 0 r0", "the probe's own silence opens the wait")
    }

    func testAskingSoonJoinsTheDueProbeAndNeverSendsBeforeTheDoorsTime() async throws {
        let door = Door()
        let (link, _) = try await paired(door, device: mac)
        door.answers(.reply(503, Self.starting, ["Retry-After": "300"]))
        await link.probeSoon()
        pacer.pass(2)
        let first = try XCTUnwrap(link.joinProbe())
        pacer.pass(2)
        let second = try XCTUnwrap(link.joinProbe())
        await link.probesEnded()
        XCTAssertEqual(door.requests, 1, "nothing is sent before the door's time")
        door.answers(.reply(200, "{}", [:]))
        pacer.pass(296)
        await first.value
        await second.value
        XCTAssertEqual(door.requests, 2, "the asks and the due probe are one request, at 300 s")
        XCTAssertEqual(Said.of(link.snapshot, from: start), "answering r1")
    }


    func testEnteringHeldAnUpdateOrARefusedPassProbesAtItsTimeUntilTheHomeAnswers() async throws {
        let replies: [(Door.Answer, String, TimeInterval)] = [
            (.reply(503, Self.held, ["Retry-After": "30"]), "held Your home is held", 30),
            (.reply(426, #"{"code":"DEVICE_TOO_OLD","floor":"2.0.0"}"#, [:]), "update device 2.0.0", HomeLink.probeEvery),
            (.reply(401, #"{"code":"PRINCIPAL_UNKNOWN","message":"no"}"#, [:]), "pass refused", HomeLink.probeEvery),
        ]
        for (reply, said, due) in replies {
            let door = Door()
            let (link, _) = try await paired(door)
            let seen = Recorder(link, from: start)
            door.answers(reply)
            await read(link)
            door.answers(.reply(200, "{}", [:]))
            await probe(after: due - 1, link)
            XCTAssertEqual(door.requests, 1, "\(said): no probe before \(Int(due)) s")
            await probe(after: 1, link)
            XCTAssertEqual(door.requests, 2, "\(said): one probe at \(Int(due)) s")
            await fulfillment(of: [seen.count(3)], timeout: 30)
            XCTAssertEqual(seen.said, ["answering r0", said, "answering r1"])
        }
    }


    func testEveryMoveOfTheClockIsToldWhileTheDiskIsWrittenOnceAMinute() async throws {
        let door = Door()
        let (link, _) = try await paired(door)
        let seen = Recorder(link, from: start)
        for _ in 0..<3 {
            clock.advance(5)
            await read(link)
        }
        await fulfillment(of: [seen.count(4)], timeout: 30)
        XCTAssertEqual(seen.said, ["answering r0", "answering r0", "answering r0", "answering r0"])
        XCTAssertEqual(seen.reached, [0, 5, 10, 15].map { Optional(start.addingTimeInterval($0)) })
        XCTAssertEqual(link.reachWrites, 1)
    }


    func testAProbeThatSpannedATripSaysNothing() async throws {
        let door = Door()
        let (link, _) = try await paired(door)
        door.answers(.silent)
        await read(link)
        let probing = door.holdNext()
        pacer.pass(10)
        await fulfillment(of: [probing], timeout: 30)
        pacer.pass(5)
        link.inFront(false)
        pacer.pass(10)
        door.release()
        await link.probesEnded()
        XCTAssertEqual(Said.of(link.snapshot, from: start), "waiting 0 r0", "a probe begun before the trip fails nothing")
    }

    func testForgetDetachesTheOldPairingsProbe() async throws {
        let door = Door()
        let (link, _) = try await paired(door)
        door.answers(.silent)
        await read(link)
        let probing = door.holdNext()
        pacer.pass(10)
        await fulfillment(of: [probing], timeout: 30)
        let old = try XCTUnwrap(link.reachBox.lock.withLock { link.reachBox.probe?.task })

        try link.forget()
        door.answers(.reply(200, Fixture.paired(), [:]))
        _ = try await link.pair(code: "12345678", name: home, account: Fixture.account)
        door.answers(.silent)
        await read(link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "waiting 10 r1")
        door.answers(.reply(200, "{}", [:]))
        let joined = try XCTUnwrap(link.joinProbe())
        pacer.pass(10)
        await joined.value
        XCTAssertEqual(door.requests, 5, "the new pairing's probe reached the door while the old one's was held")
        XCTAssertEqual(Said.of(link.snapshot, from: start), "answering r2")

        door.answers(.silent)
        door.release()
        await old.value
        XCTAssertEqual(Said.of(link.snapshot, from: start), "answering r2", "the old probe's end says nothing")
        XCTAssertNil(link.reachBox.lock.withLock { link.reachBox.probe }, "nor touches the new pairing's probes")
    }

    func testForgetEndsTheOldPairingsMark() async throws {
        let door = Door()
        let (link, _) = try await paired(door, device: mac)
        let gate = Gate()
        let heal = Task { await link.restarting { await gate.pass() } }
        await fulfillment(of: [gate.entered], timeout: 30)
        try link.forget()
        door.answers(.reply(200, Fixture.paired(), [:]))
        _ = try await link.pair(code: "12345678", name: home, account: nil)
        door.answers(.silent)
        await read(link)
        await probe(after: 10, link)
        await probe(after: 10, link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "unreachable silent 0", "no mark of the old pairing holds the wait")
        gate.open()
        await heal.value
    }


    func testALateHeldUpdateOrRefusedReplyNeverReplacesTheNetworksCause() async throws {
        let replies: [(Door.Answer, String)] = [
            (.reply(503, Self.held, [:]), "held"),
            (.reply(426, #"{"code":"DEVICE_TOO_OLD","floor":"2.0.0"}"#, [:]), "update"),
            (.reply(401, #"{"code":"PRINCIPAL_UNKNOWN","message":"no"}"#, [:]), "pass refused"),
        ]
        for (reply, name) in replies {
            let door = Door()
            let network = MovableNetwork(.home)
            let (link, _) = try await paired(door, network: network)
            let seen = Recorder(link, from: start)
            let arrived = door.holdNext()
            let reading = Task { await read(link) }
            await fulfillment(of: [arrived], timeout: 30)
            clock.advance(1)
            let gone = Int(clock.now.timeIntervalSince(start))
            network.set(.offline)
            await fulfillment(of: [seen.count(2)], timeout: 30)
            door.release(answering: reply)
            _ = await reading.value
            XCTAssertEqual(Said.of(link.snapshot, from: start), "unreachable offline \(gone)", name)
        }
    }


    func testARequestsOwnNotNowIsItsWaitAndNoNewsOfReach() async throws {
        let door = Door()
        let (link, _) = try await paired(door)
        door.answers(.reply(503, Self.preparing, ["Retry-After": "5"]), at: "/v1/people")
        let state = await read(link, at: "/v1/people")
        XCTAssertEqual(state, .wait(words: "Your people are being prepared.", until: clock.now.addingTimeInterval(5)))
        await link.probesEnded()
        XCTAssertEqual(door.requests(at: "/v1/status"), 0, "a request's own wait asks no probe")
        XCTAssertEqual(Said.of(link.snapshot, from: start), "answering r0", "reach never left answering")
        XCTAssertEqual(link.snapshot.lastReached, clock.now, "the home answered: the clock moved")

        pacer.pass(5)
        door.answers(.reply(200, "{}", [:]), at: "/v1/people")
        let again = await read(link, at: "/v1/people")
        XCTAssertNil(again)
        await link.probesEnded()
        XCTAssertEqual(door.requests(at: "/v1/status"), 0)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "answering r0")
    }

    func testAWaitOnThePersonIsNeverAStart() async throws {
        let door = Door()
        let (link, _) = try await paired(door)
        let away = #"{"code":"NOT_NOW","wait":"needs","message":"The home's folder is not there","title":"Your home's folder isn't there","line":"Lifestream waits for it. If it's on a drive, connect the drive.","acts":[]}"#
        door.answers(.reply(503, away, ["Retry-After": "60"]))
        await link.probeSoon()
        XCTAssertEqual(link.snapshot.reach, .held(HomeLink.Held(title: "Your home's folder isn't there",
                                                                detail: "Lifestream waits for it. If it's on a drive, connect the drive.")))
        XCTAssertEqual(link.snapshot.episode?.told, link.snapshot.reach, "the person is told of it")
        XCTAssertEqual(ReachWords.strip(link.snapshot, device: .phone, clock: HomeClock.placeholder(at: start, zone: .gmt), now: start)?.tone,
                       .warning, "a needs-you strip, never the waiting one")
    }

    func testARequestsNotNowWhileTheProbeMeetsOneTooIsTheHomeStartingThenSilenceIsTheWait() async throws {
        let door = Door()
        let (link, _) = try await paired(door)
        door.answers(.reply(503, Self.starting, ["Retry-After": "5"]))
        let state = await read(link, at: "/v1/people")
        XCTAssertEqual(state, .reach, "a start is the home's: the strip says it")
        await link.probesEnded()
        XCTAssertEqual(door.requests(at: "/v1/status"), 1)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "starting 0 r0", "the probe's own not-now is the home's")
        await probe(after: 10, link)
        await probe(after: 10, link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "starting 0 r0", "past the grace: the door still answers")
        door.answers(.silent)
        await probe(after: 10, link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "waiting 30 r0")
        await probe(after: 10, link)
        await probe(after: 10, link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "unreachable silent 30")
    }

    func testAHeldNotNowOnARequestIsHeldAtOnce() async throws {
        let door = Door()
        let (link, _) = try await paired(door)
        door.answers(.reply(503, Self.held, ["Retry-After": "30"]), at: "/v1/people")
        let state = await read(link, at: "/v1/people")
        XCTAssertEqual(state, .reach)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "held Your home is held")
        XCTAssertEqual(door.requests(at: "/v1/status"), 0, "a hold is said with no probe first")
    }


    func testTheGraceTheLinkIsMadeWithIsTheOneCounted() async throws {
        let door = Door()
        let (link, _) = try await paired(door, grace: 2)
        let seen = Recorder(link, from: start)
        door.answers(.silent)
        await read(link)
        await probe(after: 10, link)
        await fulfillment(of: [seen.count(3)], timeout: 30)
        XCTAssertEqual(seen.said, ["answering r0", "waiting 0 r0", "unreachable silent 0"],
                       "the first probe, 10 s on, fails past a 2 s grace (the default's says nothing yet: test 5)")
    }


    func testWhileHeldAnActsAnswerMovesTheClockAndOnlyTheProbesAnswerEndsTheHold() async throws {
        let door = Door()
        let (link, _) = try await paired(door)
        let seen = Recorder(link, from: start)
        door.answers(.reply(503, Self.held, ["Retry-After": "30"]))
        await read(link, at: "/v1/people")
        XCTAssertEqual(Said.of(link.snapshot, from: start), "held Your home is held")

        clock.advance(1)
        door.answers(.reply(202, "", [:]), at: "/v1/home/verify")
        try await link.verifyHome()
        XCTAssertEqual(Said.of(link.snapshot, from: start), "held Your home is held", "the act's 202 leaves the hold")
        XCTAssertEqual(link.snapshot.lastReached, clock.now, "the act's answer moved the clock")
        XCTAssertEqual(link.snapshot.revision, 0)
        XCTAssertEqual(door.requests(at: "/v1/status"), 0, "the act joined the hold's probe, due at its Retry-After")

        door.answers(.reply(200, "{}", [:]))
        await probe(after: 29, link)
        XCTAssertEqual(door.requests(at: "/v1/status"), 1, "one probe")
        await fulfillment(of: [seen.count(4)], timeout: 30)
        XCTAssertEqual(seen.said, ["answering r0", "held Your home is held", "held Your home is held", "answering r1"])
        XCTAssertEqual(seen.reached[2], start.addingTimeInterval(1), "the third, the act's clock move")
    }


    func testAStartThatTurnsSilentKeepsItsStripAndItsEndSaysReached() async throws {
        let door = Door()
        let (link, _) = try await paired(door)
        let clock = HomeClock.placeholder(at: start, zone: .gmt)
        door.answers(.reply(503, Self.starting, ["Retry-After": "5"]))
        await link.probeSoon()
        XCTAssertEqual(Said.of(link.snapshot, from: start), "starting 0 r0")
        door.answers(.silent)
        await probe(after: 10, link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "waiting 10 r0")
        XCTAssertEqual(ReachWords.strip(link.snapshot, device: .phone, clock: clock, now: self.clock.now)?.title, "Your home is starting",
                       "the wait keeps the strip the episode showed")
        let episode = try XCTUnwrap(link.snapshot.episode)
        door.answers(.reply(200, "{}", [:]))
        await probe(after: 10, link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "answering r1")
        XCTAssertEqual(link.snapshot.episode?.id, episode.id, "the same episode, ended")
        XCTAssertEqual(link.snapshot.episode?.ended, self.clock.now)
        XCTAssertEqual(ReachWords.reached(link.snapshot, clock: clock, now: self.clock.now)?.title, "Lifestream is back")
        XCTAssertNil(link.snapshot.episode?.told, "a start is never told")
    }

    func testAnEpisodeIsToldOnceWhateverItsTurns() async throws {
        let door = Door()
        let (link, _) = try await paired(door, grace: 2)
        door.answers(.silent)
        await read(link)
        await probe(after: 10, link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "unreachable silent 0")
        let told = try XCTUnwrap(link.snapshot.episode?.told)
        door.answers(.reply(503, Self.starting, ["Retry-After": "5"]))
        await probe(after: 10, link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "starting 0 r0")
        door.answers(.silent)
        await probe(after: 10, link)
        await probe(after: 10, link)
        XCTAssertTrue(Said.of(link.snapshot, from: start).hasPrefix("unreachable silent"))
        XCTAssertEqual(link.snapshot.episode?.told, told, "told once, at the episode's first")
        XCTAssertEqual(link.snapshot.episode?.id, 1)
    }


    func testTheCauseIsKeptWithTheRoutesItWasJudgedBy() async throws {
        let door = Door()
        let network = MovableNetwork(NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: false, cost: .free))
        let (link, credentials) = try await paired(door, network: network, grace: 2)
        var stored = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(credentials.read())) as? [String: Any])
        stored["addresses"] = ["https://mac-a.local:4682", "https://100.81.6.81:4682"]
        stored["pin"] = stored["pin"] ?? String(repeating: "A", count: 52)
        try credentials.write(try JSONSerialization.data(withJSONObject: stored))
        door.answers(.silent)
        await read(link)
        await probe(after: 10, link)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "unreachable silent 0")
        XCTAssertEqual(link.snapshot.routes, HomeLink.Routes(online: true, local: true, tailscale: false))
        XCTAssertEqual(ReachWords.diagnosis(link.snapshot, device: .phone)?.path.filter(\.failed).map(\.id), ["mac"])
    }

    func testCheckAgainReadsTheNetworkThenProbesEvenUnderTheNetworksCause() async throws {
        let door = Door()
        let network = MovableNetwork(NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: false, cost: .free))
        let (link, _) = try await paired(door, network: network)
        let seen = Recorder(link, from: start)
        network.set(NetworkFacts(online: false, onLocalNetwork: false, tunnelUp: false, cost: .free))
        await fulfillment(of: [seen.count(2)], timeout: 30)
        XCTAssertEqual(Said.of(link.snapshot, from: start), "unreachable offline 0")
        XCTAssertEqual(door.requests(at: "/v1/status"), 0, "no road: no probe of its own")
        network.lag(NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: false, cost: .free))
        door.answers(.reply(200, "{}", [:]))
        let after = await link.checkAgain()
        XCTAssertEqual(Said.of(after, from: start), "answering r1")
        XCTAssertFalse(after.checking)
        XCTAssertTrue(seen.snapshots.contains(where: \.checking), "every Try again is busy while it runs")
    }
}


enum Said {
    static func of(_ snapshot: HomeLink.ReachSnapshot, from start: Date) -> String {
        let seconds = { (date: Date) in Int(date.timeIntervalSince(start).rounded()) }
        switch snapshot.reach {
        case .answering: return "answering r\(snapshot.revision)"
        case .waiting(let since): return "waiting \(seconds(since)) r\(snapshot.revision)"
        case .starting(_, let since): return "starting \(seconds(since)) r\(snapshot.revision)"
        case .unreachable(let cause, let since): return "unreachable \(word(cause)) \(seconds(since))"
        case .held(let held): return "held \(held.title)"
        case .needsUpdate(.home): return "update home"
        case .needsUpdate(.device(let floor)): return "update device \(floor)"
        case .passRefused: return "pass refused"
        case .unpaired: return "unpaired"
        }
    }

    static func word(_ cause: HomeLink.Cause) -> String {
        switch cause {
        case .offline: "offline"
        case .tailscaleOff: "tailscale off"
        case .wifiOnly: "wifi only"
        case .notRunning: "not running"
        case .driveAway: "drive away"
        case .local(let words): "local: \(words)"
        case .silent: "silent"
        }
    }
}

final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private let start: Date
    private var got: [HomeLink.ReachSnapshot] = []
    private var waits: [(count: Int, kept: XCTestExpectation)] = []
    private var reading: Task<Void, Never>?

    init(_ link: HomeLink, from start: Date) {
        self.start = start
        let stream = link.snapshots()
        reading = Task { [weak self] in
            for await snapshot in stream { self?.add(snapshot) }
        }
    }

    deinit { reading?.cancel() }

    var said: [String] { lock.withLock { got.map { Said.of($0, from: start) } } }

    var snapshots: [HomeLink.ReachSnapshot] { lock.withLock { got } }

    var reached: [Date?] { lock.withLock { got.map(\.lastReached) } }

    func count(_ count: Int) -> XCTestExpectation {
        let kept = XCTestExpectation(description: "\(count) snapshots told")
        lock.withLock { if got.count >= count { kept.fulfill() } else { waits.append((count, kept)) } }
        return kept
    }

    private func add(_ snapshot: HomeLink.ReachSnapshot) {
        lock.withLock {
            got.append(snapshot)
            waits.removeAll { wait in
                guard got.count >= wait.count else { return false }
                wait.kept.fulfill()
                return true
            }
        }
    }
}

final class ManualPacer: @unchecked Sendable {
    private let lock = NSLock()
    private let clock: TestClock
    private var timers: [(at: Date, fire: @Sendable () -> Void)] = []

    init(_ clock: TestClock) { self.clock = clock }

    var pacer: Pacer {
        Pacer { [self] seconds, fire in
            lock.withLock { timers.append((clock.now.addingTimeInterval(seconds), fire)) }
        }
    }

    func pass(_ seconds: TimeInterval) {
        let end = clock.now.addingTimeInterval(seconds)
        while let fire = lock.withLock({ () -> (@Sendable () -> Void)? in
            guard let next = timers.indices.filter({ timers[$0].at <= end }).min(by: { timers[$0].at < timers[$1].at }) else { return nil }
            let timer = timers.remove(at: next)
            moveTo(timer.at)
            return timer.fire
        }) {
            fire()
        }
        lock.withLock { moveTo(end) }
    }

    private func moveTo(_ at: Date) {
        clock.advance(max(0, at.timeIntervalSince(clock.now)))
    }
}

final class MovableNetwork: NetworkWatch, @unchecked Sendable {
    private let lock = NSLock()
    private var current: NetworkFacts?
    private var readers: [UUID: AsyncStream<NetworkFacts>.Continuation] = [:]

    init(_ facts: NetworkFacts?) { current = facts }

    var facts: NetworkFacts? { lock.withLock { current } }

    func changes() -> AsyncStream<NetworkFacts> {
        AsyncStream { continuation in
            let id = UUID()
            lock.withLock {
                readers[id] = continuation
                if let current { continuation.yield(current) }
            }
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                _ = self.lock.withLock { self.readers.removeValue(forKey: id) }
            }
        }
    }

    func set(_ facts: NetworkFacts) {
        lock.withLock {
            current = facts
            for reader in readers.values { reader.yield(facts) }
        }
    }

    func lag(_ facts: NetworkFacts) {
        lock.withLock { current = facts }
    }
}

extension NetworkFacts {
    static let home = NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: false, path: 1, cost: .free)
    static let offline = NetworkFacts(online: false, onLocalNetwork: false, tunnelUp: false, path: 2, cost: .free)
}

final class Door: HomeTransport, @unchecked Sendable {
    enum Answer {
        case reply(Int, String, [String: String])
        case silent
        case lines([String], drops: Bool)
    }

    private let lock = NSLock()
    private var answer = Answer.reply(200, "{}", [:])
    private var byPath: [String: Answer] = [:]
    private var paths: [String] = []
    private var asked = 0
    private var holding: XCTestExpectation?
    private var held: CheckedContinuation<Void, Never>?
    private var heldAnswer: Answer?
    private var arrivals: [(count: Int, kept: XCTestExpectation)] = []

    var requests: Int { lock.withLock { asked } }

    func answers(_ answer: Answer) { lock.withLock { self.answer = answer } }

    func answers(_ answer: Answer, at path: String) { lock.withLock { byPath[path] = answer } }

    func requests(at path: String) -> Int { lock.withLock { paths.filter { $0 == path }.count } }

    func arrived(_ count: Int) -> XCTestExpectation {
        let kept = XCTestExpectation(description: "\(count) requests reached the door")
        lock.withLock { if asked >= count { kept.fulfill() } else { arrivals.append((count, kept)) } }
        return kept
    }

    func holdNext() -> XCTestExpectation {
        let kept = XCTestExpectation(description: "the held request reached the door")
        lock.withLock { holding = kept }
        return kept
    }

    func release(answering: Answer? = nil) {
        lock.withLock { () -> CheckedContinuation<Void, Never>? in
            heldAnswer = answering
            defer { held = nil }
            return held
        }?.resume()
    }

    func identify(_ address: URL, within: TimeInterval) async throws -> String { String(repeating: "A", count: 52) }

    func perform(_ request: HomeRequest) async throws -> HomeResponse {
        switch await arrive(request.url.path) {
        case .reply(let status, let body, let headers): return HomeResponse(status: status, headers: headers, body: Data(body.utf8))
        case .silent: throw URLError(.cannotConnectToHost)
        case .lines(let lines, _): return HomeResponse(status: 200, body: Data((lines.joined(separator: "\n") + "\n").utf8))
        }
    }

    func stream(_ request: HomeRequest) async throws -> HomeStream {
        switch await arrive(request.url.path) {
        case .reply(let status, let body, let headers):
            return HomeStream(status: status, headers: headers, lines: HomeStream.lines(of: Data(body.utf8)))
        case .silent:
            throw URLError(.cannotConnectToHost)
        case .lines(let lines, let drops):
            return HomeStream(status: 200, lines: AsyncThrowingStream { continuation in
                for line in lines { continuation.yield(Data(line.utf8)) }
                if drops { continuation.finish(throwing: URLError(.networkConnectionLost)) } else { continuation.finish() }
            })
        }
    }

    private func arrive(_ path: String) async -> Answer {
        let hold = lock.withLock { () -> XCTestExpectation? in
            asked += 1
            paths.append(path)
            arrivals.removeAll { arrival in
                guard asked >= arrival.count else { return false }
                arrival.kept.fulfill()
                return true
            }
            defer { holding = nil }
            return holding
        }
        if let hold {
            await withCheckedContinuation { (gate: CheckedContinuation<Void, Never>) in
                lock.withLock { held = gate }
                hold.fulfill()
            }
            return lock.withLock { heldAnswer ?? byPath[path] ?? answer }
        }
        return lock.withLock { byPath[path] ?? answer }
    }
}

final class Gate: @unchecked Sendable {
    let entered = XCTestExpectation(description: "the heal began")
    private let lock = NSLock()
    private var opened = false
    private var waiting: CheckedContinuation<Void, Never>?

    func pass() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let go = lock.withLock { () -> Bool in
                if opened { return true }
                waiting = continuation
                return false
            }
            entered.fulfill()
            if go { continuation.resume() }
        }
    }

    func open() {
        lock.withLock { () -> CheckedContinuation<Void, Never>? in
            opened = true
            defer { waiting = nil }
            return waiting
        }?.resume()
    }
}
