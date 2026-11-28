import CryptoKit
import DeviceFiles
import Darwin
import Evidence
import Foundation
import HomeLink
import XCTest
@testable import Shipping

final class UploadDomainTests: XCTestCase {
    private var root: URL!
    private var folder: URL!

    private static let source = "upload:local:unit-0001"
    private static let fetchedAt = "2026-09-23T04:00:00.000Z"
    private static let modified = "2026-09-20T10:00:00.000Z"
    private static let created = "2026-09-19T08:30:00.000Z"
    private var work: URL { root.appendingPathComponent("work", isDirectory: true) }
    private var cache: URL { root.appendingPathComponent("hash-cache/upload_local_unit-0001.json") }

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("upload-domain-tests")
        folder = root.appendingPathComponent("Lifestream Drop", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: cache.deletingLastPathComponent(), withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func domain(bundleBytes: Int = UploadDomain.defaultBundleBytes, free: Int64? = 1 << 40) -> UploadDomain {
        UploadDomain(sourceId: Self.source, folder: folder, hashCache: cache, ledgers: ledgers, bundleBytes: bundleBytes,
                     disk: Volume(root, every: 0, read: { _ in free }))
    }

    private var ledgers: Ledgers { Ledgers(root: root.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain)) }

    private func carried(_ sealed: SealedBundle) throws -> [String] {
        try DomainFixtures.entry(HashEntry.self, of: sealed, ledgers: ledgers).hashes
    }

    @discardableResult
    private func drop(_ path: String, _ text: String, modified: String = UploadDomainTests.modified) throws -> URL {
        let url = try DomainFixtures.write(text, to: folder.appendingPathComponent(path))
        try FileManager.default.setAttributes([.creationDate: try DomainFixtures.instant(Self.created),
                                               .modificationDate: try DomainFixtures.instant(modified)], ofItemAtPath: url.path)
        return url
    }

    private func seal(_ domain: UploadDomain? = nil, shipped: Set<String> = [], at: String = UploadDomainTests.fetchedAt) throws -> SealedBundle? {
        let custody = shipped.isEmpty ? ShippingFixture.first
            : try DomainFixtures.received(HashEntry(mark: nil, hashes: shipped.sorted()), source: Self.source, ledgers: ledgers)
        return try (domain ?? self.domain()).sealOne(DomainFixtures.request(work: work, at: at, custody: custody))
    }

    private func shipped(_ sealed: SealedBundle) throws -> [String: String] {
        let zip = try StoredZipReader(sealed.file)
        return Dictionary(uniqueKeysWithValues: zip.names.filter { $0.hasPrefix("files/") }
            .map { (String($0.dropFirst("files/".count)), zip.text($0)!) })
    }

    private func facts(_ sealed: SealedBundle) throws -> [String: Any] {
        let manifest = try JSONSerialization.jsonObject(with: Data(try XCTUnwrap(StoredZipReader(sealed.file).text("manifest.json")).utf8)) as! [String: Any]
        return manifest["facts"] as! [String: Any]
    }

