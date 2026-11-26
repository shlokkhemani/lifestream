import CoreLocation
import Foundation
import LifestreamCaptureCore

@MainActor
final class AppOwnedRecorder: NSObject, @preconcurrency CLLocationManagerDelegate {
    enum State: String { case recording, sleeping, wakeup, off }

    private struct Check {
        let wokeBy: String
        let from: State
        let centre: CLLocation
        let startedMonotonic: TimeInterval
        var startLate: TimeInterval?
        var fixes = 0
        var fresh = 0
    }

    static let label = "app_owned"

    var operationalState: String { state.rawValue }
    private weak var coordinator: LocationRecorderCoordinator?
    private var watch: StillWatch.Watch
    private let watchClockStart = ContinuousClock.now
    let recordingManager = CLLocationManager()
    let keepAliveManager = CLLocationManager()
    private var watchTimer: Timer?
    private var armedFor: TimeInterval?
    private var settleTimer: Timer?
    private var stationarySince: TimeInterval?
    private var stationaryCandidate: CLLocation?
    private var lastPreciseLocation: CLLocation?
    private(set) var settledLocation: CLLocation?
    private var fixSinceLeaving = false
    private var travelMode: MotionTravelMode = .uncertain
    private var lastMovingMode: MotionTravelMode = .uncertain
    private var degraded = false
    private let quietFor: (MotionTravelMode) -> TimeInterval
    private var check: Check?
    private var updating: Set<ObjectIdentifier> = []
    private(set) var state: State = .off
    private var stateEnteredMonotonic = ProcessInfo.processInfo.systemUptime
    private(set) var requestedConfiguration = RequestedLocationConfiguration(
        desiredAccuracy: kCLLocationAccuracyNearestTenMeters,
        distanceFilter: 22,
        activityType: .other,
        pausesAutomatically: false
    )

    init(
        coordinator: LocationRecorderCoordinator,
        watch: StillWatch.Watch = .init(),
        quiet: @escaping (MotionTravelMode) -> TimeInterval = RecorderTuning.settleHysteresis(for:)
    ) {
        self.coordinator = coordinator
        self.watch = watch
        self.quietFor = quiet
        super.init()
        recordingManager.delegate = self
        keepAliveManager.delegate = self
        recordingManager.allowsBackgroundLocationUpdates = true
        recordingManager.pausesLocationUpdatesAutomatically = false
        recordingManager.showsBackgroundLocationIndicator = false
        keepAliveManager.showsBackgroundLocationIndicator = false
        keepAliveManager.allowsBackgroundLocationUpdates = true
        keepAliveManager.pausesLocationUpdatesAutomatically = false
        keepAliveManager.desiredAccuracy = 3_000
        keepAliveManager.distanceFilter = 3_000
    }

    func start() { enterRecording(reason: "start") }

    func stop() {
        settleTimer?.invalidate()
        watch.recording(at: watchNow, quiet: nil)
        armWatch()
        setUpdating(recordingManager, false)
        setUpdating(keepAliveManager, false)
        transitionState(to: .off, reason: "stop")
    }

    func catchUp() { watchTimerFired(timed: false) }

    func motionActivityChanged(_ mode: MotionTravelMode) {
        travelMode = mode
        if mode == .walking || mode == .vehicle {
            lastMovingMode = mode
            watch.movementHeard(at: watchNow)
            followWatch(wokeBy: "motion")
            stationarySince = nil
            stationaryCandidate = nil
            settleTimer?.invalidate()
            settleTimer = nil
        } else if mode == .stationary {
            if stationarySince == nil {
                stationarySince = watchNow
                stationaryCandidate = bestKnownSettleCenter
            }
            scheduleClassifierSettleTimer()
        }
        guard !degraded else { return }
        switch mode {
        case .walking:
            requestedConfiguration.distanceFilter = 12
            requestedConfiguration.activityType = .fitness
        case .vehicle:
            requestedConfiguration.distanceFilter = 50
            requestedConfiguration.activityType = .automotiveNavigation
        case .uncertain:
            requestedConfiguration.distanceFilter = 22
            requestedConfiguration.activityType = .otherNavigation
        case .stationary: break
        }
        applyConfiguration()
    }

    func degradedModeChanged(_ degraded: Bool, reason: String) {
        guard self.degraded != degraded else { return }
        self.degraded = degraded
        if degraded {
            requestedConfiguration.desiredAccuracy = 3_000
            requestedConfiguration.distanceFilter = 3_000
            requestedConfiguration.activityType = .other
        } else {
            requestedConfiguration.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
            motionActivityChanged(travelMode)
        }
        applyConfiguration()
        if state == .recording {
            watch.recording(at: watchNow, quiet: quiet)
            armWatch()
        }
        coordinator?.recordServiceEvent(
            "engine_b_degraded_mode",
            detail: [
                "enabled": .bool(degraded),
                "reason": .string(reason),
                "configuration": .object(requestedConfiguration.json),
            ])
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        EnergyLedger.shared.measure(.location) { receive(locations, from: manager) }
    }

