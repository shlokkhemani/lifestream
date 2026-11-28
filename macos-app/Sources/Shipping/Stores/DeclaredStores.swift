import DeviceFiles
import Evidence
import Foundation
import HomeLink

public final class DeclaredStores: @unchecked Sendable {
    public struct Mac: Sendable {
        public let home: URL
        public let lifestream: @Sendable () -> [URL]
        public let applications: [URL]
        public let fullDiskAccess: @Sendable () -> Bool
        public let wake: @Sendable (String) -> Void
        public let ledgers: Ledgers
        public let hashCacheDirectory: URL
        public let sessionDirectory: URL
        public let biomeSpacing: @Sendable () -> TimeInterval

        public static let powerSpacing: @Sendable () -> TimeInterval = { BiomeEngine.powerSpacing() }

        public init(home: URL, lifestream: @escaping @Sendable () -> [URL], applications: [URL], fullDiskAccess: @escaping @Sendable () -> Bool,
                    wake: @escaping @Sendable (String) -> Void = StoreWake.launchHidden, ledgers: Ledgers, hashCacheDirectory: URL,
                    sessionDirectory: URL, biomeSpacing: @escaping @Sendable () -> TimeInterval = Mac.powerSpacing) {
            self.home = home
            self.lifestream = lifestream
            self.applications = applications
            self.fullDiskAccess = fullDiskAccess
            self.wake = wake
            self.ledgers = ledgers
            self.hashCacheDirectory = hashCacheDirectory
            self.sessionDirectory = sessionDirectory
            self.biomeSpacing = biomeSpacing
        }

        public var road: StoreFiles { StoreFiles(home: home, lifestream: lifestream()) }
    }

    public let mac: Mac
    public let consent: StoreConsent
    private let file: URL
    private let files: DeviceFiles
    private let lock = NSLock()
    private var kept: [String: HomeLink.DeclaredStore]?
    private var refusedAtUse: [String: String] = [:]

    public init(file: URL, consent: StoreConsent, mac: Mac) {
        self.file = file
        self.consent = consent
        self.mac = mac
        files = mac.ledgers.files
        kept = (try? files.read(file, maximumBytes: ShippingState.mostKept))
            .flatMap { try? JSONDecoder().decode([String: HomeLink.DeclaredStore].self, from: $0) }
    }

    public convenience init(state: ShippingState, mac: Mac, known: Set<String> = Set(KnownStores.digests.values)) {
        self.init(file: state.root.appendingPathComponent("stores.json"),
                  consent: StoreConsent(file: state.root.appendingPathComponent("allowed.json"), known: known, files: state.files), mac: mac)
    }


    public var declarations: [String: HomeLink.DeclaredStore] { lock.withLock { kept ?? [:] } }

