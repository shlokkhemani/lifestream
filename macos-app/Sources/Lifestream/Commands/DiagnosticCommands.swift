import Audio
import Evidence
import Foundation
import InputEvents
import MachineEvents
import Screen

@MainActor enum DiagnosticCommands {
    static func permissions(_ options: Options) async throws -> CommandOutcome {
        if options.request { Grant.requestMissing() }
        var held = Dictionary(uniqueKeysWithValues: await Grant.current().map { ($0.key.rawValue, $0.value) })
        held["notifications"] = await NotificationGrant.allowed()
        held["inputMonitoring"] = InputEventPermission.granted
        try writeJSONLine(held)
        return .succeeded
    }

    static func inputFocus(_ options: Options) throws -> CommandOutcome {
        var failure: Error?
        let heard = InputFocusProbe.run(limit: options.limit, modes: options.modes(try MacProcess.current.writing())) { line in
            guard failure == nil else { return }
            do { try writeJSONLine(line) } catch { failure = error }
        }
        if let failure { throw failure }
        guard heard else {
            try writeJSONLine(["inputMonitoring": false])
            return .failed
        }
        return .succeeded
    }

    static func selfTest() async throws -> CommandOutcome {
        let results = await CaptureDiagnostics.selfTest()
        try writeJSONLine(results)
        return results.values.contains(false) ? .failed : .succeeded
    }

    private struct AudioDecision: Encodable {
        let mic: String
        let sound: String
        let device: String?
        let chosen: String?
        let holders: [String]
        let players: [String]
    }

    static func audioWatch(_ options: Options) async throws -> CommandOutcome {
        let modes = options.modes(try MacProcess.current.writing())
        let watch = DeviceUseWatch(modes: modes)
        watch.start { read, lines in
            for line in lines { FileHandle.standardOutput.write(Data((line + "\n").utf8)) }
            func decide(_ track: AudioTrack) -> AudioPlan.Decision {
                AudioPlan.decide(track, use: read, modes: modes, running: true, heldBack: [],
                                 permission: AudioPermissions.status(track))
            }
            let mic = decide(.mic)
            var device: AudioSidecar.Device?
            if case .record(_, let recorded, _) = mic { device = recorded }
            let room = read.audio.map(AudioPlan.room)
            try? writeJSONLine(AudioDecision(mic: mic.word, sound: decide(.sound).word, device: device?.uid,
                                             chosen: device?.chosen, holders: room?.holders ?? [], players: room?.players ?? []))
        }
        try await Task.sleep(for: .seconds(options.duration ?? 365 * 24 * 3600))
        watch.stop()
        return .succeeded
    }

    static func audioTest(_ options: Options) async throws -> CommandOutcome {
        let track = options.track
        if AudioPermissions.status(track) == .undetermined {
            _ = await AudioPermissions.request(track)
        }
        guard AudioPermissions.granted(track) else {
            try writeJSONLine([track.rawValue: false])
            return .failed
        }
        let directory = options.outputURL ?? FileManager.default.temporaryDirectory
            .appendingPathComponent("lifestream-audio-test-\(UUID().uuidString)", isDirectory: true)
        defer { if options.outputURL == nil { try? FileManager.default.removeItem(at: directory) } }
        let seconds = options.duration ?? 10
        let plain = MacProcess.current.plain
        let result = try await Task.detached {
            try AudioDiagnostics.testRecording(track, seconds: seconds, into: directory, files: plain)
        }.value
        try writeJSONLine(TestLine(file: options.outputURL == nil ? nil : result.file.path, track: result.track.rawValue, device: result.device,
                                   seconds: result.seconds, bytes: result.bytes, bytesPerHour: result.bytesPerHour,
                                   latencyMs: result.latencyMs,
                                   chunksPerSecond: result.seconds > 0 ? Double(result.chunks) / result.seconds : 0,
                                   sampleRate: AudioFormat.sampleRate, codec: AudioFormat.codec))
        return result.bytes > 0 && result.seconds > 0 ? .succeeded : .failed
    }

    private struct TestLine: Encodable {
        let file: String?
        let track: String
        let device: String?
        let seconds: Double
        let bytes: Int
        let bytesPerHour: Int
        let latencyMs: Int?
        let chunksPerSecond: Double
        let sampleRate: Int
        let codec: String
    }
}

private extension AudioPlan.Decision {
    var word: String {
        switch self {
        case .record: return "record"
        case .idle(let state): return state.rawValue
        case .unknown: return "unknown"
        }
    }
}
