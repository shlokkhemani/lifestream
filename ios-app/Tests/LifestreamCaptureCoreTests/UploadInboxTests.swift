import Foundation
import HomeLink
import Synchronization
import XCTest

@testable import LifestreamCaptureCore

final class UploadInboxTests: XCTestCase {
    private var root: URL!
    private var inbox: UploadInbox!
    private var store: CaptureStore!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("upload-inbox-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        inbox = UploadInbox(directory: root.appendingPathComponent("group/upload-inbox", isDirectory: true), volume: Volume(root))
        store = try CaptureStore(root: root.appendingPathComponent("capture", isDirectory: true))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private static let sharedAt = Date(timeIntervalSince1970: 1_791_000_000)

    private func handed(_ text: String, name: String = "statement-synthetic.pdf") throws -> URL {
        let url = root.appendingPathComponent("handed/\(UUID().uuidString)/\(name)")
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
        return url
    }

    private func member(_ value: JSONValue?, _ name: String) -> JSONValue? {
        guard case .object(let members)? = value else { return nil }
        return members[name]
    }

    private func uploads() async throws -> [CaptureEntry] {
        try await store.entries(domain: .upload)
    }

    func testASharedFileIsOneFileEntryNamingItsBlob() async throws {
        let source = try handed("%PDF synthetic statement")
        try inbox.publish(file: source, name: "statement-synthetic.pdf", mediaType: "application/pdf", sharedAt: Self.sharedAt)
        XCTAssertEqual(try Data(contentsOf: source), Data("%PDF synthetic statement".utf8))
        let recorded = try await inbox.drain(into: store)
        XCTAssertEqual(recorded, 1)
        let entries = try await uploads()
        XCTAssertEqual(entries.count, 1)
        let entry = try XCTUnwrap(entries.first)
        XCTAssertEqual(entry.domain, .upload)
        XCTAssertEqual(entry.kind, "file")
        XCTAssertEqual(entry.observedAt, CaptureTime.rfc3339(Self.sharedAt))
        let hash = SHA256Digest.tagged(Data("%PDF synthetic statement".utf8))
        XCTAssertEqual(entry.payload, .object([
            "name": .string("statement-synthetic.pdf"),
            "blob": .object(["hash": .string(hash), "bytes": .integer(24), "type": .string("application/pdf"), "role": .string("original")]),
        ]))
        let blob = try await store.blobFile(forTaggedHash: hash)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(blob)), Data("%PDF synthetic statement".utf8))
        XCTAssertEqual(try inbox.pending(), [])
        let again = try await inbox.drain(into: store)
        XCTAssertEqual(again, 0)
    }

    func testAFileTheDiskHasNoRoomForWaitsUncopied() async throws {
        let payload = Data(repeating: 9, count: 10_000)
        let free = Mutex<Int64?>(Room.bottomBytes + 5_000)
        let store = try CaptureStore(root: root.appendingPathComponent("tight", isDirectory: true),
                                     volume: Volume(root, every: 0, read: { _ in free.withLock { $0 } }))
        let handedFile = root.appendingPathComponent("handed/large.bin")
        try FileManager.default.createDirectory(at: handedFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try payload.write(to: handedFile)
        try inbox.publish(file: handedFile, name: "large.bin", mediaType: "application/octet-stream", sharedAt: Self.sharedAt)
        do {
            try await inbox.drain(into: store)
            XCTFail("a payload that would leave under 1 GB")
        } catch { XCTAssertEqual(error as? CaptureError, .full) }
        let item = try XCTUnwrap(try inbox.pending().first)
        let left = try FileManager.default.contentsOfDirectory(atPath: item.directory.path).filter { $0.hasPrefix(UploadInbox.copyPrefix) }
        XCTAssertEqual(left, [], "no copy was made")
        let entries = try await store.entries(domain: .upload)
        XCTAssertEqual(entries.count, 0)

        free.withLock { $0 = Room.keepBytes }
        let recorded = try await inbox.drain(into: store)
        XCTAssertEqual(recorded, 1, "with room, the item kept in the inbox is recorded")
    }

    func testTheShareCopiesNoFileTheDiskHasNoRoomFor() throws {
        let free = Mutex<Int64?>(Room.bottomBytes + 5_000)
        let tight = UploadInbox(directory: root.appendingPathComponent("tight/upload-inbox", isDirectory: true),
                                volume: Volume(root, every: 0, read: { _ in free.withLock { $0 } }))
        let file = try handed(String(repeating: "9", count: 10_000), name: "large.bin")
        XCTAssertThrowsError(try tight.publish(file: file, name: "large.bin", mediaType: "application/octet-stream", sharedAt: Self.sharedAt)) {
            XCTAssertEqual($0 as? CaptureError, .full)
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: tight.directory.path), [], "nothing staged, no item")

        free.withLock { $0 = Room.bottomBytes + 10_000 }
        try tight.publish(file: file, name: "large.bin", mediaType: "application/octet-stream", sharedAt: Self.sharedAt)
        XCTAssertEqual(try tight.pending().map(\.name), ["large.bin"], "a file that leaves the bottom whole is taken")
    }

    func testTheNextSealCarriesTheEntryAndNamesTheBytes() async throws {
        try inbox.publish(file: try handed("synthetic scan bytes", name: "scan.jpg"), name: "scan.jpg", mediaType: "image/jpeg", sharedAt: Self.sharedAt)
        try await inbox.drain(into: store)
        let exporter = CaptureExporter(store: store, exportsDirectory: root.appendingPathComponent("exports", isDirectory: true))
        let sealed = try await exporter.sealEverything()
        let bundle = try XCTUnwrap(sealed)
        let file = try XCTUnwrap(bundle.manifest.files["upload.jsonl"])
        XCTAssertEqual(file.observations, 1)
        XCTAssertEqual(file.firstSequence, 1)
        let hash = SHA256Digest.tagged(Data("synthetic scan bytes".utf8))
        XCTAssertEqual(bundle.files.map(\.name), [hash], "the file goes on its own")
        XCTAssertNil(bundle.manifest.files["blobs/\(hash.dropFirst(7))"])
    }

    func testAKillAtEveryStepRecordsTheFileOnce() async throws {
        for stop in ["hashed", "copied", "stored", "appended"] {
            try tearDownWithError()
            try setUpWithError()
            let text = "synthetic bytes stopped after \(stop)"
            let id = try inbox.publish(file: try handed(text), name: "a.pdf", mediaType: "application/pdf", sharedAt: Self.sharedAt)
            let item = try XCTUnwrap(try inbox.pending().first)
            let directory = item.directory
            let hash = SHA256Digest.tagged(Data(text.utf8))
            try FileDurability.writeNewRegularFileDurably(Data(hash.utf8), to: directory.appendingPathComponent("hash"))
            if stop != "hashed" {
                let copy = directory.appendingPathComponent(".blob-\(UUID().uuidString.lowercased())")
                try FileDurability.copyRegularFileDurably(from: directory.appendingPathComponent("payload"), to: copy)
                if stop != "copied" { _ = try await store.storeBlob(file: OwnedMediaFile(takingOwnershipOf: copy)) }
            }
            if stop == "appended" {
                let draft = CaptureDraft(kind: "file", observedAt: item.sharedAt, payload: .object([
                    "name": .string("a.pdf"),
                    "blob": .object(["hash": .string(hash), "bytes": .unsigned(UInt64(text.utf8.count)), "type": .string("application/pdf"), "role": .string("original")]),
                ]))
                try await store.appendReplayBatch(domain: .upload, drafts: [ReplayCaptureDraft(replayKey: "upload:\(id.uuidString.lowercased())", draft: draft)])
            }
            try await inbox.drain(into: store)
            let entries = try await uploads()
            XCTAssertEqual(entries.count, 1, "stopped after \(stop)")
            XCTAssertEqual(member(member(entries.first?.payload, "blob"), "hash"), .string(hash), "stopped after \(stop)")
            XCTAssertEqual(try inbox.pending(), [], "stopped after \(stop)")
        }
    }

    func testACancelledDrainLosesNoFile() async throws {
        let text = "synthetic bytes a cancelled drain held"
        try inbox.publish(file: try handed(text), name: "kept.pdf", mediaType: "application/pdf", sharedAt: Self.sharedAt)
        let inbox = inbox!, store = store!
        let cancelled = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await inbox.drain(into: store)
        }
        _ = try? await cancelled.value
        XCTAssertEqual(try inbox.pending().map(\.name), ["kept.pdf"])
        let recorded = try await inbox.drain(into: store)
        XCTAssertEqual(recorded, 1)
        let hash = SHA256Digest.tagged(Data(text.utf8))
        let entries = try await uploads()
        XCTAssertEqual(entries.map { member(member($0.payload, "blob"), "hash") }, [.string(hash)])
        let blob = try await store.blobFile(forTaggedHash: hash)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(blob)), Data(text.utf8))
        XCTAssertEqual(try inbox.pending(), [])
    }

    func testAnItemStillBeingWrittenIsNeverRecorded() async throws {
        let staging = inbox.directory.appendingPathComponent(".staging-\(UUID().uuidString.lowercased())", isDirectory: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        try Data("half a copy".utf8).write(to: staging.appendingPathComponent("payload"))
        XCTAssertEqual(try inbox.pending(), [])
        let recorded = try await inbox.drain(into: store)
        XCTAssertEqual(recorded, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: staging.path))
        XCTAssertEqual(try inbox.pending(now: Date().addingTimeInterval(2 * 24 * 60 * 60)), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path))
    }

    func testAnUnreadableItemHoldsBackNoOther() async throws {
        try inbox.publish(file: try handed("first file"), name: "first.txt", mediaType: "text/plain", sharedAt: Self.sharedAt)
        let broken = try inbox.publish(file: try handed("second file"), name: "second.txt", mediaType: "text/plain",
                                       sharedAt: Self.sharedAt.addingTimeInterval(1))
        try FileManager.default.removeItem(at: inbox.directory.appendingPathComponent("\(broken.uuidString.lowercased())/payload"))
        try inbox.publish(file: try handed("third file"), name: "third.txt", mediaType: "text/plain", sharedAt: Self.sharedAt.addingTimeInterval(2))
        let recorded = try await inbox.drain(into: store)
        XCTAssertEqual(recorded, 2)
        let names = try await uploads().compactMap { member($0.payload, "name") }
        XCTAssertEqual(names, [.string("first.txt"), .string("third.txt")])
        XCTAssertEqual(try inbox.pending().map(\.name), ["second.txt"])
    }
}
