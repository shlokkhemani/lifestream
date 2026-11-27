import AppKit
import Recorder
import SwiftUI
import UserNotifications
import XCTest
@testable import Lifestream

final class LaunchWindowTests: XCTestCase {
    private let done = SetupWorld(placed: true, release: true, outdated: false, folder: URL(fileURLWithPath: "/Volumes/Drive-A/Lifestream"),
                                  agents: Dictionary(uniqueKeysWithValues: HomeJob.allCases.map { ($0, .current) }),
                                  paired: true)
    private let due = SetupWorld(placed: true, release: true, outdated: false, folder: URL(fileURLWithPath: "/Volumes/Drive-A/Lifestream"),
                                 agents: Dictionary(uniqueKeysWithValues: HomeJob.allCases.map { ($0, .current) }),
                                 paired: false)
    private let all = Dictionary(uniqueKeysWithValues: Grant.allCases.map { ($0, true) })

    private func lacking(_ grant: Grant) -> [Grant: Bool] {
        var grants = all
        grants[grant] = false
        return grants
    }

    func testAnOpenShowsTheFirstRunThenAStandingNeedThenTheDashboard() {
        func shown(_ opening: LaunchWindow.Opening, _ world: SetupWorld, open: Bool = false, needs: Bool,
                   onboarding: Bool = false, resume: String? = nil) -> LaunchWindow? {
            LaunchWindow.shown(opening, world: world, open: open, needs: needs, onboarding: onboarding, resume: resume)
        }
        XCTAssertNil(shown(.atLogin, done, needs: false), "a login opens no window")
        XCTAssertNil(shown(.atLogin, done, needs: true), "a login opens a window for a need")
        XCTAssertNil(shown(.atLogin, done, needs: false, resume: "view=connectors"), "a login opens a restart's page")
        XCTAssertEqual(shown(.atLogin, due, needs: false), .setup, "the first run comes back at login")
        XCTAssertNil(shown(.afterUpdate, done, needs: false), "an update's relaunch opens no window")
        XCTAssertNil(shown(.afterUpdate, done, needs: true), "an update's relaunch opens a window for a need")
        XCTAssertNil(shown(.afterUpdate, done, needs: false, resume: "view=connectors"), "an update's relaunch opens a restart's page")
        XCTAssertEqual(shown(.afterUpdate, due, needs: false), .setup, "the first run comes back after an update")
        XCTAssertEqual(shown(.byPerson, due, needs: false), .setup)
        XCTAssertEqual(shown(.byPerson, due, needs: true), .setup, "a need came before a due first run")
        XCTAssertEqual(shown(.byPerson, due, needs: false, resume: "view=connectors"), .setup, "a restart's page came before a due first run")
        XCTAssertEqual(shown(.byPerson, done, needs: true), .connectors)
        XCTAssertEqual(shown(.byPerson, done, needs: true, onboarding: true), .dashboard, "a need took the person out of the onboarding")
        XCTAssertEqual(shown(.byPerson, done, needs: true, resume: "view=onboarding&seg=found"), .page("view=onboarding&seg=found"))
        XCTAssertEqual(shown(.byPerson, done, needs: false, onboarding: true, resume: "view=connectors"), .page("view=connectors"))
        XCTAssertEqual(shown(.byPerson, done, needs: false), .dashboard)
        XCTAssertEqual(shown(.byPerson, done, open: true, needs: true), .front, "a reopen moved an open window to Connectors for a need")
        XCTAssertEqual(shown(.byPerson, done, open: true, needs: false, resume: "view=connectors"), .front, "a reopen moved an open window")
        XCTAssertEqual(shown(.byPerson, due, open: true, needs: false), .setup, "an open window hid a due first run")
        XCTAssertNil(shown(.atLogin, done, open: true, needs: true))
    }

