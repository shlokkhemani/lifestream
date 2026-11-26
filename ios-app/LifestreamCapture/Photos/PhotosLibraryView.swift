import Cockpit
import HomeLink
import LifestreamCaptureCore
@preconcurrency import Photos
import PhotoLibrary
import PhotosUI
import SwiftUI
import UIKit

@MainActor
final class PhotosServices: ObservableObject {
    static let shared = PhotosServices(runtime: .shared)

    let runtime: AppRuntime
    let library = PhotoLibrary()
    let pass: PhotoPass
    @Published private(set) var state = PhotoPassState()
    @Published private(set) var bringingIn = false
    @Published private(set) var stopped: String?
    @Published private(set) var waiting: String?
    private var bringing: Task<Void, Never>?

    init(runtime: AppRuntime) {
        self.runtime = runtime
        pass = PhotoPass(store: runtime.captureStore, library: library,
                         stateURL: runtime.root.appendingPathComponent("photos", isDirectory: true).appendingPathComponent("cursor.json"),
                         build: ThisPhoneSheet.build)
    }

    @discardableResult
    func run(_ grant: PhotoPass.Grant, device: Device) async -> PhotoPass.Report? {
        guard (try? await runtime.launched()) != nil else { return nil }
        let store = runtime.captureStore
        guard await store.isPaired, await store.isRestored else { return nil }
        let shipper = runtime.shipping.shipper
        let report = await pass.measured(grant, device: device, bringingIn: bringingIn, home: .of(shipper))
        shipper.photoPass(report)
        await refresh()
        return report
    }

    func refresh() async { state = await pass.state() }

    func bringIn() {
        guard !bringingIn else { return }
        bringingIn = true
        stopped = nil
        bringing = runtime.shipping.backgroundSync.continued(
            title: "Bringing in your photos", subtitle: "Sending your photos to Lifestream") { [weak self] progress in
                await self?.bringingInAll(progress)
            }
    }

    func stopBringingIn() { bringing?.cancel() }

    private func bringingInAll(_ progress: Progress) async {
        defer { bringingIn = false; bringing = nil; waiting = nil }
        var first: Int?
        var idle = 0
        while !Task.isCancelled {
            let shipping = runtime.shipping
            await shipping.shipper.send(.foreground)
            if shipping.shipper.state.outcome == .unreachable, shipping.link.snapshot.reach != .answering {
                for await snapshot in shipping.link.snapshots() {
                    if snapshot.reach == .answering { break }
                    waiting = BringInStep.waiting(snapshot.reach)
                }
                waiting = nil
                continue
            }
            let device = await ShippingService.device(shipping.link)
            let report = await run(.wake(.foreground), device: device)
            if let report, !report.waited, let wanted = state.left?.wanted {
                first = first ?? wanted
                progress.totalUnitCount = Int64(max(first ?? 0, 1))
                progress.completedUnitCount = Int64(max(0, (first ?? 0) - wanted))
            }
            switch BringInStep.after(report, left: state.left, idle: idle) {
            case .done: return
            case .stop(let words):
                stopped = words
                return
            case .wait(let wait):
                await BringInWait(volume: runtime.captureStore.volume, link: shipping.link, phone: PhoneNeeds.name)
                    .out(wait, spare: device.spare) { self.waiting = $0 }
                waiting = nil
            case .again(let passes):
                idle = passes
                try? await Task.sleep(for: .seconds(20))
            }
        }
    }
}

struct BringInWait: Sendable {
    let volume: Volume
    let link: HomeLink
    let phone: String
    var pause: @Sendable () async -> Void = { try? await Task.sleep(for: .seconds(60)) }

    @MainActor func out(_ wait: Due.Wait, spare: Int64, say: (String) -> Void) async {
        switch wait {
        case .network:
            let changes = link.mobileChanges()
            guard var said = pastWait else { return }
            say(said.words)
            for await _ in changes {
                guard let wait = pastWait else { return }
                if wait != said { say(wait.words) }
                said = wait
            }
        case .space:
            say(Self.space(volume.room, phone: phone))
            repeat { await pause() } while !Task.isCancelled && volume.spare <= spare
        }
    }

