import CryptoKit
import Evidence
import Foundation
import HomeLink

final class FileEngine: ShippingDomain {
    typealias Names = HomeLink.MacStore.Engine.Names

    let sourceId: String
    let name: String
    private let feeder: String
    private let files: [HomeLink.MacStore.Engine.Member]
    private let names: (rule: Names, at: [String])?
    private let road: StoreFiles
    private let hashCache: URL
    private let ledgers: Ledgers
    private let named: @Sendable (String, URL) -> URL?
    private let filesUnread = SealNote<Unread?>(nil)
    private let stated = SealNote<Through?>(nil)

    init(sourceId: String, store: HomeLink.MacStore, files declared: [HomeLink.MacStore.Engine.Member], names: Names?, account: String,
         road: StoreFiles, hashCache: URL, ledgers: Ledgers, named: (@Sendable (String, URL) -> URL?)? = nil) throws {
        self.sourceId = sourceId
        name = store.name
        feeder = store.feeder
        for path in declared.map(\.path) + (names.map { [$0.root] } ?? []) { _ = try road.path(path) }
        files = declared
        self.names = names.map { rule in (rule, rule.at.components(separatedBy: ".").map { $0 == "<account>" ? account : $0 }) }
        self.road = road
        self.hashCache = hashCache
        self.ledgers = ledgers
        self.named = named ?? { road.named($0, under: $1) }
    }

    func seal(_ request: SealRequest) throws -> [SealedBundle] {
        let ledger = ledgers.ledger(HashEntry.self, pass: request.custody.pass, source: sourceId)
        let held = try ledger.held(through: request.custody.received)
        stated.value = nil
        let start = request.start.map { Int(($0.timeIntervalSince1970 * 1_000_000_000).rounded(.down)) }
        let fromStart = { (modifiedAt: Int?) -> Bool in
            guard let start, let modifiedAt else { return true }
            return modifiedAt >= start
        }
        var months = Months()
        var listed: [(member: String, bytes: Data, modifiedAt: Int)] = []
        for file in files {
            guard let opened = try road.open(try road.path(file.path), spelled: file.path), let bytes = try? opened.bytes() else {
                throw FileEngineError.missing(file.member)
            }
            months.file(modifiedAt: opened.stamp.modifiedAt, bytes: bytes.count)
            listed.append((file.member, bytes, opened.stamp.modifiedAt))
        }
        let read = listed.filter { fromStart($0.modifiedAt) }
        var namedFiles: [(locator: String, file: URL, modifiedAt: Int?)] = []
        if let names, let from = listed.first(where: { $0.member == names.rule.from }) {
            let root = try road.path(names.rule.root)
            var seen = Set<String>()
            for locator in try Self.locators(names.rule, at: names.at, in: from.bytes) where seen.insert(locator).inserted {
                guard let file = named(locator, root) else { continue }
                let stamp = (try? road.opener.open(file))??.stamp
                if let stamp { months.file(modifiedAt: stamp.modifiedAt, bytes: stamp.bytes) }
                namedFiles.append((locator, file, stamp?.modifiedAt))
            }
        }
        guard !read.isEmpty else {
            if request.owesThrough { stated.value = request.through(readThrough: request.fetchedAt, months: months) }
            return []
        }
        let naming = names.flatMap { names in read.contains { $0.member == names.rule.from } ? names : nil }
        var index = BlobIndex()
        var firstPath: [String: URL] = [:]
        var cache = HashCache(file: hashCache, files: ledgers.files)
        defer {
            filesUnread.value = .files(cache.failing(at: request.fetchedAt))
            try? cache.save()
        }
        if naming != nil {
            for named in namedFiles where fromStart(named.modifiedAt) {
                guard let measured = try cache.measureNamed(locator: named.locator, file: named.file, opener: road.opener,
                                                            at: request.fetchedAt) else { continue }
                index.set(named.locator, BlobIndex.Entry(sha256: measured.sha256, bytes: measured.bytes))
                if firstPath[measured.sha256] == nil { firstPath[measured.sha256] = named.file }
            }
        }
        let shipped = Set(held.flatMap(\.entry.hashes))
        let counted = request.owed(months)
        var uncarried: Set<String> = []
        var answered: Set<String>?
        var staged: Set<String> = []
        while true {
            let carried = index.without(uncarried)
            let marked = read.reduce(Data()) { $0 + $1.bytes } + (naming == nil ? Data() : carried.data)
            let mark = SHA256.hash(data: marked).map { String(format: "%02x", $0) }.joined()
            guard mark != held.last?.entry.mark else {
                cache.shipped(carried.entries.keys)
                if request.owesThrough { stated.value = request.through(readThrough: request.fetchedAt, months: months) }
                return []
            }
            let unsent = firstPath.filter { !shipped.contains($0.key) && !uncarried.contains($0.key) }
            if let staging = request.staged, answered == nil {
                let sizes = Dictionary(index.entries.values.map { ($0.sha256, Int64($0.bytes)) }, uniquingKeysWith: max)
                let large = unsent.compactMap { sha256, file -> StagedBlobs.Large? in
                    guard let bytes = sizes[sha256], bytes > staging.thresholdBytes else { return nil }
                    return StagedBlobs.Large(sha256: sha256, file: file, bytes: bytes)
                }
                if !large.isEmpty {
                    let named = Set(unsent.keys)
                    let held = request.held(named).intersection(named)
                    answered = held
                    guard let ready = staging.ready(large, held: held, kept: false, kind: .new) else { return [] }
                    staged = ready
                }
            }
            let carrying = staged.subtracting(uncarried)
            var members = read.map { BundleWriter.File(name: $0.member, content: .bytes($0.bytes)) }
            if let names = naming { members.append(BundleWriter.File(name: names.rule.index, content: .bytes(carried.data))) }
            let written: BundleWriter.Written
            do {
                written = try BundleWriter.write(
                    into: request.workDirectory, sourceId: sourceId, feeder: feeder, fetchedAt: request.fetchedAt, files: members,
                    blobs: unsent.filter { !carrying.contains($0.key) }
                        .map { BundleWriter.Blob(sha256: $0.key, file: $0.value, opener: road.opener) },
                    stagedBlobs: carrying.sorted(),
                    held: { [answered] hexes in answered.map { $0.intersection(hexes) } ?? request.held(hexes) },
                    facts: [("snapshot_taken_at", .string(UTCInstant.rfc3339(request.fetchedAt)))] + Months.facts(counted),
                    custody: (request.custody, []), through: ledgers.files)
            } catch let error as BundleWriterError {
                guard let blob = error.uncarriedBlob, !uncarried.contains(blob.sha256) else { throw error }
                uncarried.insert(blob.sha256)
                for (locator, entry) in index.entries where entry.sha256 == blob.sha256 {
                    cache.failed(locator: locator, why: blob.why, at: request.fetchedAt)
                }
                continue
            }
            try ledger.record(HashEntry(mark: mark, hashes: written.named), at: request.custody.seal)
            cache.shipped(carried.entries.keys)
            return [SealedBundle(file: written.file, sidecar: BundleSidecar(id: written.id, sourceId: sourceId, custody: request.custody,
                                                                            write: .new, months: counted, stagedBlobs: written.staged))]
        }
    }

