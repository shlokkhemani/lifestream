import DeviceFiles
import XCTest
@testable import Shipping

final class ShipperFlushTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("shipper-flush-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        DeviceFiles.flushObserver = nil
        try? FileManager.default.removeItem(at: root)
    }

    func testAPlainRunOrdersEveryStateWriteAndEndsWithOneFullFlushOfItsFolder() async throws {
        try await assertOneRunFlushes(DeviceFiles(.plain), folder: root.appendingPathComponent("plain", isDirectory: true))
    }

    func testAKeyedRunOrdersEveryStateWriteAndEndsWithOneFullFlushOfItsFolder() async throws {
        try await assertOneRunFlushes(DeviceFiles(.keyed(ShippingFixture.macKey)), folder: root.appendingPathComponent("keyed", isDirectory: true))
    }

    private func assertOneRunFlushes(_ files: DeviceFiles, folder: URL,
                                     file: StaticString = #filePath, line: UInt = #line) async throws {
        let state = ShippingState(root: folder, files: files)
        try state.prepare()
        let now = ShippingFixture.instant("2026-09-22T23:00:00.000Z")
        let clock = FixedClock(now)
        let domain = FakeDomain(sourceId: ShippingFixture.machineSource, name: "machine_events", seals: [.sealed()])
        let home = FakeHome(sources: [domain.sourceId], clock: clock.read)
        let link = try await ShippingFixture.link(home, folder: folder)
        let shipper = Shipper(Shipper.Dependencies(
            state: state, link: link, domains: { _ in [domain] },
            clock: clock.read, record: { _ in }, scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true)))

        let prefix = folder.path
        let seen = Collected<(path: String, level: DeviceFiles.Flush, scheduleRunAt: Date?)>()
        DeviceFiles.flushObserver = { url, level in
            guard url.path.hasPrefix(prefix) else { return }
            let path = String(url.path.dropFirst(prefix.count).drop { $0 == "/" })
            guard !path.hasSuffix(".zip.partial") else { return }
            seen.append((path, level, state.readSchedule().lastRunAt))
        }

        let report = await shipper.run(.timer)
        DeviceFiles.flushObserver = nil

        XCTAssertEqual(report.outcome, "shipped", file: file, line: line)
        let flushes = seen.all
        XCTAssertEqual(flushes.filter { $0.level == .full }.count, 1, "one full flush a run", file: file, line: line)
        XCTAssertEqual(flushes.last?.level, .full, "and it is the last", file: file, line: line)
        XCTAssertEqual(flushes.last?.path, "", "of the folder the schedule is in", file: file, line: line)
        XCTAssertEqual(flushes.last?.scheduleRunAt, now, "after the schedule's rename", file: file, line: line)
        let ordered = flushes.dropLast()
        XCTAssertEqual(ordered.count, 3, "the sidecar, the settings, the schedule; the saved answer is HomeLink's own file", file: file, line: line)
        for flush in ordered {
            XCTAssertEqual(flush.level, .barrier, file: file, line: line)
            let name = (flush.path as NSString).lastPathComponent
            XCTAssertTrue(name.hasPrefix(".") && name.hasSuffix(".tmp"), "\(flush.path) is a temporary, renamed after", file: file, line: line)
        }
        XCTAssertNotEqual(ordered.last?.scheduleRunAt, now, "the schedule's barrier precedes its rename", file: file, line: line)

        let left = FileManager.default.enumerator(atPath: prefix)?.compactMap { $0 as? String } ?? []
        XCTAssertTrue(left.allSatisfy { !$0.hasSuffix(".tmp") }, "no temporary is left", file: file, line: line)
    }
}
