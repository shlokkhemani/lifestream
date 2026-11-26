import DeviceFiles
import Foundation


extension HomeLink {
    public enum Reach: Sendable, Equatable {
        case answering
        case waiting(since: Date)
        case starting(Starting, since: Date)
        case unreachable(Cause, since: Date)
        case held(Held)
        case needsUpdate(Update)
        case passRefused
        case unpaired

        public var isUnreachable: Bool {
            if case .unreachable = self { true } else { false }
        }
    }

    public enum Cause: Sendable, Equatable {
        case offline, tailscaleOff, wifiOnly
        case notRunning
        case driveAway
        case local(String)
        case silent

        public var isNetwork: Bool {
            switch self {
            case .offline, .tailscaleOff, .wifiOnly: true
            default: false
            }
        }

        public static func of(_ facts: NetworkFacts, homeListsTailscale: Bool) -> Cause? {
            if !facts.online { return .offline }
            if homeListsTailscale, !facts.tunnelUp { return .tailscaleOff }
            if !homeListsTailscale, !facts.onLocalNetwork { return .wifiOnly }
            return nil
        }
    }

    public enum Update: Sendable, Equatable {
        case home
        case device(floor: String)
    }

    public struct ReachSnapshot: Sendable, Equatable {
        public let reach: Reach
        public let lastReached: Date?
        public let revision: Int
        public let episode: Episode?
        public let routes: Routes?
        public let checking: Bool

        public init(reach: Reach, lastReached: Date?, revision: Int, episode: Episode? = nil, routes: Routes? = nil,
                    checking: Bool = false) {
            self.reach = reach
            self.lastReached = lastReached
            self.revision = revision
            self.episode = episode
            self.routes = routes
            self.checking = checking
        }

        public func reached(_ at: Date?) -> ReachSnapshot {
            ReachSnapshot(reach: reach, lastReached: at, revision: revision, episode: episode, routes: routes, checking: checking)
        }
    }

    public struct Episode: Sendable, Equatable {
        public let id: Int
        public let since: Date
        public private(set) var shown: Reach?
        public private(set) var told: Reach?
        public private(set) var ended: Date?

        public init(id: Int, since: Date, shown: Reach? = nil, told: Reach? = nil, ended: Date? = nil) {
            self.id = id
            self.since = since
            self.shown = shown
            self.told = told
            self.ended = ended
        }

        public var showedStrip: Bool { shown != nil }

        public static func next(_ episode: Episode?, after reach: Reach, at: Date, count: inout Int) -> Episode? {
            switch reach {
            case .unpaired:
                return nil
            case .answering:
                guard var episode, episode.ended == nil else { return episode }
                episode.ended = at
                return episode
            default:
                var current: Episode
                if let episode, episode.ended == nil {
                    current = episode
                } else {
                    count += 1
                    current = Episode(id: count, since: at)
                }
                if case .waiting = reach {} else { current.shown = reach }
                switch reach {
                case .unreachable, .held: if current.told == nil { current.told = reach }
                default: break
                }
                return current
            }
        }
    }

    public struct Routes: Sendable, Equatable {
        public let online: Bool?
        public let local: Bool?
        public let tailscale: Bool?
        public let here: Bool

        public init(online: Bool?, local: Bool?, tailscale: Bool?, here: Bool = false) {
            self.online = online
            self.local = local
            self.tailscale = tailscale
            self.here = here
        }

        public static func of(_ addresses: [URL], on facts: NetworkFacts?) -> Routes {
            let hosts = addresses.compactMap(\.host)
            let here = hosts.contains(where: HomeLink.isLoopback(host:))
            let away = hosts.filter { !HomeLink.isLoopback(host: $0) }
            let usable = { (each: (NetworkFacts) -> Bool) in facts.map { $0.online && each($0) } }
            return Routes(online: facts?.online,
                          local: away.contains { !HomeLink.isPrivate(host: $0) } ? usable(\.onLocalNetwork) : nil,
                          tailscale: away.contains(where: HomeLink.isPrivate(host:)) ? usable(\.tunnelUp) : nil,
                          here: here)
        }
    }

    public enum RequestState: Sendable, Equatable {
        case inFlight
        case reach
        case wait(words: String, until: Date)
        case refused(String)
        case saving
        case unknown(String)
        case failed
    }

    public enum ActSaid: Sendable, Equatable {
        case notSent
        case refused(String)
        case saving
        case unknown(String)
    }

