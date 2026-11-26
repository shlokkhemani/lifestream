import Foundation
import DeviceFiles
import HomeLink
import Shipping
import UserNotifications
import XCTest
@testable import Lifestream

@MainActor final class SilenceNotificationTests: XCTestCase {
    private var folder: URL!
    private let since = Date(timeIntervalSince1970: 1_794_837_720)
    private let checking = HomeLink.Held(title: "Lifestream is checking its database.", detail: "It can take up to an hour.")
    private let damaged = HomeLink.Held(title: "Lifestream's database is damaged.", detail: "A check found damage in home.db.")

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("silence-notification-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: folder)
    }

    private func coordinator(_ log: NoticeLog) -> ShippingCoordinator {
        let link = HomeLink(device: .init(kind: .mac, version: "500", model: "Mac15,3", serial4: nil), credentials: StoredPass(nil),
                            folder: folder.appendingPathComponent("link"), transport: StandInDoor(), files: DeviceFiles(.plain))
        let shipper = Shipper(Shipper.Dependencies(state: ShippingState(root: folder.appendingPathComponent("ship"), files: DeviceFiles(.plain)), link: link,
                                                   domains: { _ in [] }, record: { _ in }, scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true)))
        return ShippingCoordinator(shipper: shipper, link: link, notices: log.notices, explain: { nil })
    }

    private var episode: HomeLink.Episode?
    private var episodes = 0

    private func snapshot(_ reach: HomeLink.Reach, revision: Int = 0) -> HomeLink.ReachSnapshot {
        episode = HomeLink.Episode.next(episode, after: reach, at: since, count: &episodes)
        return HomeLink.ReachSnapshot(reach: reach, lastReached: since, revision: revision, episode: episode)
    }

    func testTheNoticeIsPostedOnceAnEpisode() {
        var notice = HomeNotice()
        XCTAssertNil(notice.see(snapshot(.waiting(since: since))), "a wait is no news")
        XCTAssertEqual(notice.see(snapshot(.answering)), .remove, "the first answer took back nothing an earlier process left")
        XCTAssertNil(notice.see(snapshot(.answering)), "taken back twice")
        let unreachable = ReachWords.notification(.unreachable(.silent, since: since), device: .mac)!
        XCTAssertEqual(notice.see(snapshot(.unreachable(.silent, since: since))), .post(episode: 2, title: unreachable.title, body: unreachable.body))
        let said = HomeLink.Starting(title: "Your home is starting", line: "It answers in a moment.")
        for turn: HomeLink.Reach in [.waiting(since: since), .starting(said, since: since), .unreachable(.silent, since: since),
                                     .unreachable(.local("The drive holding your home is not connected."), since: since),
                                     .held(checking), .held(damaged), .needsUpdate(.home)] {
            XCTAssertNil(notice.see(snapshot(turn)), "\(turn) inside the episode posted again")
        }
        XCTAssertEqual(notice.see(snapshot(.answering)), .remove, "the episode ended")
        XCTAssertNil(notice.see(snapshot(.starting(said, since: since))), "a start tells no one")
        XCTAssertEqual(notice.see(snapshot(.held(damaged))), .post(episode: 3, title: damaged.title, body: damaged.detail),
                       "a home waiting on the person, in the door's words")
        XCTAssertEqual(notice.see(snapshot(.unpaired)), .remove)
        XCTAssertNil(notice.see(snapshot(.answering)), "nothing left to remove")
    }

    func testTheReachNotificationPostsReachWordsOnceAllowedAndIsTakenBack() async throws {
        let log = NoticeLog()
        let coordinator = coordinator(log)
        coordinator.saw(snapshot(.answering))
        coordinator.saw(snapshot(.unreachable(.silent, since: since)))
        await coordinator.posting?.value
        XCTAssertEqual(log.asked, 1, "the notification did not ask macOS")
        XCTAssertEqual(log.posted.map(\.identifier), ["home-silent"])
        XCTAssertEqual(log.posted.last?.content.title, "Can't reach Lifestream")
        XCTAssertEqual(log.posted.last?.content.body, "Lifestream isn't answering")
        coordinator.saw(snapshot(.held(damaged)))
        await coordinator.posting?.value
        XCTAssertEqual(log.posted.count, 1)
        coordinator.saw(snapshot(.answering))
        coordinator.saw(snapshot(.held(damaged)))
        await coordinator.posting?.value
        XCTAssertEqual(log.posted.map(\.identifier), ["home-silent", "home-silent"])
        XCTAssertEqual(log.posted.last?.content.title, "Lifestream's database is damaged.")
        XCTAssertEqual(log.posted.last?.content.body, "A check found damage in home.db.")
        coordinator.saw(snapshot(.answering))
        for leaving: HomeLink.Reach in [.answering, .unpaired] {
            let removed = log.removed
            coordinator.saw(snapshot(.unreachable(.silent, since: since)))
            await coordinator.posting?.value
            coordinator.saw(snapshot(leaving))
            XCTAssertEqual(log.removed, removed + 1, "\(leaving) left the notification standing")
        }
        XCTAssertEqual(log.posted.count, 4)
    }

    func testAPostMacOSAllowsAfterReachMovedOnPostsNothing() async throws {
        let log = NoticeLog()
        log.held = true
        let coordinator = coordinator(log)
        coordinator.saw(snapshot(.answering))
        for leaving: HomeLink.Reach in [.answering, .unpaired] {
            coordinator.saw(snapshot(.unreachable(.silent, since: since)))
            try await until("macOS asked") { log.asking }
            coordinator.saw(snapshot(leaving, revision: leaving == .answering ? 1 : 0))
            log.answer(true)
            await coordinator.posting?.value
            XCTAssertEqual(log.posted.count, 0, "posted after \(leaving)")
        }
    }

    func testARelaunchTakesBackWhatAnEarlierProcessLeft() async {
        for first: HomeLink.Reach in [.answering, .needsUpdate(.home), .needsUpdate(.device(floor: "0.4.0")), .passRefused, .unpaired] {
            let log = NoticeLog()
            let coordinator = coordinator(log)
            coordinator.saw(snapshot(.waiting(since: since)))
            XCTAssertEqual(log.removed, 0, "a wait took it back")
            coordinator.saw(snapshot(first))
            XCTAssertEqual(log.removed, 1, "\(first) left an earlier process's notification standing")
            coordinator.saw(snapshot(first, revision: 1))
            XCTAssertEqual(log.removed, 1, "\(first) taken back again")
            XCTAssertEqual(log.posted.count, 0)
        }
        let log = NoticeLog()
        let coordinator = coordinator(log)
        coordinator.saw(snapshot(.unreachable(.silent, since: since)))
        await coordinator.posting?.value
        XCTAssertEqual(log.posted.map(\.identifier), ["home-silent"])
        XCTAssertEqual(log.removed, 0)
    }

    func testAPostMacOSAllowsDuringAWaitInsideItsEpisodeGoes() async throws {
        let log = NoticeLog()
        log.held = true
        let coordinator = coordinator(log)
        coordinator.saw(snapshot(.answering))
        coordinator.saw(snapshot(.held(damaged)))
        try await until("macOS asked") { log.asking }
        coordinator.saw(snapshot(.waiting(since: since)))
        log.answer(true)
        await coordinator.posting?.value
        coordinator.saw(snapshot(.held(damaged)))
        await coordinator.posting?.value
        XCTAssertEqual(log.posted.count, 1, "the episode's post was lost, or posted twice")
        XCTAssertEqual(log.posted.first?.content.title, damaged.title)
        XCTAssertEqual(log.posted.first?.content.body, damaged.detail)
    }

    func testNothingPostsWhileMacOSRefuses() async {
        let log = NoticeLog()
        log.allow = false
        let coordinator = coordinator(log)
        coordinator.saw(snapshot(.unreachable(.silent, since: since)))
        await coordinator.posting?.value
        XCTAssertEqual(log.asked, 1)
        XCTAssertEqual(log.posted.count, 0)
    }

    func testABrowserAskingPostsConnectWhichShowsTheBrowserFlow() async throws {
        let arcKnock = HomeReport.knock("arc", "Arc has been asking to connect since 14:02", since: 1_761_400_920_000)
        let chromeKnock = HomeReport.knock("chrome", "Chrome has been asking to connect since 14:05", since: 1_761_401_100_000)
        let arc = Need.connect(arcKnock, browser: arcKnock.acts[0])
        let chrome = Need.connect(chromeKnock, browser: chromeKnock.acts[0])
        var posted: [UNNotificationRequest] = []
        for need in [arc, chrome, arc, .saveRecoveryKey(keyed: false), .allow, .updateFailed(.refused("synthetic"))] {
            await NeedNotification.notify(need, ask: { true }, post: { posted.append($0) })
        }
        XCTAssertEqual(posted.map(\.identifier), ["connect:arc", "connect:chrome", "connect:arc"], "a need of another kind posted, or a browser's took another's place")
        let first = try XCTUnwrap(posted.first)
        XCTAssertEqual(first.content.title, "Arc has been asking to connect since 14:02")
        XCTAssertEqual(first.content.body, "Connect it if you just added the extension")
        XCTAssertEqual(first.content.categoryIdentifier, NeedNotification.connect)

        let category = try XCTUnwrap(NeedNotification.categories.first { $0.identifier == first.content.categoryIdentifier })
        XCTAssertEqual(category.actions.map(\.title), ["Connect"])
        XCTAssertTrue(category.actions[0].options.contains(.foreground))
        let page = "dialog=settings/chrome&flow=browser"
        XCTAssertEqual(NeedNotification.answer(first.content, action: category.actions[0].identifier), .show(page))
        XCTAssertEqual(NeedNotification.answer(first.content, action: UNNotificationDefaultActionIdentifier), .show(page))
        XCTAssertNil(NeedNotification.answer(first.content, action: UNNotificationDismissActionIdentifier))
        XCTAssertNil(NeedNotification.answer(UNNotificationContent(), action: UNNotificationDefaultActionIdentifier))

        var refused = 0
        await NeedNotification.notify(arc, ask: { false }, post: { _ in refused += 1 })
        XCTAssertEqual(refused, 0, "posted while macOS refused")
    }

    func testAnUpdateReadyPostsRestartToUpdateWhichInstalls() async throws {
        var posted: [UNNotificationRequest] = []
        var asked = 0
        await NeedNotification.notify(.updateReady("1900"), ask: { asked += 1; return true }, allowed: { false }, post: { posted.append($0) })
        XCTAssertEqual(posted.count, 0, "posted while notifications are not allowed")
        await NeedNotification.notify(.updateReady("1900"), ask: { asked += 1; return true }, allowed: { true }, post: { posted.append($0) })
        XCTAssertEqual(asked, 0, "an update ready asked macOS")
        let request = try XCTUnwrap(posted.first)
        XCTAssertEqual(posted.count, 1)
        XCTAssertEqual(request.identifier, "update:ready")
        XCTAssertEqual(request.content.title, "Lifestream 1900 is ready")
        let category = try XCTUnwrap(NeedNotification.categories.first { $0.identifier == request.content.categoryIdentifier })
        XCTAssertEqual(category.actions.map(\.title), ["Restart to update"])
        XCTAssertEqual(NeedNotification.answer(request.content, action: category.actions[0].identifier), .install)
        XCTAssertEqual(NeedNotification.answer(request.content, action: UNNotificationDefaultActionIdentifier), .show(nil))
        XCTAssertNil(NeedNotification.answer(request.content, action: UNNotificationDismissActionIdentifier))
    }
}