    func testAMissingGrantIsCountedInOneMenuLineAndIsARowNeverAnOpen() {
        XCTAssertEqual(Grant.missing(all), [])
        XCTAssertEqual(Grant.missing([:]), Grant.listed.filter { !$0.optional },
                       "a grant macOS did not answer for was not counted as missing, or Bluetooth, an extra, was")
        XCTAssertEqual(Grant.missing(lacking(.screenRecording)), [.screenRecording])
        XCTAssertEqual(Grant.missing(lacking(.openAtLogin)), [], "the login item, Settings' own, was counted as a permission")
        XCTAssertEqual(Grant.listed, Grant.allCases.filter { $0 != .openAtLogin })
        XCTAssertFalse(HostState.GrantRow.all(lacking(.openAtLogin), asking: [], denied: []).contains { $0.id == Grant.openAtLogin.rawValue },
                       "This Mac's permissions name the login item")
        XCTAssertEqual(HostState.GrantRow.all(all, asking: [], denied: []).map(\.id), Grant.listed.map(\.rawValue))
        XCTAssertNil(Grant(rawValue: "notifications"))
        XCTAssertEqual(Grant.missing(lacking(.photos)), [.photos])
        XCTAssertEqual(Grant.missing([:]).count, 6)
        XCTAssertEqual(Grant.menuLine(Grant.missing([:])), "Allow 6 permissions…")
        XCTAssertEqual(HostAct.read(["type": "act", "act": "allow", "grants": ["notifications"]]), .failure(.unreadable(nil)),
                       "the page may ask the host for notifications")
        XCTAssertNil(Grant.menuLine([]))
        XCTAssertEqual(Grant.menuLine([.microphone]), "Allow 1 permission…")
        XCTAssertEqual(Grant.menuLine([.microphone, .bluetooth, .photos]), "Allow 3 permissions…")
        let menu = try? String(contentsOf: sources.appendingPathComponent("MenuBar/MenuBarApp.swift"), encoding: .utf8)
        XCTAssertTrue(menu?.contains("Grant.menuLine(") == true, "the menu does not say the missing grants in one line")
    }

    func testAnAskMacOSDeclinesToRegisterIsToldFromThePersonsDontAllow() {
        let notAllowed = NSError(domain: UNErrorDomain, code: UNError.Code.notificationsNotAllowed.rawValue)
        XCTAssertTrue(NotificationGrant.declines(status: .notDetermined, error: notAllowed))
        XCTAssertTrue(NotificationGrant.declines(status: .notDetermined, error: nil), "not determined after an ask is macOS declining")
        XCTAssertFalse(NotificationGrant.declines(status: .authorized, error: nil))
        XCTAssertFalse(NotificationGrant.declines(status: .denied, error: nil))
        XCTAssertFalse(NotificationGrant.declines(status: .notDetermined, error: NSError(domain: UNErrorDomain, code: UNError.Code.attachmentInvalidURL.rawValue)))
    }

