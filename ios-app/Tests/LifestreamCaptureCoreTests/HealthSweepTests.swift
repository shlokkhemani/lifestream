import Foundation
import HomeLink
import Synchronization
import XCTest

@testable import LifestreamCaptureCore

final class HealthSweepTests: XCTestCase {
    private let type = "HKQuantityTypeIdentifierStepCount"
    private var anchorKey: String { HealthAsk.anchorPrefix + type }
    private var yieldKey: String { HealthAsk.yieldedPrefix + type }
    private var startKey: String { HealthAsk.startPrefix + type }
    private let lately = Date(timeIntervalSince1970: 1_790_985_600)
    private let longAgo = Date(timeIntervalSince1970: 1_700_006_400)

    func testASweepThatFindsNothingWritesNothing() async throws {
        let store = try await CaptureStore.restored(root: try temporaryDirectory())
        let health = FakeHealthKit(history: [], limit: 2)
        let before = await store.transactions
        for _ in 0..<2 {
            let counts = try await sweep(store, health)
            XCTAssertEqual(counts.samples, 0)
            XCTAssertEqual(counts.deletions, 0)
        }
        let after = await store.transactions
        XCTAssertEqual(after - before, 0, "an empty sweep opens no transaction")
        let anchor = try await store.anchor(anchorKey)
        XCTAssertNil(anchor, "an empty page's anchor is not saved")
        let entries = try await store.entries(domain: .health)
        XCTAssertEqual(entries, [])
        let asked = await health.asked
        XCTAssertEqual(asked, [nil, nil], "a type that never yields is read from nil each sweep")
    }

    func testEachPageIsOneTransactionAndTheNextSweepReadsFromItsAnchor() async throws {
        let store = try await CaptureStore.restored(root: try temporaryDirectory())
        let health = FakeHealthKit(history: [.sample("a"), .sample("b"), .sample("c"), .deletion("a")], limit: 2)
        let pages = Mutex(0)
        let before = await store.transactions
        let counts = try await sweep(store, health) { _, _ in pages.withLock { $0 += 1 } }
        let after = await store.transactions
        XCTAssertEqual(counts.samples, 3)
        XCTAssertEqual(counts.deletions, 1)
        XCTAssertEqual(after - before, 2, "two pages, two transactions; the empty third none")
        XCTAssertEqual(pages.withLock { $0 }, 2)
        let entries = try await store.entries(domain: .health)
        XCTAssertEqual(entries.map(\.kind), ["sample", "sample", "sample", "deleted_sample"])
        let anchor = try await store.anchor(anchorKey)
        XCTAssertEqual(anchor, FakeHealthKit.anchor(4), "the last page's anchor, not the empty page's moved one")

        let again = try await sweep(store, health, from: anchor)
        XCTAssertEqual(again.samples + again.deletions, 0)
        let asked = await health.asked
        XCTAssertEqual(asked.last, FakeHealthKit.anchor(4), "the second sweep reads from the stored anchor")
        let afterAgain = await store.transactions
        XCTAssertEqual(afterAgain, after, "and writes nothing")
        let anchorAgain = try await store.anchor(anchorKey)
        XCTAssertEqual(anchorAgain, FakeHealthKit.anchor(4))
    }

    func testADeletionOnlyPageCommitsItsDeletionAndAnchorAndNoYieldMark() async throws {
        let store = try await CaptureStore.restored(root: try temporaryDirectory())
        let health = FakeHealthKit(history: [.deletion("gone")], limit: 2)
        let yields = Mutex<[Bool]>([])
        let before = await store.transactions
        let counts = try await sweep(store, health) { _, first in yields.withLock { $0.append(first) } }
        let after = await store.transactions
        XCTAssertEqual(counts.deletions, 1)
        XCTAssertEqual(after - before, 1)
        XCTAssertEqual(yields.withLock { $0 }, [false])
        let entries = try await store.entries(domain: .health)
        XCTAssertEqual(entries.map(\.kind), ["deleted_sample"])
        let anchor = try await store.anchor(anchorKey)
        XCTAssertEqual(anchor, FakeHealthKit.anchor(1))
        let yielded = try await store.anchor(yieldKey)
        XCTAssertNil(yielded, "a deletion is no sample: the type has not yielded")
    }

