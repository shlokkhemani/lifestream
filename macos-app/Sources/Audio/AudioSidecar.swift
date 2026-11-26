import Evidence
import Foundation

public struct AudioSidecar: Codable, Equatable, Sendable {
    public var at: String
    public var until: String?
    public var track: AudioTrack
    public var detectedAt: String
    public var latencyMs: Int?
    public var part: Int
    public var endedBy: String?
    public var device: Device?
    public var room: [Room]
    public var camera: [CameraSpan]
    public var audio: Audio?
    public var session: String
    public var loudness: Loudness?

    public struct Device: Codable, Equatable, Sendable {
        public var uid: String
        public var name: String?
        public var transport: String
        public var chosen: String
    }

    public struct Room: Codable, Equatable, Sendable {
        public var at: String
        public var holders: [String]
        public var players: [String]
        public var output: Level
        public var input: Level

        init(at: String, room: AudioRoom) {
            self.at = at
            holders = room.holders
            players = room.players
            output = Level(room.output)
            input = Level(room.input)
        }
    }

    public struct Level: Codable, Equatable, Sendable {
        public var device: LevelDevice?
        public var volume: Double?
        public var muted: Bool?

        init(_ level: DeviceLevel) {
            device = level.device.map { LevelDevice(uid: $0.uid, name: $0.name, transport: $0.transport) }
            volume = level.volume
            muted = level.muted
        }
    }

    public struct LevelDevice: Codable, Equatable, Sendable {
        public var uid: String
        public var name: String?
        public var transport: String
    }

    public struct Loudness: Codable, Equatable, Sendable {
        public var everyMs: Int
        public var rmsDbfs: [Int]
        public var peakDbfs: [Int]

        enum CodingKeys: String, CodingKey {
            case everyMs = "every_ms"
            case rmsDbfs = "rms_dbfs"
            case peakDbfs = "peak_dbfs"
        }
    }

    public struct CameraSpan: Codable, Equatable, Sendable {
        public var at: String
        public var until: String
        public var device: String
    }

    public struct Audio: Codable, Equatable, Sendable {
        public var file: String
        public var mediaType: String
        public var codec: String
        public var sampleRate: Int
        public var channels: Int
        public var bitRate: Int
        public var durationMs: Int
        public var bytes: Int
        public var sha256: String

        enum CodingKeys: String, CodingKey {
            case file, codec, channels, bytes, sha256
            case mediaType = "media_type"
            case sampleRate = "sample_rate"
            case bitRate = "bit_rate"
            case durationMs = "duration_ms"
        }
    }

    enum CodingKeys: String, CodingKey {
        case at, until, track, part, device, room, camera, audio, session, loudness
        case detectedAt = "detected_at"
        case latencyMs = "latency_ms"
        case endedBy = "ended_by"
    }

    public enum Ending: String, CaseIterable, Sendable {
        case holdersGone = "holders_gone"
        case partLimit = "part_limit"
        case recorderStopped = "recorder_stopped"
        case stopped
        case withheld
        case deviceChanged = "device_changed"
        case failed
        case interrupted
    }

    public func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self) + Data("\n".utf8)
    }

    public static func decode(_ data: Data) throws -> AudioSidecar {
        try JSONDecoder().decode(AudioSidecar.self, from: data)
    }
}