    private var pastWait: MobileData.Wait? {
        link.mobile(pressed: false).past.wait
    }

    static func space(_ room: Room, phone: String) -> String {
        switch room {
        case .ok: "The next photo is too large for the space left on \(phone)."
        case .low: "\(phone) is almost full. Older photos wait until it has 5 GB free."
        case .full: "\(phone) is full. Older photos wait until it has 5 GB free."
        }
    }
}

enum BringInStep: Equatable {
    case done
    case stop(String)
    case wait(Due.Wait)
    case again(idle: Int)

    static let idleLimit = 6

    static func waiting(_ reach: HomeLink.Reach) -> String? {
        if case .waiting = reach { ReachWords.waiting } else { nil }
    }

    static func after(_ report: PhotoPass.Report?, left: PhotosWanted.Left?, idle: Int) -> BringInStep {
        guard let report else { return .stop("Bringing in your photos stopped: this phone couldn't read its library. Try again later.") }
        if report.error != nil { return .stop("A photo pass failed, so bringing in your photos stopped. Try again later.") }
        if let wait = report.waits { return .wait(wait) }
        if report.heldBack { return .stop("Lifestream is holding older photos back for now. Bring them in once it takes them.") }
        if !report.waited, left?.wanted == 0 { return .done }
        if report.done {
            return .stop(left.map { "\(Words.count($0.wanted, "photo")) couldn't be brought in now. Try again later." }
                ?? "Lifestream didn't say which photos it wants. Try again later.")
        }
        let moved = report.paged || report.files > 0 || report.refused > 0 || report.snapshots > 0
        let passes = moved ? 0 : idle + 1
        if passes == idleLimit { return .stop("Lifestream hasn't taken in the photos this phone sent. Try again once it has.") }
        return .again(idle: passes)
    }
}

@MainActor
final class PhotosLibraryModel: ObservableObject {
    @Published private(set) var access: PhotoAccess
    @Published private(set) var count: Int?
    @Published private(set) var bringing: ActOutcome = .idle
    @Published private(set) var clearing: ActOutcome = .idle

    let services: PhotosServices

    init(services: PhotosServices = .shared) {
        self.services = services
        access = services.library.access
    }

    func refresh() async {
        access = services.library.access
        count = access.reads ? try? await services.library.count() : nil
        await services.refresh()
    }

    func bringIn() async {
        await ActOutcome.run(\.bringing, of: self) {
            if access == .undecided { access = await services.library.requestAccess() }
            guard access.reads else { return }
            guard await services.runtime.captureStore.isPaired else { throw NotPaired() }
            services.bringIn()
        }
    }

    struct NotPaired: LocalizedError {
        var errorDescription: String? {
            "Photos are sent once this phone is paired with Lifestream. Until then nothing is copied, and your photos stay in your library."
        }
    }

    func clearTransferredPhotos() async {
        await ActOutcome.run(\.clearing, of: self) {
            try await services.runtime.launched()
            await services.runtime.shipping.shipper.send(.foreground)
            await refresh()
        }
    }

    func presentLimitedLibraryPicker() {
        guard let controller = Self.topViewController() else { return }
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: controller)
    }

    private static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.first?.windows.first
        var controller = window?.rootViewController
        while let presented = controller?.presentedViewController { controller = presented }
        return controller
    }
}

struct PhotosLibraryView: View {
    @ObservedObject private var services = PhotosServices.shared
    @ObservedObject private var permissions = PhoneNeeds.shared.permissions

    var body: some View {
        SheetPage("Photos") {
            PermissionState(source: .photos)
            PhotosLibrarySettings()
            let brings = !BringInPhotos.refused, clears = ClearPhotoCopies.due
            SheetPart(nil, note: clears ? ClearPhotoCopies.note : nil) {
                if brings { BringInPhotos().environment(\.actsFollow, clears) }
                if clears { ClearPhotoCopies() }
            }
        }
        .allowingSources()
    }
}

