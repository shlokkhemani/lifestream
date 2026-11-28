import Evidence
import DeviceFiles
import Foundation
import HomeLink
import XCTest
@testable import Shipping

final class AquaVoiceDomainTests: XCTestCase {
    static let source = "aqua-voice:100001:unit-0001"
    private var root: URL!

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("aqua-voice-domain-tests")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var folder: URL { root.appendingPathComponent("Library/Application Support/Aqua Voice", isDirectory: true) }
    private var work: URL { root.appendingPathComponent("work", isDirectory: true) }
    private func domain() throws -> any ShippingDomain {
        try StoreFixtures.domain(Self.source, home: root, ledgers: ledgers, state: root.appendingPathComponent("state", isDirectory: true))
    }

    private var ledgers: Ledgers { Ledgers(root: root.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain)) }

    private func carried(_ sealed: SealedBundle) throws -> HashEntry {
        try DomainFixtures.entry(HashEntry.self, of: sealed, ledgers: ledgers)
    }

    private func following(_ seal: Int) -> SealCustody {
        SealCustody(pass: ShippingFixture.pass, received: seal, imported: 0)
    }

    private static func entry(_ session: Int, _ file: String) -> String {
        "{\"kind\":\"transcription\",\"source\":\"local\",\"timestamp\":\"2026-09-20T08:00:0\(session % 10).000Z\","
            + "\"content\":\"Synthetic \(session).\",\"rawText\":\"synthetic \(session)\",\"sessionId\":\(session),"
            + "\"audioFilePath\":\"\(file)\",\"audioDurationSeconds\":1.5}"
    }

    private func history(_ mine: [String] = [entry(190000002, "audio/AQ_2.wav"), entry(190000001, "audio/AQ_1.wav")]) -> String {
        "{\"version\":1,\"historyByUserId\":{\"100001\":[\(mine.joined(separator: ","))],"
            + "\"100002\":[\(Self.entry(290000001, "audio/AQ_9.wav"))]},\"historySyncCursorByUserId\":{}}"
    }

    @discardableResult
    private func build(_ text: String? = nil, recordings: [String] = ["AQ_1", "AQ_2", "AQ_9"]) throws -> String {
        let text = text ?? history()
        try DomainFixtures.write(text, to: folder.appendingPathComponent("history.json"))
        for name in recordings { try DomainFixtures.write("synthetic wav \(name)", to: folder.appendingPathComponent("audio/\(name).wav")) }
        return text
    }

    func testTheBundleHoldsTheFileTheIndexAndTheAccountsRecordings() throws {
        let text = try build()
        let sealed = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work)))
        let zip = try StoredZipReader(sealed.file)
        let one = DomainFixtures.sha256("synthetic wav AQ_1")
        let two = DomainFixtures.sha256("synthetic wav AQ_2")
        XCTAssertEqual(zip.names, ["history.json", "audio.json"] + [one, two].sorted().map { "blobs/\($0)" } + ["manifest.json"])
        XCTAssertEqual(zip.text("history.json"), text, "the file travels as Aqua wrote it")
        XCTAssertEqual(zip.text("audio.json"), "{\"format\":\"org.lifestreamprotocol.blob-index/1\",\"entries\":{"
            + "\"audio/AQ_1.wav\":{\"sha256\":\"\(one)\",\"bytes\":18},\"audio/AQ_2.wav\":{\"sha256\":\"\(two)\",\"bytes\":18}}}\n")
        XCTAssertEqual(Set(try carried(sealed).hashes), [one, two])
        XCTAssertEqual(sealed.sidecar.id, "\(Self.source)/20260923T040000.000Z")
        XCTAssertNotNil(try carried(sealed).mark, "the seal names the file and index it read")
        let manifest = try XCTUnwrap(zip.text("manifest.json"))
        XCTAssertTrue(manifest.contains("\"feeder\":\"aqua-voice-mac\""), manifest)
        XCTAssertTrue(manifest.contains("\"snapshot_taken_at\":\"2026-09-23T04:00:00.000Z\""), manifest)
    }

    func testALargeRecordingIsStagedBeforeItsBundleAndTheBundleNamesItOnceReady() throws {
        let large = String(repeating: "synthetic wav bytes ", count: 14_000)
        try build(recordings: ["AQ_2", "AQ_9"])
        try DomainFixtures.write(large, to: folder.appendingPathComponent("audio/AQ_1.wav"))
        let hash = DomainFixtures.sha256(large), small = DomainFixtures.sha256("synthetic wav AQ_2")
        let board = StagingBoard()
        let domain = try domain()
        let request = { try DomainFixtures.request(work: self.work, owesThrough: true, staged: board.staged) }

        XCTAssertEqual(try domain.seal(request()), [], "a large recording not yet at the door holds the seal back")
        XCTAssertEqual(board.enqueued, [StagingBoard.Enqueued(sha256: hash, bytes: Int64(large.utf8.count), kept: false, kind: .new)],
                       "another app's file is staged as it lies")
        XCTAssertNil(domain.through, "work waits: no read-through is stated")
        XCTAssertFalse(FileManager.default.fileExists(atPath: ledgers.file(pass: ShippingFixture.pass, source: Self.source).path))

        board.ready(hash)
        let sealed = try XCTUnwrap(try domain.sealOne(request()))
        let zip = try StoredZipReader(sealed.file)
        XCTAssertEqual(zip.names, ["history.json", "audio.json", "blobs/\(small)", "manifest.json"], "the staged recording is not carried")
        XCTAssertTrue(try XCTUnwrap(zip.text("manifest.json")).contains("\"staged_blobs\":[\"sha256:\(hash)\"]"))
        XCTAssertEqual(sealed.sidecar.stagedBlobs, [hash])
        XCTAssertEqual(Set(try carried(sealed).hashes), [hash, small])
    }

    func testAnUnchangedFileSealsNothingAndStatesItsReadThrough() throws {
        try build()
        let first = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work)))
        let mark = try carried(first).mark
        XCTAssertNil(try DomainFixtures.stated(domain(), DomainFixtures.request(work: work, at: "2026-09-23T04:05:00.000Z",
                                                                                custody: following(1))), "none owed: none stated")
        let quiet = try DomainFixtures.instant("2026-09-23T04:10:00.000Z")
        XCTAssertEqual(try DomainFixtures.stated(domain(), DomainFixtures.request(work: work, at: "2026-09-23T04:10:00.000Z",
                                                                                  custody: following(1), owesThrough: true))?.readThrough, quiet)

        try build(history([Self.entry(190000003, "audio/AQ_3.wav"), Self.entry(190000002, "audio/AQ_2.wav")]), recordings: ["AQ_3"])
        let next = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-23T13:00:00.000Z", custody: following(1))))
        XCTAssertNotEqual(try carried(next).mark, mark)
        XCTAssertEqual(next.sidecar.seal, 2)
    }

    func testARecordingWrittenLaterShipsAtTheNextInterval() throws {
        try build(recordings: ["AQ_1"])
        let first = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work)))
        XCTAssertEqual(try carried(first).hashes, [DomainFixtures.sha256("synthetic wav AQ_1")])
        try build(recordings: ["AQ_2"])
        let second = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-23T04:05:00.000Z", custody: following(1))))
        XCTAssertEqual(try carried(second).hashes, [DomainFixtures.sha256("synthetic wav AQ_2")])
    }

    func testAFileModifiedBeforeTheStartStaysHomeUntilTheStartMovesEarlier() throws {
        let text = try build()
        let written = { (name: String, at: String) in
            try FileManager.default.setAttributes([.modificationDate: try DomainFixtures.instant(at)],
                                                  ofItemAtPath: self.folder.appendingPathComponent(name).path)
        }
        try written("history.json", "2026-09-22T00:00:00.000Z")
        for name in ["audio/AQ_1.wav", "audio/AQ_9.wav"] { try written(name, "2026-08-01T00:00:00.000Z") }
        try written("audio/AQ_2.wav", "2026-09-21T00:00:00.000Z")

        let later = try DomainFixtures.instant("2026-09-23T00:00:00.000Z")
        XCTAssertNil(try domain().sealOne(DomainFixtures.request(work: work, start: later)), "a file modified before the start was shipped")
        let quiet = try DomainFixtures.instant("2026-09-23T04:00:00.000Z")
        let months = ["2026-08": Through.Month(items: 1, bytes: 18), "2026-09": Through.Month(items: 2, bytes: Int64(text.utf8.count) + 18)]
        XCTAssertEqual(try DomainFixtures.stated(domain(), DomainFixtures.request(work: work, owesThrough: true, start: later)),
                       Through(readThrough: quiet, statedAt: quiet, months: months),
                       "nothing to ship still states its read-through, the file and the account's recordings counted by the month they "
                           + "were modified, below the start too, another account's not at all")

        let start = try DomainFixtures.instant("2026-09-01T00:00:00.000Z")
        let first = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, start: start)))
        let two = DomainFixtures.sha256("synthetic wav AQ_2")
        XCTAssertEqual(try StoredZipReader(first.file).names, ["history.json", "audio.json", "blobs/\(two)", "manifest.json"])
        XCTAssertEqual(try StoredZipReader(first.file).text("audio.json"), "{\"format\":\"org.lifestreamprotocol.blob-index/1\",\"entries\":{"
            + "\"audio/AQ_2.wav\":{\"sha256\":\"\(two)\",\"bytes\":18}}}\n", "a recording modified before the start was named")

        let widened = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, at: "2026-09-23T04:05:00.000Z",
                                                                                custody: following(1))),
                                    "a start moved earlier waited for the file to change")
        XCTAssertEqual(try carried(widened).hashes, [DomainFixtures.sha256("synthetic wav AQ_1")], "the recording the start left out")
    }

    func testARecordingTheHomeHoldsStaysHome() throws {
        try build()
        let held: Set<String> = [DomainFixtures.sha256("synthetic wav AQ_1"), DomainFixtures.sha256("synthetic wav AQ_2")]
        let custody = try DomainFixtures.received(HashEntry(mark: "another file", hashes: held.sorted()), source: Self.source, ledgers: ledgers)
        let sealed = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work, custody: custody)))
        XCTAssertEqual(try StoredZipReader(sealed.file).names, ["history.json", "audio.json", "manifest.json"])
        XCTAssertEqual(try carried(sealed).hashes, [])
    }

    func testATornOrMissingFileRefusesTheSeal() throws {
        XCTAssertThrowsError(try domain().sealOne(DomainFixtures.request(work: work)))
        try build(String(history().prefix(40)))
        XCTAssertThrowsError(try domain().sealOne(DomainFixtures.request(work: work)))
        try build("{\"version\":2,\"historyByUserId\":{}}")
        XCTAssertThrowsError(try domain().sealOne(DomainFixtures.request(work: work)))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: work.path), [])
    }

    func testAPathOutsideTheFolderHoldsNoBytes() throws {
        try DomainFixtures.write("outside", to: root.appendingPathComponent("outside.wav"))
        try build(history([Self.entry(190000001, "../outside.wav"), Self.entry(190000002, root.appendingPathComponent("outside.wav").path)]), recordings: [])
        let sealed = try XCTUnwrap(try domain().sealOne(DomainFixtures.request(work: work)))
        XCTAssertEqual(try StoredZipReader(sealed.file).text("audio.json"), "{\"format\":\"org.lifestreamprotocol.blob-index/1\",\"entries\":{}}\n")
        XCTAssertEqual(try carried(sealed).hashes, [])
    }

    func testTheDomainShipsForTheAccountItsSourceNames() throws {
        try build(history(), recordings: [])
        XCTAssertEqual(try domain().name, "aqua_voice")
        let declaration = try StoreFixtures.declaration("aqua-voice")
        XCTAssertEqual(StoreAccounts.read(declaration.store, road: StoreFiles(home: root, lifestream: [])).map(\.account), ["100001", "100002"],
                       "each account the file holds is offered to the home")
    }
}
