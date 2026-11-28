import CryptoKit
import DeviceFiles
import Evidence
import Foundation
import HomeLink
import XCTest
@testable import Shipping

final class BiomeDomainTests: XCTestCase {
    private static let source = "screen-time:person-a@example.com:unit-0001"
    private static let mac = "0000AAAA-0000-4000-8000-000000000001"
    private static let phone = "0000BBBB-0000-4000-8000-000000000002"
    private static let at = "2026-09-23T04:00:00.000Z"

    private var root: URL!
    private var biome: URL!
    private var stream: URL!

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("biome-domain-tests")
        biome = root.appendingPathComponent("Library/Biome", isDirectory: true)
        stream = biome.appendingPathComponent("streams/restricted/App.InFocus", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var work: URL { root.appendingPathComponent("work", isDirectory: true) }

    private func domain() throws -> any ShippingDomain {
        try StoreFixtures.domain(Self.source, home: root, ledgers: ledgers, state: root.appendingPathComponent("state", isDirectory: true))
    }


    private static func segment(_ records: [Data], size: Int = 4096, crc: UInt32? = nil, written: [Double] = []) -> Data {
        var file = Data(count: size)
        file.replaceSubrange(0..<4, with: Data("SEGB".utf8))
        put(UInt32(records.count), into: &file, at: 4)
        var end = 0
        for (index, record) in records.enumerated() {
            let start = 32 + ((end + 3) & ~3)
            put(crc ?? CRC32.update(0, record), into: &file, at: start)
            put(10, into: &file, at: start + 4)
            file.replaceSubrange((start + 8)..<(start + 8 + record.count), with: record)
            end = start - 32 + 8 + record.count
            let entry = size - 16 * (index + 1)
            put(UInt32(end), into: &file, at: entry)
            put(1, into: &file, at: entry + 4)
            let time = (index < written.count ? written[index] : 0).bitPattern
            put(UInt32(truncatingIfNeeded: time), into: &file, at: entry + 8)
            put(UInt32(truncatingIfNeeded: time >> 32), into: &file, at: entry + 12)
        }
        return file
    }

    private static func put(_ value: UInt32, into data: inout Data, at offset: Int) {
        withUnsafeBytes(of: value.littleEndian) { data.replaceSubrange(offset..<(offset + 4), with: $0) }
    }

    private static func record(_ app: String) -> Data {
        Data([0x32, UInt8(app.utf8.count)]) + Data(app.utf8)
    }

    @discardableResult
    private func write(_ data: Data, at locator: String) throws -> URL {
        let file = stream.appendingPathComponent(locator)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: file)
        return file
    }

    private func syncDatabase(me: [String]) throws {
        let database = biome.appendingPathComponent("sync/sync.db")
        try FileManager.default.createDirectory(at: database.deletingLastPathComponent(), withIntermediateDirectories: true)
        try DomainFixtures.sqlite(database, [
            "CREATE TABLE DevicePeer (device_identifier STRING NOT NULL, me BOOLEAN, protocol_version INTEGER NOT NULL)",
            "INSERT INTO DevicePeer VALUES ('\(Self.phone)', 0, 5)",
        ] + me.map { "INSERT INTO DevicePeer VALUES ('\($0)', 1, 5)" })
    }

    private static let local = segment([record("com.example.mail"), record("com.example.chat")])
    private static let remote = segment([record("com.example.maps")])
    private static let tombstone = segment([record("tombstone")])

    private func buildStream() throws {
        try write(Self.local, at: "local/810000000000000")
        try write(Self.tombstone, at: "local/tombstone/810000050000000")
        try write(Self.remote, at: "remote/\(Self.phone)/809990000000000")
        try write(Self.tombstone, at: "remote/\(Self.phone)/tombstone/809990050000000")
        try write(Data(), at: "lock")
        try write(Data("not a segment".utf8), at: "local/notes.txt")
        try syncDatabase(me: [Self.mac])
    }

    private static func sha(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private var ledgers: Ledgers { Ledgers(root: root.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain)) }

