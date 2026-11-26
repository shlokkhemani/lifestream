import CoreLocation
import Foundation
import HealthKit
import HomeLink
import LifestreamCaptureCore
import OSLog

private final class RouteLocationAccumulator: @unchecked Sendable {
    private let lock = NSLock()
    private var locations: [CLLocation] = []

    func append(_ newLocations: [CLLocation]) {
        lock.lock()
        locations.append(contentsOf: newLocations)
        lock.unlock()
    }

    func snapshot() -> [CLLocation] {
        lock.lock()
        defer { lock.unlock() }
        return locations
    }
}

enum HealthUnits {
    static let byUnit: [String: String] = [
        "%": "AppleWalkingSteadiness AtrialFibrillationBurden BloodAlcoholContent BodyFatPercentage OxygenSaturation PeripheralPerfusionIndex WalkingAsymmetryPercentage WalkingDoubleSupportPercentage",
        "appleEffortScore": "EstimatedWorkoutEffortScore WorkoutEffortScore",
        "cm": "RunningVerticalOscillation",
        "count": "AppleSleepingBreathingDisturbances BodyMassIndex FlightsClimbed InhalerUsage NikeFuel NumberOfAlcoholicBeverages NumberOfTimesFallen PushCount StepCount SwimmingStrokeCount UVExposure",
        "count/min": "CyclingCadence HeartRateRecoveryOneMinute RestingHeartRate WalkingHeartRateAverage",
        "count/s": "HeartRate RespiratoryRate",
        "dBASPL": "EnvironmentalAudioExposure EnvironmentalSoundReduction HeadphoneAudioExposure",
        "degC": "AppleSleepingWristTemperature BasalBodyTemperature BodyTemperature WaterTemperature",
        "g": "DietaryBiotin DietaryCaffeine DietaryCalcium DietaryCarbohydrates DietaryChloride DietaryCholesterol DietaryChromium DietaryCopper DietaryFatMonounsaturated DietaryFatPolyunsaturated DietaryFatSaturated DietaryFatTotal DietaryFiber DietaryFolate DietaryIodine DietaryIron DietaryMagnesium DietaryManganese DietaryMolybdenum DietaryNiacin DietaryPantothenicAcid DietaryPhosphorus DietaryPotassium DietaryProtein DietaryRiboflavin DietarySelenium DietarySodium DietarySugar DietaryThiamin DietaryVitaminA DietaryVitaminB12 DietaryVitaminB6 DietaryVitaminC DietaryVitaminD DietaryVitaminE DietaryVitaminK DietaryZinc",
        "IU": "InsulinDelivery",
        "kcal": "ActiveEnergyBurned BasalEnergyBurned DietaryEnergyConsumed",
        "kcal/hr·kg": "PhysicalEffort",
        "kg": "BodyMass LeanBodyMass",
        "L": "ForcedExpiratoryVolume1 ForcedVitalCapacity",
        "L/min": "PeakExpiratoryFlowRate",
        "m": "DistanceCrossCountrySkiing DistanceCycling DistanceDownhillSnowSports DistancePaddleSports DistanceRowing DistanceSkatingSports DistanceSwimming DistanceWalkingRunning DistanceWheelchair Height RunningStrideLength SixMinuteWalkTestDistance UnderwaterDepth WaistCircumference WalkingStepLength",
        "m/s": "CrossCountrySkiingSpeed CyclingSpeed PaddleSportsSpeed RowingSpeed RunningSpeed StairAscentSpeed StairDescentSpeed WalkingSpeed",
        "mg/dL": "BloodGlucose",
        "min": "AppleExerciseTime AppleMoveTime AppleStandTime TimeInDaylight",
        "mL": "DietaryWater",
        "mL/min·kg": "VO2Max",
        "mmHg": "BloodPressureDiastolic BloodPressureSystolic",
        "ms": "HeartRateVariabilityRMSSD HeartRateVariabilitySDNN RunningGroundContactTime",
        "S": "ElectrodermalActivity",
        "W": "CyclingFunctionalThresholdPower CyclingPower RunningPower",
    ]

    private static let units: [String: HKUnit] = Dictionary(uniqueKeysWithValues: byUnit.flatMap { unit, types in
        types.split(separator: " ").map { ("HKQuantityTypeIdentifier\($0)", HKUnit(from: unit)) }
    })

    static func unit(for type: HKQuantityType) -> HKUnit? { units[type.identifier] }
}

enum HealthSweepOutcome: Sendable, Equatable {
    case succeeded
    case failed
}

final class HealthObserverDelivery: @unchecked Sendable {
    enum Disposition: Sendable, Equatable {
        case acknowledged
        case retryRequired
    }

    let type: HKSampleType
    let errorDescription: String?
    private let completion: () -> Void

    init(type: HKSampleType, completion: @escaping () -> Void, error: Error?) {
        self.type = type
        self.completion = completion
        self.errorDescription = error.map { String(describing: $0) }
    }

    func process(
        sweep: @escaping @Sendable () async -> HealthSweepOutcome
    ) async -> Disposition {
        guard errorDescription == nil else { return .retryRequired }
        guard await sweep() == .succeeded else { return .retryRequired }
        completion()
        return .acknowledged
    }
}

