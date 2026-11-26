import Foundation
import HomeLink
import Passwords

enum HostBridge {
    static let version = 6
    static let handler = "lifestream"
    static let stateEvent = "lifestream:state"
    static let droppedEvent = "lifestream:dropped"
    static let refused = "refused"

    static func presenceScript(_ state: HostState) throws -> String {
        "window.lifestreamHost = {kind: \"mac\", version: \(version), state: \(try scriptLiteral(state))};"
    }

    static func stateScript(_ state: HostState) throws -> String {
        "if (window.lifestreamHost) { window.lifestreamHost.state = \(try scriptLiteral(state)); "
            + "window.dispatchEvent(new Event(\"\(stateEvent)\")); }"
    }

    static func droppedScript(kind: String) throws -> String {
        "window.dispatchEvent(new CustomEvent(\"\(droppedEvent)\", {detail: {kind: \(try scriptLiteral(kind))}}));"
    }

    static func hashScript(_ fragment: String) throws -> String {
        "location.hash=\(try scriptLiteral(fragment));"
    }

    static func scriptLiteral<Value: Encodable>(_ value: Value) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let text = String(decoding: try encoder.encode(value), as: UTF8.self)
        return text.replacingOccurrences(of: "<", with: "\\u003c")
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }

    struct Sender: Equatable {
        let scheme: String
        let host: String
        let port: Int
        let mainFrame: Bool
    }

    static func hears(_ sender: Sender, address: DashboardAddress) -> Bool {
        sender.mainFrame && address.isDashboard(scheme: sender.scheme, host: sender.host, port: sender.port)
    }
}

struct HostRefusal: Error, Equatable {
    enum Said: String, Equatable {
        case notSent = "not-sent"
        case refused
        case saving
        case unknown
    }

    let words: String
    let said: Said
    let field: String?
    let code: String?

    init(_ words: String, said: Said = .refused, field: String? = nil, code: String? = nil) {
        self.words = words
        self.said = said
        self.field = field
        self.code = code
    }

    init(_ act: HomeLink.ActSaid, code: String? = nil) {
        switch act {
        case .notSent: self.init(ReachWords.notSent, said: .notSent, code: code)
        case .refused(let words): self.init(words, code: code)
        case .saving: self.init(ReachWords.saving, said: .saving, code: code)
        case .unknown(let words): self.init(words, said: .unknown, code: code)
        }
    }

    var answer: [String: Any] { ["refused": words, "said": said.rawValue] }

    var coded: [String: Any] { ["refused": ["code": code.map { $0 as Any } ?? NSNull(), "message": words]] }

    static func update(_ label: String?) -> HostRefusal {
        HostRefusal((label.map { "“\($0)” needs a newer Lifestream. " } ?? "") + "Update Lifestream on this Mac to do this.")
    }

    static func unreadable(_ label: String?) -> HostRefusal {
        HostRefusal("Lifestream could not read this request" + (label.map { " for “\($0)”" } ?? "") + ", so nothing was done.")
    }

    static func badRequest(_ label: String?) -> HostRefusal {
        HostRefusal(unreadable(label).words, code: "BAD_REQUEST")
    }

    static func tooLarge(_ bytes: Int) -> HostRefusal {
        HostRefusal("the body states \(bytes) bytes; the door reads at most \(HostAct.bodyLimit)", code: "BODY_TOO_LARGE")
    }

    static let notHere = HostRefusal("Lifestream on this Mac doesn't offer that, so nothing was done.")
    static let noHome = HostRefusal("Lifestream isn’t set up on this Mac yet.")

    init(_ failure: LinkFailure, now: Date = Date()) {
        let code = if case .noAnswer = failure { "OUTCOME_UNKNOWN" } else { failure.code }
        guard let state = HomeLink.state(of: failure, now: now), let said = ReachWords.act(state) else {
            self.init("\(failure)", code: code)
            return
        }
        self.init(said, code: code)
    }
}

enum HostAct: Equatable {
    case allow([Grant])
    case allowStore(connector: String)
    case moveApp
    case chooseFolder(FolderChoice)
    case setUp
    case setupKey(SetupKey.Act)
    case vault(VaultAct)

    enum VaultAct: String, Equatable { case open, unlock }

