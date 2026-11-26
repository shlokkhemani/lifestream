import Foundation
import HomeLink
import LifestreamCaptureCore
import PhotoLibrary
import XCTest
@testable import Lifestream

@MainActor
final class MobileDataJourneyTests: XCTestCase {
    private static let photoBytes = 6_000_000

    func testPhotosTakenOnMobileDataGoAtOnceWaitOnLowDataModeAndAChangeOfChoiceStartsAHeldBundle() async throws {
        let rig = try await Rig(paired: true)
        addTeardownBlock { @MainActor in
            await rig.stop()
            Home.current = nil
            try? FileManager.default.removeItem(at: rig.root)
        }
        rig.long = true
        rig.path = .costly
        let shipper = rig.launch()
        let library = SyntheticLibrary()
        let pass = PhotoPass(store: rig.store, library: PhotoLibrary(library),
                             stateURL: rig.root.appendingPathComponent("photos/cursor.json"), build: "1 aaaaaaa")
        func take(_ count: Int, from first: Int) async -> PhotoPass.Report? {
            for index in first..<(first + count) {
                library.put(PhotosTests.photo(String(format: "NOW%04d/L0/001", index), minutes: Double(index)),
                            files: [.here(Data(repeating: UInt8(index), count: Self.photoBytes))])
            }
            let device = Device(shipper.link.mobile(pressed: false), charging: false, spare: 95_000_000_000)
            return await pass.run(.wake(.foreground), device: device, bringingIn: false, home: await .of(shipper))
        }
        _ = await take(0, from: 0)
        await shipper.reconcile(.foreground)

        let taken = await take(25, from: 0)
        XCTAssertEqual(taken?.files, 25, "what the change history reports is now: its files are read on a costly path")
        await shipper.reconcile(.foreground)
        let first = rig.puts(of: Home.photos)
        XCTAssertEqual(first.count, 1, "the app is in front, so the long wake holds nothing: one bundle, requested at once")
        XCTAssertGreaterThanOrEqual(first.first?.bytes ?? 0, Int64(25 * Self.photoBytes))
        XCTAssertEqual(first.first?.kind, "new")
        XCTAssertEqual(first.first?.crossing, MobileData.Crossing(costly: true, lowData: false),
                       "it may cross a costly path, never a Low Data Mode one")
        XCTAssertEqual(rig.home.received(Home.photos), 1)
        rig.home.importAll()

        rig.path = .lowData
        let lowData = await take(9, from: 25)
        XCTAssertEqual(lowData?.files, 9)
        await shipper.reconcile(.foreground)
        XCTAssertEqual(rig.puts(of: Home.photos).count, 1, "54 MB on Low Data Mode is no request")
        XCTAssertEqual(shipper.waits, [.network(.lowData)])
        XCTAssertEqual(shipper.shippingDescription, "Large sends wait: Low Data Mode is on")
        let held = await shipper.unsent()
        XCTAssertTrue(held.waitsForNetwork)

        rig.date.addTimeInterval(60)
        rig.path = .costly
        try await until("Low Data Mode off is due at once") { rig.alarms.next == rig.date }
        rig.alarms.ring(rig.date)
        try await until("the held bundle is requested") { rig.puts(of: Home.photos).count == 2 }
        XCTAssertEqual(rig.puts(of: Home.photos).last?.crossing, MobileData.Crossing(costly: true, lowData: false))
        try await until("the held bundle landed") { rig.home.received(Home.photos) == 2 }
        rig.home.importAll()

        let unit = try XCTUnwrap(shipper.link.unit)
        let key = "devices.\(unit).mobile_data"
        let small = try await shipper.link.setHomeSetting(key: key, value: .string("small"))
        XCTAssertEqual(small, .taken(.string("small")))
        _ = await take(9, from: 34)
        await shipper.reconcile(.foreground)
        XCTAssertEqual(rig.puts(of: Home.photos).count, 2, "\"Only small sends\" holds 54 MB")
        XCTAssertEqual(shipper.waits, [.network(.large)])
        XCTAssertEqual(shipper.shippingDescription, MobileData.Wait.large.words)

        let exchanges = rig.home.exchanges
        rig.date.addTimeInterval(60)
        let now = try await shipper.link.setHomeSetting(key: key, value: .string("now"))
        XCTAssertEqual(now, .taken(.string("now")))
        try await until("the choice is due at once") { rig.alarms.next == rig.date }
        XCTAssertEqual(rig.home.exchanges, exchanges, "the setting's answer is the choice: no exchange came between")
        rig.alarms.ring(rig.date)
        try await until("the bundle held for its size is requested") { rig.puts(of: Home.photos).count == 3 }
        XCTAssertEqual(rig.puts(of: Home.photos).last?.crossing, MobileData.Crossing(costly: true, lowData: false))
        XCTAssertEqual(rig.puts(of: Home.photos).map(\.kind), ["new", "new", "new"], "phone bundles stay new")
        try await until("the third bundle landed") { rig.home.received(Home.photos) == 3 }
        try rig.artifact("mobile-data")
    }
}
