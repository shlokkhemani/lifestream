import DeviceFiles
import Foundation
import XCTest
@testable import HomeLink

final class TurnTests: XCTestCase {
    private var folder: URL!
    private let phone = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil)
    private let home = "https://lifestream.example.ts.net"

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-turn-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private static let run = "0123456789abcdef"
    private static let restarted = "fedcba9876543210"
    private static let restored = "00000000c0c0c0c0"

    private static func answer(received: Int, n: Int, run: String = TurnTests.run) -> String {
        Fixture.answer(received: received, imported: 0, turn: Answer.Turn(run: run, n: n))
    }

    private func paired(_ transport: any HomeTransport, credentials: MemoryCredentials = MemoryCredentials(),
                        network: (any NetworkWatch)? = nil) async throws -> HomeLink {
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: home, account: Fixture.account)
        return HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport, network: network)
    }

    private func bundle() throws -> URL {
        let file = folder.appendingPathComponent("b.zip")
        try Data("zip".utf8).write(to: file)
        return file
    }

    func testAnExchangeOlderByTurnThatLandsAfterABundlesIsNotSavedAndHandsBackTheNewer() async throws {
        let scripted = ScriptedTransport([.reply(201, Self.answer(received: 1, n: 6)), .reply(200, Self.answer(received: 0, n: 5))])
        let held = HeldTransport(scripted)
        let link = try await paired(held)
        let landed = Landed()
        link.onAnswer { landed.add() }
        XCTAssertNil(link.fresh, "nothing landed in this process yet")
        let exchange = Task { try await link.exchange() }
        await fulfillment(of: [held.asked], timeout: 30)
        let sent = try await link.send(bundle: try bundle(), id: "sha256:00aa", kind: .new)
        XCTAssertEqual(sent.sources[Fixture.source]?.received, 1)
        XCTAssertEqual(link.fresh, sent, "the newest answer, whichever request brought it")
        XCTAssertEqual(landed.count, 1, "the device heard it")
        held.answer()
        let late = try await ended("the held exchange's late answer", exchange)
        XCTAssertEqual(late.sources[Fixture.source]?.received, 1, "the late exchange hands back the newer answer")
        XCTAssertEqual(late.turn, Answer.Turn(run: Self.run, n: 6))
        XCTAssertEqual(link.saved?.sources[Fixture.source]?.received, 1, "the older answer is never saved")
        XCTAssertEqual(link.saved?.turn.n, 6)
        XCTAssertEqual(landed.count, 1, "an older answer landing late is no news")
    }

    func testAStaleOlderByTurnHandsBackTheNewerAndARestartedDoorIsTaken() async throws {
        let stale = #"{"code":"STALE","message":"seal again","answer":"# + Self.answer(received: 0, n: 3) + "}"
        let transport = ScriptedTransport([
            .reply(200, Self.answer(received: 2, n: 4)),
            .reply(409, stale),
            .reply(200, Self.answer(received: 0, n: 1, run: Self.restarted)),
        ])
        let link = try await paired(transport)
        _ = try await link.exchange()
        do {
            _ = try await link.send(bundle: try bundle(), id: "sha256:00aa", kind: .new)
            XCTFail("stale")
        } catch LinkFailure.stale(let answer) {
            XCTAssertEqual(answer.sources[Fixture.source]?.received, 2, "a STALE older than the saved answer reseals from the newer")
        }
        XCTAssertEqual(link.saved?.turn.n, 4)

        let restarted = try await link.exchange()
        XCTAssertEqual(restarted.sources[Fixture.source]?.received, 0, "another door process is newer, whatever it counts")
        XCTAssertEqual(link.saved?.turn, Answer.Turn(run: Self.restarted, n: 1))
    }

    func testALateAnswerOfARetiredRunIsNeverSavedWhenTheResponsesCrossed() async throws {
        let gated = GatedTransport([Self.answer(received: 1, n: 4), Self.answer(received: 2, n: 5),
                                    Self.answer(received: 0, n: 1, run: Self.restarted)])
        let link = try await paired(gated)
        gated.open(0)
        _ = try await link.exchange()
        let first = Task { try await link.send(bundle: try bundle(), id: "sha256:00aa", kind: .new) }
        await fulfillment(of: [gated.reached(1)], timeout: 30)
        let second = Task { try await link.send(bundle: try bundle(), id: "sha256:00bb", kind: .new) }
        await fulfillment(of: [gated.reached(2)], timeout: 30)
        gated.open(2)
        let restarted = try await ended("the second send's answer", second)
        XCTAssertEqual(restarted.turn, Answer.Turn(run: Self.restarted, n: 1), "the new run is taken")
        gated.open(1)
        let late = try await ended("the first send's late answer", first)
        XCTAssertEqual(late.turn, Answer.Turn(run: Self.restarted, n: 1), "the old run's late answer hands back the new run's")
        XCTAssertEqual(late.sources[Fixture.source]?.received, 0)
        XCTAssertEqual(link.saved?.turn, Answer.Turn(run: Self.restarted, n: 1), "and is never saved")
        XCTAssertEqual(link.fresh?.turn.run, Self.restarted)
    }

    func testALateAnswerOfARetiredRunIsNeverSavedWhenTheRequestsCrossedAndALaterRunIsTaken() async throws {
        let stale = #"{"code":"STALE","message":"seal again","answer":"# + Self.answer(received: 3, n: 6) + "}"
        let gated = GatedTransport([Self.answer(received: 1, n: 4), Self.answer(received: 0, n: 1, run: Self.restarted)],
                                   then: [(409, stale), (200, Self.answer(received: 0, n: 2, run: Self.restored)),
                                          (200, Self.answer(received: 5, n: 9))])
        let link = try await paired(gated)
        gated.open(0)
        _ = try await link.exchange()
        let first = Task { try await link.send(bundle: try bundle(), id: "sha256:00aa", kind: .new) }
        await fulfillment(of: [gated.reached(1)], timeout: 30)
        let second = Task { try await link.send(bundle: try bundle(), id: "sha256:00bb", kind: .new) }
        await fulfillment(of: [gated.reached(2)], timeout: 30)
        gated.open(1)
        _ = try await ended("the first send's answer", first)
        gated.open(2)
        do {
            _ = try await ended("the second send's STALE", second)
            XCTFail("stale")
        } catch LinkFailure.stale(let answer) {
            XCTAssertEqual(answer.turn, Answer.Turn(run: Self.restarted, n: 1), "a retired run's STALE reseals from the newest run's answer")
            XCTAssertEqual(answer.sources[Fixture.source]?.received, 0)
        }
        XCTAssertEqual(link.saved?.turn, Answer.Turn(run: Self.restarted, n: 1))

        gated.open(3)
        let restored = try await link.exchange()
        XCTAssertEqual(restored.turn, Answer.Turn(run: Self.restored, n: 2), "a later run is taken")
        XCTAssertEqual(link.saved?.turn, Answer.Turn(run: Self.restored, n: 2))
        gated.open(4)
        let alive = try await link.exchange()
        XCTAssertEqual(alive.turn, Answer.Turn(run: Self.run, n: 9), "a retired run answering a request sent after it was retired is alive")
        XCTAssertEqual(link.saved?.turn, Answer.Turn(run: Self.run, n: 9))
    }

    func testARunRetiredByALateAnswerIsTakenAgainWhenItAnswersALaterRequest() async throws {
        let gated = GatedTransport([Self.answer(received: 1, n: 4), Self.answer(received: 3, n: 7, run: Self.restarted),
                                    Self.answer(received: 0, n: 1, run: Self.restored), Self.answer(received: 0, n: 2, run: Self.restored)])
        let link = try await paired(gated)
        gated.open(0)
        _ = try await link.exchange()
        let first = Task { try await link.send(bundle: try bundle(), id: "sha256:00aa", kind: .new) }
        await fulfillment(of: [gated.reached(1)], timeout: 30)
        let second = Task { try await link.send(bundle: try bundle(), id: "sha256:00bb", kind: .new) }
        await fulfillment(of: [gated.reached(2)], timeout: 30)
        gated.open(2)
        let third = try await ended("the second send's answer", second)
        XCTAssertEqual(third.turn, Answer.Turn(run: Self.restored, n: 1), "C is taken, A retired")
        gated.open(1)
        let late = try await ended("the first send's late answer", first)
        XCTAssertEqual(late.turn, Answer.Turn(run: Self.restarted, n: 7), "B, never seen, lands in the order it lands")
        gated.open(3)
        let again = try await link.exchange()
        XCTAssertEqual(again.turn, Answer.Turn(run: Self.restored, n: 2), "C answered a request sent after it was retired: it is alive")
        XCTAssertEqual(link.saved?.turn, Answer.Turn(run: Self.restored, n: 2))
        XCTAssertEqual(link.fresh?.turn.run, Self.restored)
    }

    func testAPairingAnswerOfARunRetiredWhileItCameCompletesThePairingAndIsNotTaken() async throws {
        let gated = GatedTransport([Self.answer(received: 1, n: 4),
                                    #"{"unit":"macbook-pro-0001","answer":"# + Self.answer(received: 1, n: 5) + "}",
                                    Self.answer(received: 0, n: 1, run: Self.restarted),
                                    Self.answer(received: 0, n: 2, run: Self.restarted)])
        let link = try await paired(gated)
        gated.open(0)
        _ = try await link.exchange()
        let pairing = Task { try await link.pair(code: "12345678", name: home, account: Fixture.account) }
        await fulfillment(of: [gated.reached(1)], timeout: 30)
        gated.open(2)
        let restarted = try await link.exchange()
        XCTAssertEqual(restarted.turn, Answer.Turn(run: Self.restarted, n: 1), "B is taken, A retired")
        gated.open(1)
        gated.open(3)
        let paired = try await ended("the pairing's answer", pairing)
        XCTAssertEqual(paired.turn, Answer.Turn(run: Self.restarted, n: 2), "the pairing stands, and an exchange under it brings the live run's answer")
        XCTAssertEqual(link.saved?.turn, Answer.Turn(run: Self.restarted, n: 2), "the retired run's pairing answer is never saved")
        XCTAssertEqual(link.fresh?.turn, Answer.Turn(run: Self.restarted, n: 2))
    }

    func testTheNewestTurnOutlivesARelaunchAndAPairingAgainStartsItsOwn() async throws {
        let credentials = MemoryCredentials()
        let first = try await paired(ScriptedTransport([.reply(200, Self.answer(received: 2, n: 9))]), credentials: credentials)
        _ = try await first.exchange()

        let relaunched = HomeLink(device: phone, credentials: credentials, folder: folder,
                                  transport: ScriptedTransport([.reply(200, Self.answer(received: 1, n: 8)), .reply(200, Self.answer(received: 3, n: 10))]))
        do { _ = try await relaunched.exchange(); XCTFail("an older answer with nothing newer to hand back") } catch LinkFailure.noAnswer {}
        XCTAssertEqual(relaunched.saved?.sources[Fixture.source]?.received, 2, "the saved answer stands")
        let next = try await relaunched.exchange()
        XCTAssertEqual(next.sources[Fixture.source]?.received, 3)

        let again = ScriptedTransport([
            .reply(200, #"{"unit":"macbook-pro-0001","answer":"# + Self.answer(received: 0, n: 2) + "}"),
            .reply(200, Self.answer(received: 0, n: 3)),
        ])
        let repaired = HomeLink(device: phone, credentials: credentials, folder: folder, transport: again)
        let paired = try await repaired.pair(code: "12345678", name: home, account: Fixture.account)
        XCTAssertEqual(paired.turn.n, 2, "a new pairing's answer is saved, whatever the last pairing's turn")
        let exchanged = try await repaired.exchange()
        XCTAssertEqual(exchanged.turn.n, 3)
    }

    func testAChangedSendingIsOwedUntilOneAnsweredExchangeCarriesIt() async throws {
        let transport = ScriptedTransport([.unreachable, .reply(200, Self.answer(received: 0, n: 1))])
        let link = try await paired(transport)
        XCTAssertFalse(link.owesExchange, "nothing told, nothing owed")
        var sending = Sending()
        sending.failed("apple-photos:person-a@example.com:iphone-aa00", code: "PHOTOS", message: "the read failed", at: Date())
        link.tell(sending: sending)
        XCTAssertTrue(link.owesExchange)
        do { _ = try await link.exchange(); XCTFail("silent") } catch LinkFailure.noAnswer {}
        XCTAssertTrue(link.owesExchange, "an exchange with no answer carried nothing")
        _ = try await link.exchange()
        XCTAssertFalse(link.owesExchange, "carried once, owed no longer")
        link.tell(sending: sending)
        XCTAssertFalse(link.owesExchange, "the same statement again owes nothing")
        link.tell(sending: Sending())
        XCTAssertTrue(link.owesExchange, "a failure that ended is owed too")

        let held = HeldTransport(ScriptedTransport([.reply(200, Self.answer(received: 0, n: 1)), .reply(200, Self.answer(received: 0, n: 2))]))
        let owing = try await paired(held)
        let first = Task { try await owing.exchange() }
        await fulfillment(of: [held.asked], timeout: 30)
        owing.owe()
        held.answer()
        _ = try await ended("the held exchange's answer", first)
        XCTAssertTrue(owing.owesExchange, "the exchange left before the change: it did not carry it")
        _ = try await owing.exchange()
        XCTAssertFalse(owing.owesExchange)
    }

    func testTheTransportHandsOnEachRequestsMetricsAndKeepsALaterBundleOffEveryCostlyPath() async throws {
        Stub.seen = []
        let measured = expectation(description: "each request's metrics reach the app")
        measured.expectedFulfillmentCount = 2
        let heard = Heard()
        let transport = URLSessionTransport(protocolClasses: [Stub.self]) { request, metrics, ending in
            heard.add("\(request.url.path) \(ending.status.map(String.init) ?? "unanswered")", metrics.taskInterval.duration >= 0)
            measured.fulfill()
        }
        let link = try await paired(transport, network: MovableNetwork(.home))
        _ = try await link.send(bundle: try bundle(), id: "sha256:00aa", kind: .later)
        _ = try await link.exchange()
        await fulfillment(of: [measured], timeout: 30)
        XCTAssertEqual(Set(heard.paths), ["/v1/bundles/sha256:00aa 201", "/v1/exchange 200"], "each with what the home answered")
        XCTAssertEqual(Stub.seen.map(\.path), ["/v1/bundles/sha256:00aa", "/v1/exchange"])
        XCTAssertEqual(Stub.seen.map(\.expensive), [false, true], "the history page asked the session for no expensive path")
        XCTAssertEqual(Stub.seen.map(\.constrained), [false, true], "nor a constrained one")
        XCTAssertEqual(Stub.seen.map(\.kind), ["later", nil], "the upload states its kind, as the door reads it")
        XCTAssertEqual(Stub.seen.first?.length, "3", "and its length")
    }

    func testACallerThatEndsARequestInItsBodyIsSaidToHaveCutItOnEveryBody() async throws {
        let file = try bundle()
        let bodies: [(String, HomeRequest.Body)] = [
            ("a file", .file(file)),
            ("a stream", .stream(size: 3, open: HomeRequest.Opener { try DeviceFiles(.plain).reader(file) })),
            ("bytes", .bytes(Data("zip".utf8))),
        ]
        for (what, body) in bodies {
            let started = expectation(description: "\(what) reached the home")
            let measured = expectation(description: "\(what)'s metrics reached the app")
            let ending = Ended()
            Silent.started = { started.fulfill() }
            let transport = URLSessionTransport(protocolClasses: [Silent.self]) { _, _, said in
                ending.set(said)
                measured.fulfill()
            }
            let request = HomeRequest(method: "PUT", url: URL(string: "\(home)/v1/files/sha256:00aa")!, headers: [:], body: body,
                                      timeout: 30)
            let sending = Task { try await transport.perform(request) }
            await fulfillment(of: [started], timeout: 30)
            sending.cancel()
            do {
                _ = try await sending.value
                XCTFail("\(what): a cancelled request answered")
            } catch {}
            await fulfillment(of: [measured], timeout: 30)
            XCTAssertEqual(ending.value, .cut, what)
        }
    }
}

