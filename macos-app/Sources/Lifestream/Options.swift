import Audio
import Evidence
import DeviceFiles
import Foundation
import HomeLink
import InputEvents
import MachineEvents
import Recorder
import ResourceWatch
import Screen
import Shipping

struct Options {
    static let spool = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Lifestream Screen")

    var command: Command = .app
    var directory = Options.spool
    var interval: Double = 2
    var duration: Double?
    var limit = 100
    var since: Date?
    var launchExclusions: Set<String> = []
    var modeChange: (mode: RecordingMode, target: RecordingModeTarget)?
    var request = false
    var idleAfter: Double?
    var ocr: OCRMode = .exact
    var videoQuality: Double = 0.65
    var maximumHeight = 1440
    var allDisplays = false
    var outputURL: URL?
    var track: AudioTrack = .mic
    var inputURL: URL?
    var dashboardPort = 4317
    var homeName: String?
    var pairingCode: String?
    var inputLog = true
    var appBundle = Bundle.main.bundleURL
    var powerLog = ResourceWatch.systemPowerLog
    var job: HomeJob?
    var agentsOn: Bool?

    func screen(modes: RecordingModes) -> ScreenCapture.Configuration {
        ScreenCapture.Configuration(modes: modes, ocr: ocr, maximumHeight: maximumHeight,
                                    maximumDimension: 4096, allDisplays: allDisplays)
    }

    func modes(_ files: DeviceFiles) -> RecordingModes {
        RecordingModes.load(from: directory, files: files) { line in
            FileHandle.standardError.write(Data((line + "\n").utf8))
        }.excludingForThisRun(launchExclusions)
    }

    var recorder: RecorderConfiguration {
        RecorderConfiguration(interval: interval, duration: duration,
                              idlePauseAfter: command == .capture ? nil : idleAfter)
    }

    init(_ rawArguments: [String]) throws {
        let arguments = rawArguments.filter { !$0.hasPrefix("-psn_") }
        var commandName = Command.app.rawValue
        var index = 0
        if let first = arguments.first, !first.hasPrefix("--") {
            commandName = first
            index = 1
        }
        let named = commandName
        while index < arguments.count {
            let flag = arguments[index]
            switch flag {
            case "--request-permissions":
                request = true
            case "--no-input-log":
                inputLog = false
            case "--help":
                commandName = Command.help.rawValue
            default:
                guard index + 1 < arguments.count else { throw UsageError.message("Missing value for \(flag)") }
                try apply(flag, value: arguments[index + 1], under: named)
                index += 1
            }
            index += 1
        }
        guard let command = Command(rawValue: commandName) else {
            throw UsageError.message("Unknown command. Run Lifestream --help")
        }
        self.command = command
    }

    private mutating func apply(_ flag: String, value: String, under command: String) throws {
        switch flag {
        case "--displays":
            guard ["relevant", "all"].contains(value) else {
                throw UsageError.message("Displays must be relevant or all")
            }
            allDisplays = value == "all"
        case "--input":
            inputURL = URL(fileURLWithPath: value)
        case "--output":
            outputURL = URL(fileURLWithPath: value)
        case "--track":
            guard let track = AudioTrack(rawValue: value) else { throw UsageError.message("Track must be mic or sound") }
            self.track = track
        case "--max-height":
            guard let height = Int(value), height == 0 || (256...8192).contains(height) else {
                throw UsageError.message("Maximum height must be zero for native size, or 256–8192 pixels")
            }
            maximumHeight = height
        case "--ocr":
            guard let mode = OCRMode(rawValue: value) else {
                throw UsageError.message("OCR mode must be always or exact")
            }
            ocr = mode
        case "--video-quality":
            guard let quality = Double(value), quality.isFinite, (0...1).contains(quality) else {
                throw UsageError.message("Video quality must be between zero and one")
            }
            videoQuality = quality
        case "--idle-after":
            guard let seconds = Double(value), seconds.isFinite, seconds >= 0, seconds <= 3600 else {
                throw UsageError.message("Idle timeout must be 0–3600 seconds; zero disables it")
            }
            idleAfter = seconds == 0 ? nil : seconds
        case "--dashboard-port":
            guard let port = Int(value), (1...65535).contains(port) else {
                throw UsageError.message("Dashboard port must be 1–65535")
            }
            dashboardPort = port
        case "--name":
            homeName = value
        case "--code":
            pairingCode = value
        case "--app":
            appBundle = URL(fileURLWithPath: value, isDirectory: true)
        case "--powerlog":
            powerLog = URL(fileURLWithPath: value, isDirectory: true)
        case "--job":
            guard let job = HomeJob(rawValue: value), job.program != nil else { throw UsageError.message("Job must be home, door, dashboard, mcp or runner") }
            self.job = job
        case "--set":
            guard ["on", "off"].contains(value) else { throw UsageError.message("Set agents on or off") }
            agentsOn = value == "on"
        case "--store":
            directory = URL(fileURLWithPath: value, isDirectory: true)
        case "--interval":
            guard let seconds = Double(value), seconds.isFinite, seconds >= 1, seconds <= 300 else {
                throw UsageError.message("Choose an interval from 1 to 300 seconds")
            }
            interval = seconds
        case "--duration":
            guard let seconds = Double(value), seconds.isFinite, seconds > 0 else {
                throw UsageError.message("Duration must be a positive number of seconds")
            }
            duration = seconds
        case "--limit":
            guard let count = Int(value), (1...10000).contains(count) else {
                throw UsageError.message("Limit must be 1–10000")
            }
            limit = count
        case "--since":
            guard let date = WireJSON.date(value) else {
                throw UsageError.message("Use an ISO-8601 date with a time zone")
            }
            since = date
        case "--exclude" where command == Command.modes.rawValue:
            try setMode(.exclude, for: .app(value))
        case "--site-activity", "--site-exclude", "--site-record":
            guard command == Command.modes.rawValue else {
                throw UsageError.message("Set a recording mode with the modes command")
            }
            let mode: RecordingMode = flag == "--site-activity" ? .activity : flag == "--site-exclude" ? .exclude : .record
            try setMode(mode, for: .site(value))
        case "--exclude":
            launchExclusions.insert(value)
        case "--activity", "--record":
            guard command == Command.modes.rawValue else {
                throw UsageError.message("Set a recording mode with the modes command")
            }
            try setMode(flag == "--activity" ? .activity : .record, for: .app(value))
        default:
            throw UsageError.message("Unknown option: \(flag)")
        }
    }
}

