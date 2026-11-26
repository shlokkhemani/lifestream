import Foundation
import DeviceFiles
import HomeLink
import Passwords
import Shipping
import UserNotifications
import XCTest
@testable import Lifestream

@MainActor final class ReachJourneyTests: XCTestCase {
    private var folder: URL!
    private var door: StandInDoor!
    private var time: ManualPacer!
    private var link: HomeLink!
    private var shipper: Shipper!
    private var coordinator: ShippingCoordinator!
    private var notified: NoticeLog!
    private var shown: [HomeLink.Reach] = []
    private let utc = TimeZone(identifier: "UTC")!
    private let start = Date(timeIntervalSince1970: 1_794_837_720)

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("reach-journey-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        door = StandInDoor()
        time = ManualPacer(start)
        let stored = try JSONSerialization.data(withJSONObject: ["name": "http://127.0.0.1:4680", "pass": "fake-pass-000000000000",
                                                                 "paired": true, "unit": "macbook-pro-0001"])
        link = HomeLink(device: .init(kind: .mac, version: "500", model: "Mac15,3", serial4: nil),
                        credentials: StoredPass(stored), folder: folder.appendingPathComponent("link"), transport: door,
                        clock: time.clock, pacer: time.pacer, files: DeviceFiles(.plain))
        shipper = Shipper(Shipper.Dependencies(state: ShippingState(root: folder.appendingPathComponent("ship"), files: DeviceFiles(.plain)), link: link,
                                               domains: { _ in [] }, record: { _ in }, scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true)))
        notified = NoticeLog()
        coordinator = ShippingCoordinator(shipper: shipper, link: link, notices: notified.notices, explain: { nil })
        coordinator.changed = { [unowned self] in
            if shown.last != coordinator.reach.reach { shown.append(coordinator.reach.reach) }
        }
        coordinator.follow()
        try await until("the first snapshot") { !shown.isEmpty }
        let answered = await coordinator.knock()
        XCTAssertEqual(answered, true)
        XCTAssertEqual(link.snapshot.lastReached, start)
    }

    override func tearDown() async throws {
        await coordinator?.stop()
        try? FileManager.default.removeItem(at: folder)
    }

    private var menu: String {
        ShippingPresentation(status: coordinator.status, reach: coordinator.reach, clock: .placeholder(at: time.now, zone: utc),
                             zone: utc, now: time.now).label
    }

    private func probe() async {
        time.pass(HomeLink.probeEvery)
        await link.probeSoon()
    }

    func testTheDoorStopsThenAnswers() async throws {
        door.mode = .stopped
        time.pass(60)
        let stopped = time.now
        let knocked = await coordinator.knock()
        XCTAssertEqual(knocked, false)
        try await until("waiting") { coordinator.reach.reach == .waiting(since: stopped) }
        XCTAssertNil(ReachWords.menuLine(coordinator.reach, clock: .placeholder(at: time.now, zone: utc)), "a wait said")
        await probe()
        XCTAssertEqual(link.snapshot.reach, .waiting(since: stopped), "said before the grace")
        await probe()
        XCTAssertEqual(link.snapshot.reach, .unreachable(.silent, since: stopped))
        try await until("the menu's line") { menu == "Lifestream isn't answering · since 14:02" }
        try await until("one notification") { notified.posted.count == 1 }
        XCTAssertEqual(notified.posted.first?.identifier, ShippingCoordinator.notification)
        XCTAssertEqual(notified.posted.first?.content.title, "Can't reach Lifestream")
        XCTAssertEqual(notified.posted.first?.content.body, "Lifestream isn't answering")
        await probe()
        XCTAssertEqual(notified.posted.count, 1)

        let runBefore = await shipper.status().lastRunAt
        XCTAssertNil(runBefore)
        let revision = link.snapshot.revision
        let removed = notified.removed
        door.mode = .answering
        await probe()
        XCTAssertEqual(link.snapshot.reach, .answering)
        XCTAssertEqual(link.snapshot.revision, revision + 1)
        try await until("the notification taken back") { notified.removed == removed + 1 }
        try await until("a run, started by the heal") { await shipper.status().lastRunAt != nil }
        try await until("the menu says the sync") { menu.hasPrefix("Lifestream: synced") }
        XCTAssertEqual(notified.posted.count, 1)
    }

    func testADeployInsideTheMarkIsAStartNeverAnOutage() async throws {
        let (time, door, link, coordinator) = (time!, door!, link!, coordinator!)
        await link.restarting {
            door.mode = .starting
            time.pass(5)
            _ = await coordinator.knock()
            for _ in 0..<6 {
                time.pass(HomeLink.probeEvery)
                await link.probeSoon()
            }
        }
        XCTAssertEqual(link.snapshot.reach, .starting(HomeLink.Starting(title: "Your home is starting", line: "It answers in a moment."),
                                                      since: start.addingTimeInterval(5)),
                       "the mark's ready phase: the door's own title and line")
        await probe()
        door.mode = .answering
        await probe()
        XCTAssertEqual(link.snapshot.reach, .answering)
        try await until("the answer shown") { shown.last == .answering }
        XCTAssertFalse(shown.contains { if case .unreachable = $0 { true } else if case .held = $0 { true } else { false } },
                       "the deploy was said: \(shown)")
        XCTAssertEqual(notified.posted.count, 0)
    }

    func testTheSocketAnsweringHealsNoDoorThatIsDown() async throws {
        let failures = Counter()
        let home = try ScriptedHome { _ in ["result": ["requests": [Any]()]] }
        defer { home.stop() }
        let link = link!
        let socket = HomeSocket(path: home.path, folder: home.folder, failed: { failures.add(); Task { await link.probeSoon() } })
        _ = try await ConnectorsHome(socket: socket).connectRequests()
        let reached = link.snapshot.lastReached

        door.mode = .stopped
        time.pass(30)
        let stopped = time.now
        _ = await coordinator.knock()
        await probe()
        await probe()
        XCTAssertEqual(link.snapshot.reach, .unreachable(.silent, since: stopped))
        _ = try await ConnectorsHome(socket: socket).connectRequests()
        XCTAssertEqual(link.snapshot.reach, .unreachable(.silent, since: stopped), "the socket healed reach")
        XCTAssertEqual(link.snapshot.lastReached, reached, "the socket moved the clock")
        XCTAssertEqual(failures.count, 0)
        try await until("the menu's line") { menu.hasPrefix("Lifestream isn't answering") }
    }
}

