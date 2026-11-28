import Foundation
import DeviceFiles
import HomeLink
import Shipping
import XCTest
@testable import Lifestream

@MainActor final class WakeShippingTests: XCTestCase {
    private nonisolated static let unit = "macbook-pro-0001"
    private static let input = "input:local:\(unit)"
    private static let whatsapp = "whatsapp:15550000001:\(unit)"
    private static let photos = "apple-photos:person-a@example.com:\(unit)"
    private static let machine = "machine:local:\(unit)"
    private static let firefox = "firefox:local:\(unit)"
    private static let all = [input, whatsapp, photos, machine, firefox]
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("wake-shipping-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: folder)
    }

    private struct Built {
        let coordinator: ShippingCoordinator
        let shipper: Shipper
        let door: Door
        let domains: [String: Counted]
        let settled: Tally
        let clock: Moving
        let power: Powered
        let order: Order
        let gate: Gate
    }

    private func built(rotates: @escaping @Sendable (String) -> Bool = { _ in true }, stores: DeclaredStores? = nil) throws -> Built {
        let door = Door(sources: Self.all)
        let stored = try JSONSerialization.data(withJSONObject: ["name": "http://127.0.0.1:4680", "pass": "fake-pass-000000000000",
                                                                 "paired": true, "unit": Self.unit])
        let link = HomeLink(device: .init(kind: .mac, version: "500", model: "MacBook Pro", serial4: "0001"),
                            credentials: Stored(stored), folder: folder.appendingPathComponent("link"), transport: door, files: DeviceFiles(.plain))
        let order = Order()
        let gate = Gate()
        let domains = Dictionary(uniqueKeysWithValues: Self.all.map { ($0, Counted($0, order: order, gate: $0 == Self.whatsapp ? gate : nil)) })
        let settled = Tally()
        let shipper = Shipper(Shipper.Dependencies(
            state: ShippingState(root: folder.appendingPathComponent("ship"), files: DeviceFiles(.plain)), link: link,
            domains: { sources in sources.compactMap { domains[$0] } }, record: { _ in },
            rotateBatch: rotates,
            settle: { _, _ in
                settled.add()
                order.append("settle")
                return []
            },
            scratch: folder.appendingPathComponent("scratch", isDirectory: true)))
        let clock = Moving(Date())
        let power = Powered(.ac)
        let coordinator = ShippingCoordinator(shipper: shipper, link: link, notices: NoticeLog().notices, explain: { nil }, stores: stores,
                                              clock: { clock.now }, power: { power.mode })
        return Built(coordinator: coordinator, shipper: shipper, door: door, domains: domains, settled: settled, clock: clock, power: power,
                     order: order, gate: gate)
    }

    private func firefoxStores() throws -> (stores: DeclaredStores, history: URL) {
        let home = folder.appendingPathComponent("person", isDirectory: true)
        let history = home.appendingPathComponent("Library/Application Support/Firefox/history.json")
        try FileManager.default.createDirectory(at: history.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"{"visits":[]}"#.utf8).write(to: history)
        let state = folder.appendingPathComponent("stores", isDirectory: true)
        let mac = DeclaredStores.Mac(home: home, lifestream: { [] }, applications: [], fullDiskAccess: { true }, wake: { _ in },
                                     ledgers: Ledgers(root: state.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain)),
                                     hashCacheDirectory: state.appendingPathComponent("hash-cache", isDirectory: true),
                                     sessionDirectory: state.appendingPathComponent("sessions", isDirectory: true))
        let store: [String: Any] = ["feeder": "firefox-mac", "name": "firefox", "held": "~/Library/Application Support/Firefox/history.json",
                                    "account": "local", "engine": ["kind": "file", "files": [["member": "history.json",
                                                                                              "path": "~/Library/Application Support/Firefox/history.json"]]]]
        let declared = HomeLink.DeclaredStore(app: nil, grants: [], product: "firefox",
                                              store: try JSONDecoder().decode(HomeLink.MacStore.self, from: JSONSerialization.data(withJSONObject: store)))
        let stores = DeclaredStores(file: state.appendingPathComponent("stores.json"),
                                    consent: StoreConsent(file: state.appendingPathComponent("allowed.json"), known: [declared.digest],
                                                          files: DeviceFiles(.plain)), mac: mac)
        try stores.take(["firefox": declared])
        return (stores, history)
    }

    private func seals(_ built: Built) -> [String: Int] { built.domains.mapValues(\.seals) }