    private func receive(_ locations: [CLLocation], from manager: CLLocationManager) {
        BackgroundWake.note("location")
        if manager === keepAliveManager {
            coordinator?.recordServiceEvent(
                "engine_b_keepalive_callback_discarded",
                detail: ["count": .integer(Int64(locations.count))]
            )
            return
        }
        coordinator?.handleLegacyBatch(
            locations,
            acquisitionPath: "engine_b_precise",
            configuration: state == .wakeup ? checkConfiguration : requestedConfiguration,
            expectsHighRate: state == .recording
        )
        check?.fixes += locations.count
        if state == .recording, let quiet {
            watch.fixDelivered(at: watchNow, quiet: quiet)
            if let due = watch.quietEnds, due < armedFor ?? .infinity { armWatch() }
        }
        for location in locations {
            lastPreciseLocation = location
            evaluate(location)
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        coordinator?.recordServiceEvent(
            "engine_b_manager_error",
            detail: [
                "manager": .string(manager === keepAliveManager ? "keepalive" : "precise"),
                "error": .string(String(describing: error)),
            ]
        )
    }

    func locationManagerDidPauseLocationUpdates(_ manager: CLLocationManager) {
        coordinator?.recordServiceEvent("engine_b_os_pause_despite_request", detail: [:])
        switch state {
        case .wakeup: endCheckUnanswered(reason: "os_pause")
        case .recording:
            if let settledLocation {
                watch.settled(at: watchNow, centreAccuracy: settledLocation.horizontalAccuracy)
                enterSleeping(reason: "os_pause")
            } else {
                setUpdating(recordingManager, false)
                enterRecording(reason: "os_pause_no_settle_centre")
            }
        case .sleeping, .off: break
        }
    }

    func locationManagerDidResumeLocationUpdates(_ manager: CLLocationManager) {
        coordinator?.recordServiceEvent("engine_b_os_resume", detail: [:])
        enterRecording(reason: "os_resume")
    }

    private var checkConfiguration: RequestedLocationConfiguration {
        var configuration = requestedConfiguration
        configuration.distanceFilter = kCLDistanceFilterNone
        return configuration
    }

    private func applyConfiguration() {
        let configuration = state == .wakeup ? checkConfiguration : requestedConfiguration
        recordingManager.desiredAccuracy = configuration.desiredAccuracy
        recordingManager.distanceFilter = configuration.distanceFilter
        recordingManager.activityType = configuration.activityType
        holdLocation(recordingManager)
    }

    func regionExited() {
        watch.regionExited(at: watchNow)
        followWatch(wokeBy: "geofence_exit")
    }

    private var watchNow: TimeInterval { (ContinuousClock.now - watchClockStart) / .seconds(1) + testAdvance }
    var testAdvance: TimeInterval = 0
    var asked: ((CLLocationManager, Bool) -> Void)?
    var deadline: TimeInterval? { watch.nextCheck ?? watch.checkEnds ?? watch.quietEnds }

    private var quiet: TimeInterval? { degraded ? nil : quietFor(lastMovingMode) }

    private func followWatch(wokeBy reason: String) {
        guard state == .sleeping, let due = watch.nextCheck else { return }
        if due <= watchNow { enterWakeup(reason: reason) } else { armWatch() }
    }

    private func armWatch() {
        watchTimer?.invalidate()
        watchTimer = nil
        armedFor = deadline
        guard let deadline else { return }
        watchTimer = Timer.scheduledTimer(withTimeInterval: max(0, deadline - watchNow), repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.watchTimerFired(timed: true) }
        }
    }

    private func watchTimerFired(timed: Bool) {
        guard let due = deadline else { return }
        guard due <= watchNow else { return armWatch() }
        let late = timed ? watchNow - due : nil
        switch state {
        case .sleeping: enterWakeup(reason: "adaptive_timer", late: late)
        case .wakeup:
            if let late { countCheckEnd(late: late) }
            endCheckUnanswered(reason: "wakeup_timeout")
        case .recording: quietCame(late: late)
        case .off: break
        }
    }

    private static func countLate(_ late: TimeInterval) {
        let bucket = late < 1 ? "lt1s" : late < 5 ? "1to5s" : late < 15 ? "5to15s" : "ge15s"
        EnergyLedger.shared.count("location_check_late_\(bucket)")
    }

    private func countCheckEnd(late: TimeInterval) {
        Self.countLate(late)
        if (check?.startLate ?? 0) + late >= StillWatch.lateTimers {
            EnergyLedger.shared.count("location_check_pair_late_ge15s")
        }
    }

