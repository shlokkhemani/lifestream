import DeviceFiles
import Evidence
import Foundation
import os

public struct InputEventLogStatus: Equatable, Sendable {
    public enum State: String, Sendable {
        case recording
        case permissionRequired = "permission_required"
        case stopped
    }

    public var state: State = .stopped
    public var events = 0
    public var chunks = 0
    public var tapRestarts = 0
    public var lastTapRestart: InputTapRestart?

    public init() {}
}

public final class InputEventLog: @unchecked Sendable {
    private let queue = DispatchQueue(label: "org.lifestreamprotocol.input-events", qos: .userInitiated)
    private let told: DispatchQueue
    private let lookupQueue = DispatchQueue(label: "org.lifestreamprotocol.input-events.lookups",
                                            qos: .userInitiated)
    private let directory: URL
    private let deviceFiles: DeviceFiles
    private let zone: TimeZone
    private let report: (String) -> Void
    private let source: InputEventSource
    private let reader: InputElementReading
    private let clock: InputEventClock
    private let limits: InputChunker.Limits
    private let fits: @Sendable () -> Bool
    private let drops = MinuteDrops()
    private let onChunkWritten: (@Sendable () -> Void)?

    private var modes: RecordingModes
    private var files: InputEventFiles?
    private var chunker: InputChunker?
    private var buffer: InputEventBuffer?
    private var wake: DispatchSourceUserDataAdd?
    private var wakeLater: DispatchSourceTimer?
    private var minuteTimer: DispatchSourceTimer?
    private var lookupTimer: DispatchSourceTimer?
    private var syncTimer: DispatchSourceTimer?
    private var listening: DispatchSourceTimer?
    private var drained: (() -> Void)?
    private var run = 0

    private let published = OSAllocatedUnfairLock(initialState: InputEventLogStatus())

    static let syncInterval = 5.0

    public convenience init(directory: URL, files: DeviceFiles, modes: RecordingModes,
                            timeZone: TimeZone = .current,
                            fits: @escaping @Sendable () -> Bool = { true }, report: @escaping (String) -> Void = { _ in },
                            onChunkWritten: (@Sendable () -> Void)? = nil) {
        self.init(directory: directory, files: files, modes: modes, timeZone: timeZone, report: report,
                  source: LiveInputEventSource(), reader: AccessibilityElementReader(), clock: .system, fits: fits,
                  onChunkWritten: onChunkWritten)
    }

    init(directory: URL, files: DeviceFiles, modes: RecordingModes, timeZone: TimeZone,
         report: @escaping (String) -> Void,
         source: InputEventSource, reader: InputElementReading, clock: InputEventClock,
         limits: InputChunker.Limits = InputChunker.Limits(), fits: @escaping @Sendable () -> Bool = { true },
         onChunkWritten: (@Sendable () -> Void)? = nil) {
        self.directory = directory
        self.deviceFiles = files
        self.modes = modes
        self.zone = timeZone
        self.report = report
        self.source = source
        self.reader = reader
        self.clock = clock
        self.limits = limits
        self.fits = fits
        let told = DispatchQueue(label: "org.lifestreamprotocol.input-events.told", qos: .utility)
        self.told = told
        self.onChunkWritten = onChunkWritten.map { tell in { @Sendable in told.async { tell() } } }
    }

    public var status: InputEventLogStatus { published.withLock { $0 } }


    public func start() {
        let opened: Bool = queue.sync {
            guard files == nil else { return false }
            do {
                files = try InputEventFiles(recorderDirectory: directory, files: deviceFiles, timeZone: zone, report: report,
                                            unsynced: { [weak self] in self?.armSync($0) }, fits: fits,
                                            drops: drops, chunkWritten: onChunkWritten)
                return true
            } catch {
                report("input events: the batch spool could not be opened")
                return false
            }
        }
        guard opened else { return }
        let wake = DispatchSource.makeUserDataAddSource(queue: queue)
        let wakeLater = DispatchSource.makeTimerSource(queue: queue)
        let buffer = InputEventBuffer(capacity: limits.capacity, wake: { wake.add(data: 1) }, wakeLater: {
            wakeLater.schedule(deadline: .now() + InputEventBuffer.deferral, leeway: .milliseconds(10))
        })
        source.setModes(queue.sync { modes })
        let state = source.openingState()
        queue.sync {
            guard let files else { return }
            run &+= 1
            let names = InputProcessNames { [source] in source.processName($0) }
            let chunker = InputChunker(modes: modes, timeZone: zone, limits: limits, names: names,
                                       writer: files, lookups: self, after: files.lastUntil)
            self.chunker = chunker
            self.buffer = buffer
            self.wake = wake
            self.wakeLater = wakeLater
            chunker.open(at: clock.now(), state: state)
            wake.setEventHandler { [weak self] in self?.drain() }
            wake.resume()
            wakeLater.setEventHandler { [weak self] in self?.drain() }
            wakeLater.resume()
            scheduleMinute()
            published.withLock { $0 = InputEventLogStatus() }
            afterWork()
        }
        let keys = source.start(into: buffer)
        published.withLock { $0.state = keys ? .recording : .permissionRequired }
        if !keys { awaitGrant() }
    }

    static let listenInterval = 2.0

