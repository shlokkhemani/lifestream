import Foundation
import XCTest
@testable import PhotoLibrary

final class PassTests: XCTestCase {
    private static let day = Date(timeIntervalSince1970: 1_780_000_000)
    private static let wifi = Device(pastMoves: true, iCloud: true, charging: false, spare: 95_000_000_000)
    private static let still = PhotoResource(typeRaw: 1, uti: "public.heic", originalFilename: "IMG_0001.HEIC")

    private static func photo(_ id: String) -> PhotoSnapshot {
        PhotoSnapshot(localIdentifier: id, creationDate: day, modificationDate: day, resources: [still])
    }

    func testAPassThatFailsWaitsBeforeItRunsAgainAndANewBuildRunsAtOnce() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.put(Self.photo("GONE/L0/001"))
        let store = MemoryStore()
        let clock = TestClock(Self.day)
        func pass(_ build: String) -> PhotoPass {
            PhotoPass(library: PhotoLibrary(synthetic), store: store, build: build, now: { clock.now })
        }
        let home = PhotoPass.Home(caughtUp: true, wanted: { _ in Self.wanting(["GONE/L0/001"]) })
        func run(_ pass: PhotoPass, bringingIn: Bool = false) async -> PhotoPass.Report? {
            await pass.run(.init(seconds: 60), device: Self.wifi, bringingIn: bringingIn, home: home)
        }
        let first = pass("1 aaaaaaa")
        let read = await run(first)
        XCTAssertEqual([read?.snapshots, read?.files], [1, 0], "its page, and no file while the library is read whole")
        let fetched = await run(first)
        XCTAssertEqual([fetched?.snapshots, fetched?.files], [0, 1], "read whole, the file the home wants")
        synthetic.delete("GONE/L0/001")
        store.unreadable = true

        assertNotNil(await run(first)?.error)
        assertEqual(await first.state().failing?.passes, 1)
        clock.now += 14 * 60
        assertNil(await run(first), "a wake inside the wait runs nothing")
        clock.now += 2 * 60
        assertNotNil(await run(first)?.error, "after 15 minutes it runs again")
        clock.now += 20 * 60
        assertNil(await run(first), "the second wait is 30 minutes")
        assertNotNil(await run(first, bringingIn: true)?.error, "Bring in all photos runs inside the wait")
        clock.now += 61 * 60
        for _ in 0..<10 {
            clock.now += 86_400
            _ = await run(first)
        }
        clock.now += 86_400 - 60
        assertNil(await run(first), "the wait grows to a day")
        clock.now += 61
        assertNotNil(await run(first)?.error, "and never past it")
        clock.now -= 3_600
        assertNotNil(await run(first)?.error, "a clock set back never strands the wait")

        let updated = pass("2 bbbbbbb")
        assertNotNil(await run(updated)?.error, "a new build tries at once")
        assertEqual(await updated.state().failing?.passes, 1, "and counts its own failures")

        store.unreadable = false
        clock.now += 86_400
        let healed = await run(updated)
        XCTAssertNil(healed?.error)
        XCTAssertEqual(healed?.gone, 2, "the deletion of its snapshot and its file, stated once it reads")
        XCTAssertEqual(healed?.refused, 1)
        assertNil(await updated.state().failing, "a pass that ends whole ends the wait")
    }

    func testAPhotosFilesAreExportedIntoTheFolderThePassIsHandedAndThePhonesIntoItsTemporaryFolder() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("photo-exports-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let home = PhotoPass.Home(caughtUp: true, wanted: { _ in Self.wanting(["A/L0/001"]) })
        func exports(_ make: (PhotoLibrary, MemoryStore) -> PhotoPass) async -> Set<String> {
            let synthetic = SyntheticLibrary()
            synthetic.put(Self.photo("A/L0/001"))
            let store = MemoryStore()
            let pass = make(PhotoLibrary(synthetic), store)
            for _ in 0..<2 { _ = await pass.run(.init(seconds: 60), device: Self.wifi, bringingIn: false, home: home) }
            return Set(store.exported.map { $0.deletingLastPathComponent().standardizedFileURL.path })
        }
        let phone = await exports { PhotoPass(library: $0, store: $1) }
        XCTAssertEqual(phone, [FileManager.default.temporaryDirectory.standardizedFileURL.path], "the phone exports where it always has")
        let mac = await exports { PhotoPass(library: $0, store: $1, exports: folder) }
        XCTAssertEqual(mac, [folder.standardizedFileURL.path])
    }

    func testStopEndsThePass() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.put(Self.photo("A/L0/001"))
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: MemoryStore())
        let home = PhotoPass.Home(caughtUp: true, wanted: { _ in Self.wanting([]) })
        let stopped = await Task { () -> PhotoPass.Report? in
            withUnsafeCurrentTask { $0?.cancel() }
            return await pass.run(.init(seconds: 60), device: Self.wifi, bringingIn: true, home: home)
        }.value
        XCTAssertEqual(stopped?.snapshots, 0)
        assertNil(await pass.state().mark, "stopped before it read anything")
        let ran = await pass.run(.init(seconds: 60), device: Self.wifi, bringingIn: true, home: home)
        XCTAssertEqual(ran?.snapshots, 1)
        XCTAssertEqual(ran?.read, 1)
    }

    func testADownloadUnderWayEndsAtThePassesTime() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.put(Self.photo("SLOW/L0/001"), files: [.stalled])
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: MemoryStore())
        let home = PhotoPass.Home(caughtUp: true, wanted: { _ in Self.wanting(["SLOW/L0/001"]) })
        let charging = Device(pastMoves: true, iCloud: true, charging: true, spare: 95_000_000_000)
        _ = await pass.run(.init(seconds: 60), device: charging, bringingIn: false, home: home)
        let started = Date()
        let report = await pass.run(.init(seconds: 0.5), device: charging, bringingIn: false, home: home)
        XCTAssertLessThan(Date().timeIntervalSince(started), 10, "the download was cancelled at the pass's time")
        XCTAssertNil(report?.error)
        XCTAssertEqual(report?.files, 0)
        XCTAssertEqual(report?.refused, 0, "a file cut off comes later, never refused")
    }

    func testADoorThatDoesNotAnswerEndsAtThePassesTime() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.put(Self.photo("A/L0/001"))
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: MemoryStore())
        let home = PhotoPass.Home(caughtUp: true, wanted: { _ in
            try await Task.sleep(nanoseconds: 86_400 * 1_000_000_000)
            return Self.wanting([])
        })
        let paged = await pass.run(.init(seconds: 60), device: Self.wifi, bringingIn: false, home: home)
        XCTAssertEqual(paged?.paged, true, "the library read whole, asking nothing")
        let started = Date()
        let report = await pass.run(.init(seconds: 0.5), device: Self.wifi, bringingIn: false, home: home)
        XCTAssertLessThan(Date().timeIntervalSince(started), 10, "the ask was cancelled at the pass's time")
        XCTAssertNil(report?.error, "a door cut off is no answer this pass, never a failure")
    }

    func testCopiesAreClearedOnlyBetweenPasses() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.put(Self.photo("A/L0/001"))
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
        let (entered, enter) = AsyncStream<Void>.makeStream()
        let (release, released) = AsyncStream<Void>.makeStream()
        let home = PhotoPass.Home(caughtUp: true, wanted: { _ in
            enter.yield()
            for await _ in release { break }
            return Self.wanting([])
        })
        _ = await pass.run(.init(seconds: 60), device: Self.wifi, bringingIn: false, home: PhotoPass.Home(caughtUp: true, wanted: { _ in Self.wanting([]) }))
        let running = Task { await pass.run(.init(seconds: 60), device: Self.wifi, bringingIn: false, home: home) }
        for await _ in entered { break }
        do {
            _ = try await pass.whileIdle { true }
            XCTFail("cleared during a pass")
        } catch {
            XCTAssertEqual(error as? PhotoPassBusy, PhotoPassBusy())
        }
        released.yield()
        assertNotNil(await running.value)
        let cleared = try await pass.whileIdle { true }
        XCTAssertTrue(cleared)
    }
}

