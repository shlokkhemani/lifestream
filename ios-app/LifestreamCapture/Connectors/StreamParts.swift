import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

extension StreamsWords {
    static func roadIcon(_ road: HomeLink.Road?) -> Cockpit.Icon {
        switch road ?? .poll {
        case .mac: .workMac
        case .phone: .phoneScreen
        case .chrome: .web
        case .upload: .file
        case .owner, .label: .home
        case .poll: .online
        }
    }
}

extension HomeLink.Connector {
    func members(on panel: Panel) -> [Member] { members.filter { $0.panel == panel } }
}

extension HomeLink.Connector.Member {
    var waitingLine: String? {
        let lines = (waiting ?? []).map(\.line)
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }
}

extension HomeLink.JSON {
    var key: String {
        switch self {
        case .string(let text): text
        case .number(let number): number == number.rounded() ? String(Int(number)) : String(number)
        case .bool(let on): on ? "true" : "false"
        default: ""
        }
    }
}


struct StreamComesFrom: View {
    let connector: HomeLink.Connector
    @Environment(\.openConnectors) private var open

    static var page: Int { 5 }

    static func rows(_ connector: HomeLink.Connector) -> Int {
        let copies = connector.copies
        let alone = alone(connector)
        return (connector.account == nil || alone ? 0 : 1) + (copies.count > page ? 1 : copies.count)
            + connector.members(on: .comesFrom).count + (connector.export == nil ? 0 : 1)
    }

    static func alone(_ connector: HomeLink.Connector) -> Bool {
        guard let copy = connector.account?.copy else { return false }
        return connector.copies.count == 1 && connector.copies[0].id == copy
    }

    var body: some View {
        let copies = connector.copies
        let paged = copies.count > Self.page
        let unchosen = connector.members(on: .comesFrom)
        let export = connector.export
        let elsewhere: String? = !unchosen.isEmpty ? "Choose it from Lifestream on your Mac."
            : copies.count > 1 ? "Turn each \(copies.allSatisfy { $0.unit != nil } ? "device" : "source") on or off from Lifestream on your Mac." : nil
        let alone = Self.alone(connector)
        let rows = Self.rows(connector)
        let after = !unchosen.isEmpty || export != nil
        if rows > 0 {
            SheetPart("Comes from", note: elsewhere) {
                if let account = connector.account, !alone {
                    ListRow(account.name, meta: account.line.isEmpty ? nil : account.line, leading: .symbol(.online),
                            separator: rows > 1) {
                        StreamAccountChange(connector: connector)
                    }
                }
                if paged {
                    ListRow("Show all", leading: .symbol(StreamsWords.roadIcon(copies.first?.road)),
                            chevron: true, separator: after, action: { open(.sources(connector.id)) }) { EmptyView() }
                        .accessibilityIdentifier("connector.detail.sources")
                } else {
                    StreamCopies(copies: copies, named: alone ? connector.account?.name : nil, said: connector.health, after: after,
                                 change: alone ? connector : nil)
                }
                ForEach(unchosen) { member in
                    ListRow(member.label, meta: member.words, leading: .symbol(.workMac),
                            separator: member.key != unchosen.last?.key || export != nil) { EmptyView() }
                }
                if let export {
                    ListRow(export.name, meta: export.line, leading: .symbol(Cockpit.Icon(rawValue: export.icon) ?? .file), separator: false) {
                        Button("Show") { open(.importKind(export.import)) }
                            .buttonStyle(.cockpit(.plain, size: .small))
                            .accessibilityIdentifier("connector.detail.import")
                    }
                }
            }
        }
    }
}

struct StreamCopies: View {
    let copies: [HomeLink.Connector.Copy]
    var named: String?
    var said: HomeLink.Health?
    let after: Bool
    var change: HomeLink.Connector?