    private var sources: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/Lifestream")
    }

    func testOnlySystemSettingsQuitIsTheSystemsAndEveryOtherIsThePersons() {
        XCTAssertEqual(QuitSource.classify(shuttingDown: false, quitReason: nil, sender: nil), .user)
        for sender in ["com.apple.dock", "com.apple.osascript", "com.apple.ActivityMonitor", "com.example.other"] {
            XCTAssertEqual(QuitSource.classify(shuttingDown: false, quitReason: nil, sender: sender), .user, sender)
        }
        XCTAssertEqual(QuitSource.classify(shuttingDown: false, quitReason: nil, sender: "com.apple.systempreferences"), .system)
        XCTAssertEqual(QuitSource.classify(shuttingDown: false, quitReason: nil, sender: "com.apple.settings.PrivacySecurity.extension"), .system)
        XCTAssertEqual(QuitDecision.decide(source: .system, screenRecorded: true), .terminateNow)
        XCTAssertEqual(QuitDecision.decide(source: .user, screenRecorded: true), .askFirst)
        XCTAssertEqual(QuitDecision.decide(source: .user, screenRecorded: false), .stopThenTerminate, "asked to keep a recording that never began")
        XCTAssertFalse(QuitDecision.screenRecorded(running: true, state: .permissionRequired), "a recorder waiting for Screen Recording records nothing")
        XCTAssertFalse(QuitDecision.screenRecorded(running: false, state: .stopped))
        for state in [RecorderState.starting, .recording, .waiting, .recovering] {
            XCTAssertTrue(QuitDecision.screenRecorded(running: true, state: state), "\(state)")
        }
        XCTAssertEqual(QuitSource.classify(shuttingDown: false, quitReason: OSType(kAELogOut), sender: "com.apple.loginwindow"), .system)
        XCTAssertEqual(QuitSource.classify(shuttingDown: true, quitReason: nil, sender: "com.apple.dock"), .controlShutdown)
    }

    func testLifestreamIsAnOrdinaryAppFromLaunchToQuit() throws {
        let build = try String(contentsOf: sources.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("build-app.sh"),
                               encoding: .utf8)
        let plist = try XCTUnwrap(build.components(separatedBy: "<<'PLIST'\n").dropFirst().first?.components(separatedBy: "\nPLIST\n").first)
        let info = try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(plist.utf8), format: nil) as? [String: Any])
        XCTAssertEqual(info["CFBundleIdentifier"] as? String, "org.lifestreamprotocol.screen-capture")
        for key in ["LSUIElement", "LSBackgroundOnly"] {
            XCTAssertNil(info[key], "the app is made a menu bar app: \(key)")
        }
        let files = (FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil)?.allObjects as? [URL] ?? [])
            .filter { $0.pathExtension == "swift" }
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            for switching in ["ActivationPolicy", "applicationShouldTerminateAfterLastWindowClosed"] {
                XCTAssertFalse(text.contains(switching), "\(file.lastPathComponent) changes what kind of app Lifestream is: \(switching)")
            }
        }
        let menu = try String(contentsOf: sources.appendingPathComponent("MenuBar/MenuBarApp.swift"), encoding: .utf8)
        XCTAssertTrue(menu.contains("func applicationShouldHandleReopen("), "the Dock icon does not open the window again")
        for name in ["MainWindowController.swift", "RecoveryKeyWindow.swift"] {
            let text = try String(contentsOf: try XCTUnwrap(files.first { $0.lastPathComponent == name }), encoding: .utf8)
            XCTAssertTrue(text.contains("AppActivation.front("), name)
            for own in ["makeKeyAndOrderFront", "showWindow(", "NSApp.activate"] {
                XCTAssertFalse(text.contains(own), "\(name) brings its window forward only through AppActivation.front: \(own)")
            }
        }
    }

    @MainActor func testAWindowComesForwardThenTheAppActivatesAndAPersonsOpenAlwaysShowsOne() {
        let app = RecordedApp()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 100), styleMask: [.titled, .closable],
                              backing: .buffered, defer: true)
        AppActivation.front(window, in: app)
        XCTAssertEqual(app.calls, ["forward", "activate"])

        for world in [done, due] {
            for needs in [false, true] {
                XCTAssertNotNil(LaunchWindow.shown(.byPerson, world: world, open: false, needs: needs, onboarding: false, resume: nil),
                                "a person's open or a click on the Dock icon showed no window")
            }
        }
    }

    func testTheOpenEventSaysALoginLaunch() {
        let open = AEEventID(kAEOpenApplication)
        XCTAssertEqual(LaunchWindow.Opening(eventID: open, propData: nil, restoreState: OSType(kAEYes)), .atLogin)
        XCTAssertEqual(LaunchWindow.Opening(eventID: open, propData: OSType(keyAELaunchedAsLogInItem), restoreState: nil), .atLogin)
        XCTAssertEqual(LaunchWindow.Opening(eventID: open, propData: nil, restoreState: nil), .byPerson)
        XCTAssertEqual(LaunchWindow.Opening(eventID: open, propData: nil, restoreState: OSType(kAENo)), .byPerson)
        XCTAssertEqual(LaunchWindow.Opening(eventID: AEEventID(kAEReopenApplication), propData: nil, restoreState: OSType(kAEYes)), .byPerson)
        XCTAssertEqual(LaunchWindow.Opening(nil), .byPerson)

        func event(restore: Bool) -> NSAppleEventDescriptor {
            let event = NSAppleEventDescriptor(eventClass: AEEventClass(kCoreEventClass), eventID: open,
                                               targetDescriptor: nil, returnID: AEReturnID(kAutoGenerateReturnID),
                                               transactionID: AETransactionID(kAnyTransactionID))
            if restore { event.setParam(NSAppleEventDescriptor(enumCode: OSType(kAEYes)), forKeyword: keyAERestoreAppState) }
            return event
        }
        XCTAssertEqual(LaunchWindow.Opening(event(restore: true)), .atLogin)
        XCTAssertEqual(LaunchWindow.Opening(event(restore: false)), .byPerson)

        XCTAssertEqual(LaunchWindow.Opening(event(restore: false), updated: true), .afterUpdate)
        XCTAssertEqual(LaunchWindow.Opening(event(restore: true), updated: true), .afterUpdate)
        XCTAssertEqual(LaunchWindow.Opening(eventID: AEEventID(kAEReopenApplication), propData: nil, restoreState: nil, updated: true), .byPerson,
                       "the reopen event is the person's")
    }

    func testAnUpdatesMarkIsReadOnceAndOnlyWhileFresh() throws {
        let suite = "LaunchWindowTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertFalse(UpdateRelaunch.take(defaults, now: now), "no update")
        UpdateRelaunch.mark(defaults, at: now)
        XCTAssertTrue(UpdateRelaunch.take(defaults, now: now.addingTimeInterval(5)))
        XCTAssertFalse(UpdateRelaunch.take(defaults, now: now.addingTimeInterval(6)), "read twice")
        UpdateRelaunch.mark(defaults, at: now)
        XCTAssertFalse(UpdateRelaunch.take(defaults, now: now.addingTimeInterval(Resume.fresh + 1)), "a stale mark took over a later open")
        defaults.set(now.timeIntervalSince1970, forKey: UpdateRelaunch.key)
        XCTAssertTrue(UpdateRelaunch.take(defaults, now: now.addingTimeInterval(1)))
    }

    func testWhatThisMacStatesOfEachGrantAndFullDiskAccessIsOffOnlyOnceSeenOn() throws {
        let suite = "LaunchWindowTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        var held: Set<Grant> = [.screenRecording, .microphone]
        let asked: Set<Grant> = [.screenRecording, .microphone, .systemAudio]
        func stated() -> [String: String] {
            Grant.stated(held: { held.contains($0) }, asked: { asked.contains($0) }, defaults: defaults)
        }
        XCTAssertEqual(stated(), ["screenRecording": "on", "accessibility": "not-asked", "microphone": "on", "systemAudio": "off",
                                  "bluetooth": "not-asked", "fullDiskAccess": "not-asked", "photos": "not-asked"],
                       "never seen on, Full Disk Access and Accessibility are not asked; the login item is no grant")
        held.insert(.fullDiskAccess)
        XCTAssertEqual(stated()["fullDiskAccess"], "on")
        XCTAssertEqual(defaults.stringArray(forKey: Grant.seenOnKey), ["fullDiskAccess"])
        held.remove(.fullDiskAccess)
        XCTAssertEqual(stated()["fullDiskAccess"], "off", "seen on, then lost")
        XCTAssertEqual(stated()["accessibility"], "not-asked")
        XCTAssertEqual(defaults.stringArray(forKey: Grant.seenOnKey), ["fullDiskAccess"], "a grant lost stays seen")
    }

    func testTheGrantListHoldsEverythingTheAppAsksFor() {
        XCTAssertEqual(Grant.allCases, [.screenRecording, .accessibility, .microphone, .systemAudio, .bluetooth,
                                        .fullDiskAccess, .photos, .openAtLogin])
        for grant in Grant.allCases where grant != .openAtLogin {
            XCTAssertTrue(grant.pane.absoluteString.hasPrefix("x-apple.systempreferences:com.apple.preference.security?Privacy_"), "\(grant)")
        }
        XCTAssertEqual(Grant.openAtLogin.pane.absoluteString, "x-apple.systempreferences:com.apple.LoginItems-Settings.extension")
        for grant in Grant.allCases { XCTAssertFalse(grant.why.isEmpty) }
    }

    @MainActor func testOneGrantReopensThroughMacOSAndNoGrantNeedsTheDragPanel() throws {
        XCTAssertEqual(Grant.allCases.filter(\.reopens), [.screenRecording])
        XCTAssertEqual(Grant.allCases.filter(\.questioned), [.microphone, .systemAudio, .bluetooth, .photos])
        XCTAssertEqual(Grant.allCases.filter(\.optional), [.bluetooth])
        XCTAssertEqual(Grant.missing([:]), [.screenRecording, .accessibility, .microphone, .systemAudio, .fullDiskAccess, .photos])
        let grants = try String(contentsOf: sources.appendingPathComponent("Connectors/Grants.swift"), encoding: .utf8)
        XCTAssertFalse(grants.contains("restartDue"))
        for grant in Grant.allCases {
            let beside = DragPanel.switchOn(grant, app: URL(fileURLWithPath: "/Applications/Lifestream.app"))
            XCTAssertEqual(beside.beside, SystemSettings.id)
        }
        let app = URL(fileURLWithPath: "/Applications/Lifestream.app")
        for grant in Grant.allCases {
            XCTAssertEqual(DragPanel.switchOn(grant, app: app).lines, ["Find **Lifestream** in this list.", "Turn on its switch."])
        }
        XCTAssertEqual(DragPanel.switchOn(.fullDiskAccess, app: app).after, "If macOS offers to quit Lifestream, choose **Later**.")
        XCTAssertEqual(DragPanel.switchOn(.screenRecording, app: app).after,
                       "When macOS asks, choose **Quit & Reopen**. Lifestream comes back right here.")
        XCTAssertNil(DragPanel.switchOn(.accessibility, app: app).after, "Accessibility is read live: macOS offers no quit")
        let panel = DragPanel.make(DragPanel.switchOn(.accessibility, app: app)) {}
        XCTAssertFalse(panel.styleMask.contains(.titled), "a title bar over the card")
        XCTAssertNil(panel.standardWindowButton(.closeButton), "the window's buttons over the card")
        XCTAssertFalse(panel.isOpaque)
        XCTAssertEqual(panel.frame.width, DragPanelContent.width)
        XCTAssertNil(panel.appearance, "the panel follows the Mac's appearance, light or dark")
    }

    @MainActor func testAGrantsPanelStandsOnlyWithSystemSettingsInFront() async throws {
        final class Front {
            var app: String? = "org.lifestreamprotocol.screen-capture"
            var window: CGRect?
            var looks = 0
        }
        let front = Front()
        let panel = DragPanel(screen: .init(front: { front.app }, window: {
            front.looks += 1
            return front.app == $0 ? front.window : nil
        }, every: .milliseconds(1)))
        func activated() {
            NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.didActivateApplicationNotification, object: nil)
        }
        let app = URL(fileURLWithPath: "/Applications/Lifestream.app")
        panel.show(DragPanel.switchOn(.accessibility, app: app))
        XCTAssertNotNil(panel.shown)
        XCTAssertFalse(panel.standing, "the panel stood before System Settings came in front")
        front.app = SystemSettings.id
        activated()
        XCTAssertFalse(panel.standing, "the panel stood before System Settings' window was on the screen")
        front.window = CGRect(x: 400, y: 200, width: 700, height: 600)
        try await until("panel.standing") { panel.standing }
        front.app = "com.google.Chrome"
        activated()
        XCTAssertFalse(panel.standing, "the panel stayed with another app in front")
        XCTAssertNotNil(panel.shown, "the ask's panel was closed, not put away")
        front.app = SystemSettings.id
        activated()
        XCTAssertTrue(panel.standing, "the panel did not come back with System Settings")
        front.window = nil
        try await until("the panel put away with the window minimised") { !panel.standing }
        XCTAssertNotNil(panel.shown, "the ask's panel was closed, not put away")
        front.window = CGRect(x: 400, y: 200, width: 700, height: 600)
        try await until("the panel back with the window restored") { panel.standing }
        panel.close()
        XCTAssertFalse(panel.standing)
        XCTAssertNil(panel.shown)
        front.window = nil
        panel.show(DragPanel.switchOn(.fullDiskAccess, app: app))
        let asked = front.looks
        try await until("200 looks with no window") { front.looks - asked >= 200 }
        XCTAssertFalse(panel.standing)
        front.window = CGRect(x: 400, y: 200, width: 700, height: 600)
        try await until("the panel beside a late window") { panel.standing }
        panel.close()
    }

    @MainActor func testTheDragPanelFollowsTheMacsAppearance() async throws {
        XCTAssertTrue(Geist.registered, "Geist is not where the app carries it")
        XCTAssertEqual(["Geist-Regular", "Geist-Medium"].compactMap { NSFont(name: $0, size: 13)?.familyName }, ["Geist", "Geist"],
                       "the panel's two faces are not found by name: it would draw the system's font")
        let app = URL(fileURLWithPath: "/Applications/Lifestream.app")
        let kinds: [(String, DragPanel.Content)] = [
            ("full-disk-access", DragPanel.switchOn(.fullDiskAccess, app: app)),
            ("screen-recording", DragPanel.switchOn(.screenRecording, app: app)),
            ("accessibility", DragPanel.switchOn(.accessibility, app: app)),
        ]
        for (name, content) in kinds {
            let size = NSHostingView(rootView: DragPanelContent(content: content)).fittingSize
            XCTAssertEqual(size.width, DragPanelContent.width, name)
            let drawn = try await Shots.draw("drag-panel-\(name)", size: size) { DragPanelContent(content: content) }
            let dark = try Data(contentsOf: drawn[0]), light = try Data(contentsOf: drawn[1])
            XCTAssertNotEqual(dark, light, "\(name): the panel is drawn the same in light and dark: it does not follow the Mac")
            for scale in [1, 2] {
                try await Shots.write(Shots.hosting(DragPanelContent(content: content), size: size), appearance: .darkAqua,
                                      to: "drag-panel-\(name)@\(scale)x.png", scale: CGFloat(scale))
            }
        }
    }
}

@MainActor private final class RecordedApp: ActivatingApp {
    var calls: [String] = []

    func bringForward(_ window: NSWindow) { calls.append("forward") }

    func activate(ignoringOtherApps flag: Bool) { calls.append("activate") }
}
