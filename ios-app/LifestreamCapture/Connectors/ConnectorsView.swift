import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI
import UIKit

struct ConnectorsView: View {
    var body: some View {
        StreamsPage().allowingSources()
    }
}

private struct StreamsPage: View {
    @EnvironmentObject private var model: CaptureAppModel
    @ObservedObject private var needs = PhoneNeeds.shared
    @ObservedObject private var permissions = PhoneNeeds.shared.permissions
    @ObservedObject private var shipper = AppRuntime.shared.shipping.shipper
    @ObservedObject private var reach = AppRuntime.shared.reach
    @ObservedObject private var home = AppRuntime.shared.homeStreams
    @ObservedObject private var asks = AppRuntime.shared.agents
    @ObservedObject private var agents = AgentsStore.shared
    @Environment(\.allowSource) private var allow
    @Environment(\.openURL) private var openURL
    @State private var pairing = false
    @State private var query = ""
    @State private var chosen: ConnectorsShown?
    @State private var removedShown = false
    @State private var allNeeds = AppRuntime.asked("--ui-test-needs-open")
    @State private var copied: [String: Int] = [:]
    @State private var sheet: StreamSheet?
    @State private var after: (@MainActor () -> Void)?

    @State private var path: [ConnectorsRoute] = AppNavigation.designPush.filter(\.agents)

    var body: some View {
        NavigationStack(path: $path) {
            ConnectorsScreen(StreamsWords.page) {
                SearchField(text: $query.timed(.searchKeystroke), placeholder: StreamsWords.search)
            } controls: {
                DrawerClose { AppNavigation.shared.presented = nil }
                    .accessibilityIdentifier("streams.close")
            } content: {
                page
                    .environment(\.cockpitRowsBare, true)
                    .environment(\.cockpitRowsFaces, Cockpit.Space.s6)
            }
            .refreshable {
                guard readsHome else { return }
                async let streams: Void = home.read()
                async let readers: Void = agents.readList()
                _ = await (streams, readers)
            }
            .task { if readsHome { await agents.readList() } }
            .navigationDestination(for: ConnectorsRoute.self) { route in
                let at = path.firstIndex(of: route) ?? path.count - 1
                AgentsDestination(route: route)
                    .navigationBarTitleDisplayMode(.inline)
                    .environment(\.drawerPush, DrawerPush(back: at > 0 ? AgentsStore.shared.title(path[at - 1]) : StreamsWords.page) {
                        AppNavigation.shared.presented = nil
                    })
                    .environment(\.openConnectors, OpenConnectorsAction { path.append($0) })
            }
            .sheet(isPresented: $pairing) { PairingView() }
            .sheet(item: $sheet, onDismiss: { after?(); after = nil }) { sheet in
                StreamSheetStack(sheet: sheet, close: { self.sheet = nil }, leave: leave)
                    .environmentObject(model)
            }
        }
        .feedbackHost()
        .readsStreams(open: sheet)
        .onChange(of: AppNavigation.shared.checkInRoute, initial: true) { _, route in
            if route != nil { sheet = nil }
        }
        .onChange(of: query) {
            AccessibilityNotification.Announcement(StreamsWords.counted(shown.count)).post()
        }
    }


    private var readsHome: Bool { reach.snapshot.reach != .unpaired }

    private var answer: StreamsAnswer? {
        readsHome ? home.answer : nil
    }

    private var report: HomeLink.StreamsReport? { answer?.report }

    private var reading: Bool { readsHome && home.reading }

    private var rows: [StreamRow] {
        guard let answer else { return PhoneSource.allCases.map(StreamRow.declared) }
        return answer.page.rows.map { StreamRow.served($0, in: answer) }
    }

