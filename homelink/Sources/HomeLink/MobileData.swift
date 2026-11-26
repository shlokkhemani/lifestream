import Foundation

public enum MobileData {
    public static let largeBytes: Int64 = 50_000_000

    static func key(of unit: String) -> String { "devices.\(unit).mobile_data" }

    public enum Choice: String, Codable, CaseIterable, Sendable { case now, everything, small }

    public enum Path: Sendable, Equatable, CaseIterable {
        case free, costly, lowData

        init(expensive: Bool, constrained: Bool) {
            self = constrained ? .lowData : expensive ? .costly : .free
        }
    }

    public enum Allows: String, Codable, Sendable, CaseIterable {
        case all, now, small, lowData = "low-data"

        init(_ path: Path, _ choice: Choice) {
            switch (path, choice) {
            case (.free, _): self = .all
            case (.lowData, _): self = .lowData
            case (.costly, .everything): self = .all
            case (.costly, .now): self = .now
            case (.costly, .small): self = .small
            }
        }

        func wait(_ kind: WriteKind, bytes: Int64) -> Wait? {
            let large = bytes >= MobileData.largeBytes
            switch self {
            case .all: return nil
            case .now: return kind == .later ? .past : nil
            case .small: return kind == .later ? .past : large ? .large : nil
            case .lowData: return kind == .later || large ? .lowData : nil
            }
        }
    }

    public struct Moment: Sendable, Equatable {
        let path: Path
        let choice: Choice
        let loopback: Bool
        let pressed: Bool

        public init(path: Path, choice: Choice, loopback: Bool, pressed: Bool) {
            self.path = path
            self.choice = choice
            self.loopback = loopback
            self.pressed = pressed
        }

        public var stated: Allows { Allows(path, choice) }

        public var internet: Moment { Moment(path: path, choice: choice, loopback: false, pressed: pressed) }

        public func decide(_ kind: WriteKind, bytes: Int64) -> Decision {
            if let wait = wait(on: path, kind, bytes) { return .waits(wait) }
            return .moves(Crossing(costly: wait(on: .costly, kind, bytes) == nil, lowData: wait(on: .lowData, kind, bytes) == nil))
        }

        private func wait(on path: Path, _ kind: WriteKind, _ bytes: Int64) -> Wait? {
            guard !loopback, !pressed else { return nil }
            return Allows(path, choice).wait(kind, bytes: bytes)
        }
    }

    public enum Decision: Sendable, Equatable {
        case moves(Crossing), waits(Wait)

        public var moves: Bool {
            if case .moves = self { return true }
            return false
        }
    }

    public struct Crossing: Sendable, Equatable {
        public static let any = Crossing(costly: true, lowData: true)

        public let costly: Bool
        public let lowData: Bool

        public init(costly: Bool, lowData: Bool) {
            self.costly = costly
            self.lowData = lowData
        }
    }

    public enum Wait: String, Sendable, CaseIterable {
        case past, large, lowData = "low-data"

        public var words: String {
            switch self {
            case .past: return "Older photos and history wait for Wi-Fi · Settings › Mobile data"
            case .large: return "Large sends wait for Wi-Fi · Settings › Mobile data"
            case .lowData: return "Large sends wait: Low Data Mode is on"
            }
        }
    }
}
