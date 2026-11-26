import Combine
import Foundation
import HomeLink
import LifestreamCaptureCore
import os
import PhotoLibrary

@MainActor
final class PhoneShipper: ObservableObject {
    enum Reason: Int, Comparable {
        case wake, processing, foreground, refresh, manual
        static func < (a: Reason, b: Reason) -> Bool { a.rawValue < b.rawValue }

        var name: String {
            switch self {
            case .wake: "wake"
            case .processing: "processing"
            case .foreground: "foreground"
            case .refresh: "refresh"
            case .manual: "manual"
            }
        }
    }

    struct Conditions: Sendable {
        var long: Bool
    }

    struct Unsent: Equatable {
        var fix: Date?
        var other: Date?
        var heldUntil: Date?
        var waitsForNetwork = false
    }

    enum Wait: Hashable, Sendable {
        case longWake
        case network(MobileData.Wait)
    }

    nonisolated static let aloneBytes = CaptureExporter.sharedBytes
    nonisolated static let tooOldSeconds: TimeInterval = 3600
    static let photoGap: TimeInterval = 300
    static let photoBackstop: TimeInterval = 1800

    @Published private(set) var state: ShipperState
    @Published private(set) var homeName: String?
    @Published private(set) var unit: String?
    @Published private(set) var saved: SavedAnswer?
    @Published private(set) var pending: [PendingBundle] = []
    @Published private(set) var waits: Set<Wait> = []
    @Published private(set) var sendFailure: String?
    @Published private(set) var lifecycle: Lifecycle
    private(set) var clock = SendClock()
    private(set) var custodyKnown = true
    private(set) var aftermaths: [Int: Task<Void, Never>] = [:]
    let link: HomeLink
    let custody: PhoneCustody
    private let warnings: HomeWarnings
    private let stateURL: URL
    private let now: @MainActor () -> Date
    private let hardware: @MainActor () -> DeviceHardware
    private let appVersion: String
    private let conditions: @MainActor () -> Conditions
    private let ledger: EnergyLedger
    private let clear: @MainActor (FreshAnswer) async throws -> Void
    private let settings: @MainActor (FreshAnswer) async -> Bool
    private let settingWaits: @MainActor () -> Bool
    private let exchange: @MainActor (HomeLink) async throws -> FreshAnswer
    private let uploads: @MainActor () async -> Void
    private let stopRecording: @MainActor () async -> Void
    private let sleep: @MainActor (Date) async -> Void
    private let ready: @MainActor (Reason) async -> Bool
    private let budget: @MainActor (_ expired: @escaping @MainActor () -> Void) -> @MainActor () -> Void
    private let photoPass: @MainActor (PhotoPass.Grant) async -> Void
    private let contactsPass: @MainActor (_ manual: Bool) async -> ReadOutcome?
    private let contactsStarted: @MainActor () async -> Date?
    private var stopped = false
    private var timer: Task<Void, Never>?
    private var asked: Reason?
    private var waiting: [Caller] = []
    private var riding: [Caller] = []
    private var passes = 0
    private var made = 0
    private var lastPhotoPass: Date?
    private var gapping: Set<CaptureDomain> = []
    private var triggers: [Int: Task<Void, Never>] = [:]
    private var queued: Send?
    private var lastPass: Task<Void, Never>?
    private var live: [Send] = []
    private var custodyTail: Task<Void, Never>?
    private var applied: FreshAnswer?
    private var tidied = false
    private var requests: [String: Task<Void, Never>] = [:]
    private static let log = Logger(subsystem: "org.lifestreamprotocol.phone", category: "shipping")

    init(stateURL: URL, link: HomeLink, custody: PhoneCustody, warnings: HomeWarnings,
         now: @escaping @MainActor () -> Date, hardware: @escaping @MainActor () -> DeviceHardware, appVersion: String,
         ledger: EnergyLedger = .shared,
         conditions: @escaping @MainActor () -> Conditions,
         clear: @escaping @MainActor (FreshAnswer) async throws -> Void,
         settings: @escaping @MainActor (FreshAnswer) async -> Bool,
         settingWaits: @escaping @MainActor () -> Bool,
         exchange: @escaping @MainActor (HomeLink) async throws -> FreshAnswer,
         uploads: @escaping @MainActor () async -> Void,
         stopRecording: @escaping @MainActor () async -> Void,
         sleep: @escaping @MainActor (Date) async -> Void,
         ready: @escaping @MainActor (Reason) async -> Bool,
         budget: @escaping @MainActor (_ expired: @escaping @MainActor () -> Void) -> @MainActor () -> Void,
         photoPass: @escaping @MainActor (PhotoPass.Grant) async -> Void,
         contacts: @escaping @MainActor (_ manual: Bool) async -> ReadOutcome?,
         contactsStarted: @escaping @MainActor () async -> Date?) {
        self.stateURL = stateURL; self.link = link; self.custody = custody
        self.warnings = warnings; self.now = now; self.hardware = hardware; self.appVersion = appVersion
        self.ledger = ledger; self.conditions = conditions; self.clear = clear; self.settings = settings
        self.settingWaits = settingWaits; self.exchange = exchange; self.uploads = uploads
        self.stopRecording = stopRecording; self.sleep = sleep; self.ready = ready; self.budget = budget
        self.photoPass = photoPass; self.contactsPass = contacts; self.contactsStarted = contactsStarted
        let state: ShipperState
        do {
            if let bytes = try FileDurability.readRegularFileIfPresent(at: stateURL, maximumBytes: 1024 * 1024) {
                state = try JSONDecoder.lifestream().decode(ShipperState.self, from: bytes)
            } else { state = ShipperState() }
        } catch {
            Self.log.error("shipper.json does not read and is replaced: \(String(describing: error), privacy: .public)")
            state = ShipperState()
        }
        self.state = state
        lifecycle = Lifecycle(state.outcome)
        homeName = Self.homeName(of: link)
        unit = link.unit
        saved = link.saved
        link.tell(sending: state.sending)
        link.onAnswer { [weak self] in Task { @MainActor in await self?.landed() } }
        warnings.follow(link)
        Task { [weak self, link] in
            for await _ in link.mobileChanges() {
                guard let self else { return }
                tell(.network)
            }
        }
    }

