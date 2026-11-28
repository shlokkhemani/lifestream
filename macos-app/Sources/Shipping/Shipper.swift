import Evidence
import Foundation
import HomeLink

public actor Shipper {
    public struct Dependencies: Sendable {
        public let state: ShippingState
        public let link: HomeLink
        public let settings: MacSettings
        public let domains: @Sendable ([String]) -> [any ShippingDomain]
        public let offers: @Sendable (String) -> [String]
        public let clock: @Sendable () -> Date
        public let record: @Sendable (ShipperRunRow) -> Void
        public let rotateBatch: @Sendable (_ product: String) -> Bool
        public let fullDiskAccess: @Sendable () -> Bool
        public let grants: @Sendable () -> [String: String]?
        public let found: @Sendable () -> [String]?
        public let stores: DeclaredStores?
        public let settle: @Sendable (FreshAnswer, _ pressed: Bool) async -> [ShipperRunRow]
        public let keepAwake: @Sendable () -> @Sendable () -> Void
        public let onFilesMissing: @Sendable (_ source: String, _ missing: Set<String>) -> Bool
        public let staged: @Sendable (_ source: String) -> StagedBlobs?
        public let onStagedConsumed: @Sendable (_ source: String, _ sha256s: Set<String>) -> Void
        public let coldInterval: @Sendable () -> TimeInterval
        public let scratch: URL

        public init(state: ShippingState, link: HomeLink, settings: MacSettings? = nil,
                    domains: @escaping @Sendable ([String]) -> [any ShippingDomain],
                    offers: @escaping @Sendable (String) -> [String] = { _ in [] },
                    clock: @escaping @Sendable () -> Date = { Date() },
                    record: @escaping @Sendable (ShipperRunRow) -> Void,
                    rotateBatch: @escaping @Sendable (_ product: String) -> Bool = { _ in true },
                    fullDiskAccess: @escaping @Sendable () -> Bool = { true },
                    grants: @escaping @Sendable () -> [String: String]? = { nil },
                    found: @escaping @Sendable () -> [String]? = { nil },
                    stores: DeclaredStores? = nil,
                    settle: @escaping @Sendable (FreshAnswer, _ pressed: Bool) async -> [ShipperRunRow] = { _, _ in [] },
                    keepAwake: @escaping @Sendable () -> @Sendable () -> Void = { {} },
                    onFilesMissing: @escaping @Sendable (_ source: String, _ missing: Set<String>) -> Bool = { _, _ in false },
                    staged: @escaping @Sendable (_ source: String) -> StagedBlobs? = { _ in nil },
                    onStagedConsumed: @escaping @Sendable (_ source: String, _ sha256s: Set<String>) -> Void = { _, _ in },
                    coldInterval: @escaping @Sendable () -> TimeInterval = { SealRequest.coldInterval },
                    scratch: URL) {
            self.state = state
            self.link = link
            self.settings = settings ?? MacSettings(file: state.root.appendingPathComponent(MacSettings.fileName), files: state.files)
            self.domains = domains
            self.offers = offers
            self.clock = clock
            self.record = record
            self.rotateBatch = rotateBatch
            self.fullDiskAccess = fullDiskAccess
            self.grants = grants
            self.found = found
            self.stores = stores
            self.settle = settle
            self.keepAwake = keepAwake
            self.onFilesMissing = onFilesMissing
            self.staged = staged
            self.onStagedConsumed = onStagedConsumed
            self.coldInterval = coldInterval
            self.scratch = scratch
        }
    }

    public static let retryInterval: TimeInterval = 15 * 60
    public static let refusedInterval: TimeInterval = HomeLink.Outbox.Wait.refused.seconds
    public static let throughInterval: TimeInterval = 5 * 60
    public static let filesMissingHold: TimeInterval = retryInterval

    private let dependencies: Dependencies
    private var schedule = ShippingSchedule()
    private var scheduleLoaded = false
    public private(set) var running = false
    private var flushing = false
    private var stoppedEarly = false
    private var knockedSilent = false
    private var unreadable: [String: Date] = [:]
    private var asked: Set<String> = []
    private var refusedThisRun: Set<String> = []
    private var conflicted: Set<String> = []
    private var pastWaits: MobileData.Wait?
    private var pressOwed = false
    private var holds: [String: Hold] = [:]
    private var lastAnswered: (asked: Date, received: Date)?
    private var settledAt: Date?
    private var afterRun: [CheckedContinuation<Void, Never>] = []

    public init(_ dependencies: Dependencies) {
        self.dependencies = dependencies
        dependencies.link.tell(sending: dependencies.state.readSchedule().sending ?? Sending())
        if let found = dependencies.found() { dependencies.link.tell(found: found) }
        if let stores = dependencies.stores { dependencies.link.tell(stores: stores.stated()) }
    }

    private var state: ShippingState { dependencies.state }
    private var link: HomeLink { dependencies.link }


    private func asked(_ saved: SavedAnswer?) -> Date? {
        guard let lastAnswered, let saved, abs(saved.at.timeIntervalSince(lastAnswered.received)) < 0.001 else { return nil }
        return lastAnswered.asked
    }

    public func status() -> ShipperStatus {
        let schedule = loadedSchedule()
        let now = dependencies.clock()
        let saved = link.saved
        let importingHistory = schedule.domains.contains { source, mine in
            guard let page = mine.historySeal, let custody = saved?.sources[source] else { return false }
            return custody.imported < page
        }
        return ShipperStatus(home: (try? link.name()) ?? nil, lastRunAt: schedule.lastRunAt, lastOutcome: schedule.lastOutcome,
                             lastContactAt: saved?.at, answerAsked: asked(saved), pending: (try? state.pendingBundles().count) ?? 0,
                             nextRunAt: nextRun(after: now), running: running,
                             sources: (saved?.sources.keys).map { $0.sorted() } ?? [], needs: saved?.needs ?? [],
                             importingHistory: importingHistory, waitsFor: schedule.waitsFor.flatMap(MobileData.Wait.init(rawValue:)))
    }

    public func nextRun(after now: Date) -> Date {
        let schedule = loadedSchedule()
        guard let lastRunAt = schedule.lastRunAt else { return now }
        let earliest = stoppedEarly ? lastRunAt.addingTimeInterval(MacSettings.readerRefresh) : now
        guard let saved = link.saved else { return max(now, earliest) }
        let bundles = (try? state.pendingBundles()) ?? []
        let pending = Set(bundles.map(\.sidecar.sourceId))
        var next = Date.distantFuture
        for bundle in bundles {
            let held = holds[bundle.sidecar.sourceId].flatMap { $0.holds(bundle.sidecar, at: lastRunAt) ? $0.until : nil }
            next = min(next, max(now, held ?? lastRunAt.addingTimeInterval(Self.retryInterval)))
        }
        let refreshing = asked.union(stamps(saved.refresh, stated: Set(saved.sources.keys)).keys)
        for domain in dependencies.domains(saved.sources.keys.sorted()) {
            if pending.contains(domain.sourceId) { continue }
            let (acted, every) = cadence(domain.sourceId, at: now)
            if domain.owes || refreshing.contains(domain.sourceId) || due(acted, trigger: .timer, at: now, interval: every) {
                next = now
                break
            }
            if let acted {
                next = min(next, max(now, acted.addingTimeInterval(every)))
            }
        }
        if next == .distantFuture { next = lastRunAt.addingTimeInterval(MacSettings.readerRefresh) }
        return max(next, earliest)
    }

    private func cadence(_ source: String, at now: Date) -> (actedAt: Date?, every: TimeInterval) {
        let setting = dependencies.settings.refresh(of: connector(source))
        let mine = schedule.domains[source] ?? DomainSchedule()
        if let tried = unreadable[source], tried > (mine.actedAt ?? .distantPast) { return (tried, setting) }
        return (mine.actedAt, setting)
    }

    private func adopt(_ pass: String, at now: Date) {
        guard schedule.pass != pass || schedule.pairedAt == nil else { return }
        schedule.pass = pass
        schedule.pairedAt = now
    }

    public func homeChanged() {
        stoppedEarly = false
    }

    private func due(_ actedAt: Date?, trigger: ShipTrigger, at now: Date, interval: TimeInterval) -> Bool {
        switch trigger {
        case .manual: true
        case .timer: elapsed(actedAt, at: now, interval: interval)
        case .now: false
        }
    }

    private func elapsed(_ actedAt: Date?, at now: Date, interval: TimeInterval) -> Bool {
        guard let actedAt else { return true }
        return now >= actedAt.addingTimeInterval(interval)
    }

    fileprivate func paired() -> Bool {
        ((try? link.name()) ?? nil) != nil
    }

    private func connector(_ source: String) -> String {
        ShippingDomains.connector(of: source, stores: dependencies.stores)
    }


    public func sources(of connector: String) -> Set<String> {
        let stated = link.fresh.map { Set($0.sources.keys) } ?? link.saved.map { Set($0.sources.keys) } ?? []
        return stated.filter { self.connector($0) == connector }
    }

    public func ask(_ sources: Set<String>) {
        asked.formUnion(sources)
    }

    public func clearFilesMissingHold(for source: String) {
        if holds[source]?.code == Hold.filesMissing { holds[source] = nil }
    }

    public struct FlushResult: Sendable, Equatable {
        public let seals: [String: Int]
        public let ran: Set<String>
        public let unrotated: Set<String>
        public let unsettled: Set<String>

        public init(seals: [String: Int] = [:], ran: Set<String> = [], unrotated: Set<String> = [], unsettled: Set<String> = []) {
            self.seals = seals
            self.ran = ran
            self.unrotated = unrotated
            self.unsettled = unsettled
        }
    }

    public func flush(sources: Set<String>?, budget: TimeInterval) async -> FlushResult {
        await Within.seconds(budget) { await self.flushed(sources) } ?? FlushResult()
    }

    private func flushed(_ wanted: Set<String>?) async -> FlushResult {
        while running { await withCheckedContinuation { afterRun.append($0) } }
        guard !Task.isCancelled, paired() else { return FlushResult() }
        running = true
        flushing = true
        defer { ended() }
        let now = dependencies.clock()
        var answer: FreshAnswer
        do {
            try state.prepare()
            _ = loadedSchedule()
            let asked = dependencies.clock()
            answer = try await dependencies.settings.exchange(through: link, offers: dependencies.offers(link.saved?.unit ?? ""))
            lastAnswered = (asked, answer.at)
        } catch {
            return FlushResult()
        }
        guard answer.pass == schedule.pass, !Task.isCancelled else { return FlushResult() }
        refusedThisRun = []
        conflicted = []
        let pending = pendingSources()
        let domains = dependencies.domains(answer.sources.keys.sorted()).filter { domain in
            Self.fast(domain) && !pending.contains(domain.sourceId) && wanted.map { $0.contains(domain.sourceId) } != false
        }
        var rows: [ShipperRunRow] = []
        let note = { (row: ShipperRunRow) in
            rows.append(row)
            self.dependencies.record(row)
        }
        let unrotated = rotate(domains)
        var shipped: Set<String> = []
        var unsettled: Set<String> = []
        flushing: for domain in domains {
            guard !Task.isCancelled else { break flushing }
            shipped.insert(domain.sourceId)
            for _ in 0..<2 {
                guard !Task.isCancelled else { break flushing }
                let outcome = await ship(domain, pressed: false, live: true, cold: false, answer: answer, at: now, note: note)
                if let fresh = outcome.answer { answer = fresh }
                if domain.unsettled { unsettled.insert(domain.sourceId) }
                if outcome.stopsTheRun { break flushing }
                guard Self.reseals(outcome) else { break }
            }
        }
        try? state.writeSchedule(schedule)
        var seals: [String: Int] = [:]
        for row in rows where row.outcome == "shipped" {
            guard let source = row.source, let seal = row.seal else { continue }
            seals[source] = max(seals[source] ?? seal, seal)
        }
        return FlushResult(seals: seals, ran: shipped, unrotated: unrotated, unsettled: unsettled)
    }

    static func fast(_ domain: any ShippingDomain) -> Bool {
        !domain.behindLive && !(domain is BiomeEngine) && !((domain as? DeclaredDomain)?.inner is BiomeEngine)
    }

    static let batches: Set<Substring> = ["machine", "input"]

    static func batched(_ domain: any ShippingDomain) -> Bool {
        batches.contains(ShippingDomains.product(of: domain.sourceId))
    }

    private func rotate(_ domains: [any ShippingDomain]) -> Set<String> {
        Set(domains.filter { Self.batched($0) && !dependencies.rotateBatch(String(ShippingDomains.product(of: $0.sourceId))) }.map(\.sourceId))
    }

    public static let photos: Substring = "apple-photos"

    private static func reseals(_ outcome: DeliveryOutcome) -> Bool {
        outcome.outcome == "stale" || (outcome.code == Hold.filesMissing && outcome.left == .spent)
    }

    private func ended() {
        running = false
        flushing = false
        let waiting = afterRun
        afterRun = []
        for wait in waiting { wait.resume() }
    }

    private func stamps(_ refresh: [String: Int]?, stated: Set<String>) -> [String: Int] {
        (refresh ?? [:]).filter { source, stamp in
            stated.contains(source) && stamp > (schedule.domains[source]?.stamp ?? .min)
        }
    }

    private func pendingSources() -> Set<String> {
        Set(((try? state.pendingBundles()) ?? []).map { $0.sidecar.sourceId })
    }


    public func run(_ trigger: ShipTrigger, due wakes: Set<String>? = nil) async -> ShipperReport {
        while flushing { await withCheckedContinuation { afterRun.append($0) } }
        guard !running else { return ShipperReport(rows: [], outcome: "busy") }
        running = true
        defer { ended() }
        ResourceMeter.shared.count(.shipperRuns)
        ResourceMeter.shared.count(.shipping(nil), units: 1)
        let now = dependencies.clock()
        var rows: [ShipperRunRow] = []
        refusedThisRun = []
        conflicted = []
        let note = { (row: ShipperRunRow) in
            rows.append(row)
            self.dependencies.record(row)
        }
        do {
            try ResourceMeter.shared.measure(.shipping(nil), units: 0) {
                try state.prepare()
                state.retireArchives()
                schedule = state.readSchedule()
            }
            scheduleLoaded = true
        } catch {
            note(ShipperRunRow(outcome: "refused", code: "LOCAL_STORAGE", message: "\(error)"))
            _ = loadedSchedule()
            stating { $0.sendFailed(code: "LOCAL_STORAGE", message: "\(error)", at: now) }
            return finish(rows, at: now)
        }
        guard paired() else {
            note(ShipperRunRow(outcome: "no_home"))
            return finish(rows, at: now)
        }
        let pressed = trigger != .timer
        if pressed { pressOwed = true }
        pastWaits = Self.wait(of: link.mobile(pressed: pressed).past)

        if let found = dependencies.found() { link.tell(found: found) }
        if let grants = dependencies.grants() { link.tell(grants: grants) }
        if let stores = dependencies.stores { link.tell(stores: stores.stated()) }
        var answer: FreshAnswer
        do {
            let asked = dependencies.clock()
            answer = try await dependencies.settings.exchange(through: link, offers: dependencies.offers(link.saved?.unit ?? ""))
            lastAnswered = (asked, answer.at)
        } catch {
            note(ShipperRunRow(failure: error))
            if let failure = error as? LinkFailure, failure == .homeTooOld {
                stating { $0.sendFailed(code: failure.code, message: failure.description, at: now) }
            }
            return finish(rows, at: now)
        }
        if let stores = dependencies.stores, let answered = answer.stores {
            do {
                try stores.take(answered)
                link.tell(stores: stores.stated())
                if let found = dependencies.found() { link.tell(found: found) }
            } catch {
                note(ShipperRunRow(outcome: "refused", code: "LOCAL_STORAGE", message: "\(error)"))
            }
        }
        state.ledgers.keep(only: answer.pass)
        adopt(answer.pass, at: now)
        stating { sending in sending.sources = sending.sources.filter { answer.sources[$0.key] != nil } }
        let stamped = stamps(answer.refresh, stated: Set(answer.sources.keys))
        asked.formIntersection(answer.sources.keys)
        let refreshing = asked.union(stamped.keys)

        var resealing: Set<String> = []
        var waiting: Set<String> = []
        var trailing: [SealedBundle] = []
        let follow = { (outcome: DeliveryOutcome) in
            guard let source = outcome.bundle?.sourceId else { return }
            switch outcome.left {
            case .spent?: resealing.insert(source)
            case .kept?: waiting.insert(source)
            case nil: break
            }
        }
        do {
            try state.recoverWork()
            for bundle in try state.pendingBundles() {
                let source = bundle.sidecar.sourceId
                guard bundle.sidecar.pass == answer.pass, !resealing.contains(source) else {
                    state.spend(bundle)
                    continue
                }
                guard let custody = answer.sources[source], !waiting.contains(source), !conflicted.contains(source) else { continue }
                switch HomeLink.Outbox.judge(pass: answer.pass, seals: [source: bundle.sidecar.seal], answer: answer) {
                case .covered:
                    state.spend(bundle)
                    consumed(bundle.sidecar)
                    note(ShipperRunRow(outcome: "shipped", source: source, bundle: bundle.sidecar.id, kind: bundle.sidecar.kind,
                                       seal: bundle.sidecar.seal))
                    continue
                case .stale:
                    state.spend(bundle)
                    resealing.insert(source)
                    note(ShipperRunRow(outcome: "stale", code: "STALE", source: source, bundle: bundle.sidecar.id,
                                       kind: bundle.sidecar.kind, seal: bundle.sidecar.seal))
                    continue
                case .next:
                    break
                }
                if let refusal = bundle.sidecar.refused {
                    if trigger == .manual || now >= refusal.at.addingTimeInterval(Self.refusedInterval) {
                        state.spend(bundle)
                        resealing.insert(source)
                    } else {
                        waiting.insert(source)
                        refused(source, code: refusal.code, message: "Lifestream refused a bundle", at: refusal.at)
                    }
                    continue
                }
                if bundle.sidecar.statesHistory, !custody.history {
                    let held = wait(bundle, code: "HISTORY", message: "Lifestream holds history back for now")
                    note(held.row())
                    follow(held)
                    continue
                }
                if bundle.sidecar.kind == ImportShipping.kind {
                    trailing.append(bundle)
                    continue
                }
                let outcome = await deliver(bundle, pressed: pressed)
                note(outcome.row())
                refusedByDoor(outcome, at: now)
                if let fresh = outcome.answer { answer = fresh }
                if outcome.stopsTheRun { return finish(rows, at: now) }
                follow(outcome)
            }
        } catch {
            note(ShipperRunRow(outcome: "refused", code: "LOCAL_STORAGE", message: "\(error)"))
            stating { $0.sendFailed(code: "LOCAL_STORAGE", message: "\(error)", at: now) }
            return finish(rows, at: now)
        }
        stating { $0.send = nil }

        let domains = dependencies.domains(answer.sources.keys.sorted()).sorted {
            ($0.behindLive ? 1 : 0, $0.sourceId) < ($1.behindLive ? 1 : 0, $1.sourceId)
        }
        let pending = pendingSources()
        let timely = { (domain: any ShippingDomain) -> Bool? in
            let source = domain.sourceId
            let (acted, every) = self.cadence(source, at: now)
            let timely = (domain.owes && trigger != .now)
                || self.due(acted, trigger: resealing.contains(source) ? .manual : trigger, at: now, interval: every)
            let woke = wakes?.contains(source) ?? false
            guard !pending.contains(source), !self.conflicted.contains(source), timely || refreshing.contains(source) || woke else { return nil }
            return timely
        }
        let unrotated = rotate(domains.filter { timely($0) != nil })
        var unsettled: Set<String> = []
        var ran: Set<String> = []
        var settles = trigger == .timer && settles(wakes, at: now)
        for domain in domains {
            let source = domain.sourceId
            guard let timely = timely(domain) else { continue }
            if settles, wakes?.contains(source) == true, ShippingDomains.product(of: source) == Self.photos {
                settles = false
                await settle(answer, note: note, at: now)
            }
            ran.insert(source)
            for _ in 0..<2 {
                let shipped = await ship(domain, pressed: pressed, live: !timely,
                                         cold: trigger == .manual || refreshing.contains(source), answer: answer, at: now, note: note)
                if let fresh = shipped.answer { answer = fresh }
                if domain.unsettled { unsettled.insert(source) }
                if shipped.stopsTheRun { return finish(rows, at: now, unrotated: unrotated, unsettled: unsettled, ran: ran) }
                guard Self.reseals(shipped) else { break }
            }
            asked.remove(source)
            if let stamp = stamped[source] { schedule.domains[source, default: DomainSchedule()].stamp = stamp }
        }
        asked.subtract(refreshing.subtracting(domains.map(\.sourceId)))

        for bundle in trailing where !conflicted.contains(bundle.sidecar.sourceId) {
            if let domain = domains.first(where: { $0.sourceId == bundle.sidecar.sourceId }), domain.holds(bundle) {
                note(ShipperRunRow(outcome: "held", code: "ON_BATTERY", message: "a handed-over file waits for power", domain: domain))
                continue
            }
            let awake = dependencies.keepAwake()
            let domain = domains.first { $0.sourceId == bundle.sidecar.sourceId }
            let outcome = await deliver(bundle, pressed: pressed, moved: domain.map { domain in { @Sendable in domain.moved(bundle, sent: $0) } })
            awake()
            note(outcome.row())
            refusedByDoor(outcome, at: now)
            if let fresh = outcome.answer {
                answer = fresh
                if outcome.outcome == "shipped" { domain?.taken(bundle, answer: fresh) }
            }
            if outcome.stopsTheRun { return finish(rows, at: now, unrotated: unrotated, unsettled: unsettled, ran: ran) }
        }

        for domain in domains {
            ResourceMeter.shared.measure(.shipping(domain.name), units: 0) { domain.applied(answer) }
        }

        if settles { await settle(answer, note: note, at: now) }
        let historyWaits = domains.contains {
            schedule.domains[$0.sourceId]?.owesHistory == true && answer.sources[$0.sourceId]?.history == true
        } ? pastWaits : nil
        return finish(rows, at: now, reachedTheDomains: true, historyWaits: historyWaits, unrotated: unrotated, unsettled: unsettled, ran: ran)
    }

    private func settle(_ answer: FreshAnswer, note: (ShipperRunRow) -> Void, at now: Date) async {
        settledAt = now
        let settle = dependencies.settle
        let press = pressOwed
        pressOwed = false
        for row in await Task.detached(priority: .background, operation: { [answer] in await settle(answer, press) }).value {
            note(row)
            if row.outcome == "refused", let source = row.source {
                refused(source, code: row.code ?? "LOCAL_ACCESS", message: row.message ?? "", at: now)
            }
        }
    }

    private func settles(_ wakes: Set<String>?, at now: Date) -> Bool {
        guard let wakes else { return true }
        return wakes.contains { ShippingDomains.product(of: $0) == Self.photos } || elapsed(settledAt, at: now, interval: Self.throughInterval)
    }

    private func consumed(_ sidecar: BundleSidecar) {
        guard let staged = sidecar.stagedBlobs, !staged.isEmpty else { return }
        dependencies.onStagedConsumed(sidecar.sourceId, Set(staged))
    }

    private func ship(_ domain: any ShippingDomain, pressed: Bool, live: Bool, cold: Bool, answer: FreshAnswer,
                      at now: Date, note: (ShipperRunRow) -> Void) async -> DeliveryOutcome {
        var mine = schedule.domains[domain.sourceId] ?? DomainSchedule()
        guard let source = answer.sources[domain.sourceId] else { return DeliveryOutcome(outcome: "nothing_new") }
        let awake = domain.owes ? dependencies.keepAwake() : nil
        defer { awake?() }
        let history = !live && source.history && pastWaits == nil
            && !(holds[domain.sourceId]?.inForce(at: now) ?? false)
        let request = SealRequest(fetchedAt: now, workDirectory: state.workDirectory, scratch: dependencies.scratch,
                                  custody: SealCustody(pass: answer.pass, received: source.received, imported: source.imported,
                                                       history: history),
                                  owesThrough: elapsed(Self.latest(mine.sealedAt, link.through(of: domain.sourceId)?.statedAt), at: now,
                                                       interval: Self.throughInterval),
                                  start: dependencies.settings.start(of: connector(domain.sourceId)),
                                  held: Self.held(link), admitted: Self.admitted(link),
                                  monthsOwed: { [link, source = domain.sourceId] in link.monthsOwed($0, of: source) },
                                  staged: dependencies.staged(domain.sourceId), forceCold: cold,
                                  coldInterval: dependencies.coldInterval())
        let sealed: [SealedBundle]
        do {
            let quality: DispatchQoS.QoSClass = pressed || flushing ? .userInitiated : .background
            sealed = try await withCheckedThrowingContinuation { sealing in
                DispatchQueue.global(qos: quality).async {
                    sealing.resume(with: Result { try ResourceMeter.shared.measure(.shipping(domain.name)) { try domain.seal(request) } })
                }
            }
            for bundle in sealed { try state.writeSidecar(bundle) }
            domain.kept(sealed)
        } catch {
            unreadable[domain.sourceId] = now
            schedule.domains[domain.sourceId]?.owesHistory = nil
            let waits = (dependencies.stores?.waitsOnFullDiskAccess(domain.sourceId) ?? false) && !dependencies.fullDiskAccess()
            note(ShipperRunRow(outcome: "refused", code: waits ? "FULL_DISK_ACCESS" : "LOCAL_ACCESS", message: "\(error)",
                               reason: ShipperRunRow.reason(error), domain: domain))
            if waits {
                stating { $0.sources[domain.sourceId] = nil }
            } else {
                refused(domain.sourceId, code: "LOCAL_ACCESS", message: "\(error)", at: now)
            }
            return DeliveryOutcome(outcome: "refused")
        }
        mine.owesHistory = domain.owesHistory ? true : nil
        if let unread = domain.unread { refused(domain.sourceId, code: unread.code, message: unread.message, at: now) }
        guard !sealed.isEmpty else {
            if !live { mine.actedAt = now }
            schedule.domains[domain.sourceId] = mine
            if let stated = domain.through {
                let seal = request.custody.received > 0 ? request.custody.received : nil
                link.tell(through: Through(readThrough: stated.readThrough, statedAt: stated.statedAt, left: stated.left,
                                           start: stated.start, months: stated.months, seal: seal),
                          of: domain.sourceId, pass: request.custody.pass)
            }
            note(ShipperRunRow(outcome: "nothing_new", domain: domain))
            return DeliveryOutcome(outcome: "nothing_new")
        }
        unreadable[domain.sourceId] = nil
        if !live { mine.actedAt = now }
        mine.sealedAt = now
        if let page = sealed.last(where: \.sidecar.statesHistory) {
            mine.historySeal = page.sidecar.seal
        }
        schedule.domains[domain.sourceId] = mine
        var outcome = DeliveryOutcome(outcome: "nothing_new")
        for (index, bundle) in sealed.enumerated() {
            outcome = await deliver(bundle, pressed: pressed, moved: { @Sendable in domain.moved(bundle, sent: $0) })
            note(outcome.row(domain: domain))
            refusedByDoor(outcome, at: now)
            guard outcome.outcome == "shipped" else {
                for later in sealed.dropFirst(index + 1) {
                    if outcome.left == .spent { state.spend(later) } else { _ = try? state.park(later) }
                }
                break
            }
        }
        return outcome
    }

    static func latest(_ one: Date?, _ other: Date?) -> Date? {
        [one, other].compactMap { $0 }.max()
    }

    static let heldWait = HomeLink.silence + 15

    static func held(_ link: HomeLink, within: TimeInterval = heldWait) -> @Sendable (Set<String>) -> Set<String> {
        { hexes in
            guard !hexes.isEmpty else { return [] }
            let contacts = (hexes.count + HomeLink.heldAtOnce - 1) / HomeLink.heldAtOnce
            let answer = HeldAnswer()
            let done = DispatchSemaphore(value: 0)
            let asking = Task {
                let held = (try? await link.held(blobs: Set(hexes.map { "sha256:" + $0 }))) ?? []
                answer.set(Set(held.map { String($0.dropFirst("sha256:".count)) }))
                done.signal()
            }
            let bound = within * Double(contacts)
            guard done.wait(timeout: .now() + bound) == .success else {
                asking.cancel()
                ShippingState.log.error("the home did not say within \(Int(bound)) s which of \(hexes.count) files it holds; every one is carried")
                return []
            }
            return answer.value
        }
    }

    static func admitted(_ link: HomeLink, within: TimeInterval = heldWait) -> @Sendable (String, String) -> Bool {
        { kind, digest in
            let asked = HomeLink.ImportDigest(kind: kind, digest: digest)
            let answer = HeldAnswer()
            let done = DispatchSemaphore(value: 0)
            let asking = Task {
                if (try? await link.held(imports: [asked]))?[asked] == .admitted { answer.set([digest]) }
                done.signal()
            }
            guard done.wait(timeout: .now() + within) == .success else {
                asking.cancel()
                ShippingState.log.error("the home did not say within \(Int(within)) s whether it took a handed-over file; it is sent")
                return false
            }
            return answer.value.contains(digest)
        }
    }

    private func finish(_ rows: [ShipperRunRow], at now: Date, reachedTheDomains: Bool = false,
                        historyWaits: MobileData.Wait? = nil, unrotated: Set<String> = [], unsettled: Set<String> = [],
                        ran: Set<String> = []) -> ShipperReport {
        ResourceMeter.shared.measure(.shipping(nil), units: 0) {
            close(rows, at: now, reachedTheDomains: reachedTheDomains, historyWaits: historyWaits, unrotated: unrotated, unsettled: unsettled,
                  ran: ran)
        }
    }

    private func close(_ rows: [ShipperRunRow], at now: Date, reachedTheDomains: Bool, historyWaits: MobileData.Wait?,
                       unrotated: Set<String>, unsettled: Set<String>, ran: Set<String>) -> ShipperReport {
        let met = Set(rows.compactMap(Self.heldForNetwork) + [historyWaits].compactMap { $0 })
        let waitsFor = MobileData.Wait.allCases.last(where: met.contains)
        let report = ShipperReport(rows: rows, outcome: Self.outcome(of: rows), waitsFor: waitsFor, unrotated: unrotated, unsettled: unsettled,
                                   ran: ran)
        stoppedEarly = !reachedTheDomains
        schedule.lastRunAt = now
        schedule.lastOutcome = report.outcome
        schedule.waitsFor = waitsFor?.rawValue
        let sent = Set(rows.filter { $0.outcome == "shipped" || $0.outcome == "nothing_new" }.compactMap(\.source))
        stating { sending in
            for source in sent.subtracting(refusedThisRun) { sending.sources[source] = nil }
        }
        link.tell(sending: schedule.sending ?? Sending())
        try? state.writeSchedule(schedule)
        return report
    }

    private static let waits = ["DISK_FULL", "DISK_LOW"]

    static func heldForNetwork(_ row: ShipperRunRow) -> MobileData.Wait? {
        row.outcome == "held" ? row.code.flatMap(MobileData.Wait.init(rawValue:)) : nil
    }

    static func wait(of decision: MobileData.Decision) -> MobileData.Wait? {
        if case .waits(let wait) = decision { return wait }
        return nil
    }

    static func outcome(of rows: [ShipperRunRow]) -> String {
        let held = Set(rows.filter { $0.outcome == "held" }.compactMap(\.code))
        return waits.first(where: held.contains).map { "held \($0)" }
            ?? rows.last(where: { heldForNetwork($0) == nil })?.summary ?? "nothing_due"
    }

    private func stating(_ change: (inout Sending) -> Void) {
        var sending = schedule.sending ?? Sending()
        change(&sending)
        schedule.sending = sending
    }

    private func refused(_ source: String, code: String, message: String, at now: Date) {
        refusedThisRun.insert(source)
        stating { $0.failed(source, code: code, message: message, at: now) }
    }

    private func refusedByDoor(_ outcome: DeliveryOutcome, at now: Date) {
        let refused = (outcome.outcome == "refused" && !outcome.stopsTheRun) || outcome.outcome == "conflict"
        let held = outcome.outcome == "held" && outcome.code == "CLOCK_AHEAD"
        guard refused || held, let source = outcome.bundle?.sourceId else { return }
        self.refused(source, code: outcome.code ?? "REFUSED", message: outcome.message ?? "Lifestream refused a bundle", at: now)
    }

    private func loadedSchedule() -> ShippingSchedule {
        if !scheduleLoaded {
            schedule = state.readSchedule()
            scheduleLoaded = true
        }
        return schedule
    }

    private var homeFull: Bool {
        link.fresh?.needs.contains { $0.id == "disk:full" } ?? false
    }

    private func deliver(_ bundle: SealedBundle, pressed: Bool, moved: (@Sendable (Int64) -> Void)? = nil) async -> DeliveryOutcome {
        guard !homeFull else { return wait(bundle, code: "DISK_FULL", message: "Lifestream's disk is full") }
        let source = bundle.sidecar.sourceId
        if let hold = holds[source], hold.holds(bundle.sidecar, at: dependencies.clock()) {
            if hold.code == Hold.room { return wait(bundle, code: hold.code, message: hold.message) }
            _ = try? state.park(bundle)
            return DeliveryOutcome(outcome: "held", code: hold.code, message: hold.message, bundle: bundle.sidecar, left: .kept)
        }
        let bytes = Int64(state.size(of: bundle))
        do {
            let gate = moved.map { SentGate(clock: dependencies.clock, moved: $0) }
            let answer = try await link.send(bundle: bundle.file, id: bundle.sidecar.id, kind: bundle.sidecar.write,
                                             pressed: pressed, compress: true,
                                             sent: gate.map { gate in { @Sendable in gate.heard($0) } })
            gate?.ended(bytes)
            return ResourceMeter.shared.measure(.shipping(nil), units: 0) {
                ResourceMeter.shared.count(.bundlesShipped)
                ResourceMeter.shared.count(.bytesShipped, Int(bytes))
                return taken(bundle, answer: answer)
            }
        } catch is CancellationError {
            _ = try? state.park(bundle)
            return DeliveryOutcome(outcome: "held", code: Hold.cancelled, message: "the send ended with its budget", bundle: bundle.sidecar,
                                   stopsTheRun: true, left: .kept)
        } catch let failure as LinkFailure {
            switch failure {
            case .waits(let network):
                return wait(bundle, code: network.rawValue, message: network.words)
            case .stale(let answer):
                state.spend(bundle)
                return DeliveryOutcome(outcome: "stale", code: failure.code, bundle: bundle.sidecar, answer: answer, left: .spent)
            case .clockAhead:
                _ = try? state.park(bundle)
                holds[source] = Hold(until: HomeLink.Outbox.Wait.clockAhead.until(dependencies.clock()), code: failure.code,
                                     message: failure.description)
                return DeliveryOutcome(outcome: "held", code: failure.code, message: failure.description, bundle: bundle.sidecar,
                                       left: .kept)
            case .tooOld, .homeTooOld:
                _ = try? state.park(bundle)
                return DeliveryOutcome(outcome: "held", code: failure.code, message: failure.description, bundle: bundle.sidecar,
                                       stopsTheRun: true, left: .kept)
            case .refused(let status, let code, let message) where status == 413 || status == 422:
                let kept = (try? state.refuse(bundle, code: code, at: dependencies.clock())) ?? bundle
                return DeliveryOutcome(outcome: "refused", code: code, message: message, bundle: kept.sidecar, left: .kept)
            case .refused(_, let code, let message):
                _ = try? state.park(bundle)
                return DeliveryOutcome(outcome: "refused", code: code, message: message, bundle: bundle.sidecar, stopsTheRun: true,
                                       left: .kept)
            case .filesMissing(let missing):
                let hexes = Set(missing.map { $0.hasPrefix("sha256:") ? String($0.dropFirst("sha256:".count)) : $0 })
                guard dependencies.onFilesMissing(source, hexes) else {
                    state.spend(bundle)
                    return DeliveryOutcome(outcome: "held", code: failure.code, message: failure.description, bundle: bundle.sidecar,
                                           left: .spent)
                }
                _ = try? state.park(bundle)
                holds[source] = Hold(until: dependencies.clock().addingTimeInterval(Self.filesMissingHold), code: failure.code,
                                     message: failure.description)
                return DeliveryOutcome(outcome: "held", code: failure.code, message: failure.description, bundle: bundle.sidecar,
                                       left: .kept)
            case .busy(let retryAfter):
                _ = try? state.park(bundle)
                holds[source] = Hold(until: HomeLink.Outbox.Wait.busy.until(dependencies.clock(), retryAfter: retryAfter),
                                     code: failure.code, message: failure.description)
                return DeliveryOutcome(outcome: "held", code: failure.code, message: failure.description, bundle: bundle.sidecar,
                                       left: .kept)
            case .unavailable(let code, let message, let retryAfter, _) where code == Hold.room:
                if let retryAfter {
                    holds[source] = Hold(until: dependencies.clock().addingTimeInterval(retryAfter), code: code, message: message,
                                         kind: bundle.sidecar.write)
                }
                return wait(bundle, code: code, message: message)
            case .unpaired:
                _ = try? state.park(bundle)
                return DeliveryOutcome(outcome: "no_home", bundle: bundle.sidecar, stopsTheRun: true, left: .kept)
            default:
                _ = try? state.park(bundle)
                return DeliveryOutcome(outcome: "unreachable", bundle: bundle.sidecar, stopsTheRun: true, left: .kept)
            }
        } catch {
            _ = try? state.park(bundle)
            return DeliveryOutcome(outcome: "unreachable", bundle: bundle.sidecar, stopsTheRun: true, left: .kept)
        }
    }

    private func taken(_ bundle: SealedBundle, answer: FreshAnswer) -> DeliveryOutcome {
        let source = bundle.sidecar.sourceId
        guard let custody = answer.sources[source] else {
            _ = try? state.park(bundle)
            return DeliveryOutcome(outcome: "held", code: "UNSTATED", message: "Lifestream's answer does not state its source",
                                   bundle: bundle.sidecar, answer: answer, left: .kept)
        }
        guard custody.received >= bundle.sidecar.seal else {
            state.spend(bundle)
            conflicted.insert(source)
            schedule.domains[source]?.actedAt = nil
            return DeliveryOutcome(outcome: "conflict", code: "NAME_TAKEN", message: "Lifestream holds another bundle under this name",
                                   bundle: bundle.sidecar, answer: answer)
        }
        state.spend(bundle)
        consumed(bundle.sidecar)
        if let months = bundle.sidecar.months, let pass = bundle.sidecar.pass {
            link.homeKept(months: months, of: source, pass: pass)
        }
        return DeliveryOutcome(outcome: "shipped", bundle: bundle.sidecar, answer: answer)
    }

    private func wait(_ bundle: SealedBundle, code: String, message: String?) -> DeliveryOutcome {
        let page = bundle.sidecar.kind == HistoryPage.kind
        if page { state.spend(bundle) } else { _ = try? state.park(bundle) }
        return DeliveryOutcome(outcome: "held", code: code, message: message, bundle: bundle.sidecar, left: page ? .spent : .kept)
    }
}

