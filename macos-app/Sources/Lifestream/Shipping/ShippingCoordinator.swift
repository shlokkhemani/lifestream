import AppKit
import Foundation
import HomeLink
import IOKit.ps
import IOKit.pwr_mgt
import MachineEvents
import Passwords
import Shipping
import UserNotifications

@MainActor final class ShippingCoordinator {
    static let launchDelay: TimeInterval = 30
    static let watchInterval: TimeInterval = 60

    nonisolated static func keptOut(pointer: URL = HomeSocket.pointer) -> [URL] {
        HomeSocket.folder(pointer: pointer).map { [$0] } ?? []
    }

    private let shipper: Shipper
    private let link: HomeLink
    private let limits: MacLimits?
    private let notices: Notices
    private let queue = DispatchQueue(label: "org.lifestreamprotocol.shipping")
    private var timer: DispatchSourceTimer?
    private var watch: Timer?
    private var pace = KnockPace()
    private var following: Task<Void, Never>?
    private var judging: Task<Void, Never>?
    private var notice = HomeNotice()
    private(set) var posting: Task<Void, Never>?
    private var wakeObserver: NSObjectProtocol?
    private var stopped = false
    private var owed = false
    private var launch: LaunchReady?

    private(set) var status: ShipperStatus?
    private(set) var running = false
    private var seen: HomeLink.ReachSnapshot?
    var reach: HomeLink.ReachSnapshot { seen ?? HomeLink.ReachSnapshot(reach: .answering, lastReached: nil, revision: 0) }
    var changed: (() -> Void)?

    convenience init(options: Options, scratch: URL, logs: RecorderLogs, link: HomeLink, settings: MacSettings, homeFree: HomeFree, limits: MacLimits,
                     imports: ImportsHeard) {
        let spool = options.directory
        let files = logs.files
        let machineEvents = logs.machineEvents
        let room = ImportRoom(onPower: { !PowerSource.onBattery() }, disk: limits.disk, homeFree: { homeFree.get() })
        let paths = ShippingDomains.conventional(spool: spool, importRoom: room, importTold: imports.told,
                                                 files: files)
        let photos = MacPhotoPass(paths: paths, link: link, settings: settings, disk: limits.disk)
        let state = ShippingState(root: ShippingState.defaultRoot, files: files)
        let stores = DeclaredStores(state: state, mac: paths.stores(lifestream: { ShippingCoordinator.keptOut() }))
        StoreConsentSheets.stores = stores
        self.init(shipper: Shipper(Shipper.Dependencies(
            state: state,
            link: link,
            settings: settings,
            domains: { ShippingDomains.build($0, paths: paths, stores: stores) },
            offers: { ShippingDomains.offers(unit: $0, paths: paths, stores: stores) },
            record: { row in machineEvents.record(shipperRun: row.detail) },
            rotateBatches: { logs.rotate() },
            fullDiskAccess: { paths.fullDiskAccess },
            grants: { Grant.stated() },
            found: { ShippingDomains.found(stores: stores) },
            stores: stores,
            settle: { answer, pressed in await photos.run(answer, pressed: pressed) },
            keepAwake: { KeepAwake.hold() },
            scratch: scratch)), link: link, limits: limits)
    }

    init(shipper: Shipper, link: HomeLink, limits: MacLimits? = nil, notices: Notices = .system,
         explain: (@Sendable () -> HomeLink.Cause?)? = nil) {
        self.shipper = shipper
        self.link = link
        self.limits = limits
        self.notices = notices
        link.probe({ [weak self] _ in await self?.probed() }, explain: explain ?? ReachDiagnosis.explain(link))
    }

