import Evidence
import DeviceFiles
import XCTest
@testable import Shipping

final class BundleWriterTests: XCTestCase {
    private var root: URL!

    static let sourceId = "machine:local:unit-0001"
    static let feeder = "machine-events"
    static let fetchedAt = "2026-09-23T04:30:00.250Z"
    static let listedName = "20260922T223000.000Z.jsonl"
    static let listedBytes = "{\"at\":\"2026-09-22T22:30:00.000Z\",\"event\":\"state\",\"detail\":{}}\n"
    private static let listedHash = "3408268f673b2c53c2ea6a48463d3b5326d413e1025f574f2a4e5387e73a8e3f"
    static let blobBytes = "blob bytes\n"
    static let blobHash = "692cce5da89bc0d3ccb6b0c4db40af2bb7123ea47960053eba4c25f038a9db99"
    private static let bundleId = "machine:local:unit-0001/20260923T043000.250Z"
    private static let bundleFile = "machine_local_unit-0001__20260923T043000.250Z.zip"

    static let bundleHex =
        "504b03042d000008000000000000aed92e1affffffffffffffff1a0014003230323630393232543232333030302e3030" +
        "305a2e6a736f6e6c010010003e000000000000003e000000000000007b226174223a22323032362d30392d3232543232" +
        "3a33303a30302e3030305a222c226576656e74223a227374617465222c2264657461696c223a7b7d7d0a504b03042d00" +
        "0008000000000000007b3589ffffffffffffffff46001400626c6f62732f363932636365356461383962633064336363" +
        "623662306334646234306166326262373132336561343739363030353365626134633235663033386139646239390100" +
        "10000b000000000000000b00000000000000626c6f622062797465730a504b030414000008000000000000893866ebb5" +
        "010000b50100000d0000006d616e69666573742e6a736f6e7b22666f726d6174223a226f72672e6c6966657374726561" +
        "6d70726f746f636f6c2e6163717569736974696f6e2f31222c22736f757263655f6964223a226d616368696e653a6c6f" +
        "63616c3a756e69742d30303031222c22666565646572223a226d616368696e652d6576656e7473222c22666574636865" +
        "645f6174223a22323032362d30392d32335430343a33303a30302e3235305a222c22636f6d706c657465223a74727565" +
        "2c2266696c6573223a5b7b2266696c65223a223230323630393232543232333030302e3030305a2e6a736f6e6c222c22" +
        "736861323536223a22333430383236386636373362326335336332656136613438343633643362353332366434313365" +
        "31303235663537346632613465353338376537336138653366222c226279746573223a36327d5d2c226661637473223a" +
        "7b2262617463686573223a312c226e65776573745f6576656e745f6174223a22323032362d30392d32325432323a3330" +
        "3a30302e3030305a222c22736e617073686f745f74616b656e5f6174223a22323032362d30392d32335430343a33303a" +
        "30302e3235305a222c22626c6f62735f63617272696564223a317d7d0a504b0102140014000008000000000000aed92e" +
        "1a3e0000003e0000001a00000000000000000000000000000000003230323630393232543232333030302e3030305a2e" +
        "6a736f6e6c504b0102140014000008000000000000007b35890b0000000b00000046000000000000000000000000008a" +
        "000000626c6f62732f363932636365356461383962633064336363623662306334646234306166326262373132336561" +
        "34373936303035336562613463323566303338613964623939504b0102140014000008000000000000893866ebb50100" +
        "00b50100000d000000000000000000000000000d0100006d616e69666573742e6a736f6e504b05060000000003000300" +
        "f7000000ed0200000000"

