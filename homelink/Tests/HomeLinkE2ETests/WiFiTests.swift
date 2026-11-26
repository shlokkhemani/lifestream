import Foundation
import Network
import XCTest
@testable import HomeLink

final class WiFiTests: XCTestCase {
    private let phone = HomeLink.Device(kind: .phone, version: "1.0.0", model: "iPhone 17 Pro", serial4: nil)

    func testAPhonePairsOnTheWiFiHoldingTheHomesCertificateSendsAndFallsToTheTailnetPinned() async throws {
        let home = try LanHome()
        defer { home.stop() }
        let ready = try await home.ready()
        let lan = try XCTUnwrap(ready["lan"] as? Int)
        let wifi = try XCTUnwrap(URL(string: "https://127.0.0.1:\(lan)"))
        let tailnet = try XCTUnwrap(URL(string: "https://localhost:\(lan)"))
        let impostor = try XCTUnwrap(ready["impostor"] as? Int)
        var report: [String: Any] = [:]

        let shown = try await home.ask(["do": "pair"])
        let text = try XCTUnwrap(shown["link"] as? String)
        let link = try XCTUnwrap(PairingLink(text))
        XCTAssertEqual(link.addresses, [wifi, tailnet], "the Wi-Fi's, then the tailnet's, written by the home")
        XCTAssertEqual(link.account, "person-a@example.com")

        let recorded = Recording()
        let first = HomeLink(device: phone, credentials: try credentials(), folder: try folder(), transport: recorded, finder: Listed([]))
        let spoofed = try Self.link(text, port: impostor, at: [])
        do {
            _ = try await first.pair(spoofed, account: link.account, name: "iPhone")
            XCTFail("a server with another key pairs")
        } catch LinkFailure.notTheHome {}
        let hitsAfterPairing = try await home.ask(["do": "impostor"])["hits"] as? Int
        XCTAssertEqual(hitsAfterPairing, 0, "nothing of the pairing reached the impostor")
        XCTAssertNil(try first.name(), "a refused pairing pairs nothing")
        XCTAssertEqual(LinkFailure.notTheHome.description, "This isn't your Mac.")

        let paired = try await first.pair(link, account: link.account, name: "iPhone")
        let unit = paired.unit
        XCTAssertEqual(paired.addresses, [wifi, tailnet])
        XCTAssertEqual(try first.addresses(), [wifi, tailnet])

        let one = try await home.ask(["do": "bundle", "unit": unit, "seal": 1])
        let sent = try await first.send(bundle: URL(fileURLWithPath: try XCTUnwrap(one["path"] as? String)), id: try XCTUnwrap(one["id"] as? String), kind: .new)
        XCTAssertEqual(sent.sources["location:local:\(unit)"]?.received, 1)
        XCTAssertTrue([wifi.host, tailnet.host].contains(recorded.last("PUT")?.url.host))
        XCTAssertEqual(recorded.last("PUT")?.pin, link.fingerprint)

        let movedTo = try await home.ask(["do": "move-lan"])
        let moved = try XCTUnwrap(movedTo["lan"] as? Int)
        let mac = try XCTUnwrap(URL(string: "https://127.0.0.1:\(moved)"))
        let now = [mac, try XCTUnwrap(URL(string: "https://localhost:\(moved)"))]
        let exchanged = try await first.exchange()
        XCTAssertEqual(exchanged.sources["location:local:\(unit)"]?.received, 1)
        XCTAssertEqual(recorded.last("POST")?.url.absoluteString, tailnet.absoluteString + "/v1/exchange")
        XCTAssertEqual(recorded.last("POST")?.pin, link.fingerprint)
        XCTAssertEqual(try first.addresses(), now, "the answer's list replaces the stored one, where it paired with it")
        let two = try await home.ask(["do": "bundle", "unit": unit, "seal": 2])
        let path = URL(fileURLWithPath: try XCTUnwrap(two["path"] as? String)), id = try XCTUnwrap(two["id"] as? String)
        let again = try await first.send(bundle: path, id: id, kind: .new)
        XCTAssertEqual(again.sources["location:local:\(unit)"]?.received, 2)
        XCTAssertTrue(now.map(\.host).contains(recorded.last("PUT")?.url.host))
        XCTAssertEqual(recorded.last("PUT")?.url.port, moved)
        XCTAssertEqual(recorded.last("PUT")?.pin, link.fingerprint)

        let typed = try await home.ask(["do": "pair"])
        let code = try XCTUnwrap(typed["code"] as? String), match = try XCTUnwrap(typed["match"] as? String)
        let elsewhere = try XCTUnwrap(URL(string: "https://127.0.0.1:\(impostor)"))
        let second = HomeLink(device: phone, credentials: try credentials(), folder: try folder(), transport: Recording(), finder: Listed([elsewhere, mac]))
        let found = await second.find()
        XCTAssertEqual(found.map(\.address), [elsewhere, mac])
        let theirs = try XCTUnwrap(found.first { $0.address == elsewhere }), ours = try XCTUnwrap(found.first { $0.address == mac })
        XCTAssertNotEqual(theirs.match(code: code), match, "a home with another key shows other four")
        XCTAssertEqual(ours.match(code: code), match, "the Mac's four are the phone's")
        XCTAssertEqual(ours.fingerprint, link.fingerprint)
        let hitsAfterFinding = try await home.ask(["do": "impostor"])["hits"] as? Int
        XCTAssertEqual(hitsAfterFinding, 0, "finding sends nothing: the code never left the phone")
        let typedIn = try await second.pair(code: code, at: ours, account: nil, name: "iPhone", phone: .another)
        XCTAssertNotEqual(typedIn.unit, unit)

        let (relay, relayPort) = try await Relay.start(to: moved)
        defer { relay.stop() }
        let stalled = try await home.ask(["do": "pair"])
        let stalledLink = try Self.link(try XCTUnwrap(stalled["link"] as? String), port: Int(relayPort), at: [])
        let testLook: TimeInterval = 0.25
        let testReach: TimeInterval = 0.5
        let third = HomeLink(device: phone, credentials: try credentials(), folder: try folder(), transport: Recording(), finder: Listed([]), look: testLook, reach: 0.75)
        let began = ContinuousClock.now
        let landed = try await third.pair(stalledLink, account: stalledLink.account, name: "iPhone", phone: .another)
        let took = ContinuousClock.now - began
        XCTAssertFalse(landed.unit.isEmpty)
        XCTAssertGreaterThanOrEqual(relay.connections, 2, "the stalled connection was left for a new one")

        let closed = try Self.closedPort()
        let away = try await home.ask(["do": "pair"])
        let awayLink = try Self.link(try XCTUnwrap(away["link"] as? String), port: closed, at: ["https://localhost:\(moved)"])
        XCTAssertEqual(awayLink.addresses.map(\.absoluteString), ["https://127.0.0.1:\(closed)", "https://localhost:\(moved)"])
        let fourth = HomeLink(device: phone, credentials: try credentials(), folder: try folder(), transport: Recording(), finder: Listed([]), look: testLook, reach: testReach)
        let awayBegan = ContinuousClock.now
        let overTailnet = try await fourth.pair(awayLink, account: awayLink.account, name: "iPhone", phone: .another)
        let awayTook = ContinuousClock.now - awayBegan
        XCTAssertFalse(overTailnet.unit.isEmpty)
        XCTAssertLessThan(awayTook, .seconds(testReach), "the tailnet's address waited on the Wi-Fi one")
        XCTAssertEqual(try fourth.name()?.absoluteString, "https://localhost:\(moved)")

        let nowhere = try await home.ask(["do": "pair"])
        let nowhereLink = try Self.link(try XCTUnwrap(nowhere["link"] as? String), port: closed, at: ["https://localhost:\(closed)"])
        let fifth = HomeLink(device: phone, credentials: try credentials(), folder: try folder(), transport: Recording(), finder: Listed([]), look: testLook, reach: testReach)
        let nowhereBegan = ContinuousClock.now
        do {
            _ = try await fifth.pair(nowhereLink, account: nil, name: "iPhone", phone: .another)
            XCTFail("a link whose addresses answer nothing paired")
        } catch LinkFailure.noAnswer {}
        let nowhereTook = ContinuousClock.now - nowhereBegan
        XCTAssertLessThan(nowhereTook, .seconds(testReach + 1), "no answer took longer than one reach")

        _ = try await home.ask(["do": "interfaces", "bonjour": "127.0.0.2", "addresses": ["127.0.0.3", "127.0.0.4", "127.0.0.1"]])
        let four = try await home.ask(["do": "pair"])
        let fourLink = try XCTUnwrap(PairingLink(try XCTUnwrap(four["link"] as? String)))
        let fourAt = ["127.0.0.2", "127.0.0.3", "127.0.0.4", "127.0.0.1"].map { URL(string: "https://\($0):\(moved)")! }
        XCTAssertEqual(fourLink.addresses, fourAt, "the home's link, its live address last")
        let lastLooked = Recording()
        lastLooked.hold(["127.0.0.2", "127.0.0.3", "127.0.0.4"])
        let sixth = HomeLink(device: phone, credentials: try credentials(), folder: try folder(), transport: lastLooked, finder: Listed([]), look: testLook, reach: testReach)
        let fourPairBegan = ContinuousClock.now
        _ = try await sixth.pair(fourLink, account: nil, name: "iPhone", phone: .another)
        let fourPairTook = ContinuousClock.now - fourPairBegan
        XCTAssertEqual(lastLooked.letGo, 3, "pairing waited on a dead address: each dead one's look is let go once the live one shows the home")
        XCTAssertEqual(try sixth.addresses(), fourAt, "the home's order, where it paired in its place, while the list holds it")
        _ = try await home.ask(["do": "interfaces", "bonjour": "127.0.0.2", "addresses": ["127.0.0.3", "127.0.0.4", "localhost"]])
        let liveLast = ["127.0.0.2", "127.0.0.3", "127.0.0.4", "localhost"].map { URL(string: "https://\($0):\(moved)")! }
        _ = try await sixth.exchange()
        XCTAssertEqual(try sixth.addresses(), liveLast, "a newer list replaces the stored one; where it paired is not in it")
        let letGoBefore = lastLooked.letGo
        let fourExchangeBegan = ContinuousClock.now
        _ = try await sixth.exchange()
        let fourExchangeTook = ContinuousClock.now - fourExchangeBegan
        XCTAssertEqual(lastLooked.letGo - letGoBefore, 3, "the exchange waited on a dead address: each dead one's look is let go")
        XCTAssertEqual(lastLooked.last("POST")?.url.absoluteString, liveLast[3].absoluteString + "/v1/exchange")
        lastLooked.hold([])

        _ = try await home.ask(["do": "interfaces", "bonjour": "127.0.0.2", "addresses": ["127.0.0.3", "127.0.0.4", "127.0.0.5"]])
        let deadAt = ["127.0.0.2", "127.0.0.3", "127.0.0.4", "127.0.0.5"].map { URL(string: "https://\($0):\(moved)")! }
        let told = try await sixth.exchange()
        XCTAssertEqual(told.addresses, deadAt)
        XCTAssertEqual(try sixth.addresses(), deadAt, "a newer list replaces the stored one")
        let deadExchangeBegan = ContinuousClock.now
        do {
            _ = try await sixth.exchange()
            XCTFail("an exchange whose addresses answer nothing was answered")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .noAnswer(sent: false), "no address answered: the exchange never left")
            XCTAssertEqual(failure.description, "not sent")
        }
        let deadExchangeTook = ContinuousClock.now - deadExchangeBegan
        XCTAssertLessThan(deadExchangeTook, .seconds(testReach + 1), "an exchange took longer than one reach to say so")
        let dead = try await home.ask(["do": "pair"])
        let deadLink = try XCTUnwrap(PairingLink(try XCTUnwrap(dead["link"] as? String)))
        let seventh = HomeLink(device: phone, credentials: try credentials(), folder: try folder(), transport: Recording(), finder: Listed([]), look: testLook, reach: testReach)
        let deadPairBegan = ContinuousClock.now
        do {
            _ = try await seventh.pair(deadLink, account: nil, name: "iPhone", phone: .another)
            XCTFail("a link whose addresses answer nothing paired")
        } catch LinkFailure.noAnswer {}
        let deadPairTook = ContinuousClock.now - deadPairBegan
        XCTAssertLessThan(deadPairTook, .seconds(testReach + 1), "pairing took longer than one reach to say so")

