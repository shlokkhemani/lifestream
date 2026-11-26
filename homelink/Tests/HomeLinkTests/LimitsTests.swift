import Foundation
import XCTest
@testable import HomeLink

final class LimitsTests: XCTestCase {
    private static let gb: Int64 = 1_000_000_000

    func testTheNumbersAreTheHomesNumbers() throws {
        let disk = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/core/disk.ts")
        let source = try String(contentsOf: disk, encoding: .utf8)
        func constant(_ name: String) -> Int64? {
            guard let line = source.split(separator: "\n").first(where: { $0.hasPrefix("export const \(name) = ") }) else { return nil }
            let value = line.dropFirst("export const \(name) = ".count).prefix { $0 != ";" }
            return Int64(value.replacingOccurrences(of: "_", with: ""))
        }
        XCTAssertEqual(constant("KEEP_BYTES"), Room.keepBytes, "the line every disk keeps free")
        XCTAssertEqual(constant("BOTTOM_BYTES"), Room.bottomBytes, "the bottom")
        XCTAssertEqual(Room.keepBytes, 5_000_000_000, "decimal, as Finder and iOS Settings count")
        XCTAssertEqual(Room.bottomBytes, 1_000_000_000)
    }

    func testTheLevelOfADisk() {
        XCTAssertEqual(Room(free: 5 * Self.gb), .ok, "5 GB free is ok: decimal, under 5 GiB")
        XCTAssertEqual(Room(free: 5 * Self.gb - 1), .low)
        XCTAssertEqual(Room(free: Self.gb), .low, "1 GB free is low")
        XCTAssertEqual(Room(free: Self.gb - 1), .full)
        XCTAssertEqual(Room(free: 0), .full)
        XCTAssertEqual(Room(free: nil), .low, "an unknown reading is low: history waits, new data goes on")
    }

    func testWhetherAWriteFits() {
        XCTAssertTrue(Room.fits(.later, bytes: Self.gb, free: 6 * Self.gb), "a later write leaves 5 GB")
        XCTAssertFalse(Room.fits(.later, bytes: Self.gb + 1, free: 6 * Self.gb), "one that crosses the line does not land")
        XCTAssertFalse(Room.fits(.later, bytes: 0, free: 5 * Self.gb - 1), "nothing later on a low disk")
        XCTAssertTrue(Room.fits(.new, bytes: 3 * Self.gb, free: 4 * Self.gb), "new data lands on a low disk, leaving 1 GB")
        XCTAssertFalse(Room.fits(.new, bytes: 3 * Self.gb + 1, free: 4 * Self.gb))
        XCTAssertFalse(Room.fits(.new, bytes: 0, free: Self.gb - 1), "nothing on a full disk")
        XCTAssertTrue(Room.fits(.new, bytes: 10 * Self.gb, free: nil), "unknown: new data goes on")
        XCTAssertFalse(Room.fits(.later, bytes: 0, free: nil), "unknown: history waits")
        XCTAssertEqual(Room.spare(free: 5 * Self.gb + 7), 7, "what a later write may take")
        XCTAssertEqual(Room.spare(free: 4 * Self.gb), 0)
        XCTAssertEqual(Room.spare(free: nil), 0)
        XCTAssertEqual(Room.toFree(.new, bytes: 3 * Self.gb, free: 3 * Self.gb), Self.gb, "what to free so the write leaves 1 GB")
        XCTAssertEqual(Room.toFree(.new, bytes: 3 * Self.gb, free: 4 * Self.gb), 0, "none when it fits")
        XCTAssertEqual(Room.toFree(.later, bytes: Self.gb, free: 5 * Self.gb), Self.gb)
        let volume = Volume(FileManager.default.temporaryDirectory, read: { _ in 3 * Self.gb })
        XCTAssertEqual(volume.toFree(.new, bytes: 3 * Self.gb), Self.gb)
        XCTAssertEqual(volume.fits(.new, bytes: 3 * Self.gb), volume.toFree(.new, bytes: 3 * Self.gb) == 0, "the same rule")
        XCTAssertNotNil(Room.free(at: FileManager.default.temporaryDirectory), "a device reads its own disk")
    }

