import Evidence
import DeviceFiles
import Foundation
import HomeLink
import XCTest
import zlib
@testable import Shipping

final class ImportsTests: XCTestCase {
    private var root: URL!
    private var downloads: URL!
    private var state: ShippingState!
    private var clock: FixedClock!
    private var home: FakeHome!
    private var link: HomeLink!
    private var ledger: ImportLedger!

    private static let now = ShippingFixture.instant("2026-10-27T10:00:00.000Z")
    private static let lane = "upload:local:unit-0001"
    private static let live = ShippingFixture.machineSource
    private static let spotify = ImportCheck(recognise: ["**/Streaming_History_*.json"])
    private static let takeout = ImportCheck(recognise: ["Takeout/Mail/**/*.mbox", "Takeout/My Activity/**"], root: "Takeout/")
    private static let claude = ImportCheck(recognise: ["**/conversations.json"], leaves: ["**/users.json", "**/login_history.json"])

    override func setUp() async throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("imports-tests-\(UUID().uuidString)")
        downloads = root.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        state = ShippingState(root: root.appendingPathComponent("ship", isDirectory: true), files: DeviceFiles(.plain))
        try state.prepare()
        clock = FixedClock(Self.now)
        home = FakeHome(sources: [Self.lane, Self.live], clock: clock.read)
        link = try await ShippingFixture.link(home, folder: root)
        ledger = .in(state.carriedDirectory, files: DeviceFiles(.plain))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }


    func testAnyFileListsByItsMembers() throws {
        let members = Self.export(["Takeout/Mail/All mail Including Spam and Trash.mbox", "Takeout/My Activity/Search/MyActivity.json"])
        let zip = downloads.appendingPathComponent("renamed.bin")
        try FixtureZip.write(members, to: zip)
        let tgz = downloads.appendingPathComponent("renamed.zip")
        try FixtureTar.writeGzip(members, to: tgz)
        try write(members, under: downloads)
        let folder = downloads.appendingPathComponent("Takeout", isDirectory: true)
        try Data("hidden".utf8).write(to: folder.appendingPathComponent("Mail/.hidden"))
        for (url, form) in [(zip, ImportListing.Form.zip), (tgz, .tgz), (folder, .folder)] {
            let listing = try ImportListing.of(url)
            XCTAssertEqual(listing.form, form, "by its first bytes, never its name")
            XCTAssertEqual(listing.members.sorted(), members.map(\.0).sorted(), "\(form): the same names, hidden ones passed over")
        }
        let loose = downloads.appendingPathComponent("Streaming_History_Audio_2024.json")
        try Data("[]".utf8).write(to: loose)
        let tar = downloads.appendingPathComponent("plain.tar")
        try FixtureTar.plain(members).write(to: tar)
        let gzip = downloads.appendingPathComponent("notes.json.gz")
        var gzipped = Data([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3])
        gzipped.append(try (Data(repeating: 0x41, count: 600) as NSData).compressed(using: .zlib) as Data)
        try gzipped.write(to: gzip)
        for url in [loose, tar, gzip] {
            XCTAssertEqual(try ImportListing.of(url), ImportListing(form: .file, members: [url.lastPathComponent]))
        }
    }

    func testABrokenArchiveDoesNotList() throws {
        let whole = downloads.appendingPathComponent("whole.zip")
        try FixtureZip.write(Self.export(["Takeout/Mail/x.mbox"]), to: whole)
        let broken = downloads.appendingPathComponent("broken.zip")
        let bytes = try Data(contentsOf: whole)
        try bytes.prefix(bytes.count - 30).write(to: broken)
        XCTAssertThrowsError(try ImportListing.of(broken))
        let tgz = downloads.appendingPathComponent("whole.tgz")
        try FixtureTar.writeGzip(Self.export(["Takeout/Mail/x.mbox", "Takeout/Mail/y.mbox"]), to: tgz)
        let cut = downloads.appendingPathComponent("cut.tgz")
        let tarBytes = try Data(contentsOf: tgz)
        try tarBytes.prefix(tarBytes.count * 2 / 3).write(to: cut)
        XCTAssertThrowsError(try ImportListing.of(cut), "a gzipped tar that breaks part way does not list")
        XCTAssertThrowsError(try ImportListing.of(downloads.appendingPathComponent("absent.zip")))
    }

    func testAZip64FieldOutOfBoundsDoesNotOpen() throws {
        let whole = downloads.appendingPathComponent("whole.zip")
        try FixtureZip.write(Self.export(["Takeout/Mail/x.mbox"]), to: whole)
        let bytes = try Data(contentsOf: whole)
        let end = bytes.count - 22
        func listed(_ change: (inout Data) -> Void) throws -> ImportListing {
            var changed = bytes
            change(&changed)
            let url = downloads.appendingPathComponent("changed-\(UUID().uuidString).zip")
            try changed.write(to: url)
            return try ImportListing.of(url)
        }
        XCTAssertNoThrow(try listed { _ in })
        XCTAssertThrowsError(try listed { $0.set16(end + 10, 0x7fff) })
        XCTAssertThrowsError(try listed { $0.set32(end + 16, 0x7fff_fff0) })
        for offset in [UInt64(1) << 40, UInt64.max] {
            XCTAssertThrowsError(try listed { data in
                data.set32(end + 16, 0xffff_ffff)
                var locator = Data()
                locator.put32(0x0706_4b50); locator.put32(0); locator.put64(offset); locator.put32(1)
                data.insert(contentsOf: locator, at: end)
            })
        }
        let directory = Int(bytes.le32(end + 16))
        for extra in [Data([1, 0, 0xff, 0]), Data([1, 0, 0, 0])] {
            XCTAssertThrowsError(try listed { data in
                data.set32(directory + 20, 0xffff_ffff)
                data.set16(directory + 30, UInt16(extra.count))
                let nameLength = Int(data.le16(directory + 28))
                data.insert(contentsOf: extra, at: directory + 46 + nameLength)
                data.set32(data.count - 22 + 12, data.le32(data.count - 22 + 12) + UInt32(extra.count))
            })
        }
    }


    func testTheMatcherAgreesWithConnectsTable() throws {
        let table = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("packages/connect/test/patterns.json")
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: table)) as? [String: Any])
        let rows = try XCTUnwrap(object["rows"] as? [[String: Any]])
        XCTAssertGreaterThan(rows.count, 20)
        for row in rows {
            let pattern = try XCTUnwrap(row["pattern"] as? String), path = try XCTUnwrap(row["path"] as? String)
            XCTAssertEqual(MemberPattern.matches(pattern, path), try XCTUnwrap(row["matches"] as? Bool), "\(pattern) against \(path)")
        }
    }

    func testACheckSaysWhatAFileIs() throws {
        func check(_ url: URL, _ kind: ImportCheck, most: Int64 = ImportFiles.doorMost) throws -> ImportLedger.Record {
            let record = try XCTUnwrap(try ledger.handOver([url], kind: "kind").first)
            try ledger.check(record, against: kind, most: most)
            return try XCTUnwrap(try ledger.read().files.first { $0.id == record.id })
        }
        func said(_ record: ImportLedger.Record) -> String { [record.state.rawValue, record.why?.rawValue].compactMap { $0 }.joined(separator: " ") }
        let spotify = downloads.appendingPathComponent("my_spotify_data.zip")
        try FixtureZip.write(Self.export(["Spotify Extended Streaming History/Streaming_History_Audio_2024.json"]), to: spotify)
        XCTAssertEqual(said(try check(spotify, Self.spotify)), "waiting turn")
        let loose = downloads.appendingPathComponent("Streaming_History_Audio_2025.json")
        try Data("[]".utf8).write(to: loose)
        XCTAssertEqual(said(try check(loose, Self.spotify)), "waiting turn", "a loose file of the export is the export")
        XCTAssertEqual(try ledger.handOver([spotify], kind: "kind"), [], "the same path for its kind again: already owed, left as it is")
        let other = downloads.appendingPathComponent("photos.zip")
        try FixtureZip.write(Self.export(["DCIM/IMG_0001.jpg"]), to: other)
        XCTAssertEqual(said(try check(other, Self.spotify)), "refused not-this-kind")
        XCTAssertEqual(said(try check(other, Self.takeout)), "refused not-this-kind", "nothing under the root")
        let drive = downloads.appendingPathComponent("takeout-drive.tgz")
        try FixtureTar.writeGzip(Self.export(["Takeout/Drive/notes.pdf", "Takeout/archive_browser.html"]), to: drive)
        XCTAssertEqual(said(try check(drive, Self.takeout)), "refused nothing-read", "a Takeout of nothing read is not sent")
        let mixed = downloads.appendingPathComponent("takeout-mixed.zip")
        try FixtureZip.write(Self.export(["Takeout/Drive/notes.pdf", "Takeout/Mail/All mail.mbox"]), to: mixed)
        XCTAssertEqual(said(try check(mixed, Self.takeout)), "waiting turn", "read and unread products: sent")
        let light = downloads.appendingPathComponent("light_metadata-000.zip")
        try FixtureZip.write(Self.export(["users.json", "login_history.json"]), to: light)
        XCTAssertEqual(said(try check(light, Self.claude)), "refused nothing-read", "only what the kind leaves: not sent")
        let full = downloads.appendingPathComponent("data-000.zip")
        try FixtureZip.write(Self.export(["users.json", "conversations.json"]), to: full)
        XCTAssertEqual(said(try check(full, Self.claude)), "waiting turn", "what it reads beside what it leaves: sent")
        XCTAssertEqual(said(try check(other, Self.claude)), "refused not-this-kind", "neither: not this kind")
        let damaged = downloads.appendingPathComponent("damaged.zip")
        try Data([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]).write(to: damaged)
        XCTAssertEqual(said(try check(damaged, Self.spotify)), "refused damaged")
        let large = downloads.appendingPathComponent("Streaming_History_Video_2024.json")
        try Data(count: 2048).write(to: large)
        XCTAssertEqual(said(try check(large, Self.spotify, most: 1024)), "refused too-large")
        let gone = downloads.appendingPathComponent("Streaming_History_Audio_2023.json")
        try Data("[]".utf8).write(to: gone)
        let record = try XCTUnwrap(try ledger.handOver([gone], kind: "spotify").first)
        try FileManager.default.removeItem(at: gone)
        try ledger.check(record, against: Self.spotify, most: ImportFiles.doorMost)
        XCTAssertEqual(try ledger.read().files.last.map(said), "missing")
    }

    func testTheLedgerKeepsEachHandOver() throws {
        let first = try file("Streaming_History_Audio_2024.json", bytes: 64)
        let wrong = try file("notes.txt", bytes: 64)
        let handed = try ledger.handOver([first, wrong], kind: "spotify")
        XCTAssertEqual(handed.map(\.state), [.checking, .checking], "recorded before anything else")
        XCTAssertEqual(try ledger.read().files.map { [$0.id, $0.path, $0.kind, $0.state.rawValue] },
                       handed.map { [$0.id, $0.path, $0.kind, $0.state.rawValue] })
        XCTAssertNotEqual(handed[0].id, handed[1].id)
        XCTAssertFalse(handed[0].id.contains("Streaming"), "an opaque id, never the file's name")
        let text = try String(contentsOf: ledger.file, encoding: .utf8)
        XCTAssertTrue(text.hasSuffix("}\n"))
        for record in handed { try ledger.check(record, against: Self.spotify, most: ImportFiles.doorMost) }
        XCTAssertEqual(try ledger.read().files.map(\.state), [.waiting, .refused])
        let again = try ledger.handOver([first, wrong], kind: "spotify")
        XCTAssertEqual(again.map(\.id), [handed[1].id])
        XCTAssertEqual(try ledger.read().files.map(\.state), [.waiting, .checking])
        try ledger.check(again[0], against: Self.spotify, most: ImportFiles.doorMost)
        XCTAssertFalse(try ledger.forget(handed[0].id))
        XCTAssertTrue(try ledger.forget(handed[1].id))
        XCTAssertEqual(try ledger.read().files.map(\.id), [handed[0].id])
        try ledger.change { $0.files[0].state = .missing }
        let moved = downloads.appendingPathComponent("moved", isDirectory: true)
        try FileManager.default.createDirectory(at: moved, withIntermediateDirectories: true)
        let there = moved.appendingPathComponent(first.lastPathComponent)
        try FileManager.default.moveItem(at: first, to: there)
        let chosen = try XCTUnwrap(try ledger.again(handed[0].id, at: there))
        XCTAssertEqual([chosen.id, chosen.path, chosen.state.rawValue], [handed[0].id, there.path, "checking"])
        XCTAssertNil(try ledger.again(handed[0].id, at: there), "only a missing file is chosen again")
        try ledger.change { $0.files[0].state = .already }
        try ledger.launch()
        XCTAssertEqual(try ledger.read().files, [])
        let blocked = ImportLedger(file: root.appendingPathComponent("not-a-folder/imports.json"), files: DeviceFiles(.plain))
        try Data().write(to: root.appendingPathComponent("not-a-folder"))
        XCTAssertThrowsError(try blocked.handOver([there], kind: "spotify")) { error in
            XCTAssertEqual(error as? ImportLedgerError, .unwritable("imports.json"))
        }
    }


    func testOneFileABundleAfterLiveAndTheNextAtOnce() async throws {
        let first = try file("Streaming_History_Audio_2024.json", bytes: 4096)
        let second = try file("Streaming_History_Audio_2025.json", bytes: 2048)
        try handOver([first, second])
        let liveDomain = FakeDomain(sourceId: Self.live, name: "machine_events", seals: [.sealed(), .nothingNew])
        let shipper = makeShipper(live: liveDomain)
        _ = await shipper.run(.timer)
        XCTAssertEqual(home.deliveries.map(\.source), [Self.live, Self.lane], "the file goes after the live bundle")
        let sent = try XCTUnwrap(home.deliveries.last)
        XCTAssertEqual(sent.members.keys.sorted(), ["files/" + first.lastPathComponent, "manifest.json", "upload.json"])
        XCTAssertEqual(sent.members["files/" + first.lastPathComponent], try Data(contentsOf: first))
        XCTAssertEqual(sent.facts["import"] as? [String: String], ["kind": "spotify"])
        XCTAssertEqual(sent.facts["history"] as? Bool, true)
        XCTAssertEqual(Set(sent.facts.keys).subtracting(["blobs_carried"]), ["import", "history"], "no id, account, time or source")
        let manifest = try XCTUnwrap(try JSONSerialization.jsonObject(with: sent.members["manifest.json"]!) as? [String: Any])
        XCTAssertEqual(manifest["feeder"] as? String, "import-mac")
        XCTAssertEqual(try ledger.read().files.map(\.state), [.sent, .waiting])
        XCTAssertEqual(try ledger.read().files.first?.sha256, Self.sha256(try Data(contentsOf: first)))
        let next = await shipper.nextRun(after: Self.now)
        XCTAssertEqual(next, Self.now)
        clock.move(by: 1)
        _ = await shipper.run(.timer)
        XCTAssertEqual(home.deliveries.count, 3)
        XCTAssertEqual(home.deliveries.last?.members["files/" + second.lastPathComponent], try Data(contentsOf: second))
        XCTAssertEqual(home.custody(Self.lane).received, 2)
        let records = try ledger.read().files
        XCTAssertEqual(records.map(\.seal), [1, 2])
        XCTAssertEqual(records.map(\.state), [.sent, .sent])
        XCTAssertFalse(makeShipping().owes)
        home.importAll()
        clock.move(by: 400)
        _ = await shipper.run(.manual)
        XCTAssertEqual(try [first, second].map { try Data(contentsOf: $0).count }, [4096, 2048])
        try ShippingFixture.artifact("imports.json", home.deliveries.map { delivery -> [String: Any] in
            ["source": delivery.source, "seal": delivery.seal as Any, "members": delivery.members.keys.sorted(),
             "facts": delivery.facts.filter { $0.key != "blobs_carried" }]
        })
    }

    func testTheSameBytesForAnotherKindGoAgain() async throws {
        let first = try file("Streaming_History_Audio_2024.json", bytes: 1024, seed: 7)
        try handOver([first])
        try handOver([first], kind: "other", check: ImportCheck(recognise: ["*.json"]))
        let shipper = makeShipper()
        _ = await shipper.run(.timer)
        clock.move(by: 1)
        _ = await shipper.run(.timer)
        XCTAssertEqual(home.deliveries.map { ($0.facts["import"] as? [String: String])?["kind"] }, ["spotify", "other"],
                       "the home admits a file once a kind: the lane never decides it holds them")
        XCTAssertEqual(try ledger.read().files.map(\.state), [.sent, .sent])
    }

    func testARestoreSendsAgainWhatTheHomeLost() async throws {
        let first = try file("Streaming_History_Audio_2024.json", bytes: 1024, seed: 1)
        try handOver([first])
        let shipper = makeShipper()
        _ = await shipper.run(.timer)
        XCTAssertEqual(try ledger.read().files.map(\.state), [.sent])
        let lost = try XCTUnwrap(home.deliveries.first?.id)
        home.restore(Self.lane, received: 0, imported: 0)
        XCTAssertEqual(home.deliveries.count, 0, "the restore forgot it")
        clock.move(by: 400)
        _ = await shipper.run(.manual)
        XCTAssertEqual(home.deliveries.map(\.seal), [1], "the home lost it: it goes again, at the seal after what it holds")
        XCTAssertNotEqual(home.deliveries.first?.id, lost)
        XCTAssertEqual(home.custody(Self.lane).received, 1)
        XCTAssertEqual(home.deliveries.last?.members["files/" + first.lastPathComponent], try Data(contentsOf: first))
        XCTAssertEqual(try ledger.read().files.map(\.state), [.sent])
    }

    func testEachWaitIsItsFilesOwn() async throws {
        let large = downloads.appendingPathComponent("Streaming_History_Audio_2020.json")
        FileManager.default.createFile(atPath: large.path, contents: Data("[".utf8))
        let handle = try FileHandle(forWritingTo: large)
        try handle.truncate(atOffset: UInt64(ImportRoom.batteryBytes + 1))
        try handle.close()
        let small = try file("Streaming_History_Audio_2024.json", bytes: 1024)
        try handOver([large, small])
        let power = Toggle(false), macFree = Counter<Int64?>(1 << 40), homeFree = Counter<Int64?>(nil)
        let room = ImportRoom(onPower: { power.value }, disk: disk { macFree.value }, homeFree: { homeFree.value })
        let shipper = makeShipper(room: room)
        _ = await shipper.run(.timer)
        XCTAssertEqual(home.deliveries.map { $0.members.keys.filter { $0.hasPrefix("files/") } }, [["files/" + small.lastPathComponent]])
        XCTAssertEqual(try waits(), ["waiting battery", "sent"])
        XCTAssertFalse(makeShipping(room: room).owes, "a wait is no turn")
        power.value = true
        macFree.value = nil
        clock.move(by: 400)
        _ = await shipper.run(.manual)
        XCTAssertEqual(try waits(), ["waiting mac-room", "sent"], "an unknown disk waits")
        macFree.value = 1 << 40
        homeFree.value = Room.keepBytes + 2 * (ImportRoom.batteryBytes + 1) - 1
        clock.move(by: 400)
        _ = await shipper.run(.manual)
        XCTAssertEqual(try waits(), ["waiting home-room", "sent"])
        XCTAssertEqual(home.deliveries.count, 1)
        XCTAssertEqual(home.deliveries.first?.kind, "later", "its upload states it later")
    }

    func testAFileMovedBeforeItWasSentIsMissingAndTheRestGo() async throws {
        let first = try file("Streaming_History_Audio_2023.json", bytes: 1024, seed: 3)
        let second = try file("Streaming_History_Audio_2024.json", bytes: 1024, seed: 4)
        try handOver([first, second])
        let moved = root.appendingPathComponent("Elsewhere", isDirectory: true)
        try FileManager.default.createDirectory(at: moved, withIntermediateDirectories: true)
        let there = moved.appendingPathComponent(first.lastPathComponent)
        try FileManager.default.moveItem(at: first, to: there)
        let shipper = makeShipper()
        _ = await shipper.run(.timer)
        XCTAssertEqual(home.deliveries.count, 1)
        XCTAssertNotNil(home.deliveries[0].members["files/" + second.lastPathComponent])
        XCTAssertEqual(try ledger.read().files.map(\.state), [.missing, .sent])
        let id = try XCTUnwrap(try ledger.read().files.first?.id)
        let chosen = try XCTUnwrap(try ledger.again(id, at: there))
        try ledger.check(chosen, against: Self.spotify, most: ImportFiles.doorMost)
        clock.move(by: 400)
        _ = await shipper.run(.manual)
        XCTAssertEqual(home.deliveries.count, 2)
        XCTAssertEqual(try ledger.read().files.map(\.state), [.sent, .sent])
    }

    func testTheMacStaysAwakeWhileAFileSends() async throws {
        let first = try file("Streaming_History_Audio_2024.json", bytes: 1024)
        try handOver([first])
        let events = Collected<String>()
        home.gate = { events.append("request") }
        let liveDomain = FakeDomain(sourceId: Self.live, name: "machine_events", seals: [.sealed()])
        let shipper = makeShipper(live: liveDomain, keepAwake: {
            events.append("hold")
            return { events.append("release") }
        })
        _ = await shipper.run(.timer)
        XCTAssertEqual(events.all, ["request", "request", "hold", "request", "request", "release"],
                       "held around the file's turn alone (the home asked of it, then its send): not the exchange's nor the live bundle's")
    }

    func testAPendingFileGoesAfterLiveAndOnBattery() async throws {
        let first = try file("Streaming_History_Audio_2024.json", bytes: 1024)
        try handOver([first])
        home.refuse(Self.lane, (503, "NOT_NOW"))
        let power = Toggle(true)
        let liveDomain = FakeDomain(sourceId: Self.live, name: "machine_events", seals: [.nothingNew, .sealed()])
        let shipper = makeShipper(live: liveDomain, room: ImportRoom(onPower: { power.value }, disk: disk { 1 << 40 }, homeFree: { nil }))
        _ = await shipper.run(.timer)
        XCTAssertTrue(home.deliveries.isEmpty)
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.kind), ["import"])
        XCTAssertEqual(try ledger.read().files.map(\.state), [.sending])
        home.refuse(Self.lane, nil)
        power.value = false
        clock.move(by: 400)
        let run = await shipper.run(.manual)
        XCTAssertEqual(home.deliveries.map(\.source), [Self.live, Self.lane], "after this run's live bundle; a small file on battery goes")
        XCTAssertFalse(run.rows.contains { $0.summary == "held ON_BATTERY" })
        XCTAssertEqual(try ledger.read().files.map(\.state), [.sent])
    }

    func testAPendingFileOverTheBatteryLineStaysPendingOnBatteryAndIsNeverSent() async throws {
        try handOver([try file("Streaming_History_Audio_2024.json", bytes: 1024)])
        home.refuse(Self.lane, (503, "NOT_NOW"))
        let power = Toggle(true)
        let shipper = makeShipper(live: FakeDomain(sourceId: Self.live, name: "machine_events", seals: [.nothingNew]),
                                  room: ImportRoom(onPower: { power.value }, disk: disk { 1 << 40 }, homeFree: { nil }))
        _ = await shipper.run(.timer)
        let pending = try XCTUnwrap(try state.pendingBundles().first)
        XCTAssertEqual(pending.sidecar.kind, "import")
        let grown = try FileHandle(forWritingTo: pending.file)
        try grown.truncate(atOffset: UInt64(ImportRoom.batteryBytes + 1))
        try grown.close()
        let puts = home.requests.filter { $0.method == "PUT" }.count

        power.value = false
        clock.move(by: 400)
        let run = await shipper.run(.manual)
        XCTAssertTrue(run.rows.contains { $0.summary == "held ON_BATTERY" }, run.rows.map(\.summary).description)
        XCTAssertEqual(home.requests.filter { $0.method == "PUT" }.count, puts, "a file over the line is not sent on battery")
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.kind), ["import"], "it stays pending for the power")
    }

    func testAFolderShipsWholeBesideTheDropFolder() async throws {
        try write(Self.export(["Takeout/Mail/x.mbox", "Takeout/Keep/note.json"]), under: downloads)
        let folder = downloads.appendingPathComponent("Takeout", isDirectory: true)
        try handOver([folder], kind: "google-takeout", check: Self.takeout)
        let drop = root.appendingPathComponent("Lifestream Drop", isDirectory: true)
        try FileManager.default.createDirectory(at: drop, withIntermediateDirectories: true)
        let dropped = drop.appendingPathComponent("notes.txt")
        try Data("a dropped file\n".utf8).write(to: dropped)
        try FileManager.default.setAttributes([.modificationDate: Self.now.addingTimeInterval(-3600)], ofItemAtPath: dropped.path)
        let shipper = makeShipper(drop: drop)
        _ = await shipper.run(.timer)
        XCTAssertEqual(home.deliveries.map(\.seal), [1, 2])
        XCTAssertNotNil(home.deliveries[0].members["files/notes.txt"])
        let sent = home.deliveries[1]
        XCTAssertEqual(sent.members.keys.filter { $0.hasPrefix("files/") }.sorted(),
                       ["files/Takeout/Keep/note.json", "files/Takeout/Mail/x.mbox"])
        XCTAssertEqual(sent.facts["import"] as? [String: String], ["kind": "google-takeout"])
        XCTAssertNotEqual(home.deliveries[0].id, sent.id)
        let digest = ImportFiles.folderHash([("Takeout/Keep/note.json", Self.sha256(sent.members["files/Takeout/Keep/note.json"]!)),
                                             ("Takeout/Mail/x.mbox", Self.sha256(sent.members["files/Takeout/Mail/x.mbox"]!))])
        XCTAssertEqual(try ledger.read().files.first?.sha256, digest)
    }

    func testTheDropFolderAndAFileNeverTakeTheSameRoom() async throws {
        let first = try file("Streaming_History_Audio_2024.json", bytes: 1024)
        try handOver([first])
        let drop = root.appendingPathComponent("Lifestream Drop", isDirectory: true)
        try FileManager.default.createDirectory(at: drop, withIntermediateDirectories: true)
        let dropped = drop.appendingPathComponent("notes.bin")
        try Data((0..<1024).map { UInt8(truncatingIfNeeded: $0 &* 7) }).write(to: dropped)
        try FileManager.default.setAttributes([.modificationDate: Self.now.addingTimeInterval(-3600)], ofItemAtPath: dropped.path)
        let work = state.workDirectory
        let base = Room.keepBytes + 1024 + 100
        let shipper = makeShipper(room: ImportRoom(onPower: { true }, disk: disk { base - Self.bytes(under: work) }, homeFree: { nil }), drop: drop)
        _ = await shipper.run(.timer)
        XCTAssertEqual(home.deliveries.map { $0.members.keys.filter { $0.hasPrefix("files/") }.sorted() }, [["files/notes.bin"]],
                       "the dropped file went; the handed-over file did not go beside it")
        XCTAssertEqual(try waits(), ["waiting mac-room"], "the file waits for room here, judged after the drop folder's copy")
    }

    func testTheOldArchiveBundlesAreRetired() async throws {
        let pass = "p-00000001"
        try state.ledgers.ledger(HashEntry.self, pass: pass, source: Self.lane).record(HashEntry(mark: nil, hashes: ["old"]), at: 1)
        var old: [URL] = []
        for (seal, folder) in [(1, state.pendingDirectory), (2, state.workDirectory)] {
            let bundle = folder.appendingPathComponent("old-\(seal).zip")
            try Data("an archive's bundle".utf8).write(to: bundle)
            try state.writeSidecar(SealedBundle(file: bundle, sidecar: BundleSidecar(id: "old-\(seal)", sourceId: Self.lane, pass: pass, seal: seal,
                                                                                      kind: "archive", write: .later, refused: nil)))
            old.append(bundle)
        }
        let archives = state.carriedDirectory.appendingPathComponent("archives.json")
        try FileManager.default.createDirectory(at: state.carriedDirectory, withIntermediateDirectories: true)
        try Data("{\"files\":[]}\n".utf8).write(to: archives)
        let first = try file("Streaming_History_Audio_2024.json", bytes: 1024)
        try handOver([first])
        _ = await makeShipper().run(.timer)
        XCTAssertEqual(old.map { FileManager.default.fileExists(atPath: $0.path) }, [false, false], "spent, never sent")
        XCTAssertFalse(FileManager.default.fileExists(atPath: archives.path))
        XCTAssertEqual(home.deliveries.map(\.seal), [1], "the lane's next seal starts again at the home's received + 1")
        XCTAssertEqual(home.deliveries.first?.members["files/" + first.lastPathComponent], try Data(contentsOf: first))
        XCTAssertEqual(try state.ledgers.ledger(HashEntry.self, pass: pass, source: Self.lane).held(through: 9).map(\.entry.hashes),
                       [[Self.sha256(try Data(contentsOf: first))]], "the unreceived tail replaced")
    }

    func testARestoreNeverTakesAFileGoneForOneResealed() async throws {
        let first = try file("Streaming_History_Audio_2023.json", bytes: 1024, seed: 3)
        let second = try file("Streaming_History_Audio_2024.json", bytes: 1024, seed: 4)
        try handOver([first, second])
        let shipper = makeShipper()
        _ = await shipper.run(.timer)
        clock.move(by: 1)
        _ = await shipper.run(.timer)
        XCTAssertEqual(try ledger.read().files.map(\.seal), [1, 2])
        home.restore(Self.lane, received: 0, imported: 0)
        let elsewhere = root.appendingPathComponent("Elsewhere", isDirectory: true)
        try FileManager.default.createDirectory(at: elsewhere, withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: first, to: elsewhere.appendingPathComponent(first.lastPathComponent))
        clock.move(by: 400)
        _ = await shipper.run(.manual)
        XCTAssertEqual(home.deliveries.map(\.seal), [1], "the second goes again, at the seal the first once had")
        XCTAssertNotNil(home.deliveries.first?.members["files/" + second.lastPathComponent])
        var records = try ledger.read().files
        XCTAssertEqual(records.map(\.state), [.missing, .sent], "the home holds seal 1 again: the second's, never the first's")
        XCTAssertEqual(records.map(\.seal), [nil, 1])
        XCTAssertEqual(records.map(\.pass), [nil, records[1].pass])
        clock.move(by: 400)
        _ = await shipper.run(.manual)
        records = try ledger.read().files
        XCTAssertEqual(records.map(\.state), [.missing, .sent], "nor at any later answer")
    }

    func testARestoreClearsEverySealBeforeAFileIsChosenAheadInTheLedger() async throws {
        try await restoreWhileAFileWaits(waitingFirst: true)
    }

    func testARestoreClearsEverySealBeforeAFileIsChosenBehindInTheLedger() async throws {
        try await restoreWhileAFileWaits(waitingFirst: false)
    }

    private func restoreWhileAFileWaits(waitingFirst: Bool) async throws {
        let waiting = try file("Streaming_History_Audio_2023.json", bytes: 4096, seed: 5)
        let going = try file("Streaming_History_Audio_2024.json", bytes: 1024, seed: 6)
        try handOver(waitingFirst ? [waiting, going] : [going, waiting])
        let homeFree = Counter<Int64?>(Room.keepBytes + 2 * 2048)
        let room = ImportRoom(onPower: { true }, disk: disk { 1 << 40 }, homeFree: { homeFree.value })
        let shipper = makeShipper(room: room)
        _ = await shipper.run(.timer)
        XCTAssertEqual(home.deliveries.map(\.seal), [1])
        XCTAssertNotNil(home.deliveries.first?.members["files/" + going.lastPathComponent])
        home.restore(Self.lane, received: 0, imported: 0)
        homeFree.value = nil
        clock.move(by: 400)
        _ = await shipper.run(.manual)
        clock.move(by: 1)
        _ = await shipper.run(.timer)
        XCTAssertEqual(home.deliveries.map(\.seal), [1, 2], "both go again, each at its own seal")
        XCTAssertEqual(Set(home.deliveries.flatMap { $0.members.keys.filter { $0.hasPrefix("files/") } }),
                       ["files/" + waiting.lastPathComponent, "files/" + going.lastPathComponent],
                       "the file that went before the restore is never taken for the one sealed in its place")
        let records = try ledger.read().files
        XCTAssertEqual(records.map(\.state), [.sent, .sent])
        XCTAssertEqual(Set(records.compactMap(\.seal)), [1, 2])
    }

    func testARestoreNeverTakesAFileGoneForTheDropFoldersBundle() async throws {
        let first = try file("Streaming_History_Audio_2023.json", bytes: 1024, seed: 7)
        try handOver([first])
        let drop = root.appendingPathComponent("Lifestream Drop", isDirectory: true)
        try FileManager.default.createDirectory(at: drop, withIntermediateDirectories: true)
        let shipper = makeShipper(drop: drop)
        _ = await shipper.run(.timer)
        XCTAssertEqual(try ledger.read().files.map(\.seal), [1])
        home.restore(Self.lane, received: 0, imported: 0)
        let elsewhere = root.appendingPathComponent("Elsewhere", isDirectory: true)
        try FileManager.default.createDirectory(at: elsewhere, withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: first, to: elsewhere.appendingPathComponent(first.lastPathComponent))
        let dropped = drop.appendingPathComponent("notes.txt")
        try Data("a dropped file\n".utf8).write(to: dropped)
        try FileManager.default.setAttributes([.modificationDate: Self.now.addingTimeInterval(-3600)], ofItemAtPath: dropped.path)
        clock.move(by: 400)
        _ = await shipper.run(.manual)
        XCTAssertEqual(home.deliveries.map(\.seal), [1])
        XCTAssertNotNil(home.deliveries.first?.members["files/notes.txt"])
        XCTAssertEqual(try ledger.read().files.map(\.state), [.missing], "seal 1 is the dropped file's, never the file gone")
        XCTAssertEqual(try ledger.read().files.map(\.seal), [nil])
    }

    func testAFileTheHomeTookIsAlreadyInAndNothingIsSent() async throws {
        let shipper = makeShipper()
        let unknown = try file("Streaming_History_Audio_2022.json", bytes: 512, seed: 2)
        try handOver([unknown])
        _ = await shipper.run(.timer)
        XCTAssertEqual(home.deliveries.count, 1)
        XCTAssertEqual(try ledger.read().files.map(\.state), [.sent])
        XCTAssertEqual(home.importsAsked, [["spotify/\(Self.sha256(try Data(contentsOf: unknown)))"]])
        let first = try file("Streaming_History_Audio_2023.json", bytes: 1024, seed: 5)
        let second = try file("Streaming_History_Audio_2024.json", bytes: 1024, seed: 6)
        try handOver([first, second])
        let took = Self.sha256(try Data(contentsOf: first))
        home.admitted = ["spotify/\(took)"]
        clock.move(by: 1)
        _ = await shipper.run(.timer)
        XCTAssertEqual(home.deliveries.dropFirst().map { $0.members.keys.filter { $0.hasPrefix("files/") } }, [["files/" + second.lastPathComponent]],
                       "the file the home took is not copied or sent; the next goes in the same seal")
        let records = try ledger.read().files
        XCTAssertEqual(records.map(\.state), [.sent, .already, .sent])
        XCTAssertEqual(records.map(\.sha256), [Self.sha256(try Data(contentsOf: unknown)), took, Self.sha256(try Data(contentsOf: second))])
        XCTAssertEqual(records.map(\.seal), [1, nil, 2])
        XCTAssertEqual(home.importsAsked.dropFirst().flatMap { $0 }, ["spotify/\(took)", "spotify/\(Self.sha256(try Data(contentsOf: second)))"],
                       "asked by its kind and the digest the home admits by, before the copy")
        let refused = try file("Streaming_History_Audio_2021.json", bytes: 256, seed: 7)
        try handOver([refused])
        home.refusedWhole = ["spotify/\(Self.sha256(try Data(contentsOf: refused)))"]
        clock.move(by: 1)
        _ = await shipper.run(.timer)
        XCTAssertEqual(try ledger.read().files.map(\.state), [.sent, .already, .sent, .sent], "refused whole before: copied and sent")
        XCTAssertNotNil(home.deliveries.last?.members["files/" + refused.lastPathComponent])
        let letGo = try file("Streaming_History_Audio_2020.json", bytes: 128, seed: 8)
        try handOver([letGo])
        home.letGo = ["spotify/\(Self.sha256(try Data(contentsOf: letGo)))"]
        clock.move(by: 1)
        _ = await shipper.run(.timer)
        XCTAssertEqual(try ledger.read().files.map(\.state), [.sent, .already, .sent, .sent, .sent], "let go before: copied and sent")
        XCTAssertNotNil(home.deliveries.last?.members["files/" + letGo.lastPathComponent])
        try write(Self.export(["Takeout/Mail/x.mbox", "Takeout/Keep/note.json"]), under: downloads)
        let folder = downloads.appendingPathComponent("Takeout", isDirectory: true)
        try handOver([folder], kind: "google-takeout", check: Self.takeout)
        clock.move(by: 1)
        let run = await shipper.run(.timer)
        XCTAssertEqual(try waits(), ["sent", "already", "sent", "sent", "sent", "sent"], "\(run.rows.map(\.summary))")
        let sent = try XCTUnwrap(home.deliveries.last)
        let members = try ["Takeout/Keep/note.json", "Takeout/Mail/x.mbox"].map { ($0, Self.sha256(try XCTUnwrap(sent.members["files/" + $0], $0))) }
        let digest = ImportFiles.folderHash(members)
        XCTAssertEqual(home.importsAsked.last, ["google-takeout/\(digest)"])
        XCTAssertEqual(try ledger.read().files.last?.sha256, digest)
    }

    func testTheBytesSentAreToldAtMostOnceASecondAndAMegabyte() async throws {
        let gateClock = FixedClock(Self.now)
        let passed = Collected<Int64>()
        let gate = SentGate(clock: gateClock.read, moved: { passed.append($0) })
        gate.heard(500_000)
        gate.heard(1_500_000)
        gateClock.move(by: 0.5)
        gate.heard(3_000_000)
        gateClock.move(by: 1.5)
        gate.heard(2_000_000)
        gate.heard(2_600_000)
        XCTAssertEqual(passed.all, [1_500_000, 2_600_000], "under a megabyte, then under a second, then under a megabyte again")

        let first = try file("Streaming_History_Audio_2024.json", bytes: 3 << 20, seed: 9)
        try handOver([first])
        let sent = Collected<String>(), writes = Collected<Bool>()
        let told = ImportTold(changed: { writes.append(true) }, sent: { id, bytes in sent.append("\(id) \(bytes)") })
        _ = await makeShipper(told: told).run(.timer)
        let id = try XCTUnwrap(try ledger.read().files.first?.id)
        XCTAssertEqual(sent.all.count, 2, "the clock stood still: one megabyte's word, never one a chunk, then the whole")
        XCTAssertEqual(sent.all.first?.hasPrefix(id + " "), true)
        let last = try XCTUnwrap(sent.all.last?.split(separator: " ").last.flatMap { Int64($0) })
        XCTAssertGreaterThanOrEqual(last, 3 << 20, "the upload's end is told: the window never stops at a word the gate held back")
        XCTAssertGreaterThanOrEqual(writes.all.count, 2, "sending, then sent: each told as it is written")
        XCTAssertEqual(try ledger.read().files.map(\.state), [.sent])
    }


    private func waits() throws -> [String] {
        try ledger.read().files.map { [$0.state.rawValue, $0.why?.rawValue].compactMap { $0 }.joined(separator: " ") }
    }

    private static func bytes(under folder: URL) -> Int64 {
        let walk = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.fileSizeKey])
        var total: Int64 = 0
        while let url = walk?.nextObject() as? URL {
            total += Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
        return total
    }

    private static func sha256(_ data: Data) -> String {
        var digest = StreamDigest()
        digest.update(data)
        return digest.hex()
    }

    private func disk(_ free: @escaping @Sendable () -> Int64?) -> Volume {
        Volume(root, every: 0, read: { _ in free() })
    }

    private func makeShipping(room: ImportRoom? = nil) -> ImportShipping {
        ImportShipping(sourceId: Self.lane, ledger: ledger, ledgers: state.ledgers,
                       room: room ?? ImportRoom(onPower: { true }, disk: disk { 1 << 40 }, homeFree: { nil }))
    }

    private func makeShipper(live: FakeDomain? = nil, room given: ImportRoom? = nil, told: ImportTold = .nobody,
                             drop: URL? = nil, keepAwake: @escaping @Sendable () -> @Sendable () -> Void = { {} }) -> Shipper {
        let ledgers = state.ledgers, carried = state.carriedDirectory, hashes = state.hashCacheDirectory
        let lane = Self.lane
        let room = given ?? ImportRoom(onPower: { true }, disk: disk { 1 << 40 }, homeFree: { nil })
        return Shipper(Shipper.Dependencies(
            state: state, link: link, settings: MacSettings(file: DomainFixtures.settingsFile, files: DeviceFiles(.plain)),
            domains: { sources in
                sources.compactMap { source -> (any ShippingDomain)? in
                    if source == lane {
                        let folder = drop.map { UploadDomain(sourceId: lane, folder: $0, hashCache: hashes.appendingPathComponent("upload.json"),
                                                             ledgers: ledgers, disk: room.disk) }
                        return UploadLane(sourceId: lane, folder: folder,
                                          imports: ImportShipping(sourceId: lane, ledger: .in(carried, files: DeviceFiles(.plain), written: told.changed), ledgers: ledgers,
                                                                  room: room, told: told))
                    }
                    return source == live?.sourceId ? live : nil
                }
            },
            clock: clock.read, record: { _ in }, keepAwake: keepAwake, scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true)))
    }

    private func file(_ name: String, bytes: Int, seed: UInt8 = 0) throws -> URL {
        let url = downloads.appendingPathComponent(name)
        try Data((0..<bytes).map { UInt8(truncatingIfNeeded: $0 &+ Int(seed) &* 31) }).write(to: url)
        return url
    }

    private func handOver(_ files: [URL], kind: String = "spotify", check: ImportCheck = ImportsTests.spotify) throws {
        for record in try ledger.handOver(files, kind: kind) { try ledger.check(record, against: check, most: ImportFiles.doorMost) }
    }

    private func write(_ members: [(String, Data, Bool)], under folder: URL) throws {
        for (name, data, _) in members {
            let target = folder.appendingPathComponent(name)
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: target)
            try FileManager.default.setAttributes([.modificationDate: Self.now.addingTimeInterval(-3600)], ofItemAtPath: target.path)
        }
    }

    static func export(_ names: [String]) -> [(String, Data, Bool)] {
        names.map { ($0, Data("synthetic \($0)\n".utf8), true) }
    }
}

