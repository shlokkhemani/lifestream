import DeviceFiles
import Evidence
import Foundation
import HomeLink
import PhoneBackup
import PhoneBackupFixture
import XCTest
@testable import Shipping

class BackupImportsTests: XCTestCase {
    class var form: DeviceFiles.Form { .plain }

    fileprivate var root: URL!
    fileprivate var files: DeviceFiles!
    fileprivate var state: ShippingState!
    fileprivate var clock: FixedClock!
    fileprivate var home: FakeHome!
    fileprivate var link: HomeLink!
    fileprivate var ledger: ImportLedger!

    fileprivate static let now = ShippingFixture.instant("2026-10-27T10:00:00.000Z")
    fileprivate static let lane = "upload:local:unit-0001"
    fileprivate static let kind = "iphone-backup"
    fileprivate static let check = ImportCheck(recognise: ["**/backup.json"])
    fileprivate static let backup = "00008150-00117D2422D2401C-20260828T091244Z"

    fileprivate var backups: URL { state.carriedDirectory.appendingPathComponent("backups", isDirectory: true) }
    fileprivate var pulled: URL { ledger.backupFolder(Self.backup) }

    override func setUp() async throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("backup-imports-\(UUID().uuidString)")
        files = DeviceFiles(type(of: self).form)
        state = ShippingState(root: root.appendingPathComponent("ship", isDirectory: true), files: files)
        try state.prepare()
        clock = FixedClock(Self.now)
        home = FakeHome(sources: [Self.lane], clock: clock.read)
        link = try await ShippingFixture.link(home, folder: root)
        ledger = .in(state.carriedDirectory, files: files)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testABundleCarriesExactlyWhatTheHomeLacks() async throws {
        let held = Data("held medium".utf8), lacking = Data("lacking medium".utf8), shared = Data("named by both".utf8)
        let whatsapp = try store("whatsapp", ["chats.sqlite": 300], blobs: [held, lacking, shared])
        let imessage = try store("imessage", ["messages.db": 200], blobs: [shared])
        try handOver([whatsapp, imessage])
        home.holds = ["sha256:" + Self.sha256(held)]
        _ = await makeShipper().run(.timer)

        let sent = try XCTUnwrap(home.deliveries.first)
        XCTAssertEqual(sent.members.keys.filter { $0.hasPrefix("blobs/") }.sorted(),
                       ["blobs/" + Self.sha256(lacking), "blobs/" + Self.sha256(shared)].sorted(), "the lacking carried, the held not")
        XCTAssertEqual(sent.members["blobs/" + Self.sha256(lacking)], lacking)
        XCTAssertEqual(sent.members.keys.filter { $0.hasPrefix("files/") }.sorted(),
                       ["files/whatsapp/backup.json", "files/whatsapp/chats.sqlite", "files/whatsapp/media.json"])
        XCTAssertTrue(sent.lost.isEmpty, "a held blob is named, never stated lost")
        let first = try ledger.read().files[0]
        XCTAssertEqual(first.state, .sent)
        XCTAssertEqual(first.bundle, first.bytes + Int64(lacking.count + shared.count), "the bundle as sealed: the held blob is not in it")
        XCTAssertEqual(first.bytes, Self.bytes(of: ["chats.sqlite": 300]), "its members' bytes never move")
        XCTAssertFalse(FileManager.default.fileExists(atPath: whatsapp.folder.path))
        XCTAssertEqual(try blobsHere(), [named(shared)])

        clock.move(by: 1)
        _ = await makeShipper().run(.timer)
        XCTAssertEqual(home.deliveries.count, 2)
        XCTAssertEqual(try ledger.read().files.map(\.state), [.sent, .sent])
        XCTAssertFalse(FileManager.default.fileExists(atPath: pulled.path), "the last store sealed, nothing of the pull-out is left")
    }

