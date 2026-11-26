import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

final class PhoneLifeTests: XCTestCase {
    private static let name = "https://lifestream.example.ts.net"
    private static let checkin = "checkin:local:\(FakeHome.unit)"
    private static let notes = "notes:local:\(FakeHome.unit)"
    private static let location = "location:local:\(FakeHome.unit)"
    private static let health = "apple-health:\(FakeHome.account):cloud"

    private var root: URL!
    private var clock: TestClock!
    private var home: FakeHome!
    private let credentials = MemoryCredentials()

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("phone-life-\(UUID().uuidString)")
        clock = TestClock(Date(timeIntervalSince1970: 1_791_000_000))
        let clock = self.clock!
        home = FakeHome(clock: { clock.now })
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func link() -> HomeLink {
        let clock = self.clock!
        return HomeLink(device: .init(kind: .phone, version: "1.0.0", model: "iPhone", serial4: nil), credentials: credentials,
                        folder: root.appendingPathComponent("exports"), transport: home, clock: { clock.now })
    }

    private func entry(_ kind: String, _ observedAt: String, _ payload: [String: Any]) -> [String: Any] {
        ["kind": kind, "observed_at": observedAt, "payload": payload]
    }


    func testAReinstallRestoresWaitsForItAndSealsOnlyWhatItMadeSince() async throws {
        let link = link()
        _ = try await link.pair(code: FakeHome.code, name: Self.name, account: FakeHome.account)
        home.held(Self.location, received: 4)
        home.held(Self.checkin, received: 2)
        let archive = Data("a synthetic rich-text archive".utf8)
        let since = 1_790_990_000_000
        home.restoring(domains: [
            "checkin": [entry("report", "2026-10-03T01:00:00Z", ["form": "moment"]), entry("vigilance", "2026-10-03T02:00:00Z", ["completed": true])],
            "notes": [entry("note", "2026-10-03T03:00:00Z", ["id": "00000000-0000-4000-8000-00000000e001", "rich": ["hash": SHA256Digest.tagged(archive), "bytes": archive.count]])],
        ], since: [Self.health: since, Self.location: since], types: [Self.health: ["HKQuantityTypeIdentifierStepCount"]], blobs: [archive])

        let store = try CaptureStore(root: root.appendingPathComponent("capture"))
        let custody = PhoneCustody(exporter: CaptureExporter(store: store, exportsDirectory: root.appendingPathComponent("exports")))
        let answered = CaptureDraft(kind: "report", observedAt: "2026-10-03T04:00:00Z", payload: .object(["form": .string("moment")]))
        _ = try await store.append(domain: .location, draft: .init(kind: "lifecycle", observedAt: "2026-10-03T04:00:00Z", payload: .object(["event": .string("process_launch")])))
        do {
            _ = try await store.append(domain: .checkin, draft: answered)
            XCTFail("a check-in made before the restore would be sealed as carried")
        } catch CaptureError.restorePending(.checkin) {}
        let refusedBeforeRestore = !(await store.isRestored)

        let restore = try await link.restore()
        try await store.restore(restore, pass: restore.pass)
        let restoredCheckins = try await store.entries(domain: .checkin)
        XCTAssertEqual(restoredCheckins.map(\.kind), ["report", "vigilance"])
        XCTAssertEqual(restoredCheckins.first?.observedAt, "2026-10-03T01:00:00Z")
        let restoredNotes = try await store.entries(domain: .notes)
        XCTAssertEqual(restoredNotes.count, 1)
        let healthSince = try await store.since(.health)
        XCTAssertEqual(healthSince, Date(timeIntervalSince1970: TimeInterval(since) / 1000))
        let covered = try await store.sinceTypes(.health)
        XCTAssertEqual(covered, ["HKQuantityTypeIdentifierStepCount"], "since bounds only the Health types its read point covers")
        let notesSince = try await store.since(.notes)
        XCTAssertNil(notesSince, "a source the home never read states no since")
        let fetched = try await link.blob(SHA256Digest.tagged(archive))
        XCTAssertEqual(fetched, archive)
        try await store.restore(restore, pass: restore.pass)
        let checkinsAfterSecond = try await store.entries(domain: .checkin)
        XCTAssertEqual(checkinsAfterSecond.count, 2)

        _ = try await store.append(domain: .checkin, draft: answered)
        let answer = try await link.exchange()
        let sealed = try await custody.seal(answer, hardware: .synthetic, appVersion: "1.0.0", now: clock.now).bundles.first
        let pending = try XCTUnwrap(sealed)
        let manifest = try StoredZIPWriter.readManifest(from: custody.file(pending))
        XCTAssertEqual(pending.seals[Self.checkin], 3)
        XCTAssertEqual(manifest.files["checkin.jsonl"]?.firstSequence, 3, "the restored check-ins are seal 0: the seal carries only the one made since")
        XCTAssertEqual(manifest.files["checkin.jsonl"]?.lastSequence, 3)
        XCTAssertNil(manifest.files["notes.jsonl"], "restored notes never ship again")
        XCTAssertEqual(manifest.files["location.jsonl"]?.firstSequence, 1, "this install's own entries ship from its first")

        try await custody.applied(try await link.deliver(pending, of: custody))
        home.importAll()
        try await custody.applied(try await link.exchange())

        try link.forget()
        _ = try await link.pair(code: FakeHome.code, name: Self.name, account: FakeHome.account)
        let repaired = try await link.exchange()
        XCTAssertEqual(repaired.pass, "p-0002")
        try await custody.applied(repaired)
        let sealedAgain = try await custody.seal(repaired, hardware: .synthetic, appVersion: "1.0.0", now: clock.now).bundles.first
        let resealed = try XCTUnwrap(sealedAgain)
        let again = try StoredZIPWriter.readManifest(from: custody.file(resealed))
        XCTAssertEqual(again.files["checkin.jsonl"]?.firstSequence, 3, "the restored check-ins stay seal 0 under the new pass")
        XCTAssertNil(again.files["notes.jsonl"])
        try report("reinstall", [
            "refused_before_restore": refusedBeforeRestore, "restored": ["checkin": restoredCheckins.count, "notes": restoredNotes.count],
            "seals": pending.seals, "checkin_first": manifest.files["checkin.jsonl"]?.firstSequence ?? 0,
        ])
    }