    func testARecorderWakeShipsItsSourceAloneInOneRunAndSettlesNoPhotoPass() async throws {
        let built = try built()
        _ = await built.shipper.run(.timer)
        XCTAssertEqual(seals(built), [Self.input: 1, Self.whatsapp: 1, Self.photos: 1, Self.machine: 1, Self.firefox: 1])
        XCTAssertEqual(built.settled.count, 1)
        let exchanged = built.door.exchanges

        built.coordinator.noteChanged(product: "input")
        try await until("the input wake's run") { built.domains[Self.input]!.seals == 2 }

        XCTAssertEqual(seals(built), [Self.input: 2, Self.whatsapp: 1, Self.photos: 1, Self.machine: 1, Self.firefox: 1],
                       "no other source was opened")
        XCTAssertEqual(built.door.exchanges, exchanged + 1, "one exchange for the wake")
        XCTAssertEqual(built.settled.count, 1, "a recorder's wake runs no photo pass")
        await built.coordinator.stop()
    }

    func testAPhotosChangeWakesThePhotoPassOnceItsWindowEnds() async throws {
        let built = try built()
        _ = await built.shipper.run(.timer)
        built.coordinator.noteChanged(product: "apple-photos")
        await built.coordinator.wake()
        XCTAssertEqual(built.settled.count, 1, "inside its debounce nothing runs")

        built.clock.move(by: 15)
        built.order.clear()
        await built.coordinator.wake()
        XCTAssertEqual(built.domains[Self.photos]!.seals, 2)
        XCTAssertEqual(built.settled.count, 2, "the photo pass runs with the wake, not five minutes on")
        XCTAssertEqual(built.order.all, ["settle", "seal apple-photos"], "what the pass exports is sealed in the same wake")
        XCTAssertEqual(built.domains[Self.whatsapp]!.seals, 1)
        await built.coordinator.stop()
    }

    func testABatchThatNeverRotatesIsAskedAgainOnceAndThenLeftToTheNextEvent() async throws {
        let built = try built(rotates: { _ in false })
        _ = await built.shipper.run(.timer)
        built.coordinator.noteChanged(product: "machine")
        for _ in 0..<6 {
            built.clock.move(by: 15)
            await built.coordinator.wake()
        }
        XCTAssertEqual(built.domains[Self.machine]!.seals, 3, "the first run, its wake, and one more ask: never a loop")

        built.coordinator.noteChanged(product: "machine")
        for _ in 0..<6 {
            built.clock.move(by: 15)
            await built.coordinator.wake()
        }
        XCTAssertEqual(built.domains[Self.machine]!.seals, 5, "a new event is owed one more ask, no more")
        await built.coordinator.stop()
    }