        report["link"] = text.replacingOccurrences(of: link.code, with: "<code>")
        report["tailnet"] = ["addresses": awayLink.addresses.map(\.absoluteString), "paired_at": try fourth.name()?.absoluteString ?? "",
                             "seconds": Self.seconds(awayTook)]
        report["nowhere"] = ["seconds": Self.seconds(nowhereTook)]
        report["four"] = ["addresses": fourAt.map(\.absoluteString), "live_last": liveLast.map(\.absoluteString), "pair_seconds": Self.seconds(fourPairTook),
                          "exchange_seconds": Self.seconds(fourExchangeTook)]
        report["dead"] = ["told": deadAt.map(\.absoluteString), "exchange_seconds": Self.seconds(deadExchangeTook), "pair_seconds": Self.seconds(deadPairTook)]
        report["refused"] = "notTheHome"
        report["addresses"] = try first.addresses().map(\.absoluteString)
        report["requests"] = recorded.lines
        report["typed"] = ["found": found.map(\.address.absoluteString), "theirs": theirs.match(code: code), "ours": ours.match(code: code), "mac": match,
                           "account": "none"]
        report["stalled"] = ["connections": relay.connections, "seconds": Self.seconds(took)]
        try write(report)
    }

    func testAnAddressWithNoRoadIsNeverAskedAndTheRoadedAreLookedAtTogether() async throws {
        let home = try LanHome()
        defer { home.stop() }
        let ready = try await home.ready()
        let lan = try XCTUnwrap(ready["lan"] as? Int)
        let door = try XCTUnwrap(ready["door"] as? String)
        _ = try await home.ask(["do": "interfaces", "bonjour": "mac-a.local", "addresses": ["100.100.0.1", "100.100.0.2"]])
        let names = ["mac-a.local", "100.100.0.1", "100.100.0.2"].map { "https://\($0):\(lan)" }
        let shown = try await home.ask(["do": "pair"])
        let text = try XCTUnwrap(shown["link"] as? String)
        let link = try XCTUnwrap(PairingLink(text))
        XCTAssertEqual(link.addresses.map(\.absoluteString), names)
        let roads = Roads()
        let network = Facts()
        let pass = try credentials(), place = try folder()
        let phoneLink = HomeLink(device: phone, credentials: pass, folder: place, transport: roads, finder: Listed([]),
                                 network: network)
        _ = try await phoneLink.pair(link, account: link.account, name: "iPhone")
        XCTAssertEqual(Set(try phoneLink.addresses().map(\.absoluteString)), Set(names), "the home's list, wherever it paired")
        await phoneLink.clockReadsEnded()
        _ = roads.take()
        var report: [String: Any] = [:]

        for (name, facts) in [("offline", NetworkFacts(online: false, onLocalNetwork: false, tunnelUp: false, path: 1, cost: .free)),
                              ("cellular-tailscale-off", NetworkFacts(online: true, onLocalNetwork: false, tunnelUp: false, path: 2, cost: .free))] {
            network.set(facts)
            do { _ = try await phoneLink.exchange(); XCTFail("\(name): an exchange with no road answered") } catch LinkFailure.noAnswer {}
            let looked = await phoneLink.look(for: link)
            XCTAssertEqual(looked, .noAnswer(sent: false), "\(name): a pairing link with no road")
            XCTAssertEqual(roads.take(), [], "\(name): nothing reached the transport")
            report[name] = [String]()
        }

        network.set(NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: false, path: 3, cost: .free))
        do { _ = try await phoneLink.exchange() } catch { XCTFail("on the Wi-Fi: \(error), asked \(roads.take()), \(roads.errors)"); return }
        let onWiFi = roads.take()
        XCTAssertEqual(onWiFi, ["look mac-a.local", "POST mac-a.local/v1/exchange"])
        report["wifi-tailscale-off"] = onWiFi

        _ = try await phoneLink.exchange()
        let same = roads.take()
        XCTAssertEqual(same, ["POST mac-a.local/v1/exchange"])
        report["same-path"] = same

        network.set(NetworkFacts(online: true, onLocalNetwork: false, tunnelUp: true, path: 4, cost: .free))
        _ = try await phoneLink.exchange()
        let moved = roads.take()
        XCTAssertFalse(moved.contains { $0.contains("mac-a.local") }, "the Bonjour name off the Wi-Fi: \(moved)")
        let answeredAt = try XCTUnwrap(moved.last.flatMap { $0.hasPrefix("POST ") ? $0 : nil }, "an exchange went: \(moved)")
        XCTAssertTrue(moved.contains("look 100.100.0.1") || moved.contains("look 100.100.0.2"), "looked at first: \(moved)")
        report["cellular-tailscale-on"] = moved

        network.set(NetworkFacts(online: true, onLocalNetwork: false, tunnelUp: true, path: 5, cost: .free))
        _ = try await phoneLink.exchange()
        let changed = roads.take()
        let host = String(answeredAt.dropFirst("POST ".count).prefix { $0 != "/" })
        XCTAssertTrue(changed.contains("look " + host), "the path changed: looked at again: \(changed)")
        XCTAssertEqual(changed.last.map { $0.hasPrefix("POST ") }, true, changed.description)
        report["path-changed"] = changed

        network.set(NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: true, path: 6, cost: .free))
        roads.hold("mac-a.local")
        _ = try await phoneLink.exchange()
        let together = roads.take()
        XCTAssertEqual(Set(together.filter { $0.hasPrefix("look ") }), ["look mac-a.local", "look 100.100.0.1", "look 100.100.0.2"],
                       "every roaded address looked at together: \(together)")
        XCTAssertFalse(together.contains("POST mac-a.local/v1/exchange"), together.description)
        XCTAssertEqual(roads.letGo, 1, "the held look was cancelled, never waited out")
        report["together"] = together
        roads.hold(nil)

        network.set(nil)
        _ = try await phoneLink.exchange()
        let unknown = roads.take()
        XCTAssertEqual(Set(unknown.filter { $0.hasPrefix("look ") }), ["look mac-a.local", "look 100.100.0.1", "look 100.100.0.2"],
                       unknown.description)
        report["unknown"] = unknown

        let typed = try await home.ask(["do": "pair"])
        let code = try XCTUnwrap(typed["code"] as? String)
        let macFacts = Facts()
        let mac = HomeLink(device: HomeLink.Device(kind: .mac, version: "5026", model: "MacBook Pro", serial4: "0001"),
                           credentials: try self.credentials(), folder: try folder(), transport: Roads(), finder: Listed([]), network: macFacts)
        _ = try await mac.pair(code: code, name: door)
        _ = try await mac.exchange()
        XCTAssertEqual(macFacts.reads, 1, "a Mac at loopback reads the network once, to state it, and never to choose a road")
        report["mac-facts-read"] = macFacts.reads

        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".build/e2e")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            .write(to: directory.appendingPathComponent("roads.json"))
    }


    private static func link(_ text: String, port: Int, at: [String]) throws -> PairingLink {
        var parts = try XCTUnwrap(URLComponents(string: text))
        let kept = (parts.queryItems ?? []).filter { $0.name != "at" }.map { $0.name == "port" ? URLQueryItem(name: "port", value: String(port)) : $0 }
        parts.queryItems = kept + at.map { URLQueryItem(name: "at", value: $0) }
        return try XCTUnwrap(PairingLink(try XCTUnwrap(parts.string)))
    }

    private static func seconds(_ duration: Duration) -> Double {
        Double(duration.components.seconds) + Double(duration.components.attoseconds) / 1e18
    }

    private static func closedPort() throws -> Int {
        let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        defer { close(socket) }
        var address = sockaddr_in(sin_len: UInt8(MemoryLayout<sockaddr_in>.size), sin_family: sa_family_t(AF_INET), sin_port: 0,
                                  sin_addr: in_addr(s_addr: inet_addr("127.0.0.1")), sin_zero: (0, 0, 0, 0, 0, 0, 0, 0))
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(socket, $0, length) == 0 && getsockname(socket, $0, &length) == 0 }
        }
        guard bound else { throw POSIXError(.EADDRNOTAVAIL) }
        return Int(UInt16(bigEndian: address.sin_port))
    }

    private func folder() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-wifi-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func credentials() throws -> FileCredentials {
        FileCredentials(url: try folder().appendingPathComponent("pass"))
    }

    private func write(_ report: [String: Any]) throws {
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".build/e2e")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            .write(to: directory.appendingPathComponent("wifi.json"))
    }
}

