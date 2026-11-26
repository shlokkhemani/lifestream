import CryptoKit
import DeviceFiles
import Foundation
import XCTest
@testable import HomeLink

final class FilesTests: XCTestCase {
    private var folder: URL!
    private let phone = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil)
    private let home = "https://lifestream.example.ts.net"
    private static let at = Date(timeIntervalSince1970: 1_791_540_000)
    private static let goldens = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Fixtures/files")
    private static let five = ["answer.json", "reach.json", "clock.json", "settings-queue.json", "credentials.json"]

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testAPlainDeviceWritesEachOfItsFiveFilesAsBefore() async throws {
        try await writeFive()
        let writing = ProcessInfo.processInfo.environment["LIFESTREAM_WRITE_FIXTURES"] == "1"
        var facts: [String: [String: Int]] = [:]
        for name in Self.five {
            let file = folder.appendingPathComponent(name)
            let bytes = try Data(contentsOf: file)
            let mode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int) & 0o777
            let excluded = try file.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true
            facts[name] = ["mode": mode, "excluded": excluded ? 1 : 0]
            if writing {
                try FileManager.default.createDirectory(at: Self.goldens, withIntermediateDirectories: true)
                try bytes.write(to: Self.goldens.appendingPathComponent(name))
            } else {
                try Self.same(bytes, try Data(contentsOf: Self.goldens.appendingPathComponent(name)), name)
            }
        }
        let factsFile = Self.goldens.appendingPathComponent("facts.json")
        if writing {
            try JSONSerialization.data(withJSONObject: facts, options: [.sortedKeys, .prettyPrinted]).write(to: factsFile)
        } else {
            let kept = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: factsFile)) as? [String: [String: Int]])
            XCTAssertEqual(facts, kept, "each file's mode and backup flag are today's")
        }
    }

    func testAnAnswerKeptBeforeNeedsCarriedAKindStillReadsAndLeavesItsNeedsToTheNextExchange() throws {
        let kept = #"{"answer":{"calls":[],"clock":"149e7dc8591bf2d4","home":{"floors":{"extension":"0.1.0","mac":"0.1.0","phone":"1.0.0"},"id":"h-0001","version":"0.2.0"},"needs":[{"acts":[],"at":null,"banner":false,"connector":null,"copy":null,"detail":null,"dismissed":false,"id":"disk","next_ms":null,"reason":null,"since_ms":1791540000000,"state":"needs-you","unit":null,"weight":"advice","words":"Plug in the drive"}],"owner":[],"pass":"p-00000001","settings":{},"sources":{"imessage:a@example.com:unit-0001":{"formats":["v1"],"history":true,"imported":0,"received":0}},"turn":{"n":2,"run":"00000000000000aa"},"unit":"macbook-pro-0001"},"at":1791540000}"#
        try Data(kept.utf8).write(to: folder.appendingPathComponent("answer.json"))
        let link = HomeLink(device: phone, credentials: MemoryCredentials(), folder: folder,
                            transport: FilesTransport(clock: try Self.london()), clock: { Self.at })
        let saved = try XCTUnwrap(link.saved, "the answer an older app kept still reads")
        XCTAssertEqual([saved.unit, saved.pass], ["macbook-pro-0001", "p-00000001"])
        XCTAssertEqual(saved.at, Self.at)
        XCTAssertEqual(saved.needs, [], "a kept need with no kind is left out until the next exchange answers it")
    }

    static func same(_ bytes: Data, _ golden: Data, _ name: String) throws {
        guard name == "settings-queue.json" else { return XCTAssertEqual(bytes, golden, "\(name): today's bytes") }
        let read = { (data: Data) throws -> NSArray in try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSArray) }
        XCTAssertEqual(try read(bytes), try read(golden), "\(name): JSONEncoder orders its keys anew in each process, today too")
    }

    func testAKeyedDeviceWritesEachOfItsFiveFilesEncryptedAndReadsThemBack() async throws {
        let files = DeviceFiles(.keyed(SymmetricKey(size: .bits256)))
        try await writeFive(files: files)
        for name in Self.five {
            let file = folder.appendingPathComponent(name)
            let bytes = try Data(contentsOf: file)
            XCTAssertNil(try? JSONSerialization.jsonObject(with: bytes), "\(name): no plain JSON on disk")
            XCTAssertNil(bytes.range(of: Data("lifestream".utf8)), "\(name): no plain text on disk")
            let plain = try XCTUnwrap(files.read(file, maximumBytes: 1 << 20), name)
            XCTAssertNotNil(try? JSONSerialization.jsonObject(with: plain), "\(name): its plain bytes read back")
        }
        let credentials = folder.appendingPathComponent("credentials.json")
        let mode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: credentials.path)[.posixPermissions] as? Int) & 0o777
        XCTAssertEqual(mode, 0o600, "the pass keeps its mode")
        XCTAssertEqual(try credentials.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true,
                       "the pass stays out of backups")
        XCTAssertEqual(try FileCredentials(url: credentials, files: files).read(),
                       Data(#"{"name":"https://lifestream.example.ts.net","pass":"a-pass","paired":true}"#.utf8))
    }

    func testAKeyedHomesPairingAnswerMakesTheDeviceKeyedBeforeItWritesAnyFileOfThatAnswer() async throws {
        let files = DeviceFiles(.plain)
        let key = SymmetricKey(size: .bits256)
        let credentials = folder.appendingPathComponent("credentials.json")
        let answer = folder.appendingPathComponent("answer.json")
        let calls = Calls()
        let transport = FilesTransport(clock: try Self.london())
        transport.keyed = true
        let at = Self.at
        let link = HomeLink(device: phone, credentials: FileCredentials(url: credentials, files: files), folder: folder,
                            transport: transport, clock: { at }, files: files, becomeKeyed: { [folder] in
            calls.add()
            XCTAssertFalse(FileManager.default.fileExists(atPath: answer.path), "no answer kept before the switch")
            let held = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: credentials)) as? [String: Any])
            XCTAssertEqual(held["paired"] as? Bool, false, "the pass is still the plain attempt")
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder!.path), ["credentials.json"])
            try files.becomeKeyed(key) { _ in }
        })
        _ = try await link.pair(code: "12345678", name: home, account: Fixture.account)
        await link.clockReadsEnded()
        await link.probesEnded()
        XCTAssertEqual(calls.count, 1)
        for file in [credentials, answer] {
            let bytes = try Data(contentsOf: file)
            XCTAssertNil(try? JSONSerialization.jsonObject(with: bytes), "\(file.lastPathComponent) written keyed")
        }
        XCTAssertNotNil(link.saved, "the kept answer reads back through the keyed instance")
        _ = try await link.exchange()
        XCTAssertEqual(calls.count, 1, "an ordinary answer never makes the device keyed")
    }

    func testAPairingWhoseSwitchThrowsFailsWithItsReasonAndWritesNothingOfTheAnswer() async throws {
        struct Recording: Error, Equatable {}
        let files = DeviceFiles(.plain)
        let credentials = folder.appendingPathComponent("credentials.json")
        let transport = FilesTransport(clock: try Self.london())
        transport.keyed = true
        let link = HomeLink(device: phone, credentials: FileCredentials(url: credentials, files: files), folder: folder,
                            transport: transport, files: files, becomeKeyed: { throw Recording() })
        do {
            _ = try await link.pair(code: "12345678", name: home, account: Fixture.account)
            XCTFail("the pairing fails")
        } catch {
            XCTAssertEqual(error as? Recording, Recording(), "the switch's own reason")
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), [], "the pass the home redeemed was kept")
    }

    func testARefusedSwitchOnAPairedDeviceDropsOnlyThePassItSentAndKeepsItsHome() async throws {
        struct Recording: Error {}
        let files = DeviceFiles(.plain)
        let credentials = FileCredentials(url: folder.appendingPathComponent("credentials.json"), files: files)
        let paired = Data(#"{"name":"https://lifestream.example.ts.net","pass":"a-pass","paired":true}"#.utf8)
        try credentials.write(paired)
        let transport = FilesTransport(clock: try Self.london())
        transport.keyed = true
        let link = HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport, files: files,
                            becomeKeyed: { throw Recording() })
        do {
            _ = try await link.pair(code: "12345678", name: "https://lifestream-b.example.ts.net", account: Fixture.account)
            XCTFail("the pairing fails")
        } catch {
            XCTAssertTrue(error is Recording, "\(error)")
        }
        let kept = try JSONSerialization.jsonObject(with: XCTUnwrap(credentials.read())) as? NSDictionary
        XCTAssertEqual(kept, try JSONSerialization.jsonObject(with: paired) as? NSDictionary, "the refused attempt's pass stayed, or the home it was paired with was lost")
    }

    func testAnOrdinaryPairingAnswerNeverMakesTheDeviceKeyed() async throws {
        let calls = Calls()
        let link = HomeLink(device: phone, credentials: MemoryCredentials(), folder: folder,
                            transport: FilesTransport(clock: try Self.london()), becomeKeyed: { calls.add() })
        _ = try await link.pair(code: "12345678", name: home, account: Fixture.account)
        _ = try await link.exchange()
        await link.clockReadsEnded()
        await link.probesEnded()
        XCTAssertEqual(calls.count, 0)
        XCTAssertNotNil(try? JSONSerialization.jsonObject(with: Data(contentsOf: folder.appendingPathComponent("answer.json"))),
                        "kept plain")
    }

    func testAKeyedBundlesNetworkRuleReadsItsPlainSize() async throws {
        let files = DeviceFiles(.keyed(SymmetricKey(size: .bits256)))
        let bundle = folder.appendingPathComponent("large.zip")
        try files.writeNew(bundle, Data(count: Int(MobileData.largeBytes) - 1), flush: .data)
        let onDisk = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: bundle.path)[.size] as? Int)
        XCTAssertGreaterThanOrEqual(Int64(onDisk), MobileData.largeBytes, "the encrypted file is past the line")
        let transport = StreamingTransport(dropsFirst: false)
        let link = try await pairedLink(transport, files: files)
        _ = try await link.send(bundle: bundle, id: "sha256:00aa", kind: .new)
        let request = try XCTUnwrap(transport.uploads.first)
        XCTAssertEqual(request.crossing, .any, "under 50 MB of plain bytes: any network, Low Data Mode too")
        guard case .stream(let size, _) = request.body else { return XCTFail("a keyed bundle is streamed") }
        XCTAssertEqual(size, MobileData.largeBytes - 1, "the body states its plain size")
    }

    func testAKeyedBundleLostMidBodyIsSentAgainFromItsFirstByte() async throws {
        let files = DeviceFiles(.keyed(SymmetricKey(size: .bits256)))
        let bundle = folder.appendingPathComponent("b.zip")
        let payload = Data((0..<300_000).map { UInt8($0 % 251) })
        try files.writeNew(bundle, payload, flush: .data)
        let transport = StreamingTransport(dropsFirst: true)
        let link = try await pairedLink(transport, files: files)
        do {
            _ = try await link.send(bundle: bundle, id: "sha256:00aa", kind: .new)
            XCTFail("the lost connection fails the first send")
        } catch LinkFailure.noAnswer {}
        let fresh = try await link.send(bundle: bundle, id: "sha256:00aa", kind: .new)
        XCTAssertEqual(fresh.sources[Fixture.source]?.received, 1)
        XCTAssertEqual(transport.uploads.count, 2, "the next send sends it again")
        XCTAssertEqual(transport.firstBytes, [payload.prefix(1024), payload.prefix(1024)], "each attempt's stream opens at the start")
        XCTAssertEqual(transport.received, payload, "the home got the plain bytes whole")
        guard case .stream(let first, let opener)? = transport.uploads.first?.body,
              case .stream(let second, let again)? = transport.uploads.last?.body else { return XCTFail("streamed") }
        XCTAssertEqual([first, second], [Int64(payload.count), Int64(payload.count)])
        XCTAssertFalse(opener === again, "a new request each attempt")
    }

    func testAPlainBundleStillGoesFromItsFile() async throws {
        let bundle = folder.appendingPathComponent("b.zip")
        try Data("zip".utf8).write(to: bundle)
        let transport = StreamingTransport(dropsFirst: false)
        let link = try await pairedLink(transport, files: DeviceFiles(.plain))
        _ = try await link.send(bundle: bundle, id: "sha256:00aa", kind: .new)
        XCTAssertEqual(transport.uploads.first?.body, .file(bundle))
    }

    private func pairedLink(_ transport: StreamingTransport, files: DeviceFiles) async throws -> HomeLink {
        let link = HomeLink(device: phone, credentials: MemoryCredentials(), folder: folder, transport: transport, files: files)
        _ = try await link.pair(code: "12345678", name: home, account: Fixture.account)
        return link
    }

    private func writeFive(files: DeviceFiles? = nil) async throws {
        let clock = try Self.london()
        let at = Self.at
        let link = files.map {
            HomeLink(device: phone, credentials: MemoryCredentials(), folder: folder,
                     transport: FilesTransport(clock: clock), clock: { at }, files: $0)
        } ?? HomeLink(device: phone, credentials: MemoryCredentials(), folder: folder,
                      transport: FilesTransport(clock: clock), clock: { at })
        _ = try await link.pair(code: "12345678", name: home, account: Fixture.account)
        _ = try await link.exchange()
        await link.clockReadsEnded()
        await link.probesEnded()
        let queueFile = folder.appendingPathComponent("settings-queue.json")
        let credentialsFile = folder.appendingPathComponent("credentials.json")
        let queue = files.map { SettingsQueue(file: queueFile, files: $0) } ?? SettingsQueue(file: queueFile)
        let credentials = files.map { FileCredentials(url: credentialsFile, files: $0) } ?? FileCredentials(url: credentialsFile)
        try queue.enqueue(connector: "gmail", member: "spam", value: .bool(true), was: .bool(false))
        try credentials.write(Data(#"{"name":"https://lifestream.example.ts.net","pass":"a-pass","paired":true}"#.utf8))
    }

    static func london() throws -> Data {
        let cases = goldens.deletingLastPathComponent().appendingPathComponent("clock-cases.json")
        let file = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: cases)) as? [String: Any])
        let entry = try XCTUnwrap((file["clocks"] as? [[String: Any]])?.first { $0["name"] as? String == "london-4" })
        return try JSONSerialization.data(withJSONObject: XCTUnwrap(entry["clock"]), options: [.sortedKeys])
    }
}

