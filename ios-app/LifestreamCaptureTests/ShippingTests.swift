import Foundation
import HomeLink
import PhotoLibrary
import XCTest
@testable import Lifestream
@testable import LifestreamCaptureCore

private let hardware = DeviceHardware(machineModel: "iPhone18,1", marketingName: "Synthetic Phone", osVersion: "27.0")

@MainActor
final class Rig {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let home = Home()
    let credentials = MemoryPass()
    let warnings = Warnings()
    let store: CaptureStore
    let custody: PhoneCustody
    let clock = RigClock(Date(timeIntervalSince1970: 1_800_000_000))
    var date: Date {
        get { clock.at }
        set { clock.at = newValue }
    }
    let network = RigNetwork()
    var path: MobileData.Path {
        get { network.path }
        set { network.path = newValue }
    }
    let power = OnPower()
    var onPower: Bool {
        get { power.on }
        set { power.set(newValue) }
    }
    var long = false
    let budgets = Budgets()
    private(set) var alarms = Alarms()
    var photoPass: @MainActor (PhotoPass.Grant) async -> Void = { _ in }
    var recorder: ContactsRecorder?
    private(set) var contactsPasses: [Bool] = []
    private var contactsTaken: Date?
    var readyHeld: Home.Gate?
    private var launched: [PhoneShipper] = []
    private(set) var settled: [Int] = []
    var settingsHeld: Home.Gate?
    let ledger = EnergyLedger()
    var cleared = 0
    var uploaded = 0
    var uploadsHeld: Home.Gate?
    var settingWaits = false
    private(set) var reasons: [PhoneShipper.Reason] = []
    private(set) var readied = 0
    let measured = Measured()
    var exports: URL { custody.exporter.exportsDirectory }
    var stateURL: URL { exports.appendingPathComponent("shipper.json") }

    init(paired: Bool) async throws {
        store = try await CaptureStore.restored(root: root.appendingPathComponent("capture"))
        custody = PhoneCustody(exporter: CaptureExporter(store: store, exportsDirectory: root.appendingPathComponent("exports")))
        home.exports = custody.exporter.exportsDirectory
        ledger.attach(store)
        Home.current = home
        if paired { try await pair() }
    }

    nonisolated static let still = Pacer { _, _ in }

    var stamp: Int?
    private var device: HomeLink.Device { HomeLink.Device(kind: .phone, version: "1.0.0", model: "iPhone", serial4: nil, stamp: stamp) }

    var transport: RigTransport {
        let measured = measured, metering = ShippingService.metering(ledger, power: power)
        return RigTransport(home: home, session: URLSessionTransport(protocolClasses: [HomeProtocol.self]) { request, metrics, status in
            measured.add(request.method + " " + request.url.path)
            metering(request, metrics, status)
        })
    }

    func pair() async throws {
        _ = try await HomeLink(device: device, credentials: credentials, folder: exports, transport: transport, clock: clock.now,
                               pacer: Rig.still)
            .pair(code: "12345678", name: "https://lifestream.example.ts.net", account: Home.account)
    }

    func launch(build: BuildLife? = nil) -> PhoneShipper {
        let link = HomeLink(device: device, credentials: credentials, folder: exports, transport: transport, network: network,
                            clock: clock.now, pacer: Rig.still)
        let custody = custody
        let alarms = Alarms()
        self.alarms = alarms
        let shipper = PhoneShipper(
            stateURL: stateURL, link: link, custody: custody,
            warnings: HomeWarnings(center: warnings, build: build, now: { self.date }), now: { self.date }, hardware: { hardware },
            appVersion: "1.0.0",
            ledger: ledger,
            conditions: { PhoneShipper.Conditions(long: self.long) },
            clear: { answer in
                self.cleared += 1
                try await custody.clearImportedPhotos(answer)
            },
            settings: { answer in
                self.settled.append(answer.turn.n)
                if let held = self.settingsHeld {
                    self.settingsHeld = nil
                    try? await held.wait()
                }
                return false
            },
            settingWaits: { self.settingWaits },
            exchange: { link in try await link.exchange() },
            uploads: {
                if let held = self.uploadsHeld {
                    self.uploadsHeld = nil
                    _ = await Task { try? await held.wait() }.value
                }
                self.uploaded += 1
            },
            stopRecording: { [store] in try? await store.markStopped(at: Date()) },
            sleep: { await alarms.sleep(until: $0) },
            ready: { reason in
                self.reasons.append(reason)
                if let held = self.readyHeld {
                    self.readyHeld = nil
                    try? await held.wait()
                }
                self.readied += 1
                return true
            },
            budget: budgets.begin,
            photoPass: { await self.photoPass($0) },
            contacts: { manual in
                self.contactsPasses.append(manual)
                guard let recorder = self.recorder else {
                    self.contactsTaken = self.date
                    return .read
                }
                return await recorder.pass(manual: manual, at: self.date)
            },
            contactsStarted: {
                guard let recorder = self.recorder else { return self.contactsTaken }
                return await recorder.lastStarted
            })
        store.observe { [weak shipper] domain, entries in
            let events = entries.compactMap { SendClock.work(domain, kind: $0.kind) }
            guard !events.isEmpty else { return }
            Task { @MainActor in shipper?.appended(events) }
        }
        launched.append(shipper)
        return shipper
    }

    func stop() async {
        for shipper in launched { await shipper.stop() }
    }

    func counts() async throws -> [String: Int] {
        await ledger.flush()
        var counts: [String: Int] = [:]
        for entry in try await store.entries(domain: .energy) where entry.kind == "parts" {
            guard case .object(let fields) = entry.payload, case .object(let counted)? = fields["counts"] else { continue }
            for (name, value) in counted { if case .integer(let n) = value { counts[name, default: 0] += Int(n) } }
        }
        return counts
    }

    @discardableResult
    func capture(_ domain: CaptureDomain = .location, kind: String = "synthetic", blob: String? = nil, at: Date? = nil)
        async throws -> String {
        try await capture(domain, kind: kind, bytes: blob.map { Data($0.utf8) }, at: at)
    }

    @discardableResult
    func capture(_ domain: CaptureDomain, kind: String = "synthetic", bytes: Data?, at: Date? = nil) async throws -> String {
        var payload: [String: JSONValue] = ["event": .string("synthetic")]
        var hash = ""
        if let bytes {
            hash = try await store.storeBlob(bytes)
            payload["blob"] = .object(["hash": .string(hash)])
        }
        let captured = at ?? date
        _ = try await store.append(domain: domain, draft: .init(kind: kind, observedAt: CaptureTime.rfc3339(captured),
            captured: WallAndMonotonicTime(wall: captured), payload: .object(payload)))
        return hash
    }

    func bundleFiles() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: exports.path)) ?? [])
            .filter { $0.hasSuffix(".zip") }.sorted()
    }

    func blobs() async throws -> Set<String> {
        Set(try await store.validatedBlobInventory().map(\.hash))
    }

    func puts(_ count: Int, file: StaticString = #filePath, line: UInt = #line) async throws -> [Home.Put] {
        try await waitUntil("home.puts.count >= \(count)", file: file, line: line) { home.puts.count >= count }
        return home.puts
    }

    func puts(of source: String) -> [Home.Put] {
        home.puts.filter { $0.sources.contains(source) }
    }

    func artifact(_ name: String) throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".build/e2e/phone-sending.json")
        var all = (try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [String: Any] ?? [:]
        all[name] = [
            "sendings": try home.sendings.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) },
            "puts": home.puts.map { put -> [String: Any] in
                ["bundle": put.bundle, "bytes": put.bytes, "costly": put.crossing.costly, "lowData": put.crossing.lowData,
                 "kind": put.kind ?? "", "stopped": put.stopped]
            },
            "answered": home.answered,
            "received": home.receivedAll,
        ]
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: all, options: [.sortedKeys, .prettyPrinted]).write(to: file)
    }
}

extension PhoneShipper {
    func reconcile(_ reason: Reason) async {
        guard let send = await admit(reason) else { return }
        await withTaskCancellationHandler {
            await send.ended()
        } onCancel: {
            Task { @MainActor in send.cancel() }
        }
    }

    func admitted(_ reason: Reason, file: StaticString = #filePath, line: UInt = #line) async throws -> Send {
        let send = await admit(reason)
        return try XCTUnwrap(send, "no send was admitted", file: file, line: line)
    }
}

final class Alarms: @unchecked Sendable {
    private let lock = NSLock()
    private var sleepers: [Int: (at: Date, wake: CheckedContinuation<Void, Never>)] = [:]
    private var made = 0
    var next: Date? { lock.withLock { sleepers.values.map(\.at).min() } }
    var waits: [Date] { lock.withLock { sleepers.values.map(\.at).sorted() } }

    func sleep(until date: Date) async {
        let id = lock.withLock { () -> Int in
            made += 1
            return made
        }
        await withTaskCancellationHandler {
            await withCheckedContinuation { wake in
                let now = lock.withLock { () -> Bool in
                    if Task.isCancelled { return true }
                    sleepers[id] = (date, wake)
                    return false
                }
                if now { wake.resume() }
            }
        } onCancel: {
            lock.withLock { sleepers.removeValue(forKey: id) }?.wake.resume()
        }
    }

    func ring(_ date: Date) {
        let due = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            let due = sleepers.filter { $0.value.at <= date }
            for id in due.keys { sleepers[id] = nil }
            return due.values.map(\.wake)
        }
        for wake in due { wake.resume() }
    }
}

@MainActor
final class Budgets {
    private var expiries: [() -> Void] = []
    private var ends: [Int] = []
    var begun: Int { expiries.count }
    var ended: Int { ends.count }

    func begin(_ expired: @escaping @MainActor () -> Void) -> @MainActor () -> Void {
        let index = expiries.count
        expiries.append(expired)
        return {
            XCTAssertFalse(self.ends.contains(index), "budget \(index) ended twice")
            self.ends.append(index)
        }
    }

    func expire() {
        guard let expired = expiries.last, !ends.contains(expiries.count - 1) else { return }
        expired()
    }
}

final class Measured: @unchecked Sendable {
    private let lock = NSLock()
    private var heard: [String] = []
    var all: [String] { lock.withLock { heard } }
    func add(_ request: String) { lock.withLock { heard.append(request) } }
}

final class Events: @unchecked Sendable {
    private let lock = NSLock()
    private var said: [String] = []
    var all: [String] { lock.withLock { said } }
    func add(_ what: String) { lock.withLock { said.append(what) } }
}

final class RigNetwork: NetworkWatch, @unchecked Sendable {
    private let lock = NSLock()
    private var now = NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: true, cost: .free)
    private var readers: [UUID: AsyncStream<NetworkFacts>.Continuation] = [:]

    var facts: NetworkFacts? { lock.withLock { now } }

    var path: MobileData.Path {
        get { lock.withLock { now.cost } }
        set {
            let (facts, readers) = lock.withLock {
                now = NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: true, cost: newValue)
                return (now, Array(self.readers.values))
            }
            for reader in readers { reader.yield(facts) }
        }
    }

    func changes() -> AsyncStream<NetworkFacts> {
        AsyncStream { continuation in
            let id = UUID()
            let first = lock.withLock { () -> NetworkFacts in
                readers[id] = continuation
                return now
            }
            continuation.onTermination = { [weak self] _ in self?.drop(id) }
            continuation.yield(first)
        }
    }

    private func drop(_ id: UUID) {
        lock.withLock { readers[id] = nil }
    }
}

struct RigTransport: HomeTransport {
    let home: Home
    let session: URLSessionTransport

    func perform(_ request: HomeRequest) async throws -> HomeResponse {
        request.method == "PUT" ? try await session.perform(request) : try await home.perform(request)
    }

    func stream(_ request: HomeRequest) async throws -> HomeStream { try await home.stream(request) }

    func fingerprint(of address: URL, within seconds: TimeInterval) async throws -> String {
        try await home.fingerprint(of: address, within: seconds)
    }
}

@MainActor
final class ShippingTests: XCTestCase {
    private func rig(paired: Bool = true) async throws -> Rig {
        let rig = try await Rig(paired: paired)
        addTeardownBlock { @MainActor in
            await rig.stop()
            Home.current = nil
            try? FileManager.default.removeItem(at: rig.root)
        }
        return rig
    }

    private func outcomes(_ rig: Rig) async throws -> [String] {
        try await rig.store.entries(domain: .location).compactMap { entry in
            guard case .object(let fields) = entry.payload, fields["event"] == .string("shipping"),
                  case .string(let outcome)? = fields["outcome"] else { return nil }
            return outcome
        }
    }

    private static let megabyte = 1_000_000


    func testABackgroundSendReachesTheHomeDirectAndTheNextSealsWhatIsNew() async throws {
        let rig = try await rig(); try await rig.capture()
        let shipper = rig.launch()
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.received(Home.location), 1, "the send itself reached the home")
        XCTAssertEqual(shipper.pending, [], "delivered, and gone")
        XCTAssertEqual(rig.bundleFiles(), [])
        XCTAssertEqual(shipper.state.outcome, .shipped)
        XCTAssertEqual(rig.measured.all.filter { $0.hasPrefix("PUT ") }.count, 1, "the transport's metrics reached the app")

