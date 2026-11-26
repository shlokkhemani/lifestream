import Combine
import CoreLocation
import Foundation
import LifestreamCaptureCore
import UIKit

@MainActor
final class MainActorTaskQueue {
    private var tail: Task<Void, Never>?

    func enqueue(_ operation: @escaping @MainActor () async -> Void) {
        let predecessor = tail
        tail = Task { @MainActor in
            await predecessor?.value
            await operation()
        }
    }

    func perform(_ operation: @escaping @MainActor () async throws -> Void) async throws {
        let predecessor = tail
        let command = Task<Void, any Error> { @MainActor in
            await predecessor?.value
            try await operation()
        }
        tail = Task { @MainActor in
            _ = await command.result
        }
        try await command.value
    }

    func drain() async {
        await tail?.value
    }
}

struct OwedFence: Codable, Equatable, Sendable {
    let fence: Fence
    let at: Date
    let process: UUID
    let n: Int

    func notNewer(than other: OwedFence, now process: UUID) -> Bool {
        if self.process == other.process { return n <= other.n }
        return self.process != process && other.process == process
    }
}

private struct PendingProcessAbsence {
    let start: String
    let reason: String
    let coverage: CoverageState
}

@MainActor
final class LocationRecorderCoordinator: NSObject, @preconcurrency CLLocationManagerDelegate {
    var onEvent: ((SendClock.Event) -> Void)?
    let authorizationChanged = PassthroughSubject<CLAuthorizationStatus, Never>()
    let store: CaptureStore
    let intentStore: TrackingIntentStore
    let bootID: UUID?
    let platformServicesEnabled: Bool

    private let fallbackManager = CLLocationManager()
    private var serviceSession: CLServiceSession?
    private var sessionHolds: CLAuthorizationStatus?
    private var sessionWanted = false
    private var answerWaiters: [CheckedContinuation<CLAuthorizationStatus, Never>] = []
    private var alwaysWatch: AlwaysPromptWatch?
    private var fixWaiters: [UUID: CheckedContinuation<CLLocation?, Never>] = [:]
    private var backgroundSession: CLBackgroundActivitySession?
    var recorder: AppOwnedRecorder?
    private let geofences: (any Geofences)?
    private var catchGeofenceMonitor: (any GeofenceMonitor)?
    private var monitorSetupTask: Task<Void, Never>?
    private let owedFenceWrites = MainActorTaskQueue()
    private var monitorEventsTask: Task<Void, Never>?
    private let writeQueue: MainActorTaskQueue
    private var lastFixDate: Date?
    private var lastFixSequence: UInt64?
    private var previousCoverageState: CoverageState = .unknown
    private var intentDurabilityUnconfirmed = false
    private var pendingProcessAbsence: PendingProcessAbsence?
    private(set) var refusedForSpace = false
    private(set) var lastLocation: CLLocation?
    private var fallbackManagerIsActive = false
    private var motionMode: MotionTravelMode?

    private(set) var precision = LocationPrecision.stored
    private var recorderWanted = false

    private(set) var coverageState: CoverageState = .unknown
    private(set) var lastPlatformDiagnostic = "No current-process diagnostic yet"
    private(set) var serviceRequested: Bool?
    private(set) var persistenceDiagnostic: String?
    var operationalState: String {
        recorder?.operationalState ?? (recorderWanted && precision == .battery ? "battery_saving" : "not_started")
    }

    init(
        store: CaptureStore,
        intentStore: TrackingIntentStore,
        bootID: UUID?,
        platformServicesEnabled: Bool = true,
        writeQueue: MainActorTaskQueue? = nil,
        geofences: (any Geofences)? = nil
    ) {
        self.store = store
        self.intentStore = intentStore
        self.bootID = bootID
        self.platformServicesEnabled = platformServicesEnabled
        self.geofences = geofences ?? (platformServicesEnabled ? SystemGeofences() : nil)
        self.writeQueue = writeQueue ?? MainActorTaskQueue()
        super.init()
    }

    func bootstrap() {
        switch loadIntentState() {
        case .missing:
            coverageState = .authorizationBlocked
            return
        case .failed:
            coverageState = .unknown
            return
        case .loaded(let intent):
            guard intent.armed else {
                coverageState = .authorizationBlocked
                return
            }
            guard confirmLoadedIntentDurability(intent) else {
                coverageState = .unknown
                return
            }
            activateFallbackManager()
            resumePersistedIntent(intent, reason: "cold_launch_bootstrap")
        }
    }

