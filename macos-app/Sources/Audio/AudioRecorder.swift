import CoreMedia
import DeviceFiles
import Evidence
import Foundation

public struct AudioStatus: Equatable, Sendable {
    public var mic: AudioTrackState
    public var sound: AudioTrackState
    public var files: Int

    public init(mic: AudioTrackState, sound: AudioTrackState, files: Int = 0) {
        self.mic = mic
        self.sound = sound
        self.files = files
    }

    subscript(track: AudioTrack) -> AudioTrackState {
        get { track == .mic ? mic : sound }
        set { if track == .mic { mic = newValue } else { sound = newValue } }
    }
}

public enum MicUse: Equatable, Sendable {
    case recording(holders: [String], since: Date)
    case stopped(holders: [String])
}

public final class AudioRecorder: @unchecked Sendable {
    public static let stopHold: TimeInterval = 120

    private let queue = DispatchQueue(label: "org.lifestreamprotocol.audio")
    private let folder: RecordingFolder
    private let cameras = CameraSpans()
    private let permission: (AudioTrack) -> AudioAuthorization
    private let clock: () -> Date
    private var tracks: [TrackRecording] = []

    private var running = false
    private var modes: RecordingModes
    private var use: DeviceUse?
    private var holds: AudioHolds
    private let holdsFile: URL
    private let files: DeviceFiles
    private let report: (String) -> Void

    private let statusLock = NSLock()
    private var published = AudioStatus(mic: .stopped, sound: .stopped)
    private var publishedUse: MicUse?

    public init(directory: URL, files: DeviceFiles, scratch: URL,
                modes: RecordingModes, sources: AudioSources = .live(),
                permission: @escaping (AudioTrack) -> AudioAuthorization = AudioPermissions.status,
                partLength: TimeInterval = 600,
                clock: @escaping () -> Date = { Date() },
                fits: @escaping @Sendable () -> Bool = { true },
                report: @escaping (String) -> Void = { _ in }) {
        folder = RecordingFolder(url: directory.appendingPathComponent(AudioSpool.directoryName, isDirectory: true),
                                 scratch: scratch.appendingPathComponent(AudioSpool.directoryName, isDirectory: true),
                                 files: files, report: report)
        self.permission = permission
        self.clock = clock
        self.modes = modes
        self.files = files
        self.report = report
        holdsFile = directory.appendingPathComponent(AudioHolds.fileName)
        holds = AudioHolds.load(holdsFile, files: files, at: clock(), report: report)
        tracks = AudioTrack.allCases.map { track in
            TrackRecording(track: track, source: sources[track], queue: queue, folder: folder, cameras: cameras,
                           partLength: partLength, clock: clock, fits: fits, report: report,
                           changed: { [unowned self] in publishStatus() })
        }
    }


    public var status: AudioStatus {
        statusLock.withLock { published }
    }

    public var micUse: MicUse? {
        statusLock.withLock { publishedUse }
    }

    public func start() {
        queue.sync {
            guard !running else { return }
            folder.recoverLeftovers()
            running = true
            evaluate(at: clock())
        }
    }

    public func stop() {
        queue.sync {
            guard running else { return }
            running = false
            evaluate(at: clock())
        }
    }

    public func update(_ next: DeviceUse) {
        queue.async { [self] in
            use = next
            cameras.follow(next)
            for track in tracks { track.devicesChanged() }
            evaluate(at: next.at)
            for track in tracks { track.refreshOpenSidecar() }
        }
    }

    public func setModes(_ modes: RecordingModes) {
        queue.async { [self] in
            self.modes = modes
            evaluate(at: clock())
        }
    }

    public func holdBack() {
        queue.async { [self] in
            let holders = use?.audio?.microphone.map(\.app) ?? []
            guard !holders.isEmpty else { return }
            if holds.hold(holders) { saveHolds() }
            evaluate(at: clock())
        }
    }

    func waitUntilIdle() {
        queue.sync {}
    }