    public static let grace: TimeInterval = 20
    public static let probeEvery: TimeInterval = 10
    public static let readyBound: TimeInterval = 180

    public var snapshot: ReachSnapshot {
        reachBox.lock.withLock {
            loadReach()
            return now()
        }
    }

    public func snapshots() -> AsyncStream<ReachSnapshot> {
        let stream = AsyncStream<ReachSnapshot> { continuation in
            reachBox.lock.withLock {
                loadReach()
                reachBox.listeners[UUID()] = continuation
                continuation.yield(now())
            }
        }
        follow()
        return stream
    }

    @discardableResult public func probeSoon() async -> ReachSnapshot {
        if let done = joinProbe() { await done.value }
        return snapshot
    }

    @discardableResult public func checkAgain() async -> ReachSnapshot {
        changing {
            loadReach()
            let before = now()
            reachBox.checks += 1
            notify(from: before)
        }
        if let facts = network?.facts { saw(facts) }
        let done: Task<Void, Never>? = changing {
            if let probe = reachBox.probe, probe.task != nil { return probe.done }
            soon(at: clock(), now: true)
            return reachBox.probe?.done
        }
        await done?.value
        changing {
            let before = now()
            reachBox.checks -= 1
            notify(from: before)
        }
        follow()
        return snapshot
    }

    public func probe(_ ask: @escaping @Sendable (HomeLink) async throws -> Void, explain: (@Sendable () -> Cause?)? = nil) {
        reachBox.lock.withLock {
            reachBox.ask = ask
            reachBox.explain = explain
        }
    }

    public func inFront(_ front: Bool) {
        let stopped: Task<Void, Never>? = changing {
            loadReach()
            guard reachBox.front != front else { return nil }
            reachBox.front = front
            if front {
                if !answering { soon(at: clock(), now: false) }
                return nil
            }
            reachBox.trip = tick()
            defer { reachBox.following = nil }
            return reachBox.following
        }
        stopped?.cancel()
        if front { follow() }
    }

    public func restarting(_ body: @Sendable () async throws -> Void) async rethrows {
        let (id, start): (Int, Date) = reachBox.lock.withLock {
            reachBox.marks += 1
            let mark = ReachBox.Mark(id: reachBox.marks, start: clock())
            reachBox.mark = mark
            return (mark.id, mark.start)
        }
        pacer.after(Self.readyBound) { [weak self] in self?.endMark(id, at: start.addingTimeInterval(Self.readyBound)) }
        do {
            try await withTaskCancellationHandler {
                try await body()
            } onCancel: {
                self.endMark(id, at: self.clock())
            }
        } catch {
            endMark(id, at: clock())
            throw error
        }
        reachBox.lock.withLock { if reachBox.mark?.id == id { reachBox.mark?.ready = true } }
    }


    public static func state(of error: Error, now: Date) -> RequestState? {
        guard let failure = error as? LinkFailure else { return nil }
        switch failure {
        case .unpaired, .noAnswer, .notTheHome, .homeTooOld, .tooOld:
            return .reach
        case .refused(let status, let code, let message):
            return state(status: status, code: code, words: message, retryAfter: nil, now: now)
        case .unavailable(let code, let message, let retryAfter, let notNow):
            return state(status: code.hasPrefix("HTTP_") ? Int(code.dropFirst(5)) ?? 503 : 503, code: code, words: message,
                         retryAfter: retryAfter.map { Int($0.rounded(.up)) }, notNow: notNow, now: now)
        case .unanswered(let again, let began):
            return again && began ? .saving : .unknown(ReachWords.unanswered(again: again, began: began))
        case .busy, .stale, .clockAhead, .whichPhone, .unreadable:
            return .refused(failure.description)
        case .credentials, .unusableID, .name, .code, .account, .waits:
            return nil
        }
    }

    public static func state(status: Int, code: String?, words: String?, retryAfter: Int?, notNow: NotNow? = nil,
                             now: Date) -> RequestState {
        let code = code ?? "HTTP_\(status)"
        switch (status, code) {
        case (401, _), (426, _):
            return .reach
        case (503, Self.notNow) where notNow != nil && notNow != .busy:
            return .reach
        case (503, "OUTCOME_UNKNOWN"):
            return .unknown(words ?? ReachWords.unknownDone)
        case (503, "HOME_FAILED"):
            return .failed
        case (503, _) where code.hasPrefix("HTTP_"):
            return .failed
        case (503, _):
            return .wait(words: ReachWords.door(code) ?? words ?? ReachWords.waiting,
                         until: now.addingTimeInterval(retryAfter.map(TimeInterval.init) ?? probeEvery))
        case (500...599, _):
            return .failed
        default:
            return .refused(words ?? ReachWords.refused)
        }
    }

