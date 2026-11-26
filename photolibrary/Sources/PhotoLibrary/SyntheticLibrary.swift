import Foundation

public final class SyntheticLibrary: PhotoSource, @unchecked Sendable {
    public enum File: Sendable, Equatable {
        case here(Data)
        case sized(Int64, Data)
        case inCloud(Data)
        case missing
        case failing
        case offline
        case stalled
    }

    private struct Photo {
        var snapshot: PhotoSnapshot
        var files: [File]
        let added: Int
    }

    private struct Token: Codable {
        let generation: Int
        let position: Int
    }

    private let lock = NSLock()
    private var photos: [String: Photo] = [:]
    private var added = 0
    private var history: [(position: Int, upserted: [String], deleted: [String])] = []
    private var position = 0
    private var generation = 0
    private var allowed: PhotoAccess
    private var selection: Set<String> = []
    private var snapshotsMade = 0
    private var downloadsMade = 0
    private var asked = 0
    private var listed = 0
    private var refusing = false
    private var sizing = true
    private var observer: (@Sendable () -> Void)?
    private var registered = false
    private var told = 0

    public struct Refused: Error, Equatable {}

    public init(access: PhotoAccess = .full) { allowed = access }

    public var refusesReads: Bool {
        get { lock.withLock { refusing } }
        set { lock.withLock { refusing = newValue } }
    }

    public var statesSizes: Bool {
        get { lock.withLock { sizing } }
        set { lock.withLock { sizing = newValue } }
    }

    public var snapshotsRead: Int { lock.withLock { snapshotsMade } }
    public var downloads: Int { lock.withLock { downloadsMade } }
    public var filesAsked: Int { lock.withLock { asked } }
    public var listings: Int { lock.withLock { listed } }
    public var changesTold: Int { lock.withLock { told } }

    public func put(_ snapshot: PhotoSnapshot, files: [File]? = nil) {
        lock.withLock {
            let files = files ?? snapshot.resources.map { .here(Data("\(snapshot.localIdentifier)/\($0.originalFilename)".utf8)) }
            precondition(files.count == snapshot.resources.count, "one file per resource")
            let order = photos[snapshot.localIdentifier]?.added ?? { added += 1; return added }()
            photos[snapshot.localIdentifier] = Photo(snapshot: snapshot, files: files, added: order)
            if visible(snapshot.localIdentifier) { record(upserted: [snapshot.localIdentifier], deleted: []) }
        }
    }

    public func finishWriting(_ id: String, files: [File]) {
        lock.withLock {
            guard var photo = photos[id] else { return }
            precondition(files.count == photo.files.count, "one file per resource")
            photo.files = files
            photos[id] = photo
        }
    }

    public func delete(_ id: String) {
        lock.withLock {
            let seen = visible(id)
            guard photos.removeValue(forKey: id) != nil, seen else { return }
            record(upserted: [], deleted: [id])
        }
    }

    public func allow(_ access: PhotoAccess, selecting selection: Set<String> = []) {
        lock.withLock {
            if allowed == .limited, access == .limited {
                record(upserted: Array(selection.subtracting(self.selection)), deleted: Array(self.selection.subtracting(selection)))
            }
            allowed = access
            self.selection = selection
        }
    }

    public func prune() { lock.withLock { generation += 1 } }

    private func record(upserted: [String], deleted: [String]) {
        position += 1
        history.append((position, upserted, deleted))
        guard registered, let observer else { return }
        told += 1
        DispatchQueue.global().async(execute: observer)
    }

    private func registerIfReadable() {
        if allowed.reads { registered = true }
    }

    private func visible(_ id: String) -> Bool {
        photos[id] != nil && (allowed == .full || (allowed == .limited && selection.contains(id)))
    }

    private func encode(_ token: Token) -> Data { try! JSONEncoder().encode(token) }


    private func read<T>(_ body: () -> T) throws -> T {
        try lock.withLock {
            if refusing { throw Refused() }
            return body()
        }
    }

    public var access: PhotoAccess {
        lock.withLock {
            registerIfReadable()
            return allowed
        }
    }

    func requestAccess() async -> PhotoAccess { access }

    func observe(_ changed: @escaping @Sendable () -> Void) {
        lock.withLock {
            observer = changed
            registerIfReadable()
        }
    }

    func count() async throws -> Int { try read { photos.keys.filter(visible).count } }

    func token() async throws -> Data { try read { encode(Token(generation: generation, position: position)) } }

    func changes(since token: Data, limit: Int) async throws -> [PhotoChange]? {
        try read {
            guard let from = try? JSONDecoder().decode(Token.self, from: token), from.generation == generation else { return nil }
            var changes: [PhotoChange] = []
            var named = 0
            for change in history where change.position > from.position {
                let upserted = change.upserted.filter(visible)
                let deleted = change.deleted
                guard !upserted.isEmpty || !deleted.isEmpty else { continue }
                changes.append(PhotoChange(upserted: upserted, deleted: deleted,
                                           token: encode(Token(generation: generation, position: change.position))))
                named += upserted.count + deleted.count
                if named >= limit { break }
            }
            return changes
        }
    }

    func identifiers() async throws -> [String] {
        try read {
            photos.values.filter { visible($0.snapshot.localIdentifier) }.sorted { a, b in
                switch (a.snapshot.creationDate, b.snapshot.creationDate) {
                case let (x?, y?) where x != y: x > y
                case (nil, _?): false
                case (_?, nil): true
                default: a.added < b.added
                }
            }.map(\.snapshot.localIdentifier)
        }
    }

    func creationDates() async throws -> [Date?] {
        try read {
            listed += 1
            return photos.values.filter { visible($0.snapshot.localIdentifier) }.map(\.snapshot.creationDate)
        }
    }

    func snapshots(of ids: [String]) async throws -> [PhotoSnapshot] {
        try read {
            let found = ids.filter(visible).compactMap { photos[$0].map(stated) }
            snapshotsMade += found.count
            return found
        }
    }

    private func stated(_ photo: Photo) -> PhotoSnapshot {
        var snapshot = photo.snapshot
        for (index, file) in photo.files.enumerated() {
            switch file {
            case .here(let bytes), .inCloud(let bytes): snapshot.resources[index].size = sizing ? Int64(bytes.count) : nil
            case .sized(let size, _): snapshot.resources[index].size = sizing ? size : nil
            case .missing, .failing, .offline, .stalled: snapshot.resources[index].size = nil
            }
        }
        return snapshot
    }

    func file(of id: String, resource: PhotoResource, network: Bool, most: Int64, to url: URL) async -> Fetched {
        let file: File? = lock.withLock {
            asked += 1
            guard visible(id), let photo = photos[id],
                  let index = photo.snapshot.resources.firstIndex(where: { $0.isSameFile(as: resource) }) else { return nil }
            return photo.files[index]
        }
        switch file {
        case nil, .missing: return .refused(.notFound)
        case .failing: return .refused(.downloadFailed)
        case .offline: return .later
        case .inCloud where !network, .stalled where !network: return .later
        case .stalled:
            try? await Task.sleep(nanoseconds: 86_400 * 1_000_000_000)
            return .later
        case .inCloud(let bytes), .here(let bytes), .sized(_, let bytes):
            guard Int64(bytes.count) <= most else { return .noRoom }
            if case .inCloud = file { lock.withLock { downloadsMade += 1 } }
            do { try bytes.write(to: url, options: .withoutOverwriting) } catch { return .later }
            return .file(url)
        }
    }
}