extension PassTests {
    static func wanting(_ ids: [String], files: [String] = ["photo"], settled: [String] = []) -> PhotosWanted {
        PhotosWanted(photos: ids.map { .init(asset: $0, files: files) }, settled: settled,
                     left: .init(wanted: ids.count, unavailable: 0, bytes: Int64(ids.count) * 1_000))
    }

    static func home(history: Bool = true, asked: Asks, wanting wanted: PhotosWanted) -> PhotoPass.Home {
        PhotoPass.Home(caughtUp: true, history: history, wanted: { owed in
            asked.count(owed)
            return wanted
        })
    }

    func testOnMobileDataWhatIsTakenNowMovesWithItsFilesAndThePastWaits() async throws {
        let synthetic = SyntheticLibrary()
        for index in 0..<25 { synthetic.put(Self.photo("OLD\(index)/L0/001", at: -60 - Double(index))) }
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
        let mobile = Device(pastMoves: false, iCloud: false, charging: false, spare: 95_000_000_000)
        let asked = Asks()
        let home = PhotoPass.Home(caughtUp: true, wanted: { owed in
            asked.count(owed)
            guard !asked.paused else { return PhotosWanted(photos: [], settled: [], left: .init(wanted: 0, unavailable: 0, bytes: 0)) }
            return Self.wanting(owed.filter { !asked.unnamed.contains($0) && !asked.settled.contains($0) },
                                settled: owed.filter(asked.settled.contains))
        })
        let run = { (device: Device) in await pass.run(.init(seconds: 60), device: device, bringingIn: false, home: home) }
        var steps: [[String: Any]] = []
        func step(_ name: String, _ report: PhotoPass.Report?) async {
            let state = await pass.state()
            steps.append(["step": name, "snapshots": report?.snapshots ?? -1, "files": report?.files ?? -1,
                          "waits": report?.waits?.rawValue ?? "", "owed": state.owed.sorted(), "unread": state.mark?.unread ?? -1,
                          "asked": synthetic.filesAsked])
        }

        let first = await run(mobile)
        await step("first", first)
        XCTAssertEqual(first?.paged, false, "the first pass pages nothing")
        XCTAssertEqual(first?.snapshots, 0)
        assertEqual(await pass.state().mark?.unread, 25, "but takes the token and lists the backlog")
        XCTAssertNotNil(first?.stated?.months, "and counts it")
        XCTAssertEqual(synthetic.snapshotsRead, 0, "no photo of the past is read")
        XCTAssertEqual(first?.waits, .network)

        for index in 0..<23 { synthetic.put(Self.photo("NOW\(index)/L0/001", at: Double(index))) }
        synthetic.put(PhotoSnapshot(localIdentifier: "UNDATED/L0/001", creationDate: nil, modificationDate: Self.day,
                                    resources: [Self.still]))
        synthetic.put(Self.photo("WRITING/L0/001", at: 30), files: [.here(Data())])
        let taken = await run(mobile)
        await step("taken", taken)
        XCTAssertEqual(taken?.snapshots, 25, "every photo the history names, stated now")
        XCTAssertEqual(taken?.files, 24, "each with its files at once, the undated one too")
        XCTAssertEqual(synthetic.filesAsked, 24, "the file still being written is not asked for")
        XCTAssertEqual(taken?.waits, .network)
        assertEqual(await pass.state().owed, ["WRITING/L0/001"], "the photo whose files did not land is owed")
        XCTAssertEqual(asked.owed, [], "the home has not taken it yet: it is not asked for")

        let retried = await run(mobile)
        await step("retried", retried)
        XCTAssertEqual(asked.owed, [["WRITING/L0/001"]], "the owed photo asked for by name")
        XCTAssertEqual(retried?.files, 0)
        XCTAssertEqual(synthetic.filesAsked, 24, "its file still states 0 bytes: no request")
        assertEqual(await pass.state().owed, ["WRITING/L0/001"], "a retry that answers later while a file is written stays owed")
        assertEqual(await pass.state().later, [], "an owed photo never enters later")

        synthetic.finishWriting("WRITING/L0/001", files: [.here(Data("written".utf8))])
        let landed = await run(mobile)
        await step("landed", landed)
        XCTAssertEqual(landed?.files, 1, "from the wanted list, as owed, over mobile data")
        XCTAssertEqual(landed?.snapshots, 1, "with its snapshot as it stands")
        assertEqual(await pass.state().owed, [], "landed, it leaves owed")

        synthetic.put(Self.photo("ELSEWHERE/L0/001", at: 40), files: [.here(Data())])
        synthetic.put(Self.photo("CLOUD/L0/001", at: 41), files: [.inCloud(Data("in iCloud".utf8))])
        _ = await run(mobile)
        assertEqual(await pass.state().owed, ["CLOUD/L0/001", "ELSEWHERE/L0/001"])
        asked.settled = ["ELSEWHERE/L0/001"]
        let answered = await run(mobile)
        await step("answered", answered)
        XCTAssertEqual(asked.owed.last, ["CLOUD/L0/001", "ELSEWHERE/L0/001"])
        assertEqual(await pass.state().owed, [],
                    "the one the home settled leaves, and the one only iCloud holds leaves for the past's rule")
        XCTAssertEqual(synthetic.downloads, 0, "nothing comes from iCloud")
        assertEqual(await pass.state().later, [])

        synthetic.put(Self.photo("LATE/L0/001", at: 45), files: [.here(Data())])
        _ = await run(mobile)
        assertEqual(await pass.state().owed, ["LATE/L0/001"])
        asked.unnamed = ["LATE/L0/001"]
        let unknown = await run(mobile)
        await step("not known yet", unknown)
        XCTAssertEqual(asked.owed.last, ["LATE/L0/001"])
        assertEqual(await pass.state().owed, ["LATE/L0/001"], "a photo the home does not know yet, neither wanted nor settled, stays owed")
        asked.unnamed = []
        asked.paused = true
        let paused = await run(mobile)
        await step("paused", paused)
        XCTAssertEqual(asked.owed.last, ["LATE/L0/001"])
        assertEqual(await pass.state().owed, ["LATE/L0/001"], "a home whose past is paused settles nothing: it stays owed")
        asked.paused = false
        let wanted = await run(mobile)
        await step("wanted while written", wanted)
        XCTAssertEqual(asked.owed.last, ["LATE/L0/001"])
        XCTAssertEqual(wanted?.files, 0, "its file still states 0 bytes")
        assertEqual(await pass.state().owed, ["LATE/L0/001"], "wanted while it is written, it stays owed")
        let lateAsked = synthetic.filesAsked
        synthetic.put(PhotoSnapshot(localIdentifier: "LATE/L0/001", creationDate: Self.day.addingTimeInterval(45 * 60),
                                    modificationDate: Self.day.addingTimeInterval(46 * 60), resources: [Self.still]))
        let resaved = await run(mobile)
        await step("saved again", resaved)
        XCTAssertEqual([resaved?.snapshots, resaved?.files], [1, 1], "the re-save is now: its files come inline, over mobile data")
        XCTAssertEqual(synthetic.filesAsked, lateAsked + 1)
        assertEqual(await pass.state().owed, [], "landed, it leaves owed")

        let filesAsked = synthetic.filesAsked
        synthetic.put(PhotoSnapshot(localIdentifier: "OLD3/L0/001", creationDate: Self.day.addingTimeInterval(-63 * 60),
                                    modificationDate: Self.day.addingTimeInterval(600 * 60), isFavorite: true,
                                    resources: [Self.still]))
        let favourite = await run(mobile)
        await step("backlog named again", favourite)
        XCTAssertEqual([favourite?.snapshots, favourite?.files], [1, 0], "a backlog photo named again: its snapshot, no file")
        XCTAssertEqual(synthetic.filesAsked, filesAsked)
        assertEqual(await pass.state().owed, [])
        assertEqual(await pass.state().mark?.unread, 25, "the backlog is not paged")
        XCTAssertEqual(store.entries.filter { $0.kind == .availability && $0.replayKey.hasPrefix("photos:OLD") }.count, 0,
                       "nor fetched")
        XCTAssertEqual(favourite?.waits, .network)

        let wifi = await run(Self.wifi)
        await step("wifi", wifi)
        XCTAssertEqual(wifi?.paged, true, "the past moves on a free network")

        synthetic.put(PhotoSnapshot(localIdentifier: "OLD5/L0/001", creationDate: Self.day.addingTimeInterval(-65 * 60),
                                    modificationDate: Self.day.addingTimeInterval(700 * 60), resources: [Self.still]))
        let stated = await run(mobile)
        await step("stated before without files", stated)
        XCTAssertEqual([stated?.snapshots, stated?.files], [1, 0], "a photo stated before without files: its snapshot, no file")
        XCTAssertEqual(synthetic.filesAsked, filesAsked)
        XCTAssertEqual(stated?.waits, .network, "the wanted files wait")

        synthetic.put(Self.photo("LOST/L0/001", at: 50))
        synthetic.prune()
        let pruned = await run(mobile)
        await step("pruned", pruned)
        XCTAssertEqual(pruned?.snapshots, 0, "a pruned history reads whole again: what it lost is past")
        assertEqual(await pass.state().mark?.unread, try await PhotoLibrary(synthetic).count())
        XCTAssertEqual(synthetic.filesAsked, filesAsked)
        XCTAssertEqual(store.entries.filter { $0.replayKey.hasPrefix("photos:LOST/L0/001:") }.count, 0)
        try Self.artifact("mobile-data.json", ["steps": steps])
    }

