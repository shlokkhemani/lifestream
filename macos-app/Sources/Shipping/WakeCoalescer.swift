import Foundation
import IOKit.ps

public enum PowerMode: Sendable, Equatable, CaseIterable {
    case ac, battery, lowPower

    public static func current() -> PowerMode {
        if ProcessInfo.processInfo.isLowPowerModeEnabled { return .lowPower }
        let snapshot = IOPSCopyPowerSourcesInfo()?.takeRetainedValue()
        let source = snapshot.flatMap { IOPSGetProvidingPowerSourceType($0)?.takeUnretainedValue() as String? }
        return source == kIOPSBatteryPowerValue ? .battery : .ac
    }
}

public struct WakeCoalescer: Sendable {
    public enum StreamClass: Sendable, Equatable, CaseIterable {
        case messaging, agentLogs, notes, browsing, audio, upload, machine, screen, input, photos, biome

        public var fast: Bool {
            switch self {
            case .messaging, .agentLogs, .notes, .browsing, .audio, .machine, .input: true
            case .upload, .screen, .photos, .biome: false
            }
        }
    }

    public struct Window: Sendable, Equatable {
        public let debounce: TimeInterval
        public let maxWait: TimeInterval

        public init(_ debounce: TimeInterval, _ maxWait: TimeInterval) {
            self.debounce = debounce
            self.maxWait = maxWait
        }
    }

    static let classes: [Substring: StreamClass] = [
        "whatsapp": .messaging, "imessage": .messaging, "apple-calls": .messaging, "wispr-flow": .messaging, "aqua-voice": .messaging,
        "claude-code": .agentLogs, "codex": .agentLogs,
        "apple-notes": .notes, "apple-reminders": .notes, "apple-calendar": .notes,
        "chrome": .browsing, "safari": .browsing,
        "audio": .audio, "upload": .upload, "machine": .machine,
        "screen": .screen, "input": .input,
        "apple-photos": .photos,
        "screen-time": .biome, "now-playing": .biome,
    ]

    public static func streamClass(of source: String) -> StreamClass {
        classes[ShippingDomains.product(of: source)] ?? .notes
    }

    public static func window(_ stream: StreamClass, power: PowerMode) -> Window? {
        switch (stream, power) {
        case (.messaging, .ac): Window(1.5, 5)
        case (.messaging, .battery): Window(3, 10)
        case (.messaging, .lowPower): Window(15, 45)
        case (.agentLogs, .ac): Window(2, 6)
        case (.agentLogs, .battery): Window(5, 15)
        case (.agentLogs, .lowPower): Window(30, 60)
        case (.notes, .ac): Window(3, 10)
        case (.notes, .battery): Window(10, 30)
        case (.notes, .lowPower): Window(30, 90)
        case (.browsing, .ac): Window(5, 15)
        case (.browsing, .battery): Window(15, 30)
        case (.browsing, .lowPower): Window(60, 120)
        case (.audio, .ac): Window(2, 2)
        case (.upload, .ac): Window(3.5, 5)
        case (.audio, .battery), (.upload, .battery): Window(5, 5)
        case (.audio, .lowPower), (.upload, .lowPower): Window(30, 30)
        case (.machine, .ac): Window(15, 15)
        case (.machine, .battery): Window(30, 30)
        case (.machine, .lowPower): Window(60, 60)
        case (.screen, .ac), (.screen, .battery): Window(0, 0)
        case (.screen, .lowPower): Window(120, 120)
        case (.input, .ac): Window(0, 0)
        case (.input, .battery): Window(60, 120)
        case (.input, .lowPower): Window(120, 120)
        case (.photos, .ac): Window(5, 15)
        case (.photos, .battery): Window(15, 30)
        case (.photos, .lowPower): Window(60, 60)
        case (.biome, _): nil
        }
    }

    public static func sweepInterval(_ power: PowerMode) -> TimeInterval {
        power == .ac ? 15 * 60 : 30 * 60
    }

    private struct Dirty: Sendable, Equatable {
        let first: Date
        var last: Date
    }

    private var dirty: [String: Dirty] = [:]

    public init() {}

    public var isEmpty: Bool { dirty.isEmpty }

    public mutating func note(_ source: String, at now: Date) {
        guard Self.window(Self.streamClass(of: source), power: .ac) != nil else { return }
        if var known = dirty[source] {
            known.last = max(known.last, now)
            dirty[source] = known
        } else {
            dirty[source] = Dirty(first: now, last: now)
        }
    }

    public mutating func note(_ sources: Set<String>, at now: Date) {
        for source in sources { note(source, at: now) }
    }

    public func deadline(of source: String, power: PowerMode) -> Date? {
        guard let known = dirty[source], let window = Self.window(Self.streamClass(of: source), power: power) else { return nil }
        return min(known.last.addingTimeInterval(window.debounce), known.first.addingTimeInterval(window.maxWait))
    }

    public func nextDeadline(power: PowerMode) -> Date? {
        dirty.keys.compactMap { deadline(of: $0, power: power) }.min()
    }

    public mutating func takeDue(at now: Date, power: PowerMode) -> Set<String> {
        let due = Set(dirty.keys.filter { source in deadline(of: source, power: power).map { $0 <= now } ?? false })
        for source in due { dirty[source] = nil }
        return due
    }

    public mutating func requeue(_ sources: Set<String>, at now: Date) {
        note(sources, at: now)
    }

    public mutating func clear(_ sources: Set<String>, heardBy started: Date) {
        for source in sources where dirty[source].map({ $0.last <= started }) ?? false { dirty[source] = nil }
    }

    public func dirtySources() -> Set<String> { Set(dirty.keys) }

    public func dirtyFastSources() -> Set<String> {
        Set(dirty.keys.filter { Self.streamClass(of: $0).fast })
    }
}
