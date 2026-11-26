import Evidence
import XCTest
@testable import Audio

final class AudioPlanTests: XCTestCase {
    private let t0 = Instants.date("2026-09-30T10:00:00.000Z")
    private let zoom = "us.zoom.xos"
    private let chrome = "com.google.Chrome"

    private func decide(_ track: AudioTrack, holders: [String], modes: RecordingModes = .defaults, running: Bool = true,
                        heldBack: Set<String> = [], permission: AudioAuthorization = .granted) -> AudioPlan.Decision {
        AudioPlan.decide(track, use: Uses.use(at: t0, holders: holders.map { ($0, Uses.microphone) }), modes: modes,
                         running: running, heldBack: heldBack, permission: permission)
    }

    private func records(_ decision: AudioPlan.Decision) -> Bool {
        if case .record = decision { return true }
        return false
    }

    func testAHolderThePersonStoppedStopsBothTracks() {
        for track in AudioTrack.allCases {
            XCTAssertTrue(records(decide(track, holders: [zoom])), "\(track) records with no hold")
            XCTAssertEqual(decide(track, holders: [zoom], heldBack: [zoom]), .idle(.heldBack), "\(track) stops for the person")
            XCTAssertEqual(decide(track, holders: [chrome, zoom], heldBack: [zoom]), .idle(.heldBack),
                           "\(track): a stopped holder in the room stops it, whoever joins")
            XCTAssertTrue(records(decide(track, holders: [chrome], heldBack: [zoom])), "\(track): a hold on another app stops nothing")
        }
    }

    func testAStopBeatsTheGrantAndAWithheldHolderKeepsItsMeaning() {
        XCTAssertEqual(decide(.mic, holders: [zoom], heldBack: [zoom], permission: .denied), .idle(.heldBack))
        XCTAssertEqual(decide(.mic, holders: [zoom], modes: RecordingModes(activity: [zoom])), .idle(.withheld))
        XCTAssertEqual(decide(.sound, holders: [zoom], modes: RecordingModes(exclude: [zoom])), .idle(.withheld))
        XCTAssertEqual(decide(.mic, holders: [zoom], running: false, heldBack: [zoom]), .idle(.stopped),
                       "a recorder not running is stopped, whatever the person held back")
        XCTAssertEqual(decide(.mic, holders: [], heldBack: [zoom]), .idle(.idle), "no holder, no use to stop")
    }
}
