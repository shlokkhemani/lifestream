import CryptoKit
import DeviceFiles
import Foundation
import SQLite3
import XCTest
@testable import Shipping

extension ShippingFixture {
    static let macKey = SymmetricKey(data: Data(repeating: 0x5a, count: 32))
}

final class KeyedShippingFilesTests: XCTestCase {
    private static let source = "imessage:person-a@example.com:macbook-pro-0001"
    private static let plainName = "imessage_person-a@example.com_macbook-pro-0001"

    private var root: URL!
    private let keyed = DeviceFiles(.keyed(ShippingFixture.macKey))

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("keyed-shipping-files")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func state(_ files: DeviceFiles) -> ShippingState {
        ShippingState(root: root.appendingPathComponent("ship", isDirectory: true), files: files)
    }

    private func disk(_ file: URL) throws -> Data {
        try XCTUnwrap(FileManager.default.contents(atPath: file.path))
    }

    private func holds(_ data: Data, _ text: String) -> Bool {
        data.range(of: Data(text.utf8)) != nil
    }

    func testPlainNamesAreTodaysAndKeyedNamesHoldNoSource() throws {
        let plain = state(DeviceFiles(.plain))
        XCTAssertEqual(plain.ledgers.file(pass: ShippingFixture.pass, source: Self.source).lastPathComponent, Self.plainName + ".json")
        XCTAssertEqual(plain.ledgers.memory(pass: ShippingFixture.pass, source: Self.source).lastPathComponent, Self.plainName)
        XCTAssertEqual(plain.hashCacheFile(Self.source).lastPathComponent, Self.plainName + ".json")

        let encrypted = state(keyed)
        let paths = [encrypted.ledgers.file(pass: ShippingFixture.pass, source: Self.source),
                     encrypted.ledgers.memory(pass: ShippingFixture.pass, source: Self.source),
                     encrypted.ledgers.memory(pass: ShippingFixture.pass, source: Self.source).appendingPathComponent("hashes.json"),
                     encrypted.hashCacheFile(Self.source)]
        for path in paths {
            XCTAssertFalse(path.path.contains("person-a"), "no account in \(path.lastPathComponent)")
            XCTAssertFalse(path.path.contains("imessage"), "no source in \(path.lastPathComponent)")
        }
        XCTAssertEqual(encrypted.hashCacheFile(Self.source).lastPathComponent, keyed.name(Self.source) + ".json")
    }

