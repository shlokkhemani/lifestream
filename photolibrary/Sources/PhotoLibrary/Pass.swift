import Foundation

public protocol PhotoPassStore: Sendable {
    func written(prefix: String) async throws -> [PhotoEntry]
    @discardableResult func append(_ entries: [PhotoEntry]) async throws -> Int
    func store(_ url: URL) async throws -> (hash: String, bytes: UInt64)
    func readState() -> Data?
    func writeState(_ bytes: Data) throws
    func statedLive() async throws -> Set<String>?
}

extension PhotoPassStore {
    public func statedLive() async throws -> Set<String>? { nil }
}

public actor PhotoPass {
    public struct Home: Sendable {
        public var caughtUp: Bool
        public var history: Bool
        public var start: Date?
        public var wanted: @Sendable (_ owed: [String]) async throws -> PhotosWanted

        public init(caughtUp: Bool, history: Bool = true, start: Date? = nil,
                    wanted: @escaping @Sendable (_ owed: [String]) async throws -> PhotosWanted) {
            self.caughtUp = caughtUp
            self.history = history
            self.start = start
            self.wanted = wanted
        }

        func states(_ snapshot: PhotoSnapshot) -> Bool {
            guard let start, let created = snapshot.creationDate else { return true }
            return created >= start
        }

        func before(_ readFrom: Date?) -> Bool {
            guard let readFrom else { return false }
            return start.map { $0 < readFrom } ?? true
        }

        func folded(into readFrom: Date?) -> Date? {
            guard let start else { return readFrom }
            guard let readFrom else { return start }
            return max(start, readFrom)
        }
    }

    public struct Grant: Sendable, Equatable {
        public var seconds: TimeInterval
        public var background: Bool

        public init(seconds: TimeInterval, background: Bool = false) {
            self.seconds = seconds
            self.background = background
        }
    }

    public struct Stated: Sendable, Equatable {
        public var readThrough: Date
        public var left: Int?
        public var start: Date?
        public var months: [String: PhotoMonth]
    }

    public struct Report: Sendable {
        public var snapshots = 0
        public var read = 0
        public var files = 0
        public var refused = 0
        public var gone = 0
        public var unlisted: Int?
        public var paged = false
        public var waited = false
        public var heldBack = false
        public var waits: Due.Wait?
        public var stated: Stated?
        public var failure: (any Error)?

        public init() {}

        public var error: String? { failure.map { String(describing: $0) } }

        public var done: Bool { !waited && !heldBack && waits == nil && !paged && files == 0 && refused == 0 }
    }

    public static let owedAsked = 200

    private let library: PhotoLibrary
    private let store: any PhotoPassStore
    private let build: String
    private let exports: URL
    private let now: @Sendable () -> Date
    private var running = false

    public init(library: PhotoLibrary, store: any PhotoPassStore, build: String = "",
                exports: URL = FileManager.default.temporaryDirectory, now: @escaping @Sendable () -> Date = { Date() }) {
        self.library = library
        self.store = store
        self.build = build
        self.exports = exports
        self.now = now
    }

    public func state() -> PhotoPassState {
        store.readState().flatMap { try? JSONDecoder().decode(PhotoPassState.self, from: $0) } ?? PhotoPassState()
    }

    private func save(_ state: PhotoPassState) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        try store.writeState(encoder.encode(state))
    }

    public func whileIdle<T: Sendable>(_ body: @Sendable () async throws -> T) async throws -> T {
        guard !running else { throw PhotoPassBusy() }
        running = true
        defer { running = false }
        return try await body()
    }

    public func run(_ grant: Grant, device: Device, bringingIn: Bool, home: Home) async -> Report? {
        guard !running, library.access.reads else { return nil }
        var state = self.state()
        if !bringingIn, let failing = state.failing, !failing.due(now: now(), build: build) { return nil }
        running = true
        defer { running = false }
        var report = Report()
        do {
            try await pass(grant, device: device, bringingIn: bringingIn, home: home, state: &state, report: &report)
            state.failing = nil
        } catch is PhotoStoreFull {
            report.waits = .space
            state.failing = nil
        } catch {
            report.failure = error
            let before = state.failing?.build == build ? state.failing?.passes ?? 0 : 0
            state.failing = .init(error: String(describing: error), at: Wire.time(now())!, passes: before + 1, build: build)
        }
        state.lastPass = Wire.time(now())
        try? save(state)
        return report
    }

    private func pass(_ grant: Grant, device: Device, bringingIn: Bool, home: Home,
                      state: inout PhotoPassState, report: inout Report) async throws {
        let deadline = now().addingTimeInterval(grant.seconds)
        let open = { [now] in now() < deadline && !Task.isCancelled }
        let pastTaken = home.caughtUp && home.history
        var mayPage = pastTaken && device.pastMoves
        report.waited = !home.caughtUp
        report.heldBack = !home.history
        var kept: Int64 = 0
        let owedBefore = state.owed
        var listed = false
        if state.listingDue(now: now()) { try await list(&state, listed: &listed) }
        if home.before(state.readFrom) || (state.unsized && state.mark?.complete == true) {
            state.mark = state.mark?.rereading()
        }
        var readThrough: Date?
        while open() {
            let whole = mayPage && !(grant.background && state.mark?.restates == true)
            let asked = now()
            let page = try await library.read(after: state.mark, whole: whole, limit: device.page)
            if page.mark == state.mark {
                readThrough = asked
                break
            }
            report.read += page.snapshots.count
            let fromStart = page.snapshots.filter(home.states)
            if page.whole {
                state.left = nil
                report.snapshots += try await store.append(fromStart.map { $0.asset(now: now()) })
                mayPage = false
                report.paged = true
            } else {
                try await writeNew(fromStart, backlog: page.mark.backlog, room: device.changeRoom, kept: &kept, open: open,
                                   until: deadline, state: &state, report: &report)
                report.gone += try await writeGone(page.gone)
            }
            if let listed = page.listed, let stated = (try? await store.statedLive()) ?? nil {
                report.unlisted = stated.subtracting(listed).count
            }
            if page.begins {
                if !listed { try await list(&state, listed: &listed) }
                state.counting { $0.begin() }
            }
            if page.whole { state.counting { $0.add(page.snapshots) } }
            if page.whole || page.begins, page.mark.unread == 0 { state.counting { $0.end() } }
            state.readFrom = page.begins ? home.start : home.folded(into: state.readFrom)
            state.mark = page.mark
            try save(state)
        }
        if let readThrough, let months = state.months {
            report.stated = Stated(readThrough: readThrough, left: state.unread, start: home.start, months: months)
        }
        if pastTaken, !device.pastMoves, state.mark?.complete != true { report.waits = report.waits ?? .network }
        guard home.caughtUp, open() else { return }
        let pastDue = home.history && !report.paged && state.mark?.complete == true
        var device = device
        device.spare = max(0, device.spare - kept)
        let due = pastDue ? PhotoLibrary.due(device: device, bringingIn: bringingIn) : nil
        if case .waits(let wait) = due { report.waits = report.waits ?? wait }
        let asking = Array(owedBefore.intersection(state.owed).sorted().prefix(Self.owedAsked))
        let owed = Set(asking)
        let pastFetches = if case .fetch = due { true } else { false }
        guard pastFetches || !owed.isEmpty else { return }
        guard let wanted = try? await cut(at: deadline, { try await home.wanted(asking) }) else { return }
        if pastFetches { state.left = wanted.left }
        state.owed.subtract(owed.subtracting(wanted.photos.map(\.asset)))
        let owedRoom = device.changeRoom.map { max(0, $0 - kept) } ?? device.spare
        guard let owedBytes = try await fetchOwed(wanted.photos.filter { owed.contains($0.asset) }, room: owedRoom, open: open,
                                                  until: deadline, state: &state, report: &report),
              pastFetches, open() else { return }
        device.spare = max(0, device.spare - owedBytes)
        switch PhotoLibrary.due(device: device, bringingIn: bringingIn) {
        case .waits(let wait):
            report.waits = report.waits ?? wait
        case .fetch(let network, let bytes):
            let past = wanted.photos.filter { !owed.contains($0.asset) && !state.owed.contains($0.asset) }
            try await fetch(past, network: network, bytes: bytes, room: device.spare, open: open, until: deadline,
                            state: &state, report: &report)
        }
    }

    private func list(_ state: inout PhotoPassState, listed: inout Bool) async throws {
        let items = try await library.countByMonth()
        state.counting { $0.listed(items, at: now()) }
        listed = true
    }

    private func writeNew(_ snapshots: [PhotoSnapshot], backlog: [String]?, room: Int64?, kept: inout Int64,
                          open: () -> Bool, until deadline: Date, state: inout PhotoPassState,
                          report: inout Report) async throws {
        var entries: [PhotoEntry] = []
        let backlog = snapshots.isEmpty ? [] : Set(backlog ?? [])
        for snapshot in snapshots {
            let id = snapshot.localIdentifier
            let asset = snapshot.asset(now: now())
            let named = try await store.written(prefix: snapshot.name)
            guard !named.contains(where: { $0.replayKey == asset.replayKey }) else { continue }
            entries.append(asset)
            report.snapshots += 1
            guard named.isEmpty || state.owed.contains(id),
                  case .now(let only) = try await road(of: snapshot, owed: state.owed.contains(id), backlog: backlog),
                  only?.isEmpty != true else { continue }
            state.owed.insert(id)
            state.later.remove(id)
            guard let room, open() else { continue }
            guard let files = try await files(of: id, only: only, network: false, room: max(0, room - kept), until: deadline) else {
                state.owed.remove(id)
                continue
            }
            guard files.snapshot.name == snapshot.name else {
                for case .file(let url) in files.files { try? FileManager.default.removeItem(at: url) }
                continue
            }
            if files.files.contains(.noRoom) { report.waits = .space }
            guard let more = try await availability(files, report: &report) else { continue }
            entries.append(more.entry)
            kept += more.bytes
            state.owed.remove(id)
        }
        try await store.append(entries)
    }

    private enum Road {
        case now(only: Set<String>?)
        case past
    }

    private func road(of snapshot: PhotoSnapshot, owed: Bool, backlog: Set<String>) async throws -> Road {
        if owed { return .now(only: nil) }
        let earlier = try await store.written(prefix: "photos:\(snapshot.localIdentifier):")
        let held = Set(earlier.filter { $0.kind == .availability }.flatMap(Self.heldFiles))
        if !held.isEmpty { return .now(only: Self.unheld(snapshot.resources, held: held)) }
        if backlog.contains(snapshot.localIdentifier) || earlier.contains(where: { $0.kind == .asset }) { return .past }
        return .now(only: nil)
    }

    private static func unheld(_ resources: [PhotoResource], held: Set<HeldFile>) -> Set<String> {
        let changed = resources.filter { !held.contains(HeldFile($0)) }
        let render = resources.filter(\.isRender)
        let edited = changed.contains(where: \.isRender) || render.contains { $0.size == nil }
        return Set((edited ? changed + render : changed).map(\.type))
    }

    private static func heldFiles(_ availability: PhotoEntry) -> [HeldFile] {
        guard let stated = try? JSONDecoder().decode(Bound.self, from: availability.payload) else { return [] }
        return stated.resources.filter { $0.blob != nil }.map(HeldFile.init)
    }

    private func fetchOwed(_ owed: [PhotosWanted.Photo], room: Int64, open: () -> Bool, until deadline: Date,
                           state: inout PhotoPassState, report: inout Report) async throws -> Int64? {
        var bytes: Int64 = 0
        for photo in owed {
            guard open() else { return bytes }
            switch try await take(photo, network: false, room: room - bytes, until: deadline, report: &report) {
            case .gone:
                state.owed.remove(photo.asset)
            case .noRoom:
                if bytes == 0 { report.waits = .space }
                return nil
            case .landed(let more):
                bytes += more
                state.owed.remove(photo.asset)
            case .missed(let files):
                if open(), !files.writing { state.owed.remove(photo.asset) }
            }
        }
        return bytes
    }

    private func writeGone(_ ids: [String]) async throws -> Int {
        var entries: [PhotoEntry] = []
        for id in ids {
            for stated in try await store.written(prefix: "photos:\(id):") where stated.kind != .gone {
                entries.append(.gone(of: stated.kind, replayKey: stated.replayKey, payload: stated.payload, now: now()))
            }
        }
        return try await store.append(entries)
    }

    private func fetch(_ wanted: [PhotosWanted.Photo], network: Bool, bytes most: Int64, room: Int64, open: () -> Bool,
                       until deadline: Date, state: inout PhotoPassState, report: inout Report) async throws {
        if network { state.later = [] } else { state.later.formIntersection(wanted.map(\.asset)) }
        var bytes: Int64 = 0
        for photo in wanted where network || !state.later.contains(photo.asset) {
            guard open(), bytes < most else { return }
            switch try await take(photo, network: network, room: room - bytes, until: deadline, report: &report) {
            case .gone:
                continue
            case .noRoom:
                if bytes == 0 { report.waits = .space }
                return
            case .landed(let more):
                bytes += more
            case .missed(let files):
                if files.files.contains(.later), !network { state.later.insert(photo.asset) }
            }
        }
    }

    private enum Taken {
        case gone
        case noRoom
        case landed(Int64)
        case missed(PhotoFiles)
    }

    private func take(_ photo: PhotosWanted.Photo, network: Bool, room: Int64, until deadline: Date,
                      report: inout Report) async throws -> Taken {
        let id = photo.asset
        guard let files = try await files(of: id, only: Set(photo.files), network: network, room: room, until: deadline) else {
            guard let stated = try await store.written(prefix: "photos:\(id):").last(where: { $0.kind == .asset }) else { return .gone }
            try await store.append([try PhotoEntry.refusal(ofAsset: stated.payload, .notFound, now: now())])
            report.refused += 1
            return .gone
        }
        if files.files.contains(.noRoom) {
            for case .file(let url) in files.files { try? FileManager.default.removeItem(at: url) }
            return .noRoom
        }
        let asset = files.snapshot.asset(now: now())
        let stated = try await store.written(prefix: asset.replayKey).contains { $0.replayKey == asset.replayKey }
        var entries = stated ? [] : [asset]
        let more = try await availability(files, report: &report)
        if let more { entries.append(more.entry) }
        report.snapshots += entries.count(where: { $0.kind == .asset })
        try await store.append(entries)
        return more.map { .landed($0.bytes) } ?? .missed(files)
    }

    private func availability(_ files: PhotoFiles, report: inout Report) async throws -> (entry: PhotoEntry, bytes: Int64)? {
        var unstored = files.files.compactMap { if case .file(let url) = $0 { url } else { nil } }
        defer { for url in unstored { try? FileManager.default.removeItem(at: url) } }
        guard files.files.contains(where: { $0 != .unasked }), !files.files.contains(.later), !files.files.contains(.noRoom)
        else { return nil }
        var states: [ResourceState] = []
        var bytes: Int64 = 0
        for fetched in files.files {
            switch fetched {
            case .file(let url):
                let blob = try await store.store(url)
                unstored.removeAll { $0 == url }
                states.append(.blob(hash: blob.hash, bytes: blob.bytes))
                bytes += Int64(blob.bytes)
            case .refused(let refusal): states.append(.absent(refusal))
            case .unasked: states.append(.absent(nil))
            case .later, .noRoom: return nil
            }
        }
        if states.contains(where: \.isRefused) { report.refused += 1 } else { report.files += 1 }
        return (files.snapshot.availability(states, now: now()), bytes)
    }

    private func files(of id: String, only types: Set<String>? = nil, network: Bool, room: Int64 = .max,
                       until deadline: Date) async throws -> PhotoFiles? {
        try await cut(at: deadline) { [library, exports] in
            try await library.files(of: id, only: types, network: network, room: room, into: exports)
        }
    }

    private func cut<T: Sendable>(at deadline: Date, _ body: @escaping @Sendable () async throws -> T) async throws -> T {
        let running = Task { try await body() }
        let left = deadline.timeIntervalSince(now())
        let timer = Task {
            try await Task.sleep(nanoseconds: UInt64(max(left, 0) * 1_000_000_000))
            running.cancel()
        }
        defer { timer.cancel() }
        return try await withTaskCancellationHandler { try await running.value } onCancel: { running.cancel() }
    }
}

