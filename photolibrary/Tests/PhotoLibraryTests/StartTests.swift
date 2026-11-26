import Foundation
import XCTest
@testable import PhotoLibrary

final class StartTests: XCTestCase {
    private static let start = Date(timeIntervalSince1970: 1_779_235_200)
    private static let earlier = start.addingTimeInterval(-30 * 86_400)
    private static let still = PhotoResource(typeRaw: 1, uti: "public.heic", originalFilename: "IMG_0001.HEIC")

    private static func photo(_ id: String, days: Double?, edited: Double = 0) -> PhotoSnapshot {
        let taken = days.map { start.addingTimeInterval($0 * 86_400) }
        return PhotoSnapshot(localIdentifier: id, creationDate: taken,
                             modificationDate: start.addingTimeInterval(400 * 86_400 + edited), resources: [still])
    }

    private static func home(_ start: Date?) -> PhotoPass.Home {
        PhotoPass.Home(caughtUp: true, start: start, wanted: { _ in
            PhotosWanted(photos: [], settled: [], left: .init(wanted: 0, unavailable: 0, bytes: 0))
        })
    }

    private static func mac(page: Int = 1_000) -> Device {
        Device(pastMoves: true, iCloud: true, charging: true, spare: 95_000_000_000, changeRoom: nil, page: page)
    }

    private static func ids(_ store: MemoryStore, _ kind: PhotoEntry.Kind) -> [String] {
        store.entries.filter { $0.kind == kind }.map { String($0.replayKey.split(separator: ":")[1]) }
    }

    private static func run(_ pass: PhotoPass, _ start: Date?, page: Int = 1_000) async -> PhotoPass.Report? {
        await pass.run(.init(seconds: 60), device: mac(page: page), bringingIn: false, home: home(start))
    }

