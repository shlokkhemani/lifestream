import AppKit
import Combine
import Evidence
import Foundation
import HomeLink
import Passwords
import Shipping

@MainActor final class MacHost: ObservableObject {
    static let interval: TimeInterval = 30
    static let storeListing = URL(string: "https://chromewebstore.google.com/detail/lifestream/bdiidhddmofblpjlbgkckhjfcbgfnfem")!
    static let storage = URL(string: "x-apple.systempreferences:com.apple.settings.Storage")!

    @Published var sheet: HostSheet? {
        didSet { if sheet == nil, oldValue != nil { endOpening() } }
    }
    @Published private(set) var working = false
    @Published private(set) var failure: String?
    @Published private(set) var refusedField: String?
    @Published private(set) var device: DeviceSignIn?
    @Published private(set) var client: ClientSignIn?
    private var connectedName: String?

    private(set) var state: HostState
    var published: (HostState) -> Void = { _ in }
    var asked: (String) -> Void = { _ in }
    var seen: () -> Bool = { false }
    var showPage: (String) -> Void = { _ in }
    var pasteboard: NSPasteboard = .general
    var later: SecretCopy.Later = SecretCopy.wallClock
    var browse: (URL) -> Void = { _ = NSWorkspace.shared.open($0) }
    var window: () -> NSWindow? = { nil }
    var snapshot: () async -> CGImage? = { nil }
    var pictureless = false
    lazy var choose: (FilePanel) async -> URL? = { [weak self] panel in await panel.run(over: self?.window()) }
    lazy var pickApp: () async -> URL? = { [weak self] in await AppPanel.run(over: self?.window()) }
    var inset: HostState.Inset? {
        didSet { recompute() }
    }
    var onboarding = false {
        didSet {
            guard onboarding != oldValue else { return }
            recompute()
            if onboarding { Task { await lookAtFolder() } }
        }
    }

    let needs: NeedsModel
    private let lines: StatusLines
    private let socket: @Sendable () async -> HomeSocket?
    private let readGrants: () async -> [Grant: Bool]
    private let readFolder: () async -> URL?
    private let detect: (@Sendable () -> HostState.Found)?
    private let unit: @Sendable () -> String?
    private let appleID: @Sendable () -> String?
    private let door: AskLoginDoor?
    private let verifyHome: (@Sendable () async throws -> Void)?
    private let probe: (@Sendable () async -> HomeLink.ReachSnapshot)?
    private let openHome: (@Sendable () async throws -> Void)?
    private let pairAgain: PairAgain?
    private let refreshNow: (@Sendable (String) async throws -> HomeLink.RefreshAnswer)?
    private let refreshHere: (@Sendable (String) -> Void)?
    private let machineName: String?
    private let accountName: String
    private let lookFolder: (@Sendable (URL) throws -> MachineLook)?
    private var folderLook: (folder: URL, look: MachineLook?)?
    private let poll: Duration
    private let drawQR: @Sendable (String) -> String?
    private let settings: MacSettings?
    private let stores: @MainActor () -> DeclaredStores?
    private let tellStores: (HomeLink.StoresStated) -> Void
    private let homeClock: @Sendable () -> HomeClock?
    private let browserFor: @Sendable (URL) -> URL?
    private let general: General?
    private var thisUnit: String?
    private var standing: (list: [Need], saved: Set<String>)
    private var heldUpdate: Need?
    private var status: (recorder: RecorderPresentation, shipper: ShipperStatus?, reach: HomeLink.ReachSnapshot?)
    private var grants: [Grant: Bool] = [:]
    private var folder: URL?
    private var found: HostState.Found?
    private var detectDue = true
    private var appsShown: (field: HomeLink.JSON?, list: HostState.Apps)?
    private let locate: (@Sendable (String) -> Detection.App?)?
    private var located: [String: Detection.App?] = [:]
    private var shownPairing: HostState.Pairing?
    private var drawn: (link: String, qr: String)?
    private var vaultShown: HostState.Vault?
    private var askLogin: AskLogin?
    private var connectRequests: [ConnectRequest]?
    private var agentsWaiting: [HomeLink.SignIn] = []
    private var asksWaiting: [HomeLink.AgentAsk] = []
    private var pairingFlow = Flow(), browserFlow = Flow()
    private var account: Task<String?, Never>?
    private var looking: Task<Void, Never>?
    private let reads = OneRead()
    private var queue: Task<Void, Never>?
    private(set) var waiting = 0
    private var opening = 0
    private var shown: CheckedContinuation<Void, Never>?
    private var askWatch: Task<Void, Never>?
    private var askStarting: [HostAct.Subscription: Int] = [:]
    private var devicePolls: Task<Void, Never>?
    private var clientPolls: Task<Void, Never>?
    private var clientAttempt: HomeLink.JSON?
    private let sleep: @Sendable (Duration) async throws -> Void
    let panel: DragPanel
    let grantAsk: GrantAsk
    let setup: SetupHost?
    let agentRequests: AgentRequests?
    let imports: Imports?
    private let drop: () -> URL
    private var uploading = false
    var droppedOn: (_ kind: String) -> Void = { _ in }
    private(set) var drops: [String: [URL]] = [:]
    lazy var chooseImport: (_ several: Bool) async -> [URL] = { [weak self] several in await ImportPanel.run(over: self?.window(), several: several) }
    lazy var backupPassword: BackupPassword = .live(over: { [weak self] in self?.window() })
    lazy var openPane: (URL) -> Void = { NSWorkspace.shared.open($0) }
    private var timer: Timer?
    private(set) var closed = false
    private var closes = 0
    private var activity: [NSObjectProtocol] = []
    private var observed: [AnyCancellable] = []

