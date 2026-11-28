import CryptoKit
import DeviceFiles
import Evidence
import Foundation

struct RecordingFolder {
    static let maximumSidecarBytes = 1 << 20

    let url: URL
    let scratch: URL
    let files: DeviceFiles
    let report: (String) -> Void

    init(url: URL, scratch: URL, files: DeviceFiles, report: @escaping (String) -> Void) {
        self.url = url
        self.scratch = scratch
        self.files = files
        self.report = report
    }

    func create() throws {
        for folder in [url, scratch] {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
        }
    }

    func writing(_ stem: String) -> URL {
        scratch.appendingPathComponent(AudioSpool.audioName(stem))
    }

    func kept(_ stem: String) -> URL {
        url.appendingPathComponent(AudioSpool.audioName(stem))
    }

    func writeOpen(_ sidecar: AudioSidecar, stem: String) {
        do {
            try files.replace(url.appendingPathComponent(AudioSpool.openName(stem)), with: sidecar.encoded(), commit: .atomic)
        } catch {
            report("audio: an open sidecar was not written")
        }
    }

    func removeOpen(_ stem: String) {
        try? FileManager.default.removeItem(at: url.appendingPathComponent(AudioSpool.openName(stem)))
    }

    func seal(_ sidecar: AudioSidecar, stem: String, durationMs: Int) -> Bool {
        let made = writing(stem)
        let audio = kept(stem)
        do {
            if made != audio, FileManager.default.fileExists(atPath: made.path) {
                try files.place(made, at: audio, flush: .data)
            } else {
                try DeviceFiles.syncFile(audio, flush: .data)
            }
            let measured = try Self.measure(audio, files: files)
            var sealed = sidecar
            sealed.audio = AudioSidecar.Audio(
                file: AudioSpool.audioName(stem), mediaType: AudioFormat.mediaType, codec: AudioFormat.codec,
                sampleRate: AudioFormat.sampleRate, channels: AudioFormat.channels, bitRate: AudioFormat.bitRate,
                durationMs: durationMs, bytes: measured.bytes, sha256: measured.sha256)
            try files.replace(url.appendingPathComponent(AudioSpool.sidecarName(stem)), with: try sealed.encoded(),
                              commit: .durable)
            removeOpen(stem)
            return true
        } catch {
            report("audio: a recording was not sealed")
            return false
        }
    }

    static func measure(_ file: URL, files: DeviceFiles) throws -> (sha256: String, bytes: Int) {
        let reader = try files.reader(file)
        var hash = SHA256()
        var bytes = 0
        while let chunk = try reader.next() {
            hash.update(data: chunk)
            bytes += chunk.count
        }
        return (hash.finalize().map { String(format: "%02x", $0) }.joined(), bytes)
    }


    @discardableResult
    func recoverLeftovers() -> Int {
        let manager = FileManager.default
        let names = (try? manager.contentsOfDirectory(atPath: url.path)) ?? []
        let made = scratch == url ? [] : (try? manager.contentsOfDirectory(atPath: scratch.path)) ?? []
        let open = names.filter { $0.hasSuffix(AudioSpool.openSuffix) }.map { String($0.dropLast(AudioSpool.openSuffix.count)) }
        let recovered = open.sorted().filter { recover($0) }.count
        let stems = { (listed: [String]) in
            Set(listed.filter { $0.hasSuffix(AudioSpool.audioSuffix) }.map { String($0.dropLast(AudioSpool.audioSuffix.count)) })
        }
        let unfinished = stems(made)
        for stem in stems(names).union(unfinished).sorted() where !open.contains(stem) {
            let sealed = names.contains(AudioSpool.sidecarName(stem))
            guard !sealed || unfinished.contains(stem) else { continue }
            park(stem, kept: !sealed)
        }
        return recovered
    }

