import Evidence
import DeviceFiles
import Foundation
import XCTest
@testable import InputEvents

final class InputEventRotationTests: XCTestCase {
    private var root: URL!
    private let zone = TimeZone(identifier: "Asia/Kolkata")!
    private var clock: SteppedClock!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("input-rotation-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        clock = SteppedClock(Synthetic.opened)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var folder: URL { root.appendingPathComponent(InputEventBatch.directoryName) }
    private var openBatch: URL { folder.appendingPathComponent(InputEventBatch.openName) }
    private var openChunk: URL { folder.appendingPathComponent(InputEventBatch.chunkName) }

    private func log(_ source: FakeSource) -> InputEventLog {
        let log = InputEventLog(directory: root, files: DeviceFiles(.plain), modes: RecordingModes(), timeZone: zone, report: { _ in },
                                source: source, reader: FakeReader(), clock: clock.clock)
        addTeardownBlock { log.stop() }
        return log
    }

    private func click(_ source: FakeSource, at: Date) {
        clock.set(at)
        source.push(Synthetic.raw(.leftMouseUp, at: at))
    }

    private func chunks(in name: String) throws -> [InputChunk] {
        try String(contentsOf: folder.appendingPathComponent(name), encoding: .utf8)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .dropLast()
            .map { try InputEventCodec.chunk(String($0)) }
    }

    private func basic(_ date: Date) -> String { UTCInstant.basic(date) }

    func testARotationMidMinuteLeavesTheOpenMinuteAndTheNextLineOpensANewBatch() throws {
        let source = FakeSource()
        let log = log(source)
        log.start()
        click(source, at: Synthetic.opened.addingTimeInterval(5))
        click(source, at: Synthetic.minute.addingTimeInterval(10))
        try until("log.status.chunks == 1 && log.status.events == 2") { log.status.chunks == 1 && log.status.events == 2 }
        let openMinute = try Data(contentsOf: openChunk)
        XCTAssertFalse(openMinute.isEmpty)

        log.rotate()

        XCTAssertEqual(try Data(contentsOf: openChunk), openMinute, "the open minute is not touched")
        XCTAssertFalse(FileManager.default.fileExists(atPath: openBatch.path))
        let first = "\(basic(Synthetic.opened)).jsonl"
        XCTAssertEqual(InputEventBatch.sealedBatches(in: folder), [first])
        XCTAssertEqual(try chunks(in: first).map(\.at), [Synthetic.opened])

        click(source, at: Synthetic.minute.addingTimeInterval(70))
        try until("log.status.chunks == 2") { log.status.chunks == 2 }
        XCTAssertEqual(try chunks(in: first).map(\.at), [Synthetic.opened], "a sealed batch never changes")
        let open = try String(contentsOf: openBatch, encoding: .utf8).split(separator: "\n")
        XCTAssertEqual(open.count, 1)
        XCTAssertEqual(try InputEventCodec.chunk(String(open[0])).at, Synthetic.minute)

        log.stop()
        let second = "\(basic(Synthetic.minute)).jsonl"
        XCTAssertEqual(InputEventBatch.sealedBatches(in: folder), [first, second])
        XCTAssertEqual(try chunks(in: second).map(\.at),
                       [Synthetic.minute, Synthetic.minute.addingTimeInterval(60)])
    }

    func testTwoRotationsWithNothingBetweenSealOneBatch() throws {
        let source = FakeSource()
        let log = log(source)
        log.start()
        log.rotate()
        XCTAssertEqual(InputEventBatch.sealedBatches(in: folder), [], "no chunk line yet: nothing is sealed")
        XCTAssertFalse(FileManager.default.fileExists(atPath: openBatch.path))

        click(source, at: Synthetic.opened.addingTimeInterval(5))
        click(source, at: Synthetic.minute.addingTimeInterval(5))
        try until("log.status.chunks == 1") { log.status.chunks == 1 }
        log.rotate()
        log.rotate()
        XCTAssertEqual(InputEventBatch.sealedBatches(in: folder), ["\(basic(Synthetic.opened)).jsonl"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: openBatch.path))
        log.stop()
    }

    func testARotationIntoATakenNameTakesTheNextSuffix() throws {
        let taken = "\(basic(Synthetic.opened)).jsonl"
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let earlier = #"{"at":"2026-09-23T09:00:00.000Z","until":"2026-09-23T09:01:00.000Z","layout":"com.apple.keylayout.US","apps":[],"events":[]}"# + "\n"
        try Data(earlier.utf8).write(to: folder.appendingPathComponent(taken))

        let source = FakeSource()
        let log = log(source)
        log.start()
        click(source, at: Synthetic.opened.addingTimeInterval(5))
        click(source, at: Synthetic.minute.addingTimeInterval(5))
        try until("log.status.chunks == 1") { log.status.chunks == 1 }
        log.rotate()

        XCTAssertEqual(InputEventBatch.sealedBatches(in: folder), ["\(basic(Synthetic.opened))-2.jsonl", taken])
        XCTAssertEqual(try String(contentsOf: folder.appendingPathComponent(taken), encoding: .utf8), earlier,
                       "the batch already there is not overwritten")
        XCTAssertEqual(try chunks(in: "\(basic(Synthetic.opened))-2.jsonl").map(\.at), [Synthetic.opened])
        log.stop()
    }

    func testRotationsDuringChunkClosesNeverTearOrRepeatALine() throws {
        let source = FakeSource()
        let log = log(source)
        log.start()
        let minutes = 60
        let rotating = RotationLoop(log)
        rotating.start()
        for index in 0..<minutes {
            click(source, at: Synthetic.minute.addingTimeInterval(Double(index) * 60 + 1))
        }
        try until("log.status.events == minutes") { log.status.events == minutes }
        rotating.finish()
        log.stop()
        XCTAssertGreaterThan(rotating.count, 0)

        let batches = InputEventBatch.sealedBatches(in: folder)
        XCTAssertGreaterThan(batches.count, 1, "the loop sealed batches while the log wrote")
        var all: [InputChunk] = []
        for name in batches {
            let bytes = try Data(contentsOf: folder.appendingPathComponent(name))
            XCTAssertEqual(bytes.last, 0x0A, "\(name) ends on a whole line")
            all += try chunks(in: name)
        }
        let expected = [Synthetic.opened] + (0..<minutes).map { Synthetic.minute.addingTimeInterval(Double($0) * 60) }
        XCTAssertEqual(all.map(\.at), expected, "each minute once, in order")
        XCTAssertEqual(all.flatMap(\.events).filter { $0.body.name == .up }.count, minutes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: openBatch.path))
    }