    private func seal(alreadyShipped: Set<String> = [], mark: String? = nil, at spelling: String = at, start: Date? = nil) throws -> SealedBundle? {
        let custody = alreadyShipped.isEmpty && mark == nil ? ShippingFixture.first
            : try DomainFixtures.received(HashEntry(mark: mark, hashes: alreadyShipped.sorted()), source: Self.source, ledgers: ledgers)
        return try domain().sealOne(DomainFixtures.request(work: work, at: spelling, custody: custody, start: start))
    }

    private func engine(spacing: @escaping @Sendable () -> TimeInterval) throws -> BiomeEngine {
        let store = try StoreFixtures.declaration(of: Self.source).store
        guard case .biome(let stream) = store.engine else { throw StoreFixtures.StoreFixtureError.noMember(Self.source, "biome") }
        return try BiomeEngine(sourceId: Self.source, store: store, stream: stream, road: StoreFiles(home: root, lifestream: []),
                               ledgers: ledgers, spacing: spacing)
    }

    private func carried(_ sealed: SealedBundle) throws -> HashEntry {
        try DomainFixtures.entry(HashEntry.self, of: sealed, ledgers: ledgers)
    }


    func testBiomeIsNeverFlushedEvenWrappedAsADeclaredStore() throws {
        let engine = try domain()
        XCTAssertTrue(engine is BiomeEngine)
        XCTAssertFalse(Shipper.fast(engine))
        XCTAssertFalse(Shipper.fast(DeclaredDomain(engine, refuse: { _ in })), "the wrapper is seen through")
    }

    func testEverySegmentOfEveryDeviceShipsAtItsPlace() throws {
        try buildStream()
        let sealed = try XCTUnwrap(try seal())
        let zip = try StoredZipReader(sealed.file)
        let names = ["local/810000000000000.segb", "local/tombstone/810000050000000.segb",
                     "remote/\(Self.phone)/809990000000000.segb", "remote/\(Self.phone)/tombstone/809990050000000.segb"]
        XCTAssertEqual(zip.names, names + ["manifest.json"])
        XCTAssertEqual(zip.bytes("local/810000000000000.segb"), Self.local, "a segment ships raw")
        let listed = [(names[0], Self.local), (names[1], Self.tombstone), (names[2], Self.remote), (names[3], Self.tombstone)]
            .map { "{\"file\":\"\($0.0)\",\"sha256\":\"\(Self.sha($0.1))\",\"bytes\":4096}" }.joined(separator: ",")
        XCTAssertEqual(zip.text("manifest.json"),
            "{\"format\":\"org.lifestreamprotocol.acquisition/1\",\"source_id\":\"\(Self.source)\","
            + "\"feeder\":\"biome-app-in-focus\",\"fetched_at\":\"\(Self.at)\",\"complete\":true,"
            + "\"files\":[\(listed)],"
            + "\"facts\":{\"local_device\":\"\(Self.mac)\",\"segments\":4,\"unsettled\":0,"
            + "\"snapshot_taken_at\":\"\(Self.at)\",\"blobs_carried\":0},"
            + "\"custody\":{\"\(Self.source)\":{\"seal\":1}}}\n")
        XCTAssertEqual(try carried(sealed), HashEntry(mark: Self.at, hashes: Set([Self.local, Self.remote, Self.tombstone].map(Self.sha)).sorted()))
    }

