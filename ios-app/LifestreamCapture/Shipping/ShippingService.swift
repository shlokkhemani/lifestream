import Foundation
import HomeLink
import LifestreamCaptureCore
import PhotoLibrary
import Synchronization
import UIKit

@MainActor
final class ShippingService {
    private let runtime: AppRuntime
    private static var isTesting: Bool {
        NSClassFromString("XCTestCase") != nil
            || ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
            || ProcessInfo.processInfo.arguments.contains("--ui-testing")
    }
    private var observers: [NSObjectProtocol] = []
    private var network: Task<Void, Never>?
    private var started = false
    private let power = OnPower()
    lazy var link = makeLink()
    lazy var shipper = makeShipper()
    lazy var backgroundSync = BackgroundSync { [weak self] kind in
        await self?.runBackgroundSync(kind)
    }

    private func runBackgroundSync(_ kind: BackgroundSync.Kind) async {
        let name = kind == .refresh ? "background_refresh" : "background_processing"
        EnergyLedger.shared.wake(name)
        runtime.recordLifecycle(name)
        if kind == .processing {
            await shipper.send(.processing)
            if !Task.isCancelled { await runtime.sweepHistoriesInBackground() }
            if !Task.isCancelled { await runtime.refreshCheckIns() }
            if !Task.isCancelled { await shipper.photos(.processing) }
        } else {
            await runtime.refreshCheckIns()
            await shipper.send(.wake)
        }
        await EnergyLedger.shared.flush()
        if shipper.handedOver { backgroundSync.cancel() }
    }

    private static func photoPass(_ grant: PhotoPass.Grant, link: HomeLink) async {
        guard !isTesting, !PhotosServices.shared.bringingIn else { return }
        await PhotosServices.shared.run(grant, device: await device(link))
    }

    static func device(_ link: HomeLink) async -> Device {
        let battery = UIDevice.current.batteryState
        if SystemNetwork.shared.facts == nil { for await _ in SystemNetwork.shared.changes() { break } }
        let store = AppRuntime.shared.captureStore
        let free = Room.free(at: await store.root)
        return Device(link.mobile(pressed: PhotosServices.shared.bringingIn), charging: battery == .charging || battery == .full,
                      spare: store.volume.spare, changeRoom: free.map { max(0, $0 - Room.bottomBytes) } ?? .max)
    }

    init(runtime: AppRuntime) {
        self.runtime = runtime
    }

