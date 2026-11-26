import Combine
import Foundation
import HomeLink
import LifestreamCaptureCore
import SwiftUI
import UIKit
import UserNotifications

@MainActor
final class AppRuntime: ObservableObject {
    static let shared = AppRuntime()

    nonisolated static let supportRoot = URL.applicationSupportDirectory.appendingPathComponent("LifestreamCapture", isDirectory: true)

    #if DEBUG || SPEED
    nonisolated static let isUITesting = ProcessInfo.processInfo.arguments.contains("--ui-testing")
    #else
    nonisolated static let isUITesting = false
    #endif

    nonisolated static func asked(_ flag: String) -> Bool {
        isUITesting && ProcessInfo.processInfo.arguments.contains(flag)
    }

    static var runsStill: Bool { isUITesting && SpeedLog.shared == nil && !asked("--ui-test-moving") }

    let root: URL
    let captureStore: CaptureStore
    let intentStore: TrackingIntentStore
    let exporter: CaptureExporter
    let firstRun: FirstRunRecord
    @Published private(set) var restoreLanded: Date?
    let processInstanceID: UUID
    let locationRecorder: LocationRecorderCoordinator
    private var launch: Task<Void, Never>?
    private let gatedCommands = MainActorTaskQueue()
    lazy var placesBook = PlacesBook(folder: root.appendingPathComponent(DisplayCaches.places, isDirectory: true), link: shipping.link)
    lazy var life: LifeReader = LifeReader(link: shipping.link)
    lazy var reach = HomeReach(link: shipping.link)
    lazy var pages = PageShelf(root: root, link: shipping.link)

    lazy var agents = AgentAsks(link: shipping.link, pages: pages, paired: { [unowned self] in self.shipping.shipper.paired })

    lazy var homeStreams = HomeConnectorsModel()

    func forgetHomeReads() {
        HomeClock.current.adopt(shipping.link.keptClock)
        life.forget()
        homeStreams.forget()
        DaysModel.shared.forget()
        PeopleBook.shared.forget()
        PeopleTabModel.shared.forget()
        Task { [pages] in await pages.empty() }
        PersonModel.forgetAll()
        HomePictures.shared.forget()
        FaceShelf.shared.forget()
        SearchModel.shared.forget()
        AskBook.shared.forget()
        agents.forget()
    }

    private func shedHomeReads() {
        DaysModel.shared.shed()
        PersonModel.shed()
        HomePictures.shared.forget()
    }
    lazy var contactsRecorder = ContactsRecorder(
        store: captureStore, source: AppleContactSource(),
        beforeCapture: { [weak self] in
            guard let self else { throw CancellationError() }
            try await self.launched()
        })
    lazy var machineDiary = MachineDiary(store: captureStore, beforeCapture: { [weak self] in
        guard let self else { throw CancellationError() }
        try await self.launched()
    })
    lazy var checkInNotifications: CheckInNotifications = CheckInNotifications { [weak self] id, event, date in
        guard let self else { return }
        await self.checkInRecorder.event(promptID: id, event: event, at: date)
    }
    lazy var checkInRecorder: CheckInRecorder = CheckInRecorder(
        store: captureStore,
        notifications: Self.isUITesting
            ? TestCheckInNotifications() : checkInNotifications,
        stateURL: root.appendingPathComponent("checkin-schedule.json"),
        beforeCapture: { [weak self] in
            guard let self else { throw CancellationError() }
            try await self.launched()
        })
    lazy var checkInModel = makeCheckInModel()
    lazy var settings = PhoneSettings(
        queue: SettingsQueue(file: exporter.exportsDirectory.deletingLastPathComponent().appendingPathComponent("settings-queue.json")),
        link: { [unowned self] in self.shipping.link }, location: locationRecorder, checkIns: checkInModel)
    lazy var notes = makeNotes()
    lazy var notesShipping = NotesShipping(capture: captureStore)
    private func makeNotes() -> NotesController {
        let controller = NotesController()
        if let store = controller.store {
            store.saved = { [weak self] in self?.notesShipping.changed(store) }
        }
        return controller
    }
    private var restoring = false
    private func makeCheckInModel() -> CheckInModel {
        let health = healthRecorder
        return CheckInModel(recorder: checkInRecorder, healthWake: {
            guard !Self.isUITesting else { return nil }
            return await health.newestCheckInWake(now: AppClock.now)
        })
    }
    func wakeCheckIns() {
        if !Self.isUITesting { _ = checkInNotifications }
        #if DEBUG
        if Self.isUITesting,
           ProcessInfo.processInfo.arguments.contains("--ui-test-system-notification") { _ = checkInNotifications }
        #endif
        Task { await refreshCheckIns() }
    }

