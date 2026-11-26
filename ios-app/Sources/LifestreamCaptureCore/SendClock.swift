import Foundation

public struct SendClock: Sendable, Equatable {
    public static let MOVING_S: TimeInterval = 300
    public static let SETTLED_S: TimeInterval = 1800
    public static let POWER_S: TimeInterval = 60
    public static let LOW_POWER_MOVING_S: TimeInterval = 900
    public static let LOW_POWER_SETTLED_S: TimeInterval = 3600
    public static let FLOOR_S: TimeInterval = 30
    public static let BACKOFF_FIRST_S: TimeInterval = 60
    public static let BACKOFF_LAST_S: TimeInterval = 1800

    public enum Event: Sendable, Equatable {
        case visit, exit, moving, settled
        case power(Bool)
        case background
        case foreground
        case lowPower(Bool)
        case network
        case saved, shared, read
        case owed
        case fix, entry
    }

    public enum Cause: Sendable, Equatable {
        case event(Event), ask, fix, entry, held

        public var name: String? {
            switch self {
            case .ask: nil
            case .fix: "fix"
            case .entry: "entry"
            case .held: "held"
            case .event(let event):
                switch event {
                case .visit: "visit"
                case .exit: "exit"
                case .moving: "moving"
                case .settled: "settled"
                case .power: "power"
                case .background: "background"
                case .network: "network"
                case .saved: "saved"
                case .shared: "shared"
                case .read: "read"
                case .foreground, .lowPower, .owed, .fix, .entry: nil
                }
            }
        }
    }

    public static let own: [CaptureDomain: Set<String>] = [.location: ["lifecycle"], .energy: ["parts"]]

    public static func work(_ domain: CaptureDomain, kind: String) -> Event? {
        if own[domain]?.contains(kind) == true { return nil }
        let event: Event = switch domain {
        case .location where kind == "fix": .fix
        case .checkin, .notes: .saved
        case .upload: .shared
        case .photos, .contacts: .read
        default: .entry
        }
        return event
    }

    private var moving: Bool?
    public private(set) var onPower = false
    private var onScreen = false
    private var lowPower = false
    private var oldestFix: Date?
    private var oldestOther: Date?
    private var heldUntil: Date?
    private var waitsForNetwork = false
    private var firstEvent: Told?
    private struct Told: Sendable, Equatable {
        let at: Date
        let event: Event
    }
    private var asked: Date?
    private var lastStart: Date?
    private var failures = 0
    private var failedAt: Date?
    private var notBefore: Date?
    private var homeSaid = false
    private var eventTried = false

    public init() {}

    public mutating func note(_ event: Event, at time: Date) {
        observe(time)
        switch event {
        case .fix: oldestFix = Self.earliest(oldestFix, time)
        case .entry: oldestOther = Self.earliest(oldestOther, time)
        case .foreground: onScreen = true
        case .lowPower(let on): lowPower = on
        case .network:
            failures = 0
            eventTried = false
            if oldestFix != nil || oldestOther != nil || waitsForNetwork { due(event, at: time) }
        case .background:
            onScreen = false
            due(event, at: time)
        case .power(let on):
            onPower = on
            due(event, at: time)
        case .moving:
            moving = true
            due(event, at: time)
        case .settled:
            moving = false
            due(event, at: time)
        case .owed: asked = Self.earliest(asked, time)
        case .visit, .exit, .saved, .shared, .read: due(event, at: time)
        }
    }

    public mutating func withdraw() {
        asked = nil
    }

    public mutating func remaining(oldestFix fix: Date?, oldestOther other: Date?, heldUntil held: Date? = nil,
                                   waitsForNetwork network: Bool = false) {
        oldestFix = Self.earliest(oldestFix, fix)
        oldestOther = Self.earliest(oldestOther, other)
        heldUntil = Self.earliest(heldUntil, held)
        waitsForNetwork = waitsForNetwork || network
    }

    public mutating func started(at start: Date) {
        observe(start)
        if failures > 0, firstEvent != nil || asked != nil { eventTried = true }
        lastStart = start
        firstEvent = nil
        asked = nil
        oldestFix = nil
        oldestOther = nil
        heldUntil = nil
        waitsForNetwork = false
    }

    public mutating func answered(_ answered: Bool, at end: Date, notBefore deadline: Date? = nil) {
        observe(end)
        if answered {
            failures = 0
            failedAt = nil
            eventTried = false
            notBefore = nil
            homeSaid = false
        } else {
            failures += 1
            failedAt = end
            homeSaid = deadline != nil
            if let deadline { notBefore = Self.latest(deadline, notBefore) }
        }
    }

    private mutating func observe(_ time: Date) {
        func lowered(_ instant: Date?) -> Date? { instant.map { min($0, time) } }
        lastStart = lowered(lastStart)
        failedAt = lowered(failedAt)
        asked = lowered(asked)
        oldestFix = lowered(oldestFix)
        oldestOther = lowered(oldestOther)
        if let told = firstEvent, told.at > time { firstEvent = Told(at: time, event: told.event) }
    }

    public var next: Date? { due?.at }

    public var cause: Cause? { due?.cause }

    private var due: (at: Date, cause: Cause)? {
        let fix = oldestFix.map { (at: $0.addingTimeInterval(fixInterval), cause: Cause.fix) }
        let other = oldestOther.map { (at: $0.addingTimeInterval(otherInterval), cause: Cause.entry) }
        let held = heldUntil.map { (at: $0, cause: Cause.held) }
        let backoff = failures > (homeSaid ? 1 : 0) ? failedAt?.addingTimeInterval(Self.backoff(failures)) : nil
        var due = [fix, other, held].compactMap { $0 }.min { $0.at < $1.at }.map { (at: Self.latest($0.at, backoff), cause: $0.cause) }
        let event = firstEvent.map { (at: $0.at, cause: Cause.event($0.event)) }
        let ask = asked.map { (at: $0, cause: Cause.ask) }
        if let first = [event, ask].compactMap({ $0 }).min(by: { $0.at < $1.at }) {
            let at = failures == 0 || !eventTried ? first.at : Self.latest(first.at, backoff)
            if due.map({ at <= $0.at }) ?? true { due = (at: at, cause: first.cause) }
        }
        return due.map { (at: Self.latest(Self.latest($0.at, notBefore), floor), cause: $0.cause) }
    }

    public var floor: Date? { lastStart?.addingTimeInterval(Self.FLOOR_S) }

    private mutating func due(_ event: Event, at time: Date) {
        if firstEvent.map({ time < $0.at }) ?? true { firstEvent = Told(at: time, event: event) }
    }

    private var fixInterval: TimeInterval {
        guard moving != false else { return otherInterval }
        if onPower || onScreen { return Self.POWER_S }
        return lowPower ? Self.LOW_POWER_MOVING_S : Self.MOVING_S
    }

    private var otherInterval: TimeInterval {
        lowPower && !onPower && !onScreen ? Self.LOW_POWER_SETTLED_S : Self.SETTLED_S
    }

    private static func backoff(_ failures: Int) -> TimeInterval {
        min(BACKOFF_FIRST_S * pow(2, Double(failures - 1)), BACKOFF_LAST_S)
    }

    private static func earliest(_ a: Date?, _ b: Date?) -> Date? {
        guard let a else { return b }
        guard let b else { return a }
        return min(a, b)
    }

    private static func latest(_ a: Date, _ b: Date?) -> Date { b.map { max(a, $0) } ?? a }
}
