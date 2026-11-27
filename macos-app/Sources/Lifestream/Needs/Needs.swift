import Foundation
import HomeLink
import Passwords
import UserNotifications

enum Need: Equatable, Identifiable {
    case updateFailed(UpdateFailure)
    case updateReady(String)
    case filesRefused
    case pairAgain
    case allow
    case unlock
    case homeLocked(allow: Bool)
    case saveRecoveryKey(keyed: Bool)
    case password(HomeLink.Need, set: HomeLink.Act)
    case connect(HomeLink.Need, browser: HomeLink.Act)
    case notice(HomeLink.Need)

    var id: String {
        switch self {
        case .password(let need, _), .notice(let need): return "\(need.id)@\(need.sinceMs.map(String.init) ?? "")"
        default: return key
        }
    }

    var key: String {
        switch self {
        case .updateFailed: return "update"
        case .updateReady: return "update:ready"
        case .filesRefused: return "mac-files:refused"
        case .pairAgain: return "mac-files:pair"
        case .allow, .unlock, .homeLocked: return "vault:locked"
        case .saveRecoveryKey: return "vault:unsaved"
        case .password(let need, _), .connect(let need, _), .notice(let need): return need.id
        }
    }

    var home: Bool {
        switch self {
        case .password, .connect, .notice: return true
        default: return false
        }
    }

    var steers: Bool {
        switch self {
        case .password(let need, _), .connect(let need, _), .notice(let need): return need.weight != .advice
        default: return true
        }
    }

    var page: String? {
        switch self {
        case .connect: return "dialog=settings/chrome&flow=browser"
        default: return nil
        }
    }

    enum Button: String, Equatable {
        case `do`, tryAgain = "try-again"
    }

    var acts: [(button: Button, label: String)] {
        switch self {
        case .updateFailed(.refused): return []
        case .updateFailed(.blocked): return [(.tryAgain, "Try again")]
        case .updateReady: return [(.do, "Restart to Update")]
        case .filesRefused, .allow: return [(.do, "Allow")]
        case .pairAgain: return []
        case .unlock: return [(.do, "Unlock")]
        case .homeLocked: return [(.do, "Unlock")]
        case .saveRecoveryKey: return [(.do, "Save key")]
        case .password(_, let set): return [(.do, set.label)]
        case .connect(_, let browser): return [(.do, browser.label)]
        case .notice(let need): return need.acts.first { $0.do == .storage }.map { [(.do, $0.label)] } ?? []
        }
    }

    var locks: Bool {
        switch self {
        case .allow, .unlock, .homeLocked: return true
        default: return false
        }
    }

    func said(saved: Bool) -> String? {
        var lines: [String] = []
        switch self {
        case .updateFailed, .connect:
            if let detail { lines.append(detail) }
        default: break
        }
        if saved { lines.append(PasswordSheet.saved) }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    var line: String {
        switch self {
        case .updateFailed: return "Lifestream didn't update"
        case .updateReady(let generation): return "Lifestream \(generation) is ready"
        case .filesRefused: return "Lifestream can't open what this Mac records"
        case .pairAgain: return "Pair this Mac again"
        case .allow, .unlock: return "Passwords are locked on this Mac"
        case .homeLocked: return "Lifestream is locked"
        case .saveRecoveryKey: return "Recovery key not saved"
        case .password(let need, _), .connect(let need, _), .notice(let need): return need.words
        }
    }

    var detail: String? {
        switch self {
        case .updateFailed(.refused): return Self.runsMeanwhile
        case .updateFailed(.blocked(let words)): return "\(Self.runsMeanwhile) · \(words)"
        case .filesRefused: return "Click Allow."
        case .pairAgain: return "Make a pairing code in Lifestream, then type in Terminal: lifestream home --name <Lifestream's address> --code <the code>"
        case .allow: return "When macOS asks, choose Always Allow"
        case .unlock: return "Unlock them with your recovery key"
        case .homeLocked: return "Unlock it."
        case .saveRecoveryKey(let keyed): return "Without it, a lost Mac loses \(keyed ? "everything in Lifestream" : "your passwords")"
        case .password(let need, _), .connect(let need, _): return need.about
        case .updateReady, .notice: return nil
        }
    }
}

extension Need {
    static let macFilesKeys: Set<String> = [Need.filesRefused.key, Need.pairAgain.key]
    static let runsMeanwhile = "It runs the release it has meanwhile"
}

enum UpdateFailure: Equatable {
    case refused(String)
    case blocked(String)

    var words: String {
        switch self {
        case .refused(let words), .blocked(let words): return words
        }
    }
}

enum MacFilesNeed: Equatable {
    case refused
    case pairAgain