    public func take(_ declarations: [String: HomeLink.DeclaredStore]) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(declarations)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try ShippingState.replace(file, with: data, files: files)
        lock.withLock { kept = declarations }
    }

    public func stated() -> HomeLink.StoresStated {
        let held = lock.withLock { kept }
        return HomeLink.StoresStated(digest: held.map { StoreDigest.of($0) },
                                     states: (held ?? [:]).mapValues(state))
    }


    public func state(of connector: String) -> HomeLink.StoreState? {
        declarations[connector].map(state)
    }

    private func state(_ declaration: HomeLink.DeclaredStore) -> HomeLink.StoreState {
        let digest = declaration.digest
        if !StoreFiles.faults(of: declaration.store, lifestream: lifestream).isEmpty || lock.withLock({ refusedAtUse[digest] }) != nil {
            return .unsafe
        }
        switch consent.answer(digest) {
        case .allowed?: return .allowed
        case .refused?: return .refused
        case nil: return .asked
        }
    }

    public func faults(of connector: String) -> [String] {
        guard let declaration = declarations[connector] else { return [] }
        return StoreFiles.faults(of: declaration.store, lifestream: lifestream)
            + (lock.withLock { refusedAtUse[declaration.digest] }.map { [$0] } ?? [])
    }

    private var lifestream: [String] {
        let home = mac.home.standardizedFileURL.pathComponents
        return mac.lifestream().compactMap { folder in
            let parts = folder.standardizedFileURL.pathComponents
            guard parts.count > home.count, Array(parts.prefix(home.count)) == home else { return nil }
            return "~/" + parts.dropFirst(home.count).joined(separator: "/")
        }
    }

    private func refused(_ declaration: HomeLink.DeclaredStore, _ reason: String) {
        lock.withLock { refusedAtUse[declaration.digest] = reason }
        ShippingState.log.error("a store was refused by the safety rule: \(reason, privacy: .private)")
    }

    public func asking(_ connector: String) -> StoreAsking? {
        guard let declaration = declarations[connector], state(declaration) == .asked || state(declaration) == .refused else { return nil }
        let paths = declaration.store.paths
        let before = Set(consent.allowedPaths(connector))
        return StoreAsking(connector: connector, digest: declaration.digest, paths: paths,
                           new: before.isEmpty ? [] : paths.filter { !before.contains($0) }, wake: declaration.store.wake,
                           sql: declaration.store.sql)
    }

    public func answer(_ answer: StoreConsent.Answer, to asking: StoreAsking) throws {
        try consent.keep(answer, for: asking.digest, connector: asking.connector, paths: asking.paths)
    }


    public func found() -> [String] {
        declarations.filter { found($0.value) }.keys.sorted()
    }

    private func found(_ declaration: HomeLink.DeclaredStore) -> Bool {
        if let app = declaration.app {
            return mac.applications.contains { FileManager.default.fileExists(atPath: $0.appendingPathComponent("\(app).app").path) }
        }
        return declaration.behindFullDiskAccess || held(declaration)
    }

    public func held(_ connector: String) -> Bool {
        declarations[connector].map(held) ?? false
    }

    private func held(_ declaration: HomeLink.DeclaredStore) -> Bool {
        guard state(declaration) == .allowed, !declaration.behindFullDiskAccess || mac.fullDiskAccess() else { return false }
        let paths: [String]
        switch declaration.store.held {
        case .one(let one): paths = [one]
        case .many(let many): paths = many
        }
        let road = mac.road
        return paths.contains { path in
            let folders: [String?] = path.contains("<account>") ? StoreAccounts.read(declaration.store, road: road).map(\.folder) : [nil]
            return folders.contains { folder in
                guard let url = try? road.path(path, account: folder) else { return false }
                return path.hasSuffix("/") ? FileFacts.isDirectory(url.path) : FileFacts.isRegularFile(url.path)
            }
        }
    }

    func accounts(_ declaration: HomeLink.DeclaredStore) -> [StoreAccounts.Held] {
        held(declaration) ? StoreAccounts.read(declaration.store, road: mac.road) : []
    }

    public func offers(unit: String) -> [String] {
        guard !unit.isEmpty else { return [] }
        return declarations.values.flatMap { declaration -> [String] in
            if case .local = declaration.store.account { return [] }
            return accounts(declaration).map { "\(declaration.product):\($0.account):\(unit)" }
        }.sorted()
    }

    private func declaration(of source: String) -> HomeLink.DeclaredStore? {
        connector(of: source).flatMap { declarations[$0] }
    }

    public func connector(of source: String) -> String? {
        let product = ShippingDomains.product(of: source)
        return declarations.filter { $0.value.product == product }.keys.min()
    }

    public func waitsOnFullDiskAccess(_ source: String) -> Bool {
        declaration(of: source)?.behindFullDiskAccess ?? false
    }


    public func domain(for source: String) -> (any ShippingDomain)? {
        guard let declaration = declaration(of: source), state(declaration) == .allowed else { return nil }
        let held: StoreAccounts.Held
        if case .local = declaration.store.account {
            held = StoreAccounts.Held(account: "local", folder: nil)
        } else {
            guard let mine = accounts(declaration).first(where: { $0.account == ShippingDomains.account(of: source) }) else { return nil }
            held = mine
        }
        do {
            return DeclaredDomain(try engine(source, declaration, held)) { [weak self] reason in self?.refused(declaration, reason) }
        } catch let fault as StoreFiles.Unsafe {
            refused(declaration, fault.reason)
        } catch {
            ShippingState.log.error("a store's engine was not built: \(String(describing: error), privacy: .public)")
        }
        return nil
    }

    func engine(_ source: String, _ declaration: HomeLink.DeclaredStore, _ held: StoreAccounts.Held) throws -> any ShippingDomain {
        let store = declaration.store
        let road = mac.road
        let named = mac.ledgers.fileName(forSource: source) + ".json"
        let hashCache = mac.hashCacheDirectory.appendingPathComponent(named)
        switch store.engine {
        case .sqlite(let stores):
            let wake = store.wake.map { bundle in { [mac] in mac.wake(bundle) } as @Sendable () -> Void }
            return SqliteEngine.domain(sourceId: source, store: store, stores: stores, folder: held.folder, files: road,
                                       ledgers: mac.ledgers, hashCache: hashCache, wake: wake)
        case .file(let files, let names):
            return try FileEngine(sourceId: source, store: store, files: files, names: names, account: held.account, road: road,
                                  hashCache: hashCache, ledgers: mac.ledgers)
        case .logs(let roots, let match, let beside, let start):
            return try LogsEngine(sourceId: source, store: store, roots: roots, match: match, beside: beside, start: start, road: road,
                                  stateFile: mac.sessionDirectory.appendingPathComponent(named), ledgers: mac.ledgers)
        case .biome(let stream):
            return try BiomeEngine(sourceId: source, store: store, stream: stream, road: road, ledgers: mac.ledgers,
                                   spacing: mac.biomeSpacing)
        }
    }
}

