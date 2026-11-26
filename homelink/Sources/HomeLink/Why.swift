import Foundation
import Network


public struct NetworkFacts: Sendable, Equatable {
    public let online: Bool
    public let onLocalNetwork: Bool
    public let tunnelUp: Bool
    public let path: Int
    public let cost: MobileData.Path

    public init(online: Bool, onLocalNetwork: Bool, tunnelUp: Bool, path: Int = 0, cost: MobileData.Path = .free) {
        self.online = online
        self.onLocalNetwork = onLocalNetwork
        self.tunnelUp = tunnelUp
        self.path = path
        self.cost = cost
    }

    public func changesRoad(from before: NetworkFacts) -> Bool {
        online && (before.online != online || before.onLocalNetwork != onLocalNetwork || before.tunnelUp != tunnelUp)
    }

    static func tunnelUp() -> Bool {
        var first: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&first) == 0 else { return true }
        defer { freeifaddrs(first) }
        var entry = first
        while let current = entry {
            defer { entry = current.pointee.ifa_next }
            let item = current.pointee
            guard let address = item.ifa_addr, item.ifa_flags & UInt32(IFF_UP) != 0,
                  strncmp(item.ifa_name, "utun", 4) == 0 else { continue }
            switch Int32(address.pointee.sa_family) {
            case AF_INET:
                let ipv4 = address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr.s_addr }
                if isTailscale(ipv4: withUnsafeBytes(of: ipv4) { Array($0) }) { return true }
            case AF_INET6:
                let ipv6 = address.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { $0.pointee.sin6_addr }
                if isTailscale(ipv6: withUnsafeBytes(of: ipv6) { Array($0) }) { return true }
            default:
                continue
            }
        }
        return false
    }

    static func isTailscale(ipv4 bytes: [UInt8]) -> Bool {
        bytes.count == 4 && bytes[0] == 100 && bytes[1] & 0xC0 == 64
    }

    static func isTailscale(ipv6 bytes: [UInt8]) -> Bool {
        bytes.count == 16 && Array(bytes.prefix(6)) == [0xFD, 0x7A, 0x11, 0x5C, 0xA1, 0xE0]
    }
}

public protocol NetworkWatch: Sendable {
    var facts: NetworkFacts? { get }
    func changes() -> AsyncStream<NetworkFacts>
}

public final class SystemNetwork: NetworkWatch, @unchecked Sendable {
    public static let shared = SystemNetwork()

    private let lock = NSLock()
    private var monitor: NWPathMonitor?
    private var latest: (online: Bool, local: Bool, cost: MobileData.Path, path: Int)?
    private var readers: [UUID: AsyncStream<NetworkFacts>.Continuation] = [:]

    private init() {}

    public var facts: NetworkFacts? {
        lock.withLock { now() }
    }

    public func changes() -> AsyncStream<NetworkFacts> {
        AsyncStream { continuation in
            self.lock.withLock {
                self.readers[UUID()] = continuation
                if let facts = self.now() { continuation.yield(facts) }
            }
        }
    }

    private func now() -> NetworkFacts? {
        if monitor == nil {
            let monitor = NWPathMonitor()
            monitor.pathUpdateHandler = { [weak self] path in self?.update(path) }
            monitor.start(queue: DispatchQueue(label: "org.lifestreamprotocol.homelink.network"))
            self.monitor = monitor
        }
        return latest.map {
            NetworkFacts(online: $0.online, onLocalNetwork: $0.local, tunnelUp: NetworkFacts.tunnelUp(), path: $0.path,
                         cost: $0.cost)
        }
    }

    private func update(_ path: NWPath) {
        lock.withLock {
            latest = (path.status == .satisfied, path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet),
                      MobileData.Path(expensive: path.isExpensive, constrained: path.isConstrained), (latest?.path ?? 0) + 1)
            guard let facts = now() else { return }
            for (id, reader) in readers {
                if case .terminated = reader.yield(facts) { readers[id] = nil }
            }
        }
    }
}

extension HomeLink {
    public static func listsTailscale(_ addresses: [URL]) -> Bool {
        addresses.contains { $0.host.map(isPrivate(host:)) ?? false }
    }
}
