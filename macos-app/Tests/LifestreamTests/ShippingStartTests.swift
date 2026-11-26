import DeviceFiles
import Foundation
import HomeLink
import os
import Shipping
import XCTest
@testable import Lifestream

@MainActor final class ShippingStartTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("shipping-start-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: folder)
    }

    private final class Door: HomeTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var generation = 499
        private var answered: [Int] = []
        private var statements: [[String: String]] = []
        var exchanges: [Int] { lock.withLock { answered } }
        var recorders: [[String: String]] { lock.withLock { statements } }
        var running: Int { lock.withLock { generation } }
        func install(_ next: Int) { lock.withLock { generation = next } }
        func perform(_ request: HomeRequest) async throws -> HomeResponse {
            guard request.url.path == "/v1/exchange" else { return HomeResponse(status: 404, body: Data("{}".utf8)) }
            var body: [String: Any]?
            if case .json(let data) = request.body { body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] }
            let generation = lock.withLock {
                answered.append(self.generation)
                if let recorder = body?["recorder"] as? [String: String] { statements.append(recorder.merging(["at": "\(self.generation)"]) { $1 }) }
                return self.generation
            }
            let n = lock.withLock { answered.count }
            let answer: [String: Any] = ["home": ["id": "h-00000001", "version": "5b3c0d2", "generation": generation, "floors": ["mac": "0.1.0"]],
                                         "pass": "p-00000001", "unit": "macbook-pro-0001", "sources": [:], "owner": [String](),
                                         "needs": [Any](), "calls": [Any](), "settings": [String: Any](), "turn": ["run": "0000000000057a27", "n": n]]
            return HomeResponse(status: 200, body: try JSONSerialization.data(withJSONObject: answer))
        }
    }

    private final class Stored: Credentials, @unchecked Sendable {
        private var data: Data?
        init(_ data: Data?) { self.data = data }
        func read() throws -> Data? { data }
        func write(_ data: Data) throws { self.data = data }
        func delete() throws { data = nil }
    }

    private func ready(_ heal: Task<Void, Never>, _ link: HomeLink) -> LaunchReady {
        let ready = LaunchReady(heal: heal, pacer: ManualPacer(Date(timeIntervalSince1970: 1_794_837_720)).pacer)
        ready.hold(link)
        return ready
    }

    func testTheHomesFolderIsKeptOutOfShippingByThePointerAloneWithNoHomeJSON() throws {
        let home = folder.appendingPathComponent("Lifestream", isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let pointer = folder.appendingPathComponent("home")
        XCTAssertEqual(ShippingCoordinator.keptOut(pointer: pointer), [], "no pointer")
        try (home.path + "\n").write(to: pointer, atomically: true, encoding: .utf8)
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent("HOME.json").path))
        XCTAssertEqual(ShippingCoordinator.keptOut(pointer: pointer), [home], "a folder whose HOME.json does not read")
    }

    func testTheFirstExchangeAfterALaunchWaitsForTheHealAndMeetsTheReleaseItInstalled() async throws {
        let door = Door()
        let stored = try JSONSerialization.data(withJSONObject: ["name": "http://127.0.0.1:4680", "pass": "fake-pass-000000000000",
                                                                 "paired": true, "unit": "macbook-pro-0001"])
        let link = HomeLink(device: .init(kind: .mac, version: "500", model: "Mac15,3", serial4: nil, stamp: 500),
                            credentials: Stored(stored), folder: folder.appendingPathComponent("link"), transport: door, files: DeviceFiles(.plain))
        let shipper = Shipper(Shipper.Dependencies(state: ShippingState(root: folder.appendingPathComponent("ship"), files: DeviceFiles(.plain)), link: link,
                                                   domains: { _ in [] }, record: { _ in }, scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true)))
        let coordinator = ShippingCoordinator(shipper: shipper, link: link, notices: NoticeLog().notices, explain: { nil })
        var changes = 0
        coordinator.changed = { changes += 1 }

        let (gate, open) = AsyncStream<Void>.makeStream()
        let heal = Task {
            for await _ in gate {}
            door.install(500)
        }
        coordinator.start(after: ready(heal, link), delay: 0)
        link.tell(recorder: .starting, grants: ["screen": "granted"])
        link.tell(recorder: .recording)
        try await until("the menu's status, read while the heal runs") { changes > 0 && coordinator.status != nil }
        XCTAssertEqual(door.exchanges, [], "the home was asked before the heal was done")

        open.finish()
        try await until("the first knock's answer, saved after the heal") { link.saved != nil }
        try await until("the recorder told during the heal, carried after it") {
            door.recorders.contains(["state": "recording", "at": "500"])
        }
        XCTAssertEqual(Set(door.exchanges), [500], "an exchange met the home before the heal installed this app's release")
        XCTAssertEqual(link.saved?.home.generation, 500)
    }

    func testImportsAndAProbeAskedDuringTheHealWaitForItAndMeetTheReleaseItInstalled() async throws {
        let door = Door()
        let stored = try JSONSerialization.data(withJSONObject: ["name": "http://127.0.0.1:4680", "pass": "fake-pass-000000000000",
                                                                 "paired": true, "unit": "macbook-pro-0001"])
        let link = HomeLink(device: .init(kind: .mac, version: "500", model: "Mac15,3", serial4: nil, stamp: 500),
                            credentials: Stored(stored), folder: folder.appendingPathComponent("link"), transport: door, files: DeviceFiles(.plain))
        let shipper = Shipper(Shipper.Dependencies(state: ShippingState(root: folder.appendingPathComponent("ship"), files: DeviceFiles(.plain)), link: link,
                                                   domains: { _ in [] }, record: { _ in }, scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true)))
        let coordinator = ShippingCoordinator(shipper: shipper, link: link, notices: NoticeLog().notices, explain: { nil })
        defer { Task { await coordinator.stop() } }
        var changes = 0
        coordinator.changed = { changes += 1 }
        var told = 0
        var reports: [Int] = []
        let imports = Imports(world: Imports.World(
            carried: folder.appendingPathComponent("carried", isDirectory: true), files: DeviceFiles(.plain), clock: { Date() }, ship: {},
            report: { reports.append(door.running); return nil }, notify: { _, _ in }, homeFree: HomeFree(),
            tell: { told += 1; link.tell(imports: $0) }, looked: { _ in nil }, mark: {}))

        let (gate, open) = AsyncStream<Void>.makeStream()
        let heal = Task {
            for await _ in gate {}
            door.install(500)
        }
        let launch = ready(heal, link)
        coordinator.start(after: launch, delay: 0)
        imports.start(after: launch)
        let probing = Task { await link.probeSoon() }
        try await until("the menu's status, read while the heal runs") { changes > 0 && coordinator.status != nil }
        XCTAssertEqual(told, 0, "imports told the home before the heal was done")
        XCTAssertEqual(reports, [], "imports read the home's report before the heal was done")
        XCTAssertEqual(door.exchanges, [], "the home was asked before the heal was done")

        open.finish()
        let reach = await probing.value.reach
        XCTAssertEqual(reach, .answering, "the probe asked during the heal")
        try await until("imports' first report, after the heal") { !reports.isEmpty }
        XCTAssertGreaterThanOrEqual(told, 1)
        XCTAssertEqual(reports, [500], "imports read the home before the heal installed this app's release")
        XCTAssertEqual(Set(door.exchanges), [500], "an exchange met the home before the heal installed this app's release")
        await imports.stop()
    }

    func testAHealThatNeverEndsHoldsTheProbeOnlyToTheRestartBound() async throws {
        let start = Date(timeIntervalSince1970: 1_794_837_720)
        let time = ManualPacer(start)
        let door = StandInDoor()
        door.mode = .stopped
        let (link, coordinator) = try launched(door, time)
        defer { Task { await coordinator.stop() } }
        let (marked, mark) = AsyncStream<Void>.makeStream()
        let (never, ended) = AsyncStream<Void>.makeStream()
        defer { ended.finish() }
        let heal = Task {
            await link.restarting {
                mark.finish()
                for await _ in never {}
            }
        }
        for await _ in marked {}
        let launch = LaunchReady(heal: heal, pacer: time.pacer)
        launch.hold(link)
        coordinator.start(after: launch, delay: 0)
        let probed = OSAllocatedUnfairLock<HomeLink.ReachSnapshot?>(initialState: nil)
        Task { let after = await link.probeSoon(); probed.withLock { $0 = after } }
        try await until("the probe, the start and the tells' hold wait on the launch") { launch.waiters == 3 }
        XCTAssertEqual(door.exchanges, 0, "the home was asked before the heal was done")

        let bound = start.addingTimeInterval(HomeLink.readyBound)
        time.move(to: bound)
        try await until("the probe, ended past the restart bound") { probed.withLock { $0 } != nil }
        XCTAssertGreaterThanOrEqual(door.exchanges, 1, "the probe never knocked past the restart bound")
        XCTAssertEqual(probed.withLock { $0 }?.reach, .waiting(since: bound))
        time.pass(HomeLink.probeEvery)
        await link.probeSoon()
        time.pass(HomeLink.probeEvery)
        await link.probeSoon()
        XCTAssertEqual(link.snapshot.reach, .unreachable(.silent, since: bound), "the grace never applied")
    }

    func testAStopEndsAProbeWaitingOnTheHeal() async throws {
        let time = ManualPacer(Date(timeIntervalSince1970: 1_794_837_720))
        let door = StandInDoor()
        let (link, coordinator) = try launched(door, time)
        let (never, ended) = AsyncStream<Void>.makeStream()
        defer { ended.finish() }
        let heal = Task { for await _ in never {} }
        let launch = LaunchReady(heal: heal, pacer: time.pacer)
        launch.hold(link)
        coordinator.start(after: launch, delay: 0)
        let probed = OSAllocatedUnfairLock(initialState: false)
        Task { await link.probeSoon(); probed.withLock { $0 = true } }
        try await until("the probe, the start and the tells' hold wait on the launch") { launch.waiters == 3 }

        await coordinator.stop()
        try await until("the probe, ended by the stop") { probed.withLock { $0 } }
        XCTAssertEqual(door.exchanges, 0, "a stopped coordinator's probe knocked")
    }

    private func launched(_ door: StandInDoor, _ time: ManualPacer) throws -> (HomeLink, ShippingCoordinator) {
        let stored = try JSONSerialization.data(withJSONObject: ["name": "http://127.0.0.1:4680", "pass": "fake-pass-000000000000",
                                                                 "paired": true, "unit": "macbook-pro-0001"])
        let link = HomeLink(device: .init(kind: .mac, version: "500", model: "Mac15,3", serial4: nil),
                            credentials: StoredPass(stored), folder: folder.appendingPathComponent("link"), transport: door,
                            clock: time.clock, pacer: time.pacer, files: DeviceFiles(.plain))
        let shipper = Shipper(Shipper.Dependencies(state: ShippingState(root: folder.appendingPathComponent("ship"), files: DeviceFiles(.plain)), link: link,
                                                   domains: { _ in [] }, record: { _ in }, scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true)))
        return (link, ShippingCoordinator(shipper: shipper, link: link, notices: NoticeLog().notices, explain: { nil }))
    }

    private final class OfferDoor: HomeTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var carried: [[String]] = []
        private var gate: AsyncStream<Void>?
        var offers: [[String]] { lock.withLock { carried } }
        func hold() -> AsyncStream<Void>.Continuation {
            let (stream, open) = AsyncStream<Void>.makeStream()
            lock.withLock { gate = stream }
            return open
        }
        func perform(_ request: HomeRequest) async throws -> HomeResponse {
            guard request.url.path == "/v1/exchange" else { return HomeResponse(status: 404, body: Data("{}".utf8)) }
            guard case .json(let data) = request.body else { return HomeResponse(status: 400, body: Data("{}".utf8)) }
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let n = lock.withLock { carried.append(body?["offers"] as? [String] ?? []); return carried.count }
            if let held = lock.withLock({ defer { gate = nil }; return gate }) { for await _ in held {} }
            let answer: [String: Any] = ["home": ["id": "h-00000001", "version": "5b3c0d2", "generation": 500, "floors": ["mac": "0.1.0"]],
                                         "pass": "p-00000001", "unit": "macbook-pro-0001", "sources": [:], "owner": [String](),
                                         "needs": [Any](), "calls": [Any](), "settings": [String: Any](), "turn": ["run": "0000000000057a27", "n": n]]
            return HomeResponse(status: 200, body: try JSONSerialization.data(withJSONObject: answer))
        }
    }

    func testAnAllowedStoreWithNoSourceYetIsExchangedAtOnceEvenWhileARunGoes() async throws {
        let door = OfferDoor()
        let stored = try JSONSerialization.data(withJSONObject: ["name": "http://127.0.0.1:4680", "pass": "fake-pass-000000000000",
                                                                 "paired": true, "unit": "macbook-pro-0001"])
        let link = HomeLink(device: .init(kind: .mac, version: "500", model: "Mac15,3", serial4: nil, stamp: 500),
                            credentials: Stored(stored), folder: folder.appendingPathComponent("link"), transport: door, files: DeviceFiles(.plain))
        let allowed = OSAllocatedUnfairLock(initialState: false)
        let offer = "firefox:profile-00000001:macbook-pro-0001"
        let shipper = Shipper(Shipper.Dependencies(state: ShippingState(root: folder.appendingPathComponent("ship"), files: DeviceFiles(.plain)), link: link,
                                                   domains: { _ in [] }, offers: { _ in allowed.withLock { $0 } ? [offer] : [] },
                                                   record: { _ in }, scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true)))
        let coordinator = ShippingCoordinator(shipper: shipper, link: link, notices: NoticeLog().notices, explain: { nil })
        defer { Task { await coordinator.stop() } }

        allowed.withLock { $0 = true }
        await coordinator.refreshNow("firefox")
        XCTAssertEqual(door.offers, [[offer]], "an Allow kept for a store with no source here exchanged nothing")

        allowed.withLock { $0 = false }
        let open = door.hold()
        let going = Task { await coordinator.shipNow() }
        try await until("the run's exchange, held at the door") { door.offers.count == 2 }
        allowed.withLock { $0 = true }
        await coordinator.refreshNow("firefox")
        open.finish()
        _ = await going.value
        try await until("the run the Allow owed, after the one going") { door.offers.count == 3 }
        XCTAssertEqual(door.offers, [[offer], [], [offer]])
    }
}