    func testARefusedRestoreKeepsThePassAndRestoresOnceTheHomeTakesItAgain() async throws {
        let link = link()
        _ = try await link.pair(code: FakeHome.code, name: Self.name, account: FakeHome.account)
        home.restoring(domains: ["checkin": [entry("report", "2026-10-03T01:00:00Z", ["form": "moment"])]], since: [:])
        let store = try CaptureStore(root: root.appendingPathComponent("capture"))

        home.refusing = true
        do {
            _ = try await link.restore()
            XCTFail("the home refuses the pass")
        } catch LinkFailure.refused(401, "PRINCIPAL_UNKNOWN", _) {}
        XCTAssertEqual(try link.name()?.absoluteString, Self.name, "a refusal forgets no pass")
        let owed = await !store.isRestored
        XCTAssertTrue(owed, "and the restore is still owed")

        home.refusing = false
        let restore = try await link.restore()
        try await store.restore(restore, pass: restore.pass)
        let restored = await store.isRestored
        XCTAssertTrue(restored)
        let checkins = try await store.entries(domain: .checkin)
        XCTAssertEqual(checkins.map(\.kind), ["report"])
        XCTAssertEqual(restore.pass, "p-0001", "under the same pass")
        try report("refused-restore", ["kept_pass": true, "owed_while_refused": owed, "restored_after": restored])
    }


    func testANewInstallOwesItsRestoreAndKeepsItsFirstRunAcrossARelaunch() async throws {
        let capture = root.appendingPathComponent("capture")
        let left = CaptureStore.FirstRun(past: ["welcome", "pair"], started: true, askedAlways: true)
        do {
            let made = try CaptureStore(root: capture)
            XCTAssertTrue(made.madeAtOpen)
            XCTAssertEqual(made.firstRunAtOpen, CaptureStore.FirstRun(), "a new install has its first run to run")
            try await made.setFirstRun(left)
        }
        let reopened = try CaptureStore(root: capture)
        let restored = await reopened.isRestored
        XCTAssertFalse(restored, "a new install still owes its restore after a relaunch")
        XCTAssertFalse(reopened.madeAtOpen)
        XCTAssertEqual(reopened.firstRunAtOpen, left, "the first run as it was left")
        let elsewhere = try CaptureStore(root: root.appendingPathComponent("restored-from-a-backup"))
        XCTAssertEqual(elsewhere.firstRunAtOpen, CaptureStore.FirstRun(), "another install's first run is its own")
        try report("relaunch", ["owed_after_relaunch": !restored, "first_run_kept": reopened.firstRunAtOpen == left])
    }