private final class Relay: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "wifi-tests.relay")
    private let lock = NSLock()
    private var taken: [NWConnection] = []
    private var ready: CheckedContinuation<UInt16, Error>?

    var connections: Int { lock.withLock { taken.count } }

    private init(to target: Int) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [weak self] inbound in self?.take(inbound, to: target) }
        listener.stateUpdateHandler = { [weak self] state in self?.changed(state) }
    }

    static func start(to target: Int) async throws -> (Relay, port: UInt16) {
        let relay = try Relay(to: target)
        let port = try await withCheckedThrowingContinuation { (done: CheckedContinuation<UInt16, Error>) in
            relay.lock.withLock { relay.ready = done }
            relay.listener.start(queue: relay.queue)
        }
        return (relay, port)
    }

    private func changed(_ state: NWListener.State) {
        let answer: Result<UInt16, Error>? = switch state {
        case .ready: .success(listener.port!.rawValue)
        case .failed(let error): .failure(error)
        default: nil
        }
        guard let answer, let done = lock.withLock({ () -> CheckedContinuation<UInt16, Error>? in defer { ready = nil }; return ready }) else { return }
        done.resume(with: answer)
    }

    private func take(_ inbound: NWConnection, to target: Int) {
        let first = lock.withLock { () -> Bool in
            taken.append(inbound)
            return taken.count == 1
        }
        inbound.start(queue: queue)
        guard !first else { return }
        let outbound = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: UInt16(target))!, using: .tcp)
        outbound.start(queue: queue)
        Self.pipe(inbound, outbound)
        Self.pipe(outbound, inbound)
    }

    func stop() {
        listener.cancel()
        lock.withLock { taken.forEach { $0.cancel() } }
    }

    private static func pipe(_ from: NWConnection, _ to: NWConnection) {
        from.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, done, error in
            if let data, !data.isEmpty { to.send(content: data, completion: .contentProcessed { _ in }) }
            if done || error != nil {
                to.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in })
                return
            }
            pipe(from, to)
        }
    }
}

