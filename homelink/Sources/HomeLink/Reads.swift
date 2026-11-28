import Foundation

extension HomeLink {

    public func days(from: String? = nil, to: String? = nil, after: String? = nil, limit: Int? = nil) async throws -> DayList {
        try await read("/v1/days", [("from", from), ("to", to), ("after", after), ("limit", limit.map(String.init))])
    }

    public func day(_ day: String, etag inputs: String? = nil) async throws -> DayFile? {
        guard let path = Self.encoded(day) else { throw LinkFailure.unusableID }
        guard let response = try await get("/v1/days/" + path, etag: inputs.map { "\"\($0)\"" }) else { return nil }
        return try Self.decoded(DayFile.self, response)
    }

    public func sources() async throws -> [SourceRead] {
        var sources: [SourceRead] = []
        var after: String?
        repeat {
            let page = try await read("/v1/sources", [("after", after)], as: SourcePage.self)
            sources += page.sources
            after = page.next
        } while after != nil
        return sources
    }


    public func `where`(at instant: Date, etag: String? = nil) async throws -> Tagged<Where.At>? {
        try await tagged("/v1/where", [("at", String(Self.milliseconds(instant)))], etag: etag)
    }

    public func `where`(from: Bound, to: Bound, etag: String? = nil) async throws -> Tagged<Where.Pieces>? {
        try await tagged("/v1/where", [("from", from.query), ("to", to.query)], etag: etag)
    }

    public func `where`(from: Bound, to: Bound, grain: Where.Grain, etag: String? = nil) async throws -> Tagged<Where.Summaries>? {
        try await tagged("/v1/where", [("from", from.query), ("to", to.query), ("grain", grain.rawValue)], etag: etag)
    }


    static let labelsMost = 256

    public func places(at points: [Where.Point]) async throws -> [PointPlace] {
        var placed: [PointPlace] = []
        for start in stride(from: 0, to: points.count, by: Self.labelsMost) {
            let batch = points[start..<min(start + Self.labelsMost, points.count)]
            let answer = try await read("/v1/labels", batch.map { ("point", Self.query(of: $0)) }, as: PointPlaces.self)
            guard answer.places.count == batch.count else { throw LinkFailure.unreadable(200) }
            placed += answer.places
        }
        return placed
    }

    public func chats(_ keys: [String]) async throws -> [ChatLabel] {
        var labelled: [ChatLabel] = []
        for start in stride(from: 0, to: keys.count, by: Self.labelsMost) {
            let batch = keys[start..<min(start + Self.labelsMost, keys.count)]
            let answer = try await read("/v1/labels", batch.map { ("chat", $0) }, as: ChatLabels.self)
            guard answer.chats.count == batch.count else { throw LinkFailure.unreadable(200) }
            labelled += answer.chats
        }
        return labelled
    }

    private static func query(of point: Where.Point) -> String {
        "\(point.latitude),\(point.longitude)" + (point.id.map { ",\($0)" } ?? "")
    }


    public func search(_ query: SearchQuery) async throws -> Searched {
        try await Self.paged {
            let response = try await contact("GET", "/v1/search" + Self.query(Self.parameters(query)), [:], .empty,
                                             timeout: Self.silence, within: HomeLink.look)
            if response.status == 503, let refusal = try? JSONDecoder().decode(Building.self, from: response.body),
               refusal.code == "INDEX_BUILDING" {
                return .building(refusal.building ?? [])
            }
            guard response.status == 200 else { throw failure(response) }
            return .answer(try Self.decoded(SearchAnswer.self, response))
        }
    }

    private struct Building: Decodable {
        let code: String
        let building: [String]?
    }

    public func read(ref: String, cursor: String? = nil) async throws -> Read.Answer {
        try await read("/v1/read", [("ref", ref), ("cursor", cursor)])
    }

    public static let describedAtOnce = 20