    func testAPassStatesNoPhotoBeforeTheStartAndEveryUndatedOne() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.put(Self.photo("NEW/L0/001", days: 10))
        synthetic.put(Self.photo("EDGE/L0/001", days: 0))
        synthetic.put(Self.photo("OLD/L0/001", days: -10))
        synthetic.put(Self.photo("UNDATED/L0/001", days: nil))
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)

        let read = await Self.run(pass, Self.start)
        XCTAssertEqual(read?.read, 4, "the whole library is walked")
        XCTAssertEqual(Set(Self.ids(store, .asset)), ["NEW/L0/001", "EDGE/L0/001", "UNDATED/L0/001"],
                       "at or after the start, and undated")
        assertEqual(await pass.state().readFrom, Self.start)

        synthetic.put(Self.photo("IMPORTED/L0/001", days: -20))
        synthetic.put(Self.photo("TAKEN/L0/001", days: 20))
        let changed = await Self.run(pass, Self.start)
        XCTAssertEqual(changed?.snapshots, 1)
        XCTAssertEqual(Set(Self.ids(store, .asset)), ["NEW/L0/001", "EDGE/L0/001", "UNDATED/L0/001", "TAKEN/L0/001"],
                       "a photo added with an older date is not stated")
        try Self.artifact("start-states-from.json", Self.ids(store, .asset))
    }

    func testAChangeBelowTheStartIsNotStatedButTheGoneOfAPhotoItWroteIs() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.put(Self.photo("NEW/L0/001", days: 10))
        synthetic.put(Self.photo("OLD/L0/001", days: -10))
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
        _ = await Self.run(pass, nil)
        XCTAssertEqual(Self.ids(store, .asset), ["NEW/L0/001", "OLD/L0/001"], "under all, every photo")

        synthetic.put(Self.photo("OLD/L0/001", days: -10, edited: 60))
        synthetic.put(Self.photo("NEW/L0/001", days: 10, edited: 60))
        synthetic.put(Self.photo("NEVER/L0/001", days: -5))
        let edited = await Self.run(pass, Self.start)
        XCTAssertEqual(edited?.paged, false, "a start moved later reads nothing again")
        XCTAssertEqual(Self.ids(store, .asset), ["NEW/L0/001", "OLD/L0/001", "NEW/L0/001"], "only the edit above the start")

        synthetic.delete("OLD/L0/001")
        synthetic.delete("NEVER/L0/001")
        let deleted = await Self.run(pass, Self.start)
        XCTAssertEqual(deleted?.gone, 1)
        XCTAssertEqual(Self.ids(store, .gone), ["OLD/L0/001"], "the gone of a photo it wrote, none for one it never stated")
        try Self.artifact("start-gone.json", store.entries.map { "\($0.kind.rawValue) \($0.replayKey)" })
    }

    func testAStartMovedEarlierRereadsOnceAndStatesWhatItLeftOut() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.put(Self.photo("NEW/L0/001", days: 10))
        synthetic.put(Self.photo("OLD/L0/001", days: -10))
        synthetic.put(Self.photo("OLDEST/L0/001", days: -40))
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
        _ = await Self.run(pass, Self.start)
        XCTAssertEqual(Self.ids(store, .asset), ["NEW/L0/001"])
        assertEqual(await pass.state().mark?.complete, true)

        let reread = await Self.run(pass, Self.earlier)
        XCTAssertEqual(reread?.paged, true, "a whole read again")
        XCTAssertEqual(reread?.read, 3)
        XCTAssertEqual(Self.ids(store, .asset), ["NEW/L0/001", "OLD/L0/001"],
                       "what the later start left out, and nothing written twice")
        assertEqual(await pass.state().readFrom, Self.earlier)
        assertEqual(await pass.state().mark?.complete, true)

        let again = await Self.run(pass, Self.earlier)
        XCTAssertEqual([again?.paged, again?.read == 0], [false, true], "once")
    }

    func testAStartMovedLaterStatesNothingNewBelowItAndKeepsWhatItHolds() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.put(Self.photo("NEW/L0/001", days: 10))
        synthetic.put(Self.photo("OLD/L0/001", days: -10))
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
        _ = await Self.run(pass, Self.earlier)
        XCTAssertEqual(Self.ids(store, .asset), ["NEW/L0/001", "OLD/L0/001"])

        let later = await Self.run(pass, Self.start)
        XCTAssertEqual([later?.paged, later?.read == 0, later?.gone == 0], [false, true, true], "nothing read, nothing gone")
        assertEqual(await pass.state().readFrom, Self.earlier, "no page ran under the later start yet")

        synthetic.put(Self.photo("BETWEEN/L0/001", days: -5))
        _ = await Self.run(pass, Self.start)
        XCTAssertEqual(Self.ids(store, .asset), ["NEW/L0/001", "OLD/L0/001"], "nothing new below it")
        assertEqual(await pass.state().readFrom, Self.start, "the later start, from the next page on")
    }

    func testAStartMovedLaterWithNoChangeStatesTheNewStart() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.put(Self.photo("NEW/L0/001", days: 10))
        synthetic.put(Self.photo("OLD/L0/001", days: -10))
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: MemoryStore())
        let read = await Self.run(pass, Self.earlier)
        XCTAssertEqual(read?.stated?.start, Self.earlier)

        let later = await Self.run(pass, Self.start)
        XCTAssertEqual(later?.read, 0, "no change in the library")
        XCTAssertEqual(later?.stated?.start, Self.start, "the start the home lent, not the one the read ran under")
        XCTAssertEqual(later?.stated?.left, 0)

        let moved = Self.earlier.addingTimeInterval(-86_400)
        let owed = await pass.run(.init(seconds: 60), device: Self.mac(), bringingIn: false, home: PhotoPass.Home(
            caughtUp: false, start: moved, wanted: { _ in PhotosWanted(photos: [], settled: [], left: .init(wanted: 0, unavailable: 0, bytes: 0)) }))
        XCTAssertEqual(owed?.paged, false, "the home has not caught up: the reread waits")
        XCTAssertEqual(owed?.stated?.start, moved)
        XCTAssertNil(owed?.stated?.left, "a reread is owed: no left goes out under the new start")
    }

    func testAStartMovedLaterMidReadThenBackStatesTheGap() async throws {
        let synthetic = SyntheticLibrary()
        for (id, days) in [("A", 10.0), ("B", 5), ("C", -5), ("D", -10), ("E", -40)] {
            synthetic.put(Self.photo("\(id)/L0/001", days: days))
        }
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
        _ = await Self.run(pass, Self.earlier, page: 2)
        _ = await Self.run(pass, Self.start, page: 2)
        XCTAssertEqual(Self.ids(store, .asset), ["A/L0/001", "B/L0/001"], "the second page ran under the later start")
        assertEqual(await pass.state().readFrom, Self.start)

        for _ in 0..<4 { _ = await Self.run(pass, Self.earlier, page: 2) }
        XCTAssertEqual(Self.ids(store, .asset), ["A/L0/001", "B/L0/001", "C/L0/001", "D/L0/001"],
                       "moved back, the gap is read: the read began again")
        assertEqual(await pass.state().readFrom, Self.earlier)
        assertEqual(await pass.state().mark?.complete, true)
        try Self.artifact("start-gap.json", Self.ids(store, .asset))
    }

    func testADeviceThatReadEverythingBeforeThisHasNoReadFromAndReadsNothingAgain() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.put(Self.photo("NEW/L0/001", days: 10))
        synthetic.put(Self.photo("OLD/L0/001", days: -10))
        let store = MemoryStore()
        let pass = PhotoPass(library: PhotoLibrary(synthetic), store: store)
        _ = await Self.run(pass, nil)
        let state = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(store.readState())) as? [String: Any])
        XCTAssertNil(state["read_from"], "all is no member, as a state written before this")
        assertNil(await pass.state().readFrom)

        for start in [Self.start, Self.earlier] {
            let report = await Self.run(pass, start)
            XCTAssertEqual([report?.paged, report?.read == 0], [false, true], "it reads as all: nothing is walked again")
        }
        XCTAssertEqual(Self.ids(store, .asset), ["NEW/L0/001", "OLD/L0/001"])
    }

    private static func artifact(_ name: String, _ object: Any) throws {
        let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent(".build/e2e", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]).write(to: folder.appendingPathComponent(name))
    }
}

private func assertEqual<T: Equatable>(_ actual: T, _ expected: T, _ message: String = "",
                                       file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(actual, expected, message, file: file, line: line)
}

private func assertNil<T>(_ actual: T?, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertNil(actual, message, file: file, line: line)
}