public struct PhotosWanted: Codable, Sendable, Equatable {
    public var photos: [Photo]
    public var left: Left

    public init(photos: [Photo], left: Left) {
        self.photos = photos
        self.left = left
    }

    public struct Photo: Codable, Sendable, Equatable {
        public var asset: String
        public var files: [String]

        public init(asset: String, files: [String]) {
            self.asset = asset
            self.files = files
        }
    }

    public struct Left: Codable, Sendable, Equatable {
        public var wanted: Int
        public var unavailable: Int
        public var bytes: Int64

        public init(wanted: Int, unavailable: Int, bytes: Int64) {
            self.wanted = wanted
            self.unavailable = unavailable
            self.bytes = bytes
        }
    }
}

public struct PhotoStoreFull: Error, Equatable {
    public init() {}
}

public struct PhotoPassBusy: LocalizedError, Equatable {
    public init() {}
    public var errorDescription: String? { "Photos are being read right now. Try again when that pass ends." }
}

public struct PhotoPassFailure: Codable, Sendable, Equatable {
    public var error: String
    public var at: String
    public var passes: Int
    public var build: String

    public static func wait(after passes: Int) -> TimeInterval {
        min(15 * 60 * pow(2, Double(min(max(passes, 1), 16) - 1)), 24 * 60 * 60)
    }

