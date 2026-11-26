import Evidence
import Foundation
import HomeLink

public struct StoreFiles: Sendable {
    public let home: URL
    public let lifestream: [URL]

    public init(home: URL, lifestream: [URL]) {
        self.home = home
        self.lifestream = lifestream
    }

    public enum NeverRead {
        public static let folders = [
            "~/.ssh", "~/.gnupg", "~/.aws", "~/.azure", "~/.kube", "~/.docker", "~/.config", "~/.netrc", "~/.npmrc",
            "~/Library/Keychains", "~/Library/Cookies", "~/Library/HTTPStorages", "~/Library/Accounts", "~/Library/Application Support/com.apple.TCC",
            "~/Library/Application Support/Lifestream",
        ]
        public static let names = ["Cookies", "Login Data", "Web Data", "key4.db", "logins.json"]
        public static let endings = [".keychain-db"]
        public static let managers = ["1password", "bitwarden", "lastpass", "dashlane", "keepassxc", "enpass", "nordpass", "proton pass", "roboform"]
    }

    public struct Unsafe: PathFreeError, Equatable {
        public let reason: String
        public var description: String { reason }
    }


    public func path(_ spelled: String, account: String? = nil) throws -> URL {
        if let fault = Self.pathFault(spelled, unfilled: account == nil ? "nothing fills <account> here" : nil, descends: false) {
            throw Unsafe(reason: fault)
        }
        var rest = String(spelled.dropFirst(2))
        if let account {
            guard !account.isEmpty, account != ".", account != "..", !account.contains("/"), !account.contains("\0") else {
                throw Unsafe(reason: "\(spelled): <account> is filled with no one folder's name")
            }
            rest = rest.replacingOccurrences(of: "<account>", with: account)
        }
        let url = rest.split(separator: "/", omittingEmptySubsequences: true).reduce(home) { $0.appendingPathComponent(String($1)) }
        return try admit(url, spelled: "~/" + rest)
    }

    func named(_ locator: String, under root: URL) -> URL? {
        guard let file = ArtifactPath.regularFile(locator, under: root), (try? admit(file, spelled: nil)) != nil else { return nil }
        return file
    }

    func open(_ url: URL, spelled: String?) throws -> OpenedFile? {
        guard let opened = try Self.opening(url, spelled: spelled) else { return nil }
        return try held(opened, spelled: spelled)
    }

    static func opening(_ url: URL, spelled: String?) throws -> OpenedFile? {
        var descriptor: Int32
        repeat { descriptor = Darwin.open(url.path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC) } while descriptor < 0 && errno == EINTR
        guard descriptor >= 0 else {
            let code = errno
            switch code {
            case ELOOP: throw Unsafe(reason: "\(spelled ?? "a file the store names") is a link, which is never opened")
            case ENOENT, ENOTDIR: return nil
            default: throw FileOpenerError.unreadable(code)
            }
        }
        let opened = OpenedFile(url: url, descriptor: descriptor)
        return opened.isRegularFile ? opened : nil
    }

    static func unlessRefused<T>(_ body: () throws -> T) throws -> T? {
        do { return try body() } catch let refused as Unsafe { throw refused } catch { return nil }
    }

    func held(_ opened: OpenedFile, spelled: String?) throws -> OpenedFile {
        guard let location = Self.location(of: opened.handle.fileDescriptor) else { throw FileOpenerError.unreadable(errno) }
        var now = stat()
        guard fstat(opened.handle.fileDescriptor, &now) == 0 else { throw FileOpenerError.unreadable(errno) }
        guard now.st_nlink <= 1 else {
            throw Unsafe(reason: "\(spelled ?? "a file the store names") has more than one name, which is never opened")
        }
        try hold(opened.url, resolved: location, spelled: spelled)
        return opened
    }

    var opener: FileOpener {
        FileOpener { [self] in try open($0, spelled: nil) }
    }

    static func location(of descriptor: Int32) -> URL? {
        var path = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard fcntl(descriptor, F_GETPATH, &path) != -1 else { return nil }
        return URL(fileURLWithPath: String(cString: path))
    }

    @discardableResult
    func admit(_ url: URL, spelled: String?) throws -> URL {
        try hold(url, resolved: url.resolvingSymlinksInPath(), spelled: spelled)
        return url
    }

    private func hold(_ url: URL, resolved: URL, spelled: String?) throws {
        let said = spelled ?? "a file the store names"
        let homes = Self.forms(of: home)
        func inside(_ url: URL) -> [String]? { homes.lazy.compactMap { Self.parts(of: url, under: $0) }.first }
        guard let real = inside(resolved), let lexical = inside(url.standardizedFileURL) else {
            throw Unsafe(reason: "\(said) lies outside the home folder")
        }
        guard !real.isEmpty else { throw Unsafe(reason: "\(said) names the home folder itself") }
        let own = lifestream.flatMap { folder in Self.forms(of: folder).flatMap { form in homes.compactMap { Self.parts(of: form, under: $0) } } }
        for parts in [lexical, real] {
            if let fault = Self.denied(parts, own: own) { throw Unsafe(reason: "\(said) \(fault)") }
        }
    }

