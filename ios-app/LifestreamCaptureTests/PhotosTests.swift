import Foundation
import HomeLink
import LifestreamCaptureCore
import PhotoLibrary
import XCTest
@testable import Lifestream

@MainActor
final class PhotosTests: XCTestCase {
    static let day = Date(timeIntervalSince1970: 1_780_000_000)
    static let wifi = Device(moment(.free), charging: false, spare: 95_000_000_000)
    static let costly = Device(moment(.costly), charging: false, spare: wifi.spare)

    static func moment(_ path: MobileData.Path) -> MobileData.Moment {
        MobileData.Moment(path: path, choice: .now, loopback: false, pressed: false)
    }
    static let still = PhotoResource(typeRaw: 1, uti: "public.heic", originalFilename: "IMG_0001.HEIC")

    static func photo(_ id: String, minutes: Double, edited: Double? = nil) -> PhotoSnapshot {
        let taken = day.addingTimeInterval(minutes * 60)
        return PhotoSnapshot(localIdentifier: id, creationDate: taken,
                             modificationDate: edited.map { day.addingTimeInterval($0 * 60) } ?? taken, resources: [still])
    }

    private func photos() async throws -> PhotoRig {
        let photos = PhotoRig(try await Rig(paired: true))
        addTeardownBlock { @MainActor in
            Home.current = nil
            try? FileManager.default.removeItem(at: photos.rig.root)
        }
        return photos
    }


    func testTheFirstReadShipsSnapshotsAPageABundleAndANewPhotoShipsAtOnce() async throws {
        let photos = try await photos()
        for index in 0..<1_200 { photos.synthetic.put(Self.photo(String(format: "P%04d/L0/001", index), minutes: -Double(index))) }
        photos.rig.home.wanted = PhotoRig.wanting([], left: (3, 0))

        var report = try await photos.wake(.foreground, importing: false)
        XCTAssertEqual(report?.snapshots, 1_000, "a page, never the library")
        XCTAssertEqual(report?.paged, true)
        XCTAssertEqual(photos.rig.home.wantedAsked, 0, "no file is asked for while the library is read whole")
        assertNil(await photos.pass.state().left, "and its count, of part of the library, is not kept")
        assertEqual(try await photos.entries(kind: "asset").count, 1_000)
        assertEqual(try await photos.blobs(), 0, "a whole read copies no file: the home asks for them")
        XCTAssertEqual(photos.rig.home.received(Home.photos), 1)

        photos.synthetic.put(Self.photo("NEW/L0/001", minutes: 60))
        report = try await photos.wake(importing: false)
        XCTAssertEqual(report?.waited, true)
        XCTAssertEqual(report?.paged, false, "no page while the home has not imported the last")
        XCTAssertEqual(report?.files, 1)
        let written = try await photos.entries()
        XCTAssertEqual(written.suffix(2).map(\.kind), ["asset", "resource_availability"], "its snapshot, then its file")
        XCTAssertTrue(written.suffix(2).allSatisfy { $0.captureReplayKey?.hasPrefix("photos:NEW/L0/001:2026-05-28T21:26:40.000000000Z:") == true })
        XCTAssertEqual(resources(written[written.count - 2]).first?["blob"], .null, "an asset never carries a file")
        XCTAssertNotNil(resources(written[written.count - 1]).first?["blob"]?.object?["hash"])
        XCTAssertEqual(photos.rig.home.wantedAsked, 0, "the home is not asked before it imported what it was sent")

        photos.rig.home.importAll()
        report = try await photos.wake()
        XCTAssertEqual(report?.snapshots, 200, "the rest of the backlog, once the home imported the rest")
        assertNil(await photos.pass.state().left)
        report = try await photos.wake()
        XCTAssertEqual(report?.snapshots, 0)
        XCTAssertEqual(photos.rig.home.wantedAsked, 1, "the read whole and imported, it asks the home what it wants")
        assertEqual(await photos.pass.state().left, .init(wanted: 3, unavailable: 0, bytes: 3_000), "the read over, the home's count is kept")
        assertEqual(try await photos.entries().count, 1_202)
        XCTAssertEqual(photos.synthetic.snapshotsRead, 1_202, "each photo read once; the new one again with its files")
        assertEqual(try await photos.blobs(), 0, "the new photo's copy cleared once the home imported it")
        let points = try await photos.rig.store.readPoints()
        XCTAssertNil(points[.photos], "the phone states no photos read point: the home asks for what it lacks")
        let cutoff = photos.rig.root.appendingPathComponent("capture/photo-creation-cutoff.json")
        XCTAssertFalse(FileManager.default.fileExists(atPath: cutoff.path), "and keeps no creation cutoff")
        let state = await photos.pass.state()
        XCTAssertEqual(state.mark?.unread, 0)
    }


