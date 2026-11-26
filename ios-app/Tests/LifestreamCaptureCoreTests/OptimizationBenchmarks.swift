import Foundation
import Darwin
import XCTest
@testable import LifestreamCaptureCore

final class OptimizationBenchmarks: XCTestCase {
    func testMediaPublication() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let output = environment["OPTIMIZATION_OUTPUT"] else {
            throw XCTSkip("Set OPTIMIZATION_OUTPUT for an explicit Release benchmark")
        }
        let directory = URL(fileURLWithPath: output, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let sizes = environment["OPTIMIZATION_MIB", default: "1,64,1024"].split(separator: ",").compactMap { Int($0) }
        for mib in sizes {
            let source = directory.appendingPathComponent("resource-\(mib).bin")
            let writer = try FileDurability.createRegularFileExclusively(at: source)
            let chunk = Data(repeating: 0x5A, count: 1_048_576)
            for _ in 0..<mib { try writer.write(contentsOf: chunk) }
            try writer.close()
            var samples: [Double] = []
            let baseline = environment["OPTIMIZATION_CARRIER"] == "data"
            let sampleCount = mib == 1 ? 30 : 5
            for index in 0...sampleCount {
                let root = directory.appendingPathComponent("store-\(mib)-\(index)")
                let store = try CaptureStore(root: root)
                let owned = OwnedMediaFile(takingOwnershipOf: root.appendingPathComponent("input"))
                try FileDurability.copyRegularFileDurably(from: source, to: owned.url)
                let start = ContinuousClock.now
                if baseline {
                    _ = try await store.storeBlob(Data(contentsOf: owned.url))
                } else {
                    _ = try await store.storeBlob(file: owned)
                }
                let elapsed = start.duration(to: .now)
                if index > 0 { samples.append(Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18) }
                try FileManager.default.removeItem(at: root)
            }
            var usage = rusage()
            getrusage(RUSAGE_SELF, &usage)
            let record: [String: Any] = ["mib": mib, "seconds": samples, "thermal": ProcessInfo.processInfo.thermalState.rawValue,
                "peak_rss_bytes": usage.ru_maxrss, "carrier_bytes": baseline ? mib * 1_048_576 : 1_048_576, "configuration": "Release; one warmup", "samples": sampleCount, "carrier": baseline ? "data" : "file"]
            try JSONSerialization.data(withJSONObject: record, options: [.prettyPrinted, .sortedKeys])
                .write(to: directory.appendingPathComponent("media-\(mib).json"))
            try FileManager.default.removeItem(at: source)
        }
    }
}

