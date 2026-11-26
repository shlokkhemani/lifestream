import Foundation
import XCTest

@testable import LifestreamCaptureCore

final class VoiceCoreTests: XCTestCase {
    func testVoiceLogRoundTripsCountsAndExportsTheBlobVerbatim() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let capture = root.appendingPathComponent("capture")
        let store = try CaptureStore(root: capture)
        XCTAssertEqual(CaptureDomain.voice.filename, "voice.jsonl")

        let bytes = Data([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20])
        let hash = try await store.storeBlob(bytes)
        let entry = try await store.append(
            domain: .voice,
            draft: .init(
                kind: "voice_note", observedAt: CaptureTime.rfc3339(Date()),
                payload: .object([
                    "blob": .object([
                        "hash": .string(hash), "type": .string("audio/mp4"),
                        "bytes": .integer(Int64(bytes.count)), "role": .string("voice_note"),
                    ]),
                    "duration_seconds": .number(1.25),
                    "capture_mode": .string("hold"),
                    "end_reason": .string("released"),
                    "location": .null,
                ])))

        let recovered = try CaptureStore(root: capture)
        let entries = try await recovered.entries(domain: .voice)
        XCTAssertEqual(entries, [entry])
        let status = try await recovered.statusSummary()
        XCTAssertEqual(status.voiceEntriesToday, 1)
        XCTAssertEqual(status.cameraEntriesToday, 0)

        let sealed = try await CaptureExporter(
            store: recovered,
            exportsDirectory: root.appendingPathComponent("exports")
        )
        .sealEverything(appVersion: "1.0.0")
        let bundle = try XCTUnwrap(sealed)
        XCTAssertEqual(bundle.files, [PendingBundle.File(name: SHA256Digest.tagged(bytes), bytes: UInt64(bytes.count))],
                       "the seal names the recording, sent on its own")
        XCTAssertNil(bundle.manifest.files["blobs/\(hash.dropFirst("sha256:".count))"])
        XCTAssertEqual(bundle.manifest.files["voice.jsonl"]?.observations, 1)
        XCTAssertNil(bundle.manifest.files["camera.jsonl"], "a domain with nothing new is not carried")
    }

}