actor HealthSweepRunner {
    enum Status: Sendable, Equatable {
        case idle
        case running(coalescedCallCount: Int)
    }

    private var active: Set<String> = []
    private var pendingRerun: Set<String> = []
    private var waiters: [String: [CheckedContinuation<HealthSweepOutcome, Never>]] = [:]

    func run(
        typeIdentifier: String,
        operation: @escaping @Sendable () async -> HealthSweepOutcome
    ) async -> HealthSweepOutcome {
        if !active.insert(typeIdentifier).inserted {
            pendingRerun.insert(typeIdentifier)
            return await withCheckedContinuation {
                waiters[typeIdentifier, default: []].append($0)
            }
        }

        var outcome = HealthSweepOutcome.succeeded
        while true {
            if await operation() == .failed { outcome = .failed }
            if pendingRerun.remove(typeIdentifier) == nil { break }
        }

        active.remove(typeIdentifier)
        let completedWaiters = waiters.removeValue(forKey: typeIdentifier) ?? []
        for waiter in completedWaiters { waiter.resume(returning: outcome) }
        return outcome
    }

    func status(for typeIdentifier: String) -> Status {
        guard active.contains(typeIdentifier) else { return .idle }
        return .running(coalescedCallCount: waiters[typeIdentifier]?.count ?? 0)
    }
}