final class SentGate: @unchecked Sendable {
    static let every: TimeInterval = 1
    static let bytes: Int64 = 1 << 20

    private let clock: @Sendable () -> Date
    private let moved: @Sendable (Int64) -> Void
    private let lock = NSLock()
    private var last: (at: Date, bytes: Int64)?

    init(clock: @escaping @Sendable () -> Date, moved: @escaping @Sendable (Int64) -> Void) {
        self.clock = clock
        self.moved = moved
    }

    func heard(_ bytes: Int64) {
        let now = clock()
        let passes = lock.withLock { () -> Bool in
            let since = last ?? (at: .distantPast, bytes: 0)
            guard now.timeIntervalSince(since.at) >= Self.every, bytes - since.bytes >= Self.bytes else { return false }
            last = (now, bytes)
            return true
        }
        if passes { moved(bytes) }
    }

    func ended(_ bytes: Int64) {
        let passes = lock.withLock { () -> Bool in
            guard last?.bytes != bytes else { return false }
            last = (clock(), bytes)
            return true
        }
        if passes { moved(bytes) }
    }
}

private struct Hold {
    static let room = "DISK_LOW"
    static let filesMissing = "FILES_MISSING"
    static let cancelled = "CANCELLED"

    let until: Date
    let code: String
    let message: String?
    var kind: WriteKind?