    init(needs: NeedsModel, lines: StatusLines,
         socket: @escaping @Sendable () async -> HomeSocket?,
         readGrants: @escaping () async -> [Grant: Bool],
         readFolder: @escaping () async -> URL?,
         detect: (@Sendable () -> HostState.Found)? = nil,
         locate: (@Sendable (String) -> Detection.App?)? = nil,
         unit: @escaping @Sendable () -> String? = { nil },
         appleID: @escaping @Sendable () -> String? = { nil },
         door: AskLoginDoor? = nil,
         verifyHome: (@Sendable () async throws -> Void)? = nil,
         probe: (@Sendable () async -> HomeLink.ReachSnapshot)? = nil,
         openHome: (@Sendable () async throws -> Void)? = nil,
         pairAgain: PairAgain? = nil,
         refresh: (@Sendable (String) async throws -> HomeLink.RefreshAnswer)? = nil,
         refreshHere: (@Sendable (String) -> Void)? = nil,
         stores: (@MainActor () -> DeclaredStores?)? = nil,
         tellStores: @escaping (HomeLink.StoresStated) -> Void = { _ in },
         homeClock: @escaping @Sendable () -> HomeClock? = { nil },
         browserFor: @escaping @Sendable (URL) -> URL? = { _ in nil },
         machineName: String? = nil,
         lookFolder: (@Sendable (URL) throws -> MachineLook)? = nil,
         accountName: String = NSFullUserName(),
         ask: GrantAsk.System,
         poll: Duration = .seconds(2), drawQR: @escaping @Sendable (String) -> String? = { QRImage.dataURL($0) },
         settings: MacSettings? = nil, general: General? = nil, setup: SetupHost? = nil, imports: Imports? = nil,
         drop: @escaping () -> URL = { UploadDomain.folder() },
         agentRequests: AgentRequests? = nil, dragPanel: DragPanel? = nil,
         sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.needs = needs
        self.lines = lines
        self.socket = socket
        self.readGrants = readGrants
        self.readFolder = readFolder
        self.panel = dragPanel ?? DragPanel()
        self.detect = detect
        self.locate = locate
        self.unit = unit
        self.appleID = appleID
        self.door = door
        self.verifyHome = verifyHome
        self.probe = probe
        self.openHome = openHome
        self.pairAgain = pairAgain
        self.refreshNow = refresh
        self.refreshHere = refreshHere
        self.stores = stores ?? { StoreConsentSheets.stores }
        self.tellStores = tellStores
        self.homeClock = homeClock
        self.browserFor = browserFor
        self.machineName = machineName
        self.lookFolder = lookFolder
        self.accountName = accountName
        self.poll = poll
        self.drawQR = drawQR
        self.settings = settings
        self.general = general
        self.sleep = sleep
        grantAsk = GrantAsk(system: ask)
        self.setup = setup
        self.imports = imports
        self.drop = drop
        self.agentRequests = agentRequests
        standing = (needs.list, needs.saved)
        status = (lines.recorder, lines.shipper, lines.reach)
        state = HostState(recorder: lines.recorder)
        grantAsk.changed = { [weak self] in self?.recompute() }
        grantAsk.reread = { [weak self] in await self?.read() }
        grantAsk.guiding = { [weak self] grant in
            guard let self else { return }
            if let grant { panel.show(DragPanel.switchOn(grant, app: Bundle.main.bundleURL)) } else if panel.shown?.beside == SystemSettings.id { panel.close() }
        }
        setup?.changed = { [weak self] in
            guard let self else { return }
            if self.setup?.start.phase == .done { Task { await self.read() } } else { self.recompute() }
        }
        observed = [
            needs.$list.combineLatest(needs.$saved).sink { [weak self] list, saved in
                self?.standing = (list, saved)
                self?.recompute()
            },
            needs.$holding.sink { [weak self] holding in
                self?.heldUpdate = holding.map(Need.updateReady)
                self?.recompute()
            },
            lines.$recorder.combineLatest(lines.$shipper, lines.$reach).sink { [weak self] parts in
                self?.status = parts
                self?.recompute()
                self?.reachedEnds(parts.2)
            },
            needs.$vault.combineLatest(needs.$list).sink { [weak self] vault, list in
                self?.vaultShown = HostState.Vault.of(vault, need: list.first(where: \.locks))
                self?.recompute()
            },
        ]
        if let imports {
            observed.append(imports.$backups.dropFirst().sink { [weak self] _ in
                Task { @MainActor in self?.recompute() }
            })
        }
        if let agentRequests {
            observed.append(agentRequests.$waiting.combineLatest(agentRequests.$asks).sink { [weak self] waiting, asks in
                self?.agentsWaiting = waiting
                self?.asksWaiting = asks
                self?.recompute()
            })
        }
        state = made()
    }