    func start() {
        guard !Self.isTesting, !started else { return }
        started = true
        UIDevice.current.isBatteryMonitoringEnabled = true
        power.set(Self.charging)
        shipper.tell(.power(power.on))
        shipper.tell(.lowPower(ProcessInfo.processInfo.isLowPowerModeEnabled))
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: UIDevice.batteryStateDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let on = Self.charging
                guard self.power.set(on) else { return }
                self.shipper.tell(.power(on))
            }
        })
        observers.append(center.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.shipper.tell(.lowPower(ProcessInfo.processInfo.isLowPowerModeEnabled)) }
        })
        observers.append(center.addObserver(forName: ContactsRecorder.changed, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.shipper.contactsChanged() }
        })
        network = Task { [weak self] in
            var last: NetworkFacts?
            for await facts in SystemNetwork.shared.changes() {
                defer { last = facts }
                guard let before = last else { continue }
                guard facts.changesRoad(from: before) else {
                    EnergyLedger.shared.count("network_updates_same")
                    continue
                }
                self?.shipper.tell(.network)
            }
        }
        let link = link, volume = runtime.captureStore.volume
        volume.observe { room in
            link.tell(room: room)
            Task { @MainActor in PhoneNeeds.shared.recompute() }
        }
        link.tell(room: volume.room)
        runtime.captureStore.observe { [weak self] domain, entries in
            let events = entries.compactMap { SendClock.work(domain, kind: $0.kind) }
            guard !events.isEmpty else { return }
            Task { @MainActor in self?.shipper.appended(events) }
        }
        PhotosServices.shared.library.observe { [weak self] in
            Task { @MainActor in self?.shipper.libraryChanged() }
        }
        Task { await shipper.prime() }
    }

    private static var charging: Bool {
        let state = UIDevice.current.batteryState
        return state == .charging || state == .full
    }

    func cameToFront() {
        shipper.tell(.foreground)
        shipper.ask(.foreground)
        Task {
            await shipper.photos(.wake(.foreground))
            await shipper.contacts(manual: false)
        }
    }

    func wentToBackground() {
        shipper.tell(.background)
        scheduleBackgroundSync()
    }

    private func makeLink() -> HomeLink {
        let exports = runtime.exporter.exportsDirectory
        let transport = URLSessionTransport(metrics: Self.metering(.shared, power: power))
        let link = AppRuntime.isUITesting ? CannedHome.link(folder: exports, reader: CannedHome.door.map { URLSessionTransport(origin: $0) })
            : HomeLink(device: PhoneLink.device(), folder: exports, transport: transport, network: SystemNetwork.shared)
        HomeClock.current.follow(link)
        return link
    }

    private func makeShipper() -> PhoneShipper {
        let exports = runtime.exporter.exportsDirectory
        let custody = PhoneCustody(exporter: runtime.exporter)
        let shipper = PhoneShipper(
            stateURL: exports.appendingPathComponent("shipper.json"), link: link,
            custody: custody, warnings: HomeWarnings(center: LocalWarnings(), build: BuildExpiry.read()),
            now: { AppClock.now },
            hardware: { HardwareIdentity.current },
            appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1",
            clear: { [runtime] answer in
                try await runtime.launched()
                try await PhotosServices.shared.pass.clearImported(by: answer, custody: custody)
                try await runtime.contactsRecorder.clearImported(by: answer, custody: custody)
            },
            settings: { [runtime] answer in await runtime.settings.applied(answer) },
            settingWaits: { [runtime] in !runtime.settings.queue.changes.isEmpty },
            exchange: { [runtime] link in try await runtime.settings.exchange(through: link) },
            uploads: { [runtime] in
                _ = try? await UploadInbox.shared(appGroup: AppGroup.identifier)?.drain(into: runtime.captureStore)
            },
            stopRecording: { [runtime] in await runtime.stopRecordingForGood() },
            sleep: { try? await Task.sleep(for: .seconds(max(0, $0.timeIntervalSinceNow))) },
            ready: { [weak self] reason in await self?.ready(reason) ?? false },
            budget: { expired in Budget(expired: expired).end },
            photoPass: { [link = self.link] grant in await Self.photoPass(grant, link: link) },
            contacts: { [runtime] manual in
                guard !Self.isTesting else { return nil }
                return await runtime.contactsRecorder.pass(manual: manual)
            },
            contactsStarted: { [runtime] in
                guard !Self.isTesting else { return nil }
                return await runtime.contactsRecorder.lastStarted
            })
        return shipper
    }

    enum PairingTarget: Sendable, Equatable {
        case link(PairingLink)
        case found(code: String, home: FoundHome)

        var fingerprint: String {
            switch self {
            case .link(let link): link.fingerprint
            case .found(_, let home): home.fingerprint
            }
        }
    }

    func pair(_ target: PairingTarget, account: String?, name: String, phone: WhichPhone = .unsaid) async throws {
        let before = try? link.name()
        do {
            switch target {
            case .link(let pairing):
                _ = try await link.pair(pairing, account: account, name: name, phone: phone)
            case .found(let code, let home):
                _ = try await link.pair(code: code, at: home, account: account, name: name, phone: phone)
            }
        } catch LinkFailure.homeTooOld {}
        await shipper.reread()
        if before != (try? link.name()) { runtime.forgetHomeReads() }
        Task { await runtime.restoreIfOwed() }
        shipper.ask(.foreground)
    }

    func state(account: String) async throws -> String? {
        let answer = try await link.state(account: account)
        shipper.ask(.foreground)
        return answer.account
    }

    private func ready(_ reason: PhoneShipper.Reason) async -> Bool {
        guard !Self.isTesting || (AppRuntime.isUITesting && reason == .refresh) else { return false }
        do { try await runtime.launched() } catch {
            shipper.couldNotStart(error)
            return false
        }
        return await runtime.captureStore.isRestored
    }

    func registerBackgroundSync() {
        guard !Self.isTesting else { return }
        backgroundSync.register()
    }

    func scheduleBackgroundSync() {
        guard !Self.isTesting else { return }
        guard !shipper.handedOver else { return backgroundSync.cancel() }
        backgroundSync.schedule()
    }
}

