import DeviceFiles
import XCTest


import AVFoundation
import Evidence
@testable import Audio

final class AudioRecorderTests: XCTestCase {
    private var store: URL!
    private var source: FakeAudioSource!
    private var sound: FakeAudioSource!
    private var permission = AudioAuthorization.granted
    private var soundPermission = AudioAuthorization.granted
    private let t0 = Instants.date("2026-09-30T10:00:00.000Z")
    private var now = Instants.date("2026-09-30T10:00:00.000Z")
    private let zoom = "us.zoom.xos"
    private let chrome = "com.google.Chrome"

    override func setUpWithError() throws {
        store = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("audio-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: store, withIntermediateDirectories: true)
        source = FakeAudioSource()
        sound = FakeAudioSource()
        permission = .granted
        soundPermission = .granted
        now = t0
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: store)
    }

    private var folder: URL { store.appendingPathComponent(AudioSpool.directoryName) }

    private func recorder(modes: RecordingModes = .defaults, partLength: TimeInterval = 600,
                          fits: @escaping @Sendable () -> Bool = { true }) -> AudioRecorder {
        AudioRecorder(directory: store, files: DeviceFiles(.plain), scratch: store, modes: modes, sources: AudioSources(mic: source, sound: sound),
                      permission: { [unowned self] track in track == .mic ? permission : soundPermission },
                      partLength: partLength, clock: { [unowned self] in now }, fits: fits)
    }

    private func at(_ seconds: Double) -> Date { t0.addingTimeInterval(seconds) }

    private func sealed() -> [AudioSidecar] {
        AudioSpool.sealedRecordings(in: folder).map { stem in
            try! AudioSidecar.decode(Data(contentsOf: folder.appendingPathComponent(AudioSpool.sidecarName(stem))))
        }
    }

    private func room(_ at: String, _ holders: [String], _ players: [String] = []) -> AudioSidecar.Room {
        AudioSidecar.Room(at: at, room: AudioRoom(holders: holders, players: players, output: Uses.speakersAtHalf,
                                                  input: Uses.microphoneAtThreeQuarters))
    }

