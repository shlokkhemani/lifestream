import Foundation
import DeviceFiles
import HomeLink
@testable import Shipping

enum StoreFixtures {
    static func folder() -> URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Fixtures/stores", isDirectory: true)
    }

    static func all() throws -> [String: HomeLink.DeclaredStore] {
        var found: [String: HomeLink.DeclaredStore] = [:]
        for name in try FileManager.default.contentsOfDirectory(atPath: folder().path) where name.hasSuffix(".json") {
            found[String(name.dropLast(5))] = try JSONDecoder().decode(HomeLink.DeclaredStore.self,
                                                                       from: Data(contentsOf: folder().appendingPathComponent(name)))
        }
        return found
    }

    static func declaration(_ id: String) throws -> HomeLink.DeclaredStore {
        try JSONDecoder().decode(HomeLink.DeclaredStore.self, from: Data(contentsOf: folder().appendingPathComponent("\(id).json")))
    }

    static func declaration(of source: String) throws -> HomeLink.DeclaredStore {
        let product = ShippingDomains.product(of: source)
        guard let found = try all().values.first(where: { $0.product == product }) else { throw StoreFixtureError.noMember(source, "product") }
        return found
    }

    static func known() throws -> Set<String> { Set(try all().values.map(\.digest)) }

    static func stores(home: URL, state: URL, applications: [URL] = [], fullDiskAccess: Bool = true,
                       wake: @escaping @Sendable (String) -> Void = { _ in }, ledgers: Ledgers? = nil,
                       lifestream: @escaping @Sendable () -> [URL] = { [] },
                       known: Set<String>? = nil, declarations: [String: HomeLink.DeclaredStore]? = nil) throws -> DeclaredStores {
        let mac = DeclaredStores.Mac(home: home, lifestream: lifestream, applications: applications,
                                     fullDiskAccess: { fullDiskAccess }, wake: wake,
                                     ledgers: ledgers ?? Ledgers(root: state.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain)),
                                     hashCacheDirectory: state.appendingPathComponent("hash-cache", isDirectory: true),
                                     sessionDirectory: state.appendingPathComponent("sessions", isDirectory: true),
                                     biomeSpacing: { BiomeEngine.acSpacing })
        let stores = DeclaredStores(file: state.appendingPathComponent("stores.json"),
                                    consent: StoreConsent(file: state.appendingPathComponent("allowed.json"), known: try known ?? Self.known(), files: DeviceFiles(.plain)),
                                    mac: mac)
        try stores.take(declarations ?? all())
        return stores
    }

    static func none(_ state: URL) throws -> DeclaredStores {
        try stores(home: state, state: state, declarations: [:])
    }

    static func domain(_ source: String, home: URL, ledgers: Ledgers, state: URL? = nil, folder: String? = nil,
                       wake: @escaping @Sendable (String) -> Void = { _ in }) throws -> any ShippingDomain {
        let state = state ?? home.appendingPathComponent(".state", isDirectory: true)
        let stores = try Self.stores(home: home, state: state, wake: wake, ledgers: ledgers)
        return try stores.engine(source, try declaration(of: source), StoreAccounts.Held(account: ShippingDomains.account(of: source), folder: folder))
    }

    static func logs(_ source: String, home: URL, stateFile: URL, ledgers: Ledgers, budget: Int = SessionLogShipper.defaultBudget,
                     clock: @escaping @Sendable () -> Date = { Date() }) throws -> LogsEngine {
        let store = try declaration(of: source).store
        guard case .logs(let roots, let match, let beside, let start) = store.engine else { throw StoreFixtureError.noMember(source, "logs") }
        return try LogsEngine(sourceId: source, store: store, roots: roots, match: match, beside: beside, start: start,
                              road: StoreFiles(home: home, lifestream: []), stateFile: stateFile, ledgers: ledgers, budget: budget, clock: clock)
    }

    static func sqlite(_ source: String, home: URL, ledgers: Ledgers, hashCache: URL, folder: String? = nil,
                       report: @escaping @Sendable (String) -> Void = Differences.log) throws -> DifferencesDomain {
        let store = try declaration(of: source).store
        guard case .sqlite(let stores) = store.engine else { throw StoreFixtureError.noMember(source, "sqlite") }
        return SqliteEngine.domain(sourceId: source, store: store, stores: stores, folder: folder, files: StoreFiles(home: home, lifestream: []),
                                   ledgers: ledgers, hashCache: hashCache, wake: nil, report: report)
    }

    static func schema(_ id: String, member: String) throws -> (Set<String>) -> StoreSchema {
        guard case .sqlite(let stores) = try declaration(id).store.engine,
              let store = stores.first(where: { $0.member == member }) else { throw StoreFixtureError.noMember(id, member) }
        return { SqliteEngine.schema(store, $0) }
    }

    static func url(_ path: String, home: URL, folder: String? = nil) -> URL {
        var rest = String(path.dropFirst(2))
        if let folder { rest = rest.replacingOccurrences(of: "<account>", with: folder) }
        return home.appendingPathComponent(rest)
    }

    static func store(_ id: String, member: String, home: URL, folder: String? = nil) throws -> URL {
        guard case .sqlite(let stores) = try declaration(id).store.engine,
              let store = stores.first(where: { $0.member == member }) else { throw StoreFixtureError.noMember(id, member) }
        return url(store.path, home: home, folder: folder)
    }

    static func fileRoot(_ id: String, member: String, home: URL) throws -> URL {
        guard case .sqlite(let stores) = try declaration(id).store.engine,
              let root = stores.first(where: { $0.member == member })?.fileRoot else { throw StoreFixtureError.noMember(id, member) }
        return url(root, home: home)
    }

    static func locators(_ id: String, member: String, in database: URL) throws -> [String] {
        guard case .sqlite(let stores) = try declaration(id).store.engine,
              let select = stores.first(where: { $0.member == member })?.attachments?.select else { throw StoreFixtureError.noMember(id, member) }
        return try SqliteEngine.locators(select, in: database)
    }

    enum StoreFixtureError: Error {
        case noMember(String, String)
    }
}
