import Foundation
import HomeLink
import XCTest
@testable import Shipping

final class StagedUploadWorkerTests: XCTestCase {
    private var folder: URL!
    private static let source = "whatsapp:15550000001:macbook-pro-0001"
    private static let other = "imessage:person-a@example.com:macbook-pro-0001"

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("staged-worker-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func file(_ letter: Character, bytes: Int = 300 * 1024) throws -> (hex: String, url: URL) {
        let url = folder.appendingPathComponent("attachment-\(letter)")
        try Data(repeating: 7, count: bytes).write(to: url)
        return (ShippingFixture.hash(letter), url)
    }

    private func worker(_ link: FakeStaging, uploads: Int = 2, pauses: Collected<TimeInterval> = Collected()) -> (StagedUploadWorker, Collected<String>) {
        let worker = StagedUploadWorker(link: link, uploads: uploads, pause: { pauses.append($0) })
        let woke = Collected<String>()
        worker.onReady { woke.append($0) }
        return (worker, woke)
    }

    func testAFileTheDoorHoldsIsReadyAtOnceAndNothingIsSent() async throws {
        let (hex, url) = try file("a")
        let link = FakeStaging()
        link.holds("sha256:" + hex)
        let (worker, woke) = worker(link)
        worker.enqueue(source: Self.source, sha256: hex, url: url, bytes: 300 * 1024, kept: false, kind: .new)
        try await until("ready") { worker.isReady(source: Self.source, sha256: hex) }
        XCTAssertTrue(link.stages.isEmpty)
        XCTAssertEqual(woke.all, [Self.source], "the source is woken to seal what waited")
        XCTAssertFalse(worker.isPending(source: Self.source, sha256: hex))
        XCTAssertFalse(worker.isReady(source: Self.other, sha256: hex), "ready is per source: the door drops a staged file at its seal")
    }

    func testAPartlyHeldFileGoesOnFromTheBytesTheDoorHoldsNamingItsSource() async throws {
        let (hex, url) = try file("b")
        let link = FakeStaging()
        link.partly["sha256:" + hex] = 1_000
        let (worker, _) = worker(link)
        await worker.add(source: Self.source, sha256: hex.uppercased(), url: url, bytes: 300 * 1024, kept: false, kind: .later)
        try await until("ready") { worker.isReady(source: Self.source, sha256: hex) }
        XCTAssertEqual(link.stages, [FakeStaging.Stage(name: "sha256:" + hex, source: Self.source, offset: 1_000, kept: false, kind: .later,
                                                       pressed: false)])
    }

    func testAFileWaitingForTheNetworkIsParkedUntilThePathOrChoiceChanges() async throws {
        let (hex, url) = try file("c")
        let link = FakeStaging()
        link.fails("sha256:" + hex, with: [.waits(.lowData)])
        let (worker, _) = worker(link)
        await worker.start()
        await worker.add(source: Self.source, sha256: hex, url: url, bytes: 300 * 1024, kept: false, kind: .new)
        try await until("parked") { await worker.parkedCount == 1 }
        XCTAssertTrue(worker.isPending(source: Self.source, sha256: hex))
        XCTAssertEqual(link.stages.count, 1)
        link.change()
        try await until("ready after the change") { worker.isReady(source: Self.source, sha256: hex) }
        XCTAssertEqual(link.stages.count, 2)
        await worker.stop()
    }

    func testAPressParksNoMore() async throws {
        let (hex, url) = try file("d")
        let link = FakeStaging()
        link.fails("sha256:" + hex, with: [.waits(.past)])
        let (worker, _) = worker(link)
        await worker.add(source: Self.source, sha256: hex, url: url, bytes: 300 * 1024, kept: false, kind: .later)
        try await until("parked") { await worker.parkedCount == 1 }
        worker.enqueue(source: Self.source, sha256: hex, url: url, bytes: 300 * 1024, kept: false, kind: .later, pressed: true)
        try await until("ready after the press") { worker.isReady(source: Self.source, sha256: hex) }
        XCTAssertEqual(link.stages.last?.pressed, true)
    }