    func testEveryFileShipsWholeAtItsPathAndTheIndexStatesIt() throws {
        try drop("lab/report-a.pdf", "%PDF synthetic report")
        try drop("notes.txt", "synthetic notes")
        let sealed = try XCTUnwrap(try seal())
        let zip = try StoredZipReader(sealed.file)
        XCTAssertEqual(zip.names, ["upload.json", "files/lab/report-a.pdf", "files/notes.txt", "manifest.json"])
        XCTAssertEqual(try shipped(sealed), ["lab/report-a.pdf": "%PDF synthetic report", "notes.txt": "synthetic notes"])
        XCTAssertEqual(zip.text("upload.json"),
            "{\"format\":\"org.lifestreamprotocol.upload/1\",\"files\":["
            + "{\"path\":\"lab/report-a.pdf\",\"media_type\":\"application/pdf\",\"created_at\":\"\(Self.created)\",\"modified_at\":\"\(Self.modified)\"},"
            + "{\"path\":\"notes.txt\",\"media_type\":\"text/plain\",\"created_at\":\"\(Self.created)\",\"modified_at\":\"\(Self.modified)\"}]}\n")
        let manifest = try XCTUnwrap(zip.text("manifest.json"))
        XCTAssertTrue(manifest.contains("\"source_id\":\"upload:local:unit-0001\",\"feeder\":\"upload-folder\""))
        XCTAssertTrue(manifest.hasSuffix("\"facts\":{\"files\":2,\"unsettled\":0,\"waiting\":0,\"unnamed\":0,\"unreadable\":0,\"no_room\":0,"
            + "\"snapshot_taken_at\":\"\(Self.fetchedAt)\",\"blobs_carried\":0},\"custody\":{\"upload:local:unit-0001\":{\"seal\":1}}}\n"))
        XCTAssertEqual(try carried(sealed), [DomainFixtures.sha256("%PDF synthetic report"), DomainFixtures.sha256("synthetic notes")].sorted())
        XCTAssertEqual(sealed.sidecar.id, "upload:local:unit-0001/20260923T040000.000Z")
    }

    func testAnAcceptedFileStaysHomeAndAChangedOneShipsAgain() throws {
        try drop("notes.txt", "synthetic notes")
        try drop("report.pdf", "%PDF synthetic report")
        let first = try XCTUnwrap(try seal())
        let ledger = Set(try carried(first))
        XCTAssertNil(try seal(shipped: ledger, at: "2026-09-23T04:05:00.000Z"))
        try drop("notes.txt", "synthetic notes, edited", modified: "2026-09-22T10:00:00.000Z")
        let second = try XCTUnwrap(try seal(shipped: ledger, at: "2026-09-23T04:10:00.000Z"))
        XCTAssertEqual(try shipped(second), ["notes.txt": "synthetic notes, edited"])
        try drop("notes.txt", "synthetic notes", modified: "2026-09-22T11:00:00.000Z")
        XCTAssertNil(try seal(shipped: ledger.union(try carried(second)), at: "2026-09-23T04:15:00.000Z"))
    }

    func testTheSameBytesAtTwoPathsShipOnce() throws {
        try drop("a/statement.pdf", "%PDF synthetic statement")
        try drop("b/statement copy.pdf", "%PDF synthetic statement")
        let sealed = try XCTUnwrap(try seal())
        XCTAssertEqual(try shipped(sealed), ["a/statement.pdf": "%PDF synthetic statement"])
        XCTAssertEqual(try carried(sealed), [DomainFixtures.sha256("%PDF synthetic statement")])
    }

    func testAFileStillBeingWrittenWaits() throws {
        try drop("settled.txt", "settled")
        try drop("fresh.txt", "still growing", modified: "2026-09-23T03:59:58.000Z")
        try drop("takeout-001.zip.crdownload", "half a download")
        try drop("export.zip.download/data", "half a Safari download")
        let sealed = try XCTUnwrap(try seal())
        XCTAssertEqual(try shipped(sealed).keys.sorted(), ["settled.txt"])
        XCTAssertEqual(try facts(sealed)["unsettled"] as? Int, 3)
        let later = try XCTUnwrap(try seal(shipped: Set(try carried(sealed)), at: "2026-09-23T04:00:05.000Z"))
        XCTAssertEqual(try shipped(later).keys.sorted(), ["fresh.txt"])
    }