    func testTheBundlesBytesNeverMakeTheFolderMissing() async throws {
        let medium = SyntheticBytes.make(64 * 1024, seed: 3)
        let calls = try store("whatsapp", ["chats.sqlite": 1024], blobs: [medium])
        let records = try ledger.handOver(backup: Self.backup, stores: [calls], kind: Self.kind, at: Self.now)
        XCTAssertEqual(records.first?.bundle, (records.first?.bytes ?? 0) + Int64(medium.count))
        try ledger.check(records[0], against: Self.check, most: ImportFiles.doorMost)
        XCTAssertEqual(try waits(), ["waiting turn"], "checked against its members' stamp, not its bundle's bytes")
        _ = await makeShipper().run(.timer)
        XCTAssertEqual(try waits(), ["sent"])
        XCTAssertEqual(home.deliveries.first?.members["blobs/" + Self.sha256(medium)], medium)
    }

    func testEveryWaitReadsTheBundle() async throws {
        let large = try store("whatsapp", ["chats.sqlite": 2048], blobs: [], stated: [9_000_000_000])
        try handOver([large])
        XCTAssertEqual(try waits(), ["waiting turn"])

        let power = Toggle(false), macFree = Counter<Int64?>(1 << 40), homeFree = Counter<Int64?>(nil)
        let room = ImportRoom(onPower: { power.value }, disk: Volume(root, every: 0, read: { _ in macFree.value }), homeFree: { homeFree.value })
        let shipper = makeShipper(room: room)
        _ = await shipper.run(.timer)
        XCTAssertEqual(try waits(), ["waiting battery"], "9 GB waits for power though its members are 2 KB")
        power.value = true
        macFree.value = Room.keepBytes + 1_000_000_000
        clock.move(by: 400)
        _ = await shipper.run(.manual)
        XCTAssertEqual(try waits(), ["waiting mac-room"])
        macFree.value = 1 << 40
        homeFree.value = Room.keepBytes + 2 * 1_000_000_000
        clock.move(by: 400)
        _ = await shipper.run(.manual)
        XCTAssertEqual(try waits(), ["waiting home-room"])
        XCTAssertTrue(home.deliveries.isEmpty)
    }

