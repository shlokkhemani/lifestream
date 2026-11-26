import AppKit
import Combine
import Audio
import Cockpit
import Evidence
import HomeLink
import os
import Passwords
import Recorder
import Shipping
import UserNotifications

@MainActor
final class MenuBarApp: NSObject, NSApplicationDelegate, NSMenuItemValidation, NSMenuDelegate, UNUserNotificationCenterDelegate {
    private let options: Options
    private let process: MacProcess
    private let address: DashboardAddress
    private let slot = MacWork.Slot()
    private var work: MacWork? { slot.work }
    private var quitting = false
    private let agentRequests = AgentRequests.live { try MacLink.opened() }
    private let updates: Updates
    private let keeper = VaultKeeper(failed: HomeSocket.probing { MacLink.shared }, unit: { MacLink.shared?.saved?.unit }, draft: {
        guard let release = BundledRelease.inApp() else { throw ReleaseError(words: "this copy of Lifestream carries no release") }
        return try release.draft().recovery
    })
    private let needs: NeedsModel
    private let keyWindow: RecoveryKeyWindow
    private let start: SetupStart
    private lazy var gate = RecordingGate(world: { SetupWorld.read(link: MacLink.shared) }, paused: { KeptPause().paused }, start: { [weak self] in self?.startRecording() })
    private var resume: Resume?
    private var settingsLeft = false
    private var needItems: [NSMenuItem] = []
    private var grantsItem = NSMenuItem()
    private var whatsNewItem = NSMenuItem()
    private var firstRunDue = false
    private var active: NSObjectProtocol?
    private var server: RecorderControlServer?
    private var askingToQuit = false
    private let doorAddress = DoorAddress(named: { try? MacLink.shared?.name() }, pointed: { SetupWorld.pointed() }, looked: { folder in
        BundledRelease.inApp().flatMap { (try? MachineLook.read(folder, release: $0))?.folder?.door }.flatMap { URL(string: $0) }
    })
    private var uninstalling = false
    private var item: NSStatusItem!
    private var stateItem = NSMenuItem()
    private var actionItem = NSMenuItem()
    private var detailItem = NSMenuItem()
    private var shown: RecorderPresentation?
    private var starting: ActOutcome = .idle
    private var dueTimer: Timer?
    private var readingGrants = false
    private var shippingItem = NSMenuItem()
    private var openItem = NSMenuItem()
    private var shownRecording: Bool?
    private var mainMenu: NSMenu?
    private lazy var tour = MainMenu.Tour(shown: { [weak self] in self?.openWindow?.web }, open: { [weak self] page in
        Task { await self?.openConnectors(byNeed: false, page: page) }
    })
    private lazy var feedback = MainMenu.Feedback(seen: { [weak self] in self?.openWindow?.seen == true }, open: { [weak self] page, pictured in
        Task { await self?.openConnectors(byNeed: false, page: page, pictured: pictured) }
    })
    private let lines: StatusLines
    private let askDoor = AskLoginDoor.live { try MacLink.opened() }
    private var main: MainWindowController?
    private var windowMade = false
    private var openWindow: MainWindowController? { main?.kept == false ? main : nil }
    private var setup: SetupHost?
    private var setupDone: AnyCancellable?
    private var heal: Task<Void, Never>?
    private var ready: LaunchReady?
    private var launched = false
    private var shippingPaired = false
    private static let log = Logger(subsystem: "org.lifestreamprotocol.screen-capture", category: "launch")