    func testAnInstallWithNoPassCapturesWholeThenPairsKeepingItsOwnCheckInsAndUnpairs() async throws {
        let store = try CaptureStore(root: root.appendingPathComponent("capture"))
        await store.setPaired(false)
        let custody = PhoneCustody(exporter: CaptureExporter(store: store, exportsDirectory: root.appendingPathComponent("exports")))
        let admitted = await store.historyReadsAdmitted
        XCTAssertTrue(admitted, "with no pass there is no restore to wait for: the history reads run whole")
        _ = try await store.append(domain: .location, draft: .init(kind: "lifecycle", observedAt: "2026-10-03T04:00:00Z", payload: .object(["event": .string("process_launch")])))
        _ = try await store.append(domain: .checkin, draft: .init(kind: "report", observedAt: "2026-10-03T04:10:00Z", payload: .object(["form": .string("moment")])))

        let copied = try await custody.exporter.copy(hardware: .synthetic, appVersion: "1.0.0", now: clock.now)
        let copy = try XCTUnwrap(copied)
        let copyManifest = try StoredZIPWriter.readManifest(from: copy.url)
        XCTAssertTrue(copyManifest.custody.isEmpty, "a copy names no seal: no home imports it")
        XCTAssertEqual(copyManifest.files["checkin.jsonl"]?.firstSequence, 1)
        XCTAssertEqual(copyManifest.files["location.jsonl"]?.observations, 1)
        let pendingAfterCopy = try await custody.pending()
        XCTAssertEqual(pendingAfterCopy, [], "a copy is not a bundle in flight")

        let link = link()
        _ = try await link.pair(code: FakeHome.code, name: Self.name, account: FakeHome.account)
        await store.setPaired(true)
        home.restoring(domains: [
            "checkin": [entry("report", "2026-10-01T01:00:00Z", ["form": "moment"])],
            "notes": [entry("note", "2026-10-01T03:00:00Z", ["id": "00000000-0000-4000-8000-00000000e002"])],
        ], since: [:])
        let restore = try await link.restore()
        try await store.restore(restore, pass: restore.pass)
        let checkins = try await store.entries(domain: .checkin)
        XCTAssertEqual(checkins.map(\.observedAt), ["2026-10-03T04:10:00Z"], "a domain holding the install's own takes none back")
        let notes = try await store.entries(domain: .notes)
        XCTAssertEqual(notes.count, 1, "notes, which wait for the restore, come back")
        let sealed = try await custody.seal(try await link.exchange(), hardware: .synthetic, appVersion: "1.0.0", now: clock.now).bundles.first
        let pending = try XCTUnwrap(sealed)
        let manifest = try StoredZIPWriter.readManifest(from: custody.file(pending))
        XCTAssertEqual(manifest.files["checkin.jsonl"]?.firstSequence, 1, "the check-in made with no pass ships")
        XCTAssertNil(manifest.files["notes.jsonl"], "the restored notes are seal 0")

        try link.forget()
        await store.setPaired(false)
        try await custody.forgetPending()
        let pendingAfterUnpair = try await custody.pending()
        XCTAssertEqual(pendingAfterUnpair, [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: custody.file(pending).path))
        _ = try await store.append(domain: .checkin, draft: .init(kind: "report", observedAt: "2026-10-03T05:00:00Z", payload: .object(["form": .string("moment")])))
        try report("no-pass", [
            "copy_custody": copyManifest.custody.count, "restored_checkins": checkins.count - 1, "restored_notes": notes.count,
            "checkin_first_sealed": manifest.files["checkin.jsonl"]?.firstSequence ?? 0, "pending_after_unpair": pendingAfterUnpair.count,
        ])
    }


