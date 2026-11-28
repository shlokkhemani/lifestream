import Foundation
import HomeLink
import PhotoLibrary
import Shipping

actor MacPhotoPass {
    static let seconds: TimeInterval = 120

    private let paths: ShippingDomains.Paths
    private let link: HomeLink
    private let settings: MacSettings
    private let disk: Volume
    private let exports: URL
    private let library: PhotoLibrary
    private let changes = PhotoChanges()
    private var current: (source: String, pass: PhotoPass)?

    init(paths: ShippingDomains.Paths, link: HomeLink, settings: MacSettings, disk: Volume,
         exports: URL = MacPhotoPass.exports, library: PhotoLibrary = PhotoLibrary()) {
        self.paths = paths
        self.link = link
        self.settings = settings
        self.disk = disk
        self.exports = exports
        self.library = library
    }

    nonisolated func startObserving(onChange: @escaping @Sendable () -> Void) {
        changes.start(library, onChange: onChange)
    }

    nonisolated func stopObserving() {
        changes.stop()
    }

    static var exports: URL {
        MachineDirectory.url.appendingPathComponent("scratch/mac/app/photos", isDirectory: true)
    }

    func run(_ answer: FreshAnswer, pressed: Bool) async -> [ShipperRunRow] {
        guard let domain = ShippingDomains.photos(in: Array(answer.sources.keys), paths: paths) else { return [] }
        try? FileManager.default.createDirectory(at: exports, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if current?.source != domain.sourceId {
            current = (domain.sourceId, PhotoPass(library: library, store: domain.photos, build: Self.build, exports: exports))
        }
        let report = await current!.pass.run(.init(seconds: Self.seconds),
                                             device: device(pressed: pressed),
                                             bringingIn: false,
                                             home: domain.home(answer, link: link, settings: settings))
        return domain.settled(report, failing: await current!.pass.state().failing, pass: answer.pass, link: link, at: Date())
            .map { [$0] } ?? []
    }

    func device(pressed: Bool) -> Device {
        Self.device(link.mobile(pressed: pressed), onBattery: PowerSource.onBattery(), spare: disk.spare)
    }

    static var build: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        let commit = Bundle.main.object(forInfoDictionaryKey: "LifestreamCommit") as? String ?? "unknown"
        return "\(version) \(commit)"
    }

    static func device(_ mobile: MobileData.Moment, onBattery: Bool, spare: Int64) -> Device {
        Device(pastMoves: mobile.past.moves, iCloud: mobile.internet.past.moves,
               charging: !onBattery, spare: spare, changeRoom: nil, page: 5_000)
    }
}

final class PhotoChanges: @unchecked Sendable {
    private let lock = NSLock()
    private var onChange: (@Sendable () -> Void)?

    func start(_ library: PhotoLibrary, onChange: @escaping @Sendable () -> Void) {
        lock.withLock { self.onChange = onChange }
        library.observe { [weak self] in self?.changed() }
    }

    func stop() {
        lock.withLock { onChange = nil }
    }

    private func changed() {
        lock.withLock { onChange }?()
    }
}