    var paired: Bool { homeName != nil }

    var running: Bool { lifecycle == .passing }

    var handedOver: Bool { lifecycle == .handedOver }

    private static func homeName(of link: HomeLink) -> String? {
        do { return try link.name().map(name(of:)) } catch { return "Lifestream" }
    }

    private static func name(of address: URL) -> String {
        let host = address.host() ?? address.absoluteString
        return host.split(separator: ".").first.map(String.init) ?? host
    }

    func reread() async {
        let answer = link.saved
        if answer != saved { saved = answer }
        let name: String?
        do { name = try link.name().map(Self.name(of:)) } catch { return }
        let unit = link.unit
        if unit != self.unit { self.unit = unit }
        guard name != homeName else { return }
        await custody.exporter.store.setPaired(name != nil)
        homeName = name
    }

    func read(_ domain: CaptureDomain, _ outcome: ReadOutcome) {
        guard let source = link.saved.flatMap({ PhoneCustody.sources($0.sources)[domain] }) else { return }
        let code = domain == .photos ? Self.photos : Self.localAccess
        failing { failures in
            switch outcome {
            case .read: failures.ended(source, .read)
            case .failed(let words): failures.failed(source, .read, code: code, message: words, at: now())
            }
        }
    }

    func couldNotStart(_ error: any Error) {
        Self.log.error("No send could start: \(String(describing: error), privacy: .public)")
        failing { $0.sendFailed(code: Self.localStorage, message: String(describing: error), at: now()) }
        sendFailure = "This phone couldn't send to Lifestream. It tries again at its next wake."
    }

    nonisolated static let localStorage = "LOCAL_STORAGE"
    nonisolated static let localAccess = "LOCAL_ACCESS"
    nonisolated static let photos = "PHOTOS"
    nonisolated static let notNow = "NOT_NOW"

    private func failing(_ change: (inout Failures) -> Void) {
        var failures = state.failures
        change(&failures)
        guard failures != state.failures else { return }
        state.failures = failures
        link.tell(sending: failures.sending)
        do { try persist() } catch { Self.log.error("shipper.json was not written: \(String(describing: error), privacy: .public)") }
    }

    private func storeFailed(_ error: any Error, _ send: Send) {
        Self.log.error("A send did not finish: \(String(describing: error), privacy: .public)")
        failing { $0.sendFailed(code: Self.localStorage, message: String(describing: error), at: send.start) }
        sendFailure = "This phone couldn't send to Lifestream. It tries again at its next wake."
        send.storeFailed = true
        send.hear(.decided(.storeFailed))
    }


    @MainActor
    private final class Caller {
        let reason: Reason
        let exporting: Bool
        var send: Send?
        private var waiting: CheckedContinuation<Void, Never>?

        init(_ reason: Reason, exporting: Bool = false) {
            self.reason = reason
            self.exporting = exporting
        }

        func wait(_ continuation: CheckedContinuation<Void, Never>) { waiting = continuation }

        func done() {
            waiting?.resume()
            waiting = nil
        }
    }

    func tell(_ event: SendClock.Event) {
        clock.note(event, at: now())
        schedule()
    }

    func appended(_ events: [SendClock.Event]) {
        let date = now()
        for event in events { clock.note(event, at: date) }
        schedule()
    }

    func prime() async {
        let unsent = await unsent()
        clock.remaining(oldestFix: unsent.fix, oldestOther: unsent.other, heldUntil: unsent.heldUntil,
                        waitsForNetwork: unsent.waitsForNetwork)
        schedule()
    }

    func ask(_ reason: Reason) {
        asked = max(asked ?? reason, reason)
        tell(.owed)
    }

    func send(_ reason: Reason) async {
        await wait(Caller(reason))
    }