    func awaitBootstrapBarrier() async {
        await monitorSetupTask?.value
        await writeQueue.drain()
    }

    func protectedDataDidBecomeAvailable() {
        if recorder != nil {
            startCatchGeofenceMonitor(replacingAt: nil)
            return
        }
        guard catchGeofenceMonitor == nil else { return }
        switch loadIntentState() {
        case .missing:
            coverageState = .authorizationBlocked
        case .failed:
            coverageState = .unknown
        case .loaded(let intent):
            guard intent.armed else {
                coverageState = .authorizationBlocked
                return
            }
            guard confirmLoadedIntentDurability(intent) else {
                coverageState = .unknown
                return
            }
            activateFallbackManager()
            resumePersistedIntent(intent, reason: "protected_data_available")
        }
    }

    func armAndRequestAuthorization() throws {
        do {
            let result = try persistIntentDurably(armed: true, coverageState: .unknown)
            guard case .durable = result else {
                throw CaptureError.corruptState(
                    "capture intent is visible but not crash-durable"
                )
            }
        } catch {
            recordPersistenceFailure(error)
            throw error
        }

        coverageState = .unknown
        activateFallbackManager()
        requestWhenInUseAuthorization()
        recreateSessionsAndLattice(reason: "capture_started")
        startRecorder()
    }

    func requestWhenInUseAuthorization() {
        guard platformServicesEnabled else { return }
        fallbackManager.requestWhenInUseAuthorization()
    }

    var authorizationStatus: CLAuthorizationStatus { fallbackManager.authorizationStatus }

    var backgroundRecordingAllowed: Bool {
        switch authorizationStatus {
        case .authorizedAlways: true
        case .authorizedWhenInUse: backgroundSession != nil
        default: false
        }
    }

    var keepsProcessRunning: Bool { recorder?.keepsProcessRunning ?? false }

    func authorizationAnswer() async -> CLAuthorizationStatus {
        let now = fallbackManager.authorizationStatus
        guard platformServicesEnabled, fallbackManagerIsActive, now == .notDetermined else { return now }
        guard await Task.detached(operation: { CLLocationManager.locationServicesEnabled() }).value else { return now }
        if fallbackManager.authorizationStatus != .notDetermined { return fallbackManager.authorizationStatus }
        return await withCheckedContinuation { answerWaiters.append($0) }
    }

    func askAlways() async -> Bool {
        guard platformServicesEnabled else { return false }
        let watch = AlwaysPromptWatch()
        alwaysWatch = watch
        fallbackManager.requestAlwaysAuthorization()
        let shown = await watch.shown()
        alwaysWatch = nil
        recordServiceEvent("always_ask", detail: [
            "shown": .bool(shown),
            "authorization": .string(String(describing: fallbackManager.authorizationStatus)),
        ])
        return shown
    }

