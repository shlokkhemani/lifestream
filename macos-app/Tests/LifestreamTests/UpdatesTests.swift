import AppKit
import HomeLink
import Shipping
import Sparkle
import XCTest
@testable import Lifestream

@MainActor
final class UpdatesTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "org.lifestreamprotocol.screen-capture.updates-tests.\(UUID().uuidString)"

    override func setUp() {
        super.setUp()
        UserDefaults().removePersistentDomain(forName: suite)
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suite)
        super.tearDown()
    }

    private final class Clock {
        var now = Date(timeIntervalSince1970: 1_792_000_000)
        var scheduled: [(delay: TimeInterval, work: @MainActor () -> Void)] = []
    }

    private func updates(locked: @escaping () -> Bool = { false }, clock: Clock = Clock()) -> Updates {
        let updates = Updates(defaults: defaults)
        updates.mobile = { MobileData.Moment(path: .free, choice: .now, loopback: false, pressed: false) }
        updates.locked = locked
        updates.now = { clock.now }
        updates.after = { clock.scheduled.append(($0, $1)) }
        return updates
    }

    func testInstallingAutomaticallyIsOnForAMacThatNeverSetItAndThePersonsChoiceIsKept() {
        XCTAssertNil(UserDefaults().persistentDomain(forName: suite)?[Updates.installsAutomaticallyKey], "the suite starts with the setting stored")
        XCTAssertTrue(Updates(defaults: defaults).installsAutomatically, "a Mac that never set it reads off")
        let updates = updates()
        updates.installsAutomatically = false
        XCTAssertFalse(Updates(defaults: defaults).installsAutomatically, "the person's off was not kept")
        updates.installsAutomatically = true
        XCTAssertTrue(Updates(defaults: defaults).installsAutomatically)
    }

    func testOnAnUpdateInstallsOnTheLockAloneAndAtOnceWhenLockedAlready() {
        var locked = false
        let updates = updates(locked: { locked })
        var installs = 0
        updates.downloaded("1812", install: { installs += 1 })
        XCTAssertEqual(installs, 0, "installed while the person is at the Mac")
        XCTAssertNil(updates.waiting, "on, a ready update is no need before it waited a day")
        updates.screenLocked()
        XCTAssertEqual(installs, 0)
        locked = true
        updates.screenLocked()
        XCTAssertEqual(installs, 1)

        let later = self.updates(locked: { true })
        var changes = 0
        later.changed = { changes += 1 }
        later.downloaded("1813", install: { installs += 1 })
        XCTAssertEqual(installs, 2)
        XCTAssertEqual(changes, 0)
        XCTAssertNil(later.waiting)
        XCTAssertNil(later.holding, "an update installed at once was held")
        later.screenLocked()
        later.restart()
        XCTAssertEqual(installs, 2, "an immediate install leaves no pending install to invoke again")
    }

    func testOffAReadyUpdateIsANeedAtOnceAndALockInstallsNothing() {
        let updates = updates(locked: { true })
        updates.installsAutomatically = false
        var changes = 0
        updates.changed = { changes += 1 }
        XCTAssertNil(updates.waiting)
        var installs = 0
        updates.downloaded("1812", install: { installs += 1 })
        XCTAssertEqual(installs, 0, "off, a download installed by itself")
        XCTAssertEqual(updates.waiting, "1812")
        XCTAssertEqual(updates.holding, "1812")
        XCTAssertEqual(changes, 1)
        updates.screenLocked()
        XCTAssertEqual(installs, 0, "off, a lock installed")
        updates.restart()
        updates.restart()
        XCTAssertEqual(installs, 2)
    }

    func testOnAReadyUpdateIsANeedOnceItWaitedADayAndTheDayIsReadAgain() throws {
        let clock = Clock()
        let updates = updates(clock: clock)
        var changes = 0
        updates.changed = { changes += 1 }
        updates.downloaded("1812", install: {})
        XCTAssertNil(updates.waiting)
        XCTAssertEqual(updates.holding, "1812", "the mark waited with the need")
        XCTAssertEqual(changes, 1)
        let day = try XCTUnwrap(clock.scheduled.first)
        XCTAssertEqual(day.delay, Updates.waitsFor)
        XCTAssertEqual(Updates.waitsFor, 24 * 3600)
        clock.now = clock.now.addingTimeInterval(Updates.waitsFor - 60)
        XCTAssertNil(updates.waiting, "a need before the day passed")
        clock.now = clock.now.addingTimeInterval(60)
        XCTAssertEqual(updates.waiting, "1812")
        day.work()
        XCTAssertEqual(changes, 2, "nothing read the need again once the day passed")
    }

    func testTurningTheSettingOffShowsTheReadyUpdateAndOnHidesItAgain() {
        let updates = updates()
        var changes = 0
        updates.changed = { changes += 1 }
        updates.downloaded("1812", install: {})
        XCTAssertNil(updates.waiting)
        updates.installsAutomatically = false
        XCTAssertEqual(updates.waiting, "1812")
        XCTAssertEqual(changes, 2, "the change of the setting was not told")
        updates.installsAutomatically = true
        XCTAssertNil(updates.waiting)
        XCTAssertEqual(changes, 3)
    }

    func testAnUpdateSparkleAbandonsIsHeldNoLonger() {
        let updates = updates()
        updates.installsAutomatically = false
        var changes = 0
        updates.changed = { changes += 1 }
        updates.abandoned()
        XCTAssertEqual(changes, 0)
        var installs = 0
        updates.downloaded("1812", install: { installs += 1 })
        XCTAssertEqual([updates.holding, updates.waiting], ["1812", "1812"])
        XCTAssertEqual(changes, 1)
        updates.abandoned()
        XCTAssertNil(updates.holding, "the mark stood for an update Sparkle abandoned")
        XCTAssertNil(updates.waiting, "the need stood for an update Sparkle abandoned")
        XCTAssertEqual(changes, 2, "the needs and the mark were not told")
        updates.restart()
        XCTAssertEqual(installs, 0)
        updates.downloaded("1812", install: { installs += 1 })
        XCTAssertEqual(updates.holding, "1812")
        updates.restart()
        XCTAssertEqual(installs, 1)
    }

    func testWhatsNewShowsTheRunningUpdatesNoteForADay() {
        let updates = updates()
        updates.downloaded("1812", note: Updates.plain("<p>Places name\n the cafés you go back to.</p>"), install: {})
        let first = Date(timeIntervalSince1970: 1_792_000_000)
        XCTAssertNil(updates.whatsNew(running: "1811", now: first))
        XCTAssertEqual(updates.whatsNew(running: "1812", now: first), "What's new in 1812: Places name the cafés you go back to.")
        XCTAssertNotNil(Updates(defaults: defaults).whatsNew(running: "1812", now: first.addingTimeInterval(23 * 3600)))
        XCTAssertNil(Updates(defaults: defaults).whatsNew(running: "1812", now: first.addingTimeInterval(25 * 3600)))
        updates.downloaded("1813", install: {})
        XCTAssertNil(updates.whatsNew(running: "1813", now: first))
    }

    func testSparkleFindsTheDelegateMethodsByItsSelectors() {
        let updates = Updates(defaults: defaults)
        for selector in ["updater:willInstallUpdateOnQuit:immediateInstallationBlock:", "updater:didAbortWithError:",
                         "updater:mayPerformUpdateCheck:error:",
                         "updaterWillRelaunchApplication:", "supportsGentleScheduledUpdateReminders"] {
            XCTAssertTrue(updates.responds(to: NSSelectorFromString(selector)), selector)
        }
    }

    func testOnAHotspotTheHourlyCheckWaitsAndAPressDownloads() throws {
        let updates = updates()
        var moment: MobileData.Moment?
        updates.mobile = { moment }
        let here = { (path: MobileData.Path, choice: MobileData.Choice) in
            MobileData.Moment(path: path, choice: choice, loopback: true, pressed: false)
        }
        XCTAssertThrowsError(try updates.mayCheck(.updatesInBackground), "the hourly check waits while there is no link to ask")
        moment = here(.costly, .now)
        XCTAssertThrowsError(try updates.mayCheck(.updatesInBackground),
                             "a hotspot holds the hourly check, though the home is on this Mac: an update comes over the internet")
        XCTAssertNoThrow(try updates.mayCheck(.updates), "Check for Updates… is a press: it downloads on any network")
        XCTAssertNoThrow(try updates.mayCheck(.updateInformation))
        moment = here(.free, .now)
        XCTAssertNoThrow(try updates.mayCheck(.updatesInBackground), "on a free network the hourly check goes on by itself")
        moment = here(.costly, .everything)
        XCTAssertNoThrow(try updates.mayCheck(.updatesInBackground), "Everything, including my past, lets it cross a hotspot")
        moment = here(.lowData, .everything)
        XCTAssertThrowsError(try updates.mayCheck(.updatesInBackground), "Low Data Mode holds it whatever the choice")
        updates.downloaded("1812", install: {})
        XCTAssertNoThrow(try updates.mayCheck(.updatesInBackground), "with one ready nothing more downloads: nothing waits")
        updates.aborted(Updates.deferred)
        XCTAssertEqual(updates.holding, "1812", "a check that waited for the network abandoned the update ready")
        updates.aborted(NSError(domain: "org.sparkle-project.Sparkle", code: 4005))
        XCTAssertNil(updates.holding, "an abort of Sparkle's own still abandons it")
    }

    func testSparklesQuitToRelaunchIsNeverAsked() {
        XCTAssertEqual(QuitSource.classify(shuttingDown: false, quitReason: nil, sender: nil, updating: true), .system)
        XCTAssertEqual(QuitDecision.decide(source: .system, screenRecorded: true), .terminateNow)
        XCTAssertEqual(QuitSource.classify(shuttingDown: false, quitReason: nil, sender: nil, updating: false), .user)
    }

    func testABuildWithoutAFeedStartsNoUpdater() throws {
        let bundle = FileManager.default.temporaryDirectory.appendingPathComponent("NoFeed-\(UUID().uuidString).app")
        try FileManager.default.createDirectory(at: bundle.appendingPathComponent("Contents"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: bundle) }
        let info: [String: Any] = ["CFBundleIdentifier": "com.example.no-feed", "CFBundleExecutable": "NoFeed",
                                   "CFBundlePackageType": "APPL"]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            .write(to: bundle.appendingPathComponent("Contents/Info.plist"))
        let updates = Updates(defaults: defaults)
        updates.start(bundle: try XCTUnwrap(Bundle(url: bundle)))
        XCTAssertFalse(updates.available)
        XCTAssertNil(updates.waiting)
        XCTAssertNil(updates.holding)
        updates.start()
        XCTAssertFalse(updates.available)
    }

}
