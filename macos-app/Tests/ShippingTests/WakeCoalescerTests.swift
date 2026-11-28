import XCTest
@testable import Shipping

final class WakeCoalescerTests: XCTestCase {
    private static let now = Date(timeIntervalSince1970: 1_790_000_000)

    private static let matrix: [(source: String, ac: WakeCoalescer.Window, battery: WakeCoalescer.Window, lowPower: WakeCoalescer.Window)] = [
        ("whatsapp:15550000001:macbook-pro-0001", .init(1.5, 5), .init(3, 10), .init(15, 45)),
        ("imessage:person-a@example.com:macbook-pro-0001", .init(1.5, 5), .init(3, 10), .init(15, 45)),
        ("apple-calls:person-a@example.com:macbook-pro-0001", .init(1.5, 5), .init(3, 10), .init(15, 45)),
        ("wispr-flow:person-a@example.com:macbook-pro-0001", .init(1.5, 5), .init(3, 10), .init(15, 45)),
        ("aqua-voice:person-a:macbook-pro-0001", .init(1.5, 5), .init(3, 10), .init(15, 45)),
        ("claude-code:local:macbook-pro-0001", .init(2, 6), .init(5, 15), .init(30, 60)),
        ("codex:local:macbook-pro-0001", .init(2, 6), .init(5, 15), .init(30, 60)),
        ("apple-notes:person-a@example.com:macbook-pro-0001", .init(3, 10), .init(10, 30), .init(30, 90)),
        ("apple-reminders:person-a@example.com:macbook-pro-0001", .init(3, 10), .init(10, 30), .init(30, 90)),
        ("apple-calendar:person-a@example.com:macbook-pro-0001", .init(3, 10), .init(10, 30), .init(30, 90)),
        ("chrome:default:macbook-pro-0001", .init(5, 15), .init(15, 30), .init(60, 120)),
        ("safari:local:macbook-pro-0001", .init(5, 15), .init(15, 30), .init(60, 120)),
        ("audio:local:macbook-pro-0001", .init(2, 2), .init(5, 5), .init(30, 30)),
        ("upload:local:macbook-pro-0001", .init(3.5, 5), .init(5, 5), .init(30, 30)),
        ("machine:local:macbook-pro-0001", .init(15, 15), .init(30, 30), .init(60, 60)),
        ("screen:local:macbook-pro-0001", .init(0, 0), .init(0, 0), .init(120, 120)),
        ("input:local:macbook-pro-0001", .init(0, 0), .init(60, 120), .init(120, 120)),
        ("apple-photos:person-a@example.com:macbook-pro-0001", .init(5, 15), .init(15, 30), .init(60, 60)),
    ]

    func testEveryStreamClassHasItsDebounceAndMaxWaitOnEveryPower() {
        for row in Self.matrix {
            let stream = WakeCoalescer.streamClass(of: row.source)
            XCTAssertEqual(WakeCoalescer.window(stream, power: .ac), row.ac, row.source)
            XCTAssertEqual(WakeCoalescer.window(stream, power: .battery), row.battery, row.source)
            XCTAssertEqual(WakeCoalescer.window(stream, power: .lowPower), row.lowPower, row.source)
        }
        for power in PowerMode.allCases {
            XCTAssertNil(WakeCoalescer.window(WakeCoalescer.streamClass(of: "screen-time:person-a@example.com:macbook-pro-0001"), power: power),
                         "Biome keeps its own timer")
        }
    }

    func testOneEventIsDueAtItsDebounceOnEveryPower() {
        for row in Self.matrix {
            for (power, window) in [(PowerMode.ac, row.ac), (.battery, row.battery), (.lowPower, row.lowPower)] {
                var coalescer = WakeCoalescer()
                coalescer.note(row.source, at: Self.now)
                XCTAssertEqual(coalescer.nextDeadline(power: power), Self.now.addingTimeInterval(window.debounce),
                               "\(row.source) \(power)")
                if window.debounce > 0 {
                    XCTAssertEqual(coalescer.takeDue(at: Self.now.addingTimeInterval(window.debounce - 0.1), power: power), [],
                                   "\(row.source) \(power) waits its debounce")
                }
                XCTAssertEqual(coalescer.takeDue(at: Self.now.addingTimeInterval(window.debounce), power: power), [row.source])
                XCTAssertTrue(coalescer.isEmpty, "a taken source is clean")
            }
        }
    }

    func testABurstPushesTheDebounceOutButNeverPastTheMaxWait() {
        let source = "whatsapp:15550000001:macbook-pro-0001"
        var coalescer = WakeCoalescer()
        for step in stride(from: 0.0, through: 4.0, by: 1.0) {
            coalescer.note(source, at: Self.now.addingTimeInterval(step))
        }
        XCTAssertEqual(coalescer.deadline(of: source, power: .ac), Self.now.addingTimeInterval(5), "1.5 s after the last is past 5 s: the max wait")
        XCTAssertEqual(coalescer.takeDue(at: Self.now.addingTimeInterval(4.9), power: .ac), [])

        var short = WakeCoalescer()
        short.note(source, at: Self.now)
        short.note(source, at: Self.now.addingTimeInterval(1))
        XCTAssertEqual(short.deadline(of: source, power: .ac), Self.now.addingTimeInterval(2.5), "a second event moves the debounce")
        short.note(source, at: Self.now.addingTimeInterval(0.5))
        XCTAssertEqual(short.deadline(of: source, power: .ac), Self.now.addingTimeInterval(2.5), "an older event never pulls it back")
    }