    func firstFix() async -> CLLocation? {
        if let lastLocation { return lastLocation }
        let id = UUID()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { waiter in
                if Task.isCancelled { waiter.resume(returning: nil) } else { fixWaiters[id] = waiter }
            }
        } onCancel: {
            Task { @MainActor in self.fixWaiters.removeValue(forKey: id)?.resume(returning: nil) }
        }
    }

    func restoreOrArm() throws {
        switch loadIntentState() {
        case .loaded(let intent) where intent.armed:
            guard confirmLoadedIntentDurability(intent) else {
                throw CaptureError.corruptState(
                    persistenceDiagnostic ?? "persisted tracking intent is not crash-durable"
                )
            }
            guard recorder == nil else { return }
            activateFallbackManager()
            resumePersistedIntent(
                intent,
                reason: "capture_restarted"
            )
        case .missing, .loaded:
            try armAndRequestAuthorization()
        case .failed(let diagnostic):
            throw CaptureError.corruptState(
                "cannot restore capture while tracking intent is unavailable: \(diagnostic)"
            )
        }
    }

    func disarm(reason: String) throws {
        _ = try persistIntentDurably(armed: false, coverageState: coverageState)
        recordServiceEvent("capture_disarmed", detail: ["reason": .string(reason)])
        recorderWanted = false
        recorder?.stop()
        recorder = nil
        monitorSetupTask?.cancel()
        monitorEventsTask?.cancel()
        monitorEventsTask = nil
        if let monitor = catchGeofenceMonitor { Task { await monitor.remove(Self.fenceID) } }
        guard platformServicesEnabled else { return }
        fallbackManager.stopMonitoringSignificantLocationChanges()
        fallbackManager.stopMonitoringVisits()
        fallbackManager.stopUpdatingLocation()
        sessionWanted = false
        serviceSession?.invalidate()
        serviceSession = nil
        sessionHolds = nil
        backgroundSession?.invalidate()
        backgroundSession = nil
    }

    func motionActivityChanged(_ mode: MotionTravelMode) {
        recorder?.motionActivityChanged(mode)
        guard mode != motionMode else { return }
        motionMode = mode
        EnergyLedger.shared.count("motion_mode_changes")
        recordServiceEvent(
            "motion_configuration_selector", detail: ["mode": .string(mode.rawValue)])
    }

    func resourcePressureChanged(degraded: Bool, reason: String) {
        recorder?.degradedModeChanged(degraded, reason: reason)
        if degraded {
            transitionCoverage(to: .coarseFallbackOnly, reason: reason, evidence: .observed)
        } else if coverageState == .coarseFallbackOnly, precision == .precise {
            transitionCoverage(
                to: .unknown, reason: "resource_pressure_cleared", evidence: .observed)
        }
    }

    func handleLegacyBatch(
        _ locations: [CLLocation],
        acquisitionPath: String,
        configuration: RequestedLocationConfiguration,
        expectsHighRate: Bool = true
    ) {
        guard !locations.isEmpty else { return }
        if expectsHighRate {
            transitionCoverage(
                to: .highRateExpected, reason: "legacy_location_batch_received",
                evidence: .observed)
        }
        if let latestIndex = LocationBatchBookkeeping.latestIndex(in: locations) {
            let latest = locations[latestIndex]
            if lastLocation.map({ latest.timestamp >= $0.timestamp }) ?? true {
                lastLocation = latest
            }
            let waiting = fixWaiters.values
            fixWaiters.removeAll()
            for waiter in waiting { waiter.resume(returning: latest) }
        }
        enqueueLocationBatch(
            locations,
            acquisitionPath: acquisitionPath,
            configuration: configuration
        )
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard fallbackManagerIsActive else { return }
        BackgroundWake.note("location")
        let config = RequestedLocationConfiguration(
            desiredAccuracy: manager.desiredAccuracy,
            distanceFilter: manager.distanceFilter,
            activityType: manager.activityType,
            pausesAutomatically: manager.pausesLocationUpdatesAutomatically
        )
        handleLegacyBatch(
            locations, acquisitionPath: "significant_location_change", configuration: config,
            expectsHighRate: precision == .precise)
    }

    func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        guard fallbackManagerIsActive else { return }
        BackgroundWake.note("location")
        recordServiceEvent(
            "visit",
            tells: .visit,
            detail: [
                "arrival_date_rfc3339": .string(CaptureTime.rfc3339(visit.arrivalDate)),
                "arrival_date_unix_seconds": .number(visit.arrivalDate.timeIntervalSince1970),
                "departure_date_rfc3339": .string(CaptureTime.rfc3339(visit.departureDate)),
                "departure_date_unix_seconds": .number(visit.departureDate.timeIntervalSince1970),
                "latitude": .number(visit.coordinate.latitude),
                "longitude": .number(visit.coordinate.longitude),
                "horizontal_accuracy": .number(visit.horizontalAccuracy),
            ])
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard fallbackManagerIsActive else { return }
        let status = manager.authorizationStatus
        if status != .notDetermined {
            let waiting = answerWaiters
            answerWaiters.removeAll()
            for waiter in waiting { waiter.resume(returning: status) }
        }
        if status == .authorizedAlways { alwaysWatch?.granted() }
        holdLocationSessions()
        authorizationChanged.send(status)
        recordCaptureState()
        switch manager.authorizationStatus {
        case .denied, .restricted:
            transitionCoverage(
                to: .authorizationBlocked, reason: "authorization_changed", evidence: .observed)
        case .authorizedAlways:
            if coverageState == .authorizationBlocked {
                transitionCoverage(
                    to: .unknown, reason: "authorization_restored", evidence: .observed)
            }
        default: break
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard fallbackManagerIsActive else { return }
        recordServiceEvent(
            "fallback_manager_error", detail: ["error": .string(String(describing: error))])
    }

    func transitionCoverage(to state: CoverageState, reason: String, evidence: ReasonEvidence) {
        lastPlatformDiagnostic = reason
        guard state != coverageState else { return }
        previousCoverageState = coverageState
        coverageState = state
        if serviceRequested == true {
            persistIntent(armed: true)
        }
        recordServiceEvent(
            "coverage_transition",
            detail: [
                "from": .string(previousCoverageState.rawValue),
                "to": .string(state.rawValue),
                "reason": .string(reason),
                "reason_evidence": .string(evidence.rawValue),
            ])
    }

    func recordLifecycle(_ event: String, observedAt: String? = nil) {
        recordServiceEvent(
            "lifecycle",
            detail: ["event": .string(event)],
            observedAt: observedAt,
            waiting: false
        )
        if event == "will_enter_foreground" { recorder?.catchUp() }
    }

    func recordExperimentMarker(_ marker: String, observedAt: String? = nil) async throws {
        let observed = observedAt ?? CaptureTime.rfc3339(AppClock.now)
        try await writeQueue.perform {
            _ = try await self.store.append(
                domain: .location,
                draft: .init(
                    kind: "recorder_event",
                    observedAt: observed,
                    payload: .object([
                        "event": .string("experiment_marker"),
                        "detail": .object(["marker": .string(marker)]),
                    ])
                )
            )
        }
    }

    func recordServiceEvent(
        _ event: String,
        tells: SendClock.Event? = nil,
        detail: [String: JSONValue],
        observedAt: String? = nil,
        waiting: Bool = true
    ) {
        let draft = CaptureDraft(
            kind: "recorder_event",
            observedAt: observedAt ?? CaptureTime.rfc3339(AppClock.now),
            payload: .object(["event": .string(event), "detail": .object(detail)])
        )
        enqueue {
            guard await self.appendReadings([draft], waiting: waiting) != nil else { return }
            if let tells { self.onEvent?(tells) }
        }
    }

    @discardableResult
    private func appendReadings(_ drafts: [CaptureDraft], waiting: Bool = true) async -> [CaptureEntry]? {
        do {
            return try await store.appendBatch(domain: .location, drafts: drafts, waiting: waiting)
        } catch {
            if case CaptureError.full = error { refusedForSpace = true }
            EnergyLedger.shared.count("store_dropped", drafts.count)
            lastPlatformDiagnostic = "Location readings were not kept: \(error)"
            return nil
        }
    }

    func dropCatchGeofence(at location: CLLocation) {
        guard location.horizontalAccuracy >= 0,
            fallbackManager.accuracyAuthorization == .fullAccuracy
        else {
            recordServiceEvent(
                "catch_geofence_skipped",
                detail: [
                    "reason": .string(
                        location.horizontalAccuracy < 0 ? "invalid_accuracy" : "reduced_accuracy")
                ])
            return
        }
        startCatchGeofenceMonitor(replacingAt: location)
    }

    static func leftRegion(_ state: CLMonitor.Event.State) -> Bool { state == .unsatisfied }

    static let fenceID = "settled-area"
    static let owedFenceKey = "location.owed_fence"
    static let fenceProcess = UUID()
    private var fenceCount = 0

    private func nextFenceCount() -> Int {
        fenceCount += 1
        return fenceCount
    }

    func startCatchGeofenceMonitor(replacingAt location: CLLocation?) {
        guard let geofences else { return }
        let settle = location.map { location in
            OwedFence(
                fence: Fence(
                    latitude: location.coordinate.latitude, longitude: location.coordinate.longitude,
                    radius: max(200, 2 * location.horizontalAccuracy)),
                at: AppClock.now, process: Self.fenceProcess, n: nextFenceCount())
        }
        if let settle { owedFenceWrites.enqueue { [weak self] in await self?.saveOwedFence(settle) } }
        let precedingSetup = monitorSetupTask
        monitorSetupTask = Task { [weak self] in
            await precedingSetup?.value
            guard let self else { return }
            await self.owedFenceWrites.drain()
            var owed = settle
            if owed == nil { owed = await self.storedOwedFence() }
            let locked = !geofences.isProtectedDataAvailable
            let opened = self.catchGeofenceMonitor == nil
            let monitor: any GeofenceMonitor
            if let existing = self.catchGeofenceMonitor {
                monitor = existing
            } else if locked {
                self.recordServiceEvent(
                    "catch_geofence_deferred", detail: ["reason": .string("protected_data_unavailable")])
                if settle != nil { EnergyLedger.shared.count("geofence_deferred") }
                return
            } else {
                monitor = await geofences.open()
                guard !Task.isCancelled else { return }
                self.catchGeofenceMonitor = monitor
            }
            if let owed {
                await monitor.add(owed.fence, identifier: Self.fenceID)
                if let held = await monitor.condition(of: Self.fenceID), held.matches(owed.fence) {
                    await self.clearOwedFence(owed)
                    var detail: [String: JSONValue] = [
                        "radius_m": .number(owed.fence.radius),
                        "locked": .bool(locked),
                        "owed_seconds": .number(AppClock.now.timeIntervalSince(owed.at)),
                    ]
                    if let location { detail["center_horizontal_accuracy"] = .number(location.horizontalAccuracy) }
                    self.recordServiceEvent("catch_geofence_armed", detail: detail)
                    EnergyLedger.shared.count(
                        settle == nil
                            ? "geofence_armed_at_unlock" : locked ? "geofence_armed_locked" : "geofence_armed_unlocked")
                } else {
                    self.recordServiceEvent(
                        "catch_geofence_deferred",
                        detail: ["reason": .string(locked ? "not_taken_while_locked" : "not_taken")])
                    if settle != nil { EnergyLedger.shared.count("geofence_deferred") }
                }
            } else if opened {
                self.recordServiceEvent(
                    "catch_geofence_listener_resumed",
                    detail: [
                        "condition_persisted_by_core_location": .bool(true)
                    ])
            }
            guard !Task.isCancelled, self.monitorEventsTask == nil else { return }
            self.monitorEventsTask = Task { [weak self] in
                do {
                    try await monitor.listen { identifier, state in
                        guard let self else { return }
                        let left = Self.leftRegion(state)
                        self.recordServiceEvent(
                            "catch_geofence_event",
                            tells: left ? .exit : nil,
                            detail: [
                                "identifier": .string(identifier),
                                "state": .string(String(describing: state)),
                            ])
                        if left { self.recorder?.regionExited() }
                    }
                } catch {
                    self?.recordServiceEvent(
                        "catch_geofence_failed",
                        detail: [
                            "error": .string(String(describing: error))
                        ])
                }
                self?.monitorEventsTask = nil
            }
        }
    }

    private func saveOwedFence(_ owed: OwedFence) async {
        do {
            try await store.setAnchor(Self.owedFenceKey, try JSONEncoder().encode(owed))
        } catch {
            lastPlatformDiagnostic = "The catch geofence's owed circle was not kept: \(error)"
        }
    }

    private func storedOwedFence() async -> OwedFence? {
        guard let data = try? await store.anchor(Self.owedFenceKey) else { return nil }
        return try? JSONDecoder().decode(OwedFence.self, from: data)
    }

    private func clearOwedFence(_ armed: OwedFence) async {
        try? await owedFenceWrites.perform { [weak self] in
            guard let self, let stored = await self.storedOwedFence(), stored.notNewer(than: armed, now: Self.fenceProcess) else { return }
            try await self.store.setAnchor(Self.owedFenceKey, nil)
        }
    }

    private func recreateSessionsAndLattice(reason: String) {
        if platformServicesEnabled {
            sessionWanted = true
            holdLocationSessions()
            fallbackManager.startMonitoringSignificantLocationChanges()
            fallbackManager.startMonitoringVisits()
        }
        if let lastLocation {
            dropCatchGeofence(at: lastLocation)
        } else {
            startCatchGeofenceMonitor(replacingAt: nil)
        }
        guard platformServicesEnabled else { return }
        recordServiceEvent("resurrection_lattice_armed", detail: ["reason": .string(reason)])
    }

    private func holdLocationSessions() {
        guard platformServicesEnabled, sessionWanted else { return }
        let status = fallbackManager.authorizationStatus
        switch status {
        case .notDetermined, .authorizedWhenInUse:
            backgroundSession = backgroundSession ?? CLBackgroundActivitySession()
        case .authorizedAlways where sessionHolds != .authorizedAlways:
            (backgroundSession ?? CLBackgroundActivitySession()).invalidate()
            backgroundSession = nil
        default:
            backgroundSession?.invalidate()
            backgroundSession = nil
        }
        let wanted: CLAuthorizationStatus? = switch status {
        case .authorizedAlways, .authorizedWhenInUse: status
        default: nil
        }
        guard wanted != sessionHolds || (wanted != nil && serviceSession == nil) else { return }
        serviceSession?.invalidate()
        serviceSession = switch wanted {
        case .authorizedAlways?: CLServiceSession(authorization: .always)
        case .authorizedWhenInUse?: CLServiceSession(authorization: .whenInUse)
        default: nil
        }
        sessionHolds = wanted
    }

    func apply(_ precision: LocationPrecision) {
        guard precision != self.precision else { return }
        self.precision = precision
        UserDefaults.standard.set(precision.rawValue, forKey: LocationPrecision.key)
        recordServiceEvent("location_precision", detail: ["precision": .string(precision.rawValue)])
        if recorderWanted { startRecorder() }
    }

    private func startRecorder() {
        guard platformServicesEnabled else { return }
        recorderWanted = true
        recorder?.stop()
        recorder = nil
        guard precision == .precise else {
            transitionCoverage(to: .coarseFallbackOnly, reason: "battery_saving", evidence: .observed)
            return
        }
        recorder = AppOwnedRecorder(coordinator: self)
        recorder?.start()
    }

    private func enqueueLocationBatch(
        _ locations: [CLLocation],
        acquisitionPath: String,
        configuration: RequestedLocationConfiguration
    ) {
        let receipt = WallAndMonotonicTime()
        let batchID = UUID()
        enqueue {
            var drafts: [CaptureDraft] = []
            var silenceBoundary: Date?
            var statesAbsence = false
            if let pending = self.pendingProcessAbsence,
                let boundary = self.lastFixDate
                    ?? CaptureTime.date(rfc3339: pending.start),
                let firstNewIndex = LocationBatchBookkeeping.earliestIndex(
                    after: boundary, in: locations)
            {
                let firstNew = locations[firstNewIndex]
                drafts.append(
                    self.gapDraft(
                        start: pending.start,
                        end: CaptureTime.rfc3339(firstNew.timestamp),
                        reason: pending.reason,
                        evidence: .inferred,
                        expected: pending.coverage,
                        priorSequence: self.lastFixSequence
                    ))
                statesAbsence = true
                silenceBoundary = firstNew.timestamp
            } else if self.pendingProcessAbsence == nil,
                let prior = self.lastFixDate,
                self.previousCoverageState == .highRateExpected
                    || self.coverageState == .highRateExpected
            {
                silenceBoundary = prior
            }
            let full = self.refusedForSpace
            if let boundary = silenceBoundary,
                self.previousCoverageState == .highRateExpected
                    || self.coverageState == .highRateExpected
            {
                for silence in LocationBatchBookkeeping.silences(
                    after: boundary,
                    exceeding: 180,
                    in: locations
                ) {
                    let firstNew = locations[silence.endIndex]
                    drafts.append(
                        self.gapDraft(
                            start: CaptureTime.rfc3339(silence.start),
                            end: CaptureTime.rfc3339(firstNew.timestamp),
                            reason: full ? "store_full" : "high_rate_silence",
                            evidence: full ? .observed : .inferred,
                            expected: .highRateExpected,
                            priorSequence: silence.start == self.lastFixDate
                                ? self.lastFixSequence
                                : nil
                        ))
                }
            }
            for (index, location) in locations.enumerated() {
                drafts.append(
                    .init(
                        kind: "fix",
                        observedAt: CaptureTime.rfc3339(location.timestamp),
                        captured: receipt,
                        payload: RawLocation.payload(
                            location,
                            acquisitionPath: acquisitionPath,
                            engine: AppOwnedRecorder.label,
                            configuration: configuration,
                            receipt: receipt,
                            batchID: batchID,
                            batchIndex: index,
                            batchCount: locations.count
                        )
                    ))
            }
            guard let written = await self.appendReadings(drafts) else { return }
            if statesAbsence { self.pendingProcessAbsence = nil }
            self.refusedForSpace = false
            let fixEntries = written.filter { $0.kind == "fix" }
            if let latestIndex = LocationBatchBookkeeping.latestIndex(in: locations),
                latestIndex < fixEntries.count
            {
                let latestLocation = locations[latestIndex]
                if self.lastFixDate.map({ latestLocation.timestamp >= $0 }) ?? true {
                    self.lastFixDate = latestLocation.timestamp
                    self.lastFixSequence = fixEntries[latestIndex].sequence
                }
            }
        }
    }

    private func gapDraft(
        start: String,
        end: String,
        reason: String,
        evidence: ReasonEvidence,
        expected: CoverageState,
        priorSequence: UInt64?
    ) -> CaptureDraft {
        .init(
            kind: "gap",
            observedAt: start,
            payload: GapEvidence.payload(
                start: start,
                end: end,
                reason: reason,
                evidence: evidence,
                expected: expected,
                priorSequence: priorSequence
            )
        )
    }

    private func enqueue(_ operation: @escaping @MainActor () async -> Void) {
        writeQueue.enqueue { await EnergyLedger.shared.measure(.location) { await operation() } }
    }

    private func activateFallbackManager() {
        guard !fallbackManagerIsActive else { return }
        fallbackManagerIsActive = true
        guard platformServicesEnabled else { return }
        fallbackManager.delegate = self
        fallbackManager.allowsBackgroundLocationUpdates = true
        fallbackManager.pausesLocationUpdatesAutomatically = true
    }

    private func recordCaptureState() {
        UIDevice.current.isBatteryMonitoringEnabled = true
        recordServiceEvent(
            "capture_state",
            detail: [
                "authorization": .string(String(describing: fallbackManager.authorizationStatus)),
                "accuracy_authorization": .string(
                    String(describing: fallbackManager.accuracyAuthorization)),
                "background_refresh_status": .string(
                    String(describing: UIApplication.shared.backgroundRefreshStatus)),
                "low_power_mode": .bool(ProcessInfo.processInfo.isLowPowerModeEnabled),
                "thermal_state": .string(String(describing: ProcessInfo.processInfo.thermalState)),
                "battery_level": .number(Double(UIDevice.current.batteryLevel)),
                "battery_state": .string(String(describing: UIDevice.current.batteryState)),
                "timezone_identifier": .string(TimeZone.current.identifier),
                "engine": .string(AppOwnedRecorder.label),
            ])
        Task { [weak self] in
            let enabled = await Task.detached {
                CLLocationManager.locationServicesEnabled()
            }.value
            self?.recordServiceEvent("location_services_state", detail: ["enabled": .bool(enabled)])
        }
    }

    private func persistIntent(armed: Bool) {
        do {
            _ = try persistIntentDurably(
                armed: armed,
                coverageState: coverageState
            )
        } catch {
            recordPersistenceFailure(error)
        }
    }

    private func persistIntentDurably(
        armed: Bool,
        coverageState: CoverageState
    ) throws -> TrackingIntentSaveResult {
        let previous: TrackingIntent?
        switch intentStore.loadState() {
        case .missing:
            previous = nil
        case .loaded(let intent):
            previous = intent
        case .failed(let diagnostic):
            throw CaptureError.corruptState(
                "refusing to replace unreadable tracking intent: \(diagnostic)")
        }
        if intentDurabilityUnconfirmed {
            guard let previous else {
                throw CaptureError.corruptState(
                    "visible tracking intent disappeared before durability was confirmed"
                )
            }
            guard confirmLoadedIntentDurability(previous) else {
                serviceRequested = previous.armed
                return .visibleButDurabilityUnconfirmed(
                    persistenceDiagnostic ?? "tracking intent durability remains unconfirmed"
                )
            }
        }
        let intent = TrackingIntent(armed: armed, coverageState: coverageState, bootID: bootID)
        let saveResult = try intentStore.save(intent)
        switch saveResult {
        case .durable:
            serviceRequested = armed
            intentDurabilityUnconfirmed = false
            persistenceDiagnostic = nil
        case .visibleButDurabilityUnconfirmed(let diagnostic):
            intentDurabilityUnconfirmed = true
            recordPersistenceFailureMessage(
                "tracking intent is visible but crash durability is unconfirmed: \(diagnostic)"
            )
        }
        return saveResult
    }

    private func confirmLoadedIntentDurability(_ intent: TrackingIntent) -> Bool {
        do {
            switch try intentStore.save(intent) {
            case .durable:
                serviceRequested = intent.armed
                intentDurabilityUnconfirmed = false
                persistenceDiagnostic = nil
                return true
            case .visibleButDurabilityUnconfirmed(let diagnostic):
                serviceRequested = false
                intentDurabilityUnconfirmed = true
                recordPersistenceFailureMessage(
                    "tracking intent is visible but crash durability is unconfirmed: \(diagnostic)"
                )
                return false
            }
        } catch {
            serviceRequested = nil
            recordPersistenceFailure(error)
            return false
        }
    }

    private func loadIntentState() -> PersistenceLoadState<TrackingIntent> {
        let state = intentStore.loadState()
        switch state {
        case .missing:
            serviceRequested = false
            intentDurabilityUnconfirmed = false
            persistenceDiagnostic = nil
        case .loaded(let intent):
            let recovered = persistenceDiagnostic != nil && !intentDurabilityUnconfirmed
            serviceRequested = intent.armed
            if !intentDurabilityUnconfirmed {
                persistenceDiagnostic = nil
                if recovered {
                    lastPlatformDiagnostic = "Persisted tracking intent restored"
                }
            }
        case .failed(let diagnostic):
            recordPersistenceFailureMessage(diagnostic)
        }
        return state
    }

    private func newestStoredFix() async throws -> (date: Date, sequence: UInt64)? {
        try await store.latestEntries(domain: .location, kind: "fix", limit: 64)
            .compactMap { entry in CaptureTime.date(rfc3339: entry.observedAt).map { ($0, entry.sequence) } }
            .max { $0.0 < $1.0 }
            .map { (date: $0.0, sequence: $0.1) }
    }

    private func resumePersistedIntent(_ intent: TrackingIntent, reason: String) {
        coverageState = intent.coverageState
        let crossedBoot = bootID != nil && intent.bootID != nil && intent.bootID != bootID
        enqueue {
            let found: (date: Date, sequence: UInt64)?
            do { found = try await self.newestStoredFix() } catch {
                self.recordPersistenceFailureMessage(
                    "the newest stored fix could not be read, so this relaunch's absence is not recorded: \(error.localizedDescription)")
                return
            }
            guard let newest = found, self.lastFixDate.map({ newest.date > $0 }) ?? true else { return }
            self.lastFixDate = newest.date
            self.lastFixSequence = newest.sequence
            self.pendingProcessAbsence = PendingProcessAbsence(
                start: CaptureTime.rfc3339(newest.date),
                reason: crossedBoot ? "reboot_or_preunlock_absence" : "unknown_process_absence",
                coverage: crossedBoot ? .deviceOffOrPreunlock : .processAbsence
            )
        }
        recreateSessionsAndLattice(reason: reason)
        startRecorder()
    }

    private func recordPersistenceFailure(_ error: Error) {
        recordPersistenceFailureMessage(error.localizedDescription)
    }

    private func recordPersistenceFailureMessage(_ message: String) {
        let diagnostic = "Persistence failure: \(message)"
        persistenceDiagnostic = diagnostic
        lastPlatformDiagnostic = diagnostic
    }
}

@MainActor
private final class AlwaysPromptWatch {
    private var resigned = false
    private var waiter: CheckedContinuation<Bool, Never>?
    private var tokens: [NSObjectProtocol] = []

    init() {
        let center = NotificationCenter.default
        tokens.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.resigned = true }
        })
        tokens.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { if self?.resigned == true { self?.finish(true) } }
        })
    }

    func granted() {
        finish(true)
    }

    func shown() async -> Bool {
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            if self?.resigned == false { self?.finish(false) }
        }
        return await withCheckedContinuation { waiter = $0 }
    }

    private func finish(_ shown: Bool) {
        guard let waiter else { return }
        for token in tokens { NotificationCenter.default.removeObserver(token) }
        tokens = []
        self.waiter = nil
        waiter.resume(returning: shown)
    }
}

enum LocationPrecision: String, Sendable {
    case precise, battery

    static let key = "location.precision"

    static var stored: LocationPrecision {
        UserDefaults.standard.string(forKey: key).flatMap(LocationPrecision.init(rawValue:)) ?? .precise
    }
}
