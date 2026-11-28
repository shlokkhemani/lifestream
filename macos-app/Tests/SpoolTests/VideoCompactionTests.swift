import Foundation
import CoreGraphics
import CryptoKit
import XCTest
import Evidence
import DeviceFiles
@testable import Spool

class VideoCompactionTests: SpoolFormCase {
    private func frame(_ value: UInt8) -> RawFrame {
        let width = 128, height = 96
        var bytes = Data(repeating: value, count: width * height * 4)
        for i in stride(from: 3, to: bytes.count, by: 4) { bytes[i] = 255 }
        return RawFrame(layout: FrameLayout(width: width, height: height, bytesPerRow: width * 4,
            bitmapInfo: SegmentCodec.bitmap, renderingIntent: 0,
            ICCData: CGColorSpace(name: CGColorSpace.sRGB)!.copyICCData()! as Data), data: bytes)
    }
    private func observation(_ i: Int, date: Date? = nil) -> CaptureObservation {
        let text = TextObservation(text: "SYNTHETIC FRAME \(i)", confidence: 1,
                                   bounds: CaptureRect(x: 0, y: 0, width: 1, height: 1))
        return CaptureObservation(
            capturedAt: date ?? Date(timeIntervalSince1970: 1_700_000_000 + Double(i * 2)),
            displayID: UInt32(i % 2 + 1),
            width: 128,
            height: 96,
            ocr: [text]
        )
    }
    private func append(_ store: CaptureStore, _ i: Int, date: Date? = nil) throws -> CaptureObservation {
        try store.append(observation: observation(i, date: date), image: .raw(frame(UInt8(40 + i * 10))))
    }
    private func metadataURL(_ item: CaptureObservation) -> URL {
        let bundle = root.appendingPathComponent(item.imageFile!).deletingLastPathComponent()
        return bundle.appendingPathComponent("observation.lsm")
    }
    private func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }
    private func hasPreparation(in videoDirectory: URL) throws -> Bool {
        try FileManager.default.contentsOfDirectory(atPath: videoDirectory.path).contains { $0.hasPrefix(".pending-") }
    }
    private func verify(_ store: CaptureStore, _ old: CaptureObservation, value: Int) throws {
        guard case .raw(let image) = try store.readImage(for: old) else { return XCTFail("Expected readable image") }
        XCTAssertEqual(image.layout.width, 128)
        XCTAssertLessThanOrEqual(abs(Int(image.data[0]) - value), 5)
    }
    func testLiveCompactionPreservesMetadataAndHandlesWhileRemovingPendingPixels() async throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 0.8)
        let original = try (0..<6).map { try append(store, $0) }
        let metadata = try original.map { try Data(contentsOf: metadataURL($0)) }
        let report = try await store.compactPendingVideo(flush: true)
        XCTAssertEqual(report.imageCount, 3)
        XCTAssertEqual(report.pendingImageCount, 3)
        let next = try await store.compactPendingVideo(flush: true)
        XCTAssertEqual(next.imageCount, 3)
        XCTAssertEqual(next.pendingImageCount, 0)
        XCTAssertEqual(next.pendingBytes, 0)
        let reader = try CaptureStore(directory: root, files: files, scratch: scratch, readOnly: true)
        let saved = try reader.read()
        XCTAssertEqual(saved.count, 6)
        for i in original.indices {
            XCTAssertNotNil(saved[i].imageEncoding)
            XCTAssertEqual(saved[i].ocr, original[i].ocr)
            XCTAssertEqual(saved[i].imageFile, original[i].imageFile)
            XCTAssertFalse(exists(root.appendingPathComponent(original[i].imageFile!)))
            XCTAssertEqual(try Data(contentsOf: metadataURL(original[i])), metadata[i])
            try verify(reader, original[i], value: 40 + i * 10)
            try verify(reader, saved[i], value: 40 + i * 10)
        }
        let empty = try await store.compactPendingVideo(flush: true)
        XCTAssertEqual(empty.imageCount, 0)
        XCTAssertTrue(scratchIsEmpty(), "the scratch movie is gone once placed")
        for movie in try FileManager.default.contentsOfDirectory(at: root.appendingPathComponent(".video"),
                                                                  includingPropertiesForKeys: nil)
        where movie.pathExtension == "mov" {
            try assertInForm(movie)
        }
    }
    func testASegmentSaysWhenItSettlesAndNothingElseDoes() throws {
        let settles = Settles()
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 0.8,
                                     onSegmentSettled: { settles.add() })
        _ = try VideoCompaction.compact(store: store, flush: true)
        XCTAssertEqual(settles.count, 0, "an empty spool settles nothing")

        let now = Date()
        _ = try (0..<4).map { try append(store, $0, date: now.addingTimeInterval(Double($0))) }
        XCTAssertEqual(try VideoCompaction.compact(store: store, flush: false).imageCount, 0)
        XCTAssertEqual(settles.count, 0, "a segment under its wait is not settled")

        XCTAssertEqual(try VideoCompaction.compact(store: store, flush: true).imageCount, 2)
        XCTAssertEqual(settles.count, 1)
        XCTAssertEqual(try VideoCompaction.compact(store: store, flush: true).imageCount, 2)
        XCTAssertEqual(settles.count, 2, "each segment published says so once")
        XCTAssertEqual(try VideoCompaction.compact(store: store, flush: true).imageCount, 0)
        XCTAssertEqual(settles.count, 2)
    }
    func testEveryPublicationInterruptionResumesOnReopen() throws {
        enum SimulatedDeath: Error { case interrupted }
        for (index, stage) in VideoCompaction.Stage.allCases.enumerated() {
            let directory = root.appendingPathComponent("stage-\(index)")
            var original: CaptureObservation!
            var second: CaptureObservation!
            do {
                let store = try CaptureStore(directory: directory, files: files, scratch: scratch, videoQuality: 1)
                original = try append(store, 0)
                second = try append(store, 2)
                XCTAssertThrowsError(try VideoCompaction.compact(store: store, flush: true, interrupt: { reached in
                    if reached == stage { throw SimulatedDeath.interrupted }
                }))
            }
            let reader = try CaptureStore(directory: directory, files: files, scratch: scratch, readOnly: true)
            try verify(reader, original, value: 40)
            try verify(reader, second, value: 60)
            let reopened = try CaptureStore(directory: directory, files: files, scratch: scratch, videoQuality: 1)
            let report = try VideoCompaction.compact(store: reopened, flush: true)
            XCTAssertEqual(report.pendingImageCount, 0)
            try verify(reader, original, value: 40)
            try verify(reader, second, value: 60)
            XCTAssertEqual(try reader.read().map { $0.imageEncoding != nil }, [true, true])
            XCTAssertFalse(try hasPreparation(in: directory.appendingPathComponent(".video")))
        }
    }
    func testIdleTicksAndSuccessfulBatchesDiscoverRecoveryOnlyOnce() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        var discoveries = 0
        func discover(_ directory: URL) throws -> [URL] {
            discoveries += 1
            return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        }
        func compact() throws -> VideoCompactionReport {
            try VideoCompaction.compact(store: store, flush: true, discover: discover)
        }
        XCTAssertEqual(try compact().pendingImageCount, 0)
        for _ in 0..<4 { XCTAssertEqual(try compact().imageCount, 0) }
        XCTAssertEqual(discoveries, 1)
        for index in 0..<3 {
            let saved = try append(store, index)
            let report = try compact()
            XCTAssertEqual(report.imageCount, 1)
            XCTAssertEqual(report.pendingImageCount, 0)
            try verify(store, saved, value: 40 + index * 10)
            XCTAssertEqual(try compact().imageCount, 0)
        }
        XCTAssertEqual(discoveries, 1)
    }
    func testEveryPublicationInterruptionResumesInTheSameWriter() throws {
        enum SimulatedFailure: Error { case interrupted }
        for (index, stage) in VideoCompaction.Stage.allCases.enumerated() {
            let directory = root.appendingPathComponent("same-writer-\(index)")
            let store = try CaptureStore(directory: directory, files: files, scratch: scratch, videoQuality: 1)
            let original = try append(store, 0)
            var discoveries = 0
            func discover(_ directory: URL) throws -> [URL] {
                discoveries += 1
                return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            }
            let interrupt = { (reached: VideoCompaction.Stage) throws in
                if reached == stage {
                    throw SimulatedFailure.interrupted
                }
            }
            XCTAssertThrowsError(try VideoCompaction.compact(store: store, flush: true, discover: discover,
                                                             interrupt: interrupt))
            XCTAssertEqual(discoveries, 1)
            let resumed = try VideoCompaction.compact(store: store, flush: true, discover: discover)
            XCTAssertEqual(resumed.pendingImageCount, 0)
            XCTAssertEqual(discoveries, 2)
            try verify(store, original, value: 40)
            XCTAssertNotNil(try store.read().first?.imageEncoding)
            let replayed = stage == .movieWritten ? 0 : 1
            _ = try VideoCompaction.compact(store: store, flush: true, discover: discover)
            XCTAssertEqual(discoveries, 2 + replayed)
            _ = try VideoCompaction.compact(store: store, flush: true, discover: discover)
            XCTAssertEqual(discoveries, 2 + replayed)
        }
    }
    func testFailedCloseIsCleanedUpAndRetriedOnTheNextTick() throws {
        enum ChecksumFailure: Error { case unreadable }
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        let saved = try append(store, 0, date: Date())
        var discoveries = 0
        func discover(_ directory: URL) throws -> [URL] {
            discoveries += 1
            return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        }
        XCTAssertThrowsError(try VideoCompaction.compact(store: store, flush: true, discover: discover,
                                                         readMovie: { _ in throw ChecksumFailure.unreadable }))
        XCTAssertEqual(discoveries, 1)
        let videoDirectory = root.appendingPathComponent(".video")
        XCTAssertTrue(try hasPreparation(in: videoDirectory))
        try verify(store, saved, value: 40)
        let retried = try VideoCompaction.compact(store: store, flush: false, discover: discover)
        XCTAssertEqual(discoveries, 2)
        XCTAssertEqual(retried.imageCount, 1)
        XCTAssertEqual(retried.pendingImageCount, 0)
        XCTAssertEqual(retried.skippedImageCount, 0)
        XCTAssertFalse(try hasPreparation(in: videoDirectory))
        _ = try VideoCompaction.compact(store: store, flush: false, discover: discover)
        XCTAssertEqual(discoveries, 2)
        try verify(store, saved, value: 40)
    }
    func testFailedRecoveryDiscoveryRemainsRetryable() throws {
        enum DiscoveryFailure: Error { case unavailable }
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        let failingDiscovery = { (_: URL) throws -> [URL] in
            throw DiscoveryFailure.unavailable
        }
        XCTAssertThrowsError(try VideoCompaction.compact(store: store, flush: false, discover: failingDiscovery))
        var discoveries = 0
        func discover(_ directory: URL) throws -> [URL] {
            discoveries += 1
            return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        }
        _ = try VideoCompaction.compact(store: store, flush: false, discover: discover)
        _ = try VideoCompaction.compact(store: store, flush: false, discover: discover)
        XCTAssertEqual(discoveries, 1)
    }
    func testACorruptRecoveryJournalIsSetAsideAndDeletesNothing() throws {
        enum Stop: Error { case now }
        let corruptions: [(inout [String: Any]) -> Void] = [
            { $0["metadataSHA256"] = Data(repeating: 7, count: 32).base64EncodedString() },
            { entry in
                var reference = entry["reference"] as! [String: Any]
                reference["capturedAt"] = 1234.0
                entry["reference"] = reference
            },
        ]
        for (index, corrupt) in corruptions.enumerated() {
            let directory = root.appendingPathComponent("corrupt-journal-\(index)")
            var original: CaptureObservation!
            do {
                let store = try CaptureStore(directory: directory, files: files, scratch: scratch, videoQuality: 1)
                original = try append(store, 0)
                XCTAssertThrowsError(try VideoCompaction.compact(store: store, flush: true, interrupt: { stage in
                    if stage == .prepared {
                        throw Stop.now
                    }
                }))
            }
            let videoDirectory = directory.appendingPathComponent(".video")
            let staging = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: videoDirectory,
                includingPropertiesForKeys: nil).first { $0.lastPathComponent.hasPrefix(".pending-") })
            let manifest = staging.appendingPathComponent("journal.json")
            var document = try JSONSerialization.jsonObject(with: kept(manifest)) as! [String: Any]
            var entries = document["entries"] as! [[String: Any]]
            corrupt(&entries[0])
            document["entries"] = entries
            try keep(JSONSerialization.data(withJSONObject: document), at: manifest)
            let id = String(staging.lastPathComponent.dropFirst(".pending-".count))
            let reopened = try CaptureStore(directory: directory, files: files, scratch: scratch, videoQuality: 1)
            let report = try VideoCompaction.compact(store: reopened, flush: true)
            XCTAssertEqual(report.imageCount, 0)
            XCTAssertEqual(report.pendingImageCount, 0, "a journal that can never finish is set aside with its frames")
            XCTAssertTrue(exists(directory.appendingPathComponent(original.imageFile!)))
            XCTAssertFalse(exists(directory.appendingPathComponent(original.imageFile!)
                .deletingLastPathComponent().appendingPathComponent("image.archive")))
            let damaged = videoDirectory.appendingPathComponent(".damaged-" + id)
            XCTAssertTrue(exists(damaged.appendingPathComponent("pending/journal.json")))
            XCTAssertTrue(exists(damaged.appendingPathComponent("pending/movie.mov")))
            XCTAssertTrue(exists(damaged.appendingPathComponent("open/samples")))
            XCTAssertFalse(try hasPreparation(in: videoDirectory))
        }
    }
    func testReadOnlyCannotCompact() async throws {
        do {
            let writer = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
            _ = try append(writer, 0)
        }
        let reader = try CaptureStore(directory: root, files: files, scratch: scratch, readOnly: true)
        do {
            _ = try await reader.compactPendingVideo()
            XCTFail("Read-only mutation")
        } catch {
            XCTAssertEqual(error as? CaptureStoreError == nil, false)
        }
    }
    func testNormalThirtyFramePublicationHashesTheMovieAtCreationAndOnceBeforeSidecars() throws {
        var observationDecodes = 0
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1, observationDecoder: { data in
            observationDecodes += 1
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .millisecondsSince1970
            return try decoder.decode(CaptureObservation.self, from: data)
        })
        let pixels = frame(60)
        let start = Date()
        for index in 0..<30 {
            let item = CaptureObservation(capturedAt: start.addingTimeInterval(Double(index)),
                displayID: 1, width: 128, height: 96)
            _ = try store.append(observation: item, image: .raw(pixels))
            if index == 28 {
                observationDecodes = 0
                XCTAssertEqual(try VideoCompaction.compact(store: store, flush: false).imageCount, 0)
                XCTAssertEqual(observationDecodes, 0, "Images waiting for their segment are not decoded")
            }
        }
        var reads: [String] = []
        observationDecodes = 0
        let report = try VideoCompaction.compact(store: store, flush: false, readMovie: { url in
            reads.append(url.lastPathComponent)
            return try self.kept(url)
        })
        XCTAssertEqual(report.imageCount, 30)
        XCTAssertEqual(report.pendingImageCount, 0)
        XCTAssertEqual(observationDecodes, 60,
                       "Each observation is decoded once to admit it and once by the trust rule, never more")
        XCTAssertEqual(reads, ["movie.mov", "movie.mov"],
                       "One creation checksum, then one publication checksum before the rename")
    }
    func testRecoveryChecksumsTheMovieOnceWhereverTheInterruptionLeftIt() throws {
        enum Stop: Error { case now }
        for (index, interruption) in [VideoCompaction.Stage.prepared, .moviePublished].enumerated() {
            let directory = root.appendingPathComponent("recovery-integrity-\(index)")
            do {
                let writer = try CaptureStore(directory: directory, files: files, scratch: scratch, videoQuality: 1)
                _ = try append(writer, 0)
                XCTAssertThrowsError(try VideoCompaction.compact(store: writer, flush: true,
                    interrupt: { if $0 == interruption { throw Stop.now } }))
            }
            let writer = try CaptureStore(directory: directory, files: files, scratch: scratch, videoQuality: 1)
            var reads: [String] = []
            let report = try VideoCompaction.compact(store: writer, flush: true, readMovie: { url in
                reads.append(url.lastPathComponent)
                return try self.kept(url)
            })
            XCTAssertEqual(report.pendingImageCount, 0)
            XCTAssertEqual(reads.count, 1)
            if interruption == .prepared {
                XCTAssertEqual(reads, ["movie.mov"], "The prepared movie is checked before its rename")
            } else {
                XCTAssertNotEqual(reads.first, "movie.mov", "A renamed movie is checked at its final path")
                XCTAssertTrue(reads.first?.hasSuffix(".mov") == true)
            }
        }
    }
    func testMetadataChangedAfterEncodingCannotPublishOrDeleteSources() throws {
        let writer = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        let original = try append(writer, 0)
        let image = root.appendingPathComponent(try XCTUnwrap(original.imageFile))
        let bundle = image.deletingLastPathComponent(), metadata = bundle.appendingPathComponent("observation.lsm")
        let originalBytes = try Data(contentsOf: metadata)
        var reached = false
        XCTAssertThrowsError(try VideoCompaction.compact(store: writer, flush: true, interrupt: { stage in
            guard stage == .prepared else { return }
            reached = true
            var changed = original
            changed.reason = "synthetic concurrent metadata change"
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .millisecondsSince1970
            try self.keep(MetadataCodec.encode(encoder.encode(changed)), at: metadata)
        })) { XCTAssertEqual($0 as? VideoArchiveError, .invalidReference) }
        XCTAssertTrue(reached)
        XCTAssertTrue(FileManager.default.fileExists(atPath: image.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: bundle.appendingPathComponent("image.archive").path))
        try originalBytes.write(to: metadata)
        XCTAssertEqual(try VideoCompaction.compact(store: writer, flush: true).pendingImageCount, 0)
        try verify(writer, original, value: 40)
    }
    func testAnArchivedHandleRejectsARemovedOrChangedSidecar() throws {
        enum Stop: Error { case now }
        let writer = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        let original = try append(writer, 0)
        XCTAssertThrowsError(try VideoCompaction.compact(store: writer, flush: true,
            interrupt: { if $0 == .referencesPublished { throw Stop.now } }))
        let admitted = try XCTUnwrap(writer.admit([XCTUnwrap(original.imageFile)]).first)
        XCTAssertNotNil(admitted.observation.imageEncoding)
        _ = try writer.readImage(for: admitted.observation)
        let image = root.appendingPathComponent(try XCTUnwrap(original.imageFile))
        let sidecar = image.deletingLastPathComponent().appendingPathComponent("image.archive")
        let originalBytes = try kept(sidecar)
        try FileManager.default.removeItem(at: sidecar)
        XCTAssertThrowsError(try writer.readImage(for: admitted.observation)) { error in
            guard case CaptureStoreError.corruptBundle("observation-mismatch") = error else {
                return XCTFail("An archived handle cannot fall back to the last standalone image and delete it")
            }
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: image.path))
        var document = try XCTUnwrap(JSONSerialization.jsonObject(with: originalBytes) as? [String: Any])
        var reference = try XCTUnwrap(document["reference"] as? [String: Any])
        var encoding = try XCTUnwrap(reference["encoding"] as? [String: Any])
        encoding["quality"] = 0.5
        reference["encoding"] = encoding
        document["reference"] = reference
        try keep(JSONSerialization.data(withJSONObject: document), at: sidecar)
        XCTAssertThrowsError(try writer.readImage(for: admitted.observation)) { error in
            guard case CaptureStoreError.corruptBundle("observation-mismatch") = error else {
                return XCTFail("A legal replacement encoding must still match the archived handle")
            }
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: image.path))
        try keep(originalBytes, at: sidecar)
        _ = try writer.readImage(for: admitted.observation)
    }
    func testRecoveryChecksEachEntryAgainstItsMetadataOnce() throws {
        enum Stop: Error { case now }
        var decodes = 0
        let decoder = { (data: Data) throws -> CaptureObservation in
            decodes += 1
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .millisecondsSince1970
            return try decoder.decode(CaptureObservation.self, from: data)
        }
        let original: CaptureObservation
        do {
            let writer = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1, observationDecoder: decoder)
            original = try append(writer, 0)
            XCTAssertThrowsError(try VideoCompaction.compact(store: writer, flush: true,
                interrupt: { if $0 == .prepared { throw Stop.now } }))
        }
        let writer = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1, observationDecoder: decoder)
        let startup = decodes
        let report = try VideoCompaction.compact(store: writer, flush: true)
        XCTAssertEqual(report.imageCount, 1)
        XCTAssertEqual(report.pendingImageCount, 0)
        XCTAssertEqual(decodes, startup + 1, "Recovery decodes each entry's metadata once, as a reader would")
        try verify(writer, original, value: 40)
    }
    func testChangedMovieWithRestoredSizeAndModificationTimeCannotDeleteSource() throws {
        let writer = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        let original = try append(writer, 0)
        var modified = false
        XCTAssertThrowsError(try VideoCompaction.compact(store: writer, flush: true, interrupt: { stage in
            guard stage == .prepared else { return }
            let directory = self.root.appendingPathComponent(".video")
            let entries = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            let staging = try XCTUnwrap(entries.first { $0.lastPathComponent.hasPrefix(".pending-") })
            let movie = staging.appendingPathComponent("movie.mov")
            let stamp = Date(timeIntervalSince1970: 1_700_000_000)
            try FileManager.default.setAttributes([.modificationDate: stamp], ofItemAtPath: movie.path)
            let attributes = try FileManager.default.attributesOfItem(atPath: movie.path)
            let originalDate = try XCTUnwrap(attributes[.modificationDate] as? Date)
            var bytes = try self.kept(movie)
            bytes[bytes.count / 2] ^= 1
            try self.keep(bytes, at: movie)
            try FileManager.default.setAttributes([.modificationDate: originalDate], ofItemAtPath: movie.path)
            let changedAttributes = try FileManager.default.attributesOfItem(atPath: movie.path)
            XCTAssertEqual(changedAttributes[.size] as? NSNumber, attributes[.size] as? NSNumber)
            XCTAssertEqual(changedAttributes[.modificationDate] as? Date, originalDate)
            modified = true
        })) { error in XCTAssertEqual(error as? VideoArchiveError, .corruptSegment) }
        XCTAssertTrue(modified)
        let image = root.appendingPathComponent(try XCTUnwrap(original.imageFile))
        XCTAssertTrue(FileManager.default.fileExists(atPath: image.path))
        XCTAssertFalse(exists(image.deletingLastPathComponent().appendingPathComponent("image.archive")))
        try verify(writer, original, value: 40)
    }
    func testACorruptRecoveredMovieIsSetAsideAndAPublishedOneStays() throws {
        enum Stop: Error { case now }
        for (index, interruption) in [VideoCompaction.Stage.prepared, .moviePublished].enumerated() {
            let directory = root.appendingPathComponent("corrupt-recovery-\(index)")
            var original: CaptureObservation!
            do {
                let writer = try CaptureStore(directory: directory, files: files, scratch: scratch, videoQuality: 1)
                original = try append(writer, 0)
                XCTAssertThrowsError(try VideoCompaction.compact(store: writer, flush: true,
                    interrupt: { if $0 == interruption { throw Stop.now } }))
            }
            let movies = directory.appendingPathComponent(".video")
            let entries = try FileManager.default.contentsOfDirectory(at: movies, includingPropertiesForKeys: nil)
            let movie: URL
            if interruption == .prepared {
                let staging = try XCTUnwrap(entries.first { $0.lastPathComponent.hasPrefix(".pending-") })
                movie = staging.appendingPathComponent("movie.mov")
            } else { movie = try XCTUnwrap(entries.first { $0.pathExtension == "mov" }) }
            try Data([0]).write(to: movie)
            let writer = try CaptureStore(directory: directory, files: files, scratch: scratch, videoQuality: 1)
            XCTAssertEqual(try VideoCompaction.compact(store: writer, flush: true).pendingImageCount, 0)
            let image = directory.appendingPathComponent(try XCTUnwrap(original.imageFile))
            XCTAssertTrue(FileManager.default.fileExists(atPath: image.path))
            XCTAssertFalse(exists(image.deletingLastPathComponent().appendingPathComponent("image.archive")))
            XCTAssertFalse(try hasPreparation(in: movies))
            let kept = try FileManager.default.contentsOfDirectory(atPath: movies.path).filter { $0.hasPrefix(".damaged-") }
            XCTAssertEqual(kept.count, 1)
            if interruption == .moviePublished {
                XCTAssertTrue(exists(movie), "a movie already renamed into place stays")
            }
        }
    }
    func testPartialSegmentWaitsAndExplicitFlushPublishes() async throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        let saved = try append(store, 0, date: Date())
        let early = try await store.compactPendingVideo()
        XCTAssertEqual(early.imageCount, 0)
        XCTAssertEqual(early.pendingImageCount, 1)
        XCTAssertNil(try store.read().first?.imageEncoding)
        let final = try await store.compactPendingVideo(flush: true)
        XCTAssertEqual(final.imageCount, 1)
        try verify(store, saved, value: 40)
    }


    private func damagedFolders(in directory: URL) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: directory.appendingPathComponent(".video").path)
            .filter { $0.hasPrefix(".damaged-") }
    }

    func testAJournalThatCanNeverFinishIsSetAsideWithItsOpenSegment() throws {
        enum Stop: Error { case now }
        for damage in ["bundle-gone", "metadata-gone", "movie-gone", "metadata-changed"] {
            let directory = root.appendingPathComponent(damage)
            let store = try CaptureStore(directory: directory, files: files, scratch: scratch, videoQuality: 1)
            let first = try store.append(observation: observation(0), image: .raw(frame(40)))
            let second = try store.append(observation: observation(2), image: .raw(frame(60)))
            XCTAssertThrowsError(try VideoCompaction.compact(store: store, flush: true,
                interrupt: { if $0 == .prepared { throw Stop.now } }))
            let video = directory.appendingPathComponent(".video")
            let staging = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: video, includingPropertiesForKeys: nil)
                .first { $0.lastPathComponent.hasPrefix(".pending-") })
            let id = String(staging.lastPathComponent.dropFirst(".pending-".count))
            let bundle = directory.appendingPathComponent(first.imageFile!).deletingLastPathComponent()
            switch damage {
            case "bundle-gone":
                try FileManager.default.removeItem(at: bundle)
            case "metadata-gone":
                try FileManager.default.removeItem(at: bundle.appendingPathComponent("observation.lsm"))
            case "movie-gone":
                try FileManager.default.removeItem(at: staging.appendingPathComponent("movie.mov"))
            default:
                var changed = first
                changed.reason = "synthetic metadata change"
                try keep(MetadataCodec.encode(SpoolJSON.encode(changed)), at: bundle.appendingPathComponent("observation.lsm"))
            }
            let secondBundle = directory.appendingPathComponent(second.imageFile!).deletingLastPathComponent()
            let untouched = try FileManager.default.contentsOfDirectory(atPath: secondBundle.path).sorted()
            let next = try store.append(observation: observation(4, date: Date(timeIntervalSince1970: 1_700_000_100)),
                                        image: .raw(frame(80)))

            var archived = 0
            while case let count = try VideoCompaction.compact(store: store, flush: true).imageCount, count > 0 {
                archived += count
            }
            XCTAssertEqual(archived, 1, "the next segment compacts: \(damage)")
            XCTAssertEqual(store.pendingVideoReport().pendingImageCount, 0, damage)
            XCTAssertNotNil(try store.read(since: next.capturedAt).first?.imageEncoding, damage)
            XCTAssertEqual(try damagedFolders(in: directory), [".damaged-" + id], damage)
            let damaged = video.appendingPathComponent(".damaged-" + id)
            XCTAssertTrue(exists(damaged.appendingPathComponent("pending/journal.json")), damage)
            XCTAssertTrue(exists(damaged.appendingPathComponent("open/samples")), damage)
            XCTAssertFalse(exists(video.appendingPathComponent(".open-" + id)), damage)
            XCTAssertFalse(try hasPreparation(in: video), damage)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: secondBundle.path).sorted(), untouched,
                           "a frame of the set-aside segment keeps what it had: \(damage)")
            XCTAssertEqual(untouched, ["image.open", "observation.lsm"])
        }
    }

    func testAMoviePublishedBeforeTheJournalFailedStays() throws {
        enum Stop: Error { case now }
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        let original = try append(store, 0)
        XCTAssertThrowsError(try VideoCompaction.compact(store: store, flush: true,
            interrupt: { if $0 == .moviePublished { throw Stop.now } }))
        let video = root.appendingPathComponent(".video")
        let movie = try XCTUnwrap(FileManager.default.contentsOfDirectory(atPath: video.path).first { $0.hasSuffix(".mov") })
        let bundle = root.appendingPathComponent(original.imageFile!).deletingLastPathComponent()
        try FileManager.default.removeItem(at: bundle.appendingPathComponent("observation.lsm"))
        XCTAssertEqual(try VideoCompaction.compact(store: store, flush: true).pendingImageCount, 0)
        XCTAssertTrue(exists(video.appendingPathComponent(movie)))
        XCTAssertEqual(try damagedFolders(in: root).count, 1)
        XCTAssertFalse(try hasPreparation(in: video))
    }

    func testAMovieReadThatFailsKeepsTheJournalForRetry() throws {
        enum Stop: Error { case now }
        let failures: [Error] = [VideoArchiveError.timeout(.loadTracks), DeviceFileError.io(operation: "read movie.mov", code: EIO)]
        for (index, failure) in failures.enumerated() {
            let directory = root.appendingPathComponent("read-\(index)")
            let store = try CaptureStore(directory: directory, files: files, scratch: scratch, videoQuality: 1)
            let original = try store.append(observation: observation(0), image: .raw(frame(40)))
            XCTAssertThrowsError(try VideoCompaction.compact(store: store, flush: true,
                interrupt: { if $0 == .prepared { throw Stop.now } }))
            let video = directory.appendingPathComponent(".video")
            XCTAssertThrowsError(try VideoCompaction.compact(store: store, flush: true, readMovie: { _ in throw failure }))
            XCTAssertTrue(try hasPreparation(in: video), "\(failure)")
            XCTAssertEqual(try damagedFolders(in: directory), [], "\(failure)")
            XCTAssertEqual(try VideoCompaction.compact(store: store, flush: true).pendingImageCount, 0)
            XCTAssertFalse(try hasPreparation(in: video))
            XCTAssertNotNil(try store.read().first?.imageEncoding)
            try verify(store, original, value: 40)
        }
    }

    func testAnOpenSegmentWithNoSamplesIsFoundEmptyAndRemoved() throws {
        let store = try CaptureStore(directory: root, files: files, scratch: scratch, videoQuality: 1)
        _ = try append(store, 0)
        let video = root.appendingPathComponent(".video")
        let folder = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: video, includingPropertiesForKeys: nil)
            .first { $0.lastPathComponent.hasPrefix(".open-") })
        let samples = folder.appendingPathComponent("samples")
        try FileManager.default.removeItem(at: samples)
        try files.log(samples).close()
        XCTAssertEqual(try files.size(of: samples), 0)
        XCTAssertEqual(try VideoCompaction.compact(store: store, flush: true).imageCount, 0)
        XCTAssertFalse(exists(folder))
        XCTAssertFalse(try hasPreparation(in: video))
    }
}

final class VideoCompactionKeyedTests: VideoCompactionTests {
    override class var keyed: Bool { true }
}

final class Settles: @unchecked Sendable {
    private let lock = NSLock()
    private var held = 0

    func add() { lock.withLock { held += 1 } }

    var count: Int { lock.withLock { held } }
}
