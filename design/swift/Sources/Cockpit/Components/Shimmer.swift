import SwiftUI

public extension View {
    func shimmer(_ on: Bool = true) -> some View {
        modifier(Shimmer(on: on))
    }
}

struct Shimmer: ViewModifier {
    let on: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.skeletonForced) private var forced

    @ViewBuilder func body(content: Content) -> some View {
        if !on || reduceMotion {
            content
        } else {
            TimelineView(.animation(paused: forced != nil)) { context in
                content.foregroundStyle(Self.sweep(forced ?? Self.pass(at: context.date)))
            }
        }
    }

    static func pass(at date: Date) -> Double {
        date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: Cockpit.Duration.sweep) / Cockpit.Duration.sweep
    }

    static func sweep(_ pass: Double) -> LinearGradient {
        let middle = 2 * pass - 0.5
        return LinearGradient(colors: [Cockpit.Color.textTertiary, Cockpit.Color.text, Cockpit.Color.textTertiary],
                              startPoint: UnitPoint(x: middle - 0.45, y: 0.5), endPoint: UnitPoint(x: middle + 0.45, y: 0.5))
    }
}
