import Foundation
import XCTest
@testable import PhotoLibrary

final class MonthsTests: XCTestCase {
    private static let start = day(2026, 4, 1)
    private static let still = PhotoResource(typeRaw: 1, uti: "public.heic", originalFilename: "IMG_0001.HEIC")

    private static func day(_ year: Int, _ month: Int, _ day: Int) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar.date(from: DateComponents(year: year, month: month, day: day, hour: 12))!
    }

    private static func photo(_ id: String, _ taken: Date?) -> PhotoSnapshot {
        PhotoSnapshot(localIdentifier: id, creationDate: taken, modificationDate: day(2026, 6, 1), resources: [still])
    }

    private static func bytes(_ ids: String...) -> Int64 {
        ids.reduce(0) { $0 + Int64(Data("\($1)/IMG_0001.HEIC".utf8).count) }
    }

    private static let library: [(String, Date?)] = [
        ("MAY-A/L0/001", day(2026, 5, 20)), ("MAY-B/L0/001", day(2026, 5, 2)), ("MARCH/L0/001", day(2026, 3, 9)),
        ("DECEMBER/L0/001", day(2025, 12, 31)), ("UNDATED/L0/001", nil),
    ]

    private static func made() -> SyntheticLibrary {
        let synthetic = SyntheticLibrary()
        for (id, taken) in library { synthetic.put(photo(id, taken)) }
        return synthetic
    }

    private static func run(_ pass: PhotoPass, page: Int = 3, background: Bool = false,
                            from start: Date = start) async -> PhotoPass.Report? {
        let mac = Device(pastMoves: true, iCloud: true, charging: true, spare: 95_000_000_000, changeRoom: nil, page: page)
        let home = PhotoPass.Home(caughtUp: true, start: start, wanted: { _ in
            PhotosWanted(photos: [], settled: [], left: .init(wanted: 0, unavailable: 0, bytes: 0))
        })
        return await pass.run(.init(seconds: 60, background: background), device: mac, bringingIn: false, home: home)
    }

    private static func listed(_ bytes: [String: Int64?]) -> [String: PhotoMonth] {
        let items = ["2026-05": 2, "2026-03": 1, "2025-12": 1, "undated": 1]
        return items.reduce(into: [:]) { months, month in
            months[month.key] = PhotoMonth(items: month.value, bytes: bytes[month.key] ?? nil)
        }
    }

    func testMonthsHoldEveryPhotosMonthAtTheFirstPassAndBytesAsTheReadReachesThemBelowTheStartToo() async throws {
        let synthetic = Self.made()
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)

        let first = await Self.run(pass)
        let reached = Self.listed(["2026-05": Self.bytes("MAY-A/L0/001", "MAY-B/L0/001")])
        XCTAssertEqual(first?.stated?.months, reached,
                       "every photo's month at the first pass; bytes for the month read, null for the month under way and the rest")
        XCTAssertEqual(first?.stated?.left, 2)
        XCTAssertEqual(first?.stated?.start, Self.start)
        let read = await pass.state().months
        XCTAssertEqual(read, reached, "kept with the pass state")

        let ended = await Self.run(pass)
        let whole = Self.listed([
            "2026-05": Self.bytes("MAY-A/L0/001", "MAY-B/L0/001"), "2026-03": Self.bytes("MARCH/L0/001"),
            "2025-12": Self.bytes("DECEMBER/L0/001"), "undated": Self.bytes("UNDATED/L0/001"),
        ])
        XCTAssertEqual(ended?.stated?.months, whole, "every month's bytes once the read ends, below the start too")
        XCTAssertEqual(ended?.stated?.left, 0)
        XCTAssertFalse(store.entries.contains { $0.replayKey.hasPrefix("photos:DECEMBER/") }, "counted, never stated")
        XCTAssertEqual(synthetic.listings, 1, "one listing for the whole read")

        let again = await Self.run(pass)
        XCTAssertEqual(again?.stated?.months, whole)
        XCTAssertEqual(synthetic.listings, 1, "at most daily")
        try Self.artifact("months-read.json", ["first": Self.wire(reached), "ended": Self.wire(whole)])
    }

    func testAStartMovedEarlierKeepsTheLastCountedBytesOfEveryMonthTheRereadHasNotReached() async throws {
        let synthetic = Self.made()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: MemoryStore())
        let read = await Self.run(pass, page: 5)
        let whole = Self.listed([
            "2026-05": Self.bytes("MAY-A/L0/001", "MAY-B/L0/001"), "2026-03": Self.bytes("MARCH/L0/001"),
            "2025-12": Self.bytes("DECEMBER/L0/001"), "undated": Self.bytes("UNDATED/L0/001"),
        ])
        XCTAssertEqual(read?.stated?.months, whole)

        let reread = await Self.run(pass, page: 2, from: Self.day(2025, 1, 1))
        XCTAssertEqual(reread?.paged, true, "the earlier start begins a whole read again")
        XCTAssertEqual(reread?.stated?.months, whole,
                       "the month the reread reached from its tally, every other from the last count that finished")
        let state = await pass.state()
        XCTAssertNotEqual(state.unread, 0, "the reread is under way")
        try Self.artifact("months-reread.json", Self.wire(whole))
    }

    func testTheListingIsReadAgainAfterADayAndAWholeReadBegunListsAtOnce() async throws {
        let synthetic = Self.made()
        let clock = Clock(Self.day(2026, 6, 1))
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: MemoryStore(), now: { clock.now })
        _ = await Self.run(pass, page: 5)
        synthetic.put(Self.photo("JUNE/L0/001", Self.day(2026, 6, 1)))
        clock.now = clock.now.addingTimeInterval(23 * 3_600)
        let soon = await Self.run(pass, page: 5)
        XCTAssertEqual(synthetic.listings, 1)
        XCTAssertNil(soon?.stated?.months["2026-06"], "the listing waits a day")

        clock.now = clock.now.addingTimeInterval(3_600)
        let daily = await Self.run(pass, page: 5)
        XCTAssertEqual(synthetic.listings, 2)
        XCTAssertEqual(daily?.stated?.months["2026-06"], PhotoMonth(items: 1, bytes: 0),
                       "a new month counted daily; a read that ended saw none of its bytes")
    }

    func testADeviceThatReadWholeBeforeMonthsListsAndRereadsOnceForItsBytes() async throws {
        let synthetic = Self.made()
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
        _ = await Self.run(pass, page: 5)
        var state = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(store.readState())) as? [String: Any])
        XCTAssertNotNil(state.removeValue(forKey: "months"))
        try store.writeState(JSONSerialization.data(withJSONObject: state))
        let written = store.entries.count

        let woken = await Self.run(pass, page: 5, background: true)
        XCTAssertEqual(woken?.paged, true, "a whole read again, in a background wake too")
        XCTAssertEqual(woken?.stated?.months.values.allSatisfy({ $0.bytes != nil }), true)
        XCTAssertEqual(store.entries.count, written, "nothing written twice")
        let after = await Self.run(pass, page: 5)
        XCTAssertEqual([after?.paged, after?.read == 0], [false, true], "once")
    }

    private static func wire(_ months: [String: PhotoMonth]) -> [String: [Any]] {
        months.mapValues { [$0.items, $0.bytes.map { $0 as Any } ?? NSNull()] }
    }

    private static func artifact(_ name: String, _ object: Any) throws {
        let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent(".build/e2e", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]).write(to: folder.appendingPathComponent(name))
    }
}

private final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date

    init(_ start: Date) { current = start }

    var now: Date {
        get { lock.withLock { current } }
        set { lock.withLock { current = newValue } }
    }
}
