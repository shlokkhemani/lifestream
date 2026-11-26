import AppKit
import Cockpit
import HomeLink
import ImageIO
import Network
import Passwords
import Recorder
import Shipping
import SwiftUI
import UniformTypeIdentifiers
import WebKit
import XCTest
@testable import Lifestream

@MainActor final class MainWindowTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite = ""
    private var scratch: URL!

    override func setUpWithError() throws {
        suite = "MainWindowTests-\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        scratch = FileManager.default.temporaryDirectory.appendingPathComponent("main-window-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: scratch)
    }

    private var drop: URL { scratch.appendingPathComponent("drop", isDirectory: true) }

    private func window(port: Int, carrying release: URL? = nil, launch: Bool = false) -> MainWindowController {
        let keeper = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { nil })
        let needs = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        let lines = StatusLines(recorder: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true))
        let now = Date()
        lines.shipper = ShipperStatus(home: URL(string: "https://lifestream.example.ts.net"), lastRunAt: now.addingTimeInterval(-180),
                                      lastOutcome: "shipped", lastContactAt: now, pending: 0, nextRunAt: now, running: false, sources: [])
        let grants = Dictionary(uniqueKeysWithValues: Grant.allCases.map { ($0, $0 != .fullDiskAccess && $0 != .bluetooth) })
        let host = MacHost(needs: needs, lines: lines, socket: { nil },
                        readGrants: { grants }, readFolder: { URL(fileURLWithPath: "/Volumes/Drive-A/Lifestream") }, ask: .untouched)
        let address = DashboardAddress(port: port)
        let web = release.map { WebContent(address: address.carried, defaults: defaults, release: $0, dashboardHeld: { true }) }
            ?? WebContent(address: address, defaults: defaults, launch: launch, dashboardHeld: { true })
        return MainWindowController(web: web, host: host, onScreen: false, closed: {})
    }

    func testTheWindowIsFramelessAndThePageShowsOnlyOnceItLoads() async throws {
        let controller = window(port: try await Self.closedPort())
        defer { controller.close() }
        let window = try XCTUnwrap(controller.window)
        XCTAssertEqual(window.styleMask, [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView])
        XCTAssertTrue(window.titlebarAppearsTransparent)
        XCTAssertEqual(window.titleVisibility, .hidden)
        XCTAssertEqual(window.titlebarSeparatorStyle, .none)
        XCTAssertNil(window.toolbar, "the window keeps a toolbar")
        XCTAssertTrue(window.isMovableByWindowBackground)
        XCTAssertTrue(controller.web.container.isHidden || !controller.web.loaded, "the page showed before it loaded")
        try await until("controller.web.failing") { controller.web.failing }
        XCTAssertFalse(controller.web.loaded)
        controller.web.show(hash: "view=connectors&dialog=\(AppSection.thisMac)")
        XCTAssertEqual(controller.web.currentURL.fragment, "view=connectors&dialog=settings/mac")
        XCTAssertEqual(controller.web.title, "Lifestream")
    }

    func testTheDragAndTheDoubleClickAreAsThePersonChose() {
        XCTAssertTrue(WindowGestures.drags(.leftMouseDown, pressed: 1))
        XCTAssertTrue(WindowGestures.drags(.leftMouseDragged, pressed: 1))
        XCTAssertFalse(WindowGestures.drags(.leftMouseDragged, pressed: 0), "a click that ended moved the window")
        XCTAssertFalse(WindowGestures.drags(.leftMouseUp, pressed: 1))
        XCTAssertFalse(WindowGestures.drags(.rightMouseDown, pressed: 2))
        XCTAssertFalse(WindowGestures.drags(.rightMouseDragged, pressed: 3))
        XCTAssertEqual(WindowGestures.doubleClick("Minimize"), .miniaturize)
        XCTAssertEqual(WindowGestures.doubleClick("None"), .nothing)
        XCTAssertEqual(WindowGestures.doubleClick("Maximize"), .zoom)
        XCTAssertEqual(WindowGestures.doubleClick("Fill"), .zoom)
        XCTAssertEqual(WindowGestures.doubleClick(nil), .zoom, "a Mac that never chose did not zoom")
        XCTAssertEqual(WindowGestures.doubleClickKey, "AppleActionOnDoubleClick")
    }

    func testTheInsetIsTheButtonsInThePagesPixelsAndNoneInFullScreen() throws {
        let buttons = CGRect(x: 7, y: 6, width: 62, height: 16)
        XCTAssertEqual(HostState.Inset.of(buttons: buttons, zoom: 1, fullScreen: false), HostState.Inset(left: 69, centre: 14))
        XCTAssertEqual(HostState.Inset.of(buttons: buttons, zoom: 1.25, fullScreen: false), HostState.Inset(left: 55.2, centre: 11.2))
        XCTAssertEqual(HostState.Inset.of(buttons: buttons, zoom: 0.5, fullScreen: false), HostState.Inset(left: 138, centre: 28))
        XCTAssertNil(HostState.Inset.of(buttons: buttons, zoom: 1, fullScreen: true))

        let controller = window(port: 9)
        defer { controller.close() }
        let measured = try XCTUnwrap(controller.host.inset)
        XCTAssertGreaterThan(measured.left, 40)
        XCTAssertLessThan(measured.left, 120)
        XCTAssertGreaterThan(measured.centre, 6)
        XCTAssertLessThan(measured.centre, 30)
        controller.web.setZoom(1)
        controller.actualSize(nil)
        controller.zoomIn(nil)
        let zoomed = try XCTUnwrap(controller.host.inset)
        XCTAssertEqual(zoomed.left, measured.left / 1.1, accuracy: 0.01)
        XCTAssertEqual(controller.host.state.inset, zoomed)
        controller.actualSize(nil)
    }

    func testReachWordsAndTheCodeTableHoldTheHostReachContract() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../dashboard/test/fixtures/host-reach.json")
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let utc = TimeZone(identifier: "UTC")!
        let now = Date(timeIntervalSince1970: 1_794_844_800)
        let today = Date(timeIntervalSince1970: 1_794_837_720)
        let saturday = Date(timeIntervalSince1970: 1_794_664_920)
        let clock = HomeClock.placeholder(at: now, zone: utc)
        let verify = try JSONDecoder().decode(HomeLink.Act.self, from: Data(#"{"do":"verify","label":"Check again"}"#.utf8))
        let held = HomeLink.Held(title: "Lifestream is held", detail: "The drive holding it went away.", acts: [verify])
        let said = HomeLink.Starting(title: "Lifestream is starting", line: "It answers in a moment.")
        let here = HomeLink.Routes(online: true, local: nil, tailscale: nil, here: true)
        let started = HomeLink.Episode(id: 1, since: now, shown: .starting(said, since: now))
        let reached = HomeLink.Episode(id: 1, since: now.addingTimeInterval(-60), shown: .unreachable(.silent, since: now), ended: now)
        let cases: [String: (snapshot: HomeLink.ReachSnapshot, outcome: String)] = [
            "answering": (.init(reach: .answering, lastReached: today, revision: 7), "shipped"),
            "answering, its last send held": (.init(reach: .answering, lastReached: today, revision: 7), "held DISK_LOW"),
            "answering, just reached again": (.init(reach: .answering, lastReached: now, revision: 8, episode: reached), "shipped"),
            "waiting": (.init(reach: .waiting(since: now), lastReached: today, revision: 7), "unreachable"),
            "waiting, after a start": (.init(reach: .waiting(since: now), lastReached: today, revision: 7, episode: started), "unreachable"),
            "starting": (.init(reach: .starting(said, since: now), lastReached: today, revision: 7), "unreachable"),
            "unreachable": (.init(reach: .unreachable(.silent, since: now), lastReached: today, revision: 7, routes: here), "unreachable"),
            "unreachable, checking again": (.init(reach: .unreachable(.silent, since: now), lastReached: today, revision: 7, routes: here,
                                                  checking: true), "unreachable"),
            "unreachable, Lifestream not running": (.init(reach: .unreachable(.notRunning, since: now), lastReached: saturday, revision: 7,
                                                          routes: here), "unreachable"),
            "held": (.init(reach: .held(held), lastReached: today, revision: 7), "unreachable"),
            "update, the home's": (.init(reach: .needsUpdate(.home), lastReached: today, revision: 7), "held HOME_TOO_OLD"),
            "update, this Mac's": (.init(reach: .needsUpdate(.device(floor: "0.4.0")), lastReached: today, revision: 7), "held DEVICE_TOO_OLD"),
            "refused": (.init(reach: .passRefused, lastReached: today, revision: 7), "refused PRINCIPAL_UNKNOWN"),
            "unpaired": (.init(reach: .unpaired, lastReached: nil, revision: 0), "no_home"),
        ]
        let states = try XCTUnwrap(fixture["states"] as? [String: [String: Any]])
        XCTAssertEqual(Set(states.keys), Set(cases.keys))
        for (name, made) in cases {
            let state = try XCTUnwrap(states[name], name)
            let words = try XCTUnwrap(state["reach"] as? [String: Any], name)
            let snapshot = made.snapshot
            let strip = ReachWords.strip(snapshot, device: .mac, clock: clock, now: now)
            let back = ReachWords.reached(snapshot, clock: clock, now: now)
            XCTAssertEqual(words["revision"] as? Int, snapshot.revision, name)
            XCTAssertEqual(words["tone"] as? String, strip?.tone.rawValue ?? back.map { _ in "done" }, name)
            XCTAssertEqual(words["title"] as? String, strip?.title ?? back?.title, name)
            XCTAssertEqual(words["line"] as? String, strip?.line ?? back?.line, name)
            XCTAssertEqual(words["meta"] as? String, strip?.meta, name)
            XCTAssertEqual(words["acts"] as? [[String: String]], strip?.act.map { [["do": $0.do, "label": $0.label]] } ?? [], name)
            XCTAssertEqual(words["checking"] as? Bool, snapshot.checking, name)
            XCTAssertEqual(state["sending"] as? String, ReachWords.sending(made.outcome, device: .mac), name)
            let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(HostState.Reach(snapshot, clock: clock, now: now)))
            XCTAssertEqual(encoded as? NSDictionary, words as NSDictionary, name)
        }

        func state(_ door: [String: Any]) throws -> HomeLink.RequestState {
            let notNow: HomeLink.NotNow? = switch door["wait"] as? String {
            case "needs": .needs(held)
            case "starting": .starting(said)
            case "busy": .busy
            default: nil
            }
            return HomeLink.state(status: try XCTUnwrap(door["status"] as? Int), code: door["code"] as? String,
                                  words: (door["words"] ?? door["message"]) as? String, retryAfter: door["retryAfter"] as? Int,
                                  notNow: notNow, now: now)
        }
        let acts = try XCTUnwrap(fixture["acts"] as? [[String: Any]])
        XCTAssertFalse(acts.isEmpty)
        for act in acts {
            let door = try XCTUnwrap(act["door"] as? [String: Any])
            let reply = try XCTUnwrap(act["reply"] as? [String: String])
            let met = try state(door)
            let said = try XCTUnwrap(ReachWords.act(met), "\(door)")
            switch said {
            case .notSent: XCTAssertEqual(reply, ["refused": ReachWords.notSent, "said": "not-sent"], "\(door)")
            case .refused(let words): XCTAssertEqual(reply, ["refused": words, "said": "refused"], "\(door)")
            case .saving: XCTAssertEqual(reply, ["refused": ReachWords.saving, "said": "saving"], "\(door)")
            case .unknown(let words): XCTAssertEqual(reply, ["refused": words, "said": "unknown"], "\(door)")
            }
            let extra = (door["wait"] as? String).flatMap { try? JSONSerialization.data(withJSONObject: ["wait": $0], options: [.sortedKeys]) }
            let socket = HomeSocketError.refused(SocketRefusal(status: door["status"] as? Int, code: door["code"] as? String,
                                                               words: door["message"] as? String ?? "", retryAfter: door["retryAfter"] as? Int,
                                                               extra: extra))
            XCTAssertEqual(act["probe"] as? Bool, socket.reach, "\(door)")
            let host = try XCTUnwrap(MacHost.said(socket, now: now) as? HostRefusal, "\(door)")
            if door["message"] is String { XCTAssertEqual(host.answer as NSDictionary, reply as NSDictionary, "\(door)") }
            XCTAssertEqual(host.said.rawValue, reply["said"], "\(door)")
        }

        let probe = try XCTUnwrap(fixture["probe"] as? [String: Any])
        XCTAssertEqual(HostAct.read(try XCTUnwrap(probe["request"])), .success(.probeHome))

        let outcomes = try XCTUnwrap(fixture["outcomes"] as? [[[String: Any]]])
        XCTAssertFalse(outcomes.isEmpty)
        for outcome in outcomes {
            let (door, expected) = (outcome[0], outcome[1])
            let words = expected["words"] as? String
            let wanted: HomeLink.RequestState? = switch expected["state"] as? String {
            case "reach": .reach
            case "failed": .failed
            case "unknown": words.map { .unknown($0) }
            case "refused": words.map { .refused($0) }
            case "wait": words.map { .wait(words: $0, until: now.addingTimeInterval(expected["after"] as? TimeInterval ?? -1)) }
            default: nil
            }
            XCTAssertEqual(try state(door), try XCTUnwrap(wanted, "\(expected)"), "\(door)")
        }
    }

    func testTheMenuSaysReachThenWhatTheLastSendMetAndTheRecorderLightsOnlyWhatNeedsSaying() {
        let zone = TimeZone(identifier: "Europe/Lisbon")!
        let now = Date(timeIntervalSince1970: 1_791_990_000)
        let clock = HomeClock.placeholder(at: now, zone: zone)
        func line(_ outcome: String?, reach: HomeLink.Reach? = nil, paired: Bool = true) -> String {
            ShippingPresentation(read: true, paired: paired, lastOutcome: outcome, lastRunAt: now,
                                 reach: reach.map { HomeLink.ReachSnapshot(reach: $0, lastReached: now.addingTimeInterval(-120), revision: 3) },
                                 clock: clock, zone: zone, now: now).label
        }
        for outcome in ["shipped", "nothing_new", "nothing_due", "busy", "stale STALE", "held ON_BATTERY", "held HISTORY",
                        "held UPLOAD_ACTIVE", "refused FULL_DISK_ACCESS", "held DISK_FULL"] {
            XCTAssertEqual(line(outcome, reach: .answering), "Lifestream: synced 16:00", outcome)
        }
        XCTAssertEqual(ShippingPresentation(read: false, paired: false, lastOutcome: nil, lastRunAt: nil).label, "Lifestream: reading…")
        XCTAssertEqual(line("shipped", reach: .unreachable(.driveAway, since: now)), "Lifestream's drive isn't connected · since 15:58")
        XCTAssertEqual(line("shipped", reach: .unreachable(.notRunning, since: now)), "Lifestream isn't running on its Mac · since 15:58")
        XCTAssertEqual(line("shipped", reach: .starting(HomeLink.Starting(title: "Lifestream is starting", line: "It answers in a moment."), since: now)),
                       "Lifestream is starting")
        XCTAssertEqual(line("shipped", reach: .waiting(since: now)), "Lifestream: synced 16:00")
        let damaged = HomeLink.Held(title: "Lifestream's database is damaged.", detail: "A check found damage in home.db.")
        XCTAssertEqual(line("unreachable", reach: .held(damaged)), "Lifestream's database is damaged.", "a held home in its door's title")
        XCTAssertEqual(line("refused PRINCIPAL_UNKNOWN", reach: .passRefused), "Lifestream no longer knows this Mac")
        XCTAssertEqual(line("held HOME_TOO_OLD", reach: .needsUpdate(.home)), "Lifestream needs an update")
        XCTAssertEqual(line(nil, reach: .unpaired, paired: false), "This Mac isn't paired")
        XCTAssertEqual(line(nil, reach: nil, paired: false), "This Mac isn't paired", "before the link's first snapshot, one wording")
        for reach: HomeLink.Reach in [.unreachable(.silent, since: now), .held(damaged), .needsUpdate(.home), .passRefused] {
            let snapshot = HomeLink.ReachSnapshot(reach: reach, lastReached: now.addingTimeInterval(-120), revision: 3)
            let running = ShippingPresentation(read: true, paired: true, lastOutcome: "shipped", lastRunAt: now, running: true,
                                               reach: snapshot, clock: clock, zone: zone, now: now)
            XCTAssertEqual(running.label, ReachWords.menuLine(snapshot, clock: clock, now: now), "\(reach) hidden by a run")
            XCTAssertFalse(running.canShipNow, "\(reach)")
        }
        for reach: HomeLink.Reach in [.answering, .waiting(since: now)] {
            XCTAssertEqual(ShippingPresentation(read: true, paired: true, lastOutcome: "shipped", lastRunAt: now, running: true,
                                                reach: HomeLink.ReachSnapshot(reach: reach, lastReached: now, revision: 3),
                                                clock: clock, zone: zone, now: now).label, "Lifestream: syncing…", "\(reach)")
        }
        for outcome in ["unreachable", "held DEVICE_TOO_OLD", "held HOME_TOO_OLD", "refused PRINCIPAL_UNKNOWN"] {
            for reach: HomeLink.Reach in [.waiting(since: now), .answering] {
                XCTAssertEqual(ShippingPresentation(read: true, paired: true, lastOutcome: outcome, lastRunAt: now,
                                                    lastContactAt: now.addingTimeInterval(-3600),
                                                    reach: HomeLink.ReachSnapshot(reach: reach, lastReached: nil, revision: 3),
                                                    clock: clock, zone: zone, now: now).label, "Lifestream: synced 15:00", outcome)
            }
            XCTAssertEqual(line(outcome, reach: .waiting(since: now)), "Lifestream: not synced yet", "\(outcome), the home never answered")
        }
        XCTAssertEqual(line("no_home", reach: .answering), "Lifestream: not synced yet")
        let said: [String: String] = [
            "held CLOCK_AHEAD": "This Mac's clock is ahead of Lifestream's. Set the time automatically in System Settings.",
            "held DISK_LOW": "Waiting for space on Lifestream's disk",
            "refused LOCAL_ACCESS": "This Mac couldn't read one of its apps. Lifestream tries again at the next sync.",
            "refused PRINCIPAL_SCOPE": "Lifestream doesn't let this Mac send that. Pair it again.",
            "refused SOMETHING_NEW": "Lifestream didn't take what this Mac sent",
            "conflict NAME_TAKEN": "Lifestream didn't take what this Mac sent. Lifestream sends it again at the next sync.",
            "held SOMETHING_NEW": "Lifestream didn't take what this Mac sent",
        ]
        XCTAssertNil(ReachWords.sending("held DISK_FULL", device: .mac), "Lifestream's disk full is the banner's, never the sending line's")
        for (outcome, words) in said {
            XCTAssertEqual(line(outcome, reach: .answering), words, outcome)
            XCTAssertEqual(ReachWords.sending(outcome, device: .mac), words, outcome)
        }
        let waiting = { (outcome: String, cost: Metered?) in
            ShippingPresentation(read: true, paired: true, lastOutcome: outcome, lastRunAt: now, waitsForNetwork: true,
                                 metered: cost, zone: zone).label
        }
        XCTAssertEqual(waiting("shipped", .expensive), "Waiting for Wi-Fi")
        XCTAssertEqual(waiting("nothing_new", .lowDataMode), "Waiting: Low Data Mode is on")
        XCTAssertEqual(waiting("shipped", nil), "Lifestream: synced 16:00")
        XCTAssertEqual(waiting("held DISK_LOW", .expensive), "Waiting for space on Lifestream's disk", "the home's disk is said over the network")
        XCTAssertEqual(waiting("refused LOCAL_ACCESS", .expensive), said["refused LOCAL_ACCESS"], "sending words to act on are never hidden")
        XCTAssertEqual(ShippingPresentation(read: true, paired: true, lastOutcome: "shipped", lastRunAt: now, metered: .expensive,
                                            zone: zone).label, "Lifestream: synced 16:00", "a hotspot with nothing waiting is no wait")
        func battery(importing: Bool, onBattery: Bool) -> String {
            let status = ShipperStatus(home: URL(string: "http://127.0.0.1:4680"), lastRunAt: now, lastOutcome: "shipped", lastContactAt: now,
                                       pending: 0, nextRunAt: now, running: false, sources: [], importingHistory: importing)
            return ShippingPresentation(status: status, onBattery: onBattery, zone: zone).label
        }
        XCTAssertEqual(battery(importing: true, onBattery: true), "Lifestream: synced 16:00. Importing history on battery.")
        XCTAssertEqual(battery(importing: true, onBattery: false), "Lifestream: synced 16:00")
        XCTAssertEqual(battery(importing: false, onBattery: true), "Lifestream: synced 16:00")
        let synced = ShippingPresentation(read: true, paired: true, lastOutcome: "shipped", lastRunAt: now, zone: zone)
        let recording = RecorderPresentation(status: RuntimeStatus(state: .recording), running: true)
        XCTAssertEqual(StatusMenuEntry.order.map { $0.title(recording, synced) },
                       ["Recording", recording.detail, nil, "Open Lifestream", "Pause recording", nil,
                        "Lifestream: synced 16:00", "Sync now", "Settings…", nil, "Quit Lifestream"])

        XCTAssertEqual(RecorderPresentation(status: RuntimeStatus(state: .recording), running: true).signal, .engaged)
        XCTAssertTrue(RecorderPresentation(status: RuntimeStatus(state: .recording), running: true).recording)
        XCTAssertEqual(RecorderPresentation(status: RuntimeStatus(state: .stopped), running: false).signal, .idle)
        XCTAssertFalse(RecorderPresentation(status: RuntimeStatus(state: .stopped), running: false).recording)
        XCTAssertEqual(RecorderPresentation(status: RuntimeStatus(state: .permissionRequired), running: true).signal, .caution)

        let refused = ActOutcome.failed(.refused(RecorderPresentation.startFailed))
        let failed = RecorderPresentation(status: RuntimeStatus(state: .stopped), running: false, start: refused)
        XCTAssertEqual(StatusMenuEntry.order.map { $0.title(failed, synced) },
                       ["Recording paused", RecorderPresentation.startFailed, nil, "Open Lifestream", "Start recording", nil,
                        "Lifestream: synced 16:00", "Sync now", "Settings…", nil, "Quit Lifestream"])
        XCTAssertTrue(failed.failed)
        let again = RecorderPresentation(status: RuntimeStatus(state: .stopped), running: false, start: .running)
        XCTAssertFalse(again.failed)
        XCTAssertNotEqual(again.detail, RecorderPresentation.startFailed)
        let running = RecorderPresentation(status: RuntimeStatus(state: .recording), running: true, start: refused)
        XCTAssertFalse(running.failed)
        XCTAssertEqual(running.detail, recording.detail)

        XCTAssertEqual(DashboardFailure.clock(now, zone: zone), "16:00:00")
    }

    func testTheMenuBarGlyphIsTheLogosMarkWithTheDotOnlyWhileRecording() async throws {
        let paused = StreamMark.image(recording: false)
        let recording = StreamMark.image(recording: true)
        XCTAssertTrue(paused.isTemplate && recording.isTemplate)
        XCTAssertEqual(paused.size, NSSize(width: 18, height: 18))
        func bitmap(_ image: NSImage, scale: Int, ink: NSColor = .black, bar: NSColor = .clear) throws -> NSBitmapImageRep {
            let side = Int(image.size.width) * scale
            let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8,
                                                        samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                                        bytesPerRow: 0, bitsPerPixel: 0))
            bitmap.size = image.size
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
            let rect = NSRect(origin: .zero, size: image.size)
            let tinted = NSImage(size: image.size, flipped: false) { rect in
                image.draw(in: rect)
                ink.set()
                rect.fill(using: .sourceAtop)
                return true
            }
            bar.setFill()
            rect.fill()
            tinted.draw(in: rect)
            NSGraphicsContext.restoreGraphicsState()
            return bitmap
        }
        func inked(_ image: NSImage, _ rect: NSRect) throws -> Int {
            let drawn = try bitmap(image, scale: 2)
            var count = 0
            for x in Int(rect.minX * 2)..<Int(rect.maxX * 2) {
                for y in Int(rect.minY * 2)..<Int(rect.maxY * 2) where (drawn.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.5 { count += 1 }
            }
            return count
        }
        let corner = StreamMark.dot.insetBy(dx: -1, dy: -1)
        XCTAssertEqual(try inked(paused, corner), 0, "the dot shows while paused, or the mark comes within a point of it")
        XCTAssertGreaterThan(try inked(recording, corner), 10, "no dot while recording")
        let whole = NSRect(x: 0, y: 0, width: 18, height: 18)
        let added = try inked(recording, whole) - inked(paused, whole)
        XCTAssertEqual(added, try inked(recording, corner), "the dot changed the mark")

        let logo = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            context.addPath(LogoMark.glyph(in: StreamMark.mark).cgPath)
            context.fillPath()
            return true
        }
        XCTAssertEqual(try bitmap(paused, scale: 2).tiffRepresentation, try bitmap(logo, scale: 2).tiffRepresentation,
                       "the menu bar draws a mark other than the logo's")
        XCTAssertGreaterThan(try inked(paused, whole), 200, "the mark is not drawn")

        try FileManager.default.createDirectory(at: Shots.folder, withIntermediateDirectories: true)
        let bars: [(String, NSColor, NSColor)] = [("light", NSColor(white: 0.96, alpha: 1), .black), ("dark", NSColor(white: 0.12, alpha: 1), .white)]
        for (name, image) in [("paused", paused), ("recording", recording)] {
            for (look, bar, ink) in bars {
                for scale in [1, 2] {
                    let png = try XCTUnwrap(try bitmap(image, scale: scale, ink: ink, bar: bar).representation(using: .png, properties: [:]))
                    let url = Shots.folder.appendingPathComponent("menubar-glyph-\(name)-\(look)@\(scale)x.png")
                    try png.write(to: url)
                    print("drawn: \(url.path)")
                }
            }
        }
    }

    func testHelpsTourWaitsForTheFirstRunsWindowToLeaveTheOnboarding() async throws {
        let app = NSApplication.shared
        let before = (app.mainMenu, app.windowsMenu, app.helpMenu)
        defer { (app.mainMenu, app.windowsMenu, app.helpMenu) = before }
        let release = scratch.appendingPathComponent("release")
        let index = release.appendingPathComponent("dashboard/public/index.html")
        try FileManager.default.createDirectory(at: index.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"<!doctype html><html><head><meta charset="utf-8"><title>Lifestream</title></head><body></body></html>"#.utf8).write(to: index)
        let port = DashboardAddress.defaultPort
        let saved = "http://127.0.0.1:\(port)/#view="
        let first = window(port: port, carrying: release)
        defer { first.close() }
        var open: MainWindowController? = first
        var requested: [String] = []
        let tour = MainMenu.Tour(shown: { open?.web }, defaults: defaults, open: { page in
            requested.append(page)
            open?.present(hash: page)
        })
        var feedbackAsked: [String] = []
        var seenNow = true
        let feedback = MainMenu.Feedback(seen: { seenNow }, open: { page, pictured in
            feedbackAsked.append(pictured ? page : page + " shut")
            open?.present(hash: page, pictured: pictured)
        })
        let target = MenuTarget()
        let other = #selector(MenuTarget.other)
        let actions = MainMenu.Actions(target: target, quit: other, toggle: other, shipNow: other, settings: other, tour: tour,
                                       feedback: feedback)
        let main = MainMenu.install(actions, presentation: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true))
        XCTAssertIdentical(app.mainMenu, main)
        XCTAssertEqual(main.items.map(\.title), ["Lifestream", "Edit", "View", "Recording", "Window", "Help"], "Help is not last, after Window")
        XCTAssertEqual(main.item(withTitle: "Recording")?.submenu?.items.map(\.title), ["Pause recording", "Sync now"],
                       "the Recording menu holds more than the menu bar's actions")
        XCTAssertIdentical(app.windowsMenu, main.item(withTitle: "Window")?.submenu)
        let help = try XCTUnwrap(main.item(withTitle: "Help")?.submenu)
        XCTAssertIdentical(app.helpMenu, help, "Help is not the app's help menu, so macOS adds no Search field")
        XCTAssertEqual(help.items.map(\.title), ["Lifestream Tour", "Send Feedback…"])
        XCTAssertIdentical(help.items[1].target, feedback)
        XCTAssertEqual(help.items[1].action, #selector(MainMenu.Feedback.send(_:)))
        let item = try XCTUnwrap(help.items.first)
        XCTAssertIdentical(item.target, tour, "Lifestream Tour goes to the window's controller, which a window not yet made has none of")
        XCTAssertEqual(item.action, #selector(MainMenu.Tour.show(_:)))
        func offered() -> Bool {
            help.update()
            return item.isEnabled
        }

        first.present(hash: "view=onboarding&seg=model")
        try await until("first.web.loaded") { first.web.loaded }
        XCTAssertEqual(first.web.currentURL.scheme, BundledPage.scheme)
        XCTAssertEqual(defaults.string(forKey: "DashboardLastURL"), saved + "onboarding")
        XCTAssertFalse(offered(), "Lifestream Tour offered while the window shows the onboarding")
        help.performActionForItem(at: 0)
        XCTAssertEqual(requested, [], "a press while greyed asked for the walk")
        first.web.show(hash: Self.tourPage)
        try await until("the place saved is Ask") { defaults.string(forKey: "DashboardLastURL") == saved + "ask" }
        XCTAssertEqual(first.web.currentURL.absoluteString, "\(BundledPage.scheme)://\(BundledPage.host)/#\(Self.tourPage)")
        XCTAssertTrue(offered(), "Lifestream Tour greyed after Get started: the first run's window kept the onboarding's place")
        first.web.show(hash: "view=people")
        try await until("the place saved is People") { defaults.string(forKey: "DashboardLastURL") == saved + "people" }
        help.performActionForItem(at: 0)
        XCTAssertEqual(requested, [Self.tourPage], "the walk asked for elsewhere than Ask's first step")
        try await until("the window shows the walk") { first.web.currentURL.fragment == Self.tourPage }
        try await until("the place saved is Ask") { defaults.string(forKey: "DashboardLastURL") == saved + "ask" }

        help.performActionForItem(at: 1)
        XCTAssertEqual(feedbackAsked, ["dialog=feedback"], "Send Feedback… opened elsewhere than the form, or as if the window were shut")
        try await until("the window shows the form") { first.web.currentURL.fragment == MainMenu.Feedback.page }
        let taken = try await first.host.reply(.screenshotTake)
        let jpeg = try XCTUnwrap((taken["jpeg"] as? String).flatMap { Data(base64Encoded: $0) }, "the window was open, yet no picture of it")
        XCTAssertEqual(Array(jpeg.prefix(3)), [0xFF, 0xD8, 0xFF], "the window's picture is not a JPEG")
        seenNow = false
        help.performActionForItem(at: 1)
        XCTAssertEqual(feedbackAsked, ["dialog=feedback", "dialog=feedback shut"])
        let shut = try await first.host.reply(.screenshotTake)
        XCTAssertNil(shut["jpeg"], "the window was shut when Send Feedback… was chosen, yet its picture was offered")
        let later = try await first.host.reply(.screenshotTake)
        XCTAssertNotNil(later["jpeg"], "the form after a shut window's offered no picture ever again")

        open = nil
        XCTAssertTrue(offered(), "Lifestream Tour greyed with the window closed after the onboarding")
        defaults.set(saved + "onboarding", forKey: "DashboardLastURL")
        XCTAssertFalse(offered(), "Lifestream Tour offered while a window opened again would go on with the onboarding")
        defaults.removeObject(forKey: "DashboardLastURL")
        XCTAssertTrue(offered(), "Lifestream Tour greyed on a Mac whose window never opened")
    }

    private static let tourPage = "view=ask&tour=1"

    private final class MenuTarget: NSObject {
        @objc func other() {}
    }

    func testTheWindowIsDrawn() async throws {
        let server = try PageServer(["/": ("text/html", Data(Self.page.utf8))])
        defer { server.stop() }
        let port = try await server.ready()
        let controller = window(port: port)
        defer { controller.close() }
        controller.web.show(hash: "view=connectors&dialog=\(AppSection.thisMac)")
        XCTAssertEqual(controller.web.currentURL.fragment, "view=connectors&dialog=settings/mac", "another page loads first")
        let window = try XCTUnwrap(controller.window)
        window.setFrame(NSRect(x: 0, y: 0, width: 1100, height: 680), display: false)
        try await until("controller.web.loaded && controller.host.state.folder != nil && !controller.web.container.isHidden") { controller.web.loaded && controller.host.state.folder != nil && !controller.web.container.isHidden }
        XCTAssertEqual(controller.web.currentURL.fragment, "view=connectors&dialog=settings/mac")
        let page = try XCTUnwrap(controller.web.container.subviews.first as? WKWebView)
        XCTAssertEqual(page.convert(page.bounds, to: nil).maxY, window.frame.height, "the page starts below the window's top")

        let frame = try XCTUnwrap(window.contentView?.superview)
        let band = try XCTUnwrap(frame.hitTest(NSPoint(x: 400, y: window.frame.height - 10)))
        XCTAssertTrue(band.isDescendant(of: page), "the title bar's band takes the page's press: \(band)")
        let close = try XCTUnwrap(window.standardWindowButton(.closeButton))
        let centre = close.convert(NSPoint(x: close.bounds.midX, y: close.bounds.midY), to: nil)
        XCTAssertTrue(try XCTUnwrap(frame.hitTest(centre)).isDescendant(of: close), "the close button does not take its press")

        for (scheme, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
            window.appearance = NSAppearance(named: appearance)
            try await until("controller.web.title == \"Lifestream · \\(scheme)\"") { controller.web.title == "Lifestream · \(scheme)" }
            try await draw(controller, to: "window-page-\(scheme).png", appearance: appearance)
        }

        controller.host.needs.noticed([HomeReport.knock("arc", "Arc has been asking to connect since 14:02")])
        try await until("the browser's need in the state") { controller.host.state.needs.map(\.id) == ["connect:arc"] }
        _ = try await controller.host.perform(.need(key: "connect:arc", button: .do))
        try await until("the page at the browser flow") { controller.web.currentURL.fragment?.hasSuffix("dialog=settings/chrome&flow=browser") == true }
        var doors: [RecoveryKey.Door] = []
        controller.host.needs.openKey = { doors.append($0) }
        try await controller.host.press(.saveRecoveryKey(keyed: false), .do)
        XCTAssertEqual(doors, [.asked], "Save your recovery key did not open the recovery key window")
        XCTAssertEqual(controller.web.currentURL.fragment?.hasSuffix("dialog=settings/chrome&flow=browser"), true, "the recovery key need moved the page")
        XCTAssertNil(controller.host.sheet, "a native sheet opened for the recovery key")
        controller.host.needs.noticed([])

        XCTAssertEqual(window.title, controller.web.title)
        XCTAssertEqual(window.titleVisibility, .hidden)
        let drawn = Self.views(in: frame).compactMap { $0 as? NSTextField }.filter { !$0.isHiddenOrHasHiddenAncestor && $0.stringValue == window.title }
        XCTAssertTrue(drawn.isEmpty, "the window's title is drawn on its frame: \(drawn)")

        let failing = self.window(port: try await Self.closedPort())
        defer { failing.close() }
        failing.window?.setFrame(NSRect(x: 0, y: 0, width: 1100, height: 680), display: false)
        failing.host.needs.updated(.refused("the self-check refused: a synthetic problem"))
        failing.host.needs.noticed([HomeReport.password("gmail.password", connector: "gmail", member: "password",
                                                        "Gmail refused its app password: make a new one and type it here"),
                                    HomeReport.knock("arc", "Arc has been asking to connect since 14:02")])
        try await until("failing.web.failing && failing.host.needs.list.count == 3") { failing.web.failing && failing.host.needs.list.count == 3 }
        for (scheme, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
            try await draw(failing, to: "window-failure-\(scheme).png", appearance: appearance)
        }
    }

    func testTheWindowHandsTheHostItsSight() async throws {
        let page = """
        <!doctype html><html><head><title>Lifestream</title><script>
        webkit.messageHandlers.lifestream.postMessage({type: "act", act: "pairing", do: "open"});
        </script></head><body>The iPhone step</body></html>
        """
        let server = try PageServer(["/": ("text/html", Data(page.utf8))])
        defer { server.stop() }
        let port = try await server.ready()
        let home = try ScriptedHome(HostV6Tests.Home().answer)
        defer { home.stop() }
        let socket = HomeSocket(path: home.path, folder: home.folder)
        let keeper = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { socket })
        let host = MacHost(needs: NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper)),
                           lines: StatusLines(recorder: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true)),
                           socket: { socket },
                           readGrants: { [:] }, readFolder: { nil }, unit: { "macbook-pro-0001" }, ask: .untouched, poll: .milliseconds(20))
        var visible = true
        var looks = 0
        let controller = MainWindowController(web: WebContent(address: DashboardAddress(port: port), defaults: defaults, dashboardHeld: { true }),
                                              host: host, onScreen: false, sight: {
                                                  looks += 1
                                                  return visible
                                              }, closed: {})
        defer { controller.close() }
        func shows() -> Int { home.requests.filter { $0["verb"] as? String == "pair" && ($0["args"] as? [String])?.first == "show" }.count }

        try await until("the page's card wanted and its code in the state") { host.state.pairing != nil }
        visible = false
        _ = try await host.perform(.at(step: "iphone"))
        let asked = shows()
        let before = looks
        try await until("five more looks at the window's sight") { looks >= before + 5 }
        XCTAssertEqual(shows(), asked, "the code was asked for while the window was unseen")
        XCTAssertNotNil(host.state.pairing, "the code left the state while the window was unseen")
        visible = true
        try await until("the code asked for once the window is seen again") { shows() > asked }
    }

    func testAClosedWindowKeepsItsPageAndOpensAgainAtOnceWhereAsked() async throws {
        let page = """
        <!doctype html><html><head><title>Lifestream</title><script>
        window.made = Math.random();
        webkit.messageHandlers.lifestream.postMessage({type: "act", act: "pairing", do: "open"});
        </script></head><body>The iPhone step</body></html>
        """
        let server = try PageServer(["/": ("text/html", Data(page.utf8))])
        defer { server.stop() }
        let port = try await server.ready()
        let home = try ScriptedHome(HostV6Tests.Home().answer)
        defer { home.stop() }
        let socket = HomeSocket(path: home.path, folder: home.folder)
        let keeper = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { socket })
        var reads = 0
        let host = MacHost(needs: NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper)),
                           lines: StatusLines(recorder: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true)),
                           socket: { socket },
                           readGrants: {
                               reads += 1
                               return [:]
                           }, readFolder: { nil }, unit: { "macbook-pro-0001" }, ask: .untouched, poll: .milliseconds(20))
        let controller = MainWindowController(web: WebContent(address: DashboardAddress(port: port), defaults: defaults, dashboardHeld: { true }),
                                              host: host, release: "0f2978746aa0", onScreen: false, sight: { true }, closed: {})
        defer { controller.drop() }
        func shows() -> Int { home.requests.filter { $0["verb"] as? String == "pair" && ($0["args"] as? [String])?.first == "show" }.count }
        func made() async throws -> Double {
            let made = try await controller.web.page?.evaluateJavaScript("window.made")
            return try XCTUnwrap(made as? Double)
        }

        try await until("the page loaded, its card wanted and its code in the state") { controller.web.loaded && host.state.pairing != nil }
        try await until("this Mac read as the window opened") { reads > 0 }
        let document = try await made()
        let view = try XCTUnwrap(controller.web.page)
        XCTAssertTrue(controller.keeps(carried: false, release: "1a2b3c4d5e6f"), "an open window gave up its page")

        controller.close()
        XCTAssertTrue(controller.kept)
        XCTAssertTrue(host.closed, "the window closed and its host still runs")
        XCTAssertNil(host.state.pairing, "the code stayed in the state past the window's close")
        _ = try await host.perform(.at(step: "iphone"))
        let asked = shows()
        let read = reads
        host.wake()
        _ = try await host.perform(.at(step: "iphone"))
        XCTAssertEqual(shows(), asked, "the code was asked for while the window was closed")
        XCTAssertNil(host.state.pairing)
        XCTAssertTrue(controller.web.page === view, "the closed window let its web view go")
        XCTAssertTrue(controller.web.loaded)

        XCTAssertTrue(controller.keeps(carried: false, release: "0f2978746aa0"))
        XCTAssertFalse(controller.keeps(carried: false, release: "1a2b3c4d5e6f"), "opened again over an older release's page")
        XCTAssertFalse(controller.keeps(carried: false, release: nil), "opened again over a release no longer current")
        XCTAssertFalse(controller.keeps(carried: true, release: nil), "the dashboard's page opened again for the first run")

        controller.present(hash: "view=connectors&dialog=\(AppSection.settings)")
        XCTAssertFalse(controller.kept)
        XCTAssertFalse(host.closed, "opened again and its host not started")
        try await until("the hash asked, in the same document") { controller.web.currentURL.fragment == "view=connectors&dialog=settings" }
        XCTAssertTrue(controller.web.page === view, "opened again on another web view")
        let again = try await made()
        XCTAssertEqual(again, document, "opened again on a new document: the page was loaded again")
        try await until("the code asked for at once, the page saying nothing again") { shows() > asked && host.state.pairing != nil }
        try await until("this Mac read again as the window opened") { reads > read }

        controller.close()
        controller.drop()
        XCTAssertNil(controller.web.page, "a window dropped kept its web view")
    }

    func testALaunchOpensOnChatAndTheSameRunKeepsWhereTheWindowWas() async throws {
        let server = try PageServer(["/": ("text/html", Data(Self.page.utf8))])
        defer { server.stop() }
        let port = try await server.ready()
        let saved = "http://127.0.0.1:\(port)/#view="
        defaults.set(saved + "days", forKey: "DashboardLastURL")
        let launched = window(port: port, launch: true)
        launched.present(nil)
        try await until("the launch opened on Chat, not the place saved") { launched.web.loaded && launched.web.currentURL.fragment == "view=ask" }
        launched.web.show(hash: "view=people")
        try await until("the place saved is People") { defaults.string(forKey: "DashboardLastURL") == saved + "people" }
        launched.close()
        launched.present(nil)
        XCTAssertEqual(launched.web.currentURL.fragment, "view=people", "the window closed and opened again left its place")
        launched.drop()

        let again = window(port: port)
        defer { again.drop() }
        again.present(nil)
        try await until("a window made again in the same run opened where it was") { again.web.loaded && again.web.currentURL.fragment == "view=people" }

        defaults.set(saved + "onboarding", forKey: "DashboardLastURL")
        let onboarding = window(port: port, launch: true)
        defer { onboarding.drop() }
        onboarding.present(nil)
        try await until("a launch left in the onboarding went on with it") { onboarding.web.loaded && onboarding.web.currentURL.fragment == "view=onboarding" }
    }

    func testAClosedDashboardWindowIsNotKeptForAFirstRunDue() async throws {
        let controller = window(port: try await Self.closedPort())
        defer { controller.drop() }
        controller.close()
        XCTAssertFalse(controller.keeps(carried: true, release: nil), "a closed dashboard window kept for the first run")
        XCTAssertNil(controller.host.setup, "the dashboard's host can set up")
        controller.present(hash: "view=connectors&dialog=\(AppSection.settings)")
        XCTAssertTrue(controller.keeps(carried: true, release: nil), "an open window gave up its page")
    }

    func testAFailedPageOpenedAgainLoadsWhereItWasAsked() async throws {
        let port = try await Self.closedPort()
        let controller = window(port: port)
        defer { controller.drop() }
        try await until("the page failing") { controller.web.failing }
        controller.close()
        let page = "<!doctype html><html><head><title>Lifestream</title></head><body>Back</body></html>"
        let server = try PageServer(["/": ("text/html", Data(page.utf8))], port: try XCTUnwrap(NWEndpoint.Port(rawValue: UInt16(port))))
        defer { server.stop() }
        _ = try await server.ready()
        controller.present(hash: "view=connectors&dialog=\(AppSection.settings)")
        try await until("the page loaded again") { controller.web.loaded && !controller.web.failing }
        XCTAssertEqual(controller.web.currentURL.fragment, "view=connectors&dialog=settings", "opened again where it was, not where asked")
    }

    func testEachOfTheNineStreamsDialogsStandsWholeInAWindow860Tall() async throws {
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        var files = try Self.dashboardFiles(repo)
        XCTAssertNotNil(files["/index.html"], "the dashboard's pages are not in this checkout")

        let report = try await gallery(files, "const gallery = await import('/kit-gallery-report.js'); return JSON.stringify(gallery.REPORT);")
        files["/api/page/connectors"] = ("application/json", Data(report.utf8))

        let server = try PageServer(files)
        defer { server.stop() }
        let port = try await server.ready()
        let controller = window(port: port)
        defer { controller.close() }
        let window = try XCTUnwrap(controller.window)
        window.setFrame(NSRect(x: 0, y: 0, width: 1200, height: 860), display: false)
        window.appearance = NSAppearance(named: .darkAqua)
        controller.web.show(hash: "view=connectors&dialog=claude")
        try await until("controller.web.loaded && !controller.web.container.isHidden") { controller.web.loaded && !controller.web.container.isHidden }
        let page = try XCTUnwrap(controller.web.container.subviews.first as? WKWebView)

        let nine = [("claude", "Claude"), ("whatsapp", "WhatsApp"), ("gmail", "Gmail"), ("screen", "Screen"), ("whoop", "WHOOP"),
                    ("chatgpt", "ChatGPT"), ("google-takeout", "Google activity"), ("location", "Location"), ("github", "GitHub")]
        for (id, name) in nine {
            if id == "location" {
                controller.web.show(hash: "view=connectors&dialog=settings/iphone/iphone-17-pro-aa01")
                let row = #"document.querySelector('[data-part="dialog"] [data-cn-do="' + CSS.escape(JSON.stringify({ open: 'location', push: true })) + '"]')"#
                try await until("the iPhone's Settings page offers Location's dialog") {
                    (try? await page.evaluateJavaScript("!!\(row)") as? Bool) == true
                }
                _ = try? await page.evaluateJavaScript("\(row).click(); true")
            } else {
                controller.web.show(hash: "view=connectors&dialog=\(id)")
            }
            try await standsWhole(page, name, title: name, scrolls: true)
            let pills = try await page.evaluateJavaScript(
                #"JSON.stringify([...document.querySelectorAll('[data-part="dialog"] [role="tab"]')].map(each => each.dataset.cnTab))"#) as? String
            let tabs = try JSONDecoder().decode([String].self, from: Data((pills ?? "[]").utf8))
            XCTAssertNotEqual(tabs.count, 1, "\(name): a single pill drawn")
            for tab in tabs.isEmpty ? [""] : tabs {
                let pill = #"dialog.querySelector('[data-cn-tab="\#(tab)"]')"#
                if !tab.isEmpty { _ = try await page.evaluateJavaScript("(() => { const dialog = document.querySelector('[data-part=\"dialog\"] .ck-dialog'); \(pill).click(); return true; })()") }
                let seen = "\(name)\(tab.isEmpty ? "" : " \(tab)")"
                let shown = try await standsWhole(page, seen, title: name,
                                                  shows: tab.isEmpty ? "true" : "\(pill)?.getAttribute('aria-selected') === 'true'", scrolls: true)
                let file = "window-stream-\(id)\(tab.isEmpty ? "" : "-\(tab)")"
                try await draw(controller, to: "\(file)-dark.png", appearance: .darkAqua)
                try await scrolledToItsEnd(page, seen)
                if shown.over > 0 { try await draw(controller, to: "\(file)-end-dark.png", appearance: .darkAqua) }
            }
        }
    }

    func testEachFlowInEachOfItsStatesStandsWholeInAWindow860Tall() async throws {
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        var files = try Self.dashboardFiles(repo)
        XCTAssertNotNil(files["/index.html"], "the dashboard's pages are not in this checkout")

        let made = try await gallery(files, """
        const { REPORT } = await import('/kit-gallery-report.js');
        const extension = (present, patch = {}) => ({ ...REPORT, needs: [],
          connectors: REPORT.connectors.map(each => each.roads.includes('chrome') ? { ...each, ...patch } : each),
          extension: { ...REPORT.extension, present, browsers: present ? ['Arc'] : [] } });
        const phone = REPORT.devices.find(each => each.kind === 'phone' && each.pass !== null);
        const waiting = extension(false, { set_up: false, chosen: false, signed_in: null, browser: null, copies: [] });
        const knock = { id: 'connect:Arc', state: 'needs-you', reason: null, words: 'Arc has been asking to connect since 14:02',
          since_ms: REPORT.at_ms - 240000, next_ms: null, acts: [{ do: 'browser', label: 'Connect', of: 'Arc' }], detail: null,
          connector: null, copy: null, unit: null, at: null };
        return JSON.stringify({
          streams: REPORT,
          none: { ...REPORT, devices: REPORT.devices.filter(each => each.kind !== 'phone') },
          paired: { ...REPORT, devices: REPORT.devices.map(each => each === phone
            ? { ...each, unit: 'iphone-aa02', name: 'iPhone 17 Pro', pass: 'p-0a0a0a0a' } : each) },
          waiting,
          knocking: { ...waiting, needs: [knock] },
          signed: extension(true),
        });
        """)
        let reports = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(made.utf8)) as? [String: Any])
        files["/api/page/connectors"] = ("application/json", try JSONSerialization.data(withJSONObject: XCTUnwrap(reports["streams"])))
        for (name, report) in reports {
            files["/api/page/connectors?unit=flows-\(name)"] = ("application/json", try JSONSerialization.data(withJSONObject: report))
        }
        files["/api/page/connectors?unit=flows-unread"] = ("application/json", Data("not a report".utf8))

        let server = try PageServer(files)
        defer { server.stop() }
        let port = try await server.ready()
        let controller = window(port: port)
        defer { controller.close() }
        let window = try XCTUnwrap(controller.window)
        window.setFrame(NSRect(x: 0, y: 0, width: 1200, height: 860), display: false)
        window.appearance = NSAppearance(named: .darkAqua)
        controller.web.show(hash: "view=connectors&dialog=settings/home")
        try await until("the page loaded and this Mac read") {
            controller.web.loaded && !controller.web.container.isHidden && controller.host.state.folder != nil
        }
        let page = try XCTUnwrap(controller.web.container.subviews.first as? WKWebView)

        controller.host.needs.noticed([HomeReport.knock("arc", "Arc has been asking to connect since 14:02")])
        try await until("the browser's need in the state") { controller.host.state.needs.contains { $0.id == "connect:arc" } }
        let knock = controller.host.state.needs.filter { $0.id == "connect:arc" }
        controller.host.needs.noticed([])
        try await until("the host back to no need") { !controller.host.state.needs.contains { $0.id == "connect:arc" } }
        controller.host.published = { _ in }
        let base = controller.host.state

        func run(_ script: String) async throws {
            _ = try await page.evaluateJavaScript("\(script); true")
        }
        func put(_ report: String, _ change: (inout HostState) -> Void) async throws {
            var state = base
            state.unit = "flows-\(report)"
            change(&state)
            controller.web.push(state)
            try await run("window.dispatchEvent(new Event('focus'))")
        }
        enum Place: String { case dialog, over }
        let origins = ["vault": "settings/recovery", "phone": "settings/iphone", "browser": "settings/chrome"]
        func open(_ flow: String, _ place: Place) async throws {
            controller.web.show(hash: "view=days")
            try await until("the flow before \(flow) put away") {
                (try? await page.evaluateJavaScript("/^#view=days(&on=[0-9-]+)?$/.test(location.hash) && !document.querySelector('[data-flow-root]')") as? Bool) == true
            }
            controller.web.show(hash: place == .dialog ? "dialog=\(origins[flow] ?? "")&flow=\(flow)" : "view=days&flow=\(flow)")
            try await until("\(flow) open") {
                (try? await page.evaluateJavaScript("!!document.querySelector('[data-flow-root]')") as? Bool) == true
            }
        }
        func press(_ key: String) async throws {
            let dialog = "document.querySelector('[data-flow-root]').closest('.ck-dialog')"
            try await run(key == "close" ? "(\(dialog).querySelector('[data-flow=\"close\"]') ?? \(dialog).querySelector('[data-flow=\"back\"]')).click()"
                : "\(dialog).querySelector('[data-flow=\"\(key)\"]').click()")
        }
        func see(_ flow: String, _ state: String, _ place: Place, title: String, shows: String) async throws {
            try await standsWhole(page, "\(flow) · \(state) · \(place)", title: title, shows: shows)
            try await draw(controller, to: "window-flow-\(flow)-\(state)-\(place.rawValue)-dark.png", appearance: .darkAqua)
        }

        let later = Int64(Date().timeIntervalSince1970 * 1000) + 600_000
        func vault(_ state: String) -> (inout HostState) -> Void {
            { $0.vault = HostState.Vault(state: state) }
        }
        func pairing(why: String? = nil) -> (inout HostState) -> Void {
            let answer = why == nil ? PairingAnswer(code: "ABCD2345", link: "lifestream://pair?code=ABCD2345", match: "4F7K", expiresMs: later)
                : PairingAnswer(code: "ABCD2345", why: why, match: "4F7K", expiresMs: later)
            return { state in
                state.pairing = HostState.Pairing(answer, qr: answer.link.flatMap(QRImage.dataURL))
                state.phoneApp = .shown
            }
        }
        let arc = Detection.Browser(id: "arc", name: "Arc", profiles: [.init(id: "Default", name: "Person A")])
        let chrome = Detection.Browser(id: "chrome", name: "Chrome", profiles: [.init(id: "Default", name: "Person A")])
        func browsers(_ list: [Detection.Browser], asking: Bool = false, knocking: Bool = false) -> (inout HostState) -> Void {
            { state in
                state.browsers = list
                state.connectRequests = asking ? [ConnectRequest(id: "request-1", browser: "Arc")] : nil
                state.needs = base.needs + (knocking ? knock : [])
            }
        }

        for place in [Place.dialog, .over] {
            if place == .over {
                try await put("unread", browsers([arc, chrome]))
                try await open("browser", place)
                try await see("browser", "unread", place, title: "Add Lifestream to Arc",
                              shows: "!!dialog.querySelector('.ck-grow[aria-hidden=\"true\"]')")
            }
            try await put("streams", vault("none"))
            try await open("vault", place)
            try await see("vault", "to-make", place, title: "Create your vault", shows: "text.includes('All passwords and secrets go here.')")

            let app = "text.includes('I have the app') && text.includes('Get the app') && text.includes('Scan the code') && !text.includes('Or type ABCD 2345') && !dialog.querySelector('[data-flow=\"phone-app\"]')"
            let code = "text.includes('Or type ABCD 2345 on your iPhone.') && !!dialog.querySelector('[data-flow=\"phone-app\"]') && !text.includes('I have the app')"
            try await put("none", pairing())
            try await open("phone", place)
            try await see("phone", "code", place, title: "Connect your iPhone", shows: code)
            try await press("phone-app")
            try await see("phone", "app", place, title: "Connect your iPhone", shows: app)
            try await press("pair-code")
            try await see("phone", "code-again", place, title: "Connect your iPhone", shows: code)
            try await press("phone-app")
            try await see("phone", "app-again", place, title: "Connect your iPhone", shows: app)
            try await press("pair-code")
            try await see("phone", "code-back", place, title: "Connect your iPhone", shows: code)
            try await put("none", pairing(why: "Lifestream can’t open its Wi-Fi connection."))
            try await see("phone", "not-listening", place, title: "Connect your iPhone", shows: "text.includes('Wi-Fi connection')")
            if place == .dialog {
                try await put("paired", pairing())
                try await see("phone", "paired", place, title: "Connect your iPhone",
                              shows: "text.includes('iPhone 17 Pro') && text.includes('Pair another iPhone')")
                try await press("pair-another")
                try await see("phone", "another", place, title: "Connect your iPhone",
                              shows: "text.includes('iPhone 17 Pro') && text.includes('Or type ABCD 2345 on your iPhone.')")
            }
            try await put("paired", pairing())
            try await open("phone", place)
            try await see("phone", "paired-before", place, title: "Connect your iPhone",
                          shows: "text.includes('Or type ABCD 2345 on your iPhone.') && !text.includes('iPhone 17 Pro')")

            try await put("waiting", browsers([]))
            try await open("browser", place)
            try await see("browser", "no-browser", place, title: "Add Lifestream to Chrome", shows: "text.includes('You need Chrome')")
            try await put("waiting", browsers([chrome]))
            try await see("browser", "one-browser", place, title: "Add Lifestream to Chrome",
                          shows: "text.includes('Add to Chrome') && text.includes('After the extension')")
            try await put("waiting", browsers([arc, chrome]))
            try await see("browser", "two-browsers", place, title: "Add Lifestream to Arc",
                          shows: "!!dialog.querySelector('[data-flow-menu]') && text.includes('After the extension')")
            try await put("knocking", browsers([arc, chrome], knocking: true))
            try await open("browser", place)
            try await see("browser", "knock", place, title: "Add Lifestream to Arc",
                          shows: "text.includes('Waiting for Arc to ask again.')")
            try await put("knocking", browsers([arc, chrome], asking: true, knocking: true))
            try await see("browser", "asking", place, title: "Add Lifestream to Arc", shows: "text.includes('Arc wants to connect')")
            try await run("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))")
            try await see("browser", "put-away", place, title: "Add Lifestream to Arc", shows: "text.includes('Allow Arc')")
            try await put("signed", browsers([arc, chrome]))
            try await open("browser", place)
            try await see("browser", "signed-in", place, title: "Add Lifestream to Arc", shows: "text.includes('Connected to Arc')")
        }

        try await put("streams") { $0.general = General.State(login: true, autoUpdate: false, version: "2026.11.10", update: nil) }
        controller.web.show(hash: "view=days&dialog=\(AppSection.thisMac)")
        try await standsWhole(page, "settings · this mac", title: "This Mac",
                              shows: "text.includes('Open at login') && text.includes('Uninstall Lifestream')", scrolls: true)
        try await draw(controller, to: "window-settings-mac-dark.png", appearance: .darkAqua)
        controller.web.show(hash: "view=days&dialog=\(AppSection.settings)/updates")
        try await standsWhole(page, "settings · updates", title: "Updates",
                              shows: "text.includes('2026.11.10') && text.includes('Install updates automatically')", scrolls: true)
        try await draw(controller, to: "window-settings-updates-dark.png", appearance: .darkAqua)
    }

    private func gallery(_ files: [String: (type: String, body: Data)], _ script: String) async throws -> String {
        var files = files
        files["/stand-in.html"] = ("text/html", Data("<!doctype html><title>stand-in</title>".utf8))
        let reading = try PageServer(files)
        defer { reading.stop() }
        let reader = WKWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
        let port = try await reading.ready()
        reader.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/stand-in.html")!))
        try await until("reader.title == \"stand-in\" && !reader.isLoading") { reader.title == "stand-in" && !reader.isLoading }
        let answer = try await reader.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page)
        return try XCTUnwrap(answer as? String)
    }

    private struct Open: Decodable {
        let title: String
        let shows: Bool
        let still: Bool
        let over: Double
        let top: Double
        let bottom: Double
        let height: Double
        let head: Double
        let foot: Double
    }

    @discardableResult
    private func standsWhole(_ page: WKWebView, _ name: String, title: String, shows: String = "true",
                             scrolls: Bool = false) async throws -> Open {
        let script = """
        (() => {
          const dialog = document.querySelector('#flow-layer .ck-dialog') ?? document.querySelector('[data-part="dialog"] .ck-dialog');
          if (!dialog) return null;
          for (const motion of document.getAnimations()) {
            if (motion.effect?.getTiming().iterations !== Infinity) motion.finish();
          }
          const still = document.getAnimations().every(motion => motion.playState !== 'running' || motion.effect?.getTiming().iterations === Infinity);
          const text = dialog.innerText;
          const body = dialog.querySelector('.ck-dialog__body');
          const box = dialog.getBoundingClientRect();
          return JSON.stringify({ title: dialog.querySelector('.ck-dialog__title, .cn-set__title')?.textContent.trim() ?? '', shows: !!(\(shows)), still,
            over: body ? body.scrollHeight - body.clientHeight : -1, top: box.top, bottom: box.bottom, height: innerHeight,
            head: dialog.querySelector('.ck-dialog__head')?.getBoundingClientRect().top ?? box.top,
            foot: dialog.querySelector('.ck-dialog__foot')?.getBoundingClientRect().bottom ?? box.bottom });
        })()
        """
        var shown: Open?
        do {
            try await until("\(name): its dialog open and still") {
                shown = (try? await page.evaluateJavaScript(script) as? String).flatMap { try? JSONDecoder().decode(Open.self, from: Data($0.utf8)) }
                return shown.map { $0.title == title && $0.shows && $0.still } ?? false
            }
        } catch {
            let instead = try? await page.evaluateJavaScript(
                "JSON.stringify({ hash: location.hash, title: document.title, text: (document.querySelector('#flow-layer .ck-dialog') ?? document.querySelector('[data-part=\"dialog\"] .ck-dialog') ?? document.body).innerText.slice(0, 600) })")
            XCTFail("\(name): last read \(String(describing: shown)); the page: \(instead ?? "nothing")")
            throw error
        }
        let dialog = try XCTUnwrap(shown)
        XCTAssertEqual(dialog.height, 860, accuracy: 1, "the page is not the window's height")
        if !scrolls {
            XCTAssertLessThanOrEqual(dialog.over, 0, "\(name): the dialog's body scrolls by \(dialog.over) px at 860 tall")
        }
        XCTAssertGreaterThanOrEqual(dialog.top, 0, "\(name): the dialog stands \(-dialog.top) px above the window")
        XCTAssertLessThanOrEqual(dialog.bottom, dialog.height, "\(name): the dialog stands \(dialog.bottom - dialog.height) px below the window")
        XCTAssertGreaterThanOrEqual(dialog.head, dialog.top - 0.5, "\(name): the dialog's head stands \(dialog.top - dialog.head) px above it")
        XCTAssertLessThanOrEqual(dialog.foot, dialog.bottom + 0.5, "\(name): the dialog's foot stands \(dialog.foot - dialog.bottom) px below it")
        return dialog
    }

    private func scrolledToItsEnd(_ page: WKWebView, _ name: String) async throws {
        struct End: Decodable {
            let left: Double
            let last: Double
            let body: Double
            let head: Double
            let pills: Double
            let top: Double
            let foot: Double
            let height: Double
        }
        let script = """
        (() => {
          const dialog = document.querySelector('[data-part="dialog"] .ck-dialog');
          const body = dialog?.querySelector('.ck-dialog__body');
          if (!body) return null;
          body.scrollTop = body.scrollHeight;
          const pills = (dialog.querySelector('[role="tablist"]') ?? dialog.querySelector('.ck-dialog__head')).getBoundingClientRect();
          return JSON.stringify({ left: body.scrollHeight - body.clientHeight - body.scrollTop,
            last: body.lastElementChild?.getBoundingClientRect().bottom ?? 0, body: body.getBoundingClientRect().bottom,
            pills: pills.bottom, top: body.getBoundingClientRect().top,
            head: dialog.querySelector('.ck-dialog__head').getBoundingClientRect().top,
            foot: (dialog.querySelector('.ck-dialog__foot') ?? dialog).getBoundingClientRect().bottom, height: innerHeight });
        })()
        """
        var end: End?
        try await until("\(name): its body scrolled to its end") {
            end = (try? await page.evaluateJavaScript(script) as? String).flatMap { try? JSONDecoder().decode(End.self, from: Data($0.utf8)) }
            return end.map { $0.left <= 1 } ?? false
        }
        let seen = try XCTUnwrap(end)
        XCTAssertLessThanOrEqual(seen.last, seen.body + 0.5, "\(name): the body's last row stands \(seen.last - seen.body) px below it at its end")
        XCTAssertGreaterThanOrEqual(seen.head, 0, "\(name): the head left the window as the body scrolled")
        XCTAssertLessThanOrEqual(seen.pills, seen.top + 0.5, "\(name): the pills scrolled with the body")
        XCTAssertGreaterThanOrEqual(seen.pills, seen.head, "\(name): the pills left the window as the body scrolled")
        XCTAssertLessThanOrEqual(seen.foot, seen.height, "\(name): the foot left the window as the body scrolled")
    }

    private static func dashboardFiles(_ repo: URL) throws -> [String: (type: String, body: Data)] {
        let types = ["html": "text/html", "js": "text/javascript", "mjs": "text/javascript", "css": "text/css",
                     "svg": "image/svg+xml", "json": "application/json"]
        let root = repo.appendingPathComponent("dashboard/public").resolvingSymlinksInPath()
        var files: [String: (type: String, body: Data)] = [:]
        let walk = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey],
                                                                options: [.skipsHiddenFiles]))
        for case let url as URL in walk {
            guard let type = types[url.pathExtension], (try url.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true else { continue }
            let path = String(url.resolvingSymlinksInPath().path.dropFirst(root.path.count))
            files[path] = (type, try Data(contentsOf: url))
        }
        files["/"] = files["/index.html"]
        for (path, file) in [("/cockpit.css", "design/css/cockpit.css"), ("/kit.css", "design/css/kit.css"), ("/icons.json", "design/icons.json"),
                             ("/marked.js", "dashboard/node_modules/marked/lib/marked.esm.js"),
                             ("/purify.js", "dashboard/node_modules/dompurify/dist/purify.es.mjs"),
                             ("/homelink/Tests/Fixtures/report.json", "homelink/Tests/Fixtures/report.json")] {
            files[path] = (types[URL(fileURLWithPath: file).pathExtension] ?? "text/javascript", try Data(contentsOf: repo.appendingPathComponent(file)))
        }
        return files
    }

    func testTheMicrophoneIsTheDashboardsOwnOriginsAloneAndChatsFieldTakesSeveralImages() {
        XCTAssertTrue(WebContent.mayRecord(scheme: "lifestream-app", host: "page", port: 0, dashboard: 4317))
        XCTAssertTrue(WebContent.mayRecord(scheme: "http", host: "127.0.0.1", port: 4317, dashboard: 4317))
        for (scheme, host, port) in [("http", "127.0.0.1", 4318), ("http", "localhost", 4317), ("https", "127.0.0.1", 4317),
                                     ("http", "example.com", 4317), ("lifestream-app", "icon", 0), ("file", "", 0)] {
            XCTAssertFalse(WebContent.mayRecord(scheme: scheme, host: host, port: port, dashboard: 4317), "\(scheme)://\(host):\(port)")
        }
        let several = WebContent.photoPanel(several: true)
        XCTAssertTrue(several.allowsMultipleSelection)
        XCTAssertEqual(several.allowedContentTypes, [.image])
        XCTAssertFalse(several.canChooseDirectories)
        XCTAssertFalse(WebContent.photoPanel().allowsMultipleSelection)
    }

    func testTheFileFieldOpensThePhotoPanelAndThePagesSquareIsMadeHere() async throws {
        let picture = scratch.appendingPathComponent("synthetic.jpg")
        try Self.orientedPicture(to: picture)
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
        let square = try Data(contentsOf: repo.appendingPathComponent("dashboard/public/ui/people/square.js"))
        let server = try PageServer(["/": ("text/html", Data(Self.filePage.utf8)), "/square.js": ("text/javascript", square)])
        defer { server.stop() }
        let controller = window(port: try await server.ready())
        defer { controller.close() }
        var asked: [(panel: NSOpenPanel, window: NSWindow?)] = []
        var answer: URL? = picture
        controller.web.openPanel = { panel, window in
            asked.append((panel, window))
            return answer.map { [$0] }
        }
        try await until("the file page loaded") { controller.web.loaded && controller.web.title == "waiting" }
        let page = try XCTUnwrap(controller.web.container.subviews.first as? WKWebView)
        _ = try await page.evaluateJavaScript("document.querySelector('input').click(); true")
        try await until("the page made its square") { controller.web.title.hasPrefix("{") }
        XCTAssertEqual(asked.count, 1)
        let panel = try XCTUnwrap(asked.first)
        XCTAssertTrue(panel.window === controller.window, "the panel is not the window's sheet")
        XCTAssertEqual(panel.panel.allowedContentTypes, [.image])
        XCTAssertFalse(panel.panel.allowsMultipleSelection)
        XCTAssertFalse(panel.panel.canChooseDirectories)
        XCTAssertTrue(panel.panel.canChooseFiles)
        let made = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(controller.web.title.utf8)) as? [String: Any])
        XCTAssertEqual(made["files"] as? Int, 1)
        XCTAssertEqual(made["name"] as? String, "synthetic.jpg")
        XCTAssertEqual(made["picture"] as? [Int], [1200, 2400], "the picture is not shown oriented")
        XCTAssertEqual(made["square"] as? [Int], [1024, 1024], "the resize is not honoured")
        let centre = try XCTUnwrap(made["centre"] as? [Int])
        XCTAssertTrue(centre[2] > 200 && centre[0] < 60, "the square is not the lower part of the oriented picture: \(centre)")
        XCTAssertEqual(made["head"] as? [Int], [0xFF, 0xD8, 0xFF])
        XCTAssertEqual(made["placed"] as? Bool, false, "the square carries the picture's place or time")
        XCTAssertNotNil((made["hash"] as? String)?.range(of: "^sha256:[0-9a-f]{64}$", options: .regularExpression))

        answer = nil
        _ = try await page.evaluateJavaScript("document.title = 'waiting'; document.querySelector('input').click(); true")
        try await until("the field heard Cancel") { controller.web.title == "cancelled" }
        XCTAssertEqual(asked.count, 2)
    }

    private static func orientedPicture(to url: URL) throws {
        let context = try XCTUnwrap(CGContext(data: nil, width: 2400, height: 1200, bitsPerComponent: 8, bytesPerRow: 0,
                                              space: try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB)),
                                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: 1200, height: 1200))
        context.setFillColor(red: 0, green: 0, blue: 1, alpha: 1)
        context.fill(CGRect(x: 1200, y: 0, width: 1200, height: 1200))
        let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil))
        let said: [CFString: Any] = [kCGImagePropertyOrientation: 6,
                                     kCGImagePropertyExifDictionary: [kCGImagePropertyExifDateTimeOriginal: "2019:06:01 10:00:00"],
                                     kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 1.5, kCGImagePropertyGPSLatitudeRef: "N",
                                                                     kCGImagePropertyGPSLongitude: 2.5, kCGImagePropertyGPSLongitudeRef: "E"]]
        CGImageDestinationAddImage(destination, try XCTUnwrap(context.makeImage()), said as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
    }

    private static let filePage = """
    <!doctype html><html><head><meta charset="utf-8"><title>waiting</title></head><body>
    <input type="file" accept="image/*"><script type="module">
    import { makeSquare, openPicture } from "./square.js";
    const field = document.querySelector("input");
    field.addEventListener("cancel", () => { document.title = "cancelled"; });
    field.addEventListener("change", async () => {
      const file = field.files[0];
      const picture = await openPicture(file);
      const made = await makeSquare(file, { x: 0, y: picture.height / 2, side: picture.width });
      const bitmap = await createImageBitmap(made.jpeg);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const drawn = canvas.getContext("2d");
      drawn.drawImage(bitmap, 0, 0);
      const centre = [...drawn.getImageData(bitmap.width >> 1, bitmap.height >> 1, 1, 1).data].slice(0, 3);
      const bytes = new Uint8Array(await made.jpeg.arrayBuffer());
      // Before the first frame: the picture's time as stated, or a GPS directory (tag 0x8825), in either byte order.
      const frame = bytes.findIndex((byte, at) => byte === 0xff && bytes[at + 1] === 0xc0);
      const head = bytes.subarray(0, frame);
      const placed = new TextDecoder("latin1").decode(head).includes("2019:06:01")
        || head.some((byte, at) => (byte === 0x88 && head[at + 1] === 0x25) || (byte === 0x25 && head[at + 1] === 0x88));
      document.title = JSON.stringify({ files: field.files.length, name: file.name, picture: [picture.width, picture.height],
        square: [bitmap.width, bitmap.height], centre, head: [...bytes.subarray(0, 3)], placed, hash: made.hash });
    });
    </script></body></html>
    """

    private static func views(in view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap { views(in: $0) }
    }

    private static func closedPort() async throws -> Int {
        let server = try PageServer([:])
        defer { server.stop() }
        return try await server.ready()
    }

    private func draw(_ controller: MainWindowController, to file: String, appearance: NSAppearance.Name) async throws {
        let window = try XCTUnwrap(controller.window)
        window.appearance = NSAppearance(named: appearance)
        let page = controller.web.container.subviews.first as? WKWebView
        let snapshot: NSImage? = controller.web.container.isHidden ? nil : try await withCheckedThrowingContinuation { done in
            page?.takeSnapshot(with: nil) { image, error in
                if let image { done.resume(returning: image) } else { done.resume(throwing: error ?? NeverHeld()) }
            }
        }
        try compose(window, page: snapshot.flatMap { image in page.map { (image, $0) } }, to: file, appearance: appearance)
    }

    private func compose(_ window: NSWindow, page: (NSImage, WKWebView)?, to file: String, appearance: NSAppearance.Name) throws {
        let frame = try XCTUnwrap(window.contentView?.superview)
        frame.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.005))
        frame.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(frame.bitmapImageRepForCachingDisplay(in: frame.bounds))
        NSAppearance(named: appearance)?.performAsCurrentDrawingAppearance { frame.cacheDisplay(in: frame.bounds, to: bitmap) }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        if let (snapshot, view) = page {
            snapshot.draw(in: view.convert(view.bounds, to: nil))
            for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
                guard let button = window.standardWindowButton(kind), let drawn = button.bitmapImageRepForCachingDisplay(in: button.bounds) else { continue }
                NSAppearance(named: appearance)?.performAsCurrentDrawingAppearance { button.cacheDisplay(in: button.bounds, to: drawn) }
                drawn.draw(in: button.convert(button.bounds, to: nil), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            }
        }
        NSGraphicsContext.restoreGraphicsState()
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        try FileManager.default.createDirectory(at: Shots.folder, withIntermediateDirectories: true)
        let url = Shots.folder.appendingPathComponent(file)
        try png.write(to: url)
        print("drawn: \(url.path)")
    }

    private static let page = """
    <!doctype html><html class="hosted"><head><meta charset="utf-8"><title>Lifestream</title><style>
    :root { color-scheme: light dark; --canvas: #F9F9F9; --surface: #FFFFFF; --text: #1F1F1F; --quiet: #505050; --edge: rgba(31,31,31,0.1); --life: #5C4700; }
    @media (prefers-color-scheme: dark) { :root { --canvas: #101010; --surface: #191919; --text: #E8E8E8; --quiet: #ABABAB; --edge: rgba(232,232,232,0.06); --life: #FFD45E; } }
    html, body { margin: 0; height: 100%; background: var(--canvas); color: var(--text); font: 13px -apple-system, system-ui, sans-serif; }
    .shell { display: grid; grid-template-columns: 232px 1fr; height: 100%; }
    nav { background: var(--surface); border-right: 1px solid var(--edge); display: flex; flex-direction: column; }
    .row { height: calc(var(--centre) * 2px); display: flex; align-items: center; gap: 10px; color: var(--quiet); }
    nav .row { padding-left: calc(var(--left) * 1px + 12px); }
    nav ul { list-style: none; margin: 12px 0; padding: 0 12px; }
    nav li { padding: 6px 10px; border-radius: 6px; }
    nav li.on { background: var(--edge); }
    .foot { margin-top: auto; padding: 12px 16px; color: var(--quiet); line-height: 1.6; }
    main { padding: 0 32px; }
    main .row { font-size: 22px; font-weight: 600; color: var(--text); }
    .line { position: fixed; left: 0; right: 0; top: calc(var(--centre) * 1px); border-top: 1px dashed var(--life); opacity: .7; }
    .edge { position: fixed; top: 0; height: 60px; left: calc(var(--left) * 1px); border-left: 1px dashed var(--life); opacity: .7; }
    .said { color: var(--quiet); margin-top: 12px; }
    </style></head><body><div class="line"></div><div class="edge"></div><div class="shell">
    <nav><div class="row">‹ ›</div><ul><li>Days</li><li>People</li><li>Places</li><li class="on">Streams ▲</li></ul><div class="foot" id="foot"></div></nav>
    <main><div class="row">Streams</div><div class="said" id="said"></div></main></div><script>
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    function render() {
      const state = window.lifestreamHost.state;
      const inset = state.inset || {left: 0, centre: 14};
      document.documentElement.style.setProperty("--left", inset.left);
      document.documentElement.style.setProperty("--centre", inset.centre);
      document.getElementById("foot").innerText = state.recorder.words;
      const missing = state.grants.filter((grant) => !grant.granted).map((grant) => grant.title).join(", ");
      document.getElementById("said").innerText = "inset left " + inset.left.toFixed(1) + " · centre " + inset.centre.toFixed(1) + " CSS px\\n"
        + "waiting on " + missing + "\\nhome in " + state.folder;
      document.title = "Lifestream · " + (scheme.matches ? "dark" : "light");
    }
    addEventListener("lifestream:state", render);
    scheme.addEventListener("change", render);
    render();
    </script></body></html>
    """
}
