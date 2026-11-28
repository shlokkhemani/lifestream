import CoreServices
import Foundation
import HomeLink

public final class StoreWatcher: @unchecked Sendable {
    public static let latency: CFTimeInterval = 0.5
    static let sidecars = ["-wal", "-shm", "-journal"]
    static let overflow = FSEventStreamEventFlags(kFSEventStreamEventFlagMustScanSubDirs | kFSEventStreamEventFlagUserDropped
        | kFSEventStreamEventFlagKernelDropped)
    static let recentLogs = 16

    public struct Target: Sendable, Equatable {
        public enum Rule: Sendable, Equatable {
            case names(Set<String>)
            case database(pattern: String)
            case logs(match: String, beside: String?)
            case any
            case nested
            case drop
        }

        public enum Stamp: Sendable, Equatable {
            case database(String)
            case databases(pattern: String)
            case file(String)
            case logs
        }

        public let source: String
        public let directory: String
        public let recursive: Bool
        public let rule: Rule
        public let stamp: Stamp?
        let patterns: Patterns

        public init(source: String, directory: String, recursive: Bool, rule: Rule, stamp: Stamp? = nil) {
            self.source = source
            self.directory = directory
            self.recursive = recursive
            self.rule = rule
            self.stamp = stamp
            patterns = Patterns(rule)
        }

        public static func == (one: Target, other: Target) -> Bool {
            one.source == other.source && one.directory == other.directory && one.recursive == other.recursive && one.rule == other.rule
                && one.stamp == other.stamp
        }
    }

    final class Patterns: @unchecked Sendable {
        let first: NSRegularExpression?
        let second: NSRegularExpression?

        init(_ rule: Target.Rule) {
            switch rule {
            case .database(let pattern):
                first = try? NSRegularExpression(pattern: pattern)
                second = nil
            case .logs(let match, let beside):
                first = try? NSRegularExpression(pattern: match)
                second = beside.flatMap { try? NSRegularExpression(pattern: $0) }
            case .names, .any, .nested, .drop:
                first = nil
                second = nil
            }
        }

        func matches(_ name: String) -> Bool {
            [first, second].contains { $0.map { StoreFiles.matches($0, name) } ?? false }
        }
    }

    private final class Context: @unchecked Sendable {
        weak var watcher: StoreWatcher?

        init(_ watcher: StoreWatcher) { self.watcher = watcher }
    }

    private let onChange: @Sendable (Set<String>) -> Void
    private let onOverflow: @Sendable () -> Void
    private let streams: Bool
    private let queue = DispatchQueue(label: "org.lifestreamprotocol.store-watcher")
    private let lock = NSLock()
    private let transitions = NSLock()
    private var targets: [Target] = []
    private var watched: Set<String> = []
    private var stream: FSEventStreamRef?
    private var stopped = false
    private var stamps: [String: String] = [:]
    private var heardLogs: [String: [String]] = [:]

    public init(onChange: @escaping @Sendable (Set<String>) -> Void, onOverflow: @escaping @Sendable () -> Void) {
        self.onChange = onChange
        self.onOverflow = onOverflow
        streams = true
    }

    init(onChange: @escaping @Sendable (Set<String>) -> Void, onOverflow: @escaping @Sendable () -> Void, streams: Bool) {
        self.onChange = onChange
        self.onOverflow = onOverflow
        self.streams = streams
    }

    deinit {
        stop()
    }

    public var watching: [Target] { lock.withLock { targets } }

    public var directories: Set<String> { lock.withLock { watched } }

    public func update(sources: [String], stores: DeclaredStores?, uploadFolder: URL?) {
        update(Self.targets(sources: sources, stores: stores, uploadFolder: uploadFolder))
    }

    func update(_ next: [Target]) {
        let directories = Set(next.map(\.directory))
        transitions.withLock {
            let restart = lock.withLock { () -> Bool in
                guard !stopped else { return false }
                targets = next
                let known = Set(next.map(\.source))
                stamps = stamps.filter { known.contains($0.key) }
                heardLogs = heardLogs.filter { known.contains($0.key) }
                return directories != watched || (streams && stream == nil && !directories.isEmpty)
            }
            guard restart else { return }
            end()
            guard !directories.isEmpty else { return }
            start(directories)
        }
    }

    public func stop() {
        transitions.withLock {
            lock.withLock { stopped = true }
            end()
        }
    }

    private func end() {
        let ending = lock.withLock { () -> FSEventStreamRef? in
            defer {
                stream = nil
                watched = []
            }
            return stream
        }
        guard let ending else { return }
        FSEventStreamStop(ending)
        FSEventStreamInvalidate(ending)
        FSEventStreamRelease(ending)
    }