private struct Listed: HomeFinder {
    let urls: [URL]
    init(_ urls: [URL]) { self.urls = urls }
    func find(within: TimeInterval) async -> [URL] { urls }
}

private final class Recording: HomeTransport, @unchecked Sendable {
    private let inner = URLSessionTransport()
    private let lock = NSLock()
    private var made: [HomeRequest] = []
    private var said: [String] = []
    private var held: Set<String> = []
    private var cancelled = 0

    var lines: [String] { lock.withLock { said } }
    var letGo: Int { lock.withLock { cancelled } }

    func hold(_ hosts: Set<String>) { lock.withLock { held = hosts } }

    func last(_ method: String) -> HomeRequest? {
        lock.withLock { made.last { $0.method == method } }
    }

    func perform(_ request: HomeRequest) async throws -> HomeResponse {
        lock.withLock {
            made.append(request)
            said.append("\(request.method) \(request.url.absoluteString.replacingOccurrences(of: #"/v1/bundles/.*"#, with: "/v1/bundles/<id>", options: .regularExpression))\(request.pin == nil ? "" : " pinned")")
        }
        return try await inner.perform(request)
    }

    func identify(_ address: URL, within: TimeInterval) async throws -> String {
        let holding = lock.withLock { () -> Bool in
            said.append("look \(address.absoluteString)")
            return held.contains(address.host ?? "")
        }
        if holding {
            do {
                try await Task.sleep(for: .seconds(within))
            } catch {
                lock.withLock { cancelled += 1 }
                throw error
            }
            throw URLError(.timedOut)
        }
        return try await inner.identify(address, within: within)
    }
}

