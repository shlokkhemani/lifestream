import AppKit
import HomeLink
import Shipping
import Sparkle

@MainActor
final class Updates: NSObject {
    static let installsAutomaticallyKey = "InstallUpdatesAutomatically"
    static let whatsNewKey = "WhatsNew"
    static let whatsNewFor: TimeInterval = 24 * 3600
    static let waitsFor: TimeInterval = 24 * 3600
    var locked: () -> Bool = ScreenLock.now
    var mobile: () -> MobileData.Moment = {
        MacLink.shared?.mobile(pressed: false) ?? Updates.unlinked(SystemNetwork.shared.facts)
    }
    var now: () -> Date = Date.init
    var after: (TimeInterval, @escaping @MainActor () -> Void) -> Void = { delay, work in
        DispatchQueue.main.asyncAfter(wallDeadline: .now() + delay) { MainActor.assumeIsolated(work) }
    }
    private let defaults: UserDefaults
    private var controller: SPUStandardUpdaterController?
    private var install: (() -> Void)?
    private var ready: (version: String, since: Date)?
    private(set) var relaunching = false
    var changed: (() -> Void)?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        defaults.register(defaults: [Self.installsAutomaticallyKey: true])
    }

    func start(bundle: Bundle = .main) {
        guard controller == nil, bundle.object(forInfoDictionaryKey: "SUFeedURL") != nil else { return }
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: self)
        DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.screenLocked() }
        }
    }

    var available: Bool { controller != nil }

    var installsAutomatically: Bool {
        get { defaults.bool(forKey: Self.installsAutomaticallyKey) }
        set {
            defaults.set(newValue, forKey: Self.installsAutomaticallyKey)
            changed?()
        }
    }

    var holding: String? { ready?.version }

    var waiting: String? {
        guard let ready, !installsAutomatically || now().timeIntervalSince(ready.since) >= Self.waitsFor else { return nil }
        return ready.version
    }

    func screenLocked() {
        installIfEligible()
    }

    @discardableResult private func installIfEligible() -> Bool {
        guard installsAutomatically, locked() else { return false }
        restart()
        return true
    }

    func downloaded(_ version: String, note: String? = nil, install: @escaping () -> Void) {
        defaults.set(["version": version, "note": note ?? ""], forKey: Self.whatsNewKey)
        self.install = install
        if installIfEligible() {
            self.install = nil
            return
        }
        ready = (version, now())
        after(Self.waitsFor) { [weak self] in self?.changed?() }
        changed?()
    }

    func aborted(_ error: Error) {
        guard (error as NSError) != Self.deferred else { return }
        abandoned()
    }

    func abandoned() {
        guard ready != nil || install != nil else { return }
        ready = nil
        install = nil
        changed?()
    }

    func whatsNew(running version: String, now: Date = Date()) -> String? {
        guard var kept = defaults.dictionary(forKey: Self.whatsNewKey), kept["version"] as? String == version,
              let note = kept["note"] as? String, !note.isEmpty else { return nil }
        guard let first = kept["first"] as? Date else {
            kept["first"] = now
            defaults.set(kept, forKey: Self.whatsNewKey)
            return "What's new in \(version): \(note)"
        }
        return now.timeIntervalSince(first) < Self.whatsNewFor ? "What's new in \(version): \(note)" : nil
    }

    func restart() {
        install?()
    }

    func checkForUpdates() {
        NSApp.activate(ignoringOtherApps: true)
        controller?.checkForUpdates(nil)
    }

    func mayCheck(_ check: SPUUpdateCheck) throws {
        guard check == .updatesInBackground, ready == nil, !mobile().internet.past.moves else { return }
        throw Self.deferred
    }

    nonisolated static func unlinked(_ facts: NetworkFacts?) -> MobileData.Moment {
        MobileData.Moment(path: facts?.cost ?? .costly, choice: .now, loopback: false, pressed: false)
    }

    static let deferred = NSError(domain: "org.lifestreamprotocol.updates", code: 1,
                                  userInfo: [NSLocalizedDescriptionKey: "The update waits for a network that costs nothing"])
}

extension Updates: SPUUpdaterDelegate {

    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
                 immediateInstallationBlock immediateInstallHandler: @escaping () -> Void) -> Bool {
        downloaded(item.displayVersionString, note: item.itemDescription.map(Self.plain), install: immediateInstallHandler)
        return true
    }

    func updater(_ updater: SPUUpdater, mayPerform updateCheck: SPUUpdateCheck) throws {
        try mayCheck(updateCheck)
    }

    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        aborted(error)
    }

    func updaterWillRelaunchApplication(_ updater: SPUUpdater) {
        relaunching = true
        UpdateRelaunch.mark(defaults)
    }
}

extension Updates {
    nonisolated static func plain(_ described: String) -> String {
        described.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}

enum ScreenLock {
    static func now() -> Bool {
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        return session?["CGSSessionScreenIsLocked"] as? Bool == true
    }
}

extension Updates: SPUStandardUserDriverDelegate {
    nonisolated var supportsGentleScheduledUpdateReminders: Bool { true }
}