    func testAFileThatMovedWhileItWasCopiedWaits() throws {
        try drop("steady.txt", "steady")
        let moving = try drop("moving.txt", "the bytes as copied")
        let stamp = try XCTUnwrap(FileFacts.stamp(moving.path))
        try DomainFixtures.write("{\"format\":\"org.lifestreamprotocol.hash-cache/2\"}\n"
            + "{\"locator\":\"moving.txt\",\"bytes\":\(stamp.bytes),\"mtime_ns\":\(stamp.modifiedAt),\"sha256\":\"\(DomainFixtures.sha256("the bytes as hashed"))\"}\n",
            to: cache)
        let sealed = try XCTUnwrap(try seal())
        XCTAssertEqual(try shipped(sealed), ["steady.txt": "steady"])
        XCTAssertEqual(try carried(sealed), [DomainFixtures.sha256("steady")])
        XCTAssertEqual(try facts(sealed)["unsettled"] as? Int, 1)
        XCTAssertEqual(try StoredZipReader(sealed.file).text("upload.json")?.contains("moving.txt"), false)
    }

    func testHiddenNamesLinksAndUnlistableNamesStayHome() throws {
        try drop("kept.txt", "kept")
        try drop(".DS_Store", "finder state")
        try drop(".hidden/inside.txt", "hidden folder")
        try drop("back\\slash.txt", "a name the inbox refuses")
        let outside = try DomainFixtures.write("outside the folder", to: root.appendingPathComponent("outside.txt"))
        try FileManager.default.createSymbolicLink(at: folder.appendingPathComponent("link.txt"), withDestinationURL: outside)
        try FileManager.default.createSymbolicLink(at: folder.appendingPathComponent("linked-folder"), withDestinationURL: root)
        let sealed = try XCTUnwrap(try seal())
        XCTAssertEqual(try shipped(sealed), ["kept.txt": "kept"])
        XCTAssertEqual(try facts(sealed)["unnamed"] as? Int, 1)
    }

    func testABundleHoldsItsCapAndALargerFileTravelsAlone() throws {
        try drop("a.txt", String(repeating: "a", count: 40))
        try drop("b.txt", String(repeating: "b", count: 40))
        try drop("c.bin", String(repeating: "c", count: 200))
        let capped = domain(bundleBytes: 100)
        let first = try XCTUnwrap(try seal(capped))
        XCTAssertEqual(try shipped(first).keys.sorted(), ["a.txt", "b.txt"])
        XCTAssertEqual(try facts(first)["waiting"] as? Int, 1)
        let second = try XCTUnwrap(try seal(capped, shipped: Set(try carried(first)), at: "2026-09-23T04:05:00.000Z"))
        XCTAssertEqual(try shipped(second).keys.sorted(), ["c.bin"])
        XCTAssertEqual(try facts(second)["waiting"] as? Int, 0)
    }

