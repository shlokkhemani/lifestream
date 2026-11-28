import Foundation
import CoreGraphics
import XCTest
import Evidence
import DeviceFiles
@testable import Spool

final class OpenSegmentTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("open-segments-" + UUID().uuidString)
    }
    override func tearDownWithError() throws {
        if FileManager.default.fileExists(atPath: root.path) { try FileManager.default.removeItem(at: root) }
    }

    @discardableResult
    private func append(_ store: CaptureStore, _ i: Int, display: UInt32 = 1, width: Int = 128,
                        at: Date? = nil) throws -> CaptureObservation {
        let item = CaptureObservation(capturedAt: at ?? Date(timeIntervalSince1970: 1_700_000_000 + Double(i) * 2),
                                      displayID: display, width: width, height: 96)
        return try store.append(observation: item, image: .raw(SpoolFixtures.frame(width: width, value: UInt8(40 + i % 20 * 10))))
    }
    private func opened(_ item: CaptureObservation) throws -> OpenImage {
        try SpoolJSON.decode(OpenImage.self, from: Data(contentsOf: root.appendingPathComponent(XCTUnwrap(item.imageFile))))
    }
    private func openSegments() throws -> [String] {
        let video = root.appendingPathComponent(".video")
        guard FileManager.default.fileExists(atPath: video.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(atPath: video.path).filter { $0.hasPrefix(".open-") }.sorted()
    }
    private func closeAll(_ store: CaptureStore) throws {
        while try VideoCompaction.compact(store: store, flush: true).imageCount > 0 {}
    }
    private func assertArchived(_ items: [CaptureObservation], in store: CaptureStore, values: [Int],
                                file: StaticString = #filePath, line: UInt = #line) throws {
        let saved = try store.read(limit: 1000)
        for (item, value) in zip(items, values) {
            let current = try XCTUnwrap(saved.first { $0.imageFile == item.imageFile }, file: file, line: line)
            XCTAssertNotNil(current.imageEncoding, file: file, line: line)
            let bundle = root.appendingPathComponent(item.imageFile!).deletingLastPathComponent()
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: bundle.path).sorted(),
                           ["image.archive", "observation.lsm"], file: file, line: line)
            SpoolFixtures.assertPixels(try store.readImage(for: item), near: value, file: file, line: line)
        }
    }

    func testFramesShareASegmentByDisplayAndSizeUntilFullOldOrFlushed() throws {
        let store = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), videoQuality: 0.8)
        let now = Date()
        let first = try (0..<31).map { try append(store, $0, at: now.addingTimeInterval(Double($0 * 2) - 200)) }
        let other = try append(store, 31, display: 2, at: now.addingTimeInterval(-100))
        let smaller = try append(store, 32, width: 64, at: now)
        let fresh = try append(store, 33, at: now)
        let segments = try first.map { try opened($0).segment }
        XCTAssertEqual(Set(segments.prefix(30)).count, 1, "one display and size: one segment of 30")
        XCTAssertEqual(try first.prefix(30).map { try opened($0).ordinal }, Array(0..<30))
        XCTAssertNotEqual(segments[30], segments[0], "a full segment takes no 31st frame")
        XCTAssertEqual(try opened(fresh).segment, segments[30], "the next frame of that display joins the new one")
        XCTAssertEqual(Set(try [other, smaller].map { try opened($0).segment } + [segments[0], segments[30]]).count, 4)

        XCTAssertEqual(try VideoCompaction.compact(store: store, flush: false).imageCount, 30)
        let old = try (0..<2).map { _ in try VideoCompaction.compact(store: store, flush: false).imageCount }
        XCTAssertEqual(old.sorted(), [1, 2])
        XCTAssertEqual(try VideoCompaction.compact(store: store, flush: false).imageCount, 0, "a fresh segment waits")
        XCTAssertEqual(try openSegments().count, 1)
        XCTAssertEqual(try VideoCompaction.compact(store: store, flush: true).imageCount, 1)
        XCTAssertEqual(try openSegments(), [])
        XCTAssertEqual(store.pendingVideoReport().pendingImageCount, 0)
        try assertArchived(first + [other, fresh], in: store, values: (0..<31).map { 40 + $0 % 20 * 10 } + [150, 170])
        try assertArchived([smaller], in: store, values: [160])
    }

    func testAFrameReadsTheSameFromItsOpenSegmentAndFromItsMovie() throws {
        let store = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), videoQuality: 0.8)
        let items = try (0..<14).map { try append(store, $0) }
        let reader = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), readOnly: true)
        let open = try items.map { try reader.readImage(for: $0) }
        try closeAll(store)
        XCTAssertNotNil(try reader.read(limit: 14).first?.imageEncoding)
        for (item, before) in zip(items, open) {
            XCTAssertEqual(try reader.readImage(for: item), before)
        }
    }

    func testACrashAfterTheSampleIsLoggedLeavesNoFrameAndTheSegmentClosesWithTheOnesBefore() throws {
        enum Crash: Error { case now }
        var appends = 0
        let kept: [CaptureObservation]
        do {
            let store = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), observationDecoder: { try SpoolJSON.decode(CaptureObservation.self, from: $0) },
                                         appendInterrupt: {
                appends += 1
                if appends == 3 { throw Crash.now }
            })
            kept = try (0..<2).map { try append(store, $0) }
            XCTAssertThrowsError(try append(store, 2))
        }
        let reader = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), readOnly: true)
        XCTAssertEqual(try reader.read().count, 2, "the staged bundle is not published")
        XCTAssertEqual(try reader.status().incompleteCount, 1)
        let writer = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true))
        try closeAll(writer)
        try assertArchived(kept, in: writer, values: [40, 50])
        XCTAssertEqual(try openSegments(), [])
    }

    func testAFailureAfterTheSampleIsLoggedSealsTheSegmentAndTheNextFrameStartsANewOne() throws {
        enum Failure: Error { case now }
        var appends = 0
        let store = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), observationDecoder: { try SpoolJSON.decode(CaptureObservation.self, from: $0) },
                                     appendInterrupt: {
            appends += 1
            if appends == 3 { throw Failure.now }
        })
        let before = try (0..<2).map { try append(store, $0) }
        XCTAssertThrowsError(try append(store, 2))
        let after = try (3..<5).map { try append(store, $0) }
        XCTAssertNotEqual(try opened(after[0]).segment, try opened(before[0]).segment)
        XCTAssertEqual(try opened(after[0]).ordinal, 0)
        try closeAll(store)
        try assertArchived(before + after, in: store, values: [40, 50, 70, 80])
        XCTAssertEqual(try openSegments(), [])
    }

    func testACrashAfterTheRenameReadsFromTheLogAndClosesOnReopen() throws {
        let items: [CaptureObservation]
        do {
            let store = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true))
            items = try (0..<3).map { try append(store, $0) }
        }
        let reader = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), readOnly: true)
        for (item, value) in zip(items, [40, 50, 60]) {
            SpoolFixtures.assertPixels(try reader.readImage(for: item), near: value)
        }
        let writer = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true))
        XCTAssertEqual(writer.pendingVideoReport().pendingImageCount, 3)
        XCTAssertEqual(try VideoCompaction.compact(store: writer, flush: false).imageCount, 3,
                       "a writer that opens closes every open segment it finds")
        try assertArchived(items, in: writer, values: [40, 50, 60])
        try append(writer, 3)
        XCTAssertEqual(try openSegments().count, 1)
    }

    func testATornTailRecordIsDropped() throws {
        let items: [CaptureObservation]
        do {
            let store = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true))
            items = try (0..<2).map { try append(store, $0) }
        }
        let samples = root.appendingPathComponent(".video").appendingPathComponent(try XCTUnwrap(openSegments().first))
            .appendingPathComponent("samples")
        let log = try Data(contentsOf: samples)
        let handle = try FileHandle(forWritingTo: samples)
        try handle.seekToEnd()
        try handle.write(contentsOf: log.prefix(log.count / 3))
        try handle.close()
        let writer = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true))
        try closeAll(writer)
        try assertArchived(items, in: writer, values: [40, 50])
    }

    func testASegmentClosesAroundAMiddleFrameThatDoesNotAdmit() throws {
        for damage in ["bundle-deleted", "metadata-unreadable", "image-open-elsewhere"] {
            let directory = root.appendingPathComponent(damage)
            let items: [CaptureObservation]
            do {
                let store = try CaptureStore(directory: directory, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true))
                items = try (0..<3).map {
                    try store.append(observation: CaptureObservation(capturedAt: Date(timeIntervalSince1970: 1_700_000_000 + Double($0) * 2),
                                                                     displayID: 1, width: 128, height: 96),
                                     image: .raw(SpoolFixtures.frame(value: UInt8(40 + $0 * 10))))
                }
            }
            let middle = directory.appendingPathComponent(items[1].imageFile!).deletingLastPathComponent()
            var before: [String: Data] = [:]
            switch damage {
            case "bundle-deleted":
                try FileManager.default.removeItem(at: middle)
            case "metadata-unreadable":
                try MetadataCodec.encode(Data(#"{"synthetic":"not an observation"}"#.utf8))
                    .write(to: middle.appendingPathComponent("observation.lsm"))
            default:
                let file = middle.appendingPathComponent("image.open")
                let opened = try SpoolJSON.decode(OpenImage.self, from: Data(contentsOf: file))
                try SpoolJSON.encode(OpenImage(segment: opened.segment, ordinal: 0)).write(to: file)
            }
            if damage != "bundle-deleted" {
                for name in try FileManager.default.contentsOfDirectory(atPath: middle.path) {
                    before[name] = try Data(contentsOf: middle.appendingPathComponent(name))
                }
            }
            let report = try VideoCompaction.compact(store: CaptureStore(directory: directory, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true)), flush: true)
            XCTAssertEqual(report.imageCount, 2, damage)
            let folders = try FileManager.default.contentsOfDirectory(atPath: directory.appendingPathComponent(".video").path)
            XCTAssertEqual(folders.filter { $0.hasPrefix(".") }, [], "the segment closed: \(damage)")
            let movie = try XCTUnwrap(folders.first { $0.hasSuffix(".mov") })
            let sidecars = try [items[0], items[2]].map { item -> ArchiveSidecar in
                let bundle = directory.appendingPathComponent(item.imageFile!).deletingLastPathComponent()
                XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: bundle.path).sorted(),
                               ["image.archive", "observation.lsm"], damage)
                return try SpoolJSON.decode(ArchiveSidecar.self, from: Data(contentsOf: bundle.appendingPathComponent("image.archive")))
            }
            XCTAssertEqual(sidecars.map(\.reference.ordinal), [0, 2], "every sample is in the movie: \(damage)")
            XCTAssertEqual(sidecars.map(\.reference.frameCount), [3, 3])
            XCTAssertEqual(sidecars[0].reference.segment, ".video/" + movie)
            let reader = try CaptureStore(directory: directory, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), readOnly: true)
            SpoolFixtures.assertPixels(try reader.readImage(for: items[0]), near: 40)
            SpoolFixtures.assertPixels(try reader.readImage(for: items[2]), near: 60)
            if damage != "bundle-deleted" {
                var after: [String: Data] = [:]
                for name in try FileManager.default.contentsOfDirectory(atPath: middle.path) {
                    after[name] = try Data(contentsOf: middle.appendingPathComponent(name))
                }
                XCTAssertEqual(after, before, "the frame that does not admit is left as it is: \(damage)")
            }
            let expectedPending = damage == "metadata-unreadable" ? 1 : 0
            XCTAssertEqual(report.pendingImageCount, expectedPending, damage)
            XCTAssertEqual(report.skippedImageCount, expectedPending, damage)
            let again = try VideoCompaction.compact(store: CaptureStore(directory: directory, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true)), flush: true)
            XCTAssertEqual(again.imageCount, 0)
            XCTAssertEqual(again.pendingImageCount, 0, "its segment is gone: a new store does not count it: \(damage)")
            XCTAssertEqual(again.skippedImageCount, 0, damage)
        }
    }

    func testPendingCountsAndBytesAreTheFramesNotYetInAClosedMovie() throws {
        let bytes: Int
        do {
            let store = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true))
            try (0..<3).forEach { try append(store, $0) }
            let report = store.pendingVideoReport()
            XCTAssertEqual(report.pendingImageCount, 3)
            XCTAssertGreaterThan(report.pendingBytes, 0)
            bytes = report.pendingBytes
        }
        let reopened = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true))
        XCTAssertEqual(reopened.pendingVideoReport().pendingBytes, bytes, "the samples' bytes, after a restart too")
        try closeAll(reopened)
        XCTAssertEqual(reopened.pendingVideoReport().pendingImageCount, 0)
        XCTAssertEqual(reopened.pendingVideoReport().pendingBytes, 0)
    }

    private func exhaustedEncoder(_ encoding: CaptureVideoProvenance) throws -> SegmentEncoder {
        let encoder = try SegmentEncoder(encoding: encoding)
        let image = try SegmentCodec.image(.raw(SpoolFixtures.frame(width: encoding.originalWidth,
                                                                    height: encoding.originalHeight, value: 1)))
        for _ in 0..<SegmentReference.maximumFrameCount {
            _ = try encoder.encode(encoder.convert(image))
        }
        return encoder
    }

    func testAnEncoderFailureIsRetriedOnceInANewSegment() throws {
        var made = 0
        let store = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), observationDecoder: { try SpoolJSON.decode(CaptureObservation.self, from: $0) },
                                     makeEncoder: { encoding in
            made += 1
            return made == 1 ? try self.exhaustedEncoder(encoding) : try SegmentEncoder(encoding: encoding)
        })
        let item = try append(store, 0)
        XCTAssertEqual(made, 2)
        XCTAssertEqual(try opened(item).ordinal, 0)
        XCTAssertEqual(try openSegments().count, 1, "the failed segment took no frame and left no folder")
        try closeAll(store)
        try assertArchived([item], in: store, values: [40])
    }

    func testAFrameNoEncoderTakesIsRefusedAndTheSegmentBeforeItCloses() throws {
        var failing = false
        let store = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), observationDecoder: { try SpoolJSON.decode(CaptureObservation.self, from: $0) },
                                     makeEncoder: { encoding in
            failing ? try self.exhaustedEncoder(encoding) : try SegmentEncoder(encoding: encoding)
        })
        let before = try (0..<2).map { try append(store, $0) }
        _ = try VideoCompaction.compact(store: store, flush: true)
        failing = true
        XCTAssertThrowsError(try append(store, 2)) { error in
            guard case CaptureStoreError.videoEncoderUnavailable = error else { return XCTFail("\(error)") }
        }
        XCTAssertEqual(try store.status().recordCount, 2, "the frame is not kept")
        XCTAssertEqual(try openSegments(), [])
        try assertArchived(before, in: store, values: [40, 50])
    }


    private func folderBytes(_ folder: URL) throws -> [String: Data] {
        var bytes: [String: Data] = [:]
        for name in try FileManager.default.contentsOfDirectory(atPath: folder.path) {
            bytes[name] = try Data(contentsOf: folder.appendingPathComponent(name))
        }
        return bytes
    }

    private func videoEntries() throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent(".video").path).sorted()
    }

    func testASegmentThatCanNeverCloseIsSetAsideAndTheNextCompacts() throws {
        for damage in ["format-garbage", "format-gone", "log-garbage"] {
            try? FileManager.default.removeItem(at: root)
            let settles = Settles()
            let store = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true),
                                         onSegmentSettled: { settles.add() })
            let damaged = try (0..<2).map { try append(store, $0) }
            let other = try append(store, 2, display: 2)
            let id = try opened(damaged[0]).segment
            let folder = root.appendingPathComponent(".video/.open-" + id)
            switch damage {
            case "format-garbage":
                try Data("synthetic garbage, not a format".utf8).write(to: folder.appendingPathComponent("format"))
            case "format-gone":
                try FileManager.default.removeItem(at: folder.appendingPathComponent("format"))
            default:
                try Data(repeating: 0xAB, count: 300).write(to: folder.appendingPathComponent("samples"))
            }
            let before = try folderBytes(folder)
            let bundles = try damaged.map { try folderBytes(root.appendingPathComponent($0.imageFile!).deletingLastPathComponent()) }
            XCTAssertEqual(store.pendingVideoReport().pendingImageCount, 3, damage)

            var archived = 0
            while case let count = try VideoCompaction.compact(store: store, flush: true).imageCount, count > 0 {
                archived += count
            }
            XCTAssertEqual(archived, 1, "the other display's segment closes in the same store: \(damage)")
            XCTAssertEqual(settles.count, 2, "the segment set aside settles its frames too: \(damage)")
            let report = store.pendingVideoReport()
            XCTAssertEqual(report.pendingImageCount, 0, "its frames leave the pending map: \(damage)")
            XCTAssertEqual(report.skippedImageCount, 0, damage)
            XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path), damage)
            let kept = root.appendingPathComponent(".video/.damaged-" + id + "/open")
            XCTAssertEqual(try folderBytes(kept), before, "the damaged files are kept as they were: \(damage)")
            for (item, bytes) in zip(damaged, bundles) {
                XCTAssertEqual(try folderBytes(root.appendingPathComponent(item.imageFile!).deletingLastPathComponent()), bytes,
                               "its frames' bundles are untouched: \(damage)")
            }
            try assertArchived([other], in: store, values: [60])
            XCTAssertEqual(try videoEntries().filter { $0.hasPrefix(".") }, [".damaged-" + id], damage)
        }
    }

    func testAFolderWithAFormatAndNoSamplesIsRemoved() throws {
        for damage in ["samples-gone", "samples-empty"] {
            try? FileManager.default.removeItem(at: root)
            let store = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true))
            let item = try append(store, 0)
            let folder = root.appendingPathComponent(".video/.open-" + (try opened(item).segment))
            let samples = folder.appendingPathComponent("samples")
            if damage == "samples-gone" {
                try FileManager.default.removeItem(at: samples)
            } else {
                try Data().write(to: samples)
            }
            XCTAssertEqual(try VideoCompaction.compact(store: store, flush: true).imageCount, 0, damage)
            XCTAssertEqual(try videoEntries().filter { $0.hasPrefix(".") }, [], damage)
        }
    }

    func testASamplesReadThatFailsKeepsTheFolderAndFailsThePass() throws {
        var failing = true
        let store = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), observationDecoder: { try SpoolJSON.decode(CaptureObservation.self, from: $0) },
                                     readFile: { url, maximum in
            if failing && url.lastPathComponent == "samples" {
                throw DeviceFileError.io(operation: "read samples", code: EIO)
            }
            return try SpoolFiles.read(DeviceFiles(.plain), url, maximumBytes: maximum)
        })
        let items = try (0..<2).map { try append(store, $0) }
        XCTAssertThrowsError(try VideoCompaction.compact(store: store, flush: true)) { error in
            XCTAssertEqual(error as? DeviceFileError, .io(operation: "read samples", code: EIO))
        }
        XCTAssertEqual(try openSegments().count, 1)
        XCTAssertEqual(try videoEntries().filter { $0.hasPrefix(".damaged-") }, [])
        XCTAssertEqual(store.pendingVideoReport().pendingImageCount, 2)
        failing = false
        try closeAll(store)
        try assertArchived(items, in: store, values: [40, 50])
    }


    func testAfterARestartThePendingMapIsThePublishedFramesTheLogsName() throws {
        enum Crash: Error { case now }
        var appends = 0
        let items: [CaptureObservation]
        let gone: CaptureObservation
        do {
            let store = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), observationDecoder: { try SpoolJSON.decode(CaptureObservation.self, from: $0) },
                                         appendInterrupt: {
                appends += 1
                if appends == 4 { throw Crash.now }
            })
            items = try (0..<2).map { try append(store, $0) }
            gone = try append(store, 2, display: 2)
            XCTAssertThrowsError(try append(store, 3), "staged, logged, never renamed")
        }
        let other = root.appendingPathComponent(items[1].imageFile!)
        let named = try opened(items[1])
        try SpoolJSON.encode(OpenImage(segment: named.segment, ordinal: 0)).write(to: other)
        try FileManager.default.removeItem(at: root.appendingPathComponent(".video/.open-" + (try opened(gone).segment)))

        let writer = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true))
        XCTAssertEqual(Set(writer.pendingImages.keys), [items[0].imageFile!])
        XCTAssertEqual(writer.pendingVideoReport().pendingImageCount, 1)
        XCTAssertEqual(writer.pendingVideoReport().skippedImageCount, 0)
        let read = try XCTUnwrap(try writer.read().first { $0.imageFile == gone.imageFile })
        XCTAssertNil(read.imageEncoding, "a frame whose segment is gone reads, with no image")
        XCTAssertThrowsError(try writer.readImage(for: gone))
        try closeAll(writer)
        try assertArchived([items[0]], in: writer, values: [40])
    }

    func testAfterARestartADamagedFormatIsSetAsideAndItsFramesNeverCountPending() throws {
        let items: [CaptureObservation]
        do {
            let store = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true))
            items = try (0..<2).map { try append(store, $0) }
        }
        let id = try opened(items[0]).segment
        let folder = root.appendingPathComponent(".video/.open-" + id)
        try Data("synthetic garbage, not a format".utf8).write(to: folder.appendingPathComponent("format"))
        let before = try folderBytes(folder)

        do {
            let writer = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true))
            XCTAssertEqual(writer.pendingVideoReport().pendingImageCount, 0, "a format that does not read names no frame")
            XCTAssertEqual(writer.sealedSegments, [id], "but the folder waits for closing to decide it")
            XCTAssertEqual(try VideoCompaction.compact(store: writer, flush: true).imageCount, 0)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
        XCTAssertEqual(try folderBytes(root.appendingPathComponent(".video/.damaged-" + id + "/open")), before,
                       "set aside whole, not removed")

        let next = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true))
        let report = try VideoCompaction.compact(store: next, flush: true)
        XCTAssertEqual(report.pendingImageCount, 0, "the frames of a set-aside segment are not pending")
        XCTAssertEqual(report.skippedImageCount, 0)
        XCTAssertEqual(try videoEntries().filter { $0.hasPrefix(".") }, [".damaged-" + id])
        XCTAssertEqual(try next.read().map(\.imageEncoding), [nil, nil], "its frames read, with no image")
    }


    func testAFrameOfAnotherUTCDayStartsANewSegmentAndSealsTheFirst() throws {
        let store = try CaptureStore(directory: root, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true))
        let night = try append(store, 0, at: Date(timeIntervalSince1970: 1_700_006_390))
        let same = try append(store, 1, at: Date(timeIntervalSince1970: 1_700_006_398))
        let morning = try append(store, 2, at: Date(timeIntervalSince1970: 1_700_031_600))
        let back = try append(store, 3, at: Date(timeIntervalSince1970: 1_700_006_399))
        XCTAssertEqual(try opened(same).segment, try opened(night).segment)
        XCTAssertNotEqual(try opened(morning).segment, try opened(night).segment, "the next day starts a new segment")
        XCTAssertEqual(try opened(morning).ordinal, 0)
        XCTAssertNotEqual(try opened(back).segment, try opened(morning).segment, "a day set back starts another")
        XCTAssertEqual(store.sealedSegments, [try opened(night).segment, try opened(morning).segment],
                       "each segment left behind is sealed, oldest first")
        try closeAll(store)
        try assertArchived([night, same, morning, back], in: store, values: [40, 50, 60, 70])
        let movies = try [night, same, morning, back].map { item -> String in
            let bundle = root.appendingPathComponent(item.imageFile!).deletingLastPathComponent()
            return try SpoolJSON.decode(ArchiveSidecar.self, from: Data(contentsOf: bundle.appendingPathComponent("image.archive")))
                .reference.segment
        }
        XCTAssertEqual(Set(movies).count, 3)
        XCTAssertEqual(movies[0], movies[1])
    }
}
