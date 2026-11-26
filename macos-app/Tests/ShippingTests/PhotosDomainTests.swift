import Foundation
import DeviceFiles
import HomeLink
import PhotoLibrary
import XCTest
@testable import Shipping

final class PhotosDomainTests: XCTestCase {
    static let source = "apple-photos:person-a@example.com:unit-0001"
    static let mac = Device(metered: false, charging: true, spare: 95_000_000_000,
                            changeRoom: nil)
    static let day = ShippingFixture.instant("2026-09-22T06:00:00.000Z")
    static let still = PhotoResource(typeRaw: 1, uti: "public.heic", originalFilename: "IMG_0001.HEIC")
    static let render = PhotoResource(typeRaw: 5, uti: "public.jpeg", originalFilename: "FullSizeRender.jpg")
    static let movie = PhotoResource(typeRaw: 2, uti: "com.apple.quicktime-movie", originalFilename: "IMG_0004.MOV")

    private var root: URL!

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("photos-domain-tests")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    static func photo(_ id: String, minutes: Double?, resources: [PhotoResource] = [still], cloud: String? = nil) -> PhotoSnapshot {
        let taken = minutes.map { day.addingTimeInterval($0 * 60) }
        return PhotoSnapshot(localIdentifier: id, cloudIdentifier: cloud, mediaTypeRaw: resources == [movie] ? 2 : 1,
                             creationDate: taken, modificationDate: taken ?? day, pixelWidth: 4032, pixelHeight: 3024,
                             resources: resources)
    }

    private struct Rig {
        let home: FakeHome
        let domain: PhotosDomain
        let library: SyntheticLibrary
        let shipper: Shipper
        let clock: FixedClock
        let rows: Collected<ShipperRunRow>
    }