    func testTheHomesWantedPhotosComeAsMoreOfWhatItHoldsOrWhyNot() async throws {
        let photos = try await photos()
        let library = photos.synthetic
        library.put(Self.photo("HERE/L0/001", minutes: 5))
        library.put(Self.photo("CLOUD/L0/001", minutes: 4), files: [.inCloud(Data("cloud".utf8))])
        library.put(Self.photo("FAILS/L0/001", minutes: 3), files: [.failing])
        library.put(Self.photo("GONE/L0/001", minutes: 2))
        library.put(Self.photo("OFFLINE/L0/001", minutes: 1), files: [.offline])
        _ = try await photos.wake(.foreground)
        assertEqual(try await photos.entries().count, 5)

        library.delete("GONE/L0/001")
        let all = ["HERE/L0/001", "CLOUD/L0/001", "FAILS/L0/001", "GONE/L0/001", "OFFLINE/L0/001"]
        photos.rig.home.wanted = PhotoRig.wanting(all, left: (5, 0))

        let asked = photos.rig.home.wantedAsked
        photos.device = Self.costly
        let costly = try await photos.wake()
        XCTAssertEqual(costly?.waits, .network, "the past waits on a costly path with the default choice")
        photos.device = Self.wifi
        photos.device.spare = 0
        let low = try await photos.wake()
        XCTAssertEqual(low?.waits, .space)
        XCTAssertEqual(photos.rig.home.wantedAsked, asked)

        photos.device = Self.wifi
        let report = try await photos.wake()
        XCTAssertEqual(photos.rig.home.wantedAsked, asked + 1)
        XCTAssertEqual(report?.files, 1)
        XCTAssertEqual(report?.refused, 2)
        XCTAssertEqual(library.downloads, 0, "no iCloud on Wi-Fi alone")
        var more = try await photos.availabilities()
        XCTAssertEqual(more.keys.sorted(), ["FAILS/L0/001", "GONE/L0/001", "HERE/L0/001"],
                       "a file to come later (iCloud, the network) waits whole for another pass")
        XCTAssertNotNil(more["HERE/L0/001"]?["blob"]?.object?["hash"])
        XCTAssertEqual(more["FAILS/L0/001"]?["not_local_reason"], .string("download_failed"))
        XCTAssertEqual(more["GONE/L0/001"]?["not_local_reason"], .string("not_found"))
        assertEqual(try await photos.entries(kind: "asset").count, 5, "every file is more of a photo the home holds")
        assertEqual(await photos.pass.state().left, .init(wanted: 5, unavailable: 0, bytes: 5_000))

        photos.rig.home.wanted = PhotoRig.wanting(["CLOUD/L0/001", "OFFLINE/L0/001"], left: (2, 2))
        photos.device.charging = true
        _ = try await photos.wake()
        XCTAssertEqual(library.downloads, 1)
        more = try await photos.availabilities()
        XCTAssertNotNil(more["CLOUD/L0/001"]?["blob"]?.object?["hash"])
        XCTAssertNil(more["OFFLINE/L0/001"], "a network error is never a refusal")
        assertEqual(await photos.pass.state().left, .init(wanted: 2, unavailable: 2, bytes: 2_000))
    }

