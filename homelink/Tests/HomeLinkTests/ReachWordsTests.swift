import Foundation
import XCTest
@testable import HomeLink

final class ReachWordsTests: XCTestCase {
    private let zone = TimeZone(identifier: "Asia/Kolkata")!
    private let now = Date(timeIntervalSince1970: 1_794_731_520)
    private var clock: HomeClock { HomeClock.placeholder(at: now, zone: zone) }

    private static let held = HomeLink.Held(title: "Your home is held", detail: "The drive holding it went away.")
    private static let causes: [HomeLink.Cause] = [.offline, .tailscaleOff, .wifiOnly, .notRunning, .driveAway,
                                                   .local("The disk holding Lifestream is full. Free some room and it starts again."), .silent]

    private func snapshot(_ reach: HomeLink.Reach, lastReached: Date? = nil) -> HomeLink.ReachSnapshot {
        HomeLink.ReachSnapshot(reach: reach, lastReached: lastReached ?? now, revision: 0)
    }

    func testEveryStateCauseAndDeviceRendersAndTheDevicesDifferOnlyInTheirName() {
        let states: [HomeLink.Reach] = Self.causes.map { .unreachable($0, since: now) }
            + [.held(Self.held), .needsUpdate(.home), .needsUpdate(.device(floor: "2.0.0")), .passRefused]
        for state in states {
            let banners = [HomeLink.Kind.phone, .mac].map { ReachWords.strip(snapshot(state), device: $0, clock: clock, now: now) }
            guard let phone = banners[0], let mac = banners[1] else { return XCTFail("\(state) says nothing") }
            for text in [phone.title, phone.line, mac.title, mac.line].compactMap({ $0 }) {
                XCTAssertFalse(text.contains("{device}"), text)
                XCTAssertFalse(text.isEmpty, "\(state)")
            }
            XCTAssertEqual(phone.title.replacingOccurrences(of: "iPhone", with: "Mac"), mac.title, "\(state)")
            if state != .unreachable(.silent, since: now) && state != .unreachable(.notRunning, since: now) {
                XCTAssertEqual(phone.line?.replacingOccurrences(of: "iPhone", with: "Mac"), mac.line, "\(state)")
            }
            XCTAssertEqual(phone.tone, mac.tone)
            if case .unreachable = state {
                XCTAssertEqual(phone.act, ReachWords.Act(do: "probe", label: "Try again"), "the iPhone's strip tries again")
                XCTAssertNil(mac.act, "a home on another machine: the Mac's window opens the checklist")
            } else {
                XCTAssertEqual(phone.act, mac.act)
            }
            XCTAssertEqual(phone.meta, phone.tone == .warning ? "since 14:02" : nil, "\(state)")
            XCTAssertEqual(mac.meta, phone.meta, "\(state)")
        }

        let unreachable = ReachWords.strip(snapshot(.unreachable(.wifiOnly, since: now)), device: .phone, clock: clock, now: now)
        XCTAssertEqual(unreachable, ReachWords.Strip(tone: .warning, title: "Can't reach Lifestream",
                                                      line: "Not on your Mac's Wi\u{2011}Fi", meta: "since 14:02",
                                                      act: ReachWords.Act(do: "probe", label: "Try again")))
        XCTAssertEqual(ReachWords.strip(snapshot(.unreachable(.silent, since: now)), device: .mac, clock: clock, now: now)?.line,
                       "Lifestream isn't answering", "the home is on this Mac")
        XCTAssertEqual(ReachWords.strip(snapshot(.unreachable(.silent, since: now)), device: .phone, clock: clock, now: now)?.line,
                       "Your Mac isn't answering")
        XCTAssertEqual(ReachWords.strip(snapshot(.unreachable(.notRunning, since: now)), device: .mac, clock: clock, now: now)?.line,
                       "Lifestream isn't running on its Mac")
        XCTAssertEqual(ReachWords.strip(snapshot(.passRefused), device: .phone, clock: clock, now: now),
                       ReachWords.Strip(tone: .caution, title: "Lifestream no longer knows this iPhone", line: "Pair it again to send",
                                         meta: nil, act: ReachWords.Act(do: "pair", label: "Pair again")))
        XCTAssertEqual(ReachWords.strip(snapshot(.needsUpdate(.home)), device: .mac, clock: clock, now: now)?.line,
                       "Update it on your Mac")

        for quiet in [HomeLink.Reach.answering, .waiting(since: now)] {
            XCTAssertNil(ReachWords.strip(snapshot(quiet), device: .phone, clock: clock, now: now))
            XCTAssertNil(ReachWords.notification(quiet, device: .mac))
            XCTAssertNil(ReachWords.menuLine(snapshot(quiet), clock: clock, now: now))
        }
        XCTAssertNil(ReachWords.strip(snapshot(.unpaired), device: .phone, clock: clock, now: now))
        XCTAssertEqual(ReachWords.strip(snapshot(.unpaired), device: .mac, clock: clock, now: now)?.title, "This Mac isn't paired")
    }

