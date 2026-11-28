import Evidence
import DeviceFiles
import Foundation
import CryptoKit
import Darwin

enum VideoCompaction {
    struct Journal: Codable {
        let entries: [ArchiveSidecar]
    }

    struct Preparation {
        let staging: URL
        let journal: Journal
    }

    enum Stage: CaseIterable {
        case movieWritten
        case prepared
        case moviePublished
        case referencesWritten
        case referencesPublished
        case sourcesRemoved
    }

    static let maximumWait: TimeInterval = 60

    static func compact(
        store: CaptureStore,
        flush: Bool,
        discover: (URL) throws -> [URL] = {
            try FileManager.default.contentsOfDirectory(at: $0, includingPropertiesForKeys: nil)
        },
        readMovie: ((URL) throws -> Data)? = nil,
        interrupt: ((Stage) throws -> Void)? = nil
    ) throws -> VideoCompactionReport {
        guard store.videoQuality != nil else {
            throw CaptureStoreError.readOnly
        }
        let readMovie = readMovie ?? { try SpoolFiles.read(store.files, $0, maximumBytes: SegmentCodec.maximumSegmentBytes) }
        try Task.checkCancellation()
        let videoDirectory = try openVideoDirectory(of: store)
        if store.compactionNeedsRecovery {
            let recovered = try recoverOnePreparation(
                in: videoDirectory,
                store: store,
                discover: discover,
                readMovie: readMovie,
                interrupt: interrupt
            )
            if let recovered {
                store.segmentSettled?()
                return recovered
            }
            try Task.checkCancellation()
            store.compactionNeedsRecovery = false
        }
        store.sealSegments(flush: flush, now: Date())
        while let id = store.nextSealedSegment() {
            try Task.checkCancellation()
            let prepared = try prepareOpenSegment(
                id,
                in: videoDirectory,
                store: store,
                readMovie: readMovie,
                interrupt: interrupt
            )
            guard let prepared else {
                continue
            }
            try interrupt?(.prepared)
            try publish(prepared.journal, staging: prepared.staging, store: store, readMovie: readMovie,
                        interrupt: interrupt)
            store.didCloseSegment(id)
            store.compactionNeedsRecovery = false
            store.segmentSettled?()
            return store.pendingVideoReport(images: prepared.journal.entries.count)
        }
        return store.pendingVideoReport()
    }