private final class Facts: NetworkWatch, @unchecked Sendable {
    private let lock = NSLock()
    private var now: NetworkFacts?
    private var read = 0

    var reads: Int { lock.withLock { read } }
    var facts: NetworkFacts? { lock.withLock { read += 1; return now } }

    func set(_ facts: NetworkFacts?) { lock.withLock { now = facts } }
    func changes() -> AsyncStream<NetworkFacts> {
        let first = lock.withLock { now }
        return AsyncStream { continuation in
            if let first { continuation.yield(first) }
        }
    }
}

private final class Roads: HomeTransport, @unchecked Sendable {
    private static let carried = ["mac-a.local": "127.0.0.1", "100.100.0.1": "localhost", "100.100.0.2": "localhost"]
    private let inner = URLSessionTransport()
    private let lock = NSLock()
    private var said: [String] = []
    private var held: String?
    private var cancelled = 0
    private var failures: [String] = []

    var letGo: Int { lock.withLock { cancelled } }
    var errors: [String] { lock.withLock { failures } }

    func take() -> [String] { lock.withLock { defer { said = [] }; return said } }

    func hold(_ host: String?) { lock.withLock { held = host } }

    func perform(_ request: HomeRequest) async throws -> HomeResponse {
        lock.withLock { said.append("\(request.method) \(request.url.host ?? "")\(request.url.path)") }
        var onward = HomeRequest(method: request.method, url: Self.carry(request.url), headers: request.headers, body: request.body,
                                 timeout: request.timeout)
        onward.pin = request.pin
        do {
            return try await inner.perform(onward)
        } catch {
            lock.withLock { failures.append("\(request.method) \(onward.url): \(error)") }
            throw error
        }
    }

