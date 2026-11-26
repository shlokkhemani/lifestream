import Foundation
import HomeLink

public struct PhoneCustody: Sendable {
    public let exporter: CaptureExporter

    public init(exporter: CaptureExporter) {
        self.exporter = exporter
    }

    var store: CaptureStore { exporter.store }

    public struct Sealed: Sendable, Equatable {
        public let bundles: [PendingBundle]
        public let satOut: [String: String]
        public let toFree: Int64?
    }

    public enum Fate: Sendable, Equatable {
        case waiting
        case delivered
        case stale
        case unsettled
    }

    public struct Judged: Sendable, Equatable {
        public let bundle: PendingBundle
        public let fate: Fate
    }

    public func pending() async throws -> [PendingBundle] {
        try await store.pendingBundles()
    }

    public func file(_ pending: PendingBundle) -> URL {
        exporter.exportsDirectory.appendingPathComponent(pending.file)
    }

    public func blobFile(_ name: String) async throws -> URL {
        try await store.blobURL(name)
    }

    @discardableResult
    public func applied(_ answer: FreshAnswer, prune: Bool = true) async throws -> [Judged] {
        var judged: [Judged] = []
        for pending in try await store.pendingBundles() {
            let fate: Fate = switch HomeLink.Outbox.judge(pass: pending.pass, seals: pending.seals, answer: answer) {
            case .covered: .delivered
            case .next: .waiting
            case .stale where pending.pass == answer.pass && pending.last.map({ !$0.answered }) == true: .unsettled
            case .stale: .stale
            }
            if fate == .delivered || fate == .stale { try await drop(pending) }
            judged.append(Judged(bundle: pending, fate: fate))
        }
        if prune { try await store.prune(pass: answer.pass, imported: answer.sources.mapValues(\.imported)) }
        return judged
    }

    public func requesting(_ pending: PendingBundle, at date: Date) async throws {
        try await store.setLast(PendingBundle.Request(heard: nil, code: nil, at: date), of: pending.id)
    }

    public func heard(_ pending: PendingBundle, _ heard: PendingBundle.Request.Heard?, code: String?, at date: Date) async throws {
        try await store.setLast(PendingBundle.Request(heard: heard, code: code, at: date), of: pending.id)
    }

    public func forget(_ pending: PendingBundle) async throws {
        try await drop(pending)
    }

    public func seal(_ answer: FreshAnswer, only: Set<String>? = nil, failing: Set<String> = [], held: Set<String> = [],
                     hardware: DeviceHardware, appVersion: String, now: Date? = nil) async throws -> Sealed {
        try await seal(pass: answer.pass, sources: answer.sources, only: only, failing: failing, held: held,
                       hardware: hardware, appVersion: appVersion, now: now)
    }

    public func seal(_ answer: SavedAnswer, only: Set<String>? = nil, failing: Set<String> = [], held: Set<String> = [],
                     hardware: DeviceHardware, appVersion: String, now: Date? = nil) async throws -> Sealed {
        try await seal(pass: answer.pass, sources: answer.sources, saved: true, only: only, failing: failing, held: held,
                       hardware: hardware, appVersion: appVersion, now: now)
    }

    public func awaitsFresh(_ answer: SavedAnswer, only: Set<String>? = nil) async throws -> Bool {
        try await !due(pass: answer.pass, sources: answer.sources, saved: true, only: only).awaiting.isEmpty
    }

    public func named(_ answer: SavedAnswer, only: Set<String>? = nil) async throws -> Set<String> {
        let plan = try await due(pass: answer.pass, sources: answer.sources, saved: false, only: only).plan
        return try await store.namedBlobs(plan.map { ($0.domain, $0.after) })
    }

    public func holdsNothingMore(_ answer: FreshAnswer) async throws -> Bool {
        guard try await store.pendingBundles().isEmpty else { return false }
        let through = try await store.capturedThrough()
        for (domain, source) in Self.sources(answer.sources) {
            let custody = answer.sources[source]!
            guard custody.imported == custody.received,
                  try await store.carried(pass: answer.pass, source: source, through: custody.received) >= through[domain] ?? 0 else { return false }
        }
        return true
    }

    public func owesMore(_ sources: Set<String>, _ answer: FreshAnswer) async throws -> Bool {
        let through = try await store.capturedThrough()
        for (domain, source) in Self.sources(answer.sources) where sources.contains(source) {
            let carried = try await store.carried(pass: answer.pass, source: source, through: answer.sources[source]!.received)
            if carried < through[domain] ?? 0 { return true }
        }
        return false
    }

    public func exportCopies(for answer: SavedAnswer, into folder: URL, hardware: DeviceHardware, appVersion: String,
                             now: Date? = nil) async throws -> [URL] {
        var plan: [SealedSource] = []
        for (domain, source) in Self.sources(answer.sources).sorted(by: { $0.key.rawValue < $1.key.rawValue }) {
            let received = answer.sources[source]!.received
            plan.append(SealedSource(domain: domain, source: source, seal: received + 1,
                                     after: try await store.carried(pass: answer.pass, source: source, through: received)))
        }
        return try await exporter.share(plan, into: folder, hardware: hardware, appVersion: appVersion, now: now).map(\.url)
    }

    public func unsent(_ answer: SavedAnswer, skipping: Set<String> = []) async throws -> (fix: Date?, other: Date?) {
        var fix: Date?, other: Date?
        func earliest(_ a: Date?, _ b: Date?) -> Date? { [a, b].compactMap { $0 }.min() }
        for (domain, source) in Self.sources(answer.sources) where !skipping.contains(source) {
            let after = try await store.carried(pass: answer.pass, source: source, through: answer.sources[source]!.received)
            let oldest = try await store.oldestUnsent(domain, after: after)
            fix = earliest(fix, oldest.fix)
            other = earliest(other, oldest.other)
        }
        return (fix, other)
    }

