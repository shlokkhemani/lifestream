import HealthKit
import HomeLink
import LifestreamCaptureCore
import Synchronization
import XCTest

@testable import Lifestream

@MainActor
final class AppSmokeTests: XCTestCase {
    func testTheSystemBootSessionIsReadAndHoldsWithinABoot() throws {
        let session = try XCTUnwrap(SystemBootSession.current())
        XCTAssertEqual(SystemBootSession.current(), session)
    }

    func testHealthConfigurationAndQuantitySerializationPreserveSourceFacts() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("health-recorder-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try await CaptureStore.restored(root: root)
        let recorder = HealthRecorder(store: store, start: { nil },
                                      mobile: { MobileData.Moment(path: .free, choice: .now, loopback: false, pressed: false) })
        let identifiers = Set(await recorder.configuredSampleTypeIdentifiers())
        let required: Set<String> = [
            HKObjectType.workoutType().identifier,
            HKSeriesType.workoutRoute().identifier,
            HKQuantityType(.stepCount).identifier,
            HKQuantityType(.heartRate).identifier,
            HKQuantityType(.restingHeartRate).identifier,
            HKQuantityType(.heartRateVariabilitySDNN).identifier,
            HKQuantityType(.activeEnergyBurned).identifier,
            HKQuantityType(.walkingSpeed).identifier,
            HKQuantityType(.walkingStepLength).identifier,
            HKQuantityType(.walkingAsymmetryPercentage).identifier,
            HKQuantityType(.walkingDoubleSupportPercentage).identifier,
            HKQuantityType(.respiratoryRate).identifier,
            HKQuantityType(.oxygenSaturation).identifier,
            HKCategoryType(.sleepAnalysis).identifier,
            HKCategoryType(.mindfulSession).identifier,
            HKCorrelationType(.bloodPressure).identifier,
            HKObjectType.electrocardiogramType().identifier,
            HKObjectType.audiogramSampleType().identifier,
            HKSeriesType.heartbeat().identifier,
            HKObjectType.stateOfMindType().identifier,
        ]
        XCTAssertTrue(required.isSubset(of: identifiers))
        XCTAssertFalse(identifiers.contains(HKObjectType.medicationDoseEventType().identifier), "the app reads no medications")

        let start = Date(timeIntervalSince1970: 1_700_000_000.125)
        let end = start.addingTimeInterval(60.5)
        let type = HKQuantityType(.stepCount)
        let sample = HKQuantitySample(
            type: type,
            quantity: HKQuantity(unit: .count(), doubleValue: 42.25),
            start: start,
            end: end,
            metadata: [HKMetadataKeyWasUserEntered: true, "synthetic_note": "verbatim"]
        )
        let draft = await recorder.sampleDraft(sample)
        XCTAssertEqual(draft.kind, "sample")
        XCTAssertEqual(draft.observedAt, CaptureTime.rfc3339(start))
        guard case .object(let payload) = draft.payload else {
            return XCTFail("health payload shape")
        }
        XCTAssertEqual(payload["uuid"], .string(sample.uuid.uuidString.lowercased()))
        XCTAssertEqual(payload["sample_type"], .string(type.identifier))
        XCTAssertEqual(payload["start_date_unix_seconds"], .number(start.timeIntervalSince1970))
        XCTAssertEqual(payload["end_date_unix_seconds"], .number(end.timeIntervalSince1970))
        XCTAssertEqual(payload["quantity_value"], .number(42.25))
        XCTAssertEqual(payload["quantity_unit"], .string("count"))
        guard case .object(let metadata)? = payload["metadata"] else {
            return XCTFail("health metadata shape")
        }
        XCTAssertEqual(metadata[HKMetadataKeyWasUserEntered], .bool(true))
        XCTAssertEqual(metadata["synthetic_note"], .string("verbatim"))
        XCTAssertNotEqual(payload["secure_archive_base64"], .null)
    }

    func testASampleIsDatedByItsStartSoOneBegunBeforeTheStartIsNotRead() throws {
        let start = Date(timeIntervalSince1970: 1_779_235_200)
        let since = try XCTUnwrap(HealthRecorder.since(start))
        let steps = { (from: Date, to: Date) in
            HKQuantitySample(type: HKQuantityType(.stepCount), quantity: HKQuantity(unit: .count(), doubleValue: 1),
                             start: from, end: to)
        }
        XCTAssertFalse(since.evaluate(with: steps(start.addingTimeInterval(-3_600), start.addingTimeInterval(3_600))),
                       "begun before the start, ended after it")
        XCTAssertTrue(since.evaluate(with: steps(start, start.addingTimeInterval(60))), "begun at the start")
        XCTAssertNil(HealthRecorder.since(nil), "all: no predicate")
    }

