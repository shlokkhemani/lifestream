import SwiftUI

public struct SettingsLine: Identifiable, Equatable, Sendable {
    public enum End: Equatable, Sendable {
        case value(String, signal: Cockpit.SignalKind?)
        case choice(key: String, choices: [Choice])
        case none
    }

    public enum Value: Hashable, Sendable {
        case number(Double)
        case word(String)
    }

    public struct Choice: Equatable, Sendable {
        public let words: String
        public let value: Value
        public let chosen: Bool
        public let isDefault: Bool

        public init(words: String, value: Value, chosen: Bool, isDefault: Bool) {
            self.words = words
            self.value = value
            self.chosen = chosen
            self.isDefault = isDefault
        }
    }

    public let id: String
    public let label: String
    public let line: String?
    public let end: End

    public init(id: String, label: String, line: String?, end: End) {
        self.id = id
        self.label = label
        self.line = line
        self.end = end
    }
}

public struct SettingsRows: View {
    let rows: [SettingsLine]
    let busy: Set<String>
    let unlanded: [String: InPlaceLine.Said]
    let pick: (String, SettingsLine.Value) -> Void
    let retry: ((String) -> Void)?

    public init(_ rows: [SettingsLine], busy: Set<String> = [], unlanded: [String: InPlaceLine.Said] = [:],
                pick: @escaping (String, SettingsLine.Value) -> Void, retry: ((String) -> Void)? = nil) {
        self.rows = rows
        self.busy = busy
        self.unlanded = unlanded
        self.pick = pick
        self.retry = retry
    }

    public var body: some View {
        ForEach(rows.indices, id: \.self) { index in
            row(rows[index], separator: index < rows.count - 1)
                .accessibilityIdentifier("settings.row.\(rows[index].id)")
        }
    }

    @ViewBuilder private func row(_ row: SettingsLine, separator: Bool) -> some View {
        switch row.end {
        case let .value(words, signal):
            SettingRow(row.label, value: words, state: signal, line: row.line, separator: separator)
        case let .choice(key, choices):
            if let held = Self.held(choices) {
                SettingRow(row.label, line: row.line, separator: separator) {
                    MenuRow(row.label, selection: Binding(get: { held }, set: { pick(key, $0) }),
                            options: choices.map { MenuRow<SettingsLine.Value>.Option($0.value, $0.words) },
                            default: choices.first { $0.isDefault }?.value, busy: busy.contains(key))
                        .accessibilityIdentifier("settings.choice.\(key)")
                } held: {
                    if let said = unlanded[key] {
                        InPlaceLine(said, retry: retry.map { again in { again(key) } })
                            .accessibilityIdentifier("settings.choice.\(key).failure")
                    }
                }
            } else {
                SettingRow(row.label, line: row.line, separator: separator)
            }
        case .none:
            SettingRow(row.label, line: row.line, separator: separator)
        }
    }

    public static func held(_ choices: [SettingsLine.Choice]) -> SettingsLine.Value? {
        (choices.first { $0.chosen } ?? choices.first { $0.isDefault } ?? choices.first)?.value
    }
}
