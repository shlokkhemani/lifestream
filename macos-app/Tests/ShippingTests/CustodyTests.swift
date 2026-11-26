import DeviceFiles
import Evidence
import Foundation
import HomeLink
import XCTest
@testable import Shipping

class CustodyTests: XCTestCase {
    class var form: DeviceFiles.Form { .plain }

    private static let source = "input:local:unit-0001"
    private static let messages = "imessage:a@example.com:unit-0001"
    private static let start = ShippingFixture.instant("2026-09-22T23:00:00.000Z")

    private var root: URL!
    private var clock: FixedClock!
    private var home: FakeHome!
    private var state: ShippingState!

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("custody-e2e")
        clock = FixedClock(Self.start)
        home = FakeHome(sources: [Self.source, Self.messages], clock: clock.read)
        state = ShippingState(root: root.appendingPathComponent("ship", isDirectory: true), files: DeviceFiles(type(of: self).form))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var batches: URL { root.appendingPathComponent("input-events", isDirectory: true) }
    private var messagesRoot: URL { root.appendingPathComponent("Library/Messages", isDirectory: true) }
    private var chatDB: URL { messagesRoot.appendingPathComponent("chat.db") }

    private static var everyMinute: MacSettings {
        MacSettings(file: DomainFixtures.settingsFile, defaults: ["input": ["refresh": .string("1m")], "imessage": ["refresh": .string("1m")]], files: DeviceFiles(.plain))
    }