    override func setUpWithError() throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("bundle-writer-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func writeFixtureBundle() throws -> BundleWriter.Written {
        let listed = root.appendingPathComponent("listed.jsonl")
        try Data(Self.listedBytes.utf8).write(to: listed)
        let blob = root.appendingPathComponent("blob.bin")
        try Data(Self.blobBytes.utf8).write(to: blob)
        let out = root.appendingPathComponent("out", isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        return try BundleWriter.write(
            into: out, sourceId: Self.sourceId, feeder: Self.feeder,
            fetchedAt: ShippingFixture.instant(Self.fetchedAt),
            files: [BundleWriter.File(name: Self.listedName, content: .file(listed))],
            blobs: [BundleWriter.Blob(sha256: Self.blobHash, file: blob)],
            facts: [("batches", .int(1)),
                    ("newest_event_at", .string("2026-09-22T22:30:00.000Z")),
                    ("snapshot_taken_at", .string(Self.fetchedAt))],
            custody: nil, through: DeviceFiles(.plain))
    }


    func testTheIdAndTheFileNameAreTheOnesTheHomeStates() throws {
        let written = try writeFixtureBundle()
        XCTAssertEqual(written.id, Self.bundleId)
        XCTAssertEqual(written.sourceId, Self.sourceId)
        XCTAssertEqual(written.file.lastPathComponent, Self.bundleFile)
        XCTAssertEqual(written.carried, [Self.blobHash])
        XCTAssertEqual(written.files, [ZipWriter.Member(name: Self.listedName,
                                                       bytes: Self.listedBytes.utf8.count,
                                                       sha256: Self.listedHash)])
    }


    func testTheMemberOrderIsTheFilesThenTheBlobsThenTheManifest() throws {
        let written = try writeFixtureBundle()
        let probe = try ZipArchiveProbe(try Data(contentsOf: written.file))
        XCTAssertEqual(probe.members.map(\.name),
                       [Self.listedName, "blobs/\(Self.blobHash)", BundleWriter.manifestFile])
        XCTAssertEqual(probe.bytes(Self.listedName), Data(Self.listedBytes.utf8))
        XCTAssertEqual(probe.bytes("blobs/\(Self.blobHash)"), Data(Self.blobBytes.utf8))
    }

    func testTheManifestIsTheSameBytesAsTheOneInsideTheTypeScriptArchive() throws {
        let written = try writeFixtureBundle()
        let mine = try ZipArchiveProbe(try Data(contentsOf: written.file))
        let theirs = try ZipArchiveProbe(ZipArchiveProbe.data(hex: Self.bundleHex))
        XCTAssertEqual(mine.bytes(BundleWriter.manifestFile), theirs.bytes(BundleWriter.manifestFile))

        let text = String(decoding: mine.bytes(BundleWriter.manifestFile)!, as: UTF8.self)
        XCTAssertEqual(text,
                       "{\"format\":\"org.lifestreamprotocol.acquisition/1\"," +
                       "\"source_id\":\"machine:local:unit-0001\",\"feeder\":\"machine-events\"," +
                       "\"fetched_at\":\"2026-09-23T04:30:00.250Z\",\"complete\":true," +
                       "\"files\":[{\"file\":\"\(Self.listedName)\",\"sha256\":\"\(Self.listedHash)\"," +
                       "\"bytes\":62}],\"facts\":{\"batches\":1," +
                       "\"newest_event_at\":\"2026-09-22T22:30:00.000Z\"," +
                       "\"snapshot_taken_at\":\"2026-09-23T04:30:00.250Z\",\"blobs_carried\":1}}\n")
    }

    func testEveryMembersBytesMatchTheTypeScriptArchive() throws {
        let written = try writeFixtureBundle()
        let mine = try ZipArchiveProbe(try Data(contentsOf: written.file))
        let theirs = try ZipArchiveProbe(ZipArchiveProbe.data(hex: Self.bundleHex))
        XCTAssertEqual(mine.members.map(\.name), theirs.members.map(\.name))
        XCTAssertEqual(mine.members.map(\.bytes), theirs.members.map(\.bytes))
        XCTAssertEqual(mine.members.map(\.localVersion), theirs.members.map(\.localVersion),
                       "a streamed member reserves the ZIP64 extra, bytes in hand do not")
    }

    func testTheWholeArchiveIsTheTypeScriptWritersBytes() throws {
        let written = try writeFixtureBundle()
        XCTAssertEqual(try Data(contentsOf: written.file), ZipArchiveProbe.data(hex: Self.bundleHex))
    }

    func testCustodyFollowsTheFactsWithTheSealAndWhatWasLost() throws {
        let out = root.appendingPathComponent("custody", isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        func manifest(_ lost: [Lost]) throws -> String {
            let written = try BundleWriter.write(
                into: out, sourceId: Self.sourceId, feeder: Self.feeder, fetchedAt: ShippingFixture.instant(Self.fetchedAt),
                files: [], facts: [], custody: (SealCustody(pass: ShippingFixture.pass, received: 6, imported: 4), lost), through: DeviceFiles(.plain))
            return String(decoding: try ZipArchiveProbe(try Data(contentsOf: written.file)).bytes(BundleWriter.manifestFile)!, as: UTF8.self)
        }
        XCTAssertTrue(try manifest([]).hasSuffix("\"facts\":{\"blobs_carried\":0},\"custody\":{\"machine:local:unit-0001\":{\"seal\":7}}}\n"))
        XCTAssertTrue(try manifest([Lost(items: 3, what: "input batches this Mac deleted after an earlier import")]).hasSuffix(
            "\"custody\":{\"machine:local:unit-0001\":{\"seal\":7,\"lost\":[{\"items\":3,"
                + "\"what\":\"input batches this Mac deleted after an earlier import\"}]}}}\n"))
    }


    func testTheHomeIsAskedOnceOfEveryNamedFileAndAHeldFileIsNeverLost() throws {
        let out = root.appendingPathComponent("held", isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        func file(_ text: String) throws -> (hash: String, url: URL) {
            let url = root.appendingPathComponent("\(text).bin")
            try Data(text.utf8).write(to: url)
            return (try FileChunks.measure(url).sha256, url)
        }
        let carried = try file("synthetic carried"), heldHere = try file("synthetic held here")
        let listed = try file("synthetic recording")
        let heldGone = String(repeating: "c", count: 64), gone = String(repeating: "d", count: 64)
        let asked = Collected<Set<String>>()
        let written = try BundleWriter.write(
            into: out, sourceId: Self.sourceId, feeder: Self.feeder, fetchedAt: ShippingFixture.instant(Self.fetchedAt),
            files: [BundleWriter.File(name: "recording.m4a", content: .file(listed.url))],
            blobs: [BundleWriter.Blob(sha256: carried.hash, file: carried.url),
                    BundleWriter.Blob(sha256: heldHere.hash, file: heldHere.url),
                    BundleWriter.Blob(sha256: heldGone, file: nil),
                    BundleWriter.Blob(sha256: gone, file: nil),
                    BundleWriter.Blob(sha256: carried.hash, file: carried.url)],
            held: { hexes in
                asked.append(hexes)
                return [heldHere.hash, heldGone, listed.hash]
            },
            facts: [], custody: (ShippingFixture.first, [Lost(items: 2, what: "synthetic rows this Mac deleted")]), through: DeviceFiles(.plain))
        XCTAssertEqual(asked.all, [[carried.hash, heldHere.hash, heldGone, gone]], "one ask, of every named file and no listed one")
        XCTAssertEqual(written.carried, [carried.hash])
        XCTAssertEqual(written.held, [heldHere.hash, heldGone].sorted(), "an answer beyond what was asked is not believed")
        XCTAssertEqual(written.named, [carried.hash, heldHere.hash, heldGone].sorted())
        let probe = try ZipArchiveProbe(try Data(contentsOf: written.file))
        XCTAssertEqual(probe.members.map(\.name), ["recording.m4a", "blobs/\(carried.hash)", BundleWriter.manifestFile],
                       "the listed file is carried whatever the home holds")
        let manifest = String(decoding: try XCTUnwrap(probe.bytes(BundleWriter.manifestFile)), as: UTF8.self)
        XCTAssertTrue(manifest.hasSuffix("\"blobs_carried\":1},\"custody\":{\"machine:local:unit-0001\":{\"seal\":1,\"lost\":["
            + "{\"items\":2,\"what\":\"synthetic rows this Mac deleted\"},{\"items\":1,\"what\":\"files this Mac no longer holds\"}]}}}\n"),
            "the file the home holds and this Mac lacks is not lost; the other is")
        try ShippingFixture.artifact("bundle-held.json", ["asked": asked.all.map { $0.sorted() }, "carried": written.carried,
                                                          "held": written.held, "manifest": manifest])
    }


    func testABlobWhoseBytesDoNotHashToItsNameAbortsTheWrite() throws {
        let blob = root.appendingPathComponent("wrong.bin")
        try Data("not the bytes that hash\n".utf8).write(to: blob)
        let out = root.appendingPathComponent("refused", isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        XCTAssertThrowsError(try BundleWriter.write(
            into: out, sourceId: Self.sourceId, feeder: Self.feeder,
            fetchedAt: ShippingFixture.instant(Self.fetchedAt), files: [],
            blobs: [BundleWriter.Blob(sha256: Self.blobHash, file: blob)], facts: [], custody: nil, through: DeviceFiles(.plain))) {
            XCTAssertEqual($0 as? BundleWriterError, .blobMismatch(Self.blobHash))
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: out.path), [],
                       "an aborted write publishes nothing and leaves no partial")
    }

    func testABlobNameThatIsNotAHexSHA256IsRefused() throws {
        let blob = root.appendingPathComponent("blob.bin")
        try Data(Self.blobBytes.utf8).write(to: blob)
        let out = root.appendingPathComponent("refused", isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        XCTAssertThrowsError(try BundleWriter.write(
            into: out, sourceId: Self.sourceId, feeder: Self.feeder,
            fetchedAt: ShippingFixture.instant(Self.fetchedAt), files: [],
            blobs: [BundleWriter.Blob(sha256: Self.blobHash.uppercased(), file: blob)], facts: [], custody: nil, through: DeviceFiles(.plain))) {
            XCTAssertEqual($0 as? BundleWriterError, .blobName(Self.blobHash.uppercased()))
        }
    }

    func testAListedFileCannotBeTheManifestABlobOrARepeat() throws {
        let out = root.appendingPathComponent("refused", isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let payload = Data("synthetic\n".utf8)
        for name in [BundleWriter.manifestFile, "blobs/\(Self.blobHash)"] {
            XCTAssertThrowsError(try BundleWriter.write(
                into: out, sourceId: Self.sourceId, feeder: Self.feeder,
                fetchedAt: ShippingFixture.instant(Self.fetchedAt),
                files: [BundleWriter.File(name: name, content: .bytes(payload))],
                facts: [], custody: nil, through: DeviceFiles(.plain)), name) {
                XCTAssertEqual($0 as? BundleWriterError, .listed(name))
            }
        }
        XCTAssertThrowsError(try BundleWriter.write(
            into: out, sourceId: Self.sourceId, feeder: Self.feeder,
            fetchedAt: ShippingFixture.instant(Self.fetchedAt),
            files: [BundleWriter.File(name: "a.jsonl", content: .bytes(payload)),
                    BundleWriter.File(name: "a.jsonl", content: .bytes(payload))],
            facts: [], custody: nil, through: DeviceFiles(.plain))) {
            XCTAssertEqual($0 as? BundleWriterError, .listed("a.jsonl"))
        }
    }

    func testTheSameBlobOfferedTwiceIsCarriedOnceAndBlobsAreSortedByHash() throws {
        let first = root.appendingPathComponent("first.bin")
        let second = root.appendingPathComponent("second.bin")
        try Data("synthetic blob one\n".utf8).write(to: first)
        try Data("synthetic blob two\n".utf8).write(to: second)
        let firstHash = try FileChunks.measure(first).sha256
        let secondHash = try FileChunks.measure(second).sha256
        let out = root.appendingPathComponent("out", isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

        let written = try BundleWriter.write(
            into: out, sourceId: Self.sourceId, feeder: Self.feeder,
            fetchedAt: ShippingFixture.instant(Self.fetchedAt), files: [],
            blobs: [BundleWriter.Blob(sha256: secondHash, file: second),
                    BundleWriter.Blob(sha256: firstHash, file: first),
                    BundleWriter.Blob(sha256: secondHash, file: second)],
            facts: [], custody: nil, through: DeviceFiles(.plain))
        XCTAssertEqual(written.carried, [firstHash, secondHash].sorted())
        let probe = try ZipArchiveProbe(try Data(contentsOf: written.file))
        XCTAssertEqual(probe.members.map(\.name),
                       [firstHash, secondHash].sorted().map { "blobs/\($0)" } + [BundleWriter.manifestFile])
        XCTAssertTrue(String(decoding: probe.bytes(BundleWriter.manifestFile)!, as: UTF8.self)
            .contains("\"blobs_carried\":2"))
    }

    func testAStagedBlobIsNamedAndCountedButNeverCarried() throws {
        let blob = root.appendingPathComponent("blob.bin")
        try Data(Self.blobBytes.utf8).write(to: blob)
        let out = root.appendingPathComponent("staged", isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let later = String(repeating: "e", count: 64), earlier = String(repeating: "a", count: 64)
        let written = try BundleWriter.write(
            into: out, sourceId: Self.sourceId, feeder: Self.feeder, fetchedAt: ShippingFixture.instant(Self.fetchedAt), files: [],
            blobs: [BundleWriter.Blob(sha256: Self.blobHash, file: blob)], stagedBlobs: [later, earlier],
            facts: [("batches", .int(1))], custody: nil, through: DeviceFiles(.plain))
        XCTAssertEqual(written.carried, [Self.blobHash])
        XCTAssertEqual(written.staged, [earlier, later])
        XCTAssertEqual(written.named, [earlier, Self.blobHash, later].sorted())
        let probe = try ZipArchiveProbe(try Data(contentsOf: written.file))
        XCTAssertEqual(probe.members.map(\.name), ["blobs/\(Self.blobHash)", BundleWriter.manifestFile])
        let manifest = String(decoding: try XCTUnwrap(probe.bytes(BundleWriter.manifestFile)), as: UTF8.self)
        XCTAssertTrue(manifest.hasSuffix("\"files\":[],\"facts\":{\"batches\":1,\"blobs_carried\":3},"
            + "\"staged_blobs\":[\"sha256:\(earlier)\",\"sha256:\(later)\"]}\n"), manifest)
    }

    func testAStagedBlobIsNeverAskedOfTheHomeNorLostAndSitsBeforeCustody() throws {
        let out = root.appendingPathComponent("staged-held", isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        func file(_ text: String) throws -> (hash: String, url: URL) {
            let url = root.appendingPathComponent("\(text).bin")
            try Data(text.utf8).write(to: url)
            return (try FileChunks.measure(url).sha256, url)
        }
        let carried = try file("synthetic carried"), heldHere = try file("synthetic held here")
        let later = String(repeating: "e", count: 64), earlier = String(repeating: "a", count: 64)
        let asked = Collected<Set<String>>()
        let written = try BundleWriter.write(
            into: out, sourceId: Self.sourceId, feeder: Self.feeder, fetchedAt: ShippingFixture.instant(Self.fetchedAt), files: [],
            blobs: [BundleWriter.Blob(sha256: carried.hash, file: carried.url),
                    BundleWriter.Blob(sha256: heldHere.hash, file: heldHere.url)],
            stagedBlobs: [later, earlier],
            held: { hexes in
                asked.append(hexes)
                return [heldHere.hash, later]
            },
            facts: [], custody: (ShippingFixture.first, [Lost(items: 2, what: "synthetic rows this Mac deleted")]), through: DeviceFiles(.plain))
        XCTAssertEqual(asked.all, [[carried.hash, heldHere.hash]], "the home is never asked of a staged file")
        XCTAssertEqual(written.carried, [carried.hash])
        XCTAssertEqual(written.held, [heldHere.hash], "a staged file answered as held is still staged")
        XCTAssertEqual(written.staged, [earlier, later])
        XCTAssertEqual(written.named, (written.carried + written.held + written.staged).sorted())
        XCTAssertEqual(written.named, [carried.hash, heldHere.hash, earlier, later].sorted())
        let probe = try ZipArchiveProbe(try Data(contentsOf: written.file))
        XCTAssertEqual(probe.members.map(\.name), ["blobs/\(carried.hash)", BundleWriter.manifestFile])
        let manifest = String(decoding: try XCTUnwrap(probe.bytes(BundleWriter.manifestFile)), as: UTF8.self)
        XCTAssertTrue(manifest.hasSuffix("\"facts\":{\"blobs_carried\":3},"
            + "\"staged_blobs\":[\"sha256:\(earlier)\",\"sha256:\(later)\"],"
            + "\"custody\":{\"machine:local:unit-0001\":{\"seal\":1,\"lost\":["
            + "{\"items\":2,\"what\":\"synthetic rows this Mac deleted\"}]}}}\n"),
            "one carried and two staged; held counts nowhere, and a staged file is not lost")
    }

    func testAStagedBlobThatIsNotAHexSHA256IsRepeatedOrIsAlsoNamedRefusesBeforeAnyWrite() throws {
        let out = root.appendingPathComponent("refused", isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let staged = String(repeating: "b", count: 64)
        let cases: [([BundleWriter.Blob], [String], BundleWriterError)] = [
            ([], ["sha256:\(staged)"], .blobName("sha256:\(staged)")),
            ([], [staged.uppercased()], .blobName(staged.uppercased())),
            ([], [staged, staged], .stagedTwice(staged)),
            ([BundleWriter.Blob(sha256: staged, file: nil)], [staged], .stagedCarried(staged)),
        ]
        for (blobs, stagedBlobs, refusal) in cases {
            XCTAssertThrowsError(try BundleWriter.write(
                into: out, sourceId: Self.sourceId, feeder: Self.feeder, fetchedAt: ShippingFixture.instant(Self.fetchedAt), files: [],
                blobs: blobs, stagedBlobs: stagedBlobs, facts: [], custody: (ShippingFixture.first, []), through: DeviceFiles(.plain))) {
                XCTAssertEqual($0 as? BundleWriterError, refusal)
            }
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: out.path), [])
    }

    func testAnEmptyBundleIsStillAManifestWithNoFilesAndNoBlobs() throws {
        let out = root.appendingPathComponent("out", isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let written = try BundleWriter.write(
            into: out, sourceId: Self.sourceId, feeder: Self.feeder,
            fetchedAt: ShippingFixture.instant(Self.fetchedAt), files: [], facts: [], custody: nil, through: DeviceFiles(.plain))
        XCTAssertEqual(written.carried, [])
        let probe = try ZipArchiveProbe(try Data(contentsOf: written.file))
        XCTAssertEqual(probe.members.map(\.name), [BundleWriter.manifestFile])
        let manifest = String(decoding: probe.bytes(BundleWriter.manifestFile)!, as: UTF8.self)
        XCTAssertTrue(manifest.contains("\"files\":[],\"facts\":{\"blobs_carried\":0}"))
        XCTAssertFalse(manifest.contains("staged_blobs"), "no staged blob, no member")
    }
}