    func start(polling: @escaping @MainActor () -> Bool) {
        closed = false
        detectDue = true
        Task { await read() }
        let center = NotificationCenter.default
        activity = [
            center.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    self?.grantAsk.cameBack()
                    self?.detectDue = true
                    await self?.read()
                }
            },
            center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.grantAsk.resigned() }
            },
        ]
        let timer = Timer(timeInterval: Self.interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                if polling() { Task { await self?.read() } }
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        let poll = poll
        looking = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: poll)
                guard !Task.isCancelled, let self else { return }
                wake()
            }
        }
        wake()
    }

    func stop() {
        closed = true
        closes += 1
        timer?.invalidate()
        timer = nil
        activity.forEach(NotificationCenter.default.removeObserver)
        activity = []
        grantAsk.end()
        panel.close()
        wake()
        looking?.cancel()
        looking = nil
        askWatch?.cancel()
        askWatch = nil
        let left = leaveSubscriptions()
        if !left.isEmpty, let shown = askLogin {
            askLogin = shown.forgetting(left)
            recompute()
        }
        if sheet == nil { endOpening() } else { sheet = nil }
    }

    private func leaveSubscriptions() -> Set<HostAct.Subscription> {
        guard let door else { return [] }
        let leaving = Set(askLogin?.underWay ?? []).union(askStarting.filter { $0.value > 0 }.keys)
        for of in HostAct.Subscription.allCases where leaving.contains(of) {
            _ = door.queue(.cancel(of))
        }
        return leaving
    }

    func read() async {
        await reads.run { [weak self] in
            guard let self else { return }
            grants = await readGrants()
            let detecting = detectDue
            if detecting, let detect {
                detectDue = false
                found = await Task.detached { detect() }.value
            }
            folder = await readFolder()
            await lookAtFolder()
            thisUnit = await Task.detached(operation: unit).value ?? ""
            let mine = closes
            if askWatch == nil, let door, let read = try? await door.read(), mine == closes, !closed {
                askLogin = read
                watchAsk()
            }
            await needs.read()
            await general?.read()
            await imports?.listBackups().value
            readCommand()
            listApps(found: detecting)
            recompute()
        }
    }

    private func readCommand() {
        guard let general else { return }
        Task { [weak self] in
            if await general.readCommand() { self?.recompute() }
        }
    }

    private func lookAtFolder() async {
        guard setup == nil, onboarding, let folder, let lookFolder else { return }
        let look = try? await Task.detached { try lookFolder(folder) }.value
        folderLook = (folder, look)
        recompute()
    }

    private var settingUp: Bool {
        setup.map { onboarding || $0.start.phase != .done } ?? onboarding
    }

    private var machineShown: SetupHost.Machine? {
        guard settingUp else { return nil }
        if let setup { return setup.machine }
        guard let folder else { return nil }
        return .of(folder, look: folderLook?.folder == folder ? folderLook?.look : nil, name: machineName)
    }

    private var accountShown: String? { settingUp ? accountName : nil }

    private func listApps(found again: Bool) {
        guard let settings else { return }
        let field = settings.value("screen", "apps")
        guard again || appsShown == nil || appsShown?.field != field else { return }
        let named = field?.array?.compactMap { $0["app"]?.string } ?? []
        let detected = found?.apps ?? []
        if let locate {
            for id in named where located[id] == nil && !detected.contains(where: { $0.id == id }) { located[id] = .some(locate(id)) }
        }
        let elsewhere = named.compactMap { id in detected.contains { $0.id == id } ? nil : located[id] ?? nil }
        appsShown = (field, .of(apps: detected + elsewhere, named: named))
    }

    private func recompute() {
        listApps(found: false)
        let next = made()
        guard next != state else { return }
        state = next
        published(next)
    }

    private func reachedEnds(_ snapshot: HomeLink.ReachSnapshot?) {
        guard let episode = snapshot?.episode, episode.showedStrip, let ended = episode.ended else { return }
        let left = ended.addingTimeInterval(ReachWords.reachedFor).timeIntervalSinceNow
        guard left > 0 else { return }
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(left))
            self?.recompute()
        }
    }

    private func made() -> HostState {
        var made = HostState(recorder: status.recorder)
        made.inset = inset
        if !onboarding || setup == nil || setup?.start.phase == .done, let reach = status.reach {
            made.reach = HostState.Reach(reach, clock: homeClock() ?? .placeholder(at: Date(), zone: .current))
        }
        made.sending = status.shipper?.lastOutcome.flatMap { ReachWords.sending($0, device: .mac) }
        made.grants = HostState.GrantRow.all(grants, asking: grantAsk.asking, denied: grantAsk.denied)
        made.needs = standing.list.map { HostState.NeedRow($0, saved: standing.saved.contains($0.id)) }
        made.update = heldUpdate.map { HostState.NeedRow($0, saved: false) }
        made.folder = folder?.path
        made.signins = HostAct.SignInWay.allCases.map(\.rawValue)
        made.browsers = found?.browsers
        made.pairing = shownPairing
        made.phoneApp = shownPairing == nil ? nil : .shown
        made.askLogin = askLogin
        made.connectRequests = connectRequests
        made.agentRequests = agentsWaiting
        made.agentAsks = asksWaiting
        made.unit = thisUnit
        made.apps = appsShown?.list
        if let setup {
            made.placement = setup.placement
            made.setup = setup.setup
        }
        made.machine = machineShown
        made.accountName = accountShown
        made.vault = vaultShown
        made.general = general?.state(update: heldUpdate?.line)
        made.backups = imports?.backups
        return made
    }


    func perform(_ act: HostAct) async throws -> String? {
        switch act {
        case .allow(let grants):
            grantAsk.ask(grants)
            return nil
        case .allowStore(let id):
            try await allowStore(id)
            return nil
        case .moveApp:
            try first().move()
            return nil
        case .chooseFolder(let choice):
            try await first().chooseFolder(choice, over: window())
            return nil
        case .setUp:
            try await first().setUp()
            return nil
        case .setupKey(let act):
            return try await first().key.perform(act, over: window())
        case .skip(let step):
            guard let unit = await Task.detached(operation: unit).value else {
                throw HostRefusal("This Mac is not paired with Lifestream yet.")
            }
            try await serially { try await self.home().skip(unit: unit, step: step) }
            if step == "found" { await needs.knock() }
            return nil
        case .at(let step):
            guard let unit = await Task.detached(operation: unit).value else {
                throw HostRefusal("This Mac is not paired with Lifestream yet.")
            }
            try await serially { try await self.home().at(unit: unit, step: step) }
            return nil
        case .pairing, .connectWait:
            _ = want(act)
            return nil
        case .askLogin(let act):
            try await signIn(act)
            return nil
        case .connectAnswer(let id, let allow):
            try await serially { try await self.home().connectAnswer(id: id, allow: allow) }
            connectRequests?.removeAll { $0.id == id }
            recompute()
            return nil
        case .agentAnswer(let request):
            _ = try await answer(request)
            return nil
        case .agentDisconnect(let id):
            try await serially { try await self.home().disconnectAgent(id) }
            return nil
        case .agentUnlist(let id):
            try await serially { try await self.home().unlistAgent(id) }
            return nil
        case .agentAccess(let id, let access, let expect):
            _ = try await setAccess(id, access, expect: expect)
            return nil
        case .agentGuides, .agentAddress, .agentKey, .agentSignIn:
            _ = try await guide(act)
            return nil
        case .screenshotTake:
            _ = await picture()
            return nil
        case .turn(let sources, let on):
            try await serially { for source in sources { try await self.home().turn(source, on: on) } }
            await needs.knock()
            return nil
        case .pause(let id, let history):
            return try await onHome(.pause(id, history: history)) { home, _ in
                try await home.pause(stream: id, true, history: history)
                return nil
            }
        case .resume(let id, let history):
            return try await onHome(.resume(id, history: history)) { home, _ in
                try await home.pause(stream: id, false, history: history)
                return nil
            }
        case .pauseHome:
            try await serially { try await self.home().pauseHome() }
            return nil
        case .resumePause(let target):
            try await serially { try await self.home().resume(target) }
            return nil
        case .homeSetting(let setting):
            try await serially { try await self.home().set(setting) }
            return nil
        case .mobileData(let key, let choice):
            guard let link = MacLink.shared else { throw HostRefusal(LinkFailure.unpaired) }
            if let refusal = Self.refusal(try await link.setHomeSetting(key: key, value: .string(choice.rawValue))) { throw refusal }
            return nil
        case .deviceName(let unit, let name):
            try await serially {
                let home = try await self.home()
                guard try await home.report().devices.contains(where: { $0.unit == unit && $0.kind == .mac && !$0.retired }) else {
                    throw HostRefusal("Lifestream renames only a Mac it holds.")
                }
                try await home.name(unit: unit, as: name)
            }
            return nil
        case .setting(let id, let member, let value, let was):
            _ = try await setting(id, member, value, was: was)
            return nil
        case .seal(let id, let member, let value):
            try await seal(id, member, value)
            return nil
        case .refresh(let id):
            return try await refresh(id)
        case .openRouterKey(let key):
            try await serially { try await self.needs.seal("openrouter", key) }
            return nil
        case .models(let act):
            try await serially { try await self.home().models(act) }
            return nil
        case .process(let family, let item, let prompt, let route):
            try await serially { try await self.home().process(family: family, item: item, prompt: prompt, route: route) }
            return nil
        case .general(let act):
            guard let general else { throw HostRefusal.notHere }
            defer { recompute() }
            try await general.perform(act)
            return nil
        case .import(let act):
            try await importAct(act)
            return nil
        case .upload:
            try await upload()
            return nil
        case .chooseFile(let id, let member):
            try await choose(id, member)
            return nil
        case .chooseApp:
            return try await addChosenApp()?.notice
        case .faces(let what):
            try await serially { try await self.home().faces(what) }
            return nil
        case .verifyHome:
            guard let verifyHome else { throw HostRefusal.notHere }
            let refused: Error?
            do {
                try await verifyHome()
                refused = nil
            } catch {
                refused = error
            }
            await needs.knock()
            if let refused { throw Self.said(refused) }
            return nil
        case .probeHome:
            _ = try await probed()
            return nil
        case .openHome:
            guard let openHome else { throw HostRefusal.notHere }
            do {
                try await openHome()
            } catch {
                throw HostRefusal("Lifestream couldn't start: \(error)")
            }
            return nil
        case .pairHome:
            _ = try await pairedAgain()
            return nil
        case .endInstall(let pass):
            return try await onHome(.endInstall(pass)) { home, _ in
                try await home.revoke(pass: pass)
                return "The previous install is removed. Anything it hadn't synced won't reach Lifestream."
            }
        case .retirePhone(let unit):
            return try await onHome(.retirePhone(unit)) { home, report in
                try await home.retire(unit: unit)
                return "\(report.device(unit)?.name ?? "That phone") is removed. It stops recording once it has synced what it holds."
            }
        case .need(let key, let button):
            let held = needs.heldUpdate.flatMap { $0.key == key ? $0 : nil }
            guard let need = needs.list.first(where: { $0.key == key }) ?? held, need.acts.contains(where: { $0.button == button }) else {
                throw HostRefusal("That no longer needs doing.")
            }
            defer { Task { await read() } }
            try await press(need, button)
            return nil
        case .sheet(let sheet):
            defer { Task { await read() } }
            connectedName = nil
            try await open(sheet)
            return connectedName.map { "\($0) is connected." }
        case .open(let what):
            try await open(what)
            return nil
        case .vault(let act):
            try await vault(act)
            return nil
        }
    }

    private func importAct(_ act: HostAct.ImportAct) async throws {
        guard let imports else { throw HostRefusal("Lifestream on this Mac takes no files yet.") }
        switch act {
        case .choose(let kind):
            try await imports.handOver(await chooseImport(true), kind: kind)
        case .dropped(let kind):
            guard let urls = drops.removeValue(forKey: kind) else { throw HostRefusal("Drop the files on this window again.") }
            do {
                try await imports.handOver(urls, kind: kind)
            } catch {
                drops[kind] = urls + (drops[kind] ?? [])
                throw error
            }
        case .again(let kind, let file):
            guard imports.missing(file, of: kind) else { throw HostRefusal("That file is no longer missing.") }
            guard let url = await chooseImport(false).first else { return }
            try await imports.again(file, at: url)
        case .forget(let kind, let file):
            try imports.forget(file, of: kind)
        case .backupRead(let id):
            try await imports.readBackup(id, password: backupPassword)
        case .backupSettings:
            openPane(Grant.fullDiskAccess.pane)
        }
    }

    private func upload() async throws {
        guard !uploading else { throw HostRefusal("Choose the file in the panel that is open, or cancel it.") }
        uploading = true
        defer { uploading = false }
        guard let file = await choose(FilePanel(title: "Choose the file to send to Lifestream", folder: false)) else { return }
        let folder = drop()
        do {
            _ = try await Task.detached(priority: .userInitiated) { try UploadDomain.drop(file, into: folder) }.value
        } catch {
            throw HostRefusal("Lifestream could not copy that file: \(error.localizedDescription)")
        }
    }

    func dropped(on dialog: String?) -> (([URL]) -> Void)? {
        guard imports != nil, let dialog, dialog.hasPrefix(Self.importDialog), dialog.count > Self.importDialog.count else { return nil }
        let kind = String(dialog.dropFirst(Self.importDialog.count))
        guard kind != Imports.backupKind else { return nil }
        return { [weak self] urls in
            self?.drops[kind, default: []].append(contentsOf: urls)
            self?.droppedOn(kind)
        }
    }

    static let importDialog = "import:"


    func reply(_ act: HostAct) async throws -> [String: Any] {
        if case .probeHome = act { return try await probed() }
        if case .pairHome = act { return try await pairedAgain() }
        if case .agentAnswer(let request) = act { return await Self.agentReply { try await self.answer(request) } }
        if case .agentAccess(let id, let access, let expect) = act {
            return await Self.agentReply { try await self.setAccess(id, access, expect: expect) }
        }
        if case .setupKey(.show) = act {
            return try await perform(act).map { ["key": $0] } ?? [:]
        }
        if case .screenshotTake = act { return await picture() }
        switch act {
        case .agentGuides, .agentAddress, .agentKey, .agentSignIn:
            do { return ["answer": try await guide(act)] } catch { return (Self.said(error) as? HostRefusal ?? HostRefusal("\(error)")).coded }
        default: break
        }
        if case .chooseApp = act {
            guard let chosen = try await addChosenApp() else { return [:] }
            return chosen.added ? ["notice": chosen.notice, "added": true] : ["notice": chosen.notice]
        }
        if case .setting(let id, let member, let value, let was) = act {
            return try await setting(id, member, value, was: was).map { try Self.carried($0) as? [String: Any] ?? [:] } ?? [:]
        }
        return try await perform(act).map { ["notice": $0] } ?? [:]
    }

    private func picture() async -> [String: Any] {
        guard !pictureless else {
            pictureless = false
            return [:]
        }
        guard let image = await snapshot(),
              let jpeg = await Task.detached(priority: .userInitiated, operation: { WindowPicture.jpeg(image) }).value else { return [:] }
        return ["jpeg": jpeg.base64EncodedString()]
    }

    private func setting(_ id: String, _ member: String, _ value: HomeLink.JSON, was: HomeLink.JSON?) async throws -> HomeLink.SettingAnswer? {
        if let settings, settings.local(id, member) {
            try await applyHere(settings, id, member, value)
            return HomeLink.SettingAnswer(landed: .init(connector: id, member: member, value: settings.value(id, member) ?? .null))
        }
        return try await onHome(.setting(id, member: member)) { home, _ in
            try await home.set(id, member, to: value, was: was)
        }
    }

    private func answer(_ request: HomeLink.AnswerRequest) async throws -> HomeLink.AnswerReply {
        guard let agentRequests else { throw HostRefusal(LinkFailure.unpaired) }
        return try await serially {
            do { return try await agentRequests.answer(request) } catch { throw Self.said(error) }
        }
    }

    private func setAccess(_ id: String, _ access: HomeLink.Access, expect: HomeLink.Version) async throws -> HomeLink.AccessDraft {
        guard let agentRequests else { throw HostRefusal(LinkFailure.unpaired) }
        return try await serially {
            do { return try await agentRequests.setAccess(id, access, expect: expect) } catch { throw Self.said(error) }
        }
    }

    private func guide(_ act: HostAct) async throws -> Any {
        let agents = try agents()
        switch act {
        case .agentAddress(let turnOn, let reader): return try Self.carried(try await agents.address(turnOn: turnOn, reader: reader))
        case .agentKey(let app, let name, let access): return try Self.carried(try await agents.makeKey(app, name: name, access: access))
        case .agentSignIn(let id): return try Self.carried(try await agents.signIn(id))
        case .agentGuides: return try JSONSerialization.jsonObject(with: try await agents.guides())
        default: throw HostRefusal.unreadable(nil)
        }
    }

    private func agents() throws -> AgentRequests {
        guard let agentRequests else { throw HostRefusal(LinkFailure.unpaired) }
        return agentRequests
    }

    private static func agentReply<Value: Encodable>(_ work: () async throws -> Value) async -> [String: Any] {
        do { return ["answer": try carried(try await work())] } catch {
            return (said(error) as? HostRefusal ?? HostRefusal("\(error)")).coded
        }
    }

    private static func carried<Value: Encodable>(_ value: Value) throws -> Any {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try JSONSerialization.jsonObject(with: encoder.encode(value))
    }

    private func vault(_ act: HostAct.VaultAct) async throws {
        switch act {
        case .open:
            needs.openKey(.asked)
        case .unlock:
            guard let locked = needs.vaultNeed else { throw HostRefusal("Your passwords are not locked.") }
            try await press(locked, .do)
        }
    }

    private func allowStore(_ id: String) async throws {
        let mine = opening
        guard let stores = stores() else { throw HostRefusal.notHere }
        if stores.state(of: id) == nil { await needs.knock() }
        guard let state = stores.state(of: id) else { throw HostRefusal("This Mac has not been told of that store yet, so there is nothing to allow.") }
        if state == .unsafe, let fault = stores.faults(of: id).first {
            throw HostRefusal("This Mac never reads \(await storeName(id))'s store, so there is nothing to allow: \(fault).")
        }
        guard let asking = stores.asking(id) else { return }
        let name = await storeName(id)
        try await show(.store(asking, name: name), from: mine)
        guard stores.state(of: id) == .allowed else { return }
        await needs.knock()
        refreshHere?(id)
    }

    private func storeName(_ id: String) async -> String {
        (try? await serially { try await self.home().report() })?.connector(id)?.name ?? id
    }

    func answerStore(_ answer: StoreConsent.Answer, to asking: StoreAsking) -> String? {
        guard let stores = stores() else { return HostRefusal.notHere.words }
        do {
            try stores.answer(answer, to: asking)
        } catch {
            return "Lifestream could not keep your answer on this Mac: \(error.localizedDescription)"
        }
        tellStores(stores.stated())
        sheet = nil
        return nil
    }

    private func seal(_ id: String, _ member: String, _ value: String) async throws {
        try await onHome(.seal(id, member: member)) { home, _ in
            try await home.sealField(id, member: member, value: value)
        }
    }

    private func refresh(_ id: String) async throws -> String? {
        guard let refreshNow else { throw HostRefusal.notHere }
        let report = try await serially { try await self.home().report() }
        if let blocked = report.connector(id)?.refreshNow?.blocked { throw HostRefusal(blocked.words) }
        guard report.offers(.refresh(id)) else { throw HostRefusal.notHere }
        let answer: HomeLink.RefreshAnswer
        do { answer = try await refreshNow(id) } catch { throw Self.said(error) }
        if case .blocked(let blocked) = answer { throw HostRefusal(blocked.words) }
        refreshHere?(id)
        return nil
    }

    private func choose(_ id: String, _ member: String) async throws {
        let report = try await serially { try await self.home().report() }
        let here = await Task.detached(operation: unit).value
        guard report.offers(.setting(id, member: member), here: here), let field = report.member(id, member), field.control == .path else {
            throw HostRefusal.notHere
        }
        let folder = field.folder == true
        let title = "Choose \(field.label)"
        guard let chosen = await choose(FilePanel(title: title, folder: folder)) else { return }
        _ = try await serially { try await self.home().set(id, member, to: .string(chosen.path)) }
    }

    private func applyHere(_ settings: MacSettings, _ id: String, _ member: String, _ value: HomeLink.JSON) async throws {
        let kept: Bool
        do { kept = try settings.set(id, member, to: value) } catch {
            throw HostRefusal("Lifestream could not keep that setting on this Mac, so nothing was done.")
        }
        guard kept else { throw HostRefusal("Lifestream cannot use that setting, so nothing was done.") }
        await settings.apply()
        recompute()
        Task { await needs.knock() }
    }

    private func addChosenApp() async throws -> (notice: String, added: Bool)? {
        guard let settings, settings.local("screen", "apps") else {
            throw HostRefusal.notHere
        }
        guard let url = await pickApp(), !closed else { return nil }
        guard let app = await Task.detached(operation: { Detection.app(at: url) }).value, RecordingModes.isValidBundleID(app.id) else {
            throw HostRefusal("That app has no bundle identifier, so Lifestream can't tell it apart.")
        }
        guard app.id != RecordingModes.ownApp else { throw HostRefusal("Lifestream never records itself.") }
        guard !closed else { return nil }
        located[app.id] = .some(app)
        let field = settings.value("screen", "apps")?.array ?? []
        guard !field.contains(where: { $0["app"]?.string == app.id }) else {
            listApps(found: true)
            recompute()
            return ("\(app.name) is already listed.", false)
        }
        try await applyHere(settings, "screen", "apps",
                            .array(field + [.object(["app": .string(app.id), "mode": .string(RecordingMode.activity.rawValue)])]))
        return ("\(app.name) added.", true)
    }

    private func first() throws -> SetupHost {
        guard let setup else { throw HostRefusal("Lifestream is set up already.") }
        return setup
    }

    func press(_ need: Need, _ button: Need.Button) async throws {
        if button == .do, let page = need.page { return showPage(page) }
        switch (button, need) {
        case (.tryAgain, _): try refused(await needs.retry()?.value)
        case (.do, .filesRefused): try refused(await needs.allowFiles()?.value)
        case (.do, .allow): try await show(.vaultAllow)
        case (.do, .unlock): try await show(.recoveryKey)
        case (.do, .saveRecoveryKey): needs.openKey(.asked)
        case (.do, .homeLocked(allow: true)): try refused(await needs.allow()?.value)
        case (.do, .homeLocked): return
        case (.do, .updateReady): needs.installUpdate()
        case (.do, .password(let asked, let set)):
            let report = try await serially { try await self.home().report() }
            guard let connector = asked.connector, let member = set.member, let secret = report.member(connector, member)?.secret else {
                throw HostRefusal.notHere
            }
            try await show(.password(need, secret: secret))
        case (.do, .notice(let home)) where home.acts.contains(where: { $0.do == .storage }): NSWorkspace.shared.open(Self.storage)
        case (.do, _): throw HostRefusal("That no longer needs doing.")
        }
    }

    private func refused(_ answer: String??) throws {
        switch answer {
        case .none: throw HostRefusal("Lifestream is already doing that.")
        case .some(.some(let words)): throw HostRefusal(words)
        case .some(.none): return
        }
    }

    private func open(_ asked: HostAct.Sheet) async throws {
        let mine = opening
        if let locked = needs.vaultNeed { return try await press(locked, .do) }
        let report = try await serially { try await self.home().report() }
        guard let connector = report.connector(asked.connector), let sheet = Self.sheet(of: connector, asked.route) else {
            throw HostRefusal("Lifestream has no such sign-in for that connector.")
        }
        try await show(sheet, from: mine)
    }

    static func sheet(of connector: Connector, _ id: String) -> HostSheet? {
        guard let route = connector.routes.first(where: { $0.id == id }), let way = HostAct.SignInWay(rawValue: route.way) else { return nil }
        switch way {
        case .key:
            let typed = !route.fields.isEmpty && route.fields.allSatisfy { field in connector.members.contains { $0.key == field } }
            return typed ? .account(connector, route) : nil
        case .device: return .device(connector, route)
        case .client: return route.client.map { .client(connector, route, $0) }
        }
    }

    private func show(_ next: HostSheet, from mine: Int? = nil) async throws {
        guard (mine ?? opening) == opening else { return }
        guard sheet == nil else { throw HostRefusal("Close the sheet that is open first.") }
        failure = nil
        sheet = next
        await withCheckedContinuation { shown = $0 }
    }

    private func endOpening() {
        opening += 1
        working = false
        failure = nil
        refusedField = nil
        device = nil
        devicePolls?.cancel()
        devicePolls = nil
        client = nil
        clientAttempt = nil
        clientPolls?.cancel()
        clientPolls = nil
        shown?.resume()
        shown = nil
    }

    private func open(_ what: HostAct.Opening) async throws {
        switch what {
        case .homeLog:
            NSWorkspace.shared.open(Launcher.log(.home))
        case .storage:
            NSWorkspace.shared.open(Self.storage)
        case .homeFolder:
            guard let folder else { throw HostRefusal.noHome }
            NSWorkspace.shared.activateFileViewerSelecting([folder])
        case .loginItems:
            NSWorkspace.shared.open(Grant.openAtLogin.pane)
        case .app(let app):
            guard let found = await Task.detached(operation: { Self.installed(app) }).value else {
                throw HostRefusal("\(app.rawValue) is not on this Mac: get it first.")
            }
            NSWorkspace.shared.openApplication(at: found, configuration: NSWorkspace.OpenConfiguration(), completionHandler: nil)
        case .browserStore(let browser):
            try await open(Self.storeListing, in: browser)
        case .site(let url, .some(let browser)):
            try await open(url, in: browser)
        case .site(let url, nil):
            let browserFor = browserFor
            let app = await Task.detached { browserFor(url) }.value
            if let app {
                NSWorkspace.shared.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration(), completionHandler: nil)
            } else {
                NSWorkspace.shared.open(url)
            }
        }
    }

    nonisolated static func installed(_ app: HostAct.App) -> URL? {
        switch app {
        case .tailscale:
            let found = ["io.tailscale.ipn.macsys", "io.tailscale.ipn.macos"].lazy
                .compactMap { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) }.first
            let usual = URL(fileURLWithPath: "/Applications/Tailscale.app", isDirectory: true)
            return found ?? (FileManager.default.fileExists(atPath: usual.path) ? usual : nil)
        case .messages:
            return NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.MobileSMS")
        }
    }

    private func open(_ url: URL, in id: String) async throws {
        guard let (_, app) = await Task.detached(operation: { Detection.browserApp(id) }).value else {
            let name = Detection.family(id)?.name ?? "That browser"
            throw HostRefusal("\(name) is not on this Mac: install it, then add the extension.")
        }
        NSWorkspace.shared.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration(), completionHandler: nil)
    }


    private struct Flow {
        var wanted = false
        var desired = false
        var run = 0
        var asking = false
    }

    func want(_ act: HostAct) -> Bool {
        switch act {
        case .pairing(let open): intend(pairing: open, browser: browserFlow.wanted)
        case .connectWait(let open): intend(pairing: pairingFlow.wanted, browser: open)
        default: return false
        }
        return true
    }

    func resetIntent() {
        intend(pairing: false, browser: false)
    }

    private func intend(pairing: Bool, browser: Bool) {
        if pairing, !pairingFlow.wanted { account = Task.detached(operation: appleID) }
        pairingFlow.wanted = pairing
        browserFlow.wanted = browser
        wake()
    }

    func wake() {
        desireNow()
        var dropped = false
        if !pairingFlow.wanted || closed, shownPairing != nil {
            shownPairing = nil
            dropped = true
        }
        if !browserFlow.wanted || closed, connectRequests != nil {
            connectRequests = nil
            dropped = true
        }
        if dropped { recompute() }
        follow(\.pairingFlow, ask: { [weak self] home in try await home.showPairing(appleID: await self?.account?.value) },
               publish: { [weak self] made, current in await self?.show(made, current) })
        follow(\.browserFlow, ask: { try await $0.connectRequests() },
               publish: { [weak self] requests, _ in self?.show(requests) })
    }

    private func desireNow() {
        let visible = seen()
        desire(\.pairingFlow, pairingFlow.wanted && visible && !closed)
        desire(\.browserFlow, browserFlow.wanted && !closed)
    }

    private func desire(_ flow: ReferenceWritableKeyPath<MacHost, Flow>, _ desired: Bool) {
        guard self[keyPath: flow].desired != desired else { return }
        self[keyPath: flow].desired = desired
        self[keyPath: flow].run += 1
    }

    private func follow<Value: Sendable>(_ flow: ReferenceWritableKeyPath<MacHost, Flow>,
                                         ask: @escaping @MainActor (ConnectorsHome) async throws -> Value,
                                         publish: @escaping @MainActor (Value, _ current: @escaping @MainActor () -> Bool) async -> Void) {
        guard self[keyPath: flow].desired, !self[keyPath: flow].asking else { return }
        let mine = self[keyPath: flow].run
        let current = { [weak self] in self?[keyPath: flow].run == mine }
        self[keyPath: flow].asking = true
        Task {
            defer {
                self[keyPath: flow].asking = false
                if !current() { wake() }
            }
            let answer = try? await serially { () -> Value? in
                self.desireNow()
                guard current() else { return nil }
                return try await ask(try await self.home())
            }
            guard let answer, current() else { return }
            await publish(answer, current)
        }
    }

    private func show(_ made: PairingAnswer, _ current: @MainActor () -> Bool) async {
        var qr: String?
        if let link = made.link {
            if let drawn, drawn.link == link {
                qr = drawn.qr
            } else {
                let draw = drawQR
                qr = await Task.detached { draw(link) }.value
                guard current() else { return }
                if let qr { drawn = (link, qr) }
            }
        }
        shownPairing = HostState.Pairing(made, qr: qr)
        recompute()
    }

    private func show(_ requests: [ConnectRequest]) {
        let before = connectRequests
        connectRequests = requests
        recompute()
        if before == nil { Task { await needs.knock() } }
        guard !requests.isEmpty else { return }
        let seen = Set((before ?? []).map(\.id))
        if let new = requests.first(where: { !seen.contains($0.id) }) { asked(new.browser) }
    }

    private func signIn(_ act: HostAct.AskLoginAct) async throws {
        guard let door else { throw HostRefusal("Lifestream on this Mac is not set up yet.") }
        let mine = closes
        if case .start(let of) = act { askStarting[of, default: 0] += 1 }
        defer { if case .start(let of) = act { askStarting[of, default: 1] -= 1 } }
        let answered: AskLogin
        do {
            answered = try await door.send(act)
        } catch {
            throw Self.said(error)
        }
        guard !closed else { return }
        guard mine == closes else {
            Task { await read() }
            return
        }
        askLogin = answered
        recompute()
        watchAsk()
    }

    private func watchAsk() {
        guard !closed, let door, askLogin?.underWay.isEmpty == false, askWatch == nil else { return }
        askWatch = follow { host in
            guard let read = try? await door.read() else { return !Task.isCancelled }
            guard !Task.isCancelled else { return false }
            host.askLogin = read
            host.recompute()
            if read.underWay.isEmpty { host.askWatch = nil }
            return !read.underWay.isEmpty
        }
    }

    private func follow(_ ask: @escaping @MainActor (MacHost) async -> Bool) -> Task<Void, Never> {
        let poll = poll
        return Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: poll)
                guard !Task.isCancelled, let self, await ask(self) else { return }
            }
        }
    }


    private func home() async throws -> ConnectorsHome {
        guard let socket = await socket() else { throw HostRefusal.noHome }
        return ConnectorsHome(socket: socket)
    }

    private func onHome<Value: Sendable>(_ act: ConnectorsReport.Act,
                                         _ work: @escaping @MainActor (ConnectorsHome, ConnectorsReport) async throws -> Value) async throws -> Value {
        try await serially {
            let home = try await self.home()
            let report = try await home.report()
            guard report.offers(act, here: self.thisUnit) else { throw HostRefusal.notHere }
            return try await work(home, report)
        }
    }

    private func serially<Value: Sendable>(from mine: Int? = nil,
                                           _ work: @escaping @MainActor () async throws -> Value) async throws -> Value {
        let previous = queue
        waiting += 1
        let task = Task { @MainActor in
            await previous?.value
            self.waiting -= 1
            try Task.checkCancellation()
            if let mine, mine != self.opening { throw CancellationError() }
            return try await work()
        }
        queue = Task { _ = try? await task.value }
        do {
            return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
        } catch {
            throw Self.said(error)
        }
    }

    nonisolated static func refusal(_ outcome: SettingOutcome) -> HostRefusal? {
        switch outcome {
        case .taken, .changed: nil
        case .refused: HostRefusal(.refused(ReachWords.refused))
        case .saving: HostRefusal(.saving)
        case .unknown(let words): HostRefusal(.unknown(words))
        case .unreachable: HostRefusal(.notSent)
        }
    }

    nonisolated static func said(_ error: Error, now: Date = Date()) -> Error {
        switch error {
        case is CancellationError, is HostRefusal: return error
        case let failure as HomeSocketError:
            guard let said = ReachWords.act(state(of: failure, now: now)) else { return HostRefusal("\(failure)") }
            return HostRefusal(said)
        case let failure as LinkFailure: return HostRefusal(failure, now: now)
        default: return HostRefusal("\(error)")
        }
    }

    nonisolated static func state(of failure: HomeSocketError, now: Date) -> HomeLink.RequestState {
        guard case .refused(let refusal) = failure else { return .reach }
        guard let status = refusal.status else { return .refused(refusal.words) }
        let notNow: HomeLink.NotNow? = switch refusal.wait {
        case "starting": .starting(HomeLink.Starting(title: refusal.words))
        case "needs": .needs(HomeLink.Held(title: refusal.words, detail: ""))
        case "busy": .busy
        default: nil
        }
        return HomeLink.state(status: status, code: refusal.code, words: refusal.words, retryAfter: refusal.retryAfter, notNow: notNow, now: now)
    }

    private func probed() async throws -> [String: Any] {
        guard let probe else { throw HostRefusal.notHere }
        let reach = HostState.Reach(await probe(), clock: .placeholder(at: Date(), zone: .current))
        return ["state": reach.state, "revision": reach.revision]
    }

    struct PairAgain {
        let link: HomeLink
        let setUp: @MainActor () -> Void
    }

    private func pairedAgain() async throws -> [String: Any] {
        guard let pairAgain else { throw HostRefusal.notHere }
        let link = pairAgain.link
        switch await Task.detached(operation: { link.snapshot.reach }).value {
        case .passRefused: break
        case .unpaired: throw HostRefusal("This Mac isn't paired, so there was no pass to forget.")
        default: throw HostRefusal("Lifestream still knows this Mac, so its pass was kept.")
        }
        do {
            try await Task.detached { try link.forget() }.value
        } catch {
            throw HostRefusal("Lifestream couldn't forget this Mac's pass, so it stays paired: \(error)")
        }
        let reach = HostState.Reach(await Task.detached { link.snapshot }.value, clock: .placeholder(at: Date(), zone: .current))
        pairAgain.setUp()
        return ["state": reach.state, "revision": reach.revision]
    }


    @discardableResult
    func connectAccount(_ connector: String, route: String, values: [String: String]) -> Task<Bool, Never>? {
        request({ try await $0.connectAccount(connector, route: route, values: values) })
    }

    @discardableResult
    func startDevice(_ connector: String, route: String) -> Task<Bool, Never>? {
        guard !working else { return nil }
        devicePolls?.cancel()
        devicePolls = nil
        device = nil
        return request({ try await $0.deviceStart(connector, route: route) }) { code in
            guard code.open.scheme == "https" else {
                return self.failure = "Lifestream was given a sign-in page it can't open."
            }
            self.device = .code(code.code, open: code.open)
            let mine = self.opening
            self.devicePolls = Task { await self.followDevice(connector, route, code, from: mine) }
        }
    }

    private func followDevice(_ connector: String, _ route: String, _ code: ConnectorsHome.DeviceCode, from mine: Int) async {
        var interval = max(code.intervalMs, 1000)
        while true {
            do { try await sleep(.milliseconds(interval)) } catch { return }
            guard mine == opening else { return }
            let answer: ConnectorsHome.DevicePoll
            do {
                let waited = interval
                answer = try await serially(from: mine) {
                    try await self.home().devicePoll(connector, route: route, attempt: code.attempt, intervalMs: waited)
                }
            } catch {
                guard mine == opening, !Task.isCancelled, !(error is CancellationError) else { return }
                device = nil
                failure = (error as? HostRefusal)?.words ?? "\(error)"
                return
            }
            guard mine == opening, !Task.isCancelled || answer.state == .signedIn else { return }
            switch answer.state {
            case .pending: interval = max(answer.intervalMs ?? interval, 1000)
            case .denied: return device = .denied
            case .expired: return device = .expired
            case .signedIn: return device = .signedIn
            }
        }
    }

    static let clientEvery: Duration = .seconds(2)

    @discardableResult
    func startClient(_ connector: String, route: String, client typed: HomeLink.ClientTyped?) -> Task<Bool, Never>? {
        guard !working else { return nil }
        clientPolls?.cancel()
        clientPolls = nil
        client = nil
        clientAttempt = nil
        return request({ try await $0.clientStart(connector, route: route, client: typed) }) { started in
            guard started.open.scheme == "https" else {
                return self.failure = "Lifestream was given a sign-in page it can't open."
            }
            self.clientAttempt = started.attempt
            self.client = .started(open: started.open, listening: started.listening)
            self.browse(started.open)
            guard started.listening else { return }
            let mine = self.opening
            self.clientPolls = Task { await self.followClient(connector, route, started.attempt, from: mine) }
        }
    }

    @discardableResult
    func finishClient(_ connector: String, route: String, address: String) -> Task<Bool, Never>? {
        guard let attempt = clientAttempt, client != .signedIn else { return nil }
        return request({ try await $0.clientFinish(connector, route: route, attempt: attempt, address: address) }) { finished in
            guard finished.state == .signedIn else { return }
            self.clientPolls?.cancel()
            self.client = .signedIn
        }
    }

    private func followClient(_ connector: String, _ route: String, _ attempt: HomeLink.JSON, from mine: Int) async {
        while true {
            do { try await sleep(Self.clientEvery) } catch { return }
            guard mine == opening, !Task.isCancelled else { return }
            let answer: ConnectorsHome.ClientFinished
            do {
                answer = try await serially(from: mine) {
                    guard self.client != .signedIn else { throw CancellationError() }
                    return try await self.home().clientFinish(connector, route: route, attempt: attempt, address: nil)
                }
            } catch {
                guard mine == opening, !Task.isCancelled, !(error is CancellationError) else { return }
                failure = (error as? HostRefusal)?.words ?? "\(error)"
                refusedField = (error as? HostRefusal)?.field
                return
            }
            guard mine == opening, !Task.isCancelled || answer.state == .signedIn else { return }
            if answer.state == .signedIn { return client = .signedIn }
        }
    }

    func connected(_ name: String) {
        connectedName = name
    }

    func copy(_ text: String) {
        SecretCopy.put(text, on: pasteboard, later: later)
    }

    @discardableResult
    private func request<Value: Sendable>(_ work: @escaping @MainActor (ConnectorsHome) async throws -> Value,
                                          apply: @escaping (Value) -> Void = { _ in }) -> Task<Bool, Never>? {
        guard !working else { return nil }
        let mine = opening
        working = true
        failure = nil
        refusedField = nil
        return Task {
            let answer: Result<Value, Error>
            do {
                answer = .success(try await serially(from: mine) { try await work(try await self.home()) })
            } catch {
                answer = .failure(error)
            }
            guard mine == opening else { return false }
            working = false
            switch answer {
            case .success(let value):
                apply(value)
                return true
            case .failure(let error):
                failure = (error as? HostRefusal)?.words ?? "\(error)"
                refusedField = (error as? HostRefusal)?.field
                return false
            }
        }
    }
}