    func testAPageTheStoreRefusesWritesNothingAndTheNextRunWritesIt() async throws {
        let root = try temporaryDirectory()
        let free = Mutex<Int64?>(999_999_999)
        let store = try await CaptureStore.restored(root: root, volume: Volume(root, every: 0, read: { _ in free.withLock { $0 } }))
        let health = FakeHealthKit(history: [.sample("a")], limit: 2)
        do {
            _ = try await sweep(store, health)
            XCTFail("a page saved on a full disk")
        } catch { XCTAssertEqual(error as? CaptureError, .full) }
        let entries = try await store.entries(domain: .health)
        XCTAssertEqual(entries, [])
        let anchor = try await store.anchor(anchorKey)
        XCTAssertNil(anchor)
        let yielded = try await store.anchor(yieldKey)
        XCTAssertNil(yielded)

        free.withLock { $0 = nil }
        let counts = try await sweep(store, health, from: try await store.anchor(anchorKey))
        XCTAssertEqual(counts.samples, 1)
        let asked = await health.asked
        XCTAssertEqual(asked, [nil, nil, FakeHealthKit.anchor(1)], "the retry reads from the old anchor")
        let written = try await store.entries(domain: .health)
        XCTAssertEqual(written.map(\.kind), ["sample"])
        let after = try await store.anchor(anchorKey)
        XCTAssertEqual(after, FakeHealthKit.anchor(1))
    }

    func testAReadThatFailsOnItsSecondPageKeepsTheFirstAndTheRetryStartsThere() async throws {
        let store = try await CaptureStore.restored(root: try temporaryDirectory())
        let health = FakeHealthKit(history: [.sample("a"), .sample("b"), .sample("c")], limit: 2)
        await health.fail(atRead: 2)
        do {
            _ = try await sweep(store, health)
            XCTFail("the second page's failure passed")
        } catch { XCTAssertTrue(error is FakeHealthKit.Failed) }
        let entries = try await store.entries(domain: .health)
        XCTAssertEqual(entries.count, 2, "the first page stands")
        let anchor = try await store.anchor(anchorKey)
        XCTAssertEqual(anchor, FakeHealthKit.anchor(2))

        let counts = try await sweep(store, health, from: anchor)
        XCTAssertEqual(counts.samples, 1)
        let asked = await health.asked
        XCTAssertEqual(asked[2], FakeHealthKit.anchor(2), "the retry starts from the first page's anchor")
        let all = try await store.entries(domain: .health)
        XCTAssertEqual(all.count, 3, "nothing of the failed page was written, so nothing is stated twice")
    }

    func testTheFirstSampleSetsTheYieldMarkInItsPagesTransactionOnce() async throws {
        let store = try await CaptureStore.restored(root: try temporaryDirectory())
        let health = FakeHealthKit(history: [.sample("a"), .sample("b"), .sample("c")], limit: 2)
        let before = await store.transactions
        let seen = Mutex<[(first: Bool, marked: Bool, transactions: Int)]>([])
        _ = try await HealthSweep.run(
            store: store, type: type, start: nil, anchor: nil, past: .moves(.any),
            read: { anchor, _ in try await health.page(after: anchor) },
            committed: { _, first in
                let marked = (try? await store.anchor(self.yieldKey)) != nil
                let transactions = await store.transactions - before
                seen.withLock { $0.append((first, marked, transactions)) }
            })
        let pages = seen.withLock { $0 }
        XCTAssertEqual(pages.map(\.first), [true, false], "firstYield said once")
        XCTAssertEqual(pages.map(\.marked), [true, true])
        XCTAssertEqual(pages.map(\.transactions), [1, 2], "the mark rides the first page's transaction")

        await health.add(.sample("d"))
        let later = Mutex<[Bool]>([])
        _ = try await sweep(store, health, from: try await store.anchor(anchorKey)) { _, first in later.withLock { $0.append(first) } }
        XCTAssertEqual(later.withLock { $0 }, [false], "a later sweep's sample is not the type's first")
    }

    func testAStartMovedEarlierDropsTheTypesAnchorAndSweepsFromTheNewStart() async throws {
        let store = try await CaptureStore.restored(root: try temporaryDirectory())
        let health = FakeHealthKit(history: [.sample("a"), .sample("b")], limit: 2)
        _ = try await sweep(store, health, start: lately)
        let anchor = try await store.anchor(anchorKey)
        XCTAssertEqual(anchor, FakeHealthKit.anchor(2))
        let kept = try await store.anchor(startKey)
        XCTAssertEqual(kept, Self.ms(lately), "the anchor is kept with the start it read under, in its page's transaction")

        let counts = try await sweep(store, health, from: anchor, start: longAgo)
        let asked = await health.asked
        XCTAssertEqual(Array(asked.suffix(2)), [nil, FakeHealthKit.anchor(2)], "an earlier start reads from no anchor")
        XCTAssertEqual(counts.samples, 2)
        let after = try await store.anchor(startKey)
        XCTAssertEqual(after, Self.ms(longAgo), "the anchor now stands under the earlier start")

        _ = try await sweep(store, health, from: try await store.anchor(anchorKey), start: nil)
        let all = await health.asked
        XCTAssertNil(all[all.count - 2], "a start of all is earlier than any day")
        let none = try await store.anchor(startKey)
        XCTAssertNil(none, "an anchor read under all keeps no start")
    }

