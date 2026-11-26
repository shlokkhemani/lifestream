import CoreLocation
import Foundation
import HomeLink
import LifestreamCaptureCore
import XCTest

@testable import Lifestream

@MainActor
final class LocationRecorderTests: XCTestCase {
    func testRecordersKeepBackgroundFixesWithoutRequestingTheBlueIndicator() throws {
        let coordinator = try makeCoordinator()
        let recorder = AppOwnedRecorder(coordinator: coordinator)
        for manager in [recorder.recordingManager, recorder.keepAliveManager] {
            XCTAssertTrue(manager.allowsBackgroundLocationUpdates)
            XCTAssertFalse(manager.showsBackgroundLocationIndicator)
        }
    }

    func testStationaryCheckWritesItsFixAndOneEvent() async throws {
        let coordinator = try makeCoordinator()
        let recorder = AppOwnedRecorder(coordinator: coordinator, watch: .init(stillInterval: 0.25))
        let settle = fix(latitude: 10)
        recorder.start()
        defer { recorder.stop() }
        recorder.settle(at: settle, reason: "test_settle")
        let settled = try await locationEntries(coordinator).count

        for _ in 0..<2 {
            try await until("recorder.state == .wakeup") { recorder.state == .wakeup }
            recorder.locationManager(CLLocationManager(), didUpdateLocations: [fix(latitude: 10)])
            XCTAssertEqual(recorder.state, .sleeping)
        }
        let checks = Array(try await locationEntries(coordinator).dropFirst(settled))
        XCTAssertEqual(checks.map(\.kind), ["fix", "recorder_event", "fix", "recorder_event"])
        guard case .object(let fixPayload) = checks[0].payload,
            case .object(let context)? = fixPayload["capture_context"]
        else { return XCTFail("a fix carries its capture context") }
        XCTAssertEqual(context["engine"], .string("app_owned"))
        XCTAssertEqual(context["acquisition_path"], .string("engine_b_precise"))
        XCTAssertEqual(context["diagnostics"], .object([:]))
        XCTAssertEqual(context["stationary"], .null)
        let (name, detail) = try event(checks[3])
        XCTAssertEqual(name, "engine_b_state")
        XCTAssertEqual(detail["from"], .string("sleeping"))
        XCTAssertEqual(detail["state"], .string("sleeping"))
        XCTAssertEqual(detail["reason"], .string("still_stationary"))
        guard case .number(let next)? = detail["next_check_seconds"] else { return XCTFail("the event says when the next check is due") }
        XCTAssertGreaterThan(next, 0)
        XCTAssertLessThanOrEqual(next, 0.25)
        guard case .object(let check)? = detail["check"] else {
            return XCTFail("a check's event says what the check found")
        }
        XCTAssertEqual(check["woke_by"], .string("adaptive_timer"))
        XCTAssertEqual(check["fixes"], .integer(1))
        XCTAssertEqual(check["fresh_fixes"], .integer(1))
        XCTAssertEqual(coordinator.coverageState, .stationaryAutoPaused)

        try await until("recorder.state == .wakeup") { recorder.state == .wakeup }
        recorder.locationManager(CLLocationManager(), didUpdateLocations: [fix(latitude: 10.01)])
        XCTAssertEqual(recorder.state, .wakeup, "one fix far away is no departure")
        recorder.testAdvance = StillWatch.confirmGap
        recorder.locationManager(CLLocationManager(), didUpdateLocations: [fix(latitude: 10.01, madeIn: StillWatch.confirmGap)])
        XCTAssertEqual(recorder.state, .recording)
        let departure = Array(try await locationEntries(coordinator).dropFirst(settled + 4))
        XCTAssertEqual(departure.prefix(2).map(\.kind), ["fix", "fix"])
        XCTAssertEqual(try departure.dropFirst(2).map { try event($0).0 }, [
            "engine_b_state", "moving", "coverage_transition",
        ])
        XCTAssertEqual(try event(departure[2]).1["reason"], .string("left_settle_region"))
        XCTAssertEqual(try event(departure[3]).1["reason"], .string("left_settle_region"), "the moving the send clock hears, and why")
        XCTAssertEqual(coordinator.coverageState, .highRateExpected)
    }

    func testAKeptFixAndAStrayFixNeverLeave() async throws {
        let coordinator = try makeCoordinator()
        let recorder = AppOwnedRecorder(coordinator: coordinator, watch: .init(stillInterval: 0.25))
        recorder.start()
        defer { recorder.stop() }
        recorder.settle(at: fix(latitude: 10), reason: "test_settle")
        let settled = try await locationEntries(coordinator).count

        try await until("recorder.state == .wakeup") { recorder.state == .wakeup }
        recorder.locationManager(CLLocationManager(), didUpdateLocations: [fix(latitude: 10, madeIn: -5)])
        XCTAssertEqual(recorder.state, .wakeup, "a fix kept from before, inside: the check goes on")
        recorder.locationManager(CLLocationManager(), didUpdateLocations: [fix(latitude: 10.01, madeIn: -5)])
        XCTAssertEqual(recorder.state, .wakeup, "a fix kept from before, far away: no doubt begins")
        recorder.locationManager(CLLocationManager(), didUpdateLocations: [fix(latitude: 10.01)])
        XCTAssertEqual(recorder.state, .wakeup, "a fresh fix far away: doubt")
        recorder.testAdvance = StillWatch.confirmGap
        recorder.locationManager(CLLocationManager(), didUpdateLocations: [fix(latitude: 10, madeIn: StillWatch.confirmGap)])
        XCTAssertEqual(recorder.state, .sleeping, "the next fix is back where the phone settled")

        let written = Array(try await locationEntries(coordinator).dropFirst(settled))
        XCTAssertEqual(written.map(\.kind), ["fix", "fix", "fix", "fix", "recorder_event"], "every fix is kept")
        let (name, detail) = try event(written[4])
        XCTAssertEqual(name, "engine_b_state")
        XCTAssertEqual(detail["reason"], .string("still_stationary"))
        guard case .object(let check)? = detail["check"] else { return XCTFail("the check's event says what it found") }
        XCTAssertEqual(check["fixes"], .integer(4))
        XCTAssertEqual(check["fresh_fixes"], .integer(2))
        XCTAssertEqual(coordinator.coverageState, .stationaryAutoPaused)
    }