    func testBringInAllPhotosAsksICloudWithoutPower() async throws {
        let photos = try await photos()
        photos.synthetic.put(Self.photo("CLOUD/L0/001", minutes: 4), files: [.inCloud(Data("cloud".utf8))])
        _ = try await photos.wake(.foreground)
        photos.rig.home.wanted = PhotoRig.wanting(["CLOUD/L0/001"], left: (1, 0))
        _ = try await photos.wake()
        XCTAssertEqual(photos.synthetic.downloads, 0)
        photos.bringingIn = true
        let report = try await photos.wake(.foreground)
        XCTAssertEqual(report?.files, 1)
        XCTAssertEqual(photos.synthetic.downloads, 1)
    }


    func testAPrunedHistoryWaitsForTheForegroundAndRestatesNothing() async throws {
        let photos = try await photos()
        for index in 0..<3 { photos.synthetic.put(Self.photo("P\(index)/L0/001", minutes: -Double(index))) }
        _ = try await photos.wake(.foreground)
        _ = try await photos.wake()
        let read = photos.synthetic.snapshotsRead
        XCTAssertEqual(read, 3)

        photos.synthetic.prune()
        var report = try await photos.wake()
        XCTAssertEqual(photos.synthetic.snapshotsRead, read, "a background wake reads no page that only restates")
        XCTAssertEqual(report?.snapshots, 0)
        assertEqual(await photos.pass.state().mark?.restates, true)

        report = try await photos.wake(.foreground)
        XCTAssertEqual(report?.paged, true)
        XCTAssertEqual(report?.snapshots, 0, "it reads the library and writes nothing it stated")
        assertEqual(try await photos.entries().count, 3)
        assertEqual(await photos.pass.state().mark?.restates, false)
    }


    func testAnEditShipsAsANewSnapshotAndAnUntouchedPhotoNeverAgain() async throws {
        let photos = try await photos()
        _ = try await photos.wake(.foreground)
        photos.synthetic.put(Self.photo("P0/L0/001", minutes: 0))
        var report = try await photos.wake()
        XCTAssertEqual(report?.files, 1, "taken now, its file ships with it")
        photos.synthetic.put(Self.photo("P0/L0/001", minutes: 0))
        report = try await photos.wake()
        XCTAssertEqual(report?.snapshots, 0)
        XCTAssertEqual(report?.files, 0, "a snapshot it holds is never fetched again")

        var favourite = Self.photo("P0/L0/001", minutes: 0, edited: 10)
        favourite.isFavorite = true
        photos.synthetic.put(favourite)
        report = try await photos.wake()
        XCTAssertEqual(report?.snapshots, 1)
        XCTAssertEqual(report?.files, 0, "a favourite changes no file")

        var edit = Self.photo("P0/L0/001", minutes: 0, edited: 30)
        edit.isFavorite = true
        edit.resources += [PhotoResource(typeRaw: 5, uti: "public.heic", originalFilename: "FullSizeRender.HEIC"),
                           PhotoResource(typeRaw: 7, uti: "com.apple.photo.adjustment-data", originalFilename: "Adjustments.plist")]
        photos.synthetic.put(edit)
        report = try await photos.wake()
        XCTAssertEqual(report?.snapshots, 1)
        XCTAssertEqual(report?.files, 1, "the edit's render ships with it")
        let assets = try await photos.entries(kind: "asset")
        XCTAssertEqual(assets.map { modification($0) },
                       ["2026-05-28T20:26:40.000000000Z", "2026-05-28T20:36:40.000000000Z", "2026-05-28T20:56:40.000000000Z"])
        let more = try await photos.entries(kind: "resource_availability")
        XCTAssertEqual(more.count, 2, "the photo's file, then the edit's, beside its snapshot")
        XCTAssertEqual(more.last.map { resources($0).map { $0["blob"] == .null } }, [true, false, false],
                       "the original held already is not fetched again")
    }

