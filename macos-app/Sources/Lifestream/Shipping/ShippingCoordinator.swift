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
    let staged: StagedUploadWorker
    private(set) var peer: MacPeerClient?
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
    private var sleepObserver: NSObjectProtocol?
    private var stopped = false
    private var owed = false
    private var owedAll = false
    private var owedSources: Set<String> = []
    private var requeued: Set<String> = []
    private var launch: LaunchReady?
    private let photos: MacPhotoPass?
    private let stores: DeclaredStores?
    private let uploadFolder: URL?
    private let clock: @Sendable () -> Date
    private let power: @Sendable () -> PowerMode
    private var watcher: StoreWatcher?
    private var coalescer = WakeCoalescer()
    private var wakeTimer: DispatchSourceTimer?
    private var sweep: Timer?
    private var powerObserver: NSObjectProtocol?
    private var powerSource: PowerSourceWatch?
    private var lastPower: PowerMode?
    private var watchedKey: WatchKey?
    private var watching: Task<Void, Never>?
    private var baselined: Task<Void, Never>?

    private(set) var status: ShipperStatus?
    private(set) var running = false
    private var flushes = 0
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
        let staged = StagedUploadWorker(link: link)
        self.init(shipper: Shipper(Shipper.Dependencies(
            state: state,
            link: link,
            settings: settings,
            domains: { ShippingDomains.build($0, paths: paths, stores: stores) },
            offers: { ShippingDomains.offers(unit: $0, paths: paths, stores: stores) },
            record: { row in machineEvents.record(shipperRun: row.detail) },
            rotateBatch: { logs.rotate($0) },
            fullDiskAccess: { paths.fullDiskAccess },
            grants: { Grant.stated() },
            found: { ShippingDomains.found(stores: stores) },
            stores: stores,
            settle: { answer, pressed in await photos.run(answer, pressed: pressed) },
            keepAwake: { KeepAwake.hold() },
            onFilesMissing: { source, hexes in staged.invalidate(source: source, sha256s: hexes) },
            staged: { source in
                StagedBlobs(isReady: { staged.isReady(source: source, sha256: $0) },
                            enqueue: { sha256, url, bytes, kept, kind in
                                staged.enqueue(source: source, sha256: sha256, url: url, bytes: bytes, kept: kept, kind: kind)
                            })
            },
            onStagedConsumed: { source, hexes in Task { await staged.markConsumed(source: source, sha256s: hexes) } },
            coldInterval: { PowerSource.onBattery() ? 4 * 3_600 : 3_600 },
            scratch: scratch)), link: link, limits: limits, staged: staged, dials: true, photos: photos, stores: stores,
                  uploadFolder: paths.uploadFolder)
    }

    init(shipper: Shipper, link: HomeLink, limits: MacLimits? = nil, notices: Notices = .system,
         explain: (@Sendable () -> HomeLink.Cause?)? = nil, staged: StagedUploadWorker? = nil, dials: Bool = false,
         photos: MacPhotoPass? = nil, stores: DeclaredStores? = nil, uploadFolder: URL? = nil,
         clock: @escaping @Sendable () -> Date = { Date() }, power: @escaping @Sendable () -> PowerMode = { PowerMode.current() }) {
        self.shipper = shipper
        self.link = link
        self.limits = limits
        self.notices = notices
        self.photos = photos
        self.stores = stores
        self.uploadFolder = uploadFolder
        self.clock = clock
        self.power = power
        self.staged = staged ?? StagedUploadWorker(link: link)
        link.probe({ [weak self] _ in await self?.probed() }, explain: explain ?? ReachDiagnosis.explain(link))
        self.staged.onReady { [weak self] source in
            Task { @MainActor in await self?.stagedReady(source) }
        }
        if dials { peer = MacPeerClient(link: link, handlers: handlers()) }
    }

    private func handlers() -> MacPeerClient.Handlers {
        MacPeerClient.Handlers(
            sources: { [link] in (link.fresh?.sources ?? link.saved?.sources).map { $0.keys.sorted() } ?? [] },
            onRefresh: { [weak self] connector in await self?.homeRefreshes(connector) },
            onSettings: { [weak self] in await self?.settingsChanged() },
            onFlush: { [weak self] sources, budgetMs in await self?.flush(sources, budgetMs: budgetMs).seals ?? [:] })
    }

    private func stagedReady(_ source: String) async {
        await shipper.clearFilesMissingHold(for: source)
        noteChanged(sources: [source])
    }

    private var stated: [String] {
        (link.fresh?.sources ?? link.saved?.sources).map { Array($0.keys) } ?? []
    }

    func noteChanged(product: String) {
        noteChanged(sources: Set(stated.filter { ShippingDomains.product(of: $0) == product }))
    }

    func noteChanged(sources: Set<String>) {
        guard !stopped, !sources.isEmpty else { return }
        requeued.subtract(sources)
        coalescer.note(sources, at: clock())
        armWake()
    }

    private func armWake() {
        wakeTimer?.cancel()
        wakeTimer = nil
        guard !stopped, let next = coalescer.nextDeadline(power: power()) else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(wallDeadline: .now() + max(0, next.timeIntervalSince(clock())), leeway: .milliseconds(100))
        timer.setEventHandler { [weak self] in
            Task { @MainActor in await self?.wake() }
        }
        wakeTimer = timer
        timer.resume()
    }

    func wake() async {
        let due = coalescer.takeDue(at: clock(), power: power())
        armWake()
        guard !due.isEmpty else { return }
        await run(.timer, due: due)
    }

    func watch() async {
        guard !stopped, watcher == nil else { return }
        startWatching()
        await baselined?.value
    }

    private func startWatching() {
        let watcher = StoreWatcher(onChange: { [weak self] sources in
            Task { @MainActor in self?.noteChanged(sources: sources) }
        }, onOverflow: { [weak self] in
            Task { @MainActor in self?.swept(overflowed: true) }
        })
        self.watcher = watcher
        let first = watched()
        baselined = Task.detached(priority: .utility) {
            await first?.value
            _ = watcher.changedByStamp()
        }
        photos?.startObserving { [weak self] in
            Task { @MainActor in self?.noteChanged(product: String(Shipper.photos)) }
        }
        powerObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name.NSProcessInfoPowerStateDidChange, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.powerChanged() }
            }
        lastPower = power()
        powerSource = PowerSourceWatch { [weak self] in self?.powerChanged() }
        armSweep()
    }

    private func powerChanged() {
        let now = power()
        guard now != lastPower else { return }
        lastPower = now
        armWake()
        armSweep()
    }

    func storesChanged() {
        watched()
    }

    private struct WatchKey: Equatable, Sendable {
        let sources: Set<String>
        let stores: HomeLink.StoresStated?
    }

    @discardableResult
    private func watched() -> Task<Void, Never>? {
        guard let watcher, !stopped else { return nil }
        let sources = stated
        let stores = self.stores, folder = uploadFolder
        let previous = watching
        let next = Task { [weak self] in
            await previous?.value
            guard let self, !self.stopped else { return }
            let last = watchedKey
            let taken = await Task.detached(priority: .utility) { () -> WatchKey? in
                let key = WatchKey(sources: Set(sources), stores: stores?.stated())
                guard key != last else { return nil }
                watcher.update(sources: sources, stores: stores, uploadFolder: folder)
                return key
            }.value
            if let taken { watchedKey = taken }
        }
        watching = next
        return next
    }

    private func armSweep() {
        sweep?.invalidate()
        sweep = nil
        guard !stopped, watcher != nil else { return }
        sweep = Timer.scheduledTimer(withTimeInterval: WakeCoalescer.sweepInterval(power()), repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.swept(overflowed: false)
                self?.armSweep()
            }
        }
    }

    private func swept(overflowed: Bool) {
        guard let watcher else { return }
        let changed = watcher.changedByStamp()
        noteChanged(sources: overflowed ? changed.union(watcher.unstamped) : changed)
    }

    private func settingsChanged() async {
        _ = try? await link.exchange()
        await runOrOwe()
    }

    func flush(_ sources: [String]?, budgetMs: Int) async -> Shipper.FlushResult {
        guard !stopped else { return Shipper.FlushResult() }
        let wanted: Set<String>
        if let sources {
            wanted = Set(sources)
        } else {
            let stamped = (watcher?.changedByStamp() ?? []).filter { WakeCoalescer.streamClass(of: $0).fast }
            coalescer.note(stamped, at: clock())
            wanted = coalescer.dirtyFastSources()
            guard !wanted.isEmpty else { return Shipper.FlushResult() }
        }
        flushes += 1
        let started = clock()
        let stamps = watcher?.stamps(of: wanted)
        let result = await shipper.flush(sources: wanted, budget: TimeInterval(budgetMs) / 1000)
        flushes -= 1
        if let stamps { watcher?.keep(stamps.filter { result.ran.contains($0.key) }) }
        let again = result.unrotated.union(result.unsettled)
        coalescer.clear(result.ran.subtracting(again), heardBy: started)
        requeue(again, ran: result.ran)
        armWake()
        Task { await flushed() }
        return result
    }

    private func flushed() async {
        if let pass = link.saved?.pass { await staged.reset(pass: pass) }
        await refresh()
        if !running, flushes == 0, !stopped { runOwed() }
        await arm()
    }

    private func requeue(_ owedAgain: Set<String>, ran: Set<String>) {
        let again = owedAgain.subtracting(requeued)
        requeued.subtract(ran.union(owedAgain))
        requeued.formUnion(again)
        guard !again.isEmpty else { return }
        coalescer.requeue(again, at: clock())
    }

    private func owe(_ due: Set<String>?) {
        owed = true
        if let due { owedSources.formUnion(due) } else { owedAll = true }
    }

    private func runOwed() {
        guard owed else { return }
        let due: Set<String>? = owedAll ? nil : owedSources
        owed = false
        owedAll = false
        owedSources = []
        Task { await run(.timer, due: due) }
    }

    func start(after ready: LaunchReady, delay: TimeInterval) {
        launch = ready
        Task { await refresh() }
        follow()
        Task { [weak self] in
            guard await ready.wait() != .stopped, let self, !self.stopped else { return }
            limits?.start()
            judgeOnMobileChanges()
            await staged.start()
            await peer?.start()
            guard !self.stopped else { return }
            wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated {
                        self?.rearm()
                        self?.woke()
                    }
                }
            sleepObserver = NSWorkspace.shared.notificationCenter.addObserver(
                forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.sleeps() }
                }
            watch = Timer.scheduledTimer(withTimeInterval: Self.watchInterval, repeats: true) { [weak self] _ in
                Task { @MainActor in await self?.watchKnock() }
            }
            Task { await self.knock() }
            await watch()
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
        if let sleepObserver { NSWorkspace.shared.notificationCenter.removeObserver(sleepObserver) }
        sleepObserver = nil
        wakeTimer?.cancel()
        wakeTimer = nil
        sweep?.invalidate()
        sweep = nil
        if let powerObserver { NotificationCenter.default.removeObserver(powerObserver) }
        powerObserver = nil
        powerSource?.stop()
        powerSource = nil
        watching?.cancel()
        watching = nil
        watcher?.stop()
        watcher = nil
        photos?.stopObserving()
        await staged.stop()
        await peer?.stop()
        while running || flushes > 0 { try? await Task.sleep(for: .milliseconds(100)) }
    }

    private func sleeps() {
        guard let peer else { return }
        Task { await peer.willSleep() }
    }

    private func woke() {
        guard let peer, !stopped else { return }
        Task { await peer.didWake() }
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

    private func homeRefreshes(_ connector: String) async {
        let sources = await shipper.sources(of: connector)
        guard !sources.isEmpty else { return }
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
        if !stopped { await peer?.nudge() }
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
        if let before, snapshot.revision > before.revision {
            Task { await runOrOwe() }
            if let peer, !stopped { Task { await peer.nudge() } }
        }
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
        if running { owe(nil) } else { await run(.timer) }
    }

    @discardableResult
    private func run(_ trigger: ShipTrigger, due: Set<String>? = nil) async -> ShipperReport {
        guard !running, !stopped else {
            if !stopped { owe(due) }
            return ShipperReport(rows: [], outcome: "busy")
        }
        running = true
        changed?()
        let stamps = watcher?.stamps(of: due)
        let report = await shipper.run(trigger, due: due)
        if let stamps { watcher?.keep(stamps.filter { report.ran.contains($0.key) }) }
        if let pass = link.saved?.pass { await staged.reset(pass: pass) }
        running = false
        requeue(report.unrotated.union(report.unsettled), ran: report.ran)
        armWake()
        watched()
        await refresh()
        runOwed()
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

final class PowerSourceWatch {
    private let changed: @MainActor () -> Void
    private var source: CFRunLoopSource?

    @MainActor init(_ changed: @escaping @MainActor () -> Void) {
        self.changed = changed
        let made = IOPSNotificationCreateRunLoopSource({ info in
            guard let info else { return }
            let watch = Unmanaged<PowerSourceWatch>.fromOpaque(info).takeUnretainedValue()
            MainActor.assumeIsolated { watch.changed() }
        }, Unmanaged.passUnretained(self).toOpaque())
        guard let made else { return }
        let source = made.takeRetainedValue()
        self.source = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    }

    deinit {
        stop()
    }

    func stop() {
        guard let source else { return }
        CFRunLoopSourceInvalidate(source)
        self.source = nil
    }
}

enum PowerSource {
    static func onBattery() -> Bool {
        let snapshot = IOPSCopyPowerSourcesInfo()?.takeRetainedValue()
        let source = snapshot.flatMap { IOPSGetProvidingPowerSourceType($0)?.takeUnretainedValue() as String? }
        return source == kIOPSBatteryPowerValue
    }
}