    func testAStartMovedLaterKeepsTheAnchorAndALaterMoveBackReadsTheGap() async throws {
        let store = try await CaptureStore.restored(root: try temporaryDirectory())
        let health = FakeHealthKit(history: [.sample("a")], limit: 2)
        _ = try await sweep(store, health, start: longAgo)

        await health.add(.sample("b"))
        let anchor = try await store.anchor(anchorKey)
        _ = try await sweep(store, health, from: anchor, start: lately)
        let asked = await health.asked
        XCTAssertEqual(asked[asked.count - 2], FakeHealthKit.anchor(1), "a later start keeps the anchor; its predicate takes the start")
        let kept = try await store.anchor(startKey)
        XCTAssertEqual(kept, Self.ms(lately), "the anchor keeps the latest start a page of it read under")

        _ = try await sweep(store, health, from: try await store.anchor(anchorKey), start: longAgo)
        let again = await health.asked
        XCTAssertNil(again[again.count - 2], "moved back, the days the later start skipped are read again")
        let back = try await store.anchor(startKey)
        XCTAssertEqual(back, Self.ms(longAgo))
    }

    func testAnAnchorKeptWithNoStartReadsAsAllAndIsNotDropped() async throws {
        let store = try await CaptureStore.restored(root: try temporaryDirectory())
        let health = FakeHealthKit(history: [.sample("a")], limit: 2)
        let anchor = FakeHealthKit.anchor(1)
        try await store.setAnchor(anchorKey, anchor)
        await health.add(.sample("b"))
        _ = try await sweep(store, health, from: anchor, start: lately)
        let asked = await health.asked
        XCTAssertEqual(asked.first, anchor, "an anchor from before the start read everything, so no start drops it")
        let kept = try await store.anchor(startKey)
        XCTAssertEqual(kept, Self.ms(lately))
        let entries = try await store.entries(domain: .health)
        XCTAssertEqual(entries.count, 1, "only what came after the anchor")
    }

    func testAStartMovedEarlierBeforeAnyPageKeepsReadingFromNoAnchor() async throws {
        let store = try await CaptureStore.restored(root: try temporaryDirectory())
        let health = FakeHealthKit(history: [.sample("a")], limit: 2)
        _ = try await sweep(store, health, start: lately)
        let anchor = try await store.anchor(anchorKey)
        let empty = FakeHealthKit(history: [], limit: 2)
        _ = try await sweep(store, empty, from: anchor, start: longAgo)
        let kept = try await store.anchor(startKey)
        XCTAssertEqual(kept, Self.ms(lately), "an empty read commits nothing")
        _ = try await sweep(store, empty, from: anchor, start: longAgo)
        let asked = await empty.asked
        XCTAssertEqual(asked, [nil, nil], "so the next sweep under the earlier start reads from no anchor again")
    }

    private static func ms(_ date: Date) -> Data { Data(String(Int64(date.timeIntervalSince1970 * 1000)).utf8) }

    private static let costly = MobileData.Moment(path: .costly, choice: .now, loopback: false, pressed: false).past
    private static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()
    private var today: Date { lately.addingTimeInterval(2 * 86_400) }

    func testAFirstReadWhileThePastWaitsSendsTodayAndTheOlderSpanGoesOnceThePastMayMove() async throws {
        let store = try await CaptureStore.restored(root: try temporaryDirectory())
        let health = FakeHealthKit(history: [.sample("a")], limit: 2)
        let now = today.addingTimeInterval(15 * 3_600)
        let held = try await sweep(store, health, start: longAgo, past: Self.costly, now: now)
        XCTAssertEqual(held.samples, 1, "today's samples go while the past waits")
        let spans = await health.spans
        XCTAssertEqual(spans, [today, today], "a first read on a costly path reads from the start of today")
        let kept = try await store.anchor(startKey)
        XCTAssertEqual(kept, Self.ms(today), "the anchor stands under today, so the older span is still owed")

        await health.add(.sample("b"))
        let anchor = try await store.anchor(anchorKey)
        let more = try await sweep(store, health, from: anchor, start: longAgo, past: Self.costly, now: now)
        XCTAssertEqual(more.samples, 1, "what is recorded later goes on the same path")
        let anchored = await health.asked
        XCTAssertEqual(anchored[anchored.count - 2], anchor, "it reads on from its anchor")

        let wifi = try await sweep(store, health, from: try await store.anchor(anchorKey), start: longAgo, now: now)
        let asked = await health.asked
        XCTAssertNil(asked[asked.count - 2], "once the past may move, the type is read again from no anchor")
        let all = await health.spans
        XCTAssertEqual(all.suffix(2), [longAgo, longAgo], "under the start the home asked for")
        XCTAssertEqual(wifi.samples, 2, "the older span goes")
        let after = try await store.anchor(startKey)
        XCTAssertEqual(after, Self.ms(longAgo))
    }