    func inForce(at now: Date) -> Bool { now < until }

    func holds(_ bundle: BundleSidecar, at now: Date) -> Bool {
        inForce(at: now) && (kind != .later || bundle.write == .later)
    }
}

enum Within {
    static func seconds<Value: Sendable>(_ budget: TimeInterval, _ work: @escaping @Sendable () async -> Value) async -> Value? {
        let race = Race<Value?>()
        let value = await withTaskCancellationHandler {
            await withCheckedContinuation { (ending: CheckedContinuation<Value?, Never>) in
                race.arm(ending)
                race.hold(Task { race.end(await work()) })
                race.hold(Task {
                    try? await Task.sleep(for: .seconds(max(0, budget)))
                    race.end(nil)
                })
            }
        } onCancel: {
            race.end(nil)
        }
        race.cancel()
        return value
    }

    private final class Race<Value: Sendable>: @unchecked Sendable {
        private let lock = NSLock()
        private var ending: CheckedContinuation<Value, Never>?
        private var ended: Value?
        private var runners: [Task<Void, Never>] = []
        private var cancelled = false

        func arm(_ ending: CheckedContinuation<Value, Never>) {
            let early = lock.withLock { () -> Value? in
                if ended == nil { self.ending = ending }
                return ended
            }
            if let early { ending.resume(returning: early) }
        }