        try await rig.capture()
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.received(Home.location), 2)
        XCTAssertEqual(rig.home.puts.map(\.crossing), [.any, .any], "small bundles take any network")
        XCTAssertEqual(rig.home.puts.map(\.kind), ["new", "new"], "what the phone records is new: lost if it is not sent")
        let recorded = try await outcomes(rig)
        XCTAssertEqual(recorded, ["shipped"], "noted once: the outcome did not change kind")
        try rig.artifact("direct")
    }

    func testANineMegabytePhotosBundleAndTheSharedOneGoSideBySideAndLandInEitherOrder() async throws {
        let rig = try await rig()
        try await rig.capture()
        let photo = try await rig.capture(.photos, bytes: Data(repeating: 0x70, count: 9 * Self.megabyte))
        rig.home.holding = true
        rig.long = true
        let shipper = rig.launch()
        let sending = Task { await shipper.reconcile(.wake) }
        let puts = try await rig.puts(2)
        let pending = shipper.pending
        XCTAssertEqual(pending.map(\.seals), [[Home.location: 1], [Home.photos: 1]], "location shares; 9 MB of photos goes alone")
        XCTAssertEqual(Set(puts.map(\.bundle)), Set(pending.map(\.id)), "both requests run at once")
        let location = try XCTUnwrap(rig.puts(of: Home.location).first, "location's request")
        let photos = try XCTUnwrap(rig.puts(of: Home.photos).first, "the photos request")
        photos.answer(.take)
        try await until("photos delivered") { rig.home.received(Home.photos) == 1 }
        location.answer(.take)
        await sending.value
        XCTAssertEqual(rig.home.received(Home.location), 1)
        XCTAssertEqual(shipper.pending, [])
        XCTAssertEqual(rig.home.answered, [pending[1].id, pending[0].id], "landed in the other order")
        let held = try await rig.blobs()
        XCTAssertEqual(held, [photo], "received is not imported: the copy stays")
        try rig.artifact("side-by-side")
    }

    func testALocationSendStartsAndLandsWhileAPhotoUploadIsHeld() async throws {
        let rig = try await rig()
        try await rig.capture(.photos, bytes: Data(repeating: 0x77, count: 9 * Self.megabyte))
        rig.long = true
        rig.home.holdingWhen = { custody in custody.keys.contains(Home.photos) }
        let shipper = rig.launch()
        shipper.tell(.visit)
        try await until("the clock set its timer") { rig.alarms.next != nil }
        rig.alarms.ring(rig.date)
        let puts = try await rig.puts(1)
        XCTAssertEqual(rig.home.receivedAll, [:], "the photo upload is held")

        try await rig.capture()
        rig.date.addTimeInterval(60)
        shipper.tell(.visit)
        try await until("the visit is due") { rig.alarms.next == rig.date }
        rig.alarms.ring(rig.date)
        try await until("location landed") { rig.home.received(Home.location) == 1 }
        XCTAssertEqual(rig.home.received(Home.photos), 0, "beside the held upload, which still runs")
        XCTAssertFalse(puts[0].stopped)
        XCTAssertEqual(rig.reasons, [.wake, .wake])
        puts[0].answer(.take)
        try await until("the photos bundle settled on the phone, both sends ended") {
            rig.budgets.ended == 2 && shipper.pending.isEmpty
        }
        XCTAssertEqual(rig.home.received(Home.photos), 1)
        try rig.artifact("beside-a-held-upload")
    }

    func testABundleOfTenMegabytesWaitsForALongWakeAndOneOfFiftyAsksTheModuleOnEachPathButShipNowMovesIt() async throws {
        let rig = try await rig()
        try await rig.capture(.photos, bytes: Data(repeating: 0x71, count: 10 * Self.megabyte))
        let shipper = rig.launch()
        await shipper.reconcile(.wake)
        XCTAssertEqual(shipper.pending.count, 1, "sealed alone")
        XCTAssertTrue(rig.home.puts.isEmpty, "a short wake starts no bundle of 8 MB or more")
        XCTAssertEqual(shipper.state.outcome, .waiting)
        let unsent = await shipper.unsent()
        XCTAssertEqual(unsent, PhoneShipper.Unsent(), "a bundle that waits for a long wake is no work for the clock")
        XCTAssertEqual(shipper.waits, [.longWake])
        XCTAssertEqual(shipper.shippingDescription, "Large sends wait until this iPhone charges or the app is open.")
        rig.long = true
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.received(Home.photos), 1, "a wake that is long sends it")

        try await rig.capture(.photos, bytes: Data(repeating: 0x72, count: 50 * Self.megabyte))
        rig.path = .lowData
        await shipper.reconcile(.foreground)
        XCTAssertEqual(rig.puts(of: Home.photos).count, 1, "50 MB waits while Low Data Mode is on")
        XCTAssertEqual(shipper.waits, [.network(.lowData)])
        XCTAssertEqual(shipper.shippingDescription, MobileData.Wait.lowData.words, "Your home's line for the network, alone")
        let waiting = await shipper.unsent()
        XCTAssertTrue(waiting.waitsForNetwork, "the clock sends once the path or the choice changes")
        rig.long = false
        _ = await shipper.unsent()
        XCTAssertEqual(shipper.waits, [.longWake, .network(.lowData)])
        XCTAssertEqual(shipper.shippingDescription,
                       "Large sends wait until this iPhone charges or the app is open.\n" + MobileData.Wait.lowData.words)
        rig.long = true
        rig.path = .costly
        await shipper.reconcile(.foreground)
        XCTAssertEqual(rig.puts(of: Home.photos).count, 2, "what the phone records goes over mobile data at any size")
        XCTAssertEqual(rig.puts(of: Home.photos).last?.crossing, MobileData.Crossing(costly: true, lowData: false),
                       "its request may not cross onto Low Data Mode, so no change of path moves it onto one")
        XCTAssertEqual(rig.home.received(Home.photos), 2)

        try await rig.capture(.photos, bytes: Data(repeating: 0x73, count: 50 * Self.megabyte))
        rig.path = .lowData
        await shipper.reconcile(.manual)
        XCTAssertEqual(rig.puts(of: Home.photos).last?.crossing, .any, "the person pressed it")
        XCTAssertEqual(rig.puts(of: Home.photos).last?.kind, "new")
        XCTAssertEqual(rig.home.received(Home.photos), 3)
        try rig.artifact("by-size")
    }


    func testARequestTheWakesEndCancelsLeavesTheBundleInFlightAndItIsSentAgainFirst() async throws {
        let rig = try await rig()
        try await rig.capture(at: rig.date.addingTimeInterval(-SendClock.SETTLED_S))
        rig.home.holding = true
        let shipper = rig.launch()
        let wake = Task { await shipper.reconcile(.wake) }
        let puts = try await rig.puts(1)
        wake.cancel()
        await wake.value
        try await until("the request was stopped") { puts[0].stopped }
        let kept = try XCTUnwrap(shipper.pending.first)
        XCTAssertEqual(shipper.pending.count, 1, "what was in flight stays in flight")
        XCTAssertEqual(kept.last?.answered, false, "its request had no answer")
        XCTAssertEqual(shipper.clock.next, rig.date.addingTimeInterval(SendClock.BACKOFF_FIRST_S),
                       "the clock hears a send with no answer, and backs off")
        XCTAssertEqual(shipper.state.outcome, .unreachable)

        try await rig.capture()
        let retry = try await shipper.admitted(.wake)
        await retry.passed()
        let again = try await rig.puts(2)
        XCTAssertEqual(again.map(\.bundle), [kept.id, kept.id], "the same bundle, sent again first")
        XCTAssertEqual(shipper.pending.map(\.id), [kept.id], "a source in flight seals nothing more")
        rig.home.holding = false
        again[1].answer(.take)
        await retry.ended()
        XCTAssertEqual(rig.home.received(Home.location), 1)
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.received(Home.location), 2, "what was new since goes in the next send")
    }

    func testAWakeThatEndsDuringTheExchangeSealsNothingAndStartsNoRequest() async throws {
        let rig = try await rig()
        try await rig.capture(at: rig.date.addingTimeInterval(-SendClock.SETTLED_S))
        let shipper = rig.launch()
        let gate = rig.home.holdExchange()
        let send = try await shipper.admitted(.foreground)
        try await until("the exchange is answered and held") { gate.waiting }
        send.cancel()
        await send.ended()
        XCTAssertFalse(gate.waiting, "cancelling the send released its exchange")
        XCTAssertEqual(rig.home.puts.count, 0, "no request starts after its wake ended")
        XCTAssertEqual(shipper.pending, [], "and nothing is sealed")
        XCTAssertEqual(shipper.clock.next, rig.date.addingTimeInterval(SendClock.BACKOFF_FIRST_S), "the clock backs off")

        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.exchanges, 2, "the next exchange, still owed, waited behind nothing")
        XCTAssertEqual(rig.home.received(Home.location), 1, "the next send carries it")
    }

    func testAnAnswerLostAfterTheDoorSealedIsRecoveredByTheNextPut() async throws {
        let rig = try await rig(); try await rig.capture()
        rig.home.replying = { _ in .takeThenDrop }
        let shipper = rig.launch()
        await shipper.reconcile(.wake)
        let lost = try XCTUnwrap(shipper.pending.first, "no answer came: still in flight")
        XCTAssertEqual(rig.home.received(Home.location), 1, "the door took it")
        rig.home.replying = nil
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.puts.map(\.bundle), [lost.id, lost.id], "the same id, never a reseal")
        XCTAssertEqual(rig.home.statuses.last, 200, "the door answers the bundle it holds 200, with its answer")
        XCTAssertEqual(shipper.pending, [])
        XCTAssertEqual(rig.home.received(Home.location), 1)
    }

    func testUploadActiveAndA5xxAreNotYetAndTheClockBacksOff() async throws {
        let rig = try await rig()
        let overdue = rig.date.addingTimeInterval(-SendClock.SETTLED_S)
        try await rig.capture(at: overdue)
        rig.home.replying = { _ in .refuse(409, "UPLOAD_ACTIVE") }
        let shipper = rig.launch()
        await shipper.reconcile(.wake)
        let waiting = try XCTUnwrap(shipper.pending.first)
        XCTAssertEqual(waiting.last?.code, "UPLOAD_ACTIVE")
        XCTAssertEqual(shipper.clock.next, rig.date.addingTimeInterval(SendClock.BACKOFF_FIRST_S),
                       "not an answer: the clock backs off a minute")

        rig.home.replying = { _ in .refuse(503, "HOME_MOVING") }
        rig.date.addTimeInterval(60)
        await shipper.reconcile(.wake)
        XCTAssertEqual(shipper.pending.map(\.id), [waiting.id], "the home not ready: the bundle stays")
        XCTAssertEqual(shipper.state.outcome, .held("HOME_MOVING"), "a 5xx but not now is the home's own reason")
        XCTAssertNil(shipper.state.sending.sources[Home.location], "not yet is no refusal")
        XCTAssertEqual(shipper.clock.next, rig.date.addingTimeInterval(2 * SendClock.BACKOFF_FIRST_S), "then two")

        rig.home.replying = nil
        rig.date.addTimeInterval(60)
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.puts.map(\.bundle), [waiting.id, waiting.id, waiting.id])
        XCTAssertEqual(shipper.pending, [])
        try await rig.capture(at: overdue)
        await shipper.prime()
        XCTAssertEqual(shipper.clock.next, rig.date.addingTimeInterval(SendClock.FLOOR_S), "an answered send ends the backoff")
    }

    func testABusyBundleWaitsTheDoorsRetryAfterThroughEventsAndShipNowSendsIt() async throws {
        let rig = try await rig()
        try await rig.capture(at: rig.date.addingTimeInterval(-SendClock.SETTLED_S))
        rig.home.replying = { _ in .busy(retryAfter: 60) }
        let shipper = rig.launch()
        await shipper.reconcile(.wake)
        let busy = try XCTUnwrap(shipper.pending.first)
        XCTAssertEqual(busy.last?.code, "UPLOAD_ACTIVE")
        let deadline = rig.date.addingTimeInterval(60)
        XCTAssertEqual(shipper.clock.next, deadline, "the door's Retry-After")

        rig.date.addTimeInterval(30)
        shipper.tell(.visit)
        XCTAssertEqual(shipper.clock.next, deadline, "an event at 30 s waits for it")
        shipper.tell(.network)
        XCTAssertEqual(shipper.clock.next, deadline, "so does a change of network")
        XCTAssertEqual(rig.home.puts.count, 1)

        rig.home.replying = nil
        await shipper.shipNow()
        XCTAssertEqual(rig.home.puts.map(\.bundle), [busy.id, busy.id], "the person pressed it: the same bundle, now")
        XCTAssertEqual(shipper.pending, [])
        XCTAssertEqual(rig.home.received(Home.location), 1)
    }


    func testAnExchangeOlderByTurnThatLandsAfterAPutIsNotSavedAndTheNextSealIsStillTheNext() async throws {
        let rig = try await rig(); try await rig.capture()
        rig.home.holding = true
        let shipper = rig.launch()
        let send = Task { await shipper.reconcile(.wake) }
        let puts = try await rig.puts(1)
        let gate = rig.home.holdExchange()
        let beside = Task { try await shipper.link.exchange() }
        try await until("the exchange is answered and held") { gate.waiting }
        puts[0].answer(.take)
        await send.value
        XCTAssertEqual(shipper.link.saved?.sources[Home.location]?.received, 1)
        gate.open()
        let late = try await beside.value
        XCTAssertEqual(late.sources[Home.location]?.received, 1, "the older answer is handed back the newer")
        XCTAssertEqual(shipper.link.saved?.sources[Home.location]?.received, 1, "and never saved")

        rig.home.holding = false
        try await rig.capture()
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.statuses.last, 201, "the next seal is the next one: no STALE")
        XCTAssertEqual(rig.home.received(Home.location), 2)
        try rig.artifact("older-turn")
    }

    func testAnAnswerHeldInItsApplicationGivesWayToTheNewerOneThatLandsMeanwhile() async throws {
        let rig = try await rig(); try await rig.capture()
        rig.home.holding = true
        let shipper = rig.launch()
        let first = try await shipper.admitted(.wake)
        let puts = try await rig.puts(1)
        rig.home.holding = false
        let held = Home.Gate()
        rig.settingsHeld = held
        let foreground = try await shipper.admitted(.foreground)
        try await until("the foreground's answer was taken and its application held") { held.waiting }
        let older = try XCTUnwrap(shipper.link.fresh?.turn.n)
        puts[0].answer(.take)
        try await until("seal 1's answer was taken") { shipper.link.fresh?.turn.n != older }
        let newer = try XCTUnwrap(shipper.link.fresh?.turn.n)
        try await rig.capture()
        held.open()
        await first.ended()
        await foreground.ended()
        XCTAssertEqual(rig.settled, rig.settled.sorted(), "never an older answer's settings after a newer one's")
        XCTAssertEqual(rig.settled.filter { $0 == older || $0 == newer }, [older, newer], "the held one first, then seal 1's")
        XCTAssertEqual(rig.settled.last, shipper.link.fresh?.turn.n, "the newest answer's settings stand")
        XCTAssertEqual(rig.home.statuses, [201, 201], "the pass sealed 2 from the newest answer: no STALE")
        XCTAssertEqual(rig.home.received(Home.location), 2, "the new entry is carried, not dropped")
        XCTAssertEqual(shipper.pending, [])
        try rig.artifact("held-application")
    }

    func testABundleCutOffIsNotDroppedOnAStaleAnswerUntilItsOwnIDIsAnswered() async throws {
        let rig = try await rig(); try await rig.capture()
        let shipper = rig.launch()
        await shipper.reconcile(.wake)
        try await rig.capture()
        rig.home.holding = true
        let wake = Task { await shipper.reconcile(.wake) }
        let puts = try await rig.puts(2)
        wake.cancel()
        await wake.value
        try await until("the request was stopped") { puts[1].stopped }
        let cut = try XCTUnwrap(shipper.pending.first)
        XCTAssertEqual(cut.seals, [Home.location: 2])

        rig.home.restore()
        rig.home.holding = true
        let foreground = Task { await shipper.reconcile(.foreground) }
        let again = try await rig.puts(3)
        XCTAssertEqual(again[2].bundle, cut.id, "the exchange's stale answer does not drop it: it is sent again first")
        XCTAssertEqual(shipper.pending.map(\.id), [cut.id], "and nothing is sealed over it")
        rig.home.holding = false
        again[2].answer(.take)
        await foreground.value
        XCTAssertEqual(rig.home.statuses.suffix(2), [409, 201], "its own id answered STALE, then resealed once in the send")
        XCTAssertEqual(rig.home.received(Home.location), 1, "the whole history again, from the home's 0")
        XCTAssertEqual(shipper.pending, [])
        try rig.artifact("cut-off")
    }

    func testAStaleSavedAnswerResealsOnceThroughThe409() async throws {
        let rig = try await rig(); try await rig.capture()
        let shipper = rig.launch()
        await shipper.reconcile(.wake)
        try await rig.capture()
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.received(Home.location), 2)
        rig.home.restore()
        try await rig.capture()
        let exchanges = rig.home.exchanges
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.exchanges, exchanges, "no exchange owed: the seal is from the saved answer")
        XCTAssertEqual(rig.home.statuses.suffix(2), [409, 201], "seal 3 refused STALE, its answer seals again: seal 1")
        XCTAssertEqual(rig.home.received(Home.location), 1)
        XCTAssertEqual(shipper.pending, [])

        rig.home.restore()
        rig.home.alwaysStale = true
        try await rig.capture()
        let before = rig.home.puts.count
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.puts.count - before, 2, "once")
    }

    func testTwoStaleBundlesInOneSendResealOnceAfterBothRequestsEnd() async throws {
        let rig = try await rig()
        rig.long = true
        try await rig.capture()
        try await rig.capture(.photos, bytes: Data(repeating: 0x78, count: 9 * Self.megabyte))
        let shipper = rig.launch()
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.receivedAll[Home.location], 1)
        XCTAssertEqual(rig.home.receivedAll[Home.photos], 1)
        rig.home.restore()
        try await rig.capture()
        try await rig.capture(.photos, bytes: Data(repeating: 0x79, count: 9 * Self.megabyte))
        rig.home.holding = true
        let before = rig.home.puts.count
        let send = try await shipper.admitted(.wake)
        let puts = try await rig.puts(before + 2)
        puts[before].answer(.take)
        try await until("the first STALE settled") { shipper.pending.count == 1 }
        XCTAssertEqual(rig.home.puts.count, before + 2, "no reseal while the other request runs")
        rig.home.holding = false
        puts[before + 1].answer(.take)
        await send.ended()
        XCTAssertEqual(Array(rig.home.statuses.suffix(4)), [409, 409, 201, 201], "both STALE, then one reseal of both")
        XCTAssertEqual(rig.home.puts.count, before + 4)
        XCTAssertEqual(rig.home.received(Home.location), 1)
        XCTAssertEqual(rig.home.received(Home.photos), 1)
        XCTAssertEqual(shipper.pending, [])
    }

    func testARefusedPhotosBundleStatesPhotosAloneAndAFailingPhotoPassOutlastsADelivery() async throws {
        let rig = try await rig()
        try await rig.capture()
        try await rig.capture(.photos, bytes: Data(repeating: 0x74, count: 9 * Self.megabyte))
        rig.home.replying = { custody in custody.keys.contains(Home.photos) ? .refuse(422, "IOS_BUNDLE_HASH_MISMATCH") : .take }
        rig.long = true
        let shipper = rig.launch()
        await shipper.reconcile(.processing)
        XCTAssertEqual(rig.home.received(Home.location), 1)
        XCTAssertEqual(shipper.state.sending.sources[Home.photos]?.code, "IOS_BUNDLE_HASH_MISMATCH", "the refusal is Photos'")
        XCTAssertNil(shipper.state.sending.sources[Home.location], "location delivered: nothing of it is failing")
        XCTAssertNil(shipper.state.sending.send, "nothing every source shares failed")
        let refusal = try XCTUnwrap(shipper.state.sending.sources[Home.photos])

        try await rig.capture()
        rig.date.addTimeInterval(60)
        await shipper.reconcile(.foreground)
        XCTAssertEqual(shipper.state.sending.sources[Home.photos], refusal)
        XCTAssertEqual(rig.home.sending?.sources[Home.photos], refusal)
        XCTAssertEqual(shipper.pending.count, 1, "the refused bundle waits its hour")

        rig.home.replying = nil
        shipper.read(.photos, .failed("PhotoKit refused the read"))
        try await rig.capture(.photos, blob: "a small photo")
        rig.date.addTimeInterval(3600)
        await shipper.reconcile(.processing)
        XCTAssertEqual(rig.home.received(Home.photos), 1)
        XCTAssertEqual(shipper.state.sending.sources[Home.photos]?.code, "PHOTOS", "a delivery never ends a photo pass's failure")
        try rig.artifact("refused-photos")
    }


    func testAHeldBundleIsNeverResealedAndWaitsAQuarterOfAnHour() async throws {
        let rig = try await rig(); try await rig.capture()
        rig.home.replying = { _ in .refuse(422, "CLOCK_AHEAD") }
        let shipper = rig.launch()
        await shipper.reconcile(.wake)
        let held = try XCTUnwrap(shipper.pending.first)
        XCTAssertEqual(shipper.state.outcome, .held("CLOCK_AHEAD"))
        XCTAssertEqual(shipper.shippingDescription?.hasPrefix("This iPhone's clock is ahead"), true)
        XCTAssertEqual(shipper.state.sending.sources[Home.location]?.code, "CLOCK_AHEAD")

        for _ in 0..<3 {
            rig.date.addTimeInterval(4 * 60)
            try await rig.capture()
            await shipper.reconcile(.foreground)
            XCTAssertEqual(shipper.pending.map(\.id), [held.id])
        }
        XCTAssertEqual(rig.home.puts.count, 1)
        let deadline = try XCTUnwrap(shipper.pending.first?.last).at.addingTimeInterval(HomeLink.Outbox.Wait.clockAhead.seconds)
        let unsent = await shipper.unsent()
        XCTAssertNil(unsent.other, "the clock owes a held source nothing within its wait")
        XCTAssertEqual(unsent.heldUntil, deadline, "but its wait's end")

        rig.home.replying = nil
        await shipper.prime()
        try await until("the clock set its timer") { rig.alarms.next != nil }
        XCTAssertEqual(rig.alarms.next, deadline)
        rig.date = deadline
        rig.alarms.ring(rig.date)
        try await until("the held bundle was sent again") { rig.home.puts.count == 2 }
        try await until("it was taken, its send ended") { shipper.pending.isEmpty && rig.budgets.ended == 5 }
        XCTAssertEqual(rig.home.puts.map(\.bundle), [held.id, held.id])
        XCTAssertEqual(rig.reasons, [.wake, .foreground, .foreground, .foreground, .wake], "the clock's own send last")
        XCTAssertNil(shipper.state.sending.sources[Home.location], "its delivery ends the hold")
    }

    func testABundleRefusedForItsBytesGoesAfterItsHourAndItsSourcesSealAgain() async throws {
        let rig = try await rig(); try await rig.capture()
        rig.home.replying = { _ in .refuse(422, "IOS_BUNDLE_HASH_MISMATCH") }
        let shipper = rig.launch()
        await shipper.reconcile(.wake)
        let refused = try XCTUnwrap(shipper.pending.first)
        let failure = try XCTUnwrap(shipper.state.sending.sources[Home.location])
        XCTAssertEqual(failure.code, "IOS_BUNDLE_HASH_MISMATCH")

        rig.date.addTimeInterval(15 * 60)
        await shipper.reconcile(.foreground)
        XCTAssertEqual(rig.home.sending?.sources[Home.location]?.code, "IOS_BUNDLE_HASH_MISMATCH", "the exchange states it")
        XCTAssertEqual(shipper.pending.map(\.id), [refused.id], "within the hour it waits")

        rig.home.replying = nil
        rig.date.addTimeInterval(46 * 60)
        try await rig.capture()
        await shipper.reconcile(.wake)
        XCTAssertFalse(rig.home.puts.map(\.bundle).dropFirst().contains(refused.id), "an hour on, the refused bytes go")
        XCTAssertFalse(rig.bundleFiles().contains(refused.file))
        XCTAssertEqual(rig.home.received(Home.location), 1, "its seals still the next ones")
        XCTAssertNil(shipper.state.sending.sources[Home.location], "a bundle the door took ends it")
        try rig.artifact("refused-bytes")
    }


    func testASendExchangesOnlyWhenOwedAndCarriesAChangedSendingOnce() async throws {
        let rig = try await rig(); try await rig.capture()
        let shipper = rig.launch()
        await shipper.reconcile(.wake)
        let first = rig.home.exchanges
        XCTAssertEqual(first, 1, "the launch's first send carries what the last process stated")
        for _ in 0..<3 {
            try await rig.capture()
            rig.date.addTimeInterval(60)
            await shipper.reconcile(.wake)
        }
        XCTAssertEqual(rig.home.exchanges, first, "a send needs no exchange: each PUT is answered with the answer")
        XCTAssertEqual(rig.home.received(Home.location), 4)

        shipper.read(.contacts, .failed("the address book did not read"))
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.exchanges, first + 1, "a changed sending is owed")
        XCTAssertEqual(rig.home.sending?.sources[Home.contacts]?.code, "LOCAL_ACCESS")
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.exchanges, first + 1, "carried once")

        rig.settingWaits = true
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.exchanges, first + 2, "a setting that waits is owed")
        rig.settingWaits = false
        await shipper.reconcile(.foreground)
        XCTAssertEqual(rig.home.exchanges, first + 3, "the person is there")
    }


    func testAnExportSharesClonesThatOutliveTheDelivery() async throws {
        let rig = try await rig()
        try await rig.capture()
        try await rig.capture(.photos, bytes: Data(repeating: 0x75, count: 9 * Self.megabyte))
        rig.long = true
        let shipper = rig.launch()
        let copies = try await shipper.export()
        XCTAssertEqual(copies.count, 2, "every bundle in flight: the shared one and photos' own")
        try await until("the export's send delivered both, and ended under its budget") {
            rig.home.received(Home.location) == 1 && rig.home.received(Home.photos) == 1 && rig.budgets.ended == 1
        }
        XCTAssertEqual(rig.budgets.begun, 1)
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.bundleFiles(), [], "the delivered bundles' own files are gone")
        for copy in copies {
            XCTAssertFalse(try StoredZIPWriter.readManifest(from: copy).custody.isEmpty, "the person's copy still reads")
        }
        try rig.artifact("export")
    }

    func testExportWithNoHomeIsTheCopyAndPairedWorksWithTheHomeUnreachable() async throws {
        let rig = try await rig(paired: false)
        try await rig.capture(at: rig.date.addingTimeInterval(-SendClock.SETTLED_S))
        let unpaired = rig.launch()
        await unpaired.reconcile(.wake)
        XCTAssertEqual(unpaired.state.outcome, .noHome)
        let copy = try await unpaired.export()
        XCTAssertTrue(try StoredZIPWriter.readManifest(from: try XCTUnwrap(copy.first)).custody.isEmpty, "the person's copy")
        XCTAssertEqual(rig.home.exchanges, 0)
        XCTAssertEqual(unpaired.pending, [])

        try await rig.pair()
        rig.home.silent = true
        rig.home.replying = { _ in .fail }
        let shipper = rig.launch()
        let exported = try await shipper.export()
        XCTAssertEqual(exported.map(\.lastPathComponent), shipper.pending.map(\.file))
        XCTAssertEqual(shipper.pending.map(\.seals), [[Home.location: 1]], "from the saved answer's received")
        try await until("the export's send ended under its budget") { rig.budgets.ended == 2 }
        XCTAssertEqual(shipper.clock.next, rig.date.addingTimeInterval(SendClock.BACKOFF_FIRST_S),
                       "its request unanswered: the clock backs off")
    }


    func testALibraryChangeInTheBackgroundMakesAPhotoPassWhoseBundleIsSent() async throws {
        let rig = try await rig()
        let synthetic = SyntheticLibrary()
        let library = PhotoLibrary(synthetic)
        let pass = PhotoPass(store: rig.store, library: library,
                             stateURL: rig.root.appendingPathComponent("photos/cursor.json"), build: "1 aaaaaaa")
        let shipper = rig.launch()
        var passes = 0
        rig.photoPass = { grant in
            let report = await pass.run(grant, device: PhotosTests.wifi, bringingIn: false, home: await .of(shipper))
            shipper.photoPass(report)
            passes += 1
        }
        library.observe { Task { @MainActor in shipper.libraryChanged() } }
        let first = Task { await shipper.send(.foreground) }
        try await until("the clock set its timer") { rig.alarms.next != nil }
        rig.alarms.ring(rig.date)
        await first.value
        try await until("the backstop's pass ran") { passes == 1 }

        rig.date.addTimeInterval(PhoneShipper.photoGap)
        synthetic.put(PhotosTests.photo("NEW/L0/001", minutes: 0))
        try await until("the change's pass ran and the clock set its timer") { passes == 2 && rig.alarms.next != nil }
        rig.alarms.ring(rig.date)
        try await until("the photo reached the home") { rig.home.received(Home.photos) == 1 && shipper.pending.isEmpty }
        XCTAssertEqual(passes, 2, "one pass for the change")
        let unsent = await shipper.unsent()
        XCTAssertNil(unsent.other, "the home holds every photos entry")
        let entries = try await rig.store.entries(domain: .photos)
        XCTAssertTrue(entries.contains { $0.captureReplayKey?.hasPrefix("photos:NEW/L0/001:") == true })
        try rig.artifact("photos-background")
    }


    func testAReplacedInstallStopsShipsHandsOverAndStaysHandedOver() async throws {
        let rig = try await rig()
        try await rig.capture()
        rig.home.replaced = "2026-10-14T06:36:19.071Z"
        let shipper = rig.launch()
        await shipper.reconcile(.foreground)
        let stopped = await rig.store.isStopped
        XCTAssertTrue(stopped, "the first answer that says replaced stops the store")
        XCTAssertEqual(rig.home.received(Home.location), 1, "what it held ships")
        await shipper.reconcile(.foreground)
        XCTAssertNotEqual(shipper.state.outcome, .handedOver, "received is not imported: no drained yet")
        XCTAssertFalse(rig.home.revoked)

        rig.home.importAll()
        await shipper.reconcile(.foreground)
        XCTAssertEqual(shipper.state.outcome, .handedOver)
        XCTAssertEqual(shipper.lifecycle, .handedOver)
        XCTAssertTrue(rig.home.revoked)
        XCTAssertNil(shipper.sendFailure)
        let kept = try JSONDecoder.lifestream().decode(ShipperState.self, from: Data(contentsOf: rig.stateURL))
        XCTAssertEqual(kept.outcome, .handedOver, "the record says so")

        let asked = rig.home.exchanges, begun = rig.budgets.begun
        let relaunched = rig.launch()
        XCTAssertEqual(relaunched.lifecycle, .handedOver, "a launch reads the hand-over from the record")
        await relaunched.reconcile(.foreground)
        await relaunched.reconcile(.manual)
        XCTAssertEqual(relaunched.state.outcome, .handedOver)
        XCTAssertEqual(rig.home.exchanges, asked, "handed over, it asks the home nothing")
        XCTAssertEqual(rig.budgets.begun, begun, "no send is admitted once handed over")
        XCTAssertEqual(relaunched.clock, SendClock(), "and the clock hears nothing of one")
        try await relaunched.unpair()
        XCTAssertNotNil(try relaunched.link.name(), "Unpair does nothing once handed over")
        await relaunched.refused("PRINCIPAL_UNKNOWN")
        XCTAssertEqual(relaunched.state.outcome, .handedOver, "no other outcome is noted")
        XCTAssertTrue(relaunched.handedOver)
        XCTAssertNotNil(relaunched.saved?.replaced, "and the screen still reads it was replaced")
    }

    func testOnlyA200ToDrainedHandsOverNeverA401() async throws {
        let rig = try await rig()
        rig.home.replaced = "2026-10-14T06:36:19.071Z"
        rig.home.importAll()
        rig.home.loseDrainedAnswer = true
        let shipper = rig.launch()
        await shipper.reconcile(.foreground)
        XCTAssertTrue(rig.home.revoked)
        XCTAssertEqual(shipper.state.outcome, .unreachable, "drained's answer never came")
        await shipper.reconcile(.foreground)
        XCTAssertEqual(shipper.state.outcome, .passRefused, "a 401 is no hand-over")
        XCTAssertTrue(shipper.paired, "the pass is kept")
        XCTAssertNotNil(shipper.saved?.replaced)
    }


    func testA401KeepsEverythingAndAHomeThatTakesThePassAgainIsShippedTo() async throws {
        let rig = try await rig()
        try await rig.capture(at: rig.date.addingTimeInterval(-SendClock.SETTLED_S))
        rig.home.holding = true
        let shipper = rig.launch()
        let send = Task { await shipper.reconcile(.wake) }
        let puts = try await rig.puts(1)
        let sealed = try XCTUnwrap(shipper.pending.first)
        rig.home.refusePass()
        puts[0].answer(.refuse(401, "PRINCIPAL_UNKNOWN"))
        await send.value
        rig.home.holding = false
        XCTAssertEqual(shipper.state.outcome, .passRefused)
        XCTAssertEqual(shipper.link.snapshot.reach, .passRefused, "reach says it, whose banner offers Pair again")
        XCTAssertEqual(shipper.homeName, "lifestream", "and the home is still named")
        XCTAssertNotNil(shipper.link.saved)
        XCTAssertEqual(shipper.pending.map(\.id), [sealed.id])
        let paired = await rig.store.isPaired
        XCTAssertTrue(paired)

        rig.date.addTimeInterval(60)
        await shipper.reconcile(.wake)
        XCTAssertEqual(shipper.state.outcome, .passRefused)
        XCTAssertEqual(rig.home.puts.count, 1, "nothing is sent while refused")
        XCTAssertEqual(shipper.clock.next, rig.date.addingTimeInterval(2 * SendClock.BACKOFF_FIRST_S), "and the clock backs off")

        rig.home.takeBack()
        rig.date.addTimeInterval(60)
        rig.home.holding = true
        let again = try await shipper.admitted(.wake)
        await again.passed()
        let resent = try await rig.puts(2)
        rig.home.holding = false
        resent[1].answer(.take)
        await again.ended()
        XCTAssertEqual(rig.home.puts.map(\.bundle), [sealed.id, sealed.id], "the same bundle, under the same pass")
        XCTAssertEqual(rig.home.received(Home.location), 1)
        let outcomes = try await outcomes(rig)
        XCTAssertFalse(outcomes.contains("no_home"), "never unpaired")
        XCTAssertFalse(outcomes.contains { $0.hasPrefix("held ") }, "a 401 refuses the pass, never holds the bundle")
    }

    func testARefusedRestoreIsShownAsTheRefusalAndPairAgainEndsIt() async throws {
        let rig = try await rig()
        let shipper = rig.launch()
        rig.home.refusePass()
        do {
            _ = try await shipper.link.restore()
            XCTFail("the home refuses the pass")
        } catch LinkFailure.refused(401, let code, _) {
            await shipper.refused(code)
        }
        XCTAssertEqual(shipper.state.outcome, .passRefused)
        XCTAssertNil(shipper.shippingDescription, "a refused pass is reach's: the banner says it, and Last send nothing")
        XCTAssertEqual(rig.launch().state.outcome, .passRefused, "the refusal is the shipper's record, kept across a launch")
        try await rig.pair()
        await shipper.reconcile(.manual)
        XCTAssertNotEqual(shipper.state.outcome, .passRefused, "the home answered the new pass")
    }

    func testPairAgainFromARefusalReplacesThePassOnlyOnTheHomesAnswer() async throws {
        let rig = try await rig(); try await rig.capture()
        let shipper = rig.launch()
        rig.home.refusePass()
        await shipper.reconcile(.foreground)
        XCTAssertEqual(shipper.state.outcome, .passRefused)
        do {
            _ = try await shipper.link.pair(code: "87654321", name: "https://lifestream.example.ts.net", account: Home.account)
            XCTFail("a wrong code is refused")
        } catch LinkFailure.refused(403, "PAIR_CODE", _) {}
        rig.home.takeBack()
        rig.date.addTimeInterval(1)
        await shipper.reconcile(.foreground)
        XCTAssertEqual(shipper.state.outcome, .shipped, "the pass in use is still the one the home takes")

        rig.home.refusePass()
        try await rig.capture()
        rig.date.addTimeInterval(1)
        await shipper.reconcile(.foreground)
        XCTAssertEqual(shipper.state.outcome, .passRefused)
        try await rig.pair()
        rig.date.addTimeInterval(1)
        await shipper.reconcile(.foreground)
        XCTAssertEqual(shipper.state.outcome, .shipped, "the new pass is the one in use")
    }

    func testAKeychainThatWouldNotAnswerReadsAsPairedAndForgetsNothing() async throws {
        let rig = try await rig(); try await rig.capture()
        rig.home.replying = { _ in .refuse(422, "CLOCK_AHEAD") }
        let shipper = rig.launch()
        await shipper.reconcile(.foreground)
        rig.credentials.locked = true
        XCTAssertTrue(shipper.paired, "can't tell reads as paired: no Pair offered, Unpair kept")
        rig.date.addTimeInterval(600)
        await shipper.reconcile(.foreground)
        XCTAssertNotEqual(shipper.state.outcome, .noHome)
        XCTAssertEqual(shipper.pending.count, 1, "the bundle in flight is kept")
        XCTAssertEqual(rig.bundleFiles().count, 1)
        rig.credentials.locked = false
        XCTAssertEqual(shipper.homeName, "lifestream")
    }


    func testAPhotosSliceThatThrowsSitsOutLocationShipsAndTheExchangeSaysSo() async throws {
        let rig = try await rig()
        try await rig.capture()
        try await rig.capture(.photos)
        let database = try SQLiteDatabase(url: rig.store.databaseURL)
        var line = Data()
        try database.query("SELECT line FROM photos WHERE sequence = 1") { line = $0.blob(0) }
        let broken = String(decoding: line, as: UTF8.self).replacingOccurrences(of: "Z\",\"payload", with: "+01:00\",\"payload")
        try database.run("UPDATE photos SET line = ? WHERE sequence = 1", .blob(Data(broken.utf8)))

        let shipper = rig.launch()
        rig.home.holding = true
        let send = Task { await shipper.reconcile(.wake) }
        let puts = try await rig.puts(1)
        let pending = try XCTUnwrap(shipper.pending.first)
        XCTAssertEqual(pending.seals, [Home.location: 1], "location ships; photos spends no seal")
        XCTAssertEqual(try StoredZIPWriter.readManifest(from: rig.custody.file(pending)).satOut, [Home.photos])
        let failing = try XCTUnwrap(shipper.state.sending.sources[Home.photos])
        XCTAssertEqual(failing.code, "LOCAL_STORAGE")
        rig.home.holding = false
        puts[0].answer(.take)
        await send.value

        let relaunched = rig.launch()
        await relaunched.reconcile(.foreground)
        XCTAssertEqual(rig.home.sending?.sources[Home.photos]?.sinceMs, failing.sinceMs)

        try database.run("UPDATE photos SET line = ? WHERE sequence = 1", .blob(line))
        await relaunched.reconcile(.wake)
        XCTAssertEqual(rig.home.received(Home.photos), 1, "the next seal is photos' first")
        XCTAssertEqual(relaunched.state.sending.sources, [:])
        try rig.artifact("photos-sat-out")
    }

    func testAStoreFailureIsTheWholeSendsAndOnlyASendThatDoesTheWorkEndsIt() async throws {
        let rig = try await rig()
        try await rig.capture(.photos)
        let database = try SQLiteDatabase(url: rig.store.databaseURL)
        var line = Data()
        try database.query("SELECT line FROM photos WHERE sequence = 1") { line = $0.blob(0) }
        let broken = String(decoding: line, as: UTF8.self).replacingOccurrences(of: "Z\",\"payload", with: "+01:00\",\"payload")
        try database.run("UPDATE photos SET line = ? WHERE sequence = 1", .blob(Data(broken.utf8)))

        let shipper = rig.launch()
        await shipper.reconcile(.wake)
        XCTAssertEqual(shipper.pending, [], "nothing sealed")
        XCTAssertEqual(shipper.state.outcome, .storeFailed, "never nothing new")
        let failure = try XCTUnwrap(shipper.state.sending.send)
        XCTAssertEqual(failure.code, "LOCAL_STORAGE")

        rig.date.addTimeInterval(60)
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.sendings.last?.send, failure, "the home hears the since it began")
        XCTAssertEqual(rig.home.received(Home.location), 1)
        XCTAssertNil(shipper.state.sending.send, "a send that sealed ends it")
        XCTAssertEqual(shipper.state.sending.sources[Home.photos]?.code, "LOCAL_STORAGE", "Photos' own failure stays")
        try rig.artifact("store-failing")
    }

    func testALaunchThatCannotRunASendIsTheWholeSendsFailureUntilASendRuns() async throws {
        let rig = try await rig(); try await rig.capture()
        let shipper = rig.launch()
        shipper.couldNotStart(CaptureError.corruptState("Open Lifestream once before running this capture action"))
        let failure = try XCTUnwrap(shipper.state.sending.send)
        XCTAssertEqual(failure.code, "LOCAL_STORAGE")
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.sending?.send, failure, "the next exchange states it")
        XCTAssertNil(shipper.state.sending.send, "the send that did the work ends it")
    }

    func testAContactsReadThatFailsIsStatedAndContactsSitsOutUntilAPassReads() async throws {
        let rig = try await rig()
        try await rig.capture()
        let source = FakeContactSource(cards: [.synthetic("a")])
        rig.recorder = ContactsRecorder(store: rig.store, source: source)
        let shipper = rig.launch()
        await shipper.contacts(manual: false)
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.received(Home.contacts), 1)
        await source.fail()
        await source.change([.synthetic("a"), .synthetic("b")])
        try await rig.capture()
        await shipper.contacts(manual: true)
        rig.home.holding = true
        let shipped = rig.home.puts.count
        let send = Task { await shipper.reconcile(.wake) }
        let puts = try await rig.puts(shipped + 1)
        let pending = try XCTUnwrap(shipper.pending.first)
        XCTAssertEqual(try StoredZIPWriter.readManifest(from: rig.custody.file(pending)).satOut, [Home.contacts],
                       "the bundle is no heartbeat of Contacts")
        let failing = try XCTUnwrap(shipper.state.sending.sources[Home.contacts])
        XCTAssertEqual(failing.code, "LOCAL_ACCESS")
        rig.home.holding = false
        puts[shipped].answer(.take)
        await send.value

        await source.recover()
        rig.date.addTimeInterval(86400)
        await shipper.contacts(manual: false)
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.received(Home.contacts), 2, "its pass ships")
        XCTAssertNil(shipper.state.sending.sources[Home.contacts])
        try rig.artifact("contacts-failing")
    }


    func testASavedAnswerClearsNoPhoto() async throws {
        let rig = try await rig()
        let photo = try await rig.capture(.photos, blob: "synthetic photo")
        let shipper = rig.launch()
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.received(Home.photos), 1)

        let saved = rig.exports.appendingPathComponent("answer.json")
        var file = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: saved)) as? [String: Any])
        var answer = try XCTUnwrap(file["answer"] as? [String: Any])
        var sources = try XCTUnwrap(answer["sources"] as? [String: Any])
        sources[Home.photos] = ["received": 1, "imported": 1, "formats": [], "history": true]
        answer["sources"] = sources
        file["answer"] = answer
        try JSONSerialization.data(withJSONObject: file).write(to: saved)
        rig.home.silent = true
        let relaunched = rig.launch()
        XCTAssertEqual(relaunched.link.saved?.sources[Home.photos]?.imported, 1)
        await relaunched.reconcile(.manual)
        var held = try await rig.blobs()
        XCTAssertEqual(held, [photo])

        rig.home.silent = false
        rig.home.restore()
        await relaunched.reconcile(.foreground)
        held = try await rig.blobs()
        XCTAssertEqual(held, [photo])
    }


    func testAFriendsBuildOnAnOlderMacHoldsEverythingUntilTheMacUpdates() async throws {
        let rig = try await rig(paired: false)
        rig.stamp = 500
        rig.home.release = ("4f2a9c1", 499)
        do { try await rig.pair(); XCTFail("an older Mac's pairing answer is not fresh") } catch LinkFailure.homeTooOld {}
        try await rig.capture()
        let shipper = rig.launch()
        XCTAssertNotNil(shipper.homeName, "paired all the same")
        await shipper.reconcile(.foreground)
        XCTAssertEqual(shipper.state.outcome, .held("HOME_TOO_OLD"))
        XCTAssertNil(shipper.shippingDescription, "a home to update is reach's: the banner says it, and Last send nothing")
        XCTAssertEqual(shipper.link.snapshot.reach, .needsUpdate(.home))
        XCTAssertEqual(shipper.state.sending.send?.code, "HOME_TOO_OLD")
        XCTAssertEqual(rig.cleared, 0)
        await shipper.reconcile(.wake)
        XCTAssertEqual(shipper.state.outcome, .held("HOME_TOO_OLD"), "each send asks again, and holds")
        XCTAssertTrue(rig.home.puts.isEmpty, "nothing was sent")
        XCTAssertTrue(rig.bundleFiles().isEmpty, "nothing was sealed on an older home's word")

        rig.home.release = ("5b3c0d2", 500)
        await shipper.reconcile(.foreground)
        XCTAssertEqual(shipper.state.outcome, .shipped)
        XCTAssertNil(shipper.state.sending.send)
        XCTAssertEqual(rig.home.received(Home.location), 1)
        try rig.artifact("home-too-old")
    }


    func testUnpairingCancelsEveryRequestForgetsEveryBundleAndTheExportIsTheCopy() async throws {
        let rig = try await rig()
        try await rig.capture()
        try await rig.capture(.photos, bytes: Data(repeating: 0x76, count: 9 * Self.megabyte))
        rig.home.holding = true
        rig.long = true
        let shipper = rig.launch()
        let send = Task { await shipper.reconcile(.processing) }
        let puts = try await rig.puts(2)
        try await shipper.unpair()
        await send.value
        try await until("every request was stopped") { puts.allSatisfy(\.stopped) }
        XCTAssertNil(try shipper.link.name(), "the pass is gone from the Keychain")
        XCTAssertEqual(shipper.pending, [])
        XCTAssertEqual(rig.bundleFiles(), [], "every bundle sealed under the forgotten pass is deleted")
        let paired = await rig.store.isPaired
        XCTAssertFalse(paired)

        try await rig.capture()
        await shipper.reconcile(.manual)
        XCTAssertEqual(shipper.state.outcome, .noHome)
        XCTAssertEqual(rig.home.puts.count, 2, "nothing more is sent")
        let copy = try await shipper.export()
        XCTAssertTrue(try StoredZIPWriter.readManifest(from: try XCTUnwrap(copy.first)).custody.isEmpty)
        XCTAssertEqual(shipper.pending, [], "the copy never waits to ship")
    }

    func testStartDeletesEveryOtherFileInTheExportsFolder() async throws {
        let rig = try await rig(); try await rig.capture()
        rig.home.replying = { _ in .refuse(422, "CLOCK_AHEAD") }
        try FileManager.default.createDirectory(at: rig.exports, withIntermediateDirectories: true)
        try Data("stray archive".utf8).write(to: rig.exports.appendingPathComponent("lifestream-ios-bbbbbbbbbbbb.zip"))
        try Data("{}".utf8).write(to: rig.exports.appendingPathComponent("stray.json"))
        let shipper = rig.launch()
        await shipper.reconcile(.wake)
        let pending = try XCTUnwrap(shipper.pending.first)
        let kept = try FileManager.default.contentsOfDirectory(atPath: rig.exports.path).sorted()
        XCTAssertEqual(kept, ["answer.json", pending.file, "shipper.json"].sorted(), "the record, the saved answer, the bundle in flight")
    }

    func testTheRecordTheInstalledReleaseWroteLoadsAndIsWrittenBackByteForByte() async throws {
        let rig = try await rig()
        let record = #"{"expiryWarned":815000000,"failures":{"send":{"code":"LOCAL_STORAGE","message":"disk full","since_ms":1800000000000},"sources":{"phone:iphone-0001/photos":{"read":{"code":"PHOTOS","message":"no access","since_ms":1800000001000}}}},"outcome":"refused PRINCIPAL_UNKNOWN","recordedAt":815000100.5,"shown":{"need-1":"2026-10-14T06:36:19.071Z"}}"#
        try FileDurability.createDirectoryDurably(at: rig.exports)
        try Data(record.utf8).write(to: rig.stateURL)
        let shipper = rig.launch()
        XCTAssertEqual(shipper.state.outcome, .passRefused, "the refused pass, read back")
        XCTAssertEqual(shipper.lifecycle, .idle)
        XCTAssertEqual(shipper.state.shown, ["need-1": "2026-10-14T06:36:19.071Z"])
        XCTAssertEqual(shipper.state.expiryWarned, Date(timeIntervalSinceReferenceDate: 815_000_000))
        XCTAssertEqual(shipper.state.recordedAt, Date(timeIntervalSinceReferenceDate: 815_000_100.5))
        XCTAssertEqual(shipper.state.sending.send?.code, "LOCAL_STORAGE")
        XCTAssertEqual(shipper.state.sending.sources["phone:iphone-0001/photos"]?.code, "PHOTOS")
        XCTAssertEqual(String(decoding: try JSONEncoder.lifestream().encode(shipper.state), as: UTF8.self), record,
                       "written back in the shape it was read")

        let words: [(String, PhoneShipper.Outcome)] = [
            ("Nothing sent yet", .nothingSent), ("shipped", .shipped), ("nothing_new", .nothingNew),
            ("uploading", .uploading), ("waiting", .waiting), ("unreachable", .unreachable), ("no_home", .noHome),
            ("handed_over", .handedOver), ("held CLOCK_AHEAD", .held("CLOCK_AHEAD")),
            ("held DEVICE_TOO_OLD", .held("DEVICE_TOO_OLD")), ("held HOME_TOO_OLD", .held("HOME_TOO_OLD")),
            ("held IOS_BUNDLE_HASH_MISMATCH", .held("IOS_BUNDLE_HASH_MISMATCH")), ("refused PRINCIPAL_UNKNOWN", .passRefused),
            ("refused local_storage", .storeFailed),
        ]
        for (word, outcome) in words {
            XCTAssertEqual(PhoneShipper.Outcome(word: word), outcome, word)
            XCTAssertEqual(outcome.word, word)
        }

        try Data(#"{"failures":{"sources":{}},"outcome":"shipped","shown":{"need-1":"2026-10-14T06:36:19.071Z"}}"#.utf8)
            .write(to: rig.stateURL)
        XCTAssertEqual(rig.launch().state.outcome, .shipped)
        try Data(#"{"failures":{"sources":{}},"outcome":"sent","shown":{"need-1":"2026-10-14T06:36:19.071Z"}}"#.utf8)
            .write(to: rig.stateURL)
        let fresh = rig.launch()
        XCTAssertEqual(fresh.state, ShipperState())
    }

    func testARecordThatDoesNotReadIsReplacedAndShippingGoesOn() async throws {
        let rig = try await rig(); try await rig.capture()
        try FileDurability.createDirectoryDurably(at: rig.exports)
        try Data("invalid".utf8).write(to: rig.stateURL)
        let shipper = rig.launch()
        await shipper.reconcile(.manual)
        XCTAssertNil(shipper.sendFailure)
        XCTAssertEqual(rig.home.received(Home.location), 1)
        let written = try JSONDecoder.lifestream().decode(ShipperState.self, from: Data(contentsOf: rig.stateURL))
        XCTAssertEqual(written.outcome, .shipped, "a fresh record took its place")
    }


    private func stale(_ at: Date) -> String {
        ReachWords.stale(lastReached: at, clock: HomeClock.current.clock, now: at.addingTimeInterval(HomeWarnings.silence))
    }

    func testTheSilenceReminderMovesOnAndNeedsShowOncePerOccurrence() async throws {
        let rig = try await rig()
        let shipper = rig.launch()
        func silences() -> [Warnings.Posted] { rig.warnings.posted.filter { $0.id == HomeWarnings.silenceID } }
        func needs() -> [String] { rig.warnings.posted.map(\.id).filter { $0.hasPrefix("need:") } }
        rig.home.needs = [["id": "pair:iphone-aa00", "state": "needs-you", "reason": "pair", "words": "Pair this iPhone again", "since_ms": 1760000000000, "next_ms": NSNull(), "acts": [Any](), "detail": NSNull(), "connector": NSNull(), "copy": NSNull(), "unit": "iphone-aa00", "at": NSNull(), "weight": "advice", "banner": false, "dismissed": false, "kind": "notice", "about": NSNull()],
                          ["id": "disk", "state": "needs-you", "reason": NSNull(), "words": "Your home's disk fills up in about 21 days", "since_ms": 1760000000000, "next_ms": NSNull(), "acts": [Any](), "detail": NSNull(), "connector": NSNull(), "copy": NSNull(), "unit": NSNull(), "at": NSNull(), "weight": "advice", "banner": false, "dismissed": false, "kind": "notice", "about": NSNull()]]
        await shipper.reconcile(.foreground)
        XCTAssertEqual(needs(), ["need:pair:iphone-aa00"], "a need naming another device, or none, is not the phone's")
        XCTAssertEqual(rig.warnings.posted.first { $0.id.hasPrefix("need:") }?.sound, false, "a need does not sound")
        try await until("the reminder scheduled from when the home last answered") { silences().last?.body == stale(rig.date) }
        XCTAssertEqual(silences().last?.after, HomeWarnings.silence)

        rig.date.addTimeInterval(3600)
        let moved = rig.date
        await shipper.reconcile(.foreground)
        try await until("the reminder moved on with the answer") { silences().last?.body == stale(moved) }
        XCTAssertEqual(needs(), ["need:pair:iphone-aa00"], "the same occurrence does not show again")

        rig.home.needs = [["id": "pair:iphone-aa00", "state": "needs-you", "reason": "pair", "words": "Pair this iPhone again", "since_ms": 1760018000000, "next_ms": NSNull(), "acts": [Any](), "detail": NSNull(), "connector": NSNull(), "copy": NSNull(), "unit": "iphone-aa00", "at": NSNull(), "weight": "advice", "banner": false, "dismissed": false, "kind": "notice", "about": NSNull()]]
        await shipper.reconcile(.foreground)
        XCTAssertEqual(rig.warnings.posted.last { $0.id.hasPrefix("need:") }?.id, "need:pair:iphone-aa00", "a new occurrence shows again")
        XCTAssertEqual(needs().count, 2)
        rig.home.needs = []
        await shipper.reconcile(.foreground)
        XCTAssertEqual(rig.warnings.removed.last, ["need:pair:iphone-aa00"])

        rig.home.silent = true
        let reached = shipper.link.snapshot.lastReached
        let count = silences().count
        rig.date.addTimeInterval(3600)
        await shipper.reconcile(.foreground)
        XCTAssertEqual(shipper.link.snapshot.lastReached, reached, "no answer, no move")
        XCTAssertEqual(silences().count, count)
    }

    func testARefusedSilenceReminderIsAskedForAgainOnTheNextAnswer() async {
        let center = Warnings()
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        let warnings = HomeWarnings(center: center, now: { at })
        center.refusing = true
        await warnings.reach(HomeLink.ReachSnapshot(reach: .answering, lastReached: at, revision: 1))
        XCTAssertTrue(center.posted.isEmpty)
        XCTAssertNil(warnings.scheduled, "a refused post counts as scheduled")

        center.refusing = false
        let next = at.addingTimeInterval(10)
        await warnings.reach(HomeLink.ReachSnapshot(reach: .answering, lastReached: next, revision: 1))
        XCTAssertEqual(center.posted.filter { $0.id == HomeWarnings.silenceID },
                       [Warnings.Posted(id: HomeWarnings.silenceID, body: stale(next), after: HomeWarnings.silence + 10, sound: false)])
        XCTAssertEqual(warnings.scheduled, next)

        await warnings.reach(HomeLink.ReachSnapshot(reach: .waiting(since: next), lastReached: next, revision: 1))
        XCTAssertEqual(center.posted.count, 1)
    }

    func testTheSilenceReminderFollowsWhenTheHomeLastAnswered() async throws {
        let rig = try await rig(); try await rig.capture()
        let shipper = rig.launch()
        await shipper.reconcile(.wake)
        let exchanges = rig.home.exchanges
        func silences() -> [Warnings.Posted] { rig.warnings.posted.filter { $0.id == HomeWarnings.silenceID } }

        try await rig.capture()
        rig.date.addTimeInterval(3600)
        var at = rig.date
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.exchanges, exchanges, "no exchange owed")
        XCTAssertEqual(rig.home.received(Home.location), 2)
        try await until("a bundle the home took moves the reminder on") { silences().last?.body == stale(at) }

        rig.date.addTimeInterval(3600)
        at = rig.date
        _ = try? await shipper.link.people()
        try await until("a read the home answered moves it on") { silences().last?.body == stale(at) }

        try await rig.capture()
        rig.home.replying = { _ in .refuse(503, "NOT_NOW") }
        rig.date.addTimeInterval(3600)
        at = rig.date
        var puts = rig.home.puts.count
        await shipper.reconcile(.wake)
        XCTAssertGreaterThan(rig.home.puts.count, puts, "not now: the bundle was asked")
        XCTAssertEqual(shipper.state.outcome, .unreachable, "not now")
        await shipper.link.probeSoon()
        try await until("the probe's answer moves it on") { silences().last?.body == stale(at) }

        try await rig.capture()
        rig.home.replying = { _ in .fail }
        rig.date.addTimeInterval(3600)
        let count = silences().count
        let reached = shipper.link.snapshot.lastReached
        puts = rig.home.puts.count
        await shipper.reconcile(.wake)
        XCTAssertGreaterThan(rig.home.puts.count, puts, "no answer: the bundle was asked")
        XCTAssertEqual(shipper.state.outcome, .unreachable, "no answer")
        XCTAssertEqual(shipper.link.snapshot.lastReached, reached, "no answer: not reached, no move")
        XCTAssertEqual(silences().count, count)
        for reply in [Home.Reply.refuse(503, "HOME_MOVING"), .refuse(422, "IOS_BUNDLE_HASH_MISMATCH")] {
            rig.home.replying = { _ in reply }
            rig.date.addTimeInterval(3600)
            at = rig.date
            await shipper.reconcile(.wake)
            try await until("\(reply): the home's answer moves it on") { silences().last?.body == stale(at) }
        }
        XCTAssertEqual(shipper.state.sending.sources[Home.location]?.code, "IOS_BUNDLE_HASH_MISMATCH", "refused, not taken")

        rig.home.refusePass()
        rig.date.addTimeInterval(3600)
        at = rig.date
        await shipper.reconcile(.wake)
        try await until("a 401 is the home's answer too") { silences().last?.body == stale(at) }
        XCTAssertEqual(shipper.link.snapshot.reach, .passRefused)
    }

    func testA5xxOtherThanNotNowIsHeldInItsOwnWords() async throws {
        let rig = try await rig(); try await rig.capture()
        let shipper = rig.launch()
        rig.home.replying = { _ in .refuse(503, "DISK_LOW") }
        await shipper.reconcile(.wake)
        XCTAssertEqual(shipper.state.outcome, .held("DISK_LOW"))
        XCTAssertEqual(shipper.shippingDescription, "Waiting for space on Lifestream's disk")
        XCTAssertEqual(shipper.link.snapshot.reach, .answering, "a disk low is the home answering")
        XCTAssertFalse(shipper.pending.isEmpty, "what was sent waits on this phone")

        rig.home.replying = { _ in .refuse(503, "NOT_NOW") }
        rig.date.addTimeInterval(3600)
        await shipper.reconcile(.wake)
        XCTAssertEqual(shipper.state.outcome, .unreachable)
        XCTAssertNil(shipper.shippingDescription, "the banner says it, never Last send")
        await shipper.link.probeSoon()
        XCTAssertEqual(shipper.link.snapshot.reach, .answering, "the probe decides: answered, one send's not-now is no reach")
    }

    func testTheBuildWarnsTwoWeeksBeforeItExpiresOrAtHalfItsLifeOncePerBuild() async throws {
        let rig = try await rig()
        let made = rig.date.addingTimeInterval(-70 * 86400), expires = rig.date.addingTimeInterval(20 * 86400)
        let stamp = { (date: Date) in ISO8601DateFormatter().string(from: date) }
        let profile = Data("0\u{82}signed-envelope".utf8) + Data("""
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0"><dict><key>Name</key><string>Synthetic Profile</string>\
            <key>CreationDate</key><date>\(stamp(made))</date>\
            <key>ExpirationDate</key><date>\(stamp(expires))</date></dict></plist>
            """.utf8) + Data([0xa0, 0x82, 0x0b, 0x00])
        let read = try BuildExpiry.life(profile: profile)
        XCTAssertEqual(read.made.timeIntervalSince1970, made.timeIntervalSince1970, accuracy: 1)
        XCTAssertEqual(read.expires.timeIntervalSince1970, expires.timeIntervalSince1970, accuracy: 1)
        XCTAssertThrowsError(try BuildExpiry.life(profile: Data("no list here".utf8)))
        XCTAssertThrowsError(try BuildExpiry.life(profile: Data("<?xml?><plist><dict></dict></plist>".utf8)), "no dates")
        XCTAssertNil(BuildExpiry.read(Bundle(for: Self.self)), "a build with no profile has no life")

        let shipper = rig.launch(build: read)
        await shipper.reconcile(.wake)
        let posted = rig.warnings.posted.filter { $0.id == HomeWarnings.expiryID }
        XCTAssertEqual(posted.count, 1)
        XCTAssertEqual(try XCTUnwrap(posted.first?.after), 6 * 86400, accuracy: 1, "a 90-day build: 14 days before it stops")
        XCTAssertEqual(posted.first?.body, HomeWarnings.expiring(read.expires))
        XCTAssertEqual(posted.first?.sound, false)
        await rig.launch(build: read).reconcile(.wake)
        XCTAssertEqual(rig.warnings.posted.filter { $0.id == HomeWarnings.expiryID }.count, 1, "once per build")

        rig.date.addTimeInterval(86400)
        await rig.launch(build: BuildLife(made: rig.date, expires: rig.date.addingTimeInterval(7 * 86400))).reconcile(.wake)
        await rig.launch(build: BuildLife(made: rig.date.addingTimeInterval(-80 * 86400), expires: rig.date.addingTimeInterval(10 * 86400)))
            .reconcile(.wake)
        XCTAssertEqual(rig.warnings.posted.filter { $0.id == HomeWarnings.expiryID }.map(\.after), [posted[0].after, 3.5 * 86400, nil])

        let fresh = try await self.rig()
        fresh.warnings.refusing = true
        let refused = fresh.launch(build: read)
        await refused.reconcile(.wake)
        XCTAssertNil(refused.state.expiryWarned)
        fresh.warnings.refusing = false
        await refused.reconcile(.manual)
        await refused.reconcile(.wake)
        XCTAssertEqual(fresh.warnings.posted.filter { $0.id == HomeWarnings.expiryID }.count, 1)
        XCTAssertEqual(refused.state.expiryWarned, read.expires)
    }


    func testTheClockStartsEachSend() async throws {
        let rig = try await rig()
        try await rig.capture(.voice, blob: "a note", at: rig.date.addingTimeInterval(-31 * 60))
        let shipper = rig.launch()
        await shipper.prime()
        try await until("the clock set its timer") { rig.alarms.next != nil }
        XCTAssertEqual(rig.alarms.next, rig.date.addingTimeInterval(-60), "due a minute ago: at once")
        rig.alarms.ring(rig.date)
        try await until("the note landed") { rig.home.received(Home.voice) == 1 }

        try await rig.capture()
        rig.date.addTimeInterval(60)
        shipper.tell(.visit)
        try await until("the visit is due at once") { rig.alarms.next == rig.date }
        rig.alarms.ring(rig.date)
        try await until("location landed") { rig.home.received(Home.location) == 1 }

        rig.date.addTimeInterval(60)
        let gate = rig.home.holdExchange()
        shipper.ask(.foreground)
        try await until("the foreground's send is due at once") { rig.alarms.next == rig.date }
        let start = rig.date
        rig.alarms.ring(rig.date)
        try await until("its exchange is answered and held") { gate.waiting }
        try await rig.capture(.location, kind: "fix")
        shipper.tell(.visit)
        XCTAssertNil(rig.alarms.next, "no timer while the pass runs")
        gate.open()
        try await until("the pass sealed the fix and sent it") { rig.home.received(Home.location) == 2 }
        try await until("the clock set its timer once the pass ended") { rig.alarms.next != nil }
        XCTAssertEqual(rig.alarms.next, start.addingTimeInterval(SendClock.FLOOR_S), "the visit, after the floor")
        rig.date = start.addingTimeInterval(SendClock.FLOOR_S)
        rig.alarms.ring(rig.date)
        try await until("the visit's send ended") { rig.budgets.ended == 4 }
        XCTAssertEqual(rig.reasons, [.wake, .wake, .foreground, .wake])
        XCTAssertNil(shipper.clock.next, "nothing more is due: no send outlives the test")
        try rig.artifact("clock")
    }


    func testStopEndsBringInAllPhotosWaitTakingBackItsAskOrCancellingTheSendItRode() async throws {
        let rig = try await rig(); try await rig.capture()
        let shipper = rig.launch()
        shipper.tell(.visit)
        try await until("the clock set its timer") { rig.alarms.next != nil }
        rig.alarms.ring(rig.date)
        try await until("the visit's send ended") { rig.budgets.ended == 1 }

        let early = Task { await shipper.send(.foreground) }
        try await until("its send waits for the floor") { rig.alarms.next == rig.date.addingTimeInterval(SendClock.FLOOR_S) }
        early.cancel()
        await early.value
        try await until("its ask was taken back, and the clock's event with it") { rig.alarms.next == nil }
        XCTAssertEqual(rig.reasons, [.wake], "no send was admitted for it")

        rig.date.addTimeInterval(SendClock.FLOOR_S)
        try await rig.capture(at: rig.date.addingTimeInterval(-SendClock.SETTLED_S))
        rig.home.holding = true
        let bringing = Task { await shipper.send(.foreground) }
        try await until("its send is due") { rig.alarms.next == rig.date }
        rig.alarms.ring(rig.date)
        let puts = try await rig.puts(2)
        bringing.cancel()
        await bringing.value
        try await until("its upload was stopped") { puts[1].stopped }
        try await until("its send ended under its budget") { rig.budgets.ended == 2 }
        XCTAssertEqual(shipper.clock.next, rig.date.addingTimeInterval(SendClock.BACKOFF_FIRST_S),
                       "a send stopped is a not yet: the clock backs off")
        XCTAssertEqual(rig.reasons, [.wake, .foreground])
        XCTAssertEqual(shipper.pending.count, 1, "what it carried stays in flight")
        try rig.artifact("stop")
    }

    func testTheBudgetsEndDuringTheResealStopsItAndTheSendEndsOnce() async throws {
        let rig = try await rig()
        try await rig.capture(at: rig.date.addingTimeInterval(-SendClock.SETTLED_S))
        let shipper = rig.launch()
        shipper.tell(.visit)
        try await until("the clock set its timer") { rig.alarms.next != nil }
        rig.alarms.ring(rig.date)
        try await until("the visit's send ended") { rig.budgets.ended == 1 }

        rig.home.restore()
        try await rig.capture()
        rig.home.holding = true
        rig.date.addTimeInterval(SendClock.FLOOR_S)
        shipper.tell(.visit)
        try await until("the visit is due") { rig.alarms.next == rig.date }
        rig.alarms.ring(rig.date)
        let stale = try await rig.puts(2)
        stale[1].answer(.take)
        let reseal = try await rig.puts(3)
        rig.budgets.expire()
        try await until("the reseal's upload was stopped") { reseal[2].stopped }
        try await until("the send ended, once") { rig.budgets.ended == 2 }
        XCTAssertEqual(shipper.clock.next, rig.date.addingTimeInterval(SendClock.BACKOFF_FIRST_S),
                       "a send its budget's end stopped is a not yet: the clock backs off")
        XCTAssertEqual(rig.home.statuses, [201, 409], "nothing more reached the home")
        XCTAssertEqual(rig.home.puts.count, 3, "and nothing more started")
        XCTAssertEqual(shipper.pending.count, 1, "the resealed bundle stays in flight")
        try rig.artifact("reseal-expired")
    }

    func testUnpairDuringALiveSendLeavesNothingRunningAndTheOutcomeNoHome() async throws {
        let rig = try await rig()
        rig.long = true
        try await rig.capture()
        try await rig.capture(.photos, bytes: Data(repeating: 0x7a, count: 9 * Self.megabyte))
        let shipper = rig.launch()
        await shipper.reconcile(.wake)
        rig.home.restore()
        try await rig.capture()
        try await rig.capture(.photos, bytes: Data(repeating: 0x7b, count: 9 * Self.megabyte))
        rig.home.holdingWhen = { custody in custody.keys.contains(Home.photos) }
        rig.date.addTimeInterval(SendClock.FLOOR_S)
        shipper.tell(.visit)
        try await until("the visit is due") { rig.alarms.next == rig.date }
        rig.alarms.ring(rig.date)
        try await until("location answered STALE, photos held") { rig.home.statuses.count == 3 && rig.home.puts.count == 4 }

        try await shipper.unpair()
        XCTAssertTrue(shipper.aftermaths.isEmpty, "every admission's aftermath ended before Unpair returned")
        XCTAssertEqual(rig.budgets.begun, 2)
        XCTAssertEqual(rig.budgets.ended, 2, "and each send's budget, once")
        XCTAssertEqual(shipper.state.outcome, .noHome, "and noted nothing after it")
        XCTAssertEqual(rig.home.puts.count, 4, "the reseal it owed never ran")
        XCTAssertNil(try shipper.link.name())
        XCTAssertEqual(shipper.pending, [])
        try await until("the held upload was stopped") { rig.puts(of: Home.photos).last?.stopped == true }
        try rig.artifact("unpair-live")
    }

    func testUnpairWaitsOutAnAftermathHeldInItsPhotoPassWhichTakesNoContactsPassAfter() async throws {
        let rig = try await rig(); try await rig.capture()
        let held = Home.Gate()
        let happened = Events()
        rig.photoPass = { _ in
            await withTaskCancellationHandler {
                _ = await Task { try? await held.wait() }.value
            } onCancel: {
                happened.add("cancelled")
            }
            happened.add("photo pass ended")
        }
        let shipper = rig.launch()
        await shipper.reconcile(.wake)
        try await until("the send's aftermath runs its photo pass, held") { held.waiting }
        let unpairing = Task {
            try await shipper.unpair()
            happened.add("unpaired")
        }
        try await until("Unpair cancelled the aftermath") { happened.all.contains("cancelled") }
        held.open()
        try await unpairing.value
        XCTAssertEqual(happened.all, ["cancelled", "photo pass ended", "unpaired"], "Unpair returned once the pass ended")
        XCTAssertTrue(shipper.aftermaths.isEmpty)
        XCTAssertEqual(rig.contactsPasses, [], "the aftermath took no contacts pass after it")
        XCTAssertEqual(rig.budgets.ended, rig.budgets.begun, "every budget ended")
        XCTAssertEqual(shipper.state.outcome, .noHome)
    }

    func testASendAskedWhileUnpairRunsNeverRuns() async throws {
        let rig = try await rig(); try await rig.capture()
        let held = Home.Gate()
        rig.uploadsHeld = held
        let shipper = rig.launch()
        let send = Task { await shipper.reconcile(.wake) }
        try await until("the pass waits at its uploads") { held.waiting }
        let exchanges = rig.home.exchanges
        let unpairing = Task { try await shipper.unpair() }
        try await until("Unpair began") { shipper.lifecycle == .unpairing }
        let clock = shipper.clock, passes = rig.contactsPasses
        let late = await shipper.admit(.manual)
        XCTAssertNil(late, "no send is admitted while Unpair runs")
        XCTAssertEqual(shipper.clock, clock, "the clock heard nothing of it")
        XCTAssertEqual(rig.contactsPasses, passes, "and Ship now's contacts pass was not taken")
        held.open()
        try await unpairing.value
        await send.value
        XCTAssertEqual(rig.home.exchanges, exchanges, "the send asked during Unpair asked the home nothing")
        XCTAssertEqual(rig.uploaded, 1, "only the held pass ran")
        XCTAssertEqual(shipper.state.outcome, .noHome, "nothing was noted after no_home")
        XCTAssertEqual(shipper.lifecycle, .idle, "and the next pass may start")
        XCTAssertNil(try shipper.link.name())
    }

    func testAnExportRunsAtOnceUnderABudgetAndOwnsItsSend() async throws {
        let rig = try await rig(); try await rig.capture()
        let shipper = rig.launch()
        shipper.tell(.visit)
        try await until("the clock set its timer") { rig.alarms.next != nil }
        let start = rig.date
        rig.alarms.ring(start)
        try await until("the visit's send ended") { rig.budgets.ended == 1 }

        try await rig.capture()
        rig.date.addTimeInterval(5)
        let scheduled = Task { await shipper.send(.processing) }
        try await until("the scheduled send waits for the floor") { rig.alarms.next == start.addingTimeInterval(SendClock.FLOOR_S) }
        let gate = rig.home.holdExchange()
        let exporting = Task { try await shipper.export() }
        try await until("the export's exchange is answered and held") { gate.waiting }
        XCTAssertEqual(rig.reasons, [.wake, .foreground], "one admission, at once, for both")
        scheduled.cancel()
        await scheduled.value
        gate.open()
        let copies = try await exporting.value
        XCTAssertEqual(copies.count, 1, "the bundle its seal made")
        try await until("the export's send ended under its budget") { rig.budgets.ended == 2 }
        XCTAssertEqual(rig.budgets.begun, 2, "one budget for the send both rode")
        XCTAssertEqual(rig.home.received(Home.location), 2, "and sent what it sealed")
        try rig.artifact("export-at-once")
    }

    func testUnpairDuringAnExportThrowsAndBuildsNoCopy() async throws {
        let rig = try await rig(); try await rig.capture()
        let shipper = rig.launch()
        let gate = rig.home.holdExchange()
        let exporting = Task { try await shipper.export() }
        try await until("the export's exchange is answered and held") { gate.waiting }
        try await shipper.unpair()
        do {
            _ = try await exporting.value
            XCTFail("an export Unpair cancelled shares nothing")
        } catch is PhoneShipper.NothingToExport {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: rig.exports.appendingPathComponent("share").path),
                       "no copy was built, of the pass or of the store the person unpaired")
        XCTAssertEqual(shipper.pending, [])
        XCTAssertNil(try shipper.link.name())
    }

    func testAnExportChainedBehindAHeldPassThrowsOnceUnpairCancelsIt() async throws {
        let rig = try await rig(); try await rig.capture()
        let held = Home.Gate()
        rig.uploadsHeld = held
        let shipper = rig.launch()
        let first = Task { await shipper.reconcile(.wake) }
        try await until("the first pass waits at its uploads") { held.waiting }
        let scheduled = Task { await shipper.send(.processing) }
        try await until("the scheduled run asked") { shipper.clock.next != nil }
        let exporting = Task { try await shipper.export() }
        try await until("the export's send was admitted") { rig.budgets.begun == 2 }
        scheduled.cancel()
        await scheduled.value
        let unpairing = Task { try await shipper.unpair() }
        try await until("Unpair began") { shipper.lifecycle == .unpairing }
        held.open()
        try await unpairing.value
        XCTAssertEqual(rig.budgets.ended, 2, "each send's budget ended, once, before Unpair returned")
        await first.value
        do {
            _ = try await exporting.value
            XCTFail("an export Unpair cancelled shares nothing")
        } catch is PhoneShipper.NothingToExport {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: rig.exports.appendingPathComponent("share").path), "no copy was built")
        XCTAssertTrue(shipper.aftermaths.isEmpty, "every aftermath was drained")
        XCTAssertEqual(shipper.pending, [])
        XCTAssertEqual(rig.uploaded, 1, "only the held pass ran")
    }


    func testAStepThatDroppedARowAndThenFailedStillPublishesItAndTheNextLaunchTidiesTheFile() async throws {
        let rig = try await rig(); try await rig.capture()
        rig.home.replying = { _ in .refuse(422, "IOS_BUNDLE_HASH_MISMATCH") }
        let shipper = rig.launch()
        await shipper.reconcile(.wake)
        let refused = try XCTUnwrap(shipper.pending.first)
        let file = rig.custody.file(refused).path
        try FileManager.default.setAttributes([.immutable: true], ofItemAtPath: file)
        defer { try? FileManager.default.setAttributes([.immutable: false], ofItemAtPath: file) }
        rig.home.replying = nil
        rig.date.addTimeInterval(HomeLink.Outbox.Wait.refused.seconds)
        await shipper.reconcile(.wake)
        XCTAssertEqual(shipper.state.outcome, .storeFailed, "the step failed, and the send with it")
        XCTAssertFalse(shipper.pending.contains { $0.id == refused.id }, "the step still published the row gone")
        XCTAssertTrue(shipper.custodyKnown)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file))

        try FileManager.default.setAttributes([.immutable: false], ofItemAtPath: file)
        let relaunched = rig.launch()
        await relaunched.reconcile(.wake)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file), "the orphan is gone")
        XCTAssertEqual(rig.home.received(Home.location), 1, "and the refused bundle's sources sealed again")
    }

    func testAStepWhoseReadFailsThrowsItAndNoRequestStartsUntilARead() async throws {
        let rig = try await rig(); try await rig.capture()
        rig.home.holding = true
        let shipper = rig.launch()
        let wake = Task { await shipper.reconcile(.wake) }
        let puts = try await rig.puts(1)
        wake.cancel()
        await wake.value
        try await until("the request was stopped") { puts[0].stopped }
        let waiting = try XCTUnwrap(shipper.pending.first)
        let database = try SQLiteDatabase(url: rig.store.databaseURL)
        var kept: String?
        try database.query("SELECT value FROM fact WHERE key = 'pending_bundle'") { kept = $0.text(0) }
        let fact = try XCTUnwrap(kept)
        struct Work: Error {}

        do {
            try await shipper.custodial { try database.run("UPDATE fact SET value = '[' WHERE key = 'pending_bundle'") }
            XCTFail("the read's error is thrown")
        } catch is Work { XCTFail("no work failed") } catch {}
        XCTAssertEqual(shipper.pending, [waiting], "the last publication stands, for the screens")
        XCTAssertFalse(shipper.custodyKnown)
        XCTAssertEqual(shipper.state.sending.send?.code, "LOCAL_STORAGE", "the store's failure, stated by the step")
        let unsent = await shipper.unsent()
        XCTAssertEqual(unsent, PhoneShipper.Unsent(), "nothing is due on bundles the phone cannot read")

        do {
            try await shipper.custodial { () async throws -> Void in throw Work() }
            XCTFail("the work's error is thrown")
        } catch is Work {}
        XCTAssertFalse(shipper.custodyKnown)

        try database.run("UPDATE fact SET value = ? WHERE key = 'pending_bundle'", .text(fact))
        rig.date.addTimeInterval(60)
        try await rig.capture(.voice, blob: "a note")
        let exchanges = rig.home.exchanges
        let send = try await shipper.admitted(.wake)
        await send.passed()
        let requests = try await rig.puts(3).dropFirst()
        XCTAssertEqual(requests.filter { $0.bundle == waiting.id }.count, 1, "the waiting bundle's request went once")
        rig.home.holding = false
        for request in requests { request.answer(.take) }
        await send.ended()
        XCTAssertEqual(rig.home.exchanges, exchanges + 1, "the store's failure was owed to the home")
        XCTAssertEqual(rig.home.sending?.send?.code, "LOCAL_STORAGE")
        XCTAssertTrue(shipper.custodyKnown)
        XCTAssertEqual(rig.home.received(Home.location), 1, "a step read them, and the request went")
        XCTAssertEqual(rig.home.received(Home.voice), 1)
        XCTAssertNil(shipper.state.sending.send, "a send that did the work again ended the store's failure")
    }

    func testAPublicationThatFailsDuringARequestIsTheWholeSendsFailureWhateverItsSiblingDelivers() async throws {
        let rig = try await rig()
        rig.home.holding = true
        let shipper = rig.launch()
        try await rig.capture()
        var wake = Task { await shipper.reconcile(.wake) }
        var puts = try await rig.puts(1)
        wake.cancel()
        await wake.value
        try await rig.capture(.voice, blob: "a note")
        wake = Task { await shipper.reconcile(.wake) }
        puts = try await rig.puts(3)
        wake.cancel()
        await wake.value
        try await until("every request was stopped") { puts.allSatisfy(\.stopped) }
        let waiting = shipper.pending
        XCTAssertEqual(waiting.count, 2)

        let database = try SQLiteDatabase(url: rig.store.databaseURL)
        try database.run("CREATE TABLE shot (n INTEGER NOT NULL)")
        try database.run("INSERT INTO shot VALUES (0)")
        try database.run("CREATE TABLE kept (value TEXT)")
        try database.run("""
            CREATE TRIGGER corrupt AFTER UPDATE OF value ON fact WHEN NEW.key = 'pending_bundle' AND NEW.value <> '['
            BEGIN
              UPDATE shot SET n = n + 1;
              INSERT INTO kept SELECT NEW.value WHERE (SELECT n FROM shot) = 2;
              UPDATE fact SET value = '[' WHERE key = 'pending_bundle' AND (SELECT n FROM shot) = 2;
            END
            """)
        let asking = rig.home.holdHeld()
        try await rig.capture(.photos, blob: "a photo")
        let send = Task { await shipper.reconcile(.wake) }
        try await until("the second request's step failed its read") { !shipper.custodyKnown }
        let sibling = try await rig.puts(4)
        XCTAssertEqual(sibling[3].bundle, waiting[0].id, "the first request went")
        try database.run("DROP TRIGGER corrupt")
        try database.run("UPDATE fact SET value = (SELECT value FROM kept) WHERE key = 'pending_bundle'")
        rig.home.holding = false
        sibling[3].answer(.take)
        asking.open()
        await send.value
        XCTAssertEqual(rig.home.received(Home.location), 1, "the sibling delivered")
        XCTAssertEqual(rig.home.received(Home.voice), 0, "the request the store failed made no PUT")
        XCTAssertEqual(shipper.state.outcome, .storeFailed, "and the send is the store's failure, not shipped")
        let recorded = try await outcomes(rig)
        XCTAssertEqual(recorded.last, "refused local_storage")
        XCTAssertEqual(shipper.state.sending.send?.code, "LOCAL_STORAGE")

        rig.date.addTimeInterval(60)
        await shipper.reconcile(.foreground)
        XCTAssertEqual(rig.home.sending?.send?.code, "LOCAL_STORAGE", "the home hears it")
        XCTAssertEqual(rig.home.received(Home.voice), 1)
        XCTAssertNil(shipper.state.sending.send)
        try rig.artifact("request-store-failed")
    }

    func testAResealWhosePublicationFailsIsTheWholeSendsFailureWhateverItsSiblingDelivered() async throws {
        let rig = try await rig()
        rig.long = true
        try await rig.capture()
        let shipper = rig.launch()
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.received(Home.location), 1)
        rig.home.restore()
        try await rig.capture()
        try await rig.capture(.photos, bytes: Data(repeating: 0x7c, count: 9 * Self.megabyte))
        let database = try SQLiteDatabase(url: rig.store.databaseURL)
        try database.run("CREATE TABLE shot (n INTEGER NOT NULL)")
        try database.run("INSERT INTO shot VALUES (0)")
        try database.run("""
            CREATE TRIGGER corrupt AFTER INSERT ON fact WHEN NEW.key = 'pending_bundle'
            BEGIN
              UPDATE shot SET n = n + 1;
              UPDATE fact SET value = '[' WHERE key = 'pending_bundle' AND (SELECT n FROM shot) = 2;
            END
            """)
        let before = rig.home.statuses.count
        await shipper.reconcile(.wake)
        XCTAssertEqual(Set(rig.home.statuses.dropFirst(before)), [201, 409], "location STALE, Photos taken")
        XCTAssertEqual(rig.home.received(Home.photos), 1, "the sibling delivered")
        XCTAssertFalse(shipper.custodyKnown, "the reseal's read failed")
        XCTAssertEqual(rig.home.statuses.count, before + 2, "and no request started on it")
        XCTAssertEqual(shipper.state.outcome, .storeFailed, "the send is the store's failure, not shipped")
        let recorded = try await outcomes(rig)
        XCTAssertEqual(recorded.last, "refused local_storage")
        XCTAssertEqual(shipper.state.sending.send?.code, "LOCAL_STORAGE")
    }

    func testThreeWaitingBundlesRequestsStartWhileTheirSendsSealIsHeldInItsStep() async throws {
        let rig = try await rig()
        rig.home.holding = true
        let shipper = rig.launch()
        var count = 0
        let captures: [(CaptureDomain, Data?)] = [(.location, nil), (.voice, Data("a note".utf8)), (.photos, Data("a photo".utf8))]
        for (domain, bytes) in captures {
            try await rig.capture(domain, bytes: bytes)
            count += shipper.pending.count + 1
            let wake = Task { await shipper.reconcile(.wake) }
            let puts = try await rig.puts(count)
            wake.cancel()
            await wake.value
            try await until("every request was stopped") { puts.allSatisfy(\.stopped) }
        }
        let waiting = shipper.pending.map(\.id)
        XCTAssertEqual(waiting.count, 3)
        XCTAssertEqual(shipper.state.outcome, .unreachable)

        let first = Home.Gate()
        let holding = Task { try await shipper.custodial { try? await first.wait() } }
        try await until("the step holds the queue") { first.waiting }
        rig.home.silent = true
        let send = Task { await shipper.reconcile(.foreground) }
        try await until("its requests and its seal are queued") { shipper.state.outcome == .uploading }
        rig.home.silent = false
        let applying = Home.Gate()
        rig.settingsHeld = applying
        _ = try await shipper.link.exchange()
        first.open()
        try await holding.value
        let puts = try await rig.puts(count + 3)
        XCTAssertTrue(applying.waiting, "the seal is held inside its step")
        XCTAssertEqual(Set(puts[count...].map(\.bundle)), Set(waiting), "every waiting bundle's PUT began meanwhile")
        rig.home.holding = false
        for put in puts[count...] { put.answer(.take) }
        applying.open()
        await send.value
        XCTAssertEqual(rig.home.received(Home.location), 1)
        XCTAssertEqual(rig.home.received(Home.voice), 1)
        XCTAssertEqual(rig.home.received(Home.photos), 1)
        XCTAssertEqual(shipper.pending, [])
    }


    func testAChangeWaitsOutTheGapFromTheLastContactsPassOnAnyRoad() async throws {
        let rig = try await rig()
        let shipper = rig.launch()
        let start = rig.date
        await shipper.contacts(manual: false)
        shipper.contactsChanged()
        try await until("the change waits out the gap") { rig.alarms.next == start.addingTimeInterval(PhoneShipper.photoGap) }
        rig.date = start.addingTimeInterval(PhoneShipper.photoGap - 1)
        await shipper.contacts(manual: true)
        rig.date = start.addingTimeInterval(PhoneShipper.photoGap)
        rig.alarms.ring(rig.date)
        let again = start.addingTimeInterval(2 * PhoneShipper.photoGap - 1)
        try await until("the change waits again, from Ship now's contacts pass") { rig.alarms.next == again }
        XCTAssertEqual(rig.contactsPasses, [false, true], "no read at the gap's end")
        rig.date = again
        rig.alarms.ring(rig.date)
        try await until("the change's contacts pass") { rig.contactsPasses.count == 3 }
        XCTAssertEqual(rig.contactsPasses, [false, true, true])
    }

    func testAManualSendCancelledWhileTheAppGetsReadyTakesNoContactsPass() async throws {
        let rig = try await rig(); try await rig.capture()
        let shipper = rig.launch()
        let held = Home.Gate()
        rig.readyHeld = held
        let shipping = Task { await shipper.shipNow() }
        try await until("Ship now waits for the app to be ready") { held.waiting }
        shipping.cancel()
        await shipping.value
        XCTAssertEqual(rig.contactsPasses, [], "no contacts pass for a send never admitted")
        XCTAssertEqual(rig.budgets.begun, 0, "and no send")
        XCTAssertEqual(rig.home.exchanges, 0)
    }

    func testATimersAdmissionWhoseOnlyCallerStoppedWhileTheAppGotReadyAdmitsNothing() async throws {
        let rig = try await rig()
        let shipper = rig.launch()
        let held = Home.Gate()
        rig.readyHeld = held
        let scheduled = Task { await shipper.send(.processing) }
        try await until("its send is due at once") { rig.alarms.next == rig.date }
        rig.alarms.ring(rig.date)
        try await until("the timer's admission waits for the app to be ready") { held.waiting }
        scheduled.cancel()
        await scheduled.value
        held.open()
        try await until("the app answered ready") { rig.readied == 1 }
        XCTAssertEqual(rig.reasons, [.processing])
        XCTAssertEqual(rig.budgets.begun, 0, "no send began for a caller that stopped")
        XCTAssertEqual(rig.home.exchanges, 0)
        XCTAssertNil(shipper.clock.next, "and nothing is due")
        XCTAssertNil(rig.alarms.next)
    }

    func testAPermissionsContactsPassThenAChangeWithinTheGapTakeOneRead() async throws {
        let rig = try await rig()
        let source = FakeContactSource(cards: [.synthetic("a")])
        let recorder = ContactsRecorder(store: rig.store, source: source)
        rig.recorder = recorder
        let shipper = rig.launch()
        let granted = rig.date
        await recorder.requestAuthorization(at: granted)
        try await until("the permission's contacts pass read the address book") { await source.reads == 1 }
        rig.date.addTimeInterval(10)
        shipper.contactsChanged()
        let due = granted.addingTimeInterval(PhoneShipper.photoGap)
        try await until("the change waits out the gap from the permission's contacts pass") { rig.alarms.waits.contains(due) }
        let reads = await source.reads
        XCTAssertEqual(reads, 1, "one read within the gap")
        rig.date = due
        rig.alarms.ring(rig.date)
        try await until("the change's contacts pass read it, past the gap") { await source.reads == 2 }
    }

    func testStopWaitsOutATriggersReadAndAChangeDuringItAsksForTheNext() async throws {
        let rig = try await rig()
        let held = Home.Gate()
        let happened = Events()
        rig.photoPass = { _ in
            happened.add("read began")
            await withTaskCancellationHandler {
                _ = await Task { try? await held.wait() }.value
            } onCancel: {
                happened.add("cancelled")
            }
            happened.add("read ended")
        }
        let shipper = rig.launch()
        shipper.libraryChanged()
        try await until("the change's read runs, held") { held.waiting }
        shipper.libraryChanged()
        let due = rig.date.addingTimeInterval(PhoneShipper.photoGap)
        try await until("the next waits out the gap") { rig.alarms.waits.contains(due) }
        let stopping = Task {
            await shipper.stop()
            happened.add("stopped")
        }
        try await until("stop cancelled the read") { happened.all.contains("cancelled") }
        held.open()
        await stopping.value
        XCTAssertEqual(happened.all, ["read began", "cancelled", "read ended", "stopped"], "stop returned once the read ended")
        XCTAssertEqual(rig.alarms.waits, [], "and the next trigger's wait with it")
    }


    func testSendCountsAreTheEnergyWindowsByThePowerEachRequestStartedOn() async throws {
        let rig = try await rig(); try await rig.capture()
        rig.home.holding = true
        let shipper = rig.launch()
        let first = try await shipper.admitted(.wake)
        let puts = try await rig.puts(1)
        rig.onPower = true
        puts[0].answer(.take)
        await first.ended()
        rig.home.holding = false
        try await rig.capture()
        rig.date.addTimeInterval(60)
        await shipper.reconcile(.wake)
        XCTAssertEqual(rig.home.received(Home.location), 2)

        let counts = try await rig.counts()
        XCTAssertEqual(counts[SendCount.requests.key(onPower: false)], 1, "the upload begun on battery")
        XCTAssertEqual(counts[SendCount.requests.key(onPower: true)], 1, "the one begun on power")
        XCTAssertEqual(counts[SendCount.bundles.key(onPower: false)], 1)
        XCTAssertEqual(counts[SendCount.bundles.key(onPower: true)], 1)
        XCTAssertNil(counts[SendCount.unanswered.key(onPower: false)], "every request was answered")
    }

    func testEachSendCountsWhyItWentOnceAsItsPassStarts() async throws {
        let rig = try await rig(); try await rig.capture()
        let shipper = rig.launch()
        await shipper.reconcile(.manual)
        XCTAssertEqual(rig.home.received(Home.location), 1)
        try await rig.capture()
        rig.date.addTimeInterval(60)
        shipper.tell(.visit)
        try await until("the visit is due at once") { rig.alarms.next == rig.date }
        rig.alarms.ring(rig.date)
        try await until("location landed") { rig.home.received(Home.location) == 2 }

        let counts = try await rig.counts()
        XCTAssertEqual(counts["send_cause_ask_manual_battery"], 1, "Ship now, with nothing due")
        XCTAssertEqual(counts["send_cause_visit_battery"], 1, "the visit")
        let causes = counts.filter { $0.key.hasPrefix("send_cause_") }.values.reduce(0, +)
        XCTAssertEqual(causes, counts["ship_passes"], "one cause a pass")
    }


    func testRefreshNowReadsAndSendsItsStreamAloneAndTheClockNeverHearsIt() async throws {
        let rig = try await rig()
        try await rig.capture()
        try await rig.capture(.voice, blob: "a note")
        var grants: [PhotoPass.Grant] = []
        rig.photoPass = { grants.append($0) }
        let shipper = rig.launch()
        await shipper.refresh([Home.voice])
        XCTAssertEqual(rig.home.puts.map(\.sources), [[Home.voice]], "one bundle, Voice notes' alone")
        XCTAssertEqual(rig.home.received(Home.voice), 1)
        XCTAssertEqual(rig.home.received(Home.location), 0, "location's entry waits for a send of its own")
        XCTAssertEqual(rig.reasons, [.refresh])
        XCTAssertEqual(rig.contactsPasses, [], "no read: a recorder's stream reads nothing, and Ship now's contacts pass is not a refresh's")
        XCTAssertEqual(grants, [])
        let counts = try await rig.counts()
        XCTAssertEqual(counts["send_cause_ask_refresh_battery"], 1)

        shipper.ask(.foreground)
        try await until("the foreground's send is due at once") { rig.alarms.next == rig.date }

        await shipper.refresh([Home.contacts])
        XCTAssertEqual(rig.contactsPasses, [true])
        await shipper.refresh([Home.photos])
        XCTAssertEqual(grants, [.wake(.refresh)])
        XCTAssertEqual(rig.contactsPasses, [true])
        XCTAssertEqual(rig.home.puts.count, 1, "nothing new of either: nothing more is sent")
    }

    func testARefreshFoldsIntoASendQueuedAndAWholeAskWidensAQueuedRefresh() async throws {
        let rig = try await rig()
        try await rig.capture(); try await rig.capture(.voice, blob: "a note")
        var held = Home.Gate()
        rig.uploadsHeld = held
        let shipper = rig.launch()
        var first = Task { await shipper.reconcile(.wake) }
        try await until("the first pass waits at its uploads") { held.waiting }
        let sent = try await rig.puts(1)
        XCTAssertEqual(sent.map(\.sources), [[Home.location, Home.voice]])

        try await rig.capture(); try await rig.capture(.voice, blob: "another note")
        var refreshed = Task { await shipper.refresh([Home.voice]) }
        try await until("the refresh's send was admitted") { rig.budgets.begun == 2 }
        let whole = try await shipper.admitted(.wake)
        XCTAssertEqual(rig.budgets.begun, 2, "folded into the refresh's send, which keeps its budget")
        held.open()
        await first.value
        await refreshed.value
        await whole.ended()
        XCTAssertEqual(rig.home.puts.map(\.sources), [[Home.location, Home.voice], [Home.location, Home.voice]],
                       "location went with the refresh: the whole ask was not narrowed to Voice notes")
        XCTAssertEqual(rig.uploaded, 2, "the widened send is a whole one")

        held = Home.Gate()
        rig.uploadsHeld = held
        try await rig.capture()
        rig.date.addTimeInterval(60)
        first = Task { await shipper.reconcile(.wake) }
        try await until("the third pass waits at its uploads") { held.waiting }
        try await rig.capture(); try await rig.capture(.voice, blob: "a third note")
        rig.date.addTimeInterval(60)
        let queued = try await shipper.admitted(.wake)
        let ready = Home.Gate()
        rig.readyHeld = ready
        refreshed = Task { await shipper.refresh([Home.voice]) }
        try await until("the refresh asks to be ready") { ready.waiting }
        let readied = rig.readied
        ready.open()
        try await until("the refresh was ready, and so folded") { rig.readied == readied + 1 }
        XCTAssertEqual(rig.budgets.begun, 4, "no budget of its own: it rides the queued send")
        held.open()
        await first.value
        await queued.ended()
        await refreshed.value
        XCTAssertEqual(rig.home.puts.count, 4, "the refresh made no send of its own")
        XCTAssertEqual(rig.home.puts.last?.sources, [Home.location, Home.voice])
        let counts = try await rig.counts()
        XCTAssertEqual(counts["ship_passes"], 4)
        XCTAssertEqual(counts["send_cause_ask_refresh_battery"], 1, "the one the refresh began; the other it rode")
    }

}