    private var shown: [StreamRow] { rows.filter { $0.matches(query) } }

    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    private var imports: [HomeLink.Import] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace)
        return report?.imports.filter { kind in words.allSatisfy { kind.name.lowercased().contains($0) } } ?? []
    }

    @ViewBuilder private var page: some View {
        let rows = self.rows.filter { !$0.standsInImport }
        let matched = rows.filter { $0.matches(query) }
        let imports = self.imports
        let side = ConnectorsShown.of(chosen, rows: self.rows, imports: report?.imports ?? [])
        let kept = matched.filter { $0.connected == (side == .connected) } + (reading ? StreamRow.reading : [])
        let keptImports = imports.filter { $0.connected == (side == .connected) }
        VStack(alignment: .leading, spacing: Self.flatSection) {
            if !shipper.paired { pairRow }
            if !searching {
                needsYou(rows)
                agentAsks
            }
            Views(StreamsWords.page, options: [
                ViewOption(StreamsWords.connected, id: ConnectorsShown.connected,
                           count: matched.filter(\.connected).count + imports.filter(\.connected).count,
                           reading: reading, identifier: "connectors.shown.connected"),
                ViewOption(StreamsWords.notConnected, id: ConnectorsShown.not,
                           count: matched.filter { !$0.connected }.count + imports.filter { !$0.connected }.count,
                           reading: reading, identifier: "connectors.shown.not"),
            ], selection: Binding(get: { side }, set: { chosen = $0 }))
            if kept.isEmpty, keptImports.isEmpty, !reading {
                none(searching ? StreamsWords.none : side == .connected ? StreamsWords.noneConnected : StreamsWords.none)
            }
            sections(StreamRow.sections(kept, imports: keptImports, fresh: !rows.contains { $0.state != .setup }))
            if side == .not, report?.adding != nil { entryRow }
            homeRead
            if !searching { Card(StreamsWords.devices, group: true, flat: true) { yourHome; devices } }
        }
    }

    @ViewBuilder private var agentAsks: some View {
        let open = asks.asks.filter { $0.state == .open }
        if !open.isEmpty {
            Card(AgentsWords.needsYou, group: true, flat: true) {
                ForEach(open) { ask in
                    ListRow(ask.name, meta: ask.line, leading: .symbol(AgentsStore.icon(.agent)),
                            separator: ask.id != open.last?.id,
                            control: .act(AgentsWords.review, busy: false) { asks.review(ask) },
                            action: { asks.review(ask) }) { EmptyView() }
                        .accessibilityIdentifier("connectors.ask.\(ask.id)")
                }
            }
        }
    }

    private var entryRow: some View {
        Card(group: true, flat: true) {
            ListRow(StreamsWords.Entry.name, meta: StreamsWords.Entry.line, leading: .icon(.codingAgent), chevron: true,
                    selected: sheet == .adding(query), separator: false, action: { sheet = .adding(query) })
                .accessibilityIdentifier("connectors.adding")
        }
    }

    private static let flatSection = Cockpit.Gap.section - 16

    @ViewBuilder private func needsYou(_ rows: [StreamRow]) -> some View {
        let strips = needs.strips
        if !strips.isEmpty {
            StatusStack(strips, open: $allNeeds, identifier: "needs") { strip, fold in
                needStrip(strip, fold: fold, rows: rows)
            }
        }
    }

    private func needStrip(_ strip: NeedStrip, fold: StatusStrip.Fold?, rows: [StreamRow]) -> some View {
        let stopped = strip.weight == .stopped
        let dismiss: (() -> Void)? = stopped ? nil : { Task { await needs.dismiss(strip) } }
        var act: StatusStrip.Act?
        var opens: (() -> Void)?
        if case .home(let need) = strip {
            let stream = home.read?.connectors.first { $0.id == need.connector }
            let takes = need.acts.filter { $0.taken(by: shipper.unit, on: stream) && !$0.opensPage }
            opens = page(need, rows)
            if takes.count == 1 {
                let take = takes[0]
                act = StatusStrip.Act(take.label, busy: home.busy(take)) {
                    if take.do == .copy { copied[need.id, default: 0] += 1 }
                    home.perform(take, on: stream, open: openURL, allow: allow, page: OpenConnectorsAction { _ in })
                }
            } else if takes.isEmpty, let page = need.acts.first(where: \.opensPage), let opens {
                act = StatusStrip.Act(page.label, perform: opens)
            }
        }
        return StatusStrip(stopped ? .stopped : .needs, title: strip.title, line: strip.line ?? strip.about, act: act, details: opens,
                           dismiss: dismiss, fold: fold, ground: stopped ? .stopped : .advice, identifier: "needs.\(strip.id)")
            .cockpitDone(StreamsWords.copied, after: copied[strip.id, default: 0])
    }

    private func page(_ need: HomeLink.Need, _ rows: [StreamRow]) -> (() -> Void)? {
        if let kind = need.acts.first(where: { $0.do == .import })?.kind { return { sheet = .importKind(kind) } }
        guard let row = need.heldBack.lazy.compactMap({ stream in rows.first { !$0.sample && $0.holds(stream) } }).first else { return nil }
        return { sheet = row.sheet }
    }

    @ViewBuilder private func sections(_ sections: [StreamSection]) -> some View {
        let lastSamples = sections.last { $0.rows.contains(where: \.sample) }?.id
        ForEach(sections) { section in
            let samples = section.rows.filter(\.sample)
            let lastRow = section.rows.last?.id
            Card(section.label, group: true, flat: true) {
                ForEach(section.imports) { kind in
                    importRow(kind, last: kind.kind == section.imports.last?.kind && section.rows.isEmpty)
                }
                ForEach(section.rows.filter { !$0.sample }) { each in streamRow(each, last: each.id == lastRow) }
                if !samples.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(samples) { each in streamRow(each, last: each.id == lastRow) }
                    }
                    .reading(true)
                }
            }
            .reading(!samples.isEmpty && samples.count == section.rows.count && section.imports.isEmpty)
            if section.id == lastSamples { WaitLine() }
        }
        .waiting(sections.contains { $0.rows.contains(where: \.sample) })
    }

    private var pairRow: some View {
        Card(group: true, flat: true) {
            ListRow(StreamsWords.Pair.title, meta: StreamsWords.Pair.line, leading: .symbol(.workMac), separator: false,
                    control: .lead(StreamsWords.Pair.button) { pairing = true })
                .accessibilityIdentifier("connectors.pair")
        }
    }

    private func none(_ words: String) -> some View {
        Text(words)
            .cockpit(.body)
            .foregroundStyle(Cockpit.Color.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("connectors.none")
    }

    private func streamRow(_ row: StreamRow, last: Bool) -> some View {
        let control: ListRow<RowEnd?>.Control? = row.act.map { act in
            .act(act.label, busy: home.busy(act)) { home.perform(act, open: openURL, allow: allow) }
        }
        return ListRow(row.name, meta: row.meta.isEmpty ? nil : row.meta, area: row.kind?.name, leading: .symbol(row.icon),
                       chevron: control == nil, selected: sheet == row.opens, separator: !last, control: control,
                       action: { sheet = row.opens }) {
            (control == nil ? row.end : nil).map(RowEnd.init)
        }
        .environment(\.cockpitRowQuiet, row.state == .setup)
        .accessibilityIdentifier(row.identifier)
    }

    private func importRow(_ kind: HomeLink.Import, last: Bool) -> some View {
        ListRow(kind.name, meta: kind.line, area: StreamsWords.imports,
                leading: .symbol(Cockpit.Icon(rawValue: kind.icon) ?? .file), chevron: true, selected: sheet == .importKind(kind.kind),
                separator: !last, action: { sheet = .importKind(kind.kind) }) {
            kind.health.state.rowMark.map(RowEnd.init)
        }
        .accessibilityIdentifier("import.\(kind.kind)")
    }

    @ViewBuilder private var homeRead: some View {
        if readsHome, home.read == nil, let failure = home.failure {
            ReadLack(failure, lacks: HomeConnectorsModel.lacks, words: HomeConnectorsModel.sentence(failure))
        } else if readsHome, let words = HomeConnectorsModel.waiting(read: home.read != nil, failure: home.failure,
                                                                       lacking: reach.lacks) {
            Text(words)
                .cockpit(.footnote)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("connectors.waits")
        }
    }

    private var yourHome: some View {
        let link = self.link
        return ListRow(StreamsWords.home, meta: link.word, mono: link.kind == nil, signal: link.kind, leading: .symbol(.home), chevron: true,
                       selected: sheet == .yourHome, action: { sheet = .yourHome })
            .accessibilityIdentifier("machinery.home")
    }

    private var link: SignalMark {
        guard shipper.paired else { return SignalMark(kind: .idle, word: "Not paired") }
        switch shipper.state.outcome {
        case .held, .refused, .storeFailed: return SignalMark(kind: .caution, word: "Needs you")
        default: break
        }
        if case .unreachable = reach.snapshot.reach { return SignalMark(kind: .warning, word: "Can't reach") }
        guard let at = reach.snapshot.lastReached else { return SignalMark(kind: nil, word: "Not reached yet") }
        return SignalMark(kind: nil, word: ReachWords.lastReached(at, clock: HomeClock.current.clock, now: AppClock.now))
    }

    @ViewBuilder private var devices: some View {
        let unit = shipper.unit
        let mine = unit.flatMap { unit in report?.devices.first { $0.unit == unit } }
        let recorder = ThisPhoneSheet.recorder(model.serviceRequested)
        let others = reading ? DeviceLine.reading : report.map { DeviceLine.all($0, besides: unit) } ?? []
        let removed = reading ? [] : report.map { DeviceLine.removed($0, besides: unit) } ?? []
        ListRow("This iPhone", meta: mine?.health.words ?? recorder.word, signal: mine.map(\.health.state.rowSignal) ?? recorder.kind,
                leading: .symbol(.phoneScreen), chevron: true, selected: sheet == .thisPhone, separator: !others.isEmpty,
                action: { sheet = .thisPhone })
            .accessibilityIdentifier("machinery.phone")
        VStack(spacing: 0) {
            ForEach(others) { device in
                ListRow(device.name, meta: device.line, signal: device.signal, leading: .symbol(device.icon), known: true,
                        separator: device.id != others.last?.id || !removed.isEmpty)
                    .accessibilityIdentifier("machinery.device.\(device.id)")
            }
        }
        .reading(reading)
        if !removed.isEmpty {
            ListRow("\(Words.count(removed.count)) removed", leading: .symbol(removedShown ? .expand : .forward),
                    separator: removedShown, action: { removedShown.toggle() })
                .accessibilityValue(removedShown ? "Open" : "Folded")
                .accessibilityIdentifier("machinery.removed")
            if removedShown {
                ForEach(removed) { device in
                    ListRow(device.name, meta: device.line, signal: device.signal, leading: .symbol(device.icon),
                            separator: device.id != removed.last?.id)
                        .accessibilityIdentifier("machinery.device.\(device.id)")
                }
            }
        }
    }


    private func leave(_ then: @escaping @MainActor () -> Void) {
        after = then
        sheet = nil
    }

}