    func shipNow() async {
        await admit(.manual)?.ended()
    }

    func refresh(_ sources: Set<String>) async {
        guard admits, let saved = link.saved else { return }
        let own = PhoneCustody.sources(saved.sources).filter { sources.contains($0.value) }
        guard !own.isEmpty, await ready(.refresh), admits else { return }
        if own[.contacts] != nil { await contacts(manual: true) }
        if own[.photos] != nil { await photos(.wake(.refresh)) }
        guard admits else { return }
        let send = begin(.refresh, cause: "ask_\(Reason.refresh.name)", exporting: false, only: Set(own.values))
        send.pressed.formUnion(own.values)
        if send.budget == nil { send.budget = budget { send.cancel() } }
        await withTaskCancellationHandler {
            await send.ended()
        } onCancel: {
            Task { @MainActor in send.cancel() }
        }
        guard admits else { return }
        await prime()
    }

    func export() async throws -> [URL] {
        guard paired else { return try await shared(by: nil) }
        let caller = Caller(.foreground, exporting: true)
        guard let send = await admit(.foreground, riding: caller) else {
            throw NothingToExport(errorDescription: "This phone can't export yet. Try again in a moment.")
        }
        await send.passed()
        release(caller)
        return try await shared(by: send)
    }

    func photos(_ grant: PhotoPass.Grant) async {
        lastPhotoPass = now()
        await photoPass(grant)
    }

    func libraryChanged() {
        trigger(.photos, last: { [weak self] in self?.lastPhotoPass }) { await $0.photos(.wake(.wake)) }
    }

    func contacts(manual: Bool) async {
        if let outcome = await contactsPass(manual) { read(.contacts, outcome) }
    }

    func contactsChanged() {
        trigger(.contacts, last: contactsStarted) { await $0.contacts(manual: true) }
    }

    private func trigger(_ domain: CaptureDomain, last: @escaping @MainActor () async -> Date?,
                         run: @escaping @MainActor (PhoneShipper) async -> Void) {
        guard gapping.insert(domain).inserted else { return }
        made += 1
        let id = made, now = now, sleep = sleep
        triggers[id] = Task { [weak self] in
            defer { self?.triggers[id] = nil }
            while let began = await last() {
                let wait = Self.photoGap - now().timeIntervalSince(began)
                guard wait > 0 else { break }
                await sleep(now().addingTimeInterval(wait))
                guard !Task.isCancelled else { return }
            }
            guard let self, !Task.isCancelled else { return }
            gapping.remove(domain)
            await run(self)
        }
    }