    func testARefusalDropsTheFile() async throws {
        let (hex, url) = try file("e")
        let link = FakeStaging()
        link.fails("sha256:" + hex, with: [.refused(status: 413, code: "TOO_LARGE", message: "too large")])
        let (worker, woke) = worker(link)
        await worker.add(source: Self.source, sha256: hex, url: url, bytes: 300 * 1024, kept: false, kind: .new)
        try await until("dropped") { !worker.isPending(source: Self.source, sha256: hex) }
        XCTAssertFalse(worker.isReady(source: Self.source, sha256: hex))
        XCTAssertEqual(woke.all, [])
    }

    func testAFileGoneFromDiskIsDropped() async throws {
        let link = FakeStaging()
        let (worker, _) = worker(link)
        let hex = ShippingFixture.hash("f")
        await worker.add(source: Self.source, sha256: hex, url: folder.appendingPathComponent("gone"), bytes: 300 * 1024, kept: false, kind: .new)
        try await until("dropped") { !worker.isPending(source: Self.source, sha256: hex) }
        XCTAssertTrue(link.stages.isEmpty)
    }

    func testADoorThatCannotTakeItNowIsTriedAgainAfterAGrowingRest() async throws {
        let (hex, url) = try file("g")
        let link = FakeStaging()
        link.fails("sha256:" + hex, with: [.noAnswer(sent: true), .unavailable(code: "NOT_NOW", message: nil, retryAfter: 9)])
        let pauses = Collected<TimeInterval>()
        let (worker, _) = worker(link, pauses: pauses)
        await worker.add(source: Self.source, sha256: hex, url: url, bytes: 300 * 1024, kept: false, kind: .new)
        try await until("ready") { worker.isReady(source: Self.source, sha256: hex) }
        XCTAssertEqual(pauses.all, [StagedUploadWorker.firstWait, 9], "doubling, or the door's Retry-After when longer")
        XCTAssertEqual(link.stages.count, 3)
    }

    func testFilesMissingStagesAgainAndATakenBundleForgetsReady() async throws {
        let (hex, url) = try file("h")
        let link = FakeStaging()
        let (worker, _) = worker(link)
        await worker.add(source: Self.source, sha256: hex, url: url, bytes: 300 * 1024, kept: false, kind: .new)
        try await until("ready") { worker.isReady(source: Self.source, sha256: hex) }
        link.sweep("sha256:" + hex)
        XCTAssertTrue(worker.invalidate(source: Self.source, sha256s: [hex]), "it can stage the file again")
        XCTAssertFalse(worker.isReady(source: Self.source, sha256: hex))
        try await until("ready again") { worker.isReady(source: Self.source, sha256: hex) }
        XCTAssertEqual(link.stages.count, 2, "staged again from what the worker remembered")
        await worker.markConsumed(source: Self.source, sha256s: [hex])
        XCTAssertFalse(worker.isReady(source: Self.source, sha256: hex))
    }

    func testFilesMissingThatCannotBeStagedAgainSaysSo() async throws {
        let (hex, url) = try file("j")
        let link = FakeStaging()
        let (worker, _) = worker(link)
        XCTAssertFalse(worker.invalidate(source: Self.source, sha256s: [hex]), "a file this worker never saw, as after a relaunch")
        XCTAssertFalse(worker.invalidate(source: Self.source, sha256s: []), "nothing named is nothing to stage")
        await worker.add(source: Self.source, sha256: hex, url: url, bytes: 300 * 1024, kept: false, kind: .new)
        try await until("ready") { worker.isReady(source: Self.source, sha256: hex) }
        try FileManager.default.removeItem(at: url)
        XCTAssertFalse(worker.invalidate(source: Self.source, sha256s: [hex]), "a file gone from disk")
        XCTAssertFalse(worker.isReady(source: Self.source, sha256: hex))
        XCTAssertFalse(worker.isPending(source: Self.source, sha256: hex))
    }

