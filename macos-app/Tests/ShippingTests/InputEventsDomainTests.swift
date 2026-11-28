import Evidence
import DeviceFiles
import Foundation
import HomeLink
import XCTest
@testable import Shipping

final class InputEventsDomainTests: XCTestCase {
    private var root: URL!
    private var batches: URL!

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("input-events-domain-tests")
        batches = root.appendingPathComponent("input-events", isDirectory: true)
        try FileManager.default.createDirectory(at: batches, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var work: URL { root.appendingPathComponent("work", isDirectory: true) }
    private var ledgers: Ledgers { Ledgers(root: root.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain)) }

    private func carried(_ batches: [String]) throws -> SealCustody {
        try DomainFixtures.received(SpoolEntry(items: batches), source: Self.source, ledgers: ledgers)
    }
    private static let source = "input:local:unit-0001"
    private static let older = "20260821T223000.000Z.jsonl"
    private static let newer = "20260922T223000.000Z.jsonl"
    private static let olderLine = chunk("2026-08-21T22:30:00.000Z", "2026-08-21T22:31:00.000Z")
    private static let newerLines = chunk("2026-09-22T22:30:00.000Z", "2026-09-22T22:31:00.000Z") + "\n"
        + chunk("2026-09-22T22:31:00.000Z", "2026-09-22T22:32:00.000Z") + "\n"

    private static func chunk(_ at: String, _ until: String) -> String {
        "{\"at\":\"\(at)\",\"until\":\"\(until)\",\"layout\":\"com.apple.keylayout.US\","
            + "\"apps\":[\"com.example.editor\"],\"events\":[{\"t\":5,\"e\":\"activate\",\"app\":0,\"pid\":501}]}"
    }

    private func domain(now: String = "2026-09-23T04:30:00.000Z") throws -> InputEventsDomain {
        let date = try DomainFixtures.instant(now)
        return InputEventsDomain(sourceId: Self.source, batchRoot: batches, ledgers: ledgers, clock: { date })
    }

    private func buildBatches() throws {
        try DomainFixtures.write(Self.olderLine + "\n", to: batches.appendingPathComponent(Self.older))
        try DomainFixtures.write(Self.newerLines, to: batches.appendingPathComponent(Self.newer))
        try DomainFixtures.write(Self.chunk("2026-09-23T03:58:00.000Z", "2026-09-23T03:59:00.000Z") + "\n",
                                 to: batches.appendingPathComponent("current.jsonl"))
        try DomainFixtures.write("{\"t\":1,\"e\":\"move\",\"x\":1,\"y\":1,\"app\":0}\n",
                                 to: batches.appendingPathComponent("current.chunk"))
        try DomainFixtures.write("{\"at\":", to: batches.appendingPathComponent("current.jsonl.torn-20260923T000000.000Z"))
    }