    func testACloudIdLearntLaterShipsOnceWithoutItsFilesAgain() async throws {
        let photos = try await photos()
        photos.synthetic.put(Self.photo("P0/L0/001", minutes: 0))
        _ = try await photos.wake(.foreground)
        var clouded = Self.photo("P0/L0/001", minutes: 0)
        clouded.cloudIdentifier = "CLOUD-P0"
        photos.synthetic.put(clouded)
        var report = try await photos.wake()
        XCTAssertEqual(report?.snapshots, 1, "the snapshot with its cloud id, once")
        XCTAssertEqual(report?.files, 0, "its name was stated: the home asks for its files")
        photos.synthetic.prune()
        report = try await photos.wake(.foreground)
        XCTAssertEqual(report?.paged, true)
        XCTAssertEqual(report?.snapshots, 0, "a restatement writes nothing")
        let assets = try await photos.entries(kind: "asset")
        XCTAssertEqual(assets.count, 2)
        XCTAssertEqual(assets.last.flatMap { cloudID($0) }, "CLOUD-P0")
    }


    func testAPhotoWithAFileToComeShipsWholeOrNotAtAllAndIsNotAskedAgainWithoutADownload() async throws {
        let photos = try await photos()
        _ = try await photos.wake(.foreground)
        let video = PhotoResource(typeRaw: 9, uti: "com.apple.quicktime-movie", originalFilename: "IMG_0001.MOV")
        let live = PhotoSnapshot(localIdentifier: "LIVE/L0/001", creationDate: Self.day, modificationDate: Self.day,
                                 resources: [Self.still, video])
        photos.synthetic.put(live, files: [.here(Data("still".utf8)), .inCloud(Data("video".utf8))])
        var report = try await photos.wake()
        XCTAssertEqual(report?.snapshots, 1)
        XCTAssertEqual(report?.files, 0, "its video is in iCloud: nothing of its files ships")
        assertEqual(try await photos.entries(kind: "resource_availability").count, 0)
        assertEqual(try await photos.blobs(), 0)

        photos.rig.home.wanted = PhotoRig.wanting(["LIVE/L0/001"], files: ["photo", "pairedVideo"], left: (1, 0))
        _ = try await photos.wake()
        assertEqual(await photos.pass.state().owed, [], "retried once as owed, its video only in iCloud: it leaves owed for the past's rule")
        _ = try await photos.wake()
        assertEqual(await photos.pass.state().later, ["LIVE/L0/001"], "the past's rule asks it once and finds it waiting for a download")
        let read = photos.synthetic.snapshotsRead
        let asked = photos.rig.home.wantedAsked
        _ = try await photos.wake()
        XCTAssertEqual(photos.synthetic.snapshotsRead, read, "waiting for a download, it is not asked of PhotoKit again")
        XCTAssertEqual(photos.rig.home.wantedAsked, asked + 1, "though the home is")

        photos.device.charging = true
        report = try await photos.wake()
        XCTAssertEqual(report?.files, 1)
        XCTAssertEqual(photos.synthetic.downloads, 1)
        var more = try await photos.entries(kind: "resource_availability")
        XCTAssertEqual(more.count, 1)
        XCTAssertEqual(resources(more[0]).compactMap { $0["blob"]?.object?["hash"] }.count, 2, "both files, together")

        report = try await photos.wake()
        XCTAssertEqual(report?.files, 1)
        more = try await photos.entries(kind: "resource_availability")
        XCTAssertEqual(more.count, 2)
    }