    func testTheStartKeepsWhatTheLedgerNamesAndPrunesTheRest() async throws {
        let kept = try store("whatsapp", ["chats.sqlite": 512], blobs: [Data("kept medium".utf8)])
        let unnamed = try store("imessage", ["messages.db": 128], blobs: [Data("stray medium".utf8)])
        let scratch = backups.appendingPathComponent("open-\(Self.backup)/phone-backup", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        try Data("decrypted list".utf8).write(to: scratch.appendingPathComponent("Manifest.db"))
        let cut = backups.appendingPathComponent("another-backup/.work", isDirectory: true)
        try FileManager.default.createDirectory(at: cut, withIntermediateDirectories: true)
        try handOver([kept])

        try ledger.prune()
        XCTAssertTrue(FileManager.default.fileExists(atPath: kept.folder.appendingPathComponent("chats.sqlite").path))
        XCTAssertEqual(try blobsHere(), [named(Data("kept medium".utf8))])
        XCTAssertFalse(FileManager.default.fileExists(atPath: unnamed.folder.path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: backups.path), [files.name(Self.backup)], "the scratch and the cut read gone")

        home.noRoomFor = ["later"]
        _ = await makeShipper().run(.timer)
        XCTAssertTrue(home.deliveries.isEmpty)
        try ledger.prune()
        home.noRoomFor = []
        clock.move(by: 400)
        _ = await makeShipper().run(.manual)
        let sent = try XCTUnwrap(home.deliveries.first)
        XCTAssertEqual(sent.members["files/whatsapp/chats.sqlite"]?.count, 512)
        XCTAssertEqual(sent.members["blobs/" + Self.sha256(Data("kept medium".utf8))], Data("kept medium".utf8))
        XCTAssertEqual(try waits(), ["sent"])
    }

    func testTheStoresAreHandedOverInOneWrite() throws {
        let writes = Counter<Int>(0)
        let counted = ImportLedger.in(state.carriedDirectory, files: files, written: { writes.value += 1 })
        let stores = try ["imessage", "whatsapp", "apple-calls"].map { try store($0, ["store.sqlite": 64], blobs: []) }
        let records = try counted.handOver(backup: Self.backup, stores: stores, kind: Self.kind, at: Self.now)
        XCTAssertEqual(writes.value, 1)
        XCTAssertEqual(records.map(\.backup), Array(repeating: Optional(Self.backup), count: 3))
        XCTAssertEqual(records.map(\.state), [.checking, .checking, .checking])
        let read = [Self.backup: ImportLedger.Backup(at: Self.now, stores: ["imessage": .owed, "whatsapp": .owed, "apple-calls": .owed])]
        XCTAssertEqual(try counted.read().backups, read)
        XCTAssertEqual(try counted.handOver(backup: Self.backup, stores: stores, kind: Self.kind, at: Self.now), [])
        try counted.change { $0.files.removeAll() }
        XCTAssertEqual(try counted.read().backups, read)
    }

    func testAQuitBetweenTheSealAndItsSidecarLeavesTheStoreToSend() async throws {
        let medium = Data("a medium".utf8)
        let whatsapp = try store("whatsapp", ["chats.sqlite": 512], blobs: [medium])
        try handOver([whatsapp])
        let lane = ImportShipping(sourceId: Self.lane, ledger: ledger, ledgers: state.ledgers,
                                  room: ImportRoom(onPower: { true }, disk: Volume(root, every: 0, read: { _ in 1 << 40 }), homeFree: { nil }))
        let request = SealRequest(fetchedAt: Self.now, workDirectory: state.workDirectory, scratch: state.workDirectory,
                                  custody: SealCustody(pass: "pass-before-the-quit", received: 0, imported: 0))
        let sealed = try XCTUnwrap(try lane.seal(request, received: 0))
        XCTAssertTrue(FileManager.default.fileExists(atPath: sealed.file.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: whatsapp.folder.appendingPathComponent("chats.sqlite").path),
                      "no sidecar, no custody: the folder stays")
        XCTAssertEqual(try blobsHere(), [named(medium)])

        try ledger.prune()
        XCTAssertTrue(FileManager.default.fileExists(atPath: whatsapp.folder.appendingPathComponent("chats.sqlite").path))
        _ = await makeShipper().run(.timer)
        let sent = try XCTUnwrap(home.deliveries.first)
        XCTAssertEqual(sent.members["files/whatsapp/chats.sqlite"]?.count, 512)
        XCTAssertEqual(sent.members["blobs/" + Self.sha256(medium)], medium)
        XCTAssertEqual(try waits(), ["sent"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: pulled.path), "sealed into custody and sent: nothing of the pull-out is left")
    }

    func testARefusedOrLostStoreIsTheBackupsToSayAndItsBytesGoAtOnce() async throws {
        let mine = Data("messages medium".utf8)
        let whatsapp = try store("whatsapp", ["chats.sqlite": 2048], blobs: [Data("whatsapp medium".utf8)], stated: [9_000_000_000])
        let imessage = try store("imessage", ["messages.db": 256], blobs: [mine])
        let records = try ledger.handOver(backup: Self.backup, stores: [whatsapp, imessage], left: ["apple-calls": .unreadable],
                                          kind: Self.kind, at: Self.now)
        try ledger.check(records[0], against: Self.check, most: 5_000_000_000)
        XCTAssertEqual(try ledger.read().files.map(\.name), ["imessage"], "refused: the backup's to say, never a file row")
        XCTAssertEqual(try ledger.read().backups?[Self.backup]?.stores, ["whatsapp": .tooLarge, "imessage": .owed, "apple-calls": .unreadable])
        XCTAssertFalse(FileManager.default.fileExists(atPath: whatsapp.folder.path), "its folder goes at once")
        XCTAssertEqual(try blobsHere(), [named(mine)], "its media go at once; the owed store's stay")

        try ledger.check(records[1], against: Self.check, most: ImportFiles.doorMost)
        home.noRoomFor = ["later"]
        _ = await makeShipper().run(.timer)
        XCTAssertTrue(home.deliveries.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: imessage.folder.path))
        XCTAssertEqual(try ledger.read().backups?[Self.backup]?.owed, true)
        for bundle in try state.pendingBundles() { state.spend(bundle) }
        home.noRoomFor = []
        clock.move(by: 400)
        _ = await makeShipper().run(.manual)
        XCTAssertEqual(try ledger.read().files, [], "lost: never a file to choose again")
        let read = try XCTUnwrap(try ledger.read().backups?[Self.backup])
        XCTAssertEqual(read.stores, ["whatsapp": .tooLarge, "imessage": .lost, "apple-calls": .unreadable])
        XCTAssertFalse(read.owed, "nothing owed: the backup may be read again")
        XCTAssertFalse(FileManager.default.fileExists(atPath: pulled.path))
    }

