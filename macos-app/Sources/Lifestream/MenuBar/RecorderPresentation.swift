import Audio
import Cockpit
import Evidence
import Foundation
import HomeLink
import Recorder
import Shipping

extension RecorderStatement.Cause {
    init(_ reason: CaptureGapReason) {
        switch reason {
        case .storageBackpressure: self = .disk
        case .screenRecordingPermissionDenied: self = .permission
        case .foregroundPageUnreadable, .siteChangedDuringCapture: self = .browser
        case .videoEncoderUnavailable, .captureFailed, .screenAcquisitionFailed, .captureAlreadyRunning,
             .shareableContentUnavailable, .noDisplay, .noValidDisplay, .invalidCaptureSizeOrDisplayMode,
             .captureGenerationInvalidated, .captureDeadlineExceeded, .captureDeadlineMissed, .captureCancelled,
             .contextChangedBeforeCapture, .contextChangedDuringCapture, .storageFailed, .recorderNotRunning:
            self = .capture
        case .displayAsleepOrSessionInactive, .sessionChangedDuringCapture, .sessionLockedOrUnavailable,
             .loginWindowActive, .inputInactiveCapturePaused, .noFocusedApplication:
            self = .away
        case .secureInputEnabled, .secureFieldFocused, .secureFieldInFrontWindow, .foregroundAppExcluded,
             .foregroundAppActivityOnly, .foregroundSiteRuleExcluded, .foregroundPrivateWindow, .foregroundSiteActivityOnly,
             .excludedVisibleApplicationNotCoveredBeforeCapture, .excludedVisibleApplicationNotCoveredDuringCapture:
            self = .private
        }
    }

    var after: TimeInterval {
        switch self {
        case .disk, .permission: return 0
        case .browser, .capture, .away, .private: return 10
        }
    }

    var words: String {
        switch self {
        case .disk: return "Not recording"
        case .permission: return "Screen Recording needs access"
        case .browser: return "Not recording · browser not answering"
        case .capture: return "Not recording · screen unavailable"
        case .away: return "Not recording · Mac idle"
        case .private: return "Not recording · private window or app"
        }
    }

    var signal: Cockpit.SignalKind {
        switch self {
        case .disk, .permission: return .caution
        case .capture: return .warning
        case .browser, .away, .private: return .idle
        }
    }
}

struct RecorderPresentation: Equatable {
    let label: String
    let detail: String
    let failed: Bool
    let toggleTitle: String
    let recording: Bool
    let signal: Cockpit.SignalKind
    let stated: RecorderStatement
    let due: Date?
    private let interrupted: Date?

    static let starting = "Starting recording"
    static let recordingWords = "Recording"
    static let paused = "Recording paused"
    static let screenOff = "Not recording: Screen is turned off in Connectors"

    static func audio(mic: AudioTrackState?, sound: AudioTrackState?) -> String {
        if sound == .recording { return mic == .recording ? " · recording microphone and sound" : " · recording sound" }
        if mic == .recording { return sound == .permissionRequired ? " · recording microphone · system audio access needed"
                                                                    : " · recording microphone" }
        if mic == .permissionRequired { return " · microphone access needed" }
        if sound == .permissionRequired { return " · system audio access needed" }
        return ""
    }

    static let compactionWarningAfter: TimeInterval = 600

    static let startFailed = "Couldn't start recording. Check that the capture folder is writable and another recorder is not already using it."

    init(status: RuntimeStatus, running: Bool, screenOff: Bool = false, ownInFront: Bool = false, now: Date = Date(),
         shown: RecorderPresentation? = nil, start: ActOutcome = .idle) {
        let counts = "\(status.recorded) frames saved · \(status.gaps) gaps"
        let failing = status.videoCompactionFailingSince.map { now.timeIntervalSince($0) } ?? 0
        let compaction = failing < Self.compactionWarningAfter ? ""
            : " · video compaction failing for \(Int(failing / 60)) min"
        let keys = status.inputLog == .permissionRequired ? " · keys and clicks not recorded" : ""
        detail = if !running, case .refused(let words)? = start.failure { words }
            else { counts + compaction + keys + Self.audio(mic: status.audioMic, sound: status.audioSound) }
        failed = !running && start.failure != nil
        toggleTitle = running ? "Pause recording" : "Start recording"

        let since = [status.lastSaved, status.capturingSince].compactMap { $0 }.max() ?? status.updatedAt
        var due: Date?
        var cause: RecorderStatement.Cause?
        switch status.state {
        case .starting:
            label = Self.starting
            signal = .idle
            stated = .starting
        case .stopped, .captured, .gap:
            label = Self.paused
            signal = .idle
            stated = .paused
        case .recording, .waiting, .recovering, .permissionRequired:
            if screenOff {
                label = Self.screenOff
                signal = .idle
                stated = .paused
                break
            }
            let reason = status.lastGapReason.flatMap(CaptureGapReason.init(rawValue:))
            let standing: RecorderStatement.Cause = status.state == .permissionRequired ? .permission
                : reason.map(RecorderStatement.Cause.init) ?? .capture
            let shows = since.addingTimeInterval(standing.after)
            let ownWindow = ownInFront && (reason == .foregroundAppActivityOnly || reason == .foregroundAppExcluded)
            if !ownWindow && (shown?.interrupted == since || now >= shows) { cause = standing }
            if let cause {
                label = cause.words
                signal = cause.signal
                stated = .interrupted(cause)
            } else {
                label = Self.recordingWords
                signal = .engaged
                stated = .recording
                due = shows
            }
        }
        recording = stated == .recording
        interrupted = cause == nil ? nil : since
        self.due = due
    }

