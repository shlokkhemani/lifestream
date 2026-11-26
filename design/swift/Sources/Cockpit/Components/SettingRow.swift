import SwiftUI

extension EnvironmentValues {
    @Entry var inSettingSection = false
}

private struct ProblemLine<Words: View>: View {
    @ViewBuilder let words: Words
    @Environment(\.cockpitPlatform) private var platform

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            SignalShape(.warning, size: platform == .ios ? 12 : 10)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            words
        }
    }
}

public enum SettingLead {
    case icon(Cockpit.Icon)
    case toned(Cockpit.Icon, Cockpit.SignalKind)
    case glyph(Cockpit.Icon)
    case image(Image)
    case signal(Cockpit.SignalKind)
    case tone(DiskBar.Tone)
}

public struct SettingRow<End: View, Held: View>: View {
    let label: String
    let about: String?
    let waiting: String?
    let only: String?
    let problem: String?
    let line: String?
    let signal: Cockpit.SignalKind?
    let note: String?
    let separator: Bool
    let lead: SettingLead?
    let tag: String?
    let working: Bool
    let asking: Bool
    let opens: (() -> Void)?
    let fieldEnd: Bool
    let end: End
    let held: Held
    var forced: RowHighlight?
    var fact = false
    var lineOpens = false
    var top = false
    var inPlace = false
    @Environment(\.cockpitPlatform) private var platform

    public init(_ label: String, about: String? = nil, waiting: String? = nil, only: String? = nil, problem: String? = nil,
                line: String? = nil, signal: Cockpit.SignalKind? = nil, note: String? = nil, separator: Bool = true,
                lead: SettingLead? = nil, tag: String? = nil, working: Bool = false, asking: Bool = false,
                opens: (() -> Void)? = nil, fieldEnd: Bool = false, @ViewBuilder end: () -> End, @ViewBuilder held: () -> Held) {
        self.label = label
        self.about = about
        self.waiting = waiting
        self.only = only
        self.problem = problem
        self.line = line
        self.signal = signal
        self.note = note
        self.separator = separator
        self.lead = lead
        self.tag = tag
        self.working = working
        self.asking = asking
        self.opens = opens
        self.fieldEnd = fieldEnd
        self.end = end()
        self.held = held()
    }

    public var body: some View {
        if fact {
            drawn.accessibilityElement(children: .combine)
        } else {
            drawn
        }
    }

    @ViewBuilder private var drawn: some View {
        Group {
            if let opens {
                Button(action: opens) { content }
                    .buttonStyle(Cockpit.Pressable(forced: forced) { label, state in chrome(label, state) })
            } else {
                chrome(content, nil)
            }
        }
        .environment(\.inSettingSection, true)
    }

    private func chrome<Row: View>(_ row: Row, _ state: RowHighlight?) -> some View {
        let past = platform == .mac ? Cockpit.Space.s2 : 0
        let fill: Color? = asking ? Cockpit.Color.warningSoft : state.map { RowChrome<EmptyView>.color($0) }
        return row
            .background {
                if let fill {
                    RoundedRectangle(cornerRadius: platform == .mac ? Cockpit.Radius.sm : 0, style: .continuous)
                        .fill(fill)
                        .padding(.horizontal, -past)
                }
            }
            .animation(.easeOut(duration: Cockpit.Duration.instant), value: state)
    }

