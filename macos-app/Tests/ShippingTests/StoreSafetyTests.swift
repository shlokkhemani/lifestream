import Foundation
import DeviceFiles
import HomeLink
import SQLite3
import XCTest
@testable import Shipping

final class StoreSafetyTests: XCTestCase {
    static let unit = "macbook-pro-0001"
    private var root: URL!
    private var home: URL { root.appendingPathComponent("home", isDirectory: true) }
    private var state: URL { root.appendingPathComponent("state", isDirectory: true) }

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("store-safety-tests")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }


    private static let folder = "~/Library/Application Support/Example Store"

    private static func example(paths extra: [String] = [], keep: String = "id > 0", touched: String = "SELECT note_id AS k FROM attachment",
                                plist: String? = nil, held: String? = nil) -> [String: Any] {
        var stores: [[String: Any]] = [[
            "path": "\(folder)/store.db", "member": "store.sqlite", "identity": "file", "file_root": folder,
            "attachments": ["member": "files", "select": "SELECT path FROM attachment"],
            "tables": [
                ["name": "note", "key": "id", "role": ["main": ["time": "created", "rows": "notes"]], "keep": keep,
                 "touched_by": [["attachment", touched]]],
                ["name": "attachment", "key": "id", "role": "follows", "keep": "note_id IN (SELECT id FROM note)", "files": ["path"]],
            ],
        ]]
        for (index, path) in extra.enumerated() {
            stores.append(["path": path, "member": "extra-\(index).sqlite", "identity": "file", "optional": true,
                           "tables": [["name": "note", "key": "id", "role": "changes"]]])
        }
        var store: [String: Any] = ["feeder": "example-store-mac", "name": "example_store", "held": held ?? "\(folder)/store.db",
                                    "account": "local", "engine": ["kind": "sqlite", "stores": stores]]
        if let plist { store["account"] = ["plist": plist, "key": "Own"] }
        return store
    }

    private static func store(_ object: [String: Any]) throws -> HomeLink.MacStore {
        try JSONDecoder().decode(HomeLink.MacStore.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private static func declared(_ object: [String: Any], product: String = "example-store") throws -> HomeLink.DeclaredStore {
        HomeLink.DeclaredStore(app: nil, grants: [], product: product, store: try store(object))
    }

    @discardableResult
    private func layExample() throws -> URL {
        let database = StoreFixtures.url("\(Self.folder)/store.db", home: home)
        try FileManager.default.createDirectory(at: database.deletingLastPathComponent(), withIntermediateDirectories: true)
        try DomainFixtures.sqlite(database, [
            "CREATE TABLE note (id INTEGER PRIMARY KEY, created INTEGER, body TEXT)",
            "CREATE TABLE attachment (id INTEGER PRIMARY KEY, note_id INTEGER, path TEXT)",
            "INSERT INTO note VALUES (1, 1790000000, 'synthetic one'), (2, 1790000060, 'synthetic two')",
            "INSERT INTO attachment VALUES (1, 2, 'files/a.txt')",
        ])
        try DomainFixtures.write("synthetic attachment", to: database.deletingLastPathComponent().appendingPathComponent("files/a.txt"))
        return database
    }

    private func shipper() throws -> DeclaredStores {
        try StoreFixtures.stores(home: home, state: state, known: [], declarations: [:])
    }

    private func seal(_ domain: any ShippingDomain) throws -> [SealedBundle] {
        try domain.seal(SealRequest(fetchedAt: try DomainFixtures.instant("2026-09-23T04:00:00.000Z"),
                                    workDirectory: try DomainFixtures.directory(root.appendingPathComponent("work-\(UUID().uuidString)")), scratch: try DomainFixtures.directory(root.appendingPathComponent("work-\(UUID().uuidString)")),
                                    custody: SealCustody(pass: ShippingFixture.pass, received: 0, imported: 0, history: true)))
    }

    func testAnUnknownStoreIsHeldUntilAllowedAndAsksAgainWhenChanged() throws {
        try layExample()
        let id = "example-store", source = "example-store:local:\(Self.unit)"
        let stores = try shipper()
        try stores.take([id: try Self.declared(Self.example())])

        XCTAssertEqual(stores.stated().states[id], .asked)
        XCTAssertFalse(stores.held(id))
        XCTAssertNil(stores.domain(for: source), "no engine before the person's Allow")
        let asking = try XCTUnwrap(stores.asking(id))
        XCTAssertEqual(asking.paths, ["\(Self.folder)/store.db", Self.folder])
        XCTAssertEqual(asking.new, [], "the first ask shows every path, none as new")
        XCTAssertNil(asking.wake)
        XCTAssertTrue(asking.sql.contains("SELECT path FROM attachment"))
        XCTAssertEqual(asking.digest, StoreDigest.of(try Self.declared(Self.example())))

        try stores.answer(.allowed, to: asking)
        XCTAssertEqual(stores.stated().states[id], .allowed)
        XCTAssertTrue(stores.held(id))
        let sealed = try seal(try XCTUnwrap(stores.domain(for: source)))
        let names = try sealed.map { try StoredZipReader($0.file).names }
        XCTAssertEqual(names.first?.filter { !$0.hasPrefix("blobs/") && $0 != BundleWriter.manifestFile }, ["store.sqlite", "files"])
        XCTAssertTrue(names.joined().contains("blobs/\(DomainFixtures.sha256("synthetic attachment"))"), "the file its note names: \(names)")
        let restarted = try StoreFixtures.stores(home: home, state: state, known: [], declarations: stores.declarations)
        XCTAssertEqual(restarted.stated().states[id], .allowed)

        let added = "~/Library/Application Support/Example Store/second.db"
        try restarted.take([id: try Self.declared(Self.example(paths: [added]))])
        XCTAssertEqual(restarted.stated().states[id], .asked)
        XCTAssertNil(restarted.domain(for: source))
        let again = try XCTUnwrap(restarted.asking(id))
        XCTAssertEqual(again.new, [added])

        try restarted.answer(.refused, to: again)
        XCTAssertEqual(restarted.stated().states[id], .refused)
        XCTAssertFalse(restarted.held(id))
        XCTAssertNil(restarted.domain(for: source))

        let known = try StoreFixtures.stores(home: home, state: root.appendingPathComponent("known"),
                                             known: [StoreDigest.of(try Self.declared(Self.example()))], declarations: [:])
        try known.take([id: try Self.declared(Self.example())])
        XCTAssertEqual(known.stated().states[id], .allowed)
        XCTAssertNil(known.asking(id))
    }


    private static let files = "~/Library/Application Support/Example Files"

    private static func fileStore() -> [String: Any] {
        ["feeder": "example-files-mac", "name": "example_files", "held": "\(files)/history.json", "account": "local",
         "engine": ["kind": "file", "files": [["member": "history.json", "path": "\(files)/history.json"]]]]
    }

    private func fileDomain(_ state: String, lifestream: @escaping @Sendable () -> [URL] = { [] }) throws -> (DeclaredStores, (any ShippingDomain)?) {
        let stores = try StoreFixtures.stores(home: home, state: root.appendingPathComponent(state), lifestream: lifestream, known: [], declarations: [:])
        try stores.take(["example-files": try Self.declared(Self.fileStore(), product: "example-files")])
        try stores.answer(.allowed, to: try XCTUnwrap(stores.asking("example-files")))
        return (stores, stores.domain(for: "example-files:local:\(Self.unit)"))
    }

    func testAFileSwappedForALinkAfterItsEngineIsBuiltIsRefusedAtTheRead() throws {
        let declared = "\(Self.files)/history.json"
        let file = StoreFixtures.url(declared, home: home)
        let ssh = home.appendingPathComponent(".ssh", isDirectory: true)
        try DomainFixtures.write("synthetic secret", to: ssh.appendingPathComponent("history.json"))
        let reason = "\(declared) lies under ~/.ssh, which is never read"

        try DomainFixtures.write(#"{"synthetic":1}"#, to: file)
        let (stores, domain) = try fileDomain("file")
        XCTAssertEqual(try seal(try XCTUnwrap(domain)).count, 1, "the file as declared ships")
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: ssh.appendingPathComponent("history.json"))
        XCTAssertThrowsError(try seal(try XCTUnwrap(domain)), "the file swapped") {
            XCTAssertEqual(($0 as? StoreFiles.Unsafe)?.reason, reason)
        }
        XCTAssertEqual(stores.stated().states["example-files"], .unsafe)

        let folder = file.deletingLastPathComponent()
        try FileManager.default.removeItem(at: folder)
        try DomainFixtures.write(#"{"synthetic":2}"#, to: file)
        let (_, again) = try fileDomain("folder")
        try FileManager.default.removeItem(at: folder)
        try FileManager.default.createSymbolicLink(at: folder, withDestinationURL: ssh)
        XCTAssertThrowsError(try seal(try XCTUnwrap(again)), "its folder swapped") {
            XCTAssertEqual(($0 as? StoreFiles.Unsafe)?.reason, reason)
        }
    }

    func testTheHomesRootIsNeverReadWhereverThePointerNamesIt() throws {
        let homeRoot = home.appendingPathComponent("lifestream-home", isDirectory: true)
        try DomainFixtures.write("synthetic home", to: homeRoot.appendingPathComponent("home.db"))
        let file = StoreFixtures.url("\(Self.files)/history.json", home: home)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: homeRoot.appendingPathComponent("home.db"))
        let pointer = Pointer()
        let (stores, before) = try fileDomain("pointer", lifestream: { pointer.folders })
        XCTAssertNotNil(before, "no home is named yet")
        pointer.folders = [homeRoot]
        XCTAssertNil(stores.domain(for: "example-files:local:\(Self.unit)"))
        XCTAssertEqual(stores.stated().states["example-files"], .unsafe)
        XCTAssertEqual(stores.faults(of: "example-files"),
                       ["\(Self.files)/history.json lies under Lifestream's own folder, which is never read"])
    }

    private final class Pointer: @unchecked Sendable {
        private let lock = NSLock()
        private var held: [URL] = []
        var folders: [URL] {
            get { lock.withLock { held } }
            set { lock.withLock { held = newValue } }
        }
    }


    private static let secret = "synthetic secret"

    private static func swap(_ file: URL, for target: URL) {
        try? FileManager.default.removeItem(at: file)
        try? FileManager.default.createSymbolicLink(at: file, withDestinationURL: target)
    }

    private func assertRefused(_ what: String, _ seal: () throws -> [SealedBundle], file: StaticString = #filePath, line: UInt = #line) {
        do {
            let sealed = try seal()
            XCTFail("\(what): \(sealed.count) bundle(s) sealed", file: file, line: line)
            for bundle in sealed {
                let bytes = (try? Data(contentsOf: bundle.file)) ?? Data()
                XCTAssertNil(bytes.range(of: Data(Self.secret.utf8)), "\(what): the secret is sealed", file: file, line: line)
            }
        } catch {
            XCTAssertEqual((error as? StoreFiles.Unsafe)?.reason, "a file the store names is a link, which is never opened",
                           "\(what): \(error)", file: file, line: line)
        }
    }

    private func request() throws -> SealRequest {
        SealRequest(fetchedAt: try DomainFixtures.instant("2026-09-23T04:00:00.000Z"),
                    workDirectory: try DomainFixtures.directory(root.appendingPathComponent("work-\(UUID().uuidString)")), scratch: try DomainFixtures.directory(root.appendingPathComponent("work-\(UUID().uuidString)")),
                    custody: SealCustody(pass: ShippingFixture.pass, received: 0, imported: 0, history: true))
    }

    private static func namingStore() -> [String: Any] {
        ["feeder": "example-files-mac", "name": "example_files", "held": "\(files)/history.json", "account": "local",
         "engine": ["kind": "file", "files": [["member": "history.json", "path": "\(files)/history.json"]],
                    "names": ["from": "history.json", "at": "items.[]", "root": files, "index": "files.json"]]]
    }

    func testAnAttachmentSwappedAfterItsCheckIsRefused() throws {
        let secret = try DomainFixtures.write(Self.secret, to: home.appendingPathComponent(".ssh/recording"))
        try DomainFixtures.write(#"{"items":["recordings/a.txt"]}"#, to: StoreFixtures.url("\(Self.files)/history.json", home: home))
        try DomainFixtures.write("synthetic recording", to: StoreFixtures.url("\(Self.files)/recordings/a.txt", home: home))
        let store = try Self.store(Self.namingStore())
        guard case .file(let members, let names) = store.engine else { return XCTFail("a file store") }
        let road = StoreFiles(home: home, lifestream: [])
        let engine = try FileEngine(sourceId: "example-files:local:\(Self.unit)", store: store, files: members, names: names, account: "local",
                                    road: road, hashCache: root.appendingPathComponent("hashes.json"),
                                    ledgers: Ledgers(root: state.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain))) { locator, under in
            let found = road.named(locator, under: under)
            if let found { Self.swap(found, for: secret) }
            return found
        }
        assertRefused("the attachment") { try engine.seal(try request()) }
    }

    private func exampleStores() throws -> [Differences.Store] {
        guard case .sqlite(let declared) = try Self.store(Self.example()).engine else {
            throw StoreFixtures.StoreFixtureError.noMember("example", "sqlite")
        }
        return try SqliteEngine.differences(of: declared[0], folder: nil, files: StoreFiles(home: home, lifestream: []))
    }

    private func seal(_ stores: [Differences.Store]) throws -> [SealedBundle] {
        var cache = HashCache(file: root.appendingPathComponent("hashes-\(UUID().uuidString).json"), files: DeviceFiles(.plain))
        return try Differences.seal(try request(), sourceId: "example-store:local:\(Self.unit)", feeder: "example-store-mac",
                                    memory: try DomainFixtures.directory(root.appendingPathComponent("memory-\(UUID().uuidString)")),
                                    stores: stores, files: DeviceFiles(.plain), cache: &cache, report: { _ in }).bundles
    }

    func testABlobSwappedAfterItsCheckIsRefused() throws {
        try layExample()
        let secret = try DomainFixtures.write(Self.secret, to: home.appendingPathComponent(".ssh/attachment"))
        var stores = try exampleStores()
        let found = stores[0].named
        stores[0].named = { locator, under in
            let file = found(locator, under)
            if let file { Self.swap(file, for: secret) }
            return file
        }
        assertRefused("the blob") { try seal(stores) }
    }

    func testASQLiteFileSwappedAfterItsCheckIsRefused() throws {
        let secret = home.appendingPathComponent(".ssh/store.db")
        try FileManager.default.createDirectory(at: secret.deletingLastPathComponent(), withIntermediateDirectories: true)
        try DomainFixtures.sqlite(secret, [
            "CREATE TABLE note (id INTEGER PRIMARY KEY, created INTEGER, body TEXT)",
            "CREATE TABLE attachment (id INTEGER PRIMARY KEY, note_id INTEGER, path TEXT)",
            "INSERT INTO note VALUES (1, 1790000000, '\(Self.secret)')",
        ])
        for inPlace in [false, true] {
            let database = try layExample()
            let writer = inPlace ? try DomainFixtures.openSqlite(database) : nil
            defer { writer.map { _ = sqlite3_close($0) } }
            if let writer {
                try DomainFixtures.run("PRAGMA journal_mode=WAL", on: writer)
                try DomainFixtures.run("PRAGMA wal_autocheckpoint=0", on: writer)
                try DomainFixtures.run("INSERT INTO note VALUES (3, 1790000120, 'synthetic three')", on: writer)
            }
            let stores = try exampleStores()
            Self.swap(database, for: secret)
            assertRefused(inPlace ? "the database read in place" : "the database's held copy") { try seal(stores) }
            try? FileManager.default.removeItem(at: database.deletingLastPathComponent())
        }
    }

    func testTheWallsHoldWhereTheOpenedFileLies() throws {
        let ssh = home.appendingPathComponent(".ssh", isDirectory: true)
        let secret = try DomainFixtures.write(Self.secret, to: ssh.appendingPathComponent("store.db"))
        let folder = StoreFixtures.url(Self.folder, home: home)
        let file = folder.appendingPathComponent("store.db")
        let underSSH = "a file the store names lies under ~/.ssh, which is never read"
        func linkFolder() throws {
            try? FileManager.default.removeItem(at: folder)
            try FileManager.default.createDirectory(at: folder.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.createSymbolicLink(at: folder, withDestinationURL: ssh)
        }
        try linkFolder()
        XCTAssertThrowsError(try StoreFiles(home: home, lifestream: []).open(file, spelled: nil), "the folder a link") {
            XCTAssertEqual(($0 as? StoreFiles.Unsafe)?.reason, underSSH)
        }

        let road = Self.racing(StoreFiles(home: home, lifestream: [])) { _ in
            try? FileManager.default.removeItem(at: folder)
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            _ = Darwin.link(secret.path, file.path)
        }
        try linkFolder()
        XCTAssertThrowsError(try road.open(file), "the folder put back, a second name for the file opened") {
            XCTAssertEqual(($0 as? StoreFiles.Unsafe)?.reason, "a file the store names has more than one name, which is never opened")
        }

        try FileManager.default.removeItem(at: folder)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let permittedName = try DomainFixtures.write("synthetic", to: folder.appendingPathComponent("named-twice.db"))
        XCTAssertEqual(Darwin.link(permittedName.path, folder.appendingPathComponent("named-again.db").path), 0)
        XCTAssertThrowsError(try StoreFiles(home: home, lifestream: []).open(permittedName, spelled: nil), "a file of two names, both permitted") {
            XCTAssertEqual(($0 as? StoreFiles.Unsafe)?.reason, "a file the store names has more than one name, which is never opened")
        }

        try FileManager.default.removeItem(at: folder)
        let permitted = try DomainFixtures.write("synthetic", to: folder.appendingPathComponent("permitted.db"))
        try FileManager.default.createSymbolicLink(at: file, withDestinationURL: permitted)
        XCTAssertThrowsError(try StoreFiles(home: home, lifestream: []).open(file, spelled: nil), "the file a link") {
            XCTAssertEqual(($0 as? StoreFiles.Unsafe)?.reason, "a file the store names is a link, which is never opened")
        }
        XCTAssertNotNil(try StoreFiles(home: home, lifestream: []).open(permitted, spelled: nil), "the file it leads to opens")
    }

    func testALogItsWriterRemovesMidRunLeavesTheStoreReadable() throws {
        let database = try layExample()
        let writer = Writer(try DomainFixtures.openSqlite(database))
        defer { writer.close() }
        try writer.run("PRAGMA journal_mode=WAL", "PRAGMA wal_autocheckpoint=0", "INSERT INTO note VALUES (3, 1790000120, 'synthetic three')")
        XCTAssertTrue(FileManager.default.fileExists(atPath: database.path + "-wal"))

        var stores = try exampleStores()
        stores[0].opener = Self.racing(StoreFiles(home: home, lifestream: [])) { url in
            guard url.path.hasSuffix("-wal"), !writer.closed else { return }
            writer.close()
            for suffix in ["-wal", "-shm"] { try? FileManager.default.removeItem(atPath: database.path + suffix) }
        }
        do { _ = try seal(stores) } catch {
            XCTAssertFalse(error is StoreFiles.Unsafe, "a log its writer removed is refused as a wall's refusal: \(error)")
        }
        XCTAssertTrue(writer.closed, "the writer closed while the seal read")
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.path + "-wal"))

        let next = try seal(try exampleStores())
        let notes = try next.flatMap { try DomainFixtures.keys(in: try DomainFixtures.extract("store.sqlite", of: $0))["note"] ?? [] }
        XCTAssertEqual(notes.sorted(), [1, 2, 3])
    }

    private static func racing(_ road: StoreFiles, _ race: @escaping @Sendable (URL) -> Void) -> FileOpener {
        FileOpener { url in
            guard let opened = try StoreFiles.opening(url, spelled: nil) else { return nil }
            race(url)
            return try road.held(opened, spelled: nil)
        }
    }

    private final class Writer: @unchecked Sendable {
        private let lock = NSLock()
        private var handle: OpaquePointer?
        init(_ handle: OpaquePointer) { self.handle = handle }
        var closed: Bool { lock.withLock { handle == nil } }
        func run(_ statements: String...) throws {
            try lock.withLock { for each in statements { try DomainFixtures.run(each, on: handle!) } }
        }
        func close() {
            lock.withLock {
                if let handle { sqlite3_close(handle) }
                handle = nil
            }
        }
    }

    func testASessionLogSwappedAfterItsCheckIsRefused() throws {
        let secret = try DomainFixtures.write(#"{"entrypoint":"cli","said":"\#(Self.secret)"}"# + "\n",
                                              to: home.appendingPathComponent(".ssh/session.jsonl"))
        let log = home.appendingPathComponent(".claude/projects/-example/00000000-0000-4000-8000-000000000001.jsonl")
        try DomainFixtures.write(#"{"entrypoint":"cli","said":"synthetic first line, longer than the secret's"}"# + "\n"
                                 + #"{"said":"synthetic second line"}"# + "\n", to: log)
        let engine = try StoreFixtures.logs("claude-code:local:\(Self.unit)", home: home, stateFile: state.appendingPathComponent("sessions.json"),
                                            ledgers: Ledgers(root: state.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain)))
        assertRefused("the session log") {
            try engine.shipper.seal(try request(), listedAt: Date(), list: { known, askFrom in
                let logs = try engine.logs(known: known, askFrom: askFrom)
                for each in logs { Self.swap(each.url, for: secret) }
                return logs
            }, starter: engine.starter)
        }
    }


    func testTheRoadSaysWhyAFileDidNotOpen() throws {
        let road = StoreFiles(home: home, lifestream: [])
        let file = try DomainFixtures.write("synthetic", to: home.appendingPathComponent("Library/Example/locked.txt"))
        XCTAssertEqual(chmod(file.path, 0), 0)
        defer { chmod(file.path, 0o644) }
        XCTAssertThrowsError(try road.open(file, spelled: nil)) { XCTAssertEqual($0 as? FileOpenerError, .unreadable(EACCES)) }
        XCTAssertNil(try road.open(home.appendingPathComponent("Library/Example/gone.txt"), spelled: nil))
        XCTAssertNil(try road.open(home.appendingPathComponent("Library/Example/gone/a.txt"), spelled: nil))
        let link = home.appendingPathComponent("Library/Example/link.txt")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
        XCTAssertThrowsError(try road.open(link, spelled: nil)) {
            XCTAssertEqual(($0 as? StoreFiles.Unsafe)?.reason, "a file the store names is a link, which is never opened")
        }
    }

    private var attachment: URL { StoreFixtures.url("\(Self.folder)/files/a.txt", home: home) }

    private func opening(_ before: @escaping @Sendable (Int) -> Void) -> FileOpener {
        let road = StoreFiles(home: home, lifestream: []), opens = Counter()
        return FileOpener { url in
            if url.lastPathComponent == "a.txt" { before(opens.next()) }
            return try road.open(url, spelled: nil)
        }
    }

    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        func next() -> Int { lock.withLock { defer { count += 1 }; return count } }
    }

    private final class Source {
        let memory: URL, cache: URL, work: URL
        var seal = 0
        init(_ root: URL) throws {
            memory = try DomainFixtures.directory(root.appendingPathComponent("memory-\(UUID().uuidString)"))
            cache = root.appendingPathComponent("hashes-\(UUID().uuidString).json")
            work = root
        }
        func seal(_ stores: [Differences.Store], at minutes: Double = 0) throws -> [SealedBundle] {
            seal += 1
            var cache = HashCache(file: cache, files: DeviceFiles(.plain))
            defer { try? cache.save() }
            let request = SealRequest(fetchedAt: try DomainFixtures.instant("2026-09-23T04:00:00.000Z").addingTimeInterval(minutes * 60),
                                      workDirectory: try DomainFixtures.directory(work.appendingPathComponent("work-\(UUID().uuidString)")), scratch: try DomainFixtures.directory(work.appendingPathComponent("work-\(UUID().uuidString)")),
                                      custody: SealCustody(pass: ShippingFixture.pass, received: seal - 1, imported: seal - 1, history: true),
                                      owesThrough: true)
            return try Differences.seal(request, sourceId: "example-store:local:\(StoreSafetyTests.unit)", feeder: "example-store-mac",
                                        memory: memory, stores: stores, files: DeviceFiles(.plain), cache: &cache, report: { _ in }).bundles
        }
    }

    private func held(_ bundles: [SealedBundle]) throws -> (notes: [Int], attachments: [Int], index: [String], blobs: [String]) {
        let bundle = try XCTUnwrap(bundles.first, "a bundle is sealed")
        XCTAssertEqual(bundles.count, 1)
        let keys = try DomainFixtures.keys(in: try DomainFixtures.extract("store.sqlite", of: bundle))
        let reader = try StoredZipReader(bundle.file)
        let index = try JSONSerialization.jsonObject(with: try XCTUnwrap(reader.bytes("files"))) as? [String: Any]
        return ((keys["note"] ?? []).sorted(), (keys["attachment"] ?? []).sorted(),
                ((index?["entries"] as? [String: Any]) ?? [:]).keys.sorted(),
                reader.names.filter { $0.hasPrefix("blobs/") }.map { String($0.dropFirst("blobs/".count)) })
    }

    func testAFileThatDoesNotOpenNowLeavesTheRestShipping() throws {
        try layExample()
        let source = try Source(root)
        XCTAssertEqual(chmod(attachment.path, 0), 0)
        let first = try held(try source.seal(try exampleStores()))
        XCTAssertEqual(first.notes, [1, 2])
        XCTAssertEqual(first.attachments, [1])
        XCTAssertEqual(first.index, [])
        XCTAssertEqual(first.blobs, [])

        XCTAssertEqual(chmod(attachment.path, 0o644), 0)
        let next = try held(try source.seal(try exampleStores(), at: 5))
        XCTAssertEqual(next.attachments, [1], "the row whose file was left out ships again")
        XCTAssertEqual(next.index, ["files/a.txt"])
        XCTAssertEqual(next.blobs, [DomainFixtures.sha256("synthetic attachment")])
    }

    func testAFileThatVanishesLeavesTheRestShipping() throws {
        try layExample()
        let source = try Source(root)
        var stores = try exampleStores()
        let file = attachment
        stores[0].opener = opening { _ in try? FileManager.default.removeItem(at: file) }
        let first = try held(try source.seal(stores))
        XCTAssertEqual(first.notes, [1, 2])
        XCTAssertEqual(first.index, [])

        try DomainFixtures.write("synthetic attachment", to: attachment)
        let next = try held(try source.seal(try exampleStores(), at: 5))
        XCTAssertEqual(next.index, ["files/a.txt"])
        XCTAssertEqual(next.blobs, [DomainFixtures.sha256("synthetic attachment")])
    }

    func testAFileSwappedBeforeItIsCarriedLeavesTheRestShipping() throws {
        try layExample()
        let source = try Source(root)
        var stores = try exampleStores()
        let file = attachment, scratch = root.appendingPathComponent("replacement.txt")
        stores[0].opener = opening { count in
            guard count == 1 else { return }
            try? "synthetic replacement".write(to: scratch, atomically: false, encoding: .utf8)
            _ = rename(scratch.path, file.path)
        }
        let first = try held(try source.seal(stores))
        XCTAssertEqual(first.notes, [1, 2])
        XCTAssertEqual(first.attachments, [1])
        XCTAssertEqual(first.index, [])
        XCTAssertEqual(first.blobs, [])

        let next = try held(try source.seal(try exampleStores(), at: 5))
        XCTAssertEqual(next.index, ["files/a.txt"])
        XCTAssertEqual(next.blobs, [DomainFixtures.sha256("synthetic replacement")])
    }

    func testAFileSwappedForALinkBeforeItIsCarriedIsRefused() throws {
        try layExample()
        let secret = try DomainFixtures.write(Self.secret, to: home.appendingPathComponent(".ssh/attachment"))
        var stores = try exampleStores()
        let file = attachment
        stores[0].opener = opening { count in if count == 1 { Self.swap(file, for: secret) } }
        assertRefused("the blob at its copy") { try seal(stores) }
    }

    func testAFileThatKeepsFailingIsTheSourcesFailure() throws {
        try layExample()
        let ledgers = Ledgers(root: state.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain))
        let source = "example-store:local:\(Self.unit)"
        let domain = DifferencesDomain(sourceId: source, name: "example_store", feeder: "example-store-mac", ledgers: ledgers,
                                       hashCache: root.appendingPathComponent("hashes.json"), report: { _ in }) { [self] in try exampleStores() }
        var seal = 0
        func sealed(at minutes: Double) throws -> [SealedBundle] {
            seal += 1
            return try domain.seal(SealRequest(
                fetchedAt: try DomainFixtures.instant("2026-09-23T04:00:00.000Z").addingTimeInterval(minutes * 60),
                workDirectory: try DomainFixtures.directory(root.appendingPathComponent("work-\(UUID().uuidString)")), scratch: try DomainFixtures.directory(root.appendingPathComponent("work-\(UUID().uuidString)")),
                custody: SealCustody(pass: ShippingFixture.pass, received: seal - 1, imported: seal - 1, history: true), owesThrough: true))
        }
        XCTAssertEqual(chmod(attachment.path, 0), 0)
        XCTAssertFalse(try sealed(at: 0).isEmpty, "the notes ship")
        XCTAssertNil(domain.unread)
        _ = try sealed(at: 30)
        XCTAssertNil(domain.unread, "failing for half an hour")
        _ = try sealed(at: 60)
        let unread = try XCTUnwrap(domain.unread, "failing for an hour")
        XCTAssertEqual(unread.code, "LOCAL_ACCESS")
        XCTAssertEqual(unread.message, "1 file the store names could not be read for over an hour, left out while the rest ships: "
                                       + "a file cannot be opened: Permission denied (a.txt)")

        XCTAssertEqual(chmod(attachment.path, 0o644), 0)
        let carried = try held(try sealed(at: 65))
        XCTAssertEqual(carried.blobs, [DomainFixtures.sha256("synthetic attachment")])
        XCTAssertNil(domain.unread)
    }

    func testAFileEnginesNamedFileThatDoesNotOpenLeavesTheMembersShipping() throws {
        try DomainFixtures.write(#"{"items":["recordings/a.txt"]}"#, to: StoreFixtures.url("\(Self.files)/history.json", home: home))
        let recording = try DomainFixtures.write("synthetic recording", to: StoreFixtures.url("\(Self.files)/recordings/a.txt", home: home))
        let store = try Self.store(Self.namingStore())
        guard case .file(let members, let names) = store.engine else { return XCTFail("a file store") }
        let engine = try FileEngine(sourceId: "example-files:local:\(Self.unit)", store: store, files: members, names: names, account: "local",
                                    road: StoreFiles(home: home, lifestream: []), hashCache: root.appendingPathComponent("hashes.json"),
                                    ledgers: Ledgers(root: state.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain)))
        XCTAssertEqual(chmod(recording.path, 0), 0)
        defer { chmod(recording.path, 0o644) }
        let sealed = try XCTUnwrap(try engine.seal(try request()).first)
        let reader = try StoredZipReader(sealed.file)
        XCTAssertEqual(reader.text("history.json"), #"{"items":["recordings/a.txt"]}"#)
        let index = try JSONSerialization.jsonObject(with: try XCTUnwrap(reader.bytes("files.json"))) as? [String: Any]
        XCTAssertEqual((index?["entries"] as? [String: Any])?.count, 0)
        XCTAssertFalse(reader.names.contains { $0.hasPrefix("blobs/") })
        XCTAssertNil(engine.unread)
    }

    private func carrying(_ carry: @escaping @Sendable (URL) throws -> OpenedFile?) -> FileOpener {
        let road = StoreFiles(home: home, lifestream: []), opens = Counter()
        return FileOpener { url in
            guard url.lastPathComponent == "a.txt", opens.next() == 1 else { return try road.open(url, spelled: nil) }
            return try carry(url)
        }
    }

    func testAFileWhoseReadFailsAtItsCopyLeavesTheRestShipping() throws {
        try layExample()
        var stores = try exampleStores()
        stores[0].opener = carrying { url in OpenedFile(url: url, descriptor: Darwin.open(url.path, O_WRONLY | O_CLOEXEC)) }
        let sealed = try held(try Source(root).seal(stores))
        XCTAssertEqual(sealed.notes, [1, 2])
        XCTAssertEqual(sealed.attachments, [1])
        XCTAssertEqual(sealed.index, [])
        XCTAssertEqual(sealed.blobs, [])
    }

    func testAFileThatNeverCarriesIsTheSourcesFailure() throws {
        try layExample()
        let ledgers = Ledgers(root: state.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain))
        let domain = DifferencesDomain(sourceId: "example-store:local:\(Self.unit)", name: "example_store", feeder: "example-store-mac",
                                       ledgers: ledgers, hashCache: root.appendingPathComponent("hashes.json"), report: { _ in }) { [self] in
            var stores = try exampleStores()
            stores[0].opener = carrying { _ in throw FileOpenerError.unreadable(EPERM) }
            return stores
        }
        var seal = 0
        for minutes in [0.0, 30, 60] {
            seal += 1
            let bundles = try domain.seal(SealRequest(
                fetchedAt: try DomainFixtures.instant("2026-09-23T04:00:00.000Z").addingTimeInterval(minutes * 60),
                workDirectory: try DomainFixtures.directory(root.appendingPathComponent("work-\(UUID().uuidString)")), scratch: try DomainFixtures.directory(root.appendingPathComponent("work-\(UUID().uuidString)")),
                custody: SealCustody(pass: ShippingFixture.pass, received: seal - 1, imported: seal - 1, history: true), owesThrough: true))
            XCTAssertEqual(try held(bundles).blobs, [], "at \(minutes) minutes")
        }
        XCTAssertEqual(domain.unread?.message, "1 file the store names could not be read for over an hour, left out while the rest ships: "
                                               + "a file cannot be opened: Operation not permitted (a.txt)")
    }

    func testAFileLeftOutOfARowPulledInUnchangedShipsLater() throws {
        let database = try layExample()
        let source = try Source(root)
        XCTAssertEqual(try held(try source.seal(try exampleStores())).blobs, [DomainFixtures.sha256("synthetic attachment")])

        try DomainFixtures.write("synthetic attachmenx", to: attachment)
        try DomainFixtures.sqlite(database, ["UPDATE note SET body = 'synthetic two, edited' WHERE id = 2"])
        var stores = try exampleStores()
        stores[0].opener = carrying { _ in throw FileOpenerError.unreadable(EPERM) }
        let left = try held(try source.seal(stores, at: 5))
        XCTAssertEqual(left.attachments, [1], "pulled in by its note")
        XCTAssertEqual(left.blobs, [])

        let next = try held(try source.seal(try exampleStores(), at: 10))
        XCTAssertEqual(next.attachments, [1])
        XCTAssertEqual(next.blobs, [DomainFixtures.sha256("synthetic attachmenx")])
    }

    func testAFileARolledBackBundleCarriedShipsAgain() throws {
        let database = try layExample()
        try FileManager.default.removeItem(at: attachment)
        let source = try Source(root)
        XCTAssertEqual(try held(try source.seal(try exampleStores())).blobs, [])

        try DomainFixtures.sqlite(database, ["UPDATE note SET body = 'synthetic two, edited' WHERE id = 2"])
        var stores = try exampleStores()
        let found = stores[0].named, file = attachment
        stores[0].named = { locator, under in
            if !FileManager.default.fileExists(atPath: file.path) { _ = try? DomainFixtures.write("synthetic attachment", to: file) }
            return found(locator, under)
        }
        XCTAssertEqual(try held(try source.seal(stores, at: 5)).blobs, [DomainFixtures.sha256("synthetic attachment")])
        let memory = source.memory.appendingPathComponent("memory-store.sqlite")
        XCTAssertEqual(try DomainFixtures.read("SELECT seal, files FROM rows WHERE tbl = 'attachment' AND key = 1", from: memory),
                       [["2", "[20]"]], "the file it states is the seal's that carried it")

        source.seal = 1
        let again = try held(try source.seal(try exampleStores(), at: 10))
        XCTAssertEqual(again.attachments, [1])
        XCTAssertEqual(again.blobs, [DomainFixtures.sha256("synthetic attachment")])
    }

    func testAHistoryPagesLinkIsTheStoresRefusal() throws {
        let database = try layExample()
        try DomainFixtures.sqlite(database, ["INSERT INTO note VALUES (3, 1780000000, 'synthetic old')",
                                             "INSERT INTO attachment VALUES (2, 3, 'files/old.txt')"])
        let old = try DomainFixtures.write("synthetic old attachment", to: database.deletingLastPathComponent().appendingPathComponent("files/old.txt"))
        let secret = try DomainFixtures.write(Self.secret, to: home.appendingPathComponent(".ssh/attachment"))
        var stores = try exampleStores()
        let found = stores[0].named
        stores[0].named = { locator, under in
            let file = found(locator, under)
            if locator == "files/old.txt", file != nil { Self.swap(old, for: secret) }
            return file
        }
        assertRefused("the history page's file") { try seal(stores) }
    }


    func testAStoreSpellsAndFindsItsSourceByItsProduct() throws {
        try layExample()
        let plist = "~/Library/Preferences/com.example.store.plist"
        try DomainFixtures.write(#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Own</key><string>15550000001</string></dict></plist>"#,
                                 to: StoreFixtures.url(plist, home: home))
        let stores = try shipper()
        try stores.take(["example-importer": try Self.declared(Self.example(plist: plist), product: "example-notes")])
        try stores.answer(.allowed, to: try XCTUnwrap(stores.asking("example-importer")))
        let offered = stores.offers(unit: Self.unit)
        XCTAssertEqual(offered.count, 1, "\(offered)")
        let source = try XCTUnwrap(offered.first)
        XCTAssertTrue(source.hasPrefix("example-notes:") && source.hasSuffix(":\(Self.unit)"), source)
        XCTAssertEqual(try XCTUnwrap(stores.domain(for: source)).sourceId, source)
        XCTAssertNil(stores.domain(for: "example-importer" + source.dropFirst("example-notes".count)), "no source is named by the connector's id")
        XCTAssertEqual(stores.stated().states.keys.sorted(), ["example-importer"], "its state is the connector's")
    }


    func testAStoreIsFoundByItsAppAndWaitsOnItsGrant() throws {
        let applications = home.appendingPathComponent("Applications", isDirectory: true)
        let chat = StoreFixtures.url("~/Library/Messages/chat.db", home: home)
        try DomainFixtures.write("synthetic", to: chat)
        func shipper(fullDiskAccess: Bool) throws -> DeclaredStores {
            try StoreFixtures.stores(home: home, state: state, applications: [applications], fullDiskAccess: fullDiskAccess)
        }
        var stores = try shipper(fullDiskAccess: false)
        XCTAssertFalse(stores.found().contains("imessage"), "its files alone do not find an app's store")
        XCTAssertTrue(stores.found().contains("screen-time"), "macOS's own, behind the grant: always found")
        XCTAssertFalse(stores.held("imessage"), "not looked at before Full Disk Access")
        XCTAssertTrue(stores.waitsOnFullDiskAccess("imessage:local:\(Self.unit)"))
        XCTAssertFalse(stores.waitsOnFullDiskAccess("chrome:default:\(Self.unit)"))
        try FileManager.default.createDirectory(at: applications.appendingPathComponent("Messages.app"), withIntermediateDirectories: true)
        XCTAssertTrue(stores.found().contains("imessage"), "found by its app")
        stores = try shipper(fullDiskAccess: true)
        XCTAssertTrue(stores.held("imessage"), "held once the grant is given")
        var bare = try StoreFixtures.all()
        bare["imessage"] = HomeLink.DeclaredStore(app: "Messages", grants: [], product: "imessage", store: bare["imessage"]!.store)
        stores = try StoreFixtures.stores(home: home, state: state, applications: [applications], fullDiskAccess: false,
                                          known: try StoreFixtures.known(), declarations: bare)
        XCTAssertEqual(stores.stated().states["imessage"], .asked, "a changed block is no store the release carries")
    }


    func testEachPathWallRefusesByName() throws {
        let cases: [(String, [String: Any], String)] = [
            ("~/.ssh", Self.example(held: "~/.ssh/id_synthetic"), "mac.store.held: ~/.ssh/id_synthetic lies under ~/.ssh, which is never read"),
            ("~/Library/Keychains", Self.example(paths: ["~/Library/Keychains/login.keychain-db"]),
             "mac.store.engine.stores[1].path: ~/Library/Keychains/login.keychain-db lies under ~/Library/Keychains, which is never read"),
            ("a .. part", Self.example(paths: ["~/Library/Application Support/Example Store/../../Keychains/x.db"]),
             "mac.store.engine.stores[1].path: ~/Library/Application Support/Example Store/../../Keychains/x.db holds a .. part"),
            ("<account> the rule does not fill", Self.example(paths: ["~/Library/Example/<account>/x.db"]),
             "mac.store.engine.stores[1].path: ~/Library/Example/<account>/x.db: its account rule (local) fills no <account>"),
            ("<account> in a plist rule's file", Self.example(plist: "~/Library/Preferences/<account>/com.example.plist"),
             "mac.store.account.plist: ~/Library/Preferences/<account>/com.example.plist: the account rule reads it, so it cannot hold <account>"),
            ("<account> under a plist rule", Self.example(plist: "~/Library/Preferences/com.example.plist", held: "~/Library/Example/<account>/store.db"),
             "mac.store.held: ~/Library/Example/<account>/store.db: its account rule (plist) fills no <account>"),
        ]
        for (what, declared, fault) in cases {
            let store = try Self.store(declared)
            XCTAssertTrue(StoreFiles.faults(of: store).contains(fault), "\(what): \(StoreFiles.faults(of: store))")
            let stores = try shipper()
            try stores.take(["example-store": HomeLink.DeclaredStore(app: nil, grants: [], product: "example-store", store: store)])
            XCTAssertEqual(stores.stated().states["example-store"], .unsafe, what)
            XCTAssertNil(stores.asking("example-store"), "\(what): an unsafe store is not offered to the person")
            XCTAssertNil(stores.domain(for: "example-store:local:\(Self.unit)"), what)
        }

        var widened = Self.example()
        var engine = try XCTUnwrap(widened["engine"] as? [String: Any])
        var stores = try XCTUnwrap(engine["stores"] as? [[String: Any]])
        stores[0]["path"] = Self.folder
        stores[0]["member"] = "<name>"
        stores[0]["match"] = ".*"
        engine["stores"] = stores
        widened["engine"] = engine
        let faults = StoreFiles.faults(of: try Self.store(widened))
        XCTAssertTrue(faults.contains("mac.store.engine.stores[0].match: matches Cookies, a file never read"), "\(faults)")

        let road = StoreFiles(home: home, lifestream: [])
        XCTAssertThrowsError(try road.path("~/Example/<account>/x.db", account: "..")) {
            XCTAssertEqual(($0 as? StoreFiles.Unsafe)?.reason, "~/Example/<account>/x.db: <account> is filled with no one folder's name")
        }
        XCTAssertThrowsError(try road.path("~/Example/<account>/x.db", account: "1Password")) {
            XCTAssertEqual(($0 as? StoreFiles.Unsafe)?.reason, "~/Example/1Password/x.db passes 1password, a password manager's, which is never read")
        }
        XCTAssertNotNil(StoreFiles.pathFault("~/Library/<account>/x.db", unfilled: nil, descends: false))
        XCTAssertNoThrow(try road.path("~/Library/Example/x.db"))
    }

    func testALinkOutOfTheHomeFolderIsRefusedAtUse() throws {
        let outside = root.appendingPathComponent("outside", isDirectory: true)
        try DomainFixtures.write("synthetic", to: outside.appendingPathComponent("store.db"))
        let folder = StoreFixtures.url(Self.folder, home: home)
        try FileManager.default.createDirectory(at: folder.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: folder, withDestinationURL: outside)
        let road = StoreFiles(home: home, lifestream: [])
        XCTAssertThrowsError(try road.path("\(Self.folder)/store.db")) {
            XCTAssertEqual(($0 as? StoreFiles.Unsafe)?.reason, "\(Self.folder)/store.db lies outside the home folder")
        }
        try FileManager.default.removeItem(at: folder)
        let ssh = home.appendingPathComponent(".ssh", isDirectory: true)
        try DomainFixtures.write("synthetic", to: ssh.appendingPathComponent("store.db"))
        try FileManager.default.createSymbolicLink(at: folder, withDestinationURL: ssh)
        XCTAssertThrowsError(try road.path("\(Self.folder)/store.db")) {
            XCTAssertEqual(($0 as? StoreFiles.Unsafe)?.reason, "\(Self.folder)/store.db lies under ~/.ssh, which is never read")
        }
        let own = StoreFiles(home: home, lifestream: [StoreFixtures.url("~/lifestream-home", home: home)])
        XCTAssertThrowsError(try own.path("~/lifestream-home/home.db")) {
            XCTAssertEqual(($0 as? StoreFiles.Unsafe)?.reason, "~/lifestream-home/home.db lies under Lifestream's own folder, which is never read")
        }

        try FileManager.default.removeItem(at: folder)
        try FileManager.default.createSymbolicLink(at: folder, withDestinationURL: outside)
        let stores = try shipper()
        try stores.take(["example-store": try Self.declared(Self.example())])
        try stores.answer(.allowed, to: try XCTUnwrap(stores.asking("example-store")))
        let domain = try XCTUnwrap(stores.domain(for: "example-store:local:\(Self.unit)"))
        XCTAssertThrowsError(try seal(domain))
        XCTAssertEqual(stores.stated().states["example-store"], .unsafe)
        XCTAssertNil(stores.domain(for: "example-store:local:\(Self.unit)"))
    }

    func testTheNeverReadListIsTheHomes() throws {
        let admit = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("packages/connect/admit.ts")
        let text = try String(contentsOf: admit, encoding: .utf8)
        let start = try XCTUnwrap(text.range(of: "export const NEVER_READ = {"))
        let end = try XCTUnwrap(text.range(of: "} as const;", range: start.upperBound..<text.endIndex))
        let block = String(text[start.upperBound..<end.lowerBound])
        func list(_ name: String) throws -> [String] {
            let opened = try XCTUnwrap(block.range(of: "\(name): ["), name)
            let closed = try XCTUnwrap(block.range(of: "]", range: opened.upperBound..<block.endIndex), name)
            let body = String(block[opened.upperBound..<closed.lowerBound])
            let quoted = try NSRegularExpression(pattern: "\"((?:[^\"\\\\]|\\\\.)*)\"")
            return quoted.matches(in: body, range: NSRange(body.startIndex..., in: body)).map { String(body[Range($0.range(at: 1), in: body)!]) }
        }
        XCTAssertEqual(try list("folders"), StoreFiles.NeverRead.folders)
        XCTAssertEqual(try list("names"), StoreFiles.NeverRead.names)
        XCTAssertEqual(try list("endings"), StoreFiles.NeverRead.endings)
        XCTAssertEqual(try list("managers"), StoreFiles.NeverRead.managers)
    }


    func testTheSQLWallRefusesByName() throws {
        let database = try layExample()
        let statements: [(String, String)] = [
            ("ATTACH DATABASE 'file:synthetic?mode=memory' AS other", "the statement: an attach is refused"),
            ("PRAGMA writable_schema = 1", "the statement: a pragma is refused"),
            ("DELETE FROM source.note", "the statement: a write is refused"),
            ("INSERT INTO source.note (id) VALUES (3)", "the statement: a write is refused"),
            ("CREATE TABLE source.other (id)", "the statement: a write is refused"),
            ("SELECT id FROM note; SELECT 2", "the statement: a second statement is refused"),
            ("SELECT random() FROM note", "the statement: the function random is refused"),
            ("SELECT sql FROM source.sqlite_master", "the statement: a read of sqlite_master the store does not hold is refused"),
        ]
        for (statement, reason) in statements {
            XCTAssertThrowsError(try StoreSQL.compile(statement, against: database), statement) {
                XCTAssertEqual(($0 as? StoreFiles.Unsafe)?.reason, reason, statement)
            }
        }
        XCTAssertNoThrow(try StoreSQL.compile("SELECT id FROM note WHERE id IN (SELECT t_key FROM temp.touched)", against: database))

        let fragments: [([String: Any], String)] = [
            (Self.example(keep: "id > 0; ATTACH DATABASE 'x' AS y"), "tables[0].keep: a second statement is refused"),
            (Self.example(keep: "id > 0 -- and nothing"), "tables[0].keep: a comment is refused"),
            (Self.example(keep: "id IN (SELECT cid FROM pragma_table_info('note'))"),
             "tables[0].keep: a read of pragma_table_info the store does not hold is refused"),
            (Self.example(touched: "SELECT name AS k FROM sqlite_master"), "tables[0].touched_by[0]: a read of sqlite_master the store does not hold is refused"),
        ]
        for (declared, reason) in fragments {
            guard case .sqlite(let stores) = try Self.store(declared).engine else { return XCTFail("a sqlite store") }
            XCTAssertThrowsError(try StoreSQL.check(stores[0], against: database), reason) {
                XCTAssertEqual(($0 as? StoreFiles.Unsafe)?.reason, reason)
            }
        }
        guard case .sqlite(let safe) = try Self.store(Self.example()).engine else { return XCTFail("a sqlite store") }
        XCTAssertNoThrow(try StoreSQL.check(safe[0], against: database))

        let stores = try shipper()
        try stores.take(["example-store": try Self.declared(Self.example(keep: "id IN (SELECT cid FROM pragma_table_info('note'))"))])
        try stores.answer(.allowed, to: try XCTUnwrap(stores.asking("example-store")))
        XCTAssertThrowsError(try seal(try XCTUnwrap(stores.domain(for: "example-store:local:\(Self.unit)"))))
        XCTAssertEqual(stores.stated().states["example-store"], .unsafe)
    }


    func testTheDigestIsTheHomes() throws {
        let all = try StoreFixtures.all()
        XCTAssertEqual(all.keys.sorted(), KnownStores.digests.keys.sorted(), "a fixture for every release store, and no other")
        for (id, declared) in all {
            XCTAssertEqual(declared.digest, KnownStores.digests[id], id)
        }
        let stores = try StoreFixtures.stores(home: home, state: state)
        XCTAssertEqual(stores.stated().digest, StoreDigest.of(all), "what the exchange states")
        let odd = #"{"s":"é \u0001\"/<","n":[1,1.5,-0,1e21,0.000001,1e-7,123456789012345680000],"z":{"b":1,"a":2,"é":3,"Z":4}}"#
        let value = try JSONSerialization.jsonObject(with: Data(odd.utf8))
        let text = StoreDigest.canonical(value)
        XCTAssertEqual("sha256:" + DomainFixtures.sha256(text), "sha256:aab15b42909c4f44847d350128cc1b7df5787d7cbeb0a844f5125e79c393abf5", text)
    }
}
