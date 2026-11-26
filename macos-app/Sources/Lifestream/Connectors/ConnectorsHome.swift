import Foundation
import HomeLink
import Passwords

extension HomeSocket {
    static func linked(_ link: @escaping @Sendable () -> HomeLink?) async -> HomeSocket? {
        await Task.detached { thisMac(failed: probing(link)) }.value
    }

    static func probing(_ link: @escaping @Sendable () -> HomeLink?) -> @Sendable () -> Void {
        { Task { await link()?.probeSoon() } }
    }
}

struct ConnectorsHome: Sendable {
    let socket: HomeSocket

    func report() async throws -> ConnectorsReport {
        try decode(try await ask(["verb": "connectors", "args": [String]()]))
    }

    func connectAccount(_ connector: String, route: String, values: [String: String]) async throws -> Account {
        try signIn(try await ask(["verb": "account-connect", "connector": connector, "route": route, "values": values]))
    }

    struct Account: Decodable, Equatable, Sendable {
        let account: String
        let source: String
    }

    func deviceStart(_ connector: String, route: String) async throws -> DeviceCode {
        try signIn(try await ask(["verb": "device-start", "connector": connector, "route": route]))
    }

    struct DeviceCode: Decodable, Equatable, Sendable {
        let code: String
        let open: URL
        let intervalMs: Int
        let attempt: HomeLink.JSON

        enum CodingKeys: String, CodingKey {
            case code, open, attempt
            case intervalMs = "interval_ms"
        }
    }

    func devicePoll(_ connector: String, route: String, attempt: HomeLink.JSON, intervalMs: Int) async throws -> DevicePoll {
        try signIn(try await ask(["verb": "device-poll", "connector": connector, "route": route, "attempt": try plain(attempt),
                                  "interval_ms": intervalMs]))
    }

    func clientStart(_ connector: String, route: String, client: HomeLink.ClientTyped?) async throws -> ClientStarted {
        var request: [String: Any] = ["verb": "client-start", "connector": connector, "route": route]
        if let client { request["client"] = ["client_id": client.clientId, "client_secret": client.clientSecret] }
        return try signIn(try await ask(request))
    }

    struct ClientStarted: Decodable, Equatable, Sendable {
        let open: URL
        let attempt: HomeLink.JSON
        let listening: Bool
    }

    func clientFinish(_ connector: String, route: String, attempt: HomeLink.JSON, address: String?) async throws -> ClientFinished {
        var request: [String: Any] = ["verb": "client-finish", "connector": connector, "route": route, "attempt": try plain(attempt)]
        if let address { request["address"] = address }
        return try signIn(try await ask(request))
    }

    struct ClientFinished: Decodable, Equatable, Sendable {
        enum State: String, Decodable, Sendable {
            case pending
            case signedIn = "signed_in"
        }

        let state: State
    }

    func sealField(_ connector: String, member: String, value: String) async throws {
        let _: Sealed = try signIn(try await ask(["verb": "seal-field", "connector": connector, "member": member, "value": value]))
    }

    private struct Sealed: Decodable {
        let sealed: Bool
    }