    func testMovementHeardStartsACheckAndNarrowsTheReach() async throws {
        let coordinator = try makeCoordinator()
        let recorder = AppOwnedRecorder(coordinator: coordinator, watch: .init(stillInterval: 3_600))
        recorder.start()
        defer { recorder.stop() }
        recorder.settle(at: fix(latitude: 10), reason: "test_settle")
        let settled = try await locationEntries(coordinator).count
        XCTAssertEqual(recorder.state, .sleeping)

        recorder.motionActivityChanged(.stationary)
        XCTAssertEqual(recorder.state, .sleeping, "stillness starts no check")
        recorder.motionActivityChanged(.walking)
        XCTAssertEqual(recorder.state, .wakeup)
        recorder.locationManager(CLLocationManager(), didUpdateLocations: [fix(latitude: 10)])
        XCTAssertEqual(recorder.state, .sleeping, "walking about the room")
        recorder.motionActivityChanged(.walking)
        XCTAssertEqual(recorder.state, .sleeping, "movement that goes on waits the moving interval after a check")

        recorder.regionExited()
        XCTAssertEqual(recorder.state, .wakeup, "the OS's exit is checked at once")
        recorder.locationManager(CLLocationManager(), didUpdateLocations: [fix(latitude: 10.0006)])
        XCTAssertEqual(recorder.state, .wakeup)
        recorder.testAdvance = StillWatch.confirmGap
        recorder.locationManager(CLLocationManager(), didUpdateLocations: [fix(latitude: 10.0006, madeIn: StillWatch.confirmGap)])
        XCTAssertEqual(recorder.state, .recording)

        let events = try Array(try await locationEntries(coordinator).dropFirst(settled))
            .filter { $0.kind == "recorder_event" }.map { try event($0) }
        let checks = events.compactMap { event -> JSONValue? in
            guard event.0 == "engine_b_state", case .object(let check)? = event.1["check"] else { return nil }
            return check["woke_by"]
        }
        XCTAssertEqual(checks, [.string("motion"), .string("geofence_exit")])
        XCTAssertEqual(events.filter { $0.0 == "moving" }.count, 1)
    }

    func testAFixInAStillPhonesReachIsStill() async throws {
        let coordinator = try makeCoordinator()
        let recorder = AppOwnedRecorder(coordinator: coordinator, watch: .init(stillInterval: 0.25))
        recorder.start()
        defer { recorder.stop() }
        recorder.settle(at: fix(latitude: 10), reason: "test_settle")
        try await until("recorder.state == .wakeup") { recorder.state == .wakeup }
        recorder.locationManager(CLLocationManager(), didUpdateLocations: [fix(latitude: 10.0006)])
        XCTAssertEqual(recorder.state, .sleeping)
        XCTAssertEqual(coordinator.coverageState, .stationaryAutoPaused)
    }

    func testAPauseBeforeAnySettleKeepsRecording() async throws {
        let coordinator = try makeCoordinator()
        let recorder = AppOwnedRecorder(coordinator: coordinator, watch: .init(stillInterval: 0.25))
        recorder.start()
        defer { recorder.stop() }
        recorder.locationManagerDidPauseLocationUpdates(recorder.recordingManager)
        XCTAssertEqual(recorder.state, .recording)
        recorder.regionExited()
        recorder.motionActivityChanged(.walking)
        XCTAssertEqual(recorder.state, .recording)
        let events = try await locationEntries(coordinator).filter { $0.kind == "recorder_event" }.map { try event($0) }
        XCTAssertFalse(events.contains { $0.0 == "engine_b_state" && $0.1["check"] != nil }, "no check ran")
        XCTAssertFalse(events.contains { $0.0 == "moving" })
    }

