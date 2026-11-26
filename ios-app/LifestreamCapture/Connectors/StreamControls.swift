import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI
import UIKit

extension HomeLink.Connector {
    var routed: Set<String> { Set(routes.flatMap(\.sets)) }

    var form: [Member] { members(on: .account).filter { !routed.contains($0.key) } }

    var signIn: ConnectorsRoute? {
        if routes.count > 1 { return .signIn(id, nil) }
        if let route = routes.first { return .signIn(id, route.id) }
        return form.isEmpty ? nil : .form(id)
    }
}

struct StreamMemberRow: View {
    let connector: HomeLink.Connector
    let member: HomeLink.Connector.Member
    let separator: Bool
    @ObservedObject var home: HomeConnectorsModel
    @Environment(\.openConnectors) private var open

    var body: some View {
        let key = MemberChanges.key(connector.id, member.key)
        let problem = home.changes.problem(key, read: home.failure)
        let busy = home.changes.busy.contains(key)
        switch Self.drawn(member) {
        case .menu:
            StreamMenu(connector: connector, member: member, separator: separator, home: home)
        case .toggle:
            SettingRow(member.label, waiting: member.waitingLine, only: member.only, problem: problem, line: member.about, separator: separator) {
                Toggle(member.label, isOn: Binding(get: { member.value?.bool == true },
                                                   set: { on in Task { await home.set(connector, member.key, .bool(on), was: member.value) } }))
                    .labelsHidden()
                    .toggleStyle(.cockpit)
                    .disabled(busy)
                    .accessibilityIdentifier("connector.setting.\(member.key)")
            } held: {
                MemberFailure(connector: connector, member: member.key, home: home)
            }
        case .stepper:
            let at = Int(member.value?.number ?? 0)
            SettingRow(member.label, waiting: member.waitingLine, only: member.only, problem: problem, line: member.about, separator: separator) {
                ValueStepper(member.label, value: Binding(get: { at }, set: { next in
                    Task { await home.set(connector, member.key, .number(Double(next)), was: member.value) }
                }), steps: Self.numbers(Int(member.min ?? 0), Int(member.max ?? 0), at)) { Words.count($0) }
                    .disabled(busy)
                    .accessibilityIdentifier("connector.setting.\(member.key)")
            } held: {
                MemberFailure(connector: connector, member: member.key, home: home)
            }
        case .list:
            pageRow(problem: problem, to: .list(connector.id, member.key))
        case .zone:
            pageRow(problem: problem, to: .zone(connector.id, member.key))
        case .typed:
            StreamTypedRow(connector: connector, member: member, separator: separator, home: home)
        case .date:
            StreamDateRow(connector: connector, member: member, separator: separator, home: home)
        case .secret:
            StreamSecretRow(connector: connector, member: member, separator: separator, home: home)
        case .said(let note):
            SettingRow(member.label, waiting: member.waitingLine, only: member.only, line: member.about, note: note, separator: separator) {
                SettingValue(member.words)
            }
            .accessibilityIdentifier("connector.setting.\(member.key)")
        }
    }

    enum Drawn: Equatable {
        case menu, toggle, stepper, list, zone, typed, date, secret
        case said(note: String?)
    }

    static func drawn(_ member: HomeLink.Connector.Member) -> Drawn {
        switch member.control {
        case .menu where member.steps != nil || member.menu != nil: .menu
        case .toggle: .toggle
        case .stepper where member.min != nil && member.max != nil: .stepper
        case .list: .list
        case .zone: .zone
        case .text, .email: .typed
        case .date: .date
        case .secret: .secret
        case .path, .menu, .stepper, nil: .said(note: member.where.map { "Choose it on \($0.name)." })
        }
    }

    private func pageRow(problem: String?, to route: ConnectorsRoute) -> some View {
        SettingRow(member.label, waiting: member.waitingLine, only: member.only, problem: problem, line: member.about,
                   separator: separator, opens: { open(route) }) {
            SettingValue(member.words)
        } held: {
            MemberFailure(connector: connector, member: member.key, home: home)
        }
        .accessibilityValue(member.words)
        .accessibilityIdentifier("connector.setting.\(member.key)")
    }

    static func numbers(_ low: Int, _ high: Int, _ at: Int) -> [Int] {
        let stride = Swift.max(1, (high - low) / 100)
        var steps = Array(Swift.stride(from: low, through: high, by: stride))
        if !steps.contains(at) { steps.append(at); steps.sort() }
        return steps
    }
}

struct StreamTypedRow: View {
    let connector: HomeLink.Connector
    let member: HomeLink.Connector.Member
    let separator: Bool
    @ObservedObject var home: HomeConnectorsModel
    @State private var typed: String?
    @FocusState private var focused: Bool

    var body: some View {
        let key = MemberChanges.key(connector.id, member.key)
        let email = member.control == .email
        SettingRow(member.label, waiting: member.waitingLine, only: member.only,
                   problem: home.changes.problem(key, read: home.failure), line: member.about, separator: separator, fieldEnd: true) {
            Field(member.label, text: Binding(get: { typed ?? held }, set: { typed = $0 }),
                  placeholder: member.value == nil ? member.words : "", focus: $focused, spaces: !email)
                .keyboardType(email ? .emailAddress : .default)
                .textContentType(email ? .emailAddress : nil)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .onSubmit(send)
                .disabled(home.changes.busy.contains(key))
                .accessibilityIdentifier("connector.setting.\(member.key)")
        } held: {
            MemberFailure(connector: connector, member: member.key, home: home)
        }
        .onChange(of: focused) { _, now in if !now { send() } }
    }

    private var held: String { member.value?.string ?? "" }