enum StreamSheet: Hashable, Identifiable {
    case phone(PhoneSource)
    case home(String)
    case importKind(String)
    case yourHome
    case thisPhone
    case adding(String)
    case joined(String)

    var id: Self { self }

    static func of(_ id: String) -> StreamSheet {
        PhoneSource.of(id).map(StreamSheet.phone) ?? .home(id)
    }

    func draws(import kind: String, in report: HomeLink.StreamsReport) -> Bool {
        if case .importKind(let open) = self { return open == kind }
        guard let id = stream else { return false }
        return report.connectors.first(where: { $0.id == id })?.export?.import == kind
    }

    var stream: String? {
        switch self {
        case .phone(let source): source.stream.id
        case .home(let id): id
        case .importKind, .yourHome, .thisPhone, .adding, .joined: nil
        }
    }
}

struct StreamSheetStack: View {
    let sheet: StreamSheet
    let close: () -> Void
    let leave: (@escaping @MainActor () -> Void) -> Void
    @ObservedObject private var home = AppRuntime.shared.homeStreams
    @ObservedObject private var shipper = AppRuntime.shared.shipping.shipper
    @ObservedObject private var reach = AppRuntime.shared.reach

    var body: some View {
        SheetStack(rest: sheet.full ? .large : .hugs) {
            root
        } destination: { route in
            destination(route)
        }
    }