    func testAKeepAliveCallbackStartsNoCheckAndACheckAsksForEveryFix() async throws {
        let coordinator = try makeCoordinator()
        let recorder = AppOwnedRecorder(coordinator: coordinator, watch: .init(stillInterval: 3_600))
        recorder.start()
        defer { recorder.stop() }
        XCTAssertEqual(recorder.recordingManager.distanceFilter, 22)
        recorder.settle(at: fix(latitude: 10), reason: "test_settle")
        let settled = try await locationEntries(coordinator).count

        recorder.locationManager(recorder.keepAliveManager, didUpdateLocations: [fix(latitude: 10.01)])
        recorder.locationManager(recorder.keepAliveManager, didUpdateLocations: [fix(latitude: 10.01, madeIn: StillWatch.confirmGap)])
        XCTAssertEqual(recorder.state, .sleeping)
        let written = Array(try await locationEntries(coordinator).dropFirst(settled))
        XCTAssertEqual(try written.map { try event($0).0 }, [
            "engine_b_keepalive_callback_discarded", "engine_b_keepalive_callback_discarded",
        ])

        recorder.regionExited()
        XCTAssertEqual(recorder.state, .wakeup)
        XCTAssertEqual(recorder.recordingManager.distanceFilter, kCLDistanceFilterNone)
        recorder.regionExited()
        XCTAssertEqual(recorder.state, .wakeup)
        XCTAssertEqual(recorder.recordingManager.distanceFilter, kCLDistanceFilterNone)
        recorder.locationManager(recorder.recordingManager, didUpdateLocations: [fix(latitude: 10.01)])
        recorder.testAdvance = StillWatch.confirmGap
        recorder.locationManager(recorder.recordingManager, didUpdateLocations: [fix(latitude: 10.01, madeIn: StillWatch.confirmGap)])
        XCTAssertEqual(recorder.state, .recording)
        XCTAssertEqual(recorder.recordingManager.distanceFilter, 22, "travelling again, the filter is back")
        let checks = try await locationEntries(coordinator).filter { $0.kind == "recorder_event" }.map { try event($0) }
            .filter { $0.0 == "engine_b_state" && $0.1["check"] != nil }
        XCTAssertEqual(checks.count, 1)
    }

    func testOnlyAnUnsatisfiedConditionIsAnExit() {
        XCTAssertTrue(LocationRecorderCoordinator.leftRegion(.unsatisfied))
        for state: CLMonitor.Event.State in [.satisfied, .unknown, .unmonitored] {
            XCTAssertFalse(LocationRecorderCoordinator.leftRegion(state))
        }
    }

    func testRepeatedMotionModeAndUnchangedCaptureStateWriteNothing() async throws {
        let coordinator = try makeCoordinator()
        for mode: MotionTravelMode in [.stationary, .stationary, .walking, .walking, .stationary] {
            coordinator.motionActivityChanged(mode)
        }
        let energy = EnergyLedger()
        energy.attach(coordinator.store)
        let monitor = CaptureStateMonitor(locationRecorder: coordinator, energy: energy)
        monitor.sample(reason: "monitor_started")
        monitor.sample(reason: "five_minute_poll")
        monitor.sample(reason: "five_minute_poll")

        let events = try await locationEntries(coordinator).map { try event($0) }
        XCTAssertEqual(events.map(\.0), [
            "motion_configuration_selector", "motion_configuration_selector",
            "motion_configuration_selector",
        ])
        await energy.flush()
        let states = try await coordinator.store.entries(domain: .energy).map(\.kind)
        XCTAssertEqual(states.filter { $0 == "power_state" }.count, 1)
        XCTAssertEqual(events.prefix(3).map { $0.1["mode"] }, [
            .string("stationary"), .string("walking"), .string("stationary"),
        ])
    }


    func testRecordingThatHearsNothingIsCheckedAndSleepsWhereAFreshFixSays() async throws {
        let coordinator = try makeCoordinator()
        let told = Told(coordinator)
        let (recorder, asked) = quickRecorder(coordinator, stillInterval: 0.25)
        recorder.start()
        defer { recorder.stop() }
        recorder.settle(at: fix(latitude: 10), reason: "test_settle")
        let settled = try await locationEntries(coordinator).count
        try await until("the settled phone's check") { recorder.state == .wakeup }
        twoFixesApart(recorder, latitude: 10.01)
        XCTAssertEqual(recorder.state, .recording)
        XCTAssertNotNil(recorder.deadline, "recording states when it next acts")

        try await until("recording's quiet check") { recorder.state == .wakeup }
        XCTAssertEqual(Array(asked.recording.suffix(2)), [false, true], "the check stops the manager, then starts it")
        recorder.locationManager(recorder.recordingManager, didUpdateLocations: [fix(latitude: 10.0001, madeIn: recorder.testAdvance)])
        XCTAssertEqual(recorder.state, .sleeping)
        XCTAssertEqual(recorder.settledLocation?.coordinate.latitude, 10.0001, "settled at the fresh fix, not at S")

        let events = try await recorderEvents(coordinator, after: settled)
        XCTAssertEqual(events.filter { $0.0 == "moving" }.count, 1)
        let settles = events.filter { $0.0 == "settled" }
        XCTAssertEqual(settles.map { $0.1["reason"] }, [.string("recording_quiet")])
        let quiet = try XCTUnwrap(events.first { checkOf($0)?["woke_by"] == .string("recording_quiet") })
        XCTAssertEqual(quiet.1["from"], .string("recording"))
        XCTAssertEqual(quiet.1["state"], .string("sleeping"))
        XCTAssertEqual(told.events.filter { $0 == .moving }.count, 1)
    }

    func testAnUnansweredQuietCheckWithMotionUnknownSettles() async throws {
        let coordinator = try makeCoordinator()
        let (recorder, asked) = quickRecorder(coordinator, checkTimeout: 0.25)
        recorder.start()
        defer { recorder.stop() }
        recorder.locationManager(recorder.recordingManager, didUpdateLocations: [fix(latitude: 10)])
        try await until("the unanswered quiet check settled") { recorder.state == .sleeping }
        XCTAssertEqual(recorder.settledLocation?.coordinate.latitude, 10)
        XCTAssertEqual(asked.recording, [true, false, true, false], "started, the check's re-arm, asleep")
        let events = try await recorderEvents(coordinator)
        XCTAssertEqual(recorder.state, .sleeping)
        XCTAssertEqual(asked.recording.count, 4, "no restart after")
        XCTAssertEqual(events.filter { $0.0 == "settled" }.map { $0.1["reason"] }, [.string("recording_quiet_unanswered")])
        XCTAssertFalse(events.contains { $0.0 == "moving" })
    }