    func testEachSealsWaitsReadTheHomesHeldSetOfThatSeal() async throws {
        let large = try store("whatsapp", ["chats.sqlite": 2048], blobs: [], stated: [9_000_000_000])
        try handOver([large])
        let macFree = Counter<Int64?>(Room.keepBytes + 1_000_000_000)
        let shipper = makeShipper(room: ImportRoom(onPower: { true }, disk: Volume(root, every: 0, read: { _ in macFree.value }), homeFree: { nil }))
        _ = await shipper.run(.timer)
        XCTAssertEqual(try waits(), ["waiting mac-room"])

        home.holds = ["sha256:" + Self.sha256(Data("stated 0".utf8))]
        clock.move(by: 400)
        _ = await shipper.run(.manual)
        XCTAssertEqual(try waits(), ["sent"])
        let sent = try XCTUnwrap(home.deliveries.first)
        XCTAssertTrue(sent.members.keys.filter { $0.hasPrefix("blobs/") }.isEmpty, "held: named, not carried")
        XCTAssertTrue(sent.lost.isEmpty)
    }

    func testAPulledBackupIsNamedByTheFormAndShipsThePlainOnesBytes() async throws {
        let phone = try SyntheticBackup.phone()
        let mine = try await pullAndShip(files, phone, in: root.appendingPathComponent("mine", isDirectory: true))
        let plain = try await pullAndShip(DeviceFiles(.plain), phone, in: root.appendingPathComponent("plain", isDirectory: true))
        XCTAssertEqual(mine.sent.count, 3, "one bundle a store")
        XCTAssertEqual(mine.sent.map { $0.keys.sorted() }, plain.sent.map { $0.keys.sorted() })
        XCTAssertEqual(mine.sent, plain.sent, "each bundle's members are the plain pull-out's bytes: \(Self.firstDifference(mine.sent, plain.sent))")
        XCTAssertFalse(mine.hashes.isEmpty)

        let secrets = [SyntheticBackup.udid] + mine.hashes
        if files.keyed {
            for path in mine.paths {
                for secret in secrets { XCTAssertFalse(path.contains(secret), "\(path) names \(secret)") }
            }
            XCTAssertEqual(mine.paths.filter { $0.hasPrefix("backups/") && $0.hasSuffix("/blobs") }.count, 1)
        } else {
            XCTAssertEqual(mine.paths, plain.paths)
            for hash in mine.hashes { XCTAssertTrue(mine.paths.contains("backups/\(mine.id)/blobs/\(hash)"), "a plain Mac keeps today's names") }
            XCTAssertTrue(mine.paths.contains("backups/\(mine.id)/whatsapp/chats.sqlite"))
        }
    }

    private static func firstDifference(_ mine: [[String: Data]], _ plain: [[String: Data]]) -> String {
        for (index, (left, right)) in zip(mine, plain).enumerated() {
            for name in Set(left.keys).union(right.keys).sorted() where left[name] != right[name] {
                guard let a = left[name], let b = right[name] else { return "bundle \(index) \(name) in one only" }
                let at = zip(a, b).enumerated().first { $0.element.0 != $0.element.1 }?.offset ?? min(a.count, b.count)
                return "bundle \(index) \(name) first differs at byte \(at)"
            }
        }
        return "no member differs"
    }