    func tellsGrants(after shown: RecorderPresentation?) -> Bool {
        (stated == .interrupted(.permission)) != (shown?.stated == .interrupted(.permission))
    }
}

struct ShippingPresentation: Equatable {
    let label: String
    let canShipNow: Bool

    init(status: ShipperStatus?, running: Bool = false, reach: HomeLink.ReachSnapshot? = nil, onBattery: Bool = false,
         mobile: MobileData.Moment? = nil, clock: HomeClock? = nil, zone: TimeZone = .current, now: Date = Date()) {
        self.init(read: status != nil, paired: status?.paired ?? false,
                  lastOutcome: status?.lastOutcome, lastRunAt: status?.lastRunAt, lastContactAt: status?.lastContactAt,
                  running: running || (status?.running ?? false), reach: reach,
                  historyOnBattery: onBattery && (status?.importingHistory ?? false),
                  waitsFor: status?.waitsFor, mobile: mobile, clock: clock, zone: zone, now: now)
    }

    init(read: Bool, paired: Bool, lastOutcome: String?, lastRunAt: Date?, lastContactAt: Date? = nil,
         running: Bool = false, reach: HomeLink.ReachSnapshot? = nil, historyOnBattery: Bool = false, waitsFor: MobileData.Wait? = nil,
         mobile: MobileData.Moment? = nil, clock: HomeClock? = nil, zone: TimeZone = .current, now: Date = Date()) {
        canShipNow = !running && paired
        let unpaired = read && !paired ? HomeLink.ReachSnapshot(reach: .unpaired, lastReached: nil, revision: 0) : nil
        if let reach = reach ?? unpaired, let said = ReachWords.menuLine(reach, clock: clock ?? .placeholder(at: now, zone: zone), now: now) {
            label = said
            return
        }
        guard !running else {
            label = "Lifestream: syncing…"
            return
        }
        guard read else {
            label = "Lifestream: reading…"
            return
        }
        let reached = lastOutcome.map(Self.reachs) ?? false
        guard let outcome = lastOutcome, outcome != "no_home", let at = reached ? lastContactAt : lastRunAt else {
            label = "Lifestream: not synced yet"
            return
        }
        if let said = ReachWords.sending(outcome, device: .mac) {
            label = said
            return
        }
        if let waitsFor, mobile?.past.moves == false {
            label = Self.words(waitsFor)
            return
        }
        label = "Lifestream: synced \(Self.clock(at, in: zone))" + (historyOnBattery ? ". \(Self.historyOnBattery)" : "")
    }

    static func words(_ wait: MobileData.Wait) -> String {
        wait == .past ? wait.words + " · Settings › Mobile data" : wait.words
    }

    static func reachs(_ outcome: String) -> Bool {
        ["unreachable", "held HOME_TOO_OLD", "held DEVICE_TOO_OLD", "refused PRINCIPAL_UNKNOWN"].contains(outcome)
    }

    static let historyOnBattery = "Importing history on battery."

    static func clock(_ instant: Date, in zone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let parts = calendar.dateComponents([.hour, .minute], from: instant)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }
}

enum StatusMenuEntry: Equatable {
    case state, detail, separator, openLifestream, toggle, shipping, shipNow, settings, quit

    static let order: [StatusMenuEntry] = [.state, .detail, .separator, .openLifestream, .toggle, .separator,
                                           .shipping, .shipNow, .settings, .separator, .quit]

    static func openTitle(firstRunDue: Bool) -> String {
        firstRunDue ? "Set up Lifestream…" : "Open Lifestream"
    }

    func title(_ presentation: RecorderPresentation,
               _ shipping: ShippingPresentation = ShippingPresentation(status: nil)) -> String? {
        switch self {
        case .state: return presentation.label
        case .detail: return presentation.detail
        case .separator: return nil
        case .openLifestream: return Self.openTitle(firstRunDue: false)
        case .toggle: return presentation.toggleTitle
        case .shipping: return shipping.label
        case .shipNow: return "Sync now"
        case .settings: return "Settings…"
        case .quit: return "Quit Lifestream"
        }
    }
}