    private func quietCame(late: TimeInterval?) {
        guard let centre = fixSinceLeaving ? lastPreciseLocation : settledLocation ?? lastPreciseLocation else {
            restartRecordingManager()
            watch.recording(at: watchNow, quiet: quiet)
            return armWatch()
        }
        watch.beginQuietCheck(at: watchNow, centreAccuracy: centre.horizontalAccuracy)
        EnergyLedger.shared.count("location_checks_recording_quiet")
        check = Check(wokeBy: "recording_quiet", from: .recording, centre: centre,
                      startedMonotonic: ProcessInfo.processInfo.systemUptime, startLate: late)
        if let late { Self.countLate(late) }
        state = .wakeup
        applyConfiguration()
        setUpdating(recordingManager, false)
        setUpdating(recordingManager, true)
        armWatch()
    }

    private func restartRecordingManager() {
        EnergyLedger.shared.count("location_recording_restarts")
        setUpdating(recordingManager, false)
        setUpdating(recordingManager, true)
    }

    private func endCheckUnanswered(reason: String) {
        if !watch.checkTimedOut(at: watchNow) { EnergyLedger.shared.count("location_checks_no_fresh_fix") }
        guard let check, check.from == .recording else { return enterSleeping(reason: reason) }
        guard travelMode == .walking || travelMode == .vehicle else {
            return settled(at: check.centre, reason: "recording_quiet_unanswered")
        }
        watch.recording(at: watchNow, quiet: quiet)
        transitionState(to: .recording, reason: "recording_quiet_moving")
        applyConfiguration()
        restartRecordingManager()
        armWatch()
    }

    private func enterRecording(reason: String) {
        let moving = state == .sleeping || check?.from == .sleeping
        settleTimer?.invalidate()
        settleTimer = nil
        watch.recording(at: watchNow, quiet: quiet)
        armWatch()
        setUpdating(keepAliveManager, false)
        transitionState(to: .recording, reason: reason)
        applyConfiguration()
        setUpdating(recordingManager, true)
        if moving {
            fixSinceLeaving = false
            coordinator?.recordServiceEvent("moving", tells: .moving, detail: ["reason": .string(reason)])
        }
        stationarySince = nil
        stationaryCandidate = nil
    }

    private func enterSleeping(reason: String) {
        guard state != .sleeping, let next = watch.nextCheck else { return }
        settleTimer?.invalidate()
        settleTimer = nil
        setUpdating(recordingManager, false)
        setUpdating(keepAliveManager, true)
        transitionState(to: .sleeping, reason: reason, nextCheckSeconds: max(0, next - watchNow))
        coordinator?.transitionCoverage(
            to: .stationaryAutoPaused, reason: "engine_b_\(reason)", evidence: .inferred)
        armWatch()
    }

    private func enterWakeup(reason: String, late: TimeInterval? = nil) {
        if state == .sleeping, let settledLocation {
            watch.beginCheck(at: watchNow)
            EnergyLedger.shared.count("location_checks_\(reason)")
            check = Check(wokeBy: reason, from: .sleeping, centre: settledLocation,
                          startedMonotonic: ProcessInfo.processInfo.systemUptime, startLate: late)
            if let late { Self.countLate(late) }
            state = .wakeup
        }
        guard state == .wakeup else { return }
        applyConfiguration()
        setUpdating(recordingManager, true)
        armWatch()
    }

    private func evaluate(_ location: CLLocation) {
        let appearsStationary = RecorderTuning.appearsStationary(
            location,
            relativeTo: stationaryCandidate
        )
        if state == .recording {
            fixSinceLeaving = true
            if appearsStationary {
                stationaryCandidate = stationaryCandidate ?? location
                stationarySince = stationarySince ?? watchNow
                let hysteresis = RecorderTuning.settleHysteresis(for: lastMovingMode)
                if let stationarySince, watchNow - stationarySince >= hysteresis {
                    settle(
                        at: location,
                        reason: "stationary_hysteresis_\(Int(hysteresis))s"
                    )
                }
            } else if location.speed < 0.5, location.horizontalAccuracy >= 0 {
                stationaryCandidate = location
                stationarySince = watchNow
                if travelMode == .stationary { scheduleClassifierSettleTimer() }
            } else {
                stationarySince = nil
                stationaryCandidate = nil
                settleTimer?.invalidate()
                settleTimer = nil
            }
        } else if state == .wakeup, let check {
            let now = watchNow
            let verdict = watch.read(
                .init(
                    madeAt: now - Date().addingTimeInterval(testAdvance).timeIntervalSince(location.timestamp),
                    stated: location.timestamp.timeIntervalSinceReferenceDate,
                    distance: location.distance(from: check.centre), accuracy: location.horizontalAccuracy),
                at: now)
            if verdict != .nothing {
                self.check?.fresh += 1
                fixSinceLeaving = true
            }
            switch verdict {
            case .still where check.from == .recording: settle(at: location, reason: "recording_quiet")
            case .still: enterSleeping(reason: "still_stationary")
            case .left:
                enterRecording(reason: "left_settle_region")
                coordinator?.transitionCoverage(
                    to: .highRateExpected, reason: "engine_b_left_settle_region",
                    evidence: .observed)
            case .doubt, .nothing: break
            }
        }
    }

