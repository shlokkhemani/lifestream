import Evidence
import Foundation
import AVFoundation
import CoreGraphics

extension CaptureStore {
    struct DisplaySize: Hashable {
        let displayID: UInt32
        let width: Int
        let height: Int

        init(_ observation: CaptureObservation) {
            displayID = observation.displayID
            width = observation.width
            height = observation.height
        }
    }

    final class OpenSegment {
        let id = UUID().uuidString.lowercased()
        let size: DisplaySize
        let firstCapturedAt: Date
        let encoder: SegmentEncoder
        var format: CMFormatDescription?
        var records = 0

        init(size: DisplaySize, encoder: SegmentEncoder, firstCapturedAt: Date) {
            self.size = size
            self.encoder = encoder
            self.firstCapturedAt = firstCapturedAt
        }
    }

    struct EncodedFrame {
        let segment: OpenSegment
        let sample: CMSampleBuffer
        let imagePath: String
    }

    func encode(_ image: CGImage, for observation: CaptureObservation, at imagePath: String) throws -> EncodedFrame {
        guard let quality = videoQuality else {
            throw CaptureStoreError.readOnly
        }
        let size = DisplaySize(observation)
        let day = SpoolLayout.dayName(for: observation.capturedAt)
        if let open = openSegments[size], SpoolLayout.dayName(for: open.firstCapturedAt) != day {
            seal(open)
        }
        for _ in 0..<2 {
            let segment: OpenSegment
            if let open = openSegments[size] {
                segment = open
            } else {
                let encoding = CaptureVideoProvenance(width: size.width, height: size.height, quality: quality)
                guard let encoder = try? makeEncoder(encoding) else {
                    break
                }
                segment = OpenSegment(size: size, encoder: encoder, firstCapturedAt: observation.capturedAt)
                openSegments[size] = segment
            }
            let pixels: CVPixelBuffer
            do {
                pixels = try segment.encoder.convert(image)
            } catch VideoArchiveError.invalidInput {
                throw CaptureStoreError.invalidObservation
            } catch {
                seal(segment)
                continue
            }
            do {
                let sample = try segment.encoder.encode(pixels)
                if let format = segment.format, let described = CMSampleBufferGetFormatDescription(sample),
                   !CMFormatDescriptionEqual(format, otherFormatDescription: described) {
                    throw VideoArchiveError.corruptSegment
                }
                return EncodedFrame(segment: segment, sample: sample, imagePath: imagePath)
            } catch {
                seal(segment)
            }
        }
        throw CaptureStoreError.videoEncoderUnavailable
    }