    func testOnACostlyPathANewVideoOf500MBStaysOwedUnfetchedUntilEverythingAndOf400MBGoesNow() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.put(Self.photo("OLD/L0/001", at: -60))
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
        let mobile = Device(pastMoves: false, iCloud: false, charging: false, spare: 95_000_000_000)
        let everything = Device(pastMoves: true, iCloud: false, charging: false, spare: 95_000_000_000)
        let asked = Asks()
        let home = PhotoPass.Home(caughtUp: true, history: false, wanted: { owed in
            asked.count(owed)
            return Self.wanting(owed, files: ["video"])
        })
        let run = { (device: Device) in await pass.run(.init(seconds: 60), device: device, bringingIn: false, home: home) }
        _ = await run(mobile)
        assertEqual(await pass.state().mark?.unread, 1, "the first read is not done: the past is paused")

        synthetic.put(Self.video("LARGE/L0/001", at: 1), files: [.sized(PhotoLibrary.wifiVideoBytes, Data("large".utf8))])
        synthetic.put(Self.video("SMALLER/L0/001", at: 2), files: [.sized(400_000_000, Data("smaller".utf8))])
        let taken = await run(mobile)
        XCTAssertEqual([taken?.snapshots, taken?.files], [2, 1], "both stated, the 400 MB one with its file")
        XCTAssertEqual(synthetic.filesAsked, 1, "the 500 MB one is never asked for")
        XCTAssertEqual(taken?.waits, .network)
        assertEqual(await pass.state().owed, ["LARGE/L0/001"])

