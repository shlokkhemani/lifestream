import Foundation
import HomeLink
import Network
import Passwords
import Recorder
import Shipping
import WebKit
import XCTest
@testable import Lifestream

final class HostContractTests: XCTestCase {
    private let address = DashboardAddress(port: 4317)

    static let unreachable = reach(.unreachable(.silent, since: Date(timeIntervalSince1970: 0)),
                                   routes: HomeLink.Routes(online: true, local: nil, tailscale: nil, here: true))

    static func reach(_ reach: HomeLink.Reach, revision: Int = 3, routes: HomeLink.Routes? = nil) -> HostState.Reach {
        HostState.Reach(HomeLink.ReachSnapshot(reach: reach, lastReached: nil, revision: revision, routes: routes),
                        clock: .placeholder(at: Date(timeIntervalSince1970: 0), zone: TimeZone(identifier: "UTC")!), now: Date(timeIntervalSince1970: 0))
    }

    @MainActor static func state(reach: HostState.Reach? = nil, needs: [Need] = [], grants: [Grant: Bool] = [:],
                                 inset: HostState.Inset? = nil, folder: URL? = nil, asking: [Grant] = []) -> HostState {
        var state = HostState(recorder: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true))
        state.inset = inset
        state.reach = reach
        state.grants = HostState.GrantRow.all(grants, asking: asking, denied: [])
        state.needs = needs.map { HostState.NeedRow($0, saved: false) }
        state.folder = folder?.path
        return state
    }

    @MainActor func testThePresenceAndTheStateEnterThePageAsSafeJSON() throws {
        let hostile = "</script><script>alert(1)</script>\"'\u{2028}\u{2029}"
        let state = Self.state(folder: URL(fileURLWithPath: "/Volumes/Drive-A/" + hostile))
        let presence = try HostBridge.presenceScript(state)
        XCTAssertTrue(presence.hasPrefix(#"window.lifestreamHost = {kind: "mac", version: 6, state: {"#), presence)
        XCTAssertEqual(HostBridge.handler, "lifestream")
        for script in [presence, try HostBridge.stateScript(state), try HostBridge.hashScript(hostile)] {
            XCTAssertFalse(script.contains("</script>"), script)
            XCTAssertFalse(script.contains("\u{2028}") || script.contains("\u{2029}"), script)
        }
        XCTAssertTrue(try HostBridge.stateScript(state).hasSuffix(#"window.dispatchEvent(new Event("lifestream:state")); }"#))
        XCTAssertEqual(try HostBridge.hashScript("view=connectors&dialog=settings/mac"), #"location.hash="view=connectors&dialog=settings\/mac";"#)
        let literal = try HostBridge.scriptLiteral(hostile)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: Data(literal.utf8), options: .fragmentsAllowed) as? String, hostile)

        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try HostBridge.scriptLiteral(state).utf8)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["recorder", "grants", "needs", "folder", "agent_requests", "agent_asks"],
                       "a home that answers said something")
        XCTAssertEqual((object["agent_requests"] as? [Any])?.count, 0, "the sign-ins' list left out while empty")
        XCTAssertEqual((object["agent_asks"] as? [Any])?.count, 0, "the asks' list left out while empty")
        XCTAssertEqual(object["folder"] as? String, "/Volumes/Drive-A/" + hostile)
        XCTAssertEqual(object["recorder"] as? [String: String], ["signal": "engaged", "words": "Recording"])
        let troubled = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try HostBridge.scriptLiteral(Self.state(reach: Self.unreachable)).utf8)) as? [String: Any])
        let link = { (id: String, name: String, state: String, value: String, fix: Any) -> NSDictionary in
            ["id": id, "name": name, "state": state, "value": value, "fix": fix, "act": NSNull()] as NSDictionary
        }
        XCTAssertEqual(troubled["reach"] as? NSDictionary, ["state": "unreachable", "revision": 3, "tone": "warning",
                                                            "title": "Can't reach Lifestream", "line": "Lifestream isn't answering",
                                                            "meta": NSNull(), "acts": [Any](), "last": NSNull(),
                                                            "path": [link("lifestream", "Lifestream on this Mac", "passed", "Running", NSNull()),
                                                                     link("drive", "Lifestream's drive", "passed", "Connected", NSNull()),
                                                                     link("home", "Lifestream", "failed", "Not answering",
                                                                          "Lifestream asks it again on its own")],
                                                            "checking": false] as NSDictionary)
        let quiet = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try HostBridge.scriptLiteral(Self.state(reach: Self.reach(.answering))).utf8)) as? [String: Any])
        XCTAssertEqual(quiet["reach"] as? NSDictionary, ["state": "answering", "revision": 3, "tone": NSNull(), "title": NSNull(),
                                                         "line": NSNull(), "meta": NSNull(), "acts": [Any](), "last": NSNull(),
                                                         "path": [Any](), "checking": false] as NSDictionary)
        let check = try JSONDecoder().decode(HomeLink.Act.self, from: Data(#"{"do":"verify","label":"Check again"}"#.utf8))
        let holding = Self.reach(.held(HomeLink.Held(title: "Lifestream's database is damaged.", detail: "It needs a good copy of home.db put back.",
                                                     acts: [check])))
        let heldState = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try HostBridge.scriptLiteral(Self.state(reach: holding)).utf8)) as? [String: Any])
        let heldHome = try XCTUnwrap(heldState["reach"] as? [String: Any])
        XCTAssertEqual(heldHome["state"] as? String, "held")
        XCTAssertEqual(heldHome["title"] as? String, "Lifestream's database is damaged.")
        XCTAssertEqual(heldHome["line"] as? String, "It needs a good copy of home.db put back.")
        XCTAssertEqual(heldHome["acts"] as? [[String: String]], [["do": "verify", "label": "Check again"]])
        XCTAssertEqual((object["grants"] as? [Any])?.count, 0, "grants said before macOS was read")
        let asked = HomeReport.password("gmail.password", connector: "gmail", member: "password", "Type it")
        let knock = HomeReport.knock("arc", "Arc asks", since: 1_761_400_920_000)
        let disk = HomeReport.need("disk", "The disk is filling", since: 1_761_400_920_000, acts: [["do": "storage", "label": "Manage storage"]])
        let needs = Self.state(needs: [.allow, .password(asked, set: asked.acts[0]), .connect(knock, browser: knock.acts[0]), .notice(disk)])
        let needRows = try XCTUnwrap((JSONSerialization.jsonObject(with: Data(try HostBridge.scriptLiteral(needs).utf8)) as? [String: Any])?["needs"] as? [[String: Any]])
        XCTAssertEqual(needRows.map { $0["home"] as? Bool }, [false, true, true, true])
        var held = Self.state()
        held.update = HostState.NeedRow(.updateReady("1900"), saved: false)
        let update = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try HostBridge.scriptLiteral(held).utf8)) as? [String: Any])
        XCTAssertEqual((update["update"] as? [String: Any])?["id"] as? String, "update:ready")
        XCTAssertEqual((update["update"] as? [String: Any])?["line"] as? String, "Lifestream 1900 is ready")
        XCTAssertEqual(((update["update"] as? [String: Any])?["acts"] as? [[String: String]])?.first,
                       ["id": "do", "label": "Restart to Update", "tone": "caution"])
        XCTAssertEqual((update["needs"] as? [Any])?.count, 0)
        held.general = General.State(login: true, autoUpdate: false, version: "1900", update: nil)
        let general = try XCTUnwrap((JSONSerialization.jsonObject(with: Data(try HostBridge.scriptLiteral(held).utf8)) as? [String: Any])?["general"]
            as? [String: Any])
        XCTAssertEqual(Set(general.keys), ["login", "auto_update", "version", "update", "by_hand", "command"])
        XCTAssertEqual(general["login"] as? Bool, true)
        XCTAssertEqual(general["auto_update"] as? Bool, false)
        XCTAssertEqual(general["version"] as? String, "1900")
        XCTAssertTrue(general["update"] is NSNull)
        XCTAssertTrue(general["by_hand"] is NSNull)
        XCTAssertTrue(general["command"] is NSNull)
        held.general?.command = General.Command(state: .installed, words: "lifestream works in new terminal windows.",
                                                prompt: "Lifestream runs on this Mac. Run ~/.local/bin/lifestream help connectors and follow it to add a connector for ___; type each lifestream command it names as ~/.local/bin/lifestream.")
        let command = try XCTUnwrap(((JSONSerialization.jsonObject(with: Data(try HostBridge.scriptLiteral(held).utf8)) as? [String: Any])?["general"]
            as? [String: Any])?["command"] as? [String: Any])
        XCTAssertEqual(Set(command.keys), ["state", "words", "prompt"])
        XCTAssertEqual(command["state"] as? String, "installed")

        let read = Self.state(grants: Dictionary(uniqueKeysWithValues: Grant.allCases.map { ($0, $0 != .screenRecording && $0 != .bluetooth && $0 != .microphone) }),
                              inset: HostState.Inset(left: 78, centre: 14), asking: [.accessibility, .screenRecording, .microphone])
        let grants = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try HostBridge.scriptLiteral(read).utf8)) as? [String: Any])
        let rows = try XCTUnwrap(grants["grants"] as? [[String: Any]])
        XCTAssertEqual(rows.map { $0["id"] as? String }, Grant.listed.map(\.rawValue), "the login item is a row: it is Settings'")
        XCTAssertEqual(rows.filter { $0["granted"] as? Bool == false }.count, 3)
        XCTAssertEqual(rows.map { $0["asking"] as? Bool }, [true, false, false, false, false, false, false],
                       "a held grant read asking, or one after the first not held did")
        XCTAssertNil(grants["allow_all"])
        XCTAssertNil(grants["walk"])
        XCTAssertEqual(grants["inset"] as? [String: Double], ["left": 78, "centre": 14])
    }

    func testOnlyTheDashboardsTopDocumentIsHeard() {
        XCTAssertTrue(HostBridge.hears(.init(scheme: "http", host: "127.0.0.1", port: 4317, mainFrame: true), address: address))
        XCTAssertTrue(HostBridge.hears(.init(scheme: "http", host: "localhost", port: 4317, mainFrame: true), address: address))
        for sender in [HostBridge.Sender(scheme: "http", host: "127.0.0.1", port: 4318, mainFrame: true),
                       .init(scheme: "https", host: "127.0.0.1", port: 4317, mainFrame: true),
                       .init(scheme: "http", host: "example.com", port: 4317, mainFrame: true),
                       .init(scheme: "http", host: "127.0.0.2", port: 4317, mainFrame: true),
                       .init(scheme: "http", host: "127.0.0.1", port: 4317, mainFrame: false)] {
            XCTAssertFalse(HostBridge.hears(sender, address: address), "\(sender)")
        }
    }

    func testEachActIsReadAndAnythingElseRefusedInWords() {
        func act(_ body: [String: Any]) -> Result<HostAct, HostRefusal> { HostAct.read(["type": "act"].merging(body) { $1 }) }
        let source = "imessage:person-a+tag@example.com:macbook-pro-0001"
        XCTAssertEqual(act(["act": "allow", "grants": ["screenRecording", "accessibility", "screenRecording"]]),
                       .success(.allow([.screenRecording, .accessibility])))
        XCTAssertEqual(act(["act": "turn", "sources": [source], "on": false]), .success(.turn(sources: [source], on: false)))
        XCTAssertEqual(act(["act": "pause", "connector": "imessage"]), .success(.pause(connector: "imessage", history: false)))
        XCTAssertEqual(act(["act": "resume", "connector": "imessage"]), .success(.resume(connector: "imessage", history: false)))
        XCTAssertEqual(act(["act": "pause", "connector": "imessage", "scope": "history"]), .success(.pause(connector: "imessage", history: true)))
        XCTAssertEqual(act(["act": "resume", "connector": "imessage", "scope": "history"]), .success(.resume(connector: "imessage", history: true)))
        XCTAssertEqual(act(["act": "end-install", "pass": "p-0000aa01"]), .success(.endInstall(pass: "p-0000aa01")))
        for what in ["on", "off"] {
            XCTAssertEqual(act(["act": "faces", "do": what]), .success(.faces(HostAct.FacesAct(rawValue: what)!)))
        }
        XCTAssertEqual(act(["act": "retire-phone", "unit": "iphone-17-pro-0001"]), .success(.retirePhone(unit: "iphone-17-pro-0001")))
        XCTAssertEqual(act(["act": "home", "do": "verify"]), .success(.verifyHome))
        XCTAssertEqual(act(["act": "home", "do": "probe"]), .success(.probeHome))
        XCTAssertEqual(act(["act": "home", "do": "pair"]), .success(.pairHome))
        XCTAssertEqual(act(["act": "need", "need": "password:gmail.password", "button": "do"]), .success(.need(key: "password:gmail.password", button: .do)))
        XCTAssertEqual(act(["act": "need", "need": "update", "button": "try-again"]), .success(.need(key: "update", button: .tryAgain)))
        XCTAssertEqual(act(["act": "sheet", "sheet": "pass"]), .failure(.unreadable(nil)))
        XCTAssertEqual(act(["act": "agent-disconnect", "id": "p-87165c7c"]), .success(.agentDisconnect(id: "p-87165c7c")))
        XCTAssertEqual(act(["act": "screenshot-take"]), .success(.screenshotTake))
        XCTAssertEqual(act(["act": "agent-unlist", "id": "p-87165c7c"]), .success(.agentUnlist(id: "p-87165c7c")))
        XCTAssertEqual(act(["act": "agent-add", "name": "Hermes", "anywhere": kCFBooleanFalse as Any]), .failure(.update(nil)))
        XCTAssertEqual(act(["act": "agents-public", "on": kCFBooleanTrue as Any]), .failure(.update(nil)))
        XCTAssertEqual(act(["act": "sheet", "connector": "granola", "route": "granola-api"]),
                       .success(.sheet(.init(connector: "granola", route: "granola-api"))))
        XCTAssertEqual(act(["act": "sheet", "connector": "example-oauth", "route": "example-oauth"]),
                       .success(.sheet(.init(connector: "example-oauth", route: "example-oauth"))))
        XCTAssertEqual(act(["act": "refresh", "connector": "example-bank"]), .success(.refresh(connector: "example-bank")))
        XCTAssertEqual(act(["act": "sheet", "sheet": "recovery-key"]), .failure(.unreadable(nil)))
        XCTAssertEqual(act(["act": "setting", "connector": "gmail", "member": "refresh", "value": "10m"]),
                       .success(.setting(connector: "gmail", member: "refresh", value: .string("10m"))))
        XCTAssertEqual(act(["act": "setting", "connector": "gmail", "member": "folders", "value": ["INBOX", "Sent"]]),
                       .success(.setting(connector: "gmail", member: "folders", value: .array([.string("INBOX"), .string("Sent")]))))
        XCTAssertEqual(act(["act": "setting", "connector": "google", "member": "products", "value": ["mail"], "was": NSNull()]),
                       .success(.setting(connector: "google", member: "products", value: .array([.string("mail")]), was: .null)))
        XCTAssertEqual(act(["act": "setting", "connector": "google", "member": "products", "value": [Any](), "was": ["mail", "calendar"]]),
                       .success(.setting(connector: "google", member: "products", value: .array([]), was: .array([.string("mail"), .string("calendar")]))))
        XCTAssertEqual(act(["act": "setting", "connector": "google", "member": "products", "value": ["mail"], "was": Date()]), .failure(.unreadable(nil)),
                       "a was that is no JSON")
        XCTAssertEqual(act(["act": "setting", "connector": "faces", "member": "battery_backlog", "value": 500]),
                       .success(.setting(connector: "faces", member: "battery_backlog", value: .number(500))))
        XCTAssertEqual(act(["act": "setting", "connector": "screen", "member": "on_battery", "value": kCFBooleanTrue as Any]),
                       .success(.setting(connector: "screen", member: "on_battery", value: .bool(true))))
        let modes: [[String: Any]] = [["app": "com.example.notes-fake", "mode": "exclude"], ["site": "mybank.example.com", "mode": "activity"]]
        XCTAssertEqual(act(["act": "setting", "connector": "screen", "member": "apps", "value": modes]),
                       .success(.setting(connector: "screen", member: "apps", value: .array([
                           .object(["app": .string("com.example.notes-fake"), "mode": .string("exclude")]),
                           .object(["site": .string("mybank.example.com"), "mode": .string("activity")]),
                       ]))))
        XCTAssertEqual(act(["act": "seal", "connector": "whoop", "member": "password", "value": " fake pass "]),
                       .success(.seal(connector: "whoop", member: "password", value: " fake pass ")))
        XCTAssertEqual(act(["act": "import", "do": "choose", "kind": "spotify"]), .success(.import(.choose(kind: "spotify"))))
        XCTAssertEqual(act(["act": "import", "do": "again", "kind": "spotify", "file": "file-a", "label": "Choose again"]),
                       .success(.import(.again(kind: "spotify", file: "file-a"))))
        XCTAssertEqual(act(["act": "import", "do": "forget", "kind": "spotify", "file": "file-a", "label": "Remove"]),
                       .success(.import(.forget(kind: "spotify", file: "file-a"))))
        for odd: [String: Any] in [["act": "import", "kind": "spotify"], ["act": "import", "do": "drop", "kind": "spotify"],
                                   ["act": "import", "do": "choose", "file": "file-a"], ["act": "import", "do": "choose", "kind": ""],
                                   ["act": "import", "do": "choose", "kind": "spotify", "file": "file-a"],
                                   ["act": "import", "do": "again", "kind": "spotify"], ["act": "import", "do": "again", "file": "file-a"],
                                   ["act": "import", "do": "forget", "kind": "spotify", "file": 7],
                                   ["act": "import", "do": "forget", "kind": "spotify", "file": String(repeating: "f", count: 201)]] {
            XCTAssertNil(try? act(odd).get(), "an import act misshapen was heard: \(odd)")
        }
        XCTAssertEqual(act(["act": "upload", "connector": "facebook", "label": "Upload"]), .success(.upload(connector: "facebook")))
        for odd: [String: Any] in [["act": "upload"], ["act": "upload", "connector": ""], ["act": "upload", "connector": "facebook", "drawn": [:] as [String: Any]]] {
            XCTAssertNil(try? act(odd).get(), "an upload misshapen was heard: \(odd)")
        }
        XCTAssertEqual(act(["act": "choose-file", "connector": "whatsapp", "member": "backups"]),
                       .success(.chooseFile(connector: "whatsapp", member: "backups")))
        XCTAssertEqual(act(["act": "choose-app"]), .success(.chooseApp))
        for (what, opening) in [("home-log", HostAct.Opening.homeLog), ("storage", .storage), ("home-folder", .homeFolder)] {
            XCTAssertEqual(act(["act": "open", "what": what]), .success(.open(opening)))
        }
        XCTAssertEqual(act(["act": "open", "what": "browser-store", "browser": "arc"]), .success(.open(.browserStore("arc"))))
        XCTAssertEqual(act(["act": "open", "what": "site", "url": "https://chatgpt.com/", "browser": "chrome"]),
                       .success(.open(.site(URL(string: "https://chatgpt.com/")!, browser: "chrome"))))
        XCTAssertEqual(act(["act": "open", "what": "site", "url": "https://auth.openai.com/codex/device"]),
                       .success(.open(.site(URL(string: "https://auth.openai.com/codex/device")!, browser: nil))))
        XCTAssertEqual(Detection.sites(of: URL(string: "https://auth.openai.com/codex/device")!), ["openai.com", "chatgpt.com"])
        XCTAssertEqual(act(["act": "skip", "step": "iphone"]), .success(.skip(step: "iphone")))
        XCTAssertEqual(act(["act": "skip", "step": "step 2"]), .success(.skip(step: "step 2")))
        XCTAssertEqual(act(["act": "at", "step": "browser"]), .success(.at(step: "browser")))
        XCTAssertEqual(act(["act": "pairing", "do": "open"]), .success(.pairing(open: true)))
        XCTAssertEqual(act(["act": "pairing", "do": "close"]), .success(.pairing(open: false)))
        XCTAssertEqual(act(["act": "ask-login", "do": "start", "of": "chatgpt"]), .success(.askLogin(.start(.chatgpt))))
        XCTAssertEqual(act(["act": "ask-login", "do": "start", "of": "claude"]), .success(.askLogin(.start(.claude))))
        XCTAssertEqual(act(["act": "ask-login", "do": "cancel", "of": "claude"]), .success(.askLogin(.cancel(.claude))))
        XCTAssertEqual(act(["act": "ask-login", "do": "sign_out", "of": "chatgpt"]), .success(.askLogin(.signOut(.chatgpt))))
        XCTAssertEqual(act(["act": "ask-login", "do": "code", "of": "claude", "attempt": "0f3a9c2e7b1d4a60", "code": "synthetic-code#synthetic-state"]),
                       .success(.askLogin(.code(attempt: "0f3a9c2e7b1d4a60", code: "synthetic-code#synthetic-state"))))
        XCTAssertEqual(act(["act": "seal", "secret": "openrouter", "value": "sk-or-v1-fake0000"]), .success(.openRouterKey("sk-or-v1-fake0000")))
        XCTAssertEqual(act(["act": "seal", "secret": "openrouter", "value": NSNull()]), .success(.openRouterKey(nil)))
        for use in HostAct.ModelUse.allCases {
            XCTAssertEqual(act(["act": "models", "do": "default", "use": use.rawValue, "model": "runner:runner-macbook-pro-0001/qwen3.5-4b"]),
                           .success(.models(.default(use: use, model: "runner:runner-macbook-pro-0001/qwen3.5-4b"))), use.rawValue)
        }
        for use in HostAct.ModelUse.allCases where use != .chat {
            XCTAssertEqual(act(["act": "models", "do": "default", "use": use.rawValue, "model": "none"]), .success(.models(.default(use: use, model: "none"))))
        }
        XCTAssertEqual(act(["act": "models", "do": "default", "use": "chat", "model": "claude:claude-opus-5-5", "thinking": "high"]),
                       .success(.models(.default(use: .chat, model: "claude:claude-opus-5-5", thinking: "high"))))
        for refused: [String: Any] in [["use": "text", "model": "claude:claude-opus-5-5", "thinking": "high"],
                                       ["use": "chat", "model": "none", "thinking": "high"],
                                       ["use": "chat", "model": "none"],
                                       ["use": "voice", "model": "claude:claude-opus-5-5"],
                                       ["kind": "pictures", "route": "claude:claude-opus-5-5"],
                                       ["use": "pictures", "model": "claude:claude-opus-5-5", "route": "claude:claude-opus-5-5"]] {
            XCTAssertEqual(act((["act": "models", "do": "default"] as [String: Any]).merging(refused) { $1 }), .failure(.unreadable(nil)), "\(refused)")
        }
        let thinking = HostAct.ModelsAct.default(use: .chat, model: "claude:claude-opus-5-5", thinking: "high")
        XCTAssertEqual(thinking.options + ["--"] + thinking.args, ["--thinking", "high", "--", "default", "chat", "claude:claude-opus-5-5"],
                       "a flag after -- reaches the verb as a word of its own")
        XCTAssertEqual(HostAct.ModelsAct.default(use: .search, model: "none").args, ["default", "search", "none"])
        XCTAssertEqual(act(["act": "models", "do": "file", "runner": "runner-macbook-pro-0001", "id": "qwen3.5-4b", "to": "fetch"]),
                       .success(.models(.file(runner: "runner-macbook-pro-0001", id: "qwen3.5-4b", fetch: true))))
        XCTAssertEqual(act(["act": "models", "do": "file", "runner": "runner-macbook-pro-0001", "id": "qwen3.5-4b", "to": "remove"]),
                       .success(.models(.file(runner: "runner-macbook-pro-0001", id: "qwen3.5-4b", fetch: false))))
        XCTAssertEqual(act(["act": "models", "do": "runner", "runner": "runner-macbook-pro-0001", "to": "pause"]),
                       .success(.models(.runner("runner-macbook-pro-0001", pause: true))))
        XCTAssertEqual(act(["act": "models", "do": "runner", "runner": "runner-macbook-pro-0001", "to": "resume"]),
                       .success(.models(.runner("runner-macbook-pro-0001", pause: false))))
        XCTAssertEqual(act(["act": "models", "do": "battery", "runner": "runner-macbook-pro-0001", "to": "save"]),
                       .success(.models(.battery("runner-macbook-pro-0001", save: true))))
        XCTAssertEqual(act(["act": "models", "do": "battery", "runner": "runner-macbook-pro-0001", "to": "spend"]),
                       .success(.models(.battery("runner-macbook-pro-0001", save: false))))
        XCTAssertEqual(act(["act": "models", "do": "address", "url": "http://127.0.0.1:11434/v1"]),
                       .success(.models(.address(url: "http://127.0.0.1:11434/v1", input: nil))))
        XCTAssertEqual(act(["act": "models", "do": "address", "url": "http://127.0.0.1:11434/v1", "input": ["text", "image"]]),
                       .success(.models(.address(url: "http://127.0.0.1:11434/v1", input: [.text, .image]))))
        XCTAssertEqual(act(["act": "models", "do": "address", "url": "https://user:secret@example.com/v1?key=k", "input": ["text"]]),
                       .success(.models(.address(url: "https://user:secret@example.com/v1?key=k", input: [.text]))))
        for input: Any in [["image"], ["image", "text"], ["text", "text"], ["text", "audio"], [String](), "text"] {
            XCTAssertEqual(act(["act": "models", "do": "address", "url": "http://127.0.0.1:11434/v1", "input": input]), .failure(.unreadable(nil)), "\(input)")
        }
        XCTAssertEqual(act(["act": "models", "do": "address", "url": "http://127.0.0.1:11434/v1", "model": "qwen3.5:4b"]), .failure(.unreadable(nil)))
        XCTAssertEqual(act(["act": "models", "do": "address", "url": "none"]), .failure(.unreadable(nil)))
        XCTAssertEqual(act(["act": "models", "do": "address", "none": kCFBooleanTrue as Any]), .success(.models(.addressNone)))
        XCTAssertEqual(HostAct.ModelsAct.address(url: "http://127.0.0.1:11434/v1", input: [.text, .image]).args,
                       ["address", "http://127.0.0.1:11434/v1", "text,image"])
        XCTAssertEqual(HostAct.ModelsAct.address(url: "http://127.0.0.1:11434/v1", input: nil).args, ["address", "http://127.0.0.1:11434/v1"])
        XCTAssertEqual(act(["act": "models", "do": "address", "url": "https://api.example.com/v1", "key": "sk-fake0000"]),
                       .success(.models(.address(url: "https://api.example.com/v1", input: nil, key: "sk-fake0000"))))
        XCTAssertEqual(act(["act": "models", "do": "address", "url": "https://api.example.com/v1", "input": ["text"], "key": "sk-fake0000"]),
                       .success(.models(.address(url: "https://api.example.com/v1", input: [.text], key: "sk-fake0000"))))
        for key: Any in ["", "sk fake", 7, NSNull()] {
            XCTAssertEqual(act(["act": "models", "do": "address", "url": "https://api.example.com/v1", "key": key]), .failure(.unreadable(nil)), "\(key)")
        }
        let keyed = HostAct.ModelsAct.address(url: "https://api.example.com/v1", input: nil, key: "sk-fake0000")
        XCTAssertEqual(keyed.options + ["--"] + keyed.args, ["--key", "--", "address", "https://api.example.com/v1"],
                       "the key goes to the vault, never into the verb's arguments")
        XCTAssertEqual(act(["act": "process", "family": "photos", "item": "ph-0001", "prompt": "describe", "route": "openrouter:fake-model"]),
                       .success(.process(family: "photos", item: "ph-0001", prompt: "describe", route: "openrouter:fake-model")))
        XCTAssertEqual(act(["act": "general-login", "on": kCFBooleanTrue as Any]), .success(.general(.login(on: true))))
        XCTAssertEqual(act(["act": "general-auto-update", "on": kCFBooleanFalse as Any]), .success(.general(.autoUpdate(on: false))))
        XCTAssertEqual(act(["act": "general-check"]), .success(.general(.check)))
        XCTAssertEqual(act(["act": "general-command", "do": "install"]), .success(.general(.command(.install))))
        XCTAssertEqual(act(["act": "general-command", "do": "remove"]), .success(.general(.command(.remove))))
        XCTAssertEqual(act(["act": "uninstall"]), .success(.general(.uninstall)))
        XCTAssertEqual(act(["act": "pause", "target": "home"]), .success(.pauseHome))
        for target in ["home", "pause:gmail", "pause:gmail:history", "runner:macbook-pro-0001", "kind:import"] {
            XCTAssertEqual(act(["act": "resume", "target": target]), .success(.resumePause(target: target)), target)
        }
        XCTAssertEqual(act(["act": "home-setting", "key": "model.cap", "value": 16]), .success(.homeSetting(.modelCap(16))))
        XCTAssertEqual(HostAct.HomeSetting.modelCap(16).args, ["set", "model.cap", "16"])
        XCTAssertEqual(act(["act": "home-setting", "key": "history.start", "value": "2026-05-23"]), .success(.homeSetting(.historyStart("2026-05-23"))))
        XCTAssertEqual(act(["act": "home-setting", "key": "history.start", "value": "all"]), .success(.homeSetting(.historyStart("all"))))
        for value: Any in ["2026-5-23", "everything", "", NSNull(), 6] {
            XCTAssertEqual(act(["act": "home-setting", "key": "history.start", "value": value]), .failure(.unreadable(nil)), "\(value)")
        }
        XCTAssertEqual(HostAct.HomeSetting.historyStart("2026-05-23").args, ["set", #"{"history.start":"2026-05-23"}"#])
        for choice in MobileData.Choice.allCases {
            XCTAssertEqual(act(["act": "home-setting", "key": "devices.macbook-pro-0001.mobile_data", "value": choice.rawValue]),
                           .success(.mobileData(key: "devices.macbook-pro-0001.mobile_data", choice: choice)), choice.rawValue)
        }
        for value: Any in ["all", "metered", "", NSNull(), 1] {
            XCTAssertEqual(act(["act": "home-setting", "key": "devices.macbook-pro-0001.mobile_data", "value": value]),
                           .failure(.unreadable(nil)), "\(value)")
        }
        for key in ["devices..mobile_data", "devices.macbook-pro-0001.mobile_data.x", "devices.a.b.mobile_data", "device.macbook-pro-0001.mobile_data"] {
            XCTAssertEqual(act(["act": "home-setting", "key": key, "value": "now"]), .failure(.unreadable(nil)), key)
        }
        let choice: [String: Any] = ["privacy.level": "all", "privacy.chat": "names"]
        XCTAssertEqual(act(["act": "home-setting", "settings": choice]),
                       .success(.homeSetting(.privacy([.word(.chat, "names"), .word(.level, "all")]))))
        for gone in ["privacy.detector", "search.meaning", "search.meaning.model"] {
            XCTAssertEqual(act(["act": "home-setting", "settings": [gone: "runner-macbook-pro-0001"]]), .failure(.unreadable(nil)), gone)
        }
        for word in HostAct.HomeSetting.PrivacyWord.allCases {
            XCTAssertEqual(act(["act": "home-setting", "settings": [word.rawValue: "none"]]), .success(.homeSetting(.privacy([.word(word, "none")]))))
            XCTAssertEqual(act(["act": "home-setting", "settings": [word.rawValue: NSNull()]]), .success(.homeSetting(.privacy([.word(word, nil)]))))
        }
        for list in HostAct.HomeSetting.PrivacyWords.allCases {
            XCTAssertEqual(act(["act": "home-setting", "settings": [list.rawValue: ["Project Fake", "-x"]]]),
                           .success(.homeSetting(.privacy([.words(list, ["Project Fake", "-x"])]))))
            XCTAssertEqual(act(["act": "home-setting", "settings": [list.rawValue: [String]()]]), .success(.homeSetting(.privacy([.words(list, [])]))))
            XCTAssertEqual(act(["act": "home-setting", "settings": [list.rawValue: NSNull()]]), .success(.homeSetting(.privacy([.words(list, nil)]))))
        }
        XCTAssertEqual(HostAct.HomeSetting.privacy([.word(.links, "path"), .word(.level, "all")]).args,
                       ["set", #"{"privacy.level":"all","privacy.links":"path"}"#])
        XCTAssertEqual(HostAct.HomeSetting.privacy([.words(.always, ["Project Fake", "a/b"]), .word(.chat, nil)]).args,
                       ["set", #"{"privacy.always":["Project Fake","a/b"],"privacy.chat":null}"#])
        XCTAssertEqual(act(["act": "home-setting", "settings": ["search.meaning.power": "plugged-idle"]]),
                       .success(.homeSetting(.meaningPower("plugged-idle"))))
        XCTAssertEqual(act(["act": "home-setting", "settings": ["search.meaning.power": NSNull()]]), .success(.homeSetting(.meaningPower(nil))))
        XCTAssertEqual(act(["act": "home-setting", "settings": ["search.meaning.power": "plugged-idle", "privacy.level": "all"]]),
                       .failure(.unreadable(nil)))
        XCTAssertEqual(HostAct.HomeSetting.meaningPower("plugged-idle").args, ["set", #"{"search.meaning.power":"plugged-idle"}"#])
        XCTAssertEqual(HostAct.HomeSetting.meaningPower(nil).args, ["set", #"{"search.meaning.power":null}"#])
        XCTAssertEqual(act(["act": "device-name", "unit": "macbook-pro-0001", "name": "-Studio Mac"]),
                       .success(.deviceName(unit: "macbook-pro-0001", name: "-Studio Mac")))
        for theme in AppAppearance.allCases {
            XCTAssertEqual(act(["act": "appearance", "theme": theme.rawValue]), .success(.general(.appearance(theme))))
        }
        XCTAssertEqual(act(["act": "connect-wait", "do": "open"]), .success(.connectWait(open: true)))
        XCTAssertEqual(act(["act": "connect-wait", "do": "close"]), .success(.connectWait(open: false)))
        XCTAssertEqual(act(["act": "connect-answer", "id": "c-0001", "allow": true]), .success(.connectAnswer(id: "c-0001", allow: true)))
        XCTAssertEqual(WindowGestures.asked(["type": "act", "act": "window", "do": "drag"]), .drag)
        XCTAssertEqual(WindowGestures.asked(["type": "act", "act": "window", "do": "zoom"]), .zoom)
        XCTAssertNil(WindowGestures.asked(["type": "act", "act": "window", "do": "close"]))
        XCTAssertNil(WindowGestures.asked(["act": "window", "do": "drag"]))
        XCTAssertNil(WindowGestures.asked(["type": "act", "act": "sheet", "do": "drag"]))
        XCTAssertEqual(act(["act": "turn", "sources": [String(repeating: "s", count: 200)], "on": true]),
                       .success(.turn(sources: [String(repeating: "s", count: 200)], on: true)))

        let refused: [Any] = [
            "act", ["act": "allow", "grants": ["fullDiskAccess"]],
            ["type": "act", "act": "pause"], ["type": "act", "act": "allow", "grants": ["notifications"]],
            ["type": "act", "act": "allow", "grants": [String]()], ["type": "act", "act": "allow", "grants": "microphone"],
            ["type": "act", "act": "allow", "grants": Array(repeating: "microphone", count: Grant.allCases.count + 1)], ["type": "act", "act": "allow"],
            ["type": "act", "act": "turn", "sources": [source], "on": 1], ["type": "act", "act": "turn", "sources": [source]],
            ["type": "act", "act": "turn", "sources": Array(repeating: source, count: 65), "on": true],
            ["type": "act", "act": "turn", "sources": [String(repeating: "s", count: 201)], "on": true],
            ["type": "act", "act": "turn", "sources": [""], "on": true], ["type": "act", "act": "turn", "sources": [4], "on": true],
            ["type": "act", "act": "end-install"], ["type": "act", "act": "retire-phone", "unit": 7],
            ["type": "act", "act": "faces"], ["type": "act", "act": "faces", "do": "now"], ["type": "act", "act": "faces", "do": true],
            ["type": "act", "act": "home"], ["type": "act", "act": "home", "do": "restore"], ["type": "act", "act": "home", "do": true],
            ["type": "act", "act": "resume", "connector": ""],
            ["type": "act", "act": "pause", "connector": String(repeating: "c", count: 201)],
            ["type": "act", "act": "pause", "connector": "imessage", "scope": "all"],
            ["type": "act", "act": "resume", "connector": "imessage", "scope": "new"],
            ["type": "act", "act": "pause", "connector": "imessage", "scope": true],
            ["type": "act", "act": "need", "need": "update", "button": "allow"], ["type": "act", "act": "need", "button": "do"],
            ["type": "act", "act": "sheet", "sheet": "settings"], ["type": "act", "act": "open", "what": "terminal"],
            ["type": "act", "act": "sheet", "sheet": "gmail"], ["type": "act", "act": "sheet", "sheet": "account"],
            ["type": "act", "act": "sheet", "connector": "gmail"],
            ["type": "act", "act": "sheet", "route": "granola-mcp"],
            ["type": "act", "act": "sheet", "connector": "granola", "route": ""],
            ["type": "act", "act": "sheet", "connector": "granola", "route": 7],
            ["type": "act", "act": "sheet", "sheet": "account", "connector": "granola", "route": "granola-api"],
            ["type": "act", "act": "sheet", "connector": "granola", "acquirer": "granola-api"],
            ["type": "act", "act": "refresh"], ["type": "act", "act": "refresh", "connector": ""],
            ["type": "act", "act": "refresh", "connector": "example-bank", "unit": "macbook-pro-0001"],
            ["type": "act", "act": "setting", "connector": "gmail", "member": "refresh"],
            ["type": "act", "act": "setting", "connector": "gmail", "member": "refresh", "value": NSNull()],
            ["type": "act", "act": "setting", "connector": "gmail", "member": "refresh", "value": String(repeating: "1", count: HostAct.valueLimit + 1)],
            ["type": "act", "act": "import"], ["type": "act", "act": "import", "do": "choose"], ["type": "act", "act": "import", "do": "again", "file": 7],
            ["type": "act", "act": "choose-file", "connector": "whatsapp"], ["type": "act", "act": "choose-file", "member": "backups"],
            ["type": "act", "act": "choose-file", "connector": "whatsapp", "member": String(repeating: "m", count: 201)],
            ["type": "act", "act": "choose-app", "app": "com.example.notes-fake"], ["type": "act", "act": "choose-app", "mode": "activity"],
            ["type": "act", "act": "allow", "grants": ["openAtLogin"]], ["type": "act", "act": "allow", "grants": ["microphone", "openAtLogin"]],
            ["type": "act", "act": "setting", "member": "refresh", "value": "10m"],
            ["type": "act", "act": "seal", "connector": "whoop", "member": "password"],
            ["type": "act", "act": "seal", "connector": "whoop", "member": "password", "value": ""],
            ["type": "act", "act": "seal", "connector": "whoop", "member": "password", "value": 7],
            ["type": "act", "act": "seal", "member": "password", "value": "fake"],
            ["type": "act", "act": "seal", "connector": "whoop", "member": "password", "value": String(repeating: "p", count: HostAct.valueLimit + 1)],
            ["type": "act", "act": "window", "do": "drag"], [1, 2],
            ["type": "act", "act": "screenshot-take", "of": "screen"],
            ["type": "act", "act": "open", "what": "browser-store"], ["type": "act", "act": "open", "what": "browser-store", "browser": ""],
            ["type": "act", "act": "open", "what": "site", "url": "http://chatgpt.com/", "browser": "chrome"],
            ["type": "act", "act": "open", "what": "site", "url": "file:///etc/hosts", "browser": "chrome"],
            ["type": "act", "act": "open", "what": "site", "url": "https://chatgpt.com/", "browser": ""],
            ["type": "act", "act": "open", "what": "site", "url": "https:///nohost", "browser": "chrome"],
            ["type": "act", "act": "skip"], ["type": "act", "act": "skip", "step": ""], ["type": "act", "act": "at"], ["type": "act", "act": "pairing", "do": "renew"],
            ["type": "act", "act": "pairing"],
            ["type": "act", "act": "ask-login", "do": "open"],
            ["type": "act", "act": "ask-login", "do": "start"], ["type": "act", "act": "ask-login", "do": "start", "of": "gemini"],
            ["type": "act", "act": "ask-login", "do": "code", "of": "chatgpt", "attempt": "login-1", "code": "ABCD"],
            ["type": "act", "act": "ask-login", "do": "code", "of": "claude", "code": "ABCD"],
            ["type": "act", "act": "connect-wait", "do": "start"],
            ["type": "act", "act": "seal", "secret": "anthropic", "value": "sk-fake"],
            ["type": "act", "act": "seal", "secret": "openrouter", "value": "sk or"],
            ["type": "act", "act": "seal", "secret": "openrouter", "value": ""],
            ["type": "act", "act": "seal", "secret": "openrouter"],
            ["type": "act", "act": "seal", "secret": "openrouter", "value": "sk-fake", "connector": "whoop"],
            ["type": "act", "act": "models", "do": "default", "kind": "video", "route": "openrouter:fake-model"],
            ["type": "act", "act": "models", "do": "default", "kind": "text"],
            ["type": "act", "act": "models", "do": "file", "runner": "runner-macbook-pro-0001", "id": "qwen3.5-4b", "to": "keep"],
            ["type": "act", "act": "models", "do": "file", "runner": "runner-macbook-pro-0001", "to": "fetch"],
            ["type": "act", "act": "models", "do": "runner", "runner": "runner-macbook-pro-0001", "to": "stop"],
            ["type": "act", "act": "models", "do": "runner", "to": "pause"],
            ["type": "act", "act": "models", "do": "battery", "runner": "runner-macbook-pro-0001", "to": "on"],
            ["type": "act", "act": "models", "do": "battery", "to": "spend"],
            ["type": "act", "act": "models", "do": "address", "url": "", "model": "m", "kinds": ["text"]],
            ["type": "act", "act": "models", "do": "address", "url": 4, "model": "m", "kinds": ["text"]],
            ["type": "act", "act": "models", "do": "address", "url": "https://example.com/v1", "model": "m", "kinds": [String]()],
            ["type": "act", "act": "models", "do": "address", "url": "https://example.com/v1", "model": "m", "kinds": ["video"]],
            ["type": "act", "act": "models", "do": "address", "none": kCFBooleanFalse as Any],
            ["type": "act", "act": "models", "do": "address", "none": kCFBooleanTrue as Any, "url": "https://example.com/v1"],
            ["type": "act", "act": "models", "do": "list"],
            ["type": "act", "act": "process", "family": "photos", "item": "ph-0001", "prompt": "describe"],
            ["type": "act", "act": "general-login", "on": 1], ["type": "act", "act": "general-auto-update"],
            ["type": "act", "act": "general-check", "now": kCFBooleanTrue as Any], ["type": "act", "act": "uninstall", "erase": kCFBooleanTrue as Any],
            ["type": "act", "act": "general-command"], ["type": "act", "act": "general-command", "do": "copy"],
            ["type": "act", "act": "general-command", "do": "install", "shell": "zsh"],
            ["type": "act", "act": "connect-answer", "id": "c-0001"], ["type": "act", "act": "connect-answer", "id": "c-0001", "allow": "yes"],
            ["type": "act", "act": "pause", "target": "pause:gmail"], ["type": "act", "act": "pause", "target": "home", "connector": "gmail"],
            ["type": "act", "act": "resume", "target": ""], ["type": "act", "act": "resume", "target": 7],
            ["type": "act", "act": "resume", "target": String(repeating: "t", count: 201)],
            ["type": "act", "act": "resume", "target": "home", "scope": "history"],
            ["type": "act", "act": "home-setting", "key": "day.zone", "value": "Etc/UTC"],
            ["type": "act", "act": "home-setting", "key": "privacy.level", "value": "all"],
            ["type": "act", "act": "home-setting", "settings": [String: Any]()],
            ["type": "act", "act": "home-setting", "settings": ["model.cap": 8]],
            ["type": "act", "act": "home-setting", "settings": ["privacy.level": "all", "privacy.work": "all"]],
            ["type": "act", "act": "home-setting", "settings": ["privacy.level": ["all"]]],
            ["type": "act", "act": "home-setting", "settings": ["privacy.level": ""]],
            ["type": "act", "act": "home-setting", "settings": ["privacy.links": 1]],
            ["type": "act", "act": "home-setting", "settings": ["privacy.always": "Project Fake"]],
            ["type": "act", "act": "home-setting", "settings": ["privacy.always": ["Project Fake", 4]]],
            ["type": "act", "act": "home-setting", "settings": ["privacy.never": [""]]],
            ["type": "act", "act": "home-setting", "settings": ["privacy.never": [String(repeating: "w", count: 16_384)]]],
            ["type": "act", "act": "home-setting", "settings": ["privacy.level": "all"], "key": "privacy.level"],
            ["type": "act", "act": "home-setting", "settings": "privacy.level"],
            ["type": "act", "act": "home-setting", "settings": ["search.meaning": ""]],
            ["type": "act", "act": "home-setting", "settings": ["search.meaning": true]],
            ["type": "act", "act": "home-setting", "settings": ["search.meaning.power": ["plugged-idle"]]],
            ["type": "act", "act": "home-setting", "settings": ["search.meaning": "off", "privacy.level": "all"]],
            ["type": "act", "act": "home-setting", "settings": ["search.meaning": "off", "search.meaning.size": "big"]],
            ["type": "act", "act": "home-setting", "settings": ["search.meaning.size": "big"]],
            ["type": "act", "act": "home-setting", "key": "search.meaning", "value": "off"],
            ["type": "act", "act": "home-setting", "key": "helpers", "value": 4],
            ["type": "act", "act": "home-setting", "key": "model.cap", "value": 2.5],
            ["type": "act", "act": "home-setting", "key": "model.cap", "value": "8"],
            ["type": "act", "act": "home-setting", "key": "model.cap", "value": kCFBooleanTrue as Any],
            ["type": "act", "act": "home-setting", "key": "model.cap"],
            ["type": "act", "act": "home-setting", "key": "model.cap", "value": NSNull()],
            ["type": "act", "act": "home-setting", "key": "model.cap", "value": 8, "was": 4],
            ["type": "act", "act": "home-setting", "key": "helpers", "value": 4],
            ["type": "act", "act": "home-setting", "key": "model.cap", "value": 2.5],
            ["type": "act", "act": "home-setting", "key": "model.cap", "value": "8"],
            ["type": "act", "act": "home-setting", "key": "model.cap", "value": kCFBooleanTrue as Any],
            ["type": "act", "act": "home-setting", "key": "model.cap"],
            ["type": "act", "act": "home-setting", "key": "model.cap", "value": 8, "was": 4],
            ["type": "act", "act": "device-name", "name": "Studio Mac"], ["type": "act", "act": "device-name", "unit": "macbook-pro-0001"],
            ["type": "act", "act": "device-name", "unit": "macbook-pro-0001", "name": "   "],
            ["type": "act", "act": "device-name", "unit": "macbook-pro-0001", "name": String(repeating: "n", count: 201)],
            ["type": "act", "act": "appearance", "theme": "night"], ["type": "act", "act": "appearance"],
            ["type": "act", "act": "appearance", "theme": "dark", "window": "main"],
        ]
        for body in refused {
            let unknown = (body as? [String: Any])?["act"] as? String == "window"
            XCTAssertEqual(HostAct.read(body), .failure(unknown ? .update(nil) : .unreadable(nil)), "\(body)")
        }
    }

    func testARefusalNamesTheControlAndAnUnknownActAsksForTheUpdate() {
        func act(_ body: [String: Any]) -> Result<HostAct, HostRefusal> { HostAct.read(["type": "act"].merging(body) { $1 }) }
        XCTAssertEqual(act(["act": "export-everything", "label": "Export all"]), .failure(.update("Export all")))
        XCTAssertEqual(HostRefusal.update("Export all").words, "“Export all” needs a newer Lifestream. Update Lifestream on this Mac to do this.")
        XCTAssertEqual(HostRefusal.update(nil).words, "Update Lifestream on this Mac to do this.")
        XCTAssertEqual(act(["act": "refresh", "connector": 7, "label": "Refresh now"]), .failure(.unreadable("Refresh now")))
        XCTAssertEqual(HostRefusal.unreadable("Refresh now").words, "Lifestream could not read this request for “Refresh now”, so nothing was done.")
        XCTAssertEqual(HostRefusal.unreadable(nil).words, "Lifestream could not read this request, so nothing was done.")
        XCTAssertFalse(HostRefusal.unreadable("Refresh now").words.contains("Update"))
        XCTAssertEqual(act(["label": "Allow"]), .failure(.unreadable("Allow")), "a body naming no act is no act this app lacks")
        XCTAssertEqual(act(["act": "refresh", "connector": "gmail", "label": "Refresh now"]), .success(.refresh(connector: "gmail")))
        XCTAssertEqual(act(["act": "choose-app", "label": "Other app…"]), .success(.chooseApp))
        XCTAssertEqual(act(["act": "uninstall", "label": "Uninstall"]), .success(.general(.uninstall)))
        XCTAssertEqual(act(["act": "general-check", "label": 7]), .success(.general(.check)))
        XCTAssertEqual(act(["act": "general-check", "label": String(repeating: "l", count: 201)]), .success(.general(.check)))
        XCTAssertEqual(act(["act": "nothing-yet", "label": "  "]), .failure(.update(nil)))
    }

    func testAStoresAllowIsItsOwnAct() {
        func act(_ body: [String: Any]) -> Result<HostAct, HostRefusal> { HostAct.read(["type": "act"].merging(body) { $1 }) }
        XCTAssertEqual(act(["act": "allow", "grants": ["store:firefox"], "label": "Allow"]), .success(.allowStore(connector: "firefox")))
        XCTAssertEqual(act(["act": "allow", "grants": ["store:"], "label": "Allow"]), .failure(.unreadable("Allow")))
        XCTAssertEqual(act(["act": "allow", "grants": ["store:firefox", "store:arc"]]), .failure(.unreadable(nil)))
        XCTAssertEqual(act(["act": "allow", "grants": ["microphone", "store:firefox"]]), .failure(.unreadable(nil)))
        XCTAssertEqual(act(["act": "allow", "grants": ["store:firefox"], "scope": "all"]), .failure(.unreadable(nil)))
        XCTAssertEqual(act(["act": "allow", "grants": ["microphone"], "label": "Allow"]), .success(.allow([.microphone])))
    }

    func testTheAgentActsAreTheDoorsShapes() throws {
        func act(_ body: [String: Any]) -> Result<HostAct, HostRefusal> { HostAct.read(["type": "act"].merging(body) { $1 }) }
        let badRequest = HostRefusal.badRequest(nil)
        func access(_ value: Any) throws -> HomeLink.Access {
            try JSONDecoder().decode(HomeLink.Access.self, from: JSONSerialization.data(withJSONObject: value))
        }
        for name in ["answer-sign-in", "answer-sign-in-wrong", "answer-sign-in-deny", "answer-sign-in-ended", "answer-once", "answer-always",
                     "answer-edited", "answer-no", "answer-no-access", "answer-stale", "answer-erased", "answer-unknown", "answer-person-only"] {
            let request = try XCTUnwrap(AgentsTests.contract(name)["request"] as? [String: Any])
            let read = try JSONDecoder().decode(HomeLink.AnswerRequest.self, from: JSONSerialization.data(withJSONObject: request))
            XCTAssertEqual(act(["act": "agent-answer"].merging(request) { $1 }), .success(.agentAnswer(read)), name)
        }
        XCTAssertEqual(badRequest.code, (AgentsTests.contract("access-bad")["answer"] as? [String: Any])?["code"] as? String,
                       "not the door's code for a body out of shape")
        let draft: [String: Any] = ["allow": [[String: Any]](), "hide": "names", "window": NSNull()]
        XCTAssertEqual(act(["act": "agent-access", "id": "p-87165c7c", "access": draft, "expect": 3]),
                       .success(.agentAccess(id: "p-87165c7c", access: try access(draft), expect: 3)))
        let widened = try XCTUnwrap(AgentsTests.contract("access-widened")["request"] as? [String: Any])
        XCTAssertEqual(act(["act": "agent-access", "id": "p-00000001"].merging(widened) { $1 }),
                       .success(.agentAccess(id: "p-00000001", access: try access(widened["access"]!), expect: try XCTUnwrap(widened["expect"] as? Int))))

        let bodies: [[String: Any]] = [
            ["act": "agent-answer", "id": "q-1", "answer": "once"],
            ["act": "agent-answer", "id": "q-1", "answer": "always", "access": draft],
            ["act": "agent-answer", "id": "q-1", "answer": "no", "access": draft],
            ["act": "agent-answer", "id": "q-1", "answer": "no", "expect": 1],
            ["act": "agent-answer", "id": "-Rq7", "answer": "deny", "access": draft],
            ["act": "agent-answer", "id": "q-1", "answer": "once", "expect": 1, "access": "everything"],
            ["act": "agent-answer", "id": "q-1", "answer": "once", "expect": 1.5],
            ["act": "agent-answer", "id": "q-1", "answer": "once", "expect": "1"],
            ["act": "agent-answer", "id": "q-1", "answer": "once", "expect": 1, "was": 1],
            ["act": "agent-answer", "answer": 42], ["act": "agent-answer", "id": "", "answer": 42],
            ["act": "agent-answer", "id": String(repeating: "q", count: 201), "answer": 42],
            ["act": "agent-answer", "id": 7, "answer": 42],
            ["act": "agent-access", "id": "p-87165c7c", "access": "names", "expect": 1],
            ["act": "agent-access", "id": "p-87165c7c", "access": [Any](), "expect": 1],
            ["act": "agent-access", "id": "p-87165c7c", "access": draft, "expect": -1],
            ["act": "agent-access", "id": "p-87165c7c", "access": draft, "expect": 1.5],
            ["act": "agent-access", "id": "p-87165c7c", "access": draft, "expect": "1"],
            ["act": "agent-access", "id": "p-87165c7c", "access": draft],
            ["act": "agent-access", "access": draft, "expect": 1],
            ["act": "agent-access", "id": "p-87165c7c", "access": draft, "expect": 1, "was": 0],
        ] + ([42.5, "42", kCFBooleanTrue as Any, "allow", "Once", NSNull()] as [Any]).map { ["act": "agent-answer", "id": "-Rq7", "answer": $0] }
        for body in bodies {
            XCTAssertEqual(act(body), .failure(badRequest), "\(body)")
        }

        let door = try XCTUnwrap(AgentsTests.contract("refused-too-large")["answer"] as? [String: Any])
        let tooLarge = try XCTUnwrap(door["message"] as? String)
        XCTAssertTrue(tooLarge.hasSuffix("the door reads at most \(HostAct.bodyLimit)"), tooLarge)
        let past = HostRefusal("the body states \(HostAct.bodyLimit + 1) bytes; the door reads at most \(HostAct.bodyLimit)",
                               code: try XCTUnwrap(door["code"] as? String))
        XCTAssertEqual(past.code, "BODY_TOO_LARGE")
        func filled(_ count: Int) -> [String: Any] { ["n": String(repeating: "w", count: count)] }
        let limit = HostAct.bodyLimit
        XCTAssertEqual(act(["act": "agent-access", "id": "p-1", "access": filled(limit - 30), "expect": 1]),
                       .success(.agentAccess(id: "p-1", access: try access(filled(limit - 30)), expect: 1)))
        XCTAssertEqual(act(["act": "agent-access", "id": "p-1", "access": filled(limit - 29), "expect": 1]), .failure(past))
        XCTAssertEqual(act(["act": "agent-answer", "id": "s-1", "answer": 42, "access": filled(limit - 42)]),
                       .success(.agentAnswer(.number("s-1", 42, access: try access(filled(limit - 42))))))
        XCTAssertEqual(act(["act": "agent-answer", "id": "s-1", "answer": 42, "access": filled(limit - 41)]), .failure(past))
    }

    func testTheWindowLoadsOnlyTheDashboard() {
        XCTAssertEqual(address.decide(URL(string: "http://127.0.0.1:4317/#view=days")), .load)
        XCTAssertEqual(address.decide(URL(string: "http://localhost:4317/")), .load)
        XCTAssertEqual(address.decide(URL(string: "http://127.0.0.1:4318/")), .openInBrowser)
        XCTAssertEqual(address.decide(URL(string: "https://127.0.0.1:4317/")), .openInBrowser)
        XCTAssertEqual(address.decide(URL(string: "http://person-a:secret@127.0.0.1:4317/")), .openInBrowser)
        XCTAssertEqual(address.decide(URL(string: "https://example.com/")), .openInBrowser)
        XCTAssertEqual(address.decide(URL(string: "imessage:+15550000001")), .openInBrowser)
        XCTAssertEqual(address.decide(URL(string: "sms:person-a@example.com")), .openInBrowser)
        for refused in ["javascript:alert(1)", "file:///etc/hosts", "lifestream:connectors", "lifestream:settings", "data:text/html,x"] {
            XCTAssertEqual(address.decide(URL(string: refused)), .refuse, refused)
        }
        XCTAssertEqual(address.startURL(stored: "https://example.com/"), address.root)
        XCTAssertEqual(address.startURL(stored: "http://127.0.0.1:4317/#view=days", launch: true), URL(string: "http://127.0.0.1:4317/#view=ask"),
                       "a launch opened where the window last was, not on Chat")
        XCTAssertEqual(address.startURL(stored: nil, launch: true), URL(string: "http://127.0.0.1:4317/#view=ask"))
        XCTAssertEqual(address.startURL(stored: "http://127.0.0.1:4317/#view=onboarding&seg=model", launch: true),
                       URL(string: "http://127.0.0.1:4317/#view=onboarding&seg=model"), "a launch left the onboarding a home was left in")
        XCTAssertEqual(address.startURL(stored: "http://127.0.0.1:4317/#view=connectors&dialog=settings/mac"),
                       URL(string: "http://127.0.0.1:4317/#view=connectors&dialog=settings/mac"))
        XCTAssertEqual(DashboardAddress.hash("dialog=settings/mac", over: URL(string: "http://127.0.0.1:4317/#view=people&focus=p1&dialog=faces")!),
                       "view=people&focus=p1&dialog=settings/mac")
        XCTAssertEqual(DashboardAddress.hash("view=days", over: URL(string: "http://127.0.0.1:4317/#view=people")!), "view=days")
        XCTAssertEqual(address.root(hash: "view=connectors&dialog=settings/mac"), URL(string: "http://127.0.0.1:4317/#view=connectors&dialog=settings/mac"))
        XCTAssertEqual(DashboardAddress.view(of: URL(string: "http://127.0.0.1:4317/#day=2026-10-14&view=days")!), "days")
        XCTAssertNil(DashboardAddress.view(of: address.root))
    }

    @MainActor func testAPageAndTheHostSpeakTheContract() async throws {
        let server = try PageServer(["/": ("text/html", Data(Self.page.utf8)), "/frame": ("text/html", Data(Self.frame.utf8))])
        defer { server.stop() }
        let port = try await server.ready()
        let suite = "HostContractTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        defaults.set("http://127.0.0.1:\(port)/#view=days", forKey: "DashboardLastURL")
        let web = WebContent(address: DashboardAddress(port: port), defaults: defaults, dashboardHeld: { false })
        defer { web.close() }
        var said: [String] = []
        var acts: [HostAct] = []
        web.perform = { act in
            acts.append(act)
            guard case .endInstall(let sentence) = act else { return [:] }
            if sentence == "refuse" { throw HostRefusal(.notSent) }
            said.append(sentence)
            return sentence.hasPrefix("presence") ? ["notice": "noted"] : [:]
        }
        func heard(_ sentence: String) -> Int { said.filter { $0 == sentence }.count }

        web.push(Self.state())
        web.start()
        try await until("heard(\"presence mac 6 nothing\") == 1") { heard("presence mac 6 nothing") == 1 }
        try await until("heard(\"resolved noted\") == 1") { heard("resolved noted") == 1 }
        try await until("heard(the label's unreadable) == 1") { heard("rejected Lifestream could not read this request for “Allow”, so nothing was done.") == 1 }
        try await until("heard(the label's update) == 1") { heard("rejected “Export all” needs a newer Lifestream. Update Lifestream on this Mac to do this.") == 1 }
        try await until("heard(\"answered Not sent not-sent\") == 1") { heard("answered Not sent not-sent") == 1 }
        try await until("heard(\"agent answered BAD_REQUEST\") == 1") { heard("agent answered BAD_REQUEST") == 1 }
        try await until("heard(\"agent answered BODY_TOO_LARGE\") == 1") { heard("agent answered BODY_TOO_LARGE") == 1 }
        try await until("heard(\"dragged\") == 1") { heard("dragged") == 1 }
        try await until("heard(\"frame rejected refused, no host\") == 1") { heard("frame rejected refused, no host") == 1 }
        try await until("heard(\"state nothing\") == 1") { heard("state nothing") == 1 }
        XCTAssertFalse(said.contains("from-frame"), "a frame's message reached the host")

        web.push(Self.state(reach: Self.unreachable))
        try await until("heard(\"state Can't reach Lifestream\") == 1") { heard("state Can't reach Lifestream") == 1 }
        web.reload()
        try await until("heard(\"presence mac 6 Can't reach Lifestream\") == 1") { heard("presence mac 6 Can't reach Lifestream") == 1 }
        try await until("heard(\"state Can't reach Lifestream\") == 2") { heard("state Can't reach Lifestream") == 2 }
        try await until("heard(\"resolved noted\") == 2") { heard("resolved noted") == 2 }
        XCTAssertEqual(heard("presence mac 6 nothing"), 1, "a reload loaded an earlier state")
        XCTAssertEqual(said.filter { $0.hasPrefix("presence") }.count, 2, "an act was answered more than once")
    }

    @MainActor func testThePagesSettersReachTheHostAndAReloadResetsThem() async throws {
        let hosted = try await Hosted(["/": ("text/html", Data(Self.setters.utf8))])
        defer { hosted.stop() }
        let (web, host) = (hosted.web, hosted.host)
        let asks = hosted.asks
        func settle() async throws {
            _ = try await host.perform(.at(step: "iphone"))
            let before = hosted.looks
            try await until("the loop looked five more times") { hosted.looks >= before + 5 }
        }
        func quiet(_ why: String) async throws {
            try await settle()
            let asked = asks().count
            try await settle()
            XCTAssertEqual(asks().count, asked, why)
        }
        func page(_ script: String) async throws {
            _ = try await XCTUnwrap(web.page).evaluateJavaScript("\(script); true")
        }

        web.start()
        try await until("the code and the requests in the state") { host.state.pairing != nil && host.state.connectRequests != nil }
        try await until("both asked for again") { asks().filter { $0 == "pair show" }.count >= 3 && asks().filter { $0 == "connect" }.count >= 3 }
        try await until("the page heard both acts answered") { web.title == "Lifestream · answered 2" }

        try await page("act({act: 'pairing', do: 'close'}); act({act: 'pairing', do: 'open'})")
        let shown = asks().filter { $0 == "pair show" }.count
        try await until("the code asked for after the close and the open") { asks().filter { $0 == "pair show" }.count >= shown + 3 }
        XCTAssertNotNil(host.state.pairing, "a close then an open in one tick landed reversed")

        try await page("act({act: 'pairing', do: 'close'}); act({act: 'connect-wait', do: 'close'})")
        try await until("both gone from the state") { host.state.pairing == nil && host.state.connectRequests == nil }
        try await quiet("asked after the page's close")

        try await page("act({act: 'pairing', do: 'open'}); act({act: 'connect-wait', do: 'open'})")
        try await until("both in the state again") { host.state.pairing != nil && host.state.connectRequests != nil }
        web.reload()
        try await until("both gone as the new document committed") { host.state.pairing == nil && host.state.connectRequests == nil }
        try await until("the reloaded page loaded") { web.title == "Lifestream · quiet" }
        try await quiet("asked for what the page before the reload wanted")
        try await page("act({act: 'pairing', do: 'open'})")
        try await until("the code asked for again") { host.state.pairing != nil }
        XCTAssertNil(host.state.connectRequests, "the reload kept the browser wait")
        XCTAssertFalse(asks().contains { $0 != "pair show" && $0 != "connect" }, "an act reached the home as a verb of its own: \(asks())")
    }

    @MainActor func testAPageRestoredFromTheBackForwardCacheSaysAgainWhatItWants() async throws {
        let hosted = try await Hosted(["/": ("text/html", Data(Self.restorable.utf8)),
                                       "/other": ("text/html", Data(Self.other.utf8))])
        defer { hosted.stop() }
        let (web, host) = (hosted.web, hosted.host)

        web.start()
        try await until("the pairing flow open on the first load") { web.title == "Lifestream · shown 1 loaded" && host.state.pairing != nil }
        _ = try await XCTUnwrap(web.page).evaluateJavaScript("location.href = '/other'; true")
        try await until("another document committed, the intent reset") { web.title == "Lifestream · elsewhere" && host.state.pairing == nil }
        let asked = hosted.asks().count
        web.goBack()
        try await until("the page back, restored or loaded afresh") {
            web.title == "Lifestream · shown 1 restored" || web.title == "Lifestream · shown 2 loaded"
        }
        guard web.title == "Lifestream · shown 1 restored" else {
            throw XCTSkip("WebKit loaded the page afresh on Back instead of restoring it from its back-forward cache: "
                          + "a restored page's setter is not proven by this run")
        }
        try await until("the restored page's setter reached the host and the code was asked for") {
            host.state.pairing != nil && hosted.asks().count > asked
        }
    }

    private static let restorable = """
    <!doctype html><html><head><title>Lifestream</title><script>
    const loads = Number(sessionStorage.getItem("loads") || 0) + 1;
    sessionStorage.setItem("loads", String(loads));
    addEventListener("pageshow", (event) => {
      webkit.messageHandlers.lifestream.postMessage({type: "act", act: "pairing", do: "open"});
      document.title = "Lifestream · shown " + loads + " " + (event.persisted ? "restored" : "loaded");
    });
    </script></head><body>The iPhone step</body></html>
    """

    private static let other = """
    <!doctype html><html><head><title>Lifestream · elsewhere</title></head><body>Days</body></html>
    """

    private static let setters = """
    <!doctype html><html><head><title>Lifestream</title><script>
    let answered = 0;
    const act = (body) => webkit.messageHandlers.lifestream.postMessage(Object.assign({type: "act"}, body))
      .then(() => { answered += 1; document.title = "Lifestream · answered " + answered; });
    if (sessionStorage.getItem("opened")) {
      document.title = "Lifestream · quiet";
    } else {
      sessionStorage.setItem("opened", "1");
      act({act: "pairing", do: "open"});
      act({act: "connect-wait", do: "open"});
    }
    </script></head><body>A synthetic page</body></html>
    """

    private static let page = """
    <!doctype html><html><head><title>Lifestream</title><script>
    const act = (body) => webkit.messageHandlers.lifestream.postMessage(Object.assign({type: "act"}, body));
    const say = (sentence) => act({act: "end-install", pass: sentence});
    const host = window.lifestreamHost;
    const reach = (state) => state.reach && state.reach.title ? state.reach.title : "nothing";
    say("presence " + host.kind + " " + host.version + " " + reach(host.state)).then((answer) => say("resolved " + answer.notice));
    addEventListener("lifestream:state", () => say("state " + reach(window.lifestreamHost.state)));
    act({act: "allow", grants: ["notifications"], label: "Allow"}).then(() => say("taken"), (error) => say("rejected " + error.message));
    act({act: "export-everything", label: "Export all"}).then(() => say("taken"), (error) => say("rejected " + error.message));
    act({act: "end-install", pass: "refuse"}).then((answer) => say("answered " + answer.refused + " " + answer.said), () => say("rejected the refusal"));
    act({act: "window", do: "drag"}).then(() => say("dragged"));
    const agent = (body) => act(body).then((answer) => say("agent answered " + (answer && answer.refused && answer.refused.code)), () => say("agent rejected"));
    agent({act: "agent-answer", id: "q-1", answer: "no", access: {allow: []}});
    agent({act: "agent-access", id: "p-1", access: {n: "w".repeat(\(HostAct.bodyLimit))}, expect: 1});
    addEventListener("message", (event) => say("frame " + event.data));
    </script></head><body>A synthetic page<iframe src="/frame"></iframe></body></html>
    """

    private static let frame = """
    <!doctype html><html><body><script>
    const seen = window.lifestreamHost ? "a host" : "no host";
    webkit.messageHandlers.lifestream.postMessage({type: "act", act: "end-install", pass: "from-frame"})
      .then(() => parent.postMessage("resolved, " + seen, "*"), (error) => parent.postMessage("rejected " + error.message + ", " + seen, "*"));
    </script></body></html>
    """
}

@MainActor private final class Hosted {
    let host: MacHost
    let web: WebContent
    private(set) var looks = 0
    private let server: PageServer
    private let home: ScriptedHome
    private let suite = "HostContractTests-\(UUID().uuidString)"
    private let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("host-contract-\(UUID().uuidString)")

    init(_ files: [String: (type: String, body: Data)]) async throws {
        server = try PageServer(files)
        let port = try await server.ready()
        home = try ScriptedHome(HostV6Tests.Home().answer)
        let socket = HomeSocket(path: home.path, folder: home.folder)
        let keeper = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { socket })
        host = MacHost(needs: NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper)),
                       lines: StatusLines(recorder: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true)),
                       socket: { socket },
                       readGrants: { [:] }, readFolder: { nil }, unit: { "macbook-pro-0001" }, ask: .untouched, poll: .milliseconds(20))
        web = WebContent(address: DashboardAddress(port: port), defaults: UserDefaults(suiteName: suite) ?? .standard, dashboardHeld: { false })
        host.seen = { [weak self] in
            self?.looks += 1
            return true
        }
        let (web, host) = (web, host)
        web.perform = { act in try await host.reply(act) }
        web.want = { act in host.want(act) }
        web.intentReset = { host.resetIntent() }
        host.published = { state in web.push(state) }
        web.push(host.state)
        host.start(polling: { false })
    }

    func asks() -> [String] {
        home.requests.map { ([$0["verb"] as? String ?? "?"] + ($0["args"] as? [String] ?? [])).joined(separator: " ") }
            .filter { $0.hasPrefix("pair") || $0.hasPrefix("connect") }
    }

    func stop() {
        host.stop()
        web.close()
        home.stop()
        server.stop()
        UserDefaults().removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: scratch)
    }
}

final class PageServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "PageServer")
    private var waiting: CheckedContinuation<Int, Error>?

    init(_ files: [String: (type: String, body: Data)], port: NWEndpoint.Port = .any) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: port)
        listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [queue] connection in
            connection.start(queue: queue)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { request, _, _, _ in
                let path = request.flatMap { String(data: $0, encoding: .utf8) }?.split(separator: " ").dropFirst().first.map(String.init) ?? ""
                let file = files[path] ?? files[String(path.prefix { $0 != "?" })]
                let body = file?.body ?? Data()
                let head = file.map { "HTTP/1.1 200 OK\r\nContent-Type: \($0.type); charset=utf-8" } ?? "HTTP/1.1 404 Not Found"
                let response = Data("\(head)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8) + body
                connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
            }
        }
    }

    func ready() async throws -> Int {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Int, Error>) in
            queue.async { [self] in
                waiting = continuation
                listener.stateUpdateHandler = { [self] state in
                    switch state {
                    case .ready: waiting?.resume(returning: Int(listener.port?.rawValue ?? 0))
                    case .failed(let error): waiting?.resume(throwing: error)
                    default: return
                    }
                    waiting = nil
                }
                listener.start(queue: queue)
            }
        }
    }

    func stop() { listener.cancel() }
}