final class StandInDoor: HomeTransport, @unchecked Sendable {
    enum Mode { case answering, stopped, starting, refusing }

    private let lock = NSLock()
    private var _mode = Mode.answering
    private var count = 0
    var mode: Mode {
        get { lock.withLock { _mode } }
        set { lock.withLock { _mode = newValue } }
    }
    var exchanges: Int { lock.withLock { count } }

    func identify(_ address: URL, within: TimeInterval) async throws -> String { "" }

    private static var refused: HomeResponse {
        HomeResponse(status: 401, body: Data(#"{"code":"PRINCIPAL_UNKNOWN","message":"This pass is not known here."}"#.utf8))
    }

    func perform(_ request: HomeRequest) async throws -> HomeResponse {
        if mode == .refusing { return Self.refused }
        guard request.url.path == "/v1/exchange" else { return HomeResponse(status: 404, body: Data("{}".utf8)) }
        let (mode, n) = lock.withLock { () -> (Mode, Int) in
            count += 1
            return (_mode, count)
        }
        switch mode {
        case .stopped:
            throw URLError(.cannotConnectToHost)
        case .starting:
            return HomeResponse(status: 503, body: Data(#"{"code":"NOT_NOW","wait":"starting","message":"Your home is starting: it answers in a moment.","title":"Your home is starting","line":"It answers in a moment.","acts":[]}"#.utf8))
        case .refusing:
            return Self.refused
        case .answering:
            let answer: [String: Any] = ["home": ["id": "h-00000001", "version": "5b3c0d2", "generation": 500, "floors": ["mac": "0.1.0"]],
                                         "pass": "p-00000001", "unit": "macbook-pro-0001", "sources": [:], "owner": [String](),
                                         "needs": [Any](), "calls": [Any](), "settings": [String: Any](),
                                         "turn": ["run": "0000000000057a27", "n": n]]
            return HomeResponse(status: 200, body: try JSONSerialization.data(withJSONObject: answer))
        }
    }
}

final class ManualPacer: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date
    private var due: [(at: Date, fire: @Sendable () -> Void)] = []

    init(_ start: Date) {
        current = start
    }

    var now: Date { lock.withLock { current } }
    var clock: @Sendable () -> Date { { [self] in now } }
    var pacer: Pacer {
        Pacer { [self] seconds, fire in lock.withLock { due.append((current.addingTimeInterval(seconds), fire)) } }
    }

    func pass(_ seconds: TimeInterval) {
        move(to: now.addingTimeInterval(seconds))
    }

    func move(to end: Date) {
        while true {
            let next = lock.withLock { () -> (@Sendable () -> Void)? in
                guard let index = due.indices.filter({ due[$0].at <= end }).min(by: { due[$0].at < due[$1].at }) else {
                    current = max(current, end)
                    return nil
                }
                let timer = due.remove(at: index)
                current = max(current, timer.at)
                return timer.fire
            }
            guard let next else { return }
            next()
        }
    }
}

final class StoredPass: Credentials, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    init(_ data: Data?) { self.data = data }
    func read() throws -> Data? { lock.withLock { data } }
    func write(_ data: Data) throws { lock.withLock { self.data = data } }
    func delete() throws { lock.withLock { data = nil } }
}

@MainActor final class NoticeLog {
    var posted: [UNNotificationRequest] = []
    var removed = 0
    var asked = 0
    var allow = true
    var held = false
    private var waiting: [CheckedContinuation<Bool, Never>] = []

    var notices: ShippingCoordinator.Notices {
        ShippingCoordinator.Notices(
            ask: { [self] in
                asked += 1
                guard held else { return allow }
                return await withCheckedContinuation { waiting.append($0) }
            },
            post: { [self] in posted.append($0) },
            remove: { [self] in removed += 1 })
    }

    var asking: Bool { !waiting.isEmpty }

    func answer(_ allowed: Bool) {
        let asks = waiting
        waiting = []
        for ask in asks { ask.resume(returning: allowed) }
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    var count: Int { lock.withLock { value } }
    func add() { lock.withLock { value += 1 } }
}