final class Home: HomeTransport, @unchecked Sendable {
    static let account = "person-a@example.com"
    static let location = "location:local:iphone-aa00"
    static let photos = "apple-photos:\(account):iphone-aa00"
    static let contacts = "apple-contacts:\(account):iphone-aa00"
    static let voice = "voice-notes:local:iphone-aa00"
    static let sources = [location, photos, contacts, voice]
    static let run = "0123456789abcdef"

    enum Reply: Sendable {
        case take
        case refuse(Int, String)
        case busy(retryAfter: Int)
        case takeThenDrop
        case fail
    }

    final class Put: @unchecked Sendable {
        let bundle: String
        let bytes: Int64
        let crossing: MobileData.Crossing
        let kind: String?
        let sources: Set<String>
        fileprivate let load: HomeProtocol
        fileprivate let thread: Thread
        private let lock = NSLock()
        private var isStopped = false
        var stopped: Bool { lock.withLock { isStopped } }
        fileprivate func stop() { lock.withLock { isStopped = true } }
        fileprivate init(bundle: String, bytes: Int64, crossing: MobileData.Crossing, kind: String?, sources: Set<String>,
                         load: HomeProtocol, thread: Thread) {
            self.bundle = bundle; self.bytes = bytes; self.crossing = crossing; self.kind = kind; self.sources = sources; self.load = load
            self.thread = thread
        }
        func answer(_ reply: Reply) {
            load.perform(#selector(HomeProtocol.reply(_:)), on: thread, with: HomeProtocol.Answer(reply),
                waitUntilDone: false, modes: [RunLoop.Mode.default.rawValue, RunLoop.Mode.common.rawValue])
        }
    }

