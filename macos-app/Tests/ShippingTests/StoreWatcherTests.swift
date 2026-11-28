import CoreServices
import DeviceFiles
import Foundation
import HomeLink
import XCTest
@testable import Shipping

final class StoreWatcherTests: XCTestCase {
    private static let unit = "macbook-pro-0001"
    private var root: URL!
    private var home: URL { root.appendingPathComponent("home", isDirectory: true) }
    private var state: URL { root.appendingPathComponent("state", isDirectory: true) }
    private var drop: URL { root.appendingPathComponent("drop", isDirectory: true) }

    override func setUpWithError() throws {
        let made = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("store-watcher-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
        root = URL(fileURLWithPath: StoreWatcher.real(made.path), isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private static let table: [String: Any] = ["key": "rowid", "name": "Item", "role": ["main": ["rows": "items", "time": "0"]]]

    private static func declared(_ product: String, held: String, engine: [String: Any]) throws -> HomeLink.DeclaredStore {
        let object: [String: Any] = ["grants": [String](), "product": product,
                                     "store": ["feeder": "\(product)-mac", "name": product.replacingOccurrences(of: "-", with: "_"),
                                               "held": held, "account": "local", "engine": engine]]
        return try JSONDecoder().decode(HomeLink.DeclaredStore.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private static func declarations() throws -> [String: HomeLink.DeclaredStore] {
        let sqlite = { (path: String, extra: [String: Any]) -> [String: Any] in
            ["kind": "sqlite", "stores": [["identity": "file", "member": "store.sqlite", "path": path, "tables": [table]].merging(extra) { $1 }]]
        }
        return [
            "apple-notes": try declared("apple-notes", held: "~/Library/Notes/store.sqlite",
                                        engine: sqlite("~/Library/Notes/store.sqlite", ["file_root": "~/Library/Notes/Media"])),
            "imessage": try declared("imessage", held: "~/Library/Chats/",
                                     engine: sqlite("~/Library/Chats", ["match": "^chat-[0-9]+\\.db$", "member": "chats/<name>"])),
            "aqua-voice": try declared("aqua-voice", held: "~/Library/Voice/history.json", engine: [
                "kind": "file", "files": [["path": "~/Library/Voice/history.json", "member": "history.json"]],
                "names": ["from": "history.json", "at": "items.[].file", "root": "~/Library/Voice/Audio", "index": "audio.json"]]),
            "claude-code": try declared("claude-code", held: "~/.agent/projects/", engine: [
                "kind": "logs", "roots": [["path": "~/.agent/projects", "depth": 1]],
                "match": "^[0-9a-f]{8}\\.jsonl$", "beside": "^[0-9a-f]{8}/meta\\.json$"]),
            "screen-time": try declared("screen-time", held: "~/Library/Biome/streams/restricted/App.InFocus/",
                                        engine: ["kind": "biome", "stream": "App.InFocus"]),
            "chrome": try declared("chrome", held: "~/Library/Browser/History", engine: sqlite("~/Library/Browser/History", [:])),
            "safari": try declared("safari", held: "~/Library/Safari/History.db", engine: sqlite("~/Library/Safari/History.db", [:])),
            "codex": try declared("codex", held: "~/.ssh/agent.sqlite", engine: sqlite("~/.ssh/agent.sqlite", [:])),
        ]
    }

    private static func source(_ product: String) -> String { "\(product):local:\(unit)" }

    private func stores() throws -> DeclaredStores {
        let declarations = try Self.declarations()
        let known = Set(["apple-notes", "imessage", "aqua-voice", "claude-code", "screen-time", "codex"].compactMap { declarations[$0]?.digest })
        let stores = try StoreFixtures.stores(home: home, state: state, known: known, declarations: declarations)
        try stores.answer(.refused, to: try XCTUnwrap(stores.asking("safari")))
        return stores
    }

    private var sources: [String] {
        ["apple-notes", "imessage", "aqua-voice", "claude-code", "screen-time", "chrome", "safari", "codex", "upload"].map(Self.source)
    }

    private func targets() throws -> [StoreWatcher.Target] {
        StoreWatcher.targets(sources: sources, stores: try stores(), uploadFolder: drop)
    }

    private func matched(_ path: String, _ targets: [StoreWatcher.Target]) -> Set<String> {
        StoreWatcher.match(path: home.path + "/" + path, flags: 0, targets: targets)
    }

    func testOnlyAllowedStoresAreWatchedNeverOneAskedRefusedUnsafeOrBiome() throws {
        let stores = try stores()
        XCTAssertEqual(stores.state(of: "chrome"), .asked)
        XCTAssertEqual(stores.state(of: "safari"), .refused)
        XCTAssertEqual(stores.state(of: "codex"), .unsafe)
        XCTAssertEqual(stores.state(of: "screen-time"), .allowed)
        let watched = Set(try targets().map(\.source))
        XCTAssertEqual(watched, Set(["apple-notes", "imessage", "aqua-voice", "claude-code", "upload"].map(Self.source)))
        let directories = Set(try targets().map(\.directory))
        XCTAssertFalse(directories.contains { $0.contains("Biome") }, "Biome is mapped in memory and polled")
        XCTAssertFalse(directories.contains { $0.contains(".ssh") || $0.contains("Safari") || $0.contains("Browser") })
    }

    func testADatabaseIsHeardByItsOwnNameAndItsSidecarsAloneInItsFolder() throws {
        let targets = try targets()
        let notes = Self.source("apple-notes")
        for name in ["store.sqlite", "store.sqlite-wal", "store.sqlite-shm", "store.sqlite-journal"] {
            XCTAssertEqual(matched("Library/Notes/\(name)", targets), [notes], name)
        }
        for name in ["other.sqlite", "other.sqlite-wal", "store.sqlite.bak", "store.sqlite-wal.tmp", ".store.sqlite"] {
            XCTAssertEqual(matched("Library/Notes/\(name)", targets), [], name)
        }
        XCTAssertEqual(matched("Library/Notes/deeper/store.sqlite", targets), [], "a file below the folder is another file")
    }

    func testAFileArrivingUnderADatabasesFileRootWakesItsSource() throws {
        let targets = try targets()
        XCTAssertEqual(matched("Library/Notes/Media/2026/photo-0001.jpg", targets), [Self.source("apple-notes")])
    }

    func testADatabasesMatchedFolderHearsEveryMatchingFileAndItsSidecars() throws {
        let targets = try targets()
        let chats = Self.source("imessage")
        for name in ["chat-1.db", "chat-22.db-wal", "chat-3.db-shm", "chat-4.db-journal"] {
            XCTAssertEqual(matched("Library/Chats/\(name)", targets), [chats], name)
        }
        for name in ["chat-x.db", "notes.db", "chat-1.db.lock"] {
            XCTAssertEqual(matched("Library/Chats/\(name)", targets), [], name)
        }
    }

    func testAFileRootHearsNoDotFile() throws {
        let targets = try targets()
        XCTAssertEqual(matched("Library/Notes/Media/.cache/thumb.jpg", targets), [])
        XCTAssertEqual(matched("Library/Notes/Media/2026/.photo-0001.jpg.tmp", targets), [])
        XCTAssertEqual(matched("Library/Voice/Audio/.DS_Store", targets), [])
    }

    func testAFileRootThatIsTheDatabasesOwnFolderHearsOnlyItsSubfoldersAndTheDatabase() throws {
        let declared = try Self.declared("imessage", held: "~/Library/Messages/chat.db", engine: [
            "kind": "sqlite", "stores": [["identity": "file", "member": "chat.db", "path": "~/Library/Messages/chat.db", "tables": [Self.table],
                                          "file_root": "~/Library/Messages"]]])
        let targets = StoreWatcher.targets(Self.source("imessage"), declared.store.engine, road: try stores().mac.road, folder: nil)
        let chats = Self.source("imessage")
        XCTAssertEqual(matched("Library/Messages/chat.db-wal", targets), [chats])
        XCTAssertEqual(matched("Library/Messages/Attachments/0a/photo-0001.heic", targets), [chats])
        for path in ["Library/Messages/NickNameCache.db", "Library/Messages/prefs.plist", "Library/Messages/.flag",
                     "Library/Messages/Attachments/.tmp/part"] {
            XCTAssertEqual(matched(path, targets), [], path)
        }
    }

    func testATargetUnderAFolderReachedByALinkMatchesTheRealPathTheEventsName() throws {
        let linked = NSTemporaryDirectory().hasSuffix("/") ? String(NSTemporaryDirectory().dropLast()) : NSTemporaryDirectory()
        try XCTSkipUnless(linked.hasPrefix("/var/"), "the temporary folder is reached through /var")
        let folder = linked + "/store-watcher-link-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: folder) }
        let target = StoreWatcher.Target(source: Self.source("apple-notes"), directory: StoreWatcher.real(folder + "/Notes"), recursive: false,
                                         rule: .names(["store.sqlite"]))
        XCTAssertEqual(target.directory, "/private" + folder + "/Notes", "a folder not made yet resolves through its parent")
        XCTAssertEqual(StoreWatcher.match(path: "/private" + folder + "/Notes/store.sqlite", flags: 0, targets: [target]),
                       [Self.source("apple-notes")])
    }

    func testAStoreOfWholeFilesHearsItsFilesAndTheFolderItsNamesLieIn() throws {
        let targets = try targets()
        let voice = Self.source("aqua-voice")
        XCTAssertEqual(matched("Library/Voice/history.json", targets), [voice])
        XCTAssertEqual(matched("Library/Voice/settings.json", targets), [], "a sibling it does not declare")
        XCTAssertEqual(matched("Library/Voice/Audio/take-0001.wav", targets), [voice])
    }

    func testSessionLogsAreHeardByTheirPatternUnderTheirRoot() throws {
        let targets = try targets()
        let agent = Self.source("claude-code")
        XCTAssertEqual(matched(".agent/projects/project-a/0a1b2c3d.jsonl", targets), [agent])
        XCTAssertEqual(matched(".agent/projects/project-a/0a1b2c3d/meta.json", targets), [agent], "a file beside a log")
        XCTAssertEqual(matched(".agent/projects/project-a/notes.txt", targets), [])
        XCTAssertEqual(matched(".agent/other/0a1b2c3d.jsonl", targets), [], "outside its root")
    }

    func testTheDropFolderHearsFilesButNoDotFileOrDownloadStillGoing() throws {
        let targets = try targets()
        let upload = Self.source("upload")
        let at = { (path: String) in StoreWatcher.match(path: self.drop.path + "/" + path, flags: 0, targets: targets) }
        XCTAssertEqual(at("statement.pdf"), [upload])
        XCTAssertEqual(at("folder/report.pdf"), [upload])
        for path in [".DS_Store", "takeout-001.zip.crdownload", "export.zip.download/data", "video.mov.part", "a.partial", ".hidden/file.txt",
                     "Takeout-002.ZIP.CRDOWNLOAD", "clip.MOV.Part"] {
            XCTAssertEqual(at(path), [], path)
        }
    }

    func testNoDropFolderNoUploadSourceAndNoStoresWatchNothing() {
        XCTAssertEqual(StoreWatcher.targets(sources: [Self.source("upload")], stores: nil, uploadFolder: nil), [])
        XCTAssertEqual(StoreWatcher.targets(sources: [], stores: nil, uploadFolder: drop), [])
    }

    func testAnEventTheKernelDroppedAsksForTheSweepAndAMatchIsHeard() throws {
        let overflowed = Collected<Bool>()
        let changed = Collected<Set<String>>()
        let watcher = StoreWatcher(onChange: { changed.append($0) }, onOverflow: { overflowed.append(true) }, streams: false)
        let targets = try targets()
        watcher.update(targets)
        defer { watcher.stop() }
        watcher.heard([(home.path + "/Library/Notes/store.sqlite-wal", FSEventStreamEventFlags(kFSEventStreamEventFlagItemModified))])
        XCTAssertEqual(changed.all, [[Self.source("apple-notes")]])
        XCTAssertEqual(overflowed.count, 0)
        for flag in [kFSEventStreamEventFlagMustScanSubDirs, kFSEventStreamEventFlagUserDropped, kFSEventStreamEventFlagKernelDropped] {
            XCTAssertTrue(StoreWatcher.overflows(FSEventStreamEventFlags(flag)))
            watcher.heard([(home.path, FSEventStreamEventFlags(flag))])
        }
        XCTAssertEqual(overflowed.count, 3, "each dropped batch asks for a sweep")
        XCTAssertEqual(changed.count, 1, "a dropped batch names no file")
        XCTAssertFalse(StoreWatcher.overflows(FSEventStreamEventFlags(kFSEventStreamEventFlagItemModified)))
    }

    func testAWatcherWatchesEachFolderOnceAndRestartsOnlyWhenTheFoldersChange() throws {
        let watcher = StoreWatcher(onChange: { _ in }, onOverflow: {}, streams: false)
        defer { watcher.stop() }
        let targets = try targets()
        watcher.update(targets)
        XCTAssertEqual(watcher.directories, Set(targets.map(\.directory)))
        XCTAssertEqual(watcher.directories.count, Set(targets.map(\.directory)).count)
        watcher.update(targets.filter { $0.source != Self.source("upload") })
        XCTAssertFalse(watcher.directories.contains(drop.path), "the drop folder is let go")
        watcher.update([])
        XCTAssertEqual(watcher.directories, [], "nothing allowed, nothing watched")
    }

    func testTheSweepSeesAWriteByItsStampWithoutOpeningTheDatabase() throws {
        let notes = home.appendingPathComponent("Library/Notes", isDirectory: true)
        let voice = home.appendingPathComponent("Library/Voice", isDirectory: true)
        let chats = home.appendingPathComponent("Library/Chats", isDirectory: true)
        for folder in [notes, voice, chats] { try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
        try Data("not a database".utf8).write(to: notes.appendingPathComponent("store.sqlite"))
        try Data("{}".utf8).write(to: voice.appendingPathComponent("history.json"))
        try Data("not a database".utf8).write(to: chats.appendingPathComponent("chat-1.db"))
        let watcher = StoreWatcher(onChange: { _ in }, onOverflow: {}, streams: false)
        watcher.update(try targets())

        XCTAssertEqual(watcher.changedByStamp(), [], "the first sweep sets the baseline")
        XCTAssertEqual(watcher.changedByStamp(), [], "nothing written, nothing changed")

        try Data("not a database, longer".utf8).write(to: notes.appendingPathComponent("store.sqlite-wal"))
        try Data("{\"items\":[]}".utf8).write(to: voice.appendingPathComponent("history.json"))
        try Data("not a database".utf8).write(to: chats.appendingPathComponent("chat-2.db"))
        XCTAssertEqual(watcher.changedByStamp(), Set(["apple-notes", "aqua-voice", "imessage"].map(Self.source)))
        XCTAssertEqual(watcher.changedByStamp(), [])
        XCTAssertEqual(watcher.unstamped, Set(["claude-code", "upload"].map(Self.source)), "logs and the drop folder are swept whole")
    }

    func testALogWrittenInsideTheEventsLatencyIsSeenByTheStampOfTheLogsLastHeard() throws {
        let project = home.appendingPathComponent(".agent/projects/project-a", isDirectory: true)
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        let log = project.appendingPathComponent("0a1b2c3d.jsonl")
        try Data("{}\n".utf8).write(to: log)
        let watcher = StoreWatcher(onChange: { _ in }, onOverflow: {}, streams: false)
        watcher.update(try targets())
        watcher.heard([(log.path, FSEventStreamEventFlags(kFSEventStreamEventFlagItemModified))])
        _ = watcher.changedByStamp()

        let handle = try FileHandle(forWritingTo: log)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data("{\"more\":1}\n".utf8))
        try handle.close()
        XCTAssertEqual(watcher.changedByStamp(), [Self.source("claude-code")], "an append to a log heard before")

        try Data("{}\n".utf8).write(to: project.appendingPathComponent("4e5f6a7b.jsonl"))
        XCTAssertEqual(watcher.changedByStamp(), [Self.source("claude-code")], "a new log in a folder heard before")
        XCTAssertEqual(watcher.changedByStamp(), [])
    }

    func testStampsTakenBeforeARunAreKeptAsTheBaselineSoAWriteDuringTheRunIsStillSeen() throws {
        let notes = home.appendingPathComponent("Library/Notes", isDirectory: true)
        try FileManager.default.createDirectory(at: notes, withIntermediateDirectories: true)
        try Data("not a database".utf8).write(to: notes.appendingPathComponent("store.sqlite"))
        let watcher = StoreWatcher(onChange: { _ in }, onOverflow: {}, streams: false)
        watcher.update(try targets())
        _ = watcher.changedByStamp()
        let source = Self.source("apple-notes")

        try Data("read by the run".utf8).write(to: notes.appendingPathComponent("store.sqlite-wal"))
        let before = watcher.stamps(of: [source])
        watcher.keep(before)
        XCTAssertEqual(watcher.changedByStamp(), [], "what the run read is no change")

        let during = watcher.stamps(of: [source])
        try Data("written while the run read, longer".utf8).write(to: notes.appendingPathComponent("store.sqlite-wal"))
        watcher.keep(during)
        XCTAssertEqual(watcher.changedByStamp(), [source], "a write after the stamps were taken is still owed")
    }

    func testAnUpdateAfterStopStartsNothing() throws {
        let watcher = StoreWatcher(onChange: { _ in }, onOverflow: {}, streams: false)
        watcher.stop()
        watcher.update(try targets())
        XCTAssertEqual(watcher.directories, [])
        XCTAssertEqual(watcher.watching, [])
    }
}
