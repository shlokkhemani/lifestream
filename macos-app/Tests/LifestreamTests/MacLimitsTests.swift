import Foundation
import DeviceFiles
import HomeLink
import PhotoLibrary
import Shipping
import XCTest
@testable import Lifestream

final class MacLimitsTests: XCTestCase {
    private static let gb: Int64 = 1_000_000_000
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("mac-limits-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: folder)
    }

    func testTheSpoolRecordsUntilItsDiskIsFullAndTheHomeHearsEachLevelOnceWithTheNetworkOnEveryExchange() async throws {
        let disk = Disk(free: 6 * Self.gb)
        let volume = Volume(folder, read: { _ in disk.free }, clock: { disk.now })
        let network = ReportedNetwork()
        let door = Door()
        let link = try link(door, network: network)
        let limits = MacLimits(disk: volume, link: link)
        XCTAssertEqual(link.mobile(pressed: false).stated, .now, "a network with no path report yet costs: the past waits for its first")

        limits.start()
        try await until("the level and the network at the start") { door.changes("room") == ["ok"] && door.changes("network") == ["now"] }

        network.report(.costly)
        network.report(.lowData)
        disk.free = 4 * Self.gb
        disk.now.addTimeInterval(60)
        XCTAssertTrue(volume.fits(.new), "a low disk keeps recording")
        try await until("low told") { door.changes("room") == ["ok", "low"] }
        XCTAssertEqual(door.stated("network").last, "low-data", "the exchange states the network as it is now, told by no caller")
        network.report(.free)
        disk.free = Self.gb / 2
        disk.now.addTimeInterval(60)
        XCTAssertFalse(volume.fits(.new), "a full disk saves no frame")
        try await until("full told") { door.changes("room") == ["ok", "low", "full"] }
        XCTAssertEqual(door.stated("network").last, "all")
        disk.free = nil
        disk.now.addTimeInterval(60)
        XCTAssertTrue(volume.fits(.new), "a disk that does not read is low: recording goes on")
        try await until("low told again") { door.changes("room") == ["ok", "low", "full", "low"] }

        XCTAssertEqual(door.stated("network").count, door.stated("room").count, "every exchange states the network")
        XCTAssertEqual(door.changes("network"), ["now", "low-data", "all"],
                       "the home's own Mac on a hotspot states now though its sends all move")
        XCTAssertEqual(door.changes("room"), ["ok", "low", "full", "low"], "each level once, the unknown reading low")
        try record("stated", ["room": door.changes("room"), "network": door.changes("network")])
    }

    func testThePhotoPassAsksTheModuleForItsPastAndForICloudApart() async throws {
        let network = ReportedNetwork()
        let disk = Volume(folder, read: { _ in 100 * Self.gb })
        let paths = ShippingDomains.conventional(home: folder, spool: folder.appendingPathComponent("spool"),
                                                 fullDiskAccessWitness: folder.appendingPathComponent("witness"),
                                                 photosAllowed: { false },
                                                 importRoom: ImportRoom(onPower: { true }, disk: disk, homeFree: { nil }), files: DeviceFiles(.plain))
        let settings = MacSettings(file: folder.appendingPathComponent("settings.json"), files: DeviceFiles(.plain))
        let here = MacPhotoPass(paths: paths, link: try link(Door(), network: network), settings: settings, disk: disk)
        let away = MacPhotoPass(paths: paths, link: try link(Door(), at: "http://100.100.1.1:4680", folder: "away", network: network),
                                settings: settings, disk: disk)
        let facts = { (pass: MacPhotoPass, pressed: Bool) async -> String in
            let device = await pass.device(pressed: pressed)
            return "\(device.pastMoves ? "past moves" : "past waits"), \(device.iCloud ? "iCloud moves" : "iCloud waits")"
        }
        var seen = [[await facts(here, false), await facts(away, false)]]
        var pressed = [[await facts(here, true), await facts(away, true)]]
        for path in [.free, .costly, .free, .lowData] as [MobileData.Path] {
            network.report(path)
            seen.append([await facts(here, false), await facts(away, false)])
            pressed.append([await facts(here, true), await facts(away, true)])
        }
        let free = ["past moves, iCloud moves", "past moves, iCloud moves"]
        let held = ["past moves, iCloud waits", "past waits, iCloud waits"]
        XCTAssertEqual(seen, [held, free, held, free, held],
                       "unknown, a hotspot and Low Data Mode hold the past and iCloud's downloads; a home on this Mac takes its past on any")
        XCTAssertEqual(pressed, Array(repeating: free, count: 5), "a press moves the past and iCloud's files on any network")
    }

