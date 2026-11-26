import Foundation

public struct Device: Sendable, Equatable {
    public var pastMoves: Bool
    public var iCloud: Bool
    public var charging: Bool
    public var spare: Int64
    public var changeRoom: Int64?
    public var page: Int

    public init(pastMoves: Bool, iCloud: Bool, charging: Bool, spare: Int64, changeRoom: Int64? = .max, page: Int = 1_000) {
        self.pastMoves = pastMoves; self.iCloud = iCloud; self.charging = charging; self.spare = spare
        self.changeRoom = changeRoom; self.page = page
    }
}

public enum Due: Sendable, Equatable {
    case fetch(network: Bool, bytes: Int64)
    case waits(Wait)

    public enum Wait: String, Sendable, Equatable {
        case space, network
    }
}

extension PhotoLibrary {
    public static let bundleBytes: Int64 = 256 << 20

    public static func due(device: Device, bringingIn: Bool) -> Due {
        guard device.spare > 0 else { return .waits(.space) }
        guard device.pastMoves else { return .waits(.network) }
        return .fetch(network: device.iCloud && (device.charging || bringingIn), bytes: min(device.spare, bundleBytes))
    }
}