public struct StoreAsking: Sendable, Equatable {
    public let connector: String
    public let digest: String
    public let paths: [String]
    public let new: [String]
    public let wake: String?
    public let sql: [String]
}

final class DeclaredDomain: ShippingDomain {
    let inner: any ShippingDomain
    private let refuse: @Sendable (String) -> Void

    init(_ inner: any ShippingDomain, refuse: @escaping @Sendable (String) -> Void) {
        self.inner = inner
        self.refuse = refuse
    }

    var sourceId: String { inner.sourceId }
    var name: String { inner.name }
    var unread: Unread? { inner.unread }
    var owesHistory: Bool { inner.owesHistory }
    var through: Through? { inner.through }
    func applied(_ answer: FreshAnswer) { inner.applied(answer) }

    func seal(_ request: SealRequest) throws -> [SealedBundle] {
        do { return try inner.seal(request) } catch let refused as StoreFiles.Unsafe {
            refuse(refused.reason)
            throw refused
        }
    }
}

extension HomeLink.MacStore {
    public var paths: [String] {
        var paths: [String] = []
        func add(_ path: String) { if !paths.contains(path) { paths.append(path) } }
        switch held {
        case .one(let one): add(one)
        case .many(let many): many.forEach(add)
        }
        switch account {
        case .local: break
        case .appleID: add(StoreAccounts.appleAccounts)
        case .plist(let file, _, _), .json(let file, _, _), .jsonKeys(let file, _, _): add(file)
        case .folders(let folders, _, let holding, _):
            add(folders)
            add((folders.hasSuffix("/") ? String(folders.dropLast()) : folders) + "/<account>/" + holding)
        }
        switch engine {
        case .sqlite(let stores):
            for store in stores {
                add(store.match.map { "\(store.path)/\($0)" } ?? store.path)
                store.fileRoot.map(add)
            }
        case .file(let files, let names):
            files.map(\.path).forEach(add)
            names.map(\.root).map(add)
        case .logs(let roots, _, _, _):
            roots.map(\.path).forEach(add)
        case .biome(let stream):
            add(BiomeEngine.folder(of: stream))
            add(BiomeEngine.syncDatabase)
        }
        return paths
    }

    public var sql: [String] {
        guard case .sqlite(let stores) = engine else { return [] }
        func all(_ selects: SqliteStore.Selects?) -> [String] {
            switch selects {
            case nil: return []
            case .one(let sql)?: return [sql]
            case .first(let list)?: return list.map(\.sql)
            }
        }
        return stores.flatMap { store -> [String] in
            store.tables.flatMap { table -> [String] in
                var found: [String] = []
                if case .main(let time, _) = table.role { found.append(time) }
                found += all(table.keep)
                found += table.chosen.map { [$0] } ?? []
                found += table.files ?? []
                found += (table.touchedBy ?? []).compactMap { $0.count >= 2 ? $0[1] : nil }
                return found
            } + all(store.attachments?.select)
        }
    }
}
