import Darwin
import Evidence
import Foundation
import Passwords
import ServiceManagement

enum HomeJob: String, CaseIterable, Codable {
    case home, door, dashboard, mcp, runner
    case resourceWatch = "resource-watch"

    var label: String { "org.lifestreamprotocol.\(rawValue)" }

    var plistName: String { "\(label).plist" }

    var program: (script: String, arguments: [String])? {
        switch self {
        case .home: return ("dist/home.mjs", ["serve"])
        case .door: return ("dist/door.mjs", ["serve"])
        case .dashboard: return ("dashboard/server.mjs", [])
        case .mcp: return ("mcp/server.mjs", [])
        case .runner: return ("dist/runner.mjs", ["serve", "--door", "http://127.0.0.1:4680"])
        case .resourceWatch: return nil
        }
    }

    var handedKey: Bool { self == .home || self == .door }

    var definition: [String: Any] {
        let noCore = ["Core": 0]
        var plist: [String: Any] = [
            "Label": label,
            "BundleProgram": "Contents/MacOS/Lifestream",
            "RunAtLoad": true,
            "KeepAlive": true,
            "ThrottleInterval": 60,
            "Umask": 0o077,
            "SoftResourceLimits": noCore,
            "HardResourceLimits": noCore,
        ]
        if program == nil {
            plist["ProgramArguments"] = ["Lifestream", rawValue]
            plist["ProcessType"] = "Background"
            plist["LowPriorityIO"] = true
        } else {
            plist["ProgramArguments"] = ["Lifestream", "launch", "--job", rawValue]
            plist["ExitTimeOut"] = 30
            if self != .home { plist["AbandonProcessGroup"] = true }
            if self == .door { plist["ProcessType"] = "Interactive" }
        }
        return plist
    }

    static func writeDefinitions(into folder: URL) throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for job in allCases {
            let data = try PropertyListSerialization.data(fromPropertyList: job.definition, format: .xml, options: 0)
            try data.write(to: folder.appendingPathComponent(job.plistName), options: .atomic)
        }
    }
}

enum OwnLog {
    static func open(_ log: URL) -> Int32 { OwnerOnly.append(log) }

    static func append(_ data: Data, to log: URL) {
        let fd = open(log)
        guard fd >= 0 else { return }
        defer { close(fd) }
        _ = data.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
    }
}

final class CommandRuns: @unchecked Sendable {
    static let app = CommandRuns()

    private let one = NSLock()
    private let lock = NSLock()
    private var queued = 0

    var waiting: Int { lock.withLock { queued } }

    func run<T>(_ body: () throws -> T) rethrows -> T {
        lock.withLock { queued += 1 }
        one.lock()
        lock.withLock { queued -= 1 }
        defer { one.unlock() }
        return try body()
    }
}

enum MachineDirectory {
    static var url: URL { HomeSocket.pointer.deletingLastPathComponent() }
    static var current: URL { url.appendingPathComponent("current/RELEASE.json") }
}

enum Launcher {
    struct Command: Equatable {
        let executable: String
        let arguments: [String]
        let environment: [String: String]
    }

    static func command(_ job: HomeJob, machine: URL = MachineDirectory.url) -> Command? {
        guard let program = job.program else { return nil }
        let release = machine.appendingPathComponent("current").resolvingSymlinksInPath()
        guard FileManager.default.fileExists(atPath: release.appendingPathComponent("RELEASE.json").path) else { return nil }
        let node = release.appendingPathComponent("node").path
        let environment = job == .dashboard ? ["VIEWER_STATE_DIR": machine.appendingPathComponent("dashboard").path] : [:]
        let folders = job == .runner ? ["--pass", machine.appendingPathComponent("runner/door-token").path,
                                        "--files", machine.appendingPathComponent("models").path] : []
        let script = (job == .dashboard ? checkoutDashboard(machine) : nil) ?? release.appendingPathComponent(program.script).path
        return Command(executable: node,
                       arguments: [node, script] + program.arguments + folders,
                       environment: environment)
    }