    func testWhatMayMoveOnAMeteredNetwork() {
        let large = Transfer.largeBytes
        XCTAssertEqual(large, 50_000_000)
        for kind in WriteKind.allCases {
            for bytes in [0, large - 1, large] {
                for pressed in [false, true] {
                    XCTAssertTrue(Transfer.mayMove(kind, bytes: bytes, pressed: pressed, metered: false),
                                  "a free network moves everything: \(kind) \(bytes) \(pressed)")
                }
            }
        }
        XCTAssertTrue(Transfer.mayMove(.new, bytes: large - 1, pressed: false, metered: true), "new data under 50 MB never waits")
        XCTAssertFalse(Transfer.mayMove(.new, bytes: large, pressed: false, metered: true), "50 MB of new data waits")
        XCTAssertFalse(Transfer.mayMove(.later, bytes: 1, pressed: false, metered: true), "a later transfer waits, however small")
        XCTAssertTrue(Transfer.mayMove(.new, bytes: large, pressed: true, metered: true), "a press moves what it names")
        XCTAssertTrue(Transfer.mayMove(.later, bytes: large, pressed: true, metered: true))
    }

    func testAVolumeReadsAtMostOnceAMinuteAndSaysEachChangeOfLevelOnce() {
        let disk = Disk(free: 6 * Self.gb)
        let volume = Volume(URL(fileURLWithPath: "/"), read: { _ in disk.free }, clock: { disk.now })
        let heard = Heard()
        volume.observe { heard.add($0) }
        XCTAssertEqual(volume.room, .ok)
        XCTAssertTrue(volume.fits(.later))
        XCTAssertTrue(volume.fits(.new))
        disk.free = 2 * Self.gb
        XCTAssertEqual(volume.room, .ok, "the reading stands for a minute")
        XCTAssertTrue(volume.fits(.later), "and so for a write counted as nothing")
        XCTAssertEqual(disk.reads, 1, "one read for every such ask within it")
        disk.now.addTimeInterval(60)
        XCTAssertEqual(volume.room, .low)
        disk.now.addTimeInterval(60)
        XCTAssertEqual(volume.room, .low)
        disk.free = Self.gb / 2
        disk.now.addTimeInterval(60)
        XCTAssertFalse(volume.fits(.new))
        disk.free = nil
        disk.now.addTimeInterval(60)
        XCTAssertEqual(volume.room, .low, "a disk that does not read is low")
        XCTAssertEqual(heard.rooms, [.ok, .low, .full, .low], "each change once")
        disk.now.addTimeInterval(-3600)
        disk.free = 9 * Self.gb
        XCTAssertEqual(volume.room, .ok, "a clock set back reads again")
    }

    func testAWriteThatBringsBytesReadsTheDiskAfreshSoTwoWritesCannotTakeTheSameRoom() {
        let disk = Disk(free: 1_150_000_000)
        let volume = Volume(URL(fileURLWithPath: "/"), read: { _ in disk.free }, clock: { disk.now })
        let blob: Int64 = 100_000_000
        XCTAssertEqual(volume.room, .low)
        XCTAssertTrue(volume.fits(.new, bytes: blob), "the first leaves 1.05 GB")
        disk.free = 1_050_000_000
        XCTAssertFalse(volume.fits(.new, bytes: blob), "the second would leave 0.95 GB, under the bottom")
        XCTAssertEqual(disk.reads, 3, "each write that brings bytes read the disk")
        XCTAssertTrue(volume.fits(.new), "an entry, counted as nothing, takes the reading just made")
        disk.free = 0
        XCTAssertEqual(volume.room, .low, "the level drawn keeps the minute's reading")
        XCTAssertEqual(volume.spare, 0, "what a pass may fetch is read afresh")
        XCTAssertEqual(volume.room, .full, "and moves the level with it")
        XCTAssertEqual(disk.reads, 4)
    }

