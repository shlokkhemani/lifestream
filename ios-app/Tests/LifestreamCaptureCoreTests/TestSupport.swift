import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

extension CaptureStore {
    func jsonl(_ domain: CaptureDomain) async throws -> Data {
        let encoder = JSONEncoder.lifestream()
        return try await entries(domain: domain).reduce(into: Data()) {
            $0.append(try encoder.encode($1))
            $0.append(0x0A)
        }
    }
}

extension DeviceHardware {
    static let synthetic = DeviceHardware(
        machineModel: "iPhone18,1", marketingName: "Synthetic Phone", osVersion: "27.0")
}

extension CaptureExporter {
    func sealEverything(appVersion: String = "1", now: Date? = nil) async throws -> BuiltExportBundle? {
        let bundles = try await seal(CaptureDomain.allCases.map {
            SealedSource(domain: $0, source: "\($0.product):local:unit-0001", seal: 1, after: 0)
        }, hardware: .synthetic, appVersion: appVersion, now: now).bundles
        guard bundles.count <= 1 else { throw SealedApart(count: bundles.count) }
        return bundles.first
    }
}

extension HomeLink {
    func deliver(_ pending: PendingBundle, of custody: PhoneCustody, kind: WriteKind = .new) async throws -> FreshAnswer {
        var files: [HomeLink.File] = []
        for file in pending.files {
            files.append(HomeLink.File(name: file.name, url: try await custody.blobFile(file.name), bytes: Int64(file.bytes)))
        }
        return try await send(bundle: custody.file(pending), id: pending.id, files: files, kind: kind)
    }
}

extension CaptureStore {
    static func restored(root: URL, processInstanceID: UUID = UUID(), waitSeconds: Double = 60,
                         volume: Volume? = nil) async throws -> CaptureStore {
        let store = try CaptureStore(root: root, processInstanceID: processInstanceID, waitSeconds: waitSeconds, volume: volume)
        try await store.restore(Restore(pass: "p-restored", unit: "unit-0001"), pass: "p-restored")
        return store
    }
}

struct SealedApart: Error { let count: Int }

struct NeverHeld: Error {}

let waitLimit: TimeInterval = 30

extension XCTestCase {
    @nonobjc func until(_ what: String, isolation: isolated (any Actor)? = #isolation, file: StaticString = #filePath, line: UInt = #line,
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
}

final class Happened: @unchecked Sendable {
    private let lock = NSLock()
    private var happened = false

    var value: Bool { lock.withLock { happened } }

    func note() {
        lock.withLock { happened = true }
    }
}

extension HomeClock {
    static func steady(_ zone: String, startHour: Int = 4) -> HomeClock {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: zone)!
        let start = calendar.date(from: DateComponents(year: 1970, month: 1, day: 1, hour: startHour))!
        let run = HomeClock.Run(day: "1970-01-01", startMs: Int64(start.timeIntervalSince1970 * 1000), days: 1, zone: zone)!
        return HomeClock(id: "steady-\(zone)-\(startHour)", runs: [run])!
    }

    static func fixture(_ name: String) throws -> HomeClock {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("homelink/Tests/Fixtures/clock-cases.json")
        let cases = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        let entry = try XCTUnwrap((cases["clocks"] as? [[String: Any]])?.first { $0["name"] as? String == name }, name)
        return try XCTUnwrap(HomeClock(body: JSONSerialization.data(withJSONObject: XCTUnwrap(entry["clock"]))), name)
    }
}