    func testStateOfMindSerializationKeepsHealthKitsRawValues() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("health-mind-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try await CaptureStore.restored(root: root)
        let recorder = HealthRecorder(store: store, start: { nil },
                                      mobile: { MobileData.Moment(path: .free, choice: .now, loopback: false, pressed: false) })
        let date = Date(timeIntervalSince1970: 1_700_000_000.25)
        let mind = HKStateOfMind(
            date: date, kind: .dailyMood, valence: 0.25,
            labels: [.happy, .calm], associations: [.work, .fitness],
            metadata: ["synthetic_note": "verbatim"]
        )
        let draft = await recorder.sampleDraft(mind)
        XCTAssertEqual(draft.kind, "sample")
        guard case .object(let payload) = draft.payload,
              case .object(let state)? = payload["state_of_mind"] else {
            return XCTFail("state of mind payload shape")
        }
        XCTAssertEqual(payload["uuid"], .string(mind.uuid.uuidString.lowercased()))
        XCTAssertEqual(payload["sample_type"], .string(HKObjectType.stateOfMindType().identifier))
        XCTAssertEqual(payload["start_date_rfc3339"], .string(CaptureTime.rfc3339(date)))
        XCTAssertEqual(payload["end_date_rfc3339"], .string(CaptureTime.rfc3339(date)))
        XCTAssertNil(payload["quantity_description"])
        XCTAssertNil(payload["category_value"])
        XCTAssertEqual(state["kind"], .integer(Int64(HKStateOfMind.Kind.dailyMood.rawValue)))
        XCTAssertEqual(state["valence"], .number(0.25))
        XCTAssertEqual(
            state["valence_classification"],
            .integer(Int64(mind.valenceClassification.rawValue)))
        XCTAssertEqual(state["labels"], .array([
            .integer(Int64(HKStateOfMind.Label.happy.rawValue)),
            .integer(Int64(HKStateOfMind.Label.calm.rawValue)),
        ]))
        XCTAssertEqual(state["associations"], .array([
            .integer(Int64(HKStateOfMind.Association.work.rawValue)),
            .integer(Int64(HKStateOfMind.Association.fitness.rawValue)),
        ]))
        guard case .object(let metadata)? = payload["metadata"] else {
            return XCTFail("state of mind metadata shape")
        }
        XCTAssertEqual(metadata["synthetic_note"], .string("verbatim"))
    }

    func testTwoTypesFirstPagesCommittedTogetherStillSayReadingIsAllowed() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("health-yield-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try await CaptureStore.restored(root: root)
        let recorder = HealthRecorder(store: store, start: { nil },
                                      mobile: { MobileData.Moment(path: .free, choice: .now, loopback: false, pressed: false) })
        var firstYields: [Bool] = []
        for type in ["HKQuantityTypeIdentifierStepCount", "HKQuantityTypeIdentifierHeartRate"] {
            var pages = [HealthPage(
                drafts: [.init(kind: "sample", observedAt: "2026-08-14T10:00:00Z", payload: .object(["uuid": .string(type)]))],
                samples: 1, deletions: 0, anchor: Data([1]))]
            _ = try await HealthSweep.run(
                store: store, type: type, start: nil, anchor: nil, past: .moves(.any),
                read: { _ in pages.isEmpty ? HealthPage(drafts: [], samples: 0, deletions: 0, anchor: Data([2])) : pages.removeFirst() },
                committed: { _, first in firstYields.append(first) })
        }
        XCTAssertEqual(firstYields, [true, true])

        let posts = Mutex(0)
        let observer = NotificationCenter.default.addObserver(
            forName: HealthRecorder.readsAllowedNotification, object: nil, queue: nil
        ) { _ in posts.withLock { $0 += 1 } }
        defer { NotificationCenter.default.removeObserver(observer) }
        for first in firstYields { await recorder.pageCommitted(firstYield: first) }
        XCTAssertGreaterThanOrEqual(posts.withLock { $0 }, 1, "a first yield always says that reading is allowed")
    }
}