    private func shipper(now domainNow: Date? = nil) async throws -> Shipper {
        let ledgers = state.ledgers
        let batches = self.batches, chatDB = self.chatDB, root = self.root!
        let clock = self.clock!
        return Shipper(Shipper.Dependencies(
            state: state, link: try await ShippingFixture.link(home, folder: state.root), settings: Self.everyMinute,
            domains: { sources in
                sources.compactMap { source -> (any ShippingDomain)? in
                    switch source {
                    case Self.source:
                        return InputEventsDomain(sourceId: source, batchRoot: batches, ledgers: ledgers,
                                                 clock: { domainNow ?? clock.now })
                    case Self.messages:
                        return FileManager.default.fileExists(atPath: chatDB.path)
                            ? try? StoreFixtures.domain(source, home: root, ledgers: ledgers,
                                                        state: root.appendingPathComponent("stores", isDirectory: true))
                            : nil
                    default: return nil
                    }
                }
            },
            clock: clock.read, record: { _ in }, scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true)))
    }

    private func batch(_ at: String) throws -> String {
        let name = UTCInstant.basic(ShippingFixture.instant(at)) + ".jsonl"
        let line = "{\"at\":\"\(at)\",\"until\":\"\(at)\",\"layout\":\"com.apple.keylayout.US\",\"apps\":[],\"events\":[]}\n"
        try FileManager.default.createDirectory(at: batches, withIntermediateDirectories: true)
        try state.files.writeNew(batches.appendingPathComponent(name), Data(line.utf8), flush: .data)
        return name
    }

    private func run(_ shipper: Shipper) async -> String {
        clock.move(by: 60)
        return await shipper.run(.timer).outcome
    }

    private func batchesShipped(since count: Int) -> [[String]] {
        home.deliveries.dropFirst(count).filter { $0.source == Self.source }
            .map { $0.members.keys.filter { $0.hasSuffix(".jsonl") }.sorted() }
    }


    func testASpoolAcrossARestoreALateBatchAndDeletion() async throws {
        var report: [String: Any] = [:]
        try FileManager.default.createDirectory(at: batches, withIntermediateDirectories: true)
        let shipper = try await shipper()
        let a = try batch("2026-08-01T10:00:00.000Z"), b = try batch("2026-08-01T11:00:00.000Z")
        _ = await run(shipper)
        let c = try batch("2026-09-22T10:00:00.000Z")
        _ = await run(shipper)
        let d = try batch("2026-09-22T11:00:00.000Z")
        _ = await run(shipper)
        XCTAssertEqual(batchesShipped(since: 0), [[a, b], [c], [d]])
        XCTAssertEqual(home.custody(Self.source).received, 3)

        home.restore(Self.source, received: 1, imported: 1)
        var seen = home.deliveries.count
        _ = await run(shipper)
        let restored = batchesShipped(since: seen)
        XCTAssertEqual(restored, [[c, d]], "what the rolled-back seals carried, and no more")
        XCTAssertEqual(home.deliveries.last?.seal, 2)
        report["restore"] = ["received_before": 3, "restored_to": 1, "shipped_again": restored.flatMap { $0 }, "seal": 2]

        let late = try batch("2026-08-01T10:30:00.000Z")
        seen = home.deliveries.count
        _ = await run(shipper)
        XCTAssertEqual(batchesShipped(since: seen), [[late]])
        report["late_batch"] = ["name": late, "shipped_in_seal": home.deliveries.last?.seal ?? 0]

        home.restore(Self.source, received: 3, imported: 2)
        clock.move(to: ShippingFixture.instant("2026-12-01T00:00:00.000Z"))
        _ = await shipper.run(.manual)
        let left = try FileManager.default.contentsOfDirectory(atPath: batches.path).filter { $0.hasSuffix(".jsonl") }.sorted()
        XCTAssertEqual(left, [late], "seal 3 is not imported: its batch stays, however old")
        report["deletion"] = ["imported": 2, "kept": left]

        home.restore(Self.source, received: 1, imported: 1)
        seen = home.deliveries.count
        _ = await run(shipper)
        let lost = try XCTUnwrap(home.deliveries.last?.lost.first)
        XCTAssertEqual(batchesShipped(since: seen), [[late]])
        XCTAssertEqual(lost["items"] as? Int, 4, "a, b, c and d were deleted once seal 2 was imported")
        XCTAssertEqual(lost["what"] as? String, "input batches, up to that many: this Mac deleted them after an earlier import",
                       "a bound: the fold counts what this Mac deleted under seals a restored home may still hold")
        report["lost_after_restore"] = lost

        home.restore(Self.source, received: 1, imported: 1)
        home.refuse(Self.source, (413, "ACQUISITION_TOO_LARGE"))
        seen = home.deliveries.count
        _ = await run(shipper)
        XCTAssertEqual(home.deliveries.count, seen, "refused, never taken")
        home.refuse(Self.source, nil)
        clock.move(by: Shipper.refusedInterval)
        _ = await run(shipper)
        let resealed = try XCTUnwrap(home.deliveries.last)
        XCTAssertEqual(resealed.seal, 2)
        XCTAssertEqual(resealed.lost.first?["items"] as? Int, 4, "the reseal states the same loss")
        report["lost_after_reseal"] = resealed.lost.first ?? [:]

        let next = try batch("2026-12-01T00:00:00.000Z")
        _ = await run(shipper)
        XCTAssertEqual(batchesShipped(since: home.deliveries.count - 1), [[next]])
        XCTAssertEqual(home.deliveries.last?.seal, 3)
        XCTAssertEqual(home.deliveries.last?.lost.count, 0, "received covers the seal that stated it")
        try write(report, as: "spool")
    }


    func testADatabaseAcrossARestoreAndARebuild() async throws {
        var report: [String: Any] = [:]
        try DomainFixtures.write("old bytes", to: messagesRoot.appendingPathComponent("Attachments/aa/01/old.jpg"))
        try DomainFixtures.write("new bytes", to: messagesRoot.appendingPathComponent("Attachments/bb/02/new.jpg"))
        try DomainFixtures.sqlite(chatDB, [try DomainFixtures.fixture("imessage-store")])
        home.sources = [Self.messages]
        let shipper = try await shipper()
        _ = await run(shipper)
        let first = Array(home.deliveries.suffix(2))
        XCTAssertEqual(first.map { $0.facts["history"] as? Bool }, [nil, true])
        XCTAssertEqual(first.map(\.seal), [1, 2])
        XCTAssertEqual(first.flatMap(blobs).sorted(), [DomainFixtures.sha256("new bytes"), DomainFixtures.sha256("old bytes")].sorted())

        try DomainFixtures.write("third", to: messagesRoot.appendingPathComponent("Attachments/cc/04/third.jpg"))
        try DomainFixtures.sqlite(chatDB, [
            "INSERT INTO message (ROWID, guid, text, service, date) VALUES (103, 'SYNTH-MSG-103', 'third', 'iMessage', 811500100000000000)",
            "INSERT INTO chat_message_join VALUES (1, 103, 811500100000000000)",
            "INSERT INTO attachment (ROWID, guid, filename, mime_type, transfer_name) VALUES "
                + "(4, 'SYNTH-ATTACHMENT-4', '~/Library/Messages/Attachments/cc/04/third.jpg', 'image/jpeg', 'third.jpg')",
            "INSERT INTO message_attachment_join VALUES (103, 4)",
        ])
        _ = await run(shipper)
        let second = try XCTUnwrap(home.deliveries.last)
        XCTAssertEqual(second.seal, 3)
        XCTAssertEqual(second.facts["kind"] as? String, "changes")
        XCTAssertEqual(blobs(second), [DomainFixtures.sha256("third")])

        home.restore(Self.messages, received: 2, imported: 2)
        _ = await run(shipper)
        let again = try XCTUnwrap(home.deliveries.last)
        XCTAssertEqual(again.seal, 3)
        XCTAssertEqual(blobs(again), [DomainFixtures.sha256("third")], "blobs the rolled-back seal carried, and only those")
        report["restore"] = ["seal": 3, "blobs": blobs(again)]

        home.importAll()
        try FileManager.default.removeItem(at: chatDB)
        try DomainFixtures.sqlite(chatDB, [try DomainFixtures.fixture("imessage-store")])
        let before = home.deliveries.count
        _ = await run(shipper)
        let rebuilt = Array(home.deliveries.dropFirst(before))
        XCTAssertEqual(rebuilt.map(\.seal), [4, 5])
        XCTAssertTrue(rebuilt.allSatisfy { $0.lost.isEmpty })
        XCTAssertEqual(rebuilt.flatMap(blobs), [], "the home holds every attachment's bytes already")
        report["rebuild"] = ["seals": rebuilt.compactMap(\.seal), "lost": 0]
        try write(report, as: "database")
    }

    private func blobs(_ delivery: FakeHome.Delivery) -> [String] {
        delivery.members.keys.filter { $0.hasPrefix("blobs/") }.map { String($0.dropFirst(6)) }.sorted()
    }


    private func write(_ scenario: [String: Any], as name: String) throws {
        let path = ProcessInfo.processInfo.environment["LIFESTREAM_CUSTODY_REPORT"]
            ?? FileManager.default.temporaryDirectory.appendingPathComponent("lifestream-custody-report.json").path
        let file = URL(fileURLWithPath: path)
        var all = (try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [String: Any] ?? [:]
        all[name] = scenario
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: all, options: [.sortedKeys, .prettyPrinted]).write(to: file)
    }
}

final class KeyedCustodyTests: CustodyTests {
    override class var form: DeviceFiles.Form { .keyed(ShippingFixture.macKey) }
}