    func testAReplacedInstallShipsWhatItHoldsSaysDrainedOnlyWhenTheHomeHoldsItAllAndIsRevoked() async throws {
        let link = link()
        _ = try await link.pair(code: FakeHome.code, name: Self.name, account: FakeHome.account)
        let store = try await CaptureStore.restored(root: root.appendingPathComponent("capture"))
        let custody = PhoneCustody(exporter: CaptureExporter(store: store, exportsDirectory: root.appendingPathComponent("exports")))
        _ = try await store.append(domain: .location, draft: .init(kind: "lifecycle", observedAt: "2026-10-03T04:00:00Z", payload: .object(["event": .string("process_launch")])))
        home.replace("p-0001", at: "2026-10-14T06:36:19.071Z")
        let told = try await link.exchange()
        XCTAssertNotNil(told.replaced)
        var holds = try await custody.holdsNothingMore(told)
        XCTAssertFalse(holds, "an entry no seal carried is still on the phone")

        _ = try await store.append(domain: .location, draft: .init(kind: "lifecycle", observedAt: "2026-10-03T04:00:01Z", payload: .object(["event": .string("waiting")])), waiting: true)
        try await store.markStopped(at: clock.now)
        for waiting in [false, true] {
            do {
                _ = try await store.append(domain: .location, draft: .init(kind: "lifecycle", observedAt: "2026-10-03T04:00:02Z", payload: .object(["event": .string("process_launch")])), waiting: waiting)
                XCTFail("a stopped install takes no entry")
            } catch CaptureError.stopped {}
        }
        let reopened = try CaptureStore(root: root.appendingPathComponent("capture"))
        let stoppedAfterRelaunch = await reopened.isStopped
        XCTAssertTrue(stoppedAfterRelaunch, "a launch reads the stop")
        let held = try await store.entries(domain: .location).count
        XCTAssertEqual(held, 2, "the waiting reading was saved with the stop")

        let sealed = try await custody.seal(told, hardware: .synthetic, appVersion: "1.0.0", now: clock.now).bundles.first
        let pending = try XCTUnwrap(sealed)
        try await custody.applied(try await link.deliver(pending, of: custody))
        let shipped = try await link.exchange()
        holds = try await custody.holdsNothingMore(shipped)
        XCTAssertFalse(holds, "a seal the home has not imported is not handed over")
        do {
            _ = try await link.exchange(drained: true)
            XCTFail("the home refuses drained while a seal waits to import")
        } catch LinkFailure.refused(409, "NOT_DRAINED", _) {}

        home.importAll()
        let imported = try await link.exchange()
        try await custody.applied(imported)
        holds = try await custody.holdsNothingMore(imported)
        XCTAssertTrue(holds)
        let drained = try await link.exchange(drained: true)
        XCTAssertNotNil(drained.replaced)
        do {
            _ = try await link.exchange()
            XCTFail("a drained pass is revoked")
        } catch LinkFailure.refused(401, _, _) {}
        try report("handover", ["replaced": told.replaced.map(CaptureTime.rfc3339) ?? "", "revoked": true])
    }


    func testAReadPointShipsBesideTheEntriesItCoversAndOnlyForItsSource() async throws {
        let link = link()
        _ = try await link.pair(code: FakeHome.code, name: Self.name, account: FakeHome.account)
        let store = try await CaptureStore.restored(root: root.appendingPathComponent("capture"))
        let custody = PhoneCustody(exporter: CaptureExporter(store: store, exportsDirectory: root.appendingPathComponent("exports")))
        _ = try await store.append(domain: .motion, draft: .init(kind: "activity", observedAt: "2026-10-03T04:00:00Z",
                                                                  payload: .object(["stationary": .bool(true)])), waiting: true)
        let at = Date(timeIntervalSince1970: 1_791_000_000)
        try await store.setReadPoint(.motion, .init(at: at))
        let saved = try await store.entries(domain: .motion)
        XCTAssertEqual(saved.count, 1, "the waiting reading is saved before the read point that covers it")
        _ = try await store.append(domain: .health, draft: .init(kind: "health_event", observedAt: "2026-10-03T04:00:00Z",
                                                                  payload: .object(["event": .string("health_sweep_failed")])))
        try await store.setReadPoint(.health, .init(at: at, types: ["HKQuantityTypeIdentifierStepCount"]))
        _ = try await store.append(domain: .location, draft: .init(kind: "lifecycle", observedAt: "2026-10-03T04:00:00Z",
                                                                    payload: .object(["event": .string("process_launch")])))

        let answer = try await link.exchange()
        let built = try await custody.seal(answer, hardware: .synthetic, appVersion: "1.0.0", now: clock.now).bundles.first
        let sealed = try XCTUnwrap(built)
        let manifest = try StoredZIPWriter.readManifest(from: custody.file(sealed))
        let motion = "motion:local:\(FakeHome.unit)"
        XCTAssertEqual(manifest.custody[motion]?.historyThrough, CaptureTime.rfc3339(at))
        XCTAssertEqual(manifest.custody[Self.health]?.historyThrough, CaptureTime.rfc3339(at))
        XCTAssertEqual(manifest.custody[Self.health]?.types, ["HKQuantityTypeIdentifierStepCount"])
        XCTAssertNil(manifest.custody[Self.location]?.historyThrough, "a source that reads no history states none")
        XCTAssertNotNil(manifest.custody[Self.location])
        try report("read-points", ["motion": manifest.custody[motion]?.historyThrough ?? "", "health_types": manifest.custody[Self.health]?.types ?? []])
    }


