import DeviceFiles
import Evidence
import Foundation

final class InputEventFiles: InputChunkWriter {
    let directory: URL
    private let zone: TimeZone
    private let report: (String) -> Void
    private let unsynced: (Bool) -> Void
    private let fits: @Sendable () -> Bool
    private let drops: MinuteDrops
    private let chunkWritten: (@Sendable () -> Void)?
    private let batches: BatchFiles
    private var batchFile: Log?
    private var batchFirstLineAt: Date?
    private var chunkFile: Log?
    private var chunkUncleared = false
    private(set) var lastUntil: Date?
    private var chunkDirty = false {
        didSet { if chunkDirty != oldValue { unsynced(chunkDirty) } }
    }

    init(recorderDirectory: URL, files: DeviceFiles, timeZone: TimeZone = .current, report: @escaping (String) -> Void = { _ in },
         unsynced: @escaping (Bool) -> Void = { _ in }, fits: @escaping @Sendable () -> Bool = { true },
         drops: MinuteDrops = MinuteDrops(), chunkWritten: (@Sendable () -> Void)? = nil) throws {
        directory = recorderDirectory.appendingPathComponent(InputEventBatch.directoryName)
        zone = timeZone
        self.report = report
        self.unsynced = unsynced
        self.fits = fits
        self.drops = drops
        self.chunkWritten = chunkWritten
        batches = BatchFiles(files)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try recover()
        lastUntil = lastPublished()?.until
    }

    var openBatch: URL { directory.appendingPathComponent(InputEventBatch.openName) }
    var openChunk: URL { directory.appendingPathComponent(InputEventBatch.chunkName) }

    func sealedBatches() -> [String] {
        InputEventBatch.sealedBatches(in: directory)
    }


    func chunkOpened(at: Date, layout: String) {
        if chunkUncleared { clearChunk() }
        appendToChunk("{\"chunk\":\(InputEventCodec.quoted(UTCInstant.rfc3339(at)))," +
                      "\"layout\":\(InputEventCodec.quoted(layout))}")
    }

    func appAdded(_ index: Int, name: String) {
        appendToChunk("{\"app\":\(index),\"name\":\(InputEventCodec.quoted(name))}")
    }

    func eventFinished(_ event: InputEvent) {
        do {
            appendToChunk(try InputEventCodec.line(event))
        } catch {
            report("input events: one event could not be written")
        }
    }

    func siteAdded(_ index: Int, host: String) {
        appendToChunk("{\"site\":\(index),\"host\":\(InputEventCodec.quoted(host))}")
    }

    func activityCounted(_ activity: InputActivity) {
        let site = activity.site.map { ",\"site\":\($0)" } ?? ""
        appendToChunk("{\"activity\":\(activity.app)\(site),\"keys\":\(activity.keys),\"clicks\":\(activity.clicks)," +
                      "\"scrolls\":\(activity.scrolls),\"moves\":\(activity.moves)}")
    }

    func lostCounted(_ total: Int) {
        appendToChunk("{\"lost\":\(total)}")
    }

    func chunkClosed(_ chunk: InputChunk?) {
        var settled = true
        var written = false
        if let chunk {
            do {
                guard fits() else { throw POSIXError(.ENOSPC) }
                try publish(chunk)
                drops.written()
                written = true
            } catch {
                report("input events: one chunk line was not written; its loss-only line follows")
                do {
                    if let loss = Self.lossOnly(chunk) {
                        try publish(loss)
                        drops.written()
                        written = true
                    }
                } catch {
                    settled = false
                    drops.dropped(error)
                    report("input events: one minute was dropped")
                }
            }
        }
        clearChunk()
        if settled { chunkDirty = false }
        if written { chunkWritten?() }
    }

    static func lossOnly(_ chunk: InputChunk) -> InputChunk? {
        let counted = chunk.activity.reduce(0) { $0 + $1.keys + $1.clicks + $1.scrolls + $1.moves }
        let lost = chunk.events.count + chunk.lost + counted
        guard lost > 0 else { return nil }
        return InputChunk(at: chunk.at, until: chunk.until, layout: chunk.layout, apps: [], events: [], lost: lost)
    }

    private func clearChunk() {
        do {
            try chunkFile?.truncate()
            chunkUncleared = false
        } catch {
            chunkUncleared = true
            report("input events: the open minute was not cleared")
        }
    }

    func syncChunk() {
        guard chunkDirty, let chunkFile else { return }
        do {
            try chunkFile.flush(.full)
            chunkDirty = false
        } catch {
            report("input events: the open minute was not synced")
            unsynced(true)
        }
    }

    private func appendToChunk(_ line: String) {
        guard !chunkUncleared else { return }
        do {
            let file = try chunkFile ?? batches.files.log(openChunk)
            chunkFile = file
            try file.append(Data((line + "\n").utf8), flush: nil)
            chunkDirty = true
        } catch {
            report("input events: the open minute could not be written")
        }
    }


    func publish(_ chunk: InputChunk) throws {
        if let first = batchFirstLineAt,
           InputEventBatch.mustRotate(firstLineAt: first, next: chunk.at, in: zone) {
            try seal()
        }
        let line = try InputEventCodec.line(chunk) + "\n"
        let file = try batchFile ?? batches.files.log(openBatch)
        batchFile = file
        do {
            try file.append(Data(line.utf8), flush: .full)
        } catch DeviceFileError.notFlushed {
            report("input events: one chunk line was written but not flushed")
        }
        if batchFirstLineAt == nil {
            batchFirstLineAt = chunk.at
        }
        lastUntil = max(lastUntil ?? chunk.until, chunk.until)
        do {
            try sealIfDue(now: chunk.until)
        } catch {
            report("input events: the open batch was not sealed")
        }
    }

