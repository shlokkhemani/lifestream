import SwiftUI

public struct AskSteps: View {
    let trace: AskTrace
    let waiting: String?
    @Binding var open: Bool
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(_ trace: AskTrace, waiting: String? = nil, open: Binding<Bool>) {
        self.trace = trace
        self.waiting = waiting
        self._open = open
    }

    public var body: some View {
        if let waiting {
            held(waiting)
        } else {
            TimelineView(AskFrames(until: trace.settles)) { context in
                drawn(trace.frame(at: context.date.timeIntervalSinceReferenceDate))
            }
        }
    }

    private var role: Cockpit.Role { platform == .mac ? .subhead : .footnote }

    private func held(_ words: String) -> some View {
        HStack(spacing: 6) {
            Loading(words, size: .glyph)
            Text(words)
                .cockpit(role)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(Cockpit.Color.textTertiary)
    }

    @ViewBuilder private func drawn(_ frame: AskTrace.Frame) -> some View {
        if let line = frame.line {
            let opens = frame.settled && !trace.steps.isEmpty
            VStack(alignment: .leading, spacing: 0) {
                if opens {
                    Button { open.toggle() } label: { self.line(line, opens: true) }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Self.words(line))
                        .accessibilityValue(open ? "Shown" : "Hidden")
                        .accessibilityHint("Shows the steps")
                } else {
                    self.line(line, opens: false)
                }
                if opens && open {
                    VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
                        ForEach(trace.steps) { step in row(step) }
                    }
                    .padding(.top, Cockpit.Space.s2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(.opacity)
                }
            }
            .animation(reduceMotion ? .linear(duration: Cockpit.Duration.fast) : Cockpit.Ease.out(Cockpit.Duration.base), value: open)
        }
    }

    private func line(_ line: AskTrace.Line, opens: Bool) -> some View {
        ZStack(alignment: .leading) {
            Text(AskTrace.thinking).cockpit(role).hidden()
            phrase(line, opens: opens)
                .id(Self.words(line))
                .transition(reduceMotion ? .opacity : .asymmetric(insertion: .offset(y: Cockpit.Space.s2).combined(with: .opacity),
                                                                  removal: .offset(y: -Cockpit.Space.s2).combined(with: .opacity)))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(reduceMotion ? .linear(duration: Cockpit.Duration.fast) : Cockpit.Ease.out(Cockpit.Duration.fast), value: Self.words(line))
        .contentShape(Rectangle())
    }

    @ViewBuilder private func phrase(_ line: AskTrace.Line, opens: Bool) -> some View {
        switch line {
        case let .working(words):
            Text(words)
                .cockpit(role)
                .lineLimit(1)
                .shimmer()
                .foregroundStyle(Cockpit.Color.textTertiary)
        case .thought:
            HStack(spacing: 2) {
                Text(Self.words(line))
                    .cockpit(role)
                    .lineLimit(1)
                if opens {
                    Icon(.forward, size: .xs)
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .animation(reduceMotion ? nil : Cockpit.Ease.out(Cockpit.Duration.base), value: open)
                }
            }
            .foregroundStyle(Cockpit.Color.textTertiary)
        }
    }

    private func row(_ step: AskTrace.Step) -> some View {
        HStack(spacing: Cockpit.Space.s2) {
            if step.failed { SignalShape(.warning, size: platform == .ios ? 12 : 10) }
            Text(step.words)
                .cockpit(role)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }

    nonisolated static func words(_ line: AskTrace.Line) -> String {
        switch line {
        case let .working(words): words
        case let .thought(ms): "Thought for " + took(ms)
        }
    }

    nonisolated public static func took(_ ms: Int) -> String {
        let tenths = Int((Double(max(0, ms)) / 100).rounded())
        if tenths < 10 { return "0.\(tenths)s" }
        let seconds = Int((Double(ms) / 1000).rounded())
        if seconds < 60 { return "\(seconds)s" }
        return "\(seconds / 60)m" + (seconds % 60 == 0 ? "" : " \(seconds % 60)s")
    }
}

struct AskFrames: TimelineSchedule {
    let until: TimeInterval?

    func entries(from start: Date, mode: TimelineScheduleMode) -> Entries {
        Entries(frames: AnimationTimelineSchedule().entries(from: start, mode: mode).makeIterator(),
                until: until.map { Date(timeIntervalSinceReferenceDate: $0 + Cockpit.Duration.fast) })
    }

    struct Entries: Sequence, IteratorProtocol {
        var frames: AnimationTimelineSchedule.Entries.Iterator
        let until: Date?
        var over = false

        mutating func next() -> Date? {
            guard !over, let date = frames.next() else { return nil }
            if let until, date >= until { over = true }
            return date
        }
    }
}