    func testAWalkerIOSGivesNoFixRecordsOn() async throws {
        try await movingStall(.walking, rounds: 1)
    }

    func testADriverIOSGivesNoFixRecordsOn() async throws {
        try await movingStall(.vehicle, rounds: 1)
    }

    func testAStallOverRoundsTellsTheSendClockNothing() async throws {
        try await movingStall(.walking, rounds: 3)
    }

    func testAQuietCheckThatFindsThePhoneGoneRecordsOn() async throws {
        let coordinator = try makeCoordinator()
        let told = Told(coordinator)
        let (recorder, _) = quickRecorder(coordinator)
        recorder.start()
        defer { recorder.stop() }
        recorder.locationManager(recorder.recordingManager, didUpdateLocations: [fix(latitude: 10)])
        try await until("recording's quiet check") { recorder.state == .wakeup }
        twoFixesApart(recorder, latitude: 10.01)
        XCTAssertEqual(recorder.state, .recording)
        XCTAssertNotNil(recorder.deadline, "the deadline armed again")
        let events = try await recorderEvents(coordinator)
        XCTAssertFalse(events.contains { $0.0 == "moving" })
        let quiet = try XCTUnwrap(events.first { checkOf($0)?["woke_by"] == .string("recording_quiet") })
        XCTAssertEqual(quiet.1["from"], .string("recording"))
        XCTAssertEqual(quiet.1["state"], .string("recording"))
        XCTAssertFalse(told.events.contains(.moving))
        try await until("the next quiet check") { recorder.state == .wakeup }
    }

    func testNoCentreRestartsTheManager() async throws {
        let coordinator = try makeCoordinator()
        let (recorder, asked) = quickRecorder(coordinator)
        recorder.start()
        defer { recorder.stop() }
        try await until("two restarts at the deadline") { asked.recording.count >= 5 }
        XCTAssertEqual(recorder.state, .recording)
        XCTAssertEqual(Array(asked.recording.prefix(5)), [true, false, true, false, true])
        let events = try await recorderEvents(coordinator)
        XCTAssertFalse(events.contains { checkOf($0) != nil }, "no check began")
    }

    func testDegradedModeHasNoDeadline() async throws {
        let coordinator = try makeCoordinator()
        let (recorder, _) = quickRecorder(coordinator)
        recorder.start()
        defer { recorder.stop() }
        recorder.locationManager(recorder.recordingManager, didUpdateLocations: [fix(latitude: 10)])
        XCTAssertNotNil(recorder.deadline)
        recorder.degradedModeChanged(true, reason: "test")
        XCTAssertNil(recorder.deadline, "no fix is expected, and the coverage says so")
        recorder.locationManager(recorder.recordingManager, didUpdateLocations: [fix(latitude: 10)])
        XCTAssertNil(recorder.deadline, "a degraded fix arms nothing")
        recorder.degradedModeChanged(false, reason: "test")
        XCTAssertNotNil(recorder.deadline)
        try await until("the quiet check after degraded mode") { recorder.state == .wakeup }
    }


    func testALockedSettleAnOpenMonitorTakesIsArmed() async throws {
        let (coordinator, geofences) = try fencedCoordinator()
        coordinator.startCatchGeofenceMonitor(replacingAt: nil)
        await coordinator.awaitBootstrapBarrier()
        geofences.locked = true
        coordinator.startCatchGeofenceMonitor(replacingAt: fix(latitude: 10))
        await coordinator.awaitBootstrapBarrier()
        XCTAssertEqual(geofences.monitors.map(\.calls), [["add 10.0"]])
        let owed = try await owedFence(coordinator)
        XCTAssertNil(owed)
        let armed = try await recorderEvents(coordinator).filter { $0.0 == "catch_geofence_armed" }
        XCTAssertEqual(armed.map { $0.1["locked"] }, [.bool(true)])
    }

    func testARefusedSettleIsOwedAndTheUnlockArmsIt() async throws {
        let (coordinator, geofences) = try fencedCoordinator()
        coordinator.recorder = AppOwnedRecorder(coordinator: coordinator)
        coordinator.startCatchGeofenceMonitor(replacingAt: nil)
        await coordinator.awaitBootstrapBarrier()
        geofences.locked = true
        geofences.takesWhileLocked = false
        coordinator.startCatchGeofenceMonitor(replacingAt: fix(latitude: 10))
        await coordinator.awaitBootstrapBarrier()
        let owed = try await owedFence(coordinator)
        XCTAssertEqual(owed?.fence.latitude, 10)
        let deferred = try await recorderEvents(coordinator).filter { $0.0 == "catch_geofence_deferred" }
        XCTAssertEqual(deferred.map { $0.1["reason"] }, [.string("not_taken_while_locked")])

        geofences.locked = false
        coordinator.protectedDataDidBecomeAvailable()
        await coordinator.awaitBootstrapBarrier()
        XCTAssertEqual(geofences.monitors.map(\.calls), [["add 10.0", "add 10.0"]], "added once more, at the unlock")
        let paid = try await owedFence(coordinator)
        XCTAssertNil(paid)
        let armed = try await recorderEvents(coordinator).filter { $0.0 == "catch_geofence_armed" }
        XCTAssertEqual(armed.map { $0.1["locked"] }, [.bool(false)])
        XCTAssertNotNil(armed.first?.1["owed_seconds"])
    }