    func testARotationClosesAMinuteWhoseBoundaryPassedBeforeSealing() throws {
        let source = FakeSource()
        let log = log(source)
        log.start()
        click(source, at: Synthetic.opened.addingTimeInterval(5))
        try until("log.status.events == 1") { log.status.events == 1 }
        clock.set(Synthetic.minute.addingTimeInterval(30 * 60 + 20))

        log.rotate()

        let first = "\(basic(Synthetic.opened)).jsonl"
        XCTAssertEqual(InputEventBatch.sealedBatches(in: folder), [first])
        let sealed = try chunks(in: first)
        XCTAssertEqual(sealed.map(\.at), [Synthetic.opened])
        XCTAssertEqual(sealed.first?.until, Synthetic.minute)
        XCTAssertEqual(try Data(contentsOf: openChunk).count, 0, "the closed minute left the open file")
        log.stop()
    }

    func testARotationOfAStoppedLogDoesNothing() throws {
        let source = FakeSource()
        let log = log(source)
        log.rotate()
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
        log.start()
        click(source, at: Synthetic.opened.addingTimeInterval(5))
        try until("log.status.events == 1") { log.status.events == 1 }
        log.stop()
        let sealed = InputEventBatch.sealedBatches(in: folder)
        log.rotate()
        XCTAssertEqual(InputEventBatch.sealedBatches(in: folder), sealed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: openBatch.path))
    }

    func testAWrittenMinuteSaysSoOnlyOnceItsLineIsInTheOpenBatch() throws {
        let written = WrittenLines()
        let batch = openBatch
        let files = try InputEventFiles(recorderDirectory: root, files: DeviceFiles(.plain), timeZone: zone,
                                        chunkWritten: { written.add((try? Data(contentsOf: batch)) ?? Data()) })
        files.chunkOpened(at: Synthetic.opened, layout: "us")
        files.chunkClosed(nil)
        XCTAssertEqual(written.seen, [], "an idle minute writes no line and says nothing")

        files.chunkOpened(at: Synthetic.minute, layout: "us")
        files.chunkClosed(InputChunk(at: Synthetic.minute, until: Synthetic.minute.addingTimeInterval(40), layout: "us",
                                     apps: [], events: [], lost: 3))
        XCTAssertEqual(written.seen.count, 1)
        let line = try XCTUnwrap(String(data: try XCTUnwrap(written.seen.first), encoding: .utf8))
        XCTAssertEqual(try InputEventCodec.chunk(String(line.dropLast())).at, Synthetic.minute,
                       "the open batch held the minute's line when it said so")
        files.close()
    }

    func testTheLogSaysAMinuteWasWrittenWhenItCloses() throws {
        let source = FakeSource()
        let written = WrittenLines()
        let log = InputEventLog(directory: root, files: DeviceFiles(.plain), modes: RecordingModes(), timeZone: zone,
                                report: { _ in }, source: source, reader: FakeReader(), clock: clock.clock,
                                onChunkWritten: { written.add(Data()) })
        addTeardownBlock { log.stop() }
        log.start()
        click(source, at: Synthetic.opened.addingTimeInterval(5))
        try until("log.status.events == 1") { log.status.events == 1 }
        log.waitUntilTold()
        XCTAssertEqual(written.seen.count, 0, "a minute still open says nothing")
        click(source, at: Synthetic.minute.addingTimeInterval(10))
        try until("one written minute told") { written.seen.count == 1 }
        clock.set(Synthetic.minute.addingTimeInterval(30))
        log.rotate()
        log.waitUntilTold()
        XCTAssertEqual(written.seen.count, 1, "a rotation inside the open minute writes no line")
    }
}

final class WrittenLines: @unchecked Sendable {
    private let lock = NSLock()
    private var held: [Data] = []

    func add(_ batch: Data) { lock.withLock { held.append(batch) } }

    var seen: [Data] { lock.withLock { held } }
}

final class SteppedClock: @unchecked Sendable {
    private let lock = NSLock()
    private var now: Date

    init(_ start: Date) { now = start }

    func set(_ date: Date) { lock.withLock { now = date } }

    var clock: InputEventClock {
        InputEventClock(now: { [self] in lock.withLock { now } },
                        uptime: { ProcessInfo.processInfo.systemUptime })
    }
}

final class RotationLoop: @unchecked Sendable {
    private let log: InputEventLog
    private let lock = NSLock()
    private var running = true
    private var rotations = 0
    private let done = DispatchSemaphore(value: 0)

    init(_ log: InputEventLog) { self.log = log }

    var count: Int { lock.withLock { rotations } }

    func start() {
        Thread.detachNewThread { [self] in
            while lock.withLock({ running }) {
                log.rotate()
                lock.withLock { rotations += 1 }
            }
            done.signal()
        }
    }

    func finish() {
        lock.withLock { running = false }
        done.wait()
    }
}
