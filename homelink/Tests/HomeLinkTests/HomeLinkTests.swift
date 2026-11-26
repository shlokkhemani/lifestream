import Foundation
import XCTest
@testable import HomeLink

final class HomeLinkTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private let mac = HomeLink.Device(kind: .mac, version: "0.2.0", model: "MacBook Pro", serial4: "0001")
    private let home = "https://lifestream.example.ts.net"

    private let phone = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil)

    private func link(_ transport: ScriptedTransport, credentials: MemoryCredentials = MemoryCredentials(),
                      device: HomeLink.Device? = nil, network: (any NetworkWatch)? = nil) -> HomeLink {
        HomeLink(device: device ?? mac, credentials: credentials, folder: folder, transport: transport, network: network)
    }

    private func paired(_ transport: ScriptedTransport, device: HomeLink.Device? = nil,
                        name: String? = nil, network: (any NetworkWatch)? = nil) async throws -> (link: HomeLink, pass: String) {
        let credentials = MemoryCredentials()
        let device = device ?? mac
        let pairing = ScriptedTransport([.reply(200, Fixture.paired())])
        _ = try await link(pairing, credentials: credentials, device: device)
            .pair(code: "12345678", name: name ?? home, account: device.kind == .phone ? Fixture.account : nil)
        let pass = try XCTUnwrap(Fixture.object(pairing.requests[0])["pass"] as? String)
        return (link(transport, credentials: credentials, device: device, network: network), pass)
    }


    func testPairingSendsItsOwnPassStoredBeforeItAsked() async throws {
        let credentials = MemoryCredentials()
        let transport = ScriptedTransport([.reply(200, Fixture.paired())])
        transport.onPerform = { _ in XCTAssertNotNil(try? credentials.read(), "the pass is stored before it is sent") }
        let fresh = try await link(transport, credentials: credentials)
            .pair(code: "12345678", name: home, offers: ["chrome:profile-2:macbook-pro-0001", "chrome:default:macbook-pro-0001"])

        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.absoluteString, "https://lifestream.example.ts.net/v1/pair")
        XCTAssertEqual(request.headers["Lifestream-Device"], "mac/0.2.0")
        XCTAssertNil(request.headers["Authorization"], "pairing has no pass to show yet")
        let body = try Fixture.object(request)
        XCTAssertEqual(body["code"] as? String, "12345678")
        XCTAssertEqual(body["kind"] as? String, "mac")
        XCTAssertEqual(body["model"] as? String, "MacBook Pro")
        XCTAssertEqual(body["serial4"] as? String, "0001")
        XCTAssertEqual(body["offers"] as? [String], ["chrome:default:macbook-pro-0001", "chrome:profile-2:macbook-pro-0001"])
        let pass = try XCTUnwrap(body["pass"] as? String)
        XCTAssertEqual(pass.count, 43, "32 bytes, base64url without padding")
        XCTAssertTrue(pass.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
        XCTAssertEqual(fresh.pass, "p-00000001")
        XCTAssertEqual(fresh.unit, "macbook-pro-0001")
        XCTAssertEqual(try link(transport, credentials: credentials).name()?.absoluteString, home)
        let elsewhere = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        XCTAssertEqual(HomeLink(device: mac, credentials: credentials, folder: elsewhere, transport: transport).unit,
                       "macbook-pro-0001", "the unit is kept with the pass, without the saved answer")
    }

    func testThePassFileKeepsTheHomesAddressesUnderItsOneKey() async throws {
        let credentials = MemoryCredentials()
        let listed = ["https://mac-a.local:4682", "https://100.81.6.81:4682"]
        try credentials.write(try JSONSerialization.data(withJSONObject: [
            "name": "https://mac-a.local:4682", "pass": "a-pass", "paired": true, "pin": String(repeating: "A", count: 52), "addresses": listed,
        ]))
        let transport = ScriptedTransport([.reply(200, Fixture.answer(received: 0, imported: 0, extra: #","addresses":["https://100.81.6.81:4682"]"#))])
        let device = link(transport, credentials: credentials, device: phone)
        XCTAssertEqual(try device.addresses().map(\.absoluteString), listed, "read back as kept")
        _ = try await device.exchange()
        let stored = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(credentials.read())) as? [String: Any])
        XCTAssertEqual(stored["addresses"] as? [String], ["https://100.81.6.81:4682"], "a new list is written under the same key")
        XCTAssertNil(stored["listed"])
    }

    func testAMacPairedAtLoopbackAsksThereWhateverTheAnswerListsAndAPhoneFollowsTheList() async throws {
        let addresses = #","addresses":["https://mac-a.local:4682","https://100.81.6.81:4682","https://mac-a.local:4682","http://100.81.6.81:4680"]"#
        let listed = #"{"unit":"macbook-pro-0001","answer":"# + Fixture.answer(received: 0, imported: 0, extra: addresses) + "}"
        let macTransport = ScriptedTransport([.reply(200, listed), .reply(200, Fixture.answer(received: 0, imported: 0))])
        let macLink = link(macTransport)
        _ = try await macLink.pair(code: "12345678", name: "http://127.0.0.1:4680", offers: [])
        XCTAssertEqual(try macLink.addresses().map(\.absoluteString), ["http://127.0.0.1:4680"],
                       "no https address without a pin, no plain http but where it paired")
        XCTAssertNil(try macLink.pin(), "a pairing at loopback holds no certificate")
        _ = try await macLink.exchange()
        XCTAssertEqual(macTransport.requests[1].url.absoluteString, "http://127.0.0.1:4680/v1/exchange", "after pairing, still loopback")

        let phoneTransport = ScriptedTransport([.reply(200, listed), .reply(200, Fixture.answer(received: 0, imported: 0))])
        let phoneLink = link(phoneTransport, device: phone)
        let pairing = try XCTUnwrap(PairingLink("lifestream://pair?code=12345678&host=mac-a.local&port=4682&fp=\(String(repeating: "A", count: 52))"))
        _ = try await phoneLink.pair(pairing, account: Fixture.account, name: "iPhone")
        XCTAssertEqual(try phoneLink.addresses().map(\.absoluteString), ["https://mac-a.local:4682", "https://100.81.6.81:4682"],
                       "the answer's list, each once, every one TLS to the pin")
        XCTAssertEqual(try phoneLink.pin(), String(repeating: "A", count: 52), "the link's certificate is the home it holds to")
        _ = try await phoneLink.exchange()
        XCTAssertTrue(["https://mac-a.local:4682/v1/exchange", "https://100.81.6.81:4682/v1/exchange"]
            .contains(phoneTransport.requests[1].url.absoluteString))
        XCTAssertEqual(phoneTransport.requests[1].pin, String(repeating: "A", count: 52))
    }

    func testTheWalkOverAddressesSpendsTheResendSoNoThirdSendGoes() async throws {
        let addresses = #","addresses":["https://mac-a.local:4682","https://100.81.6.81:4682"]"#
        let listed = #"{"unit":"iphone-aa01","answer":"# + Fixture.answer(received: 0, imported: 0, extra: addresses) + "}"
        let transport = ScriptedTransport([.reply(200, listed), .lost])
        let phoneLink = link(transport, device: phone)
        let pairing = try XCTUnwrap(PairingLink("lifestream://pair?code=12345678&host=mac-a.local&port=4682&fp=\(String(repeating: "A", count: 52))"))
        _ = try await phoneLink.pair(pairing, account: Fixture.account, name: "iPhone")
        do { _ = try await phoneLink.act(.people(request: "r-1", .undo(act: "a-1"))); XCTFail("no answer") } catch LinkFailure.noAnswer(sent: true) {}
        let acts = Array(transport.requests.dropFirst())
        XCTAssertEqual(acts.map(\.url.path), ["/v1/owner/act", "/v1/owner/act"], "the second address is the second send; no third goes")
        XCTAssertEqual(Set(acts.map { $0.url.host ?? "" }), ["mac-a.local", "100.81.6.81"], "a send to another address is a resend")
        XCTAssertEqual(acts.map { $0.headers[HomeLink.waitHeader] }, ["10000", "10000"])
        XCTAssertEqual(acts[0].body, acts[1].body, "the same request")
    }

    func testAResendGoesOnlyWithThreeSecondsLeftAndWaitsWhatIsLeft() async throws {
        let credentials = MemoryCredentials()
        _ = try await link(ScriptedTransport([.reply(200, Fixture.paired())]), credentials: credentials).pair(code: "12345678", name: home)
        let clock = TestClock(Date(timeIntervalSince1970: 1_800_000_000))
        let unknown = #"{"code":"OUTCOME_UNKNOWN","message":"Lifestream didn't answer.","again":true,"began":false}"#
        let sent = { (seconds: TimeInterval) async throws -> ScriptedTransport in
            let transport = ScriptedTransport([.reply(503, unknown)])
            transport.onPerform = { _ in clock.advance(seconds) }
            let timed = HomeLink(device: self.mac, credentials: credentials, folder: self.folder, transport: transport, clock: { clock.now })
            do { _ = try await timed.act(.people(request: "r-1", .undo(act: "a-1"))); XCTFail("unknown") } catch let failure as LinkFailure {
                XCTAssertEqual(failure, .unanswered(again: true, began: false), "the first try's word, never a reach failure")
            }
            return transport
        }
        let quick = try await sent(9)
        XCTAssertEqual(quick.requests.map { $0.headers[HomeLink.waitHeader] }, ["10000", "6000"], "the second waits what is left")
        XCTAssertEqual(quick.requests.map(\.timeout), [10, 6])
        let slow = try await sent(12.5)
        XCTAssertEqual(slow.requests.count, 1, "with 2.5 s left the resend would be refused before it could begin: it never goes")
    }

    func testEveryActAndRelayedReadSaysItsWaitAndNoOtherRequestDoes() async throws {
        let transport = ScriptedTransport([
            .reply(200, #"{"asks":[],"position":"1:0","requests":[],"today":"2026-11-14"}"#), .reply(200, Fixture.answer(received: 0, imported: 0)), .reply(200, "{}"),
            .reply(200, #"{"state":"queued"}"#),
        ])
        let (device, _) = try await paired(transport, device: phone)
        _ = try await device.page(HomeLink.PageKey(HomeLink.Pages.AgentsWaiting.route), etag: nil)
        _ = try await device.exchange()
        _ = try await device.get("/v1/status")
        _ = try await device.refresh(connector: "example-log")
        XCTAssertEqual(transport.requests.map { $0.headers[HomeLink.waitHeader] }, ["10000", nil, nil, "10000"],
                       "a relayed read and an act say their wait; the exchange and a read the door answers do not")
        XCTAssertEqual(transport.requests.map(\.timeout), [Budget.each, HomeLink.silence, HomeLink.silence, Budget.each])
    }

    func testARequestThatChangesSomethingIsNeverSentAgainAtAnotherAddressAndAReadIs() async throws {
        let addresses = #","addresses":["https://mac-a.local:4682","https://100.81.6.81:4682"]"#
        let listed = #"{"unit":"iphone-aa01","answer":"# + Fixture.answer(received: 0, imported: 0, extra: addresses) + "}"
        let transport = ScriptedTransport([
            .reply(200, listed),
            .unreachable,
            .unreachable, .reply(200, #"{"recipe":2}"#), .reply(200, "a tile"),
        ])
        let phoneLink = link(transport, device: phone)
        let pairing = try XCTUnwrap(PairingLink("lifestream://pair?code=12345678&host=mac-a.local&port=4682&fp=\(String(repeating: "A", count: 52))"))
        _ = try await phoneLink.pair(pairing, account: Fixture.account, name: "iPhone")
        do { try await phoneLink.act(need: "poll:chat", do: "try"); XCTFail("no answer") } catch LinkFailure.noAnswer {}
        XCTAssertEqual(transport.requests.count, 2, "a need's act sent again at the other address")
        let tile = try await phoneLink.picture(Restore.sha256(Data("a photo".utf8)), size: .tile)
        XCTAssertEqual(tile, Data("a tile".utf8), "a read goes on to the other address")
        XCTAssertEqual(Set(transport.requests[2...3].map { $0.url.host ?? "" }), ["mac-a.local", "100.81.6.81"], "the recipe's read")
    }

    func testARetryAfterNoAnswerSendsTheSamePassAndPairingAgainMakesANewOne() async throws {
        let credentials = MemoryCredentials()
        let transport = ScriptedTransport([.unreachable, .unreachable, .reply(200, Fixture.paired()), .reply(200, Fixture.paired())])
        let device = link(transport, credentials: credentials)
        do {
            _ = try await device.pair(code: "12345678", name: home, offers: [])
            XCTFail("no answer")
        } catch LinkFailure.noAnswer {}
        XCTAssertEqual(transport.requests.count, 2, "a pairing whose answer was lost is sent once more, never a third time")
        XCTAssertNil(try device.name(), "not paired until the home answers")
        _ = try await device.pair(code: "12345678", name: home, offers: [])
        let first = try Fixture.object(transport.requests[0])["pass"] as? String
        XCTAssertEqual(try transport.requests[1...2].map { try Fixture.object($0)["pass"] as? String }, [first, first])
        _ = try await device.pair(code: "87654321", name: home, offers: [])
        XCTAssertNotEqual(try Fixture.object(transport.requests[3])["pass"] as? String, first)
    }

    func testARetryAtAnotherAddressOfTheSameHomeSendsTheSamePass() async throws {
        let credentials = MemoryCredentials()
        let transport = ScriptedTransport([.unreachable, .unreachable, .reply(200, Fixture.paired()), .reply(200, Fixture.paired())])
        let device = link(transport, credentials: credentials, device: phone)
        let certificate = String(repeating: "A", count: 52)
        let wifi = FoundHome(address: URL(string: "https://mac-a.local:4682")!, fingerprint: certificate)
        let tailnet = FoundHome(address: URL(string: "https://100.81.6.81:4682")!, fingerprint: certificate)
        do {
            _ = try await device.pair(code: "12345678", at: wifi, account: Fixture.account)
            XCTFail("the answer was lost")
        } catch LinkFailure.noAnswer {}
        XCTAssertNil(try device.pin(), "no certificate held until the home answers")
        _ = try await device.pair(code: "12345678", at: tailnet, account: Fixture.account)
        let first = try Fixture.object(transport.requests[0])["pass"] as? String
        XCTAssertEqual(transport.requests.map { $0.url.host }, ["mac-a.local", "mac-a.local", "100.81.6.81"])
        XCTAssertEqual(try Fixture.object(transport.requests[2])["pass"] as? String, first,
                       "the same home by another road is the same attempt, so the home answers it as it did")
        XCTAssertEqual(try device.name()?.absoluteString, "https://100.81.6.81:4682", "paired where the answer came")
        XCTAssertEqual(try device.pin(), certificate, "the same home by either road")
        _ = try await device.pair(code: "87654321", at: wifi, account: Fixture.account)
        XCTAssertNotEqual(try Fixture.object(transport.requests[3])["pass"] as? String, first, "pairing again makes a new one")
    }

    func testARefusedPairingAgainKeepsThePairingInUse() async throws {
        let credentials = MemoryCredentials()
        let transport = ScriptedTransport([
            .reply(200, Fixture.paired()),
            .reply(403, #"{"code":"PAIR_CODE","message":"that code is not one the home holds"}"#),
            .reply(200, Fixture.answer(received: 0, imported: 0)),
        ])
        let device = link(transport, credentials: credentials)
        _ = try await device.pair(code: "12345678", name: home, offers: [])
        let first = try Fixture.object(transport.requests[0])["pass"] as? String
        do {
            _ = try await device.pair(code: "87654321", name: home, offers: [])
            XCTFail("refused")
        } catch LinkFailure.refused {}
        XCTAssertEqual(try device.name()?.absoluteString, home, "a refused pairing again unpairs nothing")
        _ = try await device.exchange()
        XCTAssertEqual(transport.requests[2].headers["Authorization"], "Bearer \(first!)", "the pass in use still asks")
    }

    func testThePassFileIsThisUsersAloneOutOfBackupsAndReplacedWhole() throws {
        let file = folder.appendingPathComponent("ship/credentials.json")
        let credentials = FileCredentials(url: file)
        XCTAssertNil(try credentials.read(), "no file, no pass")
        try credentials.write(Data("first".utf8))
        try credentials.write(Data("second".utf8))
        XCTAssertEqual(try credentials.read(), Data("second".utf8))
        let mode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int)
        XCTAssertEqual(mode & 0o777, 0o600)
        XCTAssertEqual(try file.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: file.deletingLastPathComponent().path), ["credentials.json"],
                       "no temporary file is left beside it")
        try credentials.delete()
        XCTAssertNil(try credentials.read())
        try credentials.delete()
    }

    func testThePhoneStatesNoSerialAndRefusalsKeepTheirCodes() async throws {
        let transport = ScriptedTransport([
            .reply(403, #"{"code":"PAIR_CODE","message":"that code is not one the home holds"}"#),
            .reply(409, #"{"code":"PAIR_UNIT_EXISTS","message":"that unit is paired"}"#),
            .reply(503, #"{"code":"NOT_NOW","message":"Your home is starting: it answers in a moment."}"#, ["retry-after": "5"]),
        ])
        let phone = link(transport, device: phone)
        for expected in [LinkFailure.refused(status: 403, code: "PAIR_CODE", message: "that code is not one the home holds"),
                         .refused(status: 409, code: "PAIR_UNIT_EXISTS", message: "that unit is paired"),
                         .unavailable(code: "NOT_NOW", message: "Your home is starting: it answers in a moment.", retryAfter: 5, notNow: .busy)] {
            do {
                _ = try await phone.pair(code: "12345678", name: home, account: Fixture.account)
                XCTFail("refused")
            } catch let failure as LinkFailure {
                XCTAssertEqual(failure, expected)
            }
        }
        XCTAssertNil(try Fixture.object(transport.requests[0])["serial4"])
        XCTAssertEqual(transport.requests[0].headers["Lifestream-Device"], "phone/1.4.0")
    }

    func testThePhoneMayStateItsAppleIDAtPairingAndNoOtherDeviceDoes() async throws {
        let transport = ScriptedTransport([.reply(200, Fixture.paired())])
        _ = try await link(transport, device: phone)
            .pair(code: "12345678", name: home, account: " person-a@example.com\n")
        XCTAssertEqual(try Fixture.object(transport.requests[0])["account"] as? String, "person-a@example.com",
                       "as the person confirmed it, trimmed")
        XCTAssertEqual(try Fixture.object(transport.requests[0])["offers"] as? [String], [])

        let mac = ScriptedTransport([.reply(200, Fixture.paired())])
        _ = try await link(mac).pair(code: "12345678", name: home)
        XCTAssertNil(try Fixture.object(mac.requests[0])["account"], "a Mac states no account")

        for account in [nil, " "] as [String?] {
            let none = ScriptedTransport([.reply(200, Fixture.paired())])
            _ = try await link(none, device: phone).pair(code: "12345678", name: home, account: account)
            XCTAssertNil(try Fixture.object(none.requests[0])["account"], "an Apple ID is the phone's to state or leave out")
        }

        for (device, account) in [(phone, "person-a"), (self.mac, "person-a@example.com")] as [(HomeLink.Device, String?)] {
            let refused = ScriptedTransport([.reply(200, Fixture.paired())])
            do {
                _ = try await link(refused, device: device).pair(code: "12345678", name: home, account: account)
                XCTFail("\(device.kind) with \(account ?? "no account")")
            } catch let failure as LinkFailure {
                XCTAssertEqual(failure, .account)
            }
            XCTAssertTrue(refused.requests.isEmpty, "nothing reaches the home")
        }
    }

    func testAPhonePairedWithNoAppleIDStatesItOnceLaterAndItsAnswerNamesIt() async throws {
        let health = #"{"home":{"id":"h-0001","version":"0.2.0","floors":{}},"pass":"p-00000001","unit":"iphone-17-pro","account":"person-a@example.com","#
            + #""sources":{"location:local:iphone-17-pro":{"received":0,"imported":0,"formats":["v1"],"history":true},"#
            + #""apple-health:person-a@example.com:cloud":{"received":0,"imported":0,"formats":["v1"],"history":true}},"#
            + #""owner":[],"needs":[],"calls":[],"settings":{},"turn":{"run":"00000000000000aa","n":1}}"#
        let transport = ScriptedTransport([.reply(200, Fixture.paired()), .reply(200, #"{"sources":["apple-health:person-a@example.com:cloud"]}"#),
                                           .reply(200, health),
                                           .reply(409, #"{"code":"ACCOUNT_SET","message":"This iPhone's Apple ID is set already."}"#),
                                           .reply(200, health)])
        let phone = link(transport, device: phone)
        let paired = try await phone.pair(code: "12345678", name: home, account: nil)
        XCTAssertNil(paired.account, "no Apple ID stated: none named")
        let stated = try await phone.state(account: " person-a@example.com\n")
        XCTAssertEqual(transport.requests[1].method, "POST")
        XCTAssertEqual(transport.requests[1].url.path, "/v1/account")
        XCTAssertEqual(try Fixture.object(transport.requests[1]) as? [String: String], ["account": "person-a@example.com"])
        XCTAssertNotNil(transport.requests[1].headers["Authorization"], "on the phone's own pass")
        XCTAssertEqual(transport.requests[2].url.path, "/v1/exchange", "the exchange brings the sources made")
        XCTAssertEqual(stated.account, "person-a@example.com")
        XCTAssertEqual(phone.saved?.account, "person-a@example.com", "kept: the phone shows it, set once")
        do {
            _ = try await phone.state(account: "person-b@example.com")
            XCTFail("a second Apple ID was taken")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure.code, "ACCOUNT_SET")
        }
        XCTAssertEqual(transport.requests[4].url.path, "/v1/exchange")
        XCTAssertEqual(phone.saved?.account, "person-a@example.com", "the phone shows the Apple ID the home holds, never the one typed")

        let mac = ScriptedTransport([.reply(200, Fixture.paired())])
        let macLink = link(mac)
        _ = try await macLink.pair(code: "12345678", name: home)
        for (device, text) in [(macLink, "person-a@example.com"), (phone, "person-a")] {
            do {
                _ = try await device.state(account: text)
                XCTFail("stated \(text)")
            } catch let failure as LinkFailure {
                XCTAssertEqual(failure, .account)
            }
        }
        XCTAssertEqual(mac.requests.count, 1, "nothing reaches the home")
    }

    func testAnAppleIDIsAnEmailAddressOrAPhoneNumber() throws {
        for (typed, account) in [("person-a@example.com", "person-a@example.com"), ("  +1 555 000 0001 ", "+1 555 000 0001"),
                                 ("(555) 000-0001", "(555) 000-0001"), ("+15550000001", "+15550000001")] {
            XCTAssertEqual(try HomeLink.account(typed), account)
        }
        for refused in ["", "person-a", "person-a@example", "@example.com", "person a@example.com", "a@b@example.com",
                        "+1 555", "555-CALL-NOW", "person-a@.example.com"] {
            XCTAssertThrowsError(try HomeLink.account(refused), refused)
        }
    }

    func testANameIsHttpsOrAPrivateAddress() throws {
        XCTAssertEqual(try HomeLink.name("https://lifestream.example.ts.net/").absoluteString, home)
        XCTAssertEqual(try HomeLink.name("http://127.0.0.1:4680").absoluteString, "http://127.0.0.1:4680")
        XCTAssertEqual(try HomeLink.name("http://100.101.102.103:4680").absoluteString, "http://100.101.102.103:4680")
        for refused in ["http://home.example.com", "http://lifestream.example.ts.net:4680", "ftp://127.0.0.1", "https://lifestream.example.ts.net/v1",
                        "https://user@lifestream.example.ts.net", "lifestream"] {
            XCTAssertThrowsError(try HomeLink.name(refused), refused)
        }
    }


    func testAnExchangeCarriesThePassAndTheHeaderAndItsAnswerIsSaved() async throws {
        let transport = ScriptedTransport([.reply(200, Fixture.answer(received: 4, imported: 2,
                                                                      extra: #","later":{"x":1}"#))])
        let (device, pass) = try await paired(transport, name: "http://127.0.0.1:4680")
        let fresh = try await device.exchange(offers: ["b", "a"])

        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.url.absoluteString, "http://127.0.0.1:4680/v1/exchange")
        XCTAssertEqual(request.headers["Authorization"], "Bearer \(pass)")
        XCTAssertEqual(request.headers["Lifestream-Device"], "mac/0.2.0")
        XCTAssertEqual(try Fixture.object(request)["offers"] as? [String], ["a", "b"])
        XCTAssertEqual(fresh.sources[Fixture.source], Answer.Custody(received: 4, imported: 2, formats: ["v1"], history: true))
        XCTAssertEqual(fresh.home.floors["mac"], "0.1.0")
        XCTAssertEqual(fresh.needs.map(\.words), ["Plug in the drive"], "the home's one list of needs; one that does not read is left out")

        let saved = try XCTUnwrap(link(transport).saved)
        XCTAssertEqual(saved.sources, fresh.sources)
        XCTAssertEqual(saved.pass, fresh.pass)
        let file = try String(contentsOf: folder.appendingPathComponent("answer.json"), encoding: .utf8)
        XCTAssertFalse(file.contains(pass), "the saved answer never holds the pass")
        XCTAssertTrue(file.contains("later"), "a member this release does not know is kept")
    }

    func testAnUnpairedDeviceAsksNothing() async throws {
        let transport = ScriptedTransport([])
        do {
            _ = try await link(transport).exchange()
            XCTFail("unpaired")
        } catch LinkFailure.unpaired {}
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testARefusalOrAnAnswerMissingWhatTheHomeAlwaysWritesIsNotAnAnswer() throws {
        XCTAssertNil(Answer(body: Data(#"{"code":"PRINCIPAL_UNKNOWN","message":"no"}"#.utf8)))
        let answer = { (received: String, imported: String) in
            Fixture.answer(received: 0, imported: 0).replacingOccurrences(of: #""received":0,"imported":0"#, with: #""received":\#(received),"imported":\#(imported)"#)
        }
        XCTAssertNil(Answer(body: Data(answer("1", "2").utf8)), "imported never passes received")
        XCTAssertNil(Answer(body: Data(answer("true", "0").utf8)))
        XCTAssertNotNil(Answer(body: Data(Fixture.answer(received: 0, imported: 0, extra: #","new":[1]"#).utf8)), "a member it does not know is kept")
        let whole = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(Fixture.answer(received: 0, imported: 0).utf8)) as? [String: Any])
        for member in ["home", "pass", "unit", "sources", "owner", "needs", "calls", "settings", "turn"] {
            var lacking = whole
            lacking[member] = nil
            XCTAssertNil(Answer(body: try JSONSerialization.data(withJSONObject: lacking)), member)
        }
        for (member, of) in [("id", "home"), ("version", "home"), ("floors", "home"), ("run", "turn"), ("n", "turn")] {
            var lacking = whole
            var inner = try XCTUnwrap(whole[of] as? [String: Any])
            inner[member] = nil
            lacking[of] = inner
            XCTAssertNil(Answer(body: try JSONSerialization.data(withJSONObject: lacking)), "\(of).\(member)")
        }
        for member in ["formats", "history"] {
            XCTAssertNil(Answer(body: Data(Fixture.answer(received: 0, imported: 0)
                .replacingOccurrences(of: member == "formats" ? #","formats":["v1"]"# : #","history":true"#, with: "").utf8)), "a source's \(member)")
        }
        XCTAssertEqual(Answer(body: Data(Fixture.answer(received: 0, imported: 0, extra: #","clock":"149e7dc8591bf2d4""#).utf8))?.clock,
                       "149e7dc8591bf2d4")
        XCTAssertNil(Answer(body: Data(Fixture.answer(received: 0, imported: 0).utf8))?.clock)
        let held = Answer(body: Data(Fixture.answer(received: 0, imported: 0, history: false).utf8))
        XCTAssertEqual(held?.sources[Fixture.source]?.history, false)
    }


    func testABundleGoesToItsKindsRouteWithItsIdAsStated() async throws {
        let bundle = folder.appendingPathComponent("b.zip")
        try Data("zip".utf8).write(to: bundle)
        let transport = ScriptedTransport([.reply(201, Fixture.answer(received: 1, imported: 0))])
        let (device, _) = try await paired(transport)
        let fresh = try await device.send(bundle: bundle, id: "imessage:a@example.com:unit-0001/20260924T173000.250Z", kind: .new)
        XCTAssertEqual(fresh.sources[Fixture.source]?.received, 1)
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.method, "PUT")
        XCTAssertEqual(request.url.absoluteString,
                       "https://lifestream.example.ts.net/v1/acquisitions/imessage:a@example.com:unit-0001/20260924T173000.250Z")
        XCTAssertEqual(request.body, .file(bundle))
        XCTAssertNil(request.progress, "no one hears an upload no one asked to hear")

        let heard = Heard()
        let progressing = ScriptedTransport([.reply(201, Fixture.answer(received: 2, imported: 0))])
        let (mac, _) = try await paired(progressing, network: MovableNetwork(.home))
        _ = try await mac.send(bundle: bundle, id: "upload:local:unit-0001/2", kind: .later, sent: { heard.add($0) })
        let progress = try XCTUnwrap(progressing.requests.first?.progress)
        progress.heard(1)
        progress.heard(3)
        XCTAssertEqual(heard.all, [1, 3])

        let phoneTransport = ScriptedTransport([.reply(201, Fixture.answer(received: 1, imported: 0))])
        let (phone, _) = try await paired(phoneTransport, device: phone)
        _ = try await phone.send(bundle: bundle, id: "install-0001-7", kind: .new)
        XCTAssertEqual(phoneTransport.requests.first?.url.absoluteString, "https://lifestream.example.ts.net/v1/bundles/install-0001-7")
    }

    func testStaleCarriesTheAnswerAndHeldBundlesAreNotRefusals() async throws {
        let bundle = folder.appendingPathComponent("b.zip")
        try Data("zip".utf8).write(to: bundle)
        let transport = ScriptedTransport([
            .reply(409, #"{"code":"STALE","message":"seal 5 is not the next","answer":"# + Fixture.answer(received: 2, imported: 2) + "}"),
            .reply(422, #"{"code":"CLOCK_AHEAD","message":"ahead"}"#),
            .reply(422, #"{"code":"ACQUISITION_MANIFEST","message":"bad"}"#),
            .reply(426, #"{"code":"DEVICE_TOO_OLD","message":"update","floor":"0.3.0"}"#),
        ])
        let (device, _) = try await paired(transport)
        do { _ = try await device.send(bundle: bundle, id: "s/1", kind: .new); XCTFail("stale") } catch LinkFailure.stale(let answer) {
            XCTAssertEqual(answer.sources[Fixture.source]?.received, 2)
        }
        do { _ = try await device.send(bundle: bundle, id: "s/1", kind: .new); XCTFail("ahead") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .clockAhead)
        }
        do { _ = try await device.send(bundle: bundle, id: "s/1", kind: .new); XCTFail("refused") } catch let failure as LinkFailure {
            XCTAssertEqual(failure.code, "ACQUISITION_MANIFEST")
        }
        do { _ = try await device.send(bundle: bundle, id: "s/1", kind: .new); XCTFail("too old") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .tooOld(floor: "0.3.0"))
        }
        XCTAssertEqual(transport.requests.count, 4)
    }

    func testAFloorFromTheAnswerHoldsBundlesBeforeTheyLeave() async throws {
        let bundle = folder.appendingPathComponent("b.zip")
        try Data("zip".utf8).write(to: bundle)
        let transport = ScriptedTransport([.reply(200, Fixture.answer(received: 0, imported: 0, macFloor: "0.10.0"))])
        let (device, _) = try await paired(transport)
        _ = try await device.exchange()
        do { _ = try await device.send(bundle: bundle, id: "s/1", kind: .new); XCTFail("too old") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .tooOld(floor: "0.10.0"), "0.2.0 is older than 0.10.0, numerically")
        }
        XCTAssertEqual(transport.requests.count, 1)
    }

    func testABundleMayBeSilentFiveMinutesAndNoLonger() async throws {
        let bundle = folder.appendingPathComponent("b.zip")
        try Data("zip".utf8).write(to: bundle)
        let transport = ScriptedTransport([.reply(201, Fixture.answer(received: 1, imported: 0))])
        let (device, _) = try await paired(transport)
        _ = try await device.send(bundle: bundle, id: "s/1", kind: .new)
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.timeout, 5 * 60)
        XCTAssertEqual(URLSessionTransport.made(request).timeoutInterval, 5 * 60, "five silent minutes, not the upload's six hours")
        XCTAssertEqual(URLSessionTransport.uploadLifetime, 6 * 3600)
    }

    func testEveryRequestButAnUploadMayBeSilentAMinute() async throws {
        let credentials = MemoryCredentials()
        let answer = Fixture.answer(received: 0, imported: 0)
        let transport = ScriptedTransport([
            .reply(200, Fixture.paired()), .reply(200, answer), .reply(200, answer),
            .reply(200, #"{"act":null,"id":"place:synthetic-gym-0a0b0c","position":"7:1791000000000"}"#),
            .reply(200, #"{"places":[],"spots":[]}"#), .reply(200, #"{"pass":"p-00000001","unit":"iphone-17-pro-0042","since":{},"types":{},"domains":{},"contacts":{}}"#),
            .reply(201, answer),
        ])
        let device = link(transport, credentials: credentials, device: phone)
        _ = try await device.pair(code: "12345678", name: home, account: Fixture.account)
        _ = try await device.exchange()
        _ = try await device.exchange()
        let edit = folder.appendingPathComponent("edit.zip")
        try Data("zip".utf8).write(to: edit)
        _ = try await device.act(.places(request: "r-1", .remove(slug: "synthetic-gym-0a0b0c")))
        _ = try await device.places(etag: nil)
        _ = try await device.restore()
        _ = try await device.send(bundle: edit, id: "sha256:00aa", kind: .new)

        XCTAssertEqual(HomeLink.silence, 60)
        XCTAssertEqual(transport.requests.map(\.timeout), [Budget.each, 60, 60, Budget.each, 60, 60, 5 * 60],
                       "pairing and an owner's edit an act's try; the exchange, a read and the restore a minute; an upload five")
        XCTAssertEqual(transport.requests.map { URLSessionTransport.made($0).timeoutInterval },
                       [Budget.each, 60, 60, Budget.each, 60, 60, 5 * 60])

        let gone = link(ScriptedTransport([.unreachable]), device: phone)
        do { _ = try await gone.pair(code: "12345678", name: home, account: Fixture.account); XCTFail("refused") }
        catch let failure as LinkFailure {
            XCTAssertEqual(failure, .noAnswer(sent: false))
            XCTAssertEqual(String(describing: failure), "not sent", "log words: the reach state is what a screen says")
        }
    }

    func testAPhonesBundleGoesOnItsOwnRouteStatingItsKindAndCrossesThePathsItsRuleAllows() async throws {
        let bundle = folder.appendingPathComponent("b.zip")
        try Data("zip".utf8).write(to: bundle)
        let large = folder.appendingPathComponent("large.zip")
        FileManager.default.createFile(atPath: large.path, contents: nil)
        let handle = try FileHandle(forWritingTo: large)
        try handle.truncate(atOffset: UInt64(MobileData.largeBytes))
        try handle.close()
        let transport = ScriptedTransport(Array(repeating: .reply(201, Fixture.answer(received: 1, imported: 0)), count: 4))
        let (device, pass) = try await paired(transport, device: phone, network: MovableNetwork(.home))
        let sent = try await device.send(bundle: bundle, id: "sha256:00aa", kind: .new)
        XCTAssertEqual(sent.sources[Fixture.source]?.received, 1)
        _ = try await device.send(bundle: bundle, id: "sha256:00ab", kind: .later)
        _ = try await device.send(bundle: large, id: "sha256:00ac", kind: .new)
        _ = try await device.send(bundle: large, id: "sha256:00ad", kind: .new, pressed: true)
        let request = transport.requests[0]
        XCTAssertEqual(request.method, "PUT")
        XCTAssertEqual(request.url.absoluteString, "https://lifestream.example.ts.net/v1/bundles/sha256:00aa")
        XCTAssertEqual(request.headers["Authorization"], "Bearer \(pass)")
        XCTAssertEqual(request.headers["Lifestream-Device"], "phone/1.4.0")
        XCTAssertEqual(request.headers["Content-Type"], "application/zip")
        XCTAssertEqual(transport.requests.map { $0.headers["Lifestream-Kind"] }, ["new", "later", "new", "new"])
        XCTAssertEqual(request.body, .file(bundle))
        XCTAssertEqual(transport.requests.map(\.crossing), [
            .any, MobileData.Crossing(costly: false, lowData: false), MobileData.Crossing(costly: true, lowData: false), .any,
        ], "on a free path: small new data crosses any; a history page none that costs; 50 MB new mobile data, not Low Data Mode; a press any")
        let made = transport.requests.map(URLSessionTransport.made)
        XCTAssertEqual(made.map(\.allowsExpensiveNetworkAccess), [true, false, true, true], "a path that changes mid-upload: the same rule")
        XCTAssertEqual(made.map(\.allowsConstrainedNetworkAccess), [true, false, false, true])
        XCTAssertTrue(made[0].allowsCellularAccess, "cellular is the two flags' to judge")

        let raised = ScriptedTransport([.reply(200, Fixture.answer(received: 0, imported: 0, phoneFloor: "2.0.0"))])
        let (below, _) = try await paired(raised, device: phone)
        _ = try await below.exchange()
        do { _ = try await below.send(bundle: bundle, id: "sha256:00aa", kind: .new); XCTFail("below the floor") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .tooOld(floor: "2.0.0"))
        }
        XCTAssertEqual(raised.requests.count, 1, "below the floor nothing is sent")
        let unpaired = link(ScriptedTransport([]), device: phone)
        do { _ = try await unpaired.send(bundle: bundle, id: "sha256:00aa", kind: .new); XCTFail("unpaired") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unpaired)
        }
    }

    func testNoAnswerNamesNoPass() async throws {
        let transport = ScriptedTransport([.unreachable])
        let (device, pass) = try await paired(transport)
        do { _ = try await device.exchange(); XCTFail("silent") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .noAnswer(sent: false))
            XCTAssertFalse("\(failure)".contains(pass))
        }
    }

    func testVersionsCompareNumerically() {
        XCTAssertLessThan(HomeLink.order("0.9.2", "0.10.0"), 0)
        XCTAssertEqual(HomeLink.order("1.0", "1.0.0"), 0)
        XCTAssertGreaterThan(HomeLink.order("2.0.0", "1.99.9"), 0)
    }
}


final class MemoryCredentials: Credentials, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    let consulted: XCTestExpectation = {
        let consulted = XCTestExpectation(description: "the credentials were read")
        consulted.assertForOverFulfill = false
        return consulted
    }()

    func read() throws -> Data? {
        consulted.fulfill()
        return lock.withLock { data }
    }
    func write(_ data: Data) throws { lock.withLock { self.data = data } }
    func delete() throws { lock.withLock { data = nil } }
}


final class PhoneLifeLinkTests: XCTestCase {
    private var folder: URL!
    private let phone = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone 17 Pro", serial4: nil)
    private let home = "https://lifestream.example.ts.net"

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testWhichPhoneCarriesItsChoicesAndTheAnswerPairsWithTheSamePass() async throws {
        let credentials = MemoryCredentials()
        let asked = #"{"code":"PAIR_WHICH_PHONE","message":"say which","phones":[{"unit":"iphone-17-pro-0042","model":"iPhone 17 Pro","account":"person-a@example.com","last_ms":1791960000000}]}"#
        let transport = ScriptedTransport([.reply(409, asked), .reply(200, Fixture.paired())])
        let link = HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport)
        do {
            _ = try await link.pair(code: "12345678", name: home, account: Fixture.account)
            XCTFail("the home asked which phone this is")
        } catch LinkFailure.whichPhone(let phones) {
            XCTAssertEqual(phones.map(\.unit), ["iphone-17-pro-0042"])
            XCTAssertEqual(phones.first?.lastShipped, Date(timeIntervalSince1970: 1_791_960_000))
        }
        _ = try await link.pair(code: "12345678", name: home, account: Fixture.account, phone: .continuing("iphone-17-pro-0042"))
        let first = try Fixture.object(transport.requests[0]), second = try Fixture.object(transport.requests[1])
        XCTAssertNil(first["unit"])
        XCTAssertEqual(second["unit"] as? String, "iphone-17-pro-0042")
        XCTAssertEqual(first["pass"] as? String, second["pass"] as? String, "the answer pairs with the pass the question saw")
        let another = ScriptedTransport([.reply(200, Fixture.paired())])
        _ = try await HomeLink(device: phone, credentials: MemoryCredentials(), folder: folder, transport: another)
            .pair(code: "12345678", name: home, account: Fixture.account, phone: .another)
        XCTAssertEqual(try Fixture.object(another.requests[0])["new"] as? Bool, true)
    }

    func testDrainedReachesTheHomeAndReplacedIsRead() async throws {
        let (link, transport) = try await pairedPhone([.reply(200, Fixture.answer(received: 2, imported: 2, extra: #","replaced":"2026-10-14T06:36:19.071Z""#))])
        let answer = try await link.exchange(drained: true)
        XCTAssertEqual(try Fixture.object(transport.requests[0])["drained"] as? Bool, true)
        XCTAssertEqual(answer.replaced, Date(timeIntervalSince1970: 1_791_959_779.071))
        let plain = try await link.exchange()
        XCTAssertNil(try Fixture.object(transport.requests[1])["drained"], "a live install says nothing of drained")
        XCTAssertNotNil(plain.replaced)
    }


    func testTellingReturnsAtOnceAndExchangesOnceOnAChangeAndNeverOnARepeat() async throws {
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: home, account: Fixture.account)
        let transport = HeldTransport(ScriptedTransport([.reply(200, Fixture.answer(received: 0, imported: 0))]))
        let link = HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport)
        let first = ["location": "asking", "photos": "not-asked"]
        link.tell(grants: first)
        await fulfillment(of: [transport.asked], timeout: 30)
        link.tell(grants: first)
        transport.answer()
        await fulfillment(of: [transport.scripted.reached(1)], timeout: 30)
        XCTAssertEqual(transport.scripted.requests[0].url.path, "/v1/exchange", "a change is one exchange, made behind the call while it waits")
        XCTAssertEqual(try Fixture.object(transport.scripted.requests[0])["grants"] as? [String: String], first)
        link.tell(grants: first)
        _ = try await link.exchange(offers: ["a"])
        let second = transport.scripted.requests[1]
        XCTAssertEqual(try Fixture.object(second)["offers"] as? [String], ["a"], "a repeat asks nothing")
        XCTAssertEqual(try Fixture.object(second)["grants"] as? [String: String], first, "an exchange made for another reason carries them too")
        let limited = ["location": "limited", "photos": "not-asked"]
        link.tell(grants: limited)
        await fulfillment(of: [transport.scripted.reached(3)], timeout: 30)
        XCTAssertEqual(try Fixture.object(transport.scripted.requests[2])["grants"] as? [String: String], limited)
    }

    func testAChangeToldDuringAnExchangeMakesOneMoreAfterIt() async throws {
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: home, account: Fixture.account)
        let transport = HeldTransport(ScriptedTransport([.reply(200, Fixture.answer(received: 0, imported: 0))]))
        let link = HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport)
        let asking = ["location": "asking"], limited = ["location": "limited"], on = ["location": "on"]
        link.tell(grants: asking)
        await fulfillment(of: [transport.asked], timeout: 30)
        link.tell(grants: limited)
        link.tell(grants: on)
        XCTAssertEqual(transport.scripted.requests.count, 0, "a tell during one in flight makes none of its own")
        transport.answer()
        await fulfillment(of: [transport.scripted.reached(2)], timeout: 30)
        _ = try await link.exchange(offers: ["a"])
        let carried = try transport.scripted.requests.map { try Fixture.object($0)["grants"] as? [String: String] }
        XCTAssertEqual(carried, [asking, on, on], "one more after it, carrying the last told, and no third")
        XCTAssertEqual(try Fixture.object(transport.scripted.requests[2])["offers"] as? [String], ["a"])
    }

    func testATellUnderAHoldWaitsAndOneExchangeCarriesEveryOneOnceItEnds() async throws {
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: home, account: Fixture.account)
        let transport = ScriptedTransport([.reply(200, Fixture.answer(received: 0, imported: 0))])
        let link = HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport)
        let (gate, open) = AsyncStream<Void>.makeStream()
        link.tellsWait(for: { for await _ in gate {} })
        let asking = ["location": "asking"], on = ["location": "on"]
        link.tell(grants: asking)
        link.tell(grants: on)
        _ = try await link.exchange(offers: ["a"])
        XCTAssertEqual(transport.requests.count, 1, "a tell under the hold made an exchange of its own")
        open.finish()
        await fulfillment(of: [transport.reached(2)], timeout: 30)
        XCTAssertEqual(try Fixture.object(transport.requests[1])["grants"] as? [String: String], on)
        XCTAssertEqual(try Fixture.object(transport.requests[1])["offers"] as? [String], [], "the hold's end made no exchange of its own")
        _ = try await link.exchange(offers: ["b"])
        XCTAssertEqual(try Fixture.object(transport.requests[2])["offers"] as? [String], ["b"], "the hold's end made more than one")
    }

    func testAnExchangeMadeBeforeAChangeNeverReachesTheHomeAfterTheOneCarryingIt() async throws {
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: home, account: Fixture.account)
        let transport = HeldTransport(ScriptedTransport([.reply(200, Fixture.answer(received: 0, imported: 0))]), hold: 1)
        let link = HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport)
        let asking = ["photos": "asking"], on = ["photos": "on"]
        link.tell(grants: asking)
        await fulfillment(of: [transport.scripted.reached(1)], timeout: 30)
        let shipper = Task { try await link.exchange(offers: ["shipper"]) }
        await fulfillment(of: [transport.asked], timeout: 30)
        link.tell(grants: on)
        transport.answer()
        _ = try await shipper.value
        await fulfillment(of: [transport.scripted.reached(3)], timeout: 30)
        let reached = try transport.scripted.requests.map { try Fixture.object($0) }
        XCTAssertEqual(reached.map { $0["grants"] as? [String: String] }, [asking, asking, on],
                       "tell's exchange goes after the shipper's: the home's newest statement is the device's newest")
        XCTAssertEqual(reached[1]["offers"] as? [String], ["shipper"])
    }

    func testTheSameStatementToldAgainToAHomeThatDoesNotTakeItAsksOnceAMinute() async throws {
        let mac = HomeLink.Device(kind: .mac, version: "0.2.0", model: "MacBook Pro", serial4: "0001")
        let stamped = HomeLink.Device(kind: .mac, version: "0.2.0", model: "MacBook Pro", serial4: "0001", stamp: 500)
        let homes: [(String, HomeLink.Device, ScriptedTransport.Step)] = [
            ("a 503", mac, .reply(503, #"{"code":"NOT_NOW","wait":"starting","message":"Your home is starting: it answers in a moment.","title":"Your home is starting","line":"It answers in a moment.","acts":[]}"#, ["retry-after": "5"])),
            ("an older home", stamped, .reply(200, Fixture.answer(received: 0, imported: 0))),
        ]
        for (what, device, reply) in homes {
            let credentials = MemoryCredentials()
            let checkout = Fixture.answer(received: 0, imported: 0).replacingOccurrences(of: #""version":"0.2.0""#, with: #""version":"checkout""#)
            let pairing = ScriptedTransport([.reply(200, #"{"unit":"macbook-pro-0001","answer":"# + checkout + "}")])
            _ = try await HomeLink(device: device, credentials: credentials, folder: folder, transport: pairing)
                .pair(code: "12345678", name: home)
            let clock = TestClock(Date(timeIntervalSince1970: 1_792_925_361))
            let transport = ScriptedTransport([reply])
            let link = HomeLink(device: device, credentials: credentials, folder: folder, transport: transport, clock: { clock.now })
            let probes = what == "a 503" ? 1 : 0
            let exchanges = { transport.requests.filter { $0.url.path == "/v1/exchange" } }

            link.tell(recorder: .recording)
            await fulfillment(of: [transport.reached(1 + probes)], timeout: 30)
            for _ in 1...4 {
                clock.advance(10)
                link.tell(recorder: .recording)
            }
            XCTAssertEqual(exchanges().count, 1, "\(what): told five times within a minute, one exchange")
            clock.advance(19)
            link.tell(recorder: .recording)
            XCTAssertEqual(exchanges().count, 1, "\(what): 59 s after the attempt, still none")
            clock.advance(1)
            link.tell(recorder: .recording)
            await fulfillment(of: [transport.reached(2 + probes)], timeout: 30)
            link.tell(recorder: .recording)
            _ = try? await link.exchange()
            XCTAssertEqual(exchanges().count, 3, "\(what): one more after 60 s, and none queued before an ordinary exchange")
            XCTAssertEqual(try exchanges().map { try Fixture.object($0)["recorder"] as? [String: String] },
                           Array(repeating: ["state": "recording"], count: 3), "\(what): every exchange carries it")

            link.tell(recorder: .paused)
            await fulfillment(of: [transport.reached(4 + probes)], timeout: 30)
            XCTAssertEqual(try Fixture.object(exchanges()[3])["recorder"] as? [String: String], ["state": "paused"],
                           "\(what): a change asks at once")
            XCTAssertEqual(transport.requests.count - exchanges().count, probes, "\(what): one probe, joined by every later not-now")
        }
    }

    func testAnAnswerToAPairingReplacedSinceIsNeitherSavedNorFresh() async throws {
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: home, account: Fixture.account)
        let replaced = Fixture.answer(received: 0, imported: 0, extra: #","replaced":"2026-10-14T06:36:19.071Z""#)
        let transport = HeldTransport(ScriptedTransport([.reply(200, Fixture.paired()), .reply(200, replaced)]))
        let link = HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport)
        let old = Task { try await link.exchange() }
        await fulfillment(of: [transport.asked], timeout: 30)
        _ = try await link.pair(code: "87654321", name: home, account: Fixture.account)
        transport.answer()
        do {
            _ = try await old.value
            XCTFail("an answer to the replaced pass is no answer to this pairing")
        } catch LinkFailure.noAnswer {}
        XCTAssertNotEqual(transport.scripted.requests[1].headers["Authorization"],
                          "Bearer " + (try XCTUnwrap(Fixture.object(transport.scripted.requests[0])["pass"] as? String)))
        XCTAssertNil(try XCTUnwrap(link.saved).replaced, "the saved answer is the new pairing's")

        let bundle = folder.appendingPathComponent("b.zip")
        try Data("zip".utf8).write(to: bundle)
        let stale = HeldTransport(ScriptedTransport([.reply(409, #"{"code":"STALE","message":"seal 5 is not the next","answer":"# + replaced + "}")]))
        let again = HomeLink(device: phone, credentials: credentials, folder: folder, transport: stale)
        let sending = Task { try await again.send(bundle: bundle, id: "install-0001-7", kind: .new) }
        await fulfillment(of: [stale.asked], timeout: 30)
        try again.forget()
        stale.answer()
        do {
            _ = try await sending.value
            XCTFail("unpaired, the stale answer is no answer")
        } catch LinkFailure.noAnswer {}
        XCTAssertNil(again.saved, "Unpair's forgetting stands")
    }

    func testALatePairingAnswerInstallsNothingOverAPairingMadeSinceOrOverUnpair() async throws {
        let credentials = MemoryCredentials()
        let other = "https://lifestream-b.example.ts.net"
        let transport = HeldTransport(ScriptedTransport([.reply(200, Fixture.paired()), .reply(200, Fixture.paired()),
                                                         .reply(200, Fixture.answer(received: 0, imported: 0))]))
        let link = HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport)
        let first = Task { try await link.pair(code: "12345678", name: home, account: Fixture.account) }
        await fulfillment(of: [transport.asked], timeout: 30)
        _ = try await link.pair(code: "87654321", name: other, account: Fixture.account)
        transport.answer()
        do {
            _ = try await first.value
            XCTFail("the pairing made since is the one in use")
        } catch LinkFailure.noAnswer {}
        XCTAssertEqual(try link.name()?.absoluteString, other)
        _ = try await link.exchange()
        let passes = try transport.scripted.requests.prefix(2).map { try XCTUnwrap(Fixture.object($0)["pass"] as? String) }
        XCTAssertEqual(transport.scripted.requests[2].headers["Authorization"], "Bearer " + passes[0], "the later pairing's pass asks")
        XCTAssertNotEqual(passes[0], passes[1])

        let held = HeldTransport(ScriptedTransport([.reply(200, Fixture.paired())]))
        let again = HomeLink(device: phone, credentials: credentials, folder: folder, transport: held)
        let pairing = Task { try await again.pair(code: "11223344", name: home, account: Fixture.account) }
        await fulfillment(of: [held.asked], timeout: 30)
        try again.forget()
        held.answer()
        do {
            _ = try await pairing.value
            XCTFail("Unpair stands")
        } catch LinkFailure.noAnswer {}
        XCTAssertNil(try again.name())
        XCTAssertNil(again.saved)
    }

    func testAFailedExchangeLeavesTheGrantsToTheNext() async throws {
        let (link, transport) = try await pairedPhone([.unreachable, .reply(200, Fixture.answer(received: 0, imported: 0))])
        let grants = ["contacts": "off"]
        link.tell(grants: grants)
        await fulfillment(of: [transport.reached(1)], timeout: 30)
        _ = try await link.exchange(offers: ["a"])
        XCTAssertEqual(try Fixture.object(transport.requests[1])["offers"] as? [String], ["a"], "tell never throws, and tries once")
        XCTAssertEqual(try Fixture.object(transport.requests[1])["grants"] as? [String: String], grants)
        link.tell(grants: grants)
        _ = try await link.exchange(offers: ["b"])
        XCTAssertEqual(try transport.requests.map { try Fixture.object($0)["offers"] as? [String] }, [[], ["a"], ["b"]],
                       "carried once the home answered, so telling them again asks nothing")
    }

    func testUnpairedTheGrantsWaitForTheFirstExchange() async throws {
        let credentials = MemoryCredentials()
        let transport = ScriptedTransport([.reply(200, Fixture.paired()), .reply(200, Fixture.answer(received: 0, imported: 0))])
        let link = HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport)
        let grants = ["motion": "not-now"]
        link.tell(grants: grants)
        await fulfillment(of: [credentials.consulted], timeout: 30)
        _ = try await link.pair(code: "12345678", name: home, account: Fixture.account)
        XCTAssertEqual(transport.requests.map(\.url.path), ["/v1/pair"], "unpaired, nothing is sent")
        XCTAssertNil(try Fixture.object(transport.requests[0])["grants"], "pairing states no grants")
        _ = try await link.exchange()
        XCTAssertEqual(transport.requests.map(\.url.path), ["/v1/pair", "/v1/exchange"], "the first exchange is the only one")
        XCTAssertEqual(try Fixture.object(transport.requests[1])["grants"] as? [String: String], grants)
    }

    func testAnExchangeBeforeAnyTellStatesNothing() async throws {
        let (link, transport) = try await pairedPhone([.reply(200, Fixture.answer(received: 0, imported: 0))])
        _ = try await link.exchange()
        XCTAssertNil(try Fixture.object(transport.requests[0])["grants"], "no grants told is no member, never all off")
    }

    func testEveryExchangeCarriesTheSendingToldAndABareTellOfGrantsToo() async throws {
        let (link, transport) = try await pairedPhone([.reply(200, Fixture.answer(received: 0, imported: 0))])
        let photos = "apple-photos:person-a@example.com:iphone-17-pro-0042"
        let began = Date(timeIntervalSince1970: 1_792_925_361.526)
        var sending = Sending()
        sending.failed(photos, code: "PHOTOS", message: "the library refused the read", at: began)
        link.tell(sending: sending)
        _ = try await link.exchange(offers: ["a"])
        XCTAssertEqual(transport.requests.count, 1, "telling makes no exchange of its own: the pass's own carries it")
        link.tell(grants: ["photos": "on"])
        await fulfillment(of: [transport.reached(2)], timeout: 30)
        sending.failed(photos, code: "LOCAL_STORAGE", message: "the slice did not stage", at: began.addingTimeInterval(3600))
        link.tell(sending: sending)
        _ = try await link.exchange(offers: ["a"], settings: ["location": ["precision": .string("battery")]])
        link.tell(sending: Sending())
        _ = try await link.exchange(drained: true)
        let carried = try transport.requests.map { try XCTUnwrap(Fixture.object($0)["sending"] as? [String: Any], "every exchange carries it") }
        XCTAssertEqual(carried.count, 4)
        let failure = { (index: Int) in (carried[index]["sources"] as? [String: [String: Any]])?[photos] }
        XCTAssertEqual(failure(0)?["code"] as? String, "PHOTOS")
        XCTAssertEqual(failure(1)?["code"] as? String, "PHOTOS", "a bare tell of grants carries it")
        XCTAssertEqual(failure(2)?["code"] as? String, "LOCAL_STORAGE", "an exchange with settings carries the newest")
        XCTAssertEqual(failure(2)?["since_ms"] as? Int64, 1_792_925_361_526, "since stays put while the source keeps failing")
        XCTAssertNil(carried[2]["uploading_since_ms"], "a bundle in flight is no statement: the phone sends it itself")
        XCTAssertNil(carried[2]["send"], "no whole-send failure is no member")
        XCTAssertEqual(carried[3] as NSDictionary, ["sources": [String: Any]()] as NSDictionary, "none failing is stated, never left off")
        try Self.artifact("sending.json", try transport.requests.map { try Fixture.object($0) })
    }

    func testAnExchangeBeforeAnyTellOfSendingStatesNone() async throws {
        let (link, transport) = try await pairedPhone([.reply(200, Fixture.answer(received: 0, imported: 0))])
        _ = try await link.exchange()
        XCTAssertNil(try Fixture.object(transport.requests[0])["sending"], "nothing told is no member: the device tells at launch")
    }

    func testTheRestoreReadsItsEntriesAndSinceAndABlobMustBeItsName() async throws {
        let restored = #"{"pass":"p-00000001","unit":"iphone-17-pro-0042","since":{"location:local:iphone-17-pro-0042":1791960000000,"upload:local:iphone-17-pro-0042":null},"types":{"apple-health:person-a@example.com:cloud":["HKQuantityTypeIdentifierStepCount"]},"#
            + #""domains":{"checkin":[{"kind":"report","observed_at":"2026-10-14T06:00:00.000Z","payload":{"form":"moment"}}],"notes":[]},"#
            + #""contacts":{"apple-contacts:person-a@example.com:iphone-17-pro-0042":["contact-a","contact-b"]}}"#
        let bytes = "a synthetic rich-text archive"
        let (link, transport) = try await pairedPhone([.reply(200, restored), .reply(200, bytes), .reply(200, "other bytes")])
        let restore = try await link.restore()
        for broken in [restored.replacingOccurrences(of: #","contacts":{"apple-contacts:person-a@example.com:iphone-17-pro-0042":["contact-a","contact-b"]}"#, with: ""),
                       restored.replacingOccurrences(of: #""contact-a","contact-b""#, with: #"{"id":"contact-a"}"#),
                       restored.replacingOccurrences(of: #""types":{"apple-health:person-a@example.com:cloud":["HKQuantityTypeIdentifierStepCount"]},"#, with: "")] {
            XCTAssertNotEqual(broken, restored)
            XCTAssertNil(Restore(body: Data(broken.utf8)), broken)
        }
        XCTAssertEqual(restore.since, ["location:local:iphone-17-pro-0042": Date(timeIntervalSince1970: 1_791_960_000)])
        XCTAssertEqual(restore.types, ["apple-health:person-a@example.com:cloud": ["HKQuantityTypeIdentifierStepCount"]], "Health's covered types come back")
        XCTAssertEqual(restore.domains["checkin"]?.map(\.kind), ["report"])
        XCTAssertEqual(try JSONSerialization.jsonObject(with: try XCTUnwrap(restore.domains["checkin"]?.first?.payload)) as? [String: String], ["form": "moment"])
        XCTAssertEqual(restore.contacts, ["apple-contacts:person-a@example.com:iphone-17-pro-0042": ["contact-a", "contact-b"]],
                       "the contacts the home holds live, by source")
        XCTAssertEqual(transport.requests[0].method, "GET")
        XCTAssertEqual(transport.requests[0].url.path, "/v1/restore")
        XCTAssertNotNil(transport.requests[0].headers["Authorization"])
        let name = Restore.sha256(Data(bytes.utf8))
        let blob = try await link.blob(name)
        XCTAssertEqual(blob, Data(bytes.utf8))
        do {
            _ = try await link.blob(name)
            XCTFail("bytes that are not the blob's name are refused")
        } catch LinkFailure.unreadable {}
    }

    static func artifact(_ name: String, _ object: Any) throws {
        let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent(".build/e2e", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]).write(to: folder.appendingPathComponent(name))
    }

    private func pairedPhone(_ script: [ScriptedTransport.Step]) async throws -> (HomeLink, ScriptedTransport) {
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: home, account: Fixture.account)
        let transport = ScriptedTransport(script)
        return (HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport), transport)
    }
}

extension HomeLinkTests {

    func testTheRecorderToldIsOneExchangeAndEveryExchangeCarriesIt() async throws {
        let answer = Fixture.answer(received: 0, imported: 0)
        let transport = ScriptedTransport(Array(repeating: .reply(200, answer), count: 6))
        let (link, _) = try await paired(transport)
        _ = try await link.exchange()
        XCTAssertNil(try Fixture.object(transport.requests[0])["recorder"], "nothing told is no member")
        link.tell(recorder: .interrupted(.browser))
        await fulfillment(of: [transport.reached(2)], timeout: 30)
        link.tell(recorder: .interrupted(.browser))
        _ = try await link.exchange(settings: ["screen": ["interval": .number(2)]])
        link.tell(recorder: .recording)
        await fulfillment(of: [transport.reached(4)], timeout: 30)
        link.tell(recorder: .starting)
        await fulfillment(of: [transport.reached(5)], timeout: 30)
        link.tell(recorder: .paused)
        await fulfillment(of: [transport.reached(6)], timeout: 30)
        let carried = try transport.requests.map { try Fixture.object($0)["recorder"] }
        XCTAssertEqual(carried.count, 6, "the same statement told again asks nothing")
        XCTAssertEqual(carried[1] as? NSDictionary, ["state": "interrupted", "cause": "browser"] as NSDictionary)
        XCTAssertEqual(carried[2] as? NSDictionary, carried[1] as? NSDictionary, "an exchange made for another reason carries it")
        XCTAssertEqual(carried[3...].map { $0 as? NSDictionary },
                       [["state": "recording"], ["state": "starting"], ["state": "paused"]] as [NSDictionary])
        try PhoneLifeLinkTests.artifact("recorder.json", try transport.requests.map { try Fixture.object($0) })
    }

    func testEveryRecorderStatementIsOneTheHomeTakes() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/home/stated.ts")
        let source = try String(contentsOf: file, encoding: .utf8)
        func list(_ name: String) throws -> Set<String> {
            let start = try XCTUnwrap(source.range(of: "export const \(name) = ["), "the home's \(name)")
            let items = source[start.upperBound...].prefix { $0 != "]" }
            return Set(items.split(separator: ",").map { $0.trimmingCharacters(in: CharacterSet(charactersIn: " \"\n")) })
        }
        let states = try list("RECORDER_STATES"), causes = try list("CAUSES")
        let named: (RecorderStatement) -> Void = { statement in
            switch statement { case .recording, .starting, .paused, .interrupted: break }
        }
        let all: [RecorderStatement] = [.recording, .starting, .paused] + RecorderStatement.Cause.allCases.map { .interrupted($0) }
        all.forEach(named)
        XCTAssertEqual(Set(all.compactMap { $0.stated["cause"] as? String }), causes, "every cause the home's")
        XCTAssertEqual(Set(all.compactMap { $0.stated["cause"] == nil ? $0.stated["state"] as? String : nil }), states,
                       "every state the home's, and no other")
        XCTAssertFalse(states.contains("stopped"))
    }

    func testTheRecorderToldWithTheGrantsIsOneExchange() async throws {
        let answer = Fixture.answer(received: 0, imported: 0)
        let transport = ScriptedTransport(Array(repeating: .reply(200, answer), count: 4))
        let (link, _) = try await paired(transport)
        transport.onPerform = { request in
            guard request.url.path == "/v1/exchange", (try? Fixture.object(request))?["recorder"] == nil else { return }
            link.tell(recorder: .interrupted(.permission), grants: ["screenRecording": "off"])
        }
        _ = try await link.exchange()
        await fulfillment(of: [transport.reached(2)], timeout: 30)
        transport.onPerform = nil
        link.tell(recorder: .recording, grants: ["screenRecording": "on"])
        await fulfillment(of: [transport.reached(3)], timeout: 30)
        let carried = try transport.requests.map { request -> [NSDictionary?] in
            let body = try Fixture.object(request)
            return [body["recorder"] as? NSDictionary, body["grants"] as? NSDictionary]
        }
        XCTAssertEqual(carried, [[nil, nil], [["state": "interrupted", "cause": "permission"], ["screenRecording": "off"]],
                                 [["state": "recording"], ["screenRecording": "on"]]])
    }



    func testAReadThroughIsSaidAgainInEveryExchangeWhetherOrNotTheHomeAnswered() async throws {
        let screen = "screen:local:macbook-pro-0001"
        let messages = "imessage:local:macbook-pro-0001"
        let answer = Fixture.answer(received: 0, imported: 0, sources: [screen, messages])
        let transport = ScriptedTransport([.reply(200, answer), .unreachable, .reply(200, answer), .reply(200, answer), .reply(200, answer)])
        let (link, _) = try await paired(transport)
        _ = try await link.exchange()
        XCTAssertNil(try Fixture.object(transport.requests[0])["through"], "nothing told is no member")
        XCTAssertFalse(link.owesExchange)

        let run = Date(timeIntervalSince1970: 1_792_925_361.5269)
        link.tell(through: Through(readThrough: run.addingTimeInterval(-90), statedAt: run), of: screen, pass: Fixture.pass)
        link.tell(through: Through(readThrough: run, statedAt: run, left: 1200, start: Date(timeIntervalSince1970: 1_779_235_200),
                                   months: ["2026-10": .init(items: 3, bytes: 9_000), "undated": .init(items: 1, bytes: nil)]),
                  of: messages, pass: Fixture.pass)
        XCTAssertEqual(transport.requests.count, 1, "telling makes no exchange of its own: the Mac's next one carries it")
        XCTAssertTrue(link.owesExchange, "a value no exchange has carried is owed")
        do { _ = try await link.exchange(); XCTFail("no answer") } catch LinkFailure.noAnswer {}
        XCTAssertTrue(link.owesExchange, "an exchange with no answer carried nothing")
        _ = try await link.exchange()
        XCTAssertFalse(link.owesExchange, "carried once the home answered")
        _ = try await link.exchange()

        let said = try transport.requests[1...3].map { try XCTUnwrap(Fixture.object($0)["through"] as? NSDictionary, "every exchange says it") }
        XCTAssertEqual(said[0], [screen: ["read_through": "2026-10-25T10:47:51.526Z", "stated_at": "2026-10-25T10:49:21.526Z"],
                                 messages: ["read_through": "2026-10-25T10:49:21.526Z", "stated_at": "2026-10-25T10:49:21.526Z",
                                            "left": 1200, "start_ms": 1_779_235_200_000,
                                            "months": ["2026-10": [3, 9_000], "undated": [1, NSNull()]]]] as NSDictionary,
                       "each instant to the millisecond below it, in UTC; left with the start it was counted under, months only where stated")
        XCTAssertEqual(said[1], said[0], "said again after an exchange that heard nothing back")
        var counted = try XCTUnwrap(said[0][messages] as? [String: Any])
        counted["months"] = nil
        XCTAssertEqual(said[2], [screen: said[0][screen]!, messages: counted] as NSDictionary,
                       "said again after one the home answered, but for the count it took")

        link.tell(through: Through(readThrough: run.addingTimeInterval(210), statedAt: run.addingTimeInterval(300)), of: screen,
                  pass: Fixture.pass)
        XCTAssertTrue(link.owesExchange, "a newer statement is owed")
        _ = try await link.exchange()
        XCTAssertEqual(try Fixture.object(transport.requests[4])["through"] as? NSDictionary,
                       [screen: ["read_through": "2026-10-25T10:52:51.526Z", "stated_at": "2026-10-25T10:54:21.526Z"],
                        messages: said[2][messages]!] as NSDictionary,
                       "the newest replaces the older, and the other source's is said as it was")
        try PhoneLifeLinkTests.artifact("through.json", try transport.requests.map { try Fixture.object($0) })
    }

    func testACountIsLeftOffOnceTheHomeTookItAcrossARelaunchAndSaidAgainAfterARefusal() async throws {
        let messages = "imessage:local:macbook-pro-0001"
        let answer = { (n: Int) in
            Fixture.answer(received: 0, imported: 0, turn: Answer.Turn(run: "00000000000000c1", n: n), sources: [messages])
        }
        let credentials = MemoryCredentials()
        _ = try await link(ScriptedTransport([.reply(200, Fixture.paired())]), credentials: credentials)
            .pair(code: "12345678", name: home, offers: [])
        let first = ScriptedTransport([.reply(200, answer(1)), .reply(200, answer(2)), .reply(200, answer(3))])
        let before = link(first, credentials: credentials)
        _ = try await before.exchange()
        let run = Date(timeIntervalSince1970: 1_792_925_361.5)
        let months: [String: Through.Month] = ["2026-10": .init(items: 3, bytes: 9_000)]
        before.tell(through: Through(readThrough: run, statedAt: run, months: months), of: messages, pass: Fixture.pass)
        XCTAssertEqual(before.monthsOwed(months, of: messages), months, "no count taken yet")
        _ = try await before.exchange()
        _ = try await before.exchange()
        let firstSaid = try first.requests[1...2].map { try XCTUnwrap(Fixture.object($0)["through"] as? [String: [String: Any]]) }
        XCTAssertNotNil(firstSaid[0][messages]?["months"])
        XCTAssertNil(firstSaid[1][messages]?["months"], "the count the home took is left off")
        XCTAssertNil(before.monthsOwed(months, of: messages))

        let refusing = ScriptedTransport([.reply(200, answer(4)), .reply(500, #"{"code":"INTERNAL","message":"failed"}"#),
                                          .reply(200, answer(5)), .reply(200, answer(6))])
        let after = link(refusing, credentials: credentials)
        _ = try await after.exchange()
        after.tell(through: Through(readThrough: run, statedAt: run, months: months), of: messages, pass: Fixture.pass)
        XCTAssertNil(after.monthsOwed(months, of: messages), "kept with the link's state: a relaunch knows it")
        let grown: [String: Through.Month] = ["2026-10": .init(items: 4, bytes: 9_500)]
        after.tell(through: Through(readThrough: run, statedAt: run.addingTimeInterval(60), months: grown), of: messages,
                   pass: Fixture.pass)
        do { _ = try await after.exchange(); XCTFail("refused") } catch LinkFailure.unavailable {}
        _ = try await after.exchange()
        _ = try await after.exchange()
        let afterSaid = try refusing.requests[1...3].map { try XCTUnwrap(Fixture.object($0)["through"] as? [String: [String: Any]]) }
        XCTAssertEqual(afterSaid[0][messages]?["months"] as? NSDictionary, ["2026-10": [4, 9_500]])
        XCTAssertEqual(afterSaid[1][messages]?["months"] as? NSDictionary, ["2026-10": [4, 9_500]],
                       "a count the home refused is said again")
        XCTAssertNil(afterSaid[2][messages]?["months"])
        try PhoneLifeLinkTests.artifact("through-months.json",
                                        try (first.requests + refusing.requests).map { try Fixture.object($0) })
    }

    func testACountABundleCarriedLeavesTheOlderToldCountOff() async throws {
        let messages = "imessage:local:macbook-pro-0001"
        let answer = Fixture.answer(received: 0, imported: 0, sources: [messages])
        let transport = ScriptedTransport([.reply(200, answer), .reply(200, answer)])
        let (link, _) = try await paired(transport)
        _ = try await link.exchange()
        let run = Date(timeIntervalSince1970: 1_792_925_361.5)
        let told: [String: Through.Month] = ["2026-10": .init(items: 3, bytes: 9_000)]
        let carried: [String: Through.Month] = ["2026-10": .init(items: 5, bytes: 12_000)]
        link.tell(through: Through(readThrough: run, statedAt: run, months: told), of: messages, pass: Fixture.pass)
        link.homeKept(months: carried, of: messages, pass: Fixture.pass)
        XCTAssertNil(link.monthsOwed(carried, of: messages), "the bundle's count is the one the home holds")
        XCTAssertEqual(link.monthsOwed(told, of: messages), told)
        XCTAssertNil(link.through(of: messages)?.months, "the older count told is dropped")
        _ = try await link.exchange()
        let said = try XCTUnwrap(Fixture.object(transport.requests[1])["through"] as? [String: [String: Any]])
        XCTAssertNotNil(said[messages], "the read-through still goes")
        XCTAssertNil(said[messages]?["months"], "never the older count")
    }

    func testPairingWithAnotherHomeForgetsEveryReadThrough() async throws {
        let answer = Fixture.answer(received: 0, imported: 0)
        let transport = ScriptedTransport([.reply(200, Fixture.paired()), .reply(200, answer),
                                           .reply(200, Fixture.paired()), .reply(200, answer)])
        let link = link(transport)
        _ = try await link.pair(code: "12345678", name: home, offers: [])
        let run = Date(timeIntervalSince1970: 1_792_925_361.5)
        link.tell(through: Through(readThrough: run, statedAt: run), of: Fixture.source, pass: Fixture.pass)
        _ = try await link.exchange()
        XCTAssertNotNil(try Fixture.object(transport.requests[1])["through"], "the first home hears it")

        _ = try await link.pair(code: "87654321", name: "https://second-home.example.ts.net", offers: [])
        _ = try await link.exchange()
        XCTAssertEqual(transport.requests[3].url.host, "second-home.example.ts.net")
        XCTAssertNil(try Fixture.object(transport.requests[3])["through"], "the second home hears none of the first's")
    }

    func testAGrantExchangesAnswerThatNoLongerStatesASourceLeavesItsReadThroughOff() async throws {
        let screen = "screen:local:macbook-pro-0001"
        let both = Fixture.answer(received: 0, imported: 0, sources: [Fixture.source, screen])
        let messagesOnly = Fixture.answer(received: 0, imported: 0, sources: [Fixture.source])
        let transport = ScriptedTransport([.reply(200, both), .reply(200, messagesOnly), .reply(200, messagesOnly),
                                           .reply(200, messagesOnly)])
        let (link, _) = try await paired(transport)
        _ = try await link.exchange()
        let run = Date(timeIntervalSince1970: 1_792_925_361.5)
        link.tell(through: Through(readThrough: run, statedAt: run), of: screen, pass: Fixture.pass)
        link.tell(through: Through(readThrough: run, statedAt: run), of: Fixture.source, pass: Fixture.pass)

        link.tell(grants: ["files": "on"])
        await fulfillment(of: [transport.reached(2)], timeout: 30)
        XCTAssertNotNil((try Fixture.object(transport.requests[1])["through"] as? [String: Any])?[screen],
                        "the grant exchange whose answer leaves the source off still says it")
        _ = try await link.exchange()
        let later = run.addingTimeInterval(300)
        link.tell(through: Through(readThrough: later, statedAt: later), of: screen, pass: Fixture.pass)
        XCTAssertNil(link.through(of: screen), "a value told after the answer that left its source off is not taken")
        _ = try await link.exchange()

        let messages = [Fixture.source: ["read_through": "2026-10-25T10:49:21.500Z", "stated_at": "2026-10-25T10:49:21.500Z"]] as NSDictionary
        XCTAssertEqual(try Fixture.object(transport.requests[2])["through"] as? NSDictionary, messages,
                       "the exchange after the grant exchange's answer says the source no more; the other as it was")
        XCTAssertEqual(try Fixture.object(transport.requests[3])["through"] as? NSDictionary, messages, "nor does any after it")
    }

    func testAReadThroughStatesItsSealWhenItHasOne() async throws {
        let screen = "screen:local:macbook-pro-0001"
        let answer = Fixture.answer(received: 0, imported: 0, sources: [screen, Fixture.source])
        let transport = ScriptedTransport([.reply(200, answer)])
        let (link, _) = try await paired(transport)
        _ = try await link.exchange()
        let run = Date(timeIntervalSince1970: 1_792_925_361.5)
        link.tell(through: Through(readThrough: run, statedAt: run, seal: 7), of: screen, pass: Fixture.pass)
        link.tell(through: Through(readThrough: run, statedAt: run), of: Fixture.source, pass: Fixture.pass)
        XCTAssertEqual(link.through(of: screen)?.seal, 7)
        _ = try await link.exchange()
        let instant = "2026-10-25T10:49:21.500Z"
        XCTAssertEqual(try Fixture.object(transport.requests[1])["through"] as? NSDictionary,
                       [screen: ["read_through": instant, "stated_at": instant, "seal": 7],
                        Fixture.source: ["read_through": instant, "stated_at": instant]] as NSDictionary)
    }

    func testAReadThroughNeverReadsAsAfterItsStatement() {
        let stated = Date(timeIntervalSince1970: 1_792_925_361.0004)
        XCTAssertEqual(Through.instant(stated), "2026-10-25T10:49:21.000Z")
        XCTAssertEqual(Through.instant(stated.addingTimeInterval(-0.0003)), "2026-10-25T10:49:21.000Z")
        XCTAssertEqual(Through.instant(Date(timeIntervalSince1970: 1_792_925_361.9999)), "2026-10-25T10:49:21.999Z")
    }


    func testAPlaceActIsOneOwnerActCarryingOnlyWhatItSaysAndTheHomeMintsItsSlug() async throws {
        let answered = #"{"act":null,"id":"place:synthetic-gym-0a0b0c","position":"7:1791000000000"}"#
        let transport = ScriptedTransport(Array(repeating: .reply(200, answered), count: 7))
        let (device, pass) = try await paired(transport, device: phone)
        let circle = HomeLink.Place.Circle(latitude: 37.3187, longitude: -122.009, radiusM: 80)
        let made = try await device.act(.places(request: "r-1", .create(name: "Synthetic Gym", circle, ids: ["google:gym"])))
        XCTAssertEqual(made, HomeLink.OwnerAnswer(act: nil, id: "place:synthetic-gym-0a0b0c", position: "7:1791000000000"))
        _ = try await device.act(.places(request: "r-2", .edit(slug: "synthetic-gym-0a0b0c", HomeLink.PlaceFields(name: .init(was: "Synthetic Gym", to: "Synthetic Gym North")))))
        _ = try await device.act(.places(request: "r-3", .edit(slug: "synthetic-gym-0a0b0c", HomeLink.PlaceFields(also: .init(was: [], to: [circle]), home: .init(was: true, to: nil)))))
        _ = try await device.act(.places(request: "r-4", .addCircle(slug: "synthetic-gym-0a0b0c", circle)))
        _ = try await device.act(.places(request: "r-5", .hide(latitude: 37.3187, longitude: -122.009)))
        _ = try await device.act(.places(request: "r-6", .unhide(key: "hidden-0a0b0c")))
        _ = try await device.act(.places(request: "r-7", .create(name: "Synthetic Cottage", circle, ids: [], home: true)))

        let request = transport.requests[0]
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.absoluteString, "https://lifestream.example.ts.net/v1/owner/act")
        XCTAssertEqual(request.headers["Authorization"], "Bearer \(pass)")
        let bodies = try transport.requests.map { request -> [String: Any] in
            guard case .json(let body) = request.body else { throw LinkFailure.unreadable(0) }
            return try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        }
        XCTAssertEqual(Set(bodies[0].keys), ["of", "kind", "request", "name", "latitude", "longitude", "radius_m", "ids"], "no slug: the home mints it")
        XCTAssertEqual(bodies[0]["of"] as? String, "places")
        XCTAssertEqual(bodies[0]["kind"] as? String, "create")
        XCTAssertEqual(bodies[0]["request"] as? String, "r-1")
        XCTAssertEqual(Set(bodies[1].keys), ["of", "kind", "request", "slug", "name", "was"], "an edit carries only the fields it changes")
        XCTAssertEqual(bodies[1]["was"] as? NSDictionary, ["name": "Synthetic Gym"], "each with the value it was edited from")
        XCTAssertEqual(bodies[2]["home"] as? NSNull, NSNull(), "home cleared is stated as null")
        XCTAssertEqual(bodies[2]["was"] as? NSDictionary, ["also": [], "home": true], "the circles too, whole, as they were")
        XCTAssertEqual((bodies[2]["also"] as? [[String: Any]])?.first?["radius_m"] as? Double, 80)
        XCTAssertEqual(bodies.map { $0["kind"] as? String }, ["create", "edit", "edit", "add-circle", "hide", "unhide", "create"])
        XCTAssertEqual(bodies[6]["home"] as? Bool, true, "a new home is one create carrying home")
        XCTAssertEqual(bodies[5]["key"] as? String, "hidden-0a0b0c")
    }

    func testAnActThatNeverLeftIsNotSentAndOneThatMayHaveLandedIsUnknown() async throws {
        let place = HomeLink.OwnerAction.places(request: "r-1", .create(name: "Synthetic Gym", HomeLink.Place.Circle(latitude: 37.3187, longitude: -122.009, radiusM: 80), ids: []))
        let person = HomeLink.OwnerAction.people(request: "r-2", .undo(act: "a-1"))

        let refused = ScriptedTransport([.unreachable])
        let (closed, _) = try await paired(refused, device: phone)
        let placeUnsent = await closed.acted(place, now: Date())
        XCTAssertEqual(placeUnsent, .unanswered(.notSent), "the connection was refused before the body went")
        let personUnsent = await closed.acted(person, now: Date())
        XCTAssertEqual(personUnsent, .unanswered(.notSent), "a person's act reads the same")
        do { _ = try await closed.act(place); XCTFail("refused") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .noAnswer(sent: false))
        }

        let dropped = ScriptedTransport([.lost])
        let (open, _) = try await paired(dropped, device: phone)
        let placeLost = await open.acted(place, now: Date())
        XCTAssertEqual(placeLost, .unanswered(.unknown(ReachWords.unknown)), "the body may have landed: not known whether saved")
        let personLost = await open.acted(person, now: Date())
        XCTAssertEqual(personLost, .unanswered(.unknown(ReachWords.unknown)))

        let thenRefused = ScriptedTransport([.lost, .unreachable])
        let (mixed, _) = try await paired(thenRefused, device: phone)
        let resent = await mixed.acted(place, now: Date())
        XCTAssertEqual(resent, .unanswered(.unknown(ReachWords.unknown)), "a resend that never left says nothing of the first copy")
        XCTAssertEqual(thenRefused.requests.count, 2)

        let interrupted = ScriptedTransport([.cancelled])
        let (away, _) = try await paired(interrupted, device: phone)
        let placeAway = await away.acted(place, now: Date())
        XCTAssertEqual(placeAway, .unanswered(.unknown(ReachWords.unknown)), "a send a trip to the background cut may have landed")
    }

    func testThePlacesRouteAsksWithItsETagAndA304IsNoList() async throws {
        let transport = ScriptedTransport([
            .reply(200, #"{"places":[],"spots":[]}"#, ["etag": "\"e-1\""]),
            .reply(304, ""),
            .reply(404, #"{"code":"ROUTE","message":"no such route"}"#),
        ])
        let (device, _) = try await paired(transport, device: phone)
        let first = try await device.places(etag: nil)
        XCTAssertEqual(first, HomeLink.Places(body: Data(#"{"places":[],"spots":[]}"#.utf8), etag: "\"e-1\""))
        XCTAssertNil(transport.requests[0].headers["If-None-Match"])
        XCTAssertEqual(transport.requests[0].method, "GET")
        XCTAssertEqual(transport.requests[0].url.absoluteString, "https://lifestream.example.ts.net/v1/places")
        let unchanged = try await device.places(etag: "\"e-1\"")
        XCTAssertNil(unchanged, "304: the list held is current")
        XCTAssertEqual(transport.requests[1].headers["If-None-Match"], "\"e-1\"")
        do {
            _ = try await device.places(etag: "\"e-1\"")
            XCTFail("an older home has no places route")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .refused(status: 404, code: "ROUTE", message: "no such route"))
        }
    }

    func testAnAnswerReadsWithOrWithoutOwnerSources() async throws {
        let transport = ScriptedTransport([
            .reply(200, Fixture.answer(received: 0, imported: 0)),
            .reply(200, Fixture.answer(received: 0, imported: 0, owner: ["places:local:macbook-pro-0001"])),
        ])
        let (device, _) = try await paired(transport, device: phone)
        let older = try await device.exchange()
        XCTAssertEqual(older.owner, [], "a home that names no owner sources")
        let newer = try await device.exchange()
        XCTAssertEqual(newer.owner, ["places:local:macbook-pro-0001"])
        XCTAssertNil(newer.sources["places:local:macbook-pro-0001"], "an owner source is no custody source")
    }
}

struct Unended: Error, CustomStringConvertible {
    let what: String
    var description: String { "\(what) never came in 30 s" }
}

func ended<Value: Sendable, Failure: Error>(_ what: String, _ task: Task<Value, Failure>,
                                            file: StaticString = #filePath, line: UInt = #line) async throws -> Value {
    let done = XCTestExpectation(description: what)
    let watching = Task { _ = await task.result; done.fulfill() }
    guard await XCTWaiter().fulfillment(of: [done], timeout: 30) == .completed else {
        let unended = Unended(what: what)
        XCTFail(unended.description, file: file, line: line)
        task.cancel()
        watching.cancel()
        throw unended
    }
    return try await task.result.get()
}

final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var at: Date

    init(_ at: Date) { self.at = at }

    var now: Date { lock.withLock { at } }

    func advance(_ seconds: TimeInterval) { lock.withLock { at = at.addingTimeInterval(seconds) } }
}

final class ScriptedTransport: HomeTransport, @unchecked Sendable {
    enum Step {
        case reply(Int, String, [String: String] = [:])
        case unreachable
        case lost
        case cancelled
    }

    private let lock = NSLock()
    private var script: [Step]
    private var made: [HomeRequest] = []
    private var waits: [(count: Int, kept: XCTestExpectation)] = []
    var onPerform: ((HomeRequest) -> Void)?

    init(_ script: [Step]) { self.script = script }

    var requests: [HomeRequest] { lock.withLock { made } }

    func reached(_ count: Int) -> XCTestExpectation {
        let kept = XCTestExpectation(description: "\(count) requests reached the home")
        lock.withLock {
            if made.count >= count { kept.fulfill() } else { waits.append((count, kept)) }
        }
        return kept
    }

    func identify(_ address: URL, within: TimeInterval) async throws -> String {
        String(repeating: "A", count: 52)
    }

    func perform(_ request: HomeRequest) async throws -> HomeResponse {
        onPerform?(request)
        let step = lock.withLock { () -> Step? in
            made.append(request)
            waits.removeAll { wait in
                guard made.count >= wait.count else { return false }
                wait.kept.fulfill()
                return true
            }
            guard let first = script.first else { return nil }
            if script.count > 1 { script.removeFirst() }
            return first
        }
        if case .cancelled? = step { throw URLError(.cancelled) }
        if case .lost? = step { throw URLError(.networkConnectionLost) }
        guard let step, case .reply(let status, let body, let headers) = step else { throw URLError(.cannotConnectToHost) }
        return HomeResponse(status: status, headers: headers, body: Data(body.utf8))
    }
}

final class HeldTransport: HomeTransport, @unchecked Sendable {
    let scripted: ScriptedTransport
    let asked = XCTestExpectation(description: "the held request reached the home")
    private let hold: Int
    private let lock = NSLock()
    private var seen = 0
    private var held: CheckedContinuation<Void, Never>?

    init(_ scripted: ScriptedTransport, hold: Int = 0) {
        self.scripted = scripted
        self.hold = hold
    }

    func identify(_ address: URL, within: TimeInterval) async throws -> String {
        try await scripted.identify(address, within: within)
    }

    func perform(_ request: HomeRequest) async throws -> HomeResponse {
        let holding = lock.withLock { () -> Bool in
            defer { seen += 1 }
            return seen == hold
        }
        if holding {
            await withCheckedContinuation { continuation in
                lock.withLock { held = continuation }
                asked.fulfill()
            }
        }
        return try await scripted.perform(request)
    }

    func answer() {
        lock.withLock { held }?.resume()
    }
}

enum Fixture {
    static let source = "imessage:a@example.com:unit-0001"
    static let pass = "p-00000001"
    static let account = "person-a@example.com"

    static func answer(received: Int, imported: Int, macFloor: String = "0.1.0", phoneFloor: String = "1.0.0", history: Bool = true,
                       owner: [String] = [], settings: String = "{}", turn: Answer.Turn? = nil, extra: String = "",
                       sources: [String] = [source]) -> String {
        let turn = turn ?? Answer.Turn(run: String(format: "%016llx", UInt64.random(in: 0...UInt64.max)), n: 1)
        let owners = owner.map { #""\#($0)""# }.joined(separator: ",")
        let custody = sources.map { #""\#($0)":{"received":\#(received),"imported":\#(imported),"formats":["v1"],"history":\#(history)}"# }
            .joined(separator: ",")
        return #"{"home":{"id":"h-0001","version":"0.2.0","floors":{"mac":"\#(macFloor)","phone":"\#(phoneFloor)","extension":"0.1.0"}},"#
            + #""pass":"\#(pass)","unit":"macbook-pro-0001","#
            + #""sources":{\#(custody)},"#
            + #""owner":[\#(owners)],"#
            + #""needs":[{"id":"disk","state":"needs-you","reason":null,"words":"Plug in the drive","since_ms":1791540000000,"next_ms":null,"#
            + #""acts":[],"detail":null,"connector":null,"copy":null,"unit":null,"at":null,"weight":"advice","banner":false,"dismissed":false,"kind":"notice","about":null},{"id":"unread","words":"a need of no shape"}],"#
            + #""calls":[],"settings":\#(settings),"turn":{"run":"\#(turn.run)","n":\#(turn.n)}\#(extra)}"#
    }

    static func paired() -> String {
        #"{"unit":"macbook-pro-0001","answer":"# + answer(received: 0, imported: 0) + "}"
    }

    static func object(_ request: HomeRequest) throws -> [String: Any] {
        guard case .json(let data) = request.body else { throw URLError(.badURL) }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

private final class Heard: @unchecked Sendable {
    private let lock = NSLock()
    private var heard: [Int64] = []

    func add(_ bytes: Int64) { lock.withLock { heard.append(bytes) } }
    var all: [Int64] { lock.withLock { heard } }
}