    func testAKeyedBundleIsNamedForItsKeyedSourceAndCarriesTheSourceInside() throws {
        let out = root.appendingPathComponent("pending", isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let written = try BundleWriter.write(
            into: out, sourceId: Self.source, feeder: "imessage", fetchedAt: ShippingFixture.instant("2026-09-23T04:30:00.250Z"),
            files: [], facts: [], custody: (ShippingFixture.first, []), through: keyed)
        XCTAssertEqual(written.file.lastPathComponent, keyed.name(Self.source) + "__20260923T043000.250Z.zip")
        XCTAssertEqual(written.sourceId, Self.source)
        for entry in try FileManager.default.contentsOfDirectory(atPath: out.path) {
            XCTAssertFalse(entry.contains("person-a"), "no account in \(entry)")
        }
        let zip = try XCTUnwrap(try keyed.read(written.file, maximumBytes: 1 << 20))
        let manifest = String(decoding: try XCTUnwrap(try ZipArchiveProbe(zip).bytes(BundleWriter.manifestFile)), as: UTF8.self)
        XCTAssertTrue(manifest.contains("\"source_id\":\"\(Self.source)\""), "the bundle still names its source: \(manifest)")
    }

    func testALedgerIsEncryptedInTheKeyedFormAndReadsTheSame() throws {
        for files in [DeviceFiles(.plain), keyed] {
            let ledger = state(files).ledgers.ledger(HashEntry.self, pass: ShippingFixture.pass, source: Self.source)
            let hash = DomainFixtures.sha256("synthetic shipped file")
            try ledger.record(HashEntry(mark: nil, hashes: [hash]), at: 1)
            XCTAssertEqual(try ledger.held(through: 1).map(\.entry.hashes), [[hash]])
            XCTAssertEqual(holds(try disk(ledger.file), hash), !files.keyed, "the content hash is plain only on a plain Mac")
            try FileManager.default.removeItem(at: root.appendingPathComponent("ship", isDirectory: true))
        }
    }

    func testAnAbsentFileReadsEmptyInBothForms() throws {
        for files in [DeviceFiles(.plain), keyed] {
            let state = state(files)
            XCTAssertEqual(try state.ledgers.ledger(HashEntry.self, pass: ShippingFixture.pass, source: Self.source).read(), [:])
            XCTAssertEqual(state.readSchedule(), ShippingSchedule())
            XCTAssertEqual(HashCache(file: state.hashCacheFile(Self.source), files: files).count, 0)
            XCTAssertEqual(try state.pendingBundles(), [])
        }
    }

    func testTheScheduleIsEncryptedInTheKeyedForm() throws {
        let state = state(keyed)
        try state.prepare()
        var schedule = ShippingSchedule()
        schedule.lastOutcome = "shipped"
        schedule.pass = ShippingFixture.pass
        try state.writeSchedule(schedule)
        XCTAssertFalse(holds(try disk(state.scheduleFile), "shipped"))
        XCTAssertEqual(state.readSchedule(), schedule)
    }

    func testAPendingSidecarIsEncryptedInTheKeyedFormAndTheBundleIsFound() throws {
        let state = state(keyed)
        try state.prepare()
        let file = state.pendingDirectory.appendingPathComponent("bundle-1.zip")
        try keyed.writeNew(file, Data("synthetic bundle\n".utf8), flush: .data)
        let bundle = SealedBundle(file: file, sidecar: BundleSidecar(id: "\(Self.source)/1", sourceId: Self.source,
                                                                   pass: ShippingFixture.pass, seal: 1, kind: nil, write: .new))
        try state.writeSidecar(bundle)
        XCTAssertFalse(holds(try disk(ShippingState.sidecarFile(for: file)), Self.source))
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar), [bundle.sidecar])
        XCTAssertEqual(state.size(of: bundle), 17, "a kept bundle's size is its plain bytes")
    }

    func testTheHashCacheRewritesAndAppendsInBothForms() throws {
        let first = try DomainFixtures.write("alpha", to: root.appendingPathComponent("media/a.jpg"))
        let second = try DomainFixtures.write("bravo", to: root.appendingPathComponent("media/b.jpg"))
        for files in [DeviceFiles(.plain), keyed] {
            let file = state(files).hashCacheFile(Self.source)
            var cache = HashCache(file: file, files: files)
            _ = try cache.measure(locator: "Media/a.jpg", file: first)
            try cache.save()
            var again = HashCache(file: file, files: files)
            XCTAssertEqual(again.count, 1)
            _ = try again.measure(locator: "Media/b.jpg", file: second)
            try again.save()
            let read = HashCache(file: file, files: files)
            XCTAssertEqual(read.count, 2)
            let bytes = try disk(file)
            XCTAssertEqual(holds(bytes, "Media/b.jpg"), !files.keyed)
            XCTAssertEqual(holds(bytes, DomainFixtures.sha256("alpha")), !files.keyed)
            if files.keyed { XCTAssertEqual(bytes.first, 0x80, "the cache is an encrypted log") }
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: file.deletingLastPathComponent().path), [file.lastPathComponent],
                           "no file left beside it")
            try FileManager.default.removeItem(at: root.appendingPathComponent("ship", isDirectory: true))
        }
    }

    func testTheKeyedFingerprintIsNotThePlainOne() throws {
        func fingerprint(_ files: DeviceFiles) throws -> Int {
            let handle = try SQLite.open(root.appendingPathComponent("fingerprint-\(UUID().uuidString).db"),
                                         flags: SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)
            defer { sqlite3_close(handle) }
            Fingerprint.register(on: handle, files: files)
            return try XCTUnwrap(try SQLite.integer("SELECT fingerprint(1, -2, 3.5, 'text', x'00ff', NULL, '')", on: handle))
        }
        XCTAssertEqual(try fingerprint(DeviceFiles(.plain)), -5115860939135311223)
        let keyedValue = try fingerprint(keyed)
        XCTAssertNotEqual(keyedValue, -5115860939135311223)
        XCTAssertEqual(try fingerprint(DeviceFiles(.keyed(ShippingFixture.macKey))), keyedValue, "the same key, the same fingerprint")
    }

    func testAStoreMemoryKeepsNoPlainMetaValueOrHashInTheKeyedForm() throws {
        let hash = DomainFixtures.sha256("synthetic attachment")
        let plainValues = ["inode 11 born 22", "declared digest", "1:2:3:4 floor 5", "the page did not seal"]
        for files in [DeviceFiles(.plain), keyed] {
            let file = root.appendingPathComponent("memory-\(files.keyed ? "keyed" : "plain")")
            let memory = StoreMemory(file: file, files: files)
            try memory.adopt(identity: plainValues[0], declared: plainValues[1])
            try memory.record(blobs: [hash], seal: 1)
            try memory.settle(stamp: plainValues[2], owed: 3)
            XCTAssertEqual(try DomainFixtures.read("SELECT value FROM meta WHERE name = 'stamp'", from: file), [[files.name(plainValues[2])]])
            XCTAssertTrue(try memory.refused(page: 9, reason: plainValues[3]))
            XCTAssertFalse(try memory.refused(page: 9, reason: plainValues[3]), "the same reason is said once")

            let meta = try DomainFixtures.read("SELECT name, value FROM meta ORDER BY name", from: file)
            XCTAssertEqual(meta, [["cold_due_at", "0"], ["declared", files.name(plainValues[1])], ["had_fast_pass", "0"],
                                  ["identity", files.name(plainValues[0])], ["owed", "3"], ["page_refused", files.name(plainValues[3])]],
                           "a refused page forgets the stamp and owes a cold pass")
            XCTAssertEqual(try DomainFixtures.read("SELECT hash FROM blobs", from: file), [[files.name(hash)]])
            if files.keyed {
                for value in plainValues + [hash] {
                    XCTAssertFalse(holds(try disk(file), value), "no plain \(value) in the keyed memory")
                }
            }
            XCTAssertEqual(try memory.unsent([hash]), [], "a hash once carried is found by its keyed name")
            let begun = try memory.begin(received: 5)
            XCTAssertNil(begun.stamp)
            XCTAssertEqual(begun.coldDueAt, 0)
            XCTAssertEqual(begun.owed, 3)
        }
    }
}
