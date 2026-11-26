import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

final class CustodyTests: XCTestCase {
    private static let location = "location:local:\(FakeHome.unit)"
    private static let voice = "voice-notes:local:\(FakeHome.unit)"
    private static let photos = "apple-photos:\(FakeHome.account):\(FakeHome.unit)"
    private static let name = "https://lifestream.example.ts.net"

    private var root: URL!
    private var clock: TestClock!
    private var home: FakeHome!
    private var store: CaptureStore!
    private var custody: PhoneCustody!
    private var link: HomeLink!
    private var second = 0

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("lifestream-custody-\(UUID().uuidString)")
        clock = TestClock(Date(timeIntervalSince1970: 1_791_000_000))
        let clock = self.clock!
        home = FakeHome(clock: { clock.now })
        store = try await CaptureStore.restored(root: root.appendingPathComponent("capture"))
        custody = PhoneCustody(exporter: CaptureExporter(store: store, exportsDirectory: root.appendingPathComponent("exports")))
        link = phoneLink()
        _ = try await link.pair(code: FakeHome.code, name: Self.name, account: FakeHome.account)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    private let credentials = MemoryCredentials()

    private func phoneLink(version: String = "1.0.0") -> HomeLink {
        let clock = self.clock!
        return HomeLink(device: .init(kind: .phone, version: version, model: "iPhone", serial4: nil), credentials: credentials,
                        folder: root.appendingPathComponent("exports"), transport: home, clock: { clock.now })
    }


    func testARestoreReshipsWhatLaterSealsCarriedBlobsIncluded() async throws {
        try await capture(.location, 3)
        let note = try await capture(.voice, blob: "first note")
        try await shipAll()
        try await capture(.location, 2)
        let later = try await capture(.voice, blob: "second note")
        try await shipAll()
        try await capture(.location, 1)
        try await shipAll()
        XCTAssertEqual(home.custody(Self.location).received, 3)
        XCTAssertEqual(home.custody(Self.voice).received, 2)
        XCTAssertEqual(home.deliveries.compactMap { $0.ranges["location.jsonl"] }, [[1, 3], [4, 5], [6, 6]])

        home.restore(to: [Self.location: .init(received: 1, imported: 1), Self.voice: .init(received: 1, imported: 1)])
        let answer = try await link.exchange()
        try await custody.applied(answer)
        let resealed = try await custody.seal(answer, hardware: .synthetic, appVersion: "1.0.0", now: clock.now).bundles
        XCTAssertEqual(resealed.map(\.seals), [[Self.location: 2], [Self.voice: 2]],
                       "each source seals the next after what the home now holds, the one naming a file alone")
        for pending in resealed { _ = try await link.deliver(pending, of: custody) }
        let location = try XCTUnwrap(home.deliveries.last { $0.seals[Self.location] != nil })
        let reshipped = try XCTUnwrap(home.deliveries.last { $0.seals[Self.voice] != nil })
        XCTAssertEqual(location.ranges["location.jsonl"], [4, 6], "what seals 2 and 3 carried, carried again")
        XCTAssertEqual(reshipped.ranges["voice.jsonl"], [2, 2])
        XCTAssertEqual(reshipped.blobs, [later], "the rolled-back seal's file travels again")
        XCTAssertFalse(reshipped.blobs.contains(note), "what the home still holds does not")
        XCTAssertEqual(home.custody(Self.location).received, 2)
        try report("restore", ["deliveries": home.deliveries.map(Self.describe)])
    }


    func testAStalePendingBundleIsResealedFromTheAnswer() async throws {
        try await capture(.location, 2)
        try await shipAll()
        try await capture(.location, 2)
        var answer = try await link.exchange()
        try await custody.applied(answer)
        let pending = try await sealed(answer)
        XCTAssertEqual(pending.seals, [Self.location: 2])

        home.restore(to: [:])
        do {
            _ = try await link.deliver(pending, of: custody)
            XCTFail("a seal that is not the next is refused")
        } catch LinkFailure.stale(let fresh) {
            answer = fresh
        }
        let fate = try await custody.applied(answer)
        XCTAssertEqual(fate.map(\.fate), [.stale])
        let gone = try await custody.pending()
        XCTAssertEqual(gone, [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: custody.file(pending).path), "the stale file goes with it")
        let resealed = try await sealed(answer)
        XCTAssertEqual(resealed.seals, [Self.location: 1])
        _ = try await link.deliver(resealed, of: custody)
        XCTAssertEqual(home.deliveries.map { $0.ranges["location.jsonl"] }, [[1, 4]], "the whole history, from the home's 0")
        try report("stale", ["deliveries": home.deliveries.map(Self.describe)])
    }


    func testAHeldBundleIsNeverResealed() async throws {
        try await capture(.location, 1)
        let answer = try await link.exchange()
        let ahead = try await sealed(answer, now: clock.now.addingTimeInterval(3_600))
        do {
            _ = try await link.deliver(ahead, of: custody)
            XCTFail("held")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .clockAhead)
        }
        try await capture(.location, 1)
        let again = try await link.exchange()
        let fate = try await custody.applied(again)
        XCTAssertEqual(fate.map(\.fate), [.waiting])
        let kept = try await custody.pending()
        XCTAssertEqual(kept.map(\.id), [ahead.id])
        let over = try await custody.seal(again, hardware: .synthetic, appVersion: "1.0.0")
        XCTAssertEqual(over.bundles, [], "a source with a bundle in flight seals nothing over it")

