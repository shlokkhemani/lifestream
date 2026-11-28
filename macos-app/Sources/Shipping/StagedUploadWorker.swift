import Foundation
import HomeLink

public protocol StagingLink: Sendable {
    func holding(_ blobs: Set<String>) async throws -> HomeLink.Holding
    func stage(file: HomeLink.File, source: String, from offset: Int64, kind: WriteKind, pressed: Bool,
               sent: (@Sendable (Int64) -> Void)?) async throws
    func mobileChanges() -> AsyncStream<Void>
}

extension HomeLink: StagingLink {}

public actor StagedUploadWorker {
    public static let thresholdBytes: Int64 = 256 * 1024
    public static let uploads = 2
    public static let firstWait: TimeInterval = 2
    public static let longestWait: TimeInterval = 5 * 60

    public struct Key: Hashable, Sendable {
        public let source: String
        public let sha256: String

        public init(source: String, sha256: String) {
            self.source = source
            self.sha256 = sha256.lowercased()
        }

        public var name: String { "sha256:" + sha256 }
    }

    struct Item: Sendable, Equatable {
        let key: Key
        let url: URL
        let bytes: Int64
        let kept: Bool
        let kind: WriteKind
        var pressed: Bool

        var file: HomeLink.File { HomeLink.File(name: key.name, url: url, bytes: bytes, kept: kept) }
    }

    enum Outcome: Equatable {
        case ready
        case parked
        case rest(TimeInterval?)
        case dropped
        case cancelled
    }

    private let link: any StagingLink
    private let uploads: Int
    private let pause: @Sendable (TimeInterval) async -> Void
    private let board = Board()
    private var running: [Key: Task<Void, Never>] = [:]
    private var parked: Set<Key> = []
    private var resting: [Key: Task<Void, Never>] = [:]
    private var tries: [Key: Int] = [:]
    private var watching: Task<Void, Never>?
    private var stopped = false
    private var pass: String?
    private var generation = 0
    private(set) var outlived = 0

    public init(link: any StagingLink, uploads: Int = StagedUploadWorker.uploads,
                pause: @escaping @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(for: .seconds($0)) }) {
        self.link = link
        self.uploads = max(1, uploads)
        self.pause = pause
    }

    var parkedCount: Int { parked.count }

    public nonisolated func onReady(_ ready: @escaping @Sendable (String) -> Void) {
        board.onReady(ready)
    }

    public nonisolated func isReady(source: String, sha256: String) -> Bool {
        board.isReady(Key(source: source, sha256: sha256))
    }

    public nonisolated func isPending(source: String, sha256: String) -> Bool {
        board.isPending(Key(source: source, sha256: sha256))
    }

    public nonisolated func enqueue(source: String, sha256: String, url: URL, bytes: Int64, kept: Bool, kind: WriteKind,
                                    pressed: Bool = false) {
        let item = Item(key: Key(source: source, sha256: sha256), url: url, bytes: bytes, kept: kept, kind: kind, pressed: pressed)
        guard board.admit(item) else { return }
        Task { await self.admitted(item.key, pressed: pressed) }
    }

    public func add(source: String, sha256: String, url: URL, bytes: Int64, kept: Bool, kind: WriteKind, pressed: Bool = false) {
        let item = Item(key: Key(source: source, sha256: sha256), url: url, bytes: bytes, kept: kept, kind: kind, pressed: pressed)
        guard board.admit(item) else { return }
        admitted(item.key, pressed: pressed)
    }

    public func start() {
        stopped = false
        if watching == nil {
            let changes = link.mobileChanges()
            watching = Task { [weak self] in
                for await _ in changes {
                    guard let self else { return }
                    await self.unpark()
                }
            }
        }
        pump()
    }

    public func stop() {
        stopped = true
        watching?.cancel()
        watching = nil
        for task in running.values { task.cancel() }
        for task in resting.values { task.cancel() }
        resting = [:]
    }

    @discardableResult
    public nonisolated func invalidate(source: String, sha256s: Set<String>) -> Bool {
        let keys = sha256s.map { Key(source: source, sha256: $0) }
        board.unready(keys)
        var staging = !keys.isEmpty
        for key in keys where !board.isPending(key) {
            guard let item = board.remembered(key), FileManager.default.fileExists(atPath: item.url.path) else {
                staging = false
                continue
            }
            _ = board.admit(item)
        }
        Task { await self.pump() }
        return staging
    }

    public func markConsumed(source: String, sha256s: Set<String>) {
        board.forget(sha256s.map { Key(source: source, sha256: $0) })
    }

    public func reset(pass: String) {
        defer { self.pass = pass }
        guard let was = self.pass, was != pass else { return }
        generation += 1
        for task in running.values { task.cancel() }
        running = [:]
        board.forgetSettled()
        parked.removeAll()
        for task in resting.values { task.cancel() }
        resting = [:]
        tries = [:]
        pump()
    }

    private func admitted(_ key: Key, pressed: Bool) {
        if pressed {
            parked.remove(key)
            resting.removeValue(forKey: key)?.cancel()
        }
        pump()
    }

    private func unpark() {
        parked.removeAll()
        pump()
    }

    private func pump() {
        guard !stopped else { return }
        while running.count < uploads {
            let busy = Set(running.keys).union(parked).union(resting.keys)
            guard let item = board.next(skipping: busy) else { return }
            let link = link
            let generation = generation
            running[item.key] = Task { [weak self] in
                let outcome = await Self.upload(item, through: link)
                await self?.ended(item, outcome, generation: generation)
            }
        }
    }

    private func ended(_ item: Item, _ outcome: Outcome, generation: Int) {
        guard generation == self.generation else {
            outlived += 1
            return
        }
        let key = item.key
        running[key] = nil
        switch outcome {
        case .ready:
            tries[key] = nil
            board.finish(key, ready: true)
            board.ready(key.source)
        case .parked:
            parked.insert(key)
        case .rest(let after):
            let count = tries[key, default: 0] + 1
            tries[key] = count
            let wait = max(after ?? 0, Self.wait(after: count))
            let pause = pause
            resting[key] = Task { [weak self] in
                await pause(wait)
                guard !Task.isCancelled else { return }
                await self?.rested(key)
            }
        case .dropped:
            tries[key] = nil
            board.finish(key, ready: false)
            board.forget([key])
        case .cancelled:
            break
        }
        pump()
    }

    private func rested(_ key: Key) {
        resting[key] = nil
        pump()
    }

    static func wait(after tries: Int) -> TimeInterval {
        min(longestWait, firstWait * pow(2, Double(max(0, tries - 1))))
    }

    static func upload(_ item: Item, through link: any StagingLink) async -> Outcome {
        guard FileManager.default.fileExists(atPath: item.url.path) else { return .dropped }
        do {
            let name = item.key.name
            let holding = try await link.holding([name])
            if !holding.whole(name) {
                try await link.stage(file: item.file, source: item.key.source, from: holding.partly[name] ?? 0, kind: item.kind,
                                     pressed: item.pressed, sent: nil)
            }
            return .ready
        } catch {
            return outcome(of: error)
        }
    }

    static let refusals: Set<Int> = [400, 401, 403, 404, 413, 422]

    static func outcome(of error: Error) -> Outcome {
        if error is CancellationError || Task.isCancelled { return .cancelled }
        guard let failure = error as? LinkFailure else { return .rest(nil) }
        switch failure {
        case .waits, .unpaired, .credentials, .notTheHome:
            return .parked
        case .busy(let retryAfter):
            return .rest(retryAfter)
        case .unavailable(_, _, let retryAfter, _):
            return .rest(retryAfter)
        case .refused(let status, _, _) where refusals.contains(status):
            return .dropped
        case .unusableID, .tooOld:
            return .dropped
        default:
            return .rest(nil)
        }
    }

    final class Board: @unchecked Sendable {
        private let lock = NSLock()
        private var readySet: Set<Key> = []
        private var pending: [Key: Item] = [:]
        private var order: [Key] = []
        private var known: [Key: Item] = [:]
        private var heard: (@Sendable (String) -> Void)?

        func onReady(_ ready: @escaping @Sendable (String) -> Void) { lock.withLock { heard = ready } }

        func ready(_ source: String) {
            let heard = lock.withLock { self.heard }
            heard?(source)
        }

        func isReady(_ key: Key) -> Bool { lock.withLock { readySet.contains(key) } }

        func isPending(_ key: Key) -> Bool { lock.withLock { pending[key] != nil } }

        func admit(_ item: Item) -> Bool {
            lock.withLock {
                known[item.key] = item
                if readySet.contains(item.key) { return false }
                if pending[item.key] != nil {
                    guard item.pressed else { return false }
                    pending[item.key]?.pressed = true
                    return true
                }
                pending[item.key] = item
                order.append(item.key)
                return true
            }
        }

        func next(skipping busy: Set<Key>) -> Item? {
            lock.withLock { order.first { !busy.contains($0) }.flatMap { pending[$0] } }
        }

        func finish(_ key: Key, ready: Bool) {
            lock.withLock {
                pending[key] = nil
                order.removeAll { $0 == key }
                if ready { readySet.insert(key) }
            }
        }

        func remembered(_ key: Key) -> Item? { lock.withLock { known[key] } }

        func unready(_ keys: [Key]) { lock.withLock { readySet.subtract(keys) } }

        func forget(_ keys: [Key]) {
            lock.withLock {
                readySet.subtract(keys)
                for key in keys where pending[key] == nil { known[key] = nil }
            }
        }

        func forgetSettled() {
            lock.withLock {
                readySet.removeAll()
                known = known.filter { pending[$0.key] != nil }
            }
        }
    }
}