    private func awaitGrant() {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + Self.listenInterval, repeating: Self.listenInterval, leeway: .milliseconds(250))
        timer.setEventHandler { [weak self] in
            guard let self, source.listen() else { return }
            listening?.cancel()
            listening = nil
            published.withLock { $0.state = .recording }
        }
        timer.resume()
        listening = timer
    }

    public func stop() {
        guard queue.sync(execute: { chunker != nil }) else { return }
        listening?.cancel()
        listening = nil
        source.stop()
        let finished = DispatchSemaphore(value: 0)
        queue.async { [self] in
            drain()
            chunker?.finish(at: clock.now())
            drained = { finished.signal() }
            afterWork()
        }
        finished.wait()
        queue.sync {
            for timer in [minuteTimer, lookupTimer, syncTimer, wakeLater] { timer?.cancel() }
            minuteTimer = nil
            lookupTimer = nil
            syncTimer = nil
            wakeLater = nil
            wake?.cancel()
            wake = nil
            buffer = nil
            chunker = nil
            do { try files?.seal() } catch { report("input events: the open batch was not sealed") }
            files?.close()
            files = nil
        }
        published.withLock { $0.state = .stopped }
    }

    public func rotate() {
        queue.sync { [self] in
            guard let files else { return }
            drain()
            chunker?.tick(now: clock.now(), uptime: clock.uptime())
            afterWork()
            do { try files.seal() } catch { report("input events: the open batch was not sealed") }
        }
    }

    func waitUntilTold() {
        queue.sync {}
        told.sync {}
    }

    public func setModes(_ modes: RecordingModes) {
        source.setModes(modes)
        queue.async { [self] in
            self.modes = modes
            chunker?.setModes(modes)
        }
    }


    private func drain() {
        guard let chunker, let buffer else { return }
        ResourceMeter.shared.measure(.inputLog) {
            var batch = buffer.take()
            let uptime = clock.uptime()
            for item in batch.items { chunker.handle(item, uptime: uptime) }
            if batch.lost > 0 { chunker.lost(batch.lost, at: clock.now()) }
            buffer.recycle(&batch.items)
            afterWork()
        }
    }

    private func afterWork() {
        guard let chunker else { return }
        armLookupTimer(chunker.nextLookupDeadline)
        published.withLockUnchecked { status in
            status.events = chunker.eventsWritten
            status.chunks = chunker.chunksWritten
            status.tapRestarts = chunker.tapRestarts
            status.lastTapRestart = chunker.lastTapRestart
        }
        if chunker.isDrained, let drained {
            self.drained = nil
            drained()
        }
    }

    private func armLookupTimer(_ deadline: Double?) {
        guard let deadline else {
            lookupTimer?.cancel()
            lookupTimer = nil
            return
        }
        let timer = lookupTimer ?? {
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.setEventHandler { [weak self] in self?.lookupDeadlinePassed() }
            timer.resume()
            lookupTimer = timer
            return timer
        }()
        timer.schedule(deadline: .now() + max(0, deadline - clock.uptime()), leeway: .milliseconds(2))
    }

    private func lookupDeadlinePassed() {
        guard let chunker else { return }
        drain()
        chunker.tick(now: clock.now(), uptime: clock.uptime())
        afterWork()
    }

    private func scheduleMinute() {
        let now = clock.now()
        let next = InputEventBatch.minute(of: now).addingTimeInterval(60)
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(wallDeadline: .now() + max(0, next.timeIntervalSince(now)), leeway: .milliseconds(50))
        timer.setEventHandler { [weak self] in self?.minutePassed() }
        minuteTimer?.cancel()
        minuteTimer = timer
        timer.resume()
    }

    private func minutePassed() {
        guard let chunker, let files else { return }
        drain()
        let now = clock.now()
        let session = source.session()
        chunker.session(screenLocked: session.screenLocked, onConsole: session.onConsole, at: now)
        chunker.tick(now: now, uptime: clock.uptime())
        if chunker.isDrained {
            do { try files.sealIfDue(now: now) } catch { report("input events: the day boundary was not sealed") }
        }
        scheduleMinute()
        afterWork()
    }

    private func armSync(_ unsynced: Bool) {
        syncTimer?.cancel()
        syncTimer = nil
        guard unsynced else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + Self.syncInterval, leeway: .milliseconds(250))
        timer.setEventHandler { [weak self] in self?.files?.syncChunk() }
        syncTimer = timer
        timer.resume()
    }
}

extension InputEventLog: InputElementLookups {
    func request(_ id: Int, _ target: InputLookupTarget, deadline: Double) {
        let requestedIn = run
        lookupQueue.async { [self] in
            let started = clock.uptime()
            let answer = started >= deadline ? InputElementAnswer(.failed(.timeout))
                : ResourceMeter.shared.measure(.inputLookup) {
                    reader.read(target, timeout: min(limits.lookupTimeout, deadline - started))
                }
            let ms = Int(((clock.uptime() - started) * 1000).rounded())
            queue.async { [self] in
                guard requestedIn == run, let chunker else { return }
                chunker.resolve(id, answer.lookup, ms: ms, page: answer.page, focusOwner: answer.focusOwner)
                afterWork()
            }
        }
    }
}
