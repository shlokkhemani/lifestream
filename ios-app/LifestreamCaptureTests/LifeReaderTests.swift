import AVFoundation
import Combine
import Foundation
import HomeLink
import LifestreamCaptureCore
import XCTest

@testable import Lifestream

@MainActor
final class LifeReaderTests: XCTestCase {
    private var folder: URL!
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let fires = Fires()

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("life-reader-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testAReadThatSpannedATripIsAskedAgainAndItsAnswerReachesTheScreenWithReachUntouched() async throws {
        let (life, door, link) = try await paired()
        door.steps = [
            { _ in link.inFront(false); throw URLError(.networkConnectionLost) },
            { _ in
                XCTAssertEqual(link.snapshot.reach, .answering, "the failed ask said nothing of reach")
                return Self.nobody
            },
        ]
        let people = try await life.people()
        XCTAssertTrue(people.people.isEmpty && people.chats.isEmpty, "the home's answer reached the screen")
        XCTAssertEqual(door.asked, 2)
        XCTAssertEqual(link.snapshot.reach, .answering)
    }

    func testAReadThatSpansATripEachTimeItIsAskedIsAskedUntilOneSpansNone() async throws {
        let (life, door, link) = try await paired()
        let trip: Door.Step = { _ in link.inFront(true); link.inFront(false); throw URLError(.networkConnectionLost) }
        door.steps = [trip, trip, { _ in Self.nobody }]
        _ = try await life.people()
        XCTAssertEqual(door.asked, 3)
        XCTAssertEqual(link.snapshot.reach, .answering)
    }

    func testAReadThatFailedForReachCarriesTheRevisionItBeganUnder() async throws {
        let (life, door, link) = try await paired()
        let first = link.snapshot.revision
        door.steps = [{ _ in throw URLError(.cannotConnectToHost) }]
        var failed: LifeReader.Failure?
        do { _ = try await life.people(); XCTFail("gone") } catch let failure as LifeReader.Failure { failed = failure }
        XCTAssertEqual(failed, .reach(begun: first))
        XCTAssertEqual(failed?.later, true, "what the phone kept serves meanwhile")
        guard case .waiting = link.snapshot.reach else { return XCTFail("one unanswered read waits: \(link.snapshot.reach)") }
        XCTAssertFalse(ReadAgain(revision: link.snapshot.revision, begun: failed?.begun).due, "nothing healed yet")
        XCTAssertNil(ReadAgain(revision: link.snapshot.revision, begun: failed?.begun).wait(now: now), "nor any time of its own")

        door.steps = [{ _ in Self.nobody }]
        _ = try await life.people()
        XCTAssertEqual(link.snapshot.revision, first + 1)
        XCTAssertTrue(ReadAgain(revision: link.snapshot.revision, begun: failed?.begun).due)

        door.steps = [{ _ in throw URLError(.cannotConnectToHost) }]
        _ = try? await life.people()
        let before = link.snapshot.revision
        door.steps = [
            { _ in
                _ = try await link.people()
                throw URLError(.cannotConnectToHost)
            },
            { _ in Self.nobody },
        ]
        failed = nil
        do { _ = try await life.people(); XCTFail("gone") } catch let failure as LifeReader.Failure { failed = failure }
        XCTAssertEqual(failed, .reach(begun: before), "the revision it began under, not the one it ended under")
        XCTAssertEqual(link.snapshot.reach, .answering, "a failure begun before the heal opens no new wait")
        XCTAssertEqual(link.snapshot.revision, before + 1)
        XCTAssertTrue(ReadAgain(revision: link.snapshot.revision, begun: failed?.begun).due, "it reads again at once")

        door.steps = [{ _ in throw URLError(.cannotConnectToHost) }]
        failed = nil
        do { _ = try await life.people(); XCTFail("gone") } catch let failure as LifeReader.Failure { failed = failure }
        XCTAssertEqual(failed, .reach(begun: before + 1))
        XCTAssertFalse(ReadAgain(revision: link.snapshot.revision, begun: failed?.begun).due, "no read again for ever")
    }