    func testADeletedPhotoHasEveryEntryStatedGoneAndALimitedSelectionNone() async throws {
        let photos = try await photos()
        photos.synthetic.put(Self.photo("A/L0/001", minutes: 1))
        photos.synthetic.put(Self.photo("B/L0/001", minutes: 0))
        _ = try await photos.wake(.foreground)
        photos.rig.home.wanted = PhotoRig.wanting(["A/L0/001"], left: (1, 0))
        _ = try await photos.wake()
        photos.rig.home.wanted = nil

        let shipped = photos.rig.home.received(Home.photos)
        photos.synthetic.delete("A/L0/001")
        let report = try await photos.wake()
        XCTAssertEqual(report?.gone, 2, "its snapshot and its files")
        XCTAssertEqual(photos.rig.home.received(Home.photos), shipped + 1,
                       "the gones ship, though the copy they name was cleared once imported (the 25 Oct stall)")
        assertEqual(try await photos.blobs(), 0, "and they keep no copy")
        XCTAssertNil(photos.shipper.state.sending.sources[Home.photos])
        let gone = try await photos.entries(kind: "gone")
        XCTAssertEqual(gone.map { of($0) }, ["asset", "resource_availability"])
        XCTAssertTrue(gone.allSatisfy { $0.captureReplayKey?.hasPrefix("photos:A/L0/001:") == true && $0.captureReplayKey?.hasSuffix(":gone") == true })
        guard case .object(let fields) = gone[0].payload, case .object(let stated)? = fields["payload"] else { return XCTFail("a payload") }
        XCTAssertEqual(stated["local_identifier"], .string("A/L0/001"), "the entry as it was stated")

        photos.synthetic.allow(.limited, selecting: ["B/L0/001"])
        _ = try await photos.wake(.foreground)
        photos.synthetic.allow(.limited, selecting: [])
        _ = try await photos.wake()
        assertEqual(try await photos.entries(kind: "gone").count, 2, "a selection that shrinks deletes nothing")
    }
}

extension PhotosTests {

    func testAPhotoPassThatFailsLeavesLocationShippingAndTheHomeHearsPhotos() async throws {
        let photos = try await photos()
        photos.synthetic.put(Self.photo("A/L0/001", minutes: 0))
        photos.synthetic.refusesReads = true
        try await photos.rig.capture()
        let failed = try await photos.wake(.foreground)
        XCTAssertNotNil(failed?.error, "PhotoKit refused the read")
        XCTAssertGreaterThanOrEqual(photos.rig.home.received(Home.location), 1, "location ships")
        let failing = try XCTUnwrap(photos.shipper.state.sending.sources[Home.photos])
        XCTAssertEqual(failing.code, "PHOTOS")

        let waiting = try await photos.wake(.foreground)
        XCTAssertNil(waiting)
        XCTAssertEqual(photos.rig.home.sending?.sources[Home.photos]?.code, "PHOTOS", "the exchange states it")
        XCTAssertEqual(photos.rig.home.sending?.sources[Home.photos]?.sinceMs, failing.sinceMs)

        photos.synthetic.refusesReads = false
        photos.bringingIn = true
        let read = try await photos.wake(.foreground)
        XCTAssertNotNil(read)
        XCTAssertNil(read?.error)
        XCTAssertNil(photos.shipper.state.sending.sources[Home.photos])
        photos.bringingIn = false
        _ = try await photos.wake(.foreground)
        XCTAssertEqual(photos.rig.home.sending?.sources, [:], "the next exchange says Photos reads again")
        try photos.rig.artifact("photo-pass-failing")
    }