    public func due(now: Date, build: String) -> Bool {
        guard build == self.build, let at = Wire.date(at) else { return true }
        return now < at || now >= at.addingTimeInterval(Self.wait(after: passes))
    }
}

public struct PhotoPassState: Codable, Sendable, Equatable {
    public var mark: ReadMark?
    public var left: PhotosWanted.Left?
    public var later: Set<String> = []
    public var lastPass: String?
    public var failing: PhotoPassFailure?
    private var owedIds: Set<String>?
    private var readFromTime: String?
    private var count: PhotoCount?

    public var owed: Set<String> {
        get { owedIds ?? [] }
        set { owedIds = newValue.isEmpty ? nil : newValue }
    }

    public var readFrom: Date? {
        get { readFromTime.flatMap(Wire.date) }
        set { readFromTime = Wire.time(newValue) }
    }

    public var months: [String: PhotoMonth]? { count?.months }

    public var unread: Int? {
        guard let mark else { return nil }
        if mark.complete { return 0 }
        return mark.unread > 0 ? mark.unread : nil
    }

    public init() {}

    enum CodingKeys: String, CodingKey {
        case left = "wanted_left"
        case mark, later
        case owedIds = "owed"
        case lastPass = "last_pass"
        case failing
        case readFromTime = "read_from"
        case count = "months"
    }