enum DeviceSignIn: Equatable {
    case code(String, open: URL)
    case denied, expired, signedIn
}

enum ClientSignIn: Equatable {
    case started(open: URL, listening: Bool)
    case signedIn
}

enum HostSheet: Identifiable, Equatable {
    case vaultAllow
    case recoveryKey
    case password(Need, secret: String)
    case account(Connector, Connector.Route)
    case device(Connector, Connector.Route)
    case client(Connector, Connector.Route, Connector.Route.Client)
    case store(StoreAsking, name: String)

    var id: String {
        switch self {
        case .vaultAllow: return "vault-allow"
        case .recoveryKey: return "recovery-key"
        case .password(let need, _): return "password-\(need.id)"
        case .account(let connector, let route), .device(let connector, let route), .client(let connector, let route, _):
            return "signin-\(connector.id)-\(route.id)"
        case .store(let asking, _): return "store-\(asking.connector)-\(asking.digest)"
        }
    }
}

enum ImportPanel {
    @MainActor static func run(over window: NSWindow?, several: Bool) async -> [URL] {
        let panel = NSOpenPanel()
        panel.message = several ? "Choose your export's files" : "Choose the file again"
        panel.prompt = "Choose"
        panel.allowsMultipleSelection = several
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        let answer: NSApplication.ModalResponse
        if let window {
            answer = await panel.beginSheetModal(for: window)
        } else {
            answer = panel.runModal()
        }
        return answer == .OK ? panel.urls : []
    }
}

enum AppPanel {
    @MainActor static func run(over window: NSWindow?) async -> URL? {
        let panel = NSOpenPanel()
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        panel.allowedContentTypes = [.applicationBundle]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.message = "Choose an app to keep at Activity only."
        panel.prompt = "Choose"
        let answer: NSApplication.ModalResponse
        if let window {
            answer = await panel.beginSheetModal(for: window)
        } else {
            answer = panel.runModal()
        }
        return answer == .OK ? panel.url : nil
    }
}

struct FilePanel: Equatable {
    let title: String
    let folder: Bool

    @MainActor func run(over window: NSWindow?) async -> URL? {
        let panel = NSOpenPanel()
        panel.message = title
        panel.prompt = folder ? "Choose" : "Upload"
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = folder
        panel.canChooseFiles = !folder
        panel.canCreateDirectories = folder
        let answer: NSApplication.ModalResponse
        if let window {
            answer = await panel.beginSheetModal(for: window)
        } else {
            answer = panel.runModal()
        }
        return answer == .OK ? panel.url : nil
    }
}