        let owed = await run(mobile)
        XCTAssertEqual(asked.owed, [["LARGE/L0/001"]], "its owed fetch runs while the past is paused")
        XCTAssertEqual(owed?.files, 0)
        XCTAssertEqual(owed?.waits, .network)
        XCTAssertEqual(synthetic.filesAsked, 1, "and does not ask for it on mobile data")
        assertEqual(await pass.state().owed, ["LARGE/L0/001"], "it stays owed")

        let free = await run(everything)
        XCTAssertEqual(free?.files, 1, "on Everything the owed fetch takes it")
        XCTAssertEqual(synthetic.filesAsked, 2)
        assertEqual(await pass.state().owed, [])

        synthetic.put(Self.video("LATER/L0/001", at: 3), files: [.sized(600_000_000, Data("later".utf8))])
        synthetic.put(Self.video("ALSO/L0/001", at: 4), files: [.sized(400_000_000, Data("also".utf8))])
        let both = await run(everything)
        XCTAssertEqual(both?.files, 2, "with Everything both sizes go at once")
        assertEqual(await pass.state().owed, [])
    }

    func testAPassWritesALargeFilesAvailabilityAfterItsPhotos() async throws {
        let synthetic = SyntheticLibrary()
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
        let home = PhotoPass.Home(caughtUp: true, wanted: { owed in Self.wanting(owed) })
        _ = await pass.run(.init(seconds: 60), device: Self.wifi, bringingIn: false, home: home)
        synthetic.put(Self.photo("BEFORE/L0/001", at: 1))
        synthetic.put(Self.video("LARGE/L0/001", at: 2), files: [.sized(PhotoPass.largeBytes, Data("large".utf8))])
        synthetic.put(Self.photo("AFTER/L0/001", at: 3))
        let report = await pass.run(.init(seconds: 60), device: Self.wifi, bringingIn: false, home: home)
        XCTAssertEqual(report?.files, 3)
        let order = store.entries.filter { $0.kind == .availability }.map { String($0.replayKey.split(separator: ":")[1]) }
        XCTAssertEqual(order, ["BEFORE/L0/001", "AFTER/L0/001", "LARGE/L0/001"],
                       "the photos of one pass are sealed before the video they were taken with")
    }

    func testAHeldPhotoNamedAgainFetchesOnlyTheFilesWhoseBindingChanged() async throws {
        let video = PhotoResource(typeRaw: 9, uti: "com.apple.quicktime-movie", originalFilename: "IMG_0001.MOV")
        let render = PhotoResource(typeRaw: 5, uti: "public.jpeg", originalFilename: "FullSizeRender.jpg")
        let synthetic = SyntheticLibrary()
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
        let mobile = Device(pastMoves: false, iCloud: false, charging: false, spare: 95_000_000_000)
        let run = {
            await pass.run(.init(seconds: 60), device: mobile, bringingIn: false, home: Self.home(asked: Asks(), wanting: Self.wanting([])))
        }
        func live(edited minutes: Double, favourite: Bool, _ resources: [PhotoResource]) -> PhotoSnapshot {
            PhotoSnapshot(localIdentifier: "LIVE/L0/001", creationDate: Self.day, modificationDate: Self.day.addingTimeInterval(minutes * 60),
                          isFavorite: favourite, resources: resources)
        }
        _ = await run()
        synthetic.put(live(edited: 0, favourite: false, [Self.still, video]))
        let taken = await run()
        XCTAssertEqual([taken?.files, synthetic.filesAsked], [1, 2], "taken now: both files")

        synthetic.put(live(edited: 10, favourite: true, [Self.still, video]))
        let favourite = await run()
        XCTAssertEqual([favourite?.snapshots, favourite?.files, synthetic.filesAsked], [1, 0, 2], "a favourite changes no file: none asked for")
        assertEqual(await pass.state().owed, [])

        synthetic.put(live(edited: 20, favourite: true, [Self.still, video, render]))
        let edited = await run()
        XCTAssertEqual([edited?.snapshots, edited?.files, synthetic.filesAsked], [1, 1, 3], "an edit: its render alone")
        let more = try XCTUnwrap(store.entries.last { $0.kind == .availability })
        let resources = try XCTUnwrap((try JSONSerialization.jsonObject(with: more.payload) as? [String: Any])?["resources"] as? [[String: Any]])
        XCTAssertEqual(resources.map { $0["blob"] is NSNull }, [true, true, false])
        assertEqual(await pass.state().owed, [])

        synthetic.put(live(edited: 30, favourite: false, [Self.still, video, render]))
        let unfavourite = await run()
        XCTAssertEqual([unfavourite?.snapshots, unfavourite?.files, synthetic.filesAsked], [1, 0, 3],
                       "an edited photo's favourite changes no file: its render is not asked for again")

        let rendered = ["LIVE/L0/001/IMG_0001.HEIC", "LIVE/L0/001/IMG_0001.MOV", "a render edited again, of other bytes"]
        synthetic.put(live(edited: 40, favourite: false, [Self.still, video, render]), files: rendered.map { .here(Data($0.utf8)) })
        let reedited = await run()
        XCTAssertEqual([reedited?.snapshots, reedited?.files, synthetic.filesAsked], [1, 1, 4],
                       "an edit again writes its render under the same name: it is fetched")
        assertEqual(await pass.state().owed, [])
        try Self.artifact("held-named-again.json", ["availability": String(decoding: more.payload, as: UTF8.self)])
    }


    func testOnlyTheFilesTheHomeLacksAreFetched() async throws {
        let video = PhotoResource(typeRaw: 9, uti: "com.apple.quicktime-movie", originalFilename: "IMG_0001.MOV")
        let synthetic = SyntheticLibrary()
        synthetic.put(PhotoSnapshot(localIdentifier: "LIVE/L0/001", creationDate: Self.day, modificationDate: Self.day,
                                    resources: [Self.still, video]),
                      files: [.inCloud(Data("the still".utf8)), .inCloud(Data("the video".utf8))])
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
        let charging = Device(pastMoves: true, iCloud: true, charging: true, spare: 95_000_000_000, changeRoom: nil)
        let asked = Asks()
        let home = Self.home(asked: asked, wanting: Self.wanting(["LIVE/L0/001"], files: ["pairedVideo"]))
        _ = await pass.run(.init(seconds: 60), device: charging, bringingIn: false, home: home)
        let report = await pass.run(.init(seconds: 60), device: charging, bringingIn: false, home: home)
        XCTAssertEqual(report?.files, 1)
        XCTAssertEqual(synthetic.downloads, 1, "the video alone is downloaded")
        let more = try XCTUnwrap(store.entries.last { $0.kind == .availability })
        let resources = try XCTUnwrap((try JSONSerialization.jsonObject(with: more.payload) as? [String: Any])?["resources"] as? [[String: Any]])
        XCTAssertTrue(resources[0]["blob"] is NSNull, "the still is not read")
        XCTAssertTrue(resources[0]["not_local_reason"] is NSNull, "nor refused")
        XCTAssertEqual((resources[1]["blob"] as? [String: Any])?["hash"] as? String, Wire.sha256(Data("the video".utf8)))
        XCTAssertEqual(resources.map { $0["size"] as? Int }, [9, 9], "each file states its size")
        try Self.artifact("only-the-files-lacked.json", ["downloads": synthetic.downloads, "availability": String(decoding: more.payload, as: UTF8.self)])
    }


    func testAWholeReadUnderFullCountsTheStatedPhotosItDoesNotList() async throws {
        let home = Self.home(asked: Asks(), wanting: Self.wanting([]))
        func pruned(_ store: any PhotoPassStore, access: PhotoAccess) async -> (first: PhotoPass.Report?, then: PhotoPass.Report?) {
            let synthetic = SyntheticLibrary()
            for id in ["A/L0/001", "B/L0/001", "C/L0/001"] { synthetic.put(Self.photo(id)) }
            let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
            let first = await pass.run(.init(seconds: 60), device: Self.wifi, bringingIn: false, home: home)
            synthetic.delete("C/L0/001")
            synthetic.prune()
            if access == .limited { synthetic.allow(.limited, selecting: ["A/L0/001", "B/L0/001"]) }
            return (first, await pass.run(.init(seconds: 60), device: Self.wifi, bringingIn: false, home: home))
        }
        let full = await pruned(MemoryStore(), access: .full)
        XCTAssertEqual(full.first?.paged, true)
        XCTAssertEqual(full.first?.unlisted, 0, "a first read lists every photo it states")
        XCTAssertEqual(full.then?.paged, true)
        XCTAssertEqual(full.then?.unlisted, 1)
        XCTAssertEqual(full.then?.gone, 0, "nothing is stated gone from it")
        let limited = await pruned(MemoryStore(), access: .limited)
        XCTAssertEqual(limited.then?.paged, true)
        XCTAssertNil(limited.then?.unlisted)
        let unindexed = await pruned(UnindexedStore(), access: .full)
        XCTAssertEqual(unindexed.then?.paged, true)
        XCTAssertNil(unindexed.first?.unlisted)
        XCTAssertNil(unindexed.then?.unlisted)
    }


    func testWhileThePastIsHeldBackNoPageNoFileButANewPhotoShips() async throws {
        let synthetic = SyntheticLibrary()
        for index in 0..<3 { synthetic.put(Self.photo("P\(index)/L0/001", at: -Double(index))) }
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
        var phone = Self.wifi
        phone.page = 2
        let asked = Asks()
        let wanted = Self.wanting(["P0/L0/001"])
        _ = await pass.run(.init(seconds: 60), device: phone, bringingIn: false, home: Self.home(asked: asked, wanting: wanted))
        XCTAssertEqual(store.entries.count, 2, "the first page")

        synthetic.put(Self.photo("NEW/L0/001", at: 60))
        let heldBack = await pass.run(.init(seconds: 60), device: phone, bringingIn: false,
                                      home: Self.home(history: false, asked: asked, wanting: wanted))
        XCTAssertEqual(heldBack?.paged, false, "no page of the whole read")
        XCTAssertEqual(heldBack?.heldBack, true, "and says so")
        XCTAssertEqual(heldBack?.done, false, "a pass held back is not done: the home has more to take")
        XCTAssertEqual(heldBack?.snapshots, 1)
        XCTAssertEqual(heldBack?.files, 1, "the photo taken now ships with its file")
        XCTAssertEqual(asked.asks, 0, "no file is asked for")
        assertEqual(await pass.state().mark?.unread, 1)

        let letGo = await pass.run(.init(seconds: 60), device: phone, bringingIn: false, home: Self.home(asked: asked, wanting: wanted))
        XCTAssertEqual(letGo?.paged, true, "let go, the last page")
        let fetched = await pass.run(.init(seconds: 60), device: phone, bringingIn: false, home: Self.home(asked: asked, wanting: wanted))
        XCTAssertEqual(asked.asks, 1)
        XCTAssertEqual(fetched?.files, 1, "and the file the home wants")
        try Self.artifact("past-held-back.json", ["entries": store.entries.map { $0.kind.rawValue }, "asks": asked.asks])
    }


    func testOnALowDiskOrWhileThePastMayNotMoveTheWantedFilesWaitAndTheReportSaysWhy() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.put(Self.photo("P0/L0/001", at: 0))
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
        let asked = Asks()
        let run = { (device: Device) in
            await pass.run(.init(seconds: 60), device: device, bringingIn: true,
                           home: Self.home(asked: asked, wanting: Self.wanting(["P0/L0/001"])))
        }
        _ = await run(Self.wifi)
        let fetchedFirst = asked.asks
        synthetic.put(Self.photo("NEW/L0/001", at: 60))

        var low = Self.wifi
        low.spare = 0
        let full = await run(low)
        XCTAssertEqual(full?.waits, .space)
        XCTAssertEqual(full?.files, 1, "the photo taken now ships with its file")
        XCTAssertEqual(full?.done, false)
        let away = await run(Device(pastMoves: false, iCloud: false, charging: false, spare: Self.wifi.spare))
        XCTAssertEqual(away?.waits, .network)
        XCTAssertEqual(asked.asks, fetchedFirst, "neither asks the home for its wanted files")

        let back = await run(Self.wifi)
        XCTAssertNil(back?.waits)
        XCTAssertEqual(asked.asks, fetchedFirst + 1, "the cause gone, the home is asked again")
        try Self.artifact("waits.json", ["space": full?.waits?.rawValue ?? "", "network": away?.waits?.rawValue ?? "",
                                         "asks": asked.asks])
    }

    func testAFileOnDiskGoesToAHomeOnLoopbackWhileICloudsWaitsForAFreeInternet() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.put(Self.photo("DISK/L0/001"), files: [.here(Data("on disk".utf8))])
        synthetic.put(Self.photo("CLOUD/L0/001"), files: [.inCloud(Data("in iCloud".utf8))])
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: MemoryStore())
        let asked = Asks()
        let run = { (iCloud: Bool, wanted: [String]) in
            await pass.run(.init(seconds: 60),
                           device: Device(pastMoves: true, iCloud: iCloud, charging: true, spare: 95_000_000_000, changeRoom: nil),
                           bringingIn: false, home: Self.home(asked: asked, wanting: Self.wanting(wanted)))
        }
        _ = await run(true, [])
        let hotspot = await run(false, ["DISK/L0/001", "CLOUD/L0/001"])
        XCTAssertEqual(hotspot?.files, 1, "the file on disk crosses no network to a home on loopback")
        XCTAssertEqual(synthetic.downloads, 0, "nothing comes from iCloud while iCloud may not move")
        let free = await run(true, ["CLOUD/L0/001"])
        XCTAssertEqual(free?.files, 1, "a free internet brings iCloud's file")
        XCTAssertEqual(synthetic.downloads, 1)
        XCTAssertNil(free?.waits)
    }

    func testAStoreWithNoRoomEndsThePassWaitingOnSpaceNeverFailing() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.put(Self.photo("NEW/L0/001", at: 0))
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
        let run = { await pass.run(.init(seconds: 60), device: Self.wifi, bringingIn: false, home: Self.home(asked: Asks(), wanting: Self.wanting([]))) }
        store.full = true
        let refused = await run()
        XCTAssertNil(refused?.error)
        XCTAssertEqual(refused?.waits, .space)
        assertNil(await pass.state().failing, "no failure, so no wait before the next pass")
        XCTAssertEqual(store.entries.count, 0)
        store.full = false
        let room = await run()
        XCTAssertNil(room?.waits)
        XCTAssertEqual(store.entries.map(\.kind), [.asset], "the photo the full disk refused, stated once there is room")
    }

    func testTheNextPhotosFilesMustFitTheRoomAboveTheLine() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.put(Self.photo("BIG/L0/001", at: 1), files: [.here(Data(repeating: 0x42, count: 100))])
        synthetic.put(Self.photo("SMALL/L0/001", at: 0), files: [.here(Data(repeating: 0x53, count: 30))])
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
        let asked = Asks()
        var tight = Self.wifi
        tight.changeRoom = nil
        let run = { (device: Device, wanted: [String]) in
            await pass.run(.init(seconds: 60), device: device, bringingIn: false, home: Self.home(asked: asked, wanting: Self.wanting(wanted)))
        }
        _ = await run(tight, [])
        let stated = store.entries.count
        tight.spare = 50

        let big = await run(tight, ["BIG/L0/001"])
        XCTAssertEqual(big?.files, 0, "100 bytes do not fit 50")
        XCTAssertEqual(big?.waits, .space, "and nothing came: the pass waits on space")
        XCTAssertEqual(store.entries.count, stated, "no file of it stored")
        synthetic.statesSizes = false
        let unsized = await run(tight, ["BIG/L0/001"])
        XCTAssertEqual(unsized?.waits, .space, "a file with no stated size is measured, and refused the same")
        XCTAssertEqual(store.entries.count, stated)
        synthetic.statesSizes = true

        let both = await run(tight, ["SMALL/L0/001", "BIG/L0/001"])
        XCTAssertEqual(both?.files, 1, "30 fit; 100 more would not")
        XCTAssertNil(both?.waits, "something came: the pass is not waiting")
        XCTAssertEqual(store.entries.last { $0.kind == .availability }?.replayKey.hasPrefix("photos:SMALL/L0/001:"), true)
        try Self.artifact("next-photo-fits.json", ["big": big?.waits?.rawValue ?? "", "unsized": unsized?.waits?.rawValue ?? "",
                                                    "both": both?.files ?? -1])
    }


    func testOnlyTheNewPhotoThatDoesNotFitGoesWithoutFiles() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.statesSizes = false
        synthetic.put(Self.photo("OLD/L0/001", at: -60))
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
        var phone = Self.wifi
        phone.changeRoom = 100
        let run = { await pass.run(.init(seconds: 60), device: phone, bringingIn: false, home: Self.home(asked: Asks(), wanting: Self.wanting([]))) }
        _ = await run()
        synthetic.put(Self.photo("VIDEO/L0/001", at: 0), files: [.here(Data(repeating: 0x56, count: 1_000))])
        for index in 1...3 {
            synthetic.put(Self.photo("SMALL\(index)/L0/001", at: Double(index)), files: [.here(Data(repeating: 0x53, count: 30))])
        }
        let scratch = Self.scratchFiles()

        let report = await run()
        XCTAssertEqual(report?.snapshots, 4, "four snapshots stated")
        XCTAssertEqual(report?.files, 3, "files for the three small ones")
        XCTAssertEqual(report?.waits, .space)
        let withFiles = store.entries.filter { $0.kind == .availability }.map { String($0.replayKey.split(separator: ":")[1]) }
        XCTAssertEqual(withFiles, ["SMALL1/L0/001", "SMALL2/L0/001", "SMALL3/L0/001"], "none for the video")
        XCTAssertEqual(Self.scratchFiles(), scratch, "no scratch file left")
        try Self.artifact("one-account.json", ["with_files": withFiles, "waits": report?.waits?.rawValue ?? ""])
    }

    func testTheWantedStageFetchesOnlyWhatTheChangedFilesLeft() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.put(Self.photo("WANTED/L0/001", at: -60), files: [.here(Data(repeating: 0x57, count: 50))])
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
        let asked = Asks()
        let run = { (device: Device) in
            await pass.run(.init(seconds: 60), device: device, bringingIn: false,
                           home: Self.home(asked: asked, wanting: Self.wanting(["WANTED/L0/001"])))
        }
        _ = await run(Self.wifi)
        let stated = store.entries.count
        var tight = Self.wifi
        tight.spare = 100
        synthetic.put(Self.photo("NEW/L0/001", at: 0), files: [.here(Data(repeating: 0x4e, count: 60))])

        let report = await run(tight)
        XCTAssertEqual(report?.files, 1, "the photo taken now, with its file")
        XCTAssertEqual(asked.asks, 1, "the home is asked")
        XCTAssertEqual(report?.waits, .space, "50 does not fit the 40 the changed file left")
        XCTAssertEqual(store.entries.count, stated + 2, "the new photo's snapshot and availability, no file of the wanted one")

        var mobile = Device(pastMoves: false, iCloud: false, charging: false, spare: tight.spare)
        mobile.changeRoom = 10
        synthetic.put(Self.photo("LATER/L0/001", at: 1), files: [.here(Data(repeating: 0x4c, count: 60))])
        let away = await run(mobile)
        XCTAssertEqual([away?.snapshots, away?.files], [1, 0], "stated without its file")
        XCTAssertEqual(away?.waits, .space, "the changed stage's wait on space stays")
    }

    private static func scratchFiles() -> Set<String> {
        Set(((try? FileManager.default.contentsOfDirectory(atPath: FileManager.default.temporaryDirectory.path)) ?? [])
            .filter { $0.hasPrefix("photo-") })
    }


    func testAnUpdatedDeviceShipsWhatChangesAndRestatesOnceBeforeAnyFileIsAsked() async throws {
        let synthetic = SyntheticLibrary()
        for index in 0..<4 { synthetic.put(Self.photo("P\(index)/L0/001", at: -Double(index))) }
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
        var phone = Self.wifi
        phone.page = 2
        let asked = Asks()
        let run = { (grant: PhotoPass.Grant, history: Bool) in
            await pass.run(grant, device: phone, bringingIn: false, home: Self.home(history: history, asked: asked, wanting: Self.wanting([])))
        }
        let foreground = PhotoPass.Grant(seconds: 60), wake = PhotoPass.Grant(seconds: 30, background: true)

        synthetic.statesSizes = false
        for _ in 0..<3 { _ = await run(foreground, true) }
        XCTAssertEqual(asked.asks, 1)
        XCTAssertTrue(store.entries.allSatisfy { Self.sizes($0) == [nil] })
        try Self.older(store)

        synthetic.statesSizes = true
        synthetic.delete("P3/L0/001")
        synthetic.put(Self.photo("NEW/L0/001", at: 60))
        let held = await run(wake, false)
        XCTAssertEqual([held?.snapshots, held?.files, held?.gone], [1, 1, 1], "the photo taken now ships with its file")
        XCTAssertEqual(held?.paged, false)
        assertEqual(await pass.state().mark?.owesRestatement, true)
        let woken = await run(wake, true)
        XCTAssertEqual(woken?.paged, false, "a background wake never restates")
        XCTAssertEqual(asked.asks, 1, "and asks for no file while the restatement is owed")

        let restating = await run(foreground, true)
        XCTAssertEqual(restating?.paged, true)
        assertEqual(await pass.state().mark?.restates, true)
        _ = await run(foreground, true)
        XCTAssertEqual(asked.asks, 1, "no file asked for while the restatement is under way")
        let after = await run(foreground, true)
        XCTAssertEqual(after?.snapshots, 0)
        XCTAssertEqual(asked.asks, 2, "restated whole, the home is asked")
        let assets = store.entries.filter { $0.kind == .asset }
        XCTAssertEqual(assets.count, 4 + 1 + 3, "each older photo still in the library gains one version, with its size")
        XCTAssertEqual(assets.suffix(4).map { Self.sizes($0) },
                       ["NEW", "P0", "P1", "P2"].map { [Int64(Data("\($0)/L0/001/IMG_0001.HEIC".utf8).count)] })
        _ = await run(foreground, true)
        XCTAssertEqual(store.entries.filter { $0.kind == .asset }.count, 8, "and never restates again")
        try Self.artifact("sizes-first.json", ["assets": assets.map { String(decoding: $0.payload, as: UTF8.self) }, "asks": asked.asks])
    }

    func testAWholeReadUnderWayAtTheUpdateRestartsOnceAndEveryPhotoGetsItsSize() async throws {
        let synthetic = SyntheticLibrary()
        let ids = (0..<4).map { "P\($0)/L0/001" }
        for (index, id) in ids.enumerated() { synthetic.put(Self.photo(id, at: -Double(index))) }
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
        var mac = Device(pastMoves: true, iCloud: true, charging: true, spare: 95_000_000_000, changeRoom: nil)
        mac.page = 2
        let asked = Asks()
        let run = { await pass.run(.init(seconds: 60), device: mac, bringingIn: false, home: Self.home(asked: asked, wanting: Self.wanting([]))) }
        synthetic.statesSizes = false
        _ = await run()
        XCTAssertEqual(store.entries.count, 2, "an older build's first page, without sizes")
        try Self.older(store)

        synthetic.statesSizes = true
        let restarted = await run()
        XCTAssertEqual(restarted?.snapshots, 2, "the read restarts from the newest photo, which gains its size")
        assertEqual(await pass.state().mark?.unread, 2)
        let ended = await run()
        XCTAssertEqual(ended?.snapshots, 2, "it goes on where it was: it restarted once")
        XCTAssertEqual(asked.asks, 0, "no file asked for while it pages")
        _ = await run()
        XCTAssertEqual(asked.asks, 1, "read whole, the home is asked")
        let newest = Dictionary(store.entries.filter { $0.kind == .asset }.map { ($0.replayKey.split(separator: ":")[1], $0) },
                                uniquingKeysWith: { _, last in last })
        XCTAssertEqual(ids.map { newest[Substring($0)].map(Self.sizes) ?? [] },
                       ids.map { [Int64(Data("\($0)/IMG_0001.HEIC".utf8).count)] as [Int64?] },
                       "every photo's newest snapshot states its size")
        XCTAssertEqual(store.entries.filter { $0.kind == .asset }.count, 2 + 4)
        try Self.artifact("restarted-read.json", ["assets": store.entries.map { String(decoding: $0.payload, as: UTF8.self) },
                                                  "asks": asked.asks])
    }

    private static func older(_ store: MemoryStore) throws {
        var state = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(store.readState())) as? [String: Any])
        var mark = try XCTUnwrap(state["mark"] as? [String: Any])
        mark["sized"] = nil
        state["mark"] = mark
        if var left = state.removeValue(forKey: "wanted_left") as? [String: Any] {
            left["bytes"] = nil
            state["left"] = left
        }
        try store.writeState(JSONSerialization.data(withJSONObject: state))
    }

    private static func photo(_ id: String, at minutes: Double) -> PhotoSnapshot {
        let taken = day.addingTimeInterval(minutes * 60)
        return PhotoSnapshot(localIdentifier: id, creationDate: taken, modificationDate: taken, resources: [still])
    }

    private static func video(_ id: String, at minutes: Double) -> PhotoSnapshot {
        let taken = day.addingTimeInterval(minutes * 60)
        return PhotoSnapshot(localIdentifier: id, mediaTypeRaw: 2, creationDate: taken, modificationDate: taken,
                             resources: [PhotoResource(typeRaw: 2, uti: "com.apple.quicktime-movie", originalFilename: "IMG_0002.MOV")])
    }

    private static func sizes(_ entry: PhotoEntry) -> [Int64?] {
        let object = (try? JSONSerialization.jsonObject(with: entry.payload)) as? [String: Any]
        return ((object?["resources"] as? [[String: Any]]) ?? []).map { ($0["size"] as? NSNumber)?.int64Value }
    }

    private static func artifact(_ name: String, _ object: Any) throws {
        let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent(".build/e2e", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]).write(to: folder.appendingPathComponent(name))
    }
}