    fileprivate func pullAndShip(_ files: DeviceFiles, _ phone: [SyntheticBackup.File], in folder: URL) async throws -> (id: String, paths: [String], hashes: [String], sent: [[String: Data]]) {
        clock.move(to: Self.now)
        let state = ShippingState(root: folder.appendingPathComponent("ship", isDirectory: true), files: files)
        try state.prepare()
        let home = FakeHome(sources: [Self.lane], clock: clock.read)
        let link = try await ShippingFixture.link(home, folder: folder)
        let ledger = ImportLedger.in(state.carriedDirectory, files: files)
        let phones = folder.appendingPathComponent("Backup", isDirectory: true)
        try FileManager.default.createDirectory(at: phones, withIntermediateDirectories: true)
        let made = try SyntheticBackup.write(in: phones, password: SyntheticBackup.password, files: phone)
        let backup = try OpenBackup(try BackupFolder(at: made.url), password: SyntheticBackup.password,
                                    work: folder.appendingPathComponent("open", isDirectory: true))
        let id = "\(made.udid)-20260828T091244Z"
        let result = try await BackupPull(backup, into: ledger.backupFolder(id), scratch: folder.appendingPathComponent("scratch", isDirectory: true),
                                          files: files, asks: .init(held: { _ in [] }, room: { _ in })).run()
        let carried = state.carriedDirectory.standardizedFileURL.path
        var paths: [String] = []
        let walk = FileManager.default.enumerator(at: state.carriedDirectory, includingPropertiesForKeys: nil)?.allObjects as? [URL] ?? []
        for url in walk {
            try FileManager.default.setAttributes([.creationDate: Self.now, .modificationDate: Self.now], ofItemAtPath: url.path)
            paths.append(String(url.standardizedFileURL.path.dropFirst(carried.count + 1)))
        }
        let stores = result.pulled.map { pulled in
            (folder: pulled.folder, blobs: pulled.blobs.map {
                ImportLedger.Blob(path: BackupPull.blob($0.sha256, in: result.blobs, files: files).path, sha256: $0.sha256, bytes: $0.bytes)
            })
        }
        for record in try ledger.handOver(backup: id, stores: stores, kind: Self.kind, at: Self.now) {
            try ledger.check(record, against: Self.check, most: ImportFiles.doorMost)
        }
        for _ in stores {
            clock.move(by: 1)
            _ = await makeShipper(state: state, link: link).run(.manual)
        }
        return (id, paths.sorted(), result.pulled.flatMap(\.blobs).map(\.sha256).sorted(), home.deliveries.map(\.members))
    }


    fileprivate typealias Store = (folder: URL, blobs: [ImportLedger.Blob])

    fileprivate func store(_ name: String, _ members: [String: Int], blobs: [Data], stated: [Int64] = []) throws -> Store {
        let folder = pulled.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for (member, size) in members { try files.writeNew(folder.appendingPathComponent(member), SyntheticBytes.make(size, seed: 1), flush: .data) }
        try files.writeNew(folder.appendingPathComponent("backup.json"), Data("{\"store\":\"\(name)\"}".utf8), flush: .data)
        if name == "whatsapp" { try files.writeNew(folder.appendingPathComponent("media.json"), Data("{}".utf8), flush: .data) }
        let blobFolder = pulled.appendingPathComponent("blobs", isDirectory: true)
        try FileManager.default.createDirectory(at: blobFolder, withIntermediateDirectories: true)
        var named: [ImportLedger.Blob] = []
        for data in blobs {
            let sha = Self.sha256(data)
            let url = blobFolder.appendingPathComponent(files.name(sha))
            if !FileManager.default.fileExists(atPath: url.path) { try files.writeNew(url, data, flush: .data) }
            named.append(ImportLedger.Blob(path: url.path, sha256: sha, bytes: Int64(data.count)))
        }
        for (index, bytes) in stated.enumerated() {
            let sha = Self.sha256(Data("stated \(index)".utf8))
            named.append(ImportLedger.Blob(path: blobFolder.appendingPathComponent(files.name(sha)).path, sha256: sha, bytes: bytes))
        }
        return (folder, named)
    }

    fileprivate func handOver(_ stores: [Store]) throws {
        for record in try ledger.handOver(backup: Self.backup, stores: stores, kind: Self.kind, at: Self.now) {
            try ledger.check(record, against: Self.check, most: ImportFiles.doorMost)
        }
    }

