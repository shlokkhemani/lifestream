import Foundation
import HomeLink
import XCTest
@testable import Shipping

final class MacPeerClientTests: XCTestCase {
    private static let boot = "6f1c1d0e-0000-4000-8000-000000000001"

    private final class Heard: @unchecked Sendable {
        private let lock = NSLock()
        private var said: [String] = []

        func add(_ word: String) { lock.withLock { said.append(word) } }
        var all: [String] { lock.withLock { said } }
    }

    private func client(_ peer: FakePeer, heard: Heard = Heard(), pauses: Collected<TimeInterval> = Collected(),
                        seals: [String: Int] = [:], gate: SourcesGate = SourcesGate()) -> MacPeerClient {
        MacPeerClient(link: peer, handlers: MacPeerClient.Handlers(
            sources: {
                await gate.pass()
                return ["imessage", "whatsapp"]
            },
            onRefresh: { heard.add("refresh \($0)") },
            onSettings: { heard.add("settings") },
            onFlush: { sources, budget in
                heard.add("flush \(sources?.joined(separator: ",") ?? "all") \(budget)")
                return seals
            }), boot: Self.boot, clock: { Date(timeIntervalSince1970: 1_794_837_720) }, pause: { pauses.append($0) })
    }

    private static func results(_ requests: [HomeLink.MacExchangeRequest]) -> [String: HomeLink.MacCommandResult] {
        var byID: [String: HomeLink.MacCommandResult] = [:]
        for request in requests { for result in request.results { byID[result.id] = result } }
        return byID
    }

    func testEachCallRunsAndItsResultGoesOnTheNextExchange() async throws {
        let peer = FakePeer([.success(HomeLink.MacExchangeAnswer(hand: 1, calls: [
            .refresh(id: "m-1", connector: "whatsapp"), .settings(id: "m-2"), .flush(id: "m-3", sources: ["whatsapp"], budgetMs: 1_000),
            .unknown(id: "m-4", kind: "dance"),
        ]))])
        let heard = Heard()
        let client = client(peer, heard: heard, seals: ["whatsapp": 42])
        await client.start()
        try await until("every result carried") { Self.results(peer.requests).count == 4 }
        let first = try XCTUnwrap(peer.requests.first)
        XCTAssertEqual(first, HomeLink.MacExchangeRequest(boot: Self.boot, sources: ["imessage", "whatsapp"]))
        XCTAssertEqual(peer.timeouts.first, HomeLink.macPoll)
        XCTAssertEqual(Set(heard.all), ["refresh whatsapp", "settings", "flush whatsapp 1000"])
        XCTAssertEqual(Self.results(peer.requests), [
            "m-1": .done("m-1"), "m-2": .done("m-2"), "m-3": .done("m-3", seals: ["whatsapp": 42]),
            "m-4": .failed("m-4", code: HomeLink.MacCommandResult.unknownCommand, message: "this Mac does not know the call \"dance\""),
        ])
        XCTAssertTrue(peer.requests.allSatisfy { $0.boot == Self.boot }, "one boot for the life of the client")
        await client.stop()
    }

    func testACallHandedAgainRunsOnce() async throws {
        let call = HomeLink.MacExchangeAnswer(hand: 1, calls: [.settings(id: "m-1")])
        let peer = FakePeer([.success(call), .success(call)])
        let heard = Heard()
        let client = client(peer, heard: heard)
        await client.start()
        try await until("its result carried") { Self.results(peer.requests)["m-1"] != nil }
        try await until("the line waits again") { peer.waiting == 1 && peer.requests.count >= 3 }
        XCTAssertEqual(heard.all, ["settings"])
        await client.stop()
    }

    func testSupersededEndsTheLineForGood() async throws {
        let peer = FakePeer([.failure(.refused(status: 409, code: "SUPERSEDED", message: "another boot holds the line"))])
        let client = client(peer)
        await client.start()
        try await until("ended") { await client.ended }
        try await until("no longer dialing") { await !client.dialing }
        XCTAssertEqual(peer.requests.count, 1)
        await client.nudge()
        XCTAssertEqual(peer.requests.count, 1, "a nudge does not bring it back")
    }