    private var content: some View {
        Group {
            if platform == .ios {
                RowFit(spacing: Cockpit.Space.s6, least: Self.iosWords, stacks: fieldEnd, first: top ? firstLine : nil) {
                    wordsWithLead
                    ending
                }
            } else {
                HStack(alignment: top ? .top : .center, spacing: Cockpit.Space.s6) {
                    wordsWithLead
                    if fieldEnd {
                        ending.frame(width: Self.macField)
                    } else {
                        ending.fixedSize()
                    }
                }
            }
        }
        .padding(.horizontal, platform == .ios ? platform.rowInset : 0)
        .padding(.vertical, platform == .ios ? Cockpit.Space.s3 : 14)
        .frame(maxWidth: .infinity, minHeight: minimum, alignment: .leading)
        .contentShape(Rectangle())
        .overlay(alignment: .bottom) {
            if separator {
                Rectangle()
                    .fill(Cockpit.Color.rule)
                    .frame(height: platform.ruleHeight)
                    .padding(.leading, platform == .ios ? platform.rowInset + leadWidth : 0)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private static var iosWords: CGFloat { 140 }
    private static var macField: CGFloat { 240 }

    private var wordsWithLead: some View {
        HStack(alignment: top ? .top : .center, spacing: Cockpit.Space.s3) {
            if let lead {
                leadView(lead).alignmentGuide(.top) { $0[VerticalAlignment.center] - titleLine / 2 }
            }
            words.frame(maxWidth: .infinity, alignment: .leading)
        }
        .layoutPriority(1)
    }

    private var titleLine: CGFloat {
        (platform == .ios ? Cockpit.Style.iosRowTitle : platform.style(.rowTitle)).lineHeight
    }

    private var firstLine: CGFloat { max(titleLine, leadHeight) }

    private var leadHeight: CGFloat {
        switch lead {
        case nil: 0
        case .icon, .toned, .image: Cockpit.Size.avatarMd
        case .glyph: Cockpit.Size.avatarSm
        case .signal, .tone: Cockpit.Size.iconMd
        }
    }

    @ViewBuilder private var ending: some View {
        if hasEnd {
            HStack(spacing: Cockpit.Space.s2) {
                end
                if opens != nil, !lineOpens, !inPlace {
                    Icon(.forward, size: .xs).foregroundStyle(Cockpit.Color.textTertiary).accessibilityHidden(true)
                }
            }
        }
    }

    private var minimum: CGFloat {
        guard platform == .mac else { return platform.rowHeight }
        return line != nil || problem != nil || waiting != nil || only != nil || note != nil ? 60 : 44
    }

    private var hasEnd: Bool { End.self != EmptyView.self || (opens != nil && !lineOpens && !inPlace) }

    private var leadWidth: CGFloat {
        switch lead {
        case nil: 0
        case .icon, .toned, .image: Cockpit.Size.avatarMd + Cockpit.Space.s3
        case .glyph: Cockpit.Size.avatarSm + Cockpit.Space.s3
        case .signal, .tone: Cockpit.Size.iconMd + Cockpit.Space.s3
        }
    }

    @ViewBuilder private func leadView(_ lead: SettingLead) -> some View {
        let side = Cockpit.Size.avatarMd
        switch lead {
        case let .icon(icon):
            tile(icon, ink: Cockpit.Color.textSecondary)
        case let .toned(icon, kind):
            tile(icon, ink: kind.color)
        case let .glyph(icon):
            Icon(icon, size: .md)
                .foregroundStyle(Cockpit.Color.text)
                .frame(width: Cockpit.Size.avatarSm, height: Cockpit.Size.avatarSm)
                .accessibilityHidden(true)
        case let .image(image):
            image.resizable().scaledToFit().frame(width: side, height: side).accessibilityHidden(true)
        case let .signal(kind):
            SignalShape(kind, size: platform == .ios ? 12 : 10, pulse: kind == .engaged)
                .frame(width: Cockpit.Size.iconMd, height: Cockpit.Size.iconMd)
        case let .tone(tone):
            DiskDot(tone: tone).frame(width: Cockpit.Size.iconMd, height: Cockpit.Size.iconMd)
        }
    }

    private func tile(_ icon: Cockpit.Icon, ink: Color) -> some View {
        let side = Cockpit.Size.avatarMd
        return Icon(icon, size: .sm)
            .foregroundStyle(ink)
            .frame(width: side, height: side)
            .background(RoundedRectangle(cornerRadius: Cockpit.Radius.sm, style: .continuous).fill(Cockpit.Color.well))
            .overlay(RoundedRectangle(cornerRadius: Cockpit.Radius.sm, style: .continuous)
                .strokeBorder(Cockpit.Color.hairline, lineWidth: Cockpit.Stroke.border))
            .accessibilityHidden(true)
    }

    private var words: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .center, spacing: Cockpit.Space.s2) {
                Text(label)
                    .cockpit(platform == .ios ? Cockpit.Style.iosRowTitle : platform.style(.rowTitle))
                    .foregroundStyle(Cockpit.Color.text)
                    .fixedSize(horizontal: false, vertical: true)
                if let about { InfoMark(about, label: label) }
                if let tag { SettingTag(tag) }
            }
            if let line {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if let signal {
                        SignalShape(signal, size: platform == .ios ? 8 : 6, pulse: signal == .engaged)
                            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                    }
                    if lineOpens, opens != nil {
                        HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s1) {
                            Text(line)
                                .cockpit(platform == .ios ? Cockpit.Style.iosFootnote : platform.style(.subhead))
                                .foregroundStyle(Cockpit.Color.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                            Icon(.forward, size: .xs).foregroundStyle(Cockpit.Color.textTertiary).accessibilityHidden(true)
                        }
                    } else {
                        Text(line).shimmer(working).settingLine()
                    }
                }
            }
            if Held.self != EmptyView.self { held.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, Cockpit.Space.s1) }
            state
        }
    }

    @ViewBuilder private var state: some View {
        if let problem {
            ProblemLine { Text(problem).settingLine(Cockpit.Color.warning) }
        } else if let waiting = waiting ?? only {
            Text(waiting).settingLine(Cockpit.Color.textTertiary)
        } else if let note {
            Text(note).settingLine(Cockpit.Color.textTertiary)
        }
    }
}