    var body: some View {
        ForEach(copies) { copy in
            ListRow(named ?? copy.name, meta: copy.line, signal: copy.health.words == said?.words ? nil : copy.health.state.rowSignal, lines: 2, leading: .symbol(StreamsWords.roadIcon(copy.road)),
                    separator: copy.id != copies.last?.id || after) {
                if let change { StreamAccountChange(connector: change) }
            }
            .accessibilityIdentifier("connector.detail.source.\(copy.name)")
        }
    }
}

struct StreamAccountChange: View {
    let connector: HomeLink.Connector
    @Environment(\.openConnectors) private var open

    var body: some View {
        if let signIn = connector.signIn {
            Button(connector.account != nil ? "Change" : "Connect") { open(signIn) }
                .buttonStyle(.cockpit(.secondary, size: .small))
                .accessibilityIdentifier("connector.detail.account.change")
        }
    }
}

struct MemberChanges: Equatable {
    struct Unlanded: Equatable {
        let said: HomeLink.ActSaid
        let value: HomeLink.JSON
        let was: HomeLink.JSON?
    }

    struct Landed: Equatable {
        let connector: String
        let member: String
        let value: HomeLink.JSON
    }

    var busy: Set<String> = []
    var landed: [String: Landed] = [:]
    var unlanded: [String: Unlanded] = [:]

    static func key(_ connector: String, _ member: String) -> String { "\(connector).\(member)" }

    static func landed(_ outcome: SettingOutcome, sent: HomeLink.JSON) -> HomeLink.JSON? {
        switch outcome {
        case .taken(let landed): landed ?? sent
        case .changed(let home): home
        case .refused, .saving, .unknown, .unreachable: nil
        }
    }

    mutating func settle(holding value: (_ connector: String, _ member: String) -> HomeLink.JSON?) {
        for (key, landing) in landed where (value(landing.connector, landing.member) ?? .null) == landing.value {
            landed[key] = nil
            busy.remove(key)
        }
    }

    mutating func settle(_ report: HomeLink.StreamsReport) {
        settle { connector, member in
            report.connectors.first { $0.id == connector }?.members.first { $0.key == member }?.value
        }
    }

    func problem(_ key: String, read failure: LifeReader.Failure?) -> String? {
        guard landed[key] != nil, let failure else { return nil }
        switch failure {
        case .reach: return nil
        case .busy(let words, _, _, _), .refused(let words), .failed(let words), .unknown(let words): return words
        case .missing, .unpaired: return "Lifestream's connectors could not be read."
        }
    }
}

struct MemberFailure: View {
    let connector: HomeLink.Connector
    let member: String
    @ObservedObject var home: HomeConnectorsModel

    var body: some View {
        if let unlanded = home.changes.unlanded[MemberChanges.key(connector.id, member)] {
            InPlaceLine(InPlaceLine.Said(unlanded.said), retry: retry(unlanded))
                .accessibilityIdentifier("connector.setting.\(member).failure")
        }
    }

    private func retry(_ unlanded: MemberChanges.Unlanded) -> (() -> Void)? {
        guard unlanded.said.sendsAgain else { return nil }
        return { Task { await home.set(connector, member, unlanded.value, was: unlanded.was) } }
    }
}

struct StreamHistoryRow: View {
    let connector: HomeLink.Connector
    var separator = false

    var body: some View {
        let words = Self.words(connector)
        ListRow(words.label, meta: words.meta, leading: .symbol(.time), separator: separator)
            .accessibilityIdentifier("connector.detail.backfill")
    }

    static func words(_ connector: HomeLink.Connector) -> (label: String, meta: String?) {
        guard let said = connector.history?.words, !said.isEmpty else { return (ConnectorWords.history, nil) }
        let parts = said.components(separatedBy: Words.dot)
        let rest = parts.dropFirst().joined(separator: Words.dot)
        return (parts[0], rest.isEmpty ? nil : rest)
    }
}

struct StreamSettings: View {
    let connector: HomeLink.Connector
    @ObservedObject var home: HomeConnectorsModel