    public func describe(_ refs: [String]) async throws -> Described {
        guard !refs.isEmpty, refs.count <= Self.describedAtOnce else { throw LinkFailure.unusableID }
        return try await read("/v1/describe", refs.map { ("ref", $0) })
    }


    public func count(_ query: CountQuery) async throws -> Counted {
        try await read("/v1/count", [("of", query.of)] + query.person.map { ("person", $0) } + [("from", query.from), ("to", query.to)])
    }



    public func people() async throws -> People {
        try await read("/v1/people")
    }

    public func peopleAt() async throws -> Positioned<People> {
        guard let response = try await get("/v1/people", []) else { throw LinkFailure.unreadable(304) }
        let people = try Self.decoded(People.self, response)
        return Positioned(value: people, position: Position(response.header("Lifestream-Position")))
    }

    public func person(id: String) async throws -> Positioned<Person> {
        guard let response = try await get("/v1/people", [("id", id)]) else { throw LinkFailure.unreadable(304) }
        let one = try Self.decoded(OnePerson.self, response)
        return Positioned(value: one.person, position: Position(response.header("Lifestream-Position")))
    }

    public func personPhotos(id: String, after: String? = nil, etag: String? = nil) async throws -> Tagged<People.Photos>? {
        try await tagged("/v1/people/photos", [("id", id), ("after", after)], etag: etag)
    }


    public func products() async throws -> Products {
        try await read("/v1/products")
    }

    public func status(within: TimeInterval = HomeLink.look) async throws -> Status {
        try await read("/v1/status", within: within)
    }

    public func privacy() async throws -> PrivacyState {
        try await read("/v1/privacy")
    }

    public func outbound(of item: Made.Ask) async throws -> [Outbound] {
        try await read("/v1/outbound", [("family", item.family), ("item", item.item)], as: Carried.self).rows
    }

    public func outbound(seq: Int) async throws -> Outbound {
        try await read("/v1/outbound/\(seq)")
    }

    public func devices() async throws -> [Camera] {
        try await read("/v1/devices", as: Cameras.self).cameras
    }


    public static let owedAtOnce = 200

    public func photosWanted<Wanted: Decodable>(source: String, owed: [String] = []) async throws -> Wanted {
        try await read("/v1/photos/wanted", [("source", source), ("files", "1")] + owed.map { ("owed", $0) })
    }

    public func photo(_ hash: String) async throws -> Photo {
        guard Self.isHash(hash) else { throw LinkFailure.unusableID }
        return try await read("/v1/photos/" + hash, as: OnePhoto.self).photo
    }


    public static let heldAtOnce = 5_000

    public func held(blobs: Set<String>) async throws -> Set<String> {
        try await holding(blobs).held
    }

    public struct Holding: Sendable, Equatable {
        public var held = Set<String>()
        public var staged = Set<String>()
        public var partly: [String: Int64] = [:]

        public init(held: Set<String> = [], staged: Set<String> = [], partly: [String: Int64] = [:]) {
            self.held = held
            self.staged = staged
            self.partly = partly
        }

        public func whole(_ name: String) -> Bool { held.contains(name) || staged.contains(name) }
    }

    public func holding(_ blobs: Set<String>) async throws -> Holding {
        struct Answer: Decodable {
            let held: [String]
            let staged: [String]?
            let partly: [String: Int64]?
        }
        let asked = blobs.sorted()
        var holding = Holding()
        for start in stride(from: 0, to: asked.count, by: Self.heldAtOnce) {
            let some = Array(asked[start..<min(start + Self.heldAtOnce, asked.count)])
            let body = try JSONSerialization.data(withJSONObject: ["blobs": some], options: [.sortedKeys, .withoutEscapingSlashes])
            let response = try await contact("POST", "/v1/blobs/held", ["Content-Type": "application/json"], .json(body),
                                             timeout: Self.silence)
            guard response.status == 200 else { throw failure(response) }
            let answer = try Self.decoded(Answer.self, response)
            holding.held.formUnion(answer.held)
            holding.staged.formUnion(answer.staged ?? [])
            holding.partly.merge(answer.partly ?? [:]) { _, new in new }
        }
        holding.held.formIntersection(blobs)
        holding.staged.formIntersection(blobs)
        holding.partly = holding.partly.filter { blobs.contains($0.key) }
        return holding
    }