    private func wait(_ caller: Caller) async {
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                if Task.isCancelled { return continuation.resume() }
                caller.wait(continuation)
                waiting.append(caller)
                tell(.owed)
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancel(caller) }
        }
    }

    private func cancel(_ caller: Caller) {
        caller.done()
        if let index = waiting.firstIndex(where: { $0 === caller }) {
            waiting.remove(at: index)
            guard waiting.isEmpty, asked == nil else { return }
            clock.withdraw()
            schedule()
        } else if let index = riding.firstIndex(where: { $0 === caller }), let send = caller.send {
            riding.remove(at: index)
            if !riding.contains(where: { $0.send === send }) { send.cancel() }
        }
    }

    private func release(_ caller: Caller) {
        riding.removeAll { $0 === caller }
    }

    @discardableResult
    func admit(_ reason: Reason) async -> Send? {
        await admit(reason, riding: nil)
    }

    private func admit(_ reason: Reason, riding rider: Caller?, timed: Bool = false) async -> Send? {
        timer?.cancel()
        timer = nil
        passes += 1
        guard await ready(strongest(reason)), admits else { return refuse(reason) }
        if timed, !due {
            passes -= 1
            schedule()
            return nil
        }
        if strongest(reason) == .manual {
            await contacts(manual: true)
            guard admits else { return refuse(reason) }
        }
        let callers = waiting + [rider].compactMap { $0 }
        let reason = strongest(reason)
        let cause = (clock.next.map { $0 <= now() } == true ? clock.cause?.name : nil) ?? "ask_\(reason.name)"
        waiting = []
        asked = nil
        clock.started(at: now())
        let send = begin(reason, cause: cause, exporting: callers.contains(where: \.exporting))
        for caller in callers { caller.send = send }
        riding += callers
        if send.budget == nil { send.budget = budget { send.cancel() } }
        follow(send, reason)
        return send
    }

    private var due: Bool {
        asked != nil || !waiting.isEmpty || clock.next.map { $0 <= now() } ?? false
    }

    private var admits: Bool { !Task.isCancelled && lifecycle != .unpairing && lifecycle != .handedOver }

    private func refuse(_ reason: Reason) -> Send? {
        passes -= 1
        let asks = [asked].compactMap { $0 } + waiting.map(\.reason)
        asked = (Task.isCancelled ? asks : asks + [reason]).max()
        for caller in waiting { caller.done() }
        waiting = []
        return nil
    }

    private func follow(_ send: Send, _ reason: Reason) {
        made += 1
        let id = made
        aftermaths[id] = Task {
            defer { aftermaths[id] = nil }
            do {
                defer { passes -= 1 }
                await send.passed()
            }
            guard admits else { return }
            await prime()
            guard admits, lastPhotoPass.map({ now().timeIntervalSince($0) >= Self.photoBackstop }) ?? true else { return }
            await photos(.wake(reason))
            guard admits else { return }
            await contacts(manual: false)
        }
    }

    private func strongest(_ reason: Reason) -> Reason {
        ([reason] + [asked].compactMap { $0 } + waiting.map(\.reason)).max() ?? reason
    }

    private func schedule() {
        timer?.cancel()
        timer = nil
        guard passes == 0, let next = clock.next else { return }
        timer = Task { [weak self, sleep] in
            await sleep(next)
            guard let self, !Task.isCancelled else { return }
            timer = nil
            _ = await admit(.wake, riding: nil, timed: true)
        }
    }

    func stop() async {
        while true {
            timer?.cancel()
            timer = nil
            await windDown()
            let running = Array(triggers.values)
            guard !running.isEmpty else { break }
            for task in running { task.cancel() }
            for task in running { await task.value }
        }
        timer?.cancel()
        timer = nil
        gapping = []
    }

    private func windDown() async {
        while !live.isEmpty || !aftermaths.isEmpty {
            let sends = live, following = Array(aftermaths.values)
            for send in sends { send.cancel() }
            for task in following { task.cancel() }
            for send in sends { await send.ended() }
            for task in following { await task.value }
        }
    }


    @MainActor
    final class Send {
        fileprivate enum Heard: Comparable {
            case notYet
            case held(String)
            case delivered
            case passRefused(String)
            case decided(Outcome)

            static func < (a: Heard, b: Heard) -> Bool { (a.rank, a.key) < (b.rank, b.key) }

            private var rank: Int {
                switch self {
                case .notYet: 0
                case .held: 1
                case .delivered: 2
                case .passRefused: 3
                case .decided: 4
                }
            }

            private var key: String {
                switch self {
                case .notYet, .delivered: ""
                case .held(let code), .passRefused(let code): code
                case .decided(let outcome): outcome.word
                }
            }
        }

        fileprivate(set) var reason: Reason
        let cause: String
        fileprivate var exporting: Bool
        fileprivate var only: Set<String>?
        fileprivate var pressed: Set<String> = []
        fileprivate(set) var start = Date.distantPast
        fileprivate var pass: Task<Void, Never>?
        fileprivate var done: Task<Void, Never>?
        fileprivate var requests: [String: Task<Void, Never>] = [:]
        fileprivate var budget: (@MainActor () -> Void)?
        fileprivate var cancelled = false
        fileprivate var ran = false
        fileprivate var heard: Heard?
        fileprivate var backsOff = false
        fileprivate var notBefore: Date?
        fileprivate var whole = false
        fileprivate var storeFailed = false
        fileprivate var resealOwed = false
        fileprivate var copies: Result<[URL], any Error>?

        fileprivate init(_ reason: Reason, cause: String, exporting: Bool, only: Set<String>?) {
            self.reason = reason
            self.cause = cause
            self.exporting = exporting
            self.only = only
        }

        fileprivate func sends(_ bundle: PendingBundle) -> Bool {
            only.map { !$0.isDisjoint(with: bundle.sources) } ?? true
        }

        fileprivate func presses(_ bundle: PendingBundle) -> Bool {
            reason == .manual || !pressed.isDisjoint(with: bundle.sources)
        }

        fileprivate func hear(_ heard: Heard) {
            if self.heard.map({ $0 < heard }) ?? true { self.heard = heard }
        }

        fileprivate func notYet(until deadline: Date? = nil) {
            backsOff = true
            if let deadline { notBefore = max(notBefore ?? deadline, deadline) }
            hear(.notYet)
        }

        func passed() async { await pass?.value }

        func ended() async { await done?.value }

        func cancel() {
            cancelled = true
            pass?.cancel()
            done?.cancel()
            for request in requests.values { request.cancel() }
        }
    }

    private func begin(_ reason: Reason, cause: String, exporting: Bool, only: Set<String>? = nil) -> Send {
        if let queued, !queued.cancelled {
            queued.reason = max(queued.reason, reason)
            queued.exporting = queued.exporting || exporting
            if let theirs = queued.only { queued.only = only.map { theirs.union($0) } }
            return queued
        }
        let send = Send(reason, cause: cause, exporting: exporting, only: only)
        let before = lastPass
        queued = send
        let pass = Task {
            await before?.value
            if queued === send { queued = nil }
            await self.pass(send)
        }
        send.pass = pass
        send.done = Task {
            await pass.value
            await self.finish(send)
        }
        lastPass = pass
        live.append(send)
        return send
    }

    struct NothingToExport: LocalizedError {
        let errorDescription: String?
    }

    private func shared(by send: Send?) async throws -> [URL] {
        guard let send else {
            guard let copy = try await custody.exporter.copy(hardware: hardware(), appVersion: appVersion, now: now())
            else { throw NothingToExport(errorDescription: "Nothing is recorded yet. An export holds what this phone records.") }
            return [copy.url]
        }
        if send.cancelled { throw NothingToExport(errorDescription: "The export stopped before it finished. Try again.") }
        if let copies = try send.copies?.get(), !copies.isEmpty { return copies }
        if let sendFailure { throw NothingToExport(errorDescription: sendFailure) }
        throw NothingToExport(errorDescription: "Lifestream holds everything this phone has recorded. Nothing is left to export.")
    }

    private var shareFolder: URL { custody.exporter.exportsDirectory.appendingPathComponent("share", isDirectory: true) }

    private static func clone(_ files: [URL], into folder: URL) async throws -> [URL] {
        try await Task.detached {
            let manager = FileManager.default
            if manager.fileExists(atPath: folder.path) { try manager.removeItem(at: folder) }
            try manager.createDirectory(at: folder, withIntermediateDirectories: true)
            return try files.map { file in
                let copy = folder.appendingPathComponent(file.lastPathComponent)
                try manager.copyItem(at: file, to: copy)
                return copy
            }
        }.value
    }

    func unpair() async throws {
        guard lifecycle.startUnpair() else { return }
        defer { lifecycle.endUnpair() }
        await windDown()
        try await forgetPass()
        try await note(.noHome, at: now())
    }

    func refused(_ code: String) async {
        try? await note(.refused(code), at: now())
    }

    private func forgetPass() async throws {
        try await forgetPending()
        try link.forget()
        await reread()
    }

    private func forgetPending() async throws {
        for request in requests.values { request.cancel() }
        try await custodial { try await self.custody.forgetPending() }
        failing { $0 = Failures() }
    }


    private func pass(_ send: Send) async {
        guard !send.cancelled, lifecycle.startPass() else { return }
        defer { lifecycle.endPass() }
        send.ran = true
        send.start = now()
        await ledger.measure(.shipping) {
            ledger.count("ship_passes")
            ledger.count("send_cause_\(send.cause)_\(clock.onPower ? "power" : "battery")")
            do {
                if !tidied {
                    let kept: Set<String> = [stateURL.lastPathComponent, "answer.json"]
                    try await custodial { try await self.custody.tidy(keeping: kept) }
                    tidied = true
                }
                state.expiryWarned = await warnings.expiry(warned: state.expiryWarned, at: send.start)
                if let decided = try await decide(send) { send.hear(.decided(decided)) }
                failing { failures in
                    if send.whole, !send.storeFailed, custodyKnown, failures.send?.code == Self.localStorage {
                        failures.send = nil
                    }
                }
                sendFailure = nil
            } catch is CancellationError {
                send.notYet()
            } catch {
                storeFailed(error, send)
            }
            await reread()
        }
    }

    private func decide(_ send: Send) async throws -> Outcome? {
        guard try link.name() != nil else {
            try await forgetPending()
            return .noHome
        }
        try await custody.exporter.store.flushForSend()

        var answered = false
        let refused = state.outcome.asksAgain
        var owed = send.reason >= .foreground || send.exporting || link.owesExchange || settingWaits() || refused
            || link.saved == nil || link.saved?.replaced != nil
        if !owed { owed = await awaitsFresh(send) }
        if owed {
            ledger.count("exchanges")
            do {
                _ = try await exchange(link)
                answered = true
            } catch let failure as LinkFailure {
                switch failure {
                case .noAnswer: send.notYet()
                case .unavailable(let code, _, let retryAfter, _):
                    send.notYet(until: retryAfter.map { now().addingTimeInterval($0) })
                    if code != Self.notNow { send.hear(.held(code)) }
                case .unpaired:
                    try await forgetPending()
                    return .noHome
                case .credentials: throw failure
                case .homeTooOld:
                    send.notYet()
                    failing { $0.sendFailed(code: failure.code, message: failure.description, at: send.start) }
                    return .held(failure.code)
                default:
                    send.notYet()
                    return failure == .clockAhead || failure.code == "DEVICE_TOO_OLD" ? .held(failure.code) : .refused(failure.code)
                }
            }
            try Task.checkCancellation()
            if answered, try await custodial({ try await self.applyNewest() }) { send.whole = true }
        }
        if refused, !answered {
            return state.outcome
        }

        start(send)
        try await seal(send)
        start(send)
        if send.only == nil { await uploads() }

        if let answer = link.fresh, answer.replaced != nil, pending.isEmpty, try await custody.holdsNothingMore(answer) {
            do {
                _ = try await link.exchange(drained: true)
                return handOver() ? .handedOver : nil
            } catch let failure as LinkFailure {
                switch failure {
                case .refused(409, "NOT_DRAINED", _): send.notYet()
                case .noAnswer, .unanswered:
                    send.notYet()
                    return .unreachable
                case .unavailable(let code, _, let retryAfter, _):
                    send.notYet(until: retryAfter.map { now().addingTimeInterval($0) })
                    return code == Self.notNow ? .unreachable : .held(code)
                case .refused: return .refused(failure.code)
                default: throw failure
                }
            }
        }
        return nil
    }

    private func awaitsFresh(_ send: Send) async -> Bool {
        guard link.fresh == nil, let saved = link.saved else { return false }
        return (try? await custody.awaitsFresh(saved, only: send.only)) == true
    }


    @discardableResult
    func custodial<T: Sendable>(_ work: @escaping @MainActor () async throws -> T) async throws -> T {
        let step = step(work)
        return try await withTaskCancellationHandler {
            try await step.value
        } onCancel: {
            step.cancel()
        }
    }

    private func step<T: Sendable>(_ work: @escaping @MainActor () async throws -> T) -> Task<T, any Error> {
        let before = custodyTail
        let step = Task { @MainActor in
            await before?.value
            try Task.checkCancellation()
            let result: Result<T, any Error>
            do { result = .success(try await work()) } catch { result = .failure(error) }
            do {
                pending = try await custody.pending()
                custodyKnown = true
            } catch {
                custodyKnown = false
                Self.log.error("The bundles in flight did not read: \(String(describing: error), privacy: .public)")
                failing { $0.sendFailed(code: Self.localStorage, message: String(describing: error), at: now()) }
                if case .success = result { throw error }
            }
            return try result.get()
        }
        custodyTail = Task { _ = await step.result }
        return step
    }

    @discardableResult
    private func applyNewest() async throws -> Bool {
        guard let answer = link.fresh else { return false }
        if answer.replaced != nil, !stopped {
            stopped = true
            await stopRecording()
        }
        let judged = try await custody.applied(answer, prune: answer != applied)
        if answer.replaced != nil, !handedOver, !judged.contains(where: { $0.fate == .waiting || $0.fate == .unsettled }) {
            ask(.wake)
        }
        guard answer != applied else { return false }
        failing { failures in
            failures.sources = failures.sources.filter { answer.sources[$0.key] != nil }
            if failures.send?.code == LinkFailure.homeTooOld.code { failures.send = nil }
        }
        do { try await clear(answer) } catch {
        }
        state.shown = await warnings.show(answer.needs.filter { !$0.dismissed }, unit: answer.unit, shown: state.shown)
        if await settings(answer) {
            link.owe()
            ask(.wake)
        }
        try persist()
        applied = answer
        return true
    }

    private func seal(_ send: Send) async throws {
        var held: Set<String> = []
        if !send.backsOff, let saved = link.saved, let named = try? await custody.named(saved, only: send.only), !named.isEmpty {
            held = (try? await link.held(blobs: named)) ?? []
        }
        try await custodial { try await self.sealDue(send, held: held) }
    }

    private func sealDue(_ send: Send, held: Set<String>) async throws {
        try await applyNewest()
        let date = now()
        for bundle in try await custody.pending() {
            guard let last = bundle.last, last.heard == .refused,
                  send.presses(bundle) || date >= HomeLink.Outbox.Wait.refused.until(last.at) else { continue }
            try await custody.forget(bundle)
        }
        let failing = Set(state.failures.sources.filter { $0.value[.read] != nil }.keys)
        let sealed: PhoneCustody.Sealed
        if let fresh = link.fresh {
            sealed = try await custody.seal(fresh, only: send.only, failing: failing, held: held, hardware: hardware(),
                                           appVersion: appVersion, now: send.start)
        } else if let saved = link.saved {
            sealed = try await custody.seal(saved, only: send.only, failing: failing, held: held, hardware: hardware(),
                                           appVersion: appVersion, now: send.start)
        } else {
            return
        }
        send.whole = true
        self.failing { failures in
            for source in failures.sources.keys where sealed.satOut[source] == nil { failures.ended(source, .seal) }
            for (source, error) in sealed.satOut {
                failures.failed(source, .seal, code: Self.localStorage, message: error, at: send.start)
            }
        }
        if !sealed.bundles.isEmpty { ledger.count("bundles_sealed", sealed.bundles.count) }
        if send.exporting, send.copies == nil {
            do {
                let files = try await custody.pending().map(custody.file)
                send.copies = .success(try await Self.clone(files, into: shareFolder))
            } catch {
                send.copies = .failure(error)
            }
        }
    }

    private func landed() async {
        do { try await custodial { try await self.applyNewest() } } catch {
            Self.log.error("An answer was not applied: \(String(describing: error), privacy: .public)")
        }
    }


    private enum Startable {
        case now
        case at(Date)
        case waits(Set<Wait>)
    }

    private func startable(_ bundle: PendingBundle, pressed: Bool, _ conditions: Conditions, at date: Date) -> Startable {
        if let last = bundle.last, let ends = Self.waitEnds(last) {
            if last.heard == .refused { return .at(ends) }
            if last.heard == .held, !pressed, date < ends { return .at(ends) }
        }
        if pressed { return .now }
        let bytes = (try? FileDurability.regularFileSize(at: custody.file(bundle))) ?? 0
        var waits = Set<Wait>()
        if bytes >= Self.aloneBytes, !conditions.long { waits.insert(.longWake) }
        if case .waits(let wait) = link.mobile(pressed: false).decide(.new, bytes: Int64(clamping: bytes)) {
            waits.insert(.network(wait))
        }
        return waits.isEmpty ? .now : .waits(waits)
    }

    private static func waitEnds(_ last: PendingBundle.Request) -> Date? {
        switch last.heard {
        case .refused: HomeLink.Outbox.Wait.refused.until(last.at)
        case .held where last.code == "CLOCK_AHEAD": HomeLink.Outbox.Wait.clockAhead.until(last.at)
        case .held: last.at.addingTimeInterval(tooOldSeconds)
        default: nil
        }
    }

    private func start(_ send: Send) {
        guard !send.cancelled, custodyKnown else { return }
        let conditions = conditions()
        let date = now()
        let ordered = pending.enumerated().sorted { a, b in
            func rank(_ bundle: PendingBundle) -> Int {
                if let last = bundle.last, !last.answered { return 0 }
                return bundle.seals.keys.contains { $0.hasPrefix("location:") } ? 1 : 2
            }
            return (rank(a.element), a.offset) < (rank(b.element), b.offset)
        }.map(\.element)
        for bundle in ordered where send.sends(bundle) && requests[bundle.id] == nil && send.requests[bundle.id] == nil {
            switch startable(bundle, pressed: send.presses(bundle), conditions, at: date) {
            case .now: request(bundle, send)
            case .at: send.hear(.held(bundle.last?.code ?? "HELD"))
            case .waits: continue
            }
        }
    }

    private func request(_ bundle: PendingBundle, _ send: Send) {
        let file = custody.file(bundle)
        let requesting = step { [custody, now] in try await custody.requesting(bundle, at: now()) }
        let task = Task { [link] in
            defer { requests[bundle.id] = nil }
            do {
                try await withTaskCancellationHandler {
                    try await requesting.value
                } onCancel: {
                    requesting.cancel()
                }
            } catch is CancellationError {
                send.notYet()
                return
            } catch {
                storeFailed(error, send)
                return
            }
            do {
                _ = try await link.send(bundle: file, id: bundle.id, kind: .new, pressed: send.presses(bundle))
                await delivered(bundle, send)
            } catch {
                await failed(bundle, error, send)
            }
        }
        requests[bundle.id] = task
        send.requests[bundle.id] = task
        if !handedOver, state.outcome != .uploading { state.outcome = .uploading }
    }

    private func settle(_ bundle: PendingBundle, _ heard: PendingBundle.Request.Heard, code: String?, _ send: Send) async {
        let step = Task {
            try await custodial {
                try await self.custody.heard(bundle, heard, code: code, at: self.now())
                try await self.applyNewest()
            }
        }
        if case .failure(let error) = await step.result { storeFailed(error, send) }
    }

    private func delivered(_ bundle: PendingBundle, _ send: Send) async {
        send.hear(.delivered)
        await settle(bundle, .taken, code: nil, send)
        failing { failures in for source in bundle.sources { failures.ended(source, .delivery) } }
    }

    private func failed(_ bundle: PendingBundle, _ error: any Error, _ send: Send) async {
        let date = now()
        func refusing(_ code: String, _ message: String) {
            send.hear(.held(code))
            failing { failures in
                for source in bundle.sources { failures.failed(source, .delivery, code: code, message: message, at: date) }
            }
        }
        switch error {
        case LinkFailure.stale:
            await settle(bundle, .stale, code: "STALE", send)
            send.resealOwed = true
        case LinkFailure.busy(let retryAfter):
            send.notYet(until: HomeLink.Outbox.Wait.busy.until(date, retryAfter: retryAfter))
            await settle(bundle, .notYet, code: "UPLOAD_ACTIVE", send)
        case LinkFailure.unavailable(let code, _, let retryAfter, _):
            send.notYet(until: retryAfter.map { date.addingTimeInterval($0) })
            if code != Self.notNow { send.hear(.held(code)) }
            await settle(bundle, .notYet, code: code, send)
        case LinkFailure.clockAhead:
            await settle(bundle, .held, code: "CLOCK_AHEAD", send)
            refusing("CLOCK_AHEAD", "Lifestream holds back what this phone sealed by a clock ahead of its own")
        case LinkFailure.tooOld(let floor):
            await settle(bundle, .held, code: "DEVICE_TOO_OLD", send)
            refusing("DEVICE_TOO_OLD", "Lifestream takes this phone's bundles from \(floor) on")
        case LinkFailure.refused(401, let code, _):
            send.notYet()
            send.hear(.passRefused(code))
            await settle(bundle, .passRefused, code: code, send)
        case LinkFailure.refused(_, let code, let message):
            await settle(bundle, .refused, code: code, send)
            refusing(code, message)
        case LinkFailure.homeTooOld:
            send.notYet()
            send.hear(.decided(.held(LinkFailure.homeTooOld.code)))
            await settle(bundle, .homeTooOld, code: LinkFailure.homeTooOld.code, send)
            failing { $0.sendFailed(code: LinkFailure.homeTooOld.code, message: LinkFailure.homeTooOld.description, at: date) }
        default:
            send.notYet()
        }
    }

    private func finish(_ send: Send) async {
        defer { closed(send) }
        guard send.ran else { return }
        await requestsEnded(send)
        if send.resealOwed, !send.cancelled {
            do { try await seal(send) } catch is CancellationError {} catch {
                storeFailed(error, send)
            }
            start(send)
            await requestsEnded(send)
        }
        await ended(send)
    }

    private func closed(_ send: Send) {
        send.budget?()
        send.budget = nil
        for caller in riding where caller.send === send { caller.done() }
        riding.removeAll { $0.send === send }
        live.removeAll { $0 === send }
    }

    private func requestsEnded(_ send: Send) async {
        var awaited: Set<String> = []
        while let next = send.requests.first(where: { !awaited.contains($0.key) }) {
            awaited.insert(next.key)
            await next.value.value
        }
    }

    private func ended(_ send: Send) async {
        let outcome: Outcome = switch send.heard {
        case .decided(let decided): decided
        case .passRefused(let code): .refused(code)
        case .delivered: .shipped
        case .held(let code): .held(code)
        case .notYet: .unreachable
        case nil: !requests.isEmpty ? .uploading : !pending.isEmpty ? .waiting
            : state.outcome == .shipped ? .shipped : .nothingNew
        }
        do { try await note(outcome, at: send.start) } catch {
            Self.log.error("The outcome was not noted: \(String(describing: error), privacy: .public)")
        }
        if send.only == nil { clock.answered(!send.backsOff, at: now(), notBefore: send.notBefore) }
        await prime()
    }

    func unsent() async -> Unsent {
        guard custodyKnown, let saved = link.saved else { return Unsent() }
        let date = now(), conditions = conditions()
        var unsent = Unsent()
        var waits = Set<Wait>()
        defer { if waits != self.waits { self.waits = waits } }
        var skipping = Set<String>()
        for bundle in pending {
            if requests[bundle.id] != nil {
                skipping.formUnion(bundle.sources)
                continue
            }
            switch startable(bundle, pressed: false, conditions, at: date) {
            case .now: break
            case .at(let ends):
                skipping.formUnion(bundle.sources)
                unsent.heldUntil = min(unsent.heldUntil ?? ends, ends)
            case .waits(let holding):
                skipping.formUnion(bundle.sources)
                waits.formUnion(holding)
                if holding.contains(where: { if case .network = $0 { true } else { false } }) { unsent.waitsForNetwork = true }
            }
        }
        if let oldest = try? await custody.unsent(saved, skipping: skipping) {
            unsent.fix = oldest.fix
            unsent.other = oldest.other
        }
        return unsent
    }

    private func handOver() -> Bool {
        guard lifecycle.handOver() else { return false }
        state.outcome = .handedOver
        do { try persist() } catch {
            Self.log.error("The hand-over was not kept: \(String(describing: error), privacy: .public)")
        }
        return true
    }

    private func note(_ outcome: Outcome, at date: Date) async throws {
        guard !handedOver || outcome == .handedOver else { return }
        let hour = { (d: Date) in Calendar.current.dateInterval(of: .hour, for: d)?.start }
        let turned = !(outcome.sending && state.outcome.sending) && outcome != state.outcome
        if turned || state.recordedAt.flatMap(hour) != hour(date), !(await custody.exporter.store.isStopped) {
            _ = try await custody.exporter.store.append(domain: .location, draft: .init(kind: "lifecycle",
                observedAt: CaptureTime.rfc3339(date),
                payload: .object(["event": .string("shipping"), "outcome": .string(outcome.word)])))
            state.recordedAt = date
        }
        guard !handedOver || outcome == .handedOver else { return }
        state.outcome = outcome
        try persist()
    }

    private func persist() throws {
        let bytes = try JSONEncoder.lifestream().encode(state)
        try FileDurability.createDirectoryDurably(at: stateURL.deletingLastPathComponent())
        try bytes.write(to: stateURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        try FileDurability.synchronizeFile(at: stateURL)
        try FileDurability.synchronizeParentDirectory(of: stateURL)
    }
}

enum ReadOutcome: Equatable, Sendable {
    case read
    case failed(String)

    init?(ending error: (any Error)?) {
        guard let error else { self = .read; return }
        if (error as? CaptureError) == .full { return nil }
        self = .failed(error.localizedDescription)
    }
}

extension MobileData.Decision {
    var wait: MobileData.Wait? {
        if case .waits(let wait) = self { wait } else { nil }
    }
}