    func start(after ready: LaunchReady, delay: TimeInterval) {
        launch = ready
        Task { await refresh() }
        follow()
        Task { [weak self] in
            guard await ready.wait() != .stopped, let self, !self.stopped else { return }
            limits?.start()
            judgeOnMobileChanges()
            wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.rearm() }
                }
            watch = Timer.scheduledTimer(withTimeInterval: Self.watchInterval, repeats: true) { [weak self] _ in
                Task { @MainActor in await self?.watchKnock() }
            }
            Task { await self.knock() }
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            rearm()
        }
    }

    func stop() async {
        stopped = true
        launch?.stop()
        timer?.cancel()
        timer = nil
        watch?.invalidate()
        watch = nil
        following?.cancel()
        following = nil
        judging?.cancel()
        judging = nil
        if let wakeObserver { NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver) }
        wakeObserver = nil
        while running { try? await Task.sleep(for: .milliseconds(100)) }
    }

    @discardableResult
    func shipNow() async -> ShipperReport {
        await run(.manual)
    }

    func refreshNow(_ connector: String) async {
        let sources = await shipper.sources(of: connector)
        guard !sources.isEmpty else { return await runOrOwe() }
        await shipper.ask(sources)
        await run(.now)
    }

    func shipSoon() {
        Task { await run(.timer) }
    }

    func pairSetUp(name: String, code: String) async -> SetupStart.Paired {
        do {
            _ = try await link.pair(code: code, name: name, offers: [])
        } catch {
            return SetupStart.Paired(failed: error)
        }
        await paired()
        return .paired
    }

    func paired() async {
        await shipper.homeChanged()
        await refresh()
        await arm()
    }

    func refresh() async {
        status = await shipper.status()
        changed?()
    }

    private func rearm() {
        Task { await arm() }
    }


    @discardableResult
    func knock() async -> Bool? {
        guard !stopped else { return nil }
        switch await link.probeSoon().reach {
        case .unpaired: return nil
        case .answering: return true
        default: return false
        }
    }

    private func probed() async {
        if let launch, await launch.wait() == .stopped { return }
        guard !stopped else { return }
        defer { Task { await refresh() } }
        pace.sent()
        let answered = await shipper.knock()
        pace.ended()
        if answered == true, timer != nil { await arm() }
    }

    private func judgeOnMobileChanges() {
        guard judging == nil, !stopped else { return }
        let changes = link.mobileChanges()
        judging = Task { [weak self] in
            for await _ in changes {
                guard let self else { return }
                await runOrOwe()
            }
        }
    }

    private func watchKnock() async {
        guard pace.allows(reach.reach) else { return }
        await knock()
    }

    func follow() {
        guard following == nil, !stopped else { return }
        following = Task { [weak self, link] in
            let snapshots = await Task.detached { link.snapshots() }.value
            for await snapshot in snapshots {
                guard let self else { return }
                saw(snapshot)
            }
        }
    }

    func saw(_ snapshot: HomeLink.ReachSnapshot) {
        let before = seen
        seen = snapshot
        if let change = notice.see(snapshot) { tell(change) }
        if let before, snapshot.revision > before.revision { Task { await runOrOwe() } }
        if snapshot != before { changed?() }
    }

    nonisolated static let notification = "home-silent"

    struct Notices {
        let ask: @MainActor () async -> Bool
        let post: @MainActor (UNNotificationRequest) -> Void
        let remove: @MainActor () -> Void

        static let system = Notices(
            ask: { await NotificationGrant.ask() },
            post: { UNUserNotificationCenter.current().add($0) },
            remove: {
                guard Bundle.main.bundleIdentifier != nil else { return }
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [ShippingCoordinator.notification])
            })
    }

    private func tell(_ change: HomeNotice.Change) {
        switch change {
        case .remove:
            notices.remove()
        case .post(let episode, let title, let body):
            posting = Task { [notices] in
                guard await notices.ask(), notice.posted == episode else { return }
                let content = UNMutableNotificationContent()
                content.title = title
                content.body = body
                notices.post(UNNotificationRequest(identifier: Self.notification, content: content, trigger: nil))
            }
        }
    }


    private func arm() async {
        guard !stopped else { return }
        let next = await shipper.nextRun(after: Date())
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(wallDeadline: .now() + max(0, next.timeIntervalSinceNow), leeway: .seconds(5))
        timer.setEventHandler { [weak self] in
            Task(priority: .background) { @MainActor in await self?.fire() }
        }
        self.timer?.cancel()
        self.timer = timer
        timer.resume()
    }

    private func fire() async {
        let now = Date()
        guard await shipper.nextRun(after: now) <= now else {
            await arm()
            return
        }
        await run(.timer)
    }

    private func runOrOwe() async {
        if running { owed = true } else { await run(.timer) }
    }

    @discardableResult
    private func run(_ trigger: ShipTrigger) async -> ShipperReport {
        guard !running, !stopped else { return ShipperReport(rows: [], outcome: "busy") }
        running = true
        changed?()
        let report = await shipper.run(trigger)
        running = false
        await refresh()
        if owed {
            owed = false
            Task { await run(.timer) }
        }
        await arm()
        return report
    }
}

struct HomeNotice: Equatable {
    enum Change: Equatable {
        case post(episode: Int, title: String, body: String)
        case remove
    }

    private(set) var posted: Int?
    private(set) var reconciled = false

    mutating func see(_ snapshot: HomeLink.ReachSnapshot) -> Change? {
        if case .waiting = snapshot.reach, snapshot.episode?.told == nil { return nil }
        defer { reconciled = true }
        if let episode = snapshot.episode, episode.ended == nil, let told = episode.told,
           let words = ReachWords.notification(told, device: .mac) {
            guard posted != episode.id else { return nil }
            posted = episode.id
            return .post(episode: episode.id, title: words.title, body: words.body)
        }
        guard posted != nil || !reconciled else { return nil }
        posted = nil
        return .remove
    }
}

struct KnockPace: Equatable {
    private(set) var inFlight = false

    func allows(_ reach: HomeLink.Reach) -> Bool { !inFlight && reach == .answering }

    mutating func sent() { inFlight = true }

    mutating func ended() { inFlight = false }
}

enum KeepAwake {
    static func hold() -> @Sendable () -> Void {
        var id = IOPMAssertionID(0)
        let made = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn),
                                               "Lifestream is sending your files" as CFString, &id)
        guard made == kIOReturnSuccess else { return {} }
        let held = id
        return { IOPMAssertionRelease(held) }
    }
}

final class HomeFree: @unchecked Sendable {
    private let lock = NSLock()
    private var bytes: Int64?
    private var mostBytes: Int64?

    func set(free: Int64?, most: Int64?) {
        lock.withLock {
            if let free { bytes = free }
            if let most { mostBytes = most }
        }
    }

    func get() -> Int64? { lock.withLock { bytes } }
    func most() -> Int64? { lock.withLock { mostBytes } }
}

enum PowerSource {
    static func onBattery() -> Bool {
        let snapshot = IOPSCopyPowerSourcesInfo()?.takeRetainedValue()
        let source = snapshot.flatMap { IOPSGetProvidingPowerSourceType($0)?.takeUnretainedValue() as String? }
        return source == kIOPSBatteryPowerValue
    }
}