    func testTheUnlockArmsTheDebtNotTheLastFix() async throws {
        let (coordinator, geofences) = try fencedCoordinator()
        geofences.locked = true
        try coordinator.armAndRequestAuthorization()
        coordinator.recorder = AppOwnedRecorder(coordinator: coordinator)
        coordinator.handleLegacyBatch([fix(latitude: 11)], acquisitionPath: "synthetic", configuration: synthetic)
        coordinator.startCatchGeofenceMonitor(replacingAt: fix(latitude: 10))
        await coordinator.awaitBootstrapBarrier()
        XCTAssertTrue(geofences.monitors.isEmpty, "nothing opens while locked")
        let owed = try await owedFence(coordinator)
        XCTAssertEqual(owed?.fence.latitude, 10)

        geofences.locked = false
        coordinator.protectedDataDidBecomeAvailable()
        await coordinator.awaitBootstrapBarrier()
        XCTAssertEqual(geofences.monitors.map(\.calls), [["add 10.0"]])
    }

    func testAMoveAddsWithNoRemove() async throws {
        let (coordinator, geofences) = try fencedCoordinator()
        coordinator.startCatchGeofenceMonitor(replacingAt: fix(latitude: 10))
        coordinator.startCatchGeofenceMonitor(replacingAt: fix(latitude: 11))
        await coordinator.awaitBootstrapBarrier()
        XCTAssertEqual(geofences.monitors.map(\.calls), [["add 10.0", "add 11.0"]])
        let owed = try await owedFence(coordinator)
        XCTAssertNil(owed)
        let armed = try await recorderEvents(coordinator).filter { $0.0 == "catch_geofence_armed" }
        XCTAssertEqual(armed.map { $0.1["locked"] }, [.bool(false), .bool(false)])
    }

    func testTwoRefusedSettlesOweTheNewer() async throws {
        let (coordinator, geofences) = try fencedCoordinator()
        coordinator.recorder = AppOwnedRecorder(coordinator: coordinator)
        coordinator.startCatchGeofenceMonitor(replacingAt: nil)
        await coordinator.awaitBootstrapBarrier()
        geofences.locked = true
        geofences.takesWhileLocked = false
        coordinator.startCatchGeofenceMonitor(replacingAt: fix(latitude: 10))
        coordinator.startCatchGeofenceMonitor(replacingAt: fix(latitude: 11))
        await coordinator.awaitBootstrapBarrier()
        let owed = try await owedFence(coordinator)
        XCTAssertEqual(owed?.fence.latitude, 11)
        geofences.locked = false
        coordinator.protectedDataDidBecomeAvailable()
        await coordinator.awaitBootstrapBarrier()
        XCTAssertEqual(geofences.monitors.map(\.calls), [["add 10.0", "add 11.0", "add 11.0"]])
        let paid = try await owedFence(coordinator)
        XCTAssertNil(paid)
    }

    func testTheDebtOutlivesAKill() async throws {
        let root = try temporaryRoot()
        let store = try CaptureStore(root: root.appendingPathComponent("capture"))
        let intent = root.appendingPathComponent("intent.json")
        let before = FakeGeofences()
        let killed = LocationRecorderCoordinator(
            store: store, intentStore: TrackingIntentStore(url: intent), bootID: UUID(),
            platformServicesEnabled: false, geofences: before)
        try killed.armAndRequestAuthorization()
        before.locked = true
        before.takesWhileLocked = false
        killed.startCatchGeofenceMonitor(replacingAt: fix(latitude: 10))
        await killed.awaitBootstrapBarrier()

        let after = FakeGeofences()
        after.locked = true
        let relaunched = LocationRecorderCoordinator(
            store: store, intentStore: TrackingIntentStore(url: intent), bootID: UUID(),
            platformServicesEnabled: false, geofences: after)
        relaunched.bootstrap()
        await relaunched.awaitBootstrapBarrier()
        XCTAssertTrue(after.monitors.isEmpty, "launched locked, nothing opens")
        after.locked = false
        relaunched.protectedDataDidBecomeAvailable()
        await relaunched.awaitBootstrapBarrier()
        XCTAssertEqual(after.monitors.map(\.calls), [["add 10.0"]])
        let paid = try await owedFence(relaunched)
        XCTAssertNil(paid)
        let armed = try await recorderEvents(relaunched).filter { $0.0 == "catch_geofence_armed" }
        XCTAssertEqual(armed.count, 1)
    }

    func testAnOlderSetupNeverClearsANewerDebt() async throws {
        let (coordinator, geofences) = try fencedCoordinator()
        coordinator.startCatchGeofenceMonitor(replacingAt: nil)
        await coordinator.awaitBootstrapBarrier()
        geofences.onAdd = { [unowned coordinator, unowned geofences] in
            geofences.onAdd = nil
            geofences.locked = true
            geofences.takesWhileLocked = false
            coordinator.startCatchGeofenceMonitor(replacingAt: self.fix(latitude: 11))
        }
        coordinator.startCatchGeofenceMonitor(replacingAt: fix(latitude: 10))
        try await until("the newer settle's setup ended") {
            try await recorderEvents(coordinator).contains { $0.0 == "catch_geofence_deferred" }
        }
        let owed = try await owedFence(coordinator)
        XCTAssertEqual(owed?.fence.latitude, 11)
        XCTAssertEqual(geofences.monitors.map(\.calls), [["add 10.0", "add 11.0"]])
    }

