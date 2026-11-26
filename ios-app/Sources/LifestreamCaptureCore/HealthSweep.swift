import Foundation
import HomeLink

public struct HealthPage: Sendable {
    public var drafts: [CaptureDraft]
    public var samples: Int
    public var deletions: Int
    public var anchor: Data

    public init(drafts: [CaptureDraft], samples: Int, deletions: Int, anchor: Data) {
        self.drafts = drafts; self.samples = samples; self.deletions = deletions; self.anchor = anchor
    }
}

public enum HealthSweep {
    public static func run(
        store: CaptureStore, type: String, start: Date?, anchor: Data?, past: MobileData.Decision,
        now: Date = AppClock.now, calendar: Calendar = .current,
        isolation: isolated (any Actor)? = #isolation,
        read: (_ anchor: Data?, _ from: Date?) async throws -> HealthPage,
        committed: (_ page: HealthPage, _ firstYield: Bool) async -> Void
    ) async throws -> (samples: Int, deletions: Int) {
        let anchorKey = HealthAsk.anchorPrefix + type
        let yieldKey = HealthAsk.yieldedPrefix + type
        let startKey = HealthAsk.startPrefix + type
        let kept = try await keptStart(store, startKey)
        var anchor = anchor
        if anchor != nil, past.moves, HistoryStart.earlier(start, than: kept) { anchor = nil }
        let from = anchor != nil ? HistoryStart.later(kept, start)
            : past.moves ? start : HistoryStart.later(start, calendar.startOfDay(for: now))
        var yielded = try await store.anchor(yieldKey) != nil
        var samples = 0
        var deletions = 0
        while true {
            let page = try await read(anchor, from)
            guard !page.drafts.isEmpty else { break }
            let firstYield = !yielded && page.samples > 0
            var anchors: [String: Data?] = [anchorKey: page.anchor, startKey: from.map(encode)]
            if firstYield { anchors[yieldKey] = Data([1]) }
            try await store.appendBatch(domain: .health, drafts: page.drafts, anchors: anchors)
            yielded = yielded || firstYield
            anchor = page.anchor
            samples += page.samples
            deletions += page.deletions
            EnergyLedger.shared.count("health_pages")
            if page.samples > 0 { EnergyLedger.shared.count("health_samples", page.samples) }
            if page.deletions > 0 { EnergyLedger.shared.count("health_deletions", page.deletions) }
            await committed(page, firstYield)
        }
        EnergyLedger.shared.count("health_sweeps")
        return (samples, deletions)
    }

    private static func keptStart(_ store: CaptureStore, _ key: String) async throws -> Date? {
        try await store.anchor(key).flatMap { Double(String(decoding: $0, as: UTF8.self)) }
            .map { Date(timeIntervalSince1970: $0 / 1000) }
    }

    private static func encode(_ start: Date) -> Data {
        Data(String(Int64((start.timeIntervalSince1970 * 1000).rounded())).utf8)
    }
}