    static let notNow = "NOT_NOW"


    enum Heard: Equatable {
        case answered
        case needsUpdate(Update)
        case passRefused
        case silent
        case unpaired
        case held(Held)
        case starting(Starting)
        case probeEnded

        var fails: Bool {
            switch self {
            case .silent, .starting, .probeEnded: true
            default: false
            }
        }
    }

    static func heard(_ response: HomeResponse) -> (heard: Heard, moves: Bool, retryAfter: TimeInterval?) {
        let object = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any]
        let retryAfter = response.header("Retry-After").flatMap(TimeInterval.init)
        switch response.status {
        case 426:
            return (.needsUpdate(.device(floor: object?["floor"] as? String ?? "")), true, nil)
        case 401:
            return (.passRefused, true, nil)
        case 503 where object?["code"] as? String == notNow:
            switch NotNow.read(response.body, object) {
            case .needs(let held): return (.held(held), false, retryAfter)
            case .starting(let said): return (.starting(said), false, retryAfter)
            case .busy: return (.answered, true, nil)
            }
        default:
            return (.answered, true, nil)
        }
    }

    static func heard(_ error: Error) -> (heard: Heard, moves: Bool)? {
        switch error as? LinkFailure {
        case .noAnswer?, .notTheHome?: (.silent, false)
        case .unpaired?: (.unpaired, false)
        case .homeTooOld?: (.needsUpdate(.home), false)
        case .tooOld(let floor)?: (.needsUpdate(.device(floor: floor)), false)
        default: nil
        }
    }

    func observe(_ response: HomeResponse, token: Int) {
        let (heard, moves, retryAfter) = Self.heard(response)
        if case .starting = heard, !Self.probing {
            guard reachBox.lock.withLock({ token >= reachBox.generation }) else { return }
            _ = joinProbe()
            return
        }
        observe(heard, token: token, moves: moves, retryAfter: retryAfter)
    }

    @TaskLocal static var probing = false

    func observe(_ error: Error, token: Int) {
        guard let (heard, moves) = Self.heard(error) else { return }
        observe(heard, token: token, moves: moves)
    }

    func observe(_ heard: Heard, token: Int, moves: Bool, retryAfter: TimeInterval? = nil) {
        let (blocked, explained, routes) = facing(heard)
        let at = clock()
        let asks = changing {
            reduce(heard, token: token, moves: moves, retryAfter: retryAfter, at: at, blocked: blocked, explained: explained,
                   routes: routes)
        }
        if asks { _ = joinProbe() }
        follow()
    }

    func reachPaired() {
        let detached: Task<Void, Never>? = changing {
            loadReach()
            let before = now()
            reachBox.generation = tick()
            let detached = detach()
            if reachBox.reach != .answering { heal() }
            told(from: before, at: clock())
            return detached
        }
        detached?.cancel()
    }

    func reachForgotten() {
        let detached: Task<Void, Never>? = changing {
            loadReach()
            let before = now()
            reachBox.generation = tick()
            let detached = detach()
            reachBox.lastReached = nil
            reachBox.reach = .unpaired
            reachBox.written = nil
            try? FileManager.default.removeItem(at: reachFile)
            notify(from: before)
            return detached
        }
        detached?.cancel()
    }

    func joinProbe() -> Task<Void, Never>? {
        changing {
            loadReach()
            if let probe = reachBox.probe { return probe.done }
            if case .unreachable(let cause, _) = reachBox.reach, cause.isNetwork { return nil }
            soon(at: clock(), now: false)
            return reachBox.probe?.done
        }
    }

    func probesEnded() async {
        while let running = reachBox.lock.withLock({ reachBox.probe?.task }) { await running.value }
    }

    var reachWrites: Int { reachBox.lock.withLock { reachBox.writes } }


    private var answering: Bool { reachBox.reach == .answering }

    private func now() -> ReachSnapshot {
        ReachSnapshot(reach: reachBox.reach, lastReached: reachBox.lastReached, revision: reachBox.revision,
                      episode: reachBox.current, routes: reachBox.routes, checking: reachBox.checks > 0)
    }

    private func loadReach() {
        guard !reachBox.loaded else { return }
        reachBox.loaded = true
        let object = (try? files.read(reachFile, maximumBytes: Self.mostKept)).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
        reachBox.lastReached = (object?["last_reached"] as? Double).map(Date.init(timeIntervalSince1970:))
        if let paired = try? name() != nil, !paired { reachBox.reach = .unpaired }
    }

    @discardableResult
    private func reduce(_ heard: Heard, token: Int, moves: Bool, retryAfter: TimeInterval?, at: Date, blocked: Cause?,
                        explained: Cause?, routes: Routes?) -> Bool {
        guard token >= reachBox.generation else { return false }
        let before = now()
        defer { told(from: before, at: at) }
        if moves { reachBox.lastReached = at }
        let current = switch heard {
        case .answered: token >= reachBox.episode
        case .silent, .starting, .probeEnded: token >= reachBox.trip && token >= reachBox.healed
        case .held, .needsUpdate, .passRefused: token >= reachBox.healed && reachBox.reach != .unpaired
        case .unpaired: true
        }
        guard current else { return false }
        if heard == .answered, case .held = reachBox.reach, !Self.probing, blocked == nil { return true }
        if let retryAfter {
            reachBox.retryAfter = retryAfter
            reachBox.notBefore = at.addingTimeInterval(retryAfter)
        }
        if let blocked, heard != .unpaired, !(heard == .answered && answering) {
            roadGone(blocked, at: at, routes: routes)
            return false
        }
        switch heard {
        case .answered:
            if reachBox.mark?.ready == true { reachBox.mark = nil }
            if !answering { heal() }
        case .starting(let said):
            switch reachBox.reach {
            case .answering, .held, .needsUpdate, .passRefused:
                reachBox.reach = .starting(said, since: at)
                reachBox.episode = tick()
            case .waiting(let since), .unreachable(_, let since), .starting(_, let since):
                reachBox.reach = .starting(said, since: since)
            case .unpaired:
                break
            }
        case .silent:
            switch reachBox.reach {
            case .answering, .held, .needsUpdate, .passRefused, .starting:
                reachBox.reach = .waiting(since: at)
                reachBox.episode = tick()
            case .unreachable(_, let since):
                reachBox.reach = .unreachable(cause(explained), since: since)
                reachBox.routes = routes
            case .waiting, .unpaired:
                break
            }
        case .probeEnded:
            switch reachBox.reach {
            case .waiting(let since) where token > reachBox.episode && reachBox.mark == nil && at.timeIntervalSince(since) >= grace:
                reachBox.reach = .unreachable(cause(explained), since: since)
                reachBox.routes = routes
            case .unreachable(let was, let since) where !was.isNetwork:
                reachBox.reach = .unreachable(cause(explained), since: since)
                reachBox.routes = routes
            default:
                break
            }
        case .held(let held):
            reachBox.reach = .held(held)
            if reachBox.mark?.ready == true { reachBox.mark = nil }
        case .needsUpdate(let update):
            reachBox.reach = .needsUpdate(update)
            if reachBox.mark?.ready == true { reachBox.mark = nil }
        case .passRefused:
            reachBox.reach = .passRefused
            if reachBox.mark?.ready == true { reachBox.mark = nil }
        case .unpaired:
            reachBox.reach = .unpaired
        }
        return false
    }

    private func heal() {
        reachBox.reach = .answering
        reachBox.revision += 1
        reachBox.healed = tick()
        reachBox.retryAfter = nil
        reachBox.notBefore = nil
    }

    private func detach() -> Task<Void, Never>? {
        let probe = reachBox.probe
        reachBox.probe = nil
        probe?.finish.finish()
        reachBox.mark = nil
        reachBox.retryAfter = nil
        reachBox.notBefore = nil
        return probe?.task
    }

    private func roadGone(_ cause: Cause, at: Date, routes: Routes?) {
        defer { if reachBox.reach.isUnreachable { reachBox.routes = routes } }
        switch reachBox.reach {
        case .answering, .held, .needsUpdate, .passRefused:
            reachBox.reach = .unreachable(cause, since: at)
            reachBox.episode = tick()
        case .waiting(let since), .unreachable(_, let since), .starting(_, let since):
            reachBox.reach = .unreachable(cause, since: since)
        case .unpaired:
            break
        }
    }

    private func cause(_ explained: Cause?) -> Cause {
        explained ?? .silent
    }

    private func told(from before: ReachSnapshot, at: Date) {
        let after = now()
        let changed = before.reach != after.reach || before.revision != after.revision
        let minute = reachBox.written.map { at.timeIntervalSince($0) >= 60 } ?? true
        if after.lastReached != nil, changed || (before.lastReached != after.lastReached && minute) {
            writeReach(at: at)
        }
        notify(from: before)
    }

    private func writeReach(at: Date) {
        guard let last = reachBox.lastReached,
              let data = try? JSONSerialization.data(withJSONObject: ["last_reached": last.timeIntervalSince1970]) else { return }
        try? FileManager.default.createDirectory(at: reachFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? files.replace(reachFile, with: data, commit: .atomic)
        reachBox.written = at
        reachBox.writes += 1
    }

    private func notify(from before: ReachSnapshot) {
        reachBox.current = Episode.next(reachBox.current, after: reachBox.reach, at: clock(), count: &reachBox.episodes)
        if !(reachBox.reach.isUnreachable) { reachBox.routes = nil }
        let after = now()
        guard before != after else { return }
        reachBox.untold.append(after)
    }


    private func roadless(_ addresses: [URL], on facts: NetworkFacts?) -> Cause? {
        guard let facts, !addresses.isEmpty, !addresses.contains(where: { Self.road(to: $0, on: facts) }) else { return nil }
        return Cause.of(facts, homeListsTailscale: Self.listsTailscale(addresses)) ?? .offline
    }

    private func facing(_ heard: Heard) -> (blocked: Cause?, explained: Cause?, routes: Routes?) {
        let (peek, explain) = reachBox.lock.withLock { () -> (Reach, (@Sendable () -> Cause?)?) in
            loadReach()
            return (reachBox.reach, reachBox.explain)
        }
        guard !(peek == .answering && heard == .answered) else { return (nil, nil, nil) }
        let facts = network?.facts
        let addresses = (try? addresses()) ?? []
        let blocked = roadless(addresses, on: facts)
        let says: Bool = switch (heard, peek) {
        case (.silent, .unreachable(let cause, _)), (.probeEnded, .unreachable(let cause, _)): !cause.isNetwork
        case (.probeEnded, .waiting): true
        default: false
        }
        return (blocked, says ? explain?() : nil, Routes.of(addresses, on: facts))
    }

    @discardableResult
    private func changing<T>(_ change: () -> T) -> T {
        reachBox.lock.withLock {
            let value = change()
            if let timer = reconcile(at: clock()) {
                pacer.after(timer.after) { [weak self] in self?.probeDue(timer.probe, at: timer.due) }
            }
            let untold = reachBox.untold
            reachBox.untold = []
            for snapshot in untold {
                for (id, listener) in reachBox.listeners {
                    if case .terminated = listener.yield(snapshot) { reachBox.listeners[id] = nil }
                }
            }
            return value
        }
    }

    private struct Timer {
        let probe: Int
        let due: Date
        let after: TimeInterval
    }

    private var probesNow: Bool {
        guard reachBox.front else { return false }
        switch reachBox.reach {
        case .answering, .unpaired: return false
        case .unreachable(let cause, _): return !cause.isNetwork
        case .waiting, .starting, .held, .needsUpdate, .passRefused: return true
        }
    }

    private func reconcile(at: Date) -> Timer? {
        guard probesNow else {
            if let due = reachBox.probe, due.task == nil {
                reachBox.probe = nil
                due.finish.finish()
            }
            return nil
        }
        if reachBox.probe == nil {
            reachBox.probe = newProbe(due: at.addingTimeInterval(max(Self.probeEvery, reachBox.retryAfter ?? 0)))
        }
        guard var probe = reachBox.probe, probe.task == nil else { return nil }
        if let notBefore = reachBox.notBefore, probe.due < notBefore { probe.due = notBefore }
        let armed = probe.armed == probe.due
        probe.armed = probe.due
        reachBox.probe = probe
        return armed ? nil : Timer(probe: probe.id, due: probe.due, after: probe.due.timeIntervalSince(at))
    }

    private func soon(at: Date, now: Bool) {
        guard reachBox.reach != .unpaired else { return }
        var probe = reachBox.probe ?? newProbe(due: at)
        guard probe.task == nil else { return }
        probe.due = now ? at : max(at, reachBox.notBefore ?? at)
        if probe.due <= at { send(&probe) }
        reachBox.probe = probe
    }

    private func newProbe(due: Date) -> ReachBox.Probe {
        reachBox.probes += 1
        let (ended, finish) = AsyncStream<Void>.makeStream()
        return ReachBox.Probe(id: reachBox.probes, due: due, done: Task { for await _ in ended {} }, finish: finish)
    }

    private func send(_ probe: inout ReachBox.Probe) {
        let began = tick()
        let ask = reachBox.ask ?? { _ = try await $0.status(within: $0.reach) }
        let id = probe.id
        probe.began = began
        probe.task = Task { [weak self] in
            guard let self else { return }
            var cancelled = false
            do {
                try await Self.$probing.withValue(true) { try await ask(self) }
            } catch {
                cancelled = error is CancellationError || (error as? URLError)?.code == .cancelled
            }
            probeEnded(id, began: began, cancelled: cancelled || Task.isCancelled)
        }
    }

    private func probeDue(_ id: Int, at due: Date) {
        changing {
            guard var probe = reachBox.probe, probe.id == id, probe.task == nil, probe.due == due else { return }
            send(&probe)
            reachBox.probe = probe
        }
    }

    private func probeEnded(_ id: Int, began: Int, cancelled: Bool) {
        let (blocked, explained, routes) = facing(.probeEnded)
        let at = clock()
        let finish: AsyncStream<Void>.Continuation? = changing {
            guard let probe = reachBox.probe, probe.id == id else { return nil }
            reachBox.probe = nil
            if !cancelled {
                reduce(.probeEnded, token: began, moves: false, retryAfter: nil, at: at, blocked: blocked, explained: explained,
                       routes: routes)
            }
            return probe.finish
        }
        finish?.finish()
    }

    private func endMark(_ id: Int, at: Date) {
        changing {
            guard reachBox.mark?.id == id else { return }
            reachBox.mark = nil
            let before = now()
            if case .waiting = reachBox.reach { reachBox.reach = .waiting(since: at) }
            told(from: before, at: clock())
        }
    }

    private func follow() {
        guard let network else { return }
        reachBox.lock.withLock {
            guard reachBox.following == nil, reachBox.front else { return }
            reachBox.following = Task { [weak self] in
                for await facts in network.changes() {
                    guard let self, !Task.isCancelled else { return }
                    saw(facts)
                }
            }
        }
    }

    func saw(_ facts: NetworkFacts) {
        let addresses = (try? addresses()) ?? []
        let blocked = roadless(addresses, on: facts)
        changing {
            loadReach()
            guard reachBox.reach != .unpaired else { return }
            let at = clock()
            if let blocked {
                let before = now()
                roadGone(blocked, at: at, routes: Routes.of(addresses, on: facts))
                told(from: before, at: at)
            } else if case .unreachable(let cause, _) = reachBox.reach, cause.isNetwork {
                soon(at: at, now: true)
            }
        }
    }
}