    private func plain(_ attempt: HomeLink.JSON) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(attempt), options: .fragmentsAllowed)
    }

    private func signIn<Value: Decodable>(_ data: Data) throws -> Value {
        if let refusal = try? JSONDecoder().decode(Refusal.self, from: data) {
            throw HostRefusal(refusal.refused, field: refusal.field)
        }
        return try decode(data)
    }

    private struct Refusal: Decodable {
        let refused: String
        let field: String?
    }

    struct DevicePoll: Decodable, Equatable, Sendable {
        enum State: String, Decodable, Sendable {
            case pending, denied, expired
            case signedIn = "signed_in"
        }

        let state: State
        let intervalMs: Int?

        enum CodingKeys: String, CodingKey {
            case state
            case intervalMs = "interval_ms"
        }
    }

    func turn(_ source: String, on: Bool) async throws {
        _ = try await ask(["verb": "connectors", "args": [on ? "on" : "off", source]])
    }

    @discardableResult
    func set(_ connector: String, _ member: String, to value: HomeLink.JSON, was: HomeLink.JSON? = nil) async throws -> HomeLink.SettingAnswer {
        let set: Changed = try decode(try await ask(["verb": "connectors", "args": try setArgs(connector, member, value, was: was)]))
        return HomeLink.SettingAnswer(landed: .init(connector: connector, member: member, value: set.changed.first { $0.member == member }?.value ?? .null))
    }

    private struct Changed: Decodable {
        let changed: [Member]

        struct Member: Decodable {
            let member: String
            let value: HomeLink.JSON
        }
    }

    private func setArgs(_ connector: String, _ member: String, _ value: HomeLink.JSON, was: HomeLink.JSON?) throws -> [String] {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        func text(_ json: HomeLink.JSON) throws -> String { String(decoding: try encoder.encode(json), as: UTF8.self) }
        let guarded = try was.map { ["--was=" + (try text($0))] } ?? []
        return guarded + ["--", "set", connector, member, try text(value)]
    }

    func pause(stream id: String, _ pause: Bool, history: Bool) async throws {
        let word = pause ? "pause" : "resume"
        _ = try await ask(["verb": "connectors", "args": history ? ["backfill", id, word] : [word, id]])
    }

    func pauseHome() async throws {
        _ = try await ask(["verb": "pause", "args": ["home", "--reason", "Paused by you"]])
    }

    func resume(_ target: String) async throws {
        _ = try await ask(["verb": "resume", "args": ["--", target]])
    }

    func set(_ setting: HostAct.HomeSetting) async throws {
        _ = try await ask(["verb": "settings", "args": setting.args])
    }

    func models(_ act: HostAct.ModelsAct) async throws {
        _ = try await ask(["verb": "models", "args": act.options + ["--"] + act.args])
    }

    func process(family: String, item: String, prompt: String, route: String) async throws {
        _ = try await ask(["verb": "models", "args": ["--", "process", family, item, prompt, route]])
    }

    func faces(_ what: HostAct.FacesAct) async throws {
        _ = try await ask(["verb": "faces", "args": [what.rawValue]])
    }

    func revoke(pass: String) async throws {
        _ = try await ask(["verb": "principals", "args": ["revoke", pass]])
    }

    func retire(unit: String) async throws {
        _ = try await ask(["verb": "device", "args": ["retire", unit]])
    }

    static func pairArgs(appleID: String?) -> [String] {
        appleID.map { ["--account", $0] } ?? []
    }

    func showPairing(appleID: String?) async throws -> PairingAnswer {
        try decode(try await ask(["verb": "pair", "args": ["show"] + Self.pairArgs(appleID: appleID)], waiting: 0))
    }

    func name(unit: String, as name: String) async throws {
        _ = try await ask(["verb": "device", "args": ["--", "name", unit, name]])
    }

    func skip(unit: String, step: String) async throws {
        _ = try await ask(["verb": "setup", "args": ["skip", unit, step]])
    }

    func at(unit: String, step: String) async throws {
        _ = try await ask(["verb": "setup", "args": ["at", unit, step]])
    }

    func connectRequests() async throws -> [ConnectRequest] {
        let answer: Connecting = try decode(try await ask(["verb": "connect", "args": [String]()], waiting: 0))
        return answer.requests
    }

    func connectAnswer(id: String, allow: Bool) async throws {
        _ = try await ask(["verb": "connect", "args": ["answer", id, allow ? "allow" : "deny"]])
    }

    func disconnectAgent(_ id: String) async throws {
        _ = try await ask(["verb": "agents", "args": ["disconnect", "--", id]])
    }

    func unlistAgent(_ id: String) async throws {
        _ = try await ask(["verb": "agents", "args": ["unlist", "--", id]])
    }

    private func ask(_ request: [String: Any], waiting: TimeInterval? = nil) async throws -> Data {
        let socket = socket
        let line = try JSONSerialization.data(withJSONObject: request.merging(["by": "you"]) { $1 })
        return try await HomeSocket.blocking {
            Result {
                let request = try JSONSerialization.jsonObject(with: line) as? [String: Any] ?? [:]
                return try JSONSerialization.data(withJSONObject: try socket.ask(request, waiting: waiting ?? socket.patience),
                                                  options: .fragmentsAllowed)
            }
        }.get()
    }

    private struct Connecting: Decodable {
        let requests: [ConnectRequest]
    }

    private func decode<Value: Decodable>(_ data: Data) throws -> Value {
        try JSONDecoder().decode(Value.self, from: data)
    }
}
