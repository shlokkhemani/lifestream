import Evidence
import Foundation

public enum AudioAuthorization: Sendable {
    case granted
    case denied
    case undetermined
}

public enum AudioPlan {
    public enum Decision: Equatable, Sendable {
        case record(AudioCapture, device: AudioSidecar.Device?, room: AudioRoom)
        case idle(AudioTrackState)
        case unknown
    }

    public static func decide(_ track: AudioTrack, use: DeviceUse?, modes: RecordingModes, running: Bool,
                              heldBack: Set<String>, permission: @autoclosure () -> AudioAuthorization) -> Decision {
        guard running else { return .idle(.stopped) }
        guard let use else { return .idle(.idle) }
        guard let audio = use.audio else { return .unknown }
        let holders = audio.microphone
        guard !holders.isEmpty else { return .idle(.idle) }
        guard !holders.contains(where: { heldBack.contains($0.app) }) else { return .idle(.heldBack) }
        guard holders.allSatisfy({ recorded($0, modes) }) else { return .idle(.withheld) }
        switch track {
        case .mic:
            guard permission() == .granted else { return .idle(.permissionRequired) }
            if let device = holders.compactMap(\.device).first { return microphone(device, chosen: "holder", in: audio) }
            if let device = audio.input.device, audio.defaultInputRunning { return microphone(device, chosen: "default", in: audio) }
            return .idle(.withheld)
        case .sound:
            guard audio.sound.allSatisfy({ recorded($0, modes) }) else { return .idle(.withheld) }
            guard permission() == .granted else { return .idle(.permissionRequired) }
            return .record(.sound, device: nil, room: room(audio))
        }
    }

    public static func room(_ audio: AudioUse) -> AudioRoom {
        AudioRoom(holders: audio.microphone.map(\.app), players: audio.sound.map(\.app),
                  output: audio.output, input: audio.input)
    }

    private static func microphone(_ device: AudioDeviceFacts, chosen: String, in audio: AudioUse) -> Decision {
        .record(.microphone(uid: device.uid),
                device: AudioSidecar.Device(uid: device.uid, name: device.name, transport: device.transport, chosen: chosen),
                room: room(audio))
    }

    private static func recorded(_ client: AudioClient, _ modes: RecordingModes) -> Bool {
        modes.mode(of: client.app) == .record && modes.mode(of: client.rawApp) == .record
    }
}

public struct AudioRoom: Equatable, Sendable {
    public let holders: [String]
    public let players: [String]
    public let output: DeviceLevel
    public let input: DeviceLevel

    public init(holders: [String], players: [String], output: DeviceLevel, input: DeviceLevel) {
        self.holders = Array(Set(holders)).sorted()
        self.players = Array(Set(players)).sorted()
        self.output = output
        self.input = input
    }
}

public enum AudioTrackState: String, Codable, CaseIterable, Sendable {
    case recording
    case idle
    case withheld
    case permissionRequired = "permission_required"
    case stopped
    case failed
    case heldBack = "held_back"
}