    private func evaluate(at instant: Date) {
        if let audio = use?.audio, holds.follow(Set(audio.microphone.map(\.app)), at: instant, hold: Self.stopHold) {
            saveHolds()
        }
        for track in tracks {
            let decision = AudioPlan.decide(track.track, use: use, modes: modes, running: running, heldBack: holds.held,
                                            permission: permission(track.track))
            track.apply(decision, at: instant)
        }
        publishStatus()
    }

    private func saveHolds() {
        do {
            try holds.save(holdsFile, files: files)
        } catch {
            report("audio: the stopped uses could not be saved")
        }
    }

    private func publishStatus() {
        var status = AudioStatus(mic: .stopped, sound: .stopped)
        for track in tracks {
            status[track.track] = track.state
            status.files += track.sealed
        }
        let micUse: MicUse?
        let recording = tracks.filter { $0.recordingSince != nil }
        if status.mic == .heldBack {
            micUse = .stopped(holders: Set(use?.audio?.microphone.map(\.app) ?? []).intersection(holds.held).sorted())
        } else if let since = recording.compactMap(\.recordingSince).min() {
            micUse = .recording(holders: Set(recording.flatMap(\.holders)).sorted(), since: since)
        } else {
            micUse = nil
        }
        statusLock.withLock {
            published = status
            publishedUse = micUse
        }
    }
}

struct AudioHolds: Equatable {
    static let fileName = "audio-holds.json"

    enum Held: Equatable {
        case onMic
        case off(since: Date)
    }

    private(set) var apps: [String: Held] = [:]

    var held: Set<String> { Set(apps.keys) }

    mutating func hold(_ holders: [String]) -> Bool {
        let before = apps
        for app in holders { apps[app] = .onMic }
        return apps != before
    }

    mutating func follow(_ holders: Set<String>, at instant: Date, hold: TimeInterval) -> Bool {
        let before = apps
        for (app, held) in apps {
            if case .off(let since) = held, instant.timeIntervalSince(since) >= hold {
                apps[app] = nil
            } else if holders.contains(app) {
                apps[app] = .onMic
            } else if held == .onMic {
                apps[app] = .off(since: instant)
            }
        }
        return apps != before
    }

    private struct Saved: Codable {
        struct App: Codable {
            let app: String
            let lastOn: String?

            enum CodingKeys: String, CodingKey {
                case app
                case lastOn = "last_on"
            }
        }

        let held: [App]
    }

    static func load(_ file: URL, files: DeviceFiles, at instant: Date, report: (String) -> Void) -> AudioHolds {
        var holds = AudioHolds()
        let read: Data?
        do {
            read = try files.read(file, maximumBytes: 1 << 16)
        } catch {
            read = Data()
        }
        guard let read else { return holds }
        guard let saved = try? JSONDecoder().decode(Saved.self, from: read),
              saved.held.allSatisfy({ $0.lastOn.map { UTCInstant.date(rfc3339: $0) != nil } ?? true }) else {
            report("audio: \(fileName) could not be read; no use is stopped")
            return holds
        }
        for app in saved.held {
            holds.apps[app.app] = .off(since: app.lastOn.flatMap { UTCInstant.date(rfc3339: $0) } ?? instant)
        }
        return holds
    }

    func save(_ file: URL, files: DeviceFiles) throws {
        guard !apps.isEmpty else {
            guard FileManager.default.fileExists(atPath: file.path) else { return }
            return try FileManager.default.removeItem(at: file)
        }
        let saved = Saved(held: apps.sorted { $0.key < $1.key }.map { app, held in
            switch held {
            case .onMic: Saved.App(app: app, lastOn: nil)
            case .off(let since): Saved.App(app: app, lastOn: UTCInstant.rfc3339(since))
            }
        })
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try files.replace(file, with: try encoder.encode(saved), commit: .durable)
    }
}

final class TrackRecording {
    let track: AudioTrack
    private(set) var state = AudioTrackState.stopped
    private(set) var sealed = 0
    private(set) var recordingSince: Date?
    private let source: any AudioSource
    private let queue: DispatchQueue
    private let folder: RecordingFolder
    private let cameras: CameraSpans
    private let partLength: TimeInterval
    private let clock: () -> Date
    private let fits: @Sendable () -> Bool
    private let report: (String) -> Void
    private let changed: () -> Void