    func testAStartMovedEarlierWhileThePastWaitsReadsOnFromItsAnchorAndRereadsOnceThePastMayMove() async throws {
        let store = try await CaptureStore.restored(root: try temporaryDirectory())
        let health = FakeHealthKit(history: [.sample("a")], limit: 2)
        _ = try await sweep(store, health, start: lately)
        let anchor = try await store.anchor(anchorKey)
        XCTAssertEqual(anchor, FakeHealthKit.anchor(1))

        await health.add(.sample("b"))
        let held = try await sweep(store, health, from: anchor, start: longAgo, past: Self.costly)
        XCTAssertEqual(held.samples, 1, "today's samples go while the past waits")
        let asked = await health.asked
        XCTAssertEqual(asked[asked.count - 2], anchor, "the stored anchor is kept and read on from")
        let spans = await health.spans
        XCTAssertEqual(spans.suffix(2), [lately, lately], "under the start it was read under")
        let kept = try await store.anchor(startKey)
        XCTAssertEqual(kept, Self.ms(lately), "so the earlier start is still owed")

        let wifi = try await sweep(store, health, from: try await store.anchor(anchorKey), start: longAgo)
        let reread = await health.asked
        XCTAssertNil(reread[reread.count - 2], "once the past may move, the earlier start rereads from no anchor")
        XCTAssertEqual(wifi.samples, 2, "the older span goes")
        let after = try await store.anchor(startKey)
        XCTAssertEqual(after, Self.ms(longAgo))
    }

    private func sweep(
        _ store: CaptureStore, _ health: FakeHealthKit, from anchor: Data? = nil, start: Date? = nil,
        past: MobileData.Decision = .moves(.any), now: Date = AppClock.now,
        committed: @escaping @Sendable (HealthPage, Bool) -> Void = { _, _ in }
    ) async throws -> (samples: Int, deletions: Int) {
        try await HealthSweep.run(
            store: store, type: type, start: start, anchor: anchor, past: past, now: now, calendar: Self.utc,
            read: { try await health.page(after: $0, from: $1) },
            committed: { page, first in committed(page, first) })
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("lifestream-health-sweep-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
}

actor FakeHealthKit {
    enum Change: Sendable {
        case sample(String)
        case deletion(String)
    }

    struct Failed: Error {}

    private var history: [Change]
    private let limit: Int
    private var failAt: Int?
    private(set) var asked: [Data?] = []
    private(set) var spans: [Date?] = []

    init(history: [Change], limit: Int) {
        self.history = history
        self.limit = limit
    }

    static func anchor(_ position: Int) -> Data { Data("position \(position)".utf8) }

    private static func position(_ anchor: Data?) -> Int {
        guard let anchor else { return 0 }
        return Int(String(decoding: anchor, as: UTF8.self).dropFirst("position ".count)) ?? 0
    }

    func fail(atRead read: Int) { failAt = read }

    func add(_ change: Change) { history.append(change) }

    func page(after anchor: Data?, from: Date? = nil) throws -> HealthPage {
        asked.append(anchor)
        spans.append(from)
        if asked.count == failAt {
            failAt = nil
            throw Failed()
        }
        let start = Self.position(anchor)
        let changes = start < history.count ? Array(history[start..<min(start + limit, history.count)]) : []
        guard !changes.isEmpty else {
            return HealthPage(drafts: [], samples: 0, deletions: 0, anchor: Self.anchor(max(start, history.count) + 1))
        }
        var drafts: [CaptureDraft] = []
        var samples = 0
        var deletions = 0
        for change in changes {
            switch change {
            case .sample(let id):
                samples += 1
                drafts.append(.init(kind: "sample", observedAt: "2026-08-14T10:00:00Z", payload: .object(["uuid": .string(id)])))
            case .deletion(let id):
                deletions += 1
                drafts.append(.init(kind: "deleted_sample", observedAt: "2026-08-14T10:00:00Z", payload: .object(["uuid": .string(id)])))
            }
        }
        return HealthPage(drafts: drafts, samples: samples, deletions: deletions, anchor: Self.anchor(start + changes.count))
    }
}