final class Toggle: @unchecked Sendable {
    private let lock = NSLock()
    private var held: Bool
    init(_ value: Bool) { held = value }
    var value: Bool {
        get { lock.withLock { held } }
        set { lock.withLock { held = newValue } }
    }
}

final class Counter<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var held: Value
    init(_ value: Value) { held = value }
    var value: Value {
        get { lock.withLock { held } }
        set { lock.withLock { held = newValue } }
    }
}

enum FixtureZip {
    static func write(_ members: [(String, Data, Bool)], to url: URL) throws {
        var out = Data()
        var directory = Data()
        for (name, data, deflate) in members {
            let stored = deflate ? (try (data as NSData).compressed(using: .zlib) as Data) : data
            let crc = data.withUnsafeBytes { UInt32(crc32(0, $0.bindMemory(to: Bytef.self).baseAddress, uInt(data.count))) }
            let offset = out.count
            let nameBytes = Data(name.utf8)
            out.put32(0x0403_4b50); out.put16(20); out.put16(0); out.put16(deflate ? 8 : 0); out.put16(0); out.put16(0)
            out.put32(crc); out.put32(UInt32(stored.count)); out.put32(UInt32(data.count)); out.put16(UInt16(nameBytes.count)); out.put16(0)
            out.append(nameBytes)
            out.append(stored)
            directory.put32(0x0201_4b50); directory.put16(20); directory.put16(20); directory.put16(0); directory.put16(deflate ? 8 : 0)
            directory.put16(0); directory.put16(0); directory.put32(crc); directory.put32(UInt32(stored.count)); directory.put32(UInt32(data.count))
            directory.put16(UInt16(nameBytes.count)); directory.put16(0); directory.put16(0); directory.put16(0); directory.put16(0)
            directory.put32(0); directory.put32(UInt32(offset))
            directory.append(nameBytes)
        }
        let start = out.count
        out.append(directory)
        out.put32(0x0605_4b50); out.put16(0); out.put16(0); out.put16(UInt16(members.count)); out.put16(UInt16(members.count))
        out.put32(UInt32(directory.count)); out.put32(UInt32(start)); out.put16(0)
        try out.write(to: url)
    }
}