    func refreshCheckIns() async {
        guard (try? await launched()) != nil else { return }
        await checkInModel.refresh()
    }

    func scenePhaseChanged(from old: ScenePhase, to new: ScenePhase) {
        if old == .background, new != .background {
            recordLifecycle("will_enter_foreground")
            sweepMotionOnForegroundWake()
            AskBook.shared.cameBack()
        }
        if old == .active, new != .active {
            EnergyLedger.shared.hold("foreground", setting: nil)
        }
        switch new {
        case .active:
            markOnScreen(true)
            HomeClock.current.inFront()
            shipping.link.inFront(true)
            agents.cameToFront()
            Task { await restoreIfOwed() }
            EnergyLedger.shared.hold("foreground", setting: "active")
            resumeSensorsWhenActive()
            refreshUsage(.foreground)
            wakeCheckIns()
            shipping.cameToFront()
        case .background:
            markOnScreen(false)
            shipping.link.inFront(false)
            agents.wentToBackground()
            recordLifecycle("entered_background")
            shipping.wentToBackground()
            Task { await EnergyLedger.shared.flush() }
        default:
            break
        }
    }
    lazy var shipping = ShippingService(runtime: self)
    lazy var captureStateMonitor = CaptureStateMonitor(locationRecorder: locationRecorder)
    lazy var healthRecorder = HealthRecorder(store: captureStore, start: start(of: .health),
                                             mobile: { [link = shipping.link] in link.mobile(pressed: false) })
    lazy var motionRecorder = MotionRecorder(
        store: captureStore, locationRecorder: locationRecorder, start: start(of: .motion))
    lazy var cameraRecorder = CameraRecorder(
        store: captureStore, locationRecorder: locationRecorder,
        authorizeWrite: { [weak self] in
            guard let self else { throw CaptureError.corruptState("capture runtime is unavailable") }
            try await self.launched()
        })
    lazy var voiceRecorder = VoiceRecorder(
        store: captureStore, locationRecorder: locationRecorder,
        authorizeWrite: { [weak self] in
            guard let self else { throw CaptureError.corruptState("capture runtime is unavailable") }
            try await self.launched()
        })