    private var readsHome: Bool { reach.snapshot.reach != .unpaired }

    @ViewBuilder private var root: some View {
        switch sheet {
        case .phone(let source):
            PhoneSourceSheet(source: source, leave: leave, home: home)
        case .home(let id):
            if readsHome, let report = home.read, let connector = report.connectors.first(where: { $0.id == id }) {
                HomeStreamSheet(connector: connector, report: report, unit: shipper.unit, home: home)
            } else if readsHome, home.reading {
                SheetFrame(StreamsWords.page) { EmptyView() }
                    .reading(true)
            } else if readsHome, home.read == nil, let failure = home.failure {
                SheetFrame(StreamsWords.page) {
                    ReadLack(failure, lacks: HomeConnectorsModel.lacks, words: HomeConnectorsModel.sentence(failure))
                }
            } else {
                Color.clear.onAppear(perform: close)
            }
        case .importKind(let kind):
            if readsHome, let report = home.read, let declared = report.imports.first(where: { $0.kind == kind }) {
                ImportSheet(kind: declared, report: report, unit: shipper.unit, home: home, leave: leave)
            } else if readsHome, home.reading {
                SheetFrame(StreamsWords.imports) { EmptyView() }
                    .reading(true)
            } else if readsHome, home.read == nil, let failure = home.failure {
                SheetFrame(StreamsWords.imports) {
                    ReadLack(failure, lacks: HomeConnectorsModel.lacks, words: HomeConnectorsModel.sentence(failure))
                }
            } else {
                Color.clear.onAppear(perform: close)
            }
        case .joined(let name):
            if let report = home.read, case let members = report.connectors.filter({ $0.joins?.name == name }), let joins = members.first?.joins {
                JoinedSheet(joins: joins, members: members)
            } else {
                Color.clear.onAppear(perform: close)
            }
        case .yourHome:
            YourHomeSheet()
        case .thisPhone:
            ThisPhoneSheet()
        case .adding(let query):
            if let adding = home.read?.adding {
                AddingSheet(line: AddingSheet.line(adding, query: query))
            } else {
                Color.clear.onAppear(perform: close)
            }
        }
    }

