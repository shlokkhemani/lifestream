import SwiftUI

public struct MenuRow<Value: Hashable>: View {
    public enum Flush: Sendable { case none, trailing, whole }

    public struct Option: Identifiable, Equatable {
        public let value: Value
        let words: String
        let note: String?
        let group: String?
        let apart: Bool
        let off: Bool
        let opens: Bool

        public init(_ value: Value, _ words: String, note: String? = nil, group: String? = nil, apart: Bool = false, off: Bool = false,
                    opens: Bool = false) {
            self.value = value
            self.words = words
            self.note = note
            self.group = group
            self.apart = apart
            self.off = off
            self.opens = opens
        }

        public var id: Value { value }
    }

    let label: String
    @Binding var selection: Value
    let options: [Option]
    let defaultValue: Value?
    let busy: Bool
    let words: String?
    let prompt: String?
    let small: Bool
    let flush: Flush
    let note: String?
    let pill: Bool
    var forced: RowHighlight?
    var forcedOpen = false
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.inSettingSection) private var inSection
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(_ label: String, selection: Binding<Value>, options: [Option], default defaultValue: Value? = nil, busy: Bool = false,
                words: String? = nil, prompt: String? = nil, small: Bool = false, flush: Flush = .none, note: String? = nil,
                pill: Bool = false) {
        self.note = note
        self.pill = pill
        self.small = small
        self.flush = flush
        self.label = label
        self._selection = selection
        self.options = options
        self.defaultValue = defaultValue
        self.busy = busy
        self.words = words
        self.prompt = prompt
    }

    public var body: some View {
        Menu {
            MenuChoices(options: options, selection: $selection, default: defaultValue)
        } label: {
            EmptyView()
        }
        .menuStyle(.button)
        .menuOrder(.fixed)
        .buttonStyle(Cockpit.Pressable(forced: forced) { _, state in face(state) })
        .disabled(busy)
        .overlay(alignment: pill ? .topLeading : .topTrailing) {
            if forcedOpen { listed.fixedSize().offset(y: platform.hitSize) }
        }
        .accessibilityLabel(label)
        .accessibilityValue(words != nil || options.contains { $0.value == selection } || prompt == nil ? chosen : "")
    }

    private var chosen: String {
        words ?? options.first { $0.value == selection }?.words ?? prompt ?? String(describing: selection)
    }

    private var sections: [(name: String?, options: [Option])]? { MenuChoices.sections(options) }
    private func under(_ option: Option) -> String? { MenuChoices.under(option, defaultValue) }

    @ViewBuilder private func face(_ state: RowHighlight?) -> some View {
        if pill {
            pillFace(state)
        } else if inSection, flush == .none, !small {
            sectionFace(state)
        } else if flush == .whole { wholeFace(state) } else { capsuleFace(state).padding(.trailing, flush == .trailing ? -Self.caretRoom : 0) }
    }

    private static var caretRoom: CGFloat { Cockpit.Space.s2 }

    private func wholeFace(_ state: RowHighlight?) -> some View {
        HStack(spacing: Cockpit.Space.s2) {
            Text(chosen)
                .cockpit(.body)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .cockpitLines(1)
            Spacer(minLength: 0)
            if busy { Spinner() } else { ControlCaret(tone: Cockpit.Color.textSecondary, menu: true) }
        }
        .frame(maxWidth: .infinity, minHeight: platform.hitSize)
        .contentShape(Rectangle())
        .background {
            Capsule(style: .continuous).fill(state == nil ? Color.clear : Cockpit.Color.raised)
                .padding(.horizontal, -Cockpit.Space.s3)
                .padding(.vertical, Cockpit.Space.s1)
        }
        .animation(.easeOut(duration: Cockpit.Duration.instant), value: state)
    }

    private func capsuleFace(_ state: RowHighlight?) -> some View {
        let capsule = Capsule(style: .continuous)
        return HStack(spacing: Cockpit.Space.s1) {
            Text(chosen)
                .cockpit(small ? .subhead : .body)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .cockpitLines(1)
            Group {
                if busy { Spinner() } else { ControlCaret(menu: true) }
            }
            .frame(width: Cockpit.Size.iconSm, height: Cockpit.Size.iconSm, alignment: platform == .ios ? .trailing : .center)
        }
        .padding(.leading, Cockpit.Space.s3)
        .padding(.trailing, Cockpit.Space.s2)
        .padding(.vertical, Cockpit.Space.s1)
        .frame(minHeight: platform == .ios ? Cockpit.Size.controlSm : 28)
        .background(capsule.fill(state == nil ? Color.clear : Cockpit.Color.raised))
        .contentShape(capsule)
        .frame(minHeight: platform.hitSize)
        .contentShape(Rectangle())
        .animation(.easeOut(duration: Cockpit.Duration.instant), value: state)
    }

    private func pillFace(_ state: RowHighlight?) -> some View {
        let capsule = Capsule(style: .continuous)
        return HStack(spacing: Cockpit.Space.s1) {
            Text(chosen)
                .cockpit(.body)
                .foregroundStyle(Cockpit.Color.text)
                .cockpitLines(1)
            Group {
                if busy { Spinner() } else { ControlCaret(menu: true) }
            }
            .frame(width: Cockpit.Size.iconSm, height: Cockpit.Size.iconSm)
        }
        .padding(.leading, Cockpit.Space.s3 + Cockpit.Space.s1)
        .padding(.trailing, Cockpit.Space.s3)
        .frame(minHeight: platform == .ios ? Cockpit.sheetFace : 28)
        .background {
            capsule.fill(Cockpit.Color.raised)
            if let state, state != .selected { capsule.fill(RowChrome<EmptyView>.color(state)) }
        }
        .contentShape(capsule)
        .frame(minHeight: platform.hitSize)
        .contentShape(Rectangle())
        .animation(.easeOut(duration: Cockpit.Duration.instant), value: state)
    }

    private func sectionFace(_ state: RowHighlight?) -> some View {
        let capsule = Capsule(style: .continuous)
        let text = platform == .ios ? Cockpit.Style.iosRowTitle : platform.style(.rowTitle)
        return HStack(spacing: Cockpit.Space.s2) {
            HStack(spacing: Cockpit.Space.s1) {
                Text(chosen).cockpit(text).foregroundStyle(Cockpit.Color.text).cockpitLines(1).layoutPriority(1)
                if let note {
                    Text(note).cockpit(platform == .ios ? Cockpit.Style.iosSubhead : platform.style(.body))
                        .foregroundStyle(Cockpit.Color.textTertiary).lineLimit(1)
                }
            }
            .frame(minWidth: Self.sectionWords, alignment: .leading)
            Group {
                if busy { Spinner() } else { ControlCaret(menu: true) }
            }
            .frame(width: Cockpit.Size.iconSm, height: Cockpit.Size.iconSm)
        }
        .padding(.leading, Cockpit.Space.s3)
        .padding(.trailing, 10)
        .frame(minHeight: Cockpit.Size.controlSm)
        .background {
            capsule.fill(Cockpit.Color.raised)
            if let state, state != .selected { capsule.fill(RowChrome<EmptyView>.color(state)) }
        }
        .overlay(capsule.strokeBorder(Cockpit.Color.hairline, lineWidth: Cockpit.Stroke.border))
        .contentShape(capsule)
        .scaleEffect(state == .pressed && !reduceMotion ? 0.97 : 1)
        .animation(.easeOut(duration: Cockpit.Duration.fast), value: state)
        .frame(minHeight: platform.hitSize)
        .contentShape(Rectangle())
    }

    private static var sectionWords: CGFloat { 150 - Cockpit.Space.s3 - 10 - Cockpit.Space.s2 - Cockpit.Size.iconSm }

    private var listed: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(options.indices, id: \.self) { index in
                let option = options[index]
                if sections != nil, let name = option.group, index == 0 || options[index - 1].group != option.group {
                    Text(name)
                        .cockpit(.footnote)
                        .foregroundStyle(Cockpit.Color.textSecondary)
                        .padding(.horizontal, Cockpit.Space.s4)
                        .padding(.top, Cockpit.Space.s2 + 2)
                        .padding(.bottom, Cockpit.Space.s1)
                }
                HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s2) {
                    Icon(.done, size: .sm)
                        .foregroundStyle(Cockpit.Color.text)
                        .opacity(option.value == selection ? 1 : 0)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(option.words).cockpit(.body).foregroundStyle(option.off ? Cockpit.Color.textTertiary : Cockpit.Color.text)
                        if let under = under(option) {
                            Text(under).cockpit(.footnote).foregroundStyle(Cockpit.Color.textSecondary)
                        }
                    }
                    if option.opens {
                        Spacer(minLength: Cockpit.Space.s2)
                        Icon(.forward, size: .sm).foregroundStyle(Cockpit.Color.textTertiary)
                    }
                }
                .padding(.horizontal, Cockpit.Space.s4)
                .padding(.vertical, Cockpit.Space.s2 + 2)
                .frame(minWidth: 240, alignment: .leading)
                if option.id != options.last?.id {
                    Rectangle().fill(Cockpit.Color.rule).frame(height: Cockpit.Stroke.border)
                }
            }
        }
        .background(RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous).fill(Cockpit.Color.surface))
        .cockpitShadow(Cockpit.Shadow.raised, in: RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous))
    }
}

