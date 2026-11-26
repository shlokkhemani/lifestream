import Foundation
import DeviceFiles
import HomeLink
import Shipping
import XCTest
@testable import Lifestream

final class KnockPaceTests: XCTestCase {
    private let since = Date(timeIntervalSince1970: 1_794_837_720)

    func testTheWatchKnocksOnlyWhileTheHomeAnswersAndNoKnockWaits() {
        var pace = KnockPace()
        XCTAssertTrue(pace.allows(.answering))
        for reach: HomeLink.Reach in [.waiting(since: since), .unreachable(.silent, since: since), .passRefused,
                                      .needsUpdate(.home), .unpaired] {
            XCTAssertFalse(pace.allows(reach), "the watch knocked while \(reach): the probe paces itself")
        }
        pace.sent()
        XCTAssertFalse(pace.allows(.answering), "a second knock while one waits on the home")
        pace.ended()
        XCTAssertTrue(pace.allows(.answering))
    }
}

@MainActor final class KnockWiringTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("knock-wiring-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: folder)
    }

    private final class HeldDoor: HomeTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        private var gates: [CheckedContinuation<Void, Never>] = []
        var exchanges: Int { lock.withLock { count } }

        func release() {
            lock.withLock { () -> [CheckedContinuation<Void, Never>] in
                defer { gates = [] }
                return gates
            }.forEach { $0.resume() }
        }

        func identify(_ address: URL, within: TimeInterval) async throws -> String { "" }

        func perform(_ request: HomeRequest) async throws -> HomeResponse {
            guard request.url.path == "/v1/exchange" else { return HomeResponse(status: 404, body: Data("{}".utf8)) }
            await withCheckedContinuation { (gate: CheckedContinuation<Void, Never>) in
                lock.withLock {
                    count += 1
                    gates.append(gate)
                }
            }
            throw URLError(.cannotConnectToHost)
        }
    }

    func testTheProbeIsTheKnockAndJoinsTheOneThatWaits() async throws {
        let door = HeldDoor()
        let time = ManualPacer(Date(timeIntervalSince1970: 1_794_837_720))
        let stored = try JSONSerialization.data(withJSONObject: ["name": "http://127.0.0.1:4680", "pass": "fake-pass-000000000000",
                                                                 "paired": true, "unit": "macbook-pro-0001"])
        let link = HomeLink(device: .init(kind: .mac, version: "500", model: "Mac15,3", serial4: nil),
                            credentials: StoredPass(stored), folder: folder.appendingPathComponent("link"), transport: door,
                            clock: time.clock, pacer: time.pacer, files: DeviceFiles(.plain))
        let shipper = Shipper(Shipper.Dependencies(state: ShippingState(root: folder.appendingPathComponent("ship"), files: DeviceFiles(.plain)), link: link,
                                                   domains: { _ in [] }, record: { _ in }, scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true)))
        let coordinator = ShippingCoordinator(shipper: shipper, link: link, notices: NoticeLog().notices, explain: { nil })

        let first = Task { await coordinator.knock() }
        try await until("the knock reached the door") { door.exchanges == 1 }
        let second = Task { await coordinator.knock() }
        door.release()
        let answers = [await first.value, await second.value]
        XCTAssertEqual(answers, [false, false])
        XCTAssertEqual(door.exchanges, 1, "a knock while one waited on the home asked again")
        XCTAssertEqual(link.snapshot.reach, .waiting(since: time.now))

        time.pass(HomeLink.probeEvery)
        try await until("the probe's knock reached the door") { door.exchanges == 2 }
        door.release()
        let after = await link.probeSoon()
        XCTAssertEqual(after.reach, .waiting(since: time.now.addingTimeInterval(-HomeLink.probeEvery)), "inside the grace")
        XCTAssertEqual(door.exchanges, 2)
        await coordinator.stop()
    }
}