final class UnindexedStore: PhotoPassStore, @unchecked Sendable {
    let kept = MemoryStore()
    func written(prefix: String) async throws -> [PhotoEntry] { try await kept.written(prefix: prefix) }
    func append(_ entries: [PhotoEntry]) async throws -> Int { try await kept.append(entries) }
    func store(_ url: URL) async throws -> (hash: String, bytes: UInt64) { try await kept.store(url) }
    func readState() -> Data? { kept.readState() }
    func writeState(_ bytes: Data) throws { try kept.writeState(bytes) }
}

final class Asks: @unchecked Sendable {
    private let lock = NSLock()
    private var made: [[String]] = []
    private var notNamed: Set<String> = []
    private var named: Set<String> = []
    private var held = false
    var asks: Int { lock.withLock { made.count } }
    var owed: [[String]] { lock.withLock { made.filter { !$0.isEmpty } } }
    var unnamed: Set<String> {
        get { lock.withLock { notNamed } }
        set { lock.withLock { notNamed = newValue } }
    }
    var settled: Set<String> {
        get { lock.withLock { named } }
        set { lock.withLock { named = newValue } }
    }
    var paused: Bool {
        get { lock.withLock { held } }
        set { lock.withLock { held = newValue } }
    }
    func count(_ owed: [String] = []) { lock.withLock { made.append(owed) } }
}