public struct Pacer: Sendable {
    public let after: @Sendable (_ seconds: TimeInterval, _ fire: @escaping @Sendable () -> Void) -> Void

    public init(after: @escaping @Sendable (_ seconds: TimeInterval, _ fire: @escaping @Sendable () -> Void) -> Void) {
        self.after = after
    }

    public static let system = Pacer { seconds, fire in
        Task {
            try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
            fire()
        }
    }
}

final class ReachBox: @unchecked Sendable {
    struct Mark {
        let id: Int
        let start: Date
        var ready = false
    }

    struct Probe {
        let id: Int
        var due: Date
        var armed: Date?
        var began: Int?
        var task: Task<Void, Never>?
        let done: Task<Void, Never>
        let finish: AsyncStream<Void>.Continuation

        init(id: Int, due: Date, done: Task<Void, Never>, finish: AsyncStream<Void>.Continuation) {
            self.id = id
            self.due = due
            self.done = done
            self.finish = finish
        }
    }

    let lock = NSLock()
    var reach: HomeLink.Reach = .answering
    var loaded = false
    var lastReached: Date?
    var revision = 0
    var generation = 0, trip = 0, healed = 0, episode = 0
    var retryAfter: TimeInterval?
    var notBefore: Date?
    var front = true
    var mark: Mark?
    var marks = 0
    var probe: Probe?
    var probes = 0
    var ask: (@Sendable (HomeLink) async throws -> Void)?
    var explain: (@Sendable () -> HomeLink.Cause?)?
    var following: Task<Void, Never>?
    var listeners: [UUID: AsyncStream<HomeLink.ReachSnapshot>.Continuation] = [:]
    var untold: [HomeLink.ReachSnapshot] = []
    var written: Date?
    var writes = 0
    var current: HomeLink.Episode?
    var episodes = 0
    var routes: HomeLink.Routes?
    var checks = 0

    deinit {
        following?.cancel()
        probe?.finish.finish()
        for listener in listeners.values { listener.finish() }
    }
}
