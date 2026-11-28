import AppKit
import DeviceFiles
import XCTest
import Evidence
@testable import MachineEvents

final class MachineEventsTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("machine-events-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        DeviceFiles.writeLimit = nil
        DeviceFiles.failStep = nil
        try? FileManager.default.removeItem(at: root)
    }

    private var batches: URL { root.appendingPathComponent(MachineEventBatch.directoryName) }

    private func sources(grants: Allowed = Allowed([:]), wakes: Wakes? = nil) -> MachineEventSources {
        MachineEventSources(directory: root, files: DeviceFiles(.plain), timeZone: TimeZone(identifier: "Asia/Kolkata")!,
                            probe: wakes == nil ? SystemDeviceUseProbe() : QuietDevices(),
                            peripherals: ScriptedPeripherals(first: Peripherals(displays: [], bluetooth: [], lux: nil),
                                                             lux: [nil]),
                            grants: { grants.now }, onUserOrSystemEvent: wakes.map { wakes in { @Sendable in wakes.add() } })
    }

    private func openLog(_ state: MachineState = fullState(),
                         zone: TimeZone = TimeZone(identifier: "Asia/Kolkata")!) throws -> MachineEventLog {
        try MachineEventLog(recorderDirectory: root, files: DeviceFiles(.plain), timeZone: zone) { state }
    }

    private func lines(_ name: String) throws -> [String] {
        let text = try String(contentsOf: batches.appendingPathComponent(name), encoding: .utf8)
        return text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    }

    private static func fullState() -> MachineState {
        MachineState(awake: true, displayAwake: false, sessionActive: true, locked: true,
                     power: .battery, batteryPercent: 72, lidOpen: true,
                     wifiJoined: true, wifiName: "synthetic-network", wifiNameUnavailable: false)
    }

    private static func date(_ spelling: String) -> Date {
        guard let value = UTCInstant.date(rfc3339: spelling) else {
            fatalError("the fixture instant \(spelling) is not the spelling under test")
        }
        return value
    }


    func testEveryBatchOpensWithTheWholeState() throws {
        let log = try openLog()
        try log.append(MachineEvent(at: Self.date("2026-09-07T05:00:00.000Z"), name: .lock))
        let written = try lines(MachineEventBatch.openName)
        XCTAssertEqual(written.count, 2)
        let first = try MachineEventCodec.event(written[0])
        XCTAssertEqual(first.name, .state)
        XCTAssertEqual(first.detail, Self.fullState().detail)
        XCTAssertEqual(try MachineEventCodec.event(written[1]).name, .lock)
        XCTAssertEqual(written[1], "{\"at\":\"2026-09-07T05:00:00.000Z\",\"event\":\"lock\",\"detail\":{}}",
                       "an identical event is identical bytes: at, event, detail, UTC milliseconds")
    }


    private static let a = MachineEvent(at: date("2026-09-07T05:00:00.000Z"), name: .lock)
    private static let b = MachineEvent(at: date("2026-09-07T05:01:00.000Z"), name: .unlock)
    private static let c = MachineEvent(at: date("2026-09-07T05:02:00.000Z"), name: .sleep)

    private static func line(_ event: MachineEvent) throws -> String {
        try MachineEventCodec.line(event) + "\n"
    }

    private var openBatch: URL { batches.appendingPathComponent(MachineEventBatch.openName) }

    func testALineIsWrittenDownToTheDisksLastByte() throws {
        let log = try openLog()
        let state = MachineEvent(at: Self.a.at, name: .state, detail: Self.fullState().detail)
        let first = try Self.line(state) + Self.line(Self.a)
        DeviceFiles.writeLimit = first.utf8.count
        try log.append(Self.a)
        XCTAssertThrowsError(try log.append(Self.b)) { error in
            XCTAssertEqual(FailureLines.errno(of: error), ENOSPC)
        }
        XCTAssertEqual(try String(contentsOf: openBatch, encoding: .utf8), first)
    }

    func testALineThatFailsHalfWayIsCutBackAndTheNextFollowsWhole() throws {
        let log = try openLog()
        try log.append(Self.a)
        let before = try String(contentsOf: openBatch, encoding: .utf8)
        DeviceFiles.writeLimit = 12
        XCTAssertThrowsError(try log.append(Self.b))
        XCTAssertEqual(try String(contentsOf: openBatch, encoding: .utf8), before, "the torn half is cut back")
        DeviceFiles.writeLimit = nil
        try log.append(Self.c)
        try log.rotate()
        let sealed = try String(contentsOf: batches.appendingPathComponent("20260907T050000.000Z.jsonl"), encoding: .utf8)
        XCTAssertEqual(sealed, before + (try Self.line(Self.c)))
        let names = try sealed.split(separator: "\n").map { try MachineEventCodec.event(String($0)).name }
        XCTAssertEqual(names, [.state, .lock, .sleep])
    }

    func testABatchWhoseCutFailedIsNeverSealedUntilTheCutHolds() throws {
        let log = try openLog()
        try log.append(Self.a)
        let before = try String(contentsOf: openBatch, encoding: .utf8)
        var cutFails = true
        DeviceFiles.failStep = { url, step in url.lastPathComponent == MachineEventBatch.openName && step == .cut && cutFails ? EIO : nil }
        DeviceFiles.writeLimit = 12
        XCTAssertThrowsError(try log.append(Self.b))
        DeviceFiles.writeLimit = nil
        XCTAssertThrowsError(try log.rotate(), "a batch whose cut failed is not sealed")
        XCTAssertEqual(log.sealedBatches(), [])
        XCTAssertTrue(FileManager.default.fileExists(atPath: openBatch.path), "the batch stays open and owned")
        cutFails = false
        try log.rotate()
        XCTAssertEqual(log.sealedBatches(), ["20260907T050000.000Z.jsonl"])
        XCTAssertEqual(try String(contentsOf: batches.appendingPathComponent("20260907T050000.000Z.jsonl"), encoding: .utf8),
                       before)
        try log.append(Self.c)
        XCTAssertEqual(try lines(MachineEventBatch.openName).map { try MachineEventCodec.event($0).name }, [.state, .sleep])
    }

    func testALineWrittenButNotFlushedIsAWrittenLine() throws {
        let log = try openLog()
        var flushFails = true
        DeviceFiles.failStep = { url, step in
            url.lastPathComponent == MachineEventBatch.openName && step == .flush(.full) && flushFails ? EIO : nil
        }
        try log.append(Self.a)
        flushFails = false
        try log.append(Self.b)
        XCTAssertEqual(try lines(MachineEventBatch.openName).map { try MachineEventCodec.event($0).name },
                       [.state, .lock, .unlock])
        try log.rotate()
        XCTAssertEqual(log.sealedBatches(), ["20260907T050000.000Z.jsonl"])
    }

    func testADropStreakNotesOneLineAndOneClosingLine() throws {
        let failures = FailureLines()
        failures.configure(spool: root, plain: DeviceFiles(.plain), build: "b", pid: 1)
        let drops = LineDrops(lines: failures)
        let first = try MachineEventLog(recorderDirectory: root, files: DeviceFiles(.plain), timeZone: TimeZone(identifier: "Asia/Kolkata")!,
                                        drops: drops) { Self.fullState() }
        try FileManager.default.createDirectory(at: openBatch, withIntermediateDirectories: true)
        XCTAssertThrowsError(try first.append(Self.a))
        XCTAssertThrowsError(try first.append(Self.b))
        try FileManager.default.removeItem(at: openBatch)
        let second = try MachineEventLog(recorderDirectory: root, files: DeviceFiles(.plain), timeZone: TimeZone(identifier: "Asia/Kolkata")!,
                                         drops: drops) { Self.fullState() }
        try second.append(Self.c)
        try second.append(Self.c)
        failures.drain()
        let noted = try failureLines()
        XCTAssertEqual(noted.map { $0["event"] as? String }, ["line_dropped", "lines_written"])
        XCTAssertEqual(noted.map { $0["errno"] as? Int }, [Int(EISDIR), Int(EISDIR)])
        XCTAssertNil(noted[0]["since"])
        XCTAssertEqual(noted[1]["since"] as? String, noted[0]["at"] as? String, "the closing line carries the streak's start")
        XCTAssertEqual(noted.map { $0["part"] as? String }, ["machine_events", "machine_events"])
    }

    private func failureLines() throws -> [[String: Any]] {
        let folder = root.appendingPathComponent("resources")
        return try FileManager.default.contentsOfDirectory(atPath: folder.path).sorted().flatMap { name in
            try String(contentsOf: folder.appendingPathComponent(name), encoding: .utf8).split(separator: "\n").map {
                try XCTUnwrap(try JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])
            }
        }
    }


    func testRotationOpensTheNextBatchWithAStateLineAtTheRotationInstant() throws {
        let zone = TimeZone(identifier: "Asia/Kolkata")!
        let log = try openLog(zone: zone)
        let opened = Self.date("2026-09-06T23:00:00.000Z")
        try log.append(MachineEvent(at: opened, name: .wake))

        let rotation = MachineEventBatch.nextRotation(after: opened, in: zone)
        XCTAssertEqual(rotation, Self.date("2026-09-07T22:30:00.000Z"))
        try log.rotate()
        try log.append(MachineEvent(at: rotation, name: .state, detail: Self.fullState().detail))

        let open = try lines(MachineEventBatch.openName)
        XCTAssertEqual(open.count, 1, "the rotation state line opens the batch by itself")
        let first = try MachineEventCodec.event(open[0])
        XCTAssertEqual(first.name, .state)
        XCTAssertEqual(first.at, rotation)
        XCTAssertEqual(first.detail, Self.fullState().detail)
    }

    func testABatchSealedByRotationIsNamedByItsFirstLine() throws {
        let zone = TimeZone(identifier: "Asia/Kolkata")!
        let log = try openLog(zone: zone)
        let opened = Self.date("2026-09-06T23:00:00.000Z")
        try log.append(MachineEvent(at: opened, name: .wake))
        let rotation = MachineEventBatch.nextRotation(after: opened, in: zone)
        try log.rotate()
        try log.append(MachineEvent(at: rotation, name: .state, detail: Self.fullState().detail))

        XCTAssertEqual(log.sealedBatches(), ["20260906T230000.000Z.jsonl"])
        let sealed = try lines("20260906T230000.000Z.jsonl")
        XCTAssertEqual(sealed.count, 2)
        XCTAssertEqual(try MachineEventCodec.event(sealed[0]).name, .state)
        XCTAssertEqual(try MachineEventCodec.event(sealed[0]).at, opened)
    }

    func testAnAppendPastFourOClockSealsTheBatchUnderItsFirstLine() throws {
        let log = try openLog()
        try log.append(MachineEvent(at: Self.date("2026-09-06T23:00:00.000Z"), name: .wake))
        try log.append(MachineEvent(at: Self.date("2026-09-07T22:30:00.000Z"), name: .sleep))

        XCTAssertEqual(log.sealedBatches(), ["20260906T230000.000Z.jsonl"])
        let sealed = try lines("20260906T230000.000Z.jsonl")
        XCTAssertEqual(sealed.count, 2)
        XCTAssertEqual(try MachineEventCodec.event(sealed[0]).name, .state)
        XCTAssertEqual(try MachineEventCodec.event(sealed[1]).name, .wake)

        let open = try lines(MachineEventBatch.openName)
        XCTAssertEqual(open.count, 2)
        XCTAssertEqual(try MachineEventCodec.event(open[0]).name, .state)
        XCTAssertEqual(try MachineEventCodec.event(open[0]).at, Self.date("2026-09-07T22:30:00.000Z"))
        XCTAssertEqual(try MachineEventCodec.event(open[1]).name, .sleep)
    }

    func testRotateSealsTheOpenBatchAndLeavesAnEmptyOneAlone() throws {
        let log = try openLog()
        try log.rotate()
        XCTAssertEqual(log.sealedBatches(), [])
        try log.append(MachineEvent(at: Self.date("2026-09-07T05:00:00.000Z"), name: .recorderStop))
        try log.rotate()
        XCTAssertEqual(log.sealedBatches(), ["20260907T050000.000Z.jsonl"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: log.openBatch.path))
        try log.rotate()
        XCTAssertEqual(log.sealedBatches(), ["20260907T050000.000Z.jsonl"])
    }

    func testLaunchSealsWhatTheLastRunLeftOpen() throws {
        let first = try openLog()
        try first.append(MachineEvent(at: Self.date("2026-09-07T05:00:00.000Z"), name: .wake))

        let second = try openLog()
        XCTAssertEqual(second.sealedBatches(), ["20260907T050000.000Z.jsonl"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: second.openBatch.path))
        XCTAssertEqual(try lines("20260907T050000.000Z.jsonl").count, 2)

        try second.append(MachineEvent(at: Self.date("2026-09-07T06:00:00.000Z"), name: .sleep))
        XCTAssertEqual(second.sealedBatches(), ["20260907T050000.000Z.jsonl"])
        XCTAssertEqual(try lines(MachineEventBatch.openName).count, 2)
    }

    func testLaunchParksAnOpenBatchWhoseFirstWriteWasTornAndKeepsItOutOfTheShipperSet() throws {
        _ = try openLog()
        try "{\"at\":\"2026-09-07T05:00".write(to: batches.appendingPathComponent(MachineEventBatch.openName),
                                              atomically: true, encoding: .utf8)
        let log = try openLog()
        XCTAssertEqual(log.sealedBatches(), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: log.openBatch.path))
        let parked = try FileManager.default.contentsOfDirectory(atPath: batches.path)
        XCTAssertEqual(parked.count, 1)
        XCTAssertTrue(parked[0].hasPrefix("current.jsonl.torn-"))
        XCTAssertFalse(parked[0].hasSuffix(".jsonl"))
    }

    func testLaunchDropsAPartialLastLineBeforeSealing() throws {
        let first = try openLog()
        try first.append(MachineEvent(at: Self.date("2026-09-07T05:00:00.000Z"), name: .wake))
        let path = batches.appendingPathComponent(MachineEventBatch.openName)
        let torn = try Data(contentsOf: path) + Data("{\"at\":\"2026-09-07T06".utf8)
        try torn.write(to: path)

        let log = try openLog()
        XCTAssertEqual(log.sealedBatches(), ["20260907T050000.000Z.jsonl"])
        let sealed = try lines("20260907T050000.000Z.jsonl")
        XCTAssertEqual(sealed.count, 2)
        for line in sealed { XCTAssertNoThrow(try MachineEventCodec.event(line)) }
    }

    func testAnEmptyOpenBatchIsRemovedRatherThanSealed() throws {
        _ = try openLog()
        FileManager.default.createFile(atPath: batches.appendingPathComponent(MachineEventBatch.openName).path,
                                       contents: Data())
        let log = try openLog()
        XCTAssertEqual(log.sealedBatches(), [])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: batches.path), [])
    }


    func testAShipperRowWithNoLogOpenLandsInASealedBatchOfItsOwn() throws {
        let sources = sources()
        sources.record(shipperRun: ["outcome": "refused", "code": "LOCAL_ACCESS",
                                    "domain": "imessage", "source": "imessage:synthetic:unit-1"])
        let sealed = try waitForOneSealedBatch()
        let written = try lines(sealed)
        XCTAssertEqual(written.count, 2)
        XCTAssertEqual(try MachineEventCodec.event(written[0]).name, .state)
        let row = try MachineEventCodec.event(written[1])
        XCTAssertEqual(row.name, .shipperRun)
        XCTAssertEqual(row.detail, ["outcome": .text("refused"), "code": .text("LOCAL_ACCESS"),
                                    "domain": .text("imessage"), "source": .text("imessage:synthetic:unit-1")])
        XCTAssertTrue(written[1].contains("\"detail\":{\"code\":\"LOCAL_ACCESS\",\"domain\":\"imessage\","
                                          + "\"outcome\":\"refused\",\"source\":\"imessage:synthetic:unit-1\"}"),
                      "the detail keys are sorted, like every other line")
        XCTAssertFalse(FileManager.default.fileExists(atPath:
            batches.appendingPathComponent(MachineEventBatch.openName).path))
    }

    func testAShipperRowWhileTheLogIsOpenJoinsTheCurrentBatch() throws {
        let sources = sources()
        sources.start()
        defer { sources.stop() }
        sources.record(shipperRun: ["outcome": "shipped"])
        let row = try waitForShipperRow(in: MachineEventBatch.openName)
        XCTAssertEqual(row.detail, ["outcome": .text("shipped")])
        XCTAssertEqual(MachineEventBatch.sealedBatches(in: batches), [],
                       "an open log keeps the row in the batch it is already writing")
    }


    func testRotateSealsTheOpenBatchSoTheRunShipsIt() throws {
        let sources = sources()
        sources.start()
        defer { sources.stop() }
        sources.record(shipperRun: ["outcome": "shipped"])
        _ = try waitForShipperRow(in: MachineEventBatch.openName)
        XCTAssertEqual(MachineEventBatch.sealedBatches(in: batches), [])

        sources.rotate()

        XCTAssertEqual(MachineEventBatch.sealedBatches(in: batches).count, 1,
                       "the batch the row is in is sealed and ready to ship")
        XCTAssertFalse(FileManager.default.fileExists(atPath:
            batches.appendingPathComponent(MachineEventBatch.openName).path))
    }

    func testRotateWithNoLogOpenOrNothingWrittenSealsNothing() throws {
        let paused = sources()
        paused.rotate()
        XCTAssertEqual(MachineEventBatch.sealedBatches(in: batches), [])

        let running = sources()
        running.start()
        running.stop()
        let afterStop = MachineEventBatch.sealedBatches(in: batches)
        running.rotate()
        XCTAssertEqual(MachineEventBatch.sealedBatches(in: batches), afterStop)
    }


    func testTheStateLineStatesEachGrantAndAnAccessLineIsPinnedBytes() throws {
        var state = Self.fullState()
        state.access = ["fullDiskAccess": "not-asked", "screenRecording": "on"]
        XCTAssertEqual(state.detail["access_fullDiskAccess"], .text("not-asked"))
        XCTAssertEqual(state.detail["access_screenRecording"], .text("on"))
        XCTAssertNil(Self.fullState().detail.keys.first { $0.hasPrefix("access_") }, "grants not read state nothing")
        let line = try MachineEventCodec.line(MachineEvent(at: Self.date("2026-09-07T05:00:00.000Z"), name: .access,
                                                       detail: ["grant": .text("fullDiskAccess"), "state": .text("off")]))
        XCTAssertEqual(line, "{\"at\":\"2026-09-07T05:00:00.000Z\",\"event\":\"access\",\"detail\":{\"grant\":\"fullDiskAccess\",\"state\":\"off\"}}")
    }

    func testAGrantThatChangesWritesOneAccessLineBeforeTheRunsSeal() throws {
        let grants = Allowed(["accessibility": "on", "fullDiskAccess": "on", "microphone": "not-asked"])
        let sources = sources(grants: grants)
        sources.start()
        defer { sources.stop() }
        sources.record(shipperRun: ["outcome": "shipped"])
        _ = try waitForShipperRow(in: MachineEventBatch.openName)
        grants.now = ["accessibility": "on", "fullDiskAccess": "off", "microphone": "on"]
        sources.rotate()

        let sealed = try XCTUnwrap(MachineEventBatch.sealedBatches(in: batches).first)
        let written = try lines(sealed).map(MachineEventCodec.event)
        XCTAssertEqual(written.first?.name, .state)
        XCTAssertEqual(written.first?.detail["access_fullDiskAccess"], .text("on"), "the batch opens with the grants read at start")
        XCTAssertEqual(written.first?.detail["access_microphone"], .text("not-asked"))
        XCTAssertEqual(written.filter { $0.name == .access }.map(\.detail),
                       [["grant": .text("fullDiskAccess"), "state": .text("off")], ["grant": .text("microphone"), "state": .text("on")]],
                       "one line for each grant that changed, in the batch the run seals")

        sources.record(shipperRun: ["outcome": "nothing_new"])
        _ = try waitForShipperRow(in: MachineEventBatch.openName)
        sources.rotate()
        let next = try XCTUnwrap(MachineEventBatch.sealedBatches(in: batches).first { $0 != sealed })
        let after = try lines(next).map(MachineEventCodec.event)
        XCTAssertEqual(after.first?.detail["access_fullDiskAccess"], .text("off"), "the next batch states what the last line said")
        XCTAssertEqual(after.filter { $0.name == .access }, [], "nothing changed, no line")
    }

    private func waitForOneSealedBatch(file: StaticString = #filePath, line: UInt = #line) throws -> String {
        var sealed: [String] = []
        try until("sealed = MachineEventBatch.sealedBatches(in: batches)", file: file, line: line) {
            sealed = MachineEventBatch.sealedBatches(in: batches)
            return sealed.count == 1
        }
        return sealed[0]
    }

    private func waitForShipperRow(in name: String, file: StaticString = #filePath,
                                   line: UInt = #line) throws -> MachineEvent {
        var row: MachineEvent?
        try until("row = ((try? lines(name)) ?? []).compactMap { try? MachineEventCodec.event($0)", file: file, line: line) {
            row = ((try? lines(name)) ?? []).compactMap { try? MachineEventCodec.event($0) }.first { $0.name == .shipperRun }
            return row != nil
        }
        return try XCTUnwrap(row)
    }

    func testARequestedRotationWaitsUntilTheClockIsPastTheNewestLine() throws {
        let log = try openLog()
        XCTAssertFalse(try log.rotateIfSafe(now: Self.date("2026-09-07T05:00:00.000Z")), "nothing open, nothing sealed")
        let newest = Self.date("2026-09-07T05:00:00.000Z")
        try log.append(MachineEvent(at: newest.addingTimeInterval(-2), name: .wake))
        try log.append(MachineEvent(at: newest, name: .lock))

        XCTAssertFalse(try log.rotateIfSafe(now: newest), "the clock on the newest line's millisecond waits")
        XCTAssertFalse(try log.rotateIfSafe(now: newest.addingTimeInterval(-30)), "a clock stepped back waits")
        XCTAssertEqual(log.sealedBatches(), [])

        XCTAssertTrue(try log.rotateIfSafe(now: newest.addingTimeInterval(0.001)))
        XCTAssertEqual(log.sealedBatches(), ["20260907T045958.000Z.jsonl"])
        XCTAssertEqual(try lines("20260907T045958.000Z.jsonl").map { try MachineEventCodec.event($0).name },
                       [.state, .wake, .lock], "the trailing lock ships in the sealed batch")
        XCTAssertFalse(FileManager.default.fileExists(atPath: log.openBatch.path))
        XCTAssertFalse(try log.rotateIfSafe(now: newest.addingTimeInterval(60)), "a sealed batch is not sealed again")
    }

    func testShippingFindsNothingOwedInAnEmptyLogAndWaitsOnlyOnAnOpenBatchOnItsNewestMillisecond() throws {
        let log = try openLog()
        let newest = Self.date("2026-09-07T05:00:00.000Z")
        XCTAssertTrue(try log.rotateForShipping(now: newest), "nothing open: nothing is owed")
        try log.append(MachineEvent(at: newest, name: .lock))
        XCTAssertFalse(try log.rotateForShipping(now: newest), "an open batch on the clock's millisecond waits")
        XCTAssertTrue(try log.rotateForShipping(now: newest.addingTimeInterval(0.001)))
        XCTAssertEqual(log.sealedBatches().count, 1)
        XCTAssertTrue(try log.rotateForShipping(now: newest.addingTimeInterval(60)), "sealed and nothing open again")
        XCTAssertEqual(log.sealedBatches().count, 1)
    }

    func testABurstOnOneMillisecondRotatesOnlyOnceTheClockMovesOn() throws {
        let log = try openLog()
        let burst = Self.date("2026-09-07T05:00:00.250Z")
        try log.append(MachineEvent(at: burst, name: .sleep))
        try log.append(MachineEvent(at: burst.addingTimeInterval(0.0002), name: .displaySleep))
        XCTAssertFalse(try log.rotateIfSafe(now: burst.addingTimeInterval(0.0004)))
        try log.append(MachineEvent(at: burst.addingTimeInterval(0.0004), name: .lock))
        XCTAssertTrue(try log.rotateIfSafe(now: burst.addingTimeInterval(0.001)))
        try log.append(MachineEvent(at: burst.addingTimeInterval(0.001), name: .wake))
        try log.rotate()
        XCTAssertEqual(log.sealedBatches(), ["20260907T050000.250Z.jsonl", "20260907T050000.251Z.jsonl"],
                       "no line of the next batch shares a millisecond with the last")
    }

    func testTheSourcesRotateOnRequestOnlyPastTheNewestLine() throws {
        let sources = sources()
        sources.start()
        defer { sources.stop() }
        sources.record(shipperRun: ["outcome": "shipped"])
        let row = try waitForShipperRow(in: MachineEventBatch.openName)
        XCTAssertFalse(sources.rotateIfSafe(now: row.at))
        XCTAssertEqual(MachineEventBatch.sealedBatches(in: batches), [])
        XCTAssertTrue(sources.rotateIfSafe(now: row.at.addingTimeInterval(1)))
        XCTAssertEqual(MachineEventBatch.sealedBatches(in: batches).count, 1)
    }

    func testOnlyEventsOfTheUserOrTheSystemWake() {
        XCTAssertEqual(Set(MachineEventName.allCases.filter { !$0.isUserOrSystem }),
                       [.state, .recorderStart, .recorderStop, .shipperRun, .ambientLight],
                       "the recorder's own rows and the light sensor's timer ride along")
    }

    func testAShipperRowWakesNothingAndAWakeOrSleepDoes() throws {
        let wakes = Wakes()
        let sources = sources(wakes: wakes)
        sources.start()
        defer { sources.stop() }
        sources.record(shipperRun: ["outcome": "shipped"])
        _ = try waitForShipperRow(in: MachineEventBatch.openName)
        sources.waitUntilTold()
        XCTAssertEqual(wakes.count, 0, "neither the start line nor a shipper row wakes the shipper")

        NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.didWakeNotification, object: nil)
        try until("wakes.count == 1") { wakes.count == 1 }
        NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.willSleepNotification, object: nil)
        try until("wakes.count == 2") { wakes.count == 2 }

        sources.record(shipperRun: ["outcome": "nothing_new"])
        try until("two shipper rows") {
            ((try? lines(MachineEventBatch.openName)) ?? []).filter { $0.contains("\"shipper_run\"") }.count == 2
        }
        sources.waitUntilTold()
        XCTAssertEqual(wakes.count, 2)
    }

    func testTwoBatchesWhoseFirstLinesShareAMillisecondBothSurvive() throws {
        let log = try openLog()
        let instant = Self.date("2026-09-07T05:00:00.000Z")
        try log.append(MachineEvent(at: instant, name: .wake))
        try log.rotate()
        try log.append(MachineEvent(at: instant, name: .sleep))
        try log.rotate()
        XCTAssertEqual(log.sealedBatches(),
                       ["20260907T050000.000Z-2.jsonl", "20260907T050000.000Z.jsonl"])
    }
}

private final class QuietDevices: DeviceUseProbe, @unchecked Sendable {
    func read(at: Date) -> DeviceUse { DeviceUse(at: at, audio: nil, cameras: nil) }
    func observe(_ signal: @escaping @Sendable (DeviceUseSignal) -> Void) {}
    func stopObserving() {}
    func recheck() {}
}

final class Wakes: @unchecked Sendable {
    private let lock = NSLock()
    private var held = 0

    func add() { lock.withLock { held += 1 } }

    var count: Int { lock.withLock { held } }
}

final class Allowed: @unchecked Sendable {
    private let lock = NSLock()
    private var held: [String: String]

    init(_ held: [String: String]) { self.held = held }

    var now: [String: String] {
        get { lock.withLock { held } }
        set { lock.withLock { held = newValue } }
    }
}
