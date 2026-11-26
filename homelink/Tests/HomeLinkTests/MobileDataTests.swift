import Foundation
import XCTest
@testable import HomeLink

final class MobileDataTests: XCTestCase {
    private typealias Wait = MobileData.Wait

    private enum Column: CaseIterable { case nowSmall, nowLarge, past }

    private static let seen: [MobileData.Path: [MobileData.Choice: MobileData.Allows]] = [
        .free: [.now: .all, .everything: .all, .small: .all],
        .costly: [.now: .now, .everything: .all, .small: .small],
        .lowData: [.now: .lowData, .everything: .lowData, .small: .lowData],
    ]

    private static let table: [MobileData.Allows: [Column: Wait?]] = [
        .all: [.nowSmall: nil, .nowLarge: nil, .past: nil],
        .now: [.nowSmall: nil, .nowLarge: nil, .past: .past],
        .small: [.nowSmall: nil, .nowLarge: .large, .past: .past],
        .lowData: [.nowSmall: nil, .nowLarge: .lowData, .past: .lowData],
    ]

    private static let sizes: [Int64] = [0, 49_999_999, 50_000_000, .max]

    private static func column(_ kind: WriteKind, _ bytes: Int64) -> Column {
        kind == .later ? .past : bytes < 50_000_000 ? .nowSmall : .nowLarge
    }

    private static func expected(_ path: MobileData.Path, _ choice: MobileData.Choice, loopback: Bool, pressed: Bool,
                                 _ kind: WriteKind, _ bytes: Int64) -> Wait? {
        guard !loopback, !pressed, let sees = seen[path]?[choice], let row = table[sees], let wait = row[column(kind, bytes)] else {
            return nil
        }
        return wait
    }

    func testEveryMomentDecidesAsTheTableSays() {
        XCTAssertEqual(MobileData.largeBytes, 50_000_000)
        var walked = 0
        for path in MobileData.Path.allCases {
            for choice in MobileData.Choice.allCases {
                for loopback in [false, true] {
                    for pressed in [false, true] {
                        let moment = MobileData.Moment(path: path, choice: choice, loopback: loopback, pressed: pressed)
                        let said = "\(path) \(choice) loopback \(loopback) pressed \(pressed)"
                        XCTAssertEqual(moment.stated, Self.seen[path]?[choice], "stated from the path and the choice alone: \(said)")
                        XCTAssertEqual(moment.internet, MobileData.Moment(path: path, choice: choice, loopback: false, pressed: pressed))
                        for kind in WriteKind.allCases {
                            for bytes in Self.sizes {
                                walked += 1
                                let crossing = MobileData.Crossing(
                                    costly: Self.expected(.costly, choice, loopback: loopback, pressed: pressed, kind, bytes) == nil,
                                    lowData: Self.expected(.lowData, choice, loopback: loopback, pressed: pressed, kind, bytes) == nil)
                                let want: MobileData.Decision = Self.expected(path, choice, loopback: loopback, pressed: pressed, kind, bytes)
                                    .map { .waits($0) } ?? .moves(crossing)
                                XCTAssertEqual(moment.decide(kind, bytes: bytes), want, "\(said) \(kind) \(bytes)")
                                XCTAssertEqual(moment.decide(kind, bytes: bytes).moves, want.moves)
                            }
                        }
                    }
                }
            }
        }
        XCTAssertEqual(walked, 3 * 3 * 2 * 2 * 2 * 4, "the whole table")
    }

    func testTheChoicesAreNestedAndAPressOrLoopbackCrossesEveryPath() {
        let order: [MobileData.Choice] = [.small, .now, .everything]
        for path in MobileData.Path.allCases {
            for kind in WriteKind.allCases {
                for bytes in Self.sizes {
                    let moves = order.map { MobileData.Moment(path: path, choice: $0, loopback: false, pressed: false).decide(kind, bytes: bytes).moves }
                    XCTAssertEqual(moves, moves.sorted { !$0 && $1 }, "what a smaller choice moves, a larger one moves: \(path) \(kind) \(bytes)")
                }
            }
        }
        for choice in MobileData.Choice.allCases {
            XCTAssertEqual(MobileData.Moment(path: .lowData, choice: choice, loopback: false, pressed: true).decide(.later, bytes: .max), .moves(.any))
            XCTAssertEqual(MobileData.Moment(path: .lowData, choice: choice, loopback: true, pressed: false).decide(.later, bytes: .max), .moves(.any))
        }
    }