struct BringInPhotos: View {
    @StateObject private var model = PhotosLibraryModel()
    @ObservedObject private var services = PhotosServices.shared
    @Environment(\.actsFollow) private var follows

    var body: some View {
        Group {
            if services.bringingIn {
                ListRow("Stop bringing in photos", meta: services.waiting ?? Self.line, separator: follows,
                        action: { services.stopBringingIn() }) {
                    Spinner()
                }
                .accessibilityIdentifier("photos.stop")
            } else {
                ListRow("Bring in all photos", meta: Self.line, separator: follows, action: { Task { await model.bringIn() } }) {
                    EmptyView()
                }
                .accessibilityIdentifier("photos.bringIn")
            }
        }
        .environment(\.cockpitRowActs, true)
        .actOutcome(model.bringing, identifier: "photos.bringIn.failed") { Task { await model.bringIn() } }
        .task { await model.refresh() }
    }

    static let line = "New photos go at once, the rest on Wi-Fi."

    @MainActor static var refused: Bool {
        let access = PhotosServices.shared.library.access
        return access == .denied || access == .restricted
    }
}

struct ClearPhotoCopies: View {
    @StateObject private var model = PhotosLibraryModel()
    @State private var confirming = false
    @Environment(\.actsFollow) private var follows

    static let note = "Your photo library is not touched."

    @MainActor static var due: Bool { PhotosServices.shared.state.lastPass != nil }

    var body: some View {
        ListRow("Clear photo copies", separator: follows, action: model.clearing.running ? nil : { confirming = true }) {
            if model.clearing.running { Spinner() }
        }
            .environment(\.cockpitRowWarns, true)
            .accessibilityIdentifier("photos.clearCopies")
            .confirmationDialog("Clear photo copies?", isPresented: $confirming, titleVisibility: .visible) {
                Button("Clear the copies Lifestream imported", role: .destructive) {
                    Task { await model.clearTransferredPhotos() }
                }
                Button("Not now", role: .cancel) {}
            } message: {
                Text("Removes this phone's copies of the photos Lifestream has imported. Your photo library is not touched.")
            }
            .actOutcome(model.clearing, identifier: "photos.clearCopies.failed") { confirming = true }
    }
}

struct PhotosLibrarySettings: View {
    @StateObject private var model = PhotosLibraryModel()
    @ObservedObject private var services = PhotosServices.shared
    @ObservedObject private var permissions = PhoneNeeds.shared.permissions

    var body: some View {
        library
        .task { await model.refresh() }
        .onChange(of: permissions.rows) { Task { await model.refresh() } }
        .onChange(of: services.bringingIn) { Task { await model.refresh() } }
    }

    private var library: some View {
        let unavailable = services.state.left?.unavailable ?? 0
        let unread = services.state.mark.flatMap { $0.restates ? nil : $0.unread } ?? 0
        return SheetPart("This iPhone", note: services.stopped) {
            if model.access == .limited {
                SettingRow("Chosen photos", line: "The only photos Lifestream can read", opens: { model.presentLimitedLibraryPicker() })
                    .accessibilityIdentifier("photos.manageSelection")
            }
            if let held = photosText {
                SettingRow("In Lifestream", value: held)
                    .accessibilityIdentifier("photos.count")
            }
            if unavailable > 0 {
                SettingRow("Without a file", value: Words.count(unavailable))
                    .accessibilityIdentifier("photos.unavailable")
            }
            if unread > 0 {
                SettingRow("Still to read", value: Words.count(unread))
                    .accessibilityIdentifier("photos.unread")
            }
            SettingRow("Last copied", value: services.state.lastPass.flatMap(CaptureTime.date(rfc3339:)).map {
                Words.ago($0) + (services.state.failing != nil ? Words.dot + "failed" : "")
            } ?? "Never", separator: false)
        }
    }

    private var photosText: String? {
        guard let count = model.count, count > 0 else { return nil }
        guard let left = services.state.left else { return Words.count(count) }
        return "\(Words.count(max(0, count - left.wanted - left.unavailable))) of \(Words.count(count))"
    }
}
