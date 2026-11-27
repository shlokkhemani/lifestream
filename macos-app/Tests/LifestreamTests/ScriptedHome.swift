import Foundation
import HomeLink
import Passwords

final class ScriptedHome: @unchecked Sendable {
    let path: String
    let pointer: URL
    let folder: URL
    private let root: String
    private let fd: Int32
    private let lock = NSLock()
    private let script: ([String: Any]) -> [String: Any]
    private let concurrent: Bool
    private var _requests: [[String: Any]] = []
    private var stopped = false

    var requests: [[String: Any]] { lock.withLock { _requests } }

    init(concurrent: Bool = false, _ script: @escaping ([String: Any]) -> [String: Any]) throws {
        self.script = script
        self.concurrent = concurrent
        root = "/tmp/lsc-\(UUID().uuidString.prefix(8))"
        (pointer, folder, path) = try SocketMachine.make(root)
        fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        let bound = Self.withAddress(path) { Darwin.bind(fd, $0, $1) }
        guard bound == 0, Darwin.listen(fd, 8) == 0 else { throw POSIXError(.EADDRINUSE) }
        Thread.detachNewThread { [self] in serve() }
    }

    func stop() {
        let first = lock.withLock { () -> Bool in
            defer { stopped = true }
            return !stopped
        }
        guard first else { return }
        let wake = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        _ = Self.withAddress(path) { Darwin.connect(wake, $0, $1) }
        Darwin.close(wake)
        try? FileManager.default.removeItem(atPath: root)
    }

    private func serve() {
        defer { Darwin.close(fd) }
        while !lock.withLock({ stopped }) {
            let client = Darwin.accept(fd, nil, nil)
            guard client >= 0 else { return }
            if lock.withLock({ stopped }) {
                Darwin.close(client)
                return
            }
            if concurrent {
                Thread.detachNewThread { [self] in answer(client) }
            } else {
                answer(client)
            }
        }
    }

    private static func withAddress(_ path: String, _ body: (UnsafePointer<sockaddr>, socklen_t) -> Int32) -> Int32 {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8) + [0]
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        return withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { body($0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
    }

    private func answer(_ client: Int32) {
        var line = Data()
        var byte: UInt8 = 0
        while Darwin.recv(client, &byte, 1, 0) == 1, byte != 10 { line.append(byte) }
        var request = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] ?? [:]
        let refused = SocketMachine.otherFolder(request, folder)
        request["folder"] = nil
        lock.withLock { _requests.append(request) }
        let answer = refused ?? script(request)
        for object in [["out": "a line as the verb goes"], answer] {
            var data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
            data.append(10)
            _ = data.withUnsafeBytes { Darwin.send(client, $0.baseAddress, $0.count, 0) }
        }
        Darwin.close(client)
    }
}

enum SocketMachine {
    static let wrongKey: [String: Any] = {
        let words = "the Mac app offered a key that is not this vault's: nothing was changed"
        return ["error": words, "refusal": ["status": 403, "code": "VAULT_KEY", "words": words, "extra": [String: Any]()]]
    }()

    static func otherFolder(_ request: [String: Any], _ folder: URL) -> [String: Any]? {
        guard request["folder"] as? String != folder.path else { return nil }
        let words = "a request names the folder of the home it asks (folder)"
        return ["error": words, "refusal": ["status": 400, "code": "BAD_CALL", "words": words, "extra": [String: Any]()]]
    }