private final class Ended: @unchecked Sendable {
    private let lock = NSLock()
    private var said: URLSessionTransport.Ending?
    var value: URLSessionTransport.Ending? { lock.withLock { said } }
    func set(_ ending: URLSessionTransport.Ending) { lock.withLock { said = ending } }
}

private final class Silent: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var started: @Sendable () -> Void = {}

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.started() }
    override func stopLoading() {}
}

private final class GatedTransport: HomeTransport, @unchecked Sendable {
    private let lock = NSLock()
    private let replies: [(Int, String)]
    private var seen = 0
    private var arrivals: [(index: Int, kept: XCTestExpectation)] = []
    private var opened: Set<Int> = []
    private var gates: [Int: CheckedContinuation<Void, Never>] = [:]

    init(_ answers: [String], then: [(Int, String)] = []) {
        replies = answers.map { (0, $0) } + then
    }

    func reached(_ index: Int) -> XCTestExpectation {
        let kept = XCTestExpectation(description: "request \(index) reached the home")
        lock.withLock { if seen > index { kept.fulfill() } else { arrivals.append((index, kept)) } }
        return kept
    }

    func open(_ index: Int) {
        lock.withLock { () -> CheckedContinuation<Void, Never>? in
            opened.insert(index)
            return gates.removeValue(forKey: index)
        }?.resume()
    }