    enum FolderChoice: Equatable {
        case panel(drives: Bool)
        case standard
    }
    case turn(sources: [String], on: Bool)
    case pause(connector: String, history: Bool)
    case resume(connector: String, history: Bool)
    case pauseHome
    case resumePause(target: String)
    case homeSetting(HomeSetting)
    case deviceName(unit: String, name: String)
    case setting(connector: String, member: String, value: HomeLink.JSON, was: HomeLink.JSON? = nil)
    case seal(connector: String, member: String, value: String)
    case refresh(connector: String)
    case openRouterKey(String?)
    case models(ModelsAct)
    case process(family: String, item: String, prompt: String, route: String)
    case general(GeneralAct)
    case `import`(ImportAct)

    enum ImportAct: Equatable {
        case choose(kind: String)
        case dropped(kind: String)
        case again(kind: String, file: String)
        case forget(kind: String, file: String)
        case backupRead(id: String)
        case backupSettings
    }
    case upload(connector: String)
    case chooseFile(connector: String, member: String)
    case chooseApp
    case faces(FacesAct)
    case verifyHome
    case probeHome
    case openHome
    case pairHome
    case endInstall(pass: String)
    case retirePhone(unit: String)
    case need(key: String, button: Need.Button)
    case sheet(Sheet)
    case open(Opening)
    case skip(step: String)
    case at(step: String)
    case pairing(open: Bool)
    case askLogin(AskLoginAct)
    case connectWait(open: Bool)
    case connectAnswer(id: String, allow: Bool)
    case agentAnswer(HomeLink.AnswerRequest)
    case agentDisconnect(id: String)
    case agentUnlist(id: String)
    case agentAccess(id: String, access: HomeLink.Access, expect: HomeLink.Version)
    case agentGuides
    case agentAddress(turnOn: Bool, reader: String?)
    case agentKey(app: HomeLink.KeyApp, name: String?, access: HomeLink.DraftAccess)
    case agentSignIn(id: String)
    case screenshotTake
    enum ModelUse: String, CaseIterable, Equatable, Sendable {
        case pictures, audio, text, chat, search, hiding
    }

    enum ModelInput: String, CaseIterable, Equatable, Sendable {
        case text, image
    }

    enum ModelsAct: Equatable, Sendable {
        static let off = "none"

        case `default`(use: ModelUse, model: String, thinking: String? = nil)
        case file(runner: String, id: String, fetch: Bool)
        case runner(String, pause: Bool)
        case battery(String, save: Bool)
        case address(url: String, input: [ModelInput]?)
        case addressNone

        var args: [String] {
            switch self {
            case .default(let use, let model, let thinking): ["default", use.rawValue, model] + (thinking.map { ["--thinking", $0] } ?? [])
            case .file(let runner, let id, let fetch): ["file", runner, id, fetch ? "fetch" : "remove"]
            case .runner(let runner, let pause): ["runner", runner, pause ? "pause" : "resume"]
            case .battery(let runner, let save): ["battery", runner, save ? "save" : "spend"]
            case .address(let url, let input): ["address", url] + (input.map { [$0.map(\.rawValue).joined(separator: ",")] } ?? [])
            case .addressNone: ["address", "none"]
            }
        }
    }

    enum GeneralAct: Equatable, Sendable {
        case login(on: Bool)
        case autoUpdate(on: Bool)
        case check
        case command(General.CommandAct)
        case uninstall
        case appearance(AppAppearance)
    }

    enum HomeSetting: Equatable, Sendable {
        case modelCap(Int)
        case historyStart(String)
        case privacy([Privacy])
        case meaningPower(String?)

        static let meaningPower = "search.meaning.power"

        enum Privacy: Equatable, Sendable {
            case word(PrivacyWord, String?)
            case words(PrivacyWords, [String]?)

            var key: String {
                switch self {
                case .word(let key, _): key.rawValue
                case .words(let key, _): key.rawValue
                }
            }

            var value: HomeLink.JSON {
                switch self {
                case .word(_, let word?): .string(word)
                case .words(_, let words?): .array(words.map(HomeLink.JSON.string))
                case .word(_, nil), .words(_, nil): .null
                }
            }
        }

        enum PrivacyWord: String, CaseIterable, Sendable {
            case level = "privacy.level", chat = "privacy.chat", links = "privacy.links"
        }

