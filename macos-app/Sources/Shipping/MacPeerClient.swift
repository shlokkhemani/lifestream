import Foundation
import HomeLink

public protocol PeerLink: Sendable {
    func macExchange(_ request: HomeLink.MacExchangeRequest, timeout: TimeInterval) async throws -> HomeLink.MacExchangeAnswer
}

extension HomeLink: PeerLink {}

public actor MacPeerClient {
    public struct Handlers: Sendable {
        public let sources: @Sendable () async -> [String]
        public let onRefresh: @Sendable (String) async -> Void
        public let onSettings: @Sendable () async -> Void
        public let onFlush: @Sendable ([String]?, Int) async -> [String: Int]

        public init(sources: @escaping @Sendable () async -> [String],
                    onRefresh: @escaping @Sendable (String) async -> Void,
                    onSettings: @escaping @Sendable () async -> Void,
                    onFlush: @escaping @Sendable ([String]?, Int) async -> [String: Int]) {
            self.sources = sources
            self.onRefresh = onRefresh
            self.onSettings = onSettings
            self.onFlush = onFlush
        }
    }

    public static let firstWait: TimeInterval = 1
    public static let longestWait: TimeInterval = 30
    public static let goodbye: TimeInterval = 2
    public static let quickest: TimeInterval = 1
    public static let superseded = "SUPERSEDED"
    static let remembered = 256

    public let boot: String
    private let link: any PeerLink
    private let handlers: Handlers
    private let clock: @Sendable () -> Date
    private let pause: @Sendable (TimeInterval) async -> Void
    private var loop: Task<Void, Never>?
    private var poll: Task<HomeLink.MacExchangeAnswer, Error>?
    private var resting: Task<Void, Never>?
    private var parting: Task<Void, Never>?
    private var running: Set<String> = []
    private var handled: [String] = []
    private var results: [HomeLink.MacCommandResult] = []
    private var failures = 0
    private var sleeping = false
    private var wanted = false
    public private(set) var ended = false

    public init(link: any PeerLink, handlers: Handlers, boot: String = UUID().uuidString.lowercased(),
                clock: @escaping @Sendable () -> Date = { Date() },
                pause: @escaping @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(for: .seconds($0)) }) {
        self.link = link
        self.handlers = handlers
        self.boot = boot
        self.clock = clock
        self.pause = pause
    }

    public var dialing: Bool { loop != nil }

    public func start() {
        wanted = true
        guard loop == nil, !ended, !sleeping else { return }
        loop = Task { [weak self] in await self?.dial() }
    }

    public func stop() {
        wanted = false
        hangUp()
    }

    public func nudge() {
        resting?.cancel()
        if wanted { start() }
    }

    private func hangUp() {
        loop?.cancel()
        loop = nil
        poll?.cancel()
        resting?.cancel()
        parting?.cancel()
        parting = nil
    }

    public func willSleep() async {
        guard wanted, !ended else { return }
        sleeping = true
        hangUp()
        let parting = Task { [weak self] in
            guard let self else { return }
            await self.sayGoodbye()
        }
        self.parting = parting
        await parting.value
        if self.parting == parting { self.parting = nil }
    }

    private func sayGoodbye() async {
        let sources = await handlers.sources()
        guard sleeping, !ended, !Task.isCancelled else { return }
        let request = HomeLink.MacExchangeRequest(boot: boot, sources: sources, running: running.sorted(), results: results, sleep: true)
        if (try? await link.macExchange(request, timeout: Self.goodbye)) != nil {
            delivered(request.results)
        }
    }

    public func didWake() {
        parting?.cancel()
        parting = nil
        sleeping = false
        failures = 0
        nudge()
    }

    private func dial() async {
        defer { if !Task.isCancelled { loop = nil } }
        while !Task.isCancelled, !ended, !sleeping {
            let sources = await handlers.sources()
            guard !sleeping, !ended, !Task.isCancelled else { return }
            let request = HomeLink.MacExchangeRequest(boot: boot, sources: sources, running: running.sorted(), results: results)
            let began = clock()
            let exchange = Task { [link] in try await link.macExchange(request, timeout: HomeLink.macPoll) }
            poll = exchange
            do {
                let answer = try await exchange.value
                if poll == exchange { poll = nil }
                failures = 0
                delivered(request.results)
                for call in answer.calls { dispatch(call) }
                if answer.calls.isEmpty, results.isEmpty, clock().timeIntervalSince(began) < Self.quickest {
                    await rest(Self.quickest)
                }
            } catch {
                if poll == exchange { poll = nil }
                if Task.isCancelled || sleeping { return }
                if error is CancellationError { continue }
                if case LinkFailure.refused(409, Self.superseded, _) = error {
                    ended = true
                    return
                }
                if case LinkFailure.refused(400, _, _) = error { delivered(request.results) }
                failures += 1
                await rest(Self.wait(after: failures, for: error))
            }
        }
    }

    private func rest(_ seconds: TimeInterval) async {
        let pause = pause
        let resting = Task { await pause(seconds) }
        self.resting = resting
        await resting.value
        if self.resting == resting { self.resting = nil }
    }

    static func wait(after failures: Int, for error: Error) -> TimeInterval {
        switch error as? LinkFailure {
        case .unpaired?, .homeTooOld?, .tooOld?, .refused?:
            return longestWait
        case .unavailable(_, _, let retryAfter?, _)?, .busy(let retryAfter?)?:
            return min(longestWait, max(firstWait, retryAfter))
        default:
            return min(longestWait, firstWait * pow(2, Double(max(0, failures - 1))))
        }
    }

    private func delivered(_ sent: [HomeLink.MacCommandResult]) {
        let ids = Set(sent.map(\.id))
        results.removeAll { ids.contains($0.id) }
    }

    private func dispatch(_ call: HomeLink.MacCommand) {
        guard !running.contains(call.id), !handled.contains(call.id) else { return }
        running.insert(call.id)
        let handlers = handlers
        Task { [weak self] in
            let result = await Self.perform(call, handlers)
            await self?.finished(result)
        }
    }

    private func finished(_ result: HomeLink.MacCommandResult) {
        running.remove(result.id)
        handled.append(result.id)
        if handled.count > Self.remembered { handled.removeFirst(handled.count - Self.remembered) }
        results.append(result)
        poll?.cancel()
        resting?.cancel()
    }

    static func perform(_ call: HomeLink.MacCommand, _ handlers: Handlers) async -> HomeLink.MacCommandResult {
        switch call {
        case .refresh(let id, let connector):
            await handlers.onRefresh(connector)
            return .done(id)
        case .settings(let id):
            await handlers.onSettings()
            return .done(id)
        case .flush(let id, let sources, let budgetMs):
            let seals = await handlers.onFlush(sources, budgetMs)
            return .done(id, seals: seals.isEmpty ? nil : seals)
        case .unknown(let id, let kind):
            return .failed(id, code: HomeLink.MacCommandResult.unknownCommand, message: "this Mac does not know the call \"\(kind)\"")
        }
    }
}