    private var session: Session?
    private var holdUntilChange = false
    private var uncounted: TimeInterval = 0

    init(track: AudioTrack, source: any AudioSource, queue: DispatchQueue, folder: RecordingFolder, cameras: CameraSpans,
         partLength: TimeInterval, clock: @escaping () -> Date, fits: @escaping @Sendable () -> Bool,
         report: @escaping (String) -> Void, changed: @escaping () -> Void) {
        self.track = track
        self.source = source
        self.queue = queue
        self.folder = folder
        self.cameras = cameras
        self.partLength = partLength
        self.clock = clock
        self.fits = fits
        self.report = report
        self.changed = changed
    }

    private final class Session {
        let capture: AudioCapture
        let device: AudioSidecar.Device?
        let detectedAt: Date
        var room: AudioRoom
        var part = 0
        var file: OpenFile?
        var name: String?
        var anchor: (wall: Date, time: CMTime)?

        init(capture: AudioCapture, device: AudioSidecar.Device?, detectedAt: Date, room: AudioRoom) {
            self.capture = capture
            self.device = device
            self.detectedAt = detectedAt
            self.room = room
        }
    }

    private final class OpenFile {
        let stem: String
        let session: String
        let writer: AudioSegmentWriter
        let at: Date
        let part: Int
        var end: Date
        var room: [AudioSidecar.Room]
        var loudness = LoudnessMeter()

        init(stem: String, session: String, writer: AudioSegmentWriter, at: Date, part: Int, room: AudioRoom) {
            self.stem = stem
            self.session = session
            self.writer = writer
            self.at = at
            self.part = part
            end = at
            self.room = [AudioSidecar.Room(at: UTCInstant.rfc3339(at), room: room)]
        }
    }


    var holders: [String] { session?.room.holders ?? [] }

    func devicesChanged() {
        holdUntilChange = false
    }

    func apply(_ decision: AudioPlan.Decision, at instant: Date) {
        switch decision {
        case .unknown:
            return
        case .idle(let next):
            if session != nil { end(ending(for: next)) }
            publish(next)
        case .record(let capture, let device, let room):
            if let session, session.capture == capture {
                roomChanged(room, at: instant)
                return
            }
            if session != nil { end(.deviceChanged) }
            guard !holdUntilChange else { return publish(.failed) }
            begin(capture, device: device, room: room, at: instant)
        }
    }

    private func ending(for state: AudioTrackState) -> AudioSidecar.Ending {
        switch state {
        case .stopped: return .recorderStopped
        case .heldBack: return .stopped
        case .withheld: return .withheld
        case .idle: return .holdersGone
        case .permissionRequired, .failed, .recording: return .failed
        }
    }

    private func begin(_ capture: AudioCapture, device: AudioSidecar.Device?, room: AudioRoom, at instant: Date) {
        let session = Session(capture: capture, device: device, detectedAt: instant, room: room)
        self.session = session
        do {
            try folder.create()
            try source.start(capture, queue: queue,
                             deliver: { [weak self] chunk in self?.deliver(chunk, to: session) },
                             failed: { [weak self] _ in self?.captureFailed(session) })
            if recordingSince == nil { recordingSince = instant }
            publish(.recording)
        } catch {
            self.session = nil
            fail("\(track.rawValue): the capture could not start")
        }
    }

    private func roomChanged(_ room: AudioRoom, at instant: Date) {
        guard let session, session.room != room else { return }
        session.room = room
        guard let file = session.file else { return }
        file.room.append(AudioSidecar.Room(at: UTCInstant.rfc3339(max(instant, file.at)), room: room))
    }

    private func end(_ ending: AudioSidecar.Ending) {
        guard let ended = session else { return }
        session = nil
        source.stop()
        if let file = ended.file { seal(file, of: ended, ending: ending) }
    }