    func sealIfDue(now: Date) throws {
        guard let first = batchFirstLineAt,
              InputEventBatch.mustRotate(firstLineAt: first, next: now, in: zone) else { return }
        try seal()
    }

    func seal() throws {
        guard let first = batchFirstLineAt else { return }
        try batchFile?.repair()
        try batches.seal(openBatch, firstLineAt: first)
        batchFile?.close()
        batchFile = nil
        batchFirstLineAt = nil
    }

    func close() {
        syncChunk()
        chunkFile?.close()
        chunkFile = nil
        batchFile?.close()
        batchFile = nil
    }


    private func recover() throws {
        batchFirstLineAt = try batches.repair(openBatch) { try? InputEventCodec.chunk($0).at }
        if let chunk = try recoveredChunk() {
            try publish(chunk)
        }
        try? FileManager.default.removeItem(at: openChunk)
        try seal()
    }

    private func recoveredChunk() throws -> InputChunk? {
        guard let bytes = try? batches.files.read(openChunk, maximumBytes: BatchFiles.maximumBytes) else { return nil }
        guard let chunk = Self.rebuild(bytes) else { return nil }
        if let published = lastPublished() {
            if published.at == chunk.at { return nil }
            if let until = published.until, chunk.at < until { return nil }
        }
        return chunk
    }

    static func rebuild(_ bytes: Data) -> InputChunk? {
        var lines = bytes.split(separator: 0x0A, omittingEmptySubsequences: false).map { Data($0) }
        lines.removeLast()
        guard let headerText = lines.first.flatMap({ String(data: $0, encoding: .utf8) }),
              let header = try? InputEventCodec.jsonObject(headerText),
              let spelled = header["chunk"] as? String, let at = UTCInstant.date(rfc3339: spelled),
              let layout = header["layout"] as? String, header.count == 2 else { return nil }
        var apps: [String] = []
        var sites: [String] = []
        var events: [InputEvent] = []
        var activity: [InputActivityKey: InputActivity] = [:]
        var lost = 0
        for data in lines.dropFirst() {
            guard let text = String(data: data, encoding: .utf8),
                  let object = try? InputEventCodec.jsonObject(text) else { break }
            if object["e"] != nil {
                guard let event = try? InputEventCodec.event(text),
                      event.body.appIndices.allSatisfy(apps.indices.contains),
                      event.site.map(sites.indices.contains) ?? true else { break }
                events.append(event)
            } else if let index = object["app"] {
                guard object.count == 2, let name = object["name"] as? String,
                      (try? InputEventCodec.integer(index, "app")) == apps.count else { break }
                apps.append(name)
            } else if let index = object["activity"] {
                var entry = object
                entry["app"] = entry.removeValue(forKey: "activity")
                guard (try? InputEventCodec.integer(index, "activity")) != nil,
                      let counted = try? InputEventCodec.activity(entry), apps.indices.contains(counted.app),
                      counted.site.map(sites.indices.contains) ?? true else { break }
                activity[InputActivityKey(counted)] = counted
            } else if let index = object["site"] {
                guard object.count == 2, let host = object["host"] as? String, RecordingModes.isValidSite(host),
                      (try? InputEventCodec.integer(index, "site")) == sites.count else { break }
                sites.append(host)
            } else if let total = object["lost"] {
                guard object.count == 1, let value = try? InputEventCodec.integer(total, "lost") else { break }
                lost = value
            } else {
                break
            }
        }
        guard !events.isEmpty || lost > 0 || !activity.isEmpty else { return nil }
        let last = events.last.map { at.addingTimeInterval(Double($0.t) / 1000) } ?? at
        return InputChunk(at: at, until: max(last, at.addingTimeInterval(0.001)), layout: layout,
                          apps: apps, sites: sites, events: events,
                          activity: activity.values.sorted(by: InputActivity.order),
                          lost: lost, recovered: true)
    }

    private func lastPublished() -> (at: Date, until: Date?)? {
        let candidates = [openBatch] + sealedBatches().reversed().prefix(1).map { directory.appendingPathComponent($0) }
        for url in candidates {
            guard let line = batches.lastLine(url), !line.isEmpty else { continue }
            let text = String(decoding: line.prefix(80), as: UTF8.self)
            guard text.hasPrefix("{\"at\":\""), text.count >= 31,
                  let at = UTCInstant.date(rfc3339: String(text.dropFirst(7).prefix(24))) else { continue }
            let rest = text.dropFirst(32)
            let until = rest.hasPrefix(",\"until\":\"") ? UTCInstant.date(rfc3339: String(rest.dropFirst(10).prefix(24))) : nil
            return (at, until)
        }
        return nil
    }
}

final class MinuteDrops: @unchecked Sendable {
    private var streak = FailureLines.Streak(closing: .minutesWritten)
    private let lines: FailureLines

    init(lines: FailureLines = .shared) {
        self.lines = lines
    }

    func dropped(_ error: Error) {
        streak.failed(.minuteDropped, errno: FailureLines.errno(of: error), lines: lines)
    }

    func written() {
        streak.ended(lines: lines)
    }
}