extension MenuRow.Option: Sendable where Value: Sendable {}

struct MenuChoices<Value: Hashable>: View {
    let options: [MenuRow<Value>.Option]
    @Binding var selection: Value
    let defaultValue: Value?

    init(options: [MenuRow<Value>.Option], selection: Binding<Value>, default defaultValue: Value?) {
        self.options = options
        self._selection = selection
        self.defaultValue = defaultValue
    }

    var body: some View {
        Group {
            if let sections = Self.sections(options) {
                ForEach(sections.indices, id: \.self) { index in
                    Section { items(sections[index].options) } header: {
                        if let name = sections[index].name { Text(name) }
                    }
                }
            } else {
                items(options)
            }
        }
        .toggleStyle(.automatic)
    }

    private func items(_ options: [MenuRow<Value>.Option]) -> some View {
        ForEach(options) { option in
            if option.opens {
                Button { selection = option.value } label: {
                    Label { Text(option.words) } icon: { MenuIcon.image(.forward) }
                }
                .disabled(option.off)
            } else {
                Toggle(isOn: Binding(get: { option.value == selection }, set: { if $0 { selection = option.value } })) {
                    Text(option.words)
                    if let under = Self.under(option, defaultValue) { Text(under) }
                }
                .disabled(option.off)
            }
        }
    }

    static func sections(_ options: [MenuRow<Value>.Option]) -> [(name: String?, options: [MenuRow<Value>.Option])]? {
        var runs: [(name: String?, options: [MenuRow<Value>.Option])] = []
        for option in options {
            if let last = runs.indices.last, runs[last].name == option.group, !option.apart {
                runs[last].options.append(option)
            } else {
                runs.append((option.group, [option]))
            }
        }
        return runs.count > 1 ? runs : nil
    }

    static func under(_ option: MenuRow<Value>.Option, _ defaultValue: Value?) -> String? {
        let said = [option.note, option.value == defaultValue ? "Default" : nil].compactMap { $0 }
        return said.isEmpty ? nil : said.joined(separator: " · ")
    }
}
