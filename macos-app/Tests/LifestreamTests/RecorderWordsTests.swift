import Audio
import Evidence
import Foundation
import HomeLink
import Recorder
import XCTest
@testable import Lifestream

final class RecorderWordsTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    private func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }

    private func words(_ seconds: TimeInterval, state: RecorderState = .recording, frame: TimeInterval? = nil,
                       reason: String? = nil, running: Bool = true, screenOff: Bool = false,
                       after shown: RecorderPresentation? = nil) -> RecorderPresentation {
        var status = RuntimeStatus(state: state)
        status.capturingSince = t0
        status.lastSaved = frame.map(at)
        status.lastGapReason = reason
        status.updatedAt = at(seconds)
        return RecorderPresentation(status: status, running: running, screenOff: screenOff, now: at(seconds), shown: shown)
    }

    private func timeline(_ steps: [(TimeInterval, RecorderState, TimeInterval?, String?)]) -> [RecorderPresentation] {
        var shown: RecorderPresentation?
        return steps.map { seconds, state, frame, reason in
            let next = words(seconds, state: state, frame: frame, reason: reason, after: shown)
            shown = next
            return next
        }
    }

    private func cause(_ presentation: RecorderPresentation) -> RecorderStatement.Cause? {
        if case .interrupted(let cause) = presentation.stated { return cause }
        return nil
    }

    func testAOneSecondRestartShowsNothing() {
        let steps = timeline([(2, .recording, 2, nil),
                              (3, .recovering, 2, "capture-generation-invalidated"),
                              (4, .recording, 4, nil)])
        XCTAssertEqual(steps.map(\.label), ["Recording", "Recording", "Recording"])
        XCTAssertEqual(steps.map(\.recording), [true, true, true], "the dot never goes out")
        XCTAssertEqual(steps.map(\.stated), [.recording, .recording, .recording], "the home hears it records")
        XCTAssertEqual(steps[1].due, at(12), "it would show ten seconds after the last frame")
    }

    func testChangingReasonsShowACauseUntilAFrameIsSaved() {
        let steps = timeline([
            (14, .waiting, 10, "no-focused-application"),
            (19, .recovering, 10, "capture-generation-invalidated"),
            (21, .waiting, 10, "foreground-page-unreadable"),
            (26, .waiting, 10, "foreground-private-window"),
            (31, .recovering, 10, "capture-generation-invalidated"),
            (33, .recording, 33, nil),
        ])
        XCTAssertEqual(steps.map(\.label), [
            "Recording", "Recording",
            "Not recording · browser not answering",
            "Not recording · private window or app",
            "Not recording · screen unavailable",
            "Recording",
        ])
        XCTAssertEqual(steps.map(\.recording), [true, true, false, false, false, true])
        XCTAssertEqual(steps.map(cause), [nil, nil, .browser, .private, .capture, nil])
        XCTAssertEqual(steps.map(\.signal), [.engaged, .engaged, .idle, .idle, .warning, .engaged])
    }

    func testLifestreamsOwnWindowInFrontIsNoPrivateWindow() {
        var status = RuntimeStatus(state: .recording)
        status.capturingSince = t0
        status.lastSaved = at(10)
        for reason in [CaptureGapReason.foregroundAppActivityOnly, .foregroundAppExcluded] {
            status.lastGapReason = reason.rawValue
            let own = RecorderPresentation(status: status, running: true, ownInFront: true, now: at(60))
            XCTAssertEqual(own.label, "Recording", "\(reason): Lifestream in front read as a private app")
            XCTAssertEqual(own.stated, .recording, "\(reason): the home heard Lifestream in front as a private app")
            let other = RecorderPresentation(status: status, running: true, ownInFront: false, now: at(60))
            XCTAssertEqual(other.label, "Not recording · private window or app", "\(reason): another app the person keeps out stopped saying so")
        }
        status.lastGapReason = CaptureGapReason.foregroundPrivateWindow.rawValue
        XCTAssertEqual(RecorderPresentation(status: status, running: true, ownInFront: true, now: at(60)).label, "Not recording · private window or app")
    }

    func testACauseShownStaysShownWhenTheNextIsSlower() {
        let steps = timeline([
            (0, .recording, 0, nil),
            (1, .recovering, 0, "storage_backpressure"),
            (2, .waiting, 0, "foreground-page-unreadable"),
            (5, .waiting, 0, "no-focused-application"),
            (6, .recording, 6, nil),
            (7, .waiting, 6, "foreground-page-unreadable"),
        ])
        XCTAssertEqual(steps.map(\.label), [
            "Recording",
            "Not recording",
            "Not recording · browser not answering",
            "Not recording · Mac idle",
            "Recording",
            "Recording",
        ])
        XCTAssertEqual(steps.map(cause), [nil, .disk, .browser, .away, nil, nil])
        XCTAssertEqual(steps[5].due, at(16), "the frame saved at 6 s starts a new interruption, timed afresh")
        var status = RuntimeStatus(state: .waiting)
        status.capturingSince = at(3)
        status.lastSaved = at(0)
        status.lastGapReason = "foreground-page-unreadable"
        XCTAssertEqual(RecorderPresentation(status: status, running: true, now: at(4), shown: steps[2]).label, "Recording")
    }

    func testAFrameSavedLateIsTimedFromItsSaving() {
        let steps = timeline([(11, .recording, nil, nil), (12, .recording, 12, nil), (21.9, .recording, 12, nil)])
        XCTAssertEqual(steps.map(\.label), ["Not recording · screen unavailable", "Recording", "Recording"])
        XCTAssertEqual(steps.map(\.stated), [.interrupted(.capture), .recording, .recording])
    }

    func testADiskOrAGrantShowsAtOnce() {
        let full = words(4.5, state: .recovering, frame: 4, reason: "storage_backpressure")
        XCTAssertEqual(full.label, "Not recording")
        XCTAssertEqual(full.toggleTitle, "Pause recording", "the run goes on: it waits for room, not for the person's start")
        XCTAssertEqual(full.stated, .interrupted(.disk))
        XCTAssertEqual(full.signal, .caution)
        let revoked = words(4.5, state: .permissionRequired, frame: 4, reason: "screen-recording-permission-denied")
        XCTAssertEqual(revoked.label, "Screen Recording needs access", "the words of the grant's need, which offers Allow")
        XCTAssertEqual(cause(revoked), .permission)
        let given = words(30, frame: 4, reason: "screen-recording-permission-denied", after: revoked)
        XCTAssertEqual(cause(given), .permission)
        XCTAssertEqual(words(31, frame: 31, after: given).label, "Recording")
    }

    func testAGrantsStopAndItsEndTellTheGrants() {
        let recording = words(4, frame: 4)
        let revoked = words(5, state: .permissionRequired, frame: 4, reason: "screen-recording-permission-denied", after: recording)
        let still = words(6, state: .permissionRequired, frame: 4, reason: "screen-recording-permission-denied", after: revoked)
        let given = words(7, frame: 7, after: still)
        let full = words(8, state: .recovering, frame: 7, reason: "storage_backpressure", after: given)
        XCTAssertEqual([revoked.tellsGrants(after: recording), still.tellsGrants(after: revoked), given.tellsGrants(after: still),
                        full.tellsGrants(after: given)], [true, false, true, false])
        XCTAssertTrue(revoked.tellsGrants(after: nil), "a launch that finds the grant missing")
        XCTAssertFalse(recording.tellsGrants(after: nil))
    }

    func testNoReasonStandingIsCapturesAfterItsTime() {
        XCTAssertEqual(words(9.9).label, "Recording", "no frame yet, inside the first ten seconds")
        XCTAssertEqual(words(10).stated, .interrupted(.capture), "timed from capture begun, with no frame since")
        XCTAssertEqual(cause(words(40, frame: 20)), .capture)
    }

    func testThePersonsOwnStatesKeepTheirWordsAndStateThem() {
        let paused = words(600, state: .stopped, frame: 4, reason: "foreground-private-window", running: false)
        XCTAssertEqual([paused.label, paused.toggleTitle], ["Recording paused", "Start recording"])
        XCTAssertEqual(paused.stated, .paused)
        XCTAssertEqual(paused.signal, .idle)
        let starting = words(600, state: .starting, frame: 4)
        XCTAssertEqual(starting.label, "Starting recording")
        XCTAssertEqual(starting.stated, .starting)
        let off = words(600, state: .waiting, frame: 4, reason: "storage_backpressure", screenOff: true)
        XCTAssertEqual(off.label, "Not recording: Screen is turned off in Connectors")
        XCTAssertEqual(off.stated, .paused, "the home turned it off, and knows")
        XCTAssertFalse(off.recording)
        XCTAssertNil(off.due)
        let asking = words(5, state: .permissionRequired, reason: "screen-recording-permission-denied")
        let offAsking = words(6, state: .permissionRequired, reason: "screen-recording-permission-denied", screenOff: true, after: asking)
        XCTAssertEqual([asking.label, offAsking.label],
                       ["Screen Recording needs access", "Not recording: Screen is turned off in Connectors"])
        XCTAssertEqual(offAsking.stated, .paused)
    }

    func testTheMicrophoneIsNamedAfterTwentySecondsAndStopsUntilTheHoldClears() {
        let names = ["us.zoom.xos": "Zoom"]
        func mic(_ seconds: TimeInterval, _ use: MicUse?, mic: AudioTrackState? = nil,
                 sound: AudioTrackState? = nil) -> RecorderPresentation {
            var status = RuntimeStatus(state: .recording)
            status.capturingSince = t0
            status.lastSaved = at(seconds)
            status.audioMic = mic
            status.audioSound = sound
            return RecorderPresentation(status: status, running: true, now: at(seconds), microphone: use,
                                        name: { names[$0] ?? $0 })
        }
        let recording = MicUse.recording(holders: ["us.zoom.xos"], since: at(100))
        let early = mic(119, recording)
        XCTAssertNil(early.microphone, "nineteen seconds in, nothing is said")
        XCTAssertFalse(early.stoppable)
        XCTAssertEqual(early.due, at(120), "the menu asks again when the line is due")
        let named = mic(120, recording)
        XCTAssertEqual([named.microphone, StatusMenuEntry.stopMicrophone.title(named)], ["Recording · Zoom", "Stop recording"])
        XCTAssertTrue(StatusMenuEntry.stopMicrophone.shown(named))
        XCTAssertFalse(named.detail.contains("microphone"), "the detail line says nothing of audio")
        let stopped = mic(130, .stopped(holders: ["us.zoom.xos"]))
        XCTAssertEqual(stopped.microphone, "Not recording · Zoom")
        XCTAssertFalse(StatusMenuEntry.stopMicrophone.shown(stopped))
        let cleared = mic(300, nil)
        XCTAssertNil(cleared.microphone, "the hold cleared, nothing is said")
        XCTAssertFalse(StatusMenuEntry.microphone.shown(cleared))
        XCTAssertEqual(mic(300, nil, mic: .permissionRequired).microphone, "Microphone needs access")
        XCTAssertNil(mic(300, nil, mic: .withheld, sound: .permissionRequired).microphone,
                     "System Audio's grant is the grant list's to ask for")
        let otherSide = mic(120, recording, mic: .permissionRequired, sound: .recording)
        XCTAssertEqual(otherSide.microphone, "Recording · Zoom", "the other side alone is named the same way")
        XCTAssertTrue(StatusMenuEntry.stopMicrophone.shown(otherSide))
        for words in [early, named, stopped, cleared].compactMap(\.microphone) {
            XCTAssertFalse(words.lowercased().contains("call"), "the Mac cannot know a call")
        }
    }

    func testARecoveringRunSaysWhyUntilAFrameIsSaved() {
        let full = words(4.5, state: .recovering, frame: 4, reason: "storage_backpressure")
        XCTAssertEqual(full.label, "Not recording", "the disk at once")
        XCTAssertEqual(full.stated, .interrupted(.disk))
        XCTAssertEqual(full.toggleTitle, "Pause recording", "the run goes on")
        XCTAssertEqual(words(9, state: .recovering, frame: 4, reason: "storage-failed").label, "Recording",
                       "a failure that is not the disk's passes like any capture's")
        let failing = words(15, state: .recovering, frame: 4, reason: "storage-failed")
        XCTAssertEqual(failing.stated, .interrupted(.capture))
        XCTAssertEqual(failing.signal, .warning)
        let reopened = words(300, state: .waiting, frame: 4, reason: "storage-failed", after: failing)
        XCTAssertEqual(reopened.label, "Not recording · screen unavailable")
        XCTAssertFalse(reopened.recording)
        XCTAssertEqual(words(302, state: .recording, frame: 302, after: reopened).label, "Recording", "a frame saved ends it")
    }

    func testEveryReasonHasACause() {
        let causes = Dictionary(grouping: CaptureGapReason.allCases, by: RecorderStatement.Cause.init)
        XCTAssertEqual(Set(causes.keys), Set(RecorderStatement.Cause.allCases), "every cause has a reason")
        XCTAssertEqual(causes[.disk], [.storageBackpressure])
        XCTAssertEqual(causes[.permission], [.screenRecordingPermissionDenied])
        for cause in RecorderStatement.Cause.allCases {
            XCTAssertEqual(cause.after, [.disk, .permission].contains(cause) ? 0 : 10, cause.rawValue)
        }
    }

    @MainActor
    func testTheMenuAndTheWindowSayTheSameWords() {
        for presentation in [words(1, frame: 1), words(30, state: .waiting, frame: 4, reason: "session-locked-or-unavailable")] {
            let line = HostState(recorder: presentation).recorder
            XCTAssertEqual(StatusMenuEntry.state.title(presentation), presentation.label)
            XCTAssertEqual(line, HostState.Line(signal: presentation.signal.rawValue, words: presentation.label))
        }
        XCTAssertEqual(words(30, state: .waiting, frame: 4, reason: "session-locked-or-unavailable").label,
                       "Not recording · Mac idle")
    }

    func testTheHomeSaysTheseWords() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/home/stream-words.ts")
        let source = try String(contentsOf: file, encoding: .utf8)
        let table = try XCTUnwrap(source.range(of: "export const RECORDER_WORDS"), "the home's table")
        let block = source[table.upperBound...].prefix { $0 != "}" }
        var home: [String: String] = [:]
        for line in block.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard let colon = trimmed.firstIndex(of: ":"), trimmed.hasSuffix("\","),
                  let open = trimmed.firstIndex(of: "\"") else { continue }
            home[String(trimmed[..<colon])] = String(trimmed[trimmed.index(after: open)..<trimmed.index(trimmed.endIndex, offsetBy: -2)])
        }
        var mac = ["recording": RecorderPresentation.recordingWords, "starting": RecorderPresentation.starting,
                   "paused": RecorderPresentation.paused]
        for cause in RecorderStatement.Cause.allCases { mac[cause.rawValue] = cause.words }
        XCTAssertEqual(home, mac)
        let key: (RecorderStatement) -> String = { stated in
            switch stated {
            case .recording: return "recording"
            case .starting: return "starting"
            case .paused: return "paused"
            case .interrupted(let cause): return cause.rawValue
            }
        }
        let reached = [RecorderState.stopped, .starting, .recording, .waiting, .recovering, .captured, .gap, .permissionRequired]
            .map { words(600, state: $0, frame: 4, reason: "no-focused-application", running: $0 != .stopped) }
        for presentation in reached {
            XCTAssertEqual(home[key(presentation.stated)], presentation.label, "\(presentation.stated)")
        }
    }
}