    var unsized: Bool { count?.unsized ?? true }

    func listingDue(now: Date) -> Bool { count?.listingDue(now: now) ?? true }

    mutating func counting(_ change: (inout PhotoCount) -> Void) {
        var count = self.count ?? PhotoCount()
        change(&count)
        self.count = count
    }
}

public struct PhotoMonth: Sendable, Equatable {
    public var items: Int
    public var bytes: Int64?

    public init(items: Int, bytes: Int64?) {
        self.items = items
        self.bytes = bytes
    }

    public static let undated = "undated"

    public static func key(of date: Date?) -> String {
        guard let date else { return undated }
        let month = utc.dateComponents([.year, .month], from: date)
        return String(format: "%04d-%02d", month.year ?? 0, month.month ?? 0)
    }

    static func newer(_ month: String, than other: String) -> Bool {
        month != undated && (other == undated || month > other)
    }

    private static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()
}

struct PhotoCount: Codable, Sendable, Equatable {
    static let relisting: TimeInterval = 86_400

    var items: [String: Int] = [:]
    var listedAt: String?
    var bytes: [String: Int64]?
    var tally: [String: Int64]?
    var reaching: String?

    enum CodingKeys: String, CodingKey {
        case items
        case listedAt = "listed_at"
        case bytes, tally, reaching
    }