    @discardableResult
    func recover(_ stem: String) -> Bool {
        let manager = FileManager.default
        let openURL = url.appendingPathComponent(AudioSpool.openName(stem))
        let made = writing(stem)
        let audio = kept(stem)
        if manager.fileExists(atPath: url.appendingPathComponent(AudioSpool.sidecarName(stem)).path) {
            try? manager.removeItem(at: openURL)
            return false
        }
        let seconds = readableSeconds(made: made, kept: audio)
        guard seconds > 0, let data = try? files.read(openURL, maximumBytes: Self.maximumSidecarBytes),
              var sidecar = try? AudioSidecar.decode(data),
              let at = UTCInstant.date(rfc3339: sidecar.at) else {
            park(stem)
            return false
        }
        let until = UTCInstant.millisecond(at.addingTimeInterval(seconds))
        sidecar.until = UTCInstant.rfc3339(until)
        sidecar.endedBy = AudioSidecar.Ending.interrupted.rawValue
        sidecar.camera = sidecar.camera.compactMap { span in
            guard let start = UTCInstant.date(rfc3339: span.at), start < until else { return nil }
            let end = UTCInstant.date(rfc3339: span.until).map { min($0, until) } ?? until
            return AudioSidecar.CameraSpan(at: span.at, until: UTCInstant.rfc3339(end), device: span.device)
        }
        sidecar.room = sidecar.room.filter { UTCInstant.date(rfc3339: $0.at).map { $0 < until } ?? false }
        return seal(sidecar, stem: stem, durationMs: Int((seconds * 1000).rounded()))
    }

    private var reading: URL { scratch.appendingPathComponent(".reading", isDirectory: true) }

    private func readableSeconds(made: URL, kept: URL) -> TimeInterval {
        let manager = FileManager.default
        if made != kept, manager.fileExists(atPath: made.path) { return AudioSegmentWriter.readableSeconds(made) }
        guard manager.fileExists(atPath: kept.path) else { return 0 }
        defer { try? manager.removeItem(at: reading) }
        return (try? files.readable(kept, in: reading) { AudioSegmentWriter.readableSeconds($0) }) ?? 0
    }

    private func park(_ stem: String, kept keptToo: Bool = true) {
        let manager = FileManager.default
        let made = writing(stem)
        if made != kept(stem), manager.fileExists(atPath: made.path) {
            let torn = kept(stem).appendingPathExtension(String(AudioSpool.tornSuffix.dropFirst()))
            do {
                try files.place(made, at: torn, flush: .data)
            } catch {
                report("audio: a recording that does not read was not parked; the next start tries again")
                return
            }
        }
        for name in [AudioSpool.audioName(stem), AudioSpool.openName(stem)] where keptToo {
            let from = url.appendingPathComponent(name)
            guard manager.fileExists(atPath: from.path) else { continue }
            try? manager.moveItem(at: from, to: url.appendingPathComponent(name + AudioSpool.tornSuffix))
        }
        report("audio: a recording that does not read was parked")
    }
}

final class CameraSpans {
    private var open: [String: Date] = [:]
    private var closed: [(device: String, at: Date, until: Date)] = []

    func follow(_ use: DeviceUse) {
        guard let cameras = use.cameras else { return }
        let running = Set(cameras.map(\.uid))
        for (device, since) in open where !running.contains(device) {
            closed.append((device, since, use.at))
            open[device] = nil
        }
        for device in running where open[device] == nil { open[device] = use.at }
        closed.removeAll { $0.until < use.at.addingTimeInterval(-86_400) }
    }

    func spans(from start: Date, until end: Date) -> [AudioSidecar.CameraSpan] {
        let all = closed + open.map { ($0.key, $0.value, end) }
        return all.compactMap { span -> AudioSidecar.CameraSpan? in
            let from = max(span.at, start), to = min(span.until, end)
            guard from < to else { return nil }
            return AudioSidecar.CameraSpan(at: UTCInstant.rfc3339(from), until: UTCInstant.rfc3339(to), device: span.device)
        }.sorted { ($0.at, $0.device) < ($1.at, $1.device) }
    }
}
