import Foundation

extension HomeLink {
    public struct Tagged<Value: Sendable>: Sendable {
        public let value: Value
        public let etag: String?

        public init(value: Value, etag: String?) {
            self.value = value
            self.etag = etag
        }
    }

    public enum Bound: Sendable, Equatable, Hashable {
        case day(String)
        case instant(Date)

        var query: String {
            switch self {
            case .day(let day): return day
            case .instant(let date): return String(HomeLink.milliseconds(date))
            }
        }
    }


    public struct DayList: Decodable, Sendable, Equatable {
        public let days: [DayHead]
        public let next: String?
    }

    public struct DayHead: Decodable, Sendable, Equatable {
        public let day: String
        public let inputs: String
        public let counts: DayFile.Counts
    }

    public struct SourceRead: Decodable, Sendable, Equatable {
        public let id: String
        public let readThroughMs: Int64?

        public init(id: String, readThroughMs: Int64?) {
            self.id = id
            self.readThroughMs = readThroughMs
        }

        enum CodingKeys: String, CodingKey {
            case id
            case readThroughMs = "read_through_ms"
        }
    }


    public enum Where {
        public enum Kind: String, Decodable, Sendable { case stay, move, gap }
        public enum Level: String, Decodable, Sendable { case place, city, region, country }
        public enum How: String, Decodable, Sendable { case observed, seen, stated, bridged, guessed }
        public enum Grain: String, Decodable, Sendable { case day, month, year }

        public struct Point: Decodable, Sendable, Equatable, Hashable {
            public let latitude: Double
            public let longitude: Double
            public let id: String?
        }

        public struct Area: Codable, Sendable, Equatable, Hashable {
            public let city: String?
            public let cityID: String?
            public let region: String?
            public let country: String?
            public let countryCode: String?

            enum CodingKeys: String, CodingKey {
                case city, region, country
                case cityID = "city_id"
                case countryCode = "country_code"
            }
        }

        public struct Named: Decodable, Sendable, Equatable {
            public let words: String?
            public let area: Area
        }

        public struct Names: Decodable, Sendable, Equatable {
            public let point: Named?
            public let from: Named?
            public let to: Named?
        }

        public struct Span: Decodable, Sendable, Equatable {
            public let startMs: Int64
            public let endMs: Int64

            enum CodingKeys: String, CodingKey {
                case startMs = "start_ms"
                case endMs = "end_ms"
            }
        }

        public struct Leg: Decodable, Sendable, Equatable {
            public let startMs: Int64
            public let endMs: Int64
            public let mode: String
            public let distanceM: Double
            public let motion: String?
            public let stated: String?

            enum CodingKeys: String, CodingKey {
                case mode, motion, stated
                case startMs = "start_ms"
                case endMs = "end_ms"
                case distanceM = "distance_m"
            }
        }

        public struct Doubt: Decodable, Sendable, Equatable {
            public let by: [String]
            public let atMs: Int64
            public let distanceM: Double

            enum CodingKeys: String, CodingKey {
                case by
                case atMs = "at_ms"
                case distanceM = "distance_m"
            }
        }

        public struct Piece: Decodable, Sendable, Equatable {
            public let startMs: Int64
            public let endMs: Int64
            public let kind: Kind
            public let level: Level?
            public let point: Point?
            public let from: Point?
            public let to: Point?
            public let how: How?
            public let by: String?
            public let guess: Area?
            public let units: [String]
            public let legs: [Leg]?
            public let distanceM: Double?
            public let open: Bool?
            public let walks: [Span]?
            public let silences: [Span]?
            public let doubted: Doubt?
            public let names: Names
            public let spot: String?

            enum CodingKeys: String, CodingKey {
                case kind, level, point, from, to, how, by, guess, units, legs, open, walks, silences, doubted, names, spot
                case startMs = "start_ms"
                case endMs = "end_ms"
                case distanceM = "distance_m"
            }
        }

        public struct At: Decodable, Sendable, Equatable {
            public let atMs: Int64
            public let piece: Piece
            public let before: Piece?
            public let after: Piece?

            enum CodingKeys: String, CodingKey {
                case piece, before, after
                case atMs = "at_ms"
            }
        }

        public struct Pieces: Decodable, Sendable, Equatable {
            public let fromMs: Int64
            public let toMs: Int64
            public let pieces: [Piece]

            enum CodingKeys: String, CodingKey {
                case pieces
                case fromMs = "from_ms"
                case toMs = "to_ms"
            }
        }

        public struct Summaries: Decodable, Sendable, Equatable {
            public let fromMs: Int64
            public let toMs: Int64
            public let grain: Grain
            public let summaries: [Summary]

            enum CodingKeys: String, CodingKey {
                case grain, summaries
                case fromMs = "from_ms"
                case toMs = "to_ms"
            }
        }

        public struct Summary: Decodable, Sendable, Equatable {
            public let period: String
            public let from: String
            public let to: String
            public let places: [PlaceCount]
            public let cities: [AreaCount]
            public let regions: [AreaCount]
            public let countries: [AreaCount]
            public let base: Base?
            public let trips: [Trip]
            public let coverage: Coverage
        }

        public struct PlaceCount: Decodable, Sendable, Equatable {
            public let slug: String?
            public let name: String
            public let latitude: Double
            public let longitude: Double
            public let hours: Double
            public let days: Int
        }

        public struct AreaCount: Decodable, Sendable, Equatable {
            public let name: String
            public var cityID: String? = nil
            public let country: String?
            public let days: Int
            public let nights: Int
            public let guessedDays: Int
            public let guessedNights: Int

            enum CodingKeys: String, CodingKey {
                case name, country, days, nights
                case cityID = "city_id"
                case guessedDays = "guessed_days"
                case guessedNights = "guessed_nights"
            }
        }

        public struct Base: Decodable, Sendable, Equatable {
            public let city: String
            public var cityID: String? = nil
            public let nights: Int

            enum CodingKeys: String, CodingKey {
                case city, nights
                case cityID = "city_id"
            }
        }

        public struct Trip: Decodable, Sendable, Equatable {
            public let first: String
            public let last: String
            public let cities: [String]
            public let guessed: Bool
        }

        public struct Coverage: Decodable, Sendable, Equatable {
            public let place: Double
            public let moving: Double
            public let city: Double
            public let region: Double
            public let country: Double
            public let guessed: Double
            public let unknown: Double
            public let daysUnknown: [String]
            public let nightsUnknown: [String]

            enum CodingKeys: String, CodingKey {
                case place, moving, city, region, country, guessed, unknown
                case daysUnknown = "days_unknown"
                case nightsUnknown = "nights_unknown"
            }
        }
    }


    public struct PointPlace: Decodable, Sendable, Equatable {
        public let latitude: Double
        public let longitude: Double
        public let slug: String?
        public let name: String?
        public let shown: String

        public init(from decoder: Decoder) throws {
            var row = try decoder.unkeyedContainer()
            latitude = try row.decode(Double.self)
            longitude = try row.decode(Double.self)
            slug = try row.decodeIfPresent(String.self)
            name = try row.decodeIfPresent(String.self)
            shown = try row.decode(String.self)
        }
    }

    struct PointPlaces: Decodable, Sendable {
        let places: [PointPlace]
    }

    public struct ChatLabel: Decodable, Sendable, Equatable {
        public let key: String
        public let title: String?
        public let group: Bool
        public let open: Open?

        public init(from decoder: Decoder) throws {
            var row = try decoder.unkeyedContainer()
            key = try row.decode(String.self)
            title = try row.decodeIfPresent(String.self)
            group = try row.decode(Bool.self)
            open = try row.decodeIfPresent(Open.self)
        }
    }

    struct ChatLabels: Decodable, Sendable {
        let chats: [ChatLabel]
    }


    public struct SearchQuery: Sendable, Equatable {
        public enum Order: String, Sendable { case newest, oldest }
        public enum List: String, Sendable { case record }

        public var query: String?
        public var from: String?
        public var to: String?
        public var families: [String]
        public var products: [String]
        public var person: [String]
        public var chat: String?
        public var place: String?
        public var order: Order?
        public var limit: Int?
        public var lists: [List]
        public var typing: Bool
        public var cursor: String?