        func hold(_ runner: Task<Void, Never>) {
            let cancelled = lock.withLock { () -> Bool in
                runners.append(runner)
                return self.cancelled
            }
            if cancelled { runner.cancel() }
        }

        func end(_ value: Value) {
            let ending = lock.withLock { () -> CheckedContinuation<Value, Never>? in
                guard ended == nil else { return nil }
                ended = value
                defer { self.ending = nil }
                return self.ending
            }
            ending?.resume(returning: value)
        }

        func cancel() {
            let runners = lock.withLock { () -> [Task<Void, Never>] in
                cancelled = true
                return self.runners
            }
            for runner in runners { runner.cancel() }
        }
    }
}

private final class HeldAnswer: @unchecked Sendable {
    private let lock = NSLock()
    private var held: Set<String> = []

    var value: Set<String> { lock.withLock { held } }
    func set(_ held: Set<String>) { lock.withLock { self.held = held } }
}

public enum ShipTrigger: Sendable, Equatable {
    case timer
    case manual
    case now
}

private struct DeliveryOutcome {
    let outcome: String
    var code: String?
    var message: String?
    var bundle: BundleSidecar?
    var answer: FreshAnswer?
    var stopsTheRun = false
    var left: Left?

    enum Left {
        case kept, spent
    }