    func testTheHomesMacOnAHotspotMovesEverythingYetStatesNow() {
        let mac = MobileData.Moment(path: .costly, choice: .now, loopback: true, pressed: false)
        XCTAssertEqual(mac.decide(.later, bytes: .max), .moves(.any), "loopback crosses no network")
        XCTAssertEqual(mac.stated, .now, "yet the home's history waits: the polls cross the Mac's link")
        XCTAssertEqual(mac.internet.decide(.later, bytes: 0), .waits(.past), "the update check crosses the hotspot")
        XCTAssertEqual(mac.internet.decide(.later, bytes: .max), .waits(.past), "and iCloud's files too")
    }

    func testCellularWithLowDataModeReadsAsLowDataMode() {
        XCTAssertEqual(MobileData.Path(expensive: true, constrained: true), .lowData, "constrained first: the bug read it as expensive")
        XCTAssertEqual(MobileData.Path(expensive: false, constrained: true), .lowData)
        XCTAssertEqual(MobileData.Path(expensive: true, constrained: false), .costly)
        XCTAssertEqual(MobileData.Path(expensive: false, constrained: false), .free, "5G with Allow More Data, an unmarked Wi-Fi")
        let both = NetworkFacts(online: true, onLocalNetwork: false, tunnelUp: true, path: 1,
                                cost: MobileData.Path(expensive: true, constrained: true))
        XCTAssertEqual(both.metered, .lowDataMode, "the old words follow the one reading")
        let moment = MobileData.Moment(path: both.cost, choice: .everything, loopback: false, pressed: false)
        XCTAssertEqual(moment.decide(.new, bytes: 50_000_000), .waits(.lowData), "Low Data Mode is respected whatever the choice")
        XCTAssertEqual(moment.stated, .lowData)
    }

    func testAWaitSaysItsWords() {
        XCTAssertEqual(Wait.past.words, "Older photos and history wait for Wi-Fi · Settings › Mobile data")
        XCTAssertEqual(Wait.large.words, "Large sends wait for Wi-Fi · Settings › Mobile data")
        XCTAssertEqual(Wait.lowData.words, "Large sends wait: Low Data Mode is on")
        XCTAssertEqual(Wait.allCases.map(\.rawValue), ["past", "large", "low-data"])
        XCTAssertEqual(MobileData.Allows.allCases.map(\.rawValue), ["all", "now", "small", "low-data"])
        XCTAssertEqual(MobileData.Choice.allCases.map(\.rawValue), ["now", "everything", "small"])
    }
}