enum FixtureTar {
    static func writeGzip(_ members: [(String, Data, Bool)], to url: URL) throws {
        let tar = plain(members)
        let deflated = try (tar as NSData).compressed(using: .zlib) as Data
        var gzip = Data([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3])
        gzip.append(deflated)
        let crc = tar.withUnsafeBytes { UInt32(crc32(0, $0.bindMemory(to: Bytef.self).baseAddress, uInt(tar.count))) }
        gzip.put32(crc)
        gzip.put32(UInt32(truncatingIfNeeded: tar.count))
        try gzip.write(to: url)
    }

    static func plain(_ members: [(String, Data, Bool)]) -> Data {
        var tar = Data()
        for (name, data, _) in members {
            var header = Data(count: 512)
            func put(_ text: String, at offset: Int, width: Int) {
                let bytes = Array(text.utf8.prefix(width))
                header.replaceSubrange(offset..<(offset + bytes.count), with: bytes)
            }
            put(name, at: 0, width: 100)
            put("0000644\0", at: 100, width: 8)
            put("0000000\0", at: 108, width: 8)
            put("0000000\0", at: 116, width: 8)
            put(String(format: "%011o\0", data.count), at: 124, width: 12)
            put(String(format: "%011o\0", 1_800_000_000), at: 136, width: 12)
            put("        ", at: 148, width: 8)
            put("0", at: 156, width: 1)
            put("ustar\0", at: 257, width: 6)
            put("00", at: 263, width: 2)
            let sum = header.reduce(0) { $0 + Int($1) }
            put(String(format: "%06o\0 ", sum), at: 148, width: 8)
            tar.append(header)
            tar.append(data)
            tar.append(Data(count: (512 - data.count % 512) % 512))
        }
        tar.append(Data(count: 1024))
        return tar
    }
}

private extension Data {
    mutating func put16(_ value: UInt16) { append(contentsOf: Swift.withUnsafeBytes(of: value.littleEndian, Array.init)) }
    mutating func put32(_ value: UInt32) { append(contentsOf: Swift.withUnsafeBytes(of: value.littleEndian, Array.init)) }
    mutating func put64(_ value: UInt64) { append(contentsOf: Swift.withUnsafeBytes(of: value.littleEndian, Array.init)) }
    mutating func set16(_ at: Int, _ value: UInt16) { replaceSubrange(at..<(at + 2), with: Swift.withUnsafeBytes(of: value.littleEndian, Array.init)) }
    mutating func set32(_ at: Int, _ value: UInt32) { replaceSubrange(at..<(at + 4), with: Swift.withUnsafeBytes(of: value.littleEndian, Array.init)) }
}
