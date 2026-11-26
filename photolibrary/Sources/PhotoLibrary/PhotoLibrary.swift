import Foundation

public enum PhotoAccess: String, Sendable, Codable {
    case full, limited, denied, restricted, undecided

    public var reads: Bool { self == .full || self == .limited }
}

public struct PhotoLibrary: Sendable {
    let source: any PhotoSource

    init(source: any PhotoSource) { self.source = source }

    public init(_ synthetic: SyntheticLibrary) { source = synthetic }

    public var access: PhotoAccess { source.access }

    public func requestAccess() async -> PhotoAccess { await source.requestAccess() }

    public func count() async throws -> Int { try await source.count() }

    public func countByMonth() async throws -> [String: Int] {
        var items: [String: Int] = [:]
        for date in try await source.creationDates() { items[PhotoMonth.key(of: date), default: 0] += 1 }
        return items
    }

    public func observe(_ changed: @escaping @Sendable () -> Void) { source.observe(changed) }

    public func read(after mark: ReadMark?, whole: Bool, limit: Int = 1_000) async throws -> ReadPage {
        let access = source.access
        guard access.reads else { throw PhotoLibraryError.noAccess }
        var mark = mark?.access == access ? mark! : ReadMark(access: access, token: nil, backlog: nil, restating: false, sized: true)
        guard let token = mark.token else {
            return try await begun(mark, restating: mark.restating, access: access, whole: whole, limit: limit)
        }
        if let changes = try await source.changes(since: token, limit: limit) {
            if let last = changes.last {
                var upserted: [String] = []
                var seen = Set<String>()
                var deleted: [String] = []
                for change in changes {
                    deleted += change.deleted
                    for id in change.upserted where seen.insert(id).inserted { upserted.append(id) }
                }
                mark.token = last.token
                let snapshots = try await source.snapshots(of: upserted)
                return ReadPage(snapshots: snapshots, gone: access == .full ? deleted : [], whole: false, mark: mark)
            }
        } else {
            mark.token = nil
            mark.restating = mark.backlog == nil || mark.restating
            return ReadPage(snapshots: [], gone: [], whole: false, mark: mark)
        }
        guard whole else { return ReadPage(snapshots: [], gone: [], whole: false, mark: mark) }
        if mark.owesRestatement {
            return try await begun(mark, restating: mark.backlog == nil || mark.restating, access: access, whole: true,
                                   limit: limit)
        }
        if mark.rereads == true {
            return try await begun(mark, restating: mark.restating, access: access, whole: true, limit: limit)
        }
        return try await page(of: mark, limit: limit)
    }

    private func begun(_ mark: ReadMark, restating: Bool, access: PhotoAccess, whole: Bool, limit: Int) async throws -> ReadPage {
        let mark = try await begin(mark, restating: restating)
        var first = whole ? try await page(of: mark, limit: limit) : ReadPage(snapshots: [], gone: [], whole: false, mark: mark)
        first.begins = true
        if access == .full { first.listed = mark.backlog ?? [] }
        return first
    }

    private func page(of mark: ReadMark, limit: Int) async throws -> ReadPage {
        guard let backlog = mark.backlog else { return ReadPage(snapshots: [], gone: [], whole: false, mark: mark) }
        var mark = mark
        let ids = Array(backlog.prefix(limit))
        let snapshots = try await source.snapshots(of: ids)
        mark.backlog = backlog.count > ids.count ? Array(backlog.dropFirst(ids.count)) : nil
        if mark.backlog == nil { mark.restating = false }
        return ReadPage(snapshots: snapshots, gone: [], whole: true, mark: mark)
    }

    private func begin(_ mark: ReadMark, restating: Bool) async throws -> ReadMark {
        var mark = mark
        if mark.token == nil { mark.token = try await source.token() }
        let ids = try await source.identifiers()
        mark.backlog = ids.isEmpty ? nil : ids
        mark.restating = restating && !ids.isEmpty
        mark.sized = true
        mark.rereads = nil
        return mark
    }

    public func files(of id: String, only types: Set<String>? = nil, network: Bool, room: Int64 = .max,
                      into directory: URL) async throws -> PhotoFiles? {
        guard let snapshot = try await source.snapshots(of: [id]).first else { return nil }
        var files: [Fetched] = []
        var left = room
        for resource in snapshot.resources {
            guard types?.contains(resource.type) ?? true else {
                files.append(.unasked)
                continue
            }
            guard resource.size != 0 else {
                files.append(.later)
                continue
            }
            guard left >= 0, (resource.size ?? 0) <= left else {
                left = -1
                files.append(.noRoom)
                continue
            }
            let url = directory.appendingPathComponent("photo-\(UUID().uuidString)")
            let fetched: Fetched = Task.isCancelled ? .later
                : await source.file(of: id, resource: resource, network: network, most: left, to: url)
            switch fetched {
            case .file(let url):
                left -= (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
            case .noRoom:
                left = -1
            case .later, .refused, .unasked:
                break
            }
            files.append(fetched)
        }
        return PhotoFiles(snapshot: snapshot, files: files)
    }
}

public enum PhotoLibraryError: Error, Equatable {
    case noAccess
}

public struct ReadMark: Codable, Sendable, Equatable {
    var access: PhotoAccess
    var token: Data?
    var backlog: [String]?
    var restating: Bool
    var sized: Bool?
    var rereads: Bool?

    public var unread: Int { backlog?.count ?? 0 }
    public var owesRestatement: Bool { sized != true }
    public var restates: Bool { restating || (backlog == nil && owesRestatement) }
    public var complete: Bool { token != nil && backlog == nil && !owesRestatement && rereads != true }

    public func rereading() -> ReadMark {
        var mark = self
        mark.rereads = true
        return mark
    }
}

public struct ReadPage: Sendable {
    public let snapshots: [PhotoSnapshot]
    public let gone: [String]
    public let whole: Bool
    public let mark: ReadMark
    public var listed: [String]? = nil
    public var begins = false
}

public struct PhotoFiles: Sendable {
    public let snapshot: PhotoSnapshot
    public let files: [Fetched]
}

public enum Fetched: Sendable, Equatable {
    case file(URL)
    case later
    case refused(Refusal)
    case unasked
    case noRoom
}