extension Options {
    fileprivate mutating func setMode(_ mode: RecordingMode, for target: RecordingModeTarget) throws {
        guard modeChange == nil else { throw UsageError.message("Set one recording mode at a time") }
        switch target {
        case .app(let bundleID):
            guard RecordingModes.isValidBundleID(bundleID) else {
                throw UsageError.message(RecordingModesError.invalidBundleID.localizedDescription)
            }
        case .site(let rule):
            guard Site(rule: rule) != nil else {
                throw UsageError.message(RecordingModesError.invalidSite.localizedDescription)
            }
        }
        modeChange = (mode, target)
    }
}

enum UsageError: Error, LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let message): return message
        }
    }
}

extension Options {
    func machineEvents(modes: RecordingModes, files: DeviceFiles, woke: (@Sendable () -> Void)? = nil) -> MachineEventSources {
        MachineEventSources(directory: directory, files: files, modes: modes, grants: { Grant.stated() }, report: { line in
            FileHandle.standardError.write(Data((line + "\n").utf8))
        }, onUserOrSystemEvent: woke)
    }

    func audio(modes: RecordingModes, files: DeviceFiles, scratch: URL, fits: @escaping @Sendable () -> Bool,
               woke: (@Sendable () -> Void)? = nil) -> AudioRecorder {
        AudioRecorder(directory: directory, files: files, scratch: scratch, modes: modes, fits: fits, report: { line in
            FileHandle.standardError.write(Data((line + "\n").utf8))
        }, partClosed: woke)
    }
}

extension Options {
    func inputEvents(modes: RecordingModes, files: DeviceFiles, fits: @escaping @Sendable () -> Bool,
                     woke: (@Sendable () -> Void)? = nil) -> InputEventLog? {
        guard inputLog else { return nil }
        return InputEventLog(directory: directory, files: files, modes: modes, fits: fits, report: { line in
            FileHandle.standardError.write(Data((line + "\n").utf8))
        }, onChunkWritten: woke)
    }
}

extension Recorder {
    static func live(_ options: Options, process: MacProcess) throws -> Recorder {
        live(options, process: process, logs: RecorderLogs(options, files: try process.writing(), scratch: process.scratch))
    }

    static func live(_ options: Options, process: MacProcess, logs: RecorderLogs) -> Recorder {
        live(configuration: options.recorder, directory: options.directory,
             screen: options.screen(modes: logs.modes), videoQuality: options.videoQuality,
             machineEvents: logs.machineEvents, inputEvents: logs.inputEvents, audio: logs.audio,
             fits: logs.fits, files: logs.files, plain: process.plain, scratch: process.scratch,
             onSegmentSettled: { [wakes = logs.wakes] in wakes.tell("screen") })
    }
}

struct RecorderLogs: Sendable {
    let files: DeviceFiles
    let modes: RecordingModes
    let disk: Volume
    let fits: @Sendable () -> Bool
    let machineEvents: MachineEventSources
    let inputEvents: InputEventLog?
    let audio: AudioRecorder
    let wakes: RecorderWakes

    init(_ options: Options, files: DeviceFiles, scratch: URL, wakes: RecorderWakes = RecorderWakes()) {
        self.files = files
        self.wakes = wakes
        modes = options.modes(files)
        let disk = Volume(options.directory)
        let fits: @Sendable () -> Bool = { disk.fits(.new) }
        self.disk = disk
        self.fits = fits
        machineEvents = options.machineEvents(modes: modes, files: files, woke: { wakes.tell("machine") })
        inputEvents = options.inputEvents(modes: modes, files: files, fits: fits, woke: { wakes.tell("input") })
        audio = options.audio(modes: modes, files: files, scratch: scratch, fits: fits, woke: { wakes.tell("audio") })
    }

    func rotate(_ product: String) -> Bool {
        switch product {
        case "machine":
            return machineEvents.rotateForShipping()
        case "input":
            inputEvents?.rotate()
            return true
        default:
            return true
        }
    }
}

final class RecorderWakes: @unchecked Sendable {
    private let lock = NSLock()
    private var heard: (@Sendable (String) -> Void)?

    func attach(_ heard: @escaping @Sendable (String) -> Void) {
        lock.withLock { self.heard = heard }
    }

    func tell(_ product: String) {
        lock.withLock { heard }?(product)
    }
}