    static func checkoutDashboard(_ machine: URL) -> String? {
        guard let named = try? String(contentsOf: machine.appendingPathComponent("dashboard-from"), encoding: .utf8) else { return nil }
        let checkout = named.trimmingCharacters(in: .whitespacesAndNewlines)
        guard checkout.hasPrefix("/") else { return nil }
        let server = URL(fileURLWithPath: checkout).appendingPathComponent("dashboard/server.mjs").path
        return FileManager.default.fileExists(atPath: server) ? server : nil
    }


    static func log(_ job: HomeJob) -> URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/lifestream/\(job.rawValue).log")
    }

    static func exec(_ job: HomeJob) -> Never {
        hush()
        let fd = OwnLog.open(log(job))
        if fd >= 0 {
            dup2(fd, STDOUT_FILENO)
            dup2(fd, STDERR_FILENO)
            close(fd)
        }
        guard let command = command(job) else {
            FileHandle.standardError.write(Data("launch \(job.rawValue): no release is current in \(MachineDirectory.url.path); the app's first run installs one\n".utf8))
            exit(1)
        }
        if job.handedKey, let why = VaultHandOff.prepare(VaultHandOff.read()) {
            FileHandle.standardError.write(Data("launch \(job.rawValue): the \(job.rawValue) starts locked: \(why)\n".utf8))
        }
        for (name, value) in command.environment {
            try? FileManager.default.createDirectory(atPath: value, withIntermediateDirectories: true)
            setenv(name, value, 1)
        }
        let arguments = command.arguments.map { strdup($0) } + [nil]
        execv(command.executable, arguments)
        FileHandle.standardError.write(Data("launch \(job.rawValue): cannot run \(command.executable): \(String(cString: strerror(errno)))\n".utf8))
        exit(1)
    }

    static func hush() {
        umask(0o077)
        var none = rlimit(rlim_cur: 0, rlim_max: 0)
        setrlimit(RLIMIT_CORE, &none)
    }
}

enum VaultHandOff {
    static let variable = "LIFESTREAM_VAULT_FD"
    static let wait: TimeInterval = 5

    static func read(_ keys: @escaping @Sendable () -> HomeKeys = { HomeKeys(reader: .helper) }) -> KeyRead {
        let read = Handed()
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async {
            read.value = keys().thisHome().launchRead(within: wait)
            done.signal()
        }
        guard done.wait(timeout: .now() + 2 * wait) == .success else {
            return .unanswered("the Keychain did not answer within \(Int(2 * wait)) s")
        }
        return read.value
    }

    private final class Handed: @unchecked Sendable {
        var value: KeyRead = .none
    }

    static func prepare(_ read: KeyRead, descriptor: Int32 = 3) -> String? {
        unsetenv(variable)
        let key: Data
        switch read {
        case .key(let held) where held.count == KeychainItem.length: key = held
        case .key: return refuse("the Keychain's vault item is not \(KeychainItem.length) bytes", descriptor)
        case .none: return refuse("this Mac's Keychain holds no vault key; the recovery key unlocks Lifestream", descriptor)
        case .unreadable(let why): return refuse("this Mac's Keychain item for Lifestream holds no key it can use (\(why)); the recovery key unlocks Lifestream", descriptor)
        case .refused(let why), .unanswered(let why): return refuse(why, descriptor)
        }
        var ends: [Int32] = [-1, -1]
        guard pipe(&ends) == 0 else { return refuse("no pipe could be made for the vault key", descriptor) }
        let written = key.withUnsafeBytes { write(ends[1], $0.baseAddress, $0.count) }
        close(ends[1])
        guard written == key.count else {
            close(ends[0])
            return refuse("the vault key could not be written to its pipe", descriptor)
        }
        if ends[0] != descriptor {
            guard dup2(ends[0], descriptor) == descriptor else {
                close(ends[0])
                return refuse("the vault key's pipe could not be put on fd \(descriptor)", descriptor)
            }
            close(ends[0])
        }
        setenv(variable, "\(descriptor)", 1)
        return nil
    }

    private static func refuse(_ why: String, _ descriptor: Int32) -> String {
        close(descriptor)
        return why
    }
}

enum HomeAgents {
    enum AppLogin: String, Encodable, Sendable {
        case enabled
        case requiresApproval = "requires_approval"
        case notRegistered = "not_registered"
    }