    func testAnUnreachableHomeIsDialedAgainAfterAGrowingRest() async throws {
        let peer = FakePeer([.failure(.noAnswer(sent: false)), .failure(.noAnswer(sent: false)),
                             .failure(.refused(status: 404, code: "ROUTE", message: "no such route"))])
        let pauses = Collected<TimeInterval>()
        let client = client(peer, pauses: pauses)
        await client.start()
        try await until("waiting after three failures") { peer.waiting == 1 }
        XCTAssertEqual(pauses.all, [1, 2, MacPeerClient.longestWait], "doubling from a second; a home that refuses the route rests longest")
        await client.stop()
    }

    func testAQuickEmptyAnswerRestsBeforeTheNextExchange() async throws {
        let peer = FakePeer([.success(HomeLink.MacExchangeAnswer(hand: 1, calls: []))])
        let pauses = Collected<TimeInterval>()
        let client = client(peer, pauses: pauses)
        await client.start()
        try await until("the second exchange waits") { peer.waiting == 1 && peer.requests.count == 2 }
        XCTAssertEqual(pauses.all, [MacPeerClient.quickest], "a door that answers at once is not dialed in a loop")
        await client.stop()
    }

    func testSleepSaysGoodbyeAndWakeDialsAgain() async throws {
        let peer = FakePeer([])
        let client = client(peer)
        await client.start()
        try await until("the poll waits") { peer.waiting == 1 }
        await client.willSleep()
        let goodbye = try XCTUnwrap(peer.requests.last)
        XCTAssertTrue(goodbye.sleep)
        XCTAssertEqual(peer.timeouts.last, MacPeerClient.goodbye)
        try await until("the poll ended") { peer.waiting == 0 }
        let dialing = await client.dialing
        XCTAssertFalse(dialing)
        await client.didWake()
        try await until("a new poll at wake") { peer.waiting == 1 && peer.requests.count == 3 }
        XCTAssertFalse(try XCTUnwrap(peer.requests.last).sleep)
        await client.stop()
    }

    func testAFlushThatSealedNothingSaysNoSeals() async throws {
        let peer = FakePeer([.success(HomeLink.MacExchangeAnswer(hand: 1, calls: [.flush(id: "m-1", sources: nil, budgetMs: 500)]))])
        let client = client(peer)
        await client.start()
        try await until("the result carried") { Self.results(peer.requests)["m-1"] != nil }
        XCTAssertEqual(Self.results(peer.requests)["m-1"], .done("m-1"), "no empty seals on the wire")
        await client.stop()
    }

    func testResultsTheDoorCallsBadAreDroppedNotSentForever() async throws {
        let peer = FakePeer([.success(HomeLink.MacExchangeAnswer(hand: 1, calls: [.settings(id: "m-1")]))])
        peer.refusesResultsOnce = true
        let client = client(peer)
        await client.start()
        try await until("the line waits again after the refusal") { peer.refused == 1 && peer.waiting == 1 }
        XCTAssertEqual(peer.requests.filter { !$0.results.isEmpty }.count, 1, "the refused batch is not sent again")
        XCTAssertEqual(peer.requests.last?.results, [])
        await client.stop()
    }

    func testAWakeBeforeTheGoodbyeLeavesKeepsTheGoodbyeOff() async throws {
        let peer = FakePeer([])
        let gate = SourcesGate()
        let client = client(peer, gate: gate)
        await client.start()
        try await until("the poll waits") { peer.waiting == 1 }
        gate.close()
        let sleeping = Task { await client.willSleep() }
        try await until("the goodbye reads its sources") { gate.held == 1 }
        await client.didWake()
        try await until("the new dial reads its sources") { gate.held == 2 }
        gate.open()
        await sleeping.value
        try await until("a new poll waits") { peer.waiting == 1 && peer.requests.count == 2 }
        XCTAssertFalse(peer.requests.contains { $0.sleep }, "no goodbye lands after the wake")
        await client.stop()
    }