    var unread: Unread? { filesUnread.value }
    var through: Through? { stated.value }

    func applied(_ answer: FreshAnswer) {
        guard let custody = answer.sources[sourceId] else { return }
        try? ledgers.ledger(HashEntry.self, pass: answer.pass, source: sourceId).prune(imported: custody.imported)
    }

    static func locators(_ names: Names, at path: [String], in bytes: Data?) throws -> [String] {
        guard let bytes, let object = try? JSONSerialization.jsonObject(with: bytes),
              (names.where ?? []).allSatisfy({ StoreValues.holds($0, object) }) else { throw FileEngineError.unreadable(names.from) }
        return try named(object, path)
    }

    static func named(_ value: Any, _ path: [String]) throws -> [String] {
        guard let step = path.first else { return (value as? String).map { [$0] } ?? [] }
        let rest = Array(path.dropFirst())
        if step == "[]" {
            guard let list = value as? [Any] else { throw FileEngineError.notAList }
            return try list.flatMap { try named($0, rest) }
        }
        guard let next = (value as? [String: Any])?[step] else { return [] }
        return try named(next, rest)
    }
}

enum FileEngineError: PathFreeError, Equatable {
    case missing(String)
    case unreadable(String)
    case notAList

    var description: String {
        switch self {
        case .missing(let member): return "the file shipped as \(member) cannot be read"
        case .unreadable(let member): return "\(member) is not the file its store declares"
        case .notAList: return "a file's names step into a list that is not one"
        }
    }
}