    func testANewerDebtStampedEarlierIsKeptWhenAnOlderCircleIsArmed() async throws {
        let (coordinator, geofences) = try fencedCoordinator()
        coordinator.startCatchGeofenceMonitor(replacingAt: nil)
        await coordinator.awaitBootstrapBarrier()
        let newer = OwedFence(
            fence: Fence(latitude: 11, longitude: 0, radius: 200), at: Date(timeIntervalSince1970: 0),
            process: LocationRecorderCoordinator.fenceProcess, n: Int.max)
        geofences.onAdd = { [unowned coordinator, unowned geofences] in
            geofences.onAdd = nil
            try? await coordinator.store.setAnchor(
                LocationRecorderCoordinator.owedFenceKey, try JSONEncoder().encode(newer))
        }
        coordinator.startCatchGeofenceMonitor(replacingAt: fix(latitude: 10))
        try await until("the older circle was armed") {
            try await recorderEvents(coordinator).contains { $0.0 == "catch_geofence_armed" }
        }
        let owed = try await owedFence(coordinator)
        XCTAssertEqual(owed, newer)
    }

    func testAnEarlierProcesssDebtStampedLaterGoesWithANewerCircle() {
        let earlier = OwedFence(
            fence: Fence(latitude: 9, longitude: 0, radius: 200), at: Date(timeIntervalSinceNow: 3600),
            process: UUID(), n: 7)
        let armed = OwedFence(
            fence: Fence(latitude: 10, longitude: 0, radius: 200), at: Date(),
            process: LocationRecorderCoordinator.fenceProcess, n: 1)
        XCTAssertTrue(earlier.notNewer(than: armed, now: LocationRecorderCoordinator.fenceProcess))
        XCTAssertFalse(armed.notNewer(than: earlier, now: LocationRecorderCoordinator.fenceProcess))
    }

    func testACircleReadBackHalfAMetreOffIsTaken() async throws {
        let (coordinator, geofences) = try fencedCoordinator()
        geofences.readBackOffset = 0.5 / 111_320
        coordinator.startCatchGeofenceMonitor(replacingAt: fix(latitude: 10))
        await coordinator.awaitBootstrapBarrier()
        let owed = try await owedFence(coordinator)
        XCTAssertNil(owed)
        let armed = try await recorderEvents(coordinator).filter { $0.0 == "catch_geofence_armed" }
        XCTAssertEqual(armed.count, 1)
    }

    func testBatterySavingsUnlockDoesNothing() async throws {
        let (coordinator, geofences) = try fencedCoordinator()
        try coordinator.armAndRequestAuthorization()
        await coordinator.awaitBootstrapBarrier()
        XCTAssertEqual(geofences.monitors.count, 1)
        let written = try await locationEntries(coordinator).count
        geofences.locked = true
        geofences.locked = false
        coordinator.protectedDataDidBecomeAvailable()
        await coordinator.awaitBootstrapBarrier()
        XCTAssertEqual(geofences.monitors.count, 1)
        XCTAssertEqual(geofences.monitors.map(\.calls), [[]])
        let after = try await locationEntries(coordinator).count
        XCTAssertEqual(after, written, "nothing written at the unlock")
    }


    func testASilenceRefusedForSpaceIsNamedStoreFull() async throws {
        let free = Free(Room.keepBytes)
        let coordinator = try makeCoordinator(free: free)
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        coordinator.handleLegacyBatch([fix(at: start)], acquisitionPath: "synthetic", configuration: synthetic)
        await coordinator.awaitBootstrapBarrier()
        free.bytes = Room.bottomBytes - 1
        coordinator.handleLegacyBatch([fix(at: start + 100)], acquisitionPath: "synthetic", configuration: synthetic)
        coordinator.handleLegacyBatch([fix(at: start + 250)], acquisitionPath: "synthetic", configuration: synthetic)
        await coordinator.awaitBootstrapBarrier()
        XCTAssertTrue(coordinator.refusedForSpace)
        free.bytes = Room.keepBytes
        coordinator.handleLegacyBatch([fix(at: start + 400)], acquisitionPath: "synthetic", configuration: synthetic)
        let gaps = try await gapsOf(coordinator)
        XCTAssertEqual(gaps.map { $0["reason"] }, [.string("store_full")], "one stretch, one gap")
        XCTAssertEqual(gaps.first?["reason_evidence"], .string("observed"))
        XCTAssertEqual(gaps.first?["start"], .string(CaptureTime.rfc3339(start)))
        XCTAssertEqual(gaps.first?["end"], .string(CaptureTime.rfc3339(start + 400)))
        XCTAssertFalse(coordinator.refusedForSpace)
    }

    func testAPendingAbsenceOutlivesARefusedBatch() async throws {
        let free = Free(Room.keepBytes)
        let (relaunched, start) = try await relaunchedOverAFix(free: free)
        free.bytes = Room.bottomBytes - 1
        relaunched.handleLegacyBatch([fix(at: start + 600)], acquisitionPath: "synthetic", configuration: synthetic)
        await relaunched.awaitBootstrapBarrier()
        free.bytes = Room.keepBytes
        relaunched.handleLegacyBatch([fix(at: start + 700)], acquisitionPath: "synthetic", configuration: synthetic)
        let gaps = try await gapsOf(relaunched)
        XCTAssertEqual(gaps.map { $0["reason"] }, [.string("reboot_or_preunlock_absence")])
        XCTAssertEqual(gaps.first?["start"], .string(CaptureTime.rfc3339(start)))
        XCTAssertEqual(gaps.first?["end"], .string(CaptureTime.rfc3339(start + 700)))
    }