final class MobileDataLinkTests: XCTestCase {
    private var folder: URL!
    private let phone = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil)
    private let home = "https://lifestream.example.ts.net"
    private let key = "devices.macbook-pro-0001.mobile_data"

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("mobile-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func paired(_ transport: ScriptedTransport, network: (any NetworkWatch)?, name: String? = nil) async throws -> HomeLink {
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: name ?? home, account: Fixture.account)
        return HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport, network: network)
    }

    private func bundle() throws -> URL {
        let file = folder.appendingPathComponent("b.zip")
        try Data("zip".utf8).write(to: file)
        return file
    }

    private static func on(_ cost: MobileData.Path) -> NetworkFacts {
        NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: false, path: 1, cost: cost)
    }

    func testAPathNotKnownYetIsCostly() async throws {
        for network in [MovableNetwork(nil), nil] as [MovableNetwork?] {
            let link = try await paired(ScriptedTransport([]), network: network)
            XCTAssertEqual(link.mobile(pressed: false).stated, .now, "no report yet, or no watch: costly, on the default choice")
            XCTAssertEqual(link.mobile(pressed: false).decide(.later, bytes: 0), .waits(.past))
        }
        let link = try await paired(ScriptedTransport([]), network: MovableNetwork(Self.on(.free)))
        XCTAssertEqual(link.mobile(pressed: false).stated, .all)
    }

    func testASendThatWaitsContactsNothingAndOneThatMovesCarriesItsCrossing() async throws {
        let network = MovableNetwork(Self.on(.costly))
        let transport = ScriptedTransport([.reply(201, Fixture.answer(received: 1, imported: 0))])
        let link = try await paired(transport, network: network)
        do {
            _ = try await link.send(bundle: try bundle(), id: "sha256:00aa", kind: .later)
            XCTFail("the past waits on a costly path")
        } catch LinkFailure.waits(let wait) {
            XCTAssertEqual(wait, .past)
        }
        XCTAssertTrue(transport.requests.isEmpty, "a send that waits contacts nothing")
        _ = try await link.send(bundle: try bundle(), id: "sha256:00ab", kind: .later, pressed: true)
        XCTAssertEqual(transport.requests.map(\.crossing), [.any], "a press crosses every path")
        let made = URLSessionTransport.made(transport.requests[0])
        XCTAssertTrue(made.allowsExpensiveNetworkAccess)
        XCTAssertTrue(made.allowsConstrainedNetworkAccess)
    }

    func testAHomeOnLoopbackTakesEveryPath() async throws {
        let transport = ScriptedTransport([.reply(201, Fixture.answer(received: 1, imported: 0))])
        let link = try await paired(transport, network: MovableNetwork(Self.on(.lowData)), name: "http://127.0.0.1:4680")
        _ = try await link.send(bundle: try bundle(), id: "sha256:00aa", kind: .later)
        XCTAssertEqual(transport.requests.map(\.crossing), [.any])
        XCTAssertEqual(link.mobile(pressed: false).stated, .lowData, "stated from the raw path, never from loopback")
    }

    func testTheChoiceIsTheAnswersAndATakenOneIsKeptUntilTheNextAnswer() async throws {
        let transport = ScriptedTransport([
            .reply(200, Fixture.answer(received: 0, imported: 0, extra: #","mobile_data":"small""#)),
            .reply(200, "{}"),
            .reply(200, Fixture.answer(received: 0, imported: 0, extra: #","mobile_data":"everything""#)),
            .reply(200, Fixture.answer(received: 0, imported: 0)),
        ])
        let link = try await paired(transport, network: MovableNetwork(Self.on(.costly)))
        var changes = link.mobileChanges().makeAsyncIterator()
        XCTAssertEqual(link.mobile(pressed: false).stated, .now, "unset is now")
        let fresh = try await link.exchange()
        XCTAssertEqual(fresh.mobileData, .small, "the answer carries the asker's own choice")
        _ = await changes.next()
        XCTAssertEqual(link.mobile(pressed: false).stated, .small)
        let taken = try await link.setHomeSetting(key: key, value: .string("everything"))
        XCTAssertEqual(taken, .taken(.string("everything")))
        _ = await changes.next()
        XCTAssertEqual(link.mobile(pressed: false).stated, .all, "a taken choice holds at once, with no exchange")
        _ = try await link.exchange()
        XCTAssertEqual(link.mobile(pressed: false).stated, .all, "the next answer confirms it")
        _ = try await link.exchange()
        _ = await changes.next()
        XCTAssertEqual(link.mobile(pressed: false).stated, .now, "an answer that says none is now")
    }

    func testAChangeOfPathIsTold() async throws {
        let network = MovableNetwork(Self.on(.free))
        let link = try await paired(ScriptedTransport([]), network: network)
        var changes = link.mobileChanges().makeAsyncIterator()
        network.set(Self.on(.lowData))
        _ = await changes.next()
        XCTAssertEqual(link.mobile(pressed: false).stated, .lowData)
    }

    func testAMacStatesWhatItsSendsSee() async throws {
        let mac = HomeLink.Device(kind: .mac, version: "1.4.0", model: "MacBook Pro", serial4: "0001")
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: mac, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: "http://127.0.0.1:4680")
        let transport = ScriptedTransport(Array(repeating: .reply(200, Fixture.answer(received: 0, imported: 0)), count: 3))
        let link = HomeLink(device: mac, credentials: credentials, folder: folder, transport: transport)
        link.tell(network: MobileData.Allows.lowData)
        await fulfillment(of: [transport.reached(1)], timeout: 30)
        XCTAssertEqual(try Fixture.object(transport.requests[0])["network"] as? String, "low-data")
        link.tell(network: MobileData.Allows.now)
        await fulfillment(of: [transport.reached(2)], timeout: 30)
        XCTAssertEqual(try Fixture.object(transport.requests[1])["network"] as? String, "now")
    }
}
