import Audio
import DeviceFiles
import Evidence
import Foundation
import InputEvents
import MachineEvents
import Screen

extension Recorder {
    public static func live(configuration: RecorderConfiguration, directory: URL,
                            screen: ScreenCapture.Configuration, videoQuality: Double,
                            machineEvents: MachineEventSources, inputEvents: InputEventLog?,
                            audio: AudioRecorder? = nil, fits: (@Sendable () -> Bool)? = nil,
                            files: DeviceFiles, plain: DeviceFiles, scratch: URL,
                            onSegmentSettled: (@Sendable () -> Void)? = nil) -> Recorder {
        var dependencies = RecorderDependencies(
            acquisition: ScreenCapture(configuration: screen),
            machine: MachineEventsAdapter(events: machineEvents),
            input: inputEvents.map { InputEventsAdapter(log: $0) } ?? NoInputLog(),
            clock: SystemRecorderClock(),
            openStore: { try await CaptureStoreAdapter.open(directory: directory, files: files, scratch: scratch,
                                                            videoQuality: videoQuality, fits: fits,
                                                            onSegmentSettled: onSegmentSettled) },
            persistStatus: { status in try status.persist(in: directory, plain: plain) })
        dependencies.previous = try? RuntimeStatus.read(from: directory, plain: plain)
        if let audio {
            machineEvents.deviceUseChanged = { [audio] use in audio.update(use) }
            dependencies.audio = audio
        }
        let sources = LiveResources.sources()
        dependencies.resources = ResourceAccount(directory: directory, files: files, sources: sources)
        FailureLines.shared.configure(spool: directory, plain: plain, build: sources.build, pid: getpid())
        dependencies.holdActivity = { reason in
            let activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep, reason: reason)
            return { ProcessInfo.processInfo.endActivity(activity) }
        }
        dependencies.modes = screen.modes
        dependencies.persistModes = { modes in try modes.save(to: directory, files: files) }
        return Recorder(configuration: configuration, dependencies: dependencies)
    }
}

extension ScreenCapture: RecorderAcquisition {
    var screenRecordingAllowed: Bool { permissions().screenRecording }
    func invalidate() { invalidateCaches() }
    func setOCR(_ mode: OCRMode) { setRecognition(mode) }
}

struct SystemRecorderClock: RecorderClock {
    var uptime: Double { ProcessInfo.processInfo.systemUptime }
    var date: Date { Date() }
    func sleep(for seconds: Double) async throws { try await Task.sleep(for: .seconds(max(0, seconds))) }
}