    @ViewBuilder private func destination(_ route: ConnectorsRoute) -> some View {
        switch route {
        case .checkIns: CheckInsPage(leave: leave)
        case .sources(let id): HomeSourcesPage(id: id, home: home)
        case .list(let id, let member): HomeListPage(id: id, member: member, home: home)
        case .zone(let id, let member): HomeZonePage(id: id, member: member, home: home)
        case .signIn(let id, let route): SignInPage(id: id, route: route, home: home)
        case .form(let id): HomeFormPage(id: id, home: home)
        case .importKind(let kind): ImportPage(kind: kind, unit: shipper.unit, home: home, leave: leave)
        case .connector(let id):
            if let report = home.read, let connector = report.connectors.first(where: { $0.id == id }) {
                ConnectorPage(connector: connector, report: report, unit: shipper.unit, home: home)
            }
        case .processing(let id, let member): StreamProcessingPage(id: id, member: member, home: home)
        case .model(let id, let member): StreamModelPage(id: id, member: member, home: home)
        case .status: StatusView()
        case .statusDetails: StatusDetails()
        #if !APP_STORE
        case .experiments: ExperimentsView()
        #endif
        case .agents, .connect, .agent, .access, .history, .read, .things, .disconnect: AgentsDestination(route: route)
        }
    }
}