    func testTheLevelReachesTheHomeOnceAChangeAndEveryExchangeCarriesIt() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("limits-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let phone = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil)
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: "https://lifestream.example.ts.net", account: Fixture.account)
        let transport = ScriptedTransport([.reply(200, Fixture.answer(received: 0, imported: 0))])
        let link = HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport)
        _ = try await link.exchange()
        XCTAssertNil(try Fixture.object(transport.requests[0])["room"], "none before any is told")

        link.tell(room: .low)
        await fulfillment(of: [transport.reached(2)], timeout: 30)
        XCTAssertEqual(try Fixture.object(transport.requests[1])["room"] as? String, "low", "a change is one exchange of its own")
        link.tell(room: .low)
        _ = try await link.exchange()
        XCTAssertEqual(transport.requests.count, 3, "a repeat makes none")
        XCTAssertEqual(try Fixture.object(transport.requests[2])["room"] as? String, "low", "an exchange made for another reason carries it")
        XCTAssertFalse(link.owesExchange)
        link.tell(room: .full)
        await fulfillment(of: [transport.reached(4)], timeout: 30)
        XCTAssertEqual(try Fixture.object(transport.requests[3])["room"] as? String, "full")
    }

    func testAMacsNetworkReachesTheHomeOnceAChangeAndEveryExchangeCarriesIt() async throws {
        XCTAssertEqual(NetworkCost(NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: false, metered: .expensive)), .metered)
        XCTAssertEqual(NetworkCost(NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: false, metered: .lowDataMode)), .metered)
        XCTAssertEqual(NetworkCost(NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: false)), .free)
        XCTAssertTrue(Watch(nil).metered, "a network with no path report yet is metered: what waits for it waits for its first")
        XCTAssertTrue(Watch(NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: false, metered: .lowDataMode)).metered)
        XCTAssertFalse(Watch(NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: false)).metered)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("limits-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let mac = HomeLink.Device(kind: .mac, version: "1.4.0", model: "MacBook Pro", serial4: "0001")
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: mac, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: "http://127.0.0.1:4680")
        let transport = ScriptedTransport([.reply(200, Fixture.answer(received: 0, imported: 0))])
        let link = HomeLink(device: mac, credentials: credentials, folder: folder, transport: transport)
        _ = try await link.exchange()
        XCTAssertNil(try Fixture.object(transport.requests[0])["network"], "none before any is told")

        link.tell(network: MobileData.Allows.now)
        await fulfillment(of: [transport.reached(2)], timeout: 30)
        XCTAssertEqual(try Fixture.object(transport.requests[1])["network"] as? String, "now", "a change is one exchange of its own")
        link.tell(network: MobileData.Allows.now)
        _ = try await link.exchange()
        XCTAssertEqual(transport.requests.count, 3, "a repeat makes none")
        XCTAssertEqual(try Fixture.object(transport.requests[2])["network"] as? String, "now", "an exchange made for another reason carries it")
        XCTAssertFalse(link.owesExchange)
        link.tell(network: MobileData.Allows.all)
        await fulfillment(of: [transport.reached(4)], timeout: 30)
        XCTAssertEqual(try Fixture.object(transport.requests[3])["network"] as? String, "all")
    }

    func testAnUploadToAHomeOnLoopbackMayTakeAnyPathWhileOneElsewhereIsKeptOffTheCostlyOnes() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("limits-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let bundle = folder.appendingPathComponent("b.zip")
        try Data("zip".utf8).write(to: bundle)
        let mac = HomeLink.Device(kind: .mac, version: "1.4.0", model: "MacBook Pro", serial4: "0001")
        var sent: [MobileData.Crossing] = []
        let free = Watch(NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: true))
        for (index, home) in ["http://127.0.0.1:4680", "http://100.100.1.1:4680"].enumerated() {
            let credentials = MemoryCredentials()
            let place = folder.appendingPathComponent("\(index)", isDirectory: true)
            try FileManager.default.createDirectory(at: place, withIntermediateDirectories: true)
            _ = try await HomeLink(device: mac, credentials: credentials, folder: place, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
                .pair(code: "12345678", name: home)
            let transport = ScriptedTransport([.reply(201, Fixture.answer(received: 1, imported: 0))])
            _ = try await HomeLink(device: mac, credentials: credentials, folder: place, transport: transport, network: free)
                .send(bundle: bundle, id: "sha256:00aa", kind: .later)
            sent += transport.requests.map(\.crossing)
        }
        XCTAssertEqual(sent, [.any, MobileData.Crossing(costly: false, lowData: false)],
                       "loopback crosses no network; a history page to a home elsewhere crosses no path that costs")
    }

    func testEveryRouteHomeLinkRelaysAgreesWithTheDoorsTableOnAgainAndWait() throws {
        let door = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/home/door.ts")
        let source = try String(contentsOf: door, encoding: .utf8)
        let whole = NSRange(source.startIndex..., in: source)
        let text = { (match: NSTextCheckingResult, group: Int) in Range(match.range(at: group), in: source).map { String(source[$0]) } }
        var constants: [String: Double] = [:]
        for match in try NSRegularExpression(pattern: #"^const ([A-Z_]+) = ([\d_]+);"#, options: .anchorsMatchLines).matches(in: source, range: whole) {
            if let name = text(match, 1), let value = text(match, 2).flatMap({ Double($0.replacingOccurrences(of: "_", with: "")) }) {
                constants[name] = value
            }
        }
        let row = try NSRegularExpression(pattern: #"^\s*"([A-Z]+ /v1/[^"]+)": \{(.*)\},?\s*$"#, options: .anchorsMatchLines)
        let again = try NSRegularExpression(pattern: #"\bagain: (true|false)\b"#)
        let wait = try NSRegularExpression(pattern: #"\bwait_ms: ([A-Z_]+|[\d_]+)\b"#)
        var routes: [String: Relay] = [:]
        for match in row.matches(in: source, range: whole) {
            guard let route = text(match, 1), let members = text(match, 2) else { continue }
            let span = NSRange(members.startIndex..., in: members)
            let said = again.firstMatch(in: members, range: span).flatMap { Range($0.range(at: 1), in: members) }.map { members[$0] == "true" }
            let waited = wait.firstMatch(in: members, range: span).flatMap { Range($0.range(at: 1), in: members) }.map { String(members[$0]) }
                .flatMap { constants[$0] ?? Double($0.replacingOccurrences(of: "_", with: "")) }
            if let said, let waited { routes[route] = Relay(again: said, wait: waited / 1000) }
        }
        XCTAssertGreaterThan(routes.count, 20, "the door's ACTS read: route to { again, wait_ms }")
        for (route, relay) in HomeLink.acts.sorted(by: { $0.key < $1.key }) {
            XCTAssertEqual(routes[route], relay, "\(route): the door's again and wait_ms, and a route it names")
        }
        for route in HomeLink.answeredAgain.sorted() {
            XCTAssertNil(routes[route], "\(route) is answered again by the door itself: no relay of its own")
        }
        XCTAssertEqual(["POST /v1/owner/act", "POST /v1/exchange drained", "POST /v1/exchange", "GET /v1/days/2026-11-11",
                        "POST /v1/ask/stop", "POST /v1/home/verify", "GET /v1/places/suggest"].map(HomeLink.sentAgain),
                       [true, false, true, true, false, false, false],
                       "the table's word, then a read and what the door answers again itself, else never")
        XCTAssertEqual(HomeLink.route(method: "GET", path: "/v1/places/suggest?spot=s&q=a"), "GET /v1/places/suggest", "a query is no route")
    }

    func testTheDashboardsBudgetIsHomeLinksWithOneHopMoreLeftForItsLastSend() throws {
        let reach = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("dashboard/public/lib/reach.js")
        let source = try String(contentsOf: reach, encoding: .utf8)
        func constant(_ name: String) -> Double? {
            guard let line = source.split(separator: "\n").first(where: { $0.hasPrefix("export const \(name) = ") }) else { return nil }
            let value = line.dropFirst("export const \(name) = ".count).prefix { $0 != ";" }
            return Double(value.replacingOccurrences(of: "_", with: ""))
        }
        XCTAssertEqual(constant("ACT_MS"), Budget.whole * 1000, "one deadline for an act")
        XCTAssertEqual(constant("SEND_MS"), Budget.each * 1000, "one send's wait")
        XCTAssertEqual(constant("SENDS").map(Int.init), Budget.sends, "at most two sends")
        XCTAssertEqual(constant("LAST_SEND_MS"), (Budget.least + 1) * 1000, "the dashboard's server is one hop more, 1 s")
    }

    func testAnActWithAgainHasOneDeadlineAndTwoSendsTheSecondOnlyWithThreeSecondsLeft() {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let at = { (seconds: TimeInterval) in start.addingTimeInterval(seconds) }
        XCTAssertEqual([Budget.whole, Budget.each, Budget.least, TimeInterval(Budget.sends)], [15, 10, 3, 2])

        let act = Budget(Relay(again: true), now: start)
        XCTAssertEqual(act.deadline, at(15), "one deadline, made when the act starts")
        XCTAssertEqual(act.send(at(0)), 10, "the first waits ten seconds")
        XCTAssertEqual(act.send(at(10)), 5, "the second waits what is left: door by four, home begins by three")
        XCTAssertNil(act.send(at(10)), "never a third")

        let late = Budget(Relay(again: true), now: start)
        XCTAssertEqual(late.send(at(1)), 10)
        XCTAssertEqual(late.send(at(12)), 3, "three seconds left: the door two, the home one to begin")
        let later = Budget(Relay(again: true), now: start)
        XCTAssertEqual(later.send(at(0)), 10)
        XCTAssertNil(later.send(at(12.5)), "under three seconds left it would be refused before it could begin")
        XCTAssertNil(Budget(Relay(again: true), now: start).send(at(12.5)), "nothing is sent with under three seconds left")

        let once = Budget(Relay(again: false), now: start)
        XCTAssertEqual(once.deadline, at(30))
        XCTAssertEqual(once.send(at(0)), 30, "a route without again: one send of its wait")
        XCTAssertNil(once.send(at(1)), "nothing it sends may be sent again")
        XCTAssertEqual(Budget(Relay(again: false, wait: 5), now: start).send(at(0)), 5, "a typed suggestion: five seconds, once")
        XCTAssertNil(Budget(Relay(again: false, wait: 5), now: start).send(at(2.5)))
    }

    func testAnActWhoseAnswerWasLostIsSentOnceMoreOnlyByTheDoorsWord() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("limits-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let mac = HomeLink.Device(kind: .mac, version: "1.4.0", model: "MacBook Pro", serial4: "0001")
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: mac, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: "http://127.0.0.1:4680")
        let again = ScriptedTransport([.unreachable, .reply(200, #"{"act":"act-2","id":"person:a","position":"2:1800000000000"}"#)])
        _ = try await HomeLink(device: mac, credentials: credentials, folder: folder, transport: again)
            .act(.people(request: "r-1", .undo(act: "act-1")))
        XCTAssertEqual(again.requests.map(\.url.path), ["/v1/owner/act", "/v1/owner/act"], "a people act: sent once more")
        XCTAssertEqual(again.requests[0].body, again.requests[1].body, "the same request")
        XCTAssertEqual(again.requests.map { $0.headers[HomeLink.waitHeader] }, ["10000", "10000"], "each try says its wait")
        XCTAssertEqual(again.requests.map(\.timeout), [Budget.each, Budget.each], "and waits it, not a minute")

        let once = ScriptedTransport([.unreachable, .reply(200, "{}")])
        do {
            try await HomeLink(device: mac, credentials: credentials, folder: folder, transport: once).act(need: "n-1", do: "try")
            XCTFail("a need's act whose answer was lost is no answer")
        } catch LinkFailure.noAnswer {}
        XCTAssertEqual(once.requests.map(\.url.path), ["/v1/act"], "a need's act: the first may have settled it, never sent again")
        XCTAssertEqual(once.requests.map { $0.headers[HomeLink.waitHeader] }, ["30000"], "its route's whole wait, once")
    }
}

private struct Watch: NetworkWatch {
    let facts: NetworkFacts?
    init(_ facts: NetworkFacts?) { self.facts = facts }
    func changes() -> AsyncStream<NetworkFacts> { AsyncStream { $0.finish() } }
}

private final class Disk: @unchecked Sendable {
    private let lock = NSLock()
    private var bytes: Int64?
    private var at = Date(timeIntervalSince1970: 1_800_000_000)
    private var count = 0

    init(free: Int64?) { bytes = free }

    var free: Int64? {
        get { lock.withLock { count += 1; return bytes } }
        set { lock.withLock { bytes = newValue } }
    }
    var reads: Int { lock.withLock { count } }
    var now: Date {
        get { lock.withLock { at } }
        set { lock.withLock { at = newValue } }
    }
}

private final class Heard: @unchecked Sendable {
    private let lock = NSLock()
    private var heard: [Room] = []
    var rooms: [Room] { lock.withLock { heard } }
    func add(_ room: Room) { lock.withLock { heard.append(room) } }
}