        home.raiseFloor(to: "2.0.0")
        let floored = try await link.exchange().home.floors["phone"]
        XCTAssertEqual(floored, "2.0.0")
        do {
            _ = try await link.deliver(ahead, of: custody)
            XCTFail("too old")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .tooOld(floor: "2.0.0"))
        }
        home.raiseFloor(to: "0.1.0")

        clock.advance(3_600)
        _ = try await link.exchange()
        _ = try await link.deliver(ahead, of: custody)
        XCTAssertEqual(home.deliveries.map(\.id), [ahead.id])
        try report("held", ["deliveries": home.deliveries.map(Self.describe)])
    }


    func testAPhotoFloorAboveTheRestoredReceivedShipsTheRowsAndStatesTheCopiesLost() async throws {
        let first = try await capture(.photos, blob: "photo one")
        let second = try await capture(.photos, blob: "photo two")
        try await shipAll()
        home.importAll()
        var answer = try await link.exchange()
        try await custody.applied(answer)
        try await custody.clearImportedPhotos(answer)
        var floor = try await store.photoExportFloor()
        XCTAssertEqual(floor, 2, "the copies an imported seal carried are cleared")
        let third = try await capture(.photos, blob: "photo three")
        try await shipAll()

        home.restore(to: [:])
        answer = try await link.exchange()
        try await custody.applied(answer)
        try await custody.clearImportedPhotos(answer)
        floor = try await store.photoExportFloor()
        XCTAssertEqual(floor, 2, "a restored home's lower imported clears nothing")
        for pending in try await custody.seal(answer, hardware: .synthetic, appVersion: "1.0.0", now: clock.now).bundles {
            _ = try await link.deliver(pending, of: custody)
        }
        let reshipped = try XCTUnwrap(home.deliveries.last { $0.seals[Self.photos] != nil })
        XCTAssertEqual(reshipped.ranges["photos.jsonl"], [1, 3], "every row, the cleared ones too")
        XCTAssertEqual(reshipped.lost[Self.photos], [Lost(items: 2, what: CaptureExporter.clearedPhotoCopies)])
        XCTAssertEqual(reshipped.blobs, [third])
        XCTAssertFalse(reshipped.blobs.contains(first) || reshipped.blobs.contains(second))
        try report("photo-floor", ["deliveries": home.deliveries.map(Self.describe), "floor": floor])
    }

    func testPhotosClearOnlyThroughWhatAnImportedSealCarried() async throws {
        let first = try await capture(.photos, blob: "photo one")
        try await shipAll()
        let second = try await capture(.photos, blob: "photo two")
        try await shipAll()
        var answer = try await link.exchange()
        try await custody.clearImportedPhotos(answer)
        var held = Set(try await store.validatedBlobInventory().map(\.hash))
        XCTAssertEqual(held, [first, second])

        home.importAll()
        home.restore(to: [Self.photos: .init(received: 2, imported: 1)])
        answer = try await link.exchange()
        try await custody.clearImportedPhotos(answer)
        held = Set(try await store.validatedBlobInventory().map(\.hash))
        XCTAssertEqual(held, [second], "the second copy waits for the seal that carried it")

        home.silence()
        let relaunched = phoneLink()
        XCTAssertEqual(relaunched.saved?.sources[Self.photos]?.imported, 1)
        do { _ = try await relaunched.exchange(); XCTFail("silent") } catch LinkFailure.noAnswer {}
        held = Set(try await store.validatedBlobInventory().map(\.hash))
        XCTAssertEqual(held, [second])
    }

    func testASavedAnswerCannotBePassedToWhatDeletes() throws {
        let control = try typecheck("""
            func clear(_ custody: PhoneCustody, _ link: HomeLink) async throws {
                try await custody.clearImportedPhotos(try await link.exchange())
            }
            """)
        XCTAssertEqual(control.status, 0, control.output)
        for call in ["custody.clearImportedPhotos(link.saved!)", "custody.applied(link.saved!)"] {
            let result = try typecheck("""
                func clear(_ custody: PhoneCustody, _ link: HomeLink) async throws {
                    _ = try await \(call)
                }
                """)
            XCTAssertNotEqual(result.status, 0, call)
            XCTAssertTrue(result.output.contains("cannot convert value of type 'SavedAnswer'"), result.output)
        }
    }


    func testAPhonePairedWithItsAppleIDSealsEveryDomainAndClearsItsPhotos() async throws {
        let answer = try await link.exchange()
        XCTAssertEqual(Set(answer.sources.keys), Set(FakeHome.sources(account: FakeHome.account)))
        XCTAssertEqual(answer.sources.count, CaptureDomain.allCases.count)
        var blobs: [CaptureDomain: String] = [:]
        for domain in CaptureDomain.allCases {
            blobs[domain] = try await capture(domain, blob: [.photos, .voice].contains(domain) ? "\(domain) bytes" : nil)
        }
        try await shipAll()

        let deliveries = home.deliveries
        let seals = deliveries.reduce(into: [String: Int]()) { $0.merge($1.seals) { _, new in new } }
        XCTAssertEqual(deliveries.map(\.seals.count).reduce(0, +), CaptureDomain.allCases.count, "one seal per domain")
        XCTAssertEqual(Set(seals.keys), Set(answer.sources.keys))
        XCTAssertEqual(deliveries.count, 3, "the photo and the voice note each seal alone, every other source together")
        for source in ["apple-health:\(FakeHome.account):cloud", "apple-contacts:\(FakeHome.account):\(FakeHome.unit)", Self.photos] {
            XCTAssertEqual(seals[source], 1, source)
        }
        XCTAssertEqual(deliveries.reduce(Set<String>()) { $0.union($1.blobs) }, [blobs[.photos]!, blobs[.voice]!])

        home.importAll()
        let imported = try await link.exchange()
        try await custody.applied(imported)
        try await custody.clearImportedPhotos(imported)
        let held = Set(try await store.validatedBlobInventory().map(\.hash))
        XCTAssertEqual(held, [blobs[.voice]!], "the photo copy goes once its seal is imported; the voice note stays")
        let floor = try await store.photoExportFloor()
        XCTAssertEqual(floor, 1)
        try report("apple-id", ["deliveries": home.deliveries.map(Self.describe), "floor": floor])
    }


    func testATurnedOffSourceShipsNothingAndANewPassStartsAgain() async throws {
        let clock = self.clock!
        home = FakeHome(sources: FakeHome.sources.filter { $0 != Self.voice }, clock: { clock.now })
        link = phoneLink()
        _ = try await link.pair(code: FakeHome.code, name: Self.name, account: FakeHome.account)
        try await capture(.location, 1)
        try await capture(.voice, blob: "note")
        let answer = try await link.exchange()
        let pending = try await sealed(answer)
        XCTAssertEqual(pending.seals, [Self.location: 1], "voice is off: no file, no seal")
        XCTAssertNil(try StoredZIPWriter.readManifest(from: custody.file(pending)).files["voice.jsonl"])
        _ = try await link.deliver(pending, of: custody)
        let fate = try await custody.applied(try await link.exchange())
        XCTAssertEqual(fate.map(\.fate), [.delivered])

        _ = try await link.pair(code: FakeHome.code, name: Self.name, account: FakeHome.account)
        let repaired = try await link.exchange()
        XCTAssertEqual(repaired.pass, "p-0002")
        try await custody.applied(repaired)
        let next = try await sealed(repaired)
        XCTAssertEqual(next.seals, [Self.location: 1])
        let carried = try await store.carried(pass: "p-0001", source: Self.location, through: 1)
        XCTAssertEqual(carried, 0, "the old pass's ledger is gone")
    }


    func testAGoneNamingAClearedCopyShipsWithEverySourceAndAGoneBeforeTheClearClearsItsCopy() async throws {
        let first = try await photo("resource_availability", "a", blob: "photo one")
        let second = try await photo("resource_availability", "b", blob: "photo two")
        try await shipAll()
        home.importAll()
        try await photo("gone", "b", blob: "photo two")
        let imported = try await link.exchange()
        try await custody.applied(imported)
        try await custody.clearImportedPhotos(imported)
        let held = Set(try await store.validatedBlobInventory().map(\.hash))
        XCTAssertFalse(held.contains(second), "a gone carries no file, so it keeps no copy")
        XCTAssertFalse(held.contains(first))
        try await photo("gone", "a", blob: "photo one")
        try await capture(.location, 2)
        try await capture(.motion)
        let answer = try await link.exchange()
        try await custody.applied(answer)
        let sealed = try await custody.seal(answer, hardware: .synthetic, appVersion: "1.0.0", now: clock.now)
        XCTAssertEqual(sealed.satOut, [:], "nothing sits out")
        let pending = try XCTUnwrap(sealed.bundles.first)
        _ = try await link.deliver(pending, of: custody)
        let delivery = try XCTUnwrap(home.deliveries.last)
        XCTAssertEqual(Set(delivery.seals.keys), [Self.photos, Self.location, "motion:local:\(FakeHome.unit)"], "every source ships")
        XCTAssertEqual(delivery.kinds["photos.jsonl"], ["gone", "gone"])
        XCTAssertNil(delivery.lost[Self.photos], "a gone states nothing lost")
        XCTAssertTrue(delivery.blobs.isEmpty)
        try report("gone-after-clear", ["deliveries": home.deliveries.map(Self.describe), "held": held.count])
    }

    func testANoteFileRemovedByHandShipsTheNoteAndStatesItLost() async throws {
        let notes = "notes:local:\(FakeHome.unit)"
        let attachment = try await capture(.notes, blob: "an attachment")
        try await capture(.location)
        let held = try await store.blobFile(forTaggedHash: attachment)
        let file = try XCTUnwrap(held)
        try FileManager.default.removeItem(at: file)
        try await shipAll()
        let delivery = try XCTUnwrap(home.deliveries.last)
        XCTAssertEqual(delivery.seals, [notes: 1, Self.location: 1], "the note ships, and every other source with it")
        XCTAssertEqual(delivery.lost[notes], [Lost(items: 1, what: CaptureExporter.missingFiles)])
        XCTAssertEqual(delivery.blobs, [], "the file it no longer holds is not carried")
        try report("note-file-lost", ["deliveries": home.deliveries.map(Self.describe)])
    }

    func testAPhotosSliceThatThrowsSitsOutAndEveryOtherSourceShips() async throws {
        try await capture(.location, 2)
        try await photo("asset", "a")
        let database = try SQLiteDatabase(url: store.databaseURL)
        let line = try await store.jsonl(.photos).dropLast()
        let broken = String(decoding: line, as: UTF8.self).replacingOccurrences(of: "Z\",\"payload", with: "+01:00\",\"payload")
        XCTAssertNotEqual(broken, String(decoding: line, as: UTF8.self))
        try database.run("UPDATE photos SET line = ? WHERE sequence = 1", .blob(Data(broken.utf8)))
        var answer = try await link.exchange()
        let sealed = try await custody.seal(answer, hardware: .synthetic, appVersion: "1.0.0", now: clock.now)
        XCTAssertEqual(Array(sealed.satOut.keys), [Self.photos])
        let pending = try XCTUnwrap(sealed.bundles.first)
        XCTAssertEqual(pending.seals, [Self.location: 1], "location ships; photos spends no seal")
        let manifest = try StoredZIPWriter.readManifest(from: custody.file(pending))
        XCTAssertEqual(manifest.satOut, [Self.photos], "the bundle says Photos sat out")
        XCTAssertNil(manifest.files["photos.jsonl"])
        _ = try await link.deliver(pending, of: custody)
        XCTAssertEqual(home.deliveries.last?.satOut, [Self.photos])
        let carried = try await store.carried(pass: answer.pass, source: Self.photos, through: 1)
        XCTAssertEqual(carried, 0, "the ledger of a source that sat out is untouched")

        try database.run("UPDATE photos SET line = ? WHERE sequence = 1", .blob(Data(line)))
        answer = try await link.exchange()
        try await custody.applied(answer)
        let next = try await custody.seal(answer, hardware: .synthetic, appVersion: "1.0.0", now: clock.now)
        XCTAssertEqual(next.satOut, [:])
        XCTAssertEqual(next.bundles.map(\.seals), [[Self.photos: 1]])
        let again = try StoredZIPWriter.readManifest(from: custody.file(try XCTUnwrap(next.bundles.first)))
        XCTAssertNil(again.satOut, "none sat out: no member, and the id hashes as before")
        try report("photos-sat-out", ["deliveries": home.deliveries.map(Self.describe), "sat_out": sealed.satOut])
    }

    func testASourceThePhoneStatesFailingSitsOutOfEveryBundleThatDoesNotSealIt() async throws {
        try await capture(.location, 2)
        var answer = try await link.exchange()
        let first = try await custody.seal(answer, failing: [Self.photos, "apple-photos:person-b@example.com:\(FakeHome.unit)"],
                                           hardware: .synthetic, appVersion: "1.0.0", now: clock.now)
        XCTAssertEqual(first.satOut, [:], "no seal failed")
        let pending = try XCTUnwrap(first.bundles.first)
        XCTAssertEqual(pending.seals, [Self.location: 1])
        XCTAssertEqual(try StoredZIPWriter.readManifest(from: custody.file(pending)).satOut, [Self.photos])
        try await custody.applied(try await link.deliver(pending, of: custody))
        XCTAssertEqual(home.deliveries.last?.satOut, [Self.photos], "the door takes it")

        try await photo("asset", "a")
        try await capture(.location)
        answer = try await link.exchange()
        let next = try await custody.seal(answer, failing: [Self.photos], hardware: .synthetic, appVersion: "1.0.0", now: clock.now)
        let sealed = try XCTUnwrap(next.bundles.first)
        XCTAssertEqual(sealed.seals, [Self.location: 2, Self.photos: 1])
        XCTAssertNil(try StoredZIPWriter.readManifest(from: custody.file(sealed)).satOut)
        try await custody.applied(try await link.deliver(sealed, of: custody))
        XCTAssertEqual(home.deliveries.last?.satOut, [])
        try report("failing-sat-out", ["deliveries": home.deliveries.map(Self.describe)])
    }


    func testALargeSourceIsSealedWholeAndAloneAndEachBundleNamesWhatTheOtherCarries() async throws {
        try await capture(.location, 3)
        try await capture(.motion, 2)
        let large = try await capture(.photos, blob: String(repeating: "p", count: 9_000_000))
        var answer = try await link.exchange()
        let first = try await custody.seal(answer, hardware: .synthetic, appVersion: "1.0.0", now: clock.now)
        XCTAssertEqual(first.bundles.map(\.seals), [[Self.location: 1, "motion:local:\(FakeHome.unit)": 1], [Self.photos: 1]],
                       "location and the small sources share; the source naming a file goes alone, after")
        XCTAssertEqual(first.bundles[1].files, [PendingBundle.File(name: large, bytes: 9_000_000)])
        let shared = first.bundles[0], photos = first.bundles[1]
        let size = try FileManager.default.attributesOfItem(atPath: custody.file(shared).path)[.size] as? NSNumber
        XCTAssertLessThan(try XCTUnwrap(size).uint64Value, CaptureExporter.sharedBytes)
        XCTAssertEqual(try StoredZIPWriter.readManifest(from: custody.file(shared)).satOut, [Self.photos])
        XCTAssertEqual(try StoredZIPWriter.readManifest(from: custody.file(photos)).satOut?.contains(Self.location), true)
        XCTAssertEqual(try StoredZIPWriter.readManifest(from: custody.file(photos)).files["photos.jsonl"]?.lastSequence, 1)

        answer = try await link.deliver(shared, of: custody)
        let judged = try await custody.applied(answer)
        XCTAssertEqual(judged.map(\.fate), [.delivered, .waiting])
        try await capture(.location, 1)
        let next = try await custody.seal(answer, hardware: .synthetic, appVersion: "1.0.0", now: clock.now)
        XCTAssertEqual(next.bundles.map(\.seals), [[Self.location: 2]])
        XCTAssertEqual(try StoredZIPWriter.readManifest(from: custody.file(next.bundles[0])).satOut, [Self.photos])
        answer = try await link.deliver(photos, of: custody)
        try await custody.applied(answer)
        XCTAssertEqual(home.deliveries.last?.blobs, [large])
        XCTAssertEqual(home.custody(Self.photos).received, 1)
        try report("by-size", ["deliveries": home.deliveries.map(Self.describe)])
    }

    func testWhatDoesNotFitBesideLocationTravelsTogetherEachArchiveUnderTheBound() async throws {
        try await capture(.location, 2)
        try await capture(.motion, 2)
        try await padded(.health, 4_200_000)
        try await padded(.usage, 4_000_000)
        let sealed = try await custody.seal(try await link.exchange(), hardware: .synthetic, appVersion: "1.0.0", now: clock.now)
        let motion = "motion:local:\(FakeHome.unit)", health = "apple-health:\(FakeHome.account):cloud"
        XCTAssertEqual(sealed.bundles.map(\.seals), [[Self.location: 1, motion: 1, health: 1], ["screen-time:local:\(FakeHome.unit)": 1]],
                       "location first in the first; what is left shares a bundle, none alone that need not be")
        for bundle in sealed.bundles {
            let size = try FileManager.default.attributesOfItem(atPath: custody.file(bundle).path)[.size] as? NSNumber
            XCTAssertLessThan(try XCTUnwrap(size).uint64Value, CaptureExporter.sharedBytes, "the archive, as sent, is under the bound")
        }
        try report("leftovers", ["deliveries": sealed.bundles.map(\.seals)])
    }


    func testAFileTheHomeHoldsIsNamedNotCarriedAndWeighsNothingInItsBundle() async throws {
        try await capture(.location, 2)
        let large = String(repeating: "p", count: 9_000_000)
        home.holding([Data(large.utf8)])
        let photo = try await capture(.photos, blob: large)
        let note = try await capture(.voice, blob: "a note the home lacks")
        let answer = try await link.exchange()
        let named = try await custody.named(try XCTUnwrap(link.saved))
        XCTAssertEqual(named, [photo, note], "the home is asked of every file the unsent entries name")
        let held = try await link.held(blobs: named)
        XCTAssertEqual(held, [photo])
        let sealed = try await custody.seal(answer, held: held, hardware: .synthetic, appVersion: "1.0.0", now: clock.now)
        XCTAssertEqual(sealed.bundles.map(\.seals), [[Self.location: 1, Self.photos: 1], [Self.voice: 1]],
                       "the 9 MB file the home holds weighs nothing: Photos travels beside location; the note it lacks goes alone")
        XCTAssertEqual(sealed.bundles.map(\.files.count), [0, 1])
        let bundle = sealed.bundles[0]
        let manifest = try StoredZIPWriter.readManifest(from: custody.file(bundle))
        XCTAssertNil(manifest.custody[Self.photos]?.lost, "a file the home holds is never stated lost")
        let size = try FileManager.default.attributesOfItem(atPath: custody.file(bundle).path)[.size] as? NSNumber
        XCTAssertLessThan(try XCTUnwrap(size).uint64Value, 100_000)

        try await custody.applied(try await link.deliver(bundle, of: custody))
        XCTAssertEqual(home.deliveries.last?.blobs, [], "the door took it, the held file named and not sent")
        XCTAssertEqual(home.custody(Self.photos).received, 1)
        try await custody.applied(try await link.deliver(sealed.bundles[1], of: custody))
        XCTAssertEqual(home.deliveries.last?.blobs, [note])
        XCTAssertEqual(home.fileSends.map(\.name), [note], "only the file the home lacked was sent")
        try report("held", ["deliveries": home.deliveries.map(Self.describe)])
    }

    func testABundleWhoseRequestWasCutOffWaitsForAnAnswerToItsOwnID() async throws {
        try await capture(.location, 2)
        try await shipAll()
        try await capture(.location, 1)
        let answer = try await link.exchange()
        let cut = try await sealed(answer)
        XCTAssertEqual(cut.seals, [Self.location: 2])
        try await custody.requesting(cut, at: clock.now)
        home.restore(to: [:])
        let other = try await link.exchange()
        var judged = try await custody.applied(other)
        XCTAssertEqual(judged.map(\.fate), [.unsettled], "the door may still be reading it")
        let kept = try await custody.pending()
        XCTAssertEqual(kept.map(\.id), [cut.id])
        XCTAssertTrue(FileManager.default.fileExists(atPath: custody.file(cut).path))

        do {
            _ = try await link.deliver(cut, of: custody)
            XCTFail("stale")
        } catch LinkFailure.stale(let fresh) {
            try await custody.heard(cut, .stale, code: "STALE", at: clock.now)
            judged = try await custody.applied(fresh)
        }
        XCTAssertEqual(judged.map(\.fate), [.stale])
        let gone = try await custody.pending()
        XCTAssertEqual(gone, [])
        let resealed = try await sealed(try await link.exchange())
        XCTAssertEqual(resealed.seals, [Self.location: 1], "its sources seal again from the home's word")
        try report("cut-off", ["deliveries": home.deliveries.map(Self.describe)])
    }


    func testASealOfOneStreamCarriesItAloneAndSpeaksForNoOtherSource() async throws {
        try await capture(.location, 2)
        let note = try await capture(.voice, blob: "a note")
        var answer = try await link.exchange()
        let sealed = try await custody.seal(answer, only: [Self.voice], hardware: .synthetic, appVersion: "1.0.0", now: clock.now)
        XCTAssertEqual(sealed.bundles.map(\.seals), [[Self.voice: 1]], "Voice notes alone, location's entries left")
        let others = Set(PhoneCustody.sources(answer.sources).values).subtracting([Self.voice])
        XCTAssertTrue(others.contains(Self.location))
        let bundle = sealed.bundles[0]
        XCTAssertEqual(Set(try XCTUnwrap(StoredZIPWriter.readManifest(from: custody.file(bundle)).satOut)), others,
                       "every other source the pass delivers is named: the bundle speaks for none of them")
        answer = try await link.deliver(bundle, of: custody)
        try await custody.applied(answer)
        XCTAssertEqual(Set(try XCTUnwrap(home.deliveries.last).satOut), others, "the door takes it")
        XCTAssertEqual(home.deliveries.last?.blobs, [note])
        XCTAssertEqual(home.custody(Self.location).received, 0, "location heard nothing of it")

        let next = try await custody.seal(answer, hardware: .synthetic, appVersion: "1.0.0", now: clock.now)
        XCTAssertEqual(next.bundles.map(\.seals), [[Self.location: 1]])
        XCTAssertEqual(try StoredZIPWriter.readManifest(from: custody.file(next.bundles[0])).files["location.jsonl"]?.lastSequence, 2)
        try report("one-stream", ["deliveries": home.deliveries.map(Self.describe)])
    }


    func testASavedAnswerNeverSealsOverALedgerRowAndAFreshAnswerSaysWhereToGoOnWhenTheHomeTookIt() async throws {
        let saved = try await sealForgotten(taken: true)
        XCTAssertEqual(home.custody(Self.location).received, 2, "the home took seal 2, its answer lost")
        try await sealsNothingFromTheSaved(saved)

        let fresh = try await link.exchange()
        try await custody.applied(fresh)
        let next = try await custody.seal(fresh, hardware: .synthetic, appVersion: "1.0.0", now: clock.now).bundles
        XCTAssertEqual(next.map(\.seals), [[Self.location: 3], [Self.voice: 1]], "the fresh answer says the home holds 2: the next is 3")
        _ = try await link.deliver(next[0], of: custody)
        XCTAssertEqual(home.deliveries.last?.ranges["location.jsonl"], [151, 180], "only what the home lacks")
        try report("saved-answer-taken", ["deliveries": home.deliveries.map(Self.describe)])
    }

    func testASavedAnswerNeverSealsOverALedgerRowAndAFreshAnswerSaysWhereToGoOnWhenTheHomeDidNotTakeIt() async throws {
        let saved = try await sealForgotten(taken: false)
        XCTAssertEqual(home.custody(Self.location).received, 1, "seal 2 never reached the home")
        try await sealsNothingFromTheSaved(saved)

        let fresh = try await link.exchange()
        try await custody.applied(fresh)
        let next = try await custody.seal(fresh, hardware: .synthetic, appVersion: "1.0.0", now: clock.now).bundles
        XCTAssertEqual(next.map(\.seals), [[Self.location: 2], [Self.voice: 1]], "the fresh answer says the home holds 1: seal 2 again")
        _ = try await link.deliver(next[0], of: custody)
        XCTAssertEqual(home.deliveries.last?.ranges["location.jsonl"], [101, 180], "seal 2 carries all the home lacks")
        try report("saved-answer-not-taken", ["deliveries": home.deliveries.map(Self.describe)])
    }

    private func sealForgotten(taken: Bool) async throws -> SavedAnswer {
        try await capture(.location, 100)
        try await shipAll()
        try await capture(.location, 50)
        let answer = try await link.exchange()
        try await custody.applied(answer)
        let saved = try XCTUnwrap(link.saved)
        XCTAssertEqual(saved.sources[Self.location]?.received, 1)
        let lost = try await sealed(answer)
        XCTAssertEqual(lost.seals, [Self.location: 2])
        if taken { _ = try await link.deliver(lost, of: custody) }
        try FileManager.default.removeItem(at: custody.file(lost))
        try await custody.tidy(keeping: [])
        let none = try await custody.pending()
        XCTAssertEqual(none, [], "its file gone, the bundle is forgotten")
        try await capture(.location, 30)
        try await capture(.voice, blob: "a note")
        return saved
    }

    private func sealsNothingFromTheSaved(_ saved: SavedAnswer) async throws {
        let awaits = try await custody.awaitsFresh(saved)
        XCTAssertTrue(awaits, "location waits for a fresh answer")
        let made = try await custody.seal(saved, hardware: .synthetic, appVersion: "1.0.0", now: clock.now)
        XCTAssertEqual(made.bundles.map(\.seals), [[Self.voice: 1]], "nothing sealed for location")
        XCTAssertTrue(try XCTUnwrap(StoredZIPWriter.readManifest(from: custody.file(made.bundles[0])).satOut).contains(Self.location),
                      "its bundle cannot speak for location")
        let carried = try await store.carried(pass: saved.pass, source: Self.location, through: 2)
        XCTAssertEqual(carried, 150, "seal 2's row still says 101-150")
        try await custody.forget(made.bundles[0])
    }


    func testAPhotosFileIsSentApartAndItsCopyClearedOnlyOnceTheSealThatNamesItIsImported() async throws {
        let photo = try await capture(.photos, blob: "a photo")
        let answer = try await link.exchange()
        let pending = try await sealed(answer)
        XCTAssertEqual(pending.files, [PendingBundle.File(name: photo, bytes: 7)])
        XCTAssertNil(try StoredZIPWriter.readManifest(from: custody.file(pending)).files["blobs/\(photo.dropFirst(7))"],
                     "the archive holds the records alone")
        try await custody.applied(try await link.deliver(pending, of: custody))
        XCTAssertEqual(home.fileSends.map(\.name), [photo], "its file went on its own")
        XCTAssertEqual(home.deliveries.last?.blobs, [photo], "and the seal brought it into the home")

        try await custody.clearImportedPhotos(try await link.exchange())
        var kept = Set(try await store.validatedBlobInventory().map(\.hash))
        XCTAssertEqual(kept, [photo], "received is not imported: the copy stays")
        home.importAll()
        try await custody.clearImportedPhotos(try await link.exchange())
        kept = Set(try await store.validatedBlobInventory().map(\.hash))
        XCTAssertEqual(kept, [], "imported, the copy goes")
        try report("sent-apart", ["deliveries": home.deliveries.map(Self.describe), "files": home.fileSends.map(\.name)])
    }

    func testAPhotoTheStageDroppedInASliceCutAtTheBoundIsSentAgainAndNeverSealedAsLost() async throws {
        let first = Data(repeating: 1, count: Int(CaptureExporter.namedBytes) / 2 + 1)
        let second = Data(repeating: 2, count: Int(CaptureExporter.namedBytes) / 2 + 1)
        try await capture(.photos, data: first)
        try await capture(.photos, data: second)
        try await capture(.photos, blob: "a photo the home imported")
        try await shipAll()
        try await shipAll()
        XCTAssertEqual(home.deliveries.compactMap { $0.ranges["photos.jsonl"] }, [[1, 1], [2, 3]], "cut at the bound")
        home.importAll()
        let imported = try await link.exchange()
        try await custody.applied(imported)
        try await custody.clearImportedPhotos(imported)
        let floor = try await store.photoExportFloor()
        XCTAssertEqual(floor, 3)
        home.restore(to: [:])
        _ = try await store.storeBlob(first)
        _ = try await store.storeBlob(second)

        let answer = try await link.exchange()
        try await custody.applied(answer)
        let resealed = try await custody.seal(answer, hardware: .synthetic, appVersion: "1.0.0", now: clock.now).bundles
        let photos = try XCTUnwrap(resealed.first { $0.seals[Self.photos] != nil })
        XCTAssertEqual(photos.files.map(\.name), [SHA256Digest.tagged(first)])
        XCTAssertNil(try StoredZIPWriter.readManifest(from: custody.file(photos)).custody[Self.photos]?.lost,
                     "the copy cleared past the slice is not stated lost in it")
        home.dropStagedAtNextBundle()
        try await custody.applied(try await link.deliver(photos, of: custody))
        let delivery = try XCTUnwrap(home.deliveries.last)
        XCTAssertEqual(delivery.ranges["photos.jsonl"], [1, 1])
        XCTAssertEqual(delivery.blobs, [SHA256Digest.tagged(first)], "FILES_MISSING named it; it was sent again and sealed with it")
        XCTAssertNil(delivery.lost[Self.photos])
        XCTAssertEqual(home.fileSends.filter { $0.name == SHA256Digest.tagged(first) }.count, 3,
                       "once before the restore, then twice: FILES_MISSING named it and it went again")
        try report("stage-dropped", ["deliveries": home.deliveries.map(Self.describe)])
    }

    func testOwesMoreWhileRowsRemainPastTheLedgerAndNotOnceTheyAreCarried() async throws {
        let first = Data(repeating: 1, count: Int(CaptureExporter.namedBytes) / 2 + 1)
        try await capture(.photos, data: first)
        try await capture(.photos, data: Data(repeating: 2, count: Int(CaptureExporter.namedBytes) / 2 + 1))
        var answer = try await link.exchange()
        let cut = try await sealed(answer)
        answer = try await link.deliver(cut, of: custody)
        try await custody.applied(answer)
        var owes = try await custody.owesMore([Self.photos], answer)
        XCTAssertTrue(owes, "the slice ended at the bound: a row is left")
        owes = try await custody.owesMore([Self.location], answer)
        XCTAssertFalse(owes, "a source with nothing is owed nothing")
        let rest = try await sealed(answer)
        answer = try await link.deliver(rest, of: custody)
        try await custody.applied(answer)
        owes = try await custody.owesMore([Self.photos], answer)
        XCTAssertFalse(owes, "every row carried")
        try await capture(.photos, blob: "a new photo")
        owes = try await custody.owesMore([Self.photos], answer)
        XCTAssertTrue(owes, "a row captured since")
    }

    func testThePairedExportCarriesEverySourcesWholeUnsentTailIntoTheFolderGiven() async throws {
        let first = Data(repeating: 1, count: Int(CaptureExporter.namedBytes) / 2 + 1)
        let second = Data(repeating: 2, count: Int(CaptureExporter.namedBytes) / 2 + 1)
        try await capture(.location, 2)
        try await shipAll()
        try await capture(.location, 1)
        let names = [try await capture(.photos, data: first), try await capture(.photos, data: second),
                     try await capture(.photos, blob: "a third photo")]
        let answer = try await link.exchange()
        try await custody.applied(answer)
        let pending = try await custody.seal(answer, hardware: .synthetic, appVersion: "1.0.0", now: clock.now).bundles
        let shipping = try XCTUnwrap(pending.first { $0.seals[Self.photos] != nil })
        XCTAssertEqual(try StoredZIPWriter.readManifest(from: custody.file(shipping)).files["photos.jsonl"]?.lastSequence, 1,
                       "the shipping slice is cut at the bound")

        let folder = root.appendingPathComponent("share", isDirectory: true)
        let copies = try await custody.exportCopies(for: try XCTUnwrap(link.saved), into: folder, hardware: .synthetic,
                                                    appVersion: "1.0.0", now: clock.now)
        XCTAssertEqual(Set(copies.map { $0.deletingLastPathComponent().standardizedFileURL }), [folder.standardizedFileURL])
        let manifests = try copies.map(StoredZIPWriter.readManifest)
        let photos = try XCTUnwrap(manifests.first { $0.custody[Self.photos] != nil })
        XCTAssertEqual(photos.files["photos.jsonl"].map { [$0.firstSequence, $0.lastSequence] }, [1, 3],
                       "every unsent row, past the pending bundle's bound")
        XCTAssertEqual(Set(photos.files.keys.filter { $0.hasPrefix("blobs/") }), Set(names.map { "blobs/" + $0.dropFirst(7) }),
                       "and every file inside it")
        XCTAssertEqual(photos.custody[Self.photos]?.seal, 1)
        let location = try XCTUnwrap(manifests.first { $0.custody[Self.location] != nil })
        XCTAssertEqual(location.files["location.jsonl"].map { [$0.firstSequence, $0.lastSequence] }, [3, 3], "after what the home holds")
        XCTAssertFalse(manifests.contains { $0.bundleID == shipping.id }, "never the shipping bundle")
        let still = try await custody.pending()
        XCTAssertEqual(still, pending, "the pending bundles are untouched")
        let carried = try await store.carried(pass: answer.pass, source: Self.photos, through: 1)
        XCTAssertEqual(carried, 1, "the export records no range")

        let copy = copies[try XCTUnwrap(manifests.firstIndex { $0.custody[Self.photos] != nil })]
        _ = try await link.send(bundle: copy, id: photos.bundleID, kind: .new)
        XCTAssertEqual(home.custody(Self.photos).received, 1, "the person imported the export")
        do {
            _ = try await link.deliver(shipping, of: custody)
            XCTFail("the shipping bundle's seal is no longer the next")
        } catch LinkFailure.stale {}
        try report("paired-export", ["copies": manifests.map { $0.custody.mapValues(\.seal) }])
    }

    private func shipAll() async throws {
        let answer = try await link.exchange()
        try await custody.applied(answer)
        for pending in try await custody.seal(answer, hardware: .synthetic, appVersion: "1.0.0", now: clock.now).bundles {
            try await custody.applied(try await link.deliver(pending, of: custody))
        }
        clock.advance(60)
    }

    private func sealed(_ answer: FreshAnswer, now: Date? = nil) async throws -> PendingBundle {
        let bundles = try await custody.seal(answer, hardware: .synthetic, appVersion: "1.0.0", now: now ?? clock.now).bundles
        XCTAssertEqual(bundles.count, 1, "under the shared size, one bundle")
        return try XCTUnwrap(bundles.first)
    }

    @discardableResult
    private func capture(_ domain: CaptureDomain, _ count: Int = 1, blob: String? = nil, data: Data? = nil) async throws -> String {
        var hash = ""
        if let file = data ?? blob.map({ Data($0.utf8) }) { hash = try await store.storeBlob(file) }
        for _ in 0..<count {
            second += 1
            let at = CaptureTime.rfc3339(clock.now.addingTimeInterval(TimeInterval(second - 1_000)))
            var payload: [String: JSONValue] = ["creation_date": .string(at)]
            if !hash.isEmpty { payload["blob"] = .object(["hash": .string(hash)]) }
            _ = try await store.append(domain: domain, draft: .init(kind: "synthetic", observedAt: at, payload: .object(payload)))
        }
        return hash
    }

    private func padded(_ domain: CaptureDomain, _ bytes: Int) async throws {
        second += 1
        let at = CaptureTime.rfc3339(clock.now.addingTimeInterval(TimeInterval(second - 1_000)))
        _ = try await store.append(domain: domain, draft: .init(kind: "synthetic", observedAt: at,
                                                                payload: .object(["padding": .string(String(repeating: "x", count: bytes))])))
    }

    @discardableResult
    private func photo(_ kind: String, _ id: String, blob: String? = nil) async throws -> String {
        var hash = ""
        if let blob { hash = SHA256Digest.tagged(Data(blob.utf8)) }
        if let blob, kind != "gone" { _ = try await store.storeBlob(Data(blob.utf8)) }
        second += 1
        let at = CaptureTime.rfc3339(clock.now.addingTimeInterval(TimeInterval(second - 1_000)))
        var payload: [String: JSONValue] = ["local_identifier": .string(id)]
        if blob != nil { payload["blob"] = .object(["hash": .string(hash)]) }
        _ = try await store.append(domain: .photos, draft: .init(kind: kind, observedAt: at, payload: .object(payload)))
        return hash
    }

    private static func describe(_ delivery: FakeHome.Delivery) -> [String: Any] {
        ["seals": delivery.seals, "ranges": delivery.ranges.mapValues { $0.map(Int.init) }, "sat_out": delivery.satOut,
         "blobs": delivery.blobs.count, "lost": delivery.lost.mapValues { $0.map { ["items": $0.items, "what": $0.what] } }]
    }

    private func report(_ name: String, _ scenario: [String: Any]) throws {
        let path = ProcessInfo.processInfo.environment["LIFESTREAM_PHONE_CUSTODY_REPORT"]
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().appendingPathComponent(".build/e2e/phone-custody.json").path
        let file = URL(fileURLWithPath: path)
        var all = (try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [String: Any] ?? [:]
        all[name] = scenario
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: all, options: [.sortedKeys, .prettyPrinted]).write(to: file)
    }

    private func typecheck(_ source: String) throws -> (status: Int32, output: String) {
        let products = Bundle(for: Self.self).bundleURL.deletingLastPathComponent()
        let modules = [products.appendingPathComponent("Modules"), products].first {
            FileManager.default.fileExists(atPath: $0.appendingPathComponent("LifestreamCaptureCore.swiftmodule").path)
        }
        let folder = try XCTUnwrap(modules, "the built core module is not beside the tests: the proof did not run")
        let file = root.appendingPathComponent("case.swift")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try ("import HomeLink\nimport LifestreamCaptureCore\n" + source).write(to: file, atomically: true, encoding: .utf8)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = ["swiftc", "-typecheck", "-I", folder.path, file.path]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        process.waitUntilExit()
        return (process.terminationStatus, output)
    }
}