    public struct ImportDigest: Hashable, Sendable {
        public let kind: String
        public let digest: String

        public init(kind: String, digest: String) {
            self.kind = kind
            self.digest = digest
        }
    }

    public enum ImportLook: String, Decodable, Sendable {
        case admitted = "in"
        case refused
        case letGo = "let-go"
    }

    public func held(imports files: Set<ImportDigest>) async throws -> [ImportDigest: ImportLook] {
        struct Held: Decodable {
            struct File: Decodable {
                let kind: String
                let digest: String
                let state: ImportLook
            }
            let held: [File]
        }
        let asked = files.sorted { ($0.kind, $0.digest) < ($1.kind, $1.digest) }
        var held: [ImportDigest: ImportLook] = [:]
        for start in stride(from: 0, to: asked.count, by: Self.heldAtOnce) {
            let some = asked[start..<min(start + Self.heldAtOnce, asked.count)].map { ["kind": $0.kind, "digest": $0.digest] }
            let body = try JSONSerialization.data(withJSONObject: ["files": some], options: [.sortedKeys, .withoutEscapingSlashes])
            let response = try await contact("POST", "/v1/imports/held", ["Content-Type": "application/json"], .json(body),
                                             timeout: Self.silence)
            guard response.status == 200 else { throw failure(response) }
            for file in try Self.decoded(Held.self, response).held {
                let digest = ImportDigest(kind: file.kind, digest: file.digest)
                if files.contains(digest) { held[digest] = file.state }
            }
        }
        return held
    }


    public func extracts(family: String, unit: String) async throws -> [Extract] {
        try await read("/v1/extracts", [("family", family), ("unit", unit)], as: ExtractPage.self).extracts
    }

    public func conversation(chat: String, day: String) async throws -> ChatDay {
        try await read("/v1/conversation", [("chat", chat), ("day", day)])
    }

    public func extracts(family: String, day: String) async throws -> [Extract] {
        var extracts: [Extract] = []
        var after: String?
        repeat {
            let page = try await read("/v1/extracts", [("family", family), ("day", day), ("after", after)], as: ExtractPage.self)
            extracts += page.extracts
            after = page.next
        } while after != nil
        return extracts
    }

    public func record(source: String, kind: String, key: String) async throws -> Record {
        let query: [(String, String?)] = [("source", source), ("kind", kind), ("key", key), ("text", "1")]
        guard let response = try await get("/v1/record", query) else { throw LinkFailure.unreadable(304) }
        var record = try Self.decoded(Record.self, response)
        record.body = response.body
        return record
    }

    public func blob(_ hash: String) async throws -> Data {
        guard Self.isHash(hash) else { throw LinkFailure.unusableID }
        guard let response = try await get("/v1/blobs/" + hash) else { throw LinkFailure.unreadable(304) }
        guard Restore.sha256(response.body) == hash else { throw LinkFailure.unreadable(response.status) }
        return response.body
    }

    @discardableResult
    public func blob(_ hash: String, range: Range<Int64>, received: (_ bytes: Data, _ total: Int64) throws -> Void) async throws -> Int64 {
        guard Self.isHash(hash), range.lowerBound >= 0, !range.isEmpty else { throw LinkFailure.unusableID }
        var at = range.lowerBound
        var back: AnswersAgain?
        defer { back?.stop() }
        while true {
            let revision = snapshot.revision
            do {
                return try await ranged(hash, at..<range.upperBound) { bytes, total in
                    at += Int64(bytes.count)
                    try received(bytes, total)
                }
            } catch LinkFailure.noAnswer {
                if back == nil { back = AnswersAgain(self, within: Self.silence) }
                try await back?.past(revision)
            }
        }
    }