    func testCachedFixesLeaveTheAbsencePending() async throws {
        let free = Free(Room.keepBytes)
        let (relaunched, start) = try await relaunchedOverAFix(free: free)
        relaunched.handleLegacyBatch([fix(at: start - 30)], acquisitionPath: "synthetic", configuration: synthetic)
        let none = try await gapsOf(relaunched)
        XCTAssertTrue(none.isEmpty)
        relaunched.handleLegacyBatch([fix(at: start + 600)], acquisitionPath: "synthetic", configuration: synthetic)
        let gaps = try await gapsOf(relaunched)
        XCTAssertEqual(gaps.map { $0["reason"] }, [.string("reboot_or_preunlock_absence")])
    }

    func testARefusalNotForSpaceIsNoFullStore() async throws {
        let coordinator = try makeCoordinator(free: Free(Room.keepBytes))
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        coordinator.handleLegacyBatch([fix(at: start)], acquisitionPath: "synthetic", configuration: synthetic)
        await coordinator.awaitBootstrapBarrier()
        try await coordinator.store.markStopped(at: start + 100)
        coordinator.handleLegacyBatch([fix(at: start + 400)], acquisitionPath: "synthetic", configuration: synthetic)
        await coordinator.awaitBootstrapBarrier()
        XCTAssertFalse(coordinator.refusedForSpace)
    }

    private func movingStall(_ mode: MotionTravelMode, rounds: Int) async throws {
        let coordinator = try makeCoordinator()
        let told = Told(coordinator)
        let (recorder, asked) = quickRecorder(coordinator, checkTimeout: 0.25)
        recorder.start()
        defer { recorder.stop() }
        recorder.motionActivityChanged(mode)
        recorder.locationManager(recorder.recordingManager, didUpdateLocations: [fix(latitude: 10)])
        let calls = 1 + 4 * rounds
        try await until("\(rounds) unanswered quiet checks") { asked.recording.count >= calls && recorder.state == .recording }
        XCTAssertEqual(Array(asked.recording.prefix(calls)), [true] + Array(repeating: [false, true], count: 2 * rounds).flatMap { $0 })
        let events = try await recorderEvents(coordinator)
        XCTAssertFalse(events.contains { $0.0 == "moving" })
        XCTAssertFalse(events.contains { $0.0 == "settled" })
        let quiet = events.filter { checkOf($0)?["woke_by"] == .string("recording_quiet") }
        XCTAssertGreaterThanOrEqual(quiet.count, rounds)
        XCTAssertTrue(quiet.allSatisfy { $0.1["state"] == .string("recording") })
        XCTAssertFalse(told.events.contains(.moving))
    }

    private func quickRecorder(
        _ coordinator: LocationRecorderCoordinator, stillInterval: TimeInterval = 3_600,
        checkTimeout: TimeInterval = StillWatch.checkTimeout
    ) -> (AppOwnedRecorder, Asked) {
        let recorder = AppOwnedRecorder(
            coordinator: coordinator, watch: .init(stillInterval: stillInterval, checkTimeout: checkTimeout),
            quiet: { RecorderTuning.settleHysteresis(for: $0) / 1_000 })
        let asked = Asked()
        recorder.asked = { [unowned recorder] manager, on in
            if manager === recorder.recordingManager { asked.recording.append(on) }
        }
        return (recorder, asked)
    }

    private func twoFixesApart(_ recorder: AppOwnedRecorder, latitude: Double) {
        recorder.locationManager(recorder.recordingManager, didUpdateLocations: [fix(latitude: latitude, madeIn: recorder.testAdvance)])
        recorder.testAdvance += StillWatch.confirmGap
        recorder.locationManager(recorder.recordingManager, didUpdateLocations: [fix(latitude: latitude, madeIn: recorder.testAdvance)])
    }

    private func recorderEvents(_ coordinator: LocationRecorderCoordinator, after: Int = 0) async throws -> [(String, [String: JSONValue])] {
        try Array(try await locationEntries(coordinator).dropFirst(after)).filter { $0.kind == "recorder_event" }.map { try event($0) }
    }

    private func checkOf(_ event: (String, [String: JSONValue])) -> [String: JSONValue]? {
        guard event.0 == "engine_b_state", case .object(let check)? = event.1["check"] else { return nil }
        return check
    }

    private func makeCoordinator(free: Free? = nil, geofences: FakeGeofences? = nil) throws -> LocationRecorderCoordinator {
        let root = try temporaryRoot()
        let capture = root.appendingPathComponent("capture")
        return LocationRecorderCoordinator(
            store: try CaptureStore(
                root: capture, volume: free.map { free in Volume(capture, every: 0, read: { _ in free.bytes }) }),
            intentStore: TrackingIntentStore(url: root.appendingPathComponent("intent.json")),
            bootID: UUID(),
            platformServicesEnabled: false,
            geofences: geofences
        )
    }

    private func temporaryRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("lifestream-recorder-tests-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    private func fencedCoordinator() throws -> (LocationRecorderCoordinator, FakeGeofences) {
        let geofences = FakeGeofences()
        return (try makeCoordinator(geofences: geofences), geofences)
    }