        public init(query: String? = nil, from: String? = nil, to: String? = nil, families: [String] = [], products: [String] = [],
                    person: [String] = [], chat: String? = nil, place: String? = nil, order: Order? = nil, limit: Int? = nil,
                    lists: [List] = [], typing: Bool = false, cursor: String? = nil) {
            self.query = query
            self.from = from
            self.to = to
            self.families = families
            self.products = products
            self.person = person
            self.chat = chat
            self.place = place
            self.order = order
            self.limit = limit
            self.lists = lists
            self.typing = typing
            self.cursor = cursor
        }
    }

    public struct SearchAnswer: Decodable, Sendable, Equatable {
        public let person: [Resolved]?
        public let record: RecordList?
    }

    public struct Resolved: Decodable, Sendable, Equatable {
        public let asked: String
        public let name: String
        public let ref: String?
    }

    public struct Reached: Decodable, Sendable, Equatable {
        public enum Side: String, Decodable, Sendable { case newest, oldest }

        public let side: Side
        public let at: String?
        public let whole: String?
    }

    public struct HeldDays: Decodable, Sendable, Equatable {
        public let first: String
        public let last: String
    }

    public struct Pending: Decodable, Sendable, Equatable {
        public enum Why: String, Decodable, Sendable { case new, erased, failed }

        public let day: String
        public let why: Why
    }

    public enum PageOrder: String, Decodable, Sendable { case newest }

    public struct RecordList: Decodable, Sendable, Equatable {
        public let total: Int
        public let hits: [RecordHit]
        public let capped: Bool?
        public let reached: Reached?
        public let held: HeldDays?
        public let pending: [Pending]?
        public let pendingMore: Int?
        public let spread: Spread?
        public let order: PageOrder?
        public let next: String?

        enum CodingKeys: String, CodingKey {
            case total, hits, capped, reached, held, pending, spread, order, next
            case pendingMore = "pending_more"
        }
    }

    public struct RecordHit: Decodable, Sendable, Equatable {
        public let ref: String
        public let day: String?
        public let family: String
        public let at: String?
        public let product: String?
        public let title: String?
        public let from: String?
        public let snippet: String?
        public let chat: String?
        public let chatTitle: String?
        public let picture: Int?
        public let more: Bool?

        enum CodingKeys: String, CodingKey {
            case ref, day, family, at, product, title, from, snippet, chat, picture, more
            case chatTitle = "chat_title"
        }
    }

    public struct Spread: Decodable, Sendable, Equatable {
        public let families: [String: Count]
        public let months: [String: Count]

        public struct Count: Decodable, Sendable, Equatable {
            public let n: Int
            public let partial: Bool

            private enum CodingKeys: String, CodingKey { case n, partial }

            public init(n: Int, partial: Bool = false) {
                self.n = n
                self.partial = partial
            }

            public init(from decoder: Decoder) throws {
                if let n = try? decoder.singleValueContainer().decode(Int.self) {
                    self.init(n: n)
                    return
                }
                let container = try decoder.container(keyedBy: CodingKeys.self)
                self.init(n: try container.decode(Int.self, forKey: .n), partial: try container.decodeIfPresent(Bool.self, forKey: .partial) ?? false)
            }
        }
    }

    public enum Searched: Sendable, Equatable {
        case answer(SearchAnswer)
        case building([String])
    }

    public struct CountQuery: Sendable, Equatable {
        public var of: String
        public var person: [String]
        public var from: String?
        public var to: String?

        public init(of: String, person: [String] = [], from: String? = nil, to: String? = nil) {
            self.of = of
            self.person = person
            self.from = from
            self.to = to
        }
    }

    public struct Counted: Decodable, Sendable, Equatable {
        public let asked: String
        public let population: Population
        public let total: Total?

        public var n: Int { total?.n ?? population.facts }

        public struct Population: Decodable, Sendable, Equatable {
            public let facts: Int
        }

        public struct Total: Decodable, Sendable, Equatable {
            public let n: Int
        }
    }

    public enum Opens: Codable, Sendable, Equatable, Hashable {
        case days(day: String, focus: String?)
        case people(String, person: String? = nil, group: String? = nil)
        case places(String)
        case read

