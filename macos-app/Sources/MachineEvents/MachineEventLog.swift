import DeviceFiles
import Evidence
import Foundation

final class MachineEventLog {
    let directory: URL
    private let zone: TimeZone
    private let drops: LineDrops
    private let state: () -> MachineState
    private let batches: BatchFiles
    private var file: Log?
    private var openFirstLineAt: Date?
    private var openMaxAtMs: Int64?

    init(recorderDirectory: URL, files: DeviceFiles, timeZone: TimeZone = .current, drops: LineDrops = LineDrops(),
         state: @escaping () -> MachineState) throws {
        directory = recorderDirectory.appendingPathComponent(MachineEventBatch.directoryName)
        zone = timeZone
        self.drops = drops
        self.state = state
        batches = BatchFiles(files)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        if let first = try batches.repair(openBatch, firstLineAt: { try? MachineEventCodec.event($0).at }) {
            try batches.seal(openBatch, firstLineAt: first)
        }
    }

    var openBatch: URL { directory.appendingPathComponent(MachineEventBatch.openName) }

    func sealedBatches() -> [String] {
        MachineEventBatch.sealedBatches(in: directory)
    }

    func append(_ event: MachineEvent) throws {
        do {
            try ResourceMeter.shared.measure(.machineEvents) { try log(event) }
        } catch {
            drops.dropped(error)
            throw error
        }
        drops.written()
    }

    private func log(_ event: MachineEvent) throws {
        if let first = openFirstLineAt,
           MachineEventBatch.mustRotate(firstLineAt: first, next: event.at, in: zone) {
            try rotate()
        }
        var events = [event]
        if openFirstLineAt == nil, event.name != .state {
            events.insert(MachineEvent(at: event.at, name: .state, detail: state().detail), at: 0)
        }
        try write(events)
    }

    func rotate() throws {
        guard let first = openFirstLineAt else { return }
        try file?.repair()
        try batches.seal(openBatch, firstLineAt: first)
        file?.close()
        file = nil
        openFirstLineAt = nil
        openMaxAtMs = nil
    }

    func rotateIfSafe(now: Date) throws -> Bool {
        guard openFirstLineAt != nil else { return false }
        if let maxAt = openMaxAtMs, Self.milliseconds(now) <= maxAt { return false }
        try rotate()
        return true
    }

    var batchOpen: Bool { openFirstLineAt != nil }

    func rotateForShipping(now: Date) throws -> Bool {
        guard batchOpen else { return true }
        return try rotateIfSafe(now: now)
    }

    static func milliseconds(_ instant: Date) -> Int64 {
        Int64((instant.timeIntervalSince1970 * 1000).rounded())
    }

    private func write(_ events: [MachineEvent]) throws {
        let lines = try events.map { try MachineEventCodec.line($0) + "\n" }.joined()
        let file = try self.file ?? batches.files.log(openBatch)
        self.file = file
        do {
            try file.append(Data(lines.utf8), flush: .full)
        } catch DeviceFileError.notFlushed {
        }
        if openFirstLineAt == nil {
            openFirstLineAt = events[0].at
        }
        for event in events {
            let at = Self.milliseconds(event.at)
            openMaxAtMs = max(openMaxAtMs ?? at, at)
        }
    }
}

final class LineDrops: @unchecked Sendable {
    private var streak = FailureLines.Streak(closing: .linesWritten)
    private let lines: FailureLines

    init(lines: FailureLines = .shared) {
        self.lines = lines
    }

    func dropped(_ error: Error) {
        streak.failed(.lineDropped, errno: FailureLines.errno(of: error), lines: lines)
    }

    func written() {
        streak.ended(lines: lines)
    }
}
