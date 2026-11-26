import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct SettingsPage: View {
    let id: String
    let title: String
    @StateObject private var read: PageReading<HomeLink.Pages.SettingsPage>
    @StateObject private var writes: SettingsWrites

    init(id: String, title: String, set: @escaping SettingsWrites.Send = SettingsWrites.home) {
        self.id = id
        self.title = title
        _read = StateObject(wrappedValue: PageReading(Self.key(id)))
        _writes = StateObject(wrappedValue: SettingsWrites(set: set))
    }

    static func key(_ id: String) -> HomeLink.PageKey {
        HomeLink.PageKey(HomeLink.Pages.SettingsPage.route, ["id": id])
    }

    static let lacks = "Pair this iPhone to see this page."

    var body: some View {
        SheetPage(read.page?.title ?? title) {
            if let page = read.page {
                PageNote(drawn: read.drawn).padding(.horizontal, Cockpit.Space.s4)
                if let line = page.line {
                    Text(line)
                        .cockpit(Cockpit.Style.iosFootnote)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .padding(.horizontal, Cockpit.Space.s4)
                }
                ForEach(page.parts.indices, id: \.self) { index in
                    let part = page.parts[index]
                    SheetPart(part.label, line: part.line) {
                        SettingsRows(Self.lines(part.rows), busy: writes.busy, unlanded: writes.unlanded.mapValues { InPlaceLine.Said($0.said) },
                                     pick: { key, value in Task { await write(key, value, over: Self.held(key, in: page)) } },
                                     retry: { key in
                                         guard let value = writes.unlanded[key]?.value else { return }
                                         Task { await write(key, value, over: nil) }
                                     })
                    }
                }
            } else if let failure = read.failure {
                ReadLack(failure, lacks: Self.lacks, words: PlacesWords.failure(failure))
                    .padding(.horizontal, Cockpit.Space.s4)
            } else {
                Loading(title, size: .inline).padding(.horizontal, Cockpit.Space.s4)
            }
        }
        .task { await read.read() }
        .readsAgain(failed: { read.failure }) { await read.read() }
        .accessibilityIdentifier("settings.page.\(id)")
    }

    private func write(_ key: String, _ value: SettingsLine.Value, over held: SettingsLine.Value?) async {
        guard held != value else { return }
        guard await writes.set(key, value) else { return }
        await read.read()
    }

    static func held(_ key: String, in page: HomeLink.Pages.SettingsPage) -> SettingsLine.Value? {
        for row in page.parts.flatMap(\.rows) {
            if case let .choice(each, choices) = end(row.end), each == key { return choices.first { $0.chosen }?.value }
        }
        return nil
    }

    static func lines(_ rows: [HomeLink.Pages.SettingsRow]) -> [SettingsLine] {
        rows.map { SettingsLine(id: $0.id, label: $0.label, line: $0.line, end: end($0.end)) }
    }

    static func end(_ end: HomeLink.Pages.SettingsEnd?) -> SettingsLine.End {
        switch end {
        case let .value(value, signal)?:
            .value(Words.phrase(value), signal: signal.flatMap { Cockpit.HealthState(rawValue: $0.rawValue)?.signal })
        case let .choice(key, choices)?:
            .choice(key: key, choices: choices.map { SettingsLine.Choice(words: $0.words, value: .number($0.value), chosen: $0.chosen, isDefault: $0.default) })
        case let .pick(key, choices)?:
            .choice(key: key, choices: choices.map { SettingsLine.Choice(words: $0.words, value: .word($0.value), chosen: $0.chosen, isDefault: $0.default) })
        case .unknown?, nil:
            .none
        }
    }
}

@MainActor
final class SettingsWrites: ObservableObject {
    typealias Send = @MainActor (String, HomeLink.JSON) async throws -> SettingOutcome

    struct Unlanded: Equatable {
        let said: HomeLink.ActSaid
        let value: SettingsLine.Value
    }

    @Published private(set) var busy: Set<String> = []
    @Published private(set) var unlanded: [String: Unlanded] = [:]
    private let send: Send

    init(set: @escaping Send) {
        send = set
    }

    static let home: Send = { key, value in try await AppRuntime.shared.shipping.link.setHomeSetting(key: key, value: value) }

    func set(_ key: String, _ value: SettingsLine.Value) async -> Bool {
        guard !busy.contains(key) else { return false }
        busy.insert(key)
        unlanded[key] = nil
        defer { busy.remove(key) }
        let outcome: SettingOutcome
        do {
            outcome = try await send(key, Self.json(value))
        } catch {
            outcome = .unreachable
        }
        guard let said = HomeConnectorsModel.said(outcome) else { return true }
        unlanded[key] = Unlanded(said: said, value: value)
        return false
    }

    static func json(_ value: SettingsLine.Value) -> HomeLink.JSON {
        switch value {
        case let .number(number): .number(number)
        case let .word(word): .string(word)
        }
    }
}