    func testTheReadAgainRunsOncePerRecoveryWhicheverCameFirst() {
        func reads(_ seen: [ReadAgain]) -> Int {
            var last: ReadAgain?
            var reads = 0
            for due in seen where due != last {
                last = due
                if due.due { reads += 1 }
            }
            return reads
        }
        XCTAssertEqual(reads([.init(revision: 1, begun: nil), .init(revision: 1, begun: 1), .init(revision: 2, begun: 1)]), 1,
                       "(a) stored, then the recovery")
        XCTAssertEqual(reads([.init(revision: 1, begun: nil), .init(revision: 2, begun: nil), .init(revision: 2, begun: 1)]), 1,
                       "(b) the recovery, then the failure begun before it")
        XCTAssertEqual(reads([.init(revision: 3, begun: 1)]), 1, "(c) a screen come back holding a failure from before")
        XCTAssertEqual(reads([.init(revision: 2, begun: 2), .init(revision: 2, begun: 2)]), 0, "a failure of this revision waits")
        XCTAssertEqual(reads([.init(revision: 2, begun: 1), .init(revision: 2, begun: 2), .init(revision: 3, begun: 2)]), 2,
                       "read again, failed again, the next recovery")
    }

    func testAnActThatSpannedATripIsNeverAskedAgain() async throws {
        let (life, door, link) = try await paired()
        let trip: Door.Step = { _ in link.inFront(true); link.inFront(false); throw URLError(.networkConnectionLost) }
        let acted: Door.Step = { _ in HomeResponse(status: 200, body: Data(#"{"act":"x","id":null,"position":"1:1","acted":true}"#.utf8)) }
        door.steps = [trip, acted]
        do { try await life.act(need: "poll:chat", do: "try"); XCTFail("no answer") } catch let failure as LifeReader.Failure {
            XCTAssertNotNil(failure.begun, "an act that met no answer is not sent: \(failure)")
        }
        XCTAssertEqual(door.asked, 1, "a need's act asked twice")
        XCTAssertEqual(link.snapshot.reach, .answering, "a failure that spanned a trip says nothing of reach")

        door.asked = 0
        door.steps = [trip, acted]
        let undone = await life.act(.people(request: "r-1", .undo(act: "x")))
        XCTAssertEqual(undone, .answered(HomeLink.OwnerAnswer(act: "x", id: nil, position: "1:1")))
        XCTAssertEqual(door.asked, 2, "an action on people sent once more, the same request, which the writer answers once")
    }


    func testAHeldHomeIsReachsAndARequestsOwnNotNowIsTheScreens() async throws {
        let (life, door, link) = try await paired()
        door.steps = [
            { _ in Self.held(Self.damaged) },
            { _ in HomeResponse(status: 503, body: Data(#"{"code":"ASK_DOWN","message":"Ask is not answering","detail":null,"acts":[]}"#.utf8)) },
            { _ in HomeResponse(status: 503, body: Data(#"{"code":"INDEX_BUILDING","message":"Search is being built.","detail":null,"acts":[]}"#.utf8)) },
        ]
        do { _ = try await life.people(); XCTFail("held") } catch let failure as LifeReader.Failure {
            XCTAssertNotNil(failure.begun, "a held home is reach's: \(failure)")
        }
        guard case .held(let hold) = link.snapshot.reach else { return XCTFail("held: \(link.snapshot.reach)") }
        let strip = try XCTUnwrap(ReachWords.strip(link.snapshot, device: .phone, clock: HomeClock.current.clock))
        XCTAssertEqual([strip.title, strip.line], ["Lifestream's database is damaged.", "A check found damage in home.db."])
        XCTAssertEqual(strip.act?.label, "Check again")
        XCTAssertEqual(hold.acts.map(\.do), [.verify])
        let revision = link.snapshot.revision
        do { _ = try await life.people(); XCTFail("down") } catch let failure as LifeReader.Failure {
            XCTAssertEqual(failure, .busy("Chat isn't answering on your Mac", code: "ASK_DOWN", until: now.addingTimeInterval(HomeLink.probeEvery),
                                          begun: revision),
                           "its words, the door's being no person's, asked again at the probe's rhythm when the door named no time")
        }
        XCTAssertEqual(link.snapshot.reach, .held(hold), "one request's not-now ends no hold: only the probe's answer does")
        do { _ = try await life.people(); XCTFail("building") } catch let failure as LifeReader.Failure {
            XCTAssertEqual(failure, .busy("Search is being built.", code: "INDEX_BUILDING", until: now.addingTimeInterval(HomeLink.probeEvery),
                                          begun: revision))
        }
    }


    func testARequestsNotNowRetryAfterIsWhenItIsReadAgainAndItsWordsStandBesideTheReportKept() async throws {
        let (life, door, link) = try await paired()
        let words = "Lifestream is busy with its index. It answers in a moment."
        let starting = "Your home is starting: it answers in a moment."
        let either: Door.Step = { request in
            request.url.path == "/v1/status" ? HomeResponse(status: 200, body: Data("{}".utf8))
                : HomeResponse(status: 404, body: Data(#"{"code":"NOT_FOUND","message":"No such person."}"#.utf8))
        }
        door.steps = [
            { _ in HomeResponse(status: 503, headers: ["Retry-After": "5"], body: Data(#"{"code":"INDEX_BUSY","message":"\#(words)","detail":null,"acts":[]}"#.utf8)) },
            { _ in HomeResponse(status: 503, headers: ["Retry-After": "5"], body: Data(#"{"code":"NOT_NOW","message":"\#(starting)","wait":"starting","title":"Your home is starting","line":"It answers in a moment.","acts":[]}"#.utf8)) },
            either, either, either,
        ]
        let revision = link.snapshot.revision
        var put: LifeReader.Failure?
        do { _ = try await life.people(); XCTFail("not now") } catch let failure as LifeReader.Failure { put = failure }
        XCTAssertEqual(put, .busy(words, code: "INDEX_BUSY", until: now.addingTimeInterval(5), begun: revision),
                       "the door's Retry-After was dropped")
        XCTAssertEqual(link.snapshot.reach, .answering, "one request's not-now is no reach")

        XCTAssertEqual(ReadAgain(revision: revision, begun: put?.since, until: put?.until).wait(now: now), 5)
        XCTAssertEqual(HomeConnectorsModel.waiting(read: true, failure: put, lacking: false), words)
        XCTAssertNil(HomeConnectorsModel.waiting(read: false, failure: put, lacking: false))
        XCTAssertNil(HomeConnectorsModel.waiting(read: true, failure: nil, lacking: false))
        XCTAssertNil(HomeConnectorsModel.waiting(read: true, failure: .reach(begun: revision), lacking: false))

        do { _ = try await life.people(); XCTFail("starting") } catch let failure as LifeReader.Failure { put = failure }
        XCTAssertEqual(put, .reach(begun: revision), "a start is reach's")
        XCTAssertNil(HomeConnectorsModel.waiting(read: true, failure: put, lacking: HomeReach.lacks(link.snapshot.reach)))
        await link.probeSoon()
        XCTAssertEqual(link.snapshot.reach, .answering, "the probe the not-now asked was answered")

        do { _ = try await life.people(); XCTFail("missing") } catch let failure as LifeReader.Failure {
            XCTAssertEqual(failure, .missing)
            XCTAssertNil(failure.until, "a wait outlived the answer after it")
            XCTAssertNil(failure.since, "nor does a revision: only a press asks it again")
        }

        let noWait: Door.Step = { request in
            request.url.path == "/v1/status" ? HomeResponse(status: 200, body: Data("{}".utf8))
                : HomeResponse(status: 503, headers: ["Retry-After": "0"], body: Data(#"{"code":"INDEX_BUSY","message":"\#(words)","detail":null,"acts":[]}"#.utf8))
        }
        door.steps = [noWait, noWait]
        do { _ = try await life.people(); XCTFail("not now") } catch let failure as LifeReader.Failure { put = failure }
        XCTAssertEqual(put?.until, now.addingTimeInterval(LifeReader.soonest))
        XCTAssertEqual(ReadAgain(revision: revision, begun: put?.since, until: put?.until).wait(now: now), LifeReader.soonest)
    }

    func testAKeptReportsWaitSaysNothingOfWhyOnceReachLacks() async throws {
        let (life, door, link) = try await paired()
        let busy = "Your home isn't ready."
        let held: Door.Step = { _ in Self.held(Self.damaged) }
        door.steps = [
            { _ in HomeResponse(status: 503, headers: ["Retry-After": "5"], body: Data(#"{"code":"NOT_NOW","message":"\#(busy)","wait":"busy","title":null,"line":null,"acts":[]}"#.utf8)) },
            held, held, held,
        ]
        var put: LifeReader.Failure?
        do { _ = try await life.people(); XCTFail("busy") } catch let failure as LifeReader.Failure { put = failure }
        guard case .busy? = put else { return XCTFail("a busy not-now is the read's wait: \(String(describing: put))") }
        for reach: HomeLink.Reach in [.answering, .waiting(since: now)] {
            XCTAssertEqual(HomeConnectorsModel.waiting(read: true, failure: put, lacking: HomeReach.lacks(reach)), busy,
                           "\(reach): the door's words under the report kept")
        }

        await link.probeSoon()
        guard case .held = link.snapshot.reach else { return XCTFail("held: \(link.snapshot.reach)") }
        XCTAssertNotNil(ReachWords.strip(link.snapshot, device: .phone, clock: HomeClock.current.clock), "the strip says why")
        XCTAssertNil(HomeConnectorsModel.waiting(read: true, failure: put, lacking: HomeReach.lacks(link.snapshot.reach)),
                     "a lacking snapshot: no why under the report")
        for reach: HomeLink.Reach in [.unreachable(.offline, since: now), .passRefused] {
            XCTAssertNil(HomeConnectorsModel.waiting(read: true, failure: put, lacking: HomeReach.lacks(reach)), "\(reach)")
        }
    }

    func testARequestsOwnNotNowIsReadAgainAtItsTimeWhileTheHomeAnswers() async throws {
        let (life, door, link) = try await paired()
        let busy = "Your home isn't ready."
        let either: Door.Step = { request in
            request.url.path == "/v1/status" ? HomeResponse(status: 200, body: Data("{}".utf8)) : Self.nobody
        }
        door.steps = [
            { _ in HomeResponse(status: 503, headers: ["Retry-After": "5"], body: Data(#"{"code":"NOT_NOW","message":"\#(busy)","wait":"busy","title":null,"line":null,"acts":[]}"#.utf8)) },
        ]
        door.otherwise = either
        let begun = link.snapshot.revision
        var failed: LifeReader.Failure?
        do { _ = try await life.find("p-1"); XCTFail("not now") } catch let failure as LifeReader.Failure { failed = failure }
        let until = now.addingTimeInterval(5)
        XCTAssertEqual(failed, .busy(busy, code: "NOT_NOW", until: until, begun: begun))
        await link.probeSoon()
        _ = try await life.people()
        XCTAssertEqual(link.snapshot.reach, .answering, "the probe answered: reach never stopped answering")
        XCTAssertEqual(link.snapshot.revision, begun, "no revision rises to read the page again")

        let again = ReadAgain(revision: link.snapshot.revision, begun: failed?.since, until: failed?.until)
        XCTAssertFalse(again.due, "not by a recovery")
        XCTAssertEqual(again.wait(now: now), 5, "read again at the door's time, with no press")
        XCTAssertEqual(again.wait(now: until), 0)
        XCTAssertEqual(again.wait(now: until.addingTimeInterval(30)), 0, "a page come back past its time reads again at once")
        XCTAssertEqual(failed?.since, begun, "it keeps the revision it began under")
        XCTAssertEqual(ReadAgain(revision: begun + 1, begun: failed?.since, until: failed?.until).wait(now: now), 0,
                       "a recovery before the door's time reads at once, whichever comes first")
        XCTAssertEqual(failed?.later, true, "what the phone kept serves meanwhile")
    }


    func testAReadThatFailedForReachWaitsInsideTheGraceAndLacksPastIt() async throws {
        let (life, door, link) = try await paired()
        door.steps = [{ _ in throw URLError(.cannotConnectToHost) }]
        var failed: LifeReader.Failure?
        do { _ = try await life.people(); XCTFail("gone") } catch let failure as LifeReader.Failure { failed = failure }
        let failure = try XCTUnwrap(failed)
        guard case .waiting = link.snapshot.reach else { return XCTFail("inside the grace: \(link.snapshot.reach)") }
        XCTAssertEqual(ReadLack.Shown(failure, lacking: HomeReach.lacks(link.snapshot.reach)), .waits,
                       "inside the grace: the waiting line, no lack")
        XCTAssertEqual(ReadLack.Shown(failure, lacking: HomeReach.lacks(.answering)), .waits, "a late failure after the heal")
        for reach: HomeLink.Reach in [.unreachable(.offline, since: now), .held(HomeLink.Held(title: "Held", detail: "Held for a test.")),
                                      .passRefused] {
            XCTAssertEqual(ReadLack.Shown(failure, lacking: HomeReach.lacks(reach)), .lacks, "\(reach): the page lack")
        }

        let busy = LifeReader.Failure.busy("Search is being built.", code: "INDEX_BUILDING", until: now, begun: 0)
        XCTAssertEqual(ReadLack.Shown(busy, lacking: false), .waits, "a wait of its own: the waiting line, in its words")
        XCTAssertEqual(ReadLack.Shown(busy, lacking: true), .lacks)
        XCTAssertEqual(ReadLack.Shown(.failed("HOME_FAILED"), lacking: false), .says, "a failure of itself: its words, Try again")
        XCTAssertEqual(ReadLack.Shown(.refused("No."), lacking: true), .says)
    }


    func testAnActThroughTheReaderSaysWhatEveryActSays() async throws {
        let (life, door, _) = try await paired()
        func said(_ step: @escaping Door.Step) async -> HomeLink.ActSaid? {
            door.steps = [step, step]
            do { try await life.choose(need: "import:i-1:whose", account: "person-a@example.com") } catch { return HomeLink.ActSaid(error) }
            XCTFail("the act landed")
            return nil
        }
        let failed = await said { _ in HomeResponse(status: 503, body: Data(#"{"code":"HOME_FAILED","message":"Lifestream failed at this. Its log says why.","detail":null,"acts":[]}"#.utf8)) }
        XCTAssertEqual(failed, .notSent, "a server failure is not sent, with Try again, never a refusal")
        let plain = await said { _ in HomeResponse(status: 500, body: Data()) }
        XCTAssertEqual(plain, .notSent)
        let unknown = await said { _ in HomeResponse(status: 503, body: Data(#"{"code":"OUTCOME_UNKNOWN","message":"Lifestream is still working on this.","again":false,"began":true}"#.utf8)) }
        XCTAssertEqual(unknown, .unknown(ReachWords.unknownDone), "a route without again is not known done, no Try again")
        let refused = await said { _ in HomeResponse(status: 409, body: Data(#"{"code":"NOT_OFFERED","message":"That import is done."}"#.utf8)) }
        XCTAssertEqual(refused, .refused("That import is done."))
        let begun = #"{"code":"OUTCOME_UNKNOWN","message":"Lifestream is still working on this.","again":true,"began":true}"#
        let silent = #"{"code":"OUTCOME_UNKNOWN","message":"Lifestream didn't answer.","again":true,"began":false}"#
        door.steps = [{ _ in HomeResponse(status: 503, body: Data(begun.utf8)) }, { _ in HomeResponse(status: 503, body: Data(silent.utf8)) }]
        do {
            try await life.process(HomeLink.Made.Ask(family: "screen", item: "item-1", prompt: "describe"), route: "local")
            XCTFail("the act landed")
        } catch {
            XCTAssertEqual(HomeLink.ActSaid(error), .saving, "begun on one try, no answer on the next: still saving, with Check")
            XCTAssertTrue(HomeLink.ActSaid(error).sendsAgain)
        }
    }

    func testCheckAgainPostsOnceAndOnlyTheProbesAnswerEndsTheHold() async throws {
        let (life, door, link) = try await paired()
        let routes = Routes()
        let checking = #"{"code":"NOT_NOW","message":"Lifestream is checking its database. It can take up to an hour.","wait":"needs","title":"Lifestream is checking its database.","line":"It can take up to an hour.","acts":[]}"#
        door.steps = [
            { _ in Self.held(Self.damaged) },
            { request in routes.add(request); return HomeResponse(status: 202, body: Data("{}".utf8)) },
            { request in routes.add(request); return Self.held(checking) },
        ]
        _ = try? await life.people()
        guard case .held(let damaged) = link.snapshot.reach else { return XCTFail("held: \(link.snapshot.reach)") }
        await life.checkAgain()
        XCTAssertEqual(routes.all, ["POST /v1/home/verify"], "posted once, the home's state asked by no one but the probe")
        XCTAssertEqual(link.snapshot.reach, .held(damaged), "a 202 moves the clock alone")
        XCTAssertNil(life.checkRefused)
        XCTAssertFalse(life.checking)
        try await probe(link)
        XCTAssertEqual(routes.all, ["POST /v1/home/verify", "GET /v1/status"], "the probe, at the hold's Retry-After")
        guard case .held(let running) = link.snapshot.reach else { return XCTFail("held: \(link.snapshot.reach)") }
        XCTAssertEqual(running.title, "Lifestream is checking its database.")
        XCTAssertNil(ReachWords.strip(link.snapshot, device: .phone, clock: HomeClock.current.clock)?.act, "a button while the check runs")

        door.steps = [
            { _ in Self.held(Self.damaged) },
            { request in routes.add(request); return HomeResponse(status: 409, body: Data(#"{"code":"NOT_NOW","message":"Your home is checking already."}"#.utf8)) },
        ]
        _ = try? await life.people()
        XCTAssertEqual(link.snapshot.reach, .held(damaged))
        await life.checkAgain()
        XCTAssertEqual(routes.all.last, "POST /v1/home/verify")
        XCTAssertEqual(link.snapshot.reach, .held(damaged))
        XCTAssertEqual(life.checkRefused, LifeReader.CheckRefused(hold: damaged, words: "Your home is checking already."))

        door.steps = [
            { request in routes.add(request); return HomeResponse(status: 409, body: Data(#"{"code":"NOT_HELD","message":"Your home is fine now."}"#.utf8)) },
            { request in routes.add(request); return HomeResponse(status: 200, body: Data("{}".utf8)) },
        ]
        await life.checkAgain()
        XCTAssertEqual(life.checkRefused, LifeReader.CheckRefused(hold: damaged, words: "Your home is fine now."))
        try await probe(link)
        XCTAssertEqual(routes.all.suffix(2), ["POST /v1/home/verify", "GET /v1/status"], "each press posted once")
        XCTAssertEqual(link.snapshot.reach, .answering, "the probe answered: no hold")
        XCTAssertNil(ReachWords.strip(link.snapshot, device: .phone, clock: HomeClock.current.clock), "nor its words")

        let pressed = routes.all.count
        await life.checkAgain()
        XCTAssertEqual(routes.all.count, pressed)
    }

    private func probe(_ link: HomeLink) async throws {
        let probing = Task { await link.probeSoon() }
        try await until("a probe is due") { fires.count > 0 }
        fires.fire()
        _ = await probing.value
    }


    func testTheCannedHomesClockReadsAsAKeptClockNamedByItsAnswers() throws {
        let now = AppClock.now
        let clock = try XCTUnwrap(HomeClock(body: try JSONSerialization.data(withJSONObject: CannedHome.clockAnswer(at: now))))
        XCTAssertNotNil(clock.id, "a clock the phone keeps, not a placeholder")
        XCTAssertEqual(clock.id, CannedHome.answer["clock"] as? String, "the id its answers name: no read owed once kept")
        XCTAssertEqual(clock.dayAt(now).day, CannedHome.today)
        XCTAssertEqual(CannedHome.Routine(now: now).today, CannedHome.today, "the routine lays its days by the same clock")
    }


    func testAPlaceVisitedOnceSaysItsCityAndItsDay() throws {
        let clock = HomeClock.current.clock
        defer { if clock.id == nil { HomeClock.current.reset() } else { HomeClock.current.install(clock) } }
        let run = try XCTUnwrap(HomeClock.Run(day: "1970-01-01", startMs: 4 * 3_600_000, days: 1, zone: "UTC"))
        HomeClock.current.install(try XCTUnwrap(HomeClock(id: "utc-4", runs: [run])))
        let at = ISO8601DateFormatter()
        let now = try XCTUnwrap(at.date(from: "2026-10-24T18:00:00Z"))
        func page(since: String, partOf: String = "null") throws -> HomeLink.Pages.Place {
            let body = #"{"position":"1:1","today":"2026-10-24","head":{"name":"Corner Bakery","line":"Synthetic Town","since":"# + since
                + #"},"here":true,"rhythm":null,"stays":1,"visits":{"count":0,"rows":[]},"people":[],"photos":{"first":[],"total":0,"line":null},"#
                + #""part_of":"# + partOf + #","inside":[],"ask_home":null,"clashes":[],"counting":false}"#
            return try JSONDecoder().decode(HomeLink.Pages.Place.self, from: Data(body.utf8))
        }
        XCTAssertEqual(PlacesWords.line(try page(since: #"{"kind":"day","day":"2026-08-22"}"#), now: now), ["Synthetic Town", "Sat 22 Aug"])
        XCTAssertEqual(PlacesWords.line(try page(since: #"{"kind":"month","month":"2026-08"}"#, partOf: #"{"slug":"synthetic-quarter","name":"Synthetic Quarter"}"#), now: now),
                       ["Synthetic Town", PlacesWords.here, "Part of Synthetic Quarter"])
    }


    func testTheAlsoListIsLaidOpenTheFirstTimeItsDayIsDrawnAndFoldsAsAnyBlock() throws {
        let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("homelink/Tests/Fixtures/pages")
        let page = try JSONDecoder().decode(HomeLink.Pages.Day.self, from: Data(contentsOf: fixtures.appendingPathComponent("day.brief.json")))
        let also = try XCTUnwrap(page.also, "the brief day holds rows with no hour of their own")
        let model = DayModel(day: page.day)
        let laid = {
            DayLayout.of(page, isOpen: model.isOpen, lead: 0).sections.flatMap { $0.header + $0.pieces }.compactMap { piece -> String? in
                if case .row(let row, _) = piece.kind, piece.owner == .also { row.key } else { nil }
            }
        }
        XCTAssertFalse(also.folded, "the home's default: open")
        XCTAssertEqual(laid(), also.rows.map(\.key), "its rows, in the home's order, from the first draw")
        model.toggled = [DayReading.also]
        XCTAssertEqual(laid(), [], "folded, as any block")
    }



    private final class Clock: @unchecked Sendable {
        var at: Date
        init(_ at: Date) { self.at = at }
    }

    private lazy var clock = Clock(now)

    nonisolated private static let damaged = #"{"code":"NOT_NOW","message":"Lifestream's database is damaged. A check found damage in home.db.","wait":"needs","title":"Lifestream's database is damaged.","line":"A check found damage in home.db.","acts":[{"do":"verify","label":"Check again"}]}"#

    nonisolated private static func held(_ body: String) -> HomeResponse {
        HomeResponse(status: 503, headers: ["Retry-After": "60"], body: Data(body.utf8))
    }

    nonisolated private static let nobody = HomeResponse(status: 200, body: Data(#"{"people":[],"chats":[],"zone":"UTC","day_start_hour":4}"#.utf8))


    func testALivePhotosMotionThatFailsLeavesItsStillAndSaysWhy() async throws {
        let (life, door, link) = try await paired()
        door.steps = Array(repeating: { _ in HomeResponse(status: 404, body: Data(#"{"code":"BLOB_UNKNOWN","message":"no blob"}"#.utf8)) },
                           count: 20)
        let player = ViewerPlayer(life: life, reach: HomeReach(link: link))
        player.show(Self.motion, recording: false)
        XCTAssertTrue(player.live, "LIVE while its motion reads")
        XCTAssertFalse(player.bar, "a Live Photo has no bar")
        try await until("its motion failed") { player.said }
        XCTAssertFalse(player.live, "17: no LIVE over a motion that failed, and no press plays it")
        XCTAssertTrue(player.bar, "17: its bar says why")
        player.end(recording: false)
    }

    func testAVideoThatFailsMidPlayIsSaid() async throws {
        let (life, _, link) = try await paired()
        let player = ViewerPlayer(life: life, reach: HomeReach(link: link))
        player.show(Self.film, recording: false)
        let item = try XCTUnwrap(player.player.currentItem)
        XCTAssertNotEqual(item.status, .failed)
        XCTAssertFalse(player.said)
        NotificationCenter.default.post(name: AVPlayerItem.failedToPlayToEndTimeNotification, object: item)
        try await until("18: the failure said") { player.said }
        XCTAssertTrue(player.bar)
        player.end(recording: false)
    }

    func testAVideoPlaysThroughTheSwitchALivePhotoUnderItAndARecordingKeepsItsSession() {
        XCTAssertEqual(ViewerPlayer.session(for: Self.film, recording: false), .playback, "a video opened is the person's act")
        XCTAssertEqual(ViewerPlayer.session(for: Self.motion, recording: false), .ambient, "the switch mutes a Live Photo, as Photos")
        XCTAssertEqual(ViewerPlayer.session(for: nil, recording: false), .ambient, "the viewer closed")
        for play in [Self.film, Self.motion, nil] {
            XCTAssertNil(ViewerPlayer.session(for: play, recording: true), "19: a recording's session is never changed")
        }
    }

    func testAPhotoIsZoomedIntoItsOriginalOnlyOnceItsFactsSayItIsAPicture() {
        XCTAssertFalse(PhotoPage.deepens(known: false, play: nil), "20: facts not read: it may be a video")
        XCTAssertFalse(PhotoPage.deepens(known: true, play: Self.film), "a video's original is the whole video")
        XCTAssertTrue(PhotoPage.deepens(known: true, play: nil), "a still")
        XCTAssertTrue(PhotoPage.deepens(known: true, play: Self.motion), "a Live Photo's still")
    }

    private static let film = HomeLink.Photo.Play(hash: "sha256:" + String(repeating: "f1", count: 32), mediaType: "video/quicktime", live: false)
    private static let motion = HomeLink.Photo.Play(hash: "sha256:" + String(repeating: "d2", count: 32), mediaType: "video/quicktime", live: true)

    private func paired() async throws -> (LifeReader, Door, HomeLink) {
        let answer = #"{"home":{"id":"h-0001","version":"0.2.0","floors":{"mac":"0.1.0","phone":"1.0.0","extension":"0.1.0"}},"#
            + #""pass":"p-0000aa00","unit":"iphone-aa00","sources":{},"owner":[],"needs":[],"calls":[],"settings":{},"#
            + #""turn":{"run":"0000000000000001","n":1}}"#
        let door = Door()
        door.steps = [{ _ in HomeResponse(status: 200, body: Data(#"{"unit":"iphone-aa00","answer":\#(answer)}"#.utf8)) }]
        let network = TestNetwork(NetworkFacts(online: true, onLocalNetwork: false, tunnelUp: true, path: 1, cost: .free))
        let link = HomeLink(device: HomeLink.Device(kind: .phone, version: "1.0.0", model: "iPhone", serial4: nil),
                            credentials: MemoryPass(), folder: folder, transport: door, network: network,
                            pacer: fires.pacer)
        _ = try await link.pair(code: "12345678", name: "http://100.64.0.42:4680", account: "person-a@example.com")
        door.asked = 0
        let clock = clock
        return (LifeReader(link: link, clock: { clock.at }), door, link)
    }
}

final class TestNetwork: NetworkWatch, @unchecked Sendable {
    private let lock = NSLock()
    private var now: NetworkFacts

    init(_ facts: NetworkFacts) { now = facts }

    var facts: NetworkFacts? { lock.withLock { now } }

    func set(_ facts: NetworkFacts) { lock.withLock { now = facts } }

    func changes() -> AsyncStream<NetworkFacts> {
        let first = lock.withLock { now }
        return AsyncStream { $0.yield(first) }
    }
}

private final class Door: HomeTransport, @unchecked Sendable {
    typealias Step = @Sendable (HomeRequest) async throws -> HomeResponse

    private let lock = NSLock()
    private var script: [Step] = []
    private var rest: Step?
    private var count = 0

    var steps: [Step] {
        get { lock.withLock { script } }
        set { lock.withLock { script = newValue } }
    }
    var otherwise: Step? {
        get { lock.withLock { rest } }
        set { lock.withLock { rest = newValue } }
    }
    var asked: Int {
        get { lock.withLock { count } }
        set { lock.withLock { count = newValue } }
    }

    func perform(_ request: HomeRequest) async throws -> HomeResponse {
        let step = lock.withLock { () -> Step? in
            count += 1
            return script.isEmpty ? rest : script.removeFirst()
        }
        guard let step else { throw URLError(.cannotConnectToHost) }
        return try await step(request)
    }
}

private final class Fires: @unchecked Sendable {
    private let lock = NSLock()
    private var kept: [@Sendable () -> Void] = []

    var pacer: Pacer { Pacer { [self] _, fire in lock.withLock { kept.append(fire) } } }
    var count: Int { lock.withLock { kept.count } }

    func fire() {
        let due = lock.withLock { () -> [@Sendable () -> Void] in
            defer { kept = [] }
            return kept
        }
        due.forEach { $0() }
    }
}

private final class Routes: @unchecked Sendable {
    private let lock = NSLock()
    private var asked: [String] = []

    func add(_ request: HomeRequest) { lock.withLock { asked.append("\(request.method) \(request.url.path)") } }
    var all: [String] { lock.withLock { asked } }
}