private struct RowFit: Layout {
    let spacing: CGFloat
    let least: CGFloat
    let stacks: Bool
    let first: CGFloat?

    private func arrange(_ width: CGFloat?, _ subviews: Subviews) -> (side: Bool, words: CGSize, end: CGSize, size: CGSize) {
        let words = subviews[0]
        let end = subviews.count > 1 ? subviews[1] : nil
        let endIdeal = end?.sizeThatFits(.unspecified) ?? .zero
        let gap = endIdeal.width > 0 ? spacing : 0
        let wordsIdeal = words.sizeThatFits(.unspecified).width
        let available = width ?? (wordsIdeal + gap + endIdeal.width)
        if !stacks, available - gap - endIdeal.width >= min(least, wordsIdeal) {
            let wordsSize = words.sizeThatFits(ProposedViewSize(width: available - gap - endIdeal.width, height: nil))
            return (true, wordsSize, endIdeal, CGSize(width: available, height: max(wordsSize.height, endIdeal.height)))
        }
        let wordsSize = words.sizeThatFits(ProposedViewSize(width: available, height: nil))
        let endSize = end.map { sub -> CGSize in
            let fitted = sub.sizeThatFits(ProposedViewSize(width: available, height: nil))
            return CGSize(width: min(fitted.width, available), height: fitted.height)
        } ?? .zero
        let below = endSize.height > 0 ? Cockpit.Space.s2 + endSize.height : 0
        return (false, wordsSize, endSize, CGSize(width: available, height: wordsSize.height + below))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(proposal.width, subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let laid = arrange(bounds.width, subviews)
        let top = bounds.minY + max(0, (bounds.height - laid.size.height) / 2)
        if laid.side, let first {
            subviews[0].place(at: CGPoint(x: bounds.minX, y: top), anchor: .topLeading, proposal: ProposedViewSize(laid.words))
            if subviews.count > 1 {
                subviews[1].place(at: CGPoint(x: bounds.maxX, y: top + max(0, (first - laid.end.height) / 2)), anchor: .topTrailing,
                                  proposal: ProposedViewSize(laid.end))
            }
        } else if laid.side {
            subviews[0].place(at: CGPoint(x: bounds.minX, y: top + laid.size.height / 2), anchor: .leading, proposal: ProposedViewSize(laid.words))
            if subviews.count > 1 {
                subviews[1].place(at: CGPoint(x: bounds.maxX, y: top + laid.size.height / 2), anchor: .trailing, proposal: ProposedViewSize(laid.end))
            }
        } else {
            subviews[0].place(at: CGPoint(x: bounds.minX, y: top), proposal: ProposedViewSize(laid.words))
            if subviews.count > 1 {
                subviews[1].place(at: CGPoint(x: bounds.maxX, y: top + laid.words.height + Cockpit.Space.s2), anchor: .topTrailing,
                                  proposal: ProposedViewSize(laid.end))
            }
        }
    }
}

public extension SettingRow {
    func opensFromLine() -> Self {
        var row = self
        row.lineOpens = true
        return row
    }