    private func send() {
        let value = (typed ?? held).trimmingCharacters(in: .whitespacesAndNewlines)
        typed = nil
        guard !value.isEmpty, value != held else { return }
        Task { await home.set(connector, member.key, .string(value), was: member.value) }
    }
}

struct StreamDateRow: View {
    let connector: HomeLink.Connector
    let member: HomeLink.Connector.Member
    let separator: Bool
    @ObservedObject var home: HomeConnectorsModel
    @State private var open = false
    @State private var chosen: DateRow.Day?

    var body: some View {
        let key = MemberChanges.key(connector.id, member.key)
        let held = member.value?.string.flatMap(Self.day)
        DateRow(member.label, day: Binding(get: { chosen ?? held }, set: choose), empty: "Choose a day",
                open: $open, clear: nil, yearAlways: true, separator: separator,
                said: DateRow.Said(waiting: member.waitingLine, only: member.only, problem: home.changes.problem(key, read: home.failure),
                                   line: held == nil ? member.words : member.about),
                held: AnyView(MemberFailure(connector: connector, member: member.key, home: home)))
            .disabled(home.changes.busy.contains(key))
            .accessibilityIdentifier("connector.setting.\(member.key)")
    }

    private func choose(_ day: DateRow.Day?) {
        guard let value = Self.value(day, held: member.value?.string) else { return }
        chosen = day
        Task {
            await home.set(connector, member.key, .string(value), was: member.value)
            chosen = nil
        }
    }

    static func value(_ day: DateRow.Day?, held: String?) -> String? {
        guard let day, let year = day.year else { return nil }
        let value = String(format: "%04d-%02d-%02d", year, day.month, day.day)
        return value == held ? nil : value
    }

    static func day(_ text: String) -> DateRow.Day? {
        let parts = text.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return DateRow.Day(month: parts[1], day: parts[2], year: parts[0])
    }
}

struct StreamSecretRow: View {
    let connector: HomeLink.Connector
    let member: HomeLink.Connector.Member
    let separator: Bool
    @ObservedObject var home: HomeConnectorsModel
    @State private var typed = ""
    @State private var sealed = 0

    var body: some View {
        let key = MemberChanges.key(connector.id, member.key)
        let busy = home.sealing.contains(key)
        SettingRow(member.label, line: member.words.isEmpty ? member.about : member.words, separator: separator, fieldEnd: true) {
            HStack(spacing: Cockpit.Space.s2) {
                Field(member.label, text: $typed, focus: nil, secure: true, spaces: false, error: home.sealRefused[key])
                    .textContentType(.password)
                    .submitLabel(.done)
                    .onSubmit(seal)
                    .accessibilityIdentifier("connector.setting.\(member.key)")
                Button("Save", action: seal)
                    .buttonStyle(.cockpit(.secondary, busy: busy))
                    .cockpitDone("Saved", after: sealed)
                    .disabled(typed.isEmpty || busy)
                    .accessibilityIdentifier("connector.setting.\(member.key).save")
            }
        } held: {
            failure(key, busy: busy)
        }
    }

    @ViewBuilder private func failure(_ key: String, busy: Bool) -> some View {
        if let failed = home.sealFailed[key], !busy {
            let retry: (() -> Void)? = failed == .notSent && !typed.isEmpty ? { seal() } : nil
            InPlaceLine(InPlaceLine.Said(failed), retry: retry)
                .accessibilityIdentifier("connector.setting.\(member.key).failure")
        }
    }

    private func seal() {
        guard !typed.isEmpty else { return }
        let value = typed
        Task {
            if await home.seal(connector, member.key, value) {
                typed = ""
                sealed += 1
            }
        }
    }
}

struct StreamForm: View {
    let connector: HomeLink.Connector
    @ObservedObject var home: HomeConnectorsModel

    static let label = "Account"

    var body: some View {
        let members = StreamRows.form.members(connector)
        if !members.isEmpty {
            SheetPart(Self.label) {
                ForEach(members) { member in
                    StreamMemberRow(connector: connector, member: member, separator: member.key != members.last?.key, home: home)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("connector.detail.form")
        }
    }
}

struct HomeFormPage: View {
    let id: String
    @ObservedObject var home: HomeConnectorsModel

    var body: some View {
        if let connector = home.read?.connectors.first(where: { $0.id == id }) {
            PageDrawer(connector.name) {
                StreamForm(connector: connector, home: home)
            }
        }
    }
}

struct StreamRefreshRow: View {
    let connector: HomeLink.Connector
    let refresh: HomeLink.Connector.RefreshNow
    var separator = false
    @ObservedObject var home: HomeConnectorsModel

    var body: some View {
        let busy = home.refreshing.contains(connector.id)
        let blocked = refresh.blocked
        VStack(alignment: .leading, spacing: 0) {
            ListRow(refresh.act.label, meta: Self.line(refresh) ?? home.refreshSaid[connector.id], separator: separator,
                    action: blocked != nil || busy ? nil : { Task { await home.refresh(connector) } }) {
                if busy { Spinner() }
            }
            .environment(\.cockpitRowActs, blocked == nil)
            .accessibilityIdentifier("connector.detail.refresh")
            if let failed = home.refreshFailed[connector.id], !busy {
                InPlaceLine(InPlaceLine.Said(failed), retry: failed.sendsAgain ? { Task { await home.refresh(connector) } } : nil)
                    .accessibilityIdentifier("connector.detail.refresh.failure")
            }
        }
    }

    static func line(_ refresh: HomeLink.Connector.RefreshNow) -> String? {
        if let blocked = refresh.blocked { return blocked.words }
        return refresh.asked.isEmpty ? nil : "Waiting for " + refresh.asked.map(\.name).joined(separator: ", ")
    }
}
