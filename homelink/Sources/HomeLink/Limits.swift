import Foundation


public enum WriteKind: String, Sendable, Codable, CaseIterable {
    case new, later
}

public enum Room: String, Sendable, Codable, Equatable {
    case ok, low, full

    public static let keepBytes: Int64 = 5_000_000_000
    public static let bottomBytes: Int64 = 1_000_000_000

    public init(free: Int64?) {
        guard let free else { self = .low; return }
        self = free < Self.bottomBytes ? .full : free < Self.keepBytes ? .low : .ok
    }

    public static func fits(_ kind: WriteKind, bytes: Int64, free: Int64?) -> Bool {
        guard let free else { return kind == .new }
        return free - bytes >= (kind == .new ? bottomBytes : keepBytes)
    }

    public static func toFree(_ kind: WriteKind, bytes: Int64, free: Int64?) -> Int64 {
        guard !fits(kind, bytes: bytes, free: free) else { return 0 }
        return bytes + (kind == .new ? bottomBytes : keepBytes) - (free ?? 0)
    }

    public static func spare(free: Int64?) -> Int64 {
        max(0, (free ?? 0) - keepBytes)
    }

    public static func free(at url: URL) -> Int64? {
        var url = url
        url.removeAllCachedResourceValues()
        return try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage
    }
}

public final class Volume: @unchecked Sendable {
    private let url: URL
    private let every: TimeInterval
    private let read: @Sendable (URL) -> Int64?
    private let clock: @Sendable () -> Date
    private let lock = NSLock()
    private var reading: (free: Int64?, at: Date)?
    private var level: Room?
    private var observer: (@Sendable (Room) -> Void)?

    public init(_ url: URL, every: TimeInterval = 60, read: @escaping @Sendable (URL) -> Int64? = { Room.free(at: $0) },
                clock: @escaping @Sendable () -> Date = { Date() }) {
        self.url = url
        self.every = every
        self.read = read
        self.clock = clock
    }

    public var room: Room { Room(free: free(fresh: false)) }

    public var spare: Int64 { Room.spare(free: free(fresh: true)) }

    public func fits(_ kind: WriteKind, bytes: Int64 = 0) -> Bool {
        Room.fits(kind, bytes: bytes, free: free(fresh: bytes > 0))
    }

    public func toFree(_ kind: WriteKind, bytes: Int64) -> Int64 {
        Room.toFree(kind, bytes: bytes, free: free(fresh: bytes > 0))
    }

    public func observe(_ changed: @escaping @Sendable (Room) -> Void) {
        lock.withLock { observer = changed }
    }

    private func free(fresh: Bool) -> Int64? {
        let now = clock()
        var changed: (Room, @Sendable (Room) -> Void)?
        let free = lock.withLock { () -> Int64? in
            if !fresh, let reading, now.timeIntervalSince(reading.at) < every, now >= reading.at { return reading.free }
            let free = read(url)
            reading = (free, now)
            let room = Room(free: free)
            if room != level {
                level = room
                if let observer { changed = (room, observer) }
            }
            return free
        }
        if let changed { changed.1(changed.0) }
        return free
    }
}

public enum NetworkCost: String, Sendable, Codable, Equatable {
    case free, metered

    public init(_ facts: NetworkFacts) {
        self = facts.metered == nil ? .free : .metered
    }
}

public enum Transfer {
    public static let largeBytes = MobileData.largeBytes

    public static func mayMove(_ kind: WriteKind, bytes: Int64, pressed: Bool, metered: Bool) -> Bool {
        !metered || pressed || (kind == .new && bytes < largeBytes)
    }
}

public struct Relay: Sendable, Equatable {
    public static let wait: TimeInterval = 30

    public let again: Bool
    public let wait: TimeInterval

    public init(again: Bool, wait: TimeInterval = Relay.wait) {
        self.again = again
        self.wait = wait
    }
}

public final class Budget: @unchecked Sendable {
    public static let whole: TimeInterval = 15
    public static let each: TimeInterval = 10
    public static let least: TimeInterval = 3
    public static let sends = 2

    public let relay: Relay
    public let deadline: Date
    private let lock = NSLock()
    private var sent = 0
    private var kept: (response: HomeResponse, began: Bool)?

    public init(_ relay: Relay, now: Date) {
        self.relay = relay
        deadline = now.addingTimeInterval(relay.again ? Self.whole : relay.wait)
    }

    public func left(_ now: Date) -> TimeInterval {
        max(0, deadline.timeIntervalSince(now))
    }

    public func send(_ now: Date) -> TimeInterval? {
        lock.withLock {
            guard sent < sends, let wait = wait(now) else { return nil }
            sent += 1
            return wait
        }
    }

    func hasSend(_ now: Date) -> Bool {
        lock.withLock { sent < sends && wait(now) != nil }
    }

    private var sends: Int {
        relay.again ? Self.sends : 1
    }

    func wait(_ now: Date) -> TimeInterval? {
        let left = left(now)
        guard left >= Self.least else { return nil }
        return relay.again ? min(Self.each, left) : relay.wait
    }

    func sending(_ now: () -> Date, _ once: () async throws -> HomeResponse) async throws -> HomeResponse {
        var heard: HomeResponse?
        var lost = false
        while heard.map(HomeLink.sendAgain) ?? true, send(now()) != nil {
            do {
                let response = try await once()
                keep(response)
                heard = response
            } catch LinkFailure.noAnswer(let sent) {
                lost = lost || sent
            }
        }
        return try lock.withLock {
            guard let response = heard ?? kept?.response else { throw LinkFailure.noAnswer(sent: lost) }
            guard HomeLink.unanswered(response) != nil || HomeLink.refusedNotNow(response), let kept, kept.began else { return response }
            return kept.response
        }
    }

    private func keep(_ response: HomeResponse) {
        guard let said = HomeLink.unanswered(response) else { return }
        lock.withLock {
            guard kept?.began != true else { return }
            kept = (response, said.began)
        }
    }
}