    var unsized: Bool { bytes == nil && tally == nil }

    var months: [String: PhotoMonth]? {
        guard listedAt != nil else { return nil }
        return items.reduce(into: [:]) { months, month in
            months[month.key] = PhotoMonth(items: month.value, bytes: bytes(of: month.key))
        }
    }

    func listingDue(now: Date) -> Bool {
        guard let listed = listedAt.flatMap(Wire.date) else { return true }
        return now < listed || now.timeIntervalSince(listed) >= Self.relisting
    }

    private func bytes(of month: String) -> Int64? {
        if let tally, let reaching, PhotoMonth.newer(month, than: reaching) { return tally[month] ?? 0 }
        return bytes.map { $0[month] ?? 0 }
    }

    mutating func listed(_ items: [String: Int], at now: Date) {
        self.items = items
        listedAt = Wire.time(now)
    }

    mutating func begin() {
        tally = [:]
        reaching = nil
    }

    mutating func add(_ snapshots: [PhotoSnapshot]) {
        guard tally != nil else { return }
        for snapshot in snapshots {
            let month = PhotoMonth.key(of: snapshot.creationDate)
            tally?[month, default: 0] += snapshot.resources.reduce(0) { $0 + ($1.size ?? 0) }
            reaching = month
        }
    }

    mutating func end() {
        guard let tally else { return }
        bytes = tally
        self.tally = nil
        reaching = nil
    }
}

private struct HeldFile: Hashable {
    let typeRaw: Int64
    let uti: String
    let name: String
    let size: Int64?

    init(_ resource: PhotoResource) {
        typeRaw = Int64(resource.typeRaw); uti = resource.uti; name = resource.originalFilename; size = resource.size
    }

    init(_ resource: Bound.Resource) {
        typeRaw = resource.type_raw; uti = resource.uti; name = resource.original_filename; size = resource.size
    }
}

private struct Bound: Decodable {
    let resources: [Resource]

    struct Resource: Decodable {
        let type_raw: Int64
        let uti: String
        let original_filename: String
        let size: Int64?
        let blob: Blob?
    }

    struct Blob: Decodable {
        let hash: String
    }
}

private extension PhotoFiles {
    var writing: Bool { zip(snapshot.resources, files).contains { $1 == .later && $0.size == 0 } }
}

private extension PhotoResource {
    static let renderTypes: Set<Int> = [5, 6, 7, 8, 10, 11, 12]

    var isRender: Bool { Self.renderTypes.contains(typeRaw) }
}

private extension ResourceState {
    var isRefused: Bool { if case .absent(_?) = self { true } else { false } }
}