    private func files() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []).sorted()
    }

    private func session(_ recorder: AudioRecorder, seconds: Double, start: Double = 0.2, frame: Int = 0,
                         holders: [(String, AudioDeviceFacts?)]? = nil, leaveAt: Double? = nil) {
        recorder.update(Uses.use(at: at(0), holders: holders ?? [(zoom, Uses.microphone)]))
        recorder.waitUntilIdle()
        source.push(SyntheticAudio.chunks(seconds: seconds, from: frame, at: at(start)))
        recorder.waitUntilIdle()
        if let leaveAt {
            recorder.update(Uses.use(at: at(leaveAt)))
            recorder.waitUntilIdle()
        }
    }


    func testNothingIsRecordedBeforeStartOrAfterStop() {
        let recorder = recorder()
        recorder.update(Uses.use(at: t0, holders: [(zoom, Uses.microphone)]))
        recorder.waitUntilIdle()
        XCTAssertEqual(source.started, [], "a stopped recorder opens no device")
        XCTAssertEqual(recorder.status.mic, .stopped)

        recorder.start()
        XCTAssertEqual(source.started, [Uses.microphone.uid], "start follows the holder already there")
        XCTAssertEqual(recorder.status.mic, .recording)
        source.push(SyntheticAudio.chunks(seconds: 2, at: at(1)))
        recorder.stop()
        XCTAssertEqual(sealed().map(\.endedBy), ["recorder_stopped"], "stop returns after the file is sealed")
        XCTAssertFalse(source.capturing)

        recorder.update(Uses.use(at: at(5), holders: [(chrome, Uses.microphone)]))
        recorder.waitUntilIdle()
        XCTAssertEqual(source.started.count, 1)
        XCTAssertEqual(recorder.status, AudioStatus(mic: .stopped, sound: .stopped, files: 1))
    }

    func testAStopEndsTheSessionAsStoppedAndKeepsWhatWasRecorded() {
        let recorder = recorder()
        recorder.start()
        session(recorder, seconds: 2)
        XCTAssertEqual(recorder.micUse, .recording(holders: [zoom], since: at(0)))

        recorder.holdBack()
        recorder.waitUntilIdle()
        XCTAssertEqual(sealed().map(\.endedBy), ["stopped"], "the stop seals the file with its own ending")
        XCTAssertEqual(sealed().first?.audio?.durationMs ?? 0, 2_000, accuracy: 25, "what was recorded before the stop is kept")
        XCTAssertFalse(source.capturing)
        XCTAssertFalse(sound.capturing)
        XCTAssertEqual(recorder.status, AudioStatus(mic: .heldBack, sound: .heldBack, files: 1))
        XCTAssertEqual(recorder.micUse, .stopped(holders: [zoom]))

        recorder.update(Uses.use(at: at(5), holders: [(chrome, Uses.microphone), (zoom, Uses.microphone)]))
        recorder.waitUntilIdle()
        XCTAssertEqual(source.started.count, 1, "an app joining a stopped use records nothing")
    }

    func testAStopHoldsThroughAShortReleaseAndClearsAfterTheHold() {
        let recorder = recorder()
        recorder.start()
        session(recorder, seconds: 1)
        recorder.holdBack()
        recorder.waitUntilIdle()
        XCTAssertEqual(AudioRecorder.stopHold, 120)

        recorder.update(Uses.use(at: at(10)))
        recorder.update(Uses.use(at: at(10 + AudioRecorder.stopHold - 1), holders: [(zoom, Uses.microphone)]))
        recorder.waitUntilIdle()
        XCTAssertEqual(source.started.count, 1, "an app that lets go and takes the mic back stays stopped")
        XCTAssertEqual(recorder.status.mic, .heldBack)

        recorder.update(Uses.use(at: at(200)))
        recorder.update(Uses.use(at: at(200 + AudioRecorder.stopHold - 0.001)))
        recorder.waitUntilIdle()
        XCTAssertNil(recorder.micUse, "with no app on the mic, the menu says nothing")

        recorder.update(Uses.use(at: at(200 + AudioRecorder.stopHold), holders: [(zoom, Uses.microphone)]))
        recorder.waitUntilIdle()
        XCTAssertEqual(source.started.count, 2, "a use after the hold records")
        XCTAssertEqual(recorder.micUse, .recording(holders: [zoom], since: at(200 + AudioRecorder.stopHold)))
    }

    func testAnotherAppRecordsWhileTheStoppedAppIsOffTheMic() {
        let facetime = "com.apple.FaceTime"
        let recorder = recorder()
        recorder.start()
        session(recorder, seconds: 1)
        recorder.holdBack()
        recorder.update(Uses.use(at: at(10)))
        recorder.update(Uses.use(at: at(20), holders: [(facetime, Uses.microphone)]))
        recorder.waitUntilIdle()
        XCTAssertEqual(source.started.count, 2, "a hold on Zoom never stops FaceTime")
        XCTAssertEqual(recorder.status.mic, .recording)
        XCTAssertEqual(recorder.micUse, .recording(holders: [facetime], since: at(20)), "the menu names what records, and offers Stop")

        recorder.update(Uses.use(at: at(30), holders: [(facetime, Uses.microphone), (zoom, Uses.microphone)]))
        recorder.waitUntilIdle()
        XCTAssertEqual(recorder.status, AudioStatus(mic: .heldBack, sound: .heldBack, files: 1))
        XCTAssertEqual(recorder.micUse, .stopped(holders: [zoom]), "only the held-back app is named")
    }

    func testEachHoldClearsOnItsOwnAppsTimeOffTheMic() {
        let filter = "com.example.noise-filter"
        let recorder = recorder()
        recorder.start()
        session(recorder, seconds: 1)
        recorder.holdBack()
        recorder.update(Uses.use(at: at(5), holders: [(zoom, Uses.microphone), (filter, Uses.microphone)]))
        recorder.update(Uses.use(at: at(10), holders: [(filter, Uses.microphone)]))
        recorder.waitUntilIdle()
        XCTAssertEqual(source.started.count, 2, "the filter alone records: it was never stopped")

        recorder.update(Uses.use(at: at(10 + AudioRecorder.stopHold - 1), holders: [(filter, Uses.microphone), (zoom, Uses.microphone)]))
        recorder.waitUntilIdle()
        XCTAssertEqual(recorder.status.mic, .heldBack, "Zoom back within its hold is still stopped")
        recorder.update(Uses.use(at: at(200), holders: [(filter, Uses.microphone)]))
        recorder.update(Uses.use(at: at(200 + AudioRecorder.stopHold), holders: [(filter, Uses.microphone), (zoom, Uses.microphone)]))
        recorder.waitUntilIdle()
        XCTAssertEqual(recorder.status.mic, .recording, "Zoom's hold cleared though the filter never left the mic")
        XCTAssertEqual(recorder.micUse, .recording(holders: [filter, zoom].sorted(), since: at(200)))
    }

    func testAHoldOutlivesTheRecorderAndLeavesNoFileOnceCleared() {
        let holds = store.appendingPathComponent(AudioHolds.fileName)
        let first = recorder()
        first.start()
        session(first, seconds: 1)
        first.holdBack()
        first.waitUntilIdle()
        XCTAssertTrue(FileManager.default.fileExists(atPath: holds.path), "the stop is saved at once")
        first.stop()

        now = at(50)
        let second = recorder()
        second.start()
        second.update(Uses.use(at: at(50 + AudioRecorder.stopHold - 1), holders: [(zoom, Uses.microphone)]))
        second.waitUntilIdle()
        XCTAssertEqual(source.started.count, 1, "a relaunch never resumes a stopped use")
        XCTAssertEqual(second.micUse, .stopped(holders: [zoom]))
        second.update(Uses.use(at: at(200)))
        second.stop()

        let third = recorder()
        third.start()
        third.update(Uses.use(at: at(200 + AudioRecorder.stopHold), holders: [(zoom, Uses.microphone)]))
        third.waitUntilIdle()
        XCTAssertEqual(source.started.count, 2, "the hold saved off the mic clears by its own time")
        XCTAssertFalse(FileManager.default.fileExists(atPath: holds.path), "a cleared hold leaves no file")
    }

    func testStopIsOfferedWhenOnlyTheOtherSideRecords() {
        permission = .denied
        let recorder = recorder()
        recorder.start()
        recorder.update(Uses.use(at: at(0), holders: [(zoom, Uses.microphone)]))
        recorder.waitUntilIdle()
        XCTAssertEqual(recorder.status, AudioStatus(mic: .permissionRequired, sound: .recording))
        XCTAssertEqual(recorder.micUse, .recording(holders: [zoom], since: at(0)))

        recorder.holdBack()
        recorder.waitUntilIdle()
        XCTAssertFalse(sound.capturing)
        XCTAssertEqual(recorder.status, AudioStatus(mic: .heldBack, sound: .heldBack))
        XCTAssertEqual(recorder.micUse, .stopped(holders: [zoom]))
    }

    func testAStartWithNoHolderIsIdle() {
        let recorder = recorder()
        recorder.start()
        recorder.update(Uses.use(at: t0))
        recorder.waitUntilIdle()
        XCTAssertEqual(recorder.status, AudioStatus(mic: .idle, sound: .idle))
        XCTAssertEqual(source.started, [], "a device opened with no holder")
    }

    func testAHolderNotRecordedInFullWithholdsTheMicrophone() {
        let recorder = recorder(modes: RecordingModes(activity: [zoom]))
        recorder.start()
        recorder.update(Uses.use(at: t0, holders: [(zoom, Uses.microphone)]))
        recorder.waitUntilIdle()
        XCTAssertEqual(source.started, [], "an activity-mode holder is never recorded")
        XCTAssertEqual(recorder.status.mic, .withheld)

        recorder.update(Uses.use(at: at(1), holders: [(chrome, Uses.microphone), (zoom, Uses.microphone)]))
        recorder.waitUntilIdle()
        XCTAssertEqual(source.started, [], "one withheld holder withholds the room from every other")

        recorder.setModes(RecordingModes())
        recorder.waitUntilIdle()
        XCTAssertEqual(source.started.count, 1)
        source.push(SyntheticAudio.chunks(seconds: 1, at: at(2)))
        recorder.setModes(RecordingModes(exclude: [chrome]))
        recorder.waitUntilIdle()
        XCTAssertEqual(sealed().map(\.endedBy), ["withheld"], "a holder newly excluded ends the file at once")
        XCTAssertFalse(source.capturing)
    }

    func testADefaultDeviceNobodyRunsIsNeverOpened() {
        let recorder = recorder()
        recorder.start()
        recorder.update(Uses.use(at: t0, holders: [(zoom, nil)], defaultRunning: false))
        recorder.waitUntilIdle()
        XCTAssertEqual(source.started, [])
        XCTAssertEqual(recorder.status.mic, .withheld)
    }

    func testTheDefaultDeviceIsUsedOnlyWhileRunningAndSaysSo() {
        let recorder = recorder()
        recorder.start()
        recorder.update(Uses.use(at: t0, holders: [(zoom, nil)], input: Uses.headset, defaultRunning: true))
        recorder.waitUntilIdle()
        XCTAssertEqual(source.started, [Uses.headset.uid])
        source.push(SyntheticAudio.chunks(seconds: 1, at: at(0.3)))
        recorder.stop()
        let device = sealed().first?.device
        XCTAssertEqual(device?.chosen, "default")
        XCTAssertEqual(device?.uid, Uses.headset.uid)
        XCTAssertEqual(device?.transport, "bluetooth")
    }

    func testMissingPermissionRecordsNothing() {
        permission = .undetermined
        let recorder = recorder()
        recorder.start()
        recorder.update(Uses.use(at: t0, holders: [(zoom, Uses.microphone)]))
        recorder.waitUntilIdle()
        XCTAssertEqual(source.started, [])
        XCTAssertEqual(recorder.status.mic, .permissionRequired)
    }

    func testASourceThatFailsToStartLeavesNothingAndRetries() {
        let recorder = recorder()
        recorder.start()
        source.failNextStart = true
        recorder.update(Uses.use(at: t0, holders: [(zoom, Uses.microphone)]))
        recorder.waitUntilIdle()
        XCTAssertEqual(recorder.status.mic, .failed)
        XCTAssertEqual(files(), [])
        recorder.setModes(.defaults)
        recorder.waitUntilIdle()
        XCTAssertEqual(source.started.count, 1, "nothing retries until the devices change")

        recorder.update(Uses.use(at: at(1), holders: [(zoom, Uses.microphone)]))
        recorder.waitUntilIdle()
        XCTAssertEqual(source.started.count, 2, "the next device read tries again")
        XCTAssertEqual(recorder.status.mic, .recording)

        source.push(SyntheticAudio.chunks(seconds: 1, at: at(1.2)))
        source.breakCapture()
        recorder.waitUntilIdle()
        XCTAssertEqual(sealed().map(\.endedBy), ["failed"], "a capture that breaks seals what it holds")
        XCTAssertEqual(recorder.status.mic, .failed)
    }

    func testAFullDiskRecordsNothingAndRoomAgainRecords() {
        let space = Space(false)
        let recorder = recorder(fits: { space.fits })
        recorder.start()
        session(recorder, seconds: 1)
        XCTAssertEqual(files(), [], "not a sample written while the disk is full")
        XCTAssertEqual(recorder.status.mic, .failed)

        space.fits = true
        recorder.update(Uses.use(at: at(2), holders: [(zoom, Uses.microphone)]))
        recorder.waitUntilIdle()
        source.push(SyntheticAudio.chunks(seconds: 1, at: at(2.2)))
        recorder.update(Uses.use(at: at(4)))
        recorder.waitUntilIdle()
        XCTAssertEqual(sealed().map(\.endedBy), ["holders_gone"], "room again: the next device read records")
    }

    func testAnUnreadableReadKeepsTheSession() {
        let recorder = recorder()
        recorder.start()
        session(recorder, seconds: 1)
        recorder.update(Uses.unreadable(at: at(2)))
        recorder.waitUntilIdle()
        XCTAssertTrue(source.capturing, "a read that failed is not a holder leaving")
        XCTAssertEqual(sealed(), [])
    }


    func testASessionWithNoSampleLeavesNoFile() {
        let recorder = recorder()
        recorder.start()
        session(recorder, seconds: 0, leaveAt: 3)
        XCTAssertEqual(files(), [])
        XCTAssertEqual(recorder.status.mic, .idle)
    }

    func testALongSessionIsSplitIntoContiguousParts() {
        let recorder = recorder(partLength: 2)
        recorder.start()
        session(recorder, seconds: 5, start: 0.25, leaveAt: 6)
        let parts = sealed()
        XCTAssertEqual(parts.map(\.part), [1, 2, 3])
        XCTAssertEqual(parts.map(\.endedBy), ["part_limit", "part_limit", "holders_gone"])
        XCTAssertEqual(parts.first?.at, "2026-09-30T10:00:00.250Z")
        XCTAssertEqual(parts.last?.until, "2026-09-30T10:00:05.250Z")
        for (earlier, later) in zip(parts, parts.dropFirst()) {
            XCTAssertEqual(earlier.until, later.at, "one part ends where the next begins")
        }
        XCTAssertEqual(parts.map(\.latencyMs), [250, nil, nil], "what was missed is stated once, on part 1")
        XCTAssertEqual(parts.map(\.session), Array(repeating: "20260930T100000.250Z.mic", count: 3),
                       "every part names its session by part 1's stem")
        XCTAssertEqual(parts.map { $0.loudness?.rmsDbfs.count }, [2, 2, 1], "each file measures only its own seconds")
        XCTAssertEqual(Set(parts.map(\.detectedAt)), ["2026-09-30T10:00:00.000Z"])
        let total = parts.compactMap(\.audio?.durationMs).reduce(0, +)
        XCTAssertEqual(total, 5_000, accuracy: 5)
    }

    func testHoldersLeavingSealTheFile() {
        let recorder = recorder()
        recorder.start()
        session(recorder, seconds: 2, leaveAt: 3)
        XCTAssertEqual(sealed().map(\.endedBy), ["holders_gone"])
        XCTAssertFalse(source.capturing)
        XCTAssertEqual(recorder.status, AudioStatus(mic: .idle, sound: .idle, files: 1))
    }

    func testAHolderJoiningIsStatedAndADeviceChangeStartsANewSession() {
        let recorder = recorder()
        recorder.start()
        session(recorder, seconds: 2)
        recorder.update(Uses.use(at: at(1.5), holders: [(chrome, Uses.microphone), (zoom, Uses.microphone)]))
        recorder.waitUntilIdle()
        recorder.update(Uses.use(at: at(3), holders: [(zoom, Uses.headset)]))
        recorder.waitUntilIdle()
        XCTAssertEqual(source.started, [Uses.microphone.uid, Uses.headset.uid])
        source.push(SyntheticAudio.chunks(seconds: 1, from: 100_000, at: at(3.2)))
        recorder.stop()

        let files = sealed()
        XCTAssertEqual(files.map(\.endedBy), ["device_changed", "recorder_stopped"])
        XCTAssertEqual(files[0].room, [
            room("2026-09-30T10:00:00.200Z", [zoom]),
            room("2026-09-30T10:00:01.500Z", [chrome, zoom]),
        ])
        XCTAssertEqual(files[1].part, 1, "a new device is a new session")
        XCTAssertEqual(files[1].device?.uid, Uses.headset.uid)
        XCTAssertEqual(files[1].latencyMs, 200)
    }

    func testCameraSpansAreClippedToTheFile() {
        let recorder = recorder()
        recorder.start()
        recorder.update(Uses.use(at: at(-5), holders: [], cameras: [Uses.camera]))
        recorder.update(Uses.use(at: at(0), holders: [(zoom, Uses.microphone)], cameras: [Uses.camera]))
        recorder.waitUntilIdle()
        source.push(SyntheticAudio.chunks(seconds: 3, at: at(0.2)))
        recorder.update(Uses.use(at: at(2), holders: [(zoom, Uses.microphone)], cameras: []))
        recorder.waitUntilIdle()
        recorder.stop()
        XCTAssertEqual(sealed().first?.camera, [
            AudioSidecar.CameraSpan(at: "2026-09-30T10:00:00.200Z", until: "2026-09-30T10:00:02.000Z",
                                         device: Uses.camera.uid),
        ])
    }

    func testEachSecondsLoudnessIsStated() throws {
        let recorder = recorder()
        recorder.start()
        session(recorder, seconds: 2)
        source.push(SyntheticAudio.silence(seconds: 1.5, from: 32_000, at: at(2.2)))
        recorder.waitUntilIdle()
        recorder.update(Uses.use(at: at(4)))
        recorder.waitUntilIdle()
        let loudness = try XCTUnwrap(sealed().first?.loudness)
        XCTAssertEqual(loudness.everyMs, 1_000)
        XCTAssertEqual(loudness.rmsDbfs.count, 4, "3.5 seconds are four values, the last one half a second")
        XCTAssertEqual(loudness.peakDbfs.count, 4)
        for second in 0..<2 {
            XCTAssertTrue((-30)...(-10) ~= loudness.rmsDbfs[second], "speech-shaped audio: \(loudness.rmsDbfs)")
            XCTAssertGreaterThan(loudness.peakDbfs[second], loudness.rmsDbfs[second])
        }
        XCTAssertEqual(Array(loudness.rmsDbfs.suffix(2)), [-96, -96], "digital silence is the floor")
        XCTAssertEqual(Array(loudness.peakDbfs.suffix(2)), [-96, -96])
    }

    func testTheDeviceLevelsAroundTheRecordingAreStated() throws {
        let recorder = recorder()
        recorder.start()
        recorder.update(Uses.use(at: at(0), holders: [(zoom, Uses.microphone)], inputVolume: 0.24))
        recorder.waitUntilIdle()
        source.push(SyntheticAudio.chunks(seconds: 3, at: at(0.2)))
        recorder.waitUntilIdle()
        recorder.update(Uses.use(at: at(1), holders: [(zoom, Uses.microphone)], inputVolume: 0.6))
        let headphones = DeviceLevel(device: Uses.headset, volume: 0.3, muted: false)
        recorder.update(Uses.use(at: at(2), holders: [(zoom, Uses.microphone)], inputVolume: 0.6, output: headphones))
        recorder.waitUntilIdle()
        recorder.stop()
        let entries = try XCTUnwrap(sealed().first?.room)
        XCTAssertEqual(entries.map(\.at), ["2026-09-30T10:00:00.200Z", "2026-09-30T10:00:01.000Z", "2026-09-30T10:00:02.000Z"],
                       "a change of level alone is an entry")
        XCTAssertEqual(entries.map(\.input.volume), [0.24, 0.6, 0.6])
        XCTAssertEqual(entries.map { $0.output.device?.uid }, [Uses.speakers.uid, Uses.speakers.uid, Uses.headset.uid])
        XCTAssertEqual(entries.last?.output.device?.name, "Synthetic Headset")
        XCTAssertEqual(entries.last?.output.device?.transport, "bluetooth")
        XCTAssertEqual(entries.last?.output.volume, 0.3)
        XCTAssertEqual(entries.last?.output.muted, false)
        XCTAssertEqual(sealed().count, 1, "a level change never ends the file")
    }

    func testTheSidecarDescribesTheAudioBesideIt() throws {
        let recorder = recorder()
        recorder.start()
        session(recorder, seconds: 3, leaveAt: 4)
        let stem = try XCTUnwrap(AudioSpool.sealedRecordings(in: folder).first)
        let sidecar = try XCTUnwrap(sealed().first)
        let audio = folder.appendingPathComponent(AudioSpool.audioName(stem))
        let measured = try RecordingFolder.measure(audio, files: DeviceFiles(.plain))
        XCTAssertEqual(stem, "20260930T100000.200Z.mic", "a recording is named by its first sample and its track")
        XCTAssertEqual(sidecar.audio, AudioSidecar.Audio(
            file: "\(stem).m4a", mediaType: "audio/mp4", codec: "aac", sampleRate: 16_000, channels: 1,
            bitRate: 32_000, durationMs: 3_000, bytes: measured.bytes, sha256: measured.sha256))
        XCTAssertEqual(Double(try AVAudioFile(forReading: audio).length) / 16_000, 3, accuracy: 0.1)
        XCTAssertEqual(sidecar.device, AudioSidecar.Device(uid: Uses.microphone.uid, name: "Synthetic Microphone",
                                                               transport: "built_in", chosen: "holder"))
        XCTAssertFalse(files().contains { $0.hasSuffix(".open.json") }, "a sealed recording leaves no open sidecar")

        let text = try String(contentsOf: folder.appendingPathComponent("\(stem).json"), encoding: .utf8)
        XCTAssertTrue(text.hasPrefix("{\"at\":\"2026-09-30T10:00:00.200Z\",\"audio\":{\"bit_rate\":32000,\"bytes\":"), text)
        XCTAssertTrue(text.hasSuffix(",\"part\":1,\"room\":[{\"at\":\"2026-09-30T10:00:00.200Z\",\"holders\":[\"us.zoom.xos\"],"
            + "\"input\":{\"device\":{\"name\":\"Synthetic Microphone\",\"transport\":\"built_in\",\"uid\":\"synthetic-input-uid\"},\"muted\":false,\"volume\":0.75},"
            + "\"output\":{\"device\":{\"name\":\"Synthetic Speakers\",\"transport\":\"built_in\",\"uid\":\"synthetic-output-uid\"},\"muted\":false,\"volume\":0.5},"
            + "\"players\":[]}],\"session\":\"20260930T100000.200Z.mic\",\"track\":\"mic\",\"until\":\"2026-09-30T10:00:03.200Z\"}\n"), text)
        XCTAssertTrue(text.contains(",\"loudness\":{\"every_ms\":1000,\"peak_dbfs\":["), text)
    }

    func testTwoFilesStartingInOneMillisecondBothSurvive() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let first = AudioSpool.freshStem(for: t0, track: .mic, in: folder)
        try Data().write(to: folder.appendingPathComponent(AudioSpool.audioName(first)))
        XCTAssertEqual(first, "20260930T100000.000Z.mic")
        XCTAssertEqual(AudioSpool.freshStem(for: t0, track: .mic, in: folder), "20260930T100000.000Z.mic-2")
        XCTAssertEqual(AudioSpool.freshStem(for: t0, track: .sound, in: folder), "20260930T100000.000Z.sound",
                       "the other track never collides")
        XCTAssertEqual(AudioSpool.instant(ofStem: "20260930T100000.000Z.mic-2"), t0)
    }

    func testACrashedFileIsRecoveredOrParked() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let crashed = "20260930T090000.000Z.mic"
        let writer = try AudioSegmentWriter(url: folder.appendingPathComponent(AudioSpool.audioName(crashed)))
        for chunk in SyntheticAudio.chunks(seconds: 25, at: t0) { try writer.append(chunk) }
        Self.abandoned.append(writer)
        var open = AudioSidecar(at: "2026-09-30T09:00:00.000Z", until: nil, track: .mic,
                                detectedAt: "2026-09-30T08:59:59.800Z", latencyMs: 200, part: 1, endedBy: nil,
                                device: .init(uid: Uses.microphone.uid, name: nil, transport: "built_in", chosen: "holder"),
                                room: [room("2026-09-30T09:00:00.000Z", [zoom])], camera: [], audio: nil, session: crashed)
        try open.encoded().write(to: folder.appendingPathComponent(AudioSpool.openName(crashed)))
        let torn = "20260930T093000.000Z.mic"
        try Data("not audio".utf8).write(to: folder.appendingPathComponent(AudioSpool.audioName(torn)))
        open.at = "2026-09-30T09:30:00.000Z"
        try open.encoded().write(to: folder.appendingPathComponent(AudioSpool.openName(torn)))
        try Data("orphan".utf8).write(to: folder.appendingPathComponent("20260930T094500.000Z.mic.m4a"))
        try until("AudioSegmentWriter.readableSeconds(folder.appendingPathComponent(AudioSpool.audioName(crashed))) >= 10") { AudioSegmentWriter.readableSeconds(folder.appendingPathComponent(AudioSpool.audioName(crashed))) >= 10 }

        recorder().start()
        let recovered = try XCTUnwrap(sealed().first)
        XCTAssertEqual(sealed().count, 1)
        XCTAssertEqual(recovered.endedBy, "interrupted")
        XCTAssertEqual(recovered.latencyMs, 200)
        XCTAssertEqual(recovered.session, crashed, "recovery keeps what the open sidecar stated")
        XCTAssertNil(recovered.loudness, "a crash leaves samples nobody measured")
        XCTAssertGreaterThanOrEqual(recovered.audio?.durationMs ?? 0, 10_000)
        XCTAssertEqual(files(), [
            "20260930T090000.000Z.mic.json", "20260930T090000.000Z.mic.m4a",
            "20260930T093000.000Z.mic.m4a.torn", "20260930T093000.000Z.mic.open.json.torn",
            "20260930T094500.000Z.mic.m4a.torn",
        ])
    }

    func testTheSealedListHoldsOnlyWholePairs() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for name in ["a.json", "a.m4a", "b.open.json", "b.m4a", "c.json", "d.m4a.torn", "d.json"] {
            try Data().write(to: folder.appendingPathComponent(name))
        }
        XCTAssertEqual(AudioSpool.sealedRecordings(in: folder), ["a"])
    }


    private let aqua = "com.example.dictation"

    func testEveryUseOfTheMicrophoneRecordsBothTracks() {
        let recorder = recorder()
        recorder.start()
        recorder.update(Uses.use(at: t0, holders: [(aqua, Uses.microphone)], players: [chrome]))
        recorder.waitUntilIdle()
        XCTAssertEqual(source.started, [Uses.microphone.uid])
        XCTAssertEqual(sound.started, ["sound"], "dictation over another app's music records the music too")
        XCTAssertEqual(recorder.status, AudioStatus(mic: .recording, sound: .recording))
        recorder.stop()

        let silent = self.recorder()
        silent.start()
        silent.update(Uses.use(at: at(5), holders: [(aqua, Uses.microphone)]))
        silent.waitUntilIdle()
        XCTAssertEqual(silent.status, AudioStatus(mic: .recording, sound: .recording),
                       "a holder that plays nothing still records the Mac's sound")
    }

    func testACallRecordsBothSidesInTwoFilesOnOneClock() throws {
        let recorder = recorder()
        recorder.start()
        recorder.update(Uses.use(at: t0, holders: [(zoom, Uses.microphone)], players: [zoom]))
        recorder.waitUntilIdle()
        XCTAssertEqual(sound.started, ["sound"])
        XCTAssertEqual(recorder.status, AudioStatus(mic: .recording, sound: .recording))
        source.push(SyntheticAudio.chunks(seconds: 3, at: at(0.2)))
        sound.push(SyntheticAudio.chunks(seconds: 3, from: 7_000, at: at(0.15)))
        recorder.waitUntilIdle()
        recorder.update(Uses.use(at: at(1.5), holders: [(zoom, Uses.microphone)], players: [chrome, zoom]))
        recorder.waitUntilIdle()
        recorder.update(Uses.use(at: at(4)))
        recorder.waitUntilIdle()

        let stems = AudioSpool.sealedRecordings(in: folder)
        XCTAssertEqual(stems, ["20260930T100000.150Z.sound", "20260930T100000.200Z.mic"])
        let byTrack = Dictionary(uniqueKeysWithValues: sealed().map { ($0.track, $0) })
        let mic = try XCTUnwrap(byTrack[.mic]), played = try XCTUnwrap(byTrack[.sound])
        XCTAssertEqual(mic.until, "2026-09-30T10:00:03.200Z")
        XCTAssertEqual(played.until, "2026-09-30T10:00:03.150Z", "each track keeps its own first sample")
        XCTAssertEqual(played.latencyMs, 150)
        XCTAssertNil(played.device, "the Mac's sound comes from no one device")
        XCTAssertEqual(played.endedBy, "holders_gone")
        XCTAssertEqual(played.room, [
            room("2026-09-30T10:00:00.150Z", [zoom], [zoom]),
            room("2026-09-30T10:00:01.500Z", [zoom], [chrome, zoom]),
        ])
        XCTAssertEqual(mic.room.last?.players, [chrome, zoom], "the microphone states who played too")
    }

    func testEachTrackWaitsForItsOwnPermission() {
        soundPermission = .undetermined
        let recorder = recorder()
        recorder.start()
        recorder.update(Uses.use(at: t0, holders: [(zoom, Uses.microphone)], players: [zoom]))
        recorder.waitUntilIdle()
        XCTAssertEqual(recorder.status, AudioStatus(mic: .recording, sound: .permissionRequired))
        XCTAssertEqual(sound.started, [], "a tap without its permission records silence, so none starts")
        recorder.stop()

        permission = .denied
        soundPermission = .granted
        let second = self.recorder()
        second.start()
        second.update(Uses.use(at: at(5), holders: [(zoom, Uses.microphone)], players: [zoom]))
        second.waitUntilIdle()
        XCTAssertEqual(second.status, AudioStatus(mic: .permissionRequired, sound: .recording))
    }

    func testAPlayerNotRecordedInFullWithholdsTheSound() {
        let banking = "com.example.bank"
        let recorder = recorder(modes: RecordingModes(exclude: [banking]))
        recorder.start()
        recorder.update(Uses.use(at: t0, holders: [(zoom, Uses.microphone)], players: [zoom]))
        recorder.waitUntilIdle()
        sound.push(SyntheticAudio.chunks(seconds: 1, at: at(0.1)))
        recorder.update(Uses.use(at: at(2), holders: [(zoom, Uses.microphone)], players: [banking, zoom]))
        recorder.waitUntilIdle()
        XCTAssertEqual(recorder.status, AudioStatus(mic: .recording, sound: .withheld, files: 1))
        XCTAssertFalse(sound.capturing)
        XCTAssertEqual(sealed().map(\.endedBy), ["withheld"], "the sound ends the moment an excluded app plays")
        XCTAssertTrue(source.capturing, "the person's own voice is still recorded")
    }

    func testPlayersComingAndGoingNeverEndTheSound() {
        let recorder = recorder()
        recorder.start()
        recorder.update(Uses.use(at: t0, holders: [(zoom, Uses.microphone)], players: [zoom]))
        recorder.waitUntilIdle()
        source.push(SyntheticAudio.chunks(seconds: 2, at: at(0.2)))
        sound.push(SyntheticAudio.chunks(seconds: 2, at: at(0.2)))
        recorder.update(Uses.use(at: at(2.5), holders: [(zoom, Uses.microphone)]))
        recorder.waitUntilIdle()
        XCTAssertEqual(sealed().count, 0, "nobody playing is the Mac's silence, recorded like its sound")
        XCTAssertTrue(sound.capturing)
        XCTAssertEqual(recorder.status, AudioStatus(mic: .recording, sound: .recording))
        recorder.update(Uses.use(at: at(3)))
        recorder.waitUntilIdle()
        XCTAssertEqual(sealed().map(\.endedBy), ["holders_gone", "holders_gone"])
    }

    func testOnlyRecordingsOlderThanEveryOpenOneShip() {
        let recorder = recorder(partLength: 1)
        recorder.start()
        recorder.update(Uses.use(at: t0, holders: [(zoom, Uses.microphone)], players: [zoom]))
        recorder.waitUntilIdle()
        sound.push(SyntheticAudio.chunks(seconds: 0.5, at: at(0.1)))
        source.push(SyntheticAudio.chunks(seconds: 2.5, at: at(0.2)))
        recorder.waitUntilIdle()
        XCTAssertEqual(AudioSpool.sealedRecordings(in: folder), ["20260930T100000.200Z.mic", "20260930T100001.200Z.mic"])
        XCTAssertEqual(AudioSpool.shippableRecordings(in: folder), [],
                       "nothing newer than the open sound part ships before it")
        recorder.stop()
        XCTAssertEqual(AudioSpool.shippableRecordings(in: folder), [
            "20260930T100000.100Z.sound", "20260930T100000.200Z.mic", "20260930T100001.200Z.mic",
            "20260930T100002.200Z.mic",
        ])
    }


    func testASlowSealLosesNoMicrophoneAudio() throws {
        let microphone = PooledMicrophone(buffers: 4, frames: AudioFormat.sampleRate / 10)
        let recorder = AudioRecorder(directory: store, files: DeviceFiles(.plain), scratch: store, modes: .defaults, sources: AudioSources(mic: microphone, sound: sound),
                                     permission: { _ in .granted }, partLength: 2, clock: { [t0] in t0 })
        let sealing = DispatchSemaphore(value: 0), resume = DispatchSemaphore(value: 0)
        var stalled = false
        let prefix = folder.path
        DeviceFiles.flushObserver = { url, _ in
            guard url.path.hasPrefix(prefix), url.pathExtension == "m4a", !stalled else { return }
            stalled = true
            sealing.signal()
            resume.wait()
        }
        defer { DeviceFiles.flushObserver = nil }
        recorder.start()
        recorder.update(Uses.use(at: t0, holders: [(zoom, Uses.microphone)]))
        recorder.waitUntilIdle()

        microphone.play(seconds: 2.1, from: 0)
        XCTAssertEqual(sealing.wait(timeout: .now() + waitLimit), .success, "part 1 seals once 2 s are in")
        microphone.play(seconds: 1.5, from: 33_600)
        resume.signal()
        recorder.update(Uses.use(at: at(10)))
        recorder.waitUntilIdle()
        recorder.stop()

        XCTAssertEqual(microphone.dropped, 0, "no buffer was held while the seal ran")
        let parts = sealed()
        XCTAssertEqual(parts.map(\.endedBy), ["part_limit", "holders_gone"])
        XCTAssertEqual(parts.compactMap(\.audio?.durationMs).reduce(0, +), 3_600, accuracy: 5)
        for stem in AudioSpool.sealedRecordings(in: folder) {
            let sidecar = try XCTUnwrap(sealed().first { $0.audio?.file == AudioSpool.audioName(stem) })
            let held = Double(try AVAudioFile(forReading: folder.appendingPathComponent(AudioSpool.audioName(stem))).length)
            XCTAssertEqual(held / 16_000, Double(sidecar.audio?.durationMs ?? 0) / 1000, accuracy: 1_024.0 / 16_000,
                           "the file holds every second its sidecar states")
        }
    }

    func testAnIdleReadReadsNoPermission() {
        var reads = 0
        let recorder = AudioRecorder(directory: store, files: DeviceFiles(.plain), scratch: store, modes: .defaults, sources: AudioSources(mic: source, sound: sound),
                                     permission: { _ in reads += 1; return .granted }, clock: { [t0] in t0 })
        recorder.start()
        for second in 0..<5 {
            recorder.update(Uses.use(at: at(Double(second)), players: [chrome], cameras: second.isMultiple(of: 2) ? [Uses.camera] : []))
        }
        recorder.waitUntilIdle()
        XCTAssertEqual(reads, 0, "nobody holds the microphone, so no permission is read")
        recorder.update(Uses.use(at: at(6), holders: [(zoom, Uses.microphone)]))
        recorder.waitUntilIdle()
        XCTAssertEqual(reads, 2, "one read per track once someone holds it")
        recorder.stop()
    }

    private static var abandoned: [AudioSegmentWriter] = []
}

final class Space: @unchecked Sendable {
    private let lock = NSLock()
    private var held: Bool

    init(_ fits: Bool) { held = fits }

    var fits: Bool {
        get { lock.withLock { held } }
        set { lock.withLock { held = newValue } }
    }
}