    private var bestKnownSettleCenter: CLLocation? {
        lastPreciseLocation ?? recordingManager.location
    }

    private func scheduleClassifierSettleTimer() {
        guard state == .recording, travelMode == .stationary, let stationarySince else { return }
        settleTimer?.invalidate()
        let remaining = max(0, RecorderTuning.settleHysteresis(for: lastMovingMode) - (watchNow - stationarySince))
        settleTimer = Timer.scheduledTimer(withTimeInterval: remaining, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { _ = self?.attemptClassifierSettle(reason: "classifier_stationary_timer") }
        }
    }

    @discardableResult
    private func attemptClassifierSettle(reason: String) -> Bool {
        guard state == .recording, travelMode == .stationary, let stationarySince else {
            return false
        }
        let hysteresis = RecorderTuning.settleHysteresis(for: lastMovingMode)
        guard watchNow - stationarySince >= hysteresis else {
            scheduleClassifierSettleTimer()
            return false
        }
        guard let center = bestKnownSettleCenter else {
            coordinator?.recordServiceEvent(
                "engine_b_settle_deferred",
                detail: [
                    "reason": .string("no_known_precise_location"),
                    "trigger": .string(reason),
                    "stationary_dwell_seconds": .number(watchNow - stationarySince),
                ])
            return false
        }
        coordinator?.recordServiceEvent(
            "engine_b_settle_center_selected",
            detail: [
                "trigger": .string(reason),
                "source": .string(
                    lastPreciseLocation == nil
                        ? "recording_manager_last_known_location" : "last_delivered_precise_fix"),
                "fix_age_seconds": .number(AppClock.now.timeIntervalSince(center.timestamp)),
                "horizontal_accuracy": .number(center.horizontalAccuracy),
            ])
        settle(at: center, reason: reason)
        return true
    }

    func settle(at location: CLLocation, reason: String) {
        watch.settled(at: watchNow, centreAccuracy: location.horizontalAccuracy)
        settled(at: location, reason: reason)
    }

    private func settled(at location: CLLocation, reason: String) {
        settledLocation = location
        coordinator?.dropCatchGeofence(at: location)
        enterSleeping(reason: reason)
        coordinator?.recordServiceEvent("settled", tells: .settled, detail: ["reason": .string(reason)])
    }

    private func transitionState(
        to next: State, reason: String, nextCheckSeconds: TimeInterval? = nil
    ) {
        let now = ProcessInfo.processInfo.systemUptime
        var detail: [String: JSONValue] = [
            "from": .string((check?.from ?? state).rawValue),
            "state": .string(next.rawValue),
            "reason": .string(reason),
            "prior_state_dwell_seconds": .number(
                RecorderTuning.dwellSeconds(
                    since: stateEnteredMonotonic, now: check?.startedMonotonic ?? now)),
        ]
        if let check {
            detail["check"] = .object([
                "woke_by": .string(check.wokeBy),
                "fixes": .integer(Int64(check.fixes)),
                "fresh_fixes": .integer(Int64(check.fresh)),
                "seconds": .number(
                    RecorderTuning.dwellSeconds(since: check.startedMonotonic, now: now)),
            ])
        }
        if let nextCheckSeconds { detail["next_check_seconds"] = .number(nextCheckSeconds) }
        state = next
        stateEnteredMonotonic = now
        check = nil
        coordinator?.recordServiceEvent("engine_b_state", detail: detail)
    }

    var keepsProcessRunning: Bool { !updating.isEmpty && coordinator?.backgroundRecordingAllowed == true }

    private func setUpdating(_ manager: CLLocationManager, _ on: Bool) {
        asked?(manager, on)
        guard coordinator?.platformServicesEnabled == true else { return }
        if on { manager.startUpdatingLocation() } else { manager.stopUpdatingLocation() }
        if on { updating.insert(ObjectIdentifier(manager)) } else { updating.remove(ObjectIdentifier(manager)) }
        holdLocation(manager)
    }

    private func holdLocation(_ manager: CLLocationManager) {
        EnergyLedger.shared.hold(
            manager === keepAliveManager ? "location.keepalive" : "location.precise",
            setting: updating.contains(ObjectIdentifier(manager)) ? String(Int(manager.desiredAccuracy)) : nil)
    }
}