    func testARestoreShipsAgainWhatTheRolledBackSealCarried() throws {
        try drop("notes.txt", "synthetic notes")
        let first = try XCTUnwrap(try seal())
        try drop("report.pdf", "%PDF synthetic report")
        let second = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(
            work: work, at: "2026-09-23T04:05:00.000Z", custody: SealCustody(pass: ShippingFixture.pass, received: 1, imported: 1))))
        XCTAssertEqual(try shipped(second), ["report.pdf": "%PDF synthetic report"])
        let restored = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(
            work: work, at: "2026-09-23T04:10:00.000Z", custody: SealCustody(pass: ShippingFixture.pass, received: 1, imported: 1))))
        XCTAssertEqual(try shipped(restored), ["report.pdf": "%PDF synthetic report"], "seal 1's file stays home")
        XCTAssertEqual(try carried(first), [DomainFixtures.sha256("synthetic notes")])
    }

    func testAFileThatWouldCrossTheLineWaitsAndGoesOnByItself() throws {
        try drop("small.txt", "small")
        try drop("large.bin", String(repeating: "x", count: 4096))
        let sealed = try XCTUnwrap(try seal(domain(free: Room.keepBytes + 1024)))
        XCTAssertEqual(try shipped(sealed).keys.sorted(), ["small.txt"])
        XCTAssertEqual(sealed.sidecar.write, .later, "its upload states it later")
        XCTAssertEqual(try facts(sealed)["no_room"] as? Int, 1)
        let carriedFirst = Set(try carried(sealed))
        XCTAssertNil(try seal(domain(free: Room.keepBytes), shipped: carriedFirst), "on the line, nothing more")
        XCTAssertNil(try seal(domain(free: nil), shipped: carriedFirst), "a disk that does not read takes nothing later")
        let later = try XCTUnwrap(try seal(domain(free: Room.keepBytes + 8192), shipped: carriedFirst), "room again: it goes")
        XCTAssertEqual(try shipped(later).keys.sorted(), ["large.bin"])
    }

    func testTheFolderIsNeverChanged() async throws {
        try drop("lab/report-a.pdf", "%PDF synthetic report")
        try drop("notes.txt", "synthetic notes")
        let before = try tree()
        _ = try XCTUnwrap(try seal())
        domain().applied(try await DomainFixtures.fresh(Self.source, received: 1, imported: 1, folder: root))
        XCTAssertEqual(try tree(), before)
    }

    func testTheFolderIsMadeWhereTheSettingNamesIt() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "upload-domain-tests-\(UUID().uuidString)"))
        XCTAssertEqual(UploadDomain.folder(home: root, defaults: defaults).lastPathComponent, "Lifestream Drop")
        defaults.set("Inbox For Home", forKey: UploadDomain.folderNameKey)
        let named = UploadDomain.folder(home: root, defaults: defaults)
        XCTAssertEqual(named, root.appendingPathComponent("Inbox For Home", isDirectory: true))
        let empty = UploadDomain(sourceId: Self.source, folder: named, hashCache: cache, ledgers: ledgers,
                                 disk: Volume(root, every: 0, read: { _ in 1 << 40 }))
        XCTAssertNil(try empty.sealOne(DomainFixtures.request(work: work)))
        XCTAssertTrue(FileFacts.isDirectory(named.path))
    }

    func testAFileLargerThanMemoryShipsInBoundedMemory() throws {
        let size = 5 << 29
        let large = folder.appendingPathComponent("takeout/takeout-001.zip")
        try FileManager.default.createDirectory(at: large.deletingLastPathComponent(), withIntermediateDirectories: true)
        XCTAssertTrue(FileManager.default.createFile(atPath: large.path, contents: nil))
        let handle = try FileHandle(forWritingTo: large)
        try handle.truncate(atOffset: UInt64(size))
        try handle.close()
        try FileManager.default.setAttributes([.modificationDate: try DomainFixtures.instant(Self.modified)], ofItemAtPath: large.path)
        var digest = SHA256()
        let zeros = Data(count: 1 << 26)
        for _ in 0..<(size / zeros.count) { digest.update(data: zeros) }
        let expected = digest.finalize().map { String(format: "%02x", $0) }.joined()

        let before = peakResident()
        let sealed = try XCTUnwrap(try seal())
        let grown = peakResident() - before
        XCTAssertEqual(try carried(sealed), [expected])
        XCTAssertGreaterThan(FileFacts.regularFileSize(sealed.file.path) ?? 0, size)
        XCTAssertLessThan(grown, 256 << 20, "the seal's peak grew by \(grown) bytes for a \(size)-byte file")
    }

    private func tree() throws -> [String: String] {
        var found: [String: String] = [:]
        let walk = try XCTUnwrap(FileManager.default.enumerator(atPath: folder.path))
        while let path = walk.nextObject() as? String {
            let url = folder.appendingPathComponent(path)
            guard FileFacts.isRegularFile(url.path), let stamp = FileFacts.stamp(url.path) else { continue }
            found[path] = "\(DomainFixtures.sha256(String(decoding: try Data(contentsOf: url), as: UTF8.self))) \(stamp.modifiedAt)"
        }
        return found
    }

    private func peakResident() -> Int {
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        return Int(usage.ru_maxrss)
    }
}