    func testFilesMissingWhileAFileStillUploadsCountsItAsStaging() async throws {
        let (hex, url) = try file("k")
        let link = FakeStaging()
        link.gated = true
        let (worker, _) = worker(link)
        await worker.add(source: Self.source, sha256: hex, url: url, bytes: 300 * 1024, kept: false, kind: .new)
        try await until("uploading") { link.inFlight == 1 }
        try FileManager.default.removeItem(at: url)
        XCTAssertTrue(worker.invalidate(source: Self.source, sha256s: [hex]), "the upload going on is the restage")
        link.gated = false
        link.release()
        try await until("ready") { worker.isReady(source: Self.source, sha256: hex) }
    }

    func testAnUploadFromTheLastPassNeverMakesAFileReadyUnderTheNext() async throws {
        let (hex, url) = try file("l")
        let link = FakeStaging()
        link.gated = true
        let (worker, _) = worker(link)
        await worker.reset(pass: "p-00000001")
        await worker.add(source: Self.source, sha256: hex, url: url, bytes: 300 * 1024, kept: false, kind: .new)
        try await until("uploading") { link.inFlight == 1 }
        link.fails("sha256:" + hex, with: [.waits(.past)])
        await worker.reset(pass: "p-00000002")
        try await until("staged again under the new pass, and parked") { await worker.parkedCount == 1 }
        link.release()
        try await until("the old upload ended") { await worker.outlived == 1 }
        XCTAssertFalse(worker.isReady(source: Self.source, sha256: hex), "the old pass's upload does not count")
        XCTAssertTrue(worker.isPending(source: Self.source, sha256: hex))
    }

    func testAPressWakesAFileRestingAfterAPressedTry() async throws {
        let (hex, url) = try file("m")
        let link = FakeStaging()
        link.fails("sha256:" + hex, with: [.noAnswer(sent: true)])
        let rests = Collected<CheckedContinuation<Void, Never>>()
        let worker = StagedUploadWorker(link: link, pause: { _ in await withCheckedContinuation { rests.append($0) } })
        defer { for rest in rests.all { rest.resume() } }
        worker.enqueue(source: Self.source, sha256: hex, url: url, bytes: 300 * 1024, kept: false, kind: .new, pressed: true)
        try await until("resting") { rests.all.count == 1 }
        worker.enqueue(source: Self.source, sha256: hex, url: url, bytes: 300 * 1024, kept: false, kind: .new, pressed: true)
        try await until("ready after the second press") { worker.isReady(source: Self.source, sha256: hex) }
        XCTAssertEqual(link.stages.count, 2)
    }

    func testAnUnpairedLinkParksAndANotFoundDrops() async throws {
        let (parkedHex, parkedURL) = try file("n")
        let (droppedHex, droppedURL) = try file("o")
        let link = FakeStaging()
        link.fails("sha256:" + parkedHex, with: [.unpaired])
        link.fails("sha256:" + droppedHex, with: [.refused(status: 404, code: "HTTP_404", message: "no route")])
        let pauses = Collected<TimeInterval>()
        let (worker, _) = worker(link, pauses: pauses)
        await worker.add(source: Self.source, sha256: parkedHex, url: parkedURL, bytes: 300 * 1024, kept: false, kind: .new)
        await worker.add(source: Self.source, sha256: droppedHex, url: droppedURL, bytes: 300 * 1024, kept: false, kind: .new)
        try await until("parked") { await worker.parkedCount == 1 }
        try await until("dropped") { !worker.isPending(source: Self.source, sha256: droppedHex) }
        XCTAssertTrue(worker.isPending(source: Self.source, sha256: parkedHex))
        XCTAssertEqual(pauses.all, [], "neither is tried again on a timer")
        XCTAssertFalse(worker.invalidate(source: Self.source, sha256s: [droppedHex]), "a dropped file is forgotten")
    }