    func testAFullDiskIsAWaitForSpaceNeverAPhotosFailure() async throws {
        let photos = try await photos()
        let root = photos.rig.root.appendingPathComponent("full")
        let free = Free(Room.bottomBytes - 1)
        let store = try await CaptureStore.restored(root: root.appendingPathComponent("capture"),
                                                    volume: Volume(root, every: 0, read: { _ in free.bytes }))
        let synthetic = SyntheticLibrary()
        synthetic.put(Self.photo("FULL/L0/001", minutes: 0))
        let pass = PhotoPass(store: store, library: PhotoLibrary(synthetic), stateURL: root.appendingPathComponent("cursor.json"),
                             build: "1 aaaaaaa")
        let home = PhotoPass.Home(caughtUp: true, wanted: { _ in PhotosWanted(photos: [], settled: [], left: .init(wanted: 0, unavailable: 0, bytes: 0)) })
        let full = await pass.run(.wake(.foreground), device: Self.wifi, bringingIn: true, home: home)
        XCTAssertNil(full?.error)
        XCTAssertEqual(full?.waits, .space)
        photos.shipper.photoPass(full)
        XCTAssertNil(photos.shipper.state.sending.sources[Home.photos], "Photos is not failing")
        XCTAssertEqual(BringInStep.after(full, left: nil, idle: 0), .wait(.space), "Bring in all photos waits for room")
        assertNil(await pass.state().failing, "no failed pass's wait")

        free.bytes = Room.keepBytes
        let room = await pass.run(.wake(.foreground), device: Self.wifi, bringingIn: true, home: home)
        XCTAssertNil(room?.waits)
        assertEqual(try await store.entries(domain: .photos).map(\.kind), ["asset"], "what the full disk refused, written")
    }


    func testBringInAllPhotosSaysWhyItWaitsGoesOnWhenTheCauseEndsAndNeverEndsSilently() async throws {
        let photos = try await photos()
        photos.synthetic.put(Self.photo("HERE/L0/001", minutes: 0))
        photos.bringingIn = true
        _ = try await photos.wake(.foreground)
        photos.rig.home.wanted = PhotoRig.wanting(["HERE/L0/001"], left: (1, 0))
        let left = PhotosWanted.Left(wanted: 1, unavailable: 0, bytes: 9)

        photos.device.spare = 0
        let low = try await photos.wake(.foreground)
        XCTAssertEqual(BringInStep.after(low, left: left, idle: 0), .wait(.space))
        photos.device = Self.costly
        let costly = try await photos.wake(.foreground)
        XCTAssertEqual(BringInStep.after(costly, left: left, idle: 0), .wait(.network))
        photos.device = Self.wifi
        let fetched = try await photos.wake(.foreground)
        XCTAssertEqual(fetched?.files, 1, "the cause ended: the file came")
        XCTAssertEqual(BringInStep.after(fetched, left: left, idle: 3), .again(idle: 0), "it moved: it goes on")
        photos.rig.home.wanted = PhotoRig.wanting([], left: (0, 0))
        let finished = try await photos.wake(.foreground)
        XCTAssertEqual(BringInStep.after(finished, left: PhotosWanted.Left(wanted: 0, unavailable: 0, bytes: 0), idle: 0), .done)

        var nothing = PhotoPass.Report()
        XCTAssertEqual(BringInStep.after(nothing, left: left, idle: 0),
                       .stop("\(Words.count(1, "photo")) couldn't be brought in now. Try again later."), "every file to come later")
        XCTAssertEqual(BringInStep.after(nothing, left: nil, idle: 0), .stop("Lifestream didn't say which photos it wants. Try again later."))
        XCTAssertEqual(BringInStep.after(nil, left: left, idle: 0),
                       .stop("Bringing in your photos stopped: this phone couldn't read its library. Try again later."))
        nothing.heldBack = true
        XCTAssertEqual(BringInStep.after(nothing, left: left, idle: 0),
                       .stop("Lifestream is holding older photos back for now. Bring them in once it takes them."))
        var importing = PhotoPass.Report()
        importing.waited = true
        XCTAssertEqual(BringInStep.after(importing, left: left, idle: 0), .again(idle: 1), "the home takes in what was sent")
        XCTAssertEqual(BringInStep.after(importing, left: left, idle: BringInStep.idleLimit - 1),
                       .stop("Lifestream hasn't taken in the photos this phone sent. Try again once it has."), "but not for ever")
    }