    private func ranged(_ hash: String, _ range: Range<Int64>, _ received: (Data, Int64) throws -> Void) async throws -> Int64 {
        let token = tick()
        let answer: HomeBytes
        do {
            answer = try await contact("GET", "/v1/blobs/" + hash, ["Range": "bytes=\(range.lowerBound)-\(range.upperBound - 1)"],
                                       { _ in .empty }, timeout: Self.silence) { request, _ in
                try await self.bytes(request) { status, headers in
                    RangeAnswer(range, HomeResponse(status: status, headers: headers, body: Data())).most
                }
            }
        } catch {
            observe(error, token: token)
            throw error
        }
        let head = HomeResponse(status: answer.status, headers: answer.headers, body: Data())
        switch RangeAnswer(range, head) {
        case .bytes(let length, let total):
            observe(head, token: token)
            var left = length
            do {
                for try await piece in answer.body {
                    left -= Int64(piece.count)
                    try received(piece, total)
                }
            } catch is TooLong {
                throw LinkFailure.unreadable(206)
            } catch let failure as LinkFailure {
                throw failure
            } catch {
                let reached = Self.reached(error)
                observe(reached, token: token)
                throw reached
            }
            guard left == 0 else { throw LinkFailure.unreadable(206) }
            return total
        case .end(let total):
            observe(head, token: token)
            return total
        case .refused:
            observe(head, token: token)
            throw LinkFailure.unreadable(answer.status)
        case .words:
            var body = Data()
            do {
                for try await piece in answer.body { body += piece }
            } catch is TooLong {
                observe(head, token: token)
                throw LinkFailure.unreadable(answer.status)
            } catch {
                let reached = Self.reached(error)
                observe(reached, token: token)
                throw reached
            }
            let response = HomeResponse(status: answer.status, headers: answer.headers, body: body)
            observe(response, token: token)
            throw failure(response)
        }
    }

    private enum RangeAnswer {
        case bytes(length: Int64, total: Int64)
        case end(total: Int64)
        case words
        case refused

        static let wordsMost: Int64 = 64 << 10

        init(_ range: Range<Int64>, _ head: HomeResponse) {
            switch head.status {
            case 206:
                guard let (start, end, total) = HomeLink.contentRange(head.header("Content-Range")), start == range.lowerBound,
                      end == range.upperBound - 1 || (end == total - 1 && end < range.upperBound - 1) else { self = .refused; return }
                self = .bytes(length: end - start + 1, total: total)
            case 416:
                guard let words = head.header("Content-Range"), words.hasPrefix("bytes */"),
                      let total = Int64(words.dropFirst("bytes */".count)), total == range.lowerBound else { self = .refused; return }
                self = .end(total: total)
            case 200:
                self = .refused
            default:
                self = .words
            }
        }

        var most: Int64? {
            switch self {
            case .bytes(let length, _): length
            case .words: Self.wordsMost
            case .end, .refused: nil
            }
        }
    }

    private static func contentRange(_ words: String?) -> (Int64, Int64, Int64)? {
        guard let words, words.hasPrefix("bytes ") else { return nil }
        let parts = words.dropFirst("bytes ".count).split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, let total = Int64(parts[1]) else { return nil }
        let ends = parts[0].split(separator: "-", omittingEmptySubsequences: false)
        guard ends.count == 2, let start = Int64(ends[0]), let end = Int64(ends[1]), start >= 0, start <= end, end < total else { return nil }
        return (start, end, total)
    }

    public enum PictureSize: String, Sendable, Hashable {
        case tile, screen

        public init(box pixels: Int) {
            self = pixels <= 640 ? .tile : .screen
        }
    }

    public struct Pictures: Decodable, Sendable, Equatable {
        public let recipe: Int
    }

    public func pictures() async throws -> Pictures {
        try await read("/v1/pictures")
    }