    init(options: Options, updates: Updates) throws {
        self.updates = updates
        self.options = options
        address = DashboardAddress(port: options.dashboardPort)
        let process = MacProcess.current
        self.process = process
        let slot = slot
        let work = slot.begin(options, process: process, link: MacLink.shared)
        let recovery = RecoveryKey(keeper: keeper)
        recovery.names = { units in await Self.deviceNames(units) }
        needs = NeedsModel(keeper: keeper, recovery: recovery)
        keyWindow = RecoveryKeyWindow(needs: needs)
        start = SetupStart(pair: { name, code in
            guard let shipping = slot.work?.shipping else { return .refused(process.refusal() ?? MacProcess.refusedWords) }
            return await shipping.pairSetUp(name: name, code: code)
        })
        lines = StatusLines(recorder: Self.presentation(work))
        super.init()
        server = try RecorderControlServer(directory: options.directory, didRespond: { response in
            if response.state == "shutting_down" { NSApp.terminate(nil) }
        }, handler: { [weak self] request in
            guard let self else { return ControlResponse(ok: false, state: "unavailable") }
            return await respond(to: request)
        })
    }

    private func respond(to request: ControlRequest) async -> ControlResponse {
        if let control = work?.control { return await control.respond(to: request) }
        if request.action == "shutdown" {
            quitting = true
            return ControlResponse(ok: true, state: "shutting_down")
        }
        return ControlResponse(ok: false, state: "refused", message: process.refusal())
    }

    private var shuttingDown: Bool { quitting || work?.control.shuttingDown == true }