    func testBringInAllPhotosSaysItWaitsOnlyWhileReachWaits() {
        let now = Date(timeIntervalSince1970: 1_794_000_000)
        XCTAssertEqual(BringInStep.waiting(.waiting(since: now)), ReachWords.waiting)
        XCTAssertNil(BringInStep.waiting(.unreachable(.offline, since: now)), "unreachable: the banner says it")
        XCTAssertNil(BringInStep.waiting(.unreachable(.silent, since: now)))
        XCTAssertNil(BringInStep.waiting(.held(HomeLink.Held(title: "Held", detail: "Held for a test."))))
    }

    func testBringInAllPhotosWaitsSayingWhyAndGoesOnByItselfOnceTheCauseEnds() async throws {
        let free = Free(Room.keepBytes + 50)
        let volume = Volume(FileManager.default.temporaryDirectory, every: 0, read: { _ in free.bytes })
        let paths = Paths(NetworkFacts(online: true, onLocalNetwork: false, tunnelUp: false, cost: .costly))
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        let link = HomeLink(device: HomeLink.Device(kind: .phone, version: "1.0.0", model: "iPhone", serial4: nil, stamp: nil),
                            credentials: MemoryPass(), folder: folder, network: paths)
        let pauses = Pauses()
        let wait = BringInWait(volume: volume, link: link, phone: "iPhone 17 Pro", pause: { await pauses.pause() })
        let said = Said()

        let space = Task { @MainActor in await wait.out(.space, spare: 50) { said.lines.append($0) } }
        try await until("the wait reads the disk after its first minute") { pauses.waiting == 1 }
        pauses.release()
        try await until("50 bytes still: it waits another minute") { pauses.waiting == 2 }
        free.bytes = Room.keepBytes + 4_000_000
        pauses.release()
        await space.value
        XCTAssertEqual(said.lines, ["The next photo is too large for the space left on iPhone 17 Pro."])

        free.bytes = Room.keepBytes - 1
        said.lines = []
        let low = Task { @MainActor in await wait.out(.space, spare: 0) { said.lines.append($0) } }
        try await until("it waits on the low disk") { pauses.waiting == 3 }
        free.bytes = Room.keepBytes + 1
        pauses.release()
        await low.value
        XCTAssertEqual(said.lines, ["iPhone 17 Pro is almost full. Older photos wait until it has 5 GB free."])
        XCTAssertEqual(BringInWait.space(.full, phone: "iPhone 17 Pro"), "iPhone 17 Pro is full. Older photos wait until it has 5 GB free.")

        said.lines = []
        let network = Task { @MainActor in await wait.out(.network, spare: 0) { said.lines.append($0) } }
        try await until("it says what it waits for") { said.lines == [MobileData.Wait.past.words] }
        paths.set(NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: false, path: 1, cost: .lowData))
        try await until("a Wi-Fi with Low Data Mode is said as such") { said.lines.last == MobileData.Wait.lowData.words }
        paths.set(NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: false, path: 2, cost: .free))
        await network.value
        XCTAssertEqual(said.lines, [MobileData.Wait.past.words, MobileData.Wait.lowData.words], "the module's words, once each")
    }
}

final class Free: @unchecked Sendable {
    private let lock = NSLock()
    private var now: Int64?
    init(_ bytes: Int64?) { now = bytes }
    var bytes: Int64? {
        get { lock.withLock { now } }
        set { lock.withLock { now = newValue } }
    }
}

@MainActor
private final class Said {
    var lines: [String] = []
}

private final class Paths: NetworkWatch, @unchecked Sendable {
    private let lock = NSLock()
    private var now: NetworkFacts
    private var readers: [AsyncStream<NetworkFacts>.Continuation] = []

    init(_ facts: NetworkFacts) { now = facts }

    var facts: NetworkFacts? { lock.withLock { now } }

    func set(_ facts: NetworkFacts) {
        let readers = lock.withLock { now = facts; return self.readers }
        for reader in readers { reader.yield(facts) }
    }