    enum State: String, Encodable, Sendable {
        case current
        case starting
        case stale
        case requiresApproval = "requires_approval"
        case notRegistered = "not_registered"
        case foreign
    }

    struct Observed: Equatable, Sendable {
        enum Registration: Equatable, Sendable { case enabled, requiresApproval, none }
        enum Held: Equatable, Sendable {
            case none
            case byThisApp(build: String?, refused: Bool, tried: Bool)
            case byAnother
        }

        let registration: Registration
        let held: Held
        let handWritten: Bool

        func state(build: String) -> State {
            if handWritten || held == .byAnother { return .foreign }
            switch registration {
            case .none: return .notRegistered
            case .requiresApproval: return .requiresApproval
            case .enabled:
                guard case .byThisApp(build, false, let tried) = held else { return .stale }
                return tried ? .current : .starting
            }
        }
    }

    static func renewed(_ states: [HomeJob: State]) -> [HomeJob] {
        HomeJob.allCases.filter { states[$0] == .stale || states[$0] == .notRegistered }
    }

    static func foreignRefusal(_ states: [HomeJob: State], user: Int = Int(getuid())) -> String? {
        let labels = HomeJob.allCases.filter { states[$0] == .foreign }.map(\.label)
        guard !labels.isEmpty else { return nil }
        return "Lifestream's jobs run only from this app, and another definition runs \(labels.joined(separator: ", ")). "
            + "Remove each (launchctl bootout gui/\(user)/<label>, then delete ~/Library/LaunchAgents/<label>.plist), then try again."
    }

    static func placeRefusal(_ bundle: URL, user: URL = FileManager.default.homeDirectoryForCurrentUser,
                             writable: (String) -> Bool = FileManager.default.isWritableFile(atPath:)) -> String? {
        let path = bundle.resolvingSymlinksInPath().path
        let places = ["/Applications/", user.appendingPathComponent("Applications").path + "/"]
        guard places.contains(where: { path.hasPrefix($0) }) else {
            return "Move Lifestream to your Applications folder, then open it again: it runs from the app where it stays."
        }
        guard writable(path), writable((path as NSString).deletingLastPathComponent) else {
            return "Move Lifestream to the Applications folder in your user folder (~/Applications), then open it again: updates replace the app, and this account cannot change it where it is."
        }
        return nil
    }

    static func observe(_ job: HomeJob) -> Observed {
        let registration: Observed.Registration
        switch SMAppService.agent(plistName: job.plistName).status {
        case .enabled: registration = .enabled
        case .requiresApproval: registration = .requiresApproval
        default: registration = .none
        }
        let held: Observed.Held
        switch Launchd.job(job.label) {
        case nil: held = .none
        case let job? where !job.submittedByApp: held = .byAnother
        case let job?: held = .byThisApp(build: job.build, refused: job.refused, tried: job.tried)
        }
        let handWritten = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/\(job.plistName)")
        return Observed(registration: registration, held: held, handWritten: FileManager.default.fileExists(atPath: handWritten.path))
    }

    static func states() -> [HomeJob: State] {
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        return Dictionary(uniqueKeysWithValues: HomeJob.allCases.map { ($0, observe($0).state(build: build)) })
    }

    static var appLogin: AppLogin {
        switch SMAppService.mainApp.status {
        case .enabled: return .enabled
        case .requiresApproval: return .requiresApproval
        default: return .notRegistered
        }
    }

    static var awaitingApproval: Bool {
        HomeJob.allCases.contains { SMAppService.agent(plistName: $0.plistName).status == .requiresApproval }
    }

    static func reconcile(bundle: URL = Bundle.main.bundleURL) async throws -> [HomeJob: State] {
        if let refusal = placeRefusal(bundle) { throw AgentError(job: nil, words: refusal) }
        let before = states()
        if let refusal = foreignRefusal(before) { throw AgentError(job: nil, words: refusal) }
        let jobs = renewed(before)
        try await withThrowingTaskGroup(of: Void.self) { group in
            for job in jobs { group.addTask { try await renew(job) } }
            try await group.waitForAll()
        }
        return states()
    }

    static func keepCommand(_ release: BundledRelease? = .inApp(), machine: URL = MachineDirectory.url, runs: CommandRuns = .app) {
        guard let release else { return }
        _ = try? runs.run {
            let never = !FileManager.default.fileExists(atPath: machine.appendingPathComponent("command.json").path)
            return try release.command(never ? .install : nil)
        }
    }