    private func spool() throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: batches.path).sorted()
    }

    func testTheManifestIsTheBytesTheHomeReads() throws {
        try buildBatches()
        let request = try DomainFixtures.request(work: work, at: "2026-09-23T04:30:00.250Z", custody: carried([Self.older]))
        let sealed = try XCTUnwrap(try domain().sealOne(request))
        let zip = try StoredZipReader(sealed.file)
        XCTAssertEqual(zip.names, [Self.newer, "manifest.json"])

        let sha = DomainFixtures.sha256(Self.newerLines)
        let bytes = Data(Self.newerLines.utf8).count
        XCTAssertEqual(bytes, 370)
        XCTAssertEqual(sha, "1a86760f8eb6300a62eef4009003fd1ba6bdf3784edb212aa266b770b2559cde",
                       "the batch's bytes")
        XCTAssertEqual(zip.text("manifest.json"),
            "{\"format\":\"org.lifestreamprotocol.acquisition/1\",\"source_id\":\"input:local:unit-0001\","
            + "\"feeder\":\"input-events\",\"fetched_at\":\"2026-09-23T04:30:00.250Z\",\"complete\":true,"
            + "\"files\":[{\"file\":\"\(Self.newer)\",\"sha256\":\"\(sha)\",\"bytes\":\(bytes)}],"
            + "\"facts\":{\"batches\":1,\"chunks\":2,\"newest_chunk_at\":\"2026-09-22T22:31:00.000Z\","
            + "\"snapshot_taken_at\":\"2026-09-23T04:30:00.250Z\",\"blobs_carried\":0},"
            + "\"custody\":{\"input:local:unit-0001\":{\"seal\":2}}}\n")
        XCTAssertEqual(zip.text(Self.newer), Self.newerLines)
    }

    func testEveryBatchTravelsWhenNothingHasShipped() throws {
        try buildBatches()
        try DomainFixtures.write("not a batch", to: batches.appendingPathComponent("notes.txt"))
        let sealed = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work)))
        XCTAssertEqual(try StoredZipReader(sealed.file).names, [Self.older, Self.newer, "manifest.json"])
        XCTAssertEqual(try DomainFixtures.entry(SpoolEntry.self, of: sealed, ledgers: ledgers).items, [Self.older, Self.newer])
        let manifest = try XCTUnwrap(try StoredZipReader(sealed.file).text("manifest.json"))
        XCTAssertTrue(manifest.contains("\"batches\":2,\"chunks\":3,\"newest_chunk_at\":\"2026-09-22T22:31:00.000Z\""),
                      manifest)
    }

    func testABatchNamedBehindTheNewestShippedStillShips() throws {
        try buildBatches()
        let late = "20260922T222000.000Z.jsonl"
        try DomainFixtures.write(Self.chunk("2026-09-22T22:20:00.000Z", "2026-09-22T22:21:00.000Z") + "\n",
                                 to: batches.appendingPathComponent(late))
        let sealed = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, custody: carried([Self.older, Self.newer]))))
        XCTAssertEqual(try StoredZipReader(sealed.file).names, [late, "manifest.json"])
    }

    func testNothingNoSealCarriedSealsNoBundle() throws {
        try buildBatches()
        XCTAssertNil(try domain().sealOne(DomainFixtures.request(work: work, custody: carried([Self.older, Self.newer]))))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: work.path), [],
                       "nothing new writes no bundle")
    }

    func testAQuietLogStatesItsReadThroughToTheLastClosedMinute() throws {
        try buildBatches()
        let domain = try domain()
        XCTAssertEqual(try DomainFixtures.stated(domain, DomainFixtures.request(work: work, at: "2026-09-23T04:30:00.250Z",
                                                                                custody: carried([Self.older, Self.newer]),
                                                                                owesThrough: true)),
                       Through(readThrough: try DomainFixtures.instant("2026-09-23T04:29:00.000Z"),
                               statedAt: try DomainFixtures.instant("2026-09-23T04:30:00.250Z")))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: work.path), [], "nothing written")
        XCTAssertNil(try DomainFixtures.stated(domain, DomainFixtures.request(work: work, at: "2026-09-23T04:31:00.250Z",
                                                                              custody: carried([Self.older, Self.newer]))),
                     "none owed: none stated")
        XCTAssertEqual(InputEventsDomain.readThrough(fetchedAt: try DomainFixtures.instant("2026-09-23T04:30:00.999Z")),
                       try DomainFixtures.instant("2026-09-23T04:29:00.000Z"), "the minute still open stays out")
        XCTAssertEqual(InputEventsDomain.readThrough(fetchedAt: try DomainFixtures.instant("2026-09-23T04:30:01.000Z")),
                       try DomainFixtures.instant("2026-09-23T04:30:00.000Z"))
    }

    func testALineThatIsNotAChunkWithAnInstantRefuses() throws {
        try DomainFixtures.write("{\"until\":\"2026-09-22T22:31:00.000Z\"}\n",
                                 to: batches.appendingPathComponent(Self.newer))
        XCTAssertThrowsError(try domain().sealOne(DomainFixtures.request(work: work))) { error in
            XCTAssertEqual("\(error)", "the batch \(Self.newer) states a line that is not a chunk with an instant")
        }
    }

    func testABatchRootThatIsNotThereRefuses() throws {
        try FileManager.default.removeItem(at: batches)
        XCTAssertThrowsError(try domain().sealOne(DomainFixtures.request(work: work))) { error in
            XCTAssertEqual("\(error)", "\(batches.path) is not a directory of input event batches")
        }
    }

    func testAnImportedBatchIsDeletedOnlyOnceItIsSevenDaysOld() async throws {
        try buildBatches()
        _ = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work)))

        try domain().applied(try await DomainFixtures.fresh(Self.source, received: 1, imported: 1, folder: root))
        XCTAssertEqual(try spool().filter { $0.hasPrefix("2026") }, [Self.newer],
                       "the batch that opened 33 days ago leaves; the newer one stays")

        try domain(now: "2026-09-29T22:00:00.000Z").applied(try await DomainFixtures.fresh(Self.source, received: 1, imported: 1, folder: root))
        XCTAssertEqual(try spool().filter { $0.hasPrefix("2026") }, [Self.newer], "an imported batch under seven days old stays")

        try domain(now: "2026-09-29T23:00:00.000Z").applied(try await DomainFixtures.fresh(Self.source, received: 1, imported: 1, folder: root))
        XCTAssertEqual(try spool().filter { $0.hasPrefix("2026") }, [], "seven days after it opened, not thirty, it leaves")
        XCTAssertEqual(try spool(), ["current.chunk", "current.jsonl", "current.jsonl.torn-20260923T000000.000Z"],
                       "the open batch, the open minute and a torn batch are never deleted")
    }

    func testABatchNoImportedSealCarriedStays() async throws {
        try buildBatches()
        _ = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work)))
        try domain(now: "2027-01-01T00:00:00.000Z").applied(try await DomainFixtures.fresh(Self.source, received: 1, imported: 0, folder: root))
        XCTAssertEqual(try spool().filter { $0.hasPrefix("2026") }, [Self.older, Self.newer])
    }

    func testABatchNoSealCarriedIsNeverDeleted() async throws {
        try buildBatches()
        _ = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, custody: carried([Self.newer]))))
        let late = "20260801T000000.000Z.jsonl"
        try DomainFixtures.write(Self.chunk("2026-08-01T00:00:00.000Z", "2026-08-01T00:01:00.000Z") + "\n",
                                 to: batches.appendingPathComponent(late))
        try domain(now: "2027-01-01T00:00:00.000Z").applied(try await DomainFixtures.fresh(Self.source, received: 2, imported: 2, folder: root))
        XCTAssertEqual(try spool().filter { $0.hasPrefix("2026") }, [late], "only what an imported seal carried left")
    }

    func testASealSealedAgainReplacesWhatTheRefusedOneCarried() async throws {
        try buildBatches()
        _ = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, custody: carried([Self.newer]))))
        try FileManager.default.removeItem(at: batches.appendingPathComponent(Self.newer))
        _ = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-24T04:30:00.000Z",
                                                                   custody: SealCustody(pass: ShippingFixture.pass, received: 1, imported: 0))))
        XCTAssertEqual(try ledgers.ledger(SpoolEntry.self, pass: ShippingFixture.pass, source: Self.source).read()[2]?.items, [Self.older])
        try domain(now: "2027-01-01T00:00:00.000Z").applied(try await DomainFixtures.fresh(Self.source, received: 2, imported: 2, folder: root))
        XCTAssertEqual(try spool().filter { $0.hasPrefix("2026") }, [])
    }

    func testABatchNameStatesTheInstantItOpened() throws {
        XCTAssertEqual(SpoolCustody.batchOpenedAt("20260923T092554.736Z.jsonl"),
                       try DomainFixtures.instant("2026-09-23T09:25:54.736Z"))
        XCTAssertEqual(SpoolCustody.batchOpenedAt("20260923T092554.736Z-2.jsonl"),
                       try DomainFixtures.instant("2026-09-23T09:25:54.736Z"))
        XCTAssertNil(SpoolCustody.batchOpenedAt("notes.jsonl"))
        XCTAssertNil(SpoolCustody.batchOpenedAt("20261399T092554.736Z.jsonl"))
    }

    func testTheDomainIsBuiltForAnInputSourceAndShipsSealedBatchesEveryInterval() throws {
        let paths = ShippingDomains.Paths(home: root, machineEventsRoot: root, inputEventsRoot: batches, audioRoot: root,
                                          hashCacheDirectory: root, ledgers: ledgers, sessionDirectory: root, importRoom: .roomy(root))
        let built = ShippingDomains.build([Self.source], paths: paths, stores: try StoreFixtures.none(root.appendingPathComponent("stores")))
        let domain = try XCTUnwrap(built.first as? InputEventsDomain)
        XCTAssertEqual(domain.batchRoot, batches)
        XCTAssertEqual(domain.ledgers.root, ledgers.root)
        XCTAssertEqual(domain.name, "input_events")
    }
}