    func row(domain: (any ShippingDomain)? = nil) -> ShipperRunRow {
        ShipperRunRow(outcome: outcome, code: code, message: message, domain: domain?.name,
                      source: bundle?.sourceId, bundle: bundle?.id, kind: bundle?.kind, seal: bundle?.seal)
    }
}

public struct ShipperRunRow: Sendable, Equatable {
    public let outcome: String
    public let code: String?
    public let message: String?
    public let reason: String?
    public let domain: String?
    public let source: String?
    public let bundle: String?
    public let kind: String?
    public let seal: Int?

    public init(outcome: String, code: String? = nil, message: String? = nil, reason: String? = nil,
                domain: String? = nil, source: String? = nil, bundle: String? = nil,
                kind: String? = nil, seal: Int? = nil) {
        self.outcome = outcome
        self.code = code
        self.message = message
        self.reason = reason
        self.domain = domain
        self.source = source
        self.bundle = bundle
        self.kind = kind
        self.seal = seal
    }

    init(outcome: String, code: String? = nil, message: String? = nil, reason: String? = nil,
         domain: any ShippingDomain) {
        self.init(outcome: outcome, code: code, message: message, reason: reason, domain: domain.name,
                  source: domain.sourceId)
    }

    init(failure error: any Error) {
        switch error as? LinkFailure {
        case .unpaired?: self.init(outcome: "no_home")
        case .refused(_, let code, let message)?: self.init(outcome: "refused", code: code, message: message)
        case .tooOld?, .homeTooOld?: self.init(outcome: "held", code: (error as? LinkFailure)?.code, message: "\(error)")
        default: self.init(outcome: "unreachable")
        }
    }