    func testANewPassForgetsWhatWasReady() async throws {
        let (hex, url) = try file("i")
        let link = FakeStaging()
        let (worker, _) = worker(link)
        await worker.reset(pass: "p-00000001")
        await worker.add(source: Self.source, sha256: hex, url: url, bytes: 300 * 1024, kept: false, kind: .new)
        try await until("ready") { worker.isReady(source: Self.source, sha256: hex) }
        await worker.reset(pass: "p-00000001")
        XCTAssertTrue(worker.isReady(source: Self.source, sha256: hex))
        await worker.reset(pass: "p-00000002")
        XCTAssertFalse(worker.isReady(source: Self.source, sha256: hex))
    }

    func testNoMoreThanItsUploadsRunAtOnce() async throws {
        let link = FakeStaging()
        link.gated = true
        let (worker, _) = worker(link, uploads: 2)
        var hexes: [String] = []
        for letter in ["1", "2", "3"] as [Character] {
            let (hex, url) = try file(letter)
            hexes.append(hex)
            await worker.add(source: Self.source, sha256: hex, url: url, bytes: 300 * 1024, kept: false, kind: .new)
        }
        try await until("two uploads in flight") { link.inFlight == 2 }
        XCTAssertEqual(link.stages.count, 2)
        link.gated = false
        link.release()
        try await until("all ready") { hexes.allSatisfy { worker.isReady(source: Self.source, sha256: $0) } }
        XCTAssertEqual(link.mostInFlight, 2)
    }
}

final class FakeStaging: StagingLink, @unchecked Sendable {
    struct Stage: Equatable {
        let name: String
        let source: String
        let offset: Int64
        let kept: Bool
        let kind: WriteKind
        let pressed: Bool
    }

    private let lock = NSLock()
    private var held: Set<String> = []
    private var parts: [String: Int64] = [:]
    private var failures: [String: [LinkFailure]] = [:]
    private var made: [Stage] = []
    private var flying = 0
    private var most = 0
    private var gate = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var readers: [AsyncStream<Void>.Continuation] = []

    var partly: [String: Int64] {
        get { lock.withLock { parts } }
        set { lock.withLock { parts = newValue } }
    }
    var gated: Bool {
        get { lock.withLock { gate } }
        set { lock.withLock { gate = newValue } }
    }
    var stages: [Stage] { lock.withLock { made } }
    var inFlight: Int { lock.withLock { waiting.count } }
    var mostInFlight: Int { lock.withLock { most } }

    func holds(_ name: String) { _ = lock.withLock { held.insert(name) } }
    func sweep(_ name: String) { _ = lock.withLock { held.remove(name) } }
    func fails(_ name: String, with script: [LinkFailure]) { lock.withLock { failures[name] = script } }

    func release() {
        let opened = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            defer { waiting = [] }
            return waiting
        }
        for wait in opened { wait.resume() }
    }

    func change() {
        for reader in lock.withLock({ readers }) { reader.yield() }
    }

    func holding(_ blobs: Set<String>) async throws -> HomeLink.Holding {
        lock.withLock { HomeLink.Holding(held: blobs.intersection(held), partly: parts.filter { blobs.contains($0.key) }) }
    }

    func stage(file: HomeLink.File, source: String, from offset: Int64, kind: WriteKind, pressed: Bool,
               sent: (@Sendable (Int64) -> Void)?) async throws {
        let failure = lock.withLock { () -> LinkFailure? in
            made.append(Stage(name: file.name, source: source, offset: offset, kept: file.kept, kind: kind, pressed: pressed))
            guard var script = failures[file.name], !script.isEmpty else { return nil }
            let first = script.removeFirst()
            failures[file.name] = script
            return first
        }
        if let failure { throw failure }
        let gated = lock.withLock { () -> Bool in
            flying += 1
            most = max(most, flying)
            return gate
        }
        if gated { await withCheckedContinuation { wait in lock.withLock { waiting.append(wait) } } }
        lock.withLock {
            flying -= 1
            held.insert(file.name)
        }
    }

    func mobileChanges() -> AsyncStream<Void> {
        AsyncStream { reader in lock.withLock { readers.append(reader) } }
    }
}