    func testHistoryReadsStartWhereTheHomeStands() throws {
        let since = Date(timeIntervalSince1970: 1_791_000_000)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Kolkata")!
        XCTAssertNil(HistoryStart.health(start: nil, since: nil), "a phone's first install under a start of all reads all of Health")
        XCTAssertEqual(HistoryStart.health(start: nil, since: since), since.addingTimeInterval(-30 * 24 * 3600))
        let usual = since.addingTimeInterval(-7 * 24 * 3600)
        let motion = HistoryStart.motion(usualStart: usual, since: since, start: nil, calendar: calendar)
        XCTAssertEqual(motion.activities, since)
        XCTAssertEqual(motion.pedometerDays, calendar.startOfDay(for: since), "since's own day: the earlier install shipped it only up to since")
        let first = HistoryStart.motion(usualStart: usual, since: nil, start: nil, calendar: calendar)
        XCTAssertEqual(first.activities, usual)
        XCTAssertEqual(first.pedometerDays, calendar.startOfDay(for: usual))
        let older = HistoryStart.motion(usualStart: usual, since: usual.addingTimeInterval(-86_400), start: nil, calendar: calendar)
        XCTAssertEqual(older.activities, usual, "a since older than the seven days reads the seven days")
        try report("since", ["health_days_before": 30, "motion_from_since": motion.activities == since])
    }

    func testHistoryReadsKeepToTheStart() throws {
        let now = Date(timeIntervalSince1970: 1_791_000_000)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        let restore = now.addingTimeInterval(-90 * 86_400)
        let restoreStart = restore.addingTimeInterval(-HistoryStart.lateArrivals)
        let longAgo = Date(timeIntervalSince1970: 1_700_000_000)
        let lately = now.addingTimeInterval(-40 * 86_400)

        XCTAssertEqual(HistoryStart.health(start: lately, since: nil), lately, "a phone never restored reads Health from the start")
        XCTAssertEqual(HistoryStart.health(start: longAgo, since: restore), restoreStart, "a start before the restore start reads from the restore start")
        XCTAssertEqual(HistoryStart.health(start: lately, since: restore), lately, "a start after the restore start reads from the start")

        let usual = now.addingTimeInterval(-7 * 86_400)
        let yesterday = now.addingTimeInterval(-86_400)
        let recent = HistoryStart.motion(usualStart: usual, since: nil, start: yesterday, calendar: calendar)
        XCTAssertEqual(recent.activities, yesterday, "a start inside the seven days cuts Motion's read")
        XCTAssertEqual(recent.pedometerDays, calendar.startOfDay(for: yesterday), "from the start's own day")
        let old = HistoryStart.motion(usualStart: usual, since: nil, start: longAgo, calendar: calendar)
        XCTAssertEqual(old.activities, usual, "a start older than the seven days reads the seven days CoreMotion keeps")
        let restored = HistoryStart.motion(usualStart: usual, since: now.addingTimeInterval(-3 * 86_400), start: yesterday, calendar: calendar)
        XCTAssertEqual(restored.activities, yesterday, "the latest of the seven days, the restore and the start")

        let utcMidnight = Date(timeIntervalSince1970: 1_790_985_600)
        XCTAssertNil(HistoryStart.usage(start: nil, calendar: calendar), "a start of all leaves Screen Time's days open")
        let usage = try XCTUnwrap(HistoryStart.usage(start: utcMidnight, calendar: calendar))
        XCTAssertEqual(usage, calendar.startOfDay(for: utcMidnight), "Screen Time's earliest day is the phone's day holding the start")
        XCTAssertLessThanOrEqual(utcMidnight.timeIntervalSince(usage), 86_400, "never more than a day before the start")

        XCTAssertTrue(HistoryStart.earlier(nil, than: lately), "all is earlier than any day")
        XCTAssertTrue(HistoryStart.earlier(longAgo, than: lately))
        XCTAssertFalse(HistoryStart.earlier(lately, than: lately))
        XCTAssertFalse(HistoryStart.earlier(lately, than: longAgo))
        XCTAssertFalse(HistoryStart.earlier(nil, than: nil), "no kept start reads as all, which nothing is earlier than")
        XCTAssertFalse(HistoryStart.earlier(longAgo, than: nil))
        try report("start", ["health_from_restore": HistoryStart.health(start: longAgo, since: restore) == restoreStart,
                             "motion_from_start": recent.activities == yesterday])
    }

    private func report(_ name: String, _ scenario: [String: Any]) throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent(".build/e2e/phone-life.json")
        var all = (try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [String: Any] ?? [:]
        all[name] = scenario
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: all, options: [.sortedKeys, .prettyPrinted]).write(to: file)
    }
}