    func topAligned() -> Self {
        var row = self
        row.top = true
        return row
    }

    func picksInPlace(_ picks: Bool = true) -> Self {
        var row = self
        row.inPlace = picks
        return row
    }
}

public extension SettingRow where Held == EmptyView {
    init(_ label: String, about: String? = nil, waiting: String? = nil, only: String? = nil, problem: String? = nil,
         line: String? = nil, signal: Cockpit.SignalKind? = nil, note: String? = nil, separator: Bool = true,
         lead: SettingLead? = nil, tag: String? = nil, working: Bool = false, asking: Bool = false,
         opens: (() -> Void)? = nil, fieldEnd: Bool = false, @ViewBuilder end: () -> End) {
        self.init(label, about: about, waiting: waiting, only: only, problem: problem, line: line, signal: signal, note: note,
                  separator: separator, lead: lead, tag: tag, working: working, asking: asking, opens: opens,
                  fieldEnd: fieldEnd, end: end, held: { EmptyView() })
    }
}

public extension SettingRow where End == SettingValue, Held == EmptyView {
    init(_ label: String, value: String, done: Bool = false, state: Cockpit.SignalKind? = nil, line: String? = nil,
         problem: String? = nil, note: String? = nil, separator: Bool = true) {
        self.init(label, problem: problem, line: line, note: note, separator: separator) {
            SettingValue(value, done: done, signal: state)
        }
        fact = true
    }
}

public extension SettingRow where End == EmptyView, Held == EmptyView {
    init(_ label: String, about: String? = nil, line: String? = nil, signal: Cockpit.SignalKind? = nil, separator: Bool = true,
         lead: SettingLead? = nil, tag: String? = nil, working: Bool = false, opens: (() -> Void)? = nil) {
        self.init(label, about: about, line: line, signal: signal, separator: separator, lead: lead, tag: tag,
                  working: working, opens: opens) { EmptyView() }
    }
}

public struct SettingValue: View {
    let words: String
    let done: Bool
    let signal: Cockpit.SignalKind?
    @Environment(\.cockpitPlatform) private var platform

    public init(_ words: String, done: Bool = false, signal: Cockpit.SignalKind? = nil) {
        self.words = words
        self.done = done
        self.signal = signal
    }

    public var body: some View {
        HStack(spacing: 6) {
            if done { Icon(.done, size: .sm).foregroundStyle(Cockpit.Color.engaged).accessibilityHidden(true) }
            if let signal { SignalShape(signal, size: platform == .ios ? 8 : 6, pulse: false) }
            Text(words)
                .cockpit(platform == .ios ? Cockpit.Style.iosSubhead : platform.style(.body))
                .foregroundStyle(Cockpit.Color.textSecondary)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct SettingTag: View {
    let words: String
    init(_ words: String) { self.words = words }

    var body: some View {
        Text(words)
            .cockpit(Cockpit.Style.iosCaption2)
            .foregroundStyle(Cockpit.Color.textSecondary)
            .lineLimit(1)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .frame(minHeight: 20)
            .overlay(Capsule(style: .continuous).strokeBorder(Cockpit.Color.border, lineWidth: Cockpit.Stroke.border))
            .fixedSize()
    }
}

extension View {
    func settingLine(_ color: Color = Cockpit.Color.textSecondary) -> some View {
        modifier(SettingLineText(color: color))
    }
}

private struct SettingLineText: ViewModifier {
    let color: Color
    @Environment(\.cockpitPlatform) private var platform

    func body(content: Content) -> some View {
        content
            .cockpit(platform == .ios ? Cockpit.Style.iosFootnote : platform.style(.subhead))
            .foregroundStyle(color)
            .frame(maxWidth: 56 * 7, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}