    final class Gate: @unchecked Sendable {
        private let lock = NSLock()
        private var held: CheckedContinuation<Void, any Error>?
        private var opened = false
        var waiting: Bool { lock.withLock { held != nil } }
        func wait() async throws {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { continuation in
                    let now = lock.withLock { () -> Result<Void, any Error>? in
                        if Task.isCancelled { return .failure(CancellationError()) }
                        if opened { return .success(()) }
                        held = continuation
                        return nil
                    }
                    if let now { continuation.resume(with: now) }
                }
            } onCancel: {
                lock.withLock { () -> CheckedContinuation<Void, any Error>? in
                    defer { held = nil }
                    return held
                }?.resume(throwing: CancellationError())
            }
        }
        func open() {
            let continuation = lock.withLock { () -> CheckedContinuation<Void, any Error>? in
                opened = true
                defer { held = nil }
                return held
            }
            continuation?.resume()
        }
    }

    nonisolated(unsafe) static var current: Home?
    private let lock = NSLock()
    private var received: [String: Int] = [:]
    private var imported: [String: Int] = [:]
    private var sealed: Set<String> = []
    private var started: [Put] = []
    private var landed: [String] = []
    private var status: [Int] = []
    private var asked = 0
    private var stated: [[String: Any]] = []
    private var quiet = false
    private var turnN = 0
    private var gate: Gate?
    private var asking: Gate?
    private var holds = false
    private var holdsWhen: (@Sendable ([String: SourceCustody]) -> Bool)?
    private var replies: (@Sendable ([String: SourceCustody]) -> Reply)?
    private var stale = false
    private var pass: String?
    private var given: Set<String> = []
    private var refused: String?
    private var replacedAt: String?
    private var didRevoke = false
    private var loseAnswer = false
    private var wanting: [String: Any]?
    private var wantedAsks = 0
    private var chosen: String?
    private var settingsSaid = 0
    private var stating: [Sending] = []
    private var running: (version: String, generation: Int?) = ("0.3.0", nil)
    var exports: URL?
    var release: (version: String, generation: Int?) {
        get { lock.withLock { running } }
        set { lock.withLock { running = newValue } }
    }

    var sendings: [Sending] { lock.withLock { stating } }
    var sending: Sending? { sendings.last }

    var puts: [Put] { lock.withLock { started } }
    var answered: [String] { lock.withLock { landed } }
    var statuses: [Int] { lock.withLock { status } }
    var exchanges: Int { lock.withLock { asked } }
    var receivedAll: [String: Int] { lock.withLock { received } }
    var silent: Bool {
        get { lock.withLock { quiet } }
        set { lock.withLock { quiet = newValue } }
    }
    var holding: Bool {
        get { lock.withLock { holds } }
        set { lock.withLock { holds = newValue } }
    }
    var holdingWhen: (@Sendable ([String: SourceCustody]) -> Bool)? {
        get { lock.withLock { holdsWhen } }
        set { lock.withLock { holdsWhen = newValue } }
    }
    var replying: (@Sendable ([String: SourceCustody]) -> Reply)? {
        get { lock.withLock { replies } }
        set { lock.withLock { replies = newValue } }
    }
    var alwaysStale: Bool {
        get { lock.withLock { stale } }
        set { lock.withLock { stale = newValue } }
    }
    var needs: [[String: Any]] {
        get { lock.withLock { stated } }
        set { lock.withLock { stated = newValue } }
    }
    var replaced: String? {
        get { lock.withLock { replacedAt } }
        set { lock.withLock { replacedAt = newValue } }
    }
    var loseDrainedAnswer: Bool {
        get { lock.withLock { loseAnswer } }
        set { lock.withLock { loseAnswer = newValue } }
    }
    var revoked: Bool { lock.withLock { didRevoke } }
    var wanted: [String: Any]? {
        get { lock.withLock { wanting } }
        set { lock.withLock { wanting = newValue } }
    }
    var wantedAsked: Int { lock.withLock { wantedAsks } }
    var mobileData: String? {
        get { lock.withLock { chosen } }
        set { lock.withLock { chosen = newValue } }
    }
    var settingsPosted: Int { lock.withLock { settingsSaid } }
    func received(_ source: String) -> Int { lock.withLock { received[source] ?? 0 } }
    func refusePass() { lock.withLock { refused = pass; pass = nil } }
    func takeBack() { lock.withLock { pass = refused } }
    func importAll() { lock.withLock { imported = received } }
    func restore() { lock.withLock { received = [:]; imported = [:]; sealed = [] } }
    func holdExchange() -> Gate {
        let gate = Gate()
        lock.withLock { self.gate = gate }
        return gate
    }
    func holdHeld() -> Gate {
        let gate = Gate()
        lock.withLock { asking = gate }
        return gate
    }
    fileprivate func began(_ put: Put) { lock.withLock { started.append(put) } }
    fileprivate func gave(_ authorization: String?) -> Bool {
        lock.withLock { pass.map { "Bearer " + $0 == authorization } ?? false || given.contains { "Bearer " + $0 == authorization } }
    }
    fileprivate func refuses(_ authorization: String?) -> Bool {
        lock.withLock { pass.map { "Bearer " + $0 != authorization } ?? true }
    }

    func perform(_ request: HomeRequest) async throws -> HomeResponse {
        let (response, held) = try lock.withLock { () throws -> (HomeResponse, Gate?) in
            let response = try answering(request)
            switch request.url.path {
            case "/v1/exchange":
                defer { gate = nil }
                return (response, gate)
            case "/v1/blobs/held":
                defer { asking = nil }
                return (response, asking)
            default:
                return (response, nil)
            }
        }
        if let held { try await held.wait() }
        return response
    }

    func stream(_ request: HomeRequest) async throws -> HomeStream { throw URLError(.unsupportedURL) }

    func fingerprint(of address: URL, within seconds: TimeInterval) async throws -> String { throw URLError(.unsupportedURL) }

    private func answering(_ request: HomeRequest) throws -> HomeResponse {
        if quiet { throw URLError(.cannotConnectToHost) }
        if request.method == "POST", request.url.path == "/v1/pair", case .json(let data) = request.body {
            let body = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
            guard body["code"] as? String == "12345678", body["account"] as? String == Self.account,
                  let stated = body["pass"] as? String else {
                return HomeResponse(status: 403, body: Self.json(["code": "PAIR_CODE", "message": "no"]))
            }
            pass = stated
            given.insert(stated)
            return HomeResponse(status: 200, body: Self.json(["unit": "iphone-aa00", "answer": answer()]))
        }
        guard let pass, request.headers["Authorization"] == "Bearer " + pass else {
            return HomeResponse(status: 401, body: Self.json(["code": "PRINCIPAL_UNKNOWN", "message": "no"]))
        }
        if request.method == "GET", request.url.path == "/v1/photos/wanted" {
            wantedAsks += 1
            guard let wanting else { return HomeResponse(status: 404, body: Self.json(["code": "ROUTE", "message": "no"])) }
            return HomeResponse(status: 200, body: Self.json(wanting))
        }
        if request.method == "POST", request.url.path == "/v1/settings", case .json(let data) = request.body {
            settingsSaid += 1
            let body = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
            if let value = body["devices.iphone-aa00.mobile_data"] as? String { chosen = value }
            return HomeResponse(status: 200, body: Self.json([:]))
        }
        guard request.method == "POST", request.url.path == "/v1/exchange" else {
            return HomeResponse(status: 404, body: Self.json(["code": "ROUTE", "message": "no"]))
        }
        asked += 1
        var body: [String: Any] = [:]
        if case .json(let data) = request.body { body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
        if let stated = body["sending"], let bytes = try? JSONSerialization.data(withJSONObject: stated),
           let sending = try? JSONDecoder().decode(Sending.self, from: bytes) { stating.append(sending) }
        guard body["drained"] as? Bool == true else { return HomeResponse(status: 200, body: Self.json(answer())) }
        guard replacedAt != nil, Self.sources.allSatisfy({ imported[$0] == received[$0] }) else {
            return HomeResponse(status: 409, body: Self.json(["code": "NOT_DRAINED", "message": "no", "answer": answer()]))
        }
        let reply = answer()
        self.pass = nil
        didRevoke = true
        if loseAnswer { throw URLError(.networkConnectionLost) }
        return HomeResponse(status: 200, body: Self.json(reply))
    }

    fileprivate func size(_ id: String) -> Int64 {
        lock.withLock {
            guard let exports else { return 0 }
            return Int64((try? FileDurability.regularFileSize(at: exports.appendingPathComponent(CaptureExporter.filename(for: id)))) ?? 0)
        }
    }

    fileprivate func custody(_ id: String) -> [String: SourceCustody] {
        lock.withLock {
            guard let exports else { return [:] }
            return (try? StoredZIPWriter.readManifest(from: exports.appendingPathComponent(CaptureExporter.filename(for: id))))?.custody ?? [:]
        }
    }

    fileprivate func take(_ id: String, authorization: String?) -> (Int, Data) {
        lock.withLock {
            let answered = { (status: Int, body: Data) -> (Int, Data) in
                self.status.append(status)
                return (status, body)
            }
            guard let pass, authorization == "Bearer " + pass else {
                return answered(401, Self.json(["code": "PRINCIPAL_UNKNOWN", "message": "no"]))
            }
            if sealed.contains(id) { return answered(200, Self.json(answer())) }
            guard let exports, let manifest = try? StoredZIPWriter.readManifest(
                from: exports.appendingPathComponent(CaptureExporter.filename(for: id))) else {
                return answered(422, Self.json(["code": "IOS_BUNDLE_BAD_ZIP", "message": "no"]))
            }
            if manifest.satOut?.isEmpty == true
                || (manifest.satOut ?? []).contains(where: { manifest.custody[$0] != nil || !Self.sources.contains($0) }) {
                return answered(422, Self.json(["code": "IOS_BUNDLE_BAD_MANIFEST", "message": "no"]))
            }
            if stale || manifest.custody.contains(where: { $0.value.seal != (received[$0.key] ?? 0) + 1 }) {
                return answered(409, Self.json(["code": "STALE", "message": "seal again", "answer": answer()]))
            }
            for (source, custody) in manifest.custody { received[source] = custody.seal }
            sealed.insert(id)
            landed.append(id)
            return answered(201, Self.json(answer()))
        }
    }

    private func answer() -> [String: Any] {
        turnN += 1
        var sources: [String: Any] = [:]
        for source in Self.sources {
            sources[source] = ["received": received[source] ?? 0, "imported": imported[source] ?? 0, "formats": ["ios-bundle-3"], "history": true]
        }
        var home: [String: Any] = ["id": "h-0001", "version": running.version, "floors": ["phone": "0.1.0"]]
        if let generation = running.generation { home["generation"] = generation }
        var answer: [String: Any] = ["home": home, "pass": "p-0001", "unit": "iphone-aa00", "sources": sources, "owner": [String](),
                                     "needs": stated, "calls": [], "settings": [String: Any](), "turn": ["run": Self.run, "n": turnN]]
        if let replacedAt { answer["replaced"] = replacedAt }
        if let chosen { answer["mobile_data"] = chosen }
        return answer
    }

    fileprivate static func json(_ object: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
    }
}

