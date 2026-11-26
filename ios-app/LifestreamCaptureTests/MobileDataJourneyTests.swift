import Foundation
import HomeLink
import LifestreamCaptureCore
import PhotoLibrary
import XCTest
@testable import Lifestream

@MainActor
final class MobileDataJourneyTests: XCTestCase {
    private static let photoBytes = 6_000_000

    func testPhotosTakenOnMobileDataGoAtOnceInBundlesOfTheBoundGoOnLowDataModeAndEverythingLetsThePastGo() async throws {
        let rig = try await Rig(paired: true)
        addTeardownBlock { @MainActor in
            await rig.stop()
            Home.current = nil
            try? FileManager.default.removeItem(at: rig.root)
        }
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
        func filesPerPhotosBundle() -> [Int] {
            var groups: [Int] = [], files = 0
            for request in rig.home.requests {
                if request.file != nil { files += 1 } else if request.sources.contains(Home.photos) {
                    groups.append(files)
                    files = 0
                }
            }
            return groups
        }
        _ = await take(0, from: 0)
        await shipper.reconcile(.foreground)

        let taken = await take(25, from: 0)
        XCTAssertEqual(taken?.files, 25, "what the change history reports is now: its files are read on a costly path")
        await shipper.reconcile(.foreground)
        XCTAssertEqual(filesPerPhotosBundle(), [8, 8, 8, 1], "150 MB of photos as bundles of the 50 MB bound, each landing sealing the next")
        XCTAssertEqual(rig.home.received(Home.photos), 4, "all in the one send")
        XCTAssertEqual(Set(rig.home.files.map(\.kind)), ["new"])
        XCTAssertTrue(rig.home.files.allSatisfy { $0.crossing == .any }, "a photo of 6 MB may cross any path")
        rig.home.importAll()

        rig.path = .lowData
        let lowData = await take(9, from: 25)
        XCTAssertEqual(lowData?.files, 9)
        await shipper.reconcile(.foreground)
        XCTAssertEqual(filesPerPhotosBundle(), [8, 8, 8, 1, 8, 1], "54 MB of small photos goes on Low Data Mode, photo by photo")
        XCTAssertEqual(rig.home.received(Home.photos), 6)
        XCTAssertEqual(shipper.waits, [])
        rig.home.importAll()

        rig.path = .costly
        let unit = try XCTUnwrap(shipper.link.unit)
        let key = "devices.\(unit).mobile_data"
        XCTAssertEqual(shipper.link.mobile(pressed: false).past, .waits(.past), "on mobile data the past waits for Wi-Fi")
        let exchanges = rig.home.exchanges
        let everything = try await shipper.link.setHomeSetting(key: key, value: .string("everything"))
        XCTAssertEqual(everything, .taken(.string("everything")))
        XCTAssertEqual(rig.home.exchanges, exchanges, "the setting's answer is the choice: no exchange came between")
        XCTAssertTrue(shipper.link.mobile(pressed: false).past.moves, "\"Everything\" lets the past cross mobile data")
        XCTAssertEqual(Set(rig.puts(of: Home.photos).map(\.kind)), ["new"], "phone bundles stay new")
        try rig.artifact("mobile-data")
    }
}