@MainActor
private final class Budget {
    private var id = UIBackgroundTaskIdentifier.invalid

    init(expired: @escaping @MainActor () -> Void) {
        id = UIApplication.shared.beginBackgroundTask(withName: "send") { [weak self] in
            MainActor.assumeIsolated {
                expired()
                self?.end()
            }
        }
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}

enum SendCount: String {
    case requests, bundles = "bundles_sent", files = "files_sent", bytes = "send_bytes", unanswered = "send_unanswered",
         cut = "send_cut"

    func key(onPower: Bool) -> String { rawValue + (onPower ? "_power" : "_battery") }
}

final class OnPower: Sendable {
    private let changes = Mutex<[Change]>([Change(at: .distantPast, on: false)])
    private struct Change { let at: Date, on: Bool }
    private static let kept = 64

    var on: Bool { changes.withLock { $0[$0.count - 1].on } }

    func on(at date: Date) -> Bool {
        changes.withLock { changes in changes.last { $0.at <= date }?.on ?? changes[0].on }
    }

    @discardableResult func set(_ on: Bool, at date: Date = AppClock.now) -> Bool {
        changes.withLock { changes in
            guard changes[changes.count - 1].on != on else { return false }
            changes.append(Change(at: date, on: on))
            if changes.count > Self.kept { changes.removeFirst(changes.count - Self.kept) }
            return true
        }
    }
}

extension PhotoPass.Grant {
    static func wake(_ reason: PhoneShipper.Reason) -> Self {
        reason >= .foreground ? Self(seconds: 120) : Self(seconds: 30, background: true)
    }

    static let processing = Self(seconds: 8 * 60)
}

extension ShippingService {
    nonisolated static func metering(_ ledger: EnergyLedger, power: OnPower) -> URLSessionTransport.Metrics {
        { request, metrics, ending in
            let onPower = power.on(at: metrics.taskInterval.start)
            ledger.count(SendCount.requests.key(onPower: onPower))
            var body: Int64 = 0
            for transaction in metrics.transactionMetrics where transaction.resourceFetchType == .networkLoad {
                body += transaction.countOfRequestBodyBytesSent
                ledger.transfer(
                    .shipping, interface: transaction.isCellular ? "cellular" : "other",
                    sentBytes: UInt64(max(0, transaction.countOfRequestHeaderBytesSent + transaction.countOfRequestBodyBytesSent)),
                    receivedBytes: UInt64(max(0, transaction.countOfResponseHeaderBytesReceived + transaction.countOfResponseBodyBytesReceived)))
            }
            guard request.method == "PUT" else { return }
            if body > 0 { ledger.count(SendCount.bytes.key(onPower: onPower), Int(body)) }
            switch ending {
            case .answered(200), .answered(201):
                let file = request.url.path.hasPrefix("/v1/files/")
                ledger.count((file ? SendCount.files : SendCount.bundles).key(onPower: onPower))
            case .answered: break
            case .unanswered: ledger.count(SendCount.unanswered.key(onPower: onPower))
            case .cut: ledger.count(SendCount.cut.key(onPower: onPower))
            }
        }
    }
}