    private func beginShutdown() {
        quitting = true
        work?.control.beginShutdown()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let event = NSAppleEventManager.shared().currentAppleEvent
        let opening = LaunchWindow.Opening(event, updated: UpdateRelaunch.take())
        Self.log.notice("open event: \(event.map { "\($0)" } ?? "none", privacy: .public)")
        let heal = Task { [weak self] in
            let failure = await Self.healMarked()
            self?.needs.updated(failure)
        }
        self.heal = heal
        let ready = LaunchReady(heal: heal)
        self.ready = ready
        NSApp.appearance = AppAppearance.kept().appearance
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        for entry in StatusMenuEntry.order {
            menu.addItem(statusItem(entry))
        }
        menu.delegate = self
        item.menu = menu
        let actions = MainMenu.Actions(target: self, quit: #selector(quit), toggle: #selector(toggle),
                                       shipNow: #selector(shipNow), settings: #selector(openSettings), tour: tour,
                                       feedback: feedback)
        mainMenu = MainMenu.install(actions, presentation: presentation)
        needs.changed = { [weak self] in self?.refreshNeeds() }
        updates.changed = { [weak self] in self?.refreshUpdate() }
        refreshUpdate()
        needs.installUpdate = { [weak self] in self?.updates.restart() }
        needs.began = { [weak self] begun in self?.needBegan(begun) }
        if Bundle.main.bundleIdentifier != nil {
            let center = UNUserNotificationCenter.current()
            center.delegate = self
            center.setNotificationCategories(NeedNotification.categories)
        }
        needs.retryUpdate = { await Self.healMarked() }
        needs.knock = { [weak self] in await self?.work?.shipping.knock() }
        needs.openKey = { [weak self] door in self?.keyWindow.open(door) }
        needs.restartDoor = { await HomeAgents.restart(.door) }
        needs.door = { [doorAddress] in await DoorAnswer.asked(await Task.detached { doorAddress.url() }.value, within: Self.doorWithin) }
        let process = process
        needs.macFiles = {
            await Task.detached {
                MacFilesNeed.of(process.opened, keyed: (try? process.macFiles.keyID()) != nil, homeHere: SetupWorld.pointed() != nil,
                                paired: (try? MacLink.shared?.name()) != nil)
            }.value
        }
        needs.openFiles = { [weak self] in await self?.openFiles() }
        if process.opened == .startedAgain, Bundle.main.bundleIdentifier != nil { Task { await NeedNotification.startedAgain() } }
        grantsItem = command("", #selector(openThisMac))
        grantsItem.isHidden = true
        menu.insertItem(grantsItem, at: menu.index(of: shippingItem) + 1)
        whatsNewItem = label("")
        whatsNewItem.isHidden = true
        menu.insertItem(whatsNewItem, at: menu.index(of: grantsItem) + 1)
        active = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshGrantsLine() }
        }
        refreshGrantsLine()
        resume = Resume.take()
        settingsLeft = resume != nil
        Task.detached(priority: .utility) { AppPlacement.ejectLeftImages() }
        if let work { began(work, delay: opening == .atLogin ? ShippingCoordinator.launchDelay : 0) }
        agentRequests.inFront = { [weak self] in NSApp.isActive && self?.main?.window?.isKeyWindow == true }
        Task { [weak self] in
            await heal.value
            self?.agentRequests.start()
        }
        if options.request { Grant.requestMissing() }
        gate.watch(start)
        setupDone = start.$phase.sink { [weak self] phase in if phase == .done { self?.setup = nil } }
        Task { [gate] in await gate.check() }
        refresh()
        Task { [weak self] in
            await self?.open(opening)
            self?.launched = true
        }
    }

    private func open(_ opening: LaunchWindow.Opening) async {
        await heal?.value
        let world = await Task.detached { SetupWorld.read(link: MacLink.shared) }.value
        gate.opens(world)
        firstRunDue = world.opensAt != nil
        await needs.read()
        let window = LaunchWindow.shown(opening, world: world, needs: !needs.list.isEmpty,
                                        onboarding: WebContent.leftInOnboarding(), resume: resume?.page)
        refreshGrantsLine()
        let agents = world.agents.map { "\($0.key.rawValue) \($0.value.rawValue)" }.sorted().joined(separator: ", ")
        Self.log.notice("opened \(opening.description, privacy: .public): \(window.map { "\($0)" } ?? "no window", privacy: .public) (agents: \(agents, privacy: .public))")
        if window != .setup, window != nil { resume = nil }
        switch window {
        case .setup?: showSetup(world)
        case .connectors?: openMain(.connectors)
        case .dashboard?: openMain(nil)
        case .page(let hash)?: openMain(hash: hash)
        case nil: break
        }
        if settingsLeft { putSettingsAway() }
    }

    private func putSettingsAway() {
        settingsLeft = false
        guard let main else {
            Task { await SystemSettings.putAway() }
            return
        }
        main.afterFront { [weak main] in
            main?.window?.orderFrontRegardless()
            Task { await SystemSettings.putAway() }
        }
    }

    private static let doorWithin: TimeInterval = 5

    private func showSetup(_ world: SetupWorld) {
        guard let step = world.opensAt else { return }
        let setup = setup ?? madeSetup(world)
        self.setup = setup
        if step == .move, openWindow == nil, !setup.opensWindow() { return }
        openMain(hash: step.hash, carried: true)
    }

    private func madeSetup(_ world: SetupWorld) -> SetupHost {
        let release = BundledRelease.inApp()
        let steps = release.map { [needs] release in
            StartSteps.live(release, dashboard: address.root, link: { MacLink.shared }, locked: { await needs.read() })
        }
        return SetupHost(world: world, start: start, release: release, steps: steps, quit: { [weak self] in self?.stopThenTerminate() })
    }

    private func needBegan(_ begun: [Need]) {
        guard launched, setup == nil else { return }
        let inFront = NSApp.isActive && main?.window?.isKeyWindow == true
        for need in begun where NeedNotification.calls(need) && !inFront {
            Task { await NeedNotification.notify(need) }
        }
        guard openWindow == nil, begun.contains(where: { !NeedNotification.calls($0) }) else { return }
        Task { await openConnectors(byNeed: true) }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let answer = NeedNotification.answer(response.notification.request.content, action: response.actionIdentifier)
        let agent = AgentRequests.opens(response.notification.request.identifier)
            && response.actionIdentifier == UNNotificationDefaultActionIdentifier
        let page = AgentRequests.page(of: response.notification.request.content)
        Task { @MainActor [weak self] in
            if agent {
                await self?.heal?.value
                if let page { self?.openMain(hash: page) } else { self?.openMain(nil) }
                return
            }
            switch answer {
            case .install?: self?.updates.restart()
            case .show(let page)?: await self?.openConnectors(byNeed: false, asked: true, page: page)
            case nil: break
            }
        }
        completionHandler()
    }

    private func windowClosed() {
        needs.forget()
    }

    private static func deviceNames(_ units: [String]) async -> [String] {
        guard !units.isEmpty, let socket = await HomeSocket.linked({ MacLink.shared }),
              let report = try? await ConnectorsHome(socket: socket).report() else { return units }
        return units.map { report.device($0)?.name ?? $0 }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        Task { [weak self] in await self?.open(.byPerson) }
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let event = NSAppleEventManager.shared().currentAppleEvent
        let quitEvent = event?.eventID == AEEventID(kAEQuitApplication) ? event : nil
        let reason = quitEvent?.attributeDescriptor(forKeyword: QuitSource.quitReasonKeyword)?.enumCodeValue
        let sender = quitEvent?.attributeDescriptor(forKeyword: AEKeyword(keySenderPIDAttr)).map(\.int32Value)
            .flatMap { $0 == getpid() ? nil : NSRunningApplication(processIdentifier: $0)?.bundleIdentifier }
        let source = QuitSource.classify(shuttingDown: shuttingDown, quitReason: reason, sender: sender,
                                         updating: updates.relaunching)
        guard keyWindow.asksBeforeQuitting(source) else { return terminating(source, sender: sender) }
        Task { [weak self] in
            guard let self else { return }
            let goOn = await keyWindow.beforeQuit(source)
            NSApp.reply(toApplicationShouldTerminate: goOn && terminating(source, sender: sender) == .terminateNow)
        }
        return .terminateLater
    }

    private func terminating(_ source: QuitSource, sender: String?) -> NSApplication.TerminateReply {
        if let sender, QuitSource.systemSettings(sender) {
            Resume(leaving: openWindow?.web.currentURL, at: Date()).save()
            try? AppRestart.reopen()
        }
        switch QuitDecision.decide(source: source, screenRecorded: screenRecorded) {
        case .terminateNow:
            return .terminateNow
        case .askFirst, .stopThenTerminate:
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated { self?.quit() }
            }
            return .terminateCancel
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        SecretCopy.leaving()
    }

    static func healMarked() async -> UpdateFailure? {
        struct Failed: Error { let failure: UpdateFailure }
        guard await Task.detached(operation: { SetupWorld.pointed() }).value != nil else { return await SetupWorld.heal(link: MacLink.shared) }
        do {
            guard let link = MacLink.shared else { return await SetupWorld.heal(link: MacLink.shared) }
            try await link.restarting {
                if let failure = await SetupWorld.heal(link: MacLink.shared) { throw Failed(failure: failure) }
            }
            return nil
        } catch {
            return (error as? Failed)?.failure
        }
    }


    private var presentation: RecorderPresentation { Self.presentation(work, shown: shown, start: starting) }

    private static func presentation(_ work: MacWork?, shown: RecorderPresentation? = nil, start: ActOutcome = .idle) -> RecorderPresentation {
        guard let recorder = work?.recorder else {
            return RecorderPresentation(status: RuntimeStatus(state: .stopped), running: false, shown: shown, start: start)
        }
        return RecorderPresentation(status: recorder.status, running: recorder.running, screenOff: recorder.off.contains(.screen),
                                    ownInFront: NSApp.isActive, shown: shown, start: start)
    }

    private var shippingPresentation: ShippingPresentation {
        ShippingPresentation(status: work?.shipping.status, running: work?.shipping.running == true,
                             reach: work?.shipping.reach ?? HomeLink.ReachSnapshot(reach: .answering, lastReached: nil, revision: 0),
                             onBattery: PowerSource.onBattery(), mobile: MacLink.shared?.mobile(pressed: false), clock: MacLink.shared?.homeClock)
    }

    private func statusItem(_ entry: StatusMenuEntry) -> NSMenuItem {
        let title = entry.title(presentation, shippingPresentation) ?? ""
        switch entry {
        case .separator:
            return .separator()
        case .state:
            stateItem = label(title)
            return stateItem
        case .detail:
            detailItem = label(title)
            return detailItem
        case .openLifestream:
            openItem = command(title, #selector(openFromMenu))
            return openItem
        case .toggle:
            actionItem = command(title, #selector(toggle))
            return actionItem
        case .shipping:
            shippingItem = label(title)
            return shippingItem
        case .shipNow:
            return command(title, #selector(shipNow))
        case .settings:
            return command(title, #selector(openSettings))
        case .quit:
            return command(title, #selector(quit), "q")
        }
    }

    private func label(_ title: String) -> NSMenuItem {
        let label = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        label.isEnabled = false
        return label
    }

    private func command(_ title: String, _ action: Selector, _ key: String = "") -> NSMenuItem {
        let command = NSMenuItem(title: title, action: action, keyEquivalent: key)
        command.target = self
        return command
    }

    private func refresh() {
        ResourceMeter.shared.measure(.menuBar) { refreshStatusItem() }
    }

    private func refreshStatusItem() {
        let text = presentation
        if text != shown {
            if text.recording != shownRecording {
                item.button?.image = StreamMark.image(recording: text.recording)
                item.button?.imagePosition = .imageLeading
                shownRecording = text.recording
            }
            if text.label != shown?.label {
                item.button?.setAccessibilityLabel("Lifestream: \(text.label)")
            }
            lines.recorder = text
            stateItem.title = text.label
            detailItem.title = text.detail
            if text.failed != shown?.failed {
                detailItem.image = text.failed ? NSImage(systemSymbolName: "exclamationmark.circle", accessibilityDescription: "Stopped") : nil
            }
            actionItem.title = text.toggleTitle
            mainMenu.flatMap(MainMenu.recordingToggle(in:))?.title = text.toggleTitle
            tellHome(text, after: shown)
            if text.due != shown?.due {
                dueTimer?.invalidate()
                dueTimer = text.due.map { due in
                    Timer.scheduledTimer(withTimeInterval: max(0, due.timeIntervalSinceNow), repeats: false) { [weak self] _ in
                        MainActor.assumeIsolated { self?.refresh() }
                    }
                }
            }
            shown = text
        }
    }

    private func tellHome(_ text: RecorderPresentation, after before: RecorderPresentation?) {
        guard !readingGrants else { return }
        guard text.tellsGrants(after: before) else {
            MacLink.shared?.tell(recorder: text.stated)
            return
        }
        readingGrants = true
        Task { [weak self] in
            let grants = await Task.detached { Grant.stated() }.value
            guard let self else { return }
            readingGrants = false
            MacLink.shared?.tell(recorder: (shown ?? text).stated, grants: grants)
        }
    }

    private func refreshShipping() {
        guard let work else { return }
        let shipping = work.shipping
        shippingItem.title = shippingPresentation.label
        lines.shipper = shipping.status
        lines.reach = shipping.reach
        let paired = shipping.status?.paired == true
        if paired, !shippingPaired { Task { [gate] in await gate.check() } }
        shippingPaired = paired
        if let status = shipping.status, status.paired, let at = status.lastContactAt {
            if let unit = work.link.unit {
                work.carry.answered(at: at, asked: status.answerAsked, audio: "\(Producer.audio.rawValue):local:\(unit)",
                                turn: { source in
                                    guard let socket = await HomeSocket.linked({ MacLink.shared }) else { throw HostRefusal.noHome }
                                    try await ConnectorsHome(socket: socket).turn(source, on: false)
                                }, knock: { [shipping] in await shipping.knock() })
            }
            work.recorder.setOff(RecordingSwitches.off(status.sources).union(work.carry.off))
        }
        needs.noticed(shipping.status?.needs ?? [])
        work.imports.refresh()
    }

    private func refreshNeeds() {
        guard let menu = item.menu else { return }
        for entry in needItems { menu.removeItem(entry) }
        needItems = needs.list.map { need in
            let entry = command(need.line + "…", #selector(openNeed(_:)))
            entry.representedObject = need.key
            return entry
        }
        let after = menu.index(of: shippingItem) + 1
        for (offset, entry) in needItems.enumerated() { menu.insertItem(entry, at: after + offset) }
    }

    private func refreshUpdate() {
        needs.update(holding: updates.holding, waiting: updates.waiting)
    }

    private func refreshGrantsLine() {
        Task { [weak self] in
            let due = await Task.detached { SetupWorld.read(link: MacLink.shared).opensAt != nil }.value
            let missing = Grant.missing(await Grant.current(telling: { MacLink.shared }))
            let line = Grant.menuLine(missing)
            guard let self else { return }
            firstRunDue = due
            grantsItem.title = line ?? ""
            grantsItem.isHidden = due || line == nil
            let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
            let whatsNew = updates.whatsNew(running: version)
            whatsNewItem.title = whatsNew ?? ""
            whatsNewItem.isHidden = due || whatsNew == nil
        }
    }

    func menuWillOpen(_ menu: NSMenu) {
        openItem.title = StatusMenuEntry.openTitle(firstRunDue: firstRunDue)
        for entry in needItems { entry.isHidden = firstRunDue && !Need.macFilesKeys.contains(entry.representedObject as? String ?? "") }
    }

    func menuDidClose(_ menu: NSMenu) {
        refreshGrantsLine()
    }


    @objc private func openFromMenu() {
        Task { await open(.byPerson) }
    }

    private func openMain(_ section: AppSection?) {
        makeMain().present(section)
    }

    private func openMain(hash: String, carried: Bool = false, pictured: Bool = true) {
        makeMain(carried: carried).present(hash: hash, pictured: pictured)
    }

    private func makeMain(carried: Bool = false) -> MainWindowController {
        let release = carried ? nil : ReleaseStamp(manifest: MachineDirectory.current)?.commit
        if let main {
            if main.keeps(carried: carried, release: release) { return main }
            main.drop()
            self.main = nil
        }
        let host = MacHost(needs: needs, lines: lines,
                           socket: { await HomeSocket.linked({ MacLink.shared }) }, readGrants: { await Grant.current(telling: { MacLink.shared }) },
                           readFolder: { await Task.detached { SetupWorld.pointed() }.value },
                           detect: {
                               let apps = Detection.apps()
                               return HostState.Found(browsers: Detection.browsers(apps), apps: apps)
                           },
                           locate: { id in NSWorkspace.shared.urlForApplication(withBundleIdentifier: id).flatMap(Detection.app(at:)) },
                           unit: { MacLink.shared?.unit }, appleID: { ShippingDomains.appleID() }, door: askDoor,
                           verifyHome: { try await MacLink.opened().verifyHome() },
                           probe: MacLink.shared.map { link in { await link.checkAgain() } },
                           openHome: {
                               try await HomeAgents.open()
                               _ = await MacLink.shared?.checkAgain()
                           },
                           pairAgain: MacLink.shared.map { MacHost.PairAgain(link: $0, setUp: { [weak self] in self?.pairAgain() }) },
                           refresh: { try await MacLink.opened().refresh(connector: $0) },
                           refreshHere: { [weak self] id in Task { await self?.work?.shipping.refreshNow(id) } },
                           tellStores: { MacLink.shared?.tell(stores: $0) },
                           homeClock: { MacLink.shared?.homeClock },
                           browserFor: { [scratch = process.scratch] url in Detection.browserUsing(Detection.sites(of: url), scratch: scratch) },
                           machineName: SetupHost.computerName(),
                           lookFolder: BundledRelease.inApp().map { release in { @Sendable folder in try MachineLook.read(folder, release: release) } },
                           ask: .live, settings: work?.settings, general: General(system: .live(updates: updates, uninstall: { [weak self] in self?.uninstall() })),
                           setup: setup, imports: work?.imports, agentRequests: agentRequests,
                           dragPanel: DragPanel(onScreen: true, screen: .live))
        let made = MainWindowController(web: WebContent(address: carried ? address.carried : address, launch: !windowMade), host: host,
                                        release: release, onScreen: true, closed: { [weak self] in self?.windowClosed() })
        windowMade = true
        main = made
        return made
    }


    private func began(_ work: MacWork, delay: TimeInterval) {
        work.recorder.changed = { [weak self] in self?.refresh() }
        work.shipping.changed = { [weak self] in self?.refreshShipping() }
        work.recorder.setOff(RecordingSwitches.off(work.link.saved.map { Array($0.sources.keys) }).union(work.carry.off))
        guard let ready else { return }
        ready.hold(work.link)
        work.shipping.start(after: ready, delay: delay)
        work.imports.start(after: ready)
    }

    private func openFiles() async -> String? {
        let process = process
        let opened = await Task.detached { process.allow() }.value
        if case .refused(let why) = opened { return NeedsModel.sentence(why) }
        if opened == .startedAgain, Bundle.main.bundleIdentifier != nil { Task { await NeedNotification.startedAgain() } }
        if let work = slot.begin(options, process: process, link: MacLink.shared) {
            began(work, delay: 0)
            hostAgain()
        }
        refresh()
        if gate.open, !KeptPause().paused { startRecording() } else { await gate.check() }
        return nil
    }

    private func hostAgain() {
        guard let main else { return }
        let shown = openWindow.map { DashboardAddress.place(hash: $0.web.currentURL.fragment) }
        main.close()
        main.drop()
        self.main = nil
        guard let shown else { return }
        if let page = shown { openMain(hash: page) } else { openMain(nil) }
    }

    private func startRecording() {
        guard work != nil else { return }
        startAsked()
        refresh()
    }

    private func startAsked() {
        guard let control = work?.control else { return }
        starting = .running
        do {
            try control.start()
            starting = .idle
        } catch {
            Self.log.error("Recording did not start: \(String(describing: error), privacy: .public)")
            starting = .failed(.refused(RecorderPresentation.startFailed))
        }
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.action {
        case #selector(toggle):
            guard let recorder = work?.recorder else { return false }
            return !recorder.stopping && !shuttingDown && (recorder.running || gate.open)
        case #selector(shipNow): return shippingPresentation.canShipNow && !shuttingDown
        default: return true
        }
    }

    @objc private func toggle() {
        guard let work, !shuttingDown, !work.recorder.stopping else { return }
        if work.recorder.running {
            Task { await work.control.pause() }
            return
        }
        guard gate.open else { return }
        startAsked()
        refresh()
    }


    @objc private func openNeed(_ sender: NSMenuItem) {
        let need = needs.list.first { $0.key == sender.representedObject as? String }
        if case .saveRecoveryKey? = need { return keyWindow.open(.asked) }
        if case .filesRefused? = need {
            needs.allowFiles()
            return
        }
        if case .pairAgain? = need { return showPairAgain() }
        Task { await openConnectors(byNeed: false, asked: true, page: need?.page) }
    }

    @objc private func openThisMac() {
        Task { await openConnectors(byNeed: false, page: "dialog=\(AppSection.thisMac)") }
    }

    private func openConnectors(byNeed: Bool, asked: Bool = false, page: String? = nil, pictured: Bool = true) async {
        await heal?.value
        let world = await Task.detached { SetupWorld.read(link: MacLink.shared) }.value
        guard world.opensAt == nil else {
            if !byNeed { showSetup(world) }
            return
        }
        if byNeed || asked, WebContent.leftInOnboarding() {
            if let flow = page?.split(separator: "&").first(where: { $0.hasPrefix("flow=") }) {
                return openMain(hash: "view=onboarding&\(flow)")
            }
            return openMain(nil)
        }
        if let page { return openMain(hash: page, pictured: pictured) }
        openMain(.connectors)
    }

    private func showPairAgain() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = Need.pairAgain.line
        alert.informativeText = Need.pairAgain.detail ?? ""
        alert.runModal()
    }

    private func pairAgain() {
        start.passForgotten()
        refreshGrantsLine()
        Task { await openConnectors(byNeed: false) }
    }

    @objc private func shipNow() {
        guard shippingPresentation.canShipNow else { return }
        Task { await work?.shipping.shipNow() }
    }

    @objc private func openSettings() {
        Task { await openConnectors(byNeed: false, page: "dialog=\(AppSection.settings)") }
    }

    private func uninstall() {
        guard !uninstalling, !shuttingDown else { return }
        uninstalling = true
        Task { [weak self] in
            await self?.uninstallNow()
            self?.uninstalling = false
        }
    }

    private func uninstallNow() async {
        let plan = await Uninstall.plan()
        guard let erase = UninstallWindows.ask(plan) else { return }
        let progress = UninstallWindows.Progress()
        let steps = Uninstall.live(key: { [keyWindow] in await keyWindow.beforeUninstall() },
                                   quiet: { [weak self] in await self?.quietForUninstall() })
        let ran = await Uninstall.run(plan, erase: erase, drop: UploadDomain.folder(), user: FileManager.default.homeDirectoryForCurrentUser,
                                      steps: steps, said: { words in await MainActor.run { progress.say(words) } })
        progress.close()
        guard let outcome = ran else { return }
        let showHow = UninstallWindows.done(outcome)
        guard outcome.stopped == nil else { return }
        if showHow { NSWorkspace.shared.open(UninstallWords.page) }
        do { try Cleaner.start(Cleaner.forThisApp()) } catch {
            Self.log.error("uninstall: \(String(describing: error), privacy: .public)")
        }
        beginShutdown()
        NSApp.terminate(nil)
    }

    private func quietForUninstall() async {
        agentRequests.stop()
        guard let work else { return }
        await work.imports.stop()
        await work.shipping.stop()
        work.audio.stop()
        await work.recorder.stop()
    }

    @objc private func quit() {
        guard !shuttingDown, !askingToQuit else { return }
        askingToQuit = true
        Task { [weak self] in
            guard let self else { return }
            let goOn = await keyWindow.beforeQuit(.user)
            if shuttingDown {
                NSApp.terminate(nil)
            } else if goOn {
                quitAsked()
            }
            askingToQuit = false
        }
    }

    private func quitAsked() {
        switch QuitDecision.decide(source: .user, screenRecorded: screenRecorded) {
        case .askFirst:
            let confirmed = confirmQuit()
            if shuttingDown {
                NSApp.terminate(nil)
                return
            }
            if confirmed { stopThenTerminate() }
        case .stopThenTerminate:
            stopThenTerminate()
        case .terminateNow:
            NSApp.terminate(nil)
        }
    }

    private var screenRecorded: Bool {
        guard let recorder = work?.recorder else { return false }
        return QuitDecision.screenRecorded(running: recorder.running, state: recorder.status.state)
    }

    private func stopThenTerminate() {
        beginShutdown()
        refresh()
        Task { [work] in
            await work?.recorder.stop()
            NSApp.terminate(nil)
        }
    }

    private func confirmQuit() -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Quit Lifestream?"
        alert.informativeText = "Screen recording stops until you open it again."
        alert.addButton(withTitle: "Keep Recording")
        alert.addButton(withTitle: "Quit")
        return alert.runModal() == .alertSecondButtonReturn
    }
}