    private func rig(_ device: Device = mac) async throws -> Rig {
        let state = ShippingState(root: root.appendingPathComponent("ship", isDirectory: true), files: DeviceFiles(.plain))
        try state.prepare()
        let clock = FixedClock(ShippingFixture.instant("2026-09-22T23:00:00.000Z"))
        let home = FakeHome(sources: [Self.source], clock: clock.read)
        let link = try await ShippingFixture.link(home, folder: state.root)
        let domain = PhotosDomain(sourceId: Self.source, root: state.photosDirectory, ledgers: state.ledgers)
        let library = SyntheticLibrary()
        let pass = PhotoPass(library: PhotoLibrary(library), store: domain.photos, build: "1 aaaaaaa", now: clock.read)
        let rows = Collected<ShipperRunRow>()
        let settings = MacSettings(file: state.root.appendingPathComponent(MacSettings.fileName), files: state.files)
        let shipper = Shipper(Shipper.Dependencies(
            state: state, link: link, settings: settings, domains: { $0.contains(Self.source) ? [domain] : [] }, clock: clock.read,
            record: { rows.append($0) },
            settle: { answer in
                let report = await pass.run(.init(seconds: 60), device: device, bringingIn: false,
                                            home: domain.home(answer, link: link, settings: settings))
                return domain.settled(report, failing: await pass.state().failing, pass: answer.pass, link: link, at: clock.now)
                    .map { [$0] } ?? []
            }, network: .free, scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true)))
        return Rig(home: home, domain: domain, library: library, shipper: shipper, clock: clock, rows: rows)
    }


    func testThePassShipsThroughTheShipperPacedByTheHome() async throws {
        let rig = try await rig()
        let (home, domain, library) = (rig.home, rig.domain, rig.library)
        for (index, id) in ["P1/L0/001", "P2/L0/001", "P3/L0/001", "P4/L0/001", "P5/L0/001"].enumerated() {
            library.put(Self.photo(id, minutes: -Double(index)), files: id == "P2/L0/001" ? [.inCloud(Data("synthetic cloud bytes".utf8))] : nil)
        }
        var shipped = Set<String>()
        func run() async throws -> (lines: [[String: Any]], blobs: Int)? {
            rig.clock.move(by: 300)
            _ = await rig.shipper.run(.timer)
            let delivered = home.deliveries.filter { !shipped.contains($0.id) }
            shipped.formUnion(delivered.map(\.id))
            XCTAssertLessThanOrEqual(delivered.count, 1, "one bundle a run")
            guard let delivery = delivered.last else { return nil }
            let text = try XCTUnwrap(delivery.members[PhotosDomain.file])
            let lines = try text.split(separator: UInt8(ascii: "\n")).map { try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0)) as? [String: Any]) }
            return (lines, delivery.facts["blobs_carried"] as? Int ?? -1)
        }
        let kinds = { (lines: [[String: Any]]) in lines.map { $0["kind"] as? String ?? "" } }
        let ids = { (lines: [[String: Any]]) in lines.map { (($0["payload"] as? [String: Any])?["local_identifier"] as? String) ?? "" } }
        let held = { try FileManager.default.contentsOfDirectory(atPath: domain.photos.blobs.path).count }

        var bundle = try await run()
        XCTAssertNil(bundle, "what the pass writes ships the next run")
        XCTAssertEqual(home.asked, [], "no file is asked for while the library is read whole")
        library.put(Self.photo("NEW/L0/001", minutes: 60))
        bundle = try await run()
        XCTAssertEqual(bundle.map { kinds($0.lines) }, Array(repeating: "asset", count: 5))
        XCTAssertEqual(bundle.map { ids($0.lines) }, ["P1/L0/001", "P2/L0/001", "P3/L0/001", "P4/L0/001", "P5/L0/001"])
        XCTAssertEqual(bundle?.blobs, 0)

        bundle = try await run()
        XCTAssertEqual(bundle.map { kinds($0.lines) }, ["asset"])
        XCTAssertEqual(bundle?.blobs, 0)
        XCTAssertEqual(home.asked, [], "the home is not asked before it imported what it was sent")

        home.importAll()
        home.wanted = FakeHome.wanting(["P1/L0/001", "P2/L0/001", "NEW/L0/001"])
        bundle = try await run()
        XCTAssertNil(bundle)
        XCTAssertEqual(home.asked, [Self.source])
        XCTAssertEqual(library.downloads, 1)
        bundle = try await run()
        XCTAssertEqual(bundle.map { kinds($0.lines) }, Array(repeating: "resource_availability", count: 3))
        XCTAssertEqual(bundle?.blobs, 3)
        let p2 = try XCTUnwrap(home.deliveries.last?.members.first { $0.value == Data("synthetic cloud bytes".utf8) })
        XCTAssertTrue(p2.key.hasPrefix("blobs/"), "the downloaded file is carried at its hash")
        XCTAssertEqual(try held(), 3, "the files wait until the home imported the seal that carried them")

        home.importAll()
        home.wanted = FakeHome.wanting([])
        try Data("a file a pass stored before it stopped".utf8).write(to: domain.photos.blobs.appendingPathComponent(String(repeating: "ab", count: 32)))
        library.delete("P1/L0/001")
        bundle = try await run()
        XCTAssertNil(bundle)
        XCTAssertEqual(try held(), 0, "every file the home imported, and every file no entry names, is gone from this Mac")
        bundle = try await run()
        XCTAssertEqual(bundle.map { kinds($0.lines) }, ["gone", "gone"])
        XCTAssertEqual(bundle.map { $0.lines.map { (($0["payload"] as? [String: Any])?["of"] as? String) ?? "" } },
                       ["asset", "resource_availability"])

        home.restore(Self.source, received: 2, imported: 2)
        bundle = try await run()
        XCTAssertEqual(bundle.map { kinds($0.lines) },
                       Array(repeating: "asset", count: 6) + Array(repeating: "resource_availability", count: 3) + ["gone", "gone"])
        XCTAssertEqual(bundle?.blobs, 0)
        let lost = try XCTUnwrap(home.deliveries.last?.lost)
        XCTAssertEqual(lost.map { $0["items"] as? Int }, [3], "never silently short")
        XCTAssertEqual(lost.map { $0["what"] as? String }, [BundleWriter.missingFiles])
        home.importAll()
        home.wanted = FakeHome.wanting(["P2/L0/001"])
        bundle = try await run()
        XCTAssertNil(bundle)
        bundle = try await run()
        XCTAssertEqual(bundle.map { kinds($0.lines) }, ["resource_availability"])
        XCTAssertEqual(bundle?.blobs, 1)
        XCTAssertEqual(home.custody(Self.source).received, 4)
        XCTAssertEqual(home.asked, Array(repeating: Self.source, count: 3))
    }

    func testThePassStatesNoPhotoBeforeItsConnectorsStartFromTheHomesAnswer() async throws {
        let rig = try await rig()
        let (home, library) = (rig.home, rig.library)
        home.settings = ["apple-photos": ["start_ms": Int(Self.day.addingTimeInterval(-3_600).timeIntervalSince1970 * 1000)]]
        library.put(Self.photo("OLD/L0/001", minutes: -120))
        library.put(Self.photo("NEW/L0/001", minutes: -30))
        library.put(Self.photo("UNDATED/L0/001", minutes: nil))
        for _ in 0..<2 {
            rig.clock.move(by: 300)
            _ = await rig.shipper.run(.timer)
        }
        let ids = try home.deliveries.flatMap { delivery in
            try XCTUnwrap(delivery.members[PhotosDomain.file]).split(separator: UInt8(ascii: "\n")).map {
                ((try JSONSerialization.jsonObject(with: Data($0)) as? [String: Any])?["payload"] as? [String: Any])?["local_identifier"] as? String
            }
        }
        XCTAssertEqual(Set(ids), ["NEW/L0/001", "UNDATED/L0/001"], "a photo before the start was stated, or an undated one was not")
    }

    func testThePassesCountReachesTheHomeOnlyWhenItChanged() async throws {
        let rig = try await rig()
        let (home, library) = (rig.home, rig.library)
        home.settings = ["apple-photos": ["start_ms": Int(Self.day.addingTimeInterval(-3_600).timeIntervalSince1970 * 1000)]]
        library.put(Self.photo("OLD/L0/001", minutes: -120))
        library.put(Self.photo("NEW/L0/001", minutes: -30))
        library.put(Self.photo("UNDATED/L0/001", minutes: nil))
        func statements() -> [[String: Any]] { home.throughs.compactMap { $0[Self.source] as? [String: Any] } }
        func said() -> [String: Any]? { statements().last }
        func counted() -> [String: Any]? { statements().last { $0["months"] != nil } }
        func runs(_ count: Int, by seconds: TimeInterval = 300) async {
            for _ in 0..<count {
                rig.clock.move(by: seconds)
                _ = await rig.shipper.run(.timer)
            }
        }
        await runs(4)
        let settled = try XCTUnwrap(counted(), "the pass's count was not stated")
        let months = try XCTUnwrap(settled["months"] as? [String: [Any]])
        XCTAssertEqual(months.mapValues { $0.first as? Int }, ["2026-09": 2, "undated": 1], "every photo counted, below the start too")
        XCTAssertEqual(settled["start_ms"] as? Int, Int(Self.day.addingTimeInterval(-3_600).timeIntervalSince1970 * 1000),
                       "the start the home lent")
        await runs(2)
        XCTAssertEqual(said()?["stated_at"] as? String, settled["stated_at"] as? String, "the same count was told again")
        XCTAssertNil(said()?["months"], "the count the home took was said again")

        library.put(Self.photo("AUGUST/L0/001", minutes: -40 * 1_440))
        await runs(2, by: 86_400)
        let told = try XCTUnwrap(counted())
        let grown = try XCTUnwrap(told["months"] as? [String: [Any]])
        XCTAssertEqual(grown.mapValues { $0.first as? Int }, ["2026-08": 1, "2026-09": 2, "undated": 1], "a count that changed was not told")
        XCTAssertNotEqual(told["stated_at"] as? String, settled["stated_at"] as? String)
    }

    func testNoFileIsAskedForUntilTheWholeReadIsImportedWithEverySize() async throws {
        var paging = Self.mac
        paging.page = 2
        let rig = try await rig(paging)
        let ids = ["P1/L0/001", "P2/L0/001", "P3/L0/001", "P4/L0/001", "P5/L0/001"]
        for (index, id) in ids.enumerated() { rig.library.put(Self.photo(id, minutes: -Double(index))) }
        rig.home.wanted = FakeHome.wanting(["P1/L0/001"])
        let run = { () async -> Void in
            rig.clock.move(by: 300)
            _ = await rig.shipper.run(.timer)
        }
        var trail: [[String: Any]] = []
        for page in 1...3 {
            await run()
            await run()
            rig.home.importAll()
            XCTAssertEqual(rig.home.asked, [], "no file asked for after page \(page)")
            let state = try JSONDecoder().decode(PhotoPassState.self, from: XCTUnwrap(rig.domain.photos.readState()))
            trail.append(["page": page, "unread": state.mark?.unread ?? -1, "asked": rig.home.asked.count])
        }
        await run()
        XCTAssertEqual(rig.home.asked, [Self.source])
        await run()
        let lines = try rig.home.deliveries.flatMap { delivery in
            try XCTUnwrap(delivery.members[PhotosDomain.file]).split(separator: UInt8(ascii: "\n")).map {
                try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0)) as? [String: Any])
            }
        }
        XCTAssertEqual(lines.map { $0["kind"] as? String }, Array(repeating: "asset", count: 5) + ["resource_availability"])
        let sizes = lines.prefix(5).map { line in
            (((line["payload"] as? [String: Any])?["resources"] as? [[String: Any]])?.first?["size"] as? Int) ?? -1
        }
        XCTAssertEqual(sizes, ids.map { Data("\($0)/IMG_0001.HEIC".utf8).count }, "every snapshot states its file's size")
        trail.append(["after": "read whole", "asked": rig.home.asked.count, "sizes": sizes])
        try ShippingFixture.artifact("photos-size-first.json", trail)
    }


    func testAFileTheHomeHoldsIsNamedNotCarriedAndClearedAtImport() async throws {
        let rig = try await rig()
        let (home, domain, library) = (rig.home, rig.domain, rig.library)
        library.put(Self.photo("HELD/L0/001", minutes: 1))
        library.put(Self.photo("NEW/L0/001", minutes: 0))
        let heldHash = "sha256:" + DomainFixtures.sha256("HELD/L0/001/IMG_0001.HEIC")
        home.holds = [heldHash]
        let run = { () async -> Void in
            rig.clock.move(by: 300)
            _ = await rig.shipper.run(.timer)
        }
        await run()
        await run()
        home.importAll()
        home.wanted = FakeHome.wanting(["HELD/L0/001", "NEW/L0/001"])
        await run()
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: domain.photos.blobs.path).count, 2)
        await run()
        let shipped = try XCTUnwrap(home.deliveries.last)
        XCTAssertEqual(shipped.members.keys.filter { $0.hasPrefix("blobs/") }, ["blobs/" + DomainFixtures.sha256("NEW/L0/001/IMG_0001.HEIC")])
        XCTAssertEqual(shipped.facts["blobs_carried"] as? Int, 1)
        let text = String(decoding: try XCTUnwrap(shipped.members[PhotosDomain.file]), as: UTF8.self)
        XCTAssertTrue(text.contains(heldHash), "the held file is named in its availability")
        XCTAssertEqual(shipped.lost.count, 0, "a held file is never stated lost")
        XCTAssertEqual(Set(home.heldAsked.flatMap { $0 }), [heldHash, "sha256:" + DomainFixtures.sha256("NEW/L0/001/IMG_0001.HEIC")])

        home.importAll()
        home.wanted = FakeHome.wanting([])
        await run()
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: domain.photos.blobs.path).count, 0)

        home.restore(Self.source, received: 0, imported: 0)
        await run()
        let again = try XCTUnwrap(home.deliveries.last)
        XCTAssertEqual(again.facts["blobs_carried"] as? Int, 0)
        XCTAssertEqual(again.lost.map { $0["items"] as? Int }, [1], "only the file the home lacks is lost")
        try ShippingFixture.artifact("photos-held.json", [
            "carried": shipped.members.keys.filter { $0.hasPrefix("blobs/") }.sorted(),
            "named": [heldHash], "asked": home.heldAsked, "lost_after_restore": again.lost,
        ])
    }


    func testWhileThePastIsHeldBackNoPageAndNoFileFlowButANewPhotoShips() async throws {
        var paging = Self.mac
        paging.page = 2
        let rig = try await rig(paging)
        let (home, library) = (rig.home, rig.library)
        for (index, id) in ["P1/L0/001", "P2/L0/001", "P3/L0/001"].enumerated() { library.put(Self.photo(id, minutes: -Double(index))) }
        home.wanted = FakeHome.wanting(["P1/L0/001"])
        let run = { () async -> Void in
            rig.clock.move(by: 300)
            _ = await rig.shipper.run(.timer)
            home.importAll()
        }
        await run()
        await run()
        home.holdingBack = [Self.source]
        library.put(Self.photo("NEW/L0/001", minutes: 60))
        let before = library.snapshotsRead
        await run()
        await run()
        XCTAssertEqual(library.snapshotsRead, before + 1, "the photo taken now, and no page")
        XCTAssertEqual(home.asked, [], "no file is asked for")
        XCTAssertEqual(library.downloads, 0)
        let ids = try home.deliveries.flatMap { delivery in
            try XCTUnwrap(delivery.members[PhotosDomain.file]).split(separator: UInt8(ascii: "\n")).map {
                ((try JSONSerialization.jsonObject(with: Data($0)) as? [String: Any])?["payload"] as? [String: Any])?["local_identifier"] as? String
            }
        }
        XCTAssertEqual(ids, ["P1/L0/001", "P2/L0/001", "NEW/L0/001"], "the new photo ships while the past waits")

        home.holdingBack = []
        await run()
        XCTAssertEqual(home.asked, [Self.source], "the page's pass asks once, for the new photo it owes: the Mac fetches none inline")
        await run()
        await run()
        XCTAssertEqual(home.asked, [Self.source, Self.source], "and the pass after the whole read once more, for the wanted list")
        try ShippingFixture.artifact("photos-held-back.json", ["shipped": ids, "asked_after_letting_go": home.asked])
    }


    func testABacklogShipsInBundlesOfAtMost20000Entries() async throws {
        let ledgers = Ledgers(root: root.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain))
        let domain = PhotosDomain(sourceId: Self.source, root: root.appendingPathComponent("photos", isDirectory: true), ledgers: ledgers)
        let backlog = (0...PhotosDomain.maximumEntries).map { index in
            PhotoEntry(kind: .asset, replayKey: "photos:B\(index)/L0/001:null:synthetic", observedAt: "2026-09-22T06:00:00.000000000Z",
                       payload: Data(#"{"local_identifier":"B\#(index)/L0/001"}"#.utf8))
        }
        let appended = try await domain.photos.append(backlog)
        XCTAssertEqual(appended, PhotosDomain.maximumEntries + 1)
        let lines = { (sealed: SealedBundle?) in
            try XCTUnwrap(StoredZipReader(XCTUnwrap(sealed).file).bytes(PhotosDomain.file)).count { $0 == UInt8(ascii: "\n") }
        }
        let first = try domain.sealOne(SealRequest(fetchedAt: Self.day, workDirectory: root, scratch: root, custody: ShippingFixture.first))
        XCTAssertEqual(try lines(first), PhotosDomain.maximumEntries)
        let rest = try domain.sealOne(SealRequest(fetchedAt: Self.day, workDirectory: root, scratch: root,
                                                  custody: SealCustody(pass: ShippingFixture.pass, received: 1, imported: 0)))
        XCTAssertEqual(try lines(rest), 1, "the rest ships the next run")
    }


    func testSyncNowRunsNoPassAndAPassThatFailsIsTheRunsRowNamingNoPath() async throws {
        let rig = try await rig()
        rig.library.put(Self.photo("P1/L0/001", minutes: 0))
        let manual = await rig.shipper.run(.manual)
        XCTAssertEqual(try rig.domain.photos.lastSequence(), 0, "Sync now waited on the library")
        XCTAssertEqual(manual.outcome, "nothing_new")

        let blocked = rig.domain.photos.stateFile
        try FileManager.default.createDirectory(at: blocked.appendingPathComponent("held", isDirectory: true), withIntermediateDirectories: true)
        rig.clock.move(by: 300)
        let timer = await rig.shipper.run(.timer)
        let failed = try XCTUnwrap(rig.rows.all.last)
        XCTAssertEqual([timer.outcome, failed.domain, failed.source], ["refused LOCAL_ACCESS", "photos", Self.source])
        let words = try XCTUnwrap(failed.reason)
        XCTAssertFalse(words.contains("/"), "a failed photo read names a path: \(words)")
        XCTAssertFalse(failed.detail.values.contains { $0.contains(root.path) })
    }


    private func metered(_ device: Device, wanting wanted: [String], library put: (SyntheticLibrary) -> Void) async throws
        -> (asked: [Bool], waits: [Bool], blobs: Int, rig: Rig) {
        let rig = try await rig(device)
        put(rig.library)
        rig.home.wanted = FakeHome.wanting(wanted)
        var asked: [Bool] = [], waits: [Bool] = []
        for _ in 0..<4 {
            rig.clock.move(by: 300)
            let asks = rig.home.asked.count
            waits.append(await rig.shipper.run(.timer).waitsForNetwork)
            asked.append(rig.home.asked.count > asks)
            rig.home.importAll()
        }
        let blobs = rig.home.deliveries.map { $0.facts["blobs_carried"] as? Int ?? 0 }.reduce(0, +)
        return (asked, waits, blobs, rig)
    }

    func testAMeteredWayHomeAsksNothingAndSaysNothing() async throws {
        let away = Device(metered: true, charging: true, spare: Self.mac.spare, changeRoom: nil)
        let (asked, waits, blobs, rig) = try await metered(away, wanting: ["P1/L0/001"]) {
            $0.put(Self.photo("P1/L0/001", minutes: 0), files: [.inCloud(Data("synthetic cloud bytes".utf8))])
        }
        XCTAssertEqual(asked, [false, false, false, false], "the door would count an ask as this Mac taking the photos")
        XCTAssertEqual(waits, [false, false, false, false], "the photo pass says no wait in the menu: the phone is asked after an hour")
        XCTAssertEqual([blobs, rig.library.downloads], [0, 0], "and no file moves")
    }

    func testAFileOnDiskGoesToAHomeOnThisMacWhileICloudsWaitForAFreeInternet() async throws {
        let here = Device(homeMetered: false, internetMetered: true, charging: true, spare: Self.mac.spare, changeRoom: nil)
        let (asked, waits, blobs, rig) = try await metered(here, wanting: ["DISK/L0/001", "CLOUD/L0/001"]) {
            $0.put(Self.photo("DISK/L0/001", minutes: 1))
            $0.put(Self.photo("CLOUD/L0/001", minutes: 0), files: [.inCloud(Data("synthetic cloud bytes".utf8))])
        }
        XCTAssertEqual(blobs, 1, "the file on this Mac's disk goes over loopback")
        XCTAssertEqual(rig.library.downloads, 0, "the one only iCloud holds waits for a free internet")
        XCTAssertTrue(asked.contains(true), "a home on this Mac is asked on a metered network")
        XCTAssertEqual(waits, [false, false, false, false], "the photo pass says no wait in the menu")
    }


    func testTheBundleIsTheWireTheHomesConnectorReads() async throws {
        let source = "apple-photos:person-a@example.com:macbook-pro-0001"
        let clock = FixedClock(ShippingFixture.instant("2026-09-22T23:00:00.000Z"))
        let ledgers = Ledgers(root: root.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain))
        let domain = PhotosDomain(sourceId: source, root: root.appendingPathComponent("photos", isDirectory: true), ledgers: ledgers)
        let library = SyntheticLibrary()
        let edited = Self.photo("EDITED/L0/001", minutes: 3, resources: [Self.still, Self.render], cloud: "EDITED:001:synthetic")
        library.put(edited)
        library.put(Self.photo("CLOUD/L0/001", minutes: 2, cloud: "CLOUD:001:synthetic"), files: [.inCloud(Data("synthetic cloud bytes".utf8))])
        library.put(Self.photo("VIDEO/L0/001", minutes: 1, resources: [Self.movie]))
        library.put(Self.photo("LOST/L0/001", minutes: 0), files: [.missing])
        library.put(Self.photo("UNDATED/L0/001", minutes: nil))
        let pass = PhotoPass(library: PhotoLibrary(library), store: domain.photos, now: clock.read)
        func run(wanting wanted: [String] = []) async {
            clock.move(by: 60)
            let home = PhotoPass.Home(caughtUp: true, wanted: {
                PhotosWanted(photos: wanted.map { .init(asset: $0, files: ["photo", "video", "fullSizePhoto"]) },
                             left: .init(wanted: wanted.count, unavailable: 0, bytes: 0))
            })
            _ = await pass.run(.init(seconds: 60), device: Self.mac, bringingIn: false, home: home)
        }
        await run()
        await run(wanting: ["EDITED/L0/001", "CLOUD/L0/001", "VIDEO/L0/001", "LOST/L0/001"])
        library.delete("VIDEO/L0/001")
        await run()

        let sealed = try XCTUnwrap(domain.sealOne(SealRequest(fetchedAt: clock.now, workDirectory: root, scratch: root, custody: ShippingFixture.first)))
        let zip = try StoredZipReader(sealed.file)
        let text = try XCTUnwrap(zip.bytes(PhotosDomain.file))
        let lines = text.split(separator: UInt8(ascii: "\n")).map { Data($0) }
        XCTAssertEqual(lines.count, 5 + 4 + 2)
        let first = try XCTUnwrap(lines.first)
        var stated = edited
        stated.resources = edited.resources.map { resource in
            var sized = resource
            sized.size = Int64(Data("EDITED/L0/001/\(resource.originalFilename)".utf8).count)
            return sized
        }
        let asset = stated.asset(now: clock.now)
        XCTAssertEqual(first, Data(#"{"kind":"asset","observed_at":"\#(asset.observedAt)","payload":"#.utf8) + asset.payload + Data("}".utf8))
        XCTAssertEqual(Set(zip.names.filter { $0.hasPrefix("blobs/") }).count, 4, "the still, its render, the cloud file and the video")
        try DomainFixtures.connectorFixture(sealed, connector: "photos/apple", named: "mac-bundle.zip")
    }
}