        enum PrivacyWords: String, CaseIterable, Sendable {
            case always = "privacy.always", never = "privacy.never"
        }

        var args: [String] {
            switch self {
            case .modelCap(let cap): ["set", "model.cap", String(cap)]
            case .historyStart(let start): ["set", HostAct.json(["history.start": start])]
            case .privacy(let settings): ["set", HostAct.json(Dictionary(uniqueKeysWithValues: settings.map { ($0.key, $0.value) }))]
            case .meaningPower(let power): ["set", HostAct.json([HomeSetting.meaningPower: power.map(HomeLink.JSON.string) ?? .null])]
            }
        }
    }

    fileprivate static func json<Value: Encodable>(_ value: Value) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return String(decoding: (try? encoder.encode(value)) ?? Data(), as: UTF8.self)
    }

    enum FacesAct: String, Equatable, Sendable {
        case on, off
    }

    struct Sheet: Equatable {
        let connector: String
        let route: String
    }

    enum SignInWay: String, Equatable, CaseIterable {
        case key, device, client
    }

    enum Opening: Equatable {
        case homeLog, storage, homeFolder, loginItems
        case app(App)
        case browserStore(String)
        case site(URL, browser: String?)
    }

    enum App: String, Equatable {
        case tailscale = "Tailscale"
        case messages = "Messages"
    }

    enum Subscription: String, CaseIterable, Equatable, Sendable {
        case chatgpt, claude
    }

    enum AskLoginAct: Equatable, Sendable {
        case start(Subscription)
        case cancel(Subscription)
        case signOut(Subscription)
        case code(attempt: String, code: String)

        var subscription: Subscription {
            switch self {
            case .start(let of), .cancel(let of), .signOut(let of): of
            case .code: .claude
            }
        }

        func body() throws -> Data {
            let fields: [String: Any]
            switch self {
            case .start(let of): fields = ["do": "start", "of": of.rawValue]
            case .cancel(let of): fields = ["do": "cancel", "of": of.rawValue]
            case .signOut(let of): fields = ["do": "sign_out", "of": of.rawValue]
            case .code(let attempt, let code):
                fields = ["do": "code", "of": Subscription.claude.rawValue, "attempt": attempt, "code": code]
            }
            return try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
        }
    }

    static let idLimit = 200
    static let valueLimit = 16_384
    static let bodyLimit = 2 * 1024 * 1024
    static let urlLimit = 2048

    static func read(_ body: Any) -> Result<HostAct, HostRefusal> {
        guard var body = body as? [String: Any], body["type"] as? String == "act" else { return .failure(.unreadable(nil)) }
        let label = id(body.removeValue(forKey: "label")).flatMap { $0.allSatisfy(\.isWhitespace) ? nil : $0 }
        guard let act = body["act"] as? String else { return .failure(.unreadable(label)) }
        if agentActs.contains(act) { return agent(act, body, label: label) }
        var known = true
        guard let read = parse(act, body, known: &known) else { return .failure(known ? .unreadable(label) : .update(label)) }
        return .success(read)
    }

    private static let agentActs: Set<String> = ["agent-answer", "agent-access", "agent-guides", "agent-address", "agent-key", "agent-signin"]

    private static func agent(_ act: String, _ body: [String: Any], label: String?) -> Result<HostAct, HostRefusal> {
        let keys = Set(body.keys).subtracting(["type", "act"])
        switch act {
        case "agent-guides":
            return keys.isEmpty ? .success(.agentGuides) : .failure(.badRequest(label))
        case "agent-address":
            guard keys.isSubset(of: ["on", "reader"]) else { return .failure(.badRequest(label)) }
            if keys.isEmpty { return .success(.agentAddress(turnOn: false, reader: nil)) }
            guard boolean(body["on"]) == true else { return .failure(.badRequest(label)) }
            let reader = body["reader"].map(id)
            guard reader != .some(nil) else { return .failure(.badRequest(label)) }
            return .success(.agentAddress(turnOn: true, reader: reader ?? nil))
        case "agent-key":
            guard keys.isSubset(of: ["app", "name", "access"]), let app = (body["app"] as? String).flatMap(HomeLink.KeyApp.init(rawValue:)),
                  let access = door(HomeLink.DraftAccess.self, body["access"] as Any), let bytes = wire(access)?.count else {
                return .failure(.badRequest(label))
            }
            let name = body["name"].map(id)
            guard name != .some(nil) else { return .failure(.badRequest(label)) }
            return bytes <= bodyLimit ? .success(.agentKey(app: app, name: name ?? nil, access: access)) : .failure(.tooLarge(bytes))
        case "agent-signin":
            guard keys == ["id"], let signIn = id(body["id"]) else { return .failure(.badRequest(label)) }
            return .success(.agentSignIn(id: signIn))
        default:
            break
        }
        if act == "agent-answer" {
            guard Set(body.keys).isSubset(of: ["type", "act", "id", "answer", "expect", "access"]), id(body["id"]) != nil,
                  let sent = door(HomeLink.AnswerRequest.self, body.filter { $0.key != "type" && $0.key != "act" }),
                  let bytes = wire(sent)?.count else { return .failure(.badRequest(label)) }
            return bytes <= bodyLimit ? .success(.agentAnswer(sent)) : .failure(.tooLarge(bytes))
        }
        guard Set(body.keys) == ["type", "act", "id", "access", "expect"], let reader = id(body["id"]),
              let access = door(HomeLink.Access.self, body["access"] as Any), let expect = whole(body["expect"]), expect >= 0,
              let held = wire(access)?.count else { return .failure(.badRequest(label)) }
        let bytes = held + #"{"access":,"expect":}"#.utf8.count + String(expect).utf8.count
        return bytes <= bodyLimit ? .success(.agentAccess(id: reader, access: access, expect: expect)) : .failure(.tooLarge(bytes))
    }

    private static func parse(_ act: String, _ body: [String: Any], known: inout Bool) -> HostAct? {
        switch act {
        case "allow" where (body["grants"] as? [Any])?.contains(where: { ($0 as? String)?.hasPrefix(StoreConsentSheets.grantPrefix) == true }) == true:
            guard let names = strings(body["grants"], most: 1), Set(body.keys) == ["type", "act", "grants"],
                  let connector = id(String(names[0].dropFirst(StoreConsentSheets.grantPrefix.count))) else { return nil }
            return .allowStore(connector: connector)
        case "allow":
            guard let names = strings(body["grants"], most: Grant.listed.count) else { return nil }
            let grants = names.compactMap(Grant.init(rawValue:)).filter(Grant.listed.contains)
            guard grants.count == names.count else { return nil }
            return .allow(grants.reduce(into: []) { if !$0.contains($1) { $0.append($1) } })
        case "move-app":
            return Set(body.keys) == ["type", "act"] ? .moveApp : nil
        case "choose-folder":
            let drives: Bool
            switch body["start"] {
            case nil: drives = false
            case let start as String where start == "volumes": drives = true
            default: return nil
            }
            var standard = false
            if let value = body["default"] {
                guard let flag = boolean(value) else { return nil }
                standard = flag
            }
            guard standard else { return .chooseFolder(.panel(drives: drives)) }
            return body["start"] == nil ? .chooseFolder(.standard) : nil
        case "setup":
            return Set(body.keys) == ["type", "act"] ? .setUp : nil
        case "setup-key":
            guard Set(body.keys) == ["type", "act", "do"] else { return nil }
            return (body["do"] as? String).flatMap(SetupKey.Act.init(rawValue:)).map { .setupKey($0) }
        case "vault":
            return (body["do"] as? String).flatMap(VaultAct.init(rawValue:)).map { .vault($0) }
        case "turn":
            guard let sources = strings(body["sources"], most: 64), let on = boolean(body["on"]) else { return nil }
            return .turn(sources: sources, on: on)
        case "pause" where body["target"] != nil:
            return Set(body.keys) == ["type", "act", "target"] && body["target"] as? String == "home" ? .pauseHome : nil
        case "resume" where body["target"] != nil:
            guard Set(body.keys) == ["type", "act", "target"], let target = id(body["target"]) else { return nil }
            return .resumePause(target: target)
        case "pause", "resume":
            guard let connector = id(body["connector"]) else { return nil }
            let history: Bool
            switch body["scope"] {
            case nil: history = false
            case let scope as String where scope == "history": history = true
            default: return nil
            }
            return act == "pause" ? .pause(connector: connector, history: history) : .resume(connector: connector, history: history)
        case "setting":
            guard let connector = id(body["connector"]), let member = id(body["member"]), let value = settingValue(body["value"]) else { return nil }
            guard let was = body["was"] else { return .setting(connector: connector, member: member, value: value) }
            return json(was).map { .setting(connector: connector, member: member, value: value, was: $0) }
        case "seal" where body["secret"] != nil:
            guard body["secret"] as? String == "openrouter", Set(body.keys) == ["type", "act", "secret", "value"] else { return nil }
            switch body["value"] {
            case is NSNull: return .openRouterKey(nil)
            case let key as String where (1...valueLimit).contains(key.count) && !key.contains(where: \.isWhitespace): return .openRouterKey(key)
            default: return nil
            }
        case "seal":
            guard let connector = id(body["connector"]), let member = id(body["member"]), let value = body["value"] as? String,
                  (1...valueLimit).contains(value.count) else { return nil }
            return .seal(connector: connector, member: member, value: value)
        case "refresh":
            guard Set(body.keys) == ["type", "act", "connector"] else { return nil }
            return id(body["connector"]).map { .refresh(connector: $0) }
        case "import":
            switch body["do"] as? String {
            case "choose", "dropped":
                guard Set(body.keys) == ["type", "act", "do", "kind"], let kind = id(body["kind"]) else { return nil }
                return .import(body["do"] as? String == "choose" ? .choose(kind: kind) : .dropped(kind: kind))
            case "again", "forget":
                guard Set(body.keys) == ["type", "act", "do", "kind", "file"], let kind = id(body["kind"]), let file = id(body["file"]) else {
                    return nil
                }
                return .import(body["do"] as? String == "again" ? .again(kind: kind, file: file) : .forget(kind: kind, file: file))
            case "backup-read":
                guard Set(body.keys) == ["type", "act", "do", "id"] else { return nil }
                return id(body["id"]).map { .import(.backupRead(id: $0)) }
            case "backup-settings":
                guard Set(body.keys) == ["type", "act", "do"] else { return nil }
                return .import(.backupSettings)
            default:
                return nil
            }
        case "upload":
            guard Set(body.keys) == ["type", "act", "connector"] else { return nil }
            return id(body["connector"]).map { .upload(connector: $0) }
        case "choose-app":
            return Set(body.keys) == ["type", "act"] ? .chooseApp : nil
        case "choose-file":
            guard let connector = id(body["connector"]), let member = id(body["member"]) else { return nil }
            return .chooseFile(connector: connector, member: member)
        case "faces":
            return (body["do"] as? String).flatMap(FacesAct.init(rawValue:)).map { .faces($0) }
        case "home":
            switch body["do"] as? String {
            case "verify": return .verifyHome
            case "probe": return .probeHome
            case "open": return .openHome
            case "pair": return .pairHome
            default: return nil
            }
        case "end-install":
            return id(body["pass"]).map { .endInstall(pass: $0) }
        case "retire-phone":
            return id(body["unit"]).map { .retirePhone(unit: $0) }
        case "need":
            guard let key = id(body["need"]), let button = (body["button"] as? String).flatMap(Need.Button.init(rawValue:)) else { return nil }
            return .need(key: key, button: button)
        case "sheet":
            guard Set(body.keys) == ["type", "act", "connector", "route"], let connector = id(body["connector"]), let route = id(body["route"])
            else { return nil }
            return .sheet(Sheet(connector: connector, route: route))
        case "open":
            switch body["what"] as? String {
            case "home-log": return .open(.homeLog)
            case "storage": return .open(.storage)
            case "home-folder": return .open(.homeFolder)
            case "login-items": return .open(.loginItems)
            case "browser-store": return id(body["browser"]).map { .open(.browserStore($0)) }
            case "app": return (body["app"] as? String).flatMap(App.init(rawValue:)).map { .open(.app($0)) }
            case "site":
                guard let text = body["url"] as? String, text.count <= urlLimit, let url = URL(string: text),
                      url.scheme == "https", url.host?.isEmpty == false else { return nil }
                let browser = body["browser"].map(id)
                guard browser != .some(nil) else { return nil }
                return .open(.site(url, browser: browser ?? nil))
            default: return nil
            }
        case "skip":
            return id(body["step"]).map { .skip(step: $0) }
        case "at":
            return id(body["step"]).map { .at(step: $0) }
        case "pairing":
            return choice(body["do"], "open", "close").map { .pairing(open: $0) }
        case "ask-login":
            let of = (body["of"] as? String).flatMap(HostAct.Subscription.init(rawValue:))
            switch body["do"] as? String {
            case "start": return of.map { .askLogin(.start($0)) }
            case "cancel": return of.map { .askLogin(.cancel($0)) }
            case "sign_out": return of.map { .askLogin(.signOut($0)) }
            case "code":
                guard of == .claude, let attempt = id(body["attempt"]), let code = body["code"] as? String, !code.isEmpty else { return nil }
                return .askLogin(.code(attempt: attempt, code: code))
            default: return nil
            }
        case "models":
            return modelsAct(body).map { .models($0) }
        case "process":
            guard let family = id(body["family"]), let item = id(body["item"]), let prompt = id(body["prompt"]),
                  let route = id(body["route"]) else { return nil }
            return .process(family: family, item: item, prompt: prompt, route: route)
        case "general-login":
            return boolean(body["on"]).map { .general(.login(on: $0)) }
        case "general-auto-update":
            return boolean(body["on"]).map { .general(.autoUpdate(on: $0)) }
        case "general-check":
            return Set(body.keys) == ["type", "act"] ? .general(.check) : nil
        case "general-command":
            guard Set(body.keys) == ["type", "act", "do"] else { return nil }
            return (body["do"] as? String).flatMap(General.CommandAct.init(rawValue:)).map { .general(.command($0)) }
        case "uninstall":
            return Set(body.keys) == ["type", "act"] ? .general(.uninstall) : nil
        case "appearance":
            guard Set(body.keys) == ["type", "act", "theme"] else { return nil }
            return (body["theme"] as? String).flatMap(AppAppearance.init(rawValue:)).map { .general(.appearance($0)) }
        case "home-setting" where body["settings"] != nil:
            guard Set(body.keys) == ["type", "act", "settings"], let settings = body["settings"] as? [String: Any], json(settings) != nil else { return nil }
            if let power = settings[HomeSetting.meaningPower] {
                guard settings.count == 1 else { return nil }
                return nullable(power, id).map { .homeSetting(.meaningPower($0)) }
            }
            guard (1...HomeSetting.PrivacyWord.allCases.count + HomeSetting.PrivacyWords.allCases.count).contains(settings.count) else { return nil }
            let read = settings.sorted { $0.key < $1.key }.map { key, value in privacySetting(key, value) }
            guard read.allSatisfy({ $0 != nil }) else { return nil }
            return .homeSetting(.privacy(read.compactMap { $0 }))
        case "home-setting":
            guard Set(body.keys) == ["type", "act", "key", "value"] else { return nil }
            switch body["key"] as? String {
            case "model.cap":
                return whole(body["value"]).map { .homeSetting(.modelCap($0)) }
            case "history.start":
                return start(body["value"]).map { .homeSetting(.historyStart($0)) }
            default:
                return nil
            }
        case "device-name":
            guard Set(body.keys) == ["type", "act", "unit", "name"], let unit = id(body["unit"]), let name = id(body["name"]),
                  !name.allSatisfy(\.isWhitespace) else { return nil }
            return .deviceName(unit: unit, name: name)
        case "connect-wait":
            return choice(body["do"], "open", "close").map { .connectWait(open: $0) }
        case "connect-answer":
            guard let id = id(body["id"]), let allow = boolean(body["allow"]) else { return nil }
            return .connectAnswer(id: id, allow: allow)
        case "agent-disconnect":
            return id(body["id"]).map { .agentDisconnect(id: $0) }
        case "agent-unlist":
            return id(body["id"]).map { .agentUnlist(id: $0) }
        case "screenshot-take":
            return Set(body.keys) == ["type", "act"] ? .screenshotTake : nil
        default:
            known = false
            return nil
        }
    }

    private static func modelsAct(_ body: [String: Any]) -> ModelsAct? {
        switch body["do"] as? String {
        case "default":
            guard let use = (body["use"] as? String).flatMap(ModelUse.init(rawValue:)), let model = id(body["model"]) else { return nil }
            guard use != .chat || model != ModelsAct.off else { return nil }
            guard let level = body["thinking"] else {
                return Set(body.keys) == ["type", "act", "do", "use", "model"] ? .default(use: use, model: model) : nil
            }
            guard use == .chat, let thinking = id(level) else { return nil }
            return .default(use: use, model: model, thinking: thinking)
        case "file":
            guard let runner = id(body["runner"]), let file = id(body["id"]), let fetch = choice(body["to"], "fetch", "remove") else { return nil }
            return .file(runner: runner, id: file, fetch: fetch)
        case "runner":
            guard let runner = id(body["runner"]), let pause = choice(body["to"], "pause", "resume") else { return nil }
            return .runner(runner, pause: pause)
        case "battery":
            guard let runner = id(body["runner"]), let save = choice(body["to"], "save", "spend") else { return nil }
            return .battery(runner, save: save)
        case "address" where body["none"] != nil:
            return boolean(body["none"]) == true && Set(body.keys) == ["type", "act", "do", "none"] ? .addressNone : nil
        case "address":
            guard let url = body["url"] as? String, !url.isEmpty, url.count <= urlLimit, url != ModelsAct.off else { return nil }
            guard let said = body["input"] else { return Set(body.keys) == ["type", "act", "do", "url"] ? .address(url: url, input: nil) : nil }
            guard let names = strings(said, most: ModelInput.allCases.count) else { return nil }
            let input = names.compactMap(ModelInput.init(rawValue:))
            guard input.count == names.count, input.first == .text, Set(input).count == input.count else { return nil }
            return .address(url: url, input: input)
        default:
            return nil
        }
    }

    private static func choice(_ value: Any?, _ yes: String, _ no: String) -> Bool? {
        switch value as? String {
        case yes: return true
        case no: return false
        default: return nil
        }
    }

    private static func settingValue(_ value: Any?) -> HomeLink.JSON? {
        guard let value, let read = json(value), read != .null else { return nil }
        return read
    }

    private static func door<Shape: Decodable>(_ shape: Shape.Type, _ value: Any) -> Shape? {
        guard JSONSerialization.isValidJSONObject([value]),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) else { return nil }
        return try? JSONDecoder().decode(shape, from: data)
    }

    private static func wire<Body: Encodable>(_ body: Body) -> Data? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try? encoder.encode(body)
    }

    private static func json(_ value: Any) -> HomeLink.JSON? {
        guard JSONSerialization.isValidJSONObject([value]),
              let data = try? JSONSerialization.data(withJSONObject: [value], options: [.sortedKeys]),
              data.count <= valueLimit + 2 else { return nil }
        return (try? JSONDecoder().decode([HomeLink.JSON].self, from: data))?.first
    }

    private static func id(_ value: Any?) -> String? {
        guard let text = value as? String, (1...idLimit).contains(text.count) else { return nil }
        return text
    }

    private static func privacySetting(_ key: String, _ value: Any) -> HomeSetting.Privacy? {
        let reset = value is NSNull
        if let word = HomeSetting.PrivacyWord(rawValue: key) {
            return reset ? .word(word, nil) : id(value).map { .word(word, $0) }
        }
        if let list = HomeSetting.PrivacyWords(rawValue: key) {
            return reset ? .words(list, nil) : words(value).map { .words(list, $0) }
        }
        return nil
    }

    private static func words(_ value: Any?) -> [String]? {
        guard let texts = value as? [String], texts.allSatisfy({ !$0.isEmpty }), json(texts) != nil else { return nil }
        return texts
    }

    private static func nullable(_ value: Any?, _ read: (Any?) -> String?) -> String?? {
        if value is NSNull { return .some(nil) }
        return read(value).map { .some($0) }
    }

    private static func strings(_ value: Any?, most: Int) -> [String]? {
        guard let values = value as? [Any], (1...most).contains(values.count) else { return nil }
        let ids = values.compactMap(id)
        return ids.count == values.count ? ids : nil
    }

    private static func start(_ value: Any?) -> String? {
        guard let text = value as? String else { return nil }
        let day = text.count == 10 && text.enumerated().allSatisfy { index, character in
            [4, 7].contains(index) ? character == "-" : character.isASCII && character.isNumber
        }
        return text == "all" || day ? text : nil
    }

    private static func whole(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        return Int(exactly: number.doubleValue)
    }

    private static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }
}