    func log(_ frame: EncodedFrame) throws -> OpenImage {
        let segment = frame.segment
        let folder = directory.appendingPathComponent(SpoolLayout.openSegmentPath(id: segment.id), isDirectory: true)
        let record = try OpenSegmentLog.record(of: frame.sample, ordinal: segment.records, imagePath: frame.imagePath)
        if segment.format == nil {
            guard let description = CMSampleBufferGetFormatDescription(frame.sample) else {
                throw VideoArchiveError.corruptSegment
            }
            let format = try OpenSegmentLog.format(of: description, displayID: segment.size.displayID,
                                                   encoding: segment.encoder.encoding)
            try FileManager.default.createDirectory(
                at: folder.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            if Darwin.mkdir(folder.path, 0o700) != 0 {
                throw CaptureStoreError.io("create open segment", errno)
            }
            segment.format = description
            try files.writeNew(folder.appendingPathComponent(SpoolLayout.openFormat), SpoolJSON.encode(format), flush: .data)
        }
        let samples = try files.log(folder.appendingPathComponent(SpoolLayout.openSamples))
        defer { samples.close() }
        try samples.append(OpenSegmentLog.encode(record), flush: .data)
        segment.records += 1
        return OpenImage(segment: segment.id, ordinal: record.ordinal)
    }

    func seal(_ segment: OpenSegment) {
        if openSegments[segment.size] === segment {
            openSegments[segment.size] = nil
        }
        if segment.format != nil, !sealedSegments.contains(segment.id) {
            sealedSegments.append(segment.id)
        }
    }

    func sealSegments(flush: Bool, now: Date) {
        mutex.lock()
        defer { mutex.unlock() }
        for segment in openSegments.values
        where flush || now.timeIntervalSince(segment.firstCapturedAt) >= VideoCompaction.maximumWait {
            seal(segment)
        }
    }

    func nextSealedSegment() -> String? {
        mutex.lock()
        defer { mutex.unlock() }
        return sealedSegments.first
    }

    func didCloseSegment(_ id: String) {
        mutex.lock()
        defer { mutex.unlock() }
        sealedSegments.removeAll { $0 == id }
    }

    enum SetAside: String {
        case format, journal
    }

    func setAside(_ id: String, why: SetAside, preparation: URL? = nil) throws {
        let video = directory.appendingPathComponent(SpoolLayout.videoDirectory, isDirectory: true)
        let damaged = directory.appendingPathComponent(SpoolLayout.damagedPath(id: id), isDirectory: true)
        if Darwin.mkdir(damaged.path, 0o700) != 0 && errno != EEXIST {
            throw CaptureStoreError.io("create damaged folder", errno)
        }
        let open = video.appendingPathComponent(SpoolLayout.openSegmentPrefix + id, isDirectory: true)
        if try SpoolFiles.exists(open) {
            try Self.keep(open, in: damaged, as: SpoolLayout.damagedOpen)
        }
        if let preparation {
            try Self.keep(preparation, in: damaged, as: SpoolLayout.damagedPending)
        }
        mutex.lock()
        let named = pendingImages.filter { $0.value.segment == id }.map(\.key)
        for path in named {
            pendingImages.removeValue(forKey: path)
        }
        skippedImages.subtract(named)
        sealedSegments.removeAll { $0 == id }
        mutex.unlock()
        FailureLines.shared.note(.segmentSetAside, kind: why.rawValue)
        segmentSettled?()
    }

    private static func keep(_ source: URL, in folder: URL, as name: String) throws {
        var target = folder.appendingPathComponent(name)
        while renamex_np(source.path, target.path, UInt32(RENAME_EXCL)) != 0 {
            guard errno == EEXIST else {
                throw CaptureStoreError.io("set aside damaged segment", errno)
            }
            target = folder.appendingPathComponent(name + "-" + UUID().uuidString.lowercased())
        }
    }

    func pendingImages(naming id: String) -> [String] {
        mutex.lock()
        defer { mutex.unlock() }
        return pendingImages.filter { $0.value.segment == id }.map(\.key).sorted()
    }

    func discoverOpenSegments() throws {
        let video = directory.appendingPathComponent(SpoolLayout.videoDirectory, isDirectory: true)
        guard try SpoolFiles.exists(video) else {
            return
        }
        sealedSegments = try SpoolFiles.children(of: video)
            .compactMap { SpoolLayout.openSegmentID($0.lastPathComponent) }
            .sorted()
        for id in sealedSegments {
            for record in (try? openSegment(id))?.records ?? [] {
                guard let bundle = try? publishedBundle(of: record.imagePath),
                      (try? openImage(in: bundle)) == OpenImage(segment: id, ordinal: record.ordinal) else {
                    continue
                }
                pendingImages[record.imagePath] = PendingEntry(bytes: record.sample.count, segment: id)
            }
        }
    }

    func publishedBundle(of imagePath: String) throws -> URL? {
        guard let image = SpoolLayout.ImagePath.parse(imagePath) else {
            return nil
        }
        let bundle = directory
            .appendingPathComponent(image.day, isDirectory: true)
            .appendingPathComponent(image.bundle, isDirectory: true)
        return try SpoolFiles.exists(bundle) && SpoolFiles.isRealDirectory(bundle) ? bundle : nil
    }

    func openImage(in bundle: URL) throws -> OpenImage {
        let url = bundle.appendingPathComponent(SpoolLayout.ImageFile.open.rawValue)
        let opened = try SpoolJSON.decode(OpenImage.self, from: readFile(url, OpenImage.maximumBytes))
        guard SpoolLayout.openSegmentID(SpoolLayout.openSegmentPrefix + opened.segment) != nil,
              (0..<SegmentReference.maximumFrameCount).contains(opened.ordinal) else {
            throw CaptureStoreError.corruptBundle("image-open")
        }
        return opened
    }

    func openSegment(_ id: String) throws -> (format: OpenSegmentLog.Format, records: [OpenSegmentLog.Record]) {
        let folder = directory.appendingPathComponent(SpoolLayout.openSegmentPath(id: id), isDirectory: true)
        guard try SpoolFiles.isRealDirectory(folder) else {
            throw CaptureStoreError.corruptBundle("open-segment")
        }
        let format = try SpoolJSON.decode(OpenSegmentLog.Format.self, from: readFile(
            folder.appendingPathComponent(SpoolLayout.openFormat), OpenSegmentLog.maximumFormatBytes))
        let samples = folder.appendingPathComponent(SpoolLayout.openSamples)
        guard try SpoolFiles.exists(samples) else {
            return (format, [])
        }
        let log = try readFile(samples, OpenSegmentLog.maximumLogBytes)
        return (format, OpenSegmentLog.records(in: log))
    }

    func readOpenFrame(of observation: CaptureObservation, in bundle: URL) throws -> RawFrame {
        let opened = try openImage(in: bundle)
        let (format, records) = try openSegment(opened.segment)
        guard records.indices.contains(opened.ordinal),
              records[opened.ordinal].imagePath == observation.imageFile,
              format.encoding.originalWidth == observation.width,
              format.encoding.originalHeight == observation.height else {
            throw CaptureStoreError.corruptBundle("image-open")
        }
        let description = try OpenSegmentLog.formatDescription(format)
        let samples = try records[...opened.ordinal].map { try OpenSegmentLog.sampleBuffer($0, format: description) }
        return try SegmentCodec.decode(samples: samples, format: description, ordinal: opened.ordinal,
                                       encoding: format.encoding)
    }
}