        private enum CodingKeys: String, CodingKey { case page, day, focus, id, person, group }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            switch try container.decode(String.self, forKey: .page) {
            case "days":
                self = .days(day: try container.decode(String.self, forKey: .day), focus: try container.decodeIfPresent(String.self, forKey: .focus))
            case "people":
                self = .people(try container.decode(String.self, forKey: .id), person: try container.decodeIfPresent(String.self, forKey: .person),
                               group: try container.decodeIfPresent(String.self, forKey: .group))
            case "places": self = .places(try container.decode(String.self, forKey: .id))
            case "read": self = .read
            case let page: throw DecodingError.dataCorruptedError(forKey: .page, in: container, debugDescription: "no page \(page)")
            }
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            switch self {
            case .days(let day, let focus):
                try container.encode("days", forKey: .page)
                try container.encode(day, forKey: .day)
                try container.encodeIfPresent(focus, forKey: .focus)
            case .people(let id, let person, let group):
                try container.encode("people", forKey: .page)
                try container.encode(id, forKey: .id)
                try container.encodeIfPresent(person, forKey: .person)
                try container.encodeIfPresent(group, forKey: .group)
            case .places(let id):
                try container.encode("places", forKey: .page)
                try container.encode(id, forKey: .id)
            case .read:
                try container.encode("read", forKey: .page)
            }
        }
    }

    public struct Citation: Decodable, Sendable, Equatable {
        public enum Kind: String, Decodable, Sendable {
            case record, message, turn, line, photo, window, row, person, chat, place, gone, other

            public init(from decoder: Decoder) throws {
                self = Kind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
            }
        }

        public let ref: String
        public let kind: Kind
        public let opens: Opens?
        public let day: String?
        public let at: String?
        public let title: String?
        public let chat: String?
        public let chatTitle: String?
        public let image: String?
        public let app: String?
        public let asked: String?
        public let n: Int?
        public let name: String?
        public let why: String?
        public let voice: Voice?

        public struct Voice: Decodable, Sendable, Equatable, Hashable {
            public let audio: String
            public let record: String
            public let seconds: Int?
            public let from: String?
            public let mine: Bool

            public init(audio: String, record: String, seconds: Int? = nil, from: String? = nil, mine: Bool = false) {
                self.audio = audio
                self.record = record
                self.seconds = seconds
                self.from = from
                self.mine = mine
            }

            private enum CodingKeys: String, CodingKey { case audio, record, seconds, from, mine }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                audio = try container.decode(String.self, forKey: .audio)
                record = try container.decode(String.self, forKey: .record)
                seconds = try container.decodeIfPresent(Int.self, forKey: .seconds)
                from = try container.decodeIfPresent(String.self, forKey: .from)
                mine = try container.decodeIfPresent(Bool.self, forKey: .mine) ?? false
            }
        }

        public init(ref: String, kind: Kind, opens: Opens?, day: String? = nil, at: String? = nil, title: String? = nil,
                    chat: String? = nil, chatTitle: String? = nil, image: String? = nil, app: String? = nil,
                    asked: String? = nil, n: Int? = nil, name: String? = nil, why: String? = nil, voice: Voice? = nil) {
            self.ref = ref
            self.kind = kind
            self.opens = opens
            self.day = day
            self.at = at
            self.title = title
            self.chat = chat
            self.chatTitle = chatTitle
            self.image = image
            self.app = app
            self.asked = asked
            self.n = n
            self.name = name
            self.why = why
            self.voice = voice
        }

        enum CodingKeys: String, CodingKey {
            case ref, kind, opens, day, at, title, chat, image, app, asked, n, name, why, voice
            case chatTitle = "chat_title"
        }

        public var words: String? { title ?? name ?? asked ?? why }
    }

    public struct Described: Decodable, Sendable, Equatable {
        public let described: [Citation]
        public let unopened: [String]?

        private enum CodingKeys: String, CodingKey { case described, unopened }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            described = try container.decode([Decodes<Citation>].self, forKey: .described).compactMap(\.value)
            unopened = try container.decodeIfPresent([String].self, forKey: .unopened)
        }
    }

    struct Decodes<Value: Decodable>: Decodable {
        let value: Value?

        init(from decoder: Decoder) throws {
            value = try? Value(from: decoder)
        }
    }

    public enum Read {
        public enum Answer: Decodable, Sendable, Equatable {
            case row(Row)
            case gone

            private enum CodingKeys: String, CodingKey { case what }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let what = try container.decode(String.self, forKey: .what)
                switch what {
                case "row": self = .row(try Row(from: decoder))
                case "gone": self = .gone
                default: throw DecodingError.dataCorruptedError(forKey: .what, in: container, debugDescription: "no read opens \(what)")
                }
            }
        }

        public struct Row: Decodable, Sendable, Equatable {
            public let ref: String
            public let asked: String
            public let n: Int
            public let now: Int?
            public let columns: [String]
            public let rows: [[JSON]]
            public let pending: [Pending]?
            public let pendingMore: Int?
            public let next: String?

            enum CodingKeys: String, CodingKey {
                case ref, asked, n, now, columns, rows, pending, next
                case pendingMore = "pending_more"
            }
        }
    }


    public struct People: Codable, Sendable, Equatable {
        public var you: Person?
        public var people: [Person]
        public let chats: [Chat]

        enum CodingKeys: String, CodingKey {
            case you, people, chats
        }

        public struct Photos: Decodable, Sendable, Equatable {
            public let photos: [Photo]
            public let next: String?
            public let total: Int

            public struct Photo: Decodable, Sendable, Equatable, Hashable {
                public let image: String
                public let face: String
                public let box: [Double]
                public let atMs: Int64?

                public var blob: String { "sha256:" + image }

                enum CodingKeys: String, CodingKey {
                    case image, face, box
                    case atMs = "at_ms"
                }
            }
        }
    }

    public struct PersonPhoto: Codable, Sendable, Equatable, Hashable {
        public let crop: String?
        public let card: String?
    }

    public struct Person: Codable, Sendable, Equatable, Identifiable {
        public let id: String
        public var name: String
        public let callName: String?
        public let fullName: String?
        public let show: String?
        public let by: String?
        public let person: String?
        public let entity: String?
        public let entityBy: String?
        public let me: Bool?
        public let hidden: Bool?
        public let organised: Bool?
        public let handles: [Handle]
        public let networks: [String]
        public let chats: [ChatCount]
        public let received: Int
        public let sent: Int
        public let firstMs: Int64?
        public let lastMs: Int64?
        public let last30: Int
        public let daysCount: Int
        public let lastDay: Int?
        public let days: [String: Int]?
        public let photo: PersonPhoto?
        public var relationship: String?
        public let work: String?
        public var details: Details?
        public let suggestions: [Suggestion]?
        public let namesSeen: [String]?
        public let record: JSON?
        public let alsoCalled: [AlsoCalled]
        public let suggested: Int?
        public let joined: [Joined]
        public let counting: Bool?

        enum CodingKeys: String, CodingKey {
            case id, name, show, by, person, entity, me, hidden, organised, handles, networks, chats, received, sent, days, photo,
                 relationship, work, details, suggestions, record, suggested, joined, counting
            case alsoCalled = "also_called"
            case callName = "call_name"
            case fullName = "full_name"
            case namesSeen = "names_seen"
            case entityBy = "entity_by"
            case firstMs = "first_ms"
            case lastMs = "last_ms"
            case last30 = "last_30"
            case daysCount = "days_count"
            case lastDay = "last_day"
        }

        public var entityIsYours: Bool { entityBy == "you" }

        public struct AlsoCalled: Codable, Sendable, Equatable, Hashable {
            public let name: String
            public let from: String

            public init(name: String, from: String) {
                self.name = name
                self.from = from
            }
        }

        public struct Joined: Codable, Sendable, Equatable, Hashable, Identifiable {
            public let id: String
            public let name: String
            public let photo: PersonPhoto?
            public let handles: [String]
            public let with: [String]

            public init(id: String, name: String, photo: PersonPhoto?, handles: [String], with: [String]) {
                self.id = id
                self.name = name
                self.photo = photo
                self.handles = handles
                self.with = with
            }
        }

        public struct ChatCount: Codable, Sendable, Equatable, Hashable {
            public let key: String
            public let count: Int
        }

        public struct Handle: Codable, Sendable, Equatable, Hashable {
            public let id: String
            public let kind: String
            public let network: String?
            public let words: String
            public let from: String?
            public let own: Bool

            public init(id: String, kind: String, network: String?, words: String, from: String?, own: Bool = false) {
                self.id = id
                self.kind = kind
                self.network = network
                self.words = words
                self.from = from
                self.own = own
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                id = try container.decode(String.self, forKey: .id)
                kind = try container.decode(String.self, forKey: .kind)
                network = try container.decodeIfPresent(String.self, forKey: .network)
                words = try container.decode(String.self, forKey: .words)
                from = try container.decodeIfPresent(String.self, forKey: .from)
                own = try container.decodeIfPresent(Bool.self, forKey: .own) ?? false
            }

            public func encode(to encoder: Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(id, forKey: .id)
                try container.encode(kind, forKey: .kind)
                try container.encode(network, forKey: .network)
                try container.encode(words, forKey: .words)
                try container.encode(from, forKey: .from)
                try container.encode(own, forKey: .own)
            }

            enum CodingKeys: String, CodingKey { case id, kind, network, words, from, own }
        }

        public struct Suggestion: Codable, Sendable, Equatable, Hashable, Identifiable {
            public let id: String
            public let kind: String
            public let value: String
            public let reasons: [String: Double]
            public let ticked: Bool

            public init(id: String, kind: String, value: String, reasons: [String: Double] = [:], ticked: Bool = false) {
                self.id = id
                self.kind = kind
                self.value = value
                self.reasons = reasons
                self.ticked = ticked
            }

            public func reason(_ name: String) -> Int { Int(reasons[name] ?? 0) }
        }

        public struct Details: Codable, Sendable, Equatable, Hashable {
            public let work: String?
            public let birthday: Birthday?
            public let profiles: [Profile]

            public init(work: String?, birthday: Birthday?, profiles: [Profile]) {
                self.work = work
                self.birthday = birthday
                self.profiles = profiles
            }

            public static let none = Details(work: nil, birthday: nil, profiles: [])

            public struct Birthday: Codable, Sendable, Equatable, Hashable {
                public let month: Int
                public let day: Int
                public let year: Int?

                public init(month: Int, day: Int, year: Int?) {
                    self.month = month
                    self.day = day
                    self.year = year
                }
            }

            public struct Profile: Codable, Sendable, Equatable, Hashable {
                public let network: String
                public let value: String

                public init(network: String, value: String) {
                    self.network = network
                    self.value = value
                }
            }
        }
    }

    public struct Chat: Codable, Sendable, Equatable, Identifiable {
        public let key: String
        public let network: String
        public let chat: String
        public let group: Bool
        public let label: String?
        public let total: Int
        public let mine: Int
        public let firstMs: Int64?
        public let lastMs: Int64?
        public let quiet: Quiet?
        public let word: Bool?

        public var id: String { key }

        enum CodingKeys: String, CodingKey {
            case key, network, chat, group, label, total, mine, quiet, word
            case firstMs = "first_ms"
            case lastMs = "last_ms"
        }

        public struct Quiet: Codable, Sendable, Equatable, Hashable {
            public let why: String
            public let lastDay: String?

            enum CodingKeys: String, CodingKey {
                case why
                case lastDay = "last_day"
            }
        }
    }


    public struct Place: Codable, Sendable, Equatable, Identifiable {
        public let slug: String
        public let name: String
        public let latitude: Double
        public let longitude: Double
        public let radiusM: Double
        public let also: [Circle]
        public let ids: [String]
        public let home: Bool?
        public let area: Where.Area
        public let days: Int
        public let hours: Double
        public let firstMs: Int64?
        public let lastMs: Int64?
        public let visitsCount: Int
        public let nights: Int
        public let here: Bool
        public let partOf: Ref?
        public let inside: [Ref]
        public let askHome: String?
        public let rhythm: String?
        public let visits: [Visit]
        public let photos: [PlacePhoto]
        public let photosCount: Int
        public let people: [Present]
        public let counting: Bool?

        public var id: String { slug }

        enum CodingKeys: String, CodingKey {
            case slug, name, latitude, longitude, also, ids, home, area, days, hours, nights, here, inside, rhythm, visits, photos, people,
                 counting
            case radiusM = "radius_m"
            case firstMs = "first_ms"
            case lastMs = "last_ms"
            case visitsCount = "visits_count"
            case partOf = "part_of"
            case askHome = "ask_home"
            case photosCount = "photos_count"
        }

        public struct Circle: Codable, Sendable, Equatable, Hashable {
            public let latitude: Double
            public let longitude: Double
            public let radiusM: Double

            public init(latitude: Double, longitude: Double, radiusM: Double) {
                self.latitude = latitude
                self.longitude = longitude
                self.radiusM = radiusM
            }

            var members: [String: Any] { ["latitude": latitude, "longitude": longitude, "radius_m": radiusM] }

            enum CodingKeys: String, CodingKey {
                case latitude, longitude
                case radiusM = "radius_m"
            }
        }

        public struct Ref: Codable, Sendable, Equatable, Hashable {
            public let slug: String
            public let name: String
        }

        public struct Visit: Codable, Sendable, Equatable, Identifiable {
            public let unit: String
            public let startMs: Int64
            public let endMs: Int64
            public let day: String
            public let focus: String
            public let people: [String]
            public let centre: Centre?

            public var id: String { "\(unit) \(startMs) \(endMs)" }

            public struct Centre: Codable, Sendable, Equatable, Hashable {
                public let latitude: Double
                public let longitude: Double
            }

            enum CodingKeys: String, CodingKey {
                case unit, day, focus, people, centre
                case startMs = "start_ms"
                case endMs = "end_ms"
            }
        }

        public struct Present: Codable, Sendable, Equatable, Identifiable {
            public let id: String
            public let name: String
            public let days: Int
            public let photo: PersonPhoto?
        }
    }

    public struct PlacePhoto: Codable, Sendable, Equatable, Hashable {
        public let image: String
        public let atMs: Int64

        public var blob: String { "sha256:" + image }

        enum CodingKeys: String, CodingKey {
            case image
            case atMs = "at_ms"
        }
    }

    public struct PlacePhotos: Decodable, Sendable, Equatable {
        public let photos: [PlacePhoto]
        public let next: String?
        public let counting: Bool?
    }

    public struct Photo: Decodable, Sendable, Equatable {
        public let hash: String
        public let kind: String
        public let play: Play?
        public let atMs: Int64?
        public let unit: String?
        public let day: String?
        public let focus: String?
        public let caption: String?
        public let described: Made?
        public let people: [Person]
        public let size: Size?
        public let place: Place?
        public let area: Area?
        public let camera: Camera?
        public let from: String?
        public let chat: Chat?

        enum CodingKeys: String, CodingKey {
            case hash, kind, play, unit, day, focus, caption, described, people, size, place, area, camera, from, chat
            case atMs = "at_ms"
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            hash = try container.decode(String.self, forKey: .hash)
            kind = try container.decode(String.self, forKey: .kind)
            play = try container.decode(Play?.self, forKey: .play)
            atMs = try container.decodeIfPresent(Int64.self, forKey: .atMs)
            unit = try container.decodeIfPresent(String.self, forKey: .unit)
            day = try container.decodeIfPresent(String.self, forKey: .day)
            focus = try container.decodeIfPresent(String.self, forKey: .focus)
            caption = try container.decodeIfPresent(String.self, forKey: .caption)
            described = try container.decodeIfPresent(Made.self, forKey: .described)
            people = try container.decode([Person].self, forKey: .people)
            size = try container.decodeIfPresent(Size.self, forKey: .size)
            place = try container.decodeIfPresent(Place.self, forKey: .place)
            area = try container.decodeIfPresent(Area.self, forKey: .area)
            camera = try container.decodeIfPresent(Camera.self, forKey: .camera)
            from = try container.decodeIfPresent(String.self, forKey: .from)
            chat = try container.decodeIfPresent(Chat.self, forKey: .chat)
        }

        public struct Play: Decodable, Sendable, Equatable, Hashable {
            public let hash: String
            public let mediaType: String
            public let live: Bool

            public init(hash: String, mediaType: String, live: Bool) {
                self.hash = hash
                self.mediaType = mediaType
                self.live = live
            }

            enum CodingKeys: String, CodingKey {
                case hash, live
                case mediaType = "media_type"
            }
        }

        public struct Person: Decodable, Sendable, Equatable, Hashable, Identifiable {
            public let id: String
            public let name: String
            public let me: Bool
            public let box: [Double]?
            public let photo: PersonPhoto?
        }

        public struct Size: Decodable, Sendable, Equatable, Hashable {
            public let width: Double
            public let height: Double
        }

        public struct Place: Decodable, Sendable, Equatable, Hashable {
            public let slug: String
            public let name: String
            public let latitude: Double
            public let longitude: Double
            public let radiusM: Double
            public let area: Area

            enum CodingKeys: String, CodingKey {
                case slug, name, latitude, longitude, area
                case radiusM = "radius_m"
            }
        }

        public struct Area: Decodable, Sendable, Equatable, Hashable {
            public let city: String?
            public let region: String?
            public let country: String?
        }

        public struct Camera: Decodable, Sendable, Equatable, Hashable {
            public let id: String
            public let name: String
            public let mine: Bool
        }

        public struct Chat: Decodable, Sendable, Equatable, Hashable {
            public let network: String
            public let chat: String
            public let title: String
            public let group: Bool
            public let sender: Sender?
            public let mine: Bool
            public let atMs: Int64
            public let day: String
            public let record: DayFile.RecordRef
            public let focus: String

            enum CodingKeys: String, CodingKey {
                case network, chat, title, group, sender, mine, day, record, focus
                case atMs = "at_ms"
            }

            public struct Sender: Decodable, Sendable, Equatable, Hashable {
                public let id: String
                public let name: String
            }
        }
    }

    public struct Made: Codable, Sendable, Equatable {
        public let by: String?
        public let atMs: Int64?
        public let state: State
        public let line: String?
        public let ask: Ask?
        public let choose: [Connector.Member.Step]

        public init(by: String?, atMs: Int64?, state: State, line: String?, ask: Ask?, choose: [Connector.Member.Step]) {
            self.by = by
            self.atMs = atMs
            self.state = state
            self.line = line
            self.ask = ask
            self.choose = choose
        }

        enum CodingKeys: String, CodingKey {
            case by, state, line, ask, choose
            case atMs = "at_ms"
        }

        public enum State: String, Codable, Sendable, Equatable {
            case done, off, needs, waiting, failed
        }

        public struct Ask: Codable, Sendable, Equatable {
            public let family: String
            public let item: String
            public let prompt: String

            public init(family: String, item: String, prompt: String) {
                self.family = family
                self.item = item
                self.prompt = prompt
            }
        }
    }

    public struct Suggestion: Decodable, Sendable, Equatable, Hashable {
        public let name: String
        public let id: String?
        public let slug: String?
        public let distanceM: Double?
        public let why: Why?

        public init(name: String, id: String? = nil, slug: String? = nil, distanceM: Double?, why: Why? = nil) {
            self.name = name
            self.id = id
            self.slug = slug
            self.distanceM = distanceM
            self.why = why
        }

        enum CodingKeys: String, CodingKey {
            case name, id, slug, why
            case distanceM = "distance_m"
        }

        public struct Why: Decodable, Sendable, Equatable, Hashable {
            public let product: String
            public let family: String?
            public let atMs: Int64
            public let tier: Int

            public init(product: String, family: String?, atMs: Int64, tier: Int) {
                self.product = product
                self.family = family
                self.atMs = atMs
                self.tier = tier
            }

            enum CodingKeys: String, CodingKey {
                case product, family, tier
                case atMs = "at_ms"
            }
        }
    }

    public struct Suggestions: Decodable, Sendable, Equatable {
        public let suggestions: [Suggestion]
        public let provider: Provider?

        public init(suggestions: [Suggestion], provider: Provider? = nil) {
            self.suggestions = suggestions
            self.provider = provider
        }

        public struct Provider: Decodable, Sendable, Equatable {
            public let name: String
            public let need: Need?

            public init(name: String, need: Need? = nil) {
                self.name = name
                self.need = need
            }

            public struct Need: Decodable, Sendable, Equatable {
                public let words: String
                public let act: Act

                public init(words: String, act: Act) {
                    self.words = words
                    self.act = act
                }

                public struct Act: Decodable, Sendable, Equatable {
                    public let `do`: String
                    public let label: String
                    public let connector: String
                    public let member: String

                    public init(do: String, label: String, connector: String, member: String) {
                        self.do = `do`
                        self.label = label
                        self.connector = connector
                        self.member = member
                    }
                }
            }
        }
    }

    public struct Spot: Decodable, Sendable, Equatable, Identifiable {
        public let latitude: Double
        public let longitude: Double
        public let stays: Int
        public let days: Int
        public let hours: Double
        public let firstMs: Int64?
        public let lastMs: Int64?
        public let worth: Bool
        public let area: Where.Area?
        public let askHome: String?
        public let key: String?
        public let witnessed: String?
        public let last: String?
        public let photos: [PlacePhoto]
        public let photosCount: Int

        public var id: String { "\(latitude),\(longitude)" }

        enum CodingKeys: String, CodingKey {
            case latitude, longitude, stays, days, hours, worth, area, key, witnessed, last, photos
            case firstMs = "first_ms"
            case lastMs = "last_ms"
            case askHome = "ask_home"
            case photosCount = "photos_count"
        }

        public init(from decoder: any Decoder) throws {
            let stated = try decoder.container(keyedBy: CodingKeys.self)
            latitude = try stated.decode(Double.self, forKey: .latitude)
            longitude = try stated.decode(Double.self, forKey: .longitude)
            stays = try stated.decodeIfPresent(Int.self, forKey: .stays) ?? 0
            days = try stated.decodeIfPresent(Int.self, forKey: .days) ?? 0
            hours = try stated.decodeIfPresent(Double.self, forKey: .hours) ?? 0
            firstMs = try stated.decodeIfPresent(Int64.self, forKey: .firstMs)
            lastMs = try stated.decodeIfPresent(Int64.self, forKey: .lastMs)
            worth = try stated.decodeIfPresent(Bool.self, forKey: .worth) ?? false
            area = try stated.decodeIfPresent(Where.Area.self, forKey: .area)
            askHome = try stated.decodeIfPresent(String.self, forKey: .askHome)
            key = try stated.decodeIfPresent(String.self, forKey: .key)
            witnessed = try stated.decodeIfPresent(String.self, forKey: .witnessed)
            last = try stated.decodeIfPresent(String.self, forKey: .last)
            photos = try stated.decodeIfPresent([PlacePhoto].self, forKey: .photos) ?? []
            photosCount = try stated.decodeIfPresent(Int.self, forKey: .photosCount) ?? 0
        }
    }

    public struct HiddenSpot: Decodable, Sendable, Equatable, Identifiable {
        public let key: String
        public let latitude: Double
        public let longitude: Double
        public let hiddenMs: Int64
        public let days: Int
        public let nearest: Nearest?
        public let counting: Bool?

        public var id: String { key }

        enum CodingKeys: String, CodingKey {
            case key, latitude, longitude, days, nearest, counting
            case hiddenMs = "hidden_ms"
        }

        public struct Nearest: Decodable, Sendable, Equatable, Hashable {
            public let name: String
            public let distanceM: Double

            enum CodingKeys: String, CodingKey {
                case name
                case distanceM = "distance_m"
            }
        }
    }

    public struct StreamsReport: Decodable, Sendable, Equatable {
        public let atMs: Int64
        public let day: String
        public let needs: [Need]
        public let disk: Disk
        public let paused: [PauseState]
        public let home: HomeRow
        public let devices: [DeviceRow]
        public let `extension`: ExtensionRow
        public let connectors: [Connector]
        public let setup: Setup?
        public let off: [String]
        public let imports: [Import]
        public let products: String?
        public let adding: Adding

        enum CodingKeys: String, CodingKey {
            case day, needs, disk, paused, home, devices, `extension`, connectors, setup, off, imports, products, adding
            case atMs = "at_ms"
        }

        public struct Adding: Decodable, Sendable, Equatable {
            public let prompt: String
            public let blank: String
        }

        public struct Disk: Decodable, Sendable, Equatable {
            public let freeBytes: Int64
            public let maxBundleBytes: Int64

            enum CodingKeys: String, CodingKey {
                case freeBytes = "free_bytes"
                case maxBundleBytes = "max_bundle_bytes"
            }
        }

        public struct PauseState: Decodable, Sendable, Equatable {
            public let target: String
            public let by: String
            public let reason: String
            public let atMs: Int64
            public let holds: [String]?
            public let title: String
            public let line: String

            enum CodingKeys: String, CodingKey {
                case target, by, reason, holds, title, line
                case atMs = "at_ms"
            }
        }

        public struct HomeRow: Decodable, Sendable, Equatable {
            public let name: String
            public let health: Health
        }

        public struct ExtensionRow: Decodable, Sendable, Equatable {
            public let name: String
            public let health: Health
            public let placed: Bool
            public let present: Bool
            public let browsers: [String]
        }

        public struct Setup: Decodable, Sendable, Equatable {
            public let skipped: [String]
            public let at: String?
        }
    }

    public enum State: String, Decodable, Sendable, Equatable, CaseIterable {
        case off, setup, paused
        case needsYou = "needs-you"
        case broken, waiting, quiet, syncing, ok
    }

    public enum Reason: String, Decodable, Sendable, Equatable, CaseIterable {
        case form, signIn = "sign-in", choose, app, grant, pair, export, install
        case signedOut = "signed-out", otherAccount = "other-account", confirm, password, `extension`
        case offline, metered, chrome, providerLimit = "provider-limit", providerMaking = "provider-making", disk, power, vault, retrying
        case failing, `import`, providerChanged = "provider-changed", missingFile = "missing-file"
        case nothingNew = "nothing-new", device
    }

    public enum Road: String, Decodable, Sendable, Equatable, Hashable, CaseIterable {
        case poll, chrome, mac, phone, upload, owner, label
    }

    public enum Requirement: String, Decodable, Sendable, Equatable, CaseIterable {
        case form, signIn = "sign-in", choose, app, grant, pair, export, install
    }

    public struct Health: Decodable, Sendable, Equatable {
        public let state: State
        public let reason: Reason?
        public let words: String
        public let sinceMs: Int64?
        public let nextMs: Int64?
        public let acts: [Act]
        public let detail: String?
        public let line: String?

        enum CodingKeys: String, CodingKey {
            case state, reason, words, acts, detail, line
            case sinceMs = "since_ms"
            case nextMs = "next_ms"
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            state = try container.decode(State.self, forKey: .state)
            reason = try container.decode(Reason?.self, forKey: .reason)
            words = try container.decode(String.self, forKey: .words)
            sinceMs = try container.decode(Int64?.self, forKey: .sinceMs)
            nextMs = try container.decode(Int64?.self, forKey: .nextMs)
            acts = try Act.known(container, .acts)
            detail = try container.decode(String?.self, forKey: .detail)
            line = try container.decodeIfPresent(String.self, forKey: .line)
        }
    }

    public struct Act: Decodable, Sendable, Equatable, Hashable {
        public enum Do: String, Decodable, Sendable, Equatable, Hashable {
            case `try`, skip, read, ignore, turn, signin, set, grant, open, copy, pair, `extension`, upload, install, storage, browser, vault, verify, refresh, report
            case letGo = "let-go"
            case `import`
        }

        public let `do`: Do
        public let label: String
        public let need: String?
        public let of: String?
        public let ids: [String]?
        public let member: String?
        public let unit: String?
        public let grant: String?
        public let url: String?
        public let kind: String?
        public let text: String?

        enum CodingKeys: String, CodingKey { case `do`, label, need, of, ids, member, unit, grant, url, kind, text }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let what = try container.decode(Do.self, forKey: .do)
            func carried<Value: Decodable>(_ key: CodingKeys, by: Set<Do>) throws -> Value? {
                by.contains(what) ? try container.decode(Value.self, forKey: key) : nil
            }
            `do` = what
            label = try container.decode(String.self, forKey: .label)
            need = try carried(.need, by: [.try, .skip, .read, .ignore, .letGo])
            of = try carried(.of, by: [.read, .ignore, .signin, .browser, .refresh, .report])
            ids = try carried(.ids, by: [.turn])
            member = try carried(.member, by: [.set])
            unit = try carried(.unit, by: [.grant])
            grant = try carried(.grant, by: [.grant])
            url = try carried(.url, by: [.open])
            kind = try carried(.kind, by: [.import])
            text = try carried(.text, by: [.copy])
        }

        struct Known: Decodable {
            let act: Act?

            init(from decoder: Decoder) throws {
                let what = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .do)
                act = Do(rawValue: what) == nil ? nil : try Act(from: decoder)
            }
        }

        static func known<Key: CodingKey>(_ container: KeyedDecodingContainer<Key>, _ key: Key) throws -> [Act] {
            try container.decode([Known].self, forKey: key).compactMap(\.act)
        }
    }

    public enum Weight: String, Decodable, Sendable, Equatable {
        case stopped, advice
    }

    public struct Need: Decodable, Sendable, Equatable, Identifiable {
        public let id: String
        public let state: State
        public let reason: Reason?
        public let words: String
        public let sinceMs: Int64?
        public let nextMs: Int64?
        public let acts: [Act]
        public let detail: String?
        public let line: String?
        public let connector: String?
        public let streams: [String]?
        public let copy: String?
        public let unit: String?
        public let at: At?
        public let weight: Weight
        public let banner: Bool
        public let dismissed: Bool
        public let kind: String
        public let about: String?

        enum CodingKeys: String, CodingKey {
            case id, state, reason, words, acts, detail, line, connector, streams, copy, unit, at, weight, banner, dismissed, kind, about
            case sinceMs = "since_ms"
            case nextMs = "next_ms"
        }

        public struct At: Decodable, Sendable, Equatable {
            public let site: String
            public let open: String?
            public let errand: String?

            enum CodingKeys: String, CodingKey { case site, open, errand }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                site = try container.decode(String.self, forKey: .site)
                open = try container.decode(String?.self, forKey: .open)
                errand = try container.decode(String?.self, forKey: .errand)
            }
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            state = try container.decode(State.self, forKey: .state)
            reason = try container.decode(Reason?.self, forKey: .reason)
            words = try container.decode(String.self, forKey: .words)
            sinceMs = try container.decode(Int64?.self, forKey: .sinceMs)
            nextMs = try container.decode(Int64?.self, forKey: .nextMs)
            acts = try Act.known(container, .acts)
            detail = try container.decode(String?.self, forKey: .detail)
            line = try container.decodeIfPresent(String.self, forKey: .line)
            connector = try container.decode(String?.self, forKey: .connector)
            streams = try container.decodeIfPresent([String].self, forKey: .streams)
            copy = try container.decode(String?.self, forKey: .copy)
            unit = try container.decode(String?.self, forKey: .unit)
            at = try container.decode(At?.self, forKey: .at)
            weight = try container.decode(Weight.self, forKey: .weight)
            banner = try container.decode(Bool.self, forKey: .banner)
            dismissed = try container.decode(Bool.self, forKey: .dismissed)
            kind = try container.decode(String.self, forKey: .kind)
            about = try container.decode(String?.self, forKey: .about)
        }
    }

    public struct DeviceRow: Decodable, Sendable, Equatable, Identifiable {
        public enum Kind: String, Decodable, Sendable, Equatable {
            case mac, phone
        }

        public let unit: String
        public let kind: Kind
        public let name: String
        public let health: Health
        public let contactMs: Int64?
        public let grants: [String: String]?
        public let found: [String]?
        public let pass: String?
        public let replaced: [String]
        public let retired: Bool
        public let streams: [Stream]

        public var id: String { unit }

        public struct Stream: Decodable, Sendable, Equatable {
            public let id: String
            public let line: String
        }

        enum CodingKeys: String, CodingKey {
            case unit, kind, name, health, grants, found, pass, replaced, retired, streams
            case contactMs = "contact_ms"
        }
    }

    public struct Connector: Decodable, Sendable, Equatable, Identifiable {
        public let id: String
        public let type: Kind?
        public let icon: String
        public let name: String
        public let product: String
        public let noun: [String]?
        public let starter: Bool
        public let roads: [Road]
        public let shown: Shown?
        public let records: String
        public let gives: String
        public let `where`: String?
        public let before: [String]
        public let sensor: Bool
        public let phoneScreen: Int?
        public let recorder: Bool
        public let macGrants: [String]
        public let macCopy: String?

        public let health: Health
        public let line: String
        public let lead: String?
        public let figure: Figure?
        public let history: History?
        public let backfillAbout: String?
        public let processing: Processing?

        public let copies: [Copy]
        public let account: Account?
        public let export: Export?
        public let ways: [Way]
        public let setUp: Bool
        public let pauses: [StreamPause]
        public let on: Bool

        public let members: [Member]
        public let routes: [Route]
        public let route: String?
        public let refreshNow: RefreshNow?

        public let origin: String?
        public let origins: [String]?
        public let browser: Browser?
        public let signedIn: Bool?
        public let allowed: Bool?
        public let chromeAccount: ChromeAccount?
        public let chosen: Bool?
        public let checking: Bool?
        public let choosing: String?

        public let quiet: Int?
        public let joins: Joins?

        public struct Joins: Decodable, Sendable, Equatable, Hashable {
            public let name: String
            public let icon: String
            public let gives: String
            public let apps: [String]
        }

        enum CodingKeys: String, CodingKey {
            case id, type, icon, name, product, noun, starter, roads, shown, records, gives, `where`, before, sensor, recorder
            case health, line, lead, figure, history, copies, account, export, ways, pauses, on, members, routes, route
            case origin, origins, browser, allowed, chosen, checking, choosing, quiet, processing, joins
            case setUp = "set_up"
            case refreshNow = "refresh_now"
            case backfillAbout = "backfill_about"
            case signedIn = "signed_in"
            case chromeAccount = "chrome_account"
            case phoneScreen = "phone_screen"
            case macGrants = "mac_grants"
            case macCopy = "mac_copy"
        }

        public func paused(_ scope: StreamPause.Scope) -> StreamPause? {
            pauses.first { $0.scope == scope }
        }

        public enum Shown: String, Decodable, Sendable, Equatable {
            case stream, home
        }

        public struct Kind: Decodable, Sendable, Equatable, Hashable {
            public let key: String
            public let name: String
            public let icon: String
        }

        public struct Figure: Decodable, Sendable, Equatable {
            public let today: Int?
            public let week: [Int]?
            public let checkedMs: Int64?
            public let words: String
            public let lastMs: Int64?
            public let last: String?

            enum CodingKeys: String, CodingKey {
                case today, week, words, last
                case checkedMs = "checked_ms"
                case lastMs = "last_ms"
            }
        }

        public struct History: Decodable, Sendable, Equatable {
            public enum State: String, Decodable, Sendable, Equatable {
                case syncing, done
            }

            public let state: State
            public let backToMs: Int64?
            public let left: Int?
            public let unit: [String]?
            public let etaMs: Int64?
            public let done: Int?
            public let total: Int?
            public let progress: String?
            public let words: String
            public let arriving: String
            public let start: Start?

            public struct Start: Decodable, Sendable, Equatable {
                public let day: String?
                public let own: Bool
            }

            enum CodingKeys: String, CodingKey {
                case state, left, unit, done, total, progress, words, arriving, start
                case backToMs = "back_to_ms"
                case etaMs = "eta_ms"
            }
        }

        public struct Processing: Decodable, Sendable, Equatable {
            public let rows: [Row]

            public struct Row: Decodable, Sendable, Equatable {
                public let member: String
                public let shape: Shape?
                public let line: String?
                public let privacy: Privacy?
            }

            public struct Privacy: Decodable, Sendable, Equatable {
                public let member: String
                public let value: String
                public let words: String
                public let steps: [Member.Step]
                public let note: String
                public let waiting: Bool
            }

            public enum Shape: String, Decodable, Sendable, Equatable {
                case off, needs, waiting, running, done
            }
        }

        public struct Copy: Decodable, Sendable, Equatable, Identifiable {
            public let id: String
            public let name: String
            public let road: Road
            public let unit: String?
            public let on: Bool
            public let retired: Bool
            public let health: Health
            public let held: Int?
            public let newestMs: Int64?
            public let oldestMs: Int64?
            public let line: String
            public let store: StoreState?

            enum CodingKeys: String, CodingKey {
                case id, name, road, unit, on, retired, health, held, line, store
                case newestMs = "newest_ms"
                case oldestMs = "oldest_ms"
            }
        }

        public struct Way: Decodable, Sendable, Equatable {
            public let road: Road
            public let ready: Bool
            public let requirements: [Requirement]

            public struct Requirement: Decodable, Sendable, Equatable {
                public let kind: HomeLink.Requirement
                public let met: Bool
                public let words: String
                public let line: String?
                public let act: Act?

                enum CodingKeys: String, CodingKey { case kind, met, words, line, act }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: CodingKeys.self)
                    kind = try container.decode(HomeLink.Requirement.self, forKey: .kind)
                    met = try container.decode(Bool.self, forKey: .met)
                    words = try container.decode(String.self, forKey: .words)
                    line = try container.decode(String?.self, forKey: .line)
                    act = try container.decode(Act.Known?.self, forKey: .act)?.act
                }
            }
        }

        public struct StreamPause: Decodable, Sendable, Equatable {
            public enum Scope: String, Decodable, Sendable, Equatable {
                case all, history
            }

            public let scope: Scope
            public let by: String
            public let reason: String
            public let atMs: Int64

            enum CodingKeys: String, CodingKey {
                case scope, by, reason
                case atMs = "at_ms"
            }
        }

        public struct Account: Decodable, Sendable, Equatable {
            public let name: String
            public let line: String
            public let copy: String?
        }

        public struct Export: Decodable, Sendable, Equatable {
            public let `import`: String
            public let name: String
            public let icon: String
            public let opens: Bool
            public let line: String
        }

        public enum Panel: String, Decodable, Sendable, Equatable {
            case settings, groups, backfill, account, export
            case comesFrom = "comes-from"
        }

        public struct Member: Decodable, Sendable, Equatable, Identifiable {
            public let key: String
            public let kind: String
            public let label: String
            public let about: String?
            public let value: JSON?
            public let words: String
            public let from: String
            public let `default`: JSON?
            public let steps: [Step]?
            public let panel: Panel?
            public let control: Control?
            public let `where`: Where?
            public let min: Double?
            public let max: Double?
            public let secret: String?
            public let held: Bool?
            public let folder: Bool?
            public let items: String?
            public let add: String?
            public let placeholder: String?
            public let waiting: [Waiting]?
            public let only: String?
            public let route: String?
            public let menu: Pages.ModelMenu?

            enum CodingKeys: String, CodingKey {
                case key, kind, label, about, value, words, from, `default`, steps, panel, control, `where`, min, max, secret, held, folder, items, add, placeholder, waiting, only, route, menu
            }

            public var id: String { key }

            public enum Control: String, Decodable, Sendable, Equatable, CaseIterable {
                case menu, zone, toggle, stepper, path, list, text, email, date, secret
            }

            public struct Where: Decodable, Sendable, Equatable {
                public let unit: String
                public let name: String
            }

            public struct Step: Codable, Sendable, Equatable {
                public let value: String
                public let words: String
                public let note: String?

                public init(value: String, words: String, note: String?) {
                    self.value = value
                    self.words = words
                    self.note = note
                }

                public func encode(to encoder: Encoder) throws {
                    var container = encoder.container(keyedBy: CodingKeys.self)
                    try container.encode(value, forKey: .value)
                    try container.encode(words, forKey: .words)
                    try container.encode(note, forKey: .note)
                }
            }

            public struct Waiting: Decodable, Sendable, Equatable {
                public let name: String
                public let kind: String
                public let line: String
            }
        }

        public struct Route: Decodable, Sendable, Equatable {
            public let id: String
            public let acquirer: String
            public let way: String
            public let label: String
            public let about: String?
            public let steps: [Import.Step]
            public let note: String?
            public let fields: [String]
            public let sets: [String]
            public let client: Client?

            public struct Client: Decodable, Sendable, Equatable {
                public let id: String
                public let name: String
                public let held: Bool
                public let before: [String]
            }
        }

        public struct RefreshNow: Decodable, Sendable, Equatable {
            public let act: Act
            public let blocked: RefreshBlocked?
            public let asked: [Asked]

            public struct Asked: Decodable, Sendable, Equatable {
                public let unit: String
                public let name: String
            }
        }

        public struct Browser: Decodable, Sendable, Equatable {
            public let unit: String
            public let name: String
        }

        public struct ChromeAccount: Decodable, Sendable, Equatable {
            public let email: String?
            public let name: String?
            public let verdict: String
            public var words: String { email ?? name ?? "" }

            public init(email: String? = nil, name: String? = nil, verdict: String) {
                (self.email, self.name, self.verdict) = (email, name, verdict)
            }

            enum CodingKeys: String, CodingKey { case email, name, verdict }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let email = try container.decodeIfPresent(String.self, forKey: .email)
                let name = try container.decodeIfPresent(String.self, forKey: .name)
                guard (email == nil) != (name == nil) else {
                    throw DecodingError.dataCorruptedError(forKey: .email, in: container, debugDescription: "an account is named by its email or its name, one of the two")
                }
                self.init(email: email, name: name, verdict: try container.decode(String.self, forKey: .verdict))
            }
        }
    }

    public struct Import: Decodable, Sendable, Equatable, Identifiable {
        public let kind: String
        public let name: String
        public let icon: String
        public let takes: String
        public let wait: String?
        public let file: String
        public let reads: String?
        public let products: [Product]
        public let guide: [Step]
        public let recognise: [String]
        public let leaves: [String]
        public let root: String?
        public let lists: String?
        public let which: [Which]?
        public let drop: Drop
        public let titles: Titles
        public let health: Health
        public let line: String
        public let coming: [File]
        public let held: [Held]

        public var id: String { kind }

        public struct Product: Decodable, Sendable, Equatable {
            public let id: String
            public let name: String
        }

        public struct Which: Decodable, Sendable, Equatable {
            public let need: String
            public let words: String
            public let line: String
            public let imports: [String]
            public let choices: [Choice]
            public let choose: String

            public struct Choice: Decodable, Sendable, Equatable {
                public let unit: String
                public let words: String
                public let line: String
            }
        }

        public struct Step: Decodable, Sendable, Equatable {
            public let title: String?
            public let words: String
            public let open: Open?

            public struct Open: Decodable, Sendable, Equatable {
                public let label: String
                public let url: String
            }
        }

        public struct Drop: Decodable, Sendable, Equatable {
            public let words: String
            public let line: String
            public let choose: String
            public let away: String
        }

        public struct Titles: Decodable, Sendable, Equatable {
            public let reads: String
            public let guide: String
            public let held: String
        }

        public struct File: Decodable, Sendable, Equatable, Identifiable {
            public let id: String
            public let name: String
            public let bytes: Int64
            public let state: String
            public let words: String
            public let line: String
            public let acts: [Act]

            enum CodingKeys: String, CodingKey { case id, name, bytes, state, words, line, acts }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                id = try container.decode(String.self, forKey: .id)
                name = try container.decode(String.self, forKey: .name)
                bytes = try container.decode(Int64.self, forKey: .bytes)
                state = try container.decode(String.self, forKey: .state)
                words = try container.decode(String.self, forKey: .words)
                line = try container.decode(String.self, forKey: .line)
                acts = try Act.known(container, .acts)
            }
        }

        public struct Held: Decodable, Sendable, Equatable, Identifiable {
            public let id: String
            public let account: String?
            public let madeAt: String
            public let name: String
            public let health: Health
            public let line: String
            public let ask: Ask?
            public let files: [File]
            public let products: [Product]
            public let span: Span?
            public let openDay: String?
            public let open: String?
            public let downloaded: String?
            public let notice: Notice?

            enum CodingKeys: String, CodingKey {
                case id, account, name, health, line, ask, files, products, span, open, downloaded, notice
                case madeAt = "made_at"
                case openDay = "open_day"
            }

            public struct Ask: Decodable, Sendable, Equatable {
                public let words: String
                public let choices: [String]
                public let other: Bool
                public let choose: String
                public let another: String
            }

            public struct Notice: Decodable, Sendable, Equatable {
                public let title: String
                public let body: String
            }

            public struct Product: Decodable, Sendable, Equatable {
                public let id: String
                public let name: String
                public let state: String
                public let count: Int
                public let line: String
            }

            public struct Span: Decodable, Sendable, Equatable {
                public let from: String
                public let to: String
            }
        }
    }

    public struct Pause: Decodable, Sendable, Equatable {
        public let target: String
        public let reason: String
        public let atMs: Int64
        public let holds: [String]?

        enum CodingKeys: String, CodingKey {
            case target, reason, holds
            case atMs = "at_ms"
        }
    }


    public struct Status: Decodable, Sendable, Equatable {
        public let atMs: Int64
        public let day: String
        public let needs: [HomeLink.Need]
        public let today: [SourceToday]
        public let paused: [Pause]
        public let report: JSON

        enum CodingKeys: String, CodingKey {
            case day, needs, today, paused
            case atMs = "at_ms"
        }

        private struct Today: Decodable {
            let sources: [SourceToday]
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            atMs = try container.decode(Int64.self, forKey: .atMs)
            day = try container.decode(String.self, forKey: .day)
            needs = try container.decode([HomeLink.Need].self, forKey: .needs)
            today = try container.decode(Today.self, forKey: .today).sources
            paused = try container.decode([Pause].self, forKey: .paused)
            report = try JSON(from: decoder)
        }

        public struct SourceToday: Decodable, Sendable, Equatable {
            public let source: String
            public let deliveries: Int
            public let imports: Int
            public let counts: [String: Int]
            public let readThroughMs: Int64?

            enum CodingKeys: String, CodingKey {
                case source, deliveries, imports, counts
                case readThroughMs = "read_through_ms"
            }
        }
    }


    public struct PrivacyState: Decodable, Sendable, Equatable {
        public let epoch: Int
        public let ready: Bool
        public let line: String?
        public let detector: Detector
        public let marking: Marking?
        public let level: String
        public let chat: String
        public let levels: [String: [String]]
        public let links: String
        public let always: [String]
        public let never: [String]
        public let types: [Kind]
        public let today: [Total]
        public let voice: Voice?

        public struct Voice: Decodable, Sendable, Equatable {
            public let leaves: String?
        }

        public struct Detector: Decodable, Sendable, Equatable {
            public enum State: String, Decodable, Sendable { case off, absent, downloading, ready }

            public let runner: String
            public let file: String?
            public let state: State
            public let line: String?
            public let bytes: Int?
            public let total: Int?
            public let model: String?
        }

        public struct Marking: Decodable, Sendable, Equatable {
            public let marked: Int
            public let total: Int
            public let line: String
        }

        public struct Kind: Decodable, Sendable, Equatable {
            public let type: String
            public let one: String
            public let many: String
            public let subtypes: [Subtype]

            public struct Subtype: Decodable, Sendable, Equatable {
                public let type: String
                public let one: String
                public let many: String
            }
        }

        public struct Total: Decodable, Sendable, Equatable {
            public let receiver: String
            public let day: String
            public let items: Int
            public let hidden: Int
            public let counts: [String: Int]
            public let rows: [String: Int]
        }
    }

    public struct Outbound: Decodable, Sendable, Equatable, Identifiable {
        public let seq: Int
        public let atMs: Int64
        public let day: String
        public let receiver: String
        public let route: String?
        public let by: String?
        public let what: String
        public let tool: String?
        public let level: Level
        public let counts: [String: Int]
        public let chars: Int
        public let pictures: Int
        public let detector: String?
        public let key: String?
        public let attempt: Int?
        public let sent: Sent?
        public let about: String?

        public var id: Int { seq }

        enum CodingKeys: String, CodingKey {
            case seq, day, receiver, route, by, what, tool, level, counts, chars, pictures, detector, key, attempt, sent, about
            case atMs = "at_ms"
        }

        public enum Level: Decodable, Sendable, Equatable {
            case named(String)
            case types([String])

            public init(from decoder: Decoder) throws {
                let container = try decoder.singleValueContainer()
                if let types = try? container.decode([String].self) { self = .types(types) } else { self = .named(try container.decode(String.self)) }
            }
        }

        public struct Sent: Decodable, Sendable, Equatable {
            public let body: String
        }
    }

    struct Carried: Decodable {
        let rows: [Outbound]
    }


    public struct Record: Decodable, Sendable, Equatable {
        public let source: String
        public let kind: String
        public let key: String
        public let head: Head
        public let version: Version?
        public let blobs: [String]
        public let text: Text?
        public let transcribed: Made?
        public let open: Open?
        public internal(set) var body = Data()

        enum CodingKeys: String, CodingKey {
            case source, kind, key, head, version, blobs, text, transcribed, open
        }

        public struct Head: Decodable, Sendable, Equatable {
            public let version: String?
            public let statedMs: Int64?
            public let sinceMs: Int64?
            public let startMs: Int64?
            public let endMs: Int64?

            enum CodingKeys: String, CodingKey {
                case version
                case statedMs = "stated_ms"
                case sinceMs = "since_ms"
                case startMs = "start_ms"
                case endMs = "end_ms"
            }
        }

        public struct Version: Decodable, Sendable, Equatable {
            public let id: String
            public let content: JSON
            public let startMs: Int64?
            public let endMs: Int64?
            public let offsetMin: Int?
            public let precision: String?

            enum CodingKeys: String, CodingKey {
                case id, content, precision
                case startMs = "start_ms"
                case endMs = "end_ms"
                case offsetMin = "offset_min"
            }
        }

        public struct Text: Decodable, Sendable, Equatable {
            public let title: String?
            public let text: String
            public let who: [String]?
            public let link: String?
        }
    }


    public struct Camera: Decodable, Sendable, Equatable, Identifiable {
        public let camera: String
        public let make: String?
        public let model: String?
        public let photos: Int
        public let firstMs: Int64?
        public let lastMs: Int64?
        public let sample: String?
        public let phones: [String]
        public let word: Word?
        public let mine: Bool
        public let why: String

        public var id: String { camera }

        enum CodingKeys: String, CodingKey {
            case camera, make, model, photos, sample, phones, word, mine, why
            case firstMs = "first_ms"
            case lastMs = "last_ms"
        }

        public struct Word: Decodable, Sendable, Equatable {
            public let mine: Bool
            public let from: String?
            public let to: String?
        }
    }
}