    public func picture(_ hash: String, size: PictureSize) async throws -> Data {
        guard Self.isHash(hash) else { throw LinkFailure.unusableID }
        let recipe = try await recipes.current { [self] in try await pictures().recipe }
        let query = [("size", size.rawValue), ("recipe", String(recipe))]
        guard let response = try await get("/v1/pictures/" + hash, query) else { throw LinkFailure.unreadable(304) }
        if response.header("Cache-Control") == "no-store" { recipes.moved(from: recipe) }
        return response.body
    }

    private static func isHash(_ hash: String) -> Bool {
        hash.hasPrefix("sha256:") && hash.utf8.count == 71
    }


    public struct Places: Sendable, Equatable {
        public let body: Data
        public let etag: String?

        public static func hidden(in body: Data) throws -> [HiddenSpot] {
            do {
                return try JSONDecoder().decode(HiddenList.self, from: body).hidden ?? []
            } catch {
                throw LinkFailure.unreadable(200)
            }
        }

        private struct HiddenList: Decodable {
            let hidden: [HiddenSpot]?
        }

        public static func spots(in body: Data) throws -> [Spot] {
            do {
                return try JSONDecoder().decode(SpotList.self, from: body).spots ?? []
            } catch {
                throw LinkFailure.unreadable(200)
            }
        }

        private struct SpotList: Decodable {
            let spots: [Spot]?
        }
    }

    public func places(etag: String?) async throws -> Places? {
        guard let response = try await get("/v1/places", etag: etag) else { return nil }
        return Places(body: response.body, etag: response.header("ETag"))
    }

    public func suggest(spot key: String, q: String? = nil) async throws -> Suggestions {
        try await read("/v1/places/suggest", [("spot", key), ("q", q)])
    }

    public func place(slug: String, etag: String? = nil) async throws -> Tagged<Place>? {
        let one: Tagged<OnePlace>? = try await tagged("/v1/places", [("slug", slug)], etag: etag)
        return one.map { Tagged(value: $0.value.place, etag: $0.etag) }
    }

    public func placePhotos(slug: String, after: String? = nil, etag: String? = nil) async throws -> Tagged<PlacePhotos>? {
        try await tagged("/v1/places/photos", [("slug", slug), ("after", after)], etag: etag)
    }

    public struct PageKey: Hashable, Sendable, CustomStringConvertible {
        public static let settled = "settled"

        public let route: String
        public let query: [String: String]

        public init(_ route: String, _ query: [String: String] = [:]) {
            self.route = route
            self.query = query.filter { $0.key != Self.settled }
        }

        public func became(_ id: String) -> PageKey {
            PageKey(route, query.merging(["id": id]) { $1 })
        }

        var items: [(String, String?)] {
            query.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
        }

        public var description: String { route + HomeLink.query(items) }
    }

    public func page(_ key: PageKey, etag: String?, settled: Bool = false) async throws -> Tagged<Data>? {
        guard let response = try await get(key.route, key.items + [(PageKey.settled, settled ? "1" : nil)], etag: etag) else { return nil }
        return Tagged(value: response.body, etag: response.header("ETag"))
    }


    func get(_ path: String, _ query: [(String, String?)] = [], etag: String? = nil,
             within: TimeInterval = HomeLink.look) async throws -> HomeResponse? {
        let response = try await contact("GET", path + Self.query(query), etag.map { ["If-None-Match": $0] } ?? [:], .empty,
                                         timeout: Self.silence, within: within)
        if response.status == 304, etag != nil { return nil }
        guard response.status == 200 else { throw failure(response) }
        return response
    }

    private func read<Value: Decodable>(_ path: String, _ query: [(String, String?)] = [],
                                        as type: Value.Type = Value.self, within: TimeInterval = HomeLink.look) async throws -> Value {
        guard let response = try await get(path, query, within: within) else { throw LinkFailure.unreadable(304) }
        return try Self.decoded(type, response)
    }

    private func tagged<Value: Decodable & Sendable>(_ path: String, _ query: [(String, String?)],
                                                     etag: String?) async throws -> Tagged<Value>? {
        guard let response = try await get(path, query, etag: etag) else { return nil }
        return Tagged(value: try Self.decoded(Value.self, response), etag: response.header("ETag"))
    }