struct AddingSheet: View {
    let line: String

    var body: some View {
        SheetFrame(StreamsWords.Entry.title, icon: .codingAgent) {
            VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                Text(StreamsWords.Entry.ask)
                    .cockpit(.body)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                CopyValue(line, shape: "", label: StreamsWords.Entry.copy, line: true) { Self.copy($0) }
                    .accessibilityIdentifier("adding.line")
            }
        }
    }

    static func line(_ adding: HomeLink.StreamsReport.Adding, query: String) -> String {
        let searched = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return searched.isEmpty ? adding.prompt : adding.prompt.replacingOccurrences(of: adding.blank, with: searched)
    }

    static func copy(_ line: String, to pasteboard: UIPasteboard = .general) {
        pasteboard.string = line
    }
}

extension View {
    func readsStreams(open: StreamSheet?) -> some View {
        modifier(StreamsReads(open: open))
    }
}

private struct StreamsReads: ViewModifier {
    let open: StreamSheet?
    @EnvironmentObject private var model: CaptureAppModel
    @ObservedObject private var checkIns = AppRuntime.shared.checkInModel
    @ObservedObject private var reach = AppRuntime.shared.reach
    @ObservedObject private var home = AppRuntime.shared.homeStreams
    @Environment(\.scenePhase) private var scenePhase
    @State private var onScreen = OnScreen()

    private var readsHome: Bool { reach.snapshot.reach != .unpaired }

    private var rereads: Bool {
        guard scenePhase == .active else { return false }
        if let failure = home.failure { return failure.since == nil }
        guard let open, let report = home.read else { return false }
        if report.imports.contains(where: { $0.underWay && open.draws(import: $0.kind, in: report) }) { return true }
        guard let id = open.stream, let stream = report.connectors.first(where: { $0.id == id }) else { return false }
        return stream.health.nextMs != nil
    }

    func body(content: Content) -> some View {
        content
            .tracked(onScreen)
            .task {
                await model.refresh()
                await checkIns.readStatus()
            }
            .task(id: readsHome) {
                if readsHome { await home.read() } else { home.forget() }
            }
            .readsAgain(failed: { home.failure }) { await home.read() }
            .task(id: rereads) {
                while rereads {
                    try? await Task.sleep(for: LifeReader.rereadEvery)
                    guard !Task.isCancelled else { return }
                    if onScreen.shown { await home.read() }
                }
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active, onScreen.shown else { return }
                Task {
                    await model.refresh()
                    if readsHome { await home.read() }
                }
            }
    }
}

enum ConnectorsRoute: Hashable {
    case checkIns
    case sources(String)
    case list(String, String)
    case zone(String, String)
    case signIn(String, String?)
    case form(String)
    case importKind(String)
    case connector(String)
    case processing(String, String)
    case model(String, String)
    case status
    case statusDetails
    #if !APP_STORE
    case experiments
    #endif
    case agents
    case connect
    case agent(String)
    case access(String, AccessRoute?)
    case history(String)
    case read(String, String)
    case things(String, String)
    case disconnect(String)
}