    private static func forms(of folder: URL) -> [URL] {
        var forms = [folder.standardizedFileURL, folder.resolvingSymlinksInPath().standardizedFileURL]
        if let real = realpath(folder.path, nil) {
            forms.append(URL(fileURLWithPath: String(cString: real)))
            free(real)
        }
        return forms.reduce(into: []) { if !$0.contains($1) { $0.append($1) } }
    }

    private static func parts(of url: URL, under root: URL) -> [String]? {
        let rootParts = root.pathComponents
        let parts = url.pathComponents
        guard parts.count >= rootParts.count, Array(parts.prefix(rootParts.count)) == rootParts else { return nil }
        return parts.dropFirst(rootParts.count).map { $0.lowercased() }
    }

    private static func denied(_ parts: [String], own: [[String]]) -> String? {
        let never = NeverRead.folders.map { (folder: $0, parts: partsOf($0)) } + own.map { (folder: "Lifestream's own folder", parts: $0) }
        for (folder, folderParts) in never where parts.count >= folderParts.count && Array(parts.prefix(folderParts.count)) == folderParts {
            return "lies under \(folder), which is never read"
        }
        if let manager = parts.first(where: { part in NeverRead.managers.contains { part.contains($0) } }) {
            return "passes \(manager), a password manager's, which is never read"
        }
        if let last = parts.last, NeverRead.names.contains(where: { $0.lowercased() == last }) || NeverRead.endings.contains(where: { last.hasSuffix($0) }) {
            return "names a file never read"
        }
        return nil
    }


    public static func faults(of store: HomeLink.MacStore, lifestream: [String] = []) -> [String] {
        var faults: [String] = []
        let rule: String
        switch store.account {
        case .local: rule = "local"
        case .appleID: rule = "apple-id"
        case .plist: rule = "plist"
        case .json: rule = "json"
        case .jsonKeys: rule = "json_keys"
        case .folders: rule = "folders"
        }
        let fills = rule == "folders" || rule == "json_keys"
        let own = lifestream.map(partsOf)
        func path(_ value: String, _ at: String, account: Bool, descends: Bool = false) {
            let unfilled = !account ? "the account rule reads it, so it cannot hold <account>" : fills ? nil : "its account rule (\(rule)) fills no <account>"
            if let fault = pathFault(value, unfilled: unfilled, descends: descends, own: own) { faults.append("mac.store.\(at): \(fault)") }
        }
        func pattern(_ value: String?, _ at: String, names: Bool) {
            guard let value, let fault = patternFault(value, names: names) else { return }
            faults.append("mac.store.\(at): \(fault)")
        }
        switch store.held {
        case .one(let held): path(held, "held", account: true)
        case .many(let held): for (index, one) in held.enumerated() { path(one, "held[\(index)]", account: true) }
        }
        switch store.account {
        case .local, .appleID: break
        case .plist(let file, _, _): path(file, "account.plist", account: false)
        case .json(let file, _, _): path(file, "account.json", account: false)
        case .jsonKeys(let file, _, _): path(file, "account.json_keys", account: false)
        case .folders(let folders, let match, let holding, _):
            path(folders, "account.folders", account: false)
            path((folders.hasSuffix("/") ? String(folders.dropLast()) : folders) + "/<account>/" + holding, "account.holding", account: true)
            pattern(match, "account.match", names: false)
        }
        switch store.engine {
        case .sqlite(let stores):
            for (index, each) in stores.enumerated() {
                path(each.path, "engine.stores[\(index)].path", account: true)
                pattern(each.match, "engine.stores[\(index)].match", names: true)
                if let root = each.fileRoot { path(root, "engine.stores[\(index)].file_root", account: true, descends: true) }
            }
        case .file(let files, let names):
            for (index, file) in files.enumerated() { path(file.path, "engine.files[\(index)].path", account: true) }
            if let names { path(names.root, "engine.names.root", account: true, descends: true) }
        case .logs(let roots, let match, let beside, _):
            for (index, root) in roots.enumerated() { path(root.path, "engine.roots[\(index)].path", account: true, descends: true) }
            pattern(match, "engine.match", names: true)
            pattern(beside, "engine.beside", names: true)
        case .biome(let stream):
            if stream.isEmpty || stream == "." || stream == ".." || stream.contains("/") || stream.contains("\0") {
                faults.append("mac.store.engine.stream: \(stream) is no one stream's folder")
            }
        }
        return faults
    }

    static func partsOf(_ path: String) -> [String] {
        path.dropFirst(2).lowercased().split(whereSeparator: { $0 == "/" || $0 == "\\" }).map(String.init).filter { $0 != "." }
    }