    static func decoded<Value: Decodable>(_ type: Value.Type, _ response: HomeResponse) throws -> Value {
        do {
            return try JSONDecoder().decode(type, from: response.body)
        } catch {
            throw LinkFailure.unreadable(response.status)
        }
    }

    static func query(_ items: [(String, String?)]) -> String {
        let present = items.compactMap { name, value in value.map { (name, $0) } }
        guard !present.isEmpty else { return "" }
        return "?" + present.map { name, value in
            name + "=" + (value.addingPercentEncoding(withAllowedCharacters: queryValue) ?? "")
        }.joined(separator: "&")
    }

    private static let queryValue = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")

    static func parameters(_ query: SearchQuery) -> [(String, String?)] {
        var items: [(String, String?)] = [("query", query.query), ("from", query.from), ("to", query.to)]
        items += query.families.map { ("families", $0) } + query.products.map { ("products", $0) } + query.person.map { ("person", $0) }
        items += [("chat", query.chat), ("place", query.place), ("order", query.order?.rawValue), ("limit", query.limit.map(String.init))]
        items += query.lists.map { ("lists", $0.rawValue) }
        items += [("typing", query.typing ? "1" : nil), ("cursor", query.cursor)]
        return items
    }

    static func milliseconds(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded(.down))
    }

    private struct OnePerson: Decodable {
        let person: Person
    }

    private struct OnePlace: Decodable, Sendable {
        let place: Place
    }

    private struct OnePhoto: Decodable {
        let photo: Photo
    }

    private struct Cameras: Decodable {
        let cameras: [Camera]
    }

    private struct ExtractPage: Decodable {
        let extracts: [Extract]
        let next: String?
    }

    private struct SourcePage: Decodable {
        let sources: [SourceRead]
        let next: String?
    }
}

final class Recipes: @unchecked Sendable {
    private let lock = NSLock()
    private var kept: Int?
    private var reading: Task<Int, Error>?

    private enum Found {
        case kept(Int)
        case reading(Task<Int, Error>)
    }

    func current(_ ask: @escaping @Sendable () async throws -> Int) async throws -> Int {
        let task: Task<Int, Error>
        switch lock.withLock({ () -> Found in
            if let kept { return .kept(kept) }
            let task = reading ?? Task { try await ask() }
            reading = task
            return .reading(task)
        }) {
        case .kept(let recipe): return recipe
        case .reading(let read): task = read
        }
        do {
            let recipe = try await task.value
            lock.withLock {
                if reading == task { (kept, reading) = (recipe, nil) }
            }
            return recipe
        } catch {
            lock.withLock { if reading == task { reading = nil } }
            throw error
        }
    }

    func moved(from recipe: Int) {
        lock.withLock { if kept == recipe { kept = nil } }
    }
}

extension HomeLink {
    final class AnswersAgain: @unchecked Sendable {
        private enum Heard { case reach(ReachSnapshot), deadline }

        private var heard: AsyncStream<Heard>.Iterator
        private let feed: AsyncStream<Heard>.Continuation
        private let watch: Task<Void, Never>

        init(_ link: HomeLink, within: TimeInterval) {
            let (stream, feed) = AsyncStream<Heard>.makeStream()
            heard = stream.makeAsyncIterator()
            self.feed = feed
            let snapshots = link.snapshots()
            watch = Task {
                for await snapshot in snapshots { feed.yield(.reach(snapshot)) }
            }
            link.pacer.after(within) { feed.yield(.deadline) }
        }

        func past(_ revision: Int) async throws {
            while let next = await heard.next() {
                switch next {
                case .reach(let snapshot) where snapshot.revision > revision: return
                case .reach: continue
                case .deadline: throw LinkFailure.noAnswer(sent: true)
                }
            }
            throw CancellationError()
        }

        func stop() {
            watch.cancel()
            feed.finish()
        }
    }
}