    private func owedFence(_ coordinator: LocationRecorderCoordinator) async throws -> OwedFence? {
        await coordinator.awaitBootstrapBarrier()
        return try await coordinator.store.anchor(LocationRecorderCoordinator.owedFenceKey)
            .map { try JSONDecoder().decode(OwedFence.self, from: $0) }
    }

    private func relaunchedOverAFix(free: Free) async throws -> (LocationRecorderCoordinator, Date) {
        let first = try makeCoordinator(free: free)
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        try first.armAndRequestAuthorization()
        first.handleLegacyBatch([fix(at: start)], acquisitionPath: "synthetic", configuration: synthetic)
        await first.awaitBootstrapBarrier()
        try await first.store.flush()
        let relaunched = LocationRecorderCoordinator(
            store: first.store, intentStore: first.intentStore, bootID: UUID(), platformServicesEnabled: false)
        relaunched.bootstrap()
        await relaunched.awaitBootstrapBarrier()
        return (relaunched, start)
    }

    private func gapsOf(_ coordinator: LocationRecorderCoordinator) async throws -> [[String: JSONValue]] {
        try await locationEntries(coordinator).filter { $0.kind == "gap" }.compactMap { entry in
            guard case .object(let gap) = entry.payload else { return nil }
            return gap
        }
    }

    private var synthetic: RequestedLocationConfiguration {
        .init(desiredAccuracy: 10, distanceFilter: 0, activityType: .other, pausesAutomatically: false)
    }

    private func fix(at date: Date) -> CLLocation {
        CLLocation(
            coordinate: .init(latitude: 10, longitude: 20), altitude: 0, horizontalAccuracy: 10,
            verticalAccuracy: 10, course: -1, speed: -1, timestamp: date)
    }

    private func locationEntries(
        _ coordinator: LocationRecorderCoordinator
    ) async throws -> [CaptureEntry] {
        await coordinator.awaitBootstrapBarrier()
        try await coordinator.store.flush()
        return try await coordinator.store.entries(domain: .location)
    }

    private func event(_ entry: CaptureEntry) throws -> (String, [String: JSONValue]) {
        guard case .object(let payload) = entry.payload,
            case .string(let name)? = payload["event"],
            case .object(let detail)? = payload["detail"]
        else { throw CaptureError.invalidEntry("not a recorder event: \(entry.kind)") }
        return (name, detail)
    }

    private func fix(latitude: Double, madeIn: TimeInterval = 0) -> CLLocation {
        CLLocation(
            coordinate: .init(latitude: latitude, longitude: 20), altitude: 0,
            horizontalAccuracy: 10, verticalAccuracy: 10, course: -1, speed: -1,
            timestamp: Date().addingTimeInterval(madeIn))
    }
}

@MainActor
final class FakeGeofences: Geofences {
    var locked = false
    var takesWhileLocked = true
    var readBackOffset = 0.0
    var onAdd: (() async -> Void)?
    private(set) var monitors: [FakeGeofenceMonitor] = []

    var isProtectedDataAvailable: Bool { !locked }

    func open() async -> any GeofenceMonitor {
        let monitor = FakeGeofenceMonitor(self)
        monitors.append(monitor)
        return monitor
    }
}

@MainActor
final class FakeGeofenceMonitor: GeofenceMonitor {
    private unowned let platform: FakeGeofences
    private(set) var calls: [String] = []
    private var held: Fence?

    init(_ platform: FakeGeofences) { self.platform = platform }

    func add(_ fence: Fence, identifier: String) async {
        calls.append("add \(fence.latitude)")
        if !platform.locked || platform.takesWhileLocked { held = fence }
        await platform.onAdd?()
    }

    func remove(_ identifier: String) async {
        calls.append("remove")
        held = nil
    }

    func condition(of identifier: String) async -> Fence? {
        held.map { Fence(latitude: $0.latitude + platform.readBackOffset, longitude: $0.longitude, radius: $0.radius) }
    }

    func listen(_ heard: (String, CLMonitor.Event.State) -> Void) async throws {}
}

@MainActor
final class Asked {
    var recording: [Bool] = []
}

@MainActor
final class Told {
    private(set) var events: [SendClock.Event] = []

    init(_ coordinator: LocationRecorderCoordinator) {
        coordinator.onEvent = { [weak self] in self?.events.append($0) }
    }
}

struct NeverHeld: Error {}

let waitLimit: TimeInterval = 30

extension XCTestCase {
    @nonobjc func until(_ what: String, isolation: isolated (any Actor)? = #isolation, file: StaticString = #filePath, line: UInt = #line,
               _ ready: () async throws -> Bool) async throws {
        try await waitUntil(what, isolation: isolation, file: file, line: line, ready)
    }
}

func waitUntil(_ what: String, isolation: isolated (any Actor)? = #isolation, file: StaticString = #filePath, line: UInt = #line,
               _ ready: () async throws -> Bool) async throws {
    let ends = Date().addingTimeInterval(waitLimit)
    while !(try await ready()) {
        guard Date() < ends else {
            XCTFail("never came in 30 s: \(what)", file: file, line: line)
            throw NeverHeld()
        }
        try await Task.sleep(for: .milliseconds(10))
    }
}

final class Happened: @unchecked Sendable {
    private let lock = NSLock()
    private var happened = false

    var value: Bool { lock.withLock { happened } }

    func note() {
        lock.withLock { happened = true }
    }
}