extension HomeLink.Tagged: Equatable where Value: Equatable {}

extension HomeLink.Person {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        callName = try c.decodeIfPresent(String.self, forKey: .callName)
        fullName = try c.decodeIfPresent(String.self, forKey: .fullName)
        show = try c.decodeIfPresent(String.self, forKey: .show)
        by = try c.decodeIfPresent(String.self, forKey: .by)
        person = try c.decodeIfPresent(String.self, forKey: .person)
        entity = try c.decodeIfPresent(String.self, forKey: .entity)
        entityBy = try c.decodeIfPresent(String.self, forKey: .entityBy)
        me = try c.decodeIfPresent(Bool.self, forKey: .me)
        hidden = try c.decodeIfPresent(Bool.self, forKey: .hidden)
        organised = try c.decodeIfPresent(Bool.self, forKey: .organised)
        handles = try c.decodeIfPresent([Handle].self, forKey: .handles) ?? []
        networks = try c.decodeIfPresent([String].self, forKey: .networks) ?? []
        chats = try c.decodeIfPresent([ChatCount].self, forKey: .chats) ?? []
        received = try c.decodeIfPresent(Int.self, forKey: .received) ?? 0
        sent = try c.decodeIfPresent(Int.self, forKey: .sent) ?? 0
        firstMs = try c.decodeIfPresent(Int64.self, forKey: .firstMs)
        lastMs = try c.decodeIfPresent(Int64.self, forKey: .lastMs)
        last30 = try c.decodeIfPresent(Int.self, forKey: .last30) ?? 0
        daysCount = try c.decodeIfPresent(Int.self, forKey: .daysCount) ?? 0
        lastDay = try c.decodeIfPresent(Int.self, forKey: .lastDay)
        days = try c.decodeIfPresent([String: Int].self, forKey: .days)
        photo = try c.decodeIfPresent(HomeLink.PersonPhoto.self, forKey: .photo)
        relationship = try c.decodeIfPresent(String.self, forKey: .relationship)
        work = try c.decodeIfPresent(String.self, forKey: .work)
        details = try c.decodeIfPresent(Details.self, forKey: .details)
        suggestions = try c.decodeIfPresent([Suggestion].self, forKey: .suggestions)
        namesSeen = try c.decodeIfPresent([String].self, forKey: .namesSeen)
        record = try c.decodeIfPresent(HomeLink.JSON.self, forKey: .record)
        alsoCalled = try c.decodeIfPresent([AlsoCalled].self, forKey: .alsoCalled) ?? []
        suggested = try c.decodeIfPresent(Int.self, forKey: .suggested)
        joined = try c.decodeIfPresent([Joined].self, forKey: .joined) ?? []
        counting = try c.decodeIfPresent(Bool.self, forKey: .counting)
    }
}