    private func fail(_ line: String) {
        report(line)
        holdUntilChange = true
        publish(.failed)
    }

    private func captureFailed(_ session: Session) {
        guard self.session === session else { return }
        end(.failed)
        fail("\(track.rawValue): the capture stopped with an error")
    }


    private func deliver(_ chunk: AudioChunk, to session: Session) {
        ResourceMeter.shared.measure(track == .mic ? .audioMic : .audioSound) { record(chunk, to: session) }
    }

    private func record(_ chunk: AudioChunk, to session: Session) {
        guard self.session === session else { return }
        uncounted += chunk.duration
        let ms = Int(uncounted * 1000)
        uncounted -= Double(ms) / 1000
        ResourceMeter.shared.count(track == .mic ? .audioMicMs : .audioSoundMs, ms)
        let time = CMSampleBufferGetPresentationTimeStamp(chunk.buffer)
        let anchor = session.anchor ?? (chunk.at, time)
        session.anchor = anchor
        let at = UTCInstant.millisecond(anchor.wall.addingTimeInterval(CMTimeSubtract(time, anchor.time).seconds))
        do {
            if let file = session.file, at.timeIntervalSince(file.at) >= partLength {
                session.file = nil
                seal(file, of: session, ending: .partLimit)
            }
            guard fits() else { throw POSIXError(.ENOSPC) }
            let file = try session.file ?? open(session, at: at)
            try file.writer.append(chunk)
            file.loudness.add(chunk.buffer)
            file.end = UTCInstant.millisecond(at.addingTimeInterval(chunk.duration))
        } catch {
            end(.failed)
            fail("\(track.rawValue): audio could not be written")
        }
    }

    private func open(_ session: Session, at instant: Date) throws -> OpenFile {
        session.part += 1
        let stem = AudioSpool.freshStem(for: instant, track: track, in: folder.url, writing: folder.scratch)
        let name = session.name ?? stem
        session.name = name
        let writer = try AudioSegmentWriter(url: folder.writing(stem))
        let file = OpenFile(stem: stem, session: name, writer: writer, at: instant, part: session.part, room: session.room)
        session.file = file
        folder.writeOpen(sidecar(file, of: session, until: nil), stem: stem)
        return file
    }


    private func sidecar(_ file: OpenFile, of session: Session, until: Date?) -> AudioSidecar {
        var latency: Int?
        if file.part == 1, let first = session.anchor?.wall {
            latency = max(0, Int((first.timeIntervalSince(session.detectedAt) * 1000).rounded()))
        }
        return AudioSidecar(
            at: UTCInstant.rfc3339(file.at), until: until.map(UTCInstant.rfc3339), track: track,
            detectedAt: UTCInstant.rfc3339(session.detectedAt), latencyMs: latency, part: file.part, endedBy: nil,
            device: session.device, room: file.room, camera: cameras.spans(from: file.at, until: until ?? clock()),
            audio: nil, session: file.session)
    }

    func refreshOpenSidecar() {
        guard let session, let file = session.file else { return }
        folder.writeOpen(sidecar(file, of: session, until: nil), stem: file.stem)
    }

    private func seal(_ file: OpenFile, of session: Session, ending: AudioSidecar.Ending) {
        do {
            try file.writer.finish()
        } catch {
            report("\(track.rawValue): an audio file was not closed; sealing what reads")
            if folder.recover(file.stem) { sealedOne() }
            return
        }
        guard FileManager.default.fileExists(atPath: folder.writing(file.stem).path) else {
            folder.removeOpen(file.stem)
            return
        }
        var sealed = sidecar(file, of: session, until: file.end)
        sealed.endedBy = ending.rawValue
        sealed.loudness = file.loudness.loudness
        if folder.seal(sealed, stem: file.stem, durationMs: Int((file.writer.duration * 1000).rounded())) {
            sealedOne()
        }
    }


    private func publish(_ next: AudioTrackState) {
        state = next
        if next != .recording { recordingSince = nil }
        changed()
    }

    private func sealedOne() {
        sealed += 1
        changed()
    }
}