    static func reason(_ error: any Error) -> String {
        if let stated = error as? PathFreeError { return stated.description }
        var chain: [String] = []
        var next: NSError? = error as NSError
        while let bridged = next, chain.count < 3 {
            chain.append("\(bridged.domain) \(bridged.code)")
            next = bridged.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return chain.joined(separator: " < ")
    }

    public var summary: String { code.map { "\(outcome) \($0)" } ?? outcome }

    public var detail: [String: String] {
        var detail = ["outcome": outcome]
        if let domain { detail["domain"] = domain }
        if let source { detail["source"] = source }
        if let bundle { detail["bundle"] = bundle }
        if let kind { detail["kind"] = kind }
        if let seal { detail["seal"] = String(seal) }
        if let code { detail["code"] = code }
        if let reason { detail["reason"] = reason }
        return detail
    }
}

public struct ShipperReport: Sendable, Equatable {
    public let rows: [ShipperRunRow]
    public let outcome: String
    public let waitsFor: MobileData.Wait?
    public let unrotated: Set<String>
    public let unsettled: Set<String>
    public let ran: Set<String>

    public init(rows: [ShipperRunRow], outcome: String, waitsFor: MobileData.Wait? = nil, unrotated: Set<String> = [],
                unsettled: Set<String> = [], ran: Set<String> = []) {
        self.rows = rows
        self.outcome = outcome
        self.waitsFor = waitsFor
        self.unrotated = unrotated
        self.unsettled = unsettled
        self.ran = ran
    }
}

public struct ShipperStatus: Sendable, Equatable {
    public let home: URL?
    public let lastRunAt: Date?
    public let lastOutcome: String?
    public let lastContactAt: Date?
    public let answerAsked: Date?
    public let pending: Int
    public let nextRunAt: Date
    public let running: Bool
    public let sources: [String]
    public let needs: [HomeLink.Need]
    public let importingHistory: Bool
    public let waitsFor: MobileData.Wait?

    public var paired: Bool { home != nil }

    public init(home: URL?, lastRunAt: Date?, lastOutcome: String?, lastContactAt: Date?, answerAsked: Date? = nil, pending: Int,
                nextRunAt: Date, running: Bool, sources: [String], needs: [HomeLink.Need] = [],
                importingHistory: Bool = false, waitsFor: MobileData.Wait? = nil) {
        self.home = home
        self.lastRunAt = lastRunAt
        self.lastOutcome = lastOutcome
        self.lastContactAt = lastContactAt
        self.answerAsked = answerAsked
        self.pending = pending
        self.nextRunAt = nextRunAt
        self.running = running
        self.sources = sources
        self.needs = needs
        self.importingHistory = importingHistory
        self.waitsFor = waitsFor
    }
}

extension Shipper {
    public func knock() async -> Bool? {
        guard paired() else { return nil }
        let answered: Bool
        do {
            let asked = dependencies.clock()
            let answer = try await dependencies.settings.exchange(through: link, drain: !knockedSilent)
            lastAnswered = (asked, answer.at)
            answered = true
        } catch LinkFailure.unavailable, LinkFailure.noAnswer {
            answered = false
        } catch {
            answered = true
        }
        knockedSilent = !answered
        return answered
    }
}