    func identify(_ address: URL, within: TimeInterval) async throws -> String { String(repeating: "A", count: 52) }

    func perform(_ request: HomeRequest) async throws -> HomeResponse {
        let index = lock.withLock { () -> Int in
            defer {
                seen += 1
                arrivals.removeAll { arrival in
                    guard seen > arrival.index else { return false }
                    arrival.kept.fulfill()
                    return true
                }
            }
            return seen
        }
        await withCheckedContinuation { (gate: CheckedContinuation<Void, Never>) in
            let open = lock.withLock { () -> Bool in
                if opened.contains(index) { return true }
                gates[index] = gate
                return false
            }
            if open { gate.resume() }
        }
        let (status, body) = replies[index]
        return HomeResponse(status: status != 0 ? status : request.method == "PUT" ? 201 : 200, headers: [:], body: Data(body.utf8))
    }
}

private final class Landed: @unchecked Sendable {
    private let lock = NSLock()
    private var heard = 0
    var count: Int { lock.withLock { heard } }
    func add() { lock.withLock { heard += 1 } }
}

private final class Heard: @unchecked Sendable {
    private let lock = NSLock()
    private var heard: [String] = []
    var paths: [String] { lock.withLock { heard } }
    func add(_ path: String, _ timed: Bool) { if timed { lock.withLock { heard.append(path) } } }
}

private final class Stub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var seen: [(path: String, expensive: Bool, constrained: Bool, kind: String?, length: String?)] = []
    private static let lock = NSLock()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.withLock {
            Self.seen.append((request.url?.path ?? "", request.allowsExpensiveNetworkAccess, request.allowsConstrainedNetworkAccess,
                              request.value(forHTTPHeaderField: "Lifestream-Kind"), request.value(forHTTPHeaderField: "Content-Length")))
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: request.httpMethod == "PUT" ? 201 : 200,
                                       httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Fixture.answer(received: 1, imported: 0).utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
