import Evidence
import DeviceFiles
import Foundation
import CoreGraphics
import CoreMedia
import Darwin

public final class CaptureStore: @unchecked Sendable {
    public let directory: URL
    let files: DeviceFiles
    let scratch: URL
    let videoQuality: Double?
    private let readOnly: Bool
    let observationDecoder: (Data) throws -> CaptureObservation
    private let fits: (@Sendable () -> Bool)?
    let segmentSettled: (@Sendable () -> Void)?
    private var writerLock: Int32 = -1

    let mutex = NSLock()
    let readMutex = NSLock()

    var pendingImages: [String: PendingEntry] = [:]
    var skippedImages: Set<String> = []
    var openSegments: [DisplaySize: OpenSegment] = [:]
    var sealedSegments: [String] = []
    let makeEncoder: (CaptureVideoProvenance) throws -> SegmentEncoder
    let appendInterrupt: (() throws -> Void)?
    let readFile: (URL, Int) throws -> Data
    let flushDay: (URL) throws -> Void
    public private(set) var newestObservation: NewestObservation?
    public private(set) var newestUnreadable = false
    var recoveryRequired = true
    var textRecoveryRequired = true
    var textWindowCursor: Int?

    public convenience init(directory: URL, files: DeviceFiles, scratch: URL,
                            readOnly: Bool = false, videoQuality: Double = 0.65,
                            fits: (@Sendable () -> Bool)? = nil,
                            onSegmentSettled: (@Sendable () -> Void)? = nil) throws {
        try self.init(
            directory: directory,
            files: files,
            scratch: scratch,
            readOnly: readOnly,
            videoQuality: videoQuality,
            observationDecoder: Self.decodeObservation,
            fits: fits,
            makeEncoder: SegmentEncoder.init,
            appendInterrupt: nil,
            onSegmentSettled: onSegmentSettled
        )
    }