    private static func openVideoDirectory(of store: CaptureStore) throws -> URL {
        let directory = store.directory.appendingPathComponent(SpoolLayout.videoDirectory, isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        guard try SpoolFiles.isRealDirectory(directory) else {
            throw VideoArchiveError.invalidReference
        }
        return directory
    }

    static func isTerminal(_ error: Error) -> Bool {
        switch error {
        case VideoArchiveError.invalidReference, VideoArchiveError.corruptSegment,
             DeviceFileError.invalidSizeOrType, DeviceFileError.unreadable,
             DeviceFileError.truncated, CaptureStoreError.corruptBundle:
            return true
        case is DecodingError, is MetadataCodecError:
            return true
        default:
            return SpoolFiles.isAbsence(error)
        }
    }

    private static func recoverOnePreparation(
        in videoDirectory: URL,
        store: CaptureStore,
        discover: (URL) throws -> [URL],
        readMovie: (URL) throws -> Data,
        interrupt: ((Stage) throws -> Void)?
    ) throws -> VideoCompactionReport? {
        let preparations = try discover(videoDirectory)
            .filter { $0.lastPathComponent.hasPrefix(SpoolLayout.stagingPrefix) }
            .sorted { $0.path < $1.path }
        for staging in preparations {
            guard try SpoolFiles.isRealDirectory(staging) else {
                throw VideoArchiveError.invalidReference
            }
            let journalURL = staging.appendingPathComponent(SpoolLayout.journal)
            guard try SpoolFiles.exists(journalURL) else {
                try FileManager.default.removeItem(at: staging)
                continue
            }
            do {
                let bytes = try SpoolFiles.read(store.files, journalURL, maximumBytes: SpoolLayout.maximumJournalBytes)
                let journal = try SpoolJSON.decode(Journal.self, from: bytes)
                try publish(journal, staging: staging, store: store, readMovie: readMovie, interrupt: interrupt)
                return store.pendingVideoReport(images: journal.entries.count)
            } catch where isTerminal(error) {
                let id = String(staging.lastPathComponent.dropFirst(SpoolLayout.stagingPrefix.count))
                try store.setAside(id, why: .journal, preparation: staging)
            }
        }
        return nil
    }

    static func journal(
        _ frames: [(ordinal: Int, frame: CaptureStore.CompactionFrame)],
        frameCount: Int,
        id: String,
        made: URL,
        staging: URL,
        files: DeviceFiles,
        encoding: CaptureVideoProvenance,
        readMovie: (URL) throws -> Data
    ) throws -> Preparation {
        let movie = staging.appendingPathComponent(SpoolLayout.preparedMovie)
        do {
            try SegmentCodec.validate(url: made, encoding: encoding, frameCount: frameCount)
            try files.place(made, at: movie, flush: .data)
        } catch {
            try? FileManager.default.removeItem(at: made)
            throw error
        }
        let checksum = Data(SHA256.hash(data: try readMovie(movie)))
        let entries = try frames.map { ordinal, frame -> ArchiveSidecar in
            guard let path = frame.observation.imageFile else {
                throw VideoArchiveError.invalidReference
            }
            let reference = SegmentReference(
                version: 1,
                segment: SpoolLayout.segmentPath(id: id),
                segmentSHA256: checksum,
                ordinal: ordinal,
                frameCount: frameCount,
                capturedAt: frame.observation.capturedAt,
                encoding: encoding
            )
            try reference.validate()
            return ArchiveSidecar(imagePath: path, metadataSHA256: frame.metadataSHA256, reference: reference)
        }
        let journal = Journal(entries: entries)
        try writeJournal(journal, in: staging, files: files)
        return Preparation(staging: staging, journal: journal)
    }

    private static func writeJournal(_ journal: Journal, in staging: URL, files: DeviceFiles) throws {
        let temporary = staging.appendingPathComponent(SpoolLayout.journalStaging)
        try files.writeNew(temporary, SpoolJSON.encode(journal), flush: .barrier)
        let final = staging.appendingPathComponent(SpoolLayout.journal)
        guard rename(temporary.path, final.path) == 0 else {
            throw CaptureStoreError.io("publish archive journal", errno)
        }
        try DeviceFiles.syncDirectory(staging, flush: .full)
    }

    static func publish(
        _ journal: Journal,
        staging: URL,
        store: CaptureStore,
        readMovie: (URL) throws -> Data,
        interrupt: ((Stage) throws -> Void)?
    ) throws {
        let segment = try verifyJournal(journal, store: store)

        try publishMovie(segment, from: staging, store: store, readMovie: readMovie)
        try interrupt?(.moviePublished)

        let sidecars = try journal.entries.compactMap { try unpublishedSidecar($0, store: store) }
        for (index, sidecar) in sidecars.enumerated() {
            if try SpoolFiles.exists(sidecar.temporary) {
                try FileManager.default.removeItem(at: sidecar.temporary)
            }
            let flush: DeviceFiles.Flush = index == sidecars.count - 1 ? .barrier : .data
            try store.files.writeNew(sidecar.temporary, sidecar.bytes, flush: flush)
        }
        try interrupt?(.referencesWritten)
        for sidecar in sidecars {
            guard renamex_np(sidecar.temporary.path, sidecar.final.path, UInt32(RENAME_EXCL)) == 0 else {
                throw CaptureStoreError.io("publish archive reference", errno)
            }
        }
        try DeviceFiles.syncDirectory(store.directory, flush: .full)
        try interrupt?(.referencesPublished)
        let paths = journal.entries.map(\.imagePath)
        for path in paths {
            try removePendingImage(at: path, store: store)
        }
        try interrupt?(.sourcesRemoved)
        store.didCompactVideo(paths)

        let id = String(staging.lastPathComponent.dropFirst(SpoolLayout.stagingPrefix.count))
        let open = store.directory.appendingPathComponent(SpoolLayout.openSegmentPath(id: id), isDirectory: true)
        if try SpoolFiles.exists(open) {
            try FileManager.default.removeItem(at: open)
        }
        try FileManager.default.removeItem(at: staging)
    }

    private static func verifyJournal(_ journal: Journal, store: CaptureStore) throws -> SegmentReference {
        guard (1...SegmentReference.maximumFrameCount).contains(journal.entries.count),
              let first = journal.entries.first,
              Set(journal.entries.map(\.imagePath)).count == journal.entries.count else {
            throw VideoArchiveError.invalidReference
        }
        var previous = -1
        for entry in journal.entries {
            try entry.reference.validate()
            try store.validateArchiveEntry(entry)
            guard entry.reference.segment == first.reference.segment,
                  entry.reference.segmentSHA256 == first.reference.segmentSHA256,
                  entry.reference.encoding == first.reference.encoding,
                  entry.reference.frameCount == first.reference.frameCount,
                  entry.reference.ordinal > previous else {
                throw VideoArchiveError.invalidReference
            }
            previous = entry.reference.ordinal
        }
        return first.reference
    }

    private static func publishMovie(
        _ segment: SegmentReference,
        from staging: URL,
        store: CaptureStore,
        readMovie: (URL) throws -> Data
    ) throws {
        let final = store.directory.appendingPathComponent(segment.segment)
        let temporary = staging.appendingPathComponent(SpoolLayout.preparedMovie)
        let renamed = try SpoolFiles.exists(final)
        guard try renamed || SpoolFiles.exists(temporary) else {
            throw VideoArchiveError.corruptSegment
        }
        guard Data(SHA256.hash(data: try readMovie(renamed ? final : temporary))) == segment.segmentSHA256 else {
            throw VideoArchiveError.corruptSegment
        }
        if !renamed {
            guard renamex_np(temporary.path, final.path, UInt32(RENAME_EXCL)) == 0 else {
                throw CaptureStoreError.io("publish archive movie", errno)
            }
        }
    }

    private struct Sidecar {
        let bytes: Data
        let temporary: URL
        let final: URL
    }

    private static func unpublishedSidecar(_ entry: ArchiveSidecar, store: CaptureStore) throws -> Sidecar? {
        let bundle = try store.safeImageURL(entry.imagePath).deletingLastPathComponent()
        let final = bundle.appendingPathComponent(SpoolLayout.archiveSidecar)
        let bytes = try SpoolJSON.encode(entry)
        guard try !SpoolFiles.exists(final) else {
            guard try SpoolFiles.read(store.files, final, maximumBytes: SpoolLayout.maximumSidecarBytes) == bytes else {
                throw VideoArchiveError.invalidReference
            }
            return nil
        }
        return Sidecar(bytes: bytes, temporary: bundle.appendingPathComponent(SpoolLayout.archiveSidecarStaging), final: final)
    }

    private static func removePendingImage(at path: String, store: CaptureStore) throws {
        let source = try store.safeImageURL(path)
        if unlink(source.path) != 0 && errno != ENOENT {
            throw CaptureStoreError.io("remove archived pending image", errno)
        }
    }
}