    static func pathFault(_ path: String, unfilled: String?, descends: Bool, own: [[String]] = []) -> String? {
        guard path.hasPrefix("~/") else { return "\(path) is not spelled from ~/" }
        if path.contains("\0") { return "holds a NUL" }
        let rest = path.dropFirst(2)
        if rest.hasPrefix("/") || rest.hasPrefix("\\") { return "\(path) holds an absolute part" }
        let scalars = Array(rest.unicodeScalars)
        if scalars.count >= 3, scalars[1] == ":", scalars[2] == "/" || scalars[2] == "\\",
           (0x41...0x5a).contains(scalars[0].value) || (0x61...0x7a).contains(scalars[0].value) {
            return "\(path) holds an absolute part"
        }
        let stated = rest.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "/" || $0 == "\\" })
        if stated.contains("..") { return "\(path) holds a .. part" }
        let parts = partsOf(path)
        if parts.isEmpty { return "names the home folder itself" }
        for part in stated where part.contains("<") {
            guard let open = part.firstIndex(of: "<"), part[open...].contains(">") else { continue }
            if part != "<account>" { return "\(path): \(part) is no whole part <account>" }
            if let unfilled { return "\(path): \(unfilled)" }
        }
        func same(_ part: String, _ other: String) -> Bool { part == other || part == "<account>" }
        let denied = NeverRead.folders.map { ($0, partsOf($0)) } + own.map { ("Lifestream's own folder", $0) }
        for (folder, never) in denied {
            if parts.count >= never.count, zip(parts, never).allSatisfy({ same($0, $1) }) { return "\(path) lies under \(folder), which is never read" }
            if descends, parts.count < never.count, zip(parts, never).allSatisfy({ same($0, $1) }) {
                return "\(path) is read beneath and holds \(folder), which is never read"
            }
        }
        if let manager = parts.first(where: { part in NeverRead.managers.contains { part.contains($0) } }) {
            return "\(path): \(manager) is a password manager's, which is never read"
        }
        let last = parts[parts.count - 1]
        if NeverRead.names.contains(where: { $0.lowercased() == last }) || NeverRead.endings.contains(where: { last.hasSuffix($0) }) {
            return "\(path) names a file never read"
        }
        return nil
    }

    static func patternFault(_ pattern: String, names: Bool) -> String? {
        guard !pattern.isEmpty, pattern.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value <= 0x7e }) else {
            return "is not ASCII: a pattern the Mac and the home read alike is"
        }
        var escaped = false
        for character in pattern {
            if escaped {
                if character == "p" || character == "P" { return "names a Unicode class (\\p{…}), which the Mac and the home read apart" }
                escaped = false
            } else if character == "\\" {
                escaped = true
            }
        }
        guard let compiled = try? NSRegularExpression(pattern: pattern) else { return "does not compile" }
        guard names else { return nil }
        let never = NeverRead.names + NeverRead.endings.map { "login\($0)" }
        if let found = never.first(where: { matches(compiled, $0) || matches(compiled, $0.lowercased()) }) {
            return "matches \(found), a file never read"
        }
        return nil
    }

    static func matches(_ pattern: NSRegularExpression, _ name: String) -> Bool {
        pattern.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil
    }

    static func matches(_ pattern: String, _ name: String) -> Bool {
        guard let compiled = try? NSRegularExpression(pattern: pattern) else { return false }
        return matches(compiled, name)
    }
}

enum ArtifactPath {
    static func file(_ locator: String, under root: URL) -> URL? {
        guard !locator.isEmpty, !locator.contains("\0"), !isAbsolute(locator) else { return nil }
        let stated = locator.split(omittingEmptySubsequences: false,
                                   whereSeparator: { $0 == "/" || $0 == "\\" })
        guard !stated.contains("..") else { return nil }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory),
              isDirectory.boolValue else { return nil }
        var candidate = URL(fileURLWithPath: root.path, isDirectory: true)
        for part in locator.split(separator: "/", omittingEmptySubsequences: true) where part != "." {
            candidate.appendPathComponent(String(part))
        }
        let realRoot = URL(fileURLWithPath: root.path).resolvingSymlinksInPath().standardizedFileURL
        let real = candidate.resolvingSymlinksInPath().standardizedFileURL
        guard contained(real, in: realRoot) else { return nil }
        return candidate
    }

    static func regularFile(_ locator: String, under root: URL) -> URL? {
        guard let candidate = file(locator, under: root), FileFacts.isRegularFile(candidate.path) else { return nil }
        return candidate
    }

    private static func isAbsolute(_ locator: String) -> Bool {
        if locator.hasPrefix("/") || locator.hasPrefix("\\") { return true }
        let scalars = Array(locator.unicodeScalars)
        guard scalars.count >= 3, scalars[1] == ":", scalars[2] == "/" || scalars[2] == "\\" else { return false }
        let letter = scalars[0].value
        return (letter >= 0x41 && letter <= 0x5a) || (letter >= 0x61 && letter <= 0x7a)
    }

    private static func contained(_ candidate: URL, in root: URL) -> Bool {
        let rootParts = root.pathComponents
        let parts = candidate.pathComponents
        guard parts.count >= rootParts.count else { return false }
        return Array(parts.prefix(rootParts.count)) == rootParts
    }
}