    func identify(_ address: URL, within: TimeInterval) async throws -> String {
        let holding = lock.withLock { () -> Bool in
            said.append("look \(address.host ?? "")")
            return address.host == held
        }
        if holding {
            do {
                try await Task.sleep(for: .seconds(within))
            } catch {
                lock.withLock { cancelled += 1 }
                throw error
            }
            throw URLError(.timedOut)
        }
        do {
            return try await inner.identify(Self.carry(address), within: within)
        } catch {
            lock.withLock { failures.append("look \(Self.carry(address)): \(error)") }
            throw error
        }
    }

    private static func carry(_ url: URL) -> URL {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false), let host = parts.host, let to = carried[host] else { return url }
        parts.host = to
        return parts.url ?? url
    }
}

private final class LanHome: @unchecked Sendable {
    private let process = Process()
    private let input = Pipe()
    private var lines: AsyncLineSequence<FileHandle.AsyncBytes>.AsyncIterator
    private let words: Task<String, Never>

    init() throws {
        let output = Pipe()
        let errors = Pipe()
        let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["node", "--import", "tsx", "packages/home/test/lan-home.ts"]
        process.currentDirectoryURL = repository
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        guard fcntl(input.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EBADF)
        }
        lines = output.fileHandleForReading.bytes.lines.makeAsyncIterator()
        let said = errors.fileHandleForReading
        words = Task {
            await withCheckedContinuation { (done: CheckedContinuation<String, Never>) in
                DispatchQueue.global().async {
                    var kept = Data()
                    while case let data = said.availableData, !data.isEmpty {
                        try? FileHandle.standardError.write(contentsOf: data)
                        kept = (kept + data).suffix(8_192)
                    }
                    done.resume(returning: String(decoding: kept, as: UTF8.self))
                }
            }
        }
        try process.run()
    }

    func ready() async throws -> [String: Any] {
        let line = try await next()
        guard line["ready"] as? Bool == true else { throw Harness.said(line) }
        return line
    }

    func ask(_ command: [String: Any]) async throws -> [String: Any] {
        let sent = try JSONSerialization.data(withJSONObject: command) + Data("\n".utf8)
        do {
            try input.fileHandleForWriting.write(contentsOf: sent)
        } catch {
            throw await ended()
        }
        let line = try await next()
        guard line["ok"] as? Bool == true, let value = line["value"] as? [String: Any] else { throw Harness.said(line) }
        return value
    }

    func stop() {
        try? input.fileHandleForWriting.close()
        process.waitUntilExit()
        // external: Foundation's Process starts its child as a new process group's leader, and the door and home node spawns join that group
        kill(-process.processIdentifier, SIGKILL)
    }

    private func next() async throws -> [String: Any] {
        guard let line = try await lines.next() else { throw await ended() }
        guard let object = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] else { throw Harness.said(["line": line]) }
        return object
    }

    private func ended() async -> Harness {
        process.waitUntilExit()
        kill(-process.processIdentifier, SIGKILL)
        return .ended(status: process.terminationStatus, words: await words.value)
    }

    enum Harness: Error, CustomStringConvertible {
        case ended(status: Int32, words: String)
        case said([String: Any])

        var description: String {
            switch self {
            case let .ended(status, words): "lan-home ended (exit \(status)), its last words: \(words)"
            case let .said(line): "lan-home said \(line)"
            }
        }
    }
}