    public func forgetPending() async throws {
        for pending in try await store.pendingBundles() { try await drop(pending) }
    }

    public func clearImportedPhotos(_ answer: FreshAnswer) async throws {
        guard let source = Self.sources(answer.sources)[.photos], let custody = answer.sources[source] else { return }
        let through = try await store.carried(pass: answer.pass, source: source, through: custody.imported)
        try await store.clearImportedPhotos(through: through)
    }

    public func clearImportedContacts(_ answer: FreshAnswer) async throws {
        guard let source = Self.sources(answer.sources)[.contacts], let custody = answer.sources[source] else { return }
        let through = try await store.carried(pass: answer.pass, source: source, through: custody.imported)
        try await store.clearImportedContactPhotos(through: through)
    }

    public func caughtUp(_ domain: CaptureDomain, _ answer: SavedAnswer) async throws -> Bool {
        guard let source = Self.sources(answer.sources)[domain], let custody = answer.sources[source],
              custody.imported == custody.received else { return false }
        let carried = try await store.carried(pass: answer.pass, source: source, through: custody.imported)
        return try await carried >= store.capturedThrough()[domain] ?? 0
    }

    public func tidy(keeping kept: Set<String>) async throws {
        try FileDurability.createDirectoryDurably(at: exporter.exportsDirectory)
        try FileDurability.excludeFromBackup(exporter.exportsDirectory)
        var keep = kept
        for pending in try await store.pendingBundles() {
            if FileManager.default.fileExists(atPath: file(pending).path) { keep.insert(pending.file) } else { try await store.forgetPending(pending.id) }
        }
        try exporter.removeBundles(keeping: keep)
    }


    private func seal(pass: String, sources stated: [String: Answer.Custody], saved: Bool = false, only: Set<String>?,
                      failing: Set<String>, held: Set<String>, hardware: DeviceHardware, appVersion: String,
                      now: Date?) async throws -> Sealed {
        let (plan, flying, awaiting, named) = try await due(pass: pass, sources: stated, saved: saved, only: only)
        let others = only.map { Set(named.values).subtracting($0) } ?? []
        let unspoken = flying.union(awaiting).union(failing).union(others).intersection(named.values)
        let made = try await exporter.seal(plan, unspoken: unspoken, held: held, hardware: hardware, appVersion: appVersion, now: now)
        var bundles: [PendingBundle] = []
        var ranges: [CarriedRange] = []
        for bundle in made.bundles {
            for planned in plan where bundle.manifest.custody[planned.source] != nil {
                guard let file = bundle.manifest.files[planned.domain.filename],
                      let first = file.firstSequence, let last = file.lastSequence else { continue }
                ranges.append(CarriedRange(source: planned.source, seal: planned.seal, first: first, last: last))
            }
            bundles.append(PendingBundle(id: bundle.manifest.bundleID, file: bundle.url.lastPathComponent, pass: pass,
                                         seals: bundle.manifest.custody.mapValues(\.seal), files: bundle.files))
        }
        if !bundles.isEmpty { try await store.record(ranges, pass: pass, pending: bundles) }
        return Sealed(bundles: bundles, satOut: made.satOut, toFree: made.toFree)
    }

    private func due(pass: String, sources stated: [String: Answer.Custody], saved: Bool, only: Set<String>? = nil) async throws
        -> (plan: [SealedSource], flying: Set<String>, awaiting: Set<String>, named: [CaptureDomain: String]) {
        let flying = try await store.pendingBundles().reduce(into: Set<String>()) { $0.formUnion($1.sources) }
        let named = Self.sources(stated)
        var plan: [SealedSource] = []
        var awaiting = Set<String>()
        for (domain, source) in named.sorted(by: { $0.key.rawValue < $1.key.rawValue })
        where !flying.contains(source) && only?.contains(source) != false {
            let received = stated[source]!.received
            if saved, try await store.newestSeal(pass: pass, source: source).map({ $0 > received }) == true {
                awaiting.insert(source)
                continue
            }
            plan.append(SealedSource(domain: domain, source: source, seal: received + 1,
                                     after: try await store.carried(pass: pass, source: source, through: received)))
        }
        return (plan, flying, awaiting, named)
    }

    private func drop(_ pending: PendingBundle) async throws {
        try await store.forgetPending(pending.id)
        try FileDurability.removeRegularFileIfPresentDurably(at: file(pending))
    }

    public static func sources(_ stated: [String: Answer.Custody]) -> [CaptureDomain: String] {
        sources(Array(stated.keys))
    }

    static func sources(_ stated: [String]) -> [CaptureDomain: String] {
        var found: [CaptureDomain: [String]] = [:]
        for source in stated {
            let product = source.split(separator: ":", maxSplits: 1).first.map(String.init) ?? ""
            if let domain = CaptureDomain.allCases.first(where: { $0.product == product }) { found[domain, default: []].append(source) }
        }
        return found.compactMapValues { $0.count == 1 ? $0[0] : nil }
    }
}

extension CaptureDomain {
    var product: String {
        switch self {
        case .location: "location"
        case .motion: "motion"
        case .health: "apple-health"
        case .photos: "apple-photos"
        case .contacts: "apple-contacts"
        case .checkin: "checkin"
        case .notes: "notes"
        case .usage: "screen-time"
        case .voice: "voice-notes"
        case .camera: "camera"
        case .energy: "energy"
        case .upload: "upload"
        case .machine: "machine"
        }
    }
}