final class MemoryStore: PhotoPassStore, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [PhotoEntry] = []
    private var blobs: [String: Data] = [:]
    private var state: Data?
    private var broken = false
    private var noRoom = false
    private var handed: [URL] = []

    var exported: [URL] { lock.withLock { handed } }

    var unreadable: Bool {
        get { lock.withLock { broken } }
        set { lock.withLock { broken = newValue } }
    }

    var full: Bool {
        get { lock.withLock { noRoom } }
        set { lock.withLock { noRoom = newValue } }
    }

    var entries: [PhotoEntry] { lock.withLock { stored } }

    struct Unreadable: Error {}

    func written(prefix: String) async throws -> [PhotoEntry] {
        try lock.withLock {
            if broken { throw Unreadable() }
            return stored.filter { $0.replayKey.hasPrefix(prefix) }
        }
    }

    func append(_ new: [PhotoEntry]) async throws -> Int {
        try lock.withLock {
            if noRoom, !new.isEmpty { throw PhotoStoreFull() }
            var keys = Set(stored.map(\.replayKey))
            let fresh = new.filter { keys.insert($0.replayKey).inserted }
            stored += fresh
            return fresh.count
        }
    }

    func store(_ url: URL) async throws -> (hash: String, bytes: UInt64) {
        if full { throw PhotoStoreFull() }
        lock.withLock { handed.append(url) }
        let data = try Data(contentsOf: url)
        try FileManager.default.removeItem(at: url)
        let hash = Wire.sha256(data)
        lock.withLock { blobs[hash] = data }
        return (hash, UInt64(data.count))
    }

    func readState() -> Data? { lock.withLock { state } }

    func writeState(_ bytes: Data) throws { lock.withLock { state = bytes } }

    func statedLive() async throws -> Set<String>? {
        lock.withLock {
            let keys = Set(stored.map(\.replayKey))
            return Set(stored.filter { $0.kind == .asset && !keys.contains($0.replayKey + ":gone") }.compactMap {
                (try? JSONSerialization.jsonObject(with: $0.payload) as? [String: Any])?["local_identifier"] as? String
            })
        }
    }
}

private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var date: Date
    init(_ date: Date) { self.date = date }
    var now: Date {
        get { lock.withLock { date } }
        set { lock.withLock { date = newValue } }
    }
}

private func assertEqual<T: Equatable>(_ actual: T, _ expected: T, _ message: String = "",
                                       file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(actual, expected, message, file: file, line: line)
}

private func assertNil<T>(_ actual: T?, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertNil(actual, message, file: file, line: line)
}

private func assertNotNil<T>(_ actual: T?, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertNotNil(actual, message, file: file, line: line)
}