    func changes() -> AsyncStream<NetworkFacts> {
        AsyncStream { continuation in
            let first = lock.withLock { readers.append(continuation); return now }
            continuation.yield(first)
        }
    }
}

private final class Pauses: @unchecked Sendable {
    private let lock = NSLock()
    private var held: [CheckedContinuation<Void, Never>] = []
    private var count = 0

    var waiting: Int { lock.withLock { count } }

    func pause() async {
        await withCheckedContinuation { continuation in
            lock.withLock {
                count += 1
                held.append(continuation)
            }
        }
    }

    func release() {
        let next = lock.withLock { held.isEmpty ? nil : held.removeFirst() }
        next?.resume()
    }
}

@MainActor
private final class PhotoRig {
    let rig: Rig
    let synthetic: SyntheticLibrary
    let pass: PhotoPass
    let shipper: PhoneShipper
    var device = PhotosTests.wifi
    var bringingIn = false

    init(_ rig: Rig) {
        self.rig = rig
        let synthetic = SyntheticLibrary()
        self.synthetic = synthetic
        pass = PhotoPass(store: rig.store, library: PhotoLibrary(synthetic),
                         stateURL: rig.root.appendingPathComponent("photos/cursor.json"), build: "1 aaaaaaa")
        shipper = rig.launch()
    }

    func wake(_ reason: PhoneShipper.Reason = .wake, importing: Bool = true) async throws -> PhotoPass.Report? {
        rig.date.addTimeInterval(11 * 60)
        await shipper.reconcile(.foreground)
        let report = await pass.run(.wake(reason), device: device, bringingIn: bringingIn, home: await .of(shipper))
        shipper.photoPass(report)
        await shipper.reconcile(reason)
        if importing { rig.home.importAll() }
        return report
    }

    static func wanting(_ ids: [String], files: [String] = ["photo"], left: (wanted: Int, unavailable: Int)) -> [String: Any] {
        ["photos": ids.map { ["asset": $0, "files": files] }, "settled": [String](),
         "left": ["wanted": left.wanted, "unavailable": left.unavailable, "bytes": left.wanted * 1_000]]
    }

    func entries(kind: String? = nil) async throws -> [CaptureEntry] {
        try await rig.store.entries(domain: .photos).filter { kind == nil || $0.kind == kind }
    }

    func availabilities() async throws -> [String: [String: JSONValue]] {
        var found: [String: [String: JSONValue]] = [:]
        for entry in try await entries(kind: "resource_availability") {
            guard case .object(let fields) = entry.payload, case .string(let id)? = fields["local_identifier"] else { continue }
            found[id] = resources(entry).first
        }
        return found
    }

    func blobs() async throws -> Int { try await rig.store.validatedBlobInventory().count }
}

private func modification(_ entry: CaptureEntry) -> String? {
    guard case .object(let fields) = entry.payload, case .string(let date)? = fields["modification_date"] else { return nil }
    return date
}

private func cloudID(_ entry: CaptureEntry) -> String? {
    guard case .object(let fields) = entry.payload, case .string(let id)? = fields["cloud_identifier"] else { return nil }
    return id
}

private func of(_ entry: CaptureEntry) -> String? {
    guard case .object(let fields) = entry.payload, case .string(let kind)? = fields["of"] else { return nil }
    return kind
}

private func resources(_ entry: CaptureEntry) -> [[String: JSONValue]] {
    guard case .object(let fields) = entry.payload, case .array(let resources)? = fields["resources"] else { return [] }
    return resources.compactMap { if case .object(let resource) = $0 { resource } else { nil } }
}

private extension JSONValue {
    var object: [String: JSONValue]? { if case .object(let fields) = self { fields } else { nil } }
}

private func assertEqual<T: Equatable>(_ actual: T, _ expected: T, _ message: String = "",
                                       file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(actual, expected, message, file: file, line: line)
}

private func assertNil<T>(_ actual: T?, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertNil(actual, message, file: file, line: line)
}