    fileprivate func blobsHere() throws -> [String] {
        let folder = pulled.appendingPathComponent("blobs")
        guard FileManager.default.fileExists(atPath: folder.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(atPath: folder.path).sorted()
    }

    fileprivate func named(_ data: Data) -> String {
        files.name(Self.sha256(data))
    }

    fileprivate func waits() throws -> [String] {
        try ledger.read().files.map { [$0.state.rawValue, $0.why?.rawValue].compactMap { $0 }.joined(separator: " ") }
    }

    fileprivate static func bytes(of members: [String: Int]) -> Int64 {
        Int64(members.values.reduce(0, +)) + Int64("{\"store\":\"whatsapp\"}".utf8.count) + 2
    }

    fileprivate static func sha256(_ data: Data) -> String {
        var digest = StreamDigest()
        digest.update(data)
        return digest.hex()
    }

    fileprivate func makeShipper(room given: ImportRoom? = nil, state other: ShippingState? = nil, link otherLink: HomeLink? = nil) -> Shipper {
        let state = other ?? self.state!, link = otherLink ?? self.link!
        let ledgers = state.ledgers, carried = state.carriedDirectory, lane = Self.lane, root = root!
        let room = given ?? ImportRoom(onPower: { true }, disk: Volume(root, every: 0, read: { _ in 1 << 40 }), homeFree: { nil })
        return Shipper(Shipper.Dependencies(
            state: state, link: link, settings: MacSettings(file: DomainFixtures.settingsFile, files: DeviceFiles(.plain)),
            domains: { sources in
                sources.compactMap { source -> (any ShippingDomain)? in
                    guard source == lane else { return nil }
                    return UploadLane(sourceId: lane, folder: nil,
                                      imports: ImportShipping(sourceId: lane, ledger: .in(carried, files: ledgers.files), ledgers: ledgers, room: room))
                }
            },
            clock: clock.read, record: { _ in }, keepAwake: { {} }, scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true)))
    }
}

final class KeyedBackupImportsTests: BackupImportsTests {
    override class var form: DeviceFiles.Form { .keyed(ShippingFixture.macKey) }

    func testAKeyedStoreIsKeptEncryptedAndSentAsItsPlainBytes() async throws {
        let medium = Data("a keyed medium".utf8)
        let whatsapp = try store("whatsapp", ["chats.sqlite": 700], blobs: [medium])
        let records = try ledger.handOver(backup: Self.backup, stores: [whatsapp], kind: Self.kind, at: Self.now)
        XCTAssertEqual(records.first?.bytes, Self.bytes(of: ["chats.sqlite": 700]), "a kept store's bytes are its plain members'")
        let onDisk = try XCTUnwrap(FileManager.default.contents(atPath: whatsapp.folder.appendingPathComponent("chats.sqlite").path))
        XCTAssertNotEqual(onDisk, SyntheticBytes.make(700, seed: 1))
        XCTAssertNil(try XCTUnwrap(FileManager.default.contents(atPath: whatsapp.blobs[0].path)).range(of: medium), "the medium is encrypted at rest")
        let ledgerOnDisk = try XCTUnwrap(FileManager.default.contents(atPath: ledger.file.path))
        XCTAssertNil(ledgerOnDisk.range(of: Data(Self.backup.utf8)), "the import ledger is encrypted")
        try ledger.check(records[0], against: Self.check, most: ImportFiles.doorMost)
        XCTAssertEqual(try waits(), ["waiting turn"])

        _ = await makeShipper().run(.timer)
        let sent = try XCTUnwrap(home.deliveries.first)
        XCTAssertEqual(sent.members["files/whatsapp/chats.sqlite"], SyntheticBytes.make(700, seed: 1))
        XCTAssertEqual(sent.members["files/whatsapp/backup.json"], Data("{\"store\":\"whatsapp\"}".utf8))
        XCTAssertEqual(sent.members["blobs/" + Self.sha256(medium)], medium)
        XCTAssertEqual(try waits(), ["sent"])
        XCTAssertEqual(try ledger.read().files.first?.sha256, ImportFiles.folderHash([
            ("whatsapp/backup.json", Self.sha256(Data("{\"store\":\"whatsapp\"}".utf8))),
            ("whatsapp/chats.sqlite", Self.sha256(SyntheticBytes.make(700, seed: 1))),
            ("whatsapp/media.json", Self.sha256(Data("{}".utf8))),
        ]), "the store's hash is over its plain members")
    }
}

enum SyntheticBytes {
    static func make(_ count: Int, seed: UInt8) -> Data {
        Data((0..<count).map { UInt8(truncatingIfNeeded: $0 &* 7 &+ Int(seed)) })
    }
}