    static func make(_ root: String) throws -> (pointer: URL, folder: URL, path: String) {
        let machine = URL(fileURLWithPath: root, isDirectory: true)
        let folder = machine.appendingPathComponent("folder", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try JSONSerialization.data(withJSONObject: ["id": "home-\(UUID().uuidString.prefix(8).lowercased())"])
            .write(to: folder.appendingPathComponent("HOME.json"))
        let pointer = machine.appendingPathComponent("home")
        try Data((folder.path + "\n").utf8).write(to: pointer)
        guard let socket = HomeSocket.thisMac(pointer: pointer) else { throw POSIXError(.ENOENT) }
        try FileManager.default.createDirectory(atPath: (socket.path as NSString).deletingLastPathComponent,
                                                withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return (pointer, socket.folder, socket.path)
    }
}

enum HomeReport {
    static let fixture: [String: Any] = {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try! Data(contentsOf: root.appendingPathComponent("homelink/Tests/Fixtures/report.json"))
        return try! JSONSerialization.jsonObject(with: data) as! [String: Any]
    }()

    private static var rows: [[String: Any]] { fixture["connectors"] as! [[String: Any]] }

    static func report(_ connectors: [[String: Any]], devices: [[String: Any]] = []) -> [String: Any] {
        fixture.merging(["connectors": connectors, "devices": devices, "needs": [Any](), "paused": [Any]()]) { $1 }
    }

    static func connector(_ id: String, _ name: String, before: [String] = [], sources: [String] = [], setUp: Bool = false,
                          members: [[String: Any]] = []) -> [String: Any] {
        let screen = rows.first { $0["id"] as? String == "screen" }!
        let like = rows.first { $0["id"] as? String == id } ?? screen
        let copy = (screen["copies"] as! [[String: Any]])[0]
        let health: [String: Any] = ["state": setUp ? "ok" : "setup", "reason": NSNull(), "words": "", "since_ms": NSNull(),
                                     "next_ms": NSNull(), "acts": [Any](), "detail": NSNull()]
        return like.merging([
            "id": id, "name": name, "product": id, "before": before, "set_up": setUp, "health": health, "members": members,
            "copies": sources.map { copy.merging(["id": $0, "name": $0]) { $1 } }, "pauses": [Any](),
            "export": NSNull(),
            "ways": [Any](),
        ]) { $1 }
    }

    static func member(_ key: String, _ kind: String, panel: String? = "settings", label: String = "A member",
                       _ more: [String: Any] = [:]) -> [String: Any] {
        let proof = (try! JSONSerialization.jsonObject(with: Data(contentsOf: ProofReport.file)) as! [String: Any])["connectors"] as! [[String: Any]]
        let like = (rows + proof).flatMap { $0["members"] as! [[String: Any]] }.first { $0["kind"] as? String == kind }!
        return like.merging(["key": key, "label": label, "panel": panel as Any? ?? NSNull()]) { $1 }.merging(more) { $1 }
    }

    static var granola: [String: Any] {
        rows.first { $0["id"] as? String == "granola" }!
    }

    static func phone(_ unit: String, _ name: String, retired: Bool = false, pass: String?, replaced: [String] = []) -> [String: Any] {
        let like = (fixture["devices"] as! [[String: Any]]).first { $0["kind"] as? String == "phone" }!
        return like.merging(["unit": unit, "name": name, "retired": retired, "pass": pass as Any? ?? NSNull(), "replaced": replaced]) { $1 }
    }

    static func need(_ id: String, _ words: String, since: Int64? = 1_760_252_400_000, connector: String? = nil,
                     reason: String? = nil, acts: [[String: Any]] = [], kind: String = "notice", about: String? = nil,
                     weight: String = "stopped") -> HomeLink.Need {
        let like = (fixture["needs"] as! [[String: Any]])[0]
        let need = like.merging(["id": id, "weight": weight, "words": words, "since_ms": since as Any? ?? NSNull(), "connector": connector as Any? ?? NSNull(),
                                 "copy": NSNull(), "reason": reason as Any? ?? NSNull(), "acts": acts,
                                 "kind": kind, "about": about as Any? ?? NSNull()]) { $1 }
        return try! JSONDecoder().decode(HomeLink.Need.self, from: JSONSerialization.data(withJSONObject: need))
    }

    static func password(_ secret: String, connector: String, member: String, _ words: String,
                         since: Int64? = 1_760_252_400_000) -> HomeLink.Need {
        need("password:" + secret, words, since: since, connector: connector, reason: "password", acts: [["do": "set", "label": "Set", "member": member]],
             kind: "password", about: "Lifestream keeps it locked with your other passwords.")
    }

    static func knock(_ browser: String, _ words: String, since: Int64? = 1_760_252_400_000) -> HomeLink.Need {
        need("connect:" + browser, words, since: since, acts: [["do": "browser", "label": "Connect", "of": browser]],
             kind: "connect", about: "Connect it if you just added the extension")
    }
}
