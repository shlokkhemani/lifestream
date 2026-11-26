import Darwin
import DeviceFiles
import Foundation
import SQLite3
import HomeLink
import XCTest
@testable import Shipping

final class ClosedStoreShippingTests: XCTestCase {
    static let source = "wispr-flow:person-a@example.com:unit-0001"
    static let now = ShippingFixture.instant("2026-09-22T23:00:00.000Z")

    private var root: URL!
    private var state: ShippingState!
    private var clock: FixedClock!
    private var rows: Collected<ShipperRunRow>!

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("closed-store-shipping-tests")
        state = ShippingState(root: root.appendingPathComponent("ship", isDirectory: true), files: DeviceFiles(.plain))
        try state.prepare()
        clock = FixedClock(Self.now)
        rows = Collected()
    }

    override func tearDownWithError() throws {
        chmod(folder.path, 0o755)
        try? FileManager.default.removeItem(at: root)
    }

    private var folder: URL { root.appendingPathComponent("Library/Application Support/Wispr Flow", isDirectory: true) }
    private var database: URL { folder.appendingPathComponent("flow.sqlite") }

    private static let schema = [
        "CREATE TABLE `History` (`transcriptEntityId` VARCHAR(36) NOT NULL UNIQUE PRIMARY KEY, `asrText` TEXT, "
            + "`formattedText` TEXT, `timestamp` DATETIME, `audio` BLOB, `app` VARCHAR(255))",
        "CREATE INDEX `idx_timestamp` ON `History` (`timestamp`)",
        "CREATE TABLE `Notes` (`id` VARCHAR(36) PRIMARY KEY, `content` TEXT)",
        "INSERT INTO Notes VALUES ('SYNTH-NOTE-0001', 'never shipped')",
    ]

    private static func dictation(_ n: Int) -> String {
        "INSERT INTO History VALUES ('00000000-0000-4000-8000-0000000000\(String(format: "%02d", n))', 'synthetic \(n)', "
            + "'Synthetic \(n).', '2026-09-20 08:\(String(format: "%02d", n)):00.000 +00:00', x'5249464673796e746865746963', 'com.example.editor')"
    }

    private var ledgers: Ledgers { state.ledgers }

    private func wispr() throws -> any ShippingDomain {
        try StoreFixtures.domain(Self.source, home: root, ledgers: ledgers, state: root.appendingPathComponent("stores", isDirectory: true))
    }

    private func shipper(_ home: FakeHome, domain: any ShippingDomain) async throws -> Shipper {
        let rows = self.rows!
        return Shipper(Shipper.Dependencies(
            state: state, link: try await ShippingFixture.link(home, folder: state.root),
            domains: { sources in sources.contains(domain.sourceId) ? [domain] : [] },
            clock: clock.read, record: { rows.append($0) }, scratch: DomainFixtures.sealScratch))
    }

    private func dictations(in delivery: FakeHome.Delivery?) throws -> [[String?]] {
        let store = root.appendingPathComponent("shipped-\(UUID().uuidString).sqlite")
        try XCTUnwrap(delivery?.members["flow.sqlite"]).write(to: store)
        XCTAssertEqual(try DomainFixtures.read("SELECT name FROM sqlite_master WHERE type = 'table'", from: store), [["History"]],
                       "no note leaves the Mac, nor the table that holds them")
        return try DomainFixtures.read("SELECT rowid, transcriptEntityId, formattedText, length(audio) FROM History ORDER BY rowid", from: store)
    }

    func testAClosedWisprStoreShipsItsDictations() async throws {
        try DomainFixtures.closedWAL(database, Self.schema + (1...3).map(Self.dictation))
        XCTAssertEqual(SQLiteSourceTests.header(database), [2, 2])
        let closed = try DomainFixtures.stamps(in: folder)
        XCTAssertEqual(closed.keys.sorted(), ["flow.sqlite"], "the store lies as a closed Wispr Flow leaves it")
        let domain = try wispr()
        let home = FakeHome(sources: [Self.source], clock: clock.read)
        let shipper = try await shipper(home, domain: domain)

        let report = await shipper.run(.timer)
        XCTAssertEqual(report.outcome, "shipped")
        XCTAssertEqual(rows.all.map(\.detail), [["outcome": "shipped", "domain": "wispr_flow", "source": Self.source,
                                                  "bundle": "\(Self.source)/20260922T230000.000Z", "kind": "changes",
                                                  "seal": "1"]])
        XCTAssertEqual(try dictations(in: home.deliveries.last), [
            ["1", "00000000-0000-4000-8000-000000000001", "Synthetic 1.", "13"],
            ["2", "00000000-0000-4000-8000-000000000002", "Synthetic 2.", "13"],
            ["3", "00000000-0000-4000-8000-000000000003", "Synthetic 3.", "13"],
        ])
        XCTAssertEqual(try DomainFixtures.stamps(in: folder), closed, "nothing was written beside the store")
        XCTAssertEqual(DomainFixtures.workspaces(SQLiteSource.workPrefix), [], "the held copy went with the read")

        try DomainFixtures.closedWAL(database, [Self.dictation(4), Self.dictation(5)])
        XCTAssertEqual(try DomainFixtures.stamps(in: folder).keys.sorted(), ["flow.sqlite"])
        clock.move(by: MacSettings.readerRefresh)
        rows.clear()
        let next = await shipper.run(.timer)
        XCTAssertEqual(next.outcome, "shipped")
        XCTAssertEqual(rows.all.map(\.detail["kind"]), ["changes"])
        XCTAssertEqual(try dictations(in: home.deliveries.last), [
            ["4", "00000000-0000-4000-8000-000000000004", "Synthetic 4.", "13"],
            ["5", "00000000-0000-4000-8000-000000000005", "Synthetic 5.", "13"],
        ])
        XCTAssertEqual(home.custody(Self.source).received, 2)
        XCTAssertEqual(DomainFixtures.workspaces(SQLiteSource.workPrefix), [])
    }

    func testARefusedReadNamesItsReasonInTheRow() async throws {
        try DomainFixtures.closedWAL(database, Self.schema + [Self.dictation(1)])
        XCTAssertEqual(chmod(folder.path, 0o000), 0)
        let home = FakeHome(sources: [Self.source], clock: clock.read)
        let shipper = try await shipper(home, domain: wispr())

        let report = await shipper.run(.timer)
        XCTAssertEqual(report.outcome, "refused LOCAL_ACCESS")
        let row = try XCTUnwrap(rows.all.first)
        XCTAssertEqual(row.detail, ["outcome": "refused", "domain": "wispr_flow", "source": Self.source,
                                    "code": "LOCAL_ACCESS",
                                    "reason": "flow.sqlite cannot be read: Permission denied"])
        XCTAssertEqual(home.deliveries.count, 0)
    }

    func testASystemErrorStatesItsDomainAndCodeAlone() async throws {
        let failing = FailingDomain(sourceId: Self.source, error: CocoaError(.fileReadNoPermission,
                                                                            userInfo: [NSFilePathErrorKey: database.path]))
        let shipper = try await shipper(FakeHome(sources: [Self.source], clock: clock.read), domain: failing)

        _ = await shipper.run(.timer)
        let row = try XCTUnwrap(rows.all.first)
        XCTAssertEqual(row.detail["reason"], "NSCocoaErrorDomain 257", "a path the error names stays on this Mac")
        XCTAssertTrue(try XCTUnwrap(row.message).contains(database.path), "the CLI's message keeps every word")
    }
}

private final class FailingDomain: ShippingDomain, @unchecked Sendable {
    let sourceId: String
    let error: CocoaError
    let name = "wispr_flow"

    init(sourceId: String, error: CocoaError) {
        self.sourceId = sourceId
        self.error = error
    }

    func seal(_ request: SealRequest) throws -> [SealedBundle] { throw error }
    func applied(_ answer: FreshAnswer) {}
}
