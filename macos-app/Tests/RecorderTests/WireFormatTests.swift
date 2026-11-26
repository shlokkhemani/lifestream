import Audio
import DeviceFiles
import Foundation
import XCTest
@testable import Recorder

final class WireFormatTests: XCTestCase {
    func testTheRuntimeFileIsSpelledAsPinnedAndAnOlderFileStillDecodes() throws {
        XCTAssertNil(RecorderState(rawValue: "error"), "a run never stops itself")
        XCTAssertEqual(InputLogState.allCases.map(\.rawValue),
                       ["recording", "permission_required", "stopped", "off"])
        XCTAssertEqual(AudioTrackState.allCases.map(\.rawValue),
                       ["recording", "idle", "withheld", "permission_required", "stopped", "failed", "held_back"])
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("runtime-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        var status = RuntimeStatus(state: .recording)
        status.updatedAt = Date(timeIntervalSince1970: 1_700_000_000.5)
        status.lastSaved = Date(timeIntervalSince1970: 1_700_000_000)
        status.lastCaptureDuration = 0.25
        status.recorded = 12
        status.gaps = 3
        status.pendingFrames = 2
        status.lastGapReason = "storage_backpressure"
        status.capturingSince = Date(timeIntervalSince1970: 1_699_999_900)
        status.consecutiveTechnicalFailedAttempts = 1
        status.lastTechnicalFailureReason = "capture_failed"
        status.lastTechnicalFailureAt = Date(timeIntervalSince1970: 1_699_999_999)
        status.videoCompactionStatus = .retryingPending
        status.pendingVideoImages = 4
        status.pendingVideoBytes = 4096
        status.videoCompactionFailingSince = Date(timeIntervalSince1970: 1_699_999_000)
        status.skippedVideoImages = 1
        status.inputLog = .permissionRequired
        status.inputEvents = 5210
        status.inputTapRestarts = 2
        status.audioMic = .recording
        status.audioSound = .permissionRequired
        status.storageFailure = StorageFailure(kind: "io", errno: 28, at: Date(timeIntervalSince1970: 1_699_999_990))
        status.owed = [RuntimeStatus.OwedSpan(reason: "recorder-not-running", from: Date(timeIntervalSince1970: 1_699_999_900),
                                              until: Date(timeIntervalSince1970: 1_699_999_920), lived: Date(timeIntervalSince1970: 1_699_999_910)),
                       RuntimeStatus.OwedSpan(reason: "storage-failed", from: Date(timeIntervalSince1970: 1_699_999_920),
                                              until: Date(timeIntervalSince1970: 1_699_999_950),
                                              bundle: "00001699999920000000-00000000-0000-4000-8000-000000000001"),
                       RuntimeStatus.OwedSpan(reason: "storage-failed", from: Date(timeIntervalSince1970: 1_699_999_950))]
        status.message = "Capture encountered a technical failure; recovery is pending."
        status.pid = 777
        try status.persist(in: directory, plain: DeviceFiles(.plain))
        let file = directory.appendingPathComponent("runtime.json")
        XCTAssertEqual(String(decoding: try Data(contentsOf: file), as: UTF8.self),
            #"{"audioMic":"recording","audioSound":"permission_required","capturingSince":"2023-11-14T22:11:40.000Z","consecutiveTechnicalFailedAttempts":1,"gaps":3,"inputEvents":5210,"inputLog":"permission_required","inputTapRestarts":2,"lastCaptureDuration":0.25,"lastGapReason":"storage_backpressure","lastSaved":"2023-11-14T22:13:20.000Z","lastTechnicalFailureAt":"2023-11-14T22:13:19.000Z","lastTechnicalFailureReason":"capture_failed","message":"Capture encountered a technical failure; recovery is pending.","owed":[{"from":"2023-11-14T22:11:40.000Z","lived":"2023-11-14T22:11:50.000Z","reason":"recorder-not-running","until":"2023-11-14T22:12:00.000Z"},{"bundle":"00001699999920000000-00000000-0000-4000-8000-000000000001","from":"2023-11-14T22:12:00.000Z","reason":"storage-failed","until":"2023-11-14T22:12:30.000Z"},{"from":"2023-11-14T22:12:30.000Z","reason":"storage-failed"}],"pendingFrames":2,"pendingVideoBytes":4096,"pendingVideoImages":4,"pid":777,"recorded":12,"skippedVideoImages":1,"state":"recording","storageFailure":{"at":"2023-11-14T22:13:10.000Z","errno":28,"kind":"io"},"updatedAt":"2023-11-14T22:13:20.500Z","videoCompactionFailingSince":"2023-11-14T21:56:40.000Z","videoCompactionStatus":"retrying; pending images retained"}"#)
        let written = try XCTUnwrap(RuntimeStatus.read(from: directory, plain: DeviceFiles(.plain)))
        XCTAssertEqual(written.inputLog, .permissionRequired)
        XCTAssertEqual(written.audioMic, .recording)
        XCTAssertEqual(written.audioSound, .permissionRequired)
        XCTAssertEqual(written.pendingFrames, 2)
        XCTAssertEqual(written.updatedAt, status.updatedAt)
        XCTAssertEqual(written.videoCompactionStatus, .retryingPending)
        XCTAssertEqual(written.capturingSince, status.capturingSince)
        XCTAssertEqual(written.storageFailure, status.storageFailure)
        XCTAssertEqual(written.owed, status.owed)
        try Data(#"{"gaps":0,"pid":1,"recorded":0,"state":"stopped","updatedAt":"2023-11-14T22:13:20.000Z"}"#.utf8)
            .write(to: file)
        let old = try XCTUnwrap(RuntimeStatus.read(from: directory, plain: DeviceFiles(.plain)))
        XCTAssertNil(old.inputLog)
        XCTAssertNil(old.inputEvents)
        XCTAssertNil(old.inputTapRestarts)
        XCTAssertNil(old.audioMic)
        XCTAssertNil(old.audioSound)
        XCTAssertNil(old.storageFailure)
        XCTAssertNil(old.owed)
    }

    func testAnAbsentRuntimeFileReadsAsNoneThroughThePlainInstance() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("runtime-absent-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        XCTAssertNil(try RuntimeStatus.read(from: directory, plain: DeviceFiles(.plain)))
    }

}