final class FilesTransport: HomeTransport, @unchecked Sendable {
    private let clock: Data
    private let id: String
    private let lock = NSLock()
    private var turn = 0
    var keyed = false

    init(clock: Data) {
        self.clock = clock
        id = HomeClock(body: clock)?.id ?? ""
    }

    func identify(_ address: URL, within: TimeInterval) async throws -> String {
        String(repeating: "A", count: 52)
    }

    func answer() -> String {
        let n = lock.withLock { () -> Int in
            turn += 1
            return turn
        }
        return Fixture.answer(received: 0, imported: 0, turn: Answer.Turn(run: "00000000000000aa", n: n),
                              extra: #","clock":"\#(id)""# + (keyed ? #","keyed":true"# : ""))
    }

    func perform(_ request: HomeRequest) async throws -> HomeResponse {
        switch request.url.path {
        case "/v1/pair":
            return HomeResponse(status: 200, body: Data((#"{"unit":"macbook-pro-0001","answer":"# + answer() + "}").utf8))
        case "/v1/exchange":
            return HomeResponse(status: 200, body: Data(answer().utf8))
        case "/v1/clock":
            return HomeResponse(status: 200, headers: ["etag": "\"c\""], body: clock)
        default:
            return HomeResponse(status: 200, body: Data("{}".utf8))
        }
    }
}

final class Calls: @unchecked Sendable {
    private let lock = NSLock()
    private var made = 0

    var count: Int { lock.withLock { made } }

    func add() {
        lock.withLock { made += 1 }
    }
}

final class StreamingTransport: HomeTransport, @unchecked Sendable {
    private let dropsFirst: Bool
    private let lock = NSLock()
    private var made: [HomeRequest] = []
    private var starts: [Data] = []
    private var whole = Data()

    init(dropsFirst: Bool) {
        self.dropsFirst = dropsFirst
    }

    var uploads: [HomeRequest] { lock.withLock { made } }
    var firstBytes: [Data] { lock.withLock { starts } }
    var received: Data { lock.withLock { whole } }

    func identify(_ address: URL, within: TimeInterval) async throws -> String {
        String(repeating: "A", count: 52)
    }

    func perform(_ request: HomeRequest) async throws -> HomeResponse {
        guard request.method == "PUT" else {
            return HomeResponse(status: 200, body: Data(Fixture.paired().utf8))
        }
        let attempt = lock.withLock { () -> Int in
            made.append(request)
            return made.count
        }
        if case .stream(_, let opener) = request.body {
            let reader = try opener.open()
            var all = try reader.next() ?? Data()
            lock.withLock { starts.append(all.prefix(1024)) }
            if dropsFirst, attempt == 1 { throw URLError(.networkConnectionLost) }
            while let piece = try reader.next() { all.append(piece) }
            lock.withLock { whole = all }
        }
        return HomeResponse(status: 201, body: Data(Fixture.answer(received: 1, imported: 0).utf8))
    }
}
