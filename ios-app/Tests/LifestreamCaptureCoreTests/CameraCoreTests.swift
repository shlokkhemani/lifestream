import Foundation
import XCTest

@testable import LifestreamCaptureCore

final class CameraCoreTests: XCTestCase {

  func testTargetedBlobLookupValidatesReferenceAndIgnoresOtherFiles() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try CaptureStore(root: root)
    let bytes = Data("synthetic image".utf8)
    let hash = try await store.storeBlob(bytes)
    try Data([0]).write(to: root.appendingPathComponent("blobs/unrelated"))
    let found = try await store.blobFile(forTaggedHash: hash)
    XCTAssertEqual(try Data(contentsOf: XCTUnwrap(found)), bytes)
    let missing = try await store.blobFile(forTaggedHash: "sha256:" + String(repeating: "0", count: 64))
    XCTAssertNil(missing)
    do {
      _ = try await store.blobFile(forTaggedHash: "sha256:../../escape")
      XCTFail("Malformed reference must fail")
    } catch {}
    try Data([9]).write(to: XCTUnwrap(found))
    do {
      _ = try await store.blobFile(forTaggedHash: hash)
      XCTFail("Corrupt referenced bytes must fail")
    } catch {}
  }

  func testCameraAndPhotosLogsRoundTripCountAndExportVerbatimBlob() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let capture = root.appendingPathComponent("capture")
    let store = try CaptureStore(root: capture)
    let bytes = Data([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9])
    let hash = try await store.storeBlob(bytes)
    let entry = try await store.append(
      domain: .camera,
      draft: .init(
        kind: "photo", observedAt: CaptureTime.rfc3339(Date()),
        payload: .object([
          "blob": .object([
            "hash": .string(hash), "type": .string("image/jpeg"),
            "bytes": .integer(Int64(bytes.count)), "role": .string("photo"),
          ]),
          "location": .null,
        ])))
    _ = try await store.append(
      domain: .photos,
      draft: .init(
        kind: "asset", observedAt: CaptureTime.rfc3339(Date()), payload: .object([:])))
    let recovered = try CaptureStore(root: capture)
    let entries = try await recovered.entries(domain: .camera)
    XCTAssertEqual(entries, [entry])
    let status = try await recovered.statusSummary()
    XCTAssertEqual(status.cameraEntriesToday, 1)
    XCTAssertEqual(status.photosEntriesToday, 1)
    let sealed = try await CaptureExporter(
      store: recovered,
      exportsDirectory: root.appendingPathComponent("exports")
    )
    .copy(hardware: .synthetic, appVersion: "1.0.0")
    let bundle = try XCTUnwrap(sealed)
    let blobPath = "blobs/\(hash.dropFirst("sha256:".count))"
    XCTAssertEqual(bundle.manifest.files[blobPath]?.sha256, SHA256Digest.tagged(bytes))
    XCTAssertEqual(bundle.manifest.files[blobPath]?.bytes, UInt64(bytes.count))
    XCTAssertEqual(bundle.manifest.files["camera.jsonl"]?.observations, 1)
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
    process.arguments = ["-p", bundle.url.path, blobPath]
    process.standardOutput = pipe
    try process.run()
    let extracted = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0)
    XCTAssertEqual(extracted, bytes)
  }
}