    func testAShippedWakeIsTheStampsBaselineSoTheNextAskTurnsFlushAsksNothing() async throws {
        let (stores, history) = try firefoxStores()
        let built = try built(stores: stores)
        _ = await built.shipper.run(.timer)
        await built.coordinator.watch()

        try Data(#"{"visits":[{"url":"https://example.com/","at":1790000000}]}"#.utf8).write(to: history)
        built.coordinator.noteChanged(sources: [Self.firefox])
        built.clock.move(by: 10)
        await built.coordinator.wake()
        XCTAssertEqual(built.domains[Self.firefox]!.seals, 2, "the wake read the change")
        let exchanged = built.door.exchanges

        let flushed = await built.coordinator.flush(nil, budgetMs: 2_000)
        XCTAssertEqual(flushed.ran, [])
        XCTAssertEqual(built.door.exchanges, exchanged, "what the wake read is no change to an Ask turn")
        await built.coordinator.stop()
    }

    func testAChangeHeardWhileAFlushRunsIsStillOwedAfterIt() async throws {
        let built = try built()
        _ = await built.shipper.run(.timer)
        built.gate.close()
        let flushing = Task { await built.coordinator.flush([Self.whatsapp], budgetMs: 30_000) }
        try await until("the flush is sealing") { built.gate.entered }

        built.clock.move(by: 1)
        built.coordinator.noteChanged(sources: [Self.whatsapp])
        built.gate.open()
        let result = await flushing.value
        XCTAssertEqual(result.ran, [Self.whatsapp])

        built.clock.move(by: 5)
        await built.coordinator.wake()
        XCTAssertEqual(built.domains[Self.whatsapp]!.seals, 3, "the change heard mid-flush gets its own wake")
        await built.coordinator.stop()
    }

    func testAnAskTurnsFlushWithNothingDirtyAsksNothingAndOneWithADirtyStoreFlushesItAlone() async throws {
        let built = try built()
        _ = await built.shipper.run(.timer)
        let exchanged = built.door.exchanges

        let clean = await built.coordinator.flush(nil, budgetMs: 2_000)
        XCTAssertEqual(clean.seals, [:])
        XCTAssertEqual(built.door.exchanges, exchanged, "nothing dirty: the home is not asked")

        built.power.mode = .lowPower
        built.coordinator.noteChanged(sources: [Self.whatsapp, Self.photos])
        _ = await built.coordinator.flush(nil, budgetMs: 2_000)
        XCTAssertEqual(built.door.exchanges, exchanged + 1)
        XCTAssertEqual(seals(built), [Self.input: 1, Self.whatsapp: 2, Self.photos: 1, Self.machine: 1, Self.firefox: 1],
                       "only the dirty fast source; photos wait their wake")
        await built.coordinator.stop()
    }

    private final class Door: HomeTransport, @unchecked Sendable {
        private let lock = NSLock()
        private let sources: [String]
        private var asked = 0

        init(sources: [String]) { self.sources = sources }

        var exchanges: Int { lock.withLock { asked } }

        func perform(_ request: HomeRequest) async throws -> HomeResponse {
            guard request.url.path == "/v1/exchange" else { return HomeResponse(status: 404, body: Data("{}".utf8)) }
            let n = lock.withLock { () -> Int in
                asked += 1
                return asked
            }
            let stated = Dictionary(uniqueKeysWithValues: sources.map {
                ($0, ["received": 0, "imported": 0, "formats": ["org.lifestreamprotocol.acquisition/1"], "history": true] as [String: Any])
            })
            let answer: [String: Any] = ["home": ["id": "h-00000001", "version": "5b3c0d2", "floors": ["mac": "0.1.0"]],
                                         "pass": "p-00000001", "unit": WakeShippingTests.unit, "sources": stated, "owner": [String](),
                                         "needs": [Any](), "calls": [Any](), "settings": [String: Any](), "turn": ["run": "0000000000057a27", "n": n]]
            return HomeResponse(status: 200, body: try JSONSerialization.data(withJSONObject: answer))
        }
    }

    private final class Counted: ShippingDomain, @unchecked Sendable {
        let sourceId: String
        let name: String
        private let order: Order
        private let gate: Gate?
        private let lock = NSLock()
        private var count = 0

        init(_ sourceId: String, order: Order, gate: Gate?) {
            self.sourceId = sourceId
            name = String(sourceId.prefix { $0 != ":" })
            self.order = order
            self.gate = gate
        }

        var seals: Int { lock.withLock { count } }

        func seal(_ request: SealRequest) throws -> [SealedBundle] {
            gate?.pass()
            lock.withLock { count += 1 }
            order.append("seal \(name)")
            return []
        }
    }

    private final class Order: @unchecked Sendable {
        private let lock = NSLock()
        private var seen: [String] = []
        var all: [String] { lock.withLock { seen } }
        func append(_ step: String) { lock.withLock { seen.append(step) } }
        func clear() { lock.withLock { seen = [] } }
    }

    private final class Gate: @unchecked Sendable {
        private let lock = NSLock()
        private var shut = false
        private var arrived = false
        private let opened = DispatchSemaphore(value: 0)

        var entered: Bool { lock.withLock { arrived } }

        func close() { lock.withLock { shut = true } }

        func open() {
            let waiting = lock.withLock { () -> Bool in
                defer { shut = false }
                return shut
            }
            if waiting { opened.signal() }
        }

        func pass() {
            let waits = lock.withLock { () -> Bool in
                guard shut else { return false }
                arrived = true
                return true
            }
            if waits { _ = opened.wait(timeout: .now() + 30) }
        }
    }

    private final class Tally: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        var count: Int { lock.withLock { value } }
        func add() { lock.withLock { value += 1 } }
    }

    private final class Moving: @unchecked Sendable {
        private let lock = NSLock()
        private var at: Date
        init(_ at: Date) { self.at = at }
        var now: Date { lock.withLock { at } }
        func move(by seconds: TimeInterval) { lock.withLock { at.addTimeInterval(seconds) } }
    }

    private final class Powered: @unchecked Sendable {
        private let lock = NSLock()
        private var held: PowerMode
        init(_ mode: PowerMode) { held = mode }
        var mode: PowerMode {
            get { lock.withLock { held } }
            set { lock.withLock { held = newValue } }
        }
    }

    private final class Stored: Credentials, @unchecked Sendable {
        private let lock = NSLock()
        private var data: Data?
        init(_ data: Data?) { self.data = data }
        func read() throws -> Data? { lock.withLock { data } }
        func write(_ data: Data) throws { lock.withLock { self.data = data } }
        func delete() throws { lock.withLock { data = nil } }
    }
}