final class HomeProtocol: URLProtocol, @unchecked Sendable {
    final class Answer: NSObject, @unchecked Sendable {
        let reply: Home.Reply
        init(_ reply: Home.Reply) { self.reply = reply }
    }

    private var put: Home.Put?
    private var home: Home?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canInit(with task: URLSessionTask) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let home = Home.current else { return fail() }
        let put = Home.Put(bundle: url.lastPathComponent, bytes: home.size(url.lastPathComponent),
                           crossing: MobileData.Crossing(costly: request.allowsExpensiveNetworkAccess,
                                                         lowData: request.allowsConstrainedNetworkAccess),
                           kind: request.value(forHTTPHeaderField: HomeLink.kindHeader),
                           sources: Set(home.custody(url.lastPathComponent).keys), load: self, thread: .current)
        self.put = put
        self.home = home
        home.began(put)
        guard !home.holding, home.holdingWhen?(home.custody(put.bundle)) != true else { return }
        reply(Answer(home.replying?(home.custody(put.bundle)) ?? .take))
    }

    override func stopLoading() { put?.stop() }

    private func fail() { client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)) }

    @objc func reply(_ answer: Answer) {
        guard let put, let home, !put.stopped else { return }
        let status: Int, body: Data
        var headers = ["Content-Type": "application/json"]
        switch answer.reply {
        case .fail: return fail()
        case .busy(let retryAfter):
            (status, body) = (409, Home.json(["code": "UPLOAD_ACTIVE", "message": "still reading"]))
            headers["Retry-After"] = String(retryAfter)
        case .takeThenDrop:
            _ = home.take(put.bundle, authorization: request.value(forHTTPHeaderField: "Authorization"))
            return fail()
        case .refuse(let code, let words): (status, body) = (code, Home.json(["code": words, "message": "refused"]))
        case .take: (status, body) = home.take(put.bundle, authorization: request.value(forHTTPHeaderField: "Authorization"))
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status,
            httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
}

final class MemoryPass: Credentials, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    private var isLocked = false
    var locked: Bool {
        get { lock.withLock { isLocked } }
        set { lock.withLock { isLocked = newValue } }
    }
    func read() throws -> Data? {
        try lock.withLock {
            if isLocked { throw LinkFailure.credentials }
            return data
        }
    }
    func write(_ data: Data) throws { lock.withLock { self.data = data } }
    func delete() throws { lock.withLock { data = nil } }
}

@MainActor
final class Warnings: WarningCenter {
    struct Posted: Equatable {
        let id: String
        let body: String
        let after: TimeInterval?
        let sound: Bool
    }
    struct Refused: Error {}
    private(set) var posted: [Posted] = []
    private(set) var removed: [[String]] = []
    var refusing = false
    func post(id: String, body: String, after delay: TimeInterval?, sound: Bool) async throws {
        if refusing { throw Refused() }
        posted.append(Posted(id: id, body: body, after: delay, sound: sound))
    }
    func remove(_ ids: [String]) { removed.append(ids) }
}

final class RigClock: @unchecked Sendable {
    private let lock = NSLock()
    private var instant: Date

    init(_ at: Date) { instant = at }

    var at: Date {
        get { lock.withLock { instant } }
        set { lock.withLock { instant = newValue } }
    }

    var now: @Sendable () -> Date { { self.at } }
}