    func testADialCaughtBySleepSendsNothingAfterTheGoodbye() async throws {
        let peer = FakePeer([])
        let gate = SourcesGate()
        gate.close()
        let client = client(peer, gate: gate)
        await client.start()
        try await until("the dial reads its sources") { gate.held == 1 }
        let sleeping = Task { await client.willSleep() }
        try await until("the goodbye reads its sources") { gate.held == 2 }
        gate.open()
        await sleeping.value
        let dialing = await client.dialing
        XCTAssertFalse(dialing)
        XCTAssertEqual(peer.requests.map(\.sleep), [true], "only the goodbye goes")
        await client.stop()
    }

    func testANudgeBeforeStartDialsNothing() async throws {
        let peer = FakePeer([])
        let client = client(peer)
        await client.nudge()
        await client.didWake()
        let dialing = await client.dialing
        XCTAssertFalse(dialing)
        XCTAssertEqual(peer.requests.count, 0)
    }
}

final class SourcesGate: @unchecked Sendable {
    private let lock = NSLock()
    private var shut = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var count = 0

    var held: Int { lock.withLock { count } }

    func close() { lock.withLock { shut = true } }

    func open() {
        let opened = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            shut = false
            defer { waiting = [] }
            return waiting
        }
        for wait in opened { wait.resume() }
    }

    func pass() async {
        await withCheckedContinuation { wait in
            let now = lock.withLock { () -> Bool in
                guard shut else { return true }
                count += 1
                waiting.append(wait)
                return false
            }
            if now { wait.resume() }
        }
    }
}

final class FakePeer: PeerLink, @unchecked Sendable {
    private let lock = NSLock()
    private var script: [Result<HomeLink.MacExchangeAnswer, LinkFailure>]
    private var made: [HomeLink.MacExchangeRequest] = []
    private var asked: [TimeInterval] = []
    private var hanging: [UUID: CheckedContinuation<HomeLink.MacExchangeAnswer, Error>] = [:]
    private var cancelled: Set<UUID> = []
    private var refusing = false
    private var refusals = 0

    var refusesResultsOnce: Bool {
        get { lock.withLock { refusing } }
        set { lock.withLock { refusing = newValue } }
    }
    var refused: Int { lock.withLock { refusals } }

    init(_ script: [Result<HomeLink.MacExchangeAnswer, LinkFailure>]) { self.script = script }

    var requests: [HomeLink.MacExchangeRequest] { lock.withLock { made } }
    var timeouts: [TimeInterval] { lock.withLock { asked } }
    var waiting: Int { lock.withLock { hanging.count } }

    func macExchange(_ request: HomeLink.MacExchangeRequest, timeout: TimeInterval) async throws -> HomeLink.MacExchangeAnswer {
        let next = lock.withLock { () -> Result<HomeLink.MacExchangeAnswer, LinkFailure>? in
            made.append(request)
            asked.append(timeout)
            if request.sleep { return .success(HomeLink.MacExchangeAnswer(hand: 0, calls: [])) }
            if refusing, !request.results.isEmpty {
                refusing = false
                refusals += 1
                return .failure(.refused(status: 400, code: "BAD_CALL", message: "the body is not a JSON object"))
            }
            return script.isEmpty ? nil : script.removeFirst()
        }
        if let next { return try next.get() }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { wait in
                let now = lock.withLock { () -> Bool in
                    if cancelled.contains(id) { return true }
                    hanging[id] = wait
                    return false
                }
                if now { wait.resume(throwing: CancellationError()) }
            }
        } onCancel: {
            let wait = lock.withLock { () -> CheckedContinuation<HomeLink.MacExchangeAnswer, Error>? in
                cancelled.insert(id)
                return hanging.removeValue(forKey: id)
            }
            wait?.resume(throwing: CancellationError())
        }
    }
}
