import Foundation
import XCTest
@testable import HomeLink

final class SendFilesTests: XCTestCase {
    private var folder: URL!
    private let phone = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil)
    private let mac = HomeLink.Device(kind: .mac, version: "0.2.0", model: "MacBook Pro", serial4: "0001")
    private let home = "https://lifestream.example.ts.net"
    private let id = "sha256:00aa"

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-files-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func paired(_ script: [ScriptedTransport.Step], device: HomeLink.Device? = nil,
                        network: (any NetworkWatch)? = nil) async throws -> (HomeLink, ScriptedTransport) {
        let device = device ?? phone
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: device, credentials: credentials, folder: folder,
                               transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: home, account: device.kind == .phone ? Fixture.account : nil)
        let transport = ScriptedTransport(script)
        let link = HomeLink(device: device, credentials: credentials, folder: folder, transport: transport, network: network,
                            pacer: Pacer { _, _ in })
        return (link, transport)
    }

    private func bundle() throws -> URL {
        let file = folder.appendingPathComponent("b.zip")
        try Data("zip".utf8).write(to: file)
        return file
    }

    private static func name(_ letter: Character) -> String {
        "sha256:" + String(repeating: letter, count: 64)
    }

    private func file(_ letter: Character, _ content: String, declared: Int64? = nil) throws -> HomeLink.File {
        let url = folder.appendingPathComponent(String(letter))
        try Data(content.utf8).write(to: url)
        return HomeLink.File(name: Self.name(letter), url: url, bytes: declared ?? Int64(content.utf8.count))
    }

    private static func holding(held: [String] = [], staged: [String] = [], partly: [String: Int] = [:]) -> ScriptedTransport.Step {
        let body = try! JSONSerialization.data(withJSONObject: ["held": held, "staged": staged, "partly": partly], options: [.sortedKeys])
        return .reply(200, String(decoding: body, as: UTF8.self))
    }

    private static func missing(_ files: [String]) -> ScriptedTransport.Step {
        let body = try! JSONSerialization.data(withJSONObject: [
            "code": "FILES_MISSING", "message": "The home lacks files this bundle names: send them, then the bundle again.",
            "missing": ["files": files],
        ], options: [.sortedKeys])
        return .reply(409, String(decoding: body, as: UTF8.self))
    }

    private static func offset(held: Int) -> ScriptedTransport.Step {
        .reply(409, #"{"code":"UPLOAD_OFFSET","message":"Send from the byte the home holds.","held":\#(held)}"#)
    }

    private static let stored = ScriptedTransport.Step.reply(201, #"{"file":"stored"}"#)
    private static let landed = ScriptedTransport.Step.reply(201, Fixture.answer(received: 1, imported: 0))

    private static func said(_ requests: [HomeRequest]) -> [String] {
        requests.map { request in
            let path = request.url.path
            guard path.hasPrefix("/v1/files/") else { return request.method + " " + path }
            return request.method + " " + path + " from " + (request.headers[HomeLink.offsetHeader] ?? "none")
        }
    }

    private static func put(_ file: HomeLink.File, from offset: Int) -> String {
        "PUT /v1/files/\(file.name) from \(offset)"
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

    func testOnlyTheFilesTheDoorLacksAreSentAPartlyOneFirstFromItsBytesThenTheOrderGiven() async throws {
        let a = try file("a", "held"), b = try file("b", "staged"), c = try file("c", "ccc"),
            d = try file("d", "0123456789"), e = try file("e", "eeeee"), f = try file("f", "ffff")
        let (link, transport) = try await paired([
            Self.holding(held: [a.name], staged: [b.name], partly: [d.name: 4, f.name: 4]),
            Self.stored, Self.stored, Self.stored, Self.stored, Self.landed,
        ])
        let sent = try await link.send(bundle: try bundle(), id: id, files: [a, b, c, d, e, f], kind: .new)
        XCTAssertEqual(sent.sources[Fixture.source]?.received, 1)
        let requests = transport.requests
        XCTAssertEqual(Self.said(requests), [
            "POST /v1/blobs/held", Self.put(d, from: 4), Self.put(f, from: 4), Self.put(c, from: 0), Self.put(e, from: 0),
            "PUT /v1/bundles/\(id)",
        ], "the held and staged are skipped, the parts go first from the bytes the door holds, then the rest in order")
        XCTAssertEqual(try Fixture.object(requests[0])["blobs"] as? [String], [a, b, c, d, e, f].map(\.name),
                       "one ask names every file given")
        XCTAssertEqual(requests[1].body.size, 6, "a part goes on as the rest of its file")
        XCTAssertEqual(try Self.bytes(of: requests[1].body), Data("456789".utf8))
        XCTAssertEqual(requests[2].body, .empty, "a part holding every byte is joined by an empty body")
        XCTAssertEqual(requests[3].body, .file(c.url), "a file from its first byte is sent as the file")
        for request in requests[1...4] {
            XCTAssertEqual(request.headers[HomeLink.kindHeader], "new", "each file states the bundle's kind")
            XCTAssertEqual(request.headers["Content-Type"], "application/octet-stream")
        }
    }

    func testAnOffsetTheDoorDoesNotHoldIsSentOnceMoreFromTheHeldItNames() async throws {
        let c = try file("c", "0123456789")
        let (link, transport) = try await paired([Self.holding(), Self.offset(held: 3), Self.stored, Self.landed])
        _ = try await link.send(bundle: try bundle(), id: id, files: [c], kind: .new)
        XCTAssertEqual(Self.said(transport.requests), [
            "POST /v1/blobs/held", Self.put(c, from: 0), Self.put(c, from: 3), "PUT /v1/bundles/\(id)",
        ])
        XCTAssertEqual(try Self.bytes(of: transport.requests[2].body), Data("3456789".utf8))
    }

    func testASecondOffsetRefusalIsRefusedAndTheBundleIsNotSent() async throws {
        let c = try file("c", "0123456789")
        let (link, transport) = try await paired([Self.holding(), Self.offset(held: 3), Self.offset(held: 5)])
        do {
            _ = try await link.send(bundle: try bundle(), id: id, files: [c], kind: .new)
            XCTFail("a door that names another offset twice")
        } catch LinkFailure.refused(let status, let code, _) {
            XCTAssertEqual(status, 409)
            XCTAssertEqual(code, "UPLOAD_OFFSET")
        }
        XCTAssertEqual(Self.said(transport.requests), ["POST /v1/blobs/held", Self.put(c, from: 0), Self.put(c, from: 3)])
    }

    func testFilesMissingSendsTheNamedFilesItWasGivenAndTheBundleOnceMoreALostNameAmongThemNoRefusal() async throws {
        let a = try file("a", "aaa"), b = try file("b", "bbb")
        let lost = Self.name("9")
        let (link, transport) = try await paired([
            Self.holding(held: [a.name], staged: [b.name]), Self.missing([b.name, lost]), Self.stored, Self.landed,
        ])
        let sent = try await link.send(bundle: try bundle(), id: id, files: [a, b], kind: .new)
        XCTAssertEqual(sent.sources[Fixture.source]?.received, 1)
        XCTAssertEqual(Self.said(transport.requests), [
            "POST /v1/blobs/held", "PUT /v1/bundles/\(id)", Self.put(b, from: 0), "PUT /v1/bundles/\(id)",
        ], "the staged file the door dropped is sent again; the lost one, never listed, is the bundle's lost count")
    }

    func testFilesMissingNamingNoneGivenOrASecondTimeIsRefused() async throws {
        let a = try file("a", "aaa")
        let cases: [(String, [HomeLink.File], [ScriptedTransport.Step], Int)] = [
            ("names only a file it was not given", [a], [Self.holding(held: [a.name]), Self.missing([Self.name("9")])], 2),
            ("names a file it was given twice", [a], [Self.holding(held: [a.name]), Self.missing([a.name]), Self.stored,
                                                     Self.missing([a.name])], 4),
            ("a bundle given no files", [], [Self.missing([a.name])], 1),
        ]
        for (what, files, script, asked) in cases {
            let (link, transport) = try await paired(script)
            do {
                _ = try await link.send(bundle: try bundle(), id: id, files: files, kind: .new)
                XCTFail("refused: \(what)")
            } catch LinkFailure.refused(let status, let code, _) {
                XCTAssertEqual(status, 409, what)
                XCTAssertEqual(code, "FILES_MISSING", what)
            }
            XCTAssertEqual(transport.requests.count, asked, what)
        }
    }

    func testACutFileSendIsNotSentAgainAndTheNextSendAsksTheDoorAgain() async throws {
        let c = try file("c", "0123456789")
        let (link, transport) = try await paired([
            Self.holding(), .lost, Self.holding(partly: [c.name: 2]), Self.stored, Self.landed,
        ])
        do {
            _ = try await link.send(bundle: try bundle(), id: id, files: [c], kind: .new)
            XCTFail("a cut file send")
        } catch LinkFailure.noAnswer(let sent) {
            XCTAssertTrue(sent)
        }
        XCTAssertEqual(Self.said(transport.requests), ["POST /v1/blobs/held", Self.put(c, from: 0)],
                       "a file is no bundle: a cut is never sent again from its first byte")
        XCTAssertFalse(HomeLink.sentAgain("PUT /v1/files/<name>"))
        XCTAssertTrue(HomeLink.sentAgain("PUT /v1/bundles/<id>"), "a bundle, not resumable, is safe to send again")
        _ = try await link.send(bundle: try bundle(), id: id, files: [c], kind: .new)
        XCTAssertEqual(Array(Self.said(transport.requests).dropFirst(2)), [
            "POST /v1/blobs/held", Self.put(c, from: 2), "PUT /v1/bundles/\(id)",
        ], "the next send goes on from the bytes the door kept")
    }

    func testAFileOverLowDatasBoundWaitsAndSendsNothingOfIt() async throws {
        let small = try file("a", "aaa"), large = try file("b", "bbb", declared: MobileData.largeBytes)
        let network = MovableNetwork(NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: false, path: 1, cost: .lowData))
        let (link, transport) = try await paired([Self.holding(), Self.stored, Self.landed], network: network)
        do {
            _ = try await link.send(bundle: try bundle(), id: id, files: [small, large], kind: .new)
            XCTFail("a large file on Low Data Mode")
        } catch LinkFailure.waits(let wait) {
            XCTAssertEqual(wait, .lowData)
        }
        XCTAssertEqual(Self.said(transport.requests), ["POST /v1/blobs/held", Self.put(small, from: 0)],
                       "the small file goes; the large one and the bundle that names it wait")
        XCTAssertEqual(transport.requests[1].crossing, MobileData.Crossing(costly: true, lowData: true))
    }

    func testAMacCallWithNoFilesMakesExactlyTodaysOneRequest() async throws {
        let wifi = MovableNetwork(NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: false, path: 1, cost: .free))
        let (link, transport) = try await paired([Self.landed], device: mac, network: wifi)
        let file = try bundle()
        _ = try await link.send(bundle: file, id: "upload:local:unit-0001/2", kind: .later)
        XCTAssertEqual(Self.said(transport.requests), ["PUT /v1/acquisitions/upload:local:unit-0001/2"])
        XCTAssertEqual(transport.requests.first?.body, .file(file))
        XCTAssertNil(transport.requests.first?.headers[HomeLink.offsetHeader])
    }
}

private extension HomeRequest.Body {
    var size: Int64? {
        guard case .stream(let size, _) = self else { return nil }
        return size
    }
}
