import Cockpit
import HomeLink
import SwiftUI

enum ModelFind {
    static let opens = "\n"
    static let failed = "Couldn’t look for models"

    static func options(_ menu: HomeLink.Pages.ModelMenu) -> [MenuRow<String>.Option] {
        let local = menu.local.map { local in local.rows.map { option($0, group: local.label) } } ?? []
        return (menu.default.map { [option($0)] } ?? []) + menu.rows.map { option($0) } + local
            + [MenuRow<String>.Option(opens, menu.more.words, apart: true, opens: true)]
            + (menu.off.map { [option($0)] } ?? [])
    }

    static func query(_ more: HomeLink.Pages.ModelMore) -> [String: String] {
        more.work.map { ["work": $0] } ?? ["use": more.use.rawValue]
    }

    private static func option(_ row: HomeLink.Pages.ModelRow, group: String? = nil) -> MenuRow<String>.Option {
        MenuRow<String>.Option(row.value, row.name, note: row.account, group: group)
    }
}

struct ModelFindList: View {
    let more: HomeLink.Pages.ModelMore
    let chosen: String?
    let busy: Bool
    let pick: (HomeLink.Pages.ModelRow) -> Void
    @State private var query = ""
    @State private var found: HomeLink.Pages.ModelsFind?
    @State private var failed: String?
    @FocusState private var focused: Bool

    var body: some View {
        SearchField(text: $query.timed(.searchKeystroke), placeholder: found?.placeholder ?? "", focus: $focused)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .accessibilityIdentifier("models.find.field")
            .onAppear { focused = true }
            .task(id: Asking(more: more, typed: typed)) { await find() }
        if let found {
            part(nil, found.rows)
            if let local = found.local { part(local.label, local.rows) }
        }
        if let none = failed ?? found?.none {
            NoneLine(none)
        }
    }

    @ViewBuilder private func part(_ label: String?, _ rows: [HomeLink.Pages.ModelRow]) -> some View {
        if !rows.isEmpty {
            SheetPart(label) {
                LazyVStack(spacing: 0) {
                    ForEach(rows, id: \.value) { row in
                        ListRow(row.name, meta: row.account, separator: row.value != rows.last?.value,
                                action: { if row.value != chosen { pick(row) } }) {
                            if row.value == chosen { Icon(.done, size: .sm).foregroundStyle(Cockpit.Color.engaged) }
                        }
                        .accessibilityAddTraits(row.value == chosen ? .isSelected : [])
                        .accessibilityIdentifier("models.find.\(row.value)")
                    }
                }
                .disabled(busy)
            }
        }
    }

    private var typed: String { query.trimmingCharacters(in: .whitespaces) }

    private struct Asking: Equatable {
        let more: HomeLink.Pages.ModelMore
        let typed: String
    }

    private func find() async {
        if !typed.isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
        guard !Task.isCancelled else { return }
        do {
            let answer = try await AppRuntime.shared.life.findModels(typed, for: more)
            guard !Task.isCancelled else { return }
            found = answer
            failed = nil
        } catch is CancellationError {
        } catch let failure as LifeReader.Failure {
            failed = PeopleWords.failure(failure) ?? ModelFind.failed
        } catch {
            failed = ModelFind.failed
        }
    }
}

struct StreamModelPage: View {
    let id: String
    let member: String
    @ObservedObject var home: HomeConnectorsModel

    var body: some View {
        if let connector = home.read?.connectors.first(where: { $0.id == id }),
           let field = connector.members.first(where: { $0.key == member }), let menu = field.menu {
            let key = MemberChanges.key(id, member)
            PageDrawer(menu.more.words) {
                ModelFindList(more: menu.more, chosen: field.value?.key, busy: home.changes.busy.contains(key)) { row in
                    Task { await home.set(connector, member, .string(row.value), was: field.value) }
                }
                if let problem = home.changes.problem(key, read: home.failure) {
                    Text(problem).cockpit(.footnote).foregroundStyle(Cockpit.Color.warning)
                }
                MemberFailure(connector: connector, member: member, home: home)
            }
        }
    }
}