    #if SCREEN_TIME
    private static let usageSource: any UsageActivitySource = AppleUsageActivitySource()
    #else
    private static let usageSource: any UsageActivitySource = NoScreenTimeUsageSource()
    #endif
    lazy var usageRecorder = UsageRecorder(
        store: captureStore, source: Self.usageSource,
        cursorURL: root.appendingPathComponent("usage-refresh.json"),
        inbox: FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: AppGroup.identifier
        ).map { UsageInbox(directory: $0.appendingPathComponent("usage-inbox", isDirectory: true)) },
        start: start(of: .screenTime),
        admit: { [weak self] in
            guard let self else { throw CaptureError.corruptState("Capture runtime is unavailable") }
            try await self.launched()
        })

    private func start(of source: PhoneSource) -> @Sendable @MainActor () -> Date? {
        { [unowned self] in PhoneSettings.start(of: source, in: self.shipping.link.saved?.settings) }
    }

    private static func keepOutOfBackups(root: URL, appGroup: String) {
        Task.detached(priority: .background) {
            DisplayCaches.assert(root: root)
            guard let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return }
            for inbox in ["upload-inbox", "usage-inbox"] {
                let folder = group.appendingPathComponent(inbox, isDirectory: true)
                if FileManager.default.fileExists(atPath: folder.path) { try? FileDurability.excludeFromBackup(folder) }
            }
        }
    }

    #if ONBOARDING
    private static func forgetEverything(exports: URL) {
        try? HomeLink(device: PhoneLink.device(), folder: exports).forget()
    }
    #endif

    private init() {
        EnergyLedger.shared.configure(
            signposts: MetricKitSignposts(),
            build: Bundle.main.object(forInfoDictionaryKey: "LifestreamCommit") as? String ?? "unknown")
        do {
            root = Self.supportRoot
            #if ONBOARDING
                if ProcessInfo.processInfo.arguments.contains("--forget-everything") {
                    Self.forgetEverything(exports: root.appendingPathComponent("exports", isDirectory: true))
                }
            #endif
            #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--ui-test-reset") {
                    try FileDurability.removePrivateDirectoryIfPresent(at: root)
                    if let domain = Bundle.main.bundleIdentifier {
                        UserDefaults.standard.removePersistentDomain(forName: domain)
                    }
                }
            #endif
            try FileDurability.createDirectoryDurably(at: root)
            try FileDurability.excludeFromBackup(root)
            Self.keepOutOfBackups(root: root, appGroup: AppGroup.identifier)
            processInstanceID = UUID()
            captureStore = try CaptureStore(
                root: root.appendingPathComponent("capture", isDirectory: true),
                processInstanceID: processInstanceID
            )
            intentStore = TrackingIntentStore(
                url: root.appendingPathComponent("tracking-intent.json"))
            exporter = CaptureExporter(
                store: captureStore,
                exportsDirectory: root.appendingPathComponent("exports", isDirectory: true)
            )
            firstRun = FirstRunRecord(store: captureStore)
            #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--ui-test-started") { firstRun.start() }
            #endif
            locationRecorder = LocationRecorderCoordinator(
                store: captureStore,
                intentStore: intentStore,
                bootID: SystemBootSession.current(),
                platformServicesEnabled: !Self.isUITesting
            )
            locationRecorder.bootstrap()
        } catch {
            fatalError("A store that would not open while protected data was available: \(error)")
        }
    }

    func bootstrap(launchOptions: [UIApplication.LaunchOptionsKey: Any]?) {
        NotePlayer.clear()
        NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil,
                                               queue: .main) { _ in MainActor.assumeIsolated { AppRuntime.shared.shedHomeReads() } }
        let launchLocationHintExposed = launchOptions?[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsLocationKey")] != nil
        if UIApplication.shared.applicationState == .background {
            EnergyLedger.shared.wake(launchLocationHintExposed ? "launch_location" : "launch")
        }
        let store = captureStore
        let previousRun = previousRunEndedOnScreen()
        let paired = shipping.shipper.paired
        launch = Task { [locationRecorder] in
            await store.setPaired(paired)
            #if DEBUG
            if Self.isUITesting {
                try? await store.restore(Restore(pass: "ui-test", unit: "ui-test"), pass: "ui-test")
            }
            #endif
            await locationRecorder.awaitBootstrapBarrier()
            _ = try? await store.append(
                domain: .location,
                draft: .init(
                    kind: "lifecycle",
                    observedAt: CaptureTime.rfc3339(AppClock.now),
                    payload: .object([
                        "event": .string("process_launch"),
                        "launch_location_hint_exposed": .bool(launchLocationHintExposed),
                    ])
                )
            )
            try? await StorageProbe.stateLockedLaunches(root: Self.supportRoot, into: store, now: AppClock.now)
            if let previousRun {
                _ = try? await store.append(domain: .location, draft: .init(
                    kind: "lifecycle", observedAt: CaptureTime.rfc3339(AppClock.now),
                    payload: .object(["event": .string("previous_run_ended_on_screen"), "on_screen_since": .string(previousRun)])))
            }
            EnergyLedger.shared.attach(store, levels: (try? await store.levels()) ?? [:])
        }
        refreshUsage(.background)
        locationRecorder.onEvent = { [weak self] event in self?.shipping.shipper.tell(event) }
        shipping.registerBackgroundSync()
        shipping.start()
        shipping.shipper.ask(.wake)
        Task {
            await launch?.value
            try? KeychainCredentials(service: "org.lifestreamprotocol.phone.google-places", account: "key").delete()
            await restoreIfOwed()
            if let notes = notes.store { try? await notesShipping.carry(notes) }
            guard !Self.isUITesting else { return }
            captureStateMonitor.start()
            await motionRecorder.bootstrapAfterLocation()
            await healthRecorder.bootstrapAfterLocation()
        }
    }


    func restoreIfOwed() async {
        guard !restoring, !Self.isUITesting else { return }
        restoring = true
        defer { restoring = false }
        guard (try? await launched()) != nil else { return }
        let link = shipping.link
        await shipping.shipper.reread()
        guard shipping.shipper.paired else { return }
        var restoredNow = false
        do {
            if !(await captureStore.isRestored) {
                let restore = try await link.restore()
                try await captureStore.restore(restore, pass: restore.pass)
                restoredNow = true
                restoreLanded = AppClock.now
            }
            if let store = notes.store, try await notesShipping.rebuildIfOwed(store, blob: { try await link.blob($0) }) {
                notes.objectWillChange.send()
            }
        } catch LinkFailure.refused(401, let code, _) {
            await shipping.shipper.refused(code)
            return
        } catch LinkFailure.unavailable(_, _, let retryAfter, _) {
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(max(retryAfter ?? 30, 5)))
                await self?.restoreIfOwed()
            }
            return
        } catch {
            return
        }
        guard restoredNow else { return }
        await refreshCheckIns()
        await motionRecorder.bootstrapAfterLocation()
        await healthRecorder.restored()
        shipping.shipper.ask(.wake)
    }

    func stopRecordingForGood() async {
        try? await captureStore.markStopped(at: AppClock.now)
        try? locationRecorder.disarm(reason: "replaced")
        await motionRecorder.stopLiveUpdates()
        await healthRecorder.stopObserving()
        #if SCREEN_TIME
        try? UsageMonitorManager().stop()
        #endif
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
    }

    private var onScreenURL: URL { root.appendingPathComponent("on-screen.json") }

    private func markOnScreen(_ on: Bool) {
        if on {
            try? Data(CaptureTime.rfc3339(AppClock.now).utf8).write(to: onScreenURL, options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: onScreenURL)
        }
    }

    private func previousRunEndedOnScreen() -> String? {
        defer { try? FileManager.default.removeItem(at: onScreenURL) }
        return (try? Data(contentsOf: onScreenURL)).map { String(decoding: $0, as: UTF8.self) }
    }

    func launched() async throws {
        guard let launch else {
            throw CaptureError.corruptState("Open Lifestream once before running this capture action")
        }
        await launch.value
    }

    func refreshUsage(_ reason: UsageRefreshReason) {
        Task {
            guard (try? await launched()) != nil else { return }
            _ = await usageRecorder.refresh(reason)
        }
    }

    func sweepHistoriesInBackground() async {
        guard (try? await launched()) != nil else { return }
        _ = await usageRecorder.refresh(.background)
        guard !Self.isUITesting, !Task.isCancelled else { return }
        await motionRecorder.bootstrapAfterLocation()
    }

    func sweepMotionOnForegroundWake() {
        Task {
            guard (try? await launched()) != nil, !Self.isUITesting else { return }
            await motionRecorder.bootstrapAfterLocation()
        }
    }

    func resumeSensorsWhenActive() {
        Task {
            guard (try? await launched()) != nil, !Self.isUITesting else { return }
            async let health: Void = healthRecorder.resumeIfAsked()
            async let motion: Void = motionRecorder.bootstrapAfterLocation()
            _ = await (health, motion)
        }
    }

    func startCapture() async throws {
        try await launched()
        try locationRecorder.restoreOrArm()
        guard !Self.isUITesting else { return }
        captureStateMonitor.start()
    }

    func recordLifecycle(_ event: String) {
        let observedAt = CaptureTime.rfc3339(AppClock.now)
        enqueueGatedCommand { [self] in
            self.locationRecorder.recordLifecycle(event, observedAt: observedAt)
        }
    }

    func protectedDataDidBecomeAvailable() {
        enqueueGatedCommand { [self] in
            self.locationRecorder.protectedDataDidBecomeAvailable()
        }
    }

    func recordExperimentMarker(
        _ marker: String,
        observedAt: String
    ) async throws {
        try await performGatedCommand { [self] in
            try await self.locationRecorder.recordExperimentMarker(
                marker,
                observedAt: observedAt
            )
        }
    }

    private func enqueueGatedCommand(
        _ operation: @escaping @MainActor () throws -> Void
    ) {
        gatedCommands.enqueue { [self] in
            do {
                try await self.launched()
                try operation()
            } catch {
            }
        }
    }

    private func performGatedCommand(
        _ operation: @escaping @MainActor () async throws -> Void
    ) async throws {
        try await gatedCommands.perform { [self] in
            try await self.launched()
            try await operation()
        }
    }
}

@MainActor
final class HomeReach: ObservableObject {
    @Published private(set) var snapshot: HomeLink.ReachSnapshot

    init(link: HomeLink) {
        snapshot = link.snapshot
        Task { [weak self] in
            for await snapshot in link.snapshots() {
                guard let self else { return }
                if Self.drawn(snapshot) != Self.drawn(self.snapshot) { self.snapshot = snapshot }
            }
        }
    }

    func redraw() {
        objectWillChange.send()
    }

    var lacks: Bool { Self.lacks(snapshot.reach) }

    static func lacks(_ reach: HomeLink.Reach) -> Bool {
        switch reach {
        case .answering, .waiting, .starting: false
        default: true
        }
    }

    private static func drawn(_ snapshot: HomeLink.ReachSnapshot) -> HomeLink.ReachSnapshot {
        snapshot.reached(snapshot.lastReached.map { Date(timeIntervalSince1970: ($0.timeIntervalSince1970 / 60).rounded(.down) * 60) })
    }
}
