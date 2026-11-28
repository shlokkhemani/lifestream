import CryptoKit
import DeviceFiles
import Foundation
import XCTest
import zlib
@testable import HomeLink

final class MacWireTests: XCTestCase {
    private var folder: URL!
    private let phone = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil)
    private let mac = HomeLink.Device(kind: .mac, version: "0.2.0", model: "MacBook Pro", serial4: "0001")
    private let home = "https://lifestream.example.ts.net"
    private let id = "whatsapp:15550000001:macbook-pro-0001/20261128T101500Z"
    private static let source = "whatsapp:15550000001:macbook-pro-0001"
    private static let landed = ScriptedTransport.Step.reply(201, Fixture.answer(received: 1, imported: 0))
    private static let stored = ScriptedTransport.Step.reply(201, #"{"file":"stored"}"#)

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-mac-wire-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func paired(_ script: [ScriptedTransport.Step], device: HomeLink.Device? = nil, files: DeviceFiles = DeviceFiles(.plain),
                        network: (any NetworkWatch)? = nil) async throws -> (HomeLink, ScriptedTransport) {
        let device = device ?? mac
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: device, credentials: credentials, folder: folder,
                               transport: ScriptedTransport([.reply(200, Fixture.paired())]), files: files)
            .pair(code: "12345678", name: home, account: device.kind == .phone ? Fixture.account : nil)
        let transport = ScriptedTransport(script)
        let link = HomeLink(device: device, credentials: credentials, folder: folder, transport: transport, network: network,
                            pacer: Pacer { _, _ in }, files: files)
        return (link, transport)
    }

    private static func compressible() -> Data {
        Data(String(repeating: "CREATE TABLE message (id INTEGER PRIMARY KEY, text TEXT);\n", count: 2_000).utf8)
    }

    private static func incompressible(_ count: Int) -> Data {
        var generator = SystemRandomNumberGenerator()
        return Data((0..<count).map { _ in UInt8.random(in: 0...255, using: &generator) })
    }

    private func bundle(_ data: Data, files: DeviceFiles = DeviceFiles(.plain)) throws -> URL {
        let file = folder.appendingPathComponent("bundle-\(UUID().uuidString).zip")
        try files.writeNew(file, data, flush: .data)
        return file
    }

    private static func bytes(of body: HomeRequest.Body) throws -> Data {
        switch body {
        case .empty: return Data()
        case .file(let url): return try Data(contentsOf: url)
        case .stream(_, let opener):
            let chunks = try opener.open()
            var read = Data()
            while let chunk = try chunks.next() { read.append(chunk) }
            return read
        case .json(let data), .bytes(let data): return data
        }
    }

    private static func gunzip(_ data: Data) throws -> Data {
        var stream = z_stream()
        guard inflateInit2_(&stream, MAX_WBITS + 16, zlibVersion(), Int32(MemoryLayout<z_stream>.size)) == Z_OK else {
            throw URLError(.cannotDecodeContentData)
        }
        defer { inflateEnd(&stream) }
        var out = Data()
        var buffer = Data(count: 1 << 16)
        var status = Z_OK
        try data.withUnsafeBytes { raw in
            stream.next_in = UnsafeMutablePointer(mutating: raw.bindMemory(to: Bytef.self).baseAddress)
            stream.avail_in = uInt(raw.count)
            while status != Z_STREAM_END {
                let have = buffer.withUnsafeMutableBytes { space -> Int in
                    stream.next_out = space.bindMemory(to: Bytef.self).baseAddress
                    stream.avail_out = uInt(space.count)
                    status = inflate(&stream, Z_NO_FLUSH)
                    return space.count - Int(stream.avail_out)
                }
                guard status == Z_OK || status == Z_STREAM_END else { throw URLError(.cannotDecodeContentData) }
                out.append(buffer.prefix(have))
            }
        }
        return out
    }

    private final class Seen: @unchecked Sendable {
        private let lock = NSLock()
        private var read: [Data] = []
        private var disk: [Data] = []

        func keep(_ body: Data, onDisk: Data?) {
            lock.withLock {
                read.append(body)
                if let onDisk { disk.append(onDisk) }
            }
        }

        var bodies: [Data] { lock.withLock { read } }
        var onDisk: [Data] { lock.withLock { disk } }
    }

    private func watch(_ transport: ScriptedTransport) -> Seen {
        let seen = Seen()
        transport.onPerform = { request in
            guard request.method == "PUT" else { return }
            let onDisk: Data? = request.headers["Content-Encoding"] == nil ? nil : Self.madeFiles().first.flatMap { try? Data(contentsOf: $0) }
            seen.keep((try? Self.bytes(of: request.body)) ?? Data(), onDisk: onDisk)
        }
        return seen
    }

    private static func madeFiles() -> [URL] {
        let temporary = FileManager.default.temporaryDirectory
        let names = (try? FileManager.default.contentsOfDirectory(atPath: temporary.path)) ?? []
        return names.filter { $0.hasPrefix("lifestream-") && $0.hasSuffix(".gz") }.map { temporary.appendingPathComponent($0) }
    }

    func testAMacBundleThatShrinksGoesGzippedStatingItsPlainLengthAndItsTemporaryIsGone() async throws {
        let plain = Self.compressible()
        let file = try bundle(plain)
        let (link, transport) = try await paired([Self.landed])
        let seen = watch(transport)
        let before = Set(Self.madeFiles())
        _ = try await link.send(bundle: file, id: id, kind: .new, compress: true)
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.url.path, "/v1/acquisitions/\(id)")
        XCTAssertEqual(request.headers["Content-Encoding"], "gzip")
        XCTAssertEqual(request.headers[HomeLink.uncompressedLengthHeader], String(plain.count))
        XCTAssertEqual(request.headers["Content-Type"], "application/zip")
        let wire = try XCTUnwrap(seen.bodies.first)
        XCTAssertLessThan(wire.count, plain.count / 10, "a store's text shrinks")
        XCTAssertEqual(Array(wire.prefix(2)), [0x1f, 0x8b], "a gzip stream, not raw deflate")
        XCTAssertEqual(try Self.gunzip(wire), plain, "the door's gunzip gives the bundle back byte for byte")
        XCTAssertEqual(Set(Self.madeFiles()).subtracting(before), [], "the .gz is removed once the send ends")
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path), "the bundle itself stays for the shipper")
    }

    func testAKeyedMacBundleIsGzippedThroughItsKeySoNoPlainBytesTouchTheDisk() async throws {
        let files = DeviceFiles(.keyed(SymmetricKey(size: .bits256)))
        let plain = Self.compressible()
        let file = try bundle(plain, files: files)
        let (link, transport) = try await paired([Self.landed], files: files)
        let seen = watch(transport)
        _ = try await link.send(bundle: file, id: id, kind: .new, compress: true)
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.headers["Content-Encoding"], "gzip")
        guard case .stream(let size, _) = request.body else { return XCTFail("a keyed .gz is streamed through its key") }
        let wire = try XCTUnwrap(seen.bodies.first)
        XCTAssertEqual(size, Int64(wire.count), "the body states its plain gzip length")
        XCTAssertEqual(try Self.gunzip(wire), plain)
        let disk = try XCTUnwrap(seen.onDisk.first, "the .gz was on disk while it was sent")
        XCTAssertNotEqual(Array(disk.prefix(2)), [0x1f, 0x8b], "on disk it is sealed, not a gzip stream")
        XCTAssertNil(disk.range(of: Data("CREATE TABLE".utf8)))
    }

    func testABundleThatDoesNotShrinkGoesAsItIsWithNoEncoding() async throws {
        let file = try bundle(Self.incompressible(64 * 1024))
        let (link, transport) = try await paired([Self.landed])
        _ = try await link.send(bundle: file, id: id, kind: .new, compress: true)
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.body, .file(file))
        XCTAssertNil(request.headers["Content-Encoding"])
        XCTAssertNil(request.headers[HomeLink.uncompressedLengthHeader])
    }

    func testAFileThatStaysIncompressiblePastTheProbeIsGivenUp() throws {
        let files = DeviceFiles(.plain)
        let source = try bundle(Self.incompressible(Int(Gzip.probe) + (1 << 20)))
        let target = folder.appendingPathComponent("given-up.gz")
        XCTAssertFalse(try Gzip.compress(source, to: target, files: files))
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path), "nothing is left of the attempt")
    }

    func testAPhoneBundleIsNeverGzipped() async throws {
        let file = try bundle(Self.compressible())
        let (link, transport) = try await paired([Self.landed], device: phone)
        _ = try await link.send(bundle: file, id: "sha256:00aa", kind: .new, compress: true)
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.url.path, "/v1/bundles/sha256:00aa")
        XCTAssertEqual(request.body, .file(file))
        XCTAssertNil(request.headers["Content-Encoding"])
    }

    func testAMacSendNotAskedToCompressIsTodaysRequest() async throws {
        let file = try bundle(Self.compressible())
        let (link, transport) = try await paired([Self.landed])
        _ = try await link.send(bundle: file, id: id, kind: .new)
        XCTAssertEqual(transport.requests.first?.body, .file(file))
        XCTAssertNil(transport.requests.first?.headers["Content-Encoding"])
    }

    func testABundleWaitingForWiFiIsNotGzippedUntilItCanMove() async throws {
        let file = try bundle(Self.compressible())
        let network = MovableNetwork(NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: false, path: 1, cost: .costly))
        let (link, transport) = try await paired([Self.landed], network: network)
        let written = Written()
        DeviceFiles.flushObserver = { url, _ in written.add(url) }
        defer { DeviceFiles.flushObserver = nil }
        do {
            _ = try await link.send(bundle: file, id: id, kind: .later, compress: true)
            XCTFail("a later bundle on a hotspot")
        } catch LinkFailure.waits(let wait) {
            XCTAssertEqual(wait, .past)
        }
        XCTAssertFalse(written.any { $0.lastPathComponent.contains(".gz") }, "nothing is gzipped for a bundle that cannot move")
        XCTAssertTrue(transport.requests.isEmpty)
        network.set(NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: false, path: 1, cost: .free))
        _ = try await link.send(bundle: file, id: id, kind: .later, compress: true)
        XCTAssertTrue(written.any { $0.lastPathComponent.contains(".gz") }, "once it can move it is gzipped")
        XCTAssertEqual(transport.requests.first?.headers["Content-Encoding"], "gzip")
    }

    func testABundleWhoseGzipFailsGoesPlain() async throws {
        let file = try bundle(Self.compressible())
        let (link, transport) = try await paired([Self.landed])
        DeviceFiles.failStep = { url, _ in url.lastPathComponent.contains(".gz") ? EIO : nil }
        defer { DeviceFiles.failStep = nil }
        _ = try await link.send(bundle: file, id: id, kind: .new, compress: true)
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.body, .file(file), "the plain bundle goes when its gzip cannot be written")
        XCTAssertNil(request.headers["Content-Encoding"])
        XCTAssertNil(request.headers[HomeLink.uncompressedLengthHeader])
    }

    private final class Written: @unchecked Sendable {
        private let lock = NSLock()
        private var urls: [URL] = []

        func add(_ url: URL) { lock.withLock { urls.append(url) } }
        func any(_ test: (URL) -> Bool) -> Bool { lock.withLock { urls.contains(where: test) } }
    }

    private static func name(_ letter: Character) -> String {
        "sha256:" + String(repeating: letter, count: 64)
    }

    private func staged(_ letter: Character, _ content: Data, files: DeviceFiles = DeviceFiles(.plain), kept: Bool = true) throws -> HomeLink.File {
        let url = folder.appendingPathComponent("staged-\(letter)")
        if kept { try files.writeNew(url, content, flush: .data) } else { try content.write(to: url) }
        return HomeLink.File(name: Self.name(letter), url: url, bytes: Int64(content.count), kept: kept)
    }

    func testAStagedFileStatesItsSourceAndOffsetAndGoesOnOnceFromTheOffsetTheDoorHolds() async throws {
        let file = try staged("a", Data("0123456789".utf8))
        let (link, transport) = try await paired([
            .reply(409, #"{"code":"UPLOAD_OFFSET","message":"Send from the byte the home holds.","held":4}"#), Self.stored,
        ])
        let seen = watch(transport)
        try await link.stage(file: file, source: Self.source, kind: .new)
        let requests = transport.requests
        XCTAssertEqual(requests.map(\.url.path), ["/v1/files/\(file.name)", "/v1/files/\(file.name)"])
        XCTAssertEqual(requests.map { $0.headers[HomeLink.offsetHeader] }, ["0", "4"])
        for request in requests {
            XCTAssertEqual(request.method, "PUT")
            XCTAssertEqual(request.headers[HomeLink.sourceHeader], Self.source, "a Mac names the source the file is staged for")
            XCTAssertEqual(request.headers[HomeLink.kindHeader], "new")
            XCTAssertEqual(request.headers["Content-Type"], "application/octet-stream")
        }
        XCTAssertEqual(seen.bodies, [Data("0123456789".utf8), Data("456789".utf8)], "one request carries the whole rest of the file")
    }

    func testANegativeHeldOffsetIsNoPlaceToGoOnFrom() async throws {
        let file = try staged("g", Data("0123456789".utf8))
        let (link, transport) = try await paired([
            .reply(409, #"{"code":"UPLOAD_OFFSET","message":"Send from the byte the home holds.","held":-4}"#), Self.stored,
        ])
        do {
            try await link.stage(file: file, source: Self.source, kind: .new)
            XCTFail("a negative offset")
        } catch LinkFailure.refused(let status, let code, _) {
            XCTAssertEqual(status, 409)
            XCTAssertEqual(code, "UPLOAD_OFFSET")
        }
        XCTAssertEqual(transport.requests.count, 1, "no second send from a byte before the first")
    }

    func testAPhoneStagesWithoutASource() async throws {
        let file = try staged("b", Data("abc".utf8))
        let (link, transport) = try await paired([Self.stored], device: phone)
        try await link.stage(file: file, source: Self.source, kind: .new)
        XCTAssertNil(transport.requests.first?.headers[HomeLink.sourceHeader])
    }

    func testAStagedFileOverLowDatasBoundWaitsAndSendsNothing() async throws {
        let url = folder.appendingPathComponent("large")
        try Data("x".utf8).write(to: url)
        let file = HomeLink.File(name: Self.name("c"), url: url, bytes: MobileData.largeBytes)
        let network = MovableNetwork(NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: false, path: 1, cost: .lowData))
        let (link, transport) = try await paired([Self.stored], network: network)
        do {
            try await link.stage(file: file, source: Self.source, kind: .new)
            XCTFail("a large file on Low Data Mode")
        } catch LinkFailure.waits(let wait) {
            XCTAssertEqual(wait, .lowData)
        }
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testAKeptFileOnAKeyedMacIsReadThroughItsKeyFromTheFirstByte() async throws {
        let files = DeviceFiles(.keyed(SymmetricKey(size: .bits256)))
        let content = Data("kept and sealed".utf8)
        let file = try staged("d", content, files: files)
        let (link, transport) = try await paired([Self.stored], files: files)
        let seen = watch(transport)
        try await link.stage(file: file, source: Self.source, kind: .new)
        guard case .stream(let size, _)? = transport.requests.first?.body else { return XCTFail("a kept keyed file is streamed") }
        XCTAssertEqual(size, Int64(content.count))
        XCTAssertEqual(seen.bodies, [content], "the plain bytes, never the sealed file")
    }

    func testAnOutsideFileOnAKeyedMacIsReadAsTheOSHoldsIt() async throws {
        let files = DeviceFiles(.keyed(SymmetricKey(size: .bits256)))
        let content = Data("an attachment another app wrote".utf8)
        let file = try staged("e", content, files: files, kept: false)
        let (link, transport) = try await paired([
            .reply(409, #"{"code":"UPLOAD_OFFSET","message":"Send from the byte the home holds.","held":3}"#), Self.stored,
        ], files: files)
        let seen = watch(transport)
        try await link.stage(file: file, source: Self.source, kind: .new)
        XCTAssertEqual(transport.requests.first?.body, .file(file.url), "from its first byte it is the file itself")
        guard case .stream(let size, _)? = transport.requests.last?.body else { return XCTFail("its rest is streamed") }
        XCTAssertEqual(size, Int64(content.count - 3))
        XCTAssertEqual(seen.bodies, [content, content.dropFirst(3)], "raw bytes, never decrypted")
    }

    func testFilesMissingOnAMacSendIsItsOwnFailureNamingTheFiles() async throws {
        let file = try bundle(Self.incompressible(1024))
        let body = #"{"code":"FILES_MISSING","message":"send them","missing":{"files":["\#(Self.name("f"))"]}}"#
        let (link, _) = try await paired([.reply(409, body)])
        do {
            _ = try await link.send(bundle: file, id: id, kind: .new, compress: true)
            XCTFail("a bundle whose staged files are gone")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .filesMissing([Self.name("f")]))
            XCTAssertEqual(failure.code, "FILES_MISSING")
        }
    }

    func testTheMacExchangeCarriesItsResultsAndReadsItsCalls() async throws {
        let answer = #"""
        {"hand":3,"calls":[{"id":"m-1","kind":"refresh","connector":"whatsapp"},{"id":"m-2","kind":"settings"},
        {"id":"m-3","kind":"flush","sources":["whatsapp"],"budget_ms":1000},{"id":"m-4","kind":"flush","budget_ms":500},
        {"id":"m-5","kind":"dance"},{"id":"m-6","kind":"refresh"},{"kind":"settings"}]}
        """#
        let (link, transport) = try await paired([.reply(200, answer)])
        let got = try await link.macExchange(HomeLink.MacExchangeRequest(
            boot: "6f1c1d0e-0000-4000-8000-000000000001", sources: ["whatsapp", "imessage"], running: ["m-0"],
            results: [.done("m-a", seals: ["whatsapp": 42]), .done("m-b"), .failed("m-c", code: "FAILED", message: "no")]))
        XCTAssertEqual(got.hand, 3)
        XCTAssertEqual(got.calls, [
            .refresh(id: "m-1", connector: "whatsapp"), .settings(id: "m-2"),
            .flush(id: "m-3", sources: ["whatsapp"], budgetMs: 1000), .flush(id: "m-4", sources: nil, budgetMs: 500),
            .unknown(id: "m-5", kind: "dance"), .unknown(id: "m-6", kind: "refresh"),
        ], "an unknown or malformed call is kept to be answered; one with no id is dropped")
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.path, "/v1/mac/exchange")
        XCTAssertNotNil(request.headers["Authorization"])
        XCTAssertEqual(request.headers[HomeLink.deviceHeader], "mac/0.2.0")
        guard case .json(let sent) = request.body else { return XCTFail("JSON") }
        XCTAssertEqual(String(decoding: sent, as: UTF8.self),
                       #"{"boot":"6f1c1d0e-0000-4000-8000-000000000001","results":[{"id":"m-a","ok":true,"seals":{"whatsapp":42}},"#
                       + #"{"id":"m-b","ok":true},{"error":{"code":"FAILED","message":"no"},"id":"m-c","ok":false}],"#
                       + #""running":["m-0"],"sources":["whatsapp","imessage"]}"#,
                       "sleep, seals and error are left out unless they say something")
    }

    func testASleepingExchangeSaysSo() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let sent = try encoder.encode(HomeLink.MacExchangeRequest(boot: "b", sources: [], sleep: true))
        XCTAssertEqual(String(decoding: sent, as: UTF8.self), #"{"boot":"b","results":[],"running":[],"sleep":true,"sources":[]}"#)
    }

    func testASupersededExchangeIsARefusal() async throws {
        let (link, _) = try await paired([.reply(409, #"{"code":"SUPERSEDED","message":"another boot of this Mac holds the line"}"#)])
        do {
            _ = try await link.macExchange(HomeLink.MacExchangeRequest(boot: "b", sources: []))
            XCTFail("superseded")
        } catch LinkFailure.refused(let status, let code, _) {
            XCTAssertEqual(status, 409)
            XCTAssertEqual(code, "SUPERSEDED")
        }
    }

    func testHoldingIsReadableOutsideHomeLink() {
        let holding = HomeLink.Holding(held: [Self.name("a")], staged: [Self.name("b")], partly: [Self.name("c"): 9])
        XCTAssertTrue(holding.whole(Self.name("a")))
        XCTAssertTrue(holding.whole(Self.name("b")))
        XCTAssertFalse(holding.whole(Self.name("c")))
    }
}