    nonisolated static let rate = "refresh"

    enum Item: Identifiable {
        case member(HomeLink.Connector.Member)
        case refresh(HomeLink.Connector.RefreshNow)
        case quiet(Int)

        var id: String {
            switch self {
            case .member(let member): "member.\(member.key)"
            case .refresh: "refresh"
            case .quiet: "quiet"
            }
        }
    }

    nonisolated static func stands(_ connector: HomeLink.Connector) -> Bool { !items(connector).isEmpty }

    nonisolated static func items(_ connector: HomeLink.Connector) -> [Item] {
        let settings = StreamRows.settings.members(connector)
        let groups = StreamRows.groups.members(connector)
        let under = settings.contains { $0.key == rate } ? rate : settings.last?.key
        var items: [Item] = []
        for member in settings {
            items.append(.member(member))
            if member.key == under, let refresh = connector.refreshNow { items.append(.refresh(refresh)) }
        }
        if settings.isEmpty, let refresh = connector.refreshNow { items.append(.refresh(refresh)) }
        items += groups.map(Item.member)
        if !groups.isEmpty, let quiet = connector.quiet { items.append(.quiet(quiet)) }
        return items
    }

    var body: some View {
        let items = Self.items(connector)
        if !items.isEmpty {
            SheetPart(ConnectorWords.settings) {
                ForEach(items) { item in
                    let separator = item.id != items.last?.id
                    switch item {
                    case .member(let member): StreamMemberRow(connector: connector, member: member, separator: separator, home: home)
                    case .refresh(let refresh): StreamRefreshRow(connector: connector, refresh: refresh, separator: separator, home: home)
                    case .quiet(let count): StreamQuietGroups(count: count, separator: separator)
                    }
                }
            }
        }
    }

    static func zones(_ at: String) -> [String] {
        let known = TimeZone.knownTimeZoneIdentifiers
        return known.contains(at) || at.isEmpty ? known : known + [at]
    }

    static func zoneWords(_ zone: String) -> String {
        let city = zone.split(separator: "/").last.map { $0.replacingOccurrences(of: "_", with: " ") } ?? zone
        guard let time = TimeZone(identifier: zone) else { return city }
        let offset = time.secondsFromGMT() / 60
        let said = offset == 0 ? "GMT" : String(format: "GMT%@%d", offset < 0 ? "-" : "+", abs(offset) / 60) + (offset % 60 == 0 ? "" : String(format: ":%02d", abs(offset) % 60))
        return said == city ? city : "\(city) · \(said)"
    }
}

struct StreamMenu: View {
    let connector: HomeLink.Connector
    let member: HomeLink.Connector.Member
    var line: String?
    var signal: Cockpit.SignalKind?
    let separator: Bool
    @ObservedObject var home: HomeConnectorsModel
    @Environment(\.openConnectors) private var open

    var body: some View {
        let key = MemberChanges.key(connector.id, member.key)
        let at = member.value?.key ?? ""
        let options = member.menu.map(ModelFind.options) ?? (member.steps ?? []).map { MenuRow.Option($0.value, $0.words, note: $0.note) }
        SettingRow(member.label, about: line == nil ? nil : member.about, waiting: member.waitingLine, only: member.only,
                   problem: home.changes.problem(key, read: home.failure), line: line ?? member.about, signal: signal, separator: separator) {
            MenuRow(member.label, selection: Binding(get: { at }, set: { next in
                guard next != at else { return }
                if next == ModelFind.opens { return open(.model(connector.id, member.key)) }
                Task { await home.set(connector, member.key, .string(next), was: member.value) }
            }), options: options,
                    default: member.default.map(\.key), busy: home.changes.busy.contains(key), words: member.words, flush: .trailing)
                .accessibilityIdentifier("connector.setting.\(member.key)")
        } held: {
            MemberFailure(connector: connector, member: member.key, home: home)
        }
    }
}