struct StreamRow: Identifiable {
    static func line(_ connector: HomeLink.Connector) -> String {
        [connector.lead, connector.line].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    let sheet: StreamSheet
    let name: String
    let icon: Cockpit.Icon
    let place: StreamsWords.Place?
    let kind: StreamsWords.Kind?
    let gives: String?
    let state: HomeLink.State
    let line: String
    let identifier: String
    var find: [String] = []
    var act: HomeLink.Pages.Act?
    var opensImport: String?
    var last: String?
    var starter = false
    var sample = false
    var members: [String] = []
    var standsInImport = false

    var connected: Bool { state != .setup }

    var meta: String {
        guard let place else { return line }
        return [line.hasSuffix(".") ? String(line.dropLast()) : line, place.word].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    func holds(_ stream: String) -> Bool { sheet.stream == stream || members.contains(stream) }

    var id: StreamSheet { sheet }

    var opens: StreamSheet {
        opensImport.map(StreamSheet.importKind) ?? sheet
    }

    var end: RowEnd.Face? {
        if state == .setup { return nil }
        return state.rowMark ?? last.map(RowEnd.Face.time)
    }

    func matches(_ query: String) -> Bool {
        PageFilter.shows(find, typed: query)
    }

    static func declared(_ source: PhoneSource) -> StreamRow {
        StreamRow(sheet: .phone(source), name: source.name, icon: source.icon, place: .phone, kind: nil, gives: source.gives,
                  state: .setup, line: source.gives, identifier: source.identifier, find: [source.name, source.gives])
    }

    static func served(_ row: HomeLink.Pages.StreamRow, in answer: StreamsAnswer) -> StreamRow {
        let lead = answer.lead(of: row)
        let members = row.ids.compactMap { id in answer.report.connectors.first { $0.id == id } }
        let alone = row.joined ? nil : row.ids.first
        let source = alone.flatMap(PhoneSource.of)
        return StreamRow(sheet: row.joined ? .joined(row.name) : alone.map(StreamSheet.of) ?? .joined(row.name), name: row.name,
                         icon: Cockpit.Icon(rawValue: row.icon) ?? .recording, place: lead.flatMap(StreamsWords.place),
                         kind: lead.flatMap(StreamsWords.kind), gives: lead?.gives, state: HomeLink.State(rawValue: row.health.state.rawValue) ?? .quiet,
                         line: StreamsLine.words(row),
                         identifier: row.joined ? "home-connector.joined.\(row.name)" : source?.identifier ?? "home-connector.\(alone ?? row.name)",
                         find: row.find, act: row.act,
                         opensImport: row.joined ? nil : lead?.export.flatMap { $0.opens ? $0.import : nil },
                         last: StreamsLine.last(row), starter: members.contains(where: \.starter), members: row.ids,
                         standsInImport: !members.isEmpty && members.allSatisfy { member in
                             !member.setUp && member.roads.allSatisfy { $0 == .upload }
                                 && answer.report.imports.contains { $0.products.isEmpty && $0.kind == member.export?.import }
                         })
    }

    static var reading: [StreamRow] {
        let names = ["iMessage", "WhatsApp", "Mail", "Calls", "Contacts", "Location", "Health", "Motion", "Sleep"]
        let lines = ["29 messages today", "Last yesterday", "140 messages today", "3 calls today", "Last Thu",
                     "212 places today", "8,412 steps today", "Last yesterday", "7h 12m today"]
        return names.indices.map { index in
            let kind = index < 5 ? StreamsWords.Kind(key: "messages", name: "Messages", icon: .message)
                : StreamsWords.Kind(key: "health", name: "Health", icon: .health)
            return StreamRow(sheet: .home("reading.\(index)"), name: names[index], icon: kind.icon ?? .recording, place: nil, kind: kind,
                             gives: nil, state: .ok, line: lines[index], identifier: "connectors.reading.\(index)", last: "09:41",
                             sample: true)
        }
    }

    static func sections(_ rows: [StreamRow], imports: [HomeLink.Import] = [], fresh: Bool) -> [StreamSection] {
        var rest = rows
        var sections: [StreamSection] = []
        if fresh {
            let start = rest.filter(\.starter)
            rest.removeAll(where: \.starter)
            if !start.isEmpty { sections.append(StreamSection(label: StreamsWords.start, rows: start)) }
        }
        var kinds: [StreamSection] = []
        for row in rest {
            if let at = kinds.firstIndex(where: { $0.key == row.kind?.key }) {
                kinds[at].rows.append(row)
            } else {
                kinds.append(StreamSection(label: row.kind?.name ?? StreamsWords.more, key: row.kind?.key, rows: [row]))
            }
        }
        sections += kinds.map { kind in
            var kind = kind
            kind.rows = kind.rows.filter { $0.state != .setup } + kind.rows.filter { $0.state == .setup }
            return kind
        }
        if !imports.isEmpty {
            sections.append(StreamSection(label: StreamsWords.imports, key: StreamsWords.importsKey, rows: [], imports: imports))
        }
        return sections
    }
}

enum ConnectorsShown: Hashable {
    case connected, not

    static func of(_ chosen: ConnectorsShown?, rows: [StreamRow], imports: [HomeLink.Import]) -> ConnectorsShown {
        chosen ?? (rows.contains(where: \.connected) || imports.contains(where: \.connected) ? .connected : .not)
    }
}

extension HomeLink.Import {
    var connected: Bool { !held.isEmpty || !coming.isEmpty }
}

struct StreamSection: Identifiable {
    let label: String?
    var key: String?
    var rows: [StreamRow]
    var imports: [HomeLink.Import] = []

    var id: String { (label ?? "") + "/" + (key ?? "") }
}

private struct Pushed: Hashable {
    let route: ConnectorsRoute
    let depth: Int
}

private struct SheetStack<Root: View, Destination: View>: View {
    let root: Root
    let destination: (ConnectorsRoute) -> Destination
    let rest: DrawerFit
    @State private var path: [Pushed] = AppNavigation.designPush.filter { !$0.agents }.enumerated().map { Pushed(route: $1, depth: $0 + 1) }
    @State private var titles: [Int: String] = [:]
    @Environment(\.dismiss) private var dismiss

    init(rest: DrawerFit, @ViewBuilder root: () -> Root, @ViewBuilder destination: @escaping (ConnectorsRoute) -> Destination) {
        self.rest = rest
        self.root = root()
        self.destination = destination
    }

    var body: some View {
        NavigationStack(path: $path) {
            root
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("connector.detail")
                .toolbar(.hidden, for: .navigationBar)
                .onPreferenceChange(DrawerTitle.self) { title in Task { @MainActor in titles[0] = title } }
                .navigationDestination(for: Pushed.self) { pushed in
                    let close = dismiss
                    destination(pushed.route)
                        .navigationBarTitleDisplayMode(.inline)
                        .environment(\.drawerPush, DrawerPush(back: titles[pushed.depth - 1] ?? "") { close() })
                        .onPreferenceChange(DrawerTitle.self) { title in Task { @MainActor in titles[pushed.depth] = title } }
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("connector.detail")
                }
        }
        .environment(\.openConnectors, OpenConnectorsAction { path.append(Pushed(route: $0, depth: path.count + 1)) })
        .feedbackHost()
        .allowingSources()
        .tint(Cockpit.Color.text)
        .drawerRest(rest)
    }
}

extension StreamSheet {
    var full: Bool {
        switch self {
        case .phone, .home, .importKind, .joined: true
        case .yourHome, .thisPhone, .adding: false
        }
    }
}

struct JoinedSheet: View {
    let joins: HomeLink.Connector.Joins
    let members: [HomeLink.Connector]
    @Environment(\.openConnectors) private var open

    var body: some View {
        PageDrawer(joins.name, icon: Cockpit.Icon(rawValue: joins.icon) ?? .recording,
                   line: joins.apps.isEmpty ? joins.gives : joins.apps.joined(separator: Words.dot)) {
            SheetPart(nil) {
                ForEach(members) { member in
                    let setUp = member.health.state != .setup && member.health.state != .off
                    let last = member.figure?.last
                    let end: RowEnd.Face? = member.health.state.rowMark ?? (setUp ? last.map(RowEnd.Face.time) : nil)
                    ListRow(member.name, meta: setUp ? StreamRow.line(member) : member.gives, leading: .symbol(StreamsWords.icon(member)),
                            chevron: true, separator: member.id != members.last?.id, action: { open(.connector(member.id)) }) {
                        end.map(RowEnd.init)
                    }
                    .environment(\.cockpitRowQuiet, !setUp)
                    .accessibilityIdentifier("connector.joined.\(member.id)")
                }
            }
            StreamReads(gives: joins.gives)
        }
    }
}
