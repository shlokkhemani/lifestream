import Foundation
import HomeLink
import LifestreamCaptureCore
import PhotoLibrary

struct PhonePhotos: PhotoPassStore {
    let store: CaptureStore
    let stateURL: URL

    func written(prefix: String) async throws -> [PhotoEntry] {
        try await store.entries(.photos, replayKeyPrefix: prefix).compactMap { stated in
            guard let kind = PhotoEntry.Kind(rawValue: stated.kind), let key = stated.captureReplayKey else { return nil }
            return PhotoEntry(kind: kind, replayKey: key, observedAt: stated.observedAt,
                              payload: try JSONEncoder.lifestream().encode(stated.payload))
        }
    }

    func append(_ entries: [PhotoEntry]) async throws -> Int {
        let drafts = try entries.map { entry in
            ReplayCaptureDraft(replayKey: entry.replayKey, draft: .init(
                kind: entry.kind.rawValue, observedAt: entry.observedAt,
                payload: try JSONDecoder.lifestream().decode(JSONValue.self, from: entry.payload)))
        }
        return try await roomy { try await store.appendReplayBatch(domain: .photos, drafts: drafts).count }
    }

    func store(_ url: URL) async throws -> (hash: String, bytes: UInt64) {
        try await roomy { try await store.storeBlob(file: OwnedMediaFile(takingOwnershipOf: url)) }
    }

    private func roomy<T>(_ write: () async throws -> T) async throws -> T {
        do { return try await write() } catch CaptureError.full { throw PhotoStoreFull() }
    }

    func statedLive() async throws -> Set<String>? {
        try await store.photosStatedLive()
    }

    func readState() -> Data? {
        try? FileDurability.readRegularFileIfPresent(at: stateURL, maximumBytes: 64 << 20)
    }

    func writeState(_ bytes: Data) throws {
        try FileDurability.createDirectoryDurably(at: stateURL.deletingLastPathComponent())
        try bytes.write(to: stateURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        try FileDurability.synchronizeFile(at: stateURL)
        try FileDurability.synchronizeParentDirectory(of: stateURL)
    }
}

extension PhotoPass {
    init(store: CaptureStore, library: PhotoLibrary, stateURL: URL, build: String = "",
         now: @escaping @Sendable () -> Date = { AppClock.now }) {
        self.init(library: library, store: PhonePhotos(store: store, stateURL: stateURL), build: build, now: now)
    }

    func clearImported(by answer: FreshAnswer, custody: PhoneCustody) async throws {
        try await whileIdle { try await custody.clearImportedPhotos(answer) }
    }

    func measured(_ grant: Grant, device: Device, bringingIn: Bool, home: Home) async -> Report? {
        let report = await EnergyLedger.shared.measure(.photos) {
            await self.run(grant, device: device, bringingIn: bringingIn, home: home)
        }
        guard let report else { return nil }
        EnergyLedger.shared.count("photo_passes")
        EnergyLedger.shared.count("photo_assets_snapshotted", report.read)
        if report.paged { EnergyLedger.shared.count("photo_passes_walk") }
        if let unlisted = report.unlisted {
            EnergyLedger.shared.count("photo_whole_reads_full")
            EnergyLedger.shared.count("photo_stated_unlisted", unlisted)
        }
        return report
    }
}

extension PhoneShipper {
    func photoPass(_ report: PhotoPass.Report?) {
        guard let report else { return }
        if let outcome = ReadOutcome(ending: report.failure) { read(.photos, outcome) }
        if let stated = report.stated { state(stated) }
    }

    private func state(_ stated: PhotoPass.Stated) {
        guard let saved = link.saved, let source = PhoneCustody.sources(saved.sources)[.photos] else { return }
        let months = stated.months.mapValues { Through.Month(items: $0.items, bytes: $0.bytes) }
        let held = link.through(of: source)
        guard held?.left != stated.left || held?.start != stated.start || held?.months != months else { return }
        link.tell(through: Through(readThrough: stated.readThrough, statedAt: max(AppClock.now, stated.readThrough),
                                   left: stated.left, start: stated.start, months: months),
                  of: source, pass: saved.pass)
    }
}

extension Device {
    init(_ mobile: MobileData.Moment, charging: Bool, spare: Int64, changeRoom: Int64? = .max) {
        self.init(pastMoves: mobile.past.moves, iCloud: mobile.internet.decide(.later, bytes: .max).moves,
                  charging: charging, spare: spare, changeRoom: changeRoom)
    }
}

extension PhotoPass.Home {
    @MainActor static func of(_ shipper: PhoneShipper) async -> Self {
        let link = shipper.link
        let source = link.saved.flatMap { PhoneCustody.sources($0.sources)[.photos] }
        var caughtUp = false
        if let saved = link.saved, source != nil { caughtUp = (try? await shipper.custody.caughtUp(.photos, saved)) ?? false }
        let history = source.flatMap { link.saved?.sources[$0]?.history } ?? true
        return Self(caughtUp: caughtUp, history: history, start: PhoneSettings.start(of: .photos, in: link.saved?.settings),
                    wanted: { owed in try await link.photosWanted(source: source ?? "", owed: owed) })
    }
}
