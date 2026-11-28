import CoreGraphics
import DeviceFiles
import CryptoKit
import Evidence
import Foundation
import HomeLink
import XCTest
import Spool
@testable import Shipping

final class ScreenSpoolDomainTests: XCTestCase {
    private var root: URL!
    private var spool: URL!

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("screen-spool-domain-tests")
        spool = root.appendingPathComponent("Lifestream Screen", isDirectory: true)
        try FileManager.default.createDirectory(at: spool, withIntermediateDirectories: true)
        try compactor(position: 0)
    }

    private func compactor(position: Int, written: Date = Date(timeIntervalSince1970: 946_684_800)) throws {
        let file = try DomainFixtures.directory(spool.appendingPathComponent(".text")).appendingPathComponent("position")
        try Data(String(position).utf8).write(to: file)
        try FileManager.default.setAttributes([.modificationDate: written], ofItemAtPath: file.path)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private static let source = "screen:local:unit-0001"
    private var work: URL { root.appendingPathComponent("work", isDirectory: true) }
    private var ledgers: Ledgers { Ledgers(root: root.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain)) }
    private var ledgerFile: URL { ledgers.file(pass: ShippingFixture.pass, source: Self.source) }

    private func marked(_ mark: String?, blobs: [String] = []) throws -> SealCustody {
        var observations: [ScreenSpoolDomain.Observation] = []
        if let mark {
            for day in try Spool.days(in: spool) where day <= String(mark.prefix(10)) {
                for bundle in try Spool.listing(of: day, in: spool).bundles where day + "/" + bundle <= mark {
                    observations.append(ScreenSpoolDomain.Observation(path: day + "/" + bundle, day: day, bundle: bundle))
                }
            }
        }
        var entry = ScreenSpoolDomain.ScreenEntry(carrying: observations, blobs: blobs)
        if mark == nil { entry.through = "" }
        return try DomainFixtures.received(entry, source: Self.source, ledgers: ledgers)
    }

    private func entry(_ sealed: SealedBundle) throws -> ScreenSpoolDomain.ScreenEntry {
        try DomainFixtures.entry(ScreenSpoolDomain.ScreenEntry.self, of: sealed, ledgers: ledgers)
    }

    private func domain(now: String = "2026-09-23T04:30:00.000Z", limit: Int = ScreenSpoolDomain.maximumObservations,
                        bytes: Int = ScreenSpoolDomain.maximumObservationBytes) throws -> ScreenSpoolDomain {
        let date = try DomainFixtures.instant(now)
        return ScreenSpoolDomain(sourceId: Self.source, spoolRoot: spool, ledgers: ledgers,
                                 maximumObservations: limit, maximumObservationBytes: bytes, clock: { date })
    }


    private static func bundleName(_ spelling: String, _ index: Int) throws -> String {
        let date = try DomainFixtures.instant(spelling)
        let stamp = String(format: "%020.0f", date.timeIntervalSince1970 * 1_000_000)
        return stamp + String(format: "-00000000-0000-4000-8000-%012d", index)
    }

    private static func segmentName(_ index: Int) -> String {
        String(format: "%08d-0000-4000-8000-000000000000.mov", index)
    }

    static func gapJSON(_ spelling: String, reason: String = "secure-input-enabled", until: String? = nil) throws -> String {
        let ms = Int((try DomainFixtures.instant(spelling).timeIntervalSince1970 * 1000).rounded())
        let end = try until.map { #""capturedUntil":\#(Int((try DomainFixtures.instant($0).timeIntervalSince1970 * 1000).rounded())),"# } ?? ""
        return #"{"capturedAt":\#(ms),\#(end)"displayID":0,"height":0,"ocr":[],"ocrStatus":"not-run","reason":"\#(reason)","status":"gap","width":0,"windows":[]}"#
    }

    @discardableResult
    private func distinctGap(_ spelling: String, _ index: Int) throws -> String {
        try observation(spelling, index, json: Self.gapJSON(spelling, reason: "synthetic-reason-\(index)"))
    }

    private func compacted(through spelling: String) throws {
        try compactor(position: Int((try DomainFixtures.instant(spelling).timeIntervalSince1970 * 1_000_000).rounded()))
    }

    static func frameJSON(_ spelling: String, imageFile: String) throws -> String {
        let ms = Int((try DomainFixtures.instant(spelling).timeIntervalSince1970 * 1000).rounded())
        let image = imageFile.replacingOccurrences(of: "/", with: "\\/")
        return #"{"accessibility":{"capturedAt":\#(ms + 40),"capturedUntil":\#(ms + 90),"limitReasons":[],"nodes":[{"depth":0,"role":"AXWindow","title":"Synthetic window"},{"depth":1,"role":"AXStaticText","value":"SYNTHETIC TEXT"}],"status":"complete-scoped-app-reported","windowCorrelation":"unique-pid-and-window-geometry"},"application":{"bundleID":"com.example.editor","name":"Example Editor","pid":4242},"capturedAt":\#(ms),"capturedUntil":\#(ms + 30),"displayID":1,"height":48,"imageFile":"\#(image)","inputIdleSeconds":1.5,"ocr":[{"bounds":{"height":0.125,"width":0.5,"x":0.25,"y":0.5},"confidence":1,"text":"SYNTHETIC TEXT"}],"ocrStatus":"complete-full-pixels-changed","reason":"foreground-pid-matched-around-image-acquisition; non-atomic-observation","status":"captured","width":64,"windows":[{"application":{"bundleID":"com.example.editor","name":"Example Editor","pid":4242},"bounds":{"height":455,"width":640,"x":0,"y":25},"title":"Synthetic window","windowID":11}]}"#
    }

    @discardableResult
    private func observation(_ spelling: String, _ index: Int, day: String? = nil, json: String? = nil,
                             packet: Data? = nil) throws -> String {
        let name = try Self.bundleName(spelling, index)
        let path = (day ?? String(spelling.prefix(10))) + "/" + name
        let folder = spool.appendingPathComponent(path, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let bytes = try packet ?? MetadataCodec.encode(Data((json ?? Self.gapJSON(spelling)).utf8))
        try bytes.write(to: folder.appendingPathComponent("observation.lsm"))
        return path
    }

    @discardableResult
    private func segment(_ index: Int, bytes: String? = nil) throws -> String {
        let text = bytes ?? "fake movie \(index)"
        try DomainFixtures.write(text, to: spool.appendingPathComponent(".video").appendingPathComponent(Self.segmentName(index)))
        return DomainFixtures.sha256(text)
    }

    static func sidecarSpelling(_ hex: String) -> String {
        var bytes = Data()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            bytes.append(UInt8(hex[index..<next], radix: 16)!)
            index = next
        }
        return bytes.base64EncodedString().replacingOccurrences(of: "/", with: "\\/")
    }

    static let metadataSpelling = sidecarSpelling(String(repeating: "a", count: 64))

    @discardableResult
    private func archived(_ spelling: String, _ index: Int, segment: Int, ordinal: Int, frames: Int,
                          hash: String? = nil, path: String? = nil) throws -> String {
        let bundle = try observation(spelling, index,
            json: Self.frameJSON(spelling, imageFile: "\(spelling.prefix(10))/\(try Self.bundleName(spelling, index))/image.open"))
        let segmentPath = path ?? ".video/" + Self.segmentName(segment)
        let segmentHash = hash ?? DomainFixtures.sha256("fake movie \(segment)")
        let sidecar = #"{"imagePath":"\#(bundle.replacingOccurrences(of: "/", with: "\\/"))\/image.open","#
            + #""metadataSHA256":"\#(Self.metadataSpelling)","#
            + #""reference":{"capturedAt":1700000000123,"encoding":{"codec":"hevc-lossy-v1"},"frameCount":\#(frames),"#
            + #""ordinal":\#(ordinal),"segment":"\#(segmentPath.replacingOccurrences(of: "/", with: "\\/"))","#
            + #""segmentSHA256":"\#(Self.sidecarSpelling(segmentHash))","version":1}}"#
        try DomainFixtures.write(sidecar, to: spool.appendingPathComponent(bundle).appendingPathComponent("image.archive"))
        return bundle
    }

    @discardableResult
    private func inOpenSegment(_ spelling: String, _ index: Int) throws -> String {
        let bundle = try observation(spelling, index,
            json: Self.frameJSON(spelling, imageFile: "\(spelling.prefix(10))/\(try Self.bundleName(spelling, index))/image.open"))
        let segment = String(format: "00000000-0000-4000-8000-%012d", 900 + index)
        try DomainFixtures.write(#"{"ordinal":0,"segment":"\#(segment)"}"#,
                                 to: spool.appendingPathComponent(bundle).appendingPathComponent("image.open"))
        _ = try DomainFixtures.directory(spool.appendingPathComponent(".video/.open-" + segment))
        return bundle
    }

    private func listed(_ sealed: SealedBundle) throws -> [String] {
        try lines(sealed).map { try XCTUnwrap($0["bundle"] as? String) }
    }

    private func lines(_ sealed: SealedBundle) throws -> [[String: Any]] {
        let text = try XCTUnwrap(try StoredZipReader(sealed.file).text("observations.jsonl"))
        return try text.split(separator: "\n").map {
            try XCTUnwrap(try JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])
        }
    }

    private func manifest(_ sealed: SealedBundle) throws -> [String: Any] {
        let text = try XCTUnwrap(try StoredZipReader(sealed.file).text("manifest.json"))
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }


    func testTheManifestIsTheBytesTheHomeReads() throws {
        let asleep = try Self.gapJSON("2026-09-22T22:30:00.000Z", reason: "display_asleep_or_session_inactive")
        let gap = try observation("2026-09-22T22:30:00.000Z", 1, json: asleep)
        let first = try archived("2026-09-22T22:30:02.000Z", 2, segment: 1, ordinal: 0, frames: 2)
        let second = try archived("2026-09-22T22:30:04.000Z", 3, segment: 1, ordinal: 1, frames: 2)
        let movie = try segment(1)
        let request = try DomainFixtures.request(work: work, at: "2026-09-23T04:30:00.250Z")
        let sealed = try XCTUnwrap(try domain().sealOne(request))
        let zip = try StoredZipReader(sealed.file)
        XCTAssertEqual(zip.names, ["observations.jsonl", "blobs/\(movie)", "manifest.json"])
        let text = try XCTUnwrap(zip.text("observations.jsonl"))
        let sidecar = { (bundle: String, ordinal: Int) in
            #"{"imagePath":"\#(bundle.replacingOccurrences(of: "/", with: "\\/"))\/image.open","metadataSHA256":"\#(Self.metadataSpelling)","reference":{"capturedAt":1700000000123,"encoding":{"codec":"hevc-lossy-v1"},"frameCount":2,"ordinal":\#(ordinal),"segment":".video\/00000001-0000-4000-8000-000000000000.mov","segmentSHA256":"\#(Self.sidecarSpelling(movie))","version":1}}"#
        }
        XCTAssertEqual(text, [
            #"{"bundle":"\#(gap)","observation":\#(asleep),"run":null}"#,
            #"{"bundle":"\#(first)","observation":\#(try Self.frameJSON("2026-09-22T22:30:02.000Z", imageFile: first + "/image.open")),"archive":\#(sidecar(first, 0)),"pending":null,"text":null}"#,
            #"{"bundle":"\#(second)","observation":\#(try Self.frameJSON("2026-09-22T22:30:04.000Z", imageFile: second + "/image.open")),"archive":\#(sidecar(second, 1)),"pending":null,"text":null}"#,
        ].map { $0 + "\n" }.joined())
        XCTAssertEqual(DomainFixtures.sha256(text), Self.observationsSHA256,
                       "the bytes the home's screen connector reads")
        let manifest = try XCTUnwrap(zip.text("manifest.json"))
        XCTAssertEqual(manifest, #"{"format":"org.lifestreamprotocol.acquisition/1","source_id":"screen:local:unit-0001","feeder":"screen-recorder","fetched_at":"2026-09-23T04:30:00.250Z","complete":true,"files":[{"file":"observations.jsonl","sha256":"\#(Self.observationsSHA256)","bytes":\#(Data(text.utf8).count)}],"facts":{"observations":3,"metadata_unreadable":0,"frames_archived":2,"segments":1,"segments_missing":0,"frames_text":0,"text_segments":0,"text_unproven":0,"gap_runs":0,"first_captured_at":"2026-09-22T22:30:00.000Z","last_captured_at":"2026-09-22T22:30:04.000Z","snapshot_taken_at":"2026-09-23T04:30:00.250Z","blobs_carried":1},"custody":{"screen:local:unit-0001":{"seal":1}}}"# + "\n")
        XCTAssertEqual(try entry(sealed).through, second)
        XCTAssertEqual(try entry(sealed).blobs, [movie])
        XCTAssertEqual(sealed.sidecar.sourceId, Self.source)
        XCTAssertEqual(zip.text("blobs/\(movie)"), "fake movie 1")
    }

    static let observationsSHA256 = "3618a81f9c2148633a4c899212bc52bd962974bcd666a8923be91de6878218f6"

    func testAPacketThatDoesNotDecodeIsCountedAndPassed() throws {
        let broken = try observation("2026-09-23T04:00:00.000Z", 1, packet: Data("LSMETA01 not a packet".utf8))
        let kept = try observation("2026-09-23T04:00:02.000Z", 2)
        let sealed = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-23T05:00:30.000Z")))
        XCTAssertEqual(try listed(sealed), [kept])
        let facts = try XCTUnwrap(try manifest(sealed)["facts"] as? [String: Any])
        XCTAssertEqual(facts["metadata_unreadable"] as? Int, 1)
        XCTAssertEqual(try entry(sealed).through, kept, "the mark passes the broken packet, so it never holds the slice")
        XCTAssertGreaterThan(broken.count, 0)
    }

    func testAFrameInAnOpenSegmentHoldsTheSliceHoweverOldUntilItsSidecarAppears() throws {
        let before = try observation("2026-09-23T04:00:00.000Z", 1)
        let name = try Self.bundleName("2026-09-23T04:00:02.000Z", 2)
        let open = try observation("2026-09-23T04:00:02.000Z", 2,
                                   json: Self.frameJSON("2026-09-23T04:00:02.000Z", imageFile: "2026-09-23/\(name)/image.open"))
        try DomainFixtures.write(#"{"ordinal":0,"segment":"00000000-0000-4000-8000-000000000001"}"#,
                                 to: spool.appendingPathComponent(open).appendingPathComponent("image.open"))
        let segmentFolder = try DomainFixtures.directory(spool.appendingPathComponent(".video/.open-00000000-0000-4000-8000-000000000001"))
        try observation("2026-09-23T04:00:04.000Z", 3)
        let late = try XCTUnwrap(try domain(now: "2026-09-23T09:00:00.000Z")
            .sealOne(DomainFixtures.request(work: work, at: "2026-09-23T09:00:00.000Z")))
        XCTAssertEqual(try listed(late), [before], "a frame whose image is still a sample never ships inline")
        XCTAssertEqual(try entry(late).blobs, [])

        try FileManager.default.removeItem(at: segmentFolder)
        try segment(1)
        let sidecar = #"{"imagePath":"\#(open.replacingOccurrences(of: "/", with: "\\/"))\/image.open","#
            + #""metadataSHA256":"\#(Self.metadataSpelling)","#
            + #""reference":{"capturedAt":1700000000123,"encoding":{"codec":"hevc-lossy-v1"},"frameCount":1,"#
            + #""ordinal":0,"segment":".video\/\#(Self.segmentName(1))","#
            + #""segmentSHA256":"\#(Self.sidecarSpelling(DomainFixtures.sha256("fake movie 1")))","version":1}}"#
        try DomainFixtures.write(sidecar, to: spool.appendingPathComponent(open).appendingPathComponent("image.archive"))
        let archived = try XCTUnwrap(try domain(now: "2026-09-23T09:00:00.000Z")
            .sealOne(DomainFixtures.request(work: work, at: "2026-09-23T09:00:00.000Z", custody: marked(before))))
        XCTAssertEqual(try listed(archived).first, open)
        XCTAssertNotNil(try lines(archived).first?["archive"] as? [String: Any])
        XCTAssertNil(try lines(archived).first?["pending"] as? [String: Any])
    }

    func testTheShipperMovesPastAFrameItsClosedSegmentDidNotTake() async throws {
        for damage in ["metadata-unreadable", "image-open-elsewhere", "bundle-deleted"] {
            try? FileManager.default.removeItem(at: spool)
            try compactor(position: 0)
            let store = try CaptureStore(directory: spool, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), videoQuality: 0.65)
            var paths: [String] = []
            for index in 0..<3 {
                let spelling = "2026-09-23T04:00:0\(index * 2).000Z"
                let item = CaptureObservation(capturedAt: try DomainFixtures.instant(spelling), displayID: 1, width: 64, height: 48)
                let saved = try store.append(observation: item, image: .raw(Self.pixels(UInt8(40 + index * 40))))
                paths.append(String(try XCTUnwrap(saved.imageFile).dropLast("/image.open".count)))
            }
            let middle = spool.appendingPathComponent(paths[1])
            switch damage {
            case "metadata-unreadable":
                try MetadataCodec.encode(Data(#"{"synthetic":"not an observation"}"#.utf8))
                    .write(to: middle.appendingPathComponent("observation.lsm"))
            case "image-open-elsewhere":
                let file = middle.appendingPathComponent("image.open")
                let json = String(decoding: try Data(contentsOf: file), as: UTF8.self)
                try Data(json.replacingOccurrences(of: #""ordinal":1"#, with: #""ordinal":0"#).utf8).write(to: file)
            default:
                try FileManager.default.removeItem(at: middle)
            }
            while try await store.compactPendingVideo(flush: true).imageCount > 0 {}
            let sealed = try XCTUnwrap(try domain(now: "2026-09-23T05:30:00.000Z")
                .sealOne(DomainFixtures.request(work: work, at: "2026-09-23T05:30:00.000Z")), damage)
            let shipped = try lines(sealed)
            let facts = try XCTUnwrap(try manifest(sealed)["facts"] as? [String: Any])
            XCTAssertEqual(try entry(sealed).through, paths[2], "the mark moves past the bad frame: \(damage)")
            XCTAssertEqual(facts["frames_archived"] as? Int, 2, damage)
            XCTAssertEqual(facts["segments"] as? Int, 1, damage)
            if damage == "bundle-deleted" {
                XCTAssertEqual(shipped.compactMap { $0["bundle"] as? String }, [paths[0], paths[2]])
            } else {
                XCTAssertEqual(shipped.compactMap { $0["bundle"] as? String }, paths, damage)
                XCTAssertTrue(shipped[1]["archive"] is NSNull, "the frame ships with no image: \(damage)")
                XCTAssertTrue(shipped[1]["pending"] is NSNull, damage)
            }
        }
    }

    func testAFrameOfASetAsideSegmentShipsWithNoImageAndTheNextFrameFollows() async throws {
        let store = try CaptureStore(directory: spool, files: DeviceFiles(.plain), scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true), videoQuality: 0.65)
        var paths: [String] = []
        for (index, display) in [1, 1, 2].enumerated() {
            let spelling = "2026-09-23T04:00:0\(index * 2).000Z"
            let item = CaptureObservation(capturedAt: try DomainFixtures.instant(spelling), displayID: UInt32(display),
                                          width: 64, height: 48)
            let saved = try store.append(observation: item, image: .raw(Self.pixels(UInt8(40 + index * 40))))
            paths.append(String(try XCTUnwrap(saved.imageFile).dropLast("/image.open".count)))
        }
        let opened = try JSONSerialization.jsonObject(with: Data(contentsOf: spool.appendingPathComponent(paths[0] + "/image.open")))
        let segment = try XCTUnwrap((opened as? [String: Any])?["segment"] as? String)
        try Data("synthetic garbage".utf8).write(to: spool.appendingPathComponent(".video/.open-" + segment + "/format"))
        while try await store.compactPendingVideo(flush: true).imageCount > 0 {}
        XCTAssertTrue(FileManager.default.fileExists(atPath: spool.appendingPathComponent(".video/.damaged-" + segment).path))

        let sealed = try XCTUnwrap(try domain(now: "2026-09-23T05:30:00.000Z")
            .sealOne(DomainFixtures.request(work: work, at: "2026-09-23T05:30:00.000Z")))
        let shipped = try lines(sealed)
        XCTAssertEqual(shipped.compactMap { $0["bundle"] as? String }, paths)
        XCTAssertEqual(try entry(sealed).through, paths[2], "the mark moves past the set-aside frames")
        for line in shipped.prefix(2) {
            XCTAssertTrue(line["archive"] is NSNull, "a frame of the set-aside segment ships with no image")
            XCTAssertTrue(line["pending"] is NSNull)
        }
        XCTAssertNotNil(shipped[2]["archive"] as? [String: Any])
        let facts = try XCTUnwrap(try manifest(sealed)["facts"] as? [String: Any])
        XCTAssertEqual(facts["frames_archived"] as? Int, 1)
        XCTAssertEqual(facts["segments"] as? Int, 1)
    }

    private static func pixels(_ level: UInt8) -> RawFrame {
        var bytes = Data(repeating: level, count: 64 * 48 * 4)
        for index in stride(from: 3, to: bytes.count, by: 4) { bytes[index] = 255 }
        let bitmap = CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
        return RawFrame(layout: FrameLayout(width: 64, height: 48, bytesPerRow: 64 * 4, bitmapInfo: bitmap, renderingIntent: 0,
                                            ICCData: CGColorSpace(name: CGColorSpace.sRGB)!.copyICCData()! as Data), data: bytes)
    }

    func testAnObservationInsideTheGraceOrBehindAStagingFolderWaits() throws {
        try compacted(through: "2026-09-23T06:00:00.000Z")
        let frame = { (spelling: String, index: Int) -> String in
            try self.observation(spelling, index,
                json: Self.frameJSON(spelling, imageFile: "\(spelling.prefix(10))/\(try Self.bundleName(spelling, index))/image.open"))
        }
        let settled = try frame("2026-09-23T04:29:00.000Z", 1)
        _ = try frame("2026-09-23T04:29:45.000Z", 2)
        let sealed = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-23T04:30:00.000Z")))
        XCTAssertEqual(try listed(sealed), [settled], "a capture under 30 s old may still be passed")

        let staged = try Self.bundleName("2026-09-23T04:29:10.000Z", 9)
        try FileManager.default.createDirectory(at: spool.appendingPathComponent("2026-09-23/.pending-" + staged),
                                                withIntermediateDirectories: true)
        _ = try frame("2026-09-23T04:29:20.000Z", 3)
        XCTAssertNil(try domain(now: "2026-09-23T04:31:00.000Z")
            .sealOne(DomainFixtures.request(work: work, at: "2026-09-23T04:31:00.000Z", custody: marked(settled))))
        let later = try XCTUnwrap(try domain(now: "2026-09-23T05:29:11.000Z")
            .sealOne(DomainFixtures.request(work: work, at: "2026-09-23T05:29:11.000Z", custody: marked(settled))))
        XCTAssertEqual(try listed(later).count, 2)
    }

    func testAStagingFolderInTheDayBeforeStillHoldsTheSlice() throws {
        try compacted(through: "2026-09-24T01:00:00.000Z")
        let frame = { (spelling: String, index: Int) -> String in
            try self.observation(spelling, index,
                json: Self.frameJSON(spelling, imageFile: "\(spelling.prefix(10))/\(try Self.bundleName(spelling, index))/image.open"))
        }
        let settled = try frame("2026-09-23T23:58:00.000Z", 1)
        let staged = try Self.bundleName("2026-09-23T23:59:50.000Z", 9)
        try FileManager.default.createDirectory(at: spool.appendingPathComponent("2026-09-23/.pending-" + staged),
                                                withIntermediateDirectories: true)
        _ = try frame("2026-09-24T00:00:10.000Z", 2)
        XCTAssertNil(try domain(now: "2026-09-24T00:30:00.000Z")
            .sealOne(DomainFixtures.request(work: work, at: "2026-09-24T00:30:00.000Z", custody: marked(settled))))
        let later = try XCTUnwrap(try domain(now: "2026-09-24T00:59:51.000Z")
            .sealOne(DomainFixtures.request(work: work, at: "2026-09-24T00:59:51.000Z", custody: marked(settled))))
        XCTAssertEqual(try listed(later).count, 1)
    }

    private func stated(at spelling: String, _ mark: String) throws -> String? {
        let through = try DomainFixtures.stated(domain(now: spelling),
                                                DomainFixtures.request(work: work, at: spelling, custody: marked(mark), owesThrough: true))
        XCTAssertEqual(through?.statedAt, try DomainFixtures.instant(spelling), "stated at the fetch")
        XCTAssertNil(through?.left, "a screen owes no rows")
        return through.map { UTCInstant.rfc3339($0.readThrough) }
    }

    func testAReadThroughIsWhereTheSliceStopped() throws {
        var mark = try observation("2026-09-23T04:20:00.000Z", 1)
        XCTAssertNil(try DomainFixtures.stated(domain(), DomainFixtures.request(work: work, at: "2026-09-23T04:30:00.000Z",
                                                                                custody: marked(mark))),
                     "nothing new and no read-through owed states nothing")

        XCTAssertEqual(try stated(at: "2026-09-23T04:30:00.000Z", mark), "2026-09-23T04:29:30.000Z")
        mark = try observation("2026-09-23T04:30:50.000Z", 2)
        let staged = try Self.bundleName("2026-09-23T04:31:10.000Z", 9)
        try FileManager.default.createDirectory(at: spool.appendingPathComponent("2026-09-23/.pending-" + staged),
                                                withIntermediateDirectories: true)
        XCTAssertEqual(try stated(at: "2026-09-23T04:32:00.000Z", mark), "2026-09-23T04:31:10.000Z")
        try FileManager.default.removeItem(at: spool.appendingPathComponent("2026-09-23/.pending-" + staged))
        try inOpenSegment("2026-09-23T04:31:20.000Z", 3)
        XCTAssertEqual(try stated(at: "2026-09-23T04:33:00.000Z", mark), "2026-09-23T04:31:20.000Z")
    }

    func testAFrameWaitingForTextOrAnOpenRunHoldsTheReadThrough() throws {
        let mark = try observation("2026-09-23T04:20:00.000Z", 1)
        try compactor(position: 0, written: try DomainFixtures.instant("2026-09-23T04:32:00.000Z"))
        let waiting = try observation("2026-09-23T04:31:20.000Z", 2,
            json: Self.frameJSON("2026-09-23T04:31:20.000Z", imageFile: "2026-09-23/\(try Self.bundleName("2026-09-23T04:31:20.000Z", 2))/image.open"))
        XCTAssertEqual(try stated(at: "2026-09-23T04:33:00.000Z", mark), "2026-09-23T04:31:20.000Z")
        try compacted(through: "2026-09-23T04:35:00.000Z")
        let shipped = try XCTUnwrap(try domain(now: "2026-09-23T04:40:00.000Z")
            .sealOne(DomainFixtures.request(work: work, at: "2026-09-23T04:40:00.000Z", custody: marked(mark))))
        XCTAssertEqual(try entry(shipped).through, waiting)
        try observation("2026-09-23T04:41:00.000Z", 3)
        try observation("2026-09-23T04:41:02.000Z", 4)
        XCTAssertEqual(try stated(at: "2026-09-23T04:45:00.000Z", waiting), "2026-09-23T04:41:00.000Z")
    }

    func testAClosuresOpeningGapWaitsForItsSpan() throws {
        let asleep = "display_asleep_or_session_inactive"
        let mark = try distinctGap("2026-09-23T01:00:00.000Z", 1)
        let opening = try observation("2026-09-23T01:10:00.000Z", 2,
                                      json: Self.gapJSON("2026-09-23T01:10:00.000Z", reason: asleep))
        let now = "2026-09-23T04:30:00.000Z"
        XCTAssertNil(try domain(now: now).sealOne(DomainFixtures.request(work: work, at: now, custody: marked(mark))),
                     "three hours on, the opening gap alone is not settled")
        XCTAssertEqual(try stated(at: now, mark), "2026-09-23T01:10:00.000Z", "the read-through stops at the opening gap")

        let span = try observation("2026-09-23T01:10:02.000Z", 3, json: Self.gapJSON(
            "2026-09-23T01:10:02.000Z", reason: asleep, until: "2026-09-23T04:29:00.000Z"))
        let later = "2026-09-23T04:31:00.000Z"
        let sealed = try XCTUnwrap(try domain(now: later).sealOne(DomainFixtures.request(work: work, at: later, custody: marked(mark))))
        XCTAssertEqual(try listed(sealed), [opening, span], "the span ends the opening gap's run; both ship")
        XCTAssertEqual(try lines(sealed).map { $0["run"] is NSNull }, [true, true], "two single gaps, never one run")
        XCTAssertEqual(try entry(sealed).through, span)
    }

    func testAnIdleOpeningGapShipsInTheSealItFallsIn() throws {
        let mark = try distinctGap("2026-09-23T01:00:00.000Z", 1)
        let idle = try observation("2026-09-23T01:10:00.000Z", 2,
                                   json: Self.gapJSON("2026-09-23T01:10:00.000Z", reason: "input-inactive-capture-paused"))
        let now = "2026-09-23T04:30:00.000Z"
        let sealed = try XCTUnwrap(try domain(now: now).sealOne(DomainFixtures.request(work: work, at: now, custody: marked(mark))),
                                   "no span yet, and still it ships")
        XCTAssertEqual(try listed(sealed), [idle])

        try observation("2026-09-23T04:00:00.000Z", 3,
                        json: Self.gapJSON("2026-09-23T04:00:00.000Z", reason: "display_asleep_or_session_inactive"))
        let later = "2026-09-23T04:31:00.000Z"
        XCTAssertNil(try domain(now: later).sealOne(DomainFixtures.request(work: work, at: later, custody: marked(idle))),
                     "the display's opening gap waits for its span, as today")
        XCTAssertEqual(try stated(at: later, idle), "2026-09-23T04:00:00.000Z")
    }

    func testABacklogShipsTheNewestFirstAndThenOnePageAtATime() throws {
        var backlog = try (0..<3).map { try observation(String(format: "2026-09-23T00:59:%02d.000Z", 54 + $0 * 2), $0) }
        backlog += try (3..<6).map { try observation(String(format: "2026-09-23T01:00:%02d.000Z", ($0 - 3) * 2), $0) }
        backlog.append(try observation("2026-09-23T01:10:00.000Z", 6,
                                       json: Self.gapJSON("2026-09-23T01:10:00.000Z", reason: "display_asleep_or_session_inactive")))
        let now = try (7..<9).map { try distinctGap(String(format: "2026-09-23T04:20:%02d.000Z", ($0 - 7) * 2), $0) }
        var owes: [Bool] = []
        let seal = { (at: String, received: Int, imported: Int) throws -> [SealedBundle] in
            let custody = SealCustody(pass: ShippingFixture.pass, received: received, imported: imported)
            let domain = try self.domain(now: at, limit: 3)
            defer { owes.append(domain.owesHistory) }
            return try domain.seal(DomainFixtures.request(work: self.work, at: at, custody: custody))
        }
        let history = { (sealed: SealedBundle) throws -> Bool? in
            try XCTUnwrap(try self.manifest(sealed)["facts"] as? [String: Any])["history"] as? Bool
        }

        let first = try seal("2026-09-23T04:30:00.000Z", 0, 0)
        XCTAssertEqual(first.count, 2)
        XCTAssertEqual(try carried(first[0]), [now[0]], "what was captured now ships first, alone")
        XCTAssertEqual(first[0].sidecar.seal, 1)
        XCTAssertNil(first[0].sidecar.kind)
        XCTAssertNil(try history(first[0]))
        XCTAssertEqual(try carried(first[1]), Array(backlog.prefix(3)), "a page ends before a run the cap would split")
        XCTAssertEqual(try lines(first[1]).count, 1, "one run")
        XCTAssertEqual(first[1].sidecar.seal, 2)
        XCTAssertEqual(first[1].sidecar.kind, "history")
        XCTAssertEqual(try history(first[1]), true)

        let again = try seal("2026-09-23T04:30:30.000Z", 1, 1)
        XCTAssertEqual(try again.map { try carried($0) }, [Array(backlog.prefix(3))])
        XCTAssertEqual(again.first?.sidecar.seal, 2)

        let newer = try distinctGap("2026-09-23T04:30:10.000Z", 9)
        let live = try seal("2026-09-23T04:31:00.000Z", 2, 1)
        XCTAssertEqual(try live.map { try carried($0) }, [[now[1]]], "no page while the home is behind")
        XCTAssertNil(try history(live[0]))

        let second = try seal("2026-09-23T04:32:00.000Z", 3, 3)
        XCTAssertEqual(try second.map { try carried($0) }, [Array(backlog[3..<6])])
        XCTAssertEqual(try second.map { try history($0) }, [true])
        let more = try (10..<13).map { try distinctGap(String(format: "2026-09-23T04:31:%02d.000Z", ($0 - 10) * 2), $0) }
        let third = try seal("2026-09-23T04:33:00.000Z", 4, 4)
        XCTAssertEqual(try third.map { try carried($0) }, [[newer, more[0], more[1]], [backlog[6]]])
        XCTAssertEqual(try third.map { try history($0) }, [nil, true])
        XCTAssertEqual(try seal("2026-09-23T04:34:00.000Z", 6, 6).count, 0, "nothing more is settled")
        XCTAssertEqual(owes, [true, true, true, true, false, false],
                       "the backlog is owed, paged or held, until the page that carries the last of it is sealed")

        let taken = try [first[0], again[0], live[0], second[0]].flatMap { try carried($0) } + third.flatMap { try carried($0) }
        XCTAssertEqual(taken.sorted(), (backlog + now + [newer] + more.prefix(2)).sorted())
        XCTAssertEqual(Set(taken).count, taken.count)
    }

    private func carried(_ sealed: SealedBundle) throws -> [String] {
        try lines(sealed).flatMap { line -> [String] in
            guard let run = line["run"] as? [String: Any], let attempts = run["attempts"] as? [[Any]] else {
                return [try XCTUnwrap(line["bundle"] as? String)]
            }
            return try attempts.map { try XCTUnwrap($0.first as? String) }
        }
    }

    func testTheMarkIsTheLastNameCarriedAndNothingAtOrBeforeItShipsAgain() throws {
        let first = try observation("2026-09-22T23:59:58.000Z", 1)
        let second = try observation("2026-09-23T00:00:00.000Z", 2)
        let sealed = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-23T04:30:00.000Z")))
        XCTAssertEqual(try listed(sealed), [first, second], "days in order")
        XCTAssertEqual(try entry(sealed).through, second)
        XCTAssertNil(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-23T04:30:01.000Z", custody: marked(second))),
                     "nothing new seals nothing")
        let third = try observation("2026-09-23T00:00:02.000Z", 3)
        let next = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-23T04:30:02.000Z",
            custody: marked(second))))
        XCTAssertEqual(try listed(next), [third])
    }

    func testASegmentTheHomeHoldsStaysHomeAndAMissingOneIsCounted() throws {
        let held = try segment(1)
        try archived("2026-09-23T04:00:00.000Z", 1, segment: 1, ordinal: 0, frames: 1)
        try archived("2026-09-23T04:00:02.000Z", 2, segment: 2, ordinal: 0, frames: 1)
        try compacted(through: "2026-09-23T04:05:00.000Z")
        let request = try DomainFixtures.request(work: work, at: "2026-09-23T04:30:00.000Z", custody: marked(nil, blobs: [held]))
        let sealed = try XCTUnwrap(try domain().sealOne(request))
        XCTAssertEqual(try entry(sealed).blobs, [])
        let facts = try XCTUnwrap(try manifest(sealed)["facts"] as? [String: Any])
        XCTAssertEqual(facts["segments"] as? Int, 2)
        XCTAssertEqual(facts["segments_missing"] as? Int, 1)
        XCTAssertEqual(facts["blobs_carried"] as? Int, 0)
    }

    func testALargeSegmentIsStagedBeforeItsBundleAndTheBundleNamesItOnceReady() throws {
        let large = String(repeating: "synthetic movie bytes ", count: 13_000)
        let hash = try segment(1, bytes: large)
        let small = try segment(2)
        try archived("2026-09-23T04:00:00.000Z", 1, segment: 1, ordinal: 0, frames: 1, hash: hash)
        try archived("2026-09-23T04:00:02.000Z", 2, segment: 2, ordinal: 0, frames: 1)
        try compacted(through: "2026-09-23T04:05:00.000Z")
        let board = StagingBoard()
        let asked = Collected<Set<String>>()
        let request = { try DomainFixtures.request(work: self.work, at: "2026-09-23T04:30:00.000Z", owesThrough: true,
                                                   held: { asked.append($0); return [] }, staged: board.staged) }
        let domain = try domain()

        XCTAssertEqual(try domain.seal(request()), [], "a large segment not yet at the door holds the seal back")
        XCTAssertEqual(board.enqueued, [StagingBoard.Enqueued(sha256: hash, bytes: Int64(large.utf8.count), kept: true, kind: .new)],
                       "only the large one is staged, read through this Mac's files")
        XCTAssertNil(domain.through, "work waits: no read-through is stated")
        XCTAssertFalse(FileManager.default.fileExists(atPath: ledgerFile.path), "and no seal is recorded")
        XCTAssertEqual(asked.all, [[hash, small]], "the door is asked once which it holds")

        board.ready(hash)
        let sealed = try XCTUnwrap(try domain.sealOne(request()))
        let zip = try StoredZipReader(sealed.file)
        XCTAssertFalse(zip.names.contains("blobs/\(hash)"), "the staged segment is not carried")
        XCTAssertTrue(zip.names.contains("blobs/\(small)"), "a small one still rides in the bundle")
        XCTAssertEqual(try manifest(sealed)["staged_blobs"] as? [String], ["sha256:\(hash)"])
        XCTAssertEqual(sealed.sidecar.stagedBlobs, [hash])
        XCTAssertEqual(Set(try entry(sealed).blobs), [hash, small], "the ledger names both as this seal's")
        XCTAssertEqual(board.enqueued.count, 1, "a ready file is not staged again")
    }

    func testTheReadyFramesShipWhileANewerLargeSegmentIsStillStaging() throws {
        let large = String(repeating: "synthetic movie bytes ", count: 13_000)
        let small = try segment(1)
        let hash = try segment(2, bytes: large)
        let ready = try archived("2026-09-23T04:00:00.000Z", 1, segment: 1, ordinal: 0, frames: 1)
        let waiting = try archived("2026-09-23T04:00:02.000Z", 2, segment: 2, ordinal: 0, frames: 1, hash: hash)
        try compacted(through: "2026-09-23T04:05:00.000Z")
        let board = StagingBoard()
        let asked = Collected<Set<String>>()
        let request = { (custody: SealCustody) in
            try DomainFixtures.request(work: self.work, at: "2026-09-23T04:30:00.000Z", custody: custody,
                                       held: { asked.append($0); return [] }, staged: board.staged)
        }
        let domain = try domain()

        let first = try XCTUnwrap(try domain.sealOne(request(ShippingFixture.first)))
        XCTAssertEqual(try carried(first), [ready], "the frames before the staging segment ship now")
        XCTAssertEqual(try StoredZipReader(first.file).names.filter { $0.hasPrefix("blobs/") }, ["blobs/\(small)"])
        XCTAssertNil(first.sidecar.stagedBlobs)
        XCTAssertEqual(board.enqueued, [StagingBoard.Enqueued(sha256: hash, bytes: Int64(large.utf8.count), kept: true, kind: .new)],
                       "the large one uploads meanwhile")
        XCTAssertEqual(asked.count, 1, "the door is asked once which files it holds")

        board.ready(hash)
        let custody = SealCustody(pass: ShippingFixture.pass, received: first.sidecar.seal, imported: first.sidecar.seal)
        let second = try XCTUnwrap(try domain.sealOne(request(custody)))
        XCTAssertEqual(try carried(second), [waiting], "the rest follows once its segment is at the door")
        XCTAssertEqual(second.sidecar.stagedBlobs, [hash])
        XCTAssertEqual(board.enqueued.count, 1)
    }

    func testALargeSegmentTheHomeHoldsIsNeitherStagedNorWaitedOn() throws {
        let large = String(repeating: "synthetic movie bytes ", count: 13_000)
        let hash = try segment(1, bytes: large)
        let frame = try archived("2026-09-23T04:00:00.000Z", 1, segment: 1, ordinal: 0, frames: 1, hash: hash)
        try compacted(through: "2026-09-23T04:05:00.000Z")
        let board = StagingBoard()
        let request = try DomainFixtures.request(work: work, at: "2026-09-23T04:30:00.000Z", held: { $0.intersection([hash]) },
                                                 staged: board.staged)

        let sealed = try XCTUnwrap(try domain().sealOne(request))
        XCTAssertEqual(try carried(sealed), [frame])
        XCTAssertEqual(board.enqueued, [], "a held file is not staged")
        XCTAssertFalse(try StoredZipReader(sealed.file).names.contains("blobs/\(hash)"), "nor carried")
        XCTAssertNil(sealed.sidecar.stagedBlobs)
    }

    func testAHistoryPagesLargeSegmentIsStagedAsLaterWork() throws {
        let large = String(repeating: "synthetic movie bytes ", count: 13_000)
        let hash = try segment(1, bytes: large)
        _ = try segment(2)
        try archived("2026-09-22T22:00:00.000Z", 1, segment: 1, ordinal: 0, frames: 1, hash: hash)
        let now = try archived("2026-09-23T04:20:00.000Z", 2, segment: 2, ordinal: 0, frames: 1)
        try compacted(through: "2026-09-23T04:25:00.000Z")
        let board = StagingBoard()
        let request = try DomainFixtures.request(work: work, at: "2026-09-23T04:30:00.000Z", staged: board.staged)
        let domain = try domain(limit: 1)

        let sealed = try domain.seal(request)
        XCTAssertEqual(try sealed.map { try carried($0) }, [[now]], "the live bundle ships; the page waits on its segment")
        XCTAssertEqual(board.enqueued, [StagingBoard.Enqueued(sha256: hash, bytes: Int64(large.utf8.count), kept: true, kind: .later)])
        XCTAssertTrue(domain.owesHistory)
    }

    func testAMissingSegmentTheHomeHoldsIsNamedAndOneItLacksIsLost() throws {
        try archived("2026-09-23T04:00:00.000Z", 1, segment: 1, ordinal: 0, frames: 1)
        try archived("2026-09-23T04:00:02.000Z", 2, segment: 2, ordinal: 0, frames: 1)
        try compacted(through: "2026-09-23T04:05:00.000Z")
        let homes = DomainFixtures.sha256("fake movie 1"), lacks = DomainFixtures.sha256("fake movie 2")
        let asked = Collected<Set<String>>()
        let request = SealRequest(fetchedAt: try DomainFixtures.instant("2026-09-23T04:30:00.000Z"),
                                  workDirectory: try DomainFixtures.directory(work), scratch: try DomainFixtures.directory(work), custody: ShippingFixture.first,
                                  held: { hexes in
                                      asked.append(hexes)
                                      return hexes.intersection([homes])
                                  })
        let sealed = try XCTUnwrap(try domain().sealOne(request))
        XCTAssertEqual(asked.all, [[homes, lacks]], "both segments are asked of the home")
        XCTAssertEqual(try entry(sealed).blobs, [homes], "the one the home holds is named")
        let lost = try XCTUnwrap(try DomainFixtures.custody(of: sealed)["lost"] as? [[String: Any]])
        XCTAssertEqual(lost.map { $0["items"] as? Int }, [1])
        XCTAssertEqual(lost.map { $0["what"] as? String }, [BundleWriter.missingFiles])
        let facts = try XCTUnwrap(try manifest(sealed)["facts"] as? [String: Any])
        XCTAssertEqual(facts["segments_missing"] as? Int, 2)
        XCTAssertEqual(facts["blobs_carried"] as? Int, 0)
    }

    func testASegmentWhoseBytesDoNotMatchItsHashIsCountedMissingAndTheRestShips() throws {
        try segment(1, bytes: "tampered movie")
        let good = try segment(2)
        try archived("2026-09-23T04:00:00.000Z", 1, segment: 1, ordinal: 0, frames: 1)
        try archived("2026-09-23T04:00:02.000Z", 2, segment: 2, ordinal: 0, frames: 1)
        let last = try observation("2026-09-23T04:00:04.000Z", 3)
        let sealed = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-23T05:00:30.000Z")))
        XCTAssertEqual(try listed(sealed).count, 3, "every observation ships; the frame still names its segment")
        XCTAssertEqual(try entry(sealed).blobs, [good], "the tampered bytes never travel")
        XCTAssertEqual(try entry(sealed).through, last, "the mark moves past it")
        let facts = try XCTUnwrap(try manifest(sealed)["facts"] as? [String: Any])
        XCTAssertEqual(facts["segments"] as? Int, 2)
        XCTAssertEqual(facts["segments_missing"] as? Int, 1)
    }

    func testASidecarNamingAPathOutsideTheVideoFolderCarriesNothingFromThere() throws {
        try DomainFixtures.write("secret", to: root.appendingPathComponent("outside.mov"))
        let hash = DomainFixtures.sha256("secret")
        try archived("2026-09-23T04:00:00.000Z", 1, segment: 1, ordinal: 0, frames: 1, hash: hash, path: "../outside.mov")
        let sealed = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-23T05:00:30.000Z")))
        XCTAssertEqual(try entry(sealed).blobs, [])
        let facts = try XCTUnwrap(try manifest(sealed)["facts"] as? [String: Any])
        XCTAssertEqual(facts["segments_missing"] as? Int, 1)
    }

    func testOneBundleCarriesAtMostTheLimitAndTheNextRunContinues() throws {
        let names = try (0..<5).map { try distinctGap(String(format: "2026-09-23T04:00:%02d.000Z", $0 * 2), $0) }
        let first = try XCTUnwrap(try domain(limit: 3).sealOne(DomainFixtures.request(work: work, at: "2026-09-23T05:30:00.000Z")))
        XCTAssertEqual(try listed(first).count, 3)
        XCTAssertEqual(try entry(first).through, names[2])
        let second = try XCTUnwrap(try domain(limit: 3).sealOne(DomainFixtures.request(work: work, at: "2026-09-23T05:30:01.000Z",
            custody: marked(names[2]))))
        XCTAssertEqual(try listed(second), Array(names.suffix(2)))
    }

    func testOneBundleCarriesAtMostTheByteCapAndALargerLineShipsAlone() throws {
        let names = try (0..<5).map { try distinctGap(String(format: "2026-09-23T04:00:%02d.000Z", $0 * 2), $0) }
        let lineBytes = try listedBytes(try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-23T05:30:00.000Z"))))
            / names.count
        try? FileManager.default.removeItem(at: ledgers.root)
        let capped = try domain(bytes: lineBytes * 5 / 2)
        let first = try XCTUnwrap(try capped.sealOne(DomainFixtures.request(work: work, at: "2026-09-23T05:30:00.000Z")))
        XCTAssertEqual(try listed(first), Array(names.prefix(2)))
        XCTAssertEqual(try entry(first).through, names[1])
        XCTAssertEqual(try manifest(first)["facts"].flatMap { ($0 as? [String: Any])?["observations"] as? Int }, 2)
        let second = try XCTUnwrap(try capped.sealOne(DomainFixtures.request(work: work, at: "2026-09-23T05:30:01.000Z", custody: marked(names[1]))))
        XCTAssertEqual(try listed(second), Array(names[2...3]))

        let tiny = try XCTUnwrap(try domain(bytes: 10).sealOne(DomainFixtures.request(work: work, at: "2026-09-23T05:30:02.000Z",
            custody: marked(names[3]))))
        XCTAssertEqual(try listed(tiny), [names[4]])
    }

    private func listedBytes(_ sealed: SealedBundle) throws -> Int {
        try XCTUnwrap(try StoredZipReader(sealed.file).text("observations.jsonl")).utf8.count
    }

    func testHiddenEntriesAndNamesOutsideTheGrammarNeverShip() throws {
        let kept = try observation("2026-09-23T04:00:00.000Z", 1)
        try DomainFixtures.write("x", to: spool.appendingPathComponent("2026-09-23/notes.txt"))
        try DomainFixtures.write("x", to: spool.appendingPathComponent("2026-09-23/.DS_Store"))
        try DomainFixtures.write("x", to: spool.appendingPathComponent("not-a-day/00001790150400000000-x/observation.lsm"))
        try DomainFixtures.write("{}", to: spool.appendingPathComponent("app-modes.json"))
        try DomainFixtures.write("x", to: spool.appendingPathComponent(kept + "/stray.bin"))
        let sealed = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-23T05:00:30.000Z")))
        XCTAssertEqual(try listed(sealed), [kept])
    }

    func testASpoolThatIsNotThereRefuses() throws {
        try FileManager.default.removeItem(at: spool)
        XCTAssertThrowsError(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-23T04:30:00.000Z")))
    }


    private func shippedTwoDays(now: String) throws -> (domain: ScreenSpoolDomain, id: String, days: [String]) {
        try? FileManager.default.removeItem(at: ledgers.root)
        try segment(1)
        try archived("2026-09-10T23:59:58.000Z", 1, segment: 1, ordinal: 0, frames: 2)
        try archived("2026-09-11T00:00:00.000Z", 2, segment: 1, ordinal: 1, frames: 2)
        try observation("2026-09-11T00:00:02.000Z", 3)
        let domain = try domain(now: now)
        let sealed = try XCTUnwrap(try domain.sealOne(DomainFixtures.request(work: work, at: "2026-09-12T00:00:00.000Z")))
        return (domain, sealed.sidecar.id, ["2026-09-10", "2026-09-11"])
    }

    private func exists(_ path: String) -> Bool {
        FileManager.default.fileExists(atPath: spool.appendingPathComponent(path).path)
    }

    private func answer(imported: Bool) async throws -> FreshAnswer {
        try await DomainFixtures.fresh(Self.source, received: 1, imported: imported ? 1 : 0, folder: root)
    }

    func testADayLeavesOnlyWhenImportedAndSevenDaysOldAndTheSegmentOnlyWithItsLastDay() async throws {
        let (young, _, days) = try shippedTwoDays(now: "2026-09-17T00:00:00.000Z")
        young.applied(try await answer(imported: true))
        XCTAssertTrue(exists(days[0]) && exists(days[1]), "under seven days old, nothing leaves")

        let (notImported, _, _) = try shippedTwoDays(now: "2026-09-30T00:00:00.000Z")
        notImported.applied(try await answer(imported: false))
        XCTAssertTrue(exists(days[0]), "a day no imported seal carried stays")

        let (old, _, _) = try shippedTwoDays(now: "2026-09-18T12:00:00.000Z")
        old.applied(try await answer(imported: true))
        XCTAssertFalse(exists(days[0]))
        XCTAssertTrue(exists(days[1]))
        XCTAssertTrue(exists(".video/" + Self.segmentName(1)), "a segment stays while a day naming it stays")
        let kept = try XCTUnwrap(try ledgers.ledger(ScreenSpoolDomain.ScreenEntry.self, pass: ShippingFixture.pass, source: Self.source).read()[1])
        XCTAssertEqual(kept.blobs, [DomainFixtures.sha256("fake movie 1")], "the segment's hash stays while it may be offered")
        XCTAssertEqual(kept.deleted, 1, "the day that left held one observation")

        let later = try domain(now: "2026-09-19T12:00:00.000Z")
        later.applied(try await answer(imported: true))
        XCTAssertFalse(exists(days[1]))
        XCTAssertFalse(exists(".video/" + Self.segmentName(1)))
        XCTAssertTrue(exists(".video"), "the folder itself stays")
        let gone = try XCTUnwrap(try ledgers.ledger(ScreenSpoolDomain.ScreenEntry.self, pass: ShippingFixture.pass, source: Self.source).read()[1])
        XCTAssertEqual(gone.blobs, [], "the segment's hash goes with it, never offered again")
        XCTAssertEqual(gone.deleted, 3)

        try observation("2026-09-19T00:00:00.000Z", 9)
        let restored = try XCTUnwrap(try later.sealOne(DomainFixtures.request(work: work, at: "2026-09-19T12:00:00.000Z")))
        let lost = try XCTUnwrap(try DomainFixtures.custody(of: restored)["lost"] as? [[String: Any]])
        XCTAssertEqual(lost.first?["items"] as? Int, 3)
        XCTAssertEqual(lost.first?["what"] as? String, "screen observations, up to that many: this Mac deleted them after an earlier import",
                       "a bound: the fold counts what this Mac deleted under seals a restored home may still hold")

        let resealed = try XCTUnwrap(try later.sealOne(DomainFixtures.request(work: work, at: "2026-09-19T12:00:00.000Z")))
        XCTAssertEqual(resealed.sidecar.seal, 1)
        let again = try XCTUnwrap(try DomainFixtures.custody(of: resealed)["lost"] as? [[String: Any]])
        XCTAssertEqual(again.first?["items"] as? Int, 3, "the reseal states the same loss")

        try observation("2026-09-19T01:00:00.000Z", 10)
        let next = try XCTUnwrap(try later.sealOne(DomainFixtures.request(
            work: work, at: "2026-09-19T12:00:00.000Z", custody: SealCustody(pass: ShippingFixture.pass, received: 1, imported: 0))))
        XCTAssertEqual(next.sidecar.seal, 2)
        XCTAssertNil(try DomainFixtures.custody(of: next)["lost"], "received covers the seal that stated it")
    }

    func testADayHoldingABundleNoSealCarriedStays() async throws {
        let (domain, _, days) = try shippedTwoDays(now: "2026-09-30T00:00:00.000Z")
        try observation("2026-09-10T23:59:59.000Z", 7)
        domain.applied(try await answer(imported: true))
        XCTAssertTrue(exists(days[0]), "a day holding more bundles than were carried stays")
        XCTAssertFalse(exists(days[1]))
        XCTAssertTrue(exists(".video/" + Self.segmentName(1)), "its frame's day stays, so its segment stays")
    }

    func testADayWhoseBundlesAreNotTheOnesCarriedStaysThoughTheCountsMatch() async throws {
        let (domain, _, days) = try shippedTwoDays(now: "2026-09-30T00:00:00.000Z")
        let carriedName = try Self.bundleName("2026-09-10T23:59:58.000Z", 1)
        try FileManager.default.removeItem(at: spool.appendingPathComponent(days[0] + "/" + carriedName))
        try observation("2026-09-10T23:59:59.000Z", 7)
        domain.applied(try await answer(imported: true))
        XCTAssertTrue(exists(days[0]), "a bundle no seal carried keeps its day")
        XCTAssertFalse(exists(days[1]))
    }

    func testAnObservationPublishedBehindTheNewestCarriedShips() throws {
        let (domain, _, _) = try shippedTwoDays(now: "2026-09-12T00:00:00.000Z")
        let late = try observation("2026-09-10T23:59:59.000Z", 7)
        let next = SealCustody(pass: ShippingFixture.pass, received: 1, imported: 0)
        let sealed = try XCTUnwrap(try domain.sealOne(DomainFixtures.request(work: work, at: "2026-09-12T00:05:00.000Z", custody: next)))
        XCTAssertEqual(try listed(sealed), [late])
        XCTAssertEqual(sealed.sidecar.seal, 2)
        XCTAssertNil(try domain.sealOne(DomainFixtures.request(work: work, at: "2026-09-12T00:10:00.000Z",
                                                            custody: SealCustody(pass: ShippingFixture.pass, received: 2, imported: 0))),
                     "once carried, it is carried")
    }

    func testADayWhoseRunShippedAgainAroundALateObservationLeaves() async throws {
        let (domain, _, days) = try shippedTwoDays(now: "2026-09-30T00:00:00.000Z")
        try observation("2026-09-11T00:00:01.000Z", 7)
        let again = try XCTUnwrap(try domain.sealOne(DomainFixtures.request(work: work, at: "2026-09-30T00:05:00.000Z",
                                                                         custody: SealCustody(pass: ShippingFixture.pass, received: 1, imported: 0))))
        XCTAssertEqual(again.sidecar.seal, 2)
        domain.applied(try await DomainFixtures.fresh(Self.source, received: 2, imported: 2, folder: root))
        XCTAssertFalse(exists(days[0]))
        XCTAssertFalse(exists(days[1]), "the run carried again holds the one carried first")
    }

    func testASegmentWhoseMiddleFrameDidNotAdmitLeavesWithItsDay() async throws {
        try segment(1)
        try archived("2026-09-10T12:00:00.000Z", 1, segment: 1, ordinal: 0, frames: 3)
        try archived("2026-09-10T12:00:04.000Z", 3, segment: 1, ordinal: 2, frames: 3)
        let domain = try domain(now: "2026-09-30T00:00:00.000Z")
        _ = try XCTUnwrap(try domain.sealOne(DomainFixtures.request(work: work, at: "2026-09-12T00:00:00.000Z")))
        domain.applied(try await answer(imported: true))
        XCTAssertFalse(exists("2026-09-10"))
        XCTAssertFalse(exists(".video/" + Self.segmentName(1)), "no retained day names it")
        let ledger = try XCTUnwrap(try ledgers.ledger(ScreenSpoolDomain.ScreenEntry.self, pass: ShippingFixture.pass,
                                                      source: Self.source).read()[1])
        XCTAssertEqual(ledger.segments, [:])
        XCTAssertEqual(ledger.blobs, [], "its hash leaves the ledger with it")
    }

    func testATextSegmentLeavesWithItsDayThoughNotEveryFrameWasCarried() async throws {
        let name = ".text/00000000-0000-4000-8000-000000000009.lstext"
        let files = [name, String(name.dropLast(".lstext".count)) + ".json"]
        for file in files { try DomainFixtures.write("fake text segment", to: spool.appendingPathComponent(file)) }
        let first = try observation("2026-09-10T12:00:00.000Z", 1)
        let second = try observation("2026-09-10T12:00:02.000Z", 2)
        let reference = ScreenSpoolDomain.SegmentReference(segment: name, sha256: DomainFixtures.sha256("fake text segment"),
                                                           ordinal: 0, frames: 3)
        let carried = [ScreenSpoolDomain.Observation(path: first, day: "2026-09-10", bundle: String(first.dropFirst(11)),
                                                     text: reference),
                       ScreenSpoolDomain.Observation(path: second, day: "2026-09-10", bundle: String(second.dropFirst(11)))]
        _ = try DomainFixtures.received(ScreenSpoolDomain.ScreenEntry(carrying: carried, blobs: [reference.sha256]),
                                        source: Self.source, ledgers: ledgers)
        let late = try observation("2026-09-10T12:00:01.000Z", 3)
        try domain(now: "2026-09-30T00:00:00.000Z").applied(try await answer(imported: true))
        XCTAssertTrue(exists("2026-09-10"))
        XCTAssertTrue(files.allSatisfy(exists), "a retained day names it")

        try FileManager.default.removeItem(at: spool.appendingPathComponent(late))
        try domain(now: "2026-09-30T00:00:00.000Z").applied(try await answer(imported: true))
        XCTAssertFalse(exists("2026-09-10"))
        XCTAssertFalse(files.contains(where: exists), "the segment and its manifest leave with the day")
    }

    func testAnUnreadableLedgerDeletesNothing() async throws {
        let (domain, _, days) = try shippedTwoDays(now: "2026-09-30T00:00:00.000Z")
        try DomainFixtures.write("{not json", to: ledgerFile)
        domain.applied(try await answer(imported: true))
        XCTAssertTrue(exists(days[0]) && exists(days[1]))
        XCTAssertThrowsError(try domain.sealOne(DomainFixtures.request(work: work, at: "2026-09-30T00:00:00.000Z")),
                             "a seal will not overwrite a ledger it cannot read")
    }

    func testTheBuilderGivesTheScreenSourceItsDomain() throws {
        let paths = ShippingDomains.conventional(home: root, spool: spool, fullDiskAccessWitness: root.appendingPathComponent("TCC.db"),
                                                 photosAllowed: { false }, importRoom: .roomy(root), files: DeviceFiles(.plain))
        let domains = ShippingDomains.build([Self.source, "coast:local:unit-0001"], paths: paths,
                                            stores: try StoreFixtures.none(root.appendingPathComponent("stores")))
        XCTAssertEqual(domains.map(\.sourceId), [Self.source], "Coast's source is not this Mac's to ship")
        XCTAssertEqual(domains.first?.name, "screen")
        XCTAssertEqual(paths.screenSpoolRoot, spool)
    }
}