    func testAHeldHomeIsTheDoorsWordsWithItsAct() throws {
        let body = Data(#"{"code":"NOT_NOW","wait":"needs","message":"Your home is held The drive holding it went away.","title":"Your home is held","line":"The drive holding it went away.","acts":[{"do":"verify","label":"Check again"}]}"#.utf8)
        guard case .needs(let held) = HomeLink.NotNow.read(body, try JSONSerialization.jsonObject(with: body) as? [String: Any]) else {
            return XCTFail("a wait on the person")
        }
        let banner = ReachWords.strip(snapshot(.held(held)), device: .phone, clock: clock, now: now)
        XCTAssertEqual(banner, ReachWords.Strip(tone: .warning, title: "Your home is held", line: "The drive holding it went away.",
                                                 meta: "since 14:02", act: ReachWords.Act(do: "verify", label: "Check again")))
        XCTAssertEqual(ReachWords.notification(.held(held), device: .phone)?.body, "The drive holding it went away.")
    }

    func testEveryClockLineIsSinceOnTheStripAndLastReachedInItsDetailsInTheZoneOfItsDay() {
        XCTAssertEqual(ReachWords.lastReached(now, clock: clock, now: now), "Last reached 14:02")
        let yesterday = now.addingTimeInterval(-86_400)
        XCTAssertEqual(ReachWords.lastReached(yesterday, clock: clock, now: now), "Last reached Sat 14 Nov · 14:02")
        XCTAssertEqual(ReachWords.stale(lastReached: yesterday, clock: clock, now: now),
                       "Can't reach Lifestream since Sat 14 Nov · What this iPhone records waits on it")
        let unreachable = snapshot(.unreachable(.silent, since: now), lastReached: yesterday)
        XCTAssertEqual(ReachWords.since(now, clock: clock, now: now), "since 14:02")
        XCTAssertEqual(ReachWords.since(yesterday, clock: clock, now: now), "since Sat 14 Nov")
        XCTAssertEqual(ReachWords.menuLine(unreachable, clock: clock, now: now), "Lifestream isn't answering · since Sat 14 Nov")
        XCTAssertEqual(ReachWords.notification(unreachable.reach, device: .mac)?.title, "Can't reach Lifestream")
        XCTAssertEqual(ReachWords.diagnosis(unreachable, device: .mac, clock: clock, now: now)?.title, "Can't reach Lifestream")
        XCTAssertEqual(ReachWords.diagnosis(unreachable, device: .mac, clock: clock, now: now)?.line, "Last reached Sat 14 Nov · 14:02")
        XCTAssertNil(ReachWords.diagnosis(snapshot(.held(Self.held)), device: .mac, clock: clock, now: now), "only out of reach opens the path")
        XCTAssertEqual(ReachWords.back.title, "Lifestream is back")
        XCTAssertNil(ReachWords.strip(HomeLink.ReachSnapshot(reach: .unreachable(.offline, since: now), lastReached: nil, revision: 0),
                                       device: .phone, clock: clock, now: now)?.meta, "never reached, no clock line")
        for state in [HomeLink.Reach.held(Self.held), .unreachable(.offline, since: now)] {
            XCTAssertEqual(ReachWords.strip(snapshot(state), device: .mac, clock: clock, now: now)?.meta?.hasPrefix("since "), true)
        }
        for state in [HomeLink.Reach.needsUpdate(.home), .needsUpdate(.device(floor: "2.0.0")), .passRefused] {
            for device in [HomeLink.Kind.phone, .mac] {
                XCTAssertNil(ReachWords.strip(snapshot(state, lastReached: yesterday), device: device, clock: clock, now: now)?.meta,
                             "\(state) on the \(device)")
            }
        }
    }

    func testEverySendingOutcomeOfBothShippersHasAKeyAndNoReachStateIsSaidAgain() {
        let mac: [String: String?] = [
            "shipped": nil, "nothing_new": nil, "nothing_due": nil, "busy": nil, "unreachable": nil, "no_home": nil,
            "refused FULL_DISK_ACCESS": nil, "held ON_BATTERY": nil, "held HISTORY": nil, "held UPLOAD_ACTIVE": nil, "stale 12": nil,
            "held DISK_LOW": "Waiting for space on Lifestream's disk",
            "held DISK_FULL": nil,
            "held CLOCK_AHEAD": "This Mac's clock is ahead of Lifestream's. Set the time automatically in System Settings.",
            "held DEVICE_TOO_OLD": nil, "held HOME_TOO_OLD": nil, "refused PRINCIPAL_UNKNOWN": nil,
            "refused PRINCIPAL_SCOPE": "Lifestream doesn't let this Mac send that. Pair it again.",
            "refused BUNDLE_TOO_LARGE": "Something this Mac recorded was too large for Lifestream. The rest still syncs.",
            "conflict 2026-11-15": "Lifestream didn't take what this Mac sent. Lifestream sends it again at the next sync.",
            "refused LOCAL_STORAGE": "This Mac couldn't read what it recorded. Check that its disk has space.",
            "refused LOCAL_ACCESS": "This Mac couldn't read one of its apps. Lifestream tries again at the next sync.",
            "refused SOMETHING_NEW": "Lifestream didn't take what this Mac sent",
        ]
        for (outcome, words) in mac {
            XCTAssertEqual(ReachWords.sending(outcome, device: .mac), words, outcome)
        }
        let phone: [String: String?] = [
            "Nothing sent yet": "Nothing sent yet.", "shipped": "Received by Lifestream.", "nothing_new": "Nothing new to send.",
            "uploading": "Sending.", "waiting": nil, "unreachable": nil, "no_home": "Pair with Lifestream to start sending.",
            "handed_over": "This install was replaced. Everything it held is in Lifestream. You can delete this app.",
            "held CLOCK_AHEAD": "This iPhone's clock is ahead of Lifestream's. Set Date & Time to automatic, and this iPhone sends again.",
            "held DEVICE_TOO_OLD": nil, "held HOME_TOO_OLD": nil, "refused PRINCIPAL_UNKNOWN": nil,
            "refused local_storage": "This iPhone couldn't finish sending. It tries again at its next wake.",
            "held ON_HOLD": "Lifestream held back the last send. This iPhone sends it again within the hour.",
            "refused PRINCIPAL_SCOPE": "Lifestream doesn't let this iPhone send that. Pair it again.",
            "refused SOMETHING_NEW": "Lifestream didn't accept this iPhone's last request. This iPhone asks again on its own.",
            "held DISK_LOW": "Waiting for space on Lifestream's disk",
            "refused BUNDLE_TOO_LARGE": "Something this iPhone recorded was too large for Lifestream. The rest still syncs.",
            "held BUNDLE_TOO_LARGE": "Something this iPhone recorded was too large for Lifestream. The rest still syncs.",
            "held PRINCIPAL_SCOPE": "Lifestream doesn't let this iPhone send that. Pair it again.",
            "held DISK_FULL": nil,
        ]
        for (outcome, words) in phone {
            XCTAssertEqual(ReachWords.sending(outcome, device: .phone), words, outcome)
        }
        XCTAssertEqual(ReachWords.sending("refused local_storage", device: .phone, long: true),
                       "This iPhone hasn't been able to send for over an hour. Lifestream shows the problem.")
        XCTAssertEqual(ReachWords.sending("held ON_HOLD", device: .phone, long: true),
                       "Lifestream has refused what this iPhone sends for over an hour. It shows the problem.")
        XCTAssertEqual(ReachWords.sending("refused LOCAL_ACCESS", device: .phone), "Lifestream didn't accept this iPhone's last request. This iPhone asks again on its own.",
                       "a Mac's own line is the Mac's alone")
        let both = ["FULL_DISK_ACCESS", "ON_BATTERY", "HISTORY", "UPLOAD_ACTIVE", "HOME_TOO_OLD", "DEVICE_TOO_OLD",
                    "PRINCIPAL_UNKNOWN", "DISK_LOW", "DISK_FULL", "CLOCK_AHEAD", "PRINCIPAL_SCOPE", "BUNDLE_TOO_LARGE"]
        let codes: [(String, [HomeLink.Kind])] = both.map { ($0, [.phone, .mac]) }
            + [("LOCAL_STORAGE", [.mac]), ("LOCAL_ACCESS", [.mac]), ("local_storage", [.phone])]
        for (code, devices) in codes {
            for device in devices {
                for long in [false, true] {
                    XCTAssertEqual(ReachWords.sending("held \(code)", device: device, long: long),
                                   ReachWords.sending("refused \(code)", device: device, long: long), "\(code) on the \(device)")
                }
            }
        }
        XCTAssertEqual(ReachWords.sending("held SOMETHING_NEW", device: .mac), ReachWords.sending("refused SOMETHING_NEW", device: .mac))
    }

    func testAnActsStateDrawsItsOneActFailure() {
        XCTAssertEqual(ReachWords.act(.reach), .notSent)
        XCTAssertEqual(ReachWords.act(.failed), .notSent)
        XCTAssertEqual(ReachWords.act(.wait(words: "Your home is building its index.", until: now)), .refused("Your home is building its index."))
        XCTAssertEqual(ReachWords.act(.refused("That isn't a day.")), .refused("That isn't a day."))
        XCTAssertEqual(ReachWords.act(.unknown("It may have done it.")), .unknown("It may have done it."))
        XCTAssertEqual(ReachWords.act(.saving), .saving)
        XCTAssertNil(ReachWords.act(.inFlight))
        XCTAssertEqual([ReachWords.notSent, ReachWords.waiting], ["Not sent", "Waiting for Lifestream."])
    }

    func testAnActNoAnswerEndedSaysWhatItsHomeSaidOfItAndNoMore() {
        XCTAssertEqual([ReachWords.saving, ReachWords.unknown, ReachWords.unknownDone],
                       ["Still saving to Lifestream", "Lifestream didn't say whether this was saved.", "Lifestream didn't say whether this was done."])
        XCTAssertEqual(ReachWords.unanswered(again: true, began: true), ReachWords.saving, "begun on a route sent again: still saving")
        XCTAssertEqual(ReachWords.unanswered(again: true, began: false), ReachWords.unknown, "sent, nothing back: not known whether saved")
        XCTAssertEqual(ReachWords.unanswered(again: false, began: true), ReachWords.unknownDone, "begun, but it cannot be sent again")
        XCTAssertEqual(ReachWords.unanswered(again: false, began: false), ReachWords.unknownDone)
        XCTAssertEqual(HomeLink.state(of: LinkFailure.unanswered(again: true, began: true), now: now), .saving)
        XCTAssertEqual(HomeLink.state(of: LinkFailure.unanswered(again: true, began: false), now: now), .unknown(ReachWords.unknown))
        XCTAssertEqual(HomeLink.state(of: LinkFailure.unanswered(again: false, began: true), now: now), .unknown(ReachWords.unknownDone),
                       "Still saving only on a route with again")
        XCTAssertEqual(LinkFailure.unanswered(again: true, began: true).description, "Lifestream is still working on this.")
        XCTAssertEqual(LinkFailure.unanswered(again: true, began: false).description, "Lifestream didn't answer.")
    }

    func testADoorCodeWhoseMessageIsNoPersonsIsWordedHere() {
        XCTAssertEqual(ReachWords.door("ASK_DOWN"), "Chat isn't answering on your Mac")
        XCTAssertEqual(ReachWords.door("DISK_LOW"), "Waiting for space on Lifestream's disk")
        XCTAssertNil(ReachWords.door("INDEX_BUSY"), "the door's own words are a person's")
    }

    func testTheFixesKeepTheirMeaningAndWiFiNeverBreaks() {
        XCTAssertEqual(ReachWords.fix(.tailscaleOff, device: .phone), "Turn it on in the Tailscale app, or join your Mac's Wi\u{2011}Fi.")
        XCTAssertEqual(ReachWords.fix(.silent, device: .phone), "Check that your Mac is awake, on the same Wi\u{2011}Fi or on Tailscale.")
        XCTAssertNil(ReachWords.fix(.driveAway, device: .phone))
        XCTAssertEqual(ReachWords.pairing(.silent).title, "Can't reach your Mac")
        XCTAssertEqual(ReachWords.pairing(.offline).fix, "Join your Mac's Wi\u{2011}Fi, then try again.")
        let words = { (links: [ReachWords.Link]) -> [String] in links.flatMap { [$0.name, $0.value, $0.fix ?? ""] } }
        var every: [String] = []
        for cause in Self.causes {
            every += [ReachWords.line(cause, device: .phone), ReachWords.fix(cause, device: .phone) ?? "", ReachWords.pairing(cause).title,
                      ReachWords.pairing(cause).fix]
            for routes in Self.routes {
                for device in [HomeLink.Kind.phone, .mac] { every += words(path(cause, routes, device)) }
            }
        }
        for text in every { XCTAssertFalse(text.contains("Wi-Fi"), "a plain hyphen breaks: \(text)") }
    }

    private static let routes: [HomeLink.Routes] = {
        let kinds: [(local: Bool?, tailscale: Bool?)] = [(true, nil), (false, nil), (nil, true), (nil, false), (true, false),
                                                          (false, true), (false, false), (true, true)]
        var all = [HomeLink.Routes(online: true, local: nil, tailscale: nil, here: true)]
        for online in [true, false] {
            for kind in kinds { all.append(HomeLink.Routes(online: online, local: kind.local, tailscale: kind.tailscale)) }
        }
        return all
    }()

    private static func judged(_ cause: HomeLink.Cause, _ routes: HomeLink.Routes) -> Bool {
        guard !routes.here, let online = routes.online, routes.local != true, routes.tailscale != true else { return !cause.isNetwork }
        return cause == (!online ? .offline : routes.tailscale != nil ? .tailscaleOff : .wifiOnly)
    }

    private func path(_ cause: HomeLink.Cause, _ routes: HomeLink.Routes, _ device: HomeLink.Kind) -> [ReachWords.Link] {
        ReachWords.diagnosis(HomeLink.ReachSnapshot(reach: .unreachable(cause, since: now), lastReached: now, revision: 0, routes: routes),
                             device: device)?.path ?? []
    }

    func testThePathBlamesOnlyTheLinkThatBroke() {
        typealias L = ReachWords.Link
        let both = { (local: Bool?, tailscale: Bool?) in HomeLink.Routes(online: true, local: local, tailscale: tailscale) }
        let offline = path(.offline, HomeLink.Routes(online: false, local: false, tailscale: false), .phone)
        XCTAssertEqual(offline.map(\.id), ["online", "wifi", "tailscale", "mac"])
        XCTAssertEqual(offline.map(\.state), [.failed, .unchecked, .unchecked, .unchecked])
        XCTAssertEqual(Set(offline.dropFirst().map(\.value)), ["Not checked"])
        let off = path(.tailscaleOff, both(nil, false), .phone)
        XCTAssertEqual(off.map(\.id), ["online", "tailscale", "mac"])
        XCTAssertEqual(off[1], L(id: "tailscale", name: "Tailscale on this iPhone", state: .failed, value: "Off",
                                  fix: "Turn it on, or join your Mac's Wi\u{2011}Fi", act: .tailscale))
        XCTAssertEqual(off[2].state, .unchecked)
        let silent = path(.silent, both(nil, true), .phone)
        XCTAssertEqual(silent.map(\.state), [.passed, .passed, .failed])
        XCTAssertEqual(silent[2].value, "Not answering")
        XCTAssertEqual(path(.wifiOnly, both(false, nil), .phone).map(\.id), ["online", "wifi", "mac"])
        XCTAssertEqual(path(.wifiOnly, both(false, nil), .phone)[1].state, .failed)
        XCTAssertEqual(path(.silent, HomeLink.Routes(online: nil, local: nil, tailscale: nil), .phone).map(\.state), [.unchecked, .failed])
    }

    func testTheChecklistNeverContradictsTheStrip() {
        let routes = HomeLink.Routes(online: true, local: true, tailscale: false)
        let snapshot = HomeLink.ReachSnapshot(reach: .unreachable(.silent, since: now), lastReached: now, revision: 0, routes: routes)
        XCTAssertEqual(ReachWords.strip(snapshot, device: .phone, clock: clock, now: now)?.line, "Your Mac isn't answering")
        let links = try! XCTUnwrap(ReachWords.diagnosis(snapshot, device: .phone)).path
        XCTAssertEqual(links.map(\.id), ["online", "wifi", "tailscale", "mac"])
        XCTAssertEqual(links.map(\.state), [.passed, .passed, .unchecked, .failed], "Tailscale off is a value, never the failure")
        XCTAssertNil(links[2].fix)
        for cause in Self.causes {
            for routes in Self.routes where Self.judged(cause, routes) {
                for device in [HomeLink.Kind.phone, .mac] {
                    let path = path(cause, routes, device)
                    let broken = path.filter(\.failed)
                    XCTAssertEqual(broken.count, 1, "\(cause) \(routes) \(device): one link breaks")
                    XCTAssertNotNil(broken.first?.fix, "\(cause): the broken link says its fix")
                    let at = path.firstIndex(where: \.failed) ?? 0
                    if at < path.count - 1 { XCTAssertEqual(path.last?.state, .unchecked, "\(cause) \(routes): the home after it, not checked") }
                }
            }
        }
    }

    func testTheMacsPathBlamesTheLinkItsCauseNamesInTheLabsOrder() {
        typealias L = ReachWords.Link
        let here = HomeLink.Routes(online: true, local: nil, tailscale: nil, here: true)
        let notRunning = path(.notRunning, here, .mac)
        XCTAssertEqual(notRunning, [L(id: "lifestream", name: "Lifestream on this Mac", state: .failed, value: "Not running",
                                      fix: "Open it, and Lifestream starts again", act: .open),
                                    L(id: "drive", name: "Lifestream's drive", state: .passed, value: "Connected"),
                                    L(id: "home", name: "Lifestream", state: .unchecked, value: "Not checked")])
        let snapshot = HomeLink.ReachSnapshot(reach: .unreachable(.notRunning, since: now), lastReached: now, revision: 0, routes: here)
        XCTAssertEqual(ReachWords.strip(snapshot, device: .mac, clock: clock, now: now)?.act, .startLifestream, "the strip starts Lifestream")
        XCTAssertEqual(ReachWords.strip(snapshot, device: .mac, clock: clock, now: now)?.title, "Lifestream isn't running")
        XCTAssertEqual(path(.driveAway, here, .mac).map(\.state), [.passed, .failed, .unchecked])
        let stopped = path(.local("The disk holding Lifestream is full. Free some room and it starts again."), here, .mac)
        XCTAssertEqual(stopped.map(\.state), [.failed, .passed, .unchecked])
        XCTAssertEqual(stopped[0].fix, "The disk holding Lifestream is full. Free some room and it starts again.")
        XCTAssertEqual(path(.silent, here, .mac).map(\.state), [.passed, .passed, .failed])
        let silent = HomeLink.ReachSnapshot(reach: .unreachable(.silent, since: now), lastReached: now, revision: 0, routes: here)
        XCTAssertNil(ReachWords.strip(silent, device: .mac, clock: clock, now: now)?.act, "Lifestream runs: nothing to open")
        let away = HomeLink.Routes(online: true, local: nil, tailscale: false)
        XCTAssertEqual(path(.offline, HomeLink.Routes(online: false, local: nil, tailscale: false), .mac).map(\.state), [.failed, .unchecked, .unchecked])
        XCTAssertEqual(path(.tailscaleOff, away, .mac).map(\.id), ["online", "tailscale", "home"])
        XCTAssertEqual(path(.silent, HomeLink.Routes(online: true, local: true, tailscale: nil), .mac).map(\.state), [.passed, .passed, .failed])
    }

    func testAStartingHomeSaysTheDoorsTitleAndLineAsAWaitingStrip() {
        let said = HomeLink.Starting(title: "Your home is starting", line: "It answers in a moment.")
        let starting = ReachWords.strip(snapshot(.starting(said, since: now)), device: .phone, clock: clock, now: now)
        XCTAssertEqual(starting, ReachWords.Strip(tone: .waiting, title: "Your home is starting", line: "It answers in a moment.",
                                                  meta: nil, act: nil))
        XCTAssertEqual(ReachWords.strip(snapshot(.starting(said, since: now)), device: .mac, clock: clock, now: now), starting)
        XCTAssertNil(ReachWords.diagnosis(snapshot(.starting(said, since: now)), device: .phone), "no details")
        XCTAssertNil(ReachWords.notification(.starting(said, since: now), device: .mac), "no notification")
    }

    func testTheStripAndReachedReadTheEpisode() {
        let said = HomeLink.Starting(title: "Your home is starting", line: "It answers in a moment.")
        var count = 0
        var episode = HomeLink.Episode.next(nil, after: .starting(said, since: now), at: now, count: &count)
        episode = HomeLink.Episode.next(episode, after: .waiting(since: now), at: now.addingTimeInterval(5), count: &count)
        let waiting = HomeLink.ReachSnapshot(reach: .waiting(since: now), lastReached: now, revision: 0, episode: episode)
        XCTAssertEqual(ReachWords.strip(waiting, device: .phone, clock: clock, now: now)?.title, "Your home is starting",
                       "the wait keeps the strip the episode showed")
        episode = HomeLink.Episode.next(episode, after: .answering, at: now.addingTimeInterval(10), count: &count)
        let back = HomeLink.ReachSnapshot(reach: .answering, lastReached: now, revision: 1, episode: episode)
        XCTAssertNil(ReachWords.strip(back, device: .phone, clock: clock, now: now))
        XCTAssertEqual(ReachWords.reached(back, clock: clock, now: now.addingTimeInterval(11))?.title, "Lifestream is back")
        XCTAssertNil(ReachWords.reached(back, clock: clock, now: now.addingTimeInterval(10 + ReachWords.reachedFor)), "for a moment")
        var quiet = HomeLink.Episode.next(nil, after: .waiting(since: now), at: now, count: &count)
        XCTAssertNil(ReachWords.strip(HomeLink.ReachSnapshot(reach: .waiting(since: now), lastReached: now, revision: 0, episode: quiet),
                                      device: .phone, clock: clock, now: now))
        quiet = HomeLink.Episode.next(quiet, after: .answering, at: now.addingTimeInterval(3), count: &count)
        XCTAssertNil(ReachWords.reached(HomeLink.ReachSnapshot(reach: .answering, lastReached: now, revision: 1, episode: quiet),
                                        clock: clock, now: now.addingTimeInterval(3)))
        XCTAssertEqual(count, 2, "two episodes")
    }

    func testTheNetworksCauseIsCheckedInItsOrder() {
        let offline = NetworkFacts(online: false, onLocalNetwork: false, tunnelUp: false, cost: .free)
        let cellular = NetworkFacts(online: true, onLocalNetwork: false, tunnelUp: false, cost: .free)
        let wifi = NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: false, cost: .free)
        let tunnel = NetworkFacts(online: true, onLocalNetwork: false, tunnelUp: true, cost: .free)
        XCTAssertEqual(HomeLink.Cause.of(offline, homeListsTailscale: true), .offline)
        XCTAssertEqual(HomeLink.Cause.of(cellular, homeListsTailscale: true), .tailscaleOff)
        XCTAssertEqual(HomeLink.Cause.of(cellular, homeListsTailscale: false), .wifiOnly)
        XCTAssertNil(HomeLink.Cause.of(wifi, homeListsTailscale: false))
        XCTAssertNil(HomeLink.Cause.of(tunnel, homeListsTailscale: true))
        XCTAssertTrue(HomeLink.Cause.offline.isNetwork)
        XCTAssertFalse(HomeLink.Cause.driveAway.isNetwork)
    }
}