    init(
        directory: URL,
        files: DeviceFiles,
        scratch: URL,
        readOnly: Bool = false,
        videoQuality: Double = 0.65,
        observationDecoder: @escaping (Data) throws -> CaptureObservation,
        fits: (@Sendable () -> Bool)? = nil,
        makeEncoder: @escaping (CaptureVideoProvenance) throws -> SegmentEncoder = SegmentEncoder.init,
        appendInterrupt: (() throws -> Void)? = nil,
        readFile: ((URL, Int) throws -> Data)? = nil,
        flushDay: @escaping (URL) throws -> Void = { try DeviceFiles.syncDirectory($0, flush: .full) },
        onSegmentSettled: (@Sendable () -> Void)? = nil
    ) throws {
        self.files = files
        self.scratch = scratch
        self.observationDecoder = observationDecoder
        self.flushDay = flushDay
        self.fits = fits
        segmentSettled = onSegmentSettled
        self.makeEncoder = makeEncoder
        self.appendInterrupt = appendInterrupt
        self.readFile = readFile ?? { try SpoolFiles.read(files, $0, maximumBytes: $1) }
        guard videoQuality.isFinite, (0...1).contains(videoQuality) else {
            throw CaptureStoreError.invalidObservation
        }
        self.directory = directory.standardizedFileURL
        self.readOnly = readOnly
        self.videoQuality = readOnly ? nil : videoQuality
        if !readOnly {
            try FileManager.default.createDirectory(
                at: self.directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        }
        guard try SpoolFiles.isRealDirectory(self.directory) else {
            throw CaptureStoreError.io("open directory", EINVAL)
        }
        guard !readOnly else {
            return
        }
        writerLock = try Self.lockWriter(in: self.directory)
        do {
            try Self.openTextDirectory(in: self.directory)
            try removeDeadStaging()
            try discoverOpenSegments()
            do {
                newestObservation = try readNewestObservation()
            } catch {
                newestUnreadable = true
            }
        } catch {
            Self.unlockWriter(writerLock)
            writerLock = -1
            throw error
        }
    }

    deinit {
        if writerLock >= 0 {
            Self.unlockWriter(writerLock)
        }
    }

    @discardableResult
    public func append(observation: CaptureObservation, image: CaptureImage?, bundle: String? = nil) throws -> CaptureObservation {
        try ResourceMeter.shared.measure(.publish) { try publish(observation, image: image, bundle: bundle) }
    }

    public static func bundleName(for capturedAt: Date) -> String {
        SpoolLayout.bundleName(capturedAt: capturedAt, id: UUID())
    }

    private func publish(_ observation: CaptureObservation, image: CaptureImage?, bundle: String?) throws -> CaptureObservation {
        mutex.lock()
        defer { mutex.unlock() }
        guard !readOnly else {
            throw CaptureStoreError.readOnly
        }
        guard observation.imageFile == nil,
              observation.imageEncoding == nil,
              Self.hasStorableTimeAndSize(observation),
              bundle.map({ SpoolLayout.names($0, capturedAt: observation.capturedAt) }) ?? true else {
            throw CaptureStoreError.invalidObservation
        }
        let day = bundle.flatMap(SpoolLayout.indexedSeconds(ofBundle:)).map { SpoolLayout.dayName(for: Date(timeIntervalSince1970: $0)) }
            ?? SpoolLayout.dayName(for: observation.capturedAt)
        let name = bundle ?? SpoolLayout.bundleName(capturedAt: observation.capturedAt, id: UUID())
        if bundle != nil, let stored = try published(name, in: day, stating: observation) { return stored }
        let source = try image.map { try Self.source($0, for: observation) }
        if source != nil, videoBackpressure() {
            throw CaptureStoreError.archiveBacklogFull
        }
        return try publishBundle(observation, image: source, day: day, name: name)
    }

    private func published(_ name: String, in day: String, stating observation: CaptureObservation) throws -> CaptureObservation? {
        let dayURL = directory.appendingPathComponent(day, isDirectory: true)
        let destination = dayURL.appendingPathComponent(name, isDirectory: true)
        guard try SpoolFiles.exists(destination) else {
            let staging = dayURL.appendingPathComponent(SpoolLayout.stagingPrefix + name, isDirectory: true)
            if try SpoolFiles.exists(staging) { try FileManager.default.removeItem(at: staging) }
            return nil
        }
        do {
            try flushDay(dayURL)
        } catch {
            throw CaptureStoreError.publishedNotFlushed(end: max(observation.capturedAt, observation.capturedUntil ?? observation.capturedAt),
                                                        cause: error)
        }
        return try decode(destination)
    }

    public func videoBackpressure() -> Bool {
        guard videoQuality != nil, let fits else { return false }
        return !fits()
    }

    var pendingBytes: Int {
        pendingImages.values.reduce(0) { $0 + $1.bytes }
    }

    static func hasStorableTimeAndSize(_ observation: CaptureObservation) -> Bool {
        let seconds = observation.capturedAt.timeIntervalSince1970
        return seconds.isFinite
            && seconds >= 0
            && seconds < SpoolLayout.captureTimeLimit
            && observation.width >= 0
            && observation.height >= 0
    }

    private static func source(_ image: CaptureImage, for observation: CaptureObservation) throws -> CGImage {
        guard observation.width > 0, observation.height > 0,
              let source = try? SegmentCodec.image(image),
              source.width == observation.width, source.height == observation.height else {
            throw CaptureStoreError.invalidObservation
        }
        return source
    }

    private func publishBundle(_ observation: CaptureObservation, image: CGImage?, day: String, name: String) throws -> CaptureObservation {
        let dayURL = directory.appendingPathComponent(day, isDirectory: true)
        if Darwin.mkdir(dayURL.path, 0o700) != 0 && errno != EEXIST {
            throw CaptureStoreError.io("create day directory", errno)
        }
        guard try SpoolFiles.isRealDirectory(dayURL) else {
            throw CaptureStoreError.io("open partition", EINVAL)
        }
        let staging = dayURL.appendingPathComponent(SpoolLayout.stagingPrefix + name, isDirectory: true)
        let destination = dayURL.appendingPathComponent(name, isDirectory: true)
        var stored = observation
        let path = image.map { _ in SpoolLayout.ImagePath(day: day, bundle: name, file: .open).relativePath }
        stored.imageFile = path
        let json = try SpoolJSON.encode(stored)
        guard json.count <= MetadataCodec.maximumJSONBytes else {
            throw CaptureStoreError.invalidObservation
        }
        let metadata = try MetadataCodec.encode(json)
        var frame: EncodedFrame?
        if let image, let path { frame = try encode(image, for: stored, at: path) }
        do {
            try FileManager.default.createDirectory(
                at: staging,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700]
            )
            if let frame {
                let opened = try log(frame)
                let file = staging.appendingPathComponent(SpoolLayout.ImageFile.open.rawValue)
                try files.writeNew(file, SpoolJSON.encode(opened), flush: .data)
            }
            try files.writeNew(staging.appendingPathComponent(SpoolLayout.metadata), metadata, flush: .barrier)
            if frame != nil {
                try appendInterrupt?()
            }
            guard Darwin.rename(staging.path, destination.path) == 0 else {
                throw CaptureStoreError.io("commit bundle", errno)
            }
            if let frame {
                pendingImages[frame.imagePath] = PendingEntry(bytes: CMSampleBufferGetTotalSampleSize(frame.sample),
                                                              segment: frame.segment.id)
            }
            do {
                try flushDay(dayURL)
            } catch {
                throw CaptureStoreError.publishedNotFlushed(end: max(observation.capturedAt, observation.capturedUntil ?? observation.capturedAt),
                                                            cause: error)
            }
            if let frame, frame.segment.records == SegmentReference.maximumFrameCount {
                seal(frame.segment)
            }
            return try observationDecoder(json)
        } catch {
            if let frame {
                seal(frame.segment)
            }
            throw error
        }
    }

    private func removeDeadStaging() throws {
        for day in try days(since: nil) {
            for child in try SpoolFiles.children(of: day) {
                let name = child.lastPathComponent
                guard name.hasPrefix(SpoolLayout.stagingPrefix),
                      SpoolLayout.indexedSeconds(ofBundle: String(name.dropFirst(SpoolLayout.stagingPrefix.count))) != nil else {
                    continue
                }
                try? FileManager.default.removeItem(at: child)
            }
        }
    }

    private static func openTextDirectory(in directory: URL) throws {
        let text = directory.appendingPathComponent(SpoolLayout.textDirectory, isDirectory: true)
        guard Darwin.mkdir(text.path, 0o700) == 0 else {
            guard errno == EEXIST else {
                throw CaptureStoreError.io("create text directory", errno)
            }
            return
        }
        try DeviceFiles.syncDirectory(directory)
    }

    private static func lockWriter(in directory: URL) throws -> Int32 {
        let path = directory.appendingPathComponent(SpoolLayout.writerLock).path
        let fd = Darwin.open(path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else {
            throw CaptureStoreError.io("open lock", errno)
        }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            let code = errno
            Darwin.close(fd)
            if code == EWOULDBLOCK {
                throw CaptureStoreError.writerAlreadyRunning
            }
            throw CaptureStoreError.io("lock", code)
        }
        return fd
    }

    private static func unlockWriter(_ fd: Int32) {
        flock(fd, LOCK_UN)
        Darwin.close(fd)
    }

    private static func decodeObservation(_ data: Data) throws -> CaptureObservation {
        try SpoolJSON.decode(CaptureObservation.self, from: data)
    }
}