    static func of(_ opened: MacProcess.Opened, keyed: Bool, homeHere: Bool, paired: Bool) -> MacFilesNeed? {
        if case .refused = opened { return .refused }
        return keyed && !homeHere && !paired ? .pairAgain : nil
    }

    var need: Need {
        switch self {
        case .refused: return .filesRefused
        case .pairAgain: return .pairAgain
        }
    }
}

enum Needs {
    private static func of(_ need: HomeLink.Need) -> Need {
        switch need.kind {
        case "password": need.acts.first { $0.do == .set }.map { .password(need, set: $0) } ?? .notice(need)
        case "connect": need.acts.first { $0.do == .browser }.map { .connect(need, browser: $0) } ?? .notice(need)
        default: .notice(need)
        }
    }

    static func list(vault: VaultState?, keyMayOpen: Bool, update: UpdateFailure?, ready: String?, needs home: [HomeLink.Need],
                     files: MacFilesNeed? = nil) -> [Need] {
        var needs: [Need] = []
        if let files { needs.append(files.need) }
        if let update { needs.append(.updateFailed(update)) }
        if let ready { needs.append(.updateReady(ready)) }
        if let vault, vault.keyed, vault.locked {
            needs.append(.homeLocked(allow: keyMayOpen))
        } else if let vault, vault.keyID != nil {
            if vault.locked {
                needs.append(keyMayOpen ? .allow : .unlock)
            } else if vault.recovery != .confirmed {
                needs.append(.saveRecoveryKey(keyed: vault.keyed))
            }
        }
        for need in home where !need.acts.contains(where: { $0.do == .vault }) {
            needs.append(of(need))
        }
        return needs
    }
}

struct NeedWatch {
    private var last: Set<String>?

    mutating func began(_ ids: [String]) -> Bool {
        defer { last = Set(ids) }
        guard let last else { return false }
        return ids.contains { !last.contains($0) }
    }
}

enum NeedNotification {
    static let connect = "connect"
    static let install = "install"
    static let unlock = "unlock"
    static let pageKey = "page"
    static let startedAgainID = "mac-files:started-again"
    static let startedAgainWords = "Lifestream couldn't open what this Mac recorded and hadn't sent yet, so it started again. Lifestream keeps everything it already received."

    static func startedAgain(ask: () async -> Bool = NotificationGrant.ask,
                             post: (UNNotificationRequest) -> Void = { UNUserNotificationCenter.current().add($0) }) async {
        guard await ask() else { return }
        let content = UNMutableNotificationContent()
        content.body = startedAgainWords
        post(UNNotificationRequest(identifier: startedAgainID, content: content, trigger: nil))
    }

    static var categories: Set<UNNotificationCategory> {
        [UNNotificationCategory(identifier: connect, actions: [UNNotificationAction(identifier: connect, title: "Connect", options: [.foreground])],
                                intentIdentifiers: []),
         UNNotificationCategory(identifier: install, actions: [UNNotificationAction(identifier: install, title: "Restart to update", options: [])],
                                intentIdentifiers: []),
         UNNotificationCategory(identifier: unlock, actions: [UNNotificationAction(identifier: unlock, title: "Unlock…", options: [.foreground])],
                                intentIdentifiers: [])]
    }

    private static func category(_ need: Need) -> String? {
        switch need {
        case .connect: return connect
        case .updateReady: return install
        case .homeLocked: return unlock
        default: return nil
        }
    }

    static func calls(_ need: Need) -> Bool {
        category(need) != nil
    }

    static func notify(_ need: Need, ask: () async -> Bool = NotificationGrant.ask, allowed: () async -> Bool = NotificationGrant.allowed,
                       post: (UNNotificationRequest) -> Void = { UNUserNotificationCenter.current().add($0) }) async {
        guard let category = category(need), await (category == install ? allowed() : ask()) else { return }
        let content = UNMutableNotificationContent()
        content.title = need.line
        content.body = need.detail ?? ""
        content.categoryIdentifier = category
        if let page = need.page { content.userInfo = [pageKey: page] }
        post(UNNotificationRequest(identifier: need.key, content: content, trigger: nil))
    }

    enum Answer: Equatable {
        case show(String?)
        case install
    }

    static func answer(_ content: UNNotificationContent, action: String) -> Answer? {
        guard [connect, install, unlock].contains(content.categoryIdentifier) else { return nil }
        switch action {
        case install: return .install
        case connect, unlock, UNNotificationDefaultActionIdentifier: return .show(content.userInfo[pageKey] as? String)
        default: return nil
        }
    }
}