extension OptimizationBenchmarks {
    func testLargeSealMemoryIsBounded() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let output = environment["OPTIMIZATION_EXPORT_JOURNEY_OUTPUT"] else {
            throw XCTSkip("Explicit Release full export journey")
        }
        let mib = try XCTUnwrap(Int(environment["OPTIMIZATION_EXPORT_JOURNEY_MIB", default: "128"]))
        XCTAssertGreaterThan(mib, 0)
        let root = URL(fileURLWithPath: output, isDirectory: true).appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let capture = root.appendingPathComponent("capture")
        let exports = root.appendingPathComponent("exports")
        let store = try CaptureStore(root: capture)
        let source = root.appendingPathComponent("synthetic-media")
        let writer = try FileDurability.createRegularFileExclusively(at: source)
        let chunk = Data(repeating: 0xA5, count: 1_048_576)
        for _ in 0..<mib { try writer.write(contentsOf: chunk) }
        try writer.close()
        let blob = try await store.storeBlob(file: OwnedMediaFile(takingOwnershipOf: source))
        for domain in CaptureDomain.allCases {
            _ = try await store.append(domain: domain, draft: .init(
                kind: "synthetic", observedAt: "2026-08-27T00:00:00Z",
                payload: .object(["hash": .string(blob.hash)])))
        }
        var before = rusage()
        getrusage(RUSAGE_SELF, &before)
        let exporter = CaptureExporter(store: store, exportsDirectory: exports)
        let sealed = try await exporter.copy(hardware: .synthetic, appVersion: "1.0.0")
        let first = try XCTUnwrap(sealed)
        XCTAssertEqual(first.manifest.files["blobs/" + String(blob.hash.dropFirst(7))]?.bytes,
            UInt64(mib) * 1_048_576)
        for domain in CaptureDomain.allCases {
            XCTAssertEqual(first.manifest.files[domain.filename]?.observations, 1)
        }
        XCTAssertEqual(try StoredZIPWriter.readManifest(from: first.url), first.manifest)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: exports.path), [first.url.lastPathComponent])
        var after = rusage()
        getrusage(RUSAGE_SELF, &after)
        print("Full seal peak RSS: \(after.ru_maxrss) bytes; growth: \(after.ru_maxrss - before.ru_maxrss) bytes; media: \(mib) MiB")
        XCTAssertLessThan(after.ru_maxrss - before.ru_maxrss, 64 * 1_048_576)
        XCTAssertLessThan(after.ru_maxrss, 256 * 1_048_576,
            "Fixture setup must not hide unbounded export memory behind an already high peak")
    }

    func testZIPTransferMemoryIsBounded() throws {
        guard let output = ProcessInfo.processInfo.environment["OPTIMIZATION_ZIP_MEMORY_OUTPUT"] else {
            throw XCTSkip("Explicit Release ZIP memory regression workload")
        }
        let root = URL(fileURLWithPath: output, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let source = root.appendingPathComponent("synthetic-media")
        defer { try? FileManager.default.removeItem(at: source) }
        let writer = try FileDurability.createRegularFileExclusively(at: source)
        let chunk = Data(repeating: 0xA5, count: 1_048_576)
        for _ in 0..<128 { try writer.write(contentsOf: chunk) }
        try writer.close()
        let digest = try SHA256Digest.inspectFile(at: source)
        var before = rusage()
        getrusage(RUSAGE_SELF, &before)
        try autoreleasepool {
            let prepared = try StoredZIPWriter.prepare(
                fileURLs: ["blob": source], to: root.appendingPathComponent("bounded.zip"),
                precomputedCRC32: ["blob": digest.crc32], expectedSHA256: ["blob": digest.hash])
            defer { try? StoredZIPWriter.removeTemporary(prepared) }
            defer { try? FileManager.default.removeItem(at: prepared.destinationURL) }
            XCTAssertGreaterThan(prepared.archiveSize, UInt64(128 * 1_048_576))
            try StoredZIPWriter.publish(prepared)
            XCTAssertEqual(try SHA256Digest.taggedFile(at: prepared.destinationURL), prepared.archiveSHA256)
            var after = rusage()
            getrusage(RUSAGE_SELF, &after)
            let growth = after.ru_maxrss - before.ru_maxrss
            print("ZIP peak RSS growth: \(growth) bytes for 128 MiB input")
            XCTAssertLessThan(growth, 32 * 1_048_576,
                "ZIP transfer retained file-sized temporary buffers during one export job")
        }
    }

    func testExportPasses() throws {
        guard let output = ProcessInfo.processInfo.environment["OPTIMIZATION_EXPORT_OUTPUT"] else {
            throw XCTSkip("Explicit Release export workload")
        }
        let root = URL(fileURLWithPath: output, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let source = root.appendingPathComponent("synthetic-media")
        let writer = try FileDurability.createRegularFileExclusively(at: source)
        for _ in 0..<64 { try writer.write(contentsOf: Data(repeating: 0xA5, count: 1_048_576)) }
        try writer.close()
        defer { try? FileManager.default.removeItem(at: source) }
        var before: [Double] = []
        var after: [Double] = []
        for iteration in 0...5 {
            let oldStart = ContinuousClock.now
            let inventoryHash = try SHA256Digest.taggedFile(at: source)
            let manifestHash = try SHA256Digest.taggedFile(at: source)
            XCTAssertEqual(inventoryHash, manifestHash)
            let old = try StoredZIPWriter.prepare(fileURLs: ["blob": source], to: root.appendingPathComponent("old.zip"))
            let oldTime = oldStart.duration(to: .now)
            let newStart = ContinuousClock.now
            let digest = try SHA256Digest.inspectFile(at: source)
            let new = try StoredZIPWriter.prepare(fileURLs: ["blob": source], to: root.appendingPathComponent("new.zip"),
                precomputedCRC32: ["blob": digest.crc32], expectedSHA256: ["blob": digest.hash])
            let newTime = newStart.duration(to: .now)
            XCTAssertEqual(old.archiveSHA256, new.archiveSHA256)
            XCTAssertEqual(old.archiveSize, new.archiveSize)
            try StoredZIPWriter.removeTemporary(old)
            try StoredZIPWriter.removeTemporary(new)
            if iteration > 0 {
                before.append(Double(oldTime.components.seconds) + Double(oldTime.components.attoseconds) / 1e18)
                after.append(Double(newTime.components.seconds) + Double(newTime.components.attoseconds) / 1e18)
            }
        }
        let row: [String: Any] = ["retained_media_bytes": 64 * 1_048_576, "before_seconds": before, "after_seconds": after,
            "media_read_passes_before": 4, "media_read_passes_after": 2, "thermal": ProcessInfo.processInfo.thermalState.rawValue]
        try JSONSerialization.data(withJSONObject: row, options: [.prettyPrinted, .sortedKeys])
            .write(to: root.appendingPathComponent("export.json"))
    }
}