    private func start(_ directories: Set<String>) {
        guard streams else {
            lock.withLock { watched = directories }
            return
        }
        let box = Context(self)
        var context = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(box).toOpaque(), retain: { info in
            guard let info else { return nil }
            _ = Unmanaged<Context>.fromOpaque(info).retain()
            return info
        }, release: { info in
            guard let info else { return }
            Unmanaged<Context>.fromOpaque(info).release()
        }, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, count, paths, flags, _ in
            guard let info, let watcher = Unmanaged<Context>.fromOpaque(info).takeUnretainedValue().watcher else { return }
            let heard = unsafeBitCast(paths, to: NSArray.self).compactMap { $0 as? String }
            watcher.heard(zip(heard, UnsafeBufferPointer(start: flags, count: count)).map { ($0, $1) })
        }
        let flags = FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer
            | kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagIgnoreSelf)
        guard let made = withExtendedLifetime(box, {
            FSEventStreamCreate(nil, callback, &context, directories.sorted() as CFArray,
                                FSEventStreamEventId(kFSEventStreamEventIdSinceNow), Self.latency, flags)
        }) else { return }
        FSEventStreamSetDispatchQueue(made, queue)
        guard FSEventStreamStart(made) else {
            FSEventStreamInvalidate(made)
            FSEventStreamRelease(made)
            return
        }
        lock.withLock {
            stream = made
            watched = directories
        }
    }

    func heard(_ events: [(path: String, flags: FSEventStreamEventFlags)]) {
        let targets = watching
        var changed: Set<String> = []
        var logs: [String: [String]] = [:]
        var overflowed = false
        for event in events {
            if Self.overflows(event.flags) { overflowed = true }
            for target in targets where Self.matches(event.path, target) {
                changed.insert(target.source)
                if target.stamp == .logs { logs[target.source, default: []].append(event.path) }
            }
        }
        if !logs.isEmpty { remember(logs) }
        if overflowed { onOverflow() }
        if !changed.isEmpty { onChange(changed) }
    }

    private func remember(_ logs: [String: [String]]) {
        lock.withLock {
            for (source, paths) in logs {
                var recent = heardLogs[source] ?? []
                for path in paths {
                    recent.removeAll { $0 == path }
                    recent.append(path)
                }
                heardLogs[source] = Array(recent.suffix(Self.recentLogs))
            }
        }
    }

    public static func overflows(_ flags: FSEventStreamEventFlags) -> Bool {
        flags & overflow != 0
    }

    public static func match(path: String, flags: FSEventStreamEventFlags, targets: [Target]) -> Set<String> {
        Set(targets.filter { matches(path, $0) }.map(\.source))
    }

    static func matches(_ path: String, _ target: Target) -> Bool {
        let prefix = target.directory.hasSuffix("/") ? target.directory : target.directory + "/"
        guard path.hasPrefix(prefix) else { return false }
        let rest = String(path.dropFirst(prefix.count))
        let parts = rest.split(separator: "/").map(String.init)
        guard let name = parts.last, target.recursive || parts.count == 1 else { return false }
        switch target.rule {
        case .names(let names):
            return names.contains(name)
        case .database:
            return target.patterns.matches(unsided(name))
        case .logs:
            return parts.indices.contains { start in target.patterns.matches(parts[start...].joined(separator: "/")) }
        case .any:
            return !parts.contains { $0.hasPrefix(".") }
        case .nested:
            return parts.count > 1 && !parts.contains { $0.hasPrefix(".") }
        case .drop:
            return !parts.contains { part in
                part.hasPrefix(".") || UploadDomain.partialSuffixes.contains { part.lowercased().hasSuffix($0) }
            }
        }
    }

    static func unsided(_ name: String) -> String {
        guard let sidecar = sidecars.first(where: name.hasSuffix) else { return name }
        return String(name.dropLast(sidecar.count))
    }

    static func sided(_ name: String) -> Set<String> {
        Set([name] + sidecars.map { name + $0 })
    }

    public static func targets(sources: [String], stores: DeclaredStores?, uploadFolder: URL?) -> [Target] {
        var found: [Target] = []
        if let uploadFolder, let source = sources.sorted().first(where: { ShippingDomains.product(of: $0) == "upload" }) {
            found.append(Target(source: source, directory: real(uploadFolder.path), recursive: true, rule: .drop))
        }
        guard let stores else { return found }
        for source in sources.sorted() {
            guard let connector = stores.connector(of: source), stores.state(of: connector) == .allowed,
                  let declaration = stores.declarations[connector] else { continue }
            let folder: String?
            if case .local = declaration.store.account {
                folder = nil
            } else {
                guard let held = stores.accounts(declaration).first(where: { $0.account == ShippingDomains.account(of: source) }) else { continue }
                folder = held.folder
            }
            found += targets(source, declaration.store.engine, road: stores.mac.road, folder: folder)
        }
        return found
    }

    static func targets(_ source: String, _ engine: HomeLink.MacStore.Engine, road: StoreFiles, folder: String?) -> [Target] {
        func url(_ spelled: String) -> URL? { try? road.path(spelled, account: folder) }
        var found: [Target] = []
        switch engine {
        case .sqlite(let databases):
            for database in databases {
                guard let path = url(database.path) else { continue }
                let folder: String
                if let match = database.match {
                    folder = real(path.path)
                    found.append(Target(source: source, directory: folder, recursive: false, rule: .database(pattern: match),
                                        stamp: .databases(pattern: match)))
                } else {
                    folder = real(path.deletingLastPathComponent().path)
                    found.append(Target(source: source, directory: folder, recursive: false, rule: .names(sided(path.lastPathComponent)),
                                        stamp: .database(folder + "/" + path.lastPathComponent)))
                }
                if let root = database.fileRoot.flatMap(url).map({ real($0.path) }) {
                    found.append(Target(source: source, directory: root, recursive: true, rule: root == folder ? .nested : .any))
                }
            }
        case .file(let files, let names):
            for file in files {
                guard let path = url(file.path) else { continue }
                let directory = real(path.deletingLastPathComponent().path)
                found.append(Target(source: source, directory: directory, recursive: false, rule: .names([path.lastPathComponent]),
                                    stamp: .file(directory + "/" + path.lastPathComponent)))
            }
            if let root = names.map(\.root).flatMap(url) {
                found.append(Target(source: source, directory: real(root.path), recursive: true, rule: .any))
            }
        case .logs(let roots, let match, let beside, _):
            for root in roots {
                guard let path = url(root.path) else { continue }
                found.append(Target(source: source, directory: real(path.path), recursive: true, rule: .logs(match: match, beside: beside),
                                    stamp: .logs))
            }
        case .biome:
            break
        }
        return found
    }

    static func real(_ path: String) -> String {
        guard let resolved = realpath(path, nil) else {
            let url = URL(fileURLWithPath: path)
            let parent = url.deletingLastPathComponent().path
            guard parent != path, parent != "/" else { return path }
            return real(parent) + "/" + url.lastPathComponent
        }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    public var unstamped: Set<String> {
        let targets = watching
        let stamped = Set(targets.filter { $0.stamp != nil && $0.stamp != .logs }.map(\.source))
        return Set(targets.map(\.source)).subtracting(stamped)
    }

    public func changedByStamp() -> Set<String> {
        let now = stamps(of: nil)
        return lock.withLock {
            var changed: Set<String> = []
            for (source, joined) in now {
                if let before = stamps[source], before != joined { changed.insert(source) }
                stamps[source] = joined
            }
            return changed
        }
    }

    public func stamps(of sources: Set<String>?) -> [String: String] {
        let (targets, logs) = lock.withLock { (targets, heardLogs) }
        var parts: [String: [String]] = [:]
        for target in targets where sources.map({ $0.contains(target.source) }) ?? true {
            guard let stamp = target.stamp else { continue }
            parts[target.source, default: []].append(Self.stamp(stamp, in: target.directory, heard: logs[target.source] ?? []))
        }
        return parts.mapValues { $0.sorted().joined(separator: "|") }
    }

    public func keep(_ taken: [String: String]) {
        lock.withLock {
            let known = Set(targets.map(\.source))
            for (source, joined) in taken where known.contains(source) { stamps[source] = joined }
        }
    }

    static func stamp(_ stamp: Target.Stamp, in directory: String, heard: [String]) -> String {
        switch stamp {
        case .database(let path), .file(let path):
            return FileStamp.of(URL(fileURLWithPath: path))
        case .databases(let pattern):
            let names = ((try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? [])
                .filter { StoreFiles.matches(pattern, $0) }.sorted()
            return names.map { $0 + " " + FileStamp.of(URL(fileURLWithPath: directory).appendingPathComponent($0)) }.joined(separator: ",")
        case .logs:
            let folders = Set([directory] + heard.map { ($0 as NSString).deletingLastPathComponent })
            return (folders.sorted() + heard.sorted()).map { $0 + " " + modified($0) }.joined(separator: ",")
        }
    }

    static func modified(_ path: String) -> String {
        var facts = stat()
        guard stat(path, &facts) == 0 else { return "-" }
        return "\(facts.st_mtimespec.tv_sec):\(facts.st_mtimespec.tv_nsec)"
    }
}