struct StreamProcessing: View {
    let connector: HomeLink.Connector
    @ObservedObject var home: HomeConnectorsModel
    @Environment(\.openConnectors) private var open

    static let elsewhere = "Change hiding in Settings › Privacy on your Mac."

    struct Drawn: Identifiable {
        let row: HomeLink.Connector.Processing.Row
        let member: HomeLink.Connector.Member
        let sent: Sent?
        var id: String { member.key }
    }

    struct Sent {
        let privacy: HomeLink.Connector.Processing.Privacy
        let member: HomeLink.Connector.Member
    }

    static func drawn(_ connector: HomeLink.Connector) -> [Drawn] {
        (connector.processing?.rows ?? []).compactMap { row in
            connector.members.first { $0.key == row.member }.map { member in
                let sent = row.privacy.flatMap { privacy in connector.members.first { $0.key == privacy.member }.map { Sent(privacy: privacy, member: $0) } }
                return Drawn(row: row, member: member, sent: sent)
            }
        }
    }

    static func stands(_ connector: HomeLink.Connector) -> Bool { !drawn(connector).isEmpty }

    static func needs(_ connector: HomeLink.Connector) -> Bool { drawn(connector).contains { $0.row.shape == .needs } }

    var body: some View {
        let drawn = Self.drawn(connector)
        if !drawn.isEmpty {
            SheetPart(ConnectorWords.ai) {
                ForEach(drawn) { each in
                    ListRow(each.member.label, meta: each.row.line, signal: each.row.shape?.signal == .warning ? .warning : nil,
                            leading: .symbol(.ai), chevron: true, separator: each.id != drawn.last?.id,
                            action: { open(.processing(connector.id, each.member.key)) })
                        .accessibilityIdentifier("connector.ai.\(each.member.key)")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("connector.detail.processing")
        }
    }
}

struct StreamProcessingPage: View {
    let id: String
    let member: String
    @ObservedObject var home: HomeConnectorsModel

    var body: some View {
        if let connector = home.read?.connectors.first(where: { $0.id == id }),
           let each = StreamProcessing.drawn(connector).first(where: { $0.member.key == member }) {
            PageDrawer(each.member.label) {
                SheetPart(ConnectorWords.model) {
                    StreamMenu(connector: connector, member: each.member, line: each.row.line, signal: each.row.shape?.signal,
                               separator: false, home: home)
                }
                if let sent = each.sent {
                    SheetPart(ConnectorWords.privacy, note: StreamProcessing.elsewhere) {
                        StreamMenu(connector: connector, member: sent.member, line: sent.privacy.note, separator: false, home: home)
                    }
                }
            }
        }
    }
}

struct StreamHistory: View {
    let connector: HomeLink.Connector
    @ObservedObject var home: HomeConnectorsModel

    static func stands(_ connector: HomeLink.Connector) -> Bool {
        connector.history != nil || connector.paused(.history) != nil || !StreamRows.backfill.members(connector).isEmpty
    }

    var body: some View {
        if Self.stands(connector) {
            SheetPart(ConnectorWords.history, note: connector.backfillAbout) { rows }
        }
    }

    @ViewBuilder private var rows: some View {
        let members = StreamRows.backfill.members(connector)
        let change = StreamFoot.historyChange(connector)
        if connector.history != nil || connector.paused(.history) != nil {
            StreamHistoryRow(connector: connector, separator: !members.isEmpty || change != nil)
        }
        ForEach(members) { member in
            StreamMenu(connector: connector, member: member, separator: member.key != members.last?.key || change != nil, home: home)
        }
        if let change {
            let busy = home.changing.contains(HomeConnectorsModel.changeKey(connector.id, change))
            ListRow(change == .resumeHistory ? ConnectorWords.resumeCatchingUp : ConnectorWords.pauseCatchingUp, separator: false,
                    action: busy ? nil : { Task { await home.change(connector.id, change) } }) {
                if busy { Spinner() }
            }
            .environment(\.cockpitRowActs, true)
            .accessibilityIdentifier("connector.detail.history")
        }
    }
}

enum StreamRows: CaseIterable {
    case form, settings, groups, backfill

    func members(_ connector: HomeLink.Connector) -> [HomeLink.Connector.Member] {
        switch self {
        case .form: connector.form
        case .settings: connector.members(on: .settings)
        case .groups: connector.members(on: .groups)
        case .backfill: connector.members(on: .backfill)
        }
    }
}

extension Text {
    @MainActor func settingValue() -> some View {
        cockpit(.body).foregroundStyle(Cockpit.Color.textSecondary).lineLimit(1)
    }
}


enum StreamFoot {
    static func running(_ connector: HomeLink.Connector) -> Bool { connector.setUp && !connector.copies.isEmpty }

    static func shown(_ connector: HomeLink.Connector) -> Bool { running(connector) || connector.paused(.all) != nil }

    static func offable(_ connector: HomeLink.Connector) -> Bool {
        running(connector) && connector.shown != .home && connector.copies.contains { $0.on }
    }

    struct Buttons: View {
        let connector: HomeLink.Connector?
        @ObservedObject var home: HomeConnectorsModel
        let offable: Bool
        let disconnect: () -> Void

        var body: some View {
            if offable {
                Button(ConnectorWords.disconnect, action: disconnect)
                    .buttonStyle(.cockpit(.secondary, tone: .warning, size: .large, fullWidth: true))
                    .disabled(connector.map { home.changing.contains($0.id) } ?? false)
                    .accessibilityIdentifier("connector.detail.turnOff")
            }
            if let connector, StreamFoot.shown(connector) {
                let change = StreamFoot.change(connector)
                let busy = home.changing.contains(HomeConnectorsModel.changeKey(connector.id, change))
                Button(change == .resume ? ConnectorWords.resume : ConnectorWords.pause) {
                    Task { await home.change(connector.id, change) }
                }
                .buttonStyle(.cockpit(.secondary, size: .large, busy: busy, fullWidth: true))
                .disabled(busy)
                .accessibilityIdentifier("connector.detail.pause")
            }
        }

        static func stands(_ connector: HomeLink.Connector?, offable: Bool) -> Bool {
            offable || connector.map(StreamFoot.shown) == true
        }
    }

    static func change(_ connector: HomeLink.Connector) -> HomeLink.StreamChange {
        connector.paused(.all) != nil ? .resume : .pause
    }

    static func historyChange(_ connector: HomeLink.Connector) -> HomeLink.StreamChange? {
        if connector.paused(.history) != nil { return .resumeHistory }
        if connector.history != nil, running(connector), connector.paused(.all) == nil { return .pauseHistory }
        return nil
    }

    struct Unchanged: View {
        let connector: HomeLink.Connector
        @ObservedObject var home: HomeConnectorsModel

        var body: some View {
            if let unchanged = home.unchanged[connector.id] {
                InPlaceLine(InPlaceLine.Said(unchanged.said), retry: unchanged.said.sendsAgain ? {
                    Task { await home.change(connector.id, unchanged.change) }
                } : nil)
                .accessibilityIdentifier("connector.detail.unchanged")
            }
        }
    }
}

enum ConnectorWords {
    static let comesFrom = "Comes from"
    static let settings = "Settings"
    static let ai = "AI"
    static let model = "Model"
    static let privacy = "Privacy"
    static let history = "History"
    static let reads = "What it reads"
    static let whereReads = "Where it reads"
    static let pause = "Pause"
    static let resume = "Resume"
    static let pauseCatchingUp = "Pause catching up"
    static let resumeCatchingUp = "Resume catching up"
    static let disconnect = "Disconnect"
    static let cancel = "Cancel"
    static let openSettings = "Open Settings"
    static let reading = "Reading your history"
    static let paused = "Paused."
    static let closeable = "Newest first: today is in already. You can close this."

    static func disconnectTitle(_ name: String) -> String { "Disconnect \(name)?" }

    static func disconnectBody(_ connector: HomeLink.Connector?) -> String {
        let nouns = connector.flatMap(StreamsWords.noun)?.1 ?? "items"
        return "Lifestream will stop getting new \(nouns). \(nouns.prefix(1).uppercased() + nouns.dropFirst()) already in Lifestream won’t be deleted."
    }

    static func managedByIOS(_ name: String) -> String { "\(name) access is managed in iOS Settings." }

    static func left(_ history: HomeLink.Connector.History, now: Int64) -> String? {
        guard let eta = history.etaMs, eta > now else { return nil }
        let minutes = Int((Double(eta - now) / 60_000).rounded(.up))
        if minutes < 60 { return "About \(minutes) minute\(minutes == 1 ? "" : "s") left." }
        let hours = Int((Double(minutes) / 60).rounded())
        return "About \(hours) hour\(hours == 1 ? "" : "s") left."
    }
}

struct StreamProgress: View {
    let connector: HomeLink.Connector
    let now: Int64

    static func stands(_ connector: HomeLink.Connector) -> Bool { connector.history?.state == .syncing }

    var body: some View {
        if let history = connector.history, history.state == .syncing {
            VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
                if let progress = history.progress, let done = history.done, let total = history.total, total > 0 {
                    Meter(ConnectorWords.reading, value: progress, share: Double(done) / Double(total), progress: true)
                } else {
                    head(Self.left(history))
                }
                Text([ConnectorWords.left(history, now: now), ConnectorWords.closeable].compactMap { $0 }.joined(separator: " "))
                    .cockpit(.subhead)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("connector.detail.progress")
        }
    }

    private static func left(_ history: HomeLink.Connector.History) -> String? {
        let noun = history.unit.flatMap { $0.count == 2 ? $0 : nil }
        return history.left.map { count in "\(Words.count(count)) \(noun.map { count == 1 ? $0[0] : $0[1] } ?? "") left".replacingOccurrences(of: "  ", with: " ") }
    }

    private func head(_ left: String?) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s3) {
                Text(ConnectorWords.reading).cockpit(.rowTitle).foregroundStyle(Cockpit.Color.text).fixedSize()
                Spacer(minLength: 0)
                if let left { Text(left).cockpit(.subhead).monospacedDigit().foregroundStyle(Cockpit.Color.textSecondary).fixedSize() }
            }
            VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
                Text(ConnectorWords.reading).cockpit(.rowTitle).foregroundStyle(Cockpit.Color.text)
                if let left { Text(left).cockpit(.subhead).monospacedDigit().foregroundStyle(Cockpit.Color.textSecondary) }
            }
        }
    }
}

struct StreamReads: View {
    let gives: String
    var reads: String? = nil
    var labelled = false

    var body: some View {
        if labelled {
            VStack(alignment: .leading, spacing: Cockpit.Space.s4) {
                part(ConnectorWords.reads, gives, identifier: "connector.detail.reads")
                if let reads { part(ConnectorWords.whereReads, reads, identifier: "connector.detail.where") }
            }
        } else if !gives.isEmpty {
            Text(gives)
                .cockpit(.subhead)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, Cockpit.Space.s4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("connector.detail.reads")
        }
    }

    @ViewBuilder private func part(_ title: String, _ words: String, identifier: String) -> some View {
        if !words.isEmpty {
            VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
                Text(title).cockpit(.subhead).foregroundStyle(Cockpit.Color.textSecondary)
                Text(words)
                    .cockpit(.body)
                    .foregroundStyle(Cockpit.Color.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(identifier)
        }
    }
}

extension EnvironmentValues {
    @Entry var actsFollow = false
}