actor HealthRecorder {
    private static let logger = Logger(
        subsystem: "org.lifestreamprotocol.phone",
        category: "HealthRecorder"
    )

    private let store: CaptureStore
    private let healthStore = HKHealthStore()
    private var observerQueries: [HKObserverQuery] = []
    private var fullSweepInProgress = false
    private var fullSweepWaiters: [CheckedContinuation<HealthSweepOutcome, Never>] = []
    private var authorizationInProgress = false
    private var authorizationWaiters: [CheckedContinuation<Void, Never>] = []
    private var answeredSheet = false
    private let sweepRunner = HealthSweepRunner()

    static let readsAllowedNotification = Notification.Name("HealthRecorder.readsAllowed")

    private let historyStart: @Sendable () async -> Date?
    private let mobile: @Sendable () -> MobileData.Moment
    private let mobileChanges: @Sendable () -> AsyncStream<Void>
    private var pastWatch: Task<Void, Never>?

    init(store: CaptureStore, start: @escaping @Sendable () async -> Date?, mobile: @escaping @Sendable () -> MobileData.Moment,
         mobileChanges: @escaping @Sendable () -> AsyncStream<Void> = { AsyncStream { $0.finish() } }) {
        self.store = store
        historyStart = start
        self.mobile = mobile
        self.mobileChanges = mobileChanges
    }

    func newestCheckInWake(now: Date) async -> Date? {
        guard HKHealthStore.isHealthDataAvailable(),
              let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else { return nil }
        let lower = now.addingTimeInterval(-18 * 3600)
        let predicate = NSCompoundPredicate(andPredicateWithSubpredicates: [
            HKQuery.predicateForSamples(withStart: lower, end: now, options: .strictEndDate),
            NSCompoundPredicate(orPredicateWithSubpredicates: [1, 3, 4, 5].map {
                HKQuery.predicateForCategorySamples(with: .equalTo, value: $0)
            })
        ])
        return await withCheckedContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: 1,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)],
                resultsHandler: Self.checkInWakeHandler(continuation))
            healthStore.execute(query)
        }
    }

    nonisolated private static func checkInWakeHandler(_ continuation: CheckedContinuation<Date?, Never>)
        -> @Sendable (HKSampleQuery, [HKSample]?, Error?) -> Void {
        { _, samples, _ in
            let instant = samples?.first?.endDate
            continuation.resume(returning: instant)
        }
    }

    func bootstrapAfterLocation() async {
        guard HKHealthStore.isHealthDataAvailable() else {
            await appendEvent("health_data_unavailable", detail: [:])
            return
        }
        await appendAuthorizationStatus(await answeredStatus(), event: "health_authorization_status")
        guard await sheet()?.reads == true else { return }
        startObservers()
        Task { await sweepAllTypesCoalesced() }
    }

    func requestAuthorizationAndBackfill() async {
        if authorizationInProgress {
            await withCheckedContinuation { authorizationWaiters.append($0) }
            return
        }
        authorizationInProgress = true
        await performAuthorizationAndStart()
        authorizationInProgress = false
        let waiters = authorizationWaiters
        authorizationWaiters.removeAll(keepingCapacity: true)
        for waiter in waiters { waiter.resume() }
    }

    func resumeIfAsked() async {
        guard await sheet()?.reads == true else { return }
        await start()
    }

    private func performAuthorizationAndStart() async {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        let before = await answeredStatus()
        await appendAuthorizationStatus(before, event: "health_authorization_status")
        if before != .unnecessary {
            do {
                try await healthStore.requestAuthorization(toShare: [], read: authorizationTypes)
                answeredSheet = true
                restartObservers()
            } catch {
                await appendEvent("health_authorization_failed", detail: ["error": .string(String(describing: error))])
            }
            await appendAuthorizationStatus(await requestStatus(), event: "health_authorization_completed")
        }
        guard await sheet()?.reads == true else { return }
        await start()
    }

    private func start() async {
        for type in sampleTypes {
            do {
                try await healthStore.enableBackgroundDelivery(for: type, frequency: .immediate)
            } catch {
                EnergyLedger.shared.count("health_delivery_refused")
            }
        }
        startObservers()
        Task { await sweepAllTypesCoalesced() }
    }

    func sheet() async -> HealthAsk? {
        guard HKHealthStore.isHealthDataAvailable() else { return nil }
        let complete = await answeredStatus() == .unnecessary
        return (try? await store.healthAsk(complete: complete)) ?? (complete ? .answered : .first)
    }

    private func answeredStatus() async -> HKAuthorizationRequestStatus {
        answeredSheet ? .unnecessary : await requestStatus()
    }

    private func requestStatus() async -> HKAuthorizationRequestStatus {
        await withCheckedContinuation { continuation in
            healthStore.getRequestStatusForAuthorization(
                toShare: [],
                read: authorizationTypes
            ) { status, _ in
                continuation.resume(returning: status)
            }
        }
    }

    private func appendAuthorizationStatus(
        _ status: HKAuthorizationRequestStatus,
        event: String
    ) async {
        await appendEvent(event, detail: [
            "request_status_raw": .integer(Int64(status.rawValue)),
            "request_status": .string(String(describing: status)),
        ])
    }

    private static let quantityIdentifiers = [
        "AppleSleepingWristTemperature", "BodyFatPercentage", "BodyMass", "BodyMassIndex", "ElectrodermalActivity", "Height",
        "LeanBodyMass", "WaistCircumference", "ActiveEnergyBurned", "AppleExerciseTime", "AppleMoveTime", "AppleStandTime",
        "BasalEnergyBurned", "CrossCountrySkiingSpeed", "CyclingCadence", "CyclingFunctionalThresholdPower", "CyclingPower",
        "CyclingSpeed", "DistanceCrossCountrySkiing", "DistanceCycling", "DistanceDownhillSnowSports", "DistancePaddleSports",
        "DistanceRowing", "DistanceSkatingSports", "DistanceSwimming", "DistanceWalkingRunning", "DistanceWheelchair",
        "EstimatedWorkoutEffortScore", "FlightsClimbed", "NikeFuel", "PaddleSportsSpeed", "PhysicalEffort", "PushCount",
        "RowingSpeed", "RunningPower", "RunningSpeed", "StepCount", "SwimmingStrokeCount", "UnderwaterDepth",
        "WorkoutEffortScore", "EnvironmentalAudioExposure", "EnvironmentalSoundReduction", "HeadphoneAudioExposure",
        "AtrialFibrillationBurden", "HeartRate", "HeartRateRecoveryOneMinute", "HeartRateVariabilityRMSSD",
        "HeartRateVariabilitySDNN", "PeripheralPerfusionIndex", "RestingHeartRate", "VO2Max", "WalkingHeartRateAverage",
        "AppleWalkingSteadiness", "RunningGroundContactTime", "RunningStrideLength", "RunningVerticalOscillation",
        "SixMinuteWalkTestDistance", "StairAscentSpeed", "StairDescentSpeed", "WalkingAsymmetryPercentage",
        "WalkingDoubleSupportPercentage", "WalkingSpeed", "WalkingStepLength", "DietaryBiotin", "DietaryCaffeine",
        "DietaryCalcium", "DietaryCarbohydrates", "DietaryChloride", "DietaryCholesterol", "DietaryChromium", "DietaryCopper",
        "DietaryEnergyConsumed", "DietaryFatMonounsaturated", "DietaryFatPolyunsaturated", "DietaryFatSaturated",
        "DietaryFatTotal", "DietaryFiber", "DietaryFolate", "DietaryIodine", "DietaryIron", "DietaryMagnesium",
        "DietaryManganese", "DietaryMolybdenum", "DietaryNiacin", "DietaryPantothenicAcid", "DietaryPhosphorus",
        "DietaryPotassium", "DietaryProtein", "DietaryRiboflavin", "DietarySelenium", "DietarySodium", "DietarySugar",
        "DietaryThiamin", "DietaryVitaminA", "DietaryVitaminB12", "DietaryVitaminB6", "DietaryVitaminC", "DietaryVitaminD",
        "DietaryVitaminE", "DietaryVitaminK", "DietaryWater", "DietaryZinc", "BloodAlcoholContent", "BloodPressureDiastolic",
        "BloodPressureSystolic", "InsulinDelivery", "NumberOfAlcoholicBeverages", "NumberOfTimesFallen", "TimeInDaylight",
        "UVExposure", "WaterTemperature", "BasalBodyTemperature", "AppleSleepingBreathingDisturbances",
        "ForcedExpiratoryVolume1", "ForcedVitalCapacity", "InhalerUsage", "OxygenSaturation", "PeakExpiratoryFlowRate",
        "RespiratoryRate", "BloodGlucose", "BodyTemperature",
    ].map { "HKQuantityTypeIdentifier\($0)" }

    private static let categoryIdentifiers = [
        "AppleStandHour", "EnvironmentalAudioExposureEvent", "HeadphoneAudioExposureEvent", "HighHeartRateEvent",
        "HypertensionEvent", "IrregularHeartRhythmEvent", "LowCardioFitnessEvent", "LowHeartRateEvent", "MindfulSession",
        "AppleWalkingSteadinessEvent", "HandwashingEvent", "ToothbrushingEvent", "BleedingAfterMenopause",
        "BleedingAfterPregnancy", "BleedingDuringPregnancy", "CervicalMucusQuality", "Contraceptive",
        "InfrequentMenstrualCycles", "IntermenstrualBleeding", "IrregularMenstrualCycles", "Lactation", "MenopausalState",
        "MenstrualFlow", "OvulationTestResult", "PersistentIntermenstrualBleeding", "Pregnancy", "PregnancyTestResult",
        "ProgesteroneTestResult", "ProlongedMenstrualPeriods", "SexualActivity", "SleepApneaEvent", "SleepAnalysis",
        "AbdominalCramps", "Acne", "AppetiteChanges", "BladderIncontinence", "Bloating", "BreastPain", "ChestTightnessOrPain",
        "Chills", "Constipation", "Coughing", "Diarrhea", "Dizziness", "DrySkin", "Fainting", "Fatigue", "Fever",
        "GeneralizedBodyAche", "HairLoss", "Headache", "Heartburn", "HotFlashes", "LossOfSmell", "LossOfTaste",
        "LowerBackPain", "MemoryLapse", "MoodChanges", "Nausea", "NightSweats", "PelvicPain",
        "RapidPoundingOrFlutteringHeartbeat", "RunnyNose", "ShortnessOfBreath", "SinusCongestion", "SkippedHeartbeat",
        "SleepChanges", "SoreThroat", "VaginalDryness", "Vomiting", "Wheezing",
    ].map { "HKCategoryTypeIdentifier\($0)" }

    private var sampleTypes: Set<HKSampleType> {
        var types: [HKSampleType] = [
            HKObjectType.workoutType(),
            HKSeriesType.workoutRoute(),
            HKSeriesType.heartbeat(),
            HKObjectType.electrocardiogramType(),
            HKObjectType.audiogramSampleType(),
            HKObjectType.stateOfMindType(),
        ]
        types += Self.quantityIdentifiers.compactMap { HKObjectType.quantityType(forIdentifier: HKQuantityTypeIdentifier(rawValue: $0)) }
        types += Self.categoryIdentifiers.compactMap { HKObjectType.categoryType(forIdentifier: HKCategoryTypeIdentifier(rawValue: $0)) }
        types += ["BloodPressure", "Food"].compactMap {
            HKObjectType.correlationType(forIdentifier: HKCorrelationTypeIdentifier(rawValue: "HKCorrelationTypeIdentifier\($0)"))
        }
        types += [HKScoredAssessmentType(.GAD7), HKScoredAssessmentType(.PHQ9)]
        return Set(types)
    }

    private var authorizationTypes: Set<HKObjectType> {
        Set(sampleTypes.filter { !($0 is HKCorrelationType) && !$0.requiresPerObjectAuthorization() }.map { $0 as HKObjectType })
            .union(Self.characteristicTypes)
    }

    private static let characteristicTypes: [HKObjectType] = [
        HKCharacteristicTypeIdentifier.dateOfBirth, .biologicalSex, .bloodType, .fitzpatrickSkinType, .wheelchairUse, .activityMoveMode,
    ].compactMap { HKObjectType.characteristicType(forIdentifier: $0) }

    private func characteristicsDraft() -> CaptureDraft {
        var facts: [JSONValue] = []
        func fact(_ identifier: HKCharacteristicTypeIdentifier, _ read: () throws -> JSONValue) {
            guard let value = try? read() else { return }
            facts.append(.object(["identifier": .string(identifier.rawValue), "value": value]))
        }
        let health = healthStore
        fact(.dateOfBirth) {
            let born = try health.dateOfBirthComponents()
            guard let year = born.year, let month = born.month, let day = born.day else { return .null }
            return .string(String(format: "%04d-%02d-%02d", year, month, day))
        }
        fact(.biologicalSex) { Self.raw(try health.biologicalSex().biologicalSex.rawValue) }
        fact(.bloodType) { Self.raw(try health.bloodType().bloodType.rawValue) }
        fact(.fitzpatrickSkinType) { Self.raw(try health.fitzpatrickSkinType().skinType.rawValue) }
        fact(.wheelchairUse) { Self.raw(try health.wheelchairUse().wheelchairUse.rawValue) }
        fact(.activityMoveMode) { .integer(Int64(try health.activityMoveMode().activityMoveMode.rawValue)) }
        return CaptureDraft(kind: "characteristics", observedAt: CaptureTime.rfc3339(AppClock.now), payload: .object(["characteristics": .array(facts)]))
    }

    private static func measured(_ quantity: HKQuantity?, _ unit: HKUnit) -> JSONValue {
        guard let quantity, quantity.is(compatibleWith: unit) else { return .null }
        return .object(["value": .number(quantity.doubleValue(for: unit)), "unit": .string(unit.unitString)])
    }

    private static func raw(_ value: Int) -> JSONValue { value == 0 ? .null : .integer(Int64(value)) }

    func configuredSampleTypeIdentifiers() -> [String] {
        sampleTypes.map(\.identifier).sorted()
    }

    func stopObserving() async {
        for query in observerQueries { healthStore.stop(query) }
        observerQueries.removeAll()
        try? await healthStore.disableAllBackgroundDelivery()
    }

    nonisolated private static func unasked(_ error: Error) -> Bool {
        (error as? HKError)?.code == .errorAuthorizationNotDetermined
    }

    private func restartObservers() {
        guard !observerQueries.isEmpty else { return }
        for query in observerQueries { healthStore.stop(query) }
        observerQueries.removeAll()
        startObservers()
    }

    private func watchPast() {
        guard pastWatch == nil else { return }
        let changes = mobileChanges()
        pastWatch = Task { [weak self] in
            guard let self else { return }
            var moved = mobile().past.moves
            for await _ in changes {
                let moves = mobile().past.moves
                if moves, !moved { _ = await sweepAllTypesCoalesced() }
                moved = moves
            }
        }
    }

    private func startObservers() {
        watchPast()
        guard observerQueries.isEmpty else { return }
        for type in sampleTypes where type != HKSeriesType.workoutRoute() {
            let query = HKObserverQuery(
                sampleType: type,
                predicate: nil,
                updateHandler: Self.observerHandler(for: self, type: type)
            )
            observerQueries.append(query)
            healthStore.execute(query)
        }
    }

    nonisolated private static func observerHandler(
        for recorder: HealthRecorder,
        type: HKSampleType
    ) -> @Sendable (HKObserverQuery, @escaping () -> Void, Error?) -> Void {
        { _, completion, error in
            BackgroundWake.note("health_observer")
            let delivery = HealthObserverDelivery(type: type, completion: completion, error: error)
            let unasked = error.map(Self.unasked) ?? false
            Task {
                if let errorDescription = delivery.errorDescription, !unasked {
                    Self.logger.error(
                        "Health observer failed for \(delivery.type.identifier, privacy: .public): \(errorDescription, privacy: .private)"
                    )
                    await recorder.appendEvent("health_observer_error", detail: [
                        "type": .string(delivery.type.identifier),
                        "error": .string(errorDescription),
                    ])
                }
                _ = await delivery.process {
                    await recorder.sweep(delivery.type)
                }
            }
        }
    }

    private func sweepAllTypes() async -> HealthSweepOutcome {
        let started = AppClock.now
        var outcome = HealthSweepOutcome.succeeded
        var covered: [String] = []
        for type in sampleTypes where type != HKSeriesType.workoutRoute() {
            if await sweep(type) == .failed {
                outcome = .failed
            } else if (try? await store.anchor(Self.yieldedKey + type.identifier)) != nil {
                covered.append(type.identifier)
            }
        }
        if !covered.isEmpty { try? await store.setReadPoint(.health, .init(at: started, types: covered.sorted())) }
        if await store.historyReadsAdmitted { _ = try? await store.append(domain: .health, draft: characteristicsDraft()) }
        return outcome
    }

    private static let yieldedKey = HealthAsk.yieldedPrefix

    func yielded() async -> Bool {
        !((try? await store.anchors(prefix: Self.yieldedKey)) ?? [:]).isEmpty
    }

    func pageCommitted(firstYield: Bool) async {
        guard firstYield else { return }
        NotificationCenter.default.post(name: Self.readsAllowedNotification, object: nil)
    }

    private func sweepAllTypesCoalesced() async -> HealthSweepOutcome {
        if fullSweepInProgress {
            return await withCheckedContinuation { continuation in
                fullSweepWaiters.append(continuation)
            }
        }
        fullSweepInProgress = true
        let outcome = await sweepAllTypes()
        fullSweepInProgress = false
        let waiters = fullSweepWaiters
        fullSweepWaiters.removeAll(keepingCapacity: true)
        for waiter in waiters { waiter.resume(returning: outcome) }
        return outcome
    }

    private func sweep(_ type: HKSampleType) async -> HealthSweepOutcome {
        await sweepRunner.run(typeIdentifier: type.identifier) {
            await EnergyLedger.shared.measure(.health) { await self.performSweep(type) }
        }
    }

    private func performSweep(_ type: HKSampleType) async -> HealthSweepOutcome {
        guard await store.historyReadsAdmitted else { return .failed }
        do {
            let covered = try await store.sinceTypes(.health).contains(type.identifier)
            let from = HistoryStart.health(start: await historyStart(), since: covered ? try await store.since(.health) : nil)
            _ = try await HealthSweep.run(
                store: store, type: type.identifier, start: from, anchor: try await storedAnchor(for: type),
                past: mobile().past,
                read: { try await self.page(of: type, after: $0.flatMap(Self.queryAnchor), start: $1) },
                committed: { _, firstYield in await self.pageCommitted(firstYield: firstYield) })
            return .succeeded
        } catch {
            if Self.unasked(error) { return .succeeded }
            let errorDescription = String(describing: error)
            Self.logger.error(
                "Health sweep failed for \(type.identifier, privacy: .public): \(errorDescription, privacy: .private)"
            )
            await appendEvent("health_sweep_failed", detail: [
                "type": .string(type.identifier),
                "error": .string(errorDescription),
            ])
            return .failed
        }
    }

    private func page(of type: HKSampleType, after anchor: HKQueryAnchor?, start: Date?) async throws -> HealthPage {
        let result = try await anchoredSamples(type: type, anchor: anchor, start: start)
        var drafts = try await seriesDrafts(result.samples) + result.deleted.map { deleted in
            CaptureDraft(
                kind: "deleted_sample",
                observedAt: CaptureTime.rfc3339(AppClock.now),
                payload: .object([
                    "uuid": .string(deleted.uuid.uuidString.lowercased()),
                    "sample_type": .string(type.identifier),
                    "deletion_reported_at": .string(CaptureTime.rfc3339(AppClock.now)),
                ])
            )
        }
        for workout in result.samples.compactMap({ $0 as? HKWorkout }) {
            drafts += try await routeDrafts(for: workout)
        }
        let archived = try NSKeyedArchiver.archivedData(withRootObject: result.anchor, requiringSecureCoding: true)
        return HealthPage(drafts: drafts, samples: result.samples.count, deletions: result.deleted.count, anchor: archived)
    }

    static func since(_ start: Date?) -> NSPredicate? {
        start.map { HKQuery.predicateForSamples(withStart: $0, end: nil, options: .strictStartDate) }
    }

    private func anchoredSamples(
        type: HKSampleType,
        anchor: HKQueryAnchor?,
        start: Date?
    ) async throws -> (samples: [HKSample], deleted: [HKDeletedObject], anchor: HKQueryAnchor) {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKAnchoredObjectQuery(
                type: type,
                predicate: Self.since(start),
                anchor: anchor,
                limit: Self.pageLimit(type)
            ) { _, samples, deleted, newAnchor, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let newAnchor {
                    continuation.resume(returning: (samples ?? [], deleted ?? [], newAnchor))
                } else {
                    continuation.resume(throwing: CaptureError.corruptState("HealthKit returned no anchor"))
                }
            }
            healthStore.execute(query)
        }
    }

    func sampleDraft(_ sample: HKSample) -> CaptureDraft {
        let archive = try? NSKeyedArchiver.archivedData(
            withRootObject: sample,
            requiringSecureCoding: true
        )
        var content: [String: JSONValue] = [
            "uuid": .string(sample.uuid.uuidString.lowercased()),
            "sample_type": .string(sample.sampleType.identifier),
            "start_date_rfc3339": .string(CaptureTime.rfc3339(sample.startDate)),
            "start_date_unix_seconds": .number(sample.startDate.timeIntervalSince1970),
            "end_date_rfc3339": .string(CaptureTime.rfc3339(sample.endDate)),
            "end_date_unix_seconds": .number(sample.endDate.timeIntervalSince1970),
            "source_revision": sourceRevision(sample.sourceRevision),
            "device": device(sample.device),
            "metadata": metadata(sample.metadata),
            "secure_archive_base64": archive.map { .string($0.base64EncodedString()) } ?? .null,
        ]
        if let quantity = sample as? HKQuantitySample {
            if let unit = HealthUnits.unit(for: quantity.quantityType), quantity.quantity.is(compatibleWith: unit) {
                content["quantity_value"] = .number(quantity.quantity.doubleValue(for: unit))
                content["quantity_unit"] = .string(unit.unitString)
            } else {
                content["quantity_description"] = .string(String(describing: quantity.quantity))
            }
        }
        if let category = sample as? HKCategorySample {
            content["category_value"] = .integer(Int64(category.value))
        }
        if let mind = sample as? HKStateOfMind {
            content["state_of_mind"] = .object([
                "kind": .integer(Int64(mind.kind.rawValue)),
                "valence": .number(mind.valence),
                "valence_classification": .integer(Int64(mind.valenceClassification.rawValue)),
                "labels": .array(mind.labels.map { .integer(Int64($0.rawValue)) }),
                "associations": .array(mind.associations.map { .integer(Int64($0.rawValue)) }),
            ])
        }
        if let correlation = sample as? HKCorrelation {
            content["correlation_objects"] = .array(correlation.objects.sorted { $0.uuid.uuidString < $1.uuid.uuidString }.map { member in
                guard case .object(var payload) = sampleDraft(member).payload else { return .null }
                payload.removeValue(forKey: "secure_archive_base64")
                return .object(payload)
            })
        }
        if let ecg = sample as? HKElectrocardiogram {
            content["electrocardiogram"] = .object([
                "classification": .integer(Int64(ecg.classification.rawValue)),
                "symptoms_status": .integer(Int64(ecg.symptomsStatus.rawValue)),
                "average_heart_rate_description": ecg.averageHeartRate.map { .string(String(describing: $0)) } ?? .null,
                "sampling_frequency_description": ecg.samplingFrequency.map { .string(String(describing: $0)) } ?? .null,
                "number_of_voltage_measurements": .integer(Int64(ecg.numberOfVoltageMeasurements)),
            ])
        }
        if let series = sample as? HKHeartbeatSeriesSample {
            content["heartbeat_series"] = .object(["count": .integer(Int64(series.count))])
        }
        if let audiogram = sample as? HKAudiogramSample {
            content["audiogram"] = .object(["sensitivity_points": .array(audiogram.sensitivityPoints.map { point in
                .object([
                    "frequency_description": .string(String(describing: point.frequency)),
                    "tests": .array(point.tests.map { test in
                        .object([
                            "sensitivity_description": .string(String(describing: test.sensitivity)),
                            "type": .integer(Int64(test.type.rawValue)),
                            "masked": .bool(test.masked),
                            "side": .integer(Int64(test.side.rawValue)),
                            "clamping_lower_description": test.clampingRange?.lowerBound.map { .string(String(describing: $0)) } ?? .null,
                            "clamping_upper_description": test.clampingRange?.upperBound.map { .string(String(describing: $0)) } ?? .null,
                        ])
                    }),
                ])
            })])
        }
        if let assessment = sample as? HKScoredAssessment {
            var stated: [String: JSONValue] = ["score": .integer(Int64(assessment.score))]
            if let gad7 = assessment as? HKGAD7Assessment {
                stated["answers"] = .array(gad7.answers.map { .integer(Int64($0.rawValue)) })
                stated["risk"] = .integer(Int64(gad7.risk.rawValue))
            }
            if let phq9 = assessment as? HKPHQ9Assessment {
                stated["answers"] = .array(phq9.answers.map { .integer(Int64($0.rawValue)) })
                stated["risk"] = .integer(Int64(phq9.risk.rawValue))
            }
            content["scored_assessment"] = .object(stated)
        }
        if let workout = sample as? HKWorkout {
            content["workout_activity_type"] = .unsigned(UInt64(workout.workoutActivityType.rawValue))
            content["duration_seconds"] = .number(workout.duration)
            content["total_distance"] = Self.measured(workout.totalDistance, .meter())
            content["total_energy"] = Self.measured(workout.statistics(for: HKQuantityType(.activeEnergyBurned))?.sumQuantity(), .kilocalorie())
            content["workout_statistics"] = .array(workout.allStatistics.sorted { $0.key.identifier < $1.key.identifier }.compactMap { type, statistics in
                guard let unit = HealthUnits.unit(for: type), type.is(compatibleWith: unit) else { return nil }
                func figure(_ quantity: HKQuantity?) -> JSONValue { quantity.map { .number($0.doubleValue(for: unit)) } ?? .null }
                return .object([
                    "type": .string(type.identifier),
                    "start": .string(CaptureTime.rfc3339(statistics.startDate)),
                    "end": .string(CaptureTime.rfc3339(statistics.endDate)),
                    "sum": figure(statistics.sumQuantity()),
                    "average": figure(statistics.averageQuantity()),
                    "minimum": figure(statistics.minimumQuantity()),
                    "maximum": figure(statistics.maximumQuantity()),
                    "unit": .string(unit.unitString),
                ])
            })
            content["workout_events"] = .array((workout.workoutEvents ?? []).map {
                .object([
                    "type": .unsigned(UInt64($0.type.rawValue)),
                    "date_interval_start": .string(CaptureTime.rfc3339($0.dateInterval.start)),
                    "date_interval_end": .string(CaptureTime.rfc3339($0.dateInterval.end)),
                    "metadata": metadata($0.metadata),
                ])
            })
        }
        return .init(
            kind: "sample",
            observedAt: CaptureTime.rfc3339(sample.startDate),
            payload: .object(content)
        )
    }

    private func seriesDrafts(_ samples: [HKSample]) async throws -> [CaptureDraft] {
        var drafts: [CaptureDraft] = []
        let encoder = JSONEncoder.lifestream()
        for sample in samples {
            let draft = sampleDraft(sample)
            guard case .object(var payload) = draft.payload else { drafts.append(draft); continue }
            if let ecg = sample as? HKElectrocardiogram, case .object(var stated) = payload["electrocardiogram"] ?? .null {
                var data = Data()
                for try await measurement in HKElectrocardiogramQueryDescriptor(ecg).results(for: healthStore) {
                    let microvolts = measurement.quantity(for: .appleWatchSimilarToLeadI)?.doubleValue(for: .voltUnit(with: .micro))
                    try Self.appendLine(.array([.number(measurement.timeSinceSampleStart), microvolts.map(JSONValue.number) ?? .null]), to: &data, encoder)
                }
                stated["voltages"] = try await seriesBlob(data, type: "application/x-ndjson")
                payload["electrocardiogram"] = .object(stated)
            } else if let series = sample as? HKHeartbeatSeriesSample, case .object(var stated) = payload["heartbeat_series"] ?? .null {
                var data = Data()
                for try await beat in HKHeartbeatSeriesQueryDescriptor(series).results(for: healthStore) {
                    try Self.appendLine(.array([.number(beat.timeIntervalSinceStart), .bool(beat.precededByGap)]), to: &data, encoder)
                }
                stated["beats"] = try await seriesBlob(data, type: "application/x-ndjson")
                payload["heartbeat_series"] = .object(stated)
            } else {
                drafts.append(draft)
                continue
            }
            drafts.append(.init(kind: draft.kind, observedAt: draft.observedAt, captured: draft.captured, payload: .object(payload)))
        }
        return drafts
    }

    private static func appendLine(_ value: JSONValue, to data: inout Data, _ encoder: JSONEncoder) throws {
        data.append(try encoder.encode(value))
        data.append(0x0A)
    }

    private func seriesBlob(_ data: Data, type: String) async throws -> JSONValue {
        let hash = try await store.storeBlob(data)
        return .object(["hash": .string(hash), "bytes": .unsigned(UInt64(data.count)), "type": .string(type)])
    }

    private static func pageLimit(_ type: HKSampleType) -> Int {
        type is HKElectrocardiogramType || type == HKSeriesType.heartbeat() ? 20 : 1_000
    }

    private func routeDrafts(for workout: HKWorkout) async throws -> [CaptureDraft] {
        var drafts: [CaptureDraft] = []
        for route in try await workoutRoutes(for: workout) {
            let locations = try await routeLocations(route)
            var data = Data()
            for (index, location) in locations.enumerated() {
                let raw = RawLocation.payload(
                    location,
                    acquisitionPath: "healthkit_route",
                    engine: "os_owned",
                        configuration: .init(
                            desiredAccuracy: 0, distanceFilter: 0, activityType: .other,
                            pausesAutomatically: false,
                            legacyKnobsApplied: false,
                            liveUpdateConfiguration: "healthkit_route_query"
                        ),
                    receipt: .init(),
                    batchID: route.uuid,
                    batchIndex: index,
                    batchCount: locations.count
                )
                data.append(try JSONEncoder.lifestream().encode(raw))
                data.append(0x0A)
            }
            let hash = try await store.storeBlob(data)
            drafts.append(.init(
                kind: "workout_route",
                observedAt: CaptureTime.rfc3339(workout.startDate),
                payload: .object([
                    "workout_uuid": .string(workout.uuid.uuidString.lowercased()),
                    "route_uuid": .string(route.uuid.uuidString.lowercased()),
                    "blob": .object([
                        "hash": .string(hash),
                        "type": .string("application/vnd.lifestreamprotocol.healthkit-route+jsonl"),
                        "bytes": .unsigned(UInt64(data.count)),
                        "role": .string("workout_route"),
                    ]),
                    "location_count": .integer(Int64(locations.count)),
                ])
            ))
        }
        return drafts
    }

    private func workoutRoutes(for workout: HKWorkout) async throws -> [HKWorkoutRoute] {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: HKSeriesType.workoutRoute(),
                predicate: HKQuery.predicateForObjects(from: workout),
                limit: HKObjectQueryNoLimit,
                sortDescriptors: nil
            ) { _, samples, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: (samples as? [HKWorkoutRoute]) ?? []) }
            }
            healthStore.execute(query)
        }
    }

    private func routeLocations(_ route: HKWorkoutRoute) async throws -> [CLLocation] {
        try await withCheckedThrowingContinuation { continuation in
            let collected = RouteLocationAccumulator()
            let query = HKWorkoutRouteQuery(route: route) { _, locations, done, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    collected.append(locations ?? [])
                    if done { continuation.resume(returning: collected.snapshot()) }
                }
            }
            healthStore.execute(query)
        }
    }

    private func sourceRevision(_ revision: HKSourceRevision) -> JSONValue {
        .object([
            "source_name": .string(revision.source.name),
            "bundle_identifier": .string(revision.source.bundleIdentifier),
            "version": revision.version.map(JSONValue.string) ?? .null,
            "product_type": revision.productType.map(JSONValue.string) ?? .null,
            "operating_system_version": .object([
                "major": .integer(Int64(revision.operatingSystemVersion.majorVersion)),
                "minor": .integer(Int64(revision.operatingSystemVersion.minorVersion)),
                "patch": .integer(Int64(revision.operatingSystemVersion.patchVersion)),
            ]),
        ])
    }

    private func device(_ device: HKDevice?) -> JSONValue {
        guard let device else { return .null }
        return .object([
            "name": device.name.map(JSONValue.string) ?? .null,
            "manufacturer": device.manufacturer.map(JSONValue.string) ?? .null,
            "model": device.model.map(JSONValue.string) ?? .null,
            "hardware_version": device.hardwareVersion.map(JSONValue.string) ?? .null,
            "firmware_version": device.firmwareVersion.map(JSONValue.string) ?? .null,
            "software_version": device.softwareVersion.map(JSONValue.string) ?? .null,
            "local_identifier": device.localIdentifier.map(JSONValue.string) ?? .null,
            "udi_device_identifier": device.udiDeviceIdentifier.map(JSONValue.string) ?? .null,
        ])
    }

    private func metadata(_ metadata: [String: Any]?) -> JSONValue {
        guard let metadata else { return .null }
        return .object(metadata.mapValues { value in
            if let value = value as? String { return .string(value) }
            if let value = value as? Bool { return .bool(value) }
            if let value = value as? NSNumber { return .number(value.doubleValue) }
            if let value = value as? Date {
                return .object([
                    "rfc3339": .string(CaptureTime.rfc3339(value)),
                    "unix_seconds": .number(value.timeIntervalSince1970),
                ])
            }
            return .object([
                "class": .string(String(describing: type(of: value))),
                "description": .string(String(describing: value)),
            ])
        })
    }

    private func storedAnchor(for type: HKSampleType) async throws -> Data? {
        guard let data = try await store.anchor(HealthAsk.anchorPrefix + type.identifier),
              Self.queryAnchor(data) != nil else { return nil }
        return data
    }

    nonisolated private static func queryAnchor(_ data: Data) -> HKQueryAnchor? {
        try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    func restored() async {
        guard await sheet()?.reads == true else { return }
        _ = await sweepAllTypesCoalesced()
    }

    private func appendEvent(_ event: String, detail: [String: JSONValue]) async {
        do {
            try await persistEvent(event, detail: detail)
        } catch {
            let errorDescription = String(describing: error)
            Self.logger.error(
                "Failed to persist \(event, privacy: .public): \(errorDescription, privacy: .private)"
            )
        }
    }

    private func persistEvent(_ event: String, detail: [String: JSONValue]) async throws {
        _ = try await store.append(
            domain: .health,
            draft: .init(
                kind: "recorder_event",
                observedAt: CaptureTime.rfc3339(AppClock.now),
                payload: .object(["event": .string(event), "detail": .object(detail)])
            )
        )
    }
}