    static func command(_ act: General.CommandAct?, release: BundledRelease, runs: CommandRuns = .app) throws -> General.Command {
        try runs.run { try release.command(act) }
    }

    static func stopWatcher() {
        Launchd.signal(HomeJob.resourceWatch.label, "SIGSTOP")
    }

    static func startWatcher() {
        Launchd.signal(HomeJob.resourceWatch.label, "SIGKILL")
        Launchd.kickstartWaiting(HomeJob.resourceWatch.label, within: kickstartWithin)
    }

    static func restart(_ job: HomeJob) async {
        await Launchd.kickstart(job.label, within: kickstartWithin, kill: true)
    }

    static func open() async throws {
        if await Task.detached(operation: { held(.home) }).value {
            await Launchd.kickstart(HomeJob.home.label, within: kickstartWithin)
        } else {
            _ = try await reconcile()
        }
    }

    static func held(_ job: HomeJob) -> Bool {
        Launchd.job(job.label) != nil
    }

    private static func renew(_ job: HomeJob) async throws {
        try await register(job)
        if try await starts(job) { return }
        await Launchd.kickstart(job.label, within: kickstartWithin)
        try await register(job)
        guard try await starts(job) else {
            throw AgentError(job: job, words: "macOS will not start it from this app")
        }
    }

    static let kickstartWithin: TimeInterval = 70
    static let endWithin: TimeInterval = 40
    static let startWithin: TimeInterval = 5
    static let firstTryWithin: TimeInterval = 90

    private static func register(_ job: HomeJob) async throws {
        let service = SMAppService.agent(plistName: job.plistName)
        do {
            if service.status == .enabled || service.status == .requiresApproval { try await service.unregister() }
            guard try await until(endWithin, { Launchd.job(job.label) == nil }) else {
                throw AgentError(job: job, words: "its process did not end within \(Int(endWithin)) seconds")
            }
            try service.register()
        } catch let error as AgentError {
            throw error
        } catch {
            throw AgentError(job: job, words: error.localizedDescription)
        }
    }

    private static func starts(_ job: HomeJob) async throws -> Bool {
        let tried = try await until(startWithin) {
            SMAppService.agent(plistName: job.plistName).status == .requiresApproval || Launchd.job(job.label)?.tried == true
        }
        guard tried else { return false }
        try await Task.sleep(for: settle)
        if SMAppService.agent(plistName: job.plistName).status == .requiresApproval { return true }
        return Launchd.job(job.label).map { !$0.refused } ?? false
    }

    static let settle = Duration.seconds(1)

    private static func until(_ seconds: TimeInterval, _ done: () -> Bool) async throws -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if done() { return true }
            try await Task.sleep(for: .milliseconds(100))
        }
        return done()
    }

    static func remove() async throws {
        do { try await closeAtLogin() } catch {
            throw AgentError(job: nil, words: error.localizedDescription)
        }
        for job in HomeJob.allCases {
            let service = SMAppService.agent(plistName: job.plistName)
            guard service.status == .enabled || service.status == .requiresApproval else { continue }
            do { try await service.unregister() } catch {
                throw AgentError(job: job, words: error.localizedDescription)
            }
        }
    }

    static func untilNoneHeld() async throws {
        guard try await until(endWithin, { HomeJob.allCases.allSatisfy { Launchd.job($0.label) == nil } }) else {
            let held = HomeJob.allCases.filter { Launchd.job($0.label) != nil }.map(\.label)
            throw AgentError(job: nil, words: "launchd still holds \(held.joined(separator: ", ")) \(Int(endWithin)) seconds after they were removed")
        }
    }

    static func openAtLogin() {
        if appLogin == .notRegistered { try? SMAppService.mainApp.register() }
    }

    static func closeAtLogin() async throws {
        if appLogin != .notRegistered { try await SMAppService.mainApp.unregister() }
    }
}

struct AgentError: Error, CustomStringConvertible {
    let job: HomeJob?
    let words: String

    var description: String { job.map { "macOS refused the \($0.rawValue) agent: \(words)" } ?? words }
}