    func testSourcesDirtyTogetherAreTakenOnlyWhenEachIsDue() {
        var coalescer = WakeCoalescer()
        let messages = "imessage:person-a@example.com:macbook-pro-0001"
        let browsing = "chrome:default:macbook-pro-0001"
        let screen = "screen:local:macbook-pro-0001"
        coalescer.note([messages, browsing, screen], at: Self.now)
        XCTAssertEqual(coalescer.nextDeadline(power: .ac), Self.now)
        XCTAssertEqual(coalescer.takeDue(at: Self.now, power: .ac), [screen], "a settled segment is due at once on power")
        XCTAssertEqual(coalescer.takeDue(at: Self.now.addingTimeInterval(1.5), power: .ac), [messages])
        XCTAssertEqual(coalescer.dirtySources(), [browsing], "a later one is kept")
        XCTAssertEqual(coalescer.nextDeadline(power: .ac), Self.now.addingTimeInterval(5))
        XCTAssertEqual(coalescer.takeDue(at: Self.now.addingTimeInterval(5), power: .ac), [browsing])
        XCTAssertNil(coalescer.nextDeadline(power: .ac))
    }

    func testScreenAndInputAreImmediateOnPowerInputWaitsOnBatteryAndBothWaitInLowPower() {
        let screen = "screen:local:macbook-pro-0001", input = "input:local:macbook-pro-0001"
        var coalescer = WakeCoalescer()
        coalescer.note([screen, input], at: Self.now)
        XCTAssertEqual(coalescer.deadline(of: screen, power: .ac), Self.now)
        XCTAssertEqual(coalescer.deadline(of: input, power: .ac), Self.now)
        XCTAssertEqual(coalescer.deadline(of: screen, power: .battery), Self.now)
        XCTAssertEqual(coalescer.deadline(of: input, power: .battery), Self.now.addingTimeInterval(60))
        coalescer.note(input, at: Self.now.addingTimeInterval(90))
        XCTAssertEqual(coalescer.deadline(of: input, power: .battery), Self.now.addingTimeInterval(120), "never past two minutes on battery")
        XCTAssertEqual(coalescer.deadline(of: screen, power: .lowPower), Self.now.addingTimeInterval(120))
        XCTAssertEqual(coalescer.deadline(of: input, power: .lowPower), Self.now.addingTimeInterval(120))
    }

    func testTheFastSourcesAreTheLiveStoresAndRecordersButNeverTheDropFolderPhotosScreenOrBiome() {
        var coalescer = WakeCoalescer()
        coalescer.note(Set(Self.matrix.map(\.source)), at: Self.now)
        coalescer.note("screen-time:person-a@example.com:macbook-pro-0001", at: Self.now)
        XCTAssertFalse(coalescer.dirtySources().contains("screen-time:person-a@example.com:macbook-pro-0001"), "Biome is never dirty")
        let fast = coalescer.dirtyFastSources()
        XCTAssertFalse(fast.contains("apple-photos:person-a@example.com:macbook-pro-0001"))
        XCTAssertFalse(fast.contains("screen:local:macbook-pro-0001"))
        XCTAssertFalse(fast.contains("upload:local:macbook-pro-0001"), "the drop folder ships behind the live ones, never in a flush")
        XCTAssertEqual(fast, Set(Self.matrix.map(\.source)).subtracting(["apple-photos:person-a@example.com:macbook-pro-0001",
                                                                       "screen:local:macbook-pro-0001", "upload:local:macbook-pro-0001"]))
    }

    func testABatchWhoseRotationIsOwedIsKeptDirtyAndATakenOneIsClean() {
        let machine = "machine:local:macbook-pro-0001", messages = "imessage:person-a@example.com:macbook-pro-0001"
        var coalescer = WakeCoalescer()
        coalescer.note([machine, messages], at: Self.now)
        coalescer.clear([messages], heardBy: Self.now)
        XCTAssertEqual(coalescer.dirtySources(), [machine])
        XCTAssertEqual(coalescer.takeDue(at: Self.now.addingTimeInterval(15), power: .ac), [machine])
        coalescer.requeue([machine], at: Self.now.addingTimeInterval(15))
        XCTAssertEqual(coalescer.deadline(of: machine, power: .ac), Self.now.addingTimeInterval(30), "the rotation is asked again at the next wake")
    }

    func testAFlushClearsOnlyWhatWasHeardBeforeItStarted() {
        let messages = "imessage:person-a@example.com:macbook-pro-0001", notes = "apple-notes:person-a@example.com:macbook-pro-0001"
        var coalescer = WakeCoalescer()
        coalescer.note([messages, notes], at: Self.now)
        coalescer.note(notes, at: Self.now.addingTimeInterval(1))
        coalescer.clear([messages, notes], heardBy: Self.now.addingTimeInterval(0.5))
        XCTAssertEqual(coalescer.dirtySources(), [notes], "a change heard while the flush ran is still owed")
    }

    func testADroppedFileIsSettledByItsFirstWakeOnPower() {
        let window = WakeCoalescer.window(.upload, power: .ac)!
        XCTAssertGreaterThan(window.debounce, UploadDomain.settle)
    }

    func testTheSafetySweepIsAQuarterHourOnPowerAndHalfAnHourOtherwise() {
        XCTAssertEqual(WakeCoalescer.sweepInterval(.ac), 15 * 60)
        XCTAssertEqual(WakeCoalescer.sweepInterval(.battery), 30 * 60)
        XCTAssertEqual(WakeCoalescer.sweepInterval(.lowPower), 30 * 60)
    }
}