    func testASegmentShipsWhenItsBytesChangedWhateverItsModificationTime() throws {
        try buildStream()
        let grown = Self.segment([Self.record("com.example.mail"), Self.record("com.example.chat"), Self.record("com.example.notes")])
        let file = try write(grown, at: "local/810000000000000")
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1_700_000_000)], ofItemAtPath: file.path)
        let touched = stream.appendingPathComponent("remote/\(Self.phone)/809990000000000")
        try FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: touched.path)

        let held = Set([Self.local, Self.remote, Self.tombstone].map(Self.sha))
        let sealed = try XCTUnwrap(try seal(alreadyShipped: held))
        let zip = try StoredZipReader(sealed.file)
        XCTAssertEqual(zip.names, ["local/810000000000000.segb", "manifest.json"])
        XCTAssertEqual(zip.bytes("local/810000000000000.segb"), grown)
        XCTAssertEqual(try carried(sealed).hashes, [Self.sha(grown)])
    }

    func testNothingNewSealsNoBundle() throws {
        try buildStream()
        XCTAssertNil(try seal(alreadyShipped: Set([Self.local, Self.remote, Self.tombstone].map(Self.sha))))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: work.path), [], "nothing new writes no bundle")
        XCTAssertEqual(DomainFixtures.workspaces(BiomeEngine.workPrefix), [], "no copy stays behind")
    }

    func testAtMostOneBundleEveryFiveMinutesOnPower() throws {
        try buildStream()
        XCTAssertNil(try seal(mark: "2026-09-23T03:55:01.000Z"))
        XCTAssertNotNil(try seal(mark: "2026-09-23T03:55:00.000Z"))
    }

    func testTheSpacingFollowsThePower() throws {
        XCTAssertEqual(BiomeEngine.acSpacing, 5 * 60)
        XCTAssertEqual(BiomeEngine.batterySpacing, 15 * 60)
        XCTAssertEqual(BiomeEngine.lowPowerSpacing, 30 * 60)
        XCTAssertEqual(BiomeEngine.spacing(onBattery: false, lowPower: false), 5 * 60)
        XCTAssertEqual(BiomeEngine.spacing(onBattery: true, lowPower: false), 15 * 60)
        XCTAssertEqual(BiomeEngine.spacing(onBattery: true, lowPower: true), 30 * 60)
        XCTAssertEqual(BiomeEngine.spacing(onBattery: false, lowPower: true), 30 * 60)
    }

    func testABundleWaitsOutTheSpacingThePowerSets() throws {
        try buildStream()
        let power = PowerNow()
        let domain = try engine { BiomeEngine.spacing(onBattery: power.onBattery, lowPower: power.lowPower) }
        let custody = try DomainFixtures.received(HashEntry(mark: "2026-09-23T03:50:00.000Z", hashes: []),
                                                  source: Self.source, ledgers: ledgers)
        let sealTenMinutesOn = { [work] () throws -> SealedBundle? in
            try domain.sealOne(DomainFixtures.request(work: work, at: Self.at, custody: custody))
        }
        power.onBattery = true
        XCTAssertNil(try sealTenMinutesOn(), "on battery, ten minutes is under the fifteen")
        power.lowPower = true
        XCTAssertNil(try sealTenMinutesOn(), "in Low Power Mode, ten minutes is under the thirty")
        power.onBattery = false
        power.lowPower = false
        XCTAssertNotNil(try sealTenMinutesOn(), "on power, ten minutes is past the five")
    }

    func testASegmentCaughtMidWriteStaysHomeAndIsCounted() throws {
        try buildStream()
        try write(Self.segment([Self.record("com.example.mail")], crc: 1), at: "local/810000000000000")
        let sealed = try XCTUnwrap(try seal())
        let zip = try StoredZipReader(sealed.file)
        XCTAssertFalse(zip.names.contains("local/810000000000000.segb"))
        let manifest = try XCTUnwrap(zip.text("manifest.json"))
        XCTAssertTrue(manifest.contains("\"segments\":3,\"unsettled\":1"), manifest)
    }

    func testALocalSegmentNeedsExactlyOneDeviceMarkedAsThisMac() throws {
        try buildStream()
        try FileManager.default.removeItem(at: biome.appendingPathComponent("sync"))
        try syncDatabase(me: [])
        XCTAssertThrowsError(try seal()) { error in
            XCTAssertEqual("\(error)", "Biome's sync database names 0 devices as this Mac, not one")
        }
        try FileManager.default.removeItem(at: biome.appendingPathComponent("sync"))
        XCTAssertThrowsError(try seal()) { error in
            XCTAssertTrue("\(error)".hasPrefix("Biome's sync database does not read"), "\(error)")
        }
    }

    func testSegmentsTheRolledBackSealCarriedShipAgain() throws {
        try buildStream()
        let first = try XCTUnwrap(try seal())
        XCTAssertEqual(first.sidecar.seal, 1)
        let next = SealCustody(pass: ShippingFixture.pass, received: 1, imported: 1)
        XCTAssertNil(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-23T05:00:00.000Z", custody: next)))
        let again = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-23T05:00:00.000Z")))
        XCTAssertEqual(try carried(again).hashes, try carried(first).hashes)
    }

    func testASegmentWrittenWhollyBeforeTheStartStaysHome() throws {
        let before = Self.segment([Self.record("com.example.mail")], written: [790_000_000])
        let crossing = Self.segment([Self.record("com.example.chat"), Self.record("com.example.maps")], written: [790_000_000, 810_000_000])
        try write(before, at: "local/790000000000000")
        try write(crossing, at: "local/800000000000000")
        try syncDatabase(me: [Self.mac])
        XCTAssertNil(try seal(start: Date(timeIntervalSinceReferenceDate: 815_000_000)), "a segment last written before the start was shipped")

        let sealed = try XCTUnwrap(try seal(start: Date(timeIntervalSinceReferenceDate: 800_000_000)))
        XCTAssertEqual(try StoredZipReader(sealed.file).names, ["local/800000000000000.segb", "manifest.json"])
        XCTAssertEqual(try carried(sealed).hashes, [Self.sha(crossing)])

        let widened = try XCTUnwrap(try seal(alreadyShipped: [Self.sha(crossing)], mark: "2026-09-23T03:00:00.000Z"))
        XCTAssertEqual(try StoredZipReader(widened.file).names, ["local/790000000000000.segb", "manifest.json"])
    }

    func testAReadCountsEverySegmentByTheMonthItWasModifiedEvenWithinTheSpacing() throws {
        try buildStream()
        for (locator, at) in [("local/810000000000000", "2026-09-22T00:00:00.000Z"), ("local/tombstone/810000050000000", "2026-09-01T00:00:00.000Z"),
                              ("remote/\(Self.phone)/809990000000000", "2026-08-31T23:59:59.000Z"),
                              ("remote/\(Self.phone)/tombstone/809990050000000", "2026-08-01T00:00:00.000Z")] {
            try FileManager.default.setAttributes([.modificationDate: try DomainFixtures.instant(at)],
                                                  ofItemAtPath: stream.appendingPathComponent(locator).path)
        }
        let months = ["2026-08": Through.Month(items: 2, bytes: 8192), "2026-09": Through.Month(items: 2, bytes: 8192)]
        let shipped = try DomainFixtures.received(HashEntry(mark: "2026-09-23T03:57:00.000Z",
                                                            hashes: Set([Self.local, Self.remote, Self.tombstone].map(Self.sha)).sorted()),
                                                  source: Self.source, ledgers: ledgers)
        let within = try DomainFixtures.instant("2026-09-23T03:57:00.000Z")
        XCTAssertEqual(try DomainFixtures.stated(domain(), DomainFixtures.request(work: work, custody: shipped, owesThrough: true)),
                       Through(readThrough: within, statedAt: try DomainFixtures.instant(Self.at), months: months),
                       "within the spacing it is read through its last read, every segment counted")
        let quiet = try DomainFixtures.instant("2026-09-23T04:30:00.000Z")
        XCTAssertEqual(try DomainFixtures.stated(domain(), DomainFixtures.request(work: work, at: "2026-09-23T04:30:00.000Z", custody: shipped,
                                                                                  owesThrough: true, start: quiet)),
                       Through(readThrough: quiet, statedAt: quiet, months: months),
                       "a read with nothing new is read through now, the segments below the start counted too")
        XCTAssertNil(try DomainFixtures.stated(domain(), DomainFixtures.request(work: work, at: "2026-09-23T04:30:00.000Z", custody: shipped)),
                     "none owed: none stated")
    }

    func testAStreamThisMacHasNeverWrittenShipsNothing() throws {
        XCTAssertNil(try seal())
    }
}

private final class PowerNow: @unchecked Sendable {
    private let lock = NSLock()
    private var battery = false
    private var low = false

    var onBattery: Bool {
        get { lock.withLock { battery } }
        set { lock.withLock { battery = newValue } }
    }

    var lowPower: Bool {
        get { lock.withLock { low } }
        set { lock.withLock { low = newValue } }
    }
}
