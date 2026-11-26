import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

final class SendClockTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    private func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }

    func testEveryEventIsDueAtOnceAndTheNetworkOnlyWithSomethingUnsent() {
        let events: [SendClock.Event] = [.visit, .exit, .moving, .settled, .power(true), .power(false), .background, .saved, .shared, .read]
        for event in events {
            var clock = SendClock()
            XCTAssertNil(clock.next, "nothing told, nothing due")
            clock.note(event, at: at(10))
            XCTAssertEqual(clock.next, at(10), "\(event) is due at once")
        }
        var clock = SendClock()
        clock.note(.network, at: at(10))
        XCTAssertNil(clock.next, "the network back with nothing unsent sends nothing")
        clock.note(.entry, at: at(20))
        clock.note(.network, at: at(30))
        XCTAssertEqual(clock.next, at(30), "with something unsent it is due at once")
        var screen = SendClock()
        screen.note(.foreground, at: at(10))
        screen.note(.lowPower(true), at: at(11))
        XCTAssertNil(screen.next, "the app on screen and Low Power Mode change intervals, they send nothing")
    }

    func testAMovingFixIsDueAtFiveMinutesAndAnyOtherEntryAtThirtyAfterTheOldest() {
        var clock = SendClock()
        clock.note(.fix, at: at(0))
        XCTAssertEqual(clock.next, at(SendClock.MOVING_S), "a fix while the moving state is not known is a moving one")
        clock.note(.fix, at: at(100))
        XCTAssertEqual(clock.next, at(300), "the oldest unsent decides")
        clock.sent(true, at: at(300))
        clock.remaining(oldestFix: nil, oldestOther: nil)
        XCTAssertNil(clock.next)

        clock.note(.settled, at: at(400))
        clock.sent(true, at: at(401))
        clock.remaining(oldestFix: nil, oldestOther: nil)
        clock.note(.fix, at: at(500))
        XCTAssertEqual(clock.next, at(500 + SendClock.SETTLED_S), "a fix while settled waits as any other entry")
        var other = SendClock()
        other.note(.entry, at: at(0))
        XCTAssertEqual(other.next, at(SendClock.SETTLED_S))
        other.note(.moving, at: at(60))
        other.sent(true, at: at(61))
        other.remaining(oldestFix: nil, oldestOther: nil)
        other.note(.entry, at: at(100))
        XCTAssertEqual(other.next, at(100 + 1800), "moving shortens fixes only")
        other.note(.fix, at: at(200))
        XCTAssertEqual(other.next, at(200 + 300))
        XCTAssertEqual(SendClock.MOVING_S, 300)
        XCTAssertEqual(SendClock.SETTLED_S, 1800)
    }

    func testOnPowerOrOnScreenAMovingFixIsAMinuteAndLowPowerModeLengthensBothButNoEvent() {
        var power = SendClock()
        power.note(.power(true), at: at(0))
        power.sent(true, at: at(1))
        power.note(.moving, at: at(100))
        power.sent(true, at: at(101))
        power.note(.fix, at: at(200))
        XCTAssertEqual(power.next, at(200 + SendClock.POWER_S))
        power.note(.entry, at: at(250))
        XCTAssertEqual(power.next, at(260), "an other entry keeps its thirty minutes: the fix decides")

        var screen = SendClock()
        screen.note(.foreground, at: at(0))
        screen.note(.entry, at: at(10))
        XCTAssertEqual(screen.next, at(10 + 1800), "on screen, other entries still wait")
        screen.note(.fix, at: at(20))
        XCTAssertEqual(screen.next, at(20 + 60))

        var low = SendClock()
        low.note(.lowPower(true), at: at(0))
        low.note(.fix, at: at(10))
        XCTAssertEqual(low.next, at(10 + SendClock.LOW_POWER_MOVING_S))
        var lowOther = SendClock()
        lowOther.note(.lowPower(true), at: at(0))
        lowOther.note(.entry, at: at(10))
        XCTAssertEqual(lowOther.next, at(10 + SendClock.LOW_POWER_SETTLED_S))
        lowOther.note(.visit, at: at(20))
        XCTAssertEqual(lowOther.next, at(20), "an event is still at once")

        var both = SendClock()
        both.note(.lowPower(true), at: at(0))
        both.note(.power(true), at: at(1))
        both.sent(true, at: at(2))
        both.note(.fix, at: at(100))
        XCTAssertEqual(both.next, at(160), "on power the minute holds, Low Power Mode or not")
        both.note(.power(false), at: at(200))
        both.sent(true, at: at(201))
        both.note(.fix, at: at(300))
        XCTAssertEqual(both.next, at(300 + 900), "unplugged, Low Power Mode's fifteen minutes")
        XCTAssertEqual([SendClock.POWER_S, SendClock.LOW_POWER_MOVING_S, SendClock.LOW_POWER_SETTLED_S], [60, 900, 3600])
    }

    func testTheFloorHoldsAgainstAnEvent() {
        var clock = SendClock()
        clock.note(.visit, at: at(0))
        clock.sent(true, at: at(0))
        clock.remaining(oldestFix: nil, oldestOther: nil)
        clock.note(.exit, at: at(5))
        XCTAssertEqual(clock.next, at(SendClock.FLOOR_S), "sends are at least 30 s apart")
        XCTAssertEqual(SendClock.FLOOR_S, 30)
        clock.note(.settled, at: at(40))
        XCTAssertEqual(clock.next, at(30), "once the floor is past, at once")
    }

    func testASendsOwnEntriesAreNotUnsentWork() {
        XCTAssertNil(SendClock.work(.location, kind: "lifecycle"), "its outcome note")
        XCTAssertNil(SendClock.work(.energy, kind: "parts"), "its energy window")
        XCTAssertEqual(SendClock.work(.location, kind: "fix"), .fix)
        XCTAssertEqual(SendClock.work(.location, kind: "recorder_event"), .entry)
        XCTAssertEqual(SendClock.work(.health, kind: "sample"), .entry)
        XCTAssertEqual(SendClock.work(.checkin, kind: "report"), .saved, "a check-in saved is an event")
        XCTAssertEqual(SendClock.work(.notes, kind: "note"), .saved)
        XCTAssertEqual(SendClock.work(.upload, kind: "file"), .shared)
        XCTAssertEqual(SendClock.work(.photos, kind: "asset"), .read, "a photo pass that wrote")
        XCTAssertEqual(SendClock.work(.contacts, kind: "card"), .read, "a contacts pass that wrote")
        XCTAssertEqual(SendClock.work(.energy, kind: "power_state"), .entry, "only the send's own energy kind is left out")

        var clock = SendClock()
        clock.note(.visit, at: at(0))
        clock.sent(true, at: at(0))
        if let work = SendClock.work(.location, kind: "lifecycle") { clock.note(work, at: at(1)) }
        clock.remaining(oldestFix: nil, oldestOther: nil)
        XCTAssertNil(clock.next, "nothing due after a send that carried everything")
    }

    func testABackoffGrowsToThirtyMinutesResetsOnAnAnswerOrANetworkChangeAndAnEventTriesOnceThroughIt() throws {
        var clock = SendClock()
        clock.note(.entry, at: at(0))
        var start = at(1800)
        var waits: [TimeInterval] = []
        for _ in 0..<7 {
            clock.sent(false, at: start)
            clock.remaining(oldestFix: nil, oldestOther: at(0))
            let next = try XCTUnwrap(clock.next)
            waits.append(next.timeIntervalSince(start))
            start = next
        }
        XCTAssertEqual(waits, [60, 120, 240, 480, 960, 1800, 1800], "1, 2, 4, 8, 16, then 30 minutes")
        clock.sent(false, at: start)
        clock.remaining(oldestFix: nil, oldestOther: at(0))

        clock.note(.visit, at: start.addingTimeInterval(40))
        XCTAssertEqual(clock.next, start.addingTimeInterval(40), "an event tries once through the backoff")
        clock.sent(false, at: start.addingTimeInterval(40))
        clock.remaining(oldestFix: nil, oldestOther: at(0))
        clock.note(.exit, at: start.addingTimeInterval(100))
        XCTAssertEqual(clock.next, start.addingTimeInterval(40 + 1800), "only once")

        var reset = clock
        reset.note(.network, at: start.addingTimeInterval(200))
        XCTAssertLessThanOrEqual(try XCTUnwrap(reset.next), start.addingTimeInterval(200), "a change of network resets it, and something is unsent: due now")
        clock.sent(true, at: start.addingTimeInterval(1840))
        clock.remaining(oldestFix: nil, oldestOther: at(0))
        XCTAssertEqual(clock.next, start.addingTimeInterval(1840 + 30), "an answer resets it: only the floor is left")
    }

    func testAnEventToldDuringASendIsNotTakenAsCarried() {
        var clock = SendClock()
        clock.note(.visit, at: at(0))
        clock.started(at: at(5))
        clock.note(.exit, at: at(8))
        clock.note(.fix, at: at(9))
        clock.answered(true, at: at(20))
        clock.remaining(oldestFix: nil, oldestOther: nil)
        XCTAssertEqual(clock.next, at(35), "the exit is still due, after the floor")
        clock.started(at: at(35))
        clock.answered(true, at: at(36))
        clock.remaining(oldestFix: nil, oldestOther: nil)
        XCTAssertNil(clock.next, "the next send carried both: the store says nothing is left")
    }

    func testARelaunchIsPrimedByWhatTheStoreHoldsUnsent() {
        var clock = SendClock()
        clock.remaining(oldestFix: at(-240), oldestOther: at(-3600))
        XCTAssertEqual(clock.next, at(-3600 + 1800), "the oldest other entry is past its thirty minutes: due already")
        var fixes = SendClock()
        fixes.remaining(oldestFix: at(-240), oldestOther: nil)
        XCTAssertEqual(fixes.next, at(60), "five minutes after the oldest fix, without hearing it again")
        try? Self.artifact()
    }

    func testAnHourHeldIsADeadlineAndANetworkWaitIsTheNetworksOnly() {
        var clock = SendClock()
        clock.remaining(oldestFix: nil, oldestOther: nil, heldUntil: at(3600))
        XCTAssertEqual(clock.next, at(3600), "a bundle held for its hour is due when the hour ends, not before")
        clock.remaining(oldestFix: nil, oldestOther: at(0), heldUntil: at(3600))
        XCTAssertEqual(clock.next, at(1800), "other work keeps its own interval beside the hour")

        var network = SendClock()
        network.remaining(oldestFix: nil, oldestOther: nil, waitsForNetwork: true)
        XCTAssertNil(network.next, "a bundle that waits on the network is no work for the timer")
        network.note(.network, at: at(50))
        XCTAssertEqual(network.next, at(50), "a change of path or choice is due at once for it")
        var held = SendClock()
        held.remaining(oldestFix: nil, oldestOther: nil, heldUntil: at(3600))
        held.note(.network, at: at(60))
        XCTAssertEqual(held.next, at(3600), "a held bundle waits out its hour, whatever network it is on")
    }

    func testABackoffRunsFromWhenTheSendsRequestsEnded() {
        var clock = SendClock()
        clock.started(at: at(0))
        clock.answered(false, at: at(600))
        clock.remaining(oldestFix: nil, oldestOther: at(-SendClock.SETTLED_S))
        XCTAssertEqual(clock.next, at(600 + SendClock.BACKOFF_FIRST_S), "work due since the start waits a minute after the upload ended unanswered")
    }

    func testAnAskTakenBackLeavesEveryEventStanding() {
        var clock = SendClock()
        clock.note(.owed, at: at(0))
        XCTAssertEqual(clock.next, at(0), "an ask is due at once")
        clock.withdraw()
        XCTAssertNil(clock.next, "taken back, nothing is due")
        clock.note(.visit, at: at(5))
        clock.note(.owed, at: at(6))
        clock.withdraw()
        XCTAssertEqual(clock.next, at(5), "the visit stands")
        clock.started(at: at(10))
        XCTAssertEqual(clock.floor, at(10 + SendClock.FLOOR_S))
    }

    private static func artifact() throws {
        var clock = SendClock()
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        var sends: [Double] = []
        var now = start
        clock.note(.moving, at: now)
        while now < start.addingTimeInterval(86_400) {
            let moving = now < start.addingTimeInterval(3600)
            if !moving, sends.count > 0, now.timeIntervalSince(start) < 3601 { clock.note(.settled, at: now) }
            clock.note(moving ? .fix : .entry, at: now)
            if let next = clock.next, next <= now {
                sends.append(now.timeIntervalSince(start))
                clock.sent(true, at: now)
                clock.remaining(oldestFix: nil, oldestOther: nil)
            }
            now = now.addingTimeInterval(10)
        }
        let report: [String: Any] = [
            "constants": ["MOVING_S": SendClock.MOVING_S, "SETTLED_S": SendClock.SETTLED_S, "POWER_S": SendClock.POWER_S,
                          "LOW_POWER_MOVING_S": SendClock.LOW_POWER_MOVING_S, "LOW_POWER_SETTLED_S": SendClock.LOW_POWER_SETTLED_S,
                          "FLOOR_S": SendClock.FLOOR_S, "BACKOFF_FIRST_S": SendClock.BACKOFF_FIRST_S, "BACKOFF_LAST_S": SendClock.BACKOFF_LAST_S],
            "day": ["sends_moving_hour": sends.filter { $0 < 3600 }.count, "sends_settled_23h": sends.filter { $0 >= 3600 }.count],
        ]
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".build/e2e/send-clock.json")
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys, .prettyPrinted]).write(to: file)
    }

    func testTheNextSendNamesWhatDecidedItAndNeverTheFloorOrABackoff() {
        var clock = SendClock()
        XCTAssertNil(clock.cause, "nothing due, no cause")
        clock.note(.settled, at: at(0))
        clock.note(.entry, at: at(1))
        clock.note(.visit, at: at(5))
        XCTAssertEqual(clock.cause, .event(.settled), "the first event, not a later one")
        clock.started(at: at(5))
        XCTAssertNil(clock.cause, "a send carried it all: nothing is due")
        clock.note(.network, at: at(10))
        XCTAssertNil(clock.cause, "the network with nothing unsent is no cause")
        clock.note(.entry, at: at(20))
        XCTAssertEqual(clock.next, at(20 + SendClock.SETTLED_S))
        XCTAssertEqual(clock.cause, .entry, "unsent work, at its interval")
        clock.note(.network, at: at(40))
        XCTAssertEqual(clock.next, at(40))
        XCTAssertEqual(clock.cause, .event(.network), "a change of network with something unsent")
        clock.started(at: at(40))
        clock.note(.read, at: at(50))
        XCTAssertEqual(clock.next, at(70), "the floor holds it")
        XCTAssertEqual(clock.cause, .event(.read), "the floor delays it, the read is its cause")
        var moving = SendClock()
        moving.note(.fix, at: at(0))
        XCTAssertEqual(moving.cause, .fix, "a moving fix at its five minutes")
        var held = SendClock()
        held.remaining(oldestFix: nil, oldestOther: nil, heldUntil: at(3600))
        XCTAssertEqual(held.cause, .held, "a held bundle when its hour ends")
        var asked = SendClock()
        asked.note(.entry, at: at(0))
        asked.note(.owed, at: at(10))
        XCTAssertEqual(asked.cause, .ask, "an ask before the work's interval")

        var down = SendClock()
        down.remaining(oldestFix: nil, oldestOther: at(0))
        down.started(at: at(1800))
        down.answered(false, at: at(1801))
        down.remaining(oldestFix: nil, oldestOther: at(0))
        XCTAssertEqual(down.cause, .entry, "the work, at the backoff's end")
        down.note(.visit, at: at(1840))
        XCTAssertEqual(down.next, at(1840), "the visit tries through the backoff")
        XCTAssertEqual(down.cause, .event(.visit), "and is the cause, not the older work the backoff holds")
    }

    func testTheHomesRetryAfterHoldsEveryEventAndNetworkUntilASendIsAnswered() {
        var clock = SendClock()
        clock.note(.visit, at: at(0))
        clock.started(at: at(0))
        clock.answered(false, at: at(0), notBefore: at(60))
        clock.note(.visit, at: at(30))
        XCTAssertEqual(clock.next, at(60), "an ordinary event at 30 s does not send before the home's minute")
        XCTAssertEqual(clock.cause, .event(.visit), "the deadline delays it, the visit is its cause")
        clock.note(.entry, at: at(31))
        clock.note(.network, at: at(32))
        XCTAssertEqual(clock.next, at(60), "nor does a change of network, which does not erase it")
        clock.started(at: at(60))
        clock.answered(true, at: at(61))
        clock.note(.saved, at: at(100))
        XCTAssertEqual(clock.next, at(100), "an answered send ends it")

        var short = SendClock()
        short.started(at: at(0))
        short.answered(false, at: at(0), notBefore: at(45))
        short.note(.read, at: at(40))
        XCTAssertEqual(short.next, at(45), "not the minute the clock would back off")
        var mixed = SendClock()
        mixed.started(at: at(0))
        mixed.answered(false, at: at(0), notBefore: at(600))
        mixed.started(at: at(30))
        mixed.answered(false, at: at(31))
        mixed.note(.visit, at: at(40))
        XCTAssertEqual(mixed.next, at(600), "a failure with no deadline does not erase the home's")
    }

    func testFiveNotYetsWithTheSameRetryAfterBackOffPastIt() {
        var clock = SendClock()
        clock.note(.entry, at: at(-3600))
        var start = at(0)
        var waits: [TimeInterval] = []
        for _ in 0..<5 {
            clock.started(at: start)
            clock.remaining(oldestFix: nil, oldestOther: at(-3600))
            clock.answered(false, at: start, notBefore: start.addingTimeInterval(60))
            guard let next = clock.next else { return XCTFail("nothing due with an entry unsent") }
            waits.append(next.timeIntervalSince(start))
            start = next
        }
        XCTAssertEqual(waits, [60, 120, 240, 480, 960], "the door's minute is the first wait of the row, then the clock backs off")
    }

    func testAClockSetBackHoldsNothingAndReadsDoNotMoveIt() {
        let noon = at(12 * 3600), eleven = at(11 * 3600)
        var clock = SendClock()
        clock.started(at: noon)
        clock.note(.visit, at: eleven)
        XCTAssertEqual(clock.next, eleven.addingTimeInterval(SendClock.FLOOR_S), "the floor runs from 11:00, not noon")
        XCTAssertEqual(clock.floor, eleven.addingTimeInterval(SendClock.FLOOR_S))
        let first = clock.next
        for _ in 0..<3 { XCTAssertEqual(clock.next, first, "a read moves nothing") }

        var down = SendClock()
        down.note(.visit, at: noon)
        down.started(at: noon)
        down.answered(false, at: noon)
        down.note(.visit, at: noon.addingTimeInterval(10))
        down.started(at: noon.addingTimeInterval(30))
        down.answered(false, at: noon.addingTimeInterval(31))
        down.note(.visit, at: eleven)
        XCTAssertEqual(down.next, eleven.addingTimeInterval(2 * SendClock.BACKOFF_FIRST_S),
                       "the event tried through already: the second backoff, from 11:00")

        var work = SendClock()
        work.note(.entry, at: noon)
        work.note(.foreground, at: eleven)
        XCTAssertEqual(work.next, eleven.addingTimeInterval(SendClock.SETTLED_S))
        var home = SendClock()
        home.started(at: noon)
        home.answered(false, at: noon, notBefore: noon.addingTimeInterval(60))
        home.note(.visit, at: eleven)
        XCTAssertEqual(home.next, noon.addingTimeInterval(60), "the home's Retry-After stands")
    }

    func testOnlyAPathUpdateThatChangesARoadIsAChangeOfNetwork() {
        let wifi = NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: true, path: 1)
        let cellular = NetworkFacts(online: true, onLocalNetwork: false, tunnelUp: true, path: 2)
        let offline = NetworkFacts(online: false, onLocalNetwork: false, tunnelUp: true, path: 3)
        let noTunnel = NetworkFacts(online: true, onLocalNetwork: false, tunnelUp: false, path: 4)
        let again = NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: true, path: 9)
        XCTAssertFalse(again.changesRoad(from: wifi), "a path update that changes nothing")
        XCTAssertTrue(cellular.changesRoad(from: wifi), "Wi-Fi to cellular")
        XCTAssertTrue(wifi.changesRoad(from: cellular), "cellular to Wi-Fi")
        XCTAssertFalse(offline.changesRoad(from: wifi), "the network going away")
        XCTAssertTrue(cellular.changesRoad(from: offline), "the network coming back")
        XCTAssertTrue(cellular.changesRoad(from: noTunnel), "the tunnel coming up")
        XCTAssertTrue(noTunnel.changesRoad(from: cellular), "the tunnel going down while online, a fact like the others")
    }
}

private extension SendClock {
    mutating func sent(_ answered: Bool, at date: Date) {
        started(at: date)
        self.answered(answered, at: date)
    }
}