    func testSetUpCountsItsDaysAboveTheLineAndRefusesADiskUnderIt() {
        XCTAssertEqual(Runway.days(free: Double(Room.keepBytes)), 0, "nothing above the line: no day")
        XCTAssertEqual(Runway.days(free: Double(Room.keepBytes) + Runway.daily * 3.5), 3, "whole days above the line")
        XCTAssertNil(Runway.full(free: Double(Room.keepBytes)), "5 GB free is the line, and Set up takes it")
        XCTAssertNotNil(Runway.full(free: Double(Room.keepBytes) - 1), "under it, refused by the one line")
    }


    private func link(_ door: Door, at name: String = "http://127.0.0.1:4680", folder sub: String = "link",
                      network: (any NetworkWatch)? = nil) throws -> HomeLink {
        let stored = try JSONSerialization.data(withJSONObject: ["name": name, "pass": "fake-pass-000000000000",
                                                                 "paired": true, "unit": "macbook-pro-0001"])
        return HomeLink(device: .init(kind: .mac, version: "500", model: "MacBook Pro", serial4: "0001"),
                        credentials: Stored(stored), folder: folder.appendingPathComponent(sub), transport: door, network: network,
                        files: DeviceFiles(.plain))
    }

    private func record(_ name: String, _ object: Any) throws {
        let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".build/e2e/mac-limits", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
            .write(to: folder.appendingPathComponent(name + ".json"))
    }

    private final class Door: HomeTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var bodies: [[String: Any]] = []

        func stated(_ member: String) -> [String] { lock.withLock { bodies.compactMap { $0[member] as? String } } }
        func changes(_ member: String) -> [String] {
            stated(member).reduce(into: []) { if $0.last != $1 { $0.append($1) } }
        }

        func perform(_ request: HomeRequest) async throws -> HomeResponse {
            guard request.url.path == "/v1/exchange" else { return HomeResponse(status: 404, body: Data("{}".utf8)) }
            let n = lock.withLock { () -> Int in
                if case .json(let data) = request.body, let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    bodies.append(body)
                }
                return bodies.count
            }
            let answer: [String: Any] = ["home": ["id": "h-00000001", "version": "5b3c0d2", "floors": ["mac": "0.1.0"]],
                                         "pass": "p-00000001", "unit": "macbook-pro-0001", "sources": [:], "owner": [String](),
                                         "needs": [Any](), "calls": [Any](), "settings": [String: Any](), "turn": ["run": "0000000000057a27", "n": n]]
            return HomeResponse(status: 200, body: try JSONSerialization.data(withJSONObject: answer))
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

    private final class Disk: @unchecked Sendable {
        private let lock = NSLock()
        private var bytes: Int64?
        private var at = Date(timeIntervalSince1970: 1_800_000_000)
        init(free: Int64?) { bytes = free }
        var free: Int64? {
            get { lock.withLock { bytes } }
            set { lock.withLock { bytes = newValue } }
        }
        var now: Date {
            get { lock.withLock { at } }
            set { lock.withLock { at = newValue } }
        }
    }
}

final class ReportedNetwork: NetworkWatch, @unchecked Sendable {
    private let lock = NSLock()
    private var latest: NetworkFacts?
    private var readers: [AsyncStream<NetworkFacts>.Continuation] = []

    init() {}

    var facts: NetworkFacts? { lock.withLock { latest } }

    func changes() -> AsyncStream<NetworkFacts> {
        AsyncStream { continuation in
            lock.withLock {
                readers.append(continuation)
                if let latest { continuation.yield(latest) }
            }
        }
    }

    func report(_ cost: MobileData.Path) {
        lock.withLock {
            let facts = NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: true, path: (latest?.path ?? 0) + 1, cost: cost)
            latest = facts
            for reader in readers { reader.yield(facts) }
        }
    }
}
