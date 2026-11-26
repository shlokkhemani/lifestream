import Foundation

extension HomeLink {
    public enum Pages {
        public struct People: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/people"

            public let position: String
            public let today: String
            public let you: Row?
            public let counts: Counts
            public let most: [Most]
            public let sections: [Section]
            public let ai: [Row]
            public let new: [New]
            public let businesses: Businesses?
            public let organise: Organise
            public let groups: Groups
            public let counting: Bool

            private enum Keys: String, CodingKey {
                case position
                case today
                case you
                case counts
                case most
                case sections
                case ai
                case new
                case businesses
                case organise
                case groups
                case counting
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.you = try container.decodeNil(forKey: .you) ? nil : container.decode(Row.self, forKey: .you)
                self.counts = try container.decode(Counts.self, forKey: .counts)
                self.most = try container.decode([Most].self, forKey: .most)
                self.sections = try container.decode([Section].self, forKey: .sections)
                self.ai = try container.decode([Row].self, forKey: .ai)
                self.new = try container.decode([New].self, forKey: .new)
                self.businesses = try container.decodeNil(forKey: .businesses) ? nil : container.decode(Businesses.self, forKey: .businesses)
                self.organise = try container.decode(Organise.self, forKey: .organise)
                self.groups = try container.decode(Groups.self, forKey: .groups)
                self.counting = try container.decode(Bool.self, forKey: .counting)
            }

            public struct Counts: Decodable, Sendable, Equatable {
                public let people: Int
                public let groups: Int

                private enum Keys: String, CodingKey {
                    case people
                    case groups
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.people = try container.decode(Int.self, forKey: .people)
                    self.groups = try container.decode(Int.self, forKey: .groups)
                }
            }

            public struct Most: Decodable, Sendable, Equatable {
                public let id: String
                public let line: String

                private enum Keys: String, CodingKey {
                    case id
                    case line
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.id = try container.decode(String.self, forKey: .id)
                    self.line = try container.decode(String.self, forKey: .line)
                }
            }

            public struct Section: Decodable, Sendable, Equatable {
                public let key: String
                public let title: String?
                public let rows: [Row]

                private enum Keys: String, CodingKey {
                    case key
                    case title
                    case rows
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.key = try container.decode(String.self, forKey: .key)
                    self.title = try container.decodeNil(forKey: .title) ? nil : container.decode(String.self, forKey: .title)
                    self.rows = try container.decode([Row].self, forKey: .rows)
                }
            }

            public struct New: Decodable, Sendable, Equatable {
                public let id: String
                public let line: String

                private enum Keys: String, CodingKey {
                    case id
                    case line
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.id = try container.decode(String.self, forKey: .id)
                    self.line = try container.decode(String.self, forKey: .line)
                }
            }

            public struct Businesses: Decodable, Sendable, Equatable {
                public let line: String
                public let offered: [Offered]

                private enum Keys: String, CodingKey {
                    case line
                    case offered
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.line = try container.decode(String.self, forKey: .line)
                    self.offered = try container.decode([Offered].self, forKey: .offered)
                }

                public struct Offered: Decodable, Sendable, Equatable {
                    public let id: String
                    public let name: String
                    public let named: Bool
                    public let photo: String?
                    public let why: String?
                    public let handles: [Handle]

                    private enum Keys: String, CodingKey {
                        case id
                        case name
                        case named
                        case photo
                        case why
                        case handles
                    }

                    public init(from decoder: Decoder) throws {
                        let container = try decoder.container(keyedBy: Keys.self)
                        self.id = try container.decode(String.self, forKey: .id)
                        self.name = try container.decode(String.self, forKey: .name)
                        self.named = try container.decode(Bool.self, forKey: .named)
                        self.photo = try container.decodeNil(forKey: .photo) ? nil : container.decode(String.self, forKey: .photo)
                        self.why = try container.decodeNil(forKey: .why) ? nil : container.decode(String.self, forKey: .why)
                        self.handles = try container.decode([Handle].self, forKey: .handles)
                    }

                    public struct Handle: Decodable, Sendable, Equatable {
                        public let id: String
                        public let words: String

                        private enum Keys: String, CodingKey {
                            case id
                            case words
                        }

                        public init(from decoder: Decoder) throws {
                            let container = try decoder.container(keyedBy: Keys.self)
                            self.id = try container.decode(String.self, forKey: .id)
                            self.words = try container.decode(String.self, forKey: .words)
                        }
                    }
                }
            }

            public struct Organise: Decodable, Sendable, Equatable {
                public let count: Int
                public let line: String?
                public let queue: [String]
                public let organised: Int
                public let often: Int

                private enum Keys: String, CodingKey {
                    case count
                    case line
                    case queue
                    case organised
                    case often
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.count = try container.decode(Int.self, forKey: .count)
                    self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                    self.queue = try container.decode([String].self, forKey: .queue)
                    self.organised = try container.decode(Int.self, forKey: .organised)
                    self.often = try container.decode(Int.self, forKey: .often)
                }
            }

            public struct Groups: Decodable, Sendable, Equatable {
                public let yours: [ChatRow]
                public let quiet: [ChatRow]
                public let quietLine: String?

                private enum Keys: String, CodingKey {
                    case yours
                    case quiet
                    case quietLine = "quiet_line"
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.yours = try container.decode([ChatRow].self, forKey: .yours)
                    self.quiet = try container.decode([ChatRow].self, forKey: .quiet)
                    self.quietLine = try container.decodeNil(forKey: .quietLine) ? nil : container.decode(String.self, forKey: .quietLine)
                }
            }
        }

        public struct Person: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/person"

            public let position: String
            public let today: String
            public let became: String?
            public let me: Bool
            public let head: Head
            public let handles: [Handle]
            public let month: Month
            public let history: History
            public let talk: Talk?
            public let `where`: [Where]
            public let suggestionsLine: String?
            public let edit: Edit
            public let counting: Bool

            private enum Keys: String, CodingKey {
                case position
                case today
                case became
                case me
                case head
                case handles
                case month
                case history
                case talk
                case `where`
                case suggestionsLine = "suggestions_line"
                case edit
                case counting
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.became = try container.decodeNil(forKey: .became) ? nil : container.decode(String.self, forKey: .became)
                self.me = try container.decode(Bool.self, forKey: .me)
                self.head = try container.decode(Head.self, forKey: .head)
                self.handles = try container.decode([Handle].self, forKey: .handles)
                self.month = try container.decode(Month.self, forKey: .month)
                self.history = try container.decode(History.self, forKey: .history)
                self.talk = try container.decodeNil(forKey: .talk) ? nil : container.decode(Talk.self, forKey: .talk)
                self.`where` = try container.decode([Where].self, forKey: .`where`)
                self.suggestionsLine = try container.decodeNil(forKey: .suggestionsLine) ? nil : container.decode(String.self, forKey: .suggestionsLine)
                self.edit = try container.decode(Edit.self, forKey: .edit)
                self.counting = try container.decode(Bool.self, forKey: .counting)
            }

            public struct Head: Decodable, Sendable, Equatable {
                public let name: String
                public let named: Bool
                public let fullName: String?
                public let photo: String?
                public let chips: [Chip]
                public let since: When?
                public let relationship: String?
                public let work: String?
                public let entity: Entity
                public let entityBy: EntityBy?

                private enum Keys: String, CodingKey {
                    case name
                    case named
                    case fullName = "full_name"
                    case photo
                    case chips
                    case since
                    case relationship
                    case work
                    case entity
                    case entityBy = "entity_by"
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.name = try container.decode(String.self, forKey: .name)
                    self.named = try container.decode(Bool.self, forKey: .named)
                    self.fullName = try container.decodeNil(forKey: .fullName) ? nil : container.decode(String.self, forKey: .fullName)
                    self.photo = try container.decodeNil(forKey: .photo) ? nil : container.decode(String.self, forKey: .photo)
                    self.chips = try container.decode([Chip].self, forKey: .chips)
                    self.since = try container.decodeNil(forKey: .since) ? nil : container.decode(When.self, forKey: .since)
                    self.relationship = try container.decodeNil(forKey: .relationship) ? nil : container.decode(String.self, forKey: .relationship)
                    self.work = try container.decodeNil(forKey: .work) ? nil : container.decode(String.self, forKey: .work)
                    self.entity = try container.decode(Entity.self, forKey: .entity)
                    self.entityBy = try container.decodeNil(forKey: .entityBy) ? nil : container.decode(EntityBy.self, forKey: .entityBy)
                }

                public enum Chip: Decodable, Sendable, Equatable {
                    case birthday(month: Int, day: Int)
                    case profile(network: String, words: String, href: String?)
                    case unknown

                    private enum Keys: String, CodingKey {
                        case kind
                        case month
                        case day
                        case network
                        case words
                        case href
                    }

                    public init(from decoder: Decoder) throws {
                        let container = try decoder.container(keyedBy: Keys.self)
                        switch try container.decode(String.self, forKey: .kind) {
                        case "birthday":
                            self = .birthday(
                                month: try container.decode(Int.self, forKey: .month),
                                day: try container.decode(Int.self, forKey: .day)
                            )
                        case "profile":
                            self = .profile(
                                network: try container.decode(String.self, forKey: .network),
                                words: try container.decode(String.self, forKey: .words),
                                href: try container.decodeNil(forKey: .href) ? nil : container.decode(String.self, forKey: .href)
                            )
                        default:
                            self = .unknown
                        }
                    }
                }

                public enum EntityBy: String, Decodable, Sendable, Equatable {
                    case you
                    case home
                    case unknown

                    public init(from decoder: Decoder) throws {
                        self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
                    }
                }
            }

            public struct Handle: Decodable, Sendable, Equatable {
                public let id: String
                public let kind: HandleKind
                public let network: String?
                public let words: String
                public let from: String?
                public let own: Bool

                private enum Keys: String, CodingKey {
                    case id
                    case kind
                    case network
                    case words
                    case from
                    case own
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.id = try container.decode(String.self, forKey: .id)
                    self.kind = try container.decode(HandleKind.self, forKey: .kind)
                    self.network = try container.decodeNil(forKey: .network) ? nil : container.decode(String.self, forKey: .network)
                    self.words = try container.decode(String.self, forKey: .words)
                    self.from = try container.decodeNil(forKey: .from) ? nil : container.decode(String.self, forKey: .from)
                    self.own = try container.decode(Bool.self, forKey: .own)
                }
            }

            public struct Where: Decodable, Sendable, Equatable {
                public let chat: String?
                public let title: String
                public let group: Bool
                public let network: String
                public let when: When?
                public let count: Int
                public let line: String
                public let quiet: Bool

                private enum Keys: String, CodingKey {
                    case chat
                    case title
                    case group
                    case network
                    case when
                    case count
                    case line
                    case quiet
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.chat = try container.decodeNil(forKey: .chat) ? nil : container.decode(String.self, forKey: .chat)
                    self.title = try container.decode(String.self, forKey: .title)
                    self.group = try container.decode(Bool.self, forKey: .group)
                    self.network = try container.decode(String.self, forKey: .network)
                    self.when = try container.decodeNil(forKey: .when) ? nil : container.decode(When.self, forKey: .when)
                    self.count = try container.decode(Int.self, forKey: .count)
                    self.line = try container.decode(String.self, forKey: .line)
                    self.quiet = try container.decode(Bool.self, forKey: .quiet)
                }
            }

            public struct Edit: Decodable, Sendable, Equatable {
                public let call: String?
                public let fullName: String?
                public let nameFrom: String?
                public let recordId: String?
                public let face: Bool
                public let reach: String?
                public let last: When?
                public let much: String
                public let mails: Mails
                public let record: PersonRecord?
                public let details: Details?
                public let suggestions: [Suggestion]
                public let alsoCalled: [AlsoCalled]
                public let namesSeen: [String]
                public let joined: [Joined]

                private enum Keys: String, CodingKey {
                    case call
                    case fullName = "full_name"
                    case nameFrom = "name_from"
                    case recordId = "record_id"
                    case face
                    case reach
                    case last
                    case much
                    case mails
                    case record
                    case details
                    case suggestions
                    case alsoCalled = "also_called"
                    case namesSeen = "names_seen"
                    case joined
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.call = try container.decodeNil(forKey: .call) ? nil : container.decode(String.self, forKey: .call)
                    self.fullName = try container.decodeNil(forKey: .fullName) ? nil : container.decode(String.self, forKey: .fullName)
                    self.nameFrom = try container.decodeNil(forKey: .nameFrom) ? nil : container.decode(String.self, forKey: .nameFrom)
                    self.recordId = try container.decodeNil(forKey: .recordId) ? nil : container.decode(String.self, forKey: .recordId)
                    self.face = try container.decode(Bool.self, forKey: .face)
                    self.reach = try container.decodeNil(forKey: .reach) ? nil : container.decode(String.self, forKey: .reach)
                    self.last = try container.decodeNil(forKey: .last) ? nil : container.decode(When.self, forKey: .last)
                    self.much = try container.decode(String.self, forKey: .much)
                    self.mails = try container.decode(Mails.self, forKey: .mails)
                    self.record = try container.decodeNil(forKey: .record) ? nil : container.decode(PersonRecord.self, forKey: .record)
                    self.details = try container.decodeNil(forKey: .details) ? nil : container.decode(Details.self, forKey: .details)
                    self.suggestions = try container.decode([Suggestion].self, forKey: .suggestions)
                    self.alsoCalled = try container.decode([AlsoCalled].self, forKey: .alsoCalled)
                    self.namesSeen = try container.decode([String].self, forKey: .namesSeen)
                    self.joined = try container.decode([Joined].self, forKey: .joined)
                }

                public struct Mails: Decodable, Sendable, Equatable {
                    public let from: Int
                    public let to: Int
                    public let newest: [Mail]?

                    private enum Keys: String, CodingKey {
                        case from
                        case to
                        case newest
                    }

                    public init(from decoder: Decoder) throws {
                        let container = try decoder.container(keyedBy: Keys.self)
                        self.from = try container.decode(Int.self, forKey: .from)
                        self.to = try container.decode(Int.self, forKey: .to)
                        self.newest = try container.decodeNil(forKey: .newest) ? nil : container.decode([Mail].self, forKey: .newest)
                    }
                }

                public struct AlsoCalled: Decodable, Sendable, Equatable {
                    public let name: String
                    public let from: String

                    private enum Keys: String, CodingKey {
                        case name
                        case from
                    }

                    public init(from decoder: Decoder) throws {
                        let container = try decoder.container(keyedBy: Keys.self)
                        self.name = try container.decode(String.self, forKey: .name)
                        self.from = try container.decode(String.self, forKey: .from)
                    }
                }

                public struct Joined: Decodable, Sendable, Equatable {
                    public let id: String
                    public let name: String
                    public let photo: String?
                    public let handles: [String]
                    public let with: [String]

                    private enum Keys: String, CodingKey {
                        case id
                        case name
                        case photo
                        case handles
                        case with
                    }

                    public init(from decoder: Decoder) throws {
                        let container = try decoder.container(keyedBy: Keys.self)
                        self.id = try container.decode(String.self, forKey: .id)
                        self.name = try container.decode(String.self, forKey: .name)
                        self.photo = try container.decodeNil(forKey: .photo) ? nil : container.decode(String.self, forKey: .photo)
                        self.handles = try container.decode([String].self, forKey: .handles)
                        self.with = try container.decode([String].self, forKey: .with)
                    }
                }
            }
        }

        public struct Group: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/group"

            public let position: String
            public let today: String
            public let head: Head
            public let total: Int
            public let writers: [Writer]
            public let yours: String?
            public let talk: Talk?
            public let counting: Bool

            private enum Keys: String, CodingKey {
                case position
                case today
                case head
                case total
                case writers
                case yours
                case talk
                case counting
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.head = try container.decode(Head.self, forKey: .head)
                self.total = try container.decode(Int.self, forKey: .total)
                self.writers = try container.decode([Writer].self, forKey: .writers)
                self.yours = try container.decodeNil(forKey: .yours) ? nil : container.decode(String.self, forKey: .yours)
                self.talk = try container.decodeNil(forKey: .talk) ? nil : container.decode(Talk.self, forKey: .talk)
                self.counting = try container.decode(Bool.self, forKey: .counting)
            }

            public struct Head: Decodable, Sendable, Equatable {
                public let title: String
                public let photo: String?
                public let line: String
                public let since: When?
                public let word: Word
                public let quiet: Bool
                public let why: Why?

                private enum Keys: String, CodingKey {
                    case title
                    case photo
                    case line
                    case since
                    case word
                    case quiet
                    case why
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.title = try container.decode(String.self, forKey: .title)
                    self.photo = try container.decodeNil(forKey: .photo) ? nil : container.decode(String.self, forKey: .photo)
                    self.line = try container.decode(String.self, forKey: .line)
                    self.since = try container.decodeNil(forKey: .since) ? nil : container.decode(When.self, forKey: .since)
                    self.word = try container.decode(Word.self, forKey: .word)
                    self.quiet = try container.decode(Bool.self, forKey: .quiet)
                    self.why = try container.decodeNil(forKey: .why) ? nil : container.decode(Why.self, forKey: .why)
                }

                public enum Word: String, Decodable, Sendable, Equatable {
                    case rule
                    case always
                    case never
                    case unknown

                    public init(from decoder: Decoder) throws {
                        self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
                    }
                }

                public struct Why: Decodable, Sendable, Equatable {
                    public let words: String
                    public let since: When?

                    private enum Keys: String, CodingKey {
                        case words
                        case since
                    }

                    public init(from decoder: Decoder) throws {
                        let container = try decoder.container(keyedBy: Keys.self)
                        self.words = try container.decode(String.self, forKey: .words)
                        self.since = try container.decodeNil(forKey: .since) ? nil : container.decode(When.self, forKey: .since)
                    }
                }
            }

            public struct Writer: Decodable, Sendable, Equatable {
                public let id: String
                public let name: String
                public let named: Bool
                public let photo: String?
                public let share: String

                private enum Keys: String, CodingKey {
                    case id
                    case name
                    case named
                    case photo
                    case share
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.id = try container.decode(String.self, forKey: .id)
                    self.name = try container.decode(String.self, forKey: .name)
                    self.named = try container.decode(Bool.self, forKey: .named)
                    self.photo = try container.decodeNil(forKey: .photo) ? nil : container.decode(String.self, forKey: .photo)
                    self.share = try container.decode(String.self, forKey: .share)
                }
            }
        }

        public struct PeopleFind: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/people/find"

            public let position: String
            public let today: String
            public let rows: [Row]
            public let profiles: [Profile]

            private enum Keys: String, CodingKey {
                case position
                case today
                case rows
                case profiles
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.rows = try container.decode([Row].self, forKey: .rows)
                self.profiles = try container.decode([Profile].self, forKey: .profiles)
            }
        }

        public struct Connectors: Decodable, Sendable, Equatable {
            public static let route = "/v1/connectors"

            public let position: String
            public let today: String
            public let rows: [StreamRow]
            public let needs: [Need]
            public let badge: Badge

            private enum Keys: String, CodingKey {
                case position
                case today
                case rows
                case needs
                case badge
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.rows = try container.decode([StreamRow].self, forKey: .rows)
                self.needs = try container.decode([Need].self, forKey: .needs)
                self.badge = try container.decode(Badge.self, forKey: .badge)
            }

            public struct Badge: Decodable, Sendable, Equatable {
                public let needs: Int
                public let asks: Int

                private enum Keys: String, CodingKey {
                    case needs
                    case asks
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.needs = try container.decode(Int.self, forKey: .needs)
                    self.asks = try container.decode(Int.self, forKey: .asks)
                }
            }
        }

        public struct AgentsWaiting: Decodable, Sendable, Equatable {
            public static let route = "/v1/agents/waiting"

            public let position: String
            public let today: String
            public let requests: [WaitingSignIn]
            public let asks: [WaitingAsk]

            private enum Keys: String, CodingKey {
                case position
                case today
                case requests
                case asks
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.requests = try container.decode([WaitingSignIn].self, forKey: .requests)
                self.asks = try container.decode([WaitingAsk].self, forKey: .asks)
            }
        }

        public struct AgentGuides: Decodable, Sendable, Equatable {
            public static let route = "/v1/agents/guides"

            public let position: String
            public let today: String
            public let title: String
            public let apps: [Guide]

            private enum Keys: String, CodingKey {
                case position
                case today
                case title
                case apps
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.title = try container.decode(String.self, forKey: .title)
                self.apps = try container.decode([Guide].self, forKey: .apps)
            }
        }

        public struct Search: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/search"

            public let position: String
            public let today: String
            public let top: [SearchRow]
            public let kinds: [KindSection]
            public let total: Count
            public let held: Held?
            public let reading: Reading?
            public let nothing: String?

            private enum Keys: String, CodingKey {
                case position
                case today
                case top
                case kinds
                case total
                case held
                case reading
                case nothing
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.top = try container.decode([SearchRow].self, forKey: .top)
                self.kinds = try container.decode([KindSection].self, forKey: .kinds)
                self.total = try container.decode(Count.self, forKey: .total)
                self.held = try container.decodeNil(forKey: .held) ? nil : container.decode(Held.self, forKey: .held)
                self.reading = try container.decodeNil(forKey: .reading) ? nil : container.decode(Reading.self, forKey: .reading)
                self.nothing = try container.decodeNil(forKey: .nothing) ? nil : container.decode(String.self, forKey: .nothing)
            }

            public struct Held: Decodable, Sendable, Equatable {
                public let first: String
                public let last: String

                private enum Keys: String, CodingKey {
                    case first
                    case last
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.first = try container.decode(String.self, forKey: .first)
                    self.last = try container.decode(String.self, forKey: .last)
                }
            }
        }

        public struct SearchKind: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/search/kind"

            public let position: String
            public let today: String
            public let family: SearchFamily
            public let title: String
            public let upcoming: Bool
            public let rows: [SearchRow]
            public let next: String?
            public let unread: String?
            public let reading: Reading?
            public let nothing: String?

            private enum Keys: String, CodingKey {
                case position
                case today
                case family
                case title
                case upcoming
                case rows
                case next
                case unread
                case reading
                case nothing
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.family = try container.decode(SearchFamily.self, forKey: .family)
                self.title = try container.decode(String.self, forKey: .title)
                self.upcoming = try container.decode(Bool.self, forKey: .upcoming)
                self.rows = try container.decode([SearchRow].self, forKey: .rows)
                self.next = try container.decodeNil(forKey: .next) ? nil : container.decode(String.self, forKey: .next)
                self.unread = try container.decodeNil(forKey: .unread) ? nil : container.decode(String.self, forKey: .unread)
                self.reading = try container.decodeNil(forKey: .reading) ? nil : container.decode(Reading.self, forKey: .reading)
                self.nothing = try container.decodeNil(forKey: .nothing) ? nil : container.decode(String.self, forKey: .nothing)
            }
        }

        public struct Places: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/places"

            public let position: String
            public let today: String
            public let here: String?
            public let frame: Frame?
            public let cities: [City]
            public let toName: [SpotRow]
            public let hidden: [HiddenRow]
            public let counting: Bool

            private enum Keys: String, CodingKey {
                case position
                case today
                case here
                case frame
                case cities
                case toName = "to_name"
                case hidden
                case counting
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.here = try container.decodeNil(forKey: .here) ? nil : container.decode(String.self, forKey: .here)
                self.frame = try container.decodeNil(forKey: .frame) ? nil : container.decode(Frame.self, forKey: .frame)
                self.cities = try container.decode([City].self, forKey: .cities)
                self.toName = try container.decode([SpotRow].self, forKey: .toName)
                self.hidden = try container.decode([HiddenRow].self, forKey: .hidden)
                self.counting = try container.decode(Bool.self, forKey: .counting)
            }

            public struct City: Decodable, Sendable, Equatable {
                public let key: String
                public let title: String
                public let here: Bool
                public let when: When?
                public let since: When?
                public let point: Point
                public let places: [PlaceRow]
                public let once: [PlaceRow]

                private enum Keys: String, CodingKey {
                    case key
                    case title
                    case here
                    case when
                    case since
                    case point
                    case places
                    case once
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.key = try container.decode(String.self, forKey: .key)
                    self.title = try container.decode(String.self, forKey: .title)
                    self.here = try container.decode(Bool.self, forKey: .here)
                    self.when = try container.decodeNil(forKey: .when) ? nil : container.decode(When.self, forKey: .when)
                    self.since = try container.decodeNil(forKey: .since) ? nil : container.decode(When.self, forKey: .since)
                    self.point = try container.decode(Point.self, forKey: .point)
                    self.places = try container.decode([PlaceRow].self, forKey: .places)
                    self.once = try container.decode([PlaceRow].self, forKey: .once)
                }
            }
        }

        public struct Place: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/place"

            public let position: String
            public let today: String
            public let head: Head
            public let here: Bool
            public let rhythm: String?
            public let stays: Int
            public let visits: Visits
            public let people: [PlacePerson]
            public let photos: Photos
            public let partOf: PlaceLink?
            public let inside: [PlaceLink]
            public let askHome: HomeAsk?
            public let clashes: [Clashe]
            public let counting: Bool

            private enum Keys: String, CodingKey {
                case position
                case today
                case head
                case here
                case rhythm
                case stays
                case visits
                case people
                case photos
                case partOf = "part_of"
                case inside
                case askHome = "ask_home"
                case clashes
                case counting
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.head = try container.decode(Head.self, forKey: .head)
                self.here = try container.decode(Bool.self, forKey: .here)
                self.rhythm = try container.decodeNil(forKey: .rhythm) ? nil : container.decode(String.self, forKey: .rhythm)
                self.stays = try container.decode(Int.self, forKey: .stays)
                self.visits = try container.decode(Visits.self, forKey: .visits)
                self.people = try container.decode([PlacePerson].self, forKey: .people)
                self.photos = try container.decode(Photos.self, forKey: .photos)
                self.partOf = try container.decodeNil(forKey: .partOf) ? nil : container.decode(PlaceLink.self, forKey: .partOf)
                self.inside = try container.decode([PlaceLink].self, forKey: .inside)
                self.askHome = try container.decodeNil(forKey: .askHome) ? nil : container.decode(HomeAsk.self, forKey: .askHome)
                self.clashes = try container.decode([Clashe].self, forKey: .clashes)
                self.counting = try container.decode(Bool.self, forKey: .counting)
            }

            public struct Head: Decodable, Sendable, Equatable {
                public let name: String
                public let line: String?
                public let since: When?

                private enum Keys: String, CodingKey {
                    case name
                    case line
                    case since
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.name = try container.decode(String.self, forKey: .name)
                    self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                    self.since = try container.decodeNil(forKey: .since) ? nil : container.decode(When.self, forKey: .since)
                }
            }

            public struct Visits: Decodable, Sendable, Equatable {
                public let count: Int
                public let rows: [PlaceVisit]

                private enum Keys: String, CodingKey {
                    case count
                    case rows
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.count = try container.decode(Int.self, forKey: .count)
                    self.rows = try container.decode([PlaceVisit].self, forKey: .rows)
                }
            }

            public struct Photos: Decodable, Sendable, Equatable {
                public let first: [String]
                public let total: Int
                public let line: String?

                private enum Keys: String, CodingKey {
                    case first
                    case total
                    case line
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.first = try container.decode([String].self, forKey: .first)
                    self.total = try container.decode(Int.self, forKey: .total)
                    self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                }
            }

            public struct Clashe: Decodable, Sendable, Equatable {
                public let id: String
                public let names: [String]

                private enum Keys: String, CodingKey {
                    case id
                    case names
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.id = try container.decode(String.self, forKey: .id)
                    self.names = try container.decode([String].self, forKey: .names)
                }
            }
        }

        public struct PlaceEdit: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/place/edit"

            public let position: String
            public let today: String
            public let slug: String
            public let circle: Circle
            public let others: [NamedCircle]
            public let points: [StayPoint]
            public let held: Int
            public let read: Bool
            public let line: String?
            public let counting: Bool

            private enum Keys: String, CodingKey {
                case position
                case today
                case slug
                case circle
                case others
                case points
                case held
                case read
                case line
                case counting
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.slug = try container.decode(String.self, forKey: .slug)
                self.circle = try container.decode(Circle.self, forKey: .circle)
                self.others = try container.decode([NamedCircle].self, forKey: .others)
                self.points = try container.decode([StayPoint].self, forKey: .points)
                self.held = try container.decode(Int.self, forKey: .held)
                self.read = try container.decode(Bool.self, forKey: .read)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                self.counting = try container.decode(Bool.self, forKey: .counting)
            }
        }

        public struct Year: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/year"

            public let position: String
            public let today: String
            public let year: Int
            public let span: YearSpan
            public let trips: [Trip]
            public let figures: [Figure]
            public let cities: [City]
            public let base: Base?

            private enum Keys: String, CodingKey {
                case position
                case today
                case year
                case span
                case trips
                case figures
                case cities
                case base
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.year = try container.decode(Int.self, forKey: .year)
                self.span = try container.decode(YearSpan.self, forKey: .span)
                self.trips = try container.decode([Trip].self, forKey: .trips)
                self.figures = try container.decode([Figure].self, forKey: .figures)
                self.cities = try container.decode([City].self, forKey: .cities)
                self.base = try container.decodeNil(forKey: .base) ? nil : container.decode(Base.self, forKey: .base)
            }

            public struct Trip: Decodable, Sendable, Equatable {
                public let title: String
                public let nights: String
                public let range: Range
                public let route: [String]
                public let guessed: Bool
                public let days: [TripDay]

                private enum Keys: String, CodingKey {
                    case title
                    case nights
                    case range
                    case route
                    case guessed
                    case days
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.title = try container.decode(String.self, forKey: .title)
                    self.nights = try container.decode(String.self, forKey: .nights)
                    self.range = try container.decode(Range.self, forKey: .range)
                    self.route = try container.decode([String].self, forKey: .route)
                    self.guessed = try container.decode(Bool.self, forKey: .guessed)
                    self.days = try container.decode([TripDay].self, forKey: .days)
                }

                public struct Range: Decodable, Sendable, Equatable {
                    public let first: String
                    public let last: String

                    private enum Keys: String, CodingKey {
                        case first
                        case last
                    }

                    public init(from decoder: Decoder) throws {
                        let container = try decoder.container(keyedBy: Keys.self)
                        self.first = try container.decode(String.self, forKey: .first)
                        self.last = try container.decode(String.self, forKey: .last)
                    }
                }
            }

            public struct Figure: Decodable, Sendable, Equatable {
                public let count: Int
                public let words: String

                private enum Keys: String, CodingKey {
                    case count
                    case words
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.count = try container.decode(Int.self, forKey: .count)
                    self.words = try container.decode(String.self, forKey: .words)
                }
            }

            public struct City: Decodable, Sendable, Equatable {
                public let name: String
                public let nights: Int
                public let point: Point?
                public let country: String?
                public let base: Bool

                private enum Keys: String, CodingKey {
                    case name
                    case nights
                    case point
                    case country
                    case base
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.name = try container.decode(String.self, forKey: .name)
                    self.nights = try container.decode(Int.self, forKey: .nights)
                    self.point = try container.decodeNil(forKey: .point) ? nil : container.decode(Point.self, forKey: .point)
                    self.country = try container.decodeNil(forKey: .country) ? nil : container.decode(String.self, forKey: .country)
                    self.base = try container.decode(Bool.self, forKey: .base)
                }
            }

            public struct Base: Decodable, Sendable, Equatable {
                public let name: String
                public let nights: Int

                private enum Keys: String, CodingKey {
                    case name
                    case nights
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.name = try container.decode(String.self, forKey: .name)
                    self.nights = try container.decode(Int.self, forKey: .nights)
                }
            }
        }

        public struct Days: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/days"

            public let position: String
            public let today: String
            public let opening: String
            public let days: [WrittenDay]
            public let next: String?

            private enum Keys: String, CodingKey {
                case position
                case today
                case opening
                case days
                case next
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.opening = try container.decode(String.self, forKey: .opening)
                self.days = try container.decode([WrittenDay].self, forKey: .days)
                self.next = try container.decodeNil(forKey: .next) ? nil : container.decode(String.self, forKey: .next)
            }
        }

        public struct Day: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/day"

            public let position: String
            public let today: String
            public let day: String
            public let state: DayState
            public let line: String?
            public let nowMs: Int?
            public let updatedMs: Int?
            public let allDay: [DayRow]
            public let chapters: [DayChapter]
            public let also: Also?
            public let plans: [DayRow]
            public let untilMs: Int?
            public let nowDivider: String?
            public let endMs: Int?
            public let beforeHome: String?
            public let side: DaySide

            private enum Keys: String, CodingKey {
                case position
                case today
                case day
                case state
                case line
                case nowMs = "now_ms"
                case updatedMs = "updated_ms"
                case allDay = "all_day"
                case chapters
                case also
                case plans
                case untilMs = "until_ms"
                case nowDivider = "now_divider"
                case endMs = "end_ms"
                case beforeHome = "before_home"
                case side
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.day = try container.decode(String.self, forKey: .day)
                self.state = try container.decode(DayState.self, forKey: .state)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                self.nowMs = try container.decodeNil(forKey: .nowMs) ? nil : container.decode(Int.self, forKey: .nowMs)
                self.updatedMs = try container.decodeNil(forKey: .updatedMs) ? nil : container.decode(Int.self, forKey: .updatedMs)
                self.allDay = try container.decode([DayRow].self, forKey: .allDay)
                self.chapters = try container.decode([DayChapter].self, forKey: .chapters)
                self.also = try container.decodeNil(forKey: .also) ? nil : container.decode(Also.self, forKey: .also)
                self.plans = try container.decode([DayRow].self, forKey: .plans)
                self.untilMs = try container.decodeNil(forKey: .untilMs) ? nil : container.decode(Int.self, forKey: .untilMs)
                self.nowDivider = try container.decodeNil(forKey: .nowDivider) ? nil : container.decode(String.self, forKey: .nowDivider)
                self.endMs = try container.decodeNil(forKey: .endMs) ? nil : container.decode(Int.self, forKey: .endMs)
                self.beforeHome = try container.decodeNil(forKey: .beforeHome) ? nil : container.decode(String.self, forKey: .beforeHome)
                self.side = try container.decode(DaySide.self, forKey: .side)
            }

            public struct Also: Decodable, Sendable, Equatable {
                public let folded: Bool
                public let names: [DayName]
                public let rows: [DayRow]

                private enum Keys: String, CodingKey {
                    case folded
                    case names
                    case rows
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.folded = try container.decode(Bool.self, forKey: .folded)
                    self.names = try container.decode([DayName].self, forKey: .names)
                    self.rows = try container.decode([DayRow].self, forKey: .rows)
                }
            }
        }

        public struct Moment: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/moment"

            public let position: String
            public let today: String
            public let day: String
            public let state: MomentState
            public let moment: DayMoment?

            private enum Keys: String, CodingKey {
                case position
                case today
                case day
                case state
                case moment
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.day = try container.decode(String.self, forKey: .day)
                self.state = try container.decode(MomentState.self, forKey: .state)
                self.moment = try container.decodeNil(forKey: .moment) ? nil : container.decode(DayMoment.self, forKey: .moment)
            }
        }

        public struct Thread: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/thread"

            public let position: String
            public let today: String
            public let chat: String
            public let day: String
            public let title: String?
            public let messages: [DayMessage]

            private enum Keys: String, CodingKey {
                case position
                case today
                case chat
                case day
                case title
                case messages
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.chat = try container.decode(String.self, forKey: .chat)
                self.day = try container.decode(String.self, forKey: .day)
                self.title = try container.decodeNil(forKey: .title) ? nil : container.decode(String.self, forKey: .title)
                self.messages = try container.decode([DayMessage].self, forKey: .messages)
            }
        }

        public struct Feedback: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/feedback"

            public let position: String
            public let today: String
            public let `open`: Bool
            public let title: String
            public let about: About
            public let field: Field
            public let email: Email
            public let kinds: [Kind]
            public let see: String
            public let send: String
            public let clear: String
            public let sent: Sent
            public let again: String
            public let privacy: String

            private enum Keys: String, CodingKey {
                case position
                case today
                case `open`
                case title
                case about
                case field
                case email
                case kinds
                case see
                case send
                case clear
                case sent
                case again
                case privacy
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.`open` = try container.decode(Bool.self, forKey: .`open`)
                self.title = try container.decode(String.self, forKey: .title)
                self.about = try container.decode(About.self, forKey: .about)
                self.field = try container.decode(Field.self, forKey: .field)
                self.email = try container.decode(Email.self, forKey: .email)
                self.kinds = try container.decode([Kind].self, forKey: .kinds)
                self.see = try container.decode(String.self, forKey: .see)
                self.send = try container.decode(String.self, forKey: .send)
                self.clear = try container.decode(String.self, forKey: .clear)
                self.sent = try container.decode(Sent.self, forKey: .sent)
                self.again = try container.decode(String.self, forKey: .again)
                self.privacy = try container.decode(String.self, forKey: .privacy)
            }

            public struct About: Decodable, Sendable, Equatable {
                public let chat: String
                public let connector: String

                private enum Keys: String, CodingKey {
                    case chat
                    case connector
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.chat = try container.decode(String.self, forKey: .chat)
                    self.connector = try container.decode(String.self, forKey: .connector)
                }
            }

            public struct Field: Decodable, Sendable, Equatable {
                public let placeholder: String
                public let max: Int

                private enum Keys: String, CodingKey {
                    case placeholder
                    case max
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.placeholder = try container.decode(String.self, forKey: .placeholder)
                    self.max = try container.decode(Int.self, forKey: .max)
                }
            }

            public struct Email: Decodable, Sendable, Equatable {
                public let label: String
                public let placeholder: String

                private enum Keys: String, CodingKey {
                    case label
                    case placeholder
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.label = try container.decode(String.self, forKey: .label)
                    self.placeholder = try container.decode(String.self, forKey: .placeholder)
                }
            }

            public struct Kind: Decodable, Sendable, Equatable {
                public let kind: FeedbackKind
                public let title: String
                public let add: String?

                private enum Keys: String, CodingKey {
                    case kind
                    case title
                    case add
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.kind = try container.decode(FeedbackKind.self, forKey: .kind)
                    self.title = try container.decode(String.self, forKey: .title)
                    self.add = try container.decodeNil(forKey: .add) ? nil : container.decode(String.self, forKey: .add)
                }
            }

            public struct Sent: Decodable, Sendable, Equatable {
                public let title: String
                public let line: String?

                private enum Keys: String, CodingKey {
                    case title
                    case line
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.title = try container.decode(String.self, forKey: .title)
                    self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                }
            }
        }

        public struct Settings: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/settings"

            public let position: String
            public let today: String
            public let you: Row?
            public let values: [SettingsValue]
            public let devices: [SettingsDevice]
            public let removed: String

            private enum Keys: String, CodingKey {
                case position
                case today
                case you
                case values
                case devices
                case removed
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.you = try container.decodeNil(forKey: .you) ? nil : container.decode(Row.self, forKey: .you)
                self.values = try container.decode([SettingsValue].self, forKey: .values)
                self.devices = try container.decode([SettingsDevice].self, forKey: .devices)
                self.removed = try container.decode(String.self, forKey: .removed)
            }
        }

        public struct SettingsPage: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/settings/page"

            public let position: String
            public let today: String
            public let id: String
            public let title: String
            public let line: String?
            public let parts: [SettingsPart]

            private enum Keys: String, CodingKey {
                case position
                case today
                case id
                case title
                case line
                case parts
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.id = try container.decode(String.self, forKey: .id)
                self.title = try container.decode(String.self, forKey: .title)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                self.parts = try container.decode([SettingsPart].self, forKey: .parts)
            }
        }

        public struct Storage: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/storage"

            public let position: String
            public let today: String
            public let title: String
            public let counted: Bool
            public let figure: String
            public let after: String
            public let disk: String
            public let growth: String
            public let sentence: [PhrasePart]
            public let bar: StorageBar
            public let chart: StorageChart?
            public let used: String
            public let uses: [StorageUse]
            public let more: String?
            public let fewer: String
            public let keep: Keep

            private enum Keys: String, CodingKey {
                case position
                case today
                case title
                case counted
                case figure
                case after
                case disk
                case growth
                case sentence
                case bar
                case chart
                case used
                case uses
                case more
                case fewer
                case keep
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.title = try container.decode(String.self, forKey: .title)
                self.counted = try container.decode(Bool.self, forKey: .counted)
                self.figure = try container.decode(String.self, forKey: .figure)
                self.after = try container.decode(String.self, forKey: .after)
                self.disk = try container.decode(String.self, forKey: .disk)
                self.growth = try container.decode(String.self, forKey: .growth)
                self.sentence = try container.decode([PhrasePart].self, forKey: .sentence)
                self.bar = try container.decode(StorageBar.self, forKey: .bar)
                self.chart = try container.decodeNil(forKey: .chart) ? nil : container.decode(StorageChart.self, forKey: .chart)
                self.used = try container.decode(String.self, forKey: .used)
                self.uses = try container.decode([StorageUse].self, forKey: .uses)
                self.more = try container.decodeNil(forKey: .more) ? nil : container.decode(String.self, forKey: .more)
                self.fewer = try container.decode(String.self, forKey: .fewer)
                self.keep = try container.decode(Keep.self, forKey: .keep)
            }

            public struct Keep: Decodable, Sendable, Equatable {
                public let label: String
                public let line: String
                public let size: String

                private enum Keys: String, CodingKey {
                    case label
                    case line
                    case size
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.label = try container.decode(String.self, forKey: .label)
                    self.line = try container.decode(String.self, forKey: .line)
                    self.size = try container.decode(String.self, forKey: .size)
                }
            }
        }

        public struct ModelDefaults: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/models/defaults"

            public let position: String
            public let today: String
            public let uses: [ModelUse]

            private enum Keys: String, CodingKey {
                case position
                case today
                case uses
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.uses = try container.decode([ModelUse].self, forKey: .uses)
            }
        }

        public struct ModelProviders: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/models/providers"

            public let position: String
            public let today: String
            public let accounts: String
            public let connections: [ModelConnection]

            private enum Keys: String, CodingKey {
                case position
                case today
                case accounts
                case connections
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.accounts = try container.decode(String.self, forKey: .accounts)
                self.connections = try container.decode([ModelConnection].self, forKey: .connections)
            }
        }

        public struct ModelsFind: Decodable, Sendable, Equatable {
            public static let route = "/v1/page/models/find"

            public let position: String
            public let today: String
            public let placeholder: String
            public let groups: [ModelGroup]
            public let none: String?

            private enum Keys: String, CodingKey {
                case position
                case today
                case placeholder
                case groups
                case none
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.position = try container.decode(String.self, forKey: .position)
                self.today = try container.decode(String.self, forKey: .today)
                self.placeholder = try container.decode(String.self, forKey: .placeholder)
                self.groups = try container.decode([ModelGroup].self, forKey: .groups)
                self.none = try container.decodeNil(forKey: .none) ? nil : container.decode(String.self, forKey: .none)
            }
        }

        public struct AccountStep: Decodable, Sendable, Equatable {
            public let startMs: Int
            public let endMs: Int
            public let present: String?
            public let task: String?
            public let `where`: String?
            public let doing: String?
            public let actions: [MomentAction]

            private enum Keys: String, CodingKey {
                case startMs = "start_ms"
                case endMs = "end_ms"
                case present
                case task
                case `where`
                case doing
                case actions
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.startMs = try container.decode(Int.self, forKey: .startMs)
                self.endMs = try container.decode(Int.self, forKey: .endMs)
                self.present = try container.decodeNil(forKey: .present) ? nil : container.decode(String.self, forKey: .present)
                self.task = try container.decodeNil(forKey: .task) ? nil : container.decode(String.self, forKey: .task)
                self.`where` = try container.decodeNil(forKey: .`where`) ? nil : container.decode(String.self, forKey: .`where`)
                self.doing = try container.decodeNil(forKey: .doing) ? nil : container.decode(String.self, forKey: .doing)
                self.actions = try container.decode([MomentAction].self, forKey: .actions)
            }
        }

        public struct AccountTask: Decodable, Sendable, Equatable {
            public let task: String
            public let seconds: Int

            private enum Keys: String, CodingKey {
                case task
                case seconds
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.task = try container.decode(String.self, forKey: .task)
                self.seconds = try container.decode(Int.self, forKey: .seconds)
            }
        }

        public enum Act: Decodable, Sendable, Equatable {
            case `try`(label: String, need: String)
            case skip(label: String, need: String)
            case letGo(label: String, need: String)
            case `import`(label: String, kind: String)
            case read(label: String, need: String, of: String)
            case ignore(label: String, need: String, of: String)
            case turn(label: String, ids: [String])
            case signin(label: String, of: String)
            case refresh(label: String, of: String)
            case resume(label: String, of: String)
            case set(label: String, member: String)
            case grant(label: String, unit: String, grant: String)
            case `open`(label: String, url: String)
            case copy(label: String, text: String)
            case browser(label: String, of: String)
            case pair(label: String)
            case `extension`(label: String)
            case upload(label: String)
            case install(label: String)
            case storage(label: String)
            case vault(label: String)
            case verify(label: String)
            case report(label: String, of: String)
            case unknown

            private enum Keys: String, CodingKey {
                case `do`
                case label
                case need
                case kind
                case of
                case ids
                case member
                case unit
                case grant
                case url
                case text
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                switch try container.decode(String.self, forKey: .`do`) {
                case "try":
                    self = .`try`(
                        label: try container.decode(String.self, forKey: .label),
                        need: try container.decode(String.self, forKey: .need)
                    )
                case "skip":
                    self = .skip(
                        label: try container.decode(String.self, forKey: .label),
                        need: try container.decode(String.self, forKey: .need)
                    )
                case "let-go":
                    self = .letGo(
                        label: try container.decode(String.self, forKey: .label),
                        need: try container.decode(String.self, forKey: .need)
                    )
                case "import":
                    self = .`import`(
                        label: try container.decode(String.self, forKey: .label),
                        kind: try container.decode(String.self, forKey: .kind)
                    )
                case "read":
                    self = .read(
                        label: try container.decode(String.self, forKey: .label),
                        need: try container.decode(String.self, forKey: .need),
                        of: try container.decode(String.self, forKey: .of)
                    )
                case "ignore":
                    self = .ignore(
                        label: try container.decode(String.self, forKey: .label),
                        need: try container.decode(String.self, forKey: .need),
                        of: try container.decode(String.self, forKey: .of)
                    )
                case "turn":
                    self = .turn(
                        label: try container.decode(String.self, forKey: .label),
                        ids: try container.decode([String].self, forKey: .ids)
                    )
                case "signin":
                    self = .signin(
                        label: try container.decode(String.self, forKey: .label),
                        of: try container.decode(String.self, forKey: .of)
                    )
                case "refresh":
                    self = .refresh(
                        label: try container.decode(String.self, forKey: .label),
                        of: try container.decode(String.self, forKey: .of)
                    )
                case "resume":
                    self = .resume(
                        label: try container.decode(String.self, forKey: .label),
                        of: try container.decode(String.self, forKey: .of)
                    )
                case "set":
                    self = .set(
                        label: try container.decode(String.self, forKey: .label),
                        member: try container.decode(String.self, forKey: .member)
                    )
                case "grant":
                    self = .grant(
                        label: try container.decode(String.self, forKey: .label),
                        unit: try container.decode(String.self, forKey: .unit),
                        grant: try container.decode(String.self, forKey: .grant)
                    )
                case "open":
                    self = .`open`(
                        label: try container.decode(String.self, forKey: .label),
                        url: try container.decode(String.self, forKey: .url)
                    )
                case "copy":
                    self = .copy(
                        label: try container.decode(String.self, forKey: .label),
                        text: try container.decode(String.self, forKey: .text)
                    )
                case "browser":
                    self = .browser(
                        label: try container.decode(String.self, forKey: .label),
                        of: try container.decode(String.self, forKey: .of)
                    )
                case "pair":
                    self = .pair(
                        label: try container.decode(String.self, forKey: .label)
                    )
                case "extension":
                    self = .`extension`(
                        label: try container.decode(String.self, forKey: .label)
                    )
                case "upload":
                    self = .upload(
                        label: try container.decode(String.self, forKey: .label)
                    )
                case "install":
                    self = .install(
                        label: try container.decode(String.self, forKey: .label)
                    )
                case "storage":
                    self = .storage(
                        label: try container.decode(String.self, forKey: .label)
                    )
                case "vault":
                    self = .vault(
                        label: try container.decode(String.self, forKey: .label)
                    )
                case "verify":
                    self = .verify(
                        label: try container.decode(String.self, forKey: .label)
                    )
                case "report":
                    self = .report(
                        label: try container.decode(String.self, forKey: .label),
                        of: try container.decode(String.self, forKey: .of)
                    )
                default:
                    self = .unknown
                }
            }
        }

        public enum AskAnswer: String, Decodable, Sendable, Equatable {
            case once
            case always
            case no
            case unknown

            public init(from decoder: Decoder) throws {
                self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
            }
        }

        public enum AskState: String, Decodable, Sendable, Equatable {
            case `open`
            case allowed
            case declined
            case replaced
            case dropped
            case lapsed
            case unknown

            public init(from decoder: Decoder) throws {
                self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
            }
        }

        public struct CallFigure: Decodable, Sendable, Equatable {
            public let lengthMs: Int?
            public let words: String?
            public let label: String

            private enum Keys: String, CodingKey {
                case lengthMs = "length_ms"
                case words
                case label
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.lengthMs = try container.decodeNil(forKey: .lengthMs) ? nil : container.decode(Int.self, forKey: .lengthMs)
                self.words = try container.decodeNil(forKey: .words) ? nil : container.decode(String.self, forKey: .words)
                self.label = try container.decode(String.self, forKey: .label)
            }
        }

        public struct CallWeek: Decodable, Sendable, Equatable {
            public let current: Bool
            public let calls: [WeekCall]

            private enum Keys: String, CodingKey {
                case current
                case calls
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.current = try container.decode(Bool.self, forKey: .current)
                self.calls = try container.decode([WeekCall].self, forKey: .calls)
            }
        }

        public struct ChatRow: Decodable, Sendable, Equatable {
            public let chat: String
            public let title: String
            public let photo: String?
            public let when: When?
            public let line: String?
            public let find: [String]

            private enum Keys: String, CodingKey {
                case chat
                case title
                case photo
                case when
                case line
                case find
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.chat = try container.decode(String.self, forKey: .chat)
                self.title = try container.decode(String.self, forKey: .title)
                self.photo = try container.decodeNil(forKey: .photo) ? nil : container.decode(String.self, forKey: .photo)
                self.when = try container.decodeNil(forKey: .when) ? nil : container.decode(When.self, forKey: .when)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                self.find = try container.decode([String].self, forKey: .find)
            }
        }

        public struct Circle: Decodable, Sendable, Equatable {
            public let latitude: Double
            public let longitude: Double
            public let radiusM: Double

            private enum Keys: String, CodingKey {
                case latitude
                case longitude
                case radiusM = "radius_m"
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.latitude = try container.decode(Double.self, forKey: .latitude)
                self.longitude = try container.decode(Double.self, forKey: .longitude)
                self.radiusM = try container.decode(Double.self, forKey: .radiusM)
            }
        }

        public struct ContactRun: Decodable, Sendable, Equatable {
            public let glyph: Glyph
            public let value: String
            public let quiet: Bool

            private enum Keys: String, CodingKey {
                case glyph
                case value
                case quiet
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.glyph = try container.decode(Glyph.self, forKey: .glyph)
                self.value = try container.decode(String.self, forKey: .value)
                self.quiet = try container.decode(Bool.self, forKey: .quiet)
            }

            public enum Glyph: String, Decodable, Sendable, Equatable {
                case message
                case call
                case callMissed = "call-missed"
                case unknown

                public init(from decoder: Decoder) throws {
                    self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
                }
            }
        }

        public struct Count: Decodable, Sendable, Equatable {
            public let n: Int
            public let partial: Bool

            private enum Keys: String, CodingKey {
                case n
                case partial
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.n = try container.decode(Int.self, forKey: .n)
                self.partial = try container.decode(Bool.self, forKey: .partial)
            }
        }

        public struct DayBlock: Decodable, Sendable, Equatable {
            public let key: String
            public let kind: Kind
            public let startMs: Int
            public let title: String?
            public let line: String?
            public let count: DayCount?
            public let folded: Bool
            public let rows: [DayRow]
            public let divider: String?

            private enum Keys: String, CodingKey {
                case key
                case kind
                case startMs = "start_ms"
                case title
                case line
                case count
                case folded
                case rows
                case divider
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.key = try container.decode(String.self, forKey: .key)
                self.kind = try container.decode(Kind.self, forKey: .kind)
                self.startMs = try container.decode(Int.self, forKey: .startMs)
                self.title = try container.decodeNil(forKey: .title) ? nil : container.decode(String.self, forKey: .title)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                self.count = try container.decodeNil(forKey: .count) ? nil : container.decode(DayCount.self, forKey: .count)
                self.folded = try container.decode(Bool.self, forKey: .folded)
                self.rows = try container.decode([DayRow].self, forKey: .rows)
                self.divider = try container.decodeNil(forKey: .divider) ? nil : container.decode(String.self, forKey: .divider)
            }

            public enum Kind: String, Decodable, Sendable, Equatable {
                case hour
                case run
                case unknown

                public init(from decoder: Decoder) throws {
                    self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
                }
            }
        }

        public struct DayChapter: Decodable, Sendable, Equatable {
            public let key: String
            public let kind: Kind
            public let episode: String?
            public let head: Head?
            public let startMs: Int
            public let endMs: Int?
            public let folded: Bool
            public let names: [DayName]
            public let photos: [Photo]
            public let blocks: [DayBlock]
            public let divider: String?

            private enum Keys: String, CodingKey {
                case key
                case kind
                case episode
                case head
                case startMs = "start_ms"
                case endMs = "end_ms"
                case folded
                case names
                case photos
                case blocks
                case divider
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.key = try container.decode(String.self, forKey: .key)
                self.kind = try container.decode(Kind.self, forKey: .kind)
                self.episode = try container.decodeNil(forKey: .episode) ? nil : container.decode(String.self, forKey: .episode)
                self.head = try container.decodeNil(forKey: .head) ? nil : container.decode(Head.self, forKey: .head)
                self.startMs = try container.decode(Int.self, forKey: .startMs)
                self.endMs = try container.decodeNil(forKey: .endMs) ? nil : container.decode(Int.self, forKey: .endMs)
                self.folded = try container.decode(Bool.self, forKey: .folded)
                self.names = try container.decode([DayName].self, forKey: .names)
                self.photos = try container.decode([Photo].self, forKey: .photos)
                self.blocks = try container.decode([DayBlock].self, forKey: .blocks)
                self.divider = try container.decodeNil(forKey: .divider) ? nil : container.decode(String.self, forKey: .divider)
            }

            public enum Kind: String, Decodable, Sendable, Equatable {
                case stay
                case move
                case none
                case day
                case gap
                case unknown

                public init(from decoder: Decoder) throws {
                    self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
                }
            }

            public struct Head: Decodable, Sendable, Equatable {
                public let title: String
                public let line: String?
                public let place: String?
                public let statedBy: String?
                public let sinceMs: Int?
                public let icon: String
                public let quiet: Bool
                public let words: [DayRun]
                public let length: String?

                private enum Keys: String, CodingKey {
                    case title
                    case line
                    case place
                    case statedBy = "stated_by"
                    case sinceMs = "since_ms"
                    case icon
                    case quiet
                    case words
                    case length
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.title = try container.decode(String.self, forKey: .title)
                    self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                    self.place = try container.decodeNil(forKey: .place) ? nil : container.decode(String.self, forKey: .place)
                    self.statedBy = try container.decodeNil(forKey: .statedBy) ? nil : container.decode(String.self, forKey: .statedBy)
                    self.sinceMs = try container.decodeNil(forKey: .sinceMs) ? nil : container.decode(Int.self, forKey: .sinceMs)
                    self.icon = try container.decode(String.self, forKey: .icon)
                    self.quiet = try container.decode(Bool.self, forKey: .quiet)
                    self.words = try container.decode([DayRun].self, forKey: .words)
                    self.length = try container.decodeNil(forKey: .length) ? nil : container.decode(String.self, forKey: .length)
                }
            }

            public struct Photo: Decodable, Sendable, Equatable {
                public let hash: String
                public let atMs: Int?
                public let alt: String
                public let video: Bool
                public let durationMs: Int?

                private enum Keys: String, CodingKey {
                    case hash
                    case atMs = "at_ms"
                    case alt
                    case video
                    case durationMs = "duration_ms"
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.hash = try container.decode(String.self, forKey: .hash)
                    self.atMs = try container.decodeNil(forKey: .atMs) ? nil : container.decode(Int.self, forKey: .atMs)
                    self.alt = try container.decode(String.self, forKey: .alt)
                    self.video = try container.decode(Bool.self, forKey: .video)
                    self.durationMs = try container.decodeNil(forKey: .durationMs) ? nil : container.decode(Int.self, forKey: .durationMs)
                }
            }
        }

        public enum DayCount: Decodable, Sendable, Equatable {
            case words(text: String)
            case sent(count: Int)
            case received(count: Int)
            case unknown

            private enum Keys: String, CodingKey {
                case kind
                case text
                case count
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                switch try container.decode(String.self, forKey: .kind) {
                case "words":
                    self = .words(
                        text: try container.decode(String.self, forKey: .text)
                    )
                case "sent":
                    self = .sent(
                        count: try container.decode(Int.self, forKey: .count)
                    )
                case "received":
                    self = .received(
                        count: try container.decode(Int.self, forKey: .count)
                    )
                default:
                    self = .unknown
                }
            }
        }

        public enum DayKind: String, Decodable, Sendable, Equatable {
            case stay
            case move
            case sleep
            case workout
            case sitting
            case phone
            case browsing
            case conversation
            case ai
            case call
            case mailSent = "mail_sent"
            case mailReceived = "mail_received"
            case event
            case note
            case voiceNote = "voice_note"
            case dictation
            case search
            case photos
            case listening
            case checkIn = "check_in"
            case payment
            case other
            case gap
            case unknown

            public init(from decoder: Decoder) throws {
                self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
            }
        }

        public struct DayMessage: Decodable, Sendable, Equatable {
            public let key: String
            public let who: String
            public let name: String
            public let text: String
            public let atMs: Int
            public let mine: Bool
            public let forwarded: Bool
            public let edited: Bool
            public let gone: Bool
            public let event: String?
            public let voice: Voice?
            public let pictures: [Picture]
            public let video: String?
            public let sticker: String?
            public let missing: [Missing]
            public let attachments: [Attachment]
            public let link: Link?
            public let location: Location?
            public let quote: Quote?
            public let reactions: [Reaction]

            private enum Keys: String, CodingKey {
                case key
                case who
                case name
                case text
                case atMs = "at_ms"
                case mine
                case forwarded
                case edited
                case gone
                case event
                case voice
                case pictures
                case video
                case sticker
                case missing
                case attachments
                case link
                case location
                case quote
                case reactions
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.key = try container.decode(String.self, forKey: .key)
                self.who = try container.decode(String.self, forKey: .who)
                self.name = try container.decode(String.self, forKey: .name)
                self.text = try container.decode(String.self, forKey: .text)
                self.atMs = try container.decode(Int.self, forKey: .atMs)
                self.mine = try container.decode(Bool.self, forKey: .mine)
                self.forwarded = try container.decode(Bool.self, forKey: .forwarded)
                self.edited = try container.decode(Bool.self, forKey: .edited)
                self.gone = try container.decode(Bool.self, forKey: .gone)
                self.event = try container.decodeNil(forKey: .event) ? nil : container.decode(String.self, forKey: .event)
                self.voice = try container.decodeNil(forKey: .voice) ? nil : container.decode(Voice.self, forKey: .voice)
                self.pictures = try container.decode([Picture].self, forKey: .pictures)
                self.video = try container.decodeNil(forKey: .video) ? nil : container.decode(String.self, forKey: .video)
                self.sticker = try container.decodeNil(forKey: .sticker) ? nil : container.decode(String.self, forKey: .sticker)
                self.missing = try container.decode([Missing].self, forKey: .missing)
                self.attachments = try container.decode([Attachment].self, forKey: .attachments)
                self.link = try container.decodeNil(forKey: .link) ? nil : container.decode(Link.self, forKey: .link)
                self.location = try container.decodeNil(forKey: .location) ? nil : container.decode(Location.self, forKey: .location)
                self.quote = try container.decodeNil(forKey: .quote) ? nil : container.decode(Quote.self, forKey: .quote)
                self.reactions = try container.decode([Reaction].self, forKey: .reactions)
            }

            public struct Voice: Decodable, Sendable, Equatable {
                public let audio: String?
                public let seconds: Int?
                public let length: String?
                public let transcript: String

                private enum Keys: String, CodingKey {
                    case audio
                    case seconds
                    case length
                    case transcript
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.audio = try container.decodeNil(forKey: .audio) ? nil : container.decode(String.self, forKey: .audio)
                    self.seconds = try container.decodeNil(forKey: .seconds) ? nil : container.decode(Int.self, forKey: .seconds)
                    self.length = try container.decodeNil(forKey: .length) ? nil : container.decode(String.self, forKey: .length)
                    self.transcript = try container.decode(String.self, forKey: .transcript)
                }
            }

            public struct Picture: Decodable, Sendable, Equatable {
                public let hash: String
                public let alt: String

                private enum Keys: String, CodingKey {
                    case hash
                    case alt
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.hash = try container.decode(String.self, forKey: .hash)
                    self.alt = try container.decode(String.self, forKey: .alt)
                }
            }

            public enum Missing: String, Decodable, Sendable, Equatable {
                case photo
                case video
                case unknown

                public init(from decoder: Decoder) throws {
                    self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
                }
            }

            public struct Attachment: Decodable, Sendable, Equatable {
                public let icon: Icon
                public let name: String
                public let line: String

                private enum Keys: String, CodingKey {
                    case icon
                    case name
                    case line
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.icon = try container.decode(Icon.self, forKey: .icon)
                    self.name = try container.decode(String.self, forKey: .name)
                    self.line = try container.decode(String.self, forKey: .line)
                }

                public enum Icon: String, Decodable, Sendable, Equatable {
                    case person
                    case file
                    case unknown

                    public init(from decoder: Decoder) throws {
                        self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
                    }
                }
            }

            public struct Link: Decodable, Sendable, Equatable {
                public let title: String
                public let href: String

                private enum Keys: String, CodingKey {
                    case title
                    case href
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.title = try container.decode(String.self, forKey: .title)
                    self.href = try container.decode(String.self, forKey: .href)
                }
            }

            public struct Location: Decodable, Sendable, Equatable {
                public let name: String
                public let latitude: Double
                public let longitude: Double

                private enum Keys: String, CodingKey {
                    case name
                    case latitude
                    case longitude
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.name = try container.decode(String.self, forKey: .name)
                    self.latitude = try container.decode(Double.self, forKey: .latitude)
                    self.longitude = try container.decode(Double.self, forKey: .longitude)
                }
            }

            public struct Quote: Decodable, Sendable, Equatable {
                public let mine: Bool
                public let name: String
                public let text: String

                private enum Keys: String, CodingKey {
                    case mine
                    case name
                    case text
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.mine = try container.decode(Bool.self, forKey: .mine)
                    self.name = try container.decode(String.self, forKey: .name)
                    self.text = try container.decode(String.self, forKey: .text)
                }
            }

            public struct Reaction: Decodable, Sendable, Equatable {
                public let face: String
                public let mine: Bool
                public let name: String

                private enum Keys: String, CodingKey {
                    case face
                    case mine
                    case name
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.face = try container.decode(String.self, forKey: .face)
                    self.mine = try container.decode(Bool.self, forKey: .mine)
                    self.name = try container.decode(String.self, forKey: .name)
                }
            }
        }

        public struct DayMoment: Decodable, Sendable, Equatable {
            public let key: String
            public let row: String
            public let kind: DayKind
            public let icon: String
            public let title: String
            public let name: String
            public let near: String?
            public let startMs: Int?
            public let endMs: Int?
            public let untimed: String?
            public let lengthMs: Int?
            public let products: [String]
            public let people: [MomentPerson]
            public let place: MomentPlace?
            public let out: MomentOpen?
            public let record: MomentRecord?
            public let letter: Int?
            public let marks: [String]
            public let pictures: [MomentPicture]
            public let source: MomentSource
            public let view: MomentView

            private enum Keys: String, CodingKey {
                case key
                case row
                case kind
                case icon
                case title
                case name
                case near
                case startMs = "start_ms"
                case endMs = "end_ms"
                case untimed
                case lengthMs = "length_ms"
                case products
                case people
                case place
                case out
                case record
                case letter
                case marks
                case pictures
                case source
                case view
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.key = try container.decode(String.self, forKey: .key)
                self.row = try container.decode(String.self, forKey: .row)
                self.kind = try container.decode(DayKind.self, forKey: .kind)
                self.icon = try container.decode(String.self, forKey: .icon)
                self.title = try container.decode(String.self, forKey: .title)
                self.name = try container.decode(String.self, forKey: .name)
                self.near = try container.decodeNil(forKey: .near) ? nil : container.decode(String.self, forKey: .near)
                self.startMs = try container.decodeNil(forKey: .startMs) ? nil : container.decode(Int.self, forKey: .startMs)
                self.endMs = try container.decodeNil(forKey: .endMs) ? nil : container.decode(Int.self, forKey: .endMs)
                self.untimed = try container.decodeNil(forKey: .untimed) ? nil : container.decode(String.self, forKey: .untimed)
                self.lengthMs = try container.decodeNil(forKey: .lengthMs) ? nil : container.decode(Int.self, forKey: .lengthMs)
                self.products = try container.decode([String].self, forKey: .products)
                self.people = try container.decode([MomentPerson].self, forKey: .people)
                self.place = try container.decodeNil(forKey: .place) ? nil : container.decode(MomentPlace.self, forKey: .place)
                self.out = try container.decodeNil(forKey: .out) ? nil : container.decode(MomentOpen.self, forKey: .out)
                self.record = try container.decodeNil(forKey: .record) ? nil : container.decode(MomentRecord.self, forKey: .record)
                self.letter = try container.decodeNil(forKey: .letter) ? nil : container.decode(Int.self, forKey: .letter)
                self.marks = try container.decode([String].self, forKey: .marks)
                self.pictures = try container.decode([MomentPicture].self, forKey: .pictures)
                self.source = try container.decode(MomentSource.self, forKey: .source)
                self.view = try container.decode(MomentView.self, forKey: .view)
            }
        }

        public struct DayName: Decodable, Sendable, Equatable {
            public let text: String
            public let firstRow: String
            public let atMs: Int?

            private enum Keys: String, CodingKey {
                case text
                case firstRow = "first_row"
                case atMs = "at_ms"
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.text = try container.decode(String.self, forKey: .text)
                self.firstRow = try container.decode(String.self, forKey: .firstRow)
                self.atMs = try container.decodeNil(forKey: .atMs) ? nil : container.decode(Int.self, forKey: .atMs)
            }
        }

        public struct DayRow: Decodable, Sendable, Equatable {
            public let key: String
            public let kind: DayKind
            public let atMs: Int?
            public let endMs: Int?
            public let icon: String
            public let name: String
            public let note: String
            public let words: [DayRun]
            public let count: DayCount?
            public let quiet: Bool
            public let focus: String?
            public let divider: String?

            private enum Keys: String, CodingKey {
                case key
                case kind
                case atMs = "at_ms"
                case endMs = "end_ms"
                case icon
                case name
                case note
                case words
                case count
                case quiet
                case focus
                case divider
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.key = try container.decode(String.self, forKey: .key)
                self.kind = try container.decode(DayKind.self, forKey: .kind)
                self.atMs = try container.decodeNil(forKey: .atMs) ? nil : container.decode(Int.self, forKey: .atMs)
                self.endMs = try container.decodeNil(forKey: .endMs) ? nil : container.decode(Int.self, forKey: .endMs)
                self.icon = try container.decode(String.self, forKey: .icon)
                self.name = try container.decode(String.self, forKey: .name)
                self.note = try container.decode(String.self, forKey: .note)
                self.words = try container.decode([DayRun].self, forKey: .words)
                self.count = try container.decodeNil(forKey: .count) ? nil : container.decode(DayCount.self, forKey: .count)
                self.quiet = try container.decode(Bool.self, forKey: .quiet)
                self.focus = try container.decodeNil(forKey: .focus) ? nil : container.decode(String.self, forKey: .focus)
                self.divider = try container.decodeNil(forKey: .divider) ? nil : container.decode(String.self, forKey: .divider)
            }
        }

        public enum DayRun: Decodable, Sendable, Equatable {
            case text(text: String, tone: RunTone, title: Bool)
            case quote(text: String)
            case list(items: [String])
            case span(text: String, tone: RunTone, startMs: Int, endMs: Int)
            case titles(items: [String])
            case tiles(photos: [Tile], more: Int)
            case unknown

            private enum Keys: String, CodingKey {
                case type
                case text
                case tone
                case title
                case items
                case startMs = "start_ms"
                case endMs = "end_ms"
                case photos
                case more
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                switch try container.decode(String.self, forKey: .type) {
                case "text":
                    self = .text(
                        text: try container.decode(String.self, forKey: .text),
                        tone: try container.decode(RunTone.self, forKey: .tone),
                        title: try container.decode(Bool.self, forKey: .title)
                    )
                case "quote":
                    self = .quote(
                        text: try container.decode(String.self, forKey: .text)
                    )
                case "list":
                    self = .list(
                        items: try container.decode([String].self, forKey: .items)
                    )
                case "span":
                    self = .span(
                        text: try container.decode(String.self, forKey: .text),
                        tone: try container.decode(RunTone.self, forKey: .tone),
                        startMs: try container.decode(Int.self, forKey: .startMs),
                        endMs: try container.decode(Int.self, forKey: .endMs)
                    )
                case "titles":
                    self = .titles(
                        items: try container.decode([String].self, forKey: .items)
                    )
                case "tiles":
                    self = .tiles(
                        photos: try container.decode([Tile].self, forKey: .photos),
                        more: try container.decode(Int.self, forKey: .more)
                    )
                default:
                    self = .unknown
                }
            }
        }

        public struct DaySide: Decodable, Sendable, Equatable {
            public let figures: [SideFigure]
            public let located: Bool
            public let places: [SidePlace]
            public let people: [SidePerson]
            public let groups: [SideGroup]
            public let unreturned: [SideCall]

            private enum Keys: String, CodingKey {
                case figures
                case located
                case places
                case people
                case groups
                case unreturned
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.figures = try container.decode([SideFigure].self, forKey: .figures)
                self.located = try container.decode(Bool.self, forKey: .located)
                self.places = try container.decode([SidePlace].self, forKey: .places)
                self.people = try container.decode([SidePerson].self, forKey: .people)
                self.groups = try container.decode([SideGroup].self, forKey: .groups)
                self.unreturned = try container.decode([SideCall].self, forKey: .unreturned)
            }
        }

        public enum DayState: String, Decodable, Sendable, Equatable {
            case ready
            case rendering
            case empty
            case unknown

            public init(from decoder: Decoder) throws {
                self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
            }
        }

        public struct Details: Decodable, Sendable, Equatable {
            public let work: String?
            public let birthday: Birthday?
            public let profiles: [Profile]
            public let cleared: [Cleared]

            private enum Keys: String, CodingKey {
                case work
                case birthday
                case profiles
                case cleared
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.work = try container.decodeNil(forKey: .work) ? nil : container.decode(String.self, forKey: .work)
                self.birthday = try container.decodeNil(forKey: .birthday) ? nil : container.decode(Birthday.self, forKey: .birthday)
                self.profiles = try container.decode([Profile].self, forKey: .profiles)
                self.cleared = try container.decode([Cleared].self, forKey: .cleared)
            }

            public struct Birthday: Decodable, Sendable, Equatable {
                public let month: Int
                public let day: Int
                public let year: Int?

                private enum Keys: String, CodingKey {
                    case month
                    case day
                    case year
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.month = try container.decode(Int.self, forKey: .month)
                    self.day = try container.decode(Int.self, forKey: .day)
                    self.year = try container.decodeNil(forKey: .year) ? nil : container.decode(Int.self, forKey: .year)
                }
            }

            public enum Cleared: String, Decodable, Sendable, Equatable {
                case work
                case birthday
                case profiles
                case unknown

                public init(from decoder: Decoder) throws {
                    self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
                }
            }
        }

        public enum Entity: String, Decodable, Sendable, Equatable {
            case person
            case ai
            case business
            case bot
            case unknown

            public init(from decoder: Decoder) throws {
                self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
            }
        }

        public struct EventWhere: Decodable, Sendable, Equatable {
            public let text: String
            public let href: String

            private enum Keys: String, CodingKey {
                case text
                case href
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.text = try container.decode(String.self, forKey: .text)
                self.href = try container.decode(String.self, forKey: .href)
            }
        }

        public struct FeedbackAttachment: Decodable, Sendable, Equatable {
            public let kind: FeedbackKind
            public let title: String
            public let text: String

            private enum Keys: String, CodingKey {
                case kind
                case title
                case text
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.kind = try container.decode(FeedbackKind.self, forKey: .kind)
                self.title = try container.decode(String.self, forKey: .title)
                self.text = try container.decode(String.self, forKey: .text)
            }
        }

        public struct FeedbackDraft: Decodable, Sendable, Equatable {
            public let attachments: [FeedbackAttachment]
            public let email: String?

            private enum Keys: String, CodingKey {
                case attachments
                case email
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.attachments = try container.decode([FeedbackAttachment].self, forKey: .attachments)
                self.email = try container.decodeNil(forKey: .email) ? nil : container.decode(String.self, forKey: .email)
            }
        }

        public enum FeedbackKind: String, Decodable, Sendable, Equatable {
            case answer
            case connector
            case app
            case screenshot
            case unknown

            public init(from decoder: Decoder) throws {
                self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
            }
        }

        public struct Frame: Decodable, Sendable, Equatable {
            public let north: Double
            public let south: Double
            public let east: Double
            public let west: Double

            private enum Keys: String, CodingKey {
                case north
                case south
                case east
                case west
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.north = try container.decode(Double.self, forKey: .north)
                self.south = try container.decode(Double.self, forKey: .south)
                self.east = try container.decode(Double.self, forKey: .east)
                self.west = try container.decode(Double.self, forKey: .west)
            }
        }

        public struct Guide: Decodable, Sendable, Equatable {
            public let app: App
            public let name: String
            public let mark: String
            public let line: String?
            public let how: How
            public let connected: String?
            public let head: String
            public let need: String
            public let hosts: [String]
            public let address: GuideAddress?
            public let steps: [GuideStep]
            public let done: Done

            private enum Keys: String, CodingKey {
                case app
                case name
                case mark
                case line
                case how
                case connected
                case head
                case need
                case hosts
                case address
                case steps
                case done
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.app = try container.decode(App.self, forKey: .app)
                self.name = try container.decode(String.self, forKey: .name)
                self.mark = try container.decode(String.self, forKey: .mark)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                self.how = try container.decode(How.self, forKey: .how)
                self.connected = try container.decodeNil(forKey: .connected) ? nil : container.decode(String.self, forKey: .connected)
                self.head = try container.decode(String.self, forKey: .head)
                self.need = try container.decode(String.self, forKey: .need)
                self.hosts = try container.decode([String].self, forKey: .hosts)
                self.address = try container.decodeNil(forKey: .address) ? nil : container.decode(GuideAddress.self, forKey: .address)
                self.steps = try container.decode([GuideStep].self, forKey: .steps)
                self.done = try container.decode(Done.self, forKey: .done)
            }

            public enum App: String, Decodable, Sendable, Equatable {
                case claude
                case chatgpt
                case muse
                case grokBot = "grok-bot"
                case instinct
                case another
                case unknown

                public init(from decoder: Decoder) throws {
                    self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
                }
            }

            public enum How: String, Decodable, Sendable, Equatable {
                case signIn = "sign-in"
                case key
                case unknown

                public init(from decoder: Decoder) throws {
                    self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
                }
            }

            public struct Done: Decodable, Sendable, Equatable {
                public let title: String
                public let ask: Ask?
                public let `open`: GuideLink?

                private enum Keys: String, CodingKey {
                    case title
                    case ask
                    case `open`
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.title = try container.decode(String.self, forKey: .title)
                    self.ask = try container.decodeNil(forKey: .ask) ? nil : container.decode(Ask.self, forKey: .ask)
                    self.`open` = try container.decodeNil(forKey: .`open`) ? nil : container.decode(GuideLink.self, forKey: .`open`)
                }

                public struct Ask: Decodable, Sendable, Equatable {
                    public let title: String
                    public let line: String
                    public let question: String

                    private enum Keys: String, CodingKey {
                        case title
                        case line
                        case question
                    }

                    public init(from decoder: Decoder) throws {
                        let container = try decoder.container(keyedBy: Keys.self)
                        self.title = try container.decode(String.self, forKey: .title)
                        self.line = try container.decode(String.self, forKey: .line)
                        self.question = try container.decode(String.self, forKey: .question)
                    }
                }
            }
        }

        public struct GuideAddress: Decodable, Sendable, Equatable {
            public let title: String
            public let line: String
            public let ready: String
            public let on: String

            private enum Keys: String, CodingKey {
                case title
                case line
                case ready
                case on
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.title = try container.decode(String.self, forKey: .title)
                self.line = try container.decode(String.self, forKey: .line)
                self.ready = try container.decode(String.self, forKey: .ready)
                self.on = try container.decode(String.self, forKey: .on)
            }
        }

        public enum GuideLink: Decodable, Sendable, Equatable {
            case web(label: String, url: String)
            case messages(label: String)
            case unknown

            private enum Keys: String, CodingKey {
                case to
                case label
                case url
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                switch try container.decode(String.self, forKey: .to) {
                case "web":
                    self = .web(
                        label: try container.decode(String.self, forKey: .label),
                        url: try container.decode(String.self, forKey: .url)
                    )
                case "messages":
                    self = .messages(
                        label: try container.decode(String.self, forKey: .label)
                    )
                default:
                    self = .unknown
                }
            }
        }

        public enum GuideStep: Decodable, Sendable, Equatable {
            case add(title: String, `where`: String, path: [String], values: [GuideValue], then: String?, `open`: GuideLink?)
            case message(title: String, line: String, value: GuideValue, `open`: GuideLink?, next: String?)
            case yes(title: String, line: String, wait: String, hint: String, sees: String, other: String, wrong: String, finishing: String, unfinished: String, out: String, denied: String, reads: String)
            case name(title: String, placeholder: String)
            case sees(title: String, make: String, sees: String)
            case give(title: String, `where`: String?, path: [String], then: String?, warn: String?, once: String, unknown: String)
            case elsewhere(title: String, line: String)
            case unknown

            private enum Keys: String, CodingKey {
                case kind
                case title
                case `where`
                case path
                case values
                case then
                case `open`
                case line
                case value
                case next
                case wait
                case hint
                case sees
                case other
                case wrong
                case finishing
                case unfinished
                case out
                case denied
                case reads
                case placeholder
                case make
                case warn
                case once
                case unknown
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                switch try container.decode(String.self, forKey: .kind) {
                case "add":
                    self = .add(
                        title: try container.decode(String.self, forKey: .title),
                        where: try container.decode(String.self, forKey: .`where`),
                        path: try container.decode([String].self, forKey: .path),
                        values: try container.decode([GuideValue].self, forKey: .values),
                        then: try container.decodeNil(forKey: .then) ? nil : container.decode(String.self, forKey: .then),
                        open: try container.decodeNil(forKey: .`open`) ? nil : container.decode(GuideLink.self, forKey: .`open`)
                    )
                case "message":
                    self = .message(
                        title: try container.decode(String.self, forKey: .title),
                        line: try container.decode(String.self, forKey: .line),
                        value: try container.decode(GuideValue.self, forKey: .value),
                        open: try container.decodeNil(forKey: .`open`) ? nil : container.decode(GuideLink.self, forKey: .`open`),
                        next: try container.decodeNil(forKey: .next) ? nil : container.decode(String.self, forKey: .next)
                    )
                case "yes":
                    self = .yes(
                        title: try container.decode(String.self, forKey: .title),
                        line: try container.decode(String.self, forKey: .line),
                        wait: try container.decode(String.self, forKey: .wait),
                        hint: try container.decode(String.self, forKey: .hint),
                        sees: try container.decode(String.self, forKey: .sees),
                        other: try container.decode(String.self, forKey: .other),
                        wrong: try container.decode(String.self, forKey: .wrong),
                        finishing: try container.decode(String.self, forKey: .finishing),
                        unfinished: try container.decode(String.self, forKey: .unfinished),
                        out: try container.decode(String.self, forKey: .out),
                        denied: try container.decode(String.self, forKey: .denied),
                        reads: try container.decode(String.self, forKey: .reads)
                    )
                case "name":
                    self = .name(
                        title: try container.decode(String.self, forKey: .title),
                        placeholder: try container.decode(String.self, forKey: .placeholder)
                    )
                case "sees":
                    self = .sees(
                        title: try container.decode(String.self, forKey: .title),
                        make: try container.decode(String.self, forKey: .make),
                        sees: try container.decode(String.self, forKey: .sees)
                    )
                case "give":
                    self = .give(
                        title: try container.decode(String.self, forKey: .title),
                        where: try container.decodeNil(forKey: .`where`) ? nil : container.decode(String.self, forKey: .`where`),
                        path: try container.decode([String].self, forKey: .path),
                        then: try container.decodeNil(forKey: .then) ? nil : container.decode(String.self, forKey: .then),
                        warn: try container.decodeNil(forKey: .warn) ? nil : container.decode(String.self, forKey: .warn),
                        once: try container.decode(String.self, forKey: .once),
                        unknown: try container.decode(String.self, forKey: .unknown)
                    )
                case "elsewhere":
                    self = .elsewhere(
                        title: try container.decode(String.self, forKey: .title),
                        line: try container.decode(String.self, forKey: .line)
                    )
                default:
                    self = .unknown
                }
            }
        }

        public struct GuideValue: Decodable, Sendable, Equatable {
            public let label: String
            public let text: String
            public let address: Bool

            private enum Keys: String, CodingKey {
                case label
                case text
                case address
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.label = try container.decode(String.self, forKey: .label)
                self.text = try container.decode(String.self, forKey: .text)
                self.address = try container.decode(Bool.self, forKey: .address)
            }
        }

        public enum HandleKind: String, Decodable, Sendable, Equatable {
            case phone
            case email
            case jid
            case network
            case unknown

            public init(from decoder: Decoder) throws {
                self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
            }
        }

        public struct Health: Decodable, Sendable, Equatable {
            public let state: State
            public let reason: HealthReason?
            public let words: String
            public let sinceMs: Int?
            public let nextMs: Int?
            public let acts: [Act]
            public let detail: String?
            public let line: String?

            private enum Keys: String, CodingKey {
                case state
                case reason
                case words
                case sinceMs = "since_ms"
                case nextMs = "next_ms"
                case acts
                case detail
                case line
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.state = try container.decode(State.self, forKey: .state)
                self.reason = try container.decodeNil(forKey: .reason) ? nil : container.decode(HealthReason.self, forKey: .reason)
                self.words = try container.decode(String.self, forKey: .words)
                self.sinceMs = try container.decodeNil(forKey: .sinceMs) ? nil : container.decode(Int.self, forKey: .sinceMs)
                self.nextMs = try container.decodeNil(forKey: .nextMs) ? nil : container.decode(Int.self, forKey: .nextMs)
                self.acts = try container.decode([Act].self, forKey: .acts)
                self.detail = try container.decodeNil(forKey: .detail) ? nil : container.decode(String.self, forKey: .detail)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
            }
        }

        public enum HealthReason: String, Decodable, Sendable, Equatable {
            case form
            case signIn = "sign-in"
            case choose
            case app
            case grant
            case pair
            case export
            case install
            case signedOut = "signed-out"
            case otherAccount = "other-account"
            case confirm
            case password
            case `extension`
            case providerChanged = "provider-changed"
            case offline
            case chrome
            case providerLimit = "provider-limit"
            case providerMaking = "provider-making"
            case disk
            case power
            case vault
            case retrying
            case metered
            case door
            case failing
            case `import`
            case missingFile = "missing-file"
            case nothingNew = "nothing-new"
            case device
            case unknown

            public init(from decoder: Decoder) throws {
                self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
            }
        }

        public struct HiddenRow: Decodable, Sendable, Equatable {
            public let key: String
            public let latitude: Double
            public let longitude: Double
            public let hidden: When
            public let line: String?

            private enum Keys: String, CodingKey {
                case key
                case latitude
                case longitude
                case hidden
                case line
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.key = try container.decode(String.self, forKey: .key)
                self.latitude = try container.decode(Double.self, forKey: .latitude)
                self.longitude = try container.decode(Double.self, forKey: .longitude)
                self.hidden = try container.decode(When.self, forKey: .hidden)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
            }
        }

        public enum History: Decodable, Sendable, Equatable {
            case weeks(weeks: [Week], marked: Int?)
            case years(years: [HistoryYear], total: Int, marked: Int?)
            case facts(total: Int, first: String?)
            case unknown

            private enum Keys: String, CodingKey {
                case kind
                case weeks
                case marked
                case years
                case total
                case first
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                switch try container.decode(String.self, forKey: .kind) {
                case "weeks":
                    self = .weeks(
                        weeks: try container.decode([Week].self, forKey: .weeks),
                        marked: try container.decodeNil(forKey: .marked) ? nil : container.decode(Int.self, forKey: .marked)
                    )
                case "years":
                    self = .years(
                        years: try container.decode([HistoryYear].self, forKey: .years),
                        total: try container.decode(Int.self, forKey: .total),
                        marked: try container.decodeNil(forKey: .marked) ? nil : container.decode(Int.self, forKey: .marked)
                    )
                case "facts":
                    self = .facts(
                        total: try container.decode(Int.self, forKey: .total),
                        first: try container.decodeNil(forKey: .first) ? nil : container.decode(String.self, forKey: .first)
                    )
                default:
                    self = .unknown
                }
            }
        }

        public struct HistoryYear: Decodable, Sendable, Equatable {
            public let year: String
            public let count: Int
            public let day: String?

            private enum Keys: String, CodingKey {
                case year
                case count
                case day
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.year = try container.decode(String.self, forKey: .year)
                self.count = try container.decode(Int.self, forKey: .count)
                self.day = try container.decodeNil(forKey: .day) ? nil : container.decode(String.self, forKey: .day)
            }
        }

        public struct HomeAsk: Decodable, Sendable, Equatable {
            public let line: String
            public let since: When

            private enum Keys: String, CodingKey {
                case line
                case since
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.line = try container.decode(String.self, forKey: .line)
                self.since = try container.decode(When.self, forKey: .since)
            }
        }

        public struct KindSection: Decodable, Sendable, Equatable {
            public let family: SearchFamily
            public let title: String
            public let count: Count?
            public let upcoming: Count?
            public let see: Bool
            public let unread: String?
            public let rows: [SearchRow]

            private enum Keys: String, CodingKey {
                case family
                case title
                case count
                case upcoming
                case see
                case unread
                case rows
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.family = try container.decode(SearchFamily.self, forKey: .family)
                self.title = try container.decode(String.self, forKey: .title)
                self.count = try container.decodeNil(forKey: .count) ? nil : container.decode(Count.self, forKey: .count)
                self.upcoming = try container.decodeNil(forKey: .upcoming) ? nil : container.decode(Count.self, forKey: .upcoming)
                self.see = try container.decode(Bool.self, forKey: .see)
                self.unread = try container.decodeNil(forKey: .unread) ? nil : container.decode(String.self, forKey: .unread)
                self.rows = try container.decode([SearchRow].self, forKey: .rows)
            }
        }

        public struct Letter: Decodable, Sendable, Equatable {
            public let atMs: Int?
            public let from: String
            public let to: String
            public let subject: String
            public let words: String
            public let attached: [String]
            public let address: String?
            public let person: String?
            public let personId: String?
            public let record: MomentRecord?

            private enum Keys: String, CodingKey {
                case atMs = "at_ms"
                case from
                case to
                case subject
                case words
                case attached
                case address
                case person
                case personId = "person_id"
                case record
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.atMs = try container.decodeNil(forKey: .atMs) ? nil : container.decode(Int.self, forKey: .atMs)
                self.from = try container.decode(String.self, forKey: .from)
                self.to = try container.decode(String.self, forKey: .to)
                self.subject = try container.decode(String.self, forKey: .subject)
                self.words = try container.decode(String.self, forKey: .words)
                self.attached = try container.decode([String].self, forKey: .attached)
                self.address = try container.decodeNil(forKey: .address) ? nil : container.decode(String.self, forKey: .address)
                self.person = try container.decodeNil(forKey: .person) ? nil : container.decode(String.self, forKey: .person)
                self.personId = try container.decodeNil(forKey: .personId) ? nil : container.decode(String.self, forKey: .personId)
                self.record = try container.decodeNil(forKey: .record) ? nil : container.decode(MomentRecord.self, forKey: .record)
            }
        }

        public struct Made: Decodable, Sendable, Equatable {
            public let by: String?
            public let atMs: Int?
            public let state: MadeState
            public let line: String?
            public let ask: MadeAsk?
            public let choose: [MadeStep]

            private enum Keys: String, CodingKey {
                case by
                case atMs = "at_ms"
                case state
                case line
                case ask
                case choose
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.by = try container.decodeNil(forKey: .by) ? nil : container.decode(String.self, forKey: .by)
                self.atMs = try container.decodeNil(forKey: .atMs) ? nil : container.decode(Int.self, forKey: .atMs)
                self.state = try container.decode(MadeState.self, forKey: .state)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                self.ask = try container.decodeNil(forKey: .ask) ? nil : container.decode(MadeAsk.self, forKey: .ask)
                self.choose = try container.decode([MadeStep].self, forKey: .choose)
            }
        }

        public struct MadeAsk: Decodable, Sendable, Equatable {
            public let family: String
            public let item: String
            public let prompt: String

            private enum Keys: String, CodingKey {
                case family
                case item
                case prompt
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.family = try container.decode(String.self, forKey: .family)
                self.item = try container.decode(String.self, forKey: .item)
                self.prompt = try container.decode(String.self, forKey: .prompt)
            }
        }

        public enum MadeState: String, Decodable, Sendable, Equatable {
            case done
            case off
            case needs
            case waiting
            case failed
            case unknown

            public init(from decoder: Decoder) throws {
                self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
            }
        }

        public struct MadeStep: Decodable, Sendable, Equatable {
            public let value: String
            public let words: String
            public let note: String?

            private enum Keys: String, CodingKey {
                case value
                case words
                case note
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.value = try container.decode(String.self, forKey: .value)
                self.words = try container.decode(String.self, forKey: .words)
                self.note = try container.decodeNil(forKey: .note) ? nil : container.decode(String.self, forKey: .note)
            }
        }

        public struct Mail: Decodable, Sendable, Equatable {
            public let family: Family
            public let title: String?
            public let from: String?
            public let day: String?

            private enum Keys: String, CodingKey {
                case family
                case title
                case from
                case day
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.family = try container.decode(Family.self, forKey: .family)
                self.title = try container.decodeNil(forKey: .title) ? nil : container.decode(String.self, forKey: .title)
                self.from = try container.decodeNil(forKey: .from) ? nil : container.decode(String.self, forKey: .from)
                self.day = try container.decodeNil(forKey: .day) ? nil : container.decode(String.self, forKey: .day)
            }

            public enum Family: String, Decodable, Sendable, Equatable {
                case mail
                case calendar
                case unknown

                public init(from decoder: Decoder) throws {
                    self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
                }
            }
        }

        public enum ModelConnection: Decodable, Sendable, Equatable {
            case plan(id: String, name: String, line: String?, signed: Bool, words: String)
            case key(id: String, name: String, line: String?, held: Bool, words: String?, key: ModelKeyField)
            case runner(id: String, unit: String, place: String, name: String, line: String?, none: String?, run: ModelSwitch?, battery: ModelSwitch?, files: [ModelFile], found: [ModelFound], paused: Bool)
            case address(id: String, label: String, url: String?, line: String?, words: ModelServerWords)
            case unknown

            private enum Keys: String, CodingKey {
                case kind
                case id
                case name
                case line
                case signed
                case words
                case held
                case key
                case unit
                case place
                case none
                case run
                case battery
                case files
                case found
                case paused
                case label
                case url
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                switch try container.decode(String.self, forKey: .kind) {
                case "plan":
                    self = .plan(
                        id: try container.decode(String.self, forKey: .id),
                        name: try container.decode(String.self, forKey: .name),
                        line: try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line),
                        signed: try container.decode(Bool.self, forKey: .signed),
                        words: try container.decode(String.self, forKey: .words)
                    )
                case "key":
                    self = .key(
                        id: try container.decode(String.self, forKey: .id),
                        name: try container.decode(String.self, forKey: .name),
                        line: try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line),
                        held: try container.decode(Bool.self, forKey: .held),
                        words: try container.decodeNil(forKey: .words) ? nil : container.decode(String.self, forKey: .words),
                        key: try container.decode(ModelKeyField.self, forKey: .key)
                    )
                case "runner":
                    self = .runner(
                        id: try container.decode(String.self, forKey: .id),
                        unit: try container.decode(String.self, forKey: .unit),
                        place: try container.decode(String.self, forKey: .place),
                        name: try container.decode(String.self, forKey: .name),
                        line: try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line),
                        none: try container.decodeNil(forKey: .none) ? nil : container.decode(String.self, forKey: .none),
                        run: try container.decodeNil(forKey: .run) ? nil : container.decode(ModelSwitch.self, forKey: .run),
                        battery: try container.decodeNil(forKey: .battery) ? nil : container.decode(ModelSwitch.self, forKey: .battery),
                        files: try container.decode([ModelFile].self, forKey: .files),
                        found: try container.decode([ModelFound].self, forKey: .found),
                        paused: try container.decode(Bool.self, forKey: .paused)
                    )
                case "address":
                    self = .address(
                        id: try container.decode(String.self, forKey: .id),
                        label: try container.decode(String.self, forKey: .label),
                        url: try container.decodeNil(forKey: .url) ? nil : container.decode(String.self, forKey: .url),
                        line: try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line),
                        words: try container.decode(ModelServerWords.self, forKey: .words)
                    )
                default:
                    self = .unknown
                }
            }
        }

        public struct ModelFile: Decodable, Sendable, Equatable {
            public let id: String
            public let name: String
            public let line: String
            public let working: Bool
            public let state: ModelFileState
            public let fits: Bool
            public let words: String?
            public let acts: [ModelFileAct]

            private enum Keys: String, CodingKey {
                case id
                case name
                case line
                case working
                case state
                case fits
                case words
                case acts
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.id = try container.decode(String.self, forKey: .id)
                self.name = try container.decode(String.self, forKey: .name)
                self.line = try container.decode(String.self, forKey: .line)
                self.working = try container.decode(Bool.self, forKey: .working)
                self.state = try container.decode(ModelFileState.self, forKey: .state)
                self.fits = try container.decode(Bool.self, forKey: .fits)
                self.words = try container.decodeNil(forKey: .words) ? nil : container.decode(String.self, forKey: .words)
                self.acts = try container.decode([ModelFileAct].self, forKey: .acts)
            }
        }

        public struct ModelFileAct: Decodable, Sendable, Equatable {
            public let act: ModelFileDo
            public let words: String

            private enum Keys: String, CodingKey {
                case act
                case words
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.act = try container.decode(ModelFileDo.self, forKey: .act)
                self.words = try container.decode(String.self, forKey: .words)
            }
        }

        public enum ModelFileDo: String, Decodable, Sendable, Equatable {
            case fetch
            case remove
            case cancel
            case unknown

            public init(from decoder: Decoder) throws {
                self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
            }
        }

        public enum ModelFileState: String, Decodable, Sendable, Equatable {
            case absent
            case fetching
            case ready
            case failed
            case unknown

            public init(from decoder: Decoder) throws {
                self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
            }
        }

        public struct ModelFound: Decodable, Sendable, Equatable {
            public let name: String
            public let size: String
            public let from: String

            private enum Keys: String, CodingKey {
                case name
                case size
                case from
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.name = try container.decode(String.self, forKey: .name)
                self.size = try container.decode(String.self, forKey: .size)
                self.from = try container.decode(String.self, forKey: .from)
            }
        }

        public struct ModelGroup: Decodable, Sendable, Equatable {
            public let label: String
            public let rows: [ModelRow]

            private enum Keys: String, CodingKey {
                case label
                case rows
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.label = try container.decode(String.self, forKey: .label)
                self.rows = try container.decode([ModelRow].self, forKey: .rows)
            }
        }

        public struct ModelKeyField: Decodable, Sendable, Equatable {
            public let label: String
            public let placeholder: String
            public let add: String
            public let remove: String

            private enum Keys: String, CodingKey {
                case label
                case placeholder
                case add
                case remove
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.label = try container.decode(String.self, forKey: .label)
                self.placeholder = try container.decode(String.self, forKey: .placeholder)
                self.add = try container.decode(String.self, forKey: .add)
                self.remove = try container.decode(String.self, forKey: .remove)
            }
        }

        public struct ModelLevel: Decodable, Sendable, Equatable {
            public let value: String
            public let name: String
            public let chosen: Bool
            public let suggested: Bool

            private enum Keys: String, CodingKey {
                case value
                case name
                case chosen
                case suggested
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.value = try container.decode(String.self, forKey: .value)
                self.name = try container.decode(String.self, forKey: .name)
                self.chosen = try container.decode(Bool.self, forKey: .chosen)
                self.suggested = try container.decode(Bool.self, forKey: .suggested)
            }
        }

        public struct ModelMenu: Decodable, Sendable, Equatable {
            public let `default`: ModelRow?
            public let rows: [ModelRow]
            public let local: ModelGroup?
            public let more: ModelMore
            public let off: ModelRow?

            private enum Keys: String, CodingKey {
                case `default`
                case rows
                case local
                case more
                case off
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.`default` = try container.decodeNil(forKey: .`default`) ? nil : container.decode(ModelRow.self, forKey: .`default`)
                self.rows = try container.decode([ModelRow].self, forKey: .rows)
                self.local = try container.decodeNil(forKey: .local) ? nil : container.decode(ModelGroup.self, forKey: .local)
                self.more = try container.decode(ModelMore.self, forKey: .more)
                self.off = try container.decodeNil(forKey: .off) ? nil : container.decode(ModelRow.self, forKey: .off)
            }
        }

        public struct ModelMore: Decodable, Sendable, Equatable {
            public let words: String
            public let use: ModelUseId
            public let work: String?

            private enum Keys: String, CodingKey {
                case words
                case use
                case work
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.words = try container.decode(String.self, forKey: .words)
                self.use = try container.decode(ModelUseId.self, forKey: .use)
                self.work = try container.decodeNil(forKey: .work) ? nil : container.decode(String.self, forKey: .work)
            }
        }

        public struct ModelRow: Decodable, Sendable, Equatable {
            public let value: String
            public let name: String
            public let account: String?
            public let chosen: Bool

            private enum Keys: String, CodingKey {
                case value
                case name
                case account
                case chosen
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.value = try container.decode(String.self, forKey: .value)
                self.name = try container.decode(String.self, forKey: .name)
                self.account = try container.decodeNil(forKey: .account) ? nil : container.decode(String.self, forKey: .account)
                self.chosen = try container.decode(Bool.self, forKey: .chosen)
            }
        }

        public struct ModelServerWords: Decodable, Sendable, Equatable {
            public let about: String
            public let add: String
            public let remove: String
            public let field: String
            public let placeholder: String
            public let save: String

            private enum Keys: String, CodingKey {
                case about
                case add
                case remove
                case field
                case placeholder
                case save
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.about = try container.decode(String.self, forKey: .about)
                self.add = try container.decode(String.self, forKey: .add)
                self.remove = try container.decode(String.self, forKey: .remove)
                self.field = try container.decode(String.self, forKey: .field)
                self.placeholder = try container.decode(String.self, forKey: .placeholder)
                self.save = try container.decode(String.self, forKey: .save)
            }
        }

        public struct ModelSwitch: Decodable, Sendable, Equatable {
            public let label: String
            public let on: Bool
            public let line: String?

            private enum Keys: String, CodingKey {
                case label
                case on
                case line
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.label = try container.decode(String.self, forKey: .label)
                self.on = try container.decode(Bool.self, forKey: .on)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
            }
        }

        public struct ModelThinking: Decodable, Sendable, Equatable {
            public let label: String
            public let value: String
            public let words: String
            public let levels: [ModelLevel]

            private enum Keys: String, CodingKey {
                case label
                case value
                case words
                case levels
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.label = try container.decode(String.self, forKey: .label)
                self.value = try container.decode(String.self, forKey: .value)
                self.words = try container.decode(String.self, forKey: .words)
                self.levels = try container.decode([ModelLevel].self, forKey: .levels)
            }
        }

        public struct ModelUse: Decodable, Sendable, Equatable {
            public let use: ModelUseId
            public let label: String
            public let line: String?
            public let working: Bool
            public let words: String
            public let value: String?
            public let leaves: Bool
            public let thinking: ModelThinking?
            public let menu: ModelMenu

            private enum Keys: String, CodingKey {
                case use
                case label
                case line
                case working
                case words
                case value
                case leaves
                case thinking
                case menu
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.use = try container.decode(ModelUseId.self, forKey: .use)
                self.label = try container.decode(String.self, forKey: .label)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                self.working = try container.decode(Bool.self, forKey: .working)
                self.words = try container.decode(String.self, forKey: .words)
                self.value = try container.decodeNil(forKey: .value) ? nil : container.decode(String.self, forKey: .value)
                self.leaves = try container.decode(Bool.self, forKey: .leaves)
                self.thinking = try container.decodeNil(forKey: .thinking) ? nil : container.decode(ModelThinking.self, forKey: .thinking)
                self.menu = try container.decode(ModelMenu.self, forKey: .menu)
            }
        }

        public enum ModelUseId: String, Decodable, Sendable, Equatable {
            case pictures
            case audio
            case text
            case chat
            case search
            case hiding
            case unknown

            public init(from decoder: Decoder) throws {
                self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
            }
        }

        public struct MomentAction: Decodable, Sendable, Equatable {
            public let atMs: Int
            public let what: String

            private enum Keys: String, CodingKey {
                case atMs = "at_ms"
                case what
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.atMs = try container.decode(Int.self, forKey: .atMs)
                self.what = try container.decode(String.self, forKey: .what)
            }
        }

        public struct MomentApp: Decodable, Sendable, Equatable {
            public let name: String
            public let minutes: Double?

            private enum Keys: String, CodingKey {
                case name
                case minutes
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.name = try container.decode(String.self, forKey: .name)
                self.minutes = try container.decodeNil(forKey: .minutes) ? nil : container.decode(Double.self, forKey: .minutes)
            }
        }

        public struct MomentFact: Decodable, Sendable, Equatable {
            public let label: String
            public let value: String

            private enum Keys: String, CodingKey {
                case label
                case value
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.label = try container.decode(String.self, forKey: .label)
                self.value = try container.decode(String.self, forKey: .value)
            }
        }

        public struct MomentOpen: Decodable, Sendable, Equatable {
            public let label: String
            public let href: String

            private enum Keys: String, CodingKey {
                case label
                case href
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.label = try container.decode(String.self, forKey: .label)
                self.href = try container.decode(String.self, forKey: .href)
            }
        }

        public struct MomentPerson: Decodable, Sendable, Equatable {
            public let name: String
            public let person: String?
            public let chat: String?
            public let call: MomentRecord?

            private enum Keys: String, CodingKey {
                case name
                case person
                case chat
                case call
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.name = try container.decode(String.self, forKey: .name)
                self.person = try container.decodeNil(forKey: .person) ? nil : container.decode(String.self, forKey: .person)
                self.chat = try container.decodeNil(forKey: .chat) ? nil : container.decode(String.self, forKey: .chat)
                self.call = try container.decodeNil(forKey: .call) ? nil : container.decode(MomentRecord.self, forKey: .call)
            }
        }

        public struct MomentPicture: Decodable, Sendable, Equatable {
            public let hash: String
            public let alt: String
            public let words: String
            public let video: Bool
            public let durationMs: Int?
            public let live: Bool

            private enum Keys: String, CodingKey {
                case hash
                case alt
                case words
                case video
                case durationMs = "duration_ms"
                case live
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.hash = try container.decode(String.self, forKey: .hash)
                self.alt = try container.decode(String.self, forKey: .alt)
                self.words = try container.decode(String.self, forKey: .words)
                self.video = try container.decode(Bool.self, forKey: .video)
                self.durationMs = try container.decodeNil(forKey: .durationMs) ? nil : container.decode(Int.self, forKey: .durationMs)
                self.live = try container.decode(Bool.self, forKey: .live)
            }
        }

        public struct MomentPlace: Decodable, Sendable, Equatable {
            public let name: String
            public let unit: String
            public let slug: String?

            private enum Keys: String, CodingKey {
                case name
                case unit
                case slug
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.name = try container.decode(String.self, forKey: .name)
                self.unit = try container.decode(String.self, forKey: .unit)
                self.slug = try container.decodeNil(forKey: .slug) ? nil : container.decode(String.self, forKey: .slug)
            }
        }

        public struct MomentRecord: Decodable, Sendable, Equatable {
            public let source: String
            public let kind: String
            public let key: String

            private enum Keys: String, CodingKey {
                case source
                case kind
                case key
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.source = try container.decode(String.self, forKey: .source)
                self.kind = try container.decode(String.self, forKey: .kind)
                self.key = try container.decode(String.self, forKey: .key)
            }
        }

        public struct MomentSite: Decodable, Sendable, Equatable {
            public let title: String
            public let line: String?
            public let atMs: Int?
            public let icon: String
            public let href: String?

            private enum Keys: String, CodingKey {
                case title
                case line
                case atMs = "at_ms"
                case icon
                case href
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.title = try container.decode(String.self, forKey: .title)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                self.atMs = try container.decodeNil(forKey: .atMs) ? nil : container.decode(Int.self, forKey: .atMs)
                self.icon = try container.decode(String.self, forKey: .icon)
                self.href = try container.decodeNil(forKey: .href) ? nil : container.decode(String.self, forKey: .href)
            }
        }

        public struct MomentSource: Decodable, Sendable, Equatable {
            public let records: [MomentSourceRecord]
            public let more: Int
            public let units: [MomentUnit]
            public let atoms: Int
            public let startMs: Int?
            public let endMs: Int?

            private enum Keys: String, CodingKey {
                case records
                case more
                case units
                case atoms
                case startMs = "start_ms"
                case endMs = "end_ms"
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.records = try container.decode([MomentSourceRecord].self, forKey: .records)
                self.more = try container.decode(Int.self, forKey: .more)
                self.units = try container.decode([MomentUnit].self, forKey: .units)
                self.atoms = try container.decode(Int.self, forKey: .atoms)
                self.startMs = try container.decodeNil(forKey: .startMs) ? nil : container.decode(Int.self, forKey: .startMs)
                self.endMs = try container.decodeNil(forKey: .endMs) ? nil : container.decode(Int.self, forKey: .endMs)
            }
        }

        public struct MomentSourceRecord: Decodable, Sendable, Equatable {
            public let source: String
            public let kind: String
            public let key: String
            public let atMs: Int?

            private enum Keys: String, CodingKey {
                case source
                case kind
                case key
                case atMs = "at_ms"
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.source = try container.decode(String.self, forKey: .source)
                self.kind = try container.decode(String.self, forKey: .kind)
                self.key = try container.decode(String.self, forKey: .key)
                self.atMs = try container.decodeNil(forKey: .atMs) ? nil : container.decode(Int.self, forKey: .atMs)
            }
        }

        public enum MomentState: String, Decodable, Sendable, Equatable {
            case found
            case gone
            case rendering
            case empty
            case unknown

            public init(from decoder: Decoder) throws {
                self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
            }
        }

        public struct MomentTimed: Decodable, Sendable, Equatable {
            public let startMs: Int?
            public let endMs: Int?
            public let text: String

            private enum Keys: String, CodingKey {
                case startMs = "start_ms"
                case endMs = "end_ms"
                case text
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.startMs = try container.decodeNil(forKey: .startMs) ? nil : container.decode(Int.self, forKey: .startMs)
                self.endMs = try container.decodeNil(forKey: .endMs) ? nil : container.decode(Int.self, forKey: .endMs)
                self.text = try container.decode(String.self, forKey: .text)
            }
        }

        public struct MomentTurn: Decodable, Sendable, Equatable {
            public let atMs: Int?
            public let mine: Bool
            public let words: String
            public let full: Bool
            public let files: [String]
            public let tools: [String]
            public let marked: Bool

            private enum Keys: String, CodingKey {
                case atMs = "at_ms"
                case mine
                case words
                case full
                case files
                case tools
                case marked
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.atMs = try container.decodeNil(forKey: .atMs) ? nil : container.decode(Int.self, forKey: .atMs)
                self.mine = try container.decode(Bool.self, forKey: .mine)
                self.words = try container.decode(String.self, forKey: .words)
                self.full = try container.decode(Bool.self, forKey: .full)
                self.files = try container.decode([String].self, forKey: .files)
                self.tools = try container.decode([String].self, forKey: .tools)
                self.marked = try container.decode(Bool.self, forKey: .marked)
            }
        }

        public struct MomentUnit: Decodable, Sendable, Equatable {
            public let family: String
            public let unit: String

            private enum Keys: String, CodingKey {
                case family
                case unit
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.family = try container.decode(String.self, forKey: .family)
                self.unit = try container.decode(String.self, forKey: .unit)
            }
        }

        public enum MomentView: Decodable, Sendable, Equatable {
            case thread(chat: String?, group: Bool)
            case quiet(chat: String)
            case ai(work: [String], turns: [MomentTurn])
            case call(figure: CallFigure?, group: String, name: String, others: [OtherCall], week: CallWeek?)
            case mail(list: Bool, letters: [Letter])
            case stay(todayMs: Int, unit: String, note: String?, inside: [MomentTimed])
            case move(km: String?, lengthMs: Int?, from: String, to: String, mode: String?, legs: [MomentTimed], note: String?)
            case body(label: String, lengthMs: Int?, bedMs: Int?, wakeMs: Int?, facts: [[MomentFact]], vitals: [String])
            case sitting(account: ScreenAccount?, apps: [MomentApp], sites: [MomentSite], lines: [MomentTimed])
            case apps(totalMs: Int?, apps: [MomentApp], sites: [MomentSite])
            case event(plan: Bool, `where`: EventWhere?, with: String?, words: String)
            case note(words: String?)
            case voice(timed: Bool, notes: [VoiceNote])
            case photos(lines: [PhotoLine])
            case listening(tracks: [String])
            case checkIn(head: String?, median: String?, lapses: String?, facts: [MomentFact], note: String?)
            case payment(amount: String?, direction: Direction, facts: [MomentFact])
            case lines(lines: [MomentTimed])
            case unknown

            private enum Keys: String, CodingKey {
                case view
                case chat
                case group
                case work
                case turns
                case figure
                case name
                case others
                case week
                case list
                case letters
                case todayMs = "today_ms"
                case unit
                case note
                case inside
                case km
                case lengthMs = "length_ms"
                case from
                case to
                case mode
                case legs
                case label
                case bedMs = "bed_ms"
                case wakeMs = "wake_ms"
                case facts
                case vitals
                case account
                case apps
                case sites
                case lines
                case totalMs = "total_ms"
                case plan
                case `where`
                case with
                case words
                case timed
                case notes
                case tracks
                case head
                case median
                case lapses
                case amount
                case direction
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                switch try container.decode(String.self, forKey: .view) {
                case "thread":
                    self = .thread(
                        chat: try container.decodeNil(forKey: .chat) ? nil : container.decode(String.self, forKey: .chat),
                        group: try container.decode(Bool.self, forKey: .group)
                    )
                case "quiet":
                    self = .quiet(
                        chat: try container.decode(String.self, forKey: .chat)
                    )
                case "ai":
                    self = .ai(
                        work: try container.decode([String].self, forKey: .work),
                        turns: try container.decode([MomentTurn].self, forKey: .turns)
                    )
                case "call":
                    self = .call(
                        figure: try container.decodeNil(forKey: .figure) ? nil : container.decode(CallFigure.self, forKey: .figure),
                        group: try container.decode(String.self, forKey: .group),
                        name: try container.decode(String.self, forKey: .name),
                        others: try container.decode([OtherCall].self, forKey: .others),
                        week: try container.decodeNil(forKey: .week) ? nil : container.decode(CallWeek.self, forKey: .week)
                    )
                case "mail":
                    self = .mail(
                        list: try container.decode(Bool.self, forKey: .list),
                        letters: try container.decode([Letter].self, forKey: .letters)
                    )
                case "stay":
                    self = .stay(
                        todayMs: try container.decode(Int.self, forKey: .todayMs),
                        unit: try container.decode(String.self, forKey: .unit),
                        note: try container.decodeNil(forKey: .note) ? nil : container.decode(String.self, forKey: .note),
                        inside: try container.decode([MomentTimed].self, forKey: .inside)
                    )
                case "move":
                    self = .move(
                        km: try container.decodeNil(forKey: .km) ? nil : container.decode(String.self, forKey: .km),
                        lengthMs: try container.decodeNil(forKey: .lengthMs) ? nil : container.decode(Int.self, forKey: .lengthMs),
                        from: try container.decode(String.self, forKey: .from),
                        to: try container.decode(String.self, forKey: .to),
                        mode: try container.decodeNil(forKey: .mode) ? nil : container.decode(String.self, forKey: .mode),
                        legs: try container.decode([MomentTimed].self, forKey: .legs),
                        note: try container.decodeNil(forKey: .note) ? nil : container.decode(String.self, forKey: .note)
                    )
                case "body":
                    self = .body(
                        label: try container.decode(String.self, forKey: .label),
                        lengthMs: try container.decodeNil(forKey: .lengthMs) ? nil : container.decode(Int.self, forKey: .lengthMs),
                        bedMs: try container.decodeNil(forKey: .bedMs) ? nil : container.decode(Int.self, forKey: .bedMs),
                        wakeMs: try container.decodeNil(forKey: .wakeMs) ? nil : container.decode(Int.self, forKey: .wakeMs),
                        facts: try container.decode([[MomentFact]].self, forKey: .facts),
                        vitals: try container.decode([String].self, forKey: .vitals)
                    )
                case "sitting":
                    self = .sitting(
                        account: try container.decodeNil(forKey: .account) ? nil : container.decode(ScreenAccount.self, forKey: .account),
                        apps: try container.decode([MomentApp].self, forKey: .apps),
                        sites: try container.decode([MomentSite].self, forKey: .sites),
                        lines: try container.decode([MomentTimed].self, forKey: .lines)
                    )
                case "apps":
                    self = .apps(
                        totalMs: try container.decodeNil(forKey: .totalMs) ? nil : container.decode(Int.self, forKey: .totalMs),
                        apps: try container.decode([MomentApp].self, forKey: .apps),
                        sites: try container.decode([MomentSite].self, forKey: .sites)
                    )
                case "event":
                    self = .event(
                        plan: try container.decode(Bool.self, forKey: .plan),
                        where: try container.decodeNil(forKey: .`where`) ? nil : container.decode(EventWhere.self, forKey: .`where`),
                        with: try container.decodeNil(forKey: .with) ? nil : container.decode(String.self, forKey: .with),
                        words: try container.decode(String.self, forKey: .words)
                    )
                case "note":
                    self = .note(
                        words: try container.decodeNil(forKey: .words) ? nil : container.decode(String.self, forKey: .words)
                    )
                case "voice":
                    self = .voice(
                        timed: try container.decode(Bool.self, forKey: .timed),
                        notes: try container.decode([VoiceNote].self, forKey: .notes)
                    )
                case "photos":
                    self = .photos(
                        lines: try container.decode([PhotoLine].self, forKey: .lines)
                    )
                case "listening":
                    self = .listening(
                        tracks: try container.decode([String].self, forKey: .tracks)
                    )
                case "check_in":
                    self = .checkIn(
                        head: try container.decodeNil(forKey: .head) ? nil : container.decode(String.self, forKey: .head),
                        median: try container.decodeNil(forKey: .median) ? nil : container.decode(String.self, forKey: .median),
                        lapses: try container.decodeNil(forKey: .lapses) ? nil : container.decode(String.self, forKey: .lapses),
                        facts: try container.decode([MomentFact].self, forKey: .facts),
                        note: try container.decodeNil(forKey: .note) ? nil : container.decode(String.self, forKey: .note)
                    )
                case "payment":
                    self = .payment(
                        amount: try container.decodeNil(forKey: .amount) ? nil : container.decode(String.self, forKey: .amount),
                        direction: try container.decode(Direction.self, forKey: .direction),
                        facts: try container.decode([MomentFact].self, forKey: .facts)
                    )
                case "lines":
                    self = .lines(
                        lines: try container.decode([MomentTimed].self, forKey: .lines)
                    )
                default:
                    self = .unknown
                }
            }

            public enum Direction: String, Decodable, Sendable, Equatable {
                case `in`
                case out
                case unknown

                public init(from decoder: Decoder) throws {
                    self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
                }
            }
        }

        public struct Month: Decodable, Sendable, Equatable {
            public let days: [MonthDay]
            public let count: Int
            public let calls: Calls?
            public let line: String
            public let before: Before?

            private enum Keys: String, CodingKey {
                case days
                case count
                case calls
                case line
                case before
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.days = try container.decode([MonthDay].self, forKey: .days)
                self.count = try container.decode(Int.self, forKey: .count)
                self.calls = try container.decodeNil(forKey: .calls) ? nil : container.decode(Calls.self, forKey: .calls)
                self.line = try container.decode(String.self, forKey: .line)
                self.before = try container.decodeNil(forKey: .before) ? nil : container.decode(Before.self, forKey: .before)
            }

            public struct Calls: Decodable, Sendable, Equatable {
                public let count: Int
                public let words: String

                private enum Keys: String, CodingKey {
                    case count
                    case words
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.count = try container.decode(Int.self, forKey: .count)
                    self.words = try container.decode(String.self, forKey: .words)
                }
            }

            public struct Before: Decodable, Sendable, Equatable {
                public let day: String
                public let joiner: String

                private enum Keys: String, CodingKey {
                    case day
                    case joiner
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.day = try container.decode(String.self, forKey: .day)
                    self.joiner = try container.decode(String.self, forKey: .joiner)
                }
            }
        }

        public struct MonthDay: Decodable, Sendable, Equatable {
            public let day: String
            public let count: Int

            private enum Keys: String, CodingKey {
                case day
                case count
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.day = try container.decode(String.self, forKey: .day)
                self.count = try container.decode(Int.self, forKey: .count)
            }
        }

        public struct NamedCircle: Decodable, Sendable, Equatable {
            public let slug: String
            public let latitude: Double
            public let longitude: Double
            public let radiusM: Double

            private enum Keys: String, CodingKey {
                case slug
                case latitude
                case longitude
                case radiusM = "radius_m"
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.slug = try container.decode(String.self, forKey: .slug)
                self.latitude = try container.decode(Double.self, forKey: .latitude)
                self.longitude = try container.decode(Double.self, forKey: .longitude)
                self.radiusM = try container.decode(Double.self, forKey: .radiusM)
            }
        }

        public struct Need: Decodable, Sendable, Equatable {
            public let id: String
            public let state: State
            public let reason: HealthReason?
            public let words: String
            public let sinceMs: Int?
            public let nextMs: Int?
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
            public let kind: Kind
            public let about: String?

            private enum Keys: String, CodingKey {
                case id
                case state
                case reason
                case words
                case sinceMs = "since_ms"
                case nextMs = "next_ms"
                case acts
                case detail
                case line
                case connector
                case streams
                case copy
                case unit
                case at
                case weight
                case banner
                case dismissed
                case kind
                case about
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.id = try container.decode(String.self, forKey: .id)
                self.state = try container.decode(State.self, forKey: .state)
                self.reason = try container.decodeNil(forKey: .reason) ? nil : container.decode(HealthReason.self, forKey: .reason)
                self.words = try container.decode(String.self, forKey: .words)
                self.sinceMs = try container.decodeNil(forKey: .sinceMs) ? nil : container.decode(Int.self, forKey: .sinceMs)
                self.nextMs = try container.decodeNil(forKey: .nextMs) ? nil : container.decode(Int.self, forKey: .nextMs)
                self.acts = try container.decode([Act].self, forKey: .acts)
                self.detail = try container.decodeNil(forKey: .detail) ? nil : container.decode(String.self, forKey: .detail)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                self.connector = try container.decodeNil(forKey: .connector) ? nil : container.decode(String.self, forKey: .connector)
                self.streams = try container.decodeNil(forKey: .streams) ? nil : container.decode([String].self, forKey: .streams)
                self.copy = try container.decodeNil(forKey: .copy) ? nil : container.decode(String.self, forKey: .copy)
                self.unit = try container.decodeNil(forKey: .unit) ? nil : container.decode(String.self, forKey: .unit)
                self.at = try container.decodeNil(forKey: .at) ? nil : container.decode(At.self, forKey: .at)
                self.weight = try container.decode(Weight.self, forKey: .weight)
                self.banner = try container.decode(Bool.self, forKey: .banner)
                self.dismissed = try container.decode(Bool.self, forKey: .dismissed)
                self.kind = try container.decode(Kind.self, forKey: .kind)
                self.about = try container.decodeNil(forKey: .about) ? nil : container.decode(String.self, forKey: .about)
            }

            public struct At: Decodable, Sendable, Equatable {
                public let site: String
                public let `open`: String?
                public let errand: String?

                private enum Keys: String, CodingKey {
                    case site
                    case `open`
                    case errand
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.site = try container.decode(String.self, forKey: .site)
                    self.`open` = try container.decodeNil(forKey: .`open`) ? nil : container.decode(String.self, forKey: .`open`)
                    self.errand = try container.decodeNil(forKey: .errand) ? nil : container.decode(String.self, forKey: .errand)
                }
            }

            public enum Weight: String, Decodable, Sendable, Equatable {
                case stopped
                case advice
                case unknown

                public init(from decoder: Decoder) throws {
                    self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
                }
            }

            public enum Kind: String, Decodable, Sendable, Equatable {
                case password
                case connect
                case notice
                case unknown

                public init(from decoder: Decoder) throws {
                    self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
                }
            }
        }

        public enum Opens: Decodable, Sendable, Equatable {
            case days(day: String, focus: String?)
            case month(month: String, day: String?)
            case people(id: String, person: String?, group: String?)
            case places(id: String)
            case read
            case unknown

            private enum Keys: String, CodingKey {
                case page
                case day
                case focus
                case month
                case id
                case person
                case group
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                switch try container.decode(String.self, forKey: .page) {
                case "days":
                    self = .days(
                        day: try container.decode(String.self, forKey: .day),
                        focus: try container.decodeNil(forKey: .focus) ? nil : container.decode(String.self, forKey: .focus)
                    )
                case "month":
                    self = .month(
                        month: try container.decode(String.self, forKey: .month),
                        day: try container.decodeNil(forKey: .day) ? nil : container.decode(String.self, forKey: .day)
                    )
                case "people":
                    self = .people(
                        id: try container.decode(String.self, forKey: .id),
                        person: try container.decodeNil(forKey: .person) ? nil : container.decode(String.self, forKey: .person),
                        group: try container.decodeNil(forKey: .group) ? nil : container.decode(String.self, forKey: .group)
                    )
                case "places":
                    self = .places(
                        id: try container.decode(String.self, forKey: .id)
                    )
                case "read":
                    self = .read
                default:
                    self = .unknown
                }
            }
        }

        public struct OtherCall: Decodable, Sendable, Equatable {
            public let atMs: Int
            public let way: String
            public let lengthMs: Int?

            private enum Keys: String, CodingKey {
                case atMs = "at_ms"
                case way
                case lengthMs = "length_ms"
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.atMs = try container.decode(Int.self, forKey: .atMs)
                self.way = try container.decode(String.self, forKey: .way)
                self.lengthMs = try container.decodeNil(forKey: .lengthMs) ? nil : container.decode(Int.self, forKey: .lengthMs)
            }
        }

        public struct PersonRecord: Decodable, Sendable, Equatable {
            public let type: RecordType
            public let slug: String
            public let name: String?
            public let fullName: String?
            public let show: Show
            public let entity: Entity?
            public let relationship: String?
            public let hidden: Bool
            public let me: Bool
            public let anchor: RecordHandle?
            public let handles: [RecordHandle]
            public let excluded: [RecordHandle]
            public let dismissed: [String]
            public let alsoCalled: [String]
            public let mergedInto: String?

            private enum Keys: String, CodingKey {
                case type
                case slug
                case name
                case fullName = "full_name"
                case show
                case entity
                case relationship
                case hidden
                case me
                case anchor
                case handles
                case excluded
                case dismissed
                case alsoCalled = "also_called"
                case mergedInto = "merged_into"
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.type = try container.decode(RecordType.self, forKey: .type)
                self.slug = try container.decode(String.self, forKey: .slug)
                self.name = try container.decodeNil(forKey: .name) ? nil : container.decode(String.self, forKey: .name)
                self.fullName = try container.decodeNil(forKey: .fullName) ? nil : container.decode(String.self, forKey: .fullName)
                self.show = try container.decode(Show.self, forKey: .show)
                self.entity = try container.decodeNil(forKey: .entity) ? nil : container.decode(Entity.self, forKey: .entity)
                self.relationship = try container.decodeNil(forKey: .relationship) ? nil : container.decode(String.self, forKey: .relationship)
                self.hidden = try container.decode(Bool.self, forKey: .hidden)
                self.me = try container.decode(Bool.self, forKey: .me)
                self.anchor = try container.decodeNil(forKey: .anchor) ? nil : container.decode(RecordHandle.self, forKey: .anchor)
                self.handles = try container.decode([RecordHandle].self, forKey: .handles)
                self.excluded = try container.decode([RecordHandle].self, forKey: .excluded)
                self.dismissed = try container.decode([String].self, forKey: .dismissed)
                self.alsoCalled = try container.decode([String].self, forKey: .alsoCalled)
                self.mergedInto = try container.decodeNil(forKey: .mergedInto) ? nil : container.decode(String.self, forKey: .mergedInto)
            }

            public enum Show: String, Decodable, Sendable, Equatable {
                case name
                case fullName = "full_name"
                case unknown

                public init(from decoder: Decoder) throws {
                    self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
                }
            }
        }

        public struct PhotoLine: Decodable, Sendable, Equatable {
            public let startMs: Int?
            public let endMs: Int?
            public let text: String
            public let video: Bool

            private enum Keys: String, CodingKey {
                case startMs = "start_ms"
                case endMs = "end_ms"
                case text
                case video
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.startMs = try container.decodeNil(forKey: .startMs) ? nil : container.decode(Int.self, forKey: .startMs)
                self.endMs = try container.decodeNil(forKey: .endMs) ? nil : container.decode(Int.self, forKey: .endMs)
                self.text = try container.decode(String.self, forKey: .text)
                self.video = try container.decode(Bool.self, forKey: .video)
            }
        }

        public enum PhrasePart: Decodable, Sendable, Equatable {
            case words(words: String)
            case time(time: When)
            case unknown

            private enum Keys: String, CodingKey {
                case kind
                case words
                case time
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                switch try container.decode(String.self, forKey: .kind) {
                case "words":
                    self = .words(
                        words: try container.decode(String.self, forKey: .words)
                    )
                case "time":
                    self = .time(
                        time: try container.decode(When.self, forKey: .time)
                    )
                default:
                    self = .unknown
                }
            }
        }

        public struct PlaceLink: Decodable, Sendable, Equatable {
            public let slug: String
            public let name: String

            private enum Keys: String, CodingKey {
                case slug
                case name
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.slug = try container.decode(String.self, forKey: .slug)
                self.name = try container.decode(String.self, forKey: .name)
            }
        }

        public struct PlacePerson: Decodable, Sendable, Equatable {
            public let id: String
            public let name: String
            public let photo: String?
            public let line: String?

            private enum Keys: String, CodingKey {
                case id
                case name
                case photo
                case line
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.id = try container.decode(String.self, forKey: .id)
                self.name = try container.decode(String.self, forKey: .name)
                self.photo = try container.decodeNil(forKey: .photo) ? nil : container.decode(String.self, forKey: .photo)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
            }
        }

        public struct PlaceRow: Decodable, Sendable, Equatable {
            public let slug: String
            public let name: String
            public let line: String?
            public let when: When?
            public let spent: Spent?
            public let find: [String]
            public let latitude: Double
            public let longitude: Double
            public let radiusM: Double
            public let also: [Circle]
            public let hours: Double

            private enum Keys: String, CodingKey {
                case slug
                case name
                case line
                case when
                case spent
                case find
                case latitude
                case longitude
                case radiusM = "radius_m"
                case also
                case hours
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.slug = try container.decode(String.self, forKey: .slug)
                self.name = try container.decode(String.self, forKey: .name)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                self.when = try container.decodeNil(forKey: .when) ? nil : container.decode(When.self, forKey: .when)
                self.spent = try container.decodeNil(forKey: .spent) ? nil : container.decode(Spent.self, forKey: .spent)
                self.find = try container.decode([String].self, forKey: .find)
                self.latitude = try container.decode(Double.self, forKey: .latitude)
                self.longitude = try container.decode(Double.self, forKey: .longitude)
                self.radiusM = try container.decode(Double.self, forKey: .radiusM)
                self.also = try container.decode([Circle].self, forKey: .also)
                self.hours = try container.decode(Double.self, forKey: .hours)
            }

            public struct Spent: Decodable, Sendable, Equatable {
                public let day: String
                public let hours: Double

                private enum Keys: String, CodingKey {
                    case day
                    case hours
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.day = try container.decode(String.self, forKey: .day)
                    self.hours = try container.decode(Double.self, forKey: .hours)
                }
            }
        }

        public struct PlaceVisit: Decodable, Sendable, Equatable {
            public let key: String
            public let unit: String
            public let day: String
            public let startMs: Int
            public let endMs: Int
            public let focus: String
            public let people: [String]

            private enum Keys: String, CodingKey {
                case key
                case unit
                case day
                case startMs = "start_ms"
                case endMs = "end_ms"
                case focus
                case people
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.key = try container.decode(String.self, forKey: .key)
                self.unit = try container.decode(String.self, forKey: .unit)
                self.day = try container.decode(String.self, forKey: .day)
                self.startMs = try container.decode(Int.self, forKey: .startMs)
                self.endMs = try container.decode(Int.self, forKey: .endMs)
                self.focus = try container.decode(String.self, forKey: .focus)
                self.people = try container.decode([String].self, forKey: .people)
            }
        }

        public struct Point: Decodable, Sendable, Equatable {
            public let latitude: Double
            public let longitude: Double

            private enum Keys: String, CodingKey {
                case latitude
                case longitude
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.latitude = try container.decode(Double.self, forKey: .latitude)
                self.longitude = try container.decode(Double.self, forKey: .longitude)
            }
        }

        public struct Profile: Decodable, Sendable, Equatable {
            public let network: String
            public let value: String

            private enum Keys: String, CodingKey {
                case network
                case value
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.network = try container.decode(String.self, forKey: .network)
                self.value = try container.decode(String.self, forKey: .value)
            }
        }

        public enum Reading: Decodable, Sendable, Equatable {
            case building(line: String, percent: Int?)
            case behind(line: String, newest: When)
            case unknown

            private enum Keys: String, CodingKey {
                case state
                case line
                case percent
                case newest
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                switch try container.decode(String.self, forKey: .state) {
                case "building":
                    self = .building(
                        line: try container.decode(String.self, forKey: .line),
                        percent: try container.decodeNil(forKey: .percent) ? nil : container.decode(Int.self, forKey: .percent)
                    )
                case "behind":
                    self = .behind(
                        line: try container.decode(String.self, forKey: .line),
                        newest: try container.decode(When.self, forKey: .newest)
                    )
                default:
                    self = .unknown
                }
            }
        }

        public struct RecordHandle: Decodable, Sendable, Equatable {
            public let kind: HandleKind
            public let value: String

            private enum Keys: String, CodingKey {
                case kind
                case value
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.kind = try container.decode(HandleKind.self, forKey: .kind)
                self.value = try container.decode(String.self, forKey: .value)
            }
        }

        public enum RecordType: String, Decodable, Sendable, Equatable {
            case peoplePerson = "people.person"
            case unknown

            public init(from decoder: Decoder) throws {
                self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
            }
        }

        public struct Row: Decodable, Sendable, Equatable {
            public let id: String
            public let name: String
            public let named: Bool
            public let face: Bool
            public let photo: String?
            public let when: When?
            public let line: String?
            public let find: [String]

            private enum Keys: String, CodingKey {
                case id
                case name
                case named
                case face
                case photo
                case when
                case line
                case find
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.id = try container.decode(String.self, forKey: .id)
                self.name = try container.decode(String.self, forKey: .name)
                self.named = try container.decode(Bool.self, forKey: .named)
                self.face = try container.decode(Bool.self, forKey: .face)
                self.photo = try container.decodeNil(forKey: .photo) ? nil : container.decode(String.self, forKey: .photo)
                self.when = try container.decodeNil(forKey: .when) ? nil : container.decode(When.self, forKey: .when)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                self.find = try container.decode([String].self, forKey: .find)
            }
        }

        public enum RunTone: String, Decodable, Sendable, Equatable {
            case secondary
            case tertiary
            case unknown

            public init(from decoder: Decoder) throws {
                self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
            }
        }

        public struct ScreenAccount: Decodable, Sendable, Equatable {
            public let narrative: String
            public let tasks: [AccountTask]
            public let people: [String]
            public let projects: [String]
            public let steps: [AccountStep]
            public let loose: [MomentAction]
            public let actions: Int

            private enum Keys: String, CodingKey {
                case narrative
                case tasks
                case people
                case projects
                case steps
                case loose
                case actions
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.narrative = try container.decode(String.self, forKey: .narrative)
                self.tasks = try container.decode([AccountTask].self, forKey: .tasks)
                self.people = try container.decode([String].self, forKey: .people)
                self.projects = try container.decode([String].self, forKey: .projects)
                self.steps = try container.decode([AccountStep].self, forKey: .steps)
                self.loose = try container.decode([MomentAction].self, forKey: .loose)
                self.actions = try container.decode(Int.self, forKey: .actions)
            }
        }

        public enum SearchFamily: String, Decodable, Sendable, Equatable {
            case messages
            case mail
            case calls
            case calendar
            case notes
            case ai
            case web
            case screen
            case photos
            case health
            case money
            case physical
            case listening
            case voice
            case phone
            case unknown

            public init(from decoder: Decoder) throws {
                self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
            }
        }

        public enum SearchRow: Decodable, Sendable, Equatable {
            case hit(ref: String, family: SearchFamily, title: String, line: String?, when: When?, picture: String?, opens: Opens?)
            case person(ref: String, name: String, line: String?, picture: String?, opens: Opens?)
            case place(ref: String, name: String, line: String, opens: Opens?)
            case date(when: When, opens: Opens)
            case track(ref: String, title: String, artist: String?, line: String)
            case sitting(key: String, title: String, line: String?, said: String?, when: When, windows: [SearchWindow], windowsLine: String?, opens: Opens)
            case unknown

            private enum Keys: String, CodingKey {
                case kind
                case ref
                case family
                case title
                case line
                case when
                case picture
                case opens
                case name
                case artist
                case key
                case said
                case windows
                case windowsLine = "windows_line"
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                switch try container.decode(String.self, forKey: .kind) {
                case "hit":
                    self = .hit(
                        ref: try container.decode(String.self, forKey: .ref),
                        family: try container.decode(SearchFamily.self, forKey: .family),
                        title: try container.decode(String.self, forKey: .title),
                        line: try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line),
                        when: try container.decodeNil(forKey: .when) ? nil : container.decode(When.self, forKey: .when),
                        picture: try container.decodeNil(forKey: .picture) ? nil : container.decode(String.self, forKey: .picture),
                        opens: try container.decodeNil(forKey: .opens) ? nil : container.decode(Opens.self, forKey: .opens)
                    )
                case "person":
                    self = .person(
                        ref: try container.decode(String.self, forKey: .ref),
                        name: try container.decode(String.self, forKey: .name),
                        line: try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line),
                        picture: try container.decodeNil(forKey: .picture) ? nil : container.decode(String.self, forKey: .picture),
                        opens: try container.decodeNil(forKey: .opens) ? nil : container.decode(Opens.self, forKey: .opens)
                    )
                case "place":
                    self = .place(
                        ref: try container.decode(String.self, forKey: .ref),
                        name: try container.decode(String.self, forKey: .name),
                        line: try container.decode(String.self, forKey: .line),
                        opens: try container.decodeNil(forKey: .opens) ? nil : container.decode(Opens.self, forKey: .opens)
                    )
                case "date":
                    self = .date(
                        when: try container.decode(When.self, forKey: .when),
                        opens: try container.decode(Opens.self, forKey: .opens)
                    )
                case "track":
                    self = .track(
                        ref: try container.decode(String.self, forKey: .ref),
                        title: try container.decode(String.self, forKey: .title),
                        artist: try container.decodeNil(forKey: .artist) ? nil : container.decode(String.self, forKey: .artist),
                        line: try container.decode(String.self, forKey: .line)
                    )
                case "sitting":
                    self = .sitting(
                        key: try container.decode(String.self, forKey: .key),
                        title: try container.decode(String.self, forKey: .title),
                        line: try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line),
                        said: try container.decodeNil(forKey: .said) ? nil : container.decode(String.self, forKey: .said),
                        when: try container.decode(When.self, forKey: .when),
                        windows: try container.decode([SearchWindow].self, forKey: .windows),
                        windowsLine: try container.decodeNil(forKey: .windowsLine) ? nil : container.decode(String.self, forKey: .windowsLine),
                        opens: try container.decode(Opens.self, forKey: .opens)
                    )
                default:
                    self = .unknown
                }
            }
        }

        public struct SearchWindow: Decodable, Sendable, Equatable {
            public let ref: String
            public let app: String
            public let title: String
            public let line: String?
            public let when: When?
            public let opens: Opens?

            private enum Keys: String, CodingKey {
                case ref
                case app
                case title
                case line
                case when
                case opens
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.ref = try container.decode(String.self, forKey: .ref)
                self.app = try container.decode(String.self, forKey: .app)
                self.title = try container.decode(String.self, forKey: .title)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                self.when = try container.decodeNil(forKey: .when) ? nil : container.decode(When.self, forKey: .when)
                self.opens = try container.decodeNil(forKey: .opens) ? nil : container.decode(Opens.self, forKey: .opens)
            }
        }

        public struct SettingsDevice: Decodable, Sendable, Equatable {
            public let id: String
            public let name: String
            public let icon: String
            public let line: String
            public let signal: State?
            public let removed: Bool

            private enum Keys: String, CodingKey {
                case id
                case name
                case icon
                case line
                case signal
                case removed
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.id = try container.decode(String.self, forKey: .id)
                self.name = try container.decode(String.self, forKey: .name)
                self.icon = try container.decode(String.self, forKey: .icon)
                self.line = try container.decode(String.self, forKey: .line)
                self.signal = try container.decodeNil(forKey: .signal) ? nil : container.decode(State.self, forKey: .signal)
                self.removed = try container.decode(Bool.self, forKey: .removed)
            }
        }

        public enum SettingsEnd: Decodable, Sendable, Equatable {
            case value(value: [PhrasePart], signal: State?)
            case choice(key: String, choices: [Choice])
            case pick(key: String, choices: [SettingsPick])
            case unknown

            private enum Keys: String, CodingKey {
                case kind
                case value
                case signal
                case key
                case choices
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                switch try container.decode(String.self, forKey: .kind) {
                case "value":
                    self = .value(
                        value: try container.decode([PhrasePart].self, forKey: .value),
                        signal: try container.decodeNil(forKey: .signal) ? nil : container.decode(State.self, forKey: .signal)
                    )
                case "choice":
                    self = .choice(
                        key: try container.decode(String.self, forKey: .key),
                        choices: try container.decode([Choice].self, forKey: .choices)
                    )
                case "pick":
                    self = .pick(
                        key: try container.decode(String.self, forKey: .key),
                        choices: try container.decode([SettingsPick].self, forKey: .choices)
                    )
                default:
                    self = .unknown
                }
            }

            public struct Choice: Decodable, Sendable, Equatable {
                public let words: String
                public let value: Double
                public let chosen: Bool
                public let `default`: Bool

                private enum Keys: String, CodingKey {
                    case words
                    case value
                    case chosen
                    case `default`
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.words = try container.decode(String.self, forKey: .words)
                    self.value = try container.decode(Double.self, forKey: .value)
                    self.chosen = try container.decode(Bool.self, forKey: .chosen)
                    self.`default` = try container.decode(Bool.self, forKey: .`default`)
                }
            }
        }

        public struct SettingsPart: Decodable, Sendable, Equatable {
            public let label: String?
            public let line: String?
            public let rows: [SettingsRow]

            private enum Keys: String, CodingKey {
                case label
                case line
                case rows
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.label = try container.decodeNil(forKey: .label) ? nil : container.decode(String.self, forKey: .label)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                self.rows = try container.decode([SettingsRow].self, forKey: .rows)
            }
        }

        public struct SettingsPick: Decodable, Sendable, Equatable {
            public let words: String
            public let value: String
            public let chosen: Bool
            public let `default`: Bool

            private enum Keys: String, CodingKey {
                case words
                case value
                case chosen
                case `default`
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.words = try container.decode(String.self, forKey: .words)
                self.value = try container.decode(String.self, forKey: .value)
                self.chosen = try container.decode(Bool.self, forKey: .chosen)
                self.`default` = try container.decode(Bool.self, forKey: .`default`)
            }
        }

        public struct SettingsRow: Decodable, Sendable, Equatable {
            public let id: String
            public let label: String
            public let line: String?
            public let end: SettingsEnd?

            private enum Keys: String, CodingKey {
                case id
                case label
                case line
                case end
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.id = try container.decode(String.self, forKey: .id)
                self.label = try container.decode(String.self, forKey: .label)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                self.end = try container.decodeNil(forKey: .end) ? nil : container.decode(SettingsEnd.self, forKey: .end)
            }
        }

        public struct SettingsValue: Decodable, Sendable, Equatable {
            public let id: String
            public let label: String?
            public let value: [PhrasePart]?
            public let signal: State?

            private enum Keys: String, CodingKey {
                case id
                case label
                case value
                case signal
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.id = try container.decode(String.self, forKey: .id)
                self.label = try container.decodeNil(forKey: .label) ? nil : container.decode(String.self, forKey: .label)
                self.value = try container.decodeNil(forKey: .value) ? nil : container.decode([PhrasePart].self, forKey: .value)
                self.signal = try container.decodeNil(forKey: .signal) ? nil : container.decode(State.self, forKey: .signal)
            }
        }

        public struct SideCall: Decodable, Sendable, Equatable {
            public let key: String
            public let atMs: Int
            public let person: String?
            public let name: String

            private enum Keys: String, CodingKey {
                case key
                case atMs = "at_ms"
                case person
                case name
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.key = try container.decode(String.self, forKey: .key)
                self.atMs = try container.decode(Int.self, forKey: .atMs)
                self.person = try container.decodeNil(forKey: .person) ? nil : container.decode(String.self, forKey: .person)
                self.name = try container.decode(String.self, forKey: .name)
            }
        }

        public struct SideFigure: Decodable, Sendable, Equatable {
            public let key: Key
            public let value: String
            public let words: String

            private enum Keys: String, CodingKey {
                case key
                case value
                case words
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.key = try container.decode(Key.self, forKey: .key)
                self.value = try container.decode(String.self, forKey: .value)
                self.words = try container.decode(String.self, forKey: .words)
            }

            public enum Key: String, Decodable, Sendable, Equatable {
                case asleep
                case steps
                case recovery
                case sent
                case received
                case unknown

                public init(from decoder: Decoder) throws {
                    self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
                }
            }
        }

        public struct SideGroup: Decodable, Sendable, Equatable {
            public let chat: String
            public let title: String
            public let runs: [ContactRun]
            public let spoken: String
            public let quiet: Bool
            public let rows: [String]

            private enum Keys: String, CodingKey {
                case chat
                case title
                case runs
                case spoken
                case quiet
                case rows
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.chat = try container.decode(String.self, forKey: .chat)
                self.title = try container.decode(String.self, forKey: .title)
                self.runs = try container.decode([ContactRun].self, forKey: .runs)
                self.spoken = try container.decode(String.self, forKey: .spoken)
                self.quiet = try container.decode(Bool.self, forKey: .quiet)
                self.rows = try container.decode([String].self, forKey: .rows)
            }
        }

        public struct SidePerson: Decodable, Sendable, Equatable {
            public let key: String
            public let person: String?
            public let name: String
            public let photo: String?
            public let runs: [ContactRun]
            public let spoken: String
            public let rows: [String]

            private enum Keys: String, CodingKey {
                case key
                case person
                case name
                case photo
                case runs
                case spoken
                case rows
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.key = try container.decode(String.self, forKey: .key)
                self.person = try container.decodeNil(forKey: .person) ? nil : container.decode(String.self, forKey: .person)
                self.name = try container.decode(String.self, forKey: .name)
                self.photo = try container.decodeNil(forKey: .photo) ? nil : container.decode(String.self, forKey: .photo)
                self.runs = try container.decode([ContactRun].self, forKey: .runs)
                self.spoken = try container.decode(String.self, forKey: .spoken)
                self.rows = try container.decode([String].self, forKey: .rows)
            }
        }

        public struct SidePlace: Decodable, Sendable, Equatable {
            public let key: String
            public let slug: String?
            public let name: String
            public let line: String?
            public let home: Bool
            public let quiet: Bool
            public let ms: Int
            public let length: String
            public let spoken: String
            public let point: SidePoint
            public let radiusM: Double?
            public let rows: [String]

            private enum Keys: String, CodingKey {
                case key
                case slug
                case name
                case line
                case home
                case quiet
                case ms
                case length
                case spoken
                case point
                case radiusM = "radius_m"
                case rows
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.key = try container.decode(String.self, forKey: .key)
                self.slug = try container.decodeNil(forKey: .slug) ? nil : container.decode(String.self, forKey: .slug)
                self.name = try container.decode(String.self, forKey: .name)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode(String.self, forKey: .line)
                self.home = try container.decode(Bool.self, forKey: .home)
                self.quiet = try container.decode(Bool.self, forKey: .quiet)
                self.ms = try container.decode(Int.self, forKey: .ms)
                self.length = try container.decode(String.self, forKey: .length)
                self.spoken = try container.decode(String.self, forKey: .spoken)
                self.point = try container.decode(SidePoint.self, forKey: .point)
                self.radiusM = try container.decodeNil(forKey: .radiusM) ? nil : container.decode(Double.self, forKey: .radiusM)
                self.rows = try container.decode([String].self, forKey: .rows)
            }
        }

        public struct SidePoint: Decodable, Sendable, Equatable {
            public let latitude: Double
            public let longitude: Double
            public let id: String?

            private enum Keys: String, CodingKey {
                case latitude
                case longitude
                case id
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.latitude = try container.decode(Double.self, forKey: .latitude)
                self.longitude = try container.decode(Double.self, forKey: .longitude)
                self.id = try container.decodeNil(forKey: .id) ? nil : container.decode(String.self, forKey: .id)
            }
        }

        public struct SpotRow: Decodable, Sendable, Equatable {
            public let key: String
            public let latitude: Double
            public let longitude: Double
            public let line: String
            public let find: [String]
            public let when: When?
            public let photos: [String]
            public let photosTotal: Int
            public let ask: HomeAsk?
            public let city: String?

            private enum Keys: String, CodingKey {
                case key
                case latitude
                case longitude
                case line
                case find
                case when
                case photos
                case photosTotal = "photos_total"
                case ask
                case city
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.key = try container.decode(String.self, forKey: .key)
                self.latitude = try container.decode(Double.self, forKey: .latitude)
                self.longitude = try container.decode(Double.self, forKey: .longitude)
                self.line = try container.decode(String.self, forKey: .line)
                self.find = try container.decode([String].self, forKey: .find)
                self.when = try container.decodeNil(forKey: .when) ? nil : container.decode(When.self, forKey: .when)
                self.photos = try container.decode([String].self, forKey: .photos)
                self.photosTotal = try container.decode(Int.self, forKey: .photosTotal)
                self.ask = try container.decodeNil(forKey: .ask) ? nil : container.decode(HomeAsk.self, forKey: .ask)
                self.city = try container.decodeNil(forKey: .city) ? nil : container.decode(String.self, forKey: .city)
            }
        }

        public enum State: String, Decodable, Sendable, Equatable {
            case off
            case setup
            case paused
            case needsYou = "needs-you"
            case broken
            case waiting
            case quiet
            case syncing
            case ok
            case unknown

            public init(from decoder: Decoder) throws {
                self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
            }
        }

        public struct StayPoint: Decodable, Sendable, Equatable {
            public let latitude: Double
            public let longitude: Double
            public let count: Int

            private enum Keys: String, CodingKey {
                case latitude
                case longitude
                case count
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.latitude = try container.decode(Double.self, forKey: .latitude)
                self.longitude = try container.decode(Double.self, forKey: .longitude)
                self.count = try container.decode(Int.self, forKey: .count)
            }
        }

        public struct StorageBar: Decodable, Sendable, Equatable {
            public let label: String
            public let parts: [StoragePart]
            public let key: [StorageKey]
            public let left: String

            private enum Keys: String, CodingKey {
                case label
                case parts
                case key
                case left
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.label = try container.decode(String.self, forKey: .label)
                self.parts = try container.decode([StoragePart].self, forKey: .parts)
                self.key = try container.decode([StorageKey].self, forKey: .key)
                self.left = try container.decode(String.self, forKey: .left)
            }
        }

        public struct StorageChart: Decodable, Sendable, Equatable {
            public let label: [PhrasePart]
            public let first: String
            public let parts: [StorageSeries]
            public let rate: Double?
            public let room: Room?

            private enum Keys: String, CodingKey {
                case label
                case first
                case parts
                case rate
                case room
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.label = try container.decode([PhrasePart].self, forKey: .label)
                self.first = try container.decode(String.self, forKey: .first)
                self.parts = try container.decode([StorageSeries].self, forKey: .parts)
                self.rate = try container.decodeNil(forKey: .rate) ? nil : container.decode(Double.self, forKey: .rate)
                self.room = try container.decodeNil(forKey: .room) ? nil : container.decode(Room.self, forKey: .room)
            }

            public struct Room: Decodable, Sendable, Equatable {
                public let bytes: Double
                public let name: String

                private enum Keys: String, CodingKey {
                    case bytes
                    case name
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.bytes = try container.decode(Double.self, forKey: .bytes)
                    self.name = try container.decode(String.self, forKey: .name)
                }
            }
        }

        public struct StorageKey: Decodable, Sendable, Equatable {
            public let id: String
            public let name: String
            public let tone: StorageTone

            private enum Keys: String, CodingKey {
                case id
                case name
                case tone
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.id = try container.decode(String.self, forKey: .id)
                self.name = try container.decode(String.self, forKey: .name)
                self.tone = try container.decode(StorageTone.self, forKey: .tone)
            }
        }

        public struct StoragePart: Decodable, Sendable, Equatable {
            public let id: String
            public let name: String
            public let tone: StorageTone
            public let share: Double
            public let size: String

            private enum Keys: String, CodingKey {
                case id
                case name
                case tone
                case share
                case size
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.id = try container.decode(String.self, forKey: .id)
                self.name = try container.decode(String.self, forKey: .name)
                self.tone = try container.decode(StorageTone.self, forKey: .tone)
                self.share = try container.decode(Double.self, forKey: .share)
                self.size = try container.decode(String.self, forKey: .size)
            }
        }

        public struct StorageSeries: Decodable, Sendable, Equatable {
            public let id: String
            public let name: String
            public let tone: StorageTone
            public let bytes: [Double]

            private enum Keys: String, CodingKey {
                case id
                case name
                case tone
                case bytes
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.id = try container.decode(String.self, forKey: .id)
                self.name = try container.decode(String.self, forKey: .name)
                self.tone = try container.decode(StorageTone.self, forKey: .tone)
                self.bytes = try container.decode([Double].self, forKey: .bytes)
            }
        }

        public enum StorageTone: String, Decodable, Sendable, Equatable {
            case s1
            case s2
            case s3
            case s4
            case s5
            case other
            case own
            case uncounted
            case disk
            case free
            case unknown

            public init(from decoder: Decoder) throws {
                self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
            }
        }

        public struct StorageUse: Decodable, Sendable, Equatable {
            public let id: String
            public let part: String
            public let name: String
            public let tone: StorageTone
            public let size: String
            public let share: Double
            public let line: [PhrasePart]?
            public let opens: String?
            public let folded: Bool

            private enum Keys: String, CodingKey {
                case id
                case part
                case name
                case tone
                case size
                case share
                case line
                case opens
                case folded
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.id = try container.decode(String.self, forKey: .id)
                self.part = try container.decode(String.self, forKey: .part)
                self.name = try container.decode(String.self, forKey: .name)
                self.tone = try container.decode(StorageTone.self, forKey: .tone)
                self.size = try container.decode(String.self, forKey: .size)
                self.share = try container.decode(Double.self, forKey: .share)
                self.line = try container.decodeNil(forKey: .line) ? nil : container.decode([PhrasePart].self, forKey: .line)
                self.opens = try container.decodeNil(forKey: .opens) ? nil : container.decode(String.self, forKey: .opens)
                self.folded = try container.decode(Bool.self, forKey: .folded)
            }
        }

        public struct StreamRow: Decodable, Sendable, Equatable {
            public let ids: [String]
            public let joined: Bool
            public let name: String
            public let icon: String
            public let health: Health
            public let line: String
            public let time: When?
            public let more: [String]
            public let last: When?
            public let act: Act?
            public let find: [String]

            private enum Keys: String, CodingKey {
                case ids
                case joined
                case name
                case icon
                case health
                case line
                case time
                case more
                case last
                case act
                case find
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.ids = try container.decode([String].self, forKey: .ids)
                self.joined = try container.decode(Bool.self, forKey: .joined)
                self.name = try container.decode(String.self, forKey: .name)
                self.icon = try container.decode(String.self, forKey: .icon)
                self.health = try container.decode(Health.self, forKey: .health)
                self.line = try container.decode(String.self, forKey: .line)
                self.time = try container.decodeNil(forKey: .time) ? nil : container.decode(When.self, forKey: .time)
                self.more = try container.decode([String].self, forKey: .more)
                self.last = try container.decodeNil(forKey: .last) ? nil : container.decode(When.self, forKey: .last)
                self.act = try container.decodeNil(forKey: .act) ? nil : container.decode(Act.self, forKey: .act)
                self.find = try container.decode([String].self, forKey: .find)
            }
        }

        public struct Suggestion: Decodable, Sendable, Equatable {
            public let id: String
            public let kind: Kind
            public let value: String
            public let reasons: [Reason]
            public let ticked: Bool
            public let other: Other?

            private enum Keys: String, CodingKey {
                case id
                case kind
                case value
                case reasons
                case ticked
                case other
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.id = try container.decode(String.self, forKey: .id)
                self.kind = try container.decode(Kind.self, forKey: .kind)
                self.value = try container.decode(String.self, forKey: .value)
                self.reasons = try container.decode([Reason].self, forKey: .reasons)
                self.ticked = try container.decode(Bool.self, forKey: .ticked)
                self.other = try container.decodeNil(forKey: .other) ? nil : container.decode(Other.self, forKey: .other)
            }

            public enum Kind: String, Decodable, Sendable, Equatable {
                case handle
                case fullName = "full_name"
                case same
                case entity
                case work
                case birthday
                case profile
                case unknown

                public init(from decoder: Decoder) throws {
                    self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
                }
            }

            public struct Reason: Decodable, Sendable, Equatable {
                public let reason: String
                public let count: Double

                private enum Keys: String, CodingKey {
                    case reason
                    case count
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.reason = try container.decode(String.self, forKey: .reason)
                    self.count = try container.decode(Double.self, forKey: .count)
                }
            }

            public struct Other: Decodable, Sendable, Equatable {
                public let id: String
                public let name: String
                public let photo: String?
                public let named: Bool
                public let face: Bool

                private enum Keys: String, CodingKey {
                    case id
                    case name
                    case photo
                    case named
                    case face
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.id = try container.decode(String.self, forKey: .id)
                    self.name = try container.decode(String.self, forKey: .name)
                    self.photo = try container.decodeNil(forKey: .photo) ? nil : container.decode(String.self, forKey: .photo)
                    self.named = try container.decode(Bool.self, forKey: .named)
                    self.face = try container.decode(Bool.self, forKey: .face)
                }
            }
        }

        public struct Talk: Decodable, Sendable, Equatable {
            public let day: String
            public let chat: String
            public let title: String
            public let group: Bool
            public let network: String
            public let lines: [TalkLine]
            public let folded: [Folded]
            public let focus: String

            private enum Keys: String, CodingKey {
                case day
                case chat
                case title
                case group
                case network
                case lines
                case folded
                case focus
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.day = try container.decode(String.self, forKey: .day)
                self.chat = try container.decode(String.self, forKey: .chat)
                self.title = try container.decode(String.self, forKey: .title)
                self.group = try container.decode(Bool.self, forKey: .group)
                self.network = try container.decode(String.self, forKey: .network)
                self.lines = try container.decode([TalkLine].self, forKey: .lines)
                self.folded = try container.decode([Folded].self, forKey: .folded)
                self.focus = try container.decode(String.self, forKey: .focus)
            }

            public struct Folded: Decodable, Sendable, Equatable {
                public let line: String
                public let lines: [TalkLine]

                private enum Keys: String, CodingKey {
                    case line
                    case lines
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.line = try container.decode(String.self, forKey: .line)
                    self.lines = try container.decode([TalkLine].self, forKey: .lines)
                }
            }
        }

        public struct TalkLine: Decodable, Sendable, Equatable {
            public let who: String
            public let name: String
            public let text: String
            public let forwarded: Bool
            public let atMs: Int
            public let mine: Bool
            public let n: Int

            private enum Keys: String, CodingKey {
                case who
                case name
                case text
                case forwarded
                case atMs = "at_ms"
                case mine
                case n
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.who = try container.decode(String.self, forKey: .who)
                self.name = try container.decode(String.self, forKey: .name)
                self.text = try container.decode(String.self, forKey: .text)
                self.forwarded = try container.decode(Bool.self, forKey: .forwarded)
                self.atMs = try container.decode(Int.self, forKey: .atMs)
                self.mine = try container.decode(Bool.self, forKey: .mine)
                self.n = try container.decode(Int.self, forKey: .n)
            }
        }

        public struct Tile: Decodable, Sendable, Equatable {
            public let item: String
            public let hash: String
            public let atMs: Int?
            public let video: Bool
            public let durationMs: Int?
            public let live: Bool

            private enum Keys: String, CodingKey {
                case item
                case hash
                case atMs = "at_ms"
                case video
                case durationMs = "duration_ms"
                case live
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.item = try container.decode(String.self, forKey: .item)
                self.hash = try container.decode(String.self, forKey: .hash)
                self.atMs = try container.decodeNil(forKey: .atMs) ? nil : container.decode(Int.self, forKey: .atMs)
                self.video = try container.decode(Bool.self, forKey: .video)
                self.durationMs = try container.decodeNil(forKey: .durationMs) ? nil : container.decode(Int.self, forKey: .durationMs)
                self.live = try container.decode(Bool.self, forKey: .live)
            }
        }

        public struct TripDay: Decodable, Sendable, Equatable {
            public let day: String
            public let line: String

            private enum Keys: String, CodingKey {
                case day
                case line
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.day = try container.decode(String.self, forKey: .day)
                self.line = try container.decode(String.self, forKey: .line)
            }
        }

        public struct VoiceNote: Decodable, Sendable, Equatable {
            public let atMs: Int?
            public let words: String
            public let seconds: Int?
            public let record: MomentRecord?
            public let made: Made?

            private enum Keys: String, CodingKey {
                case atMs = "at_ms"
                case words
                case seconds
                case record
                case made
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.atMs = try container.decodeNil(forKey: .atMs) ? nil : container.decode(Int.self, forKey: .atMs)
                self.words = try container.decode(String.self, forKey: .words)
                self.seconds = try container.decodeNil(forKey: .seconds) ? nil : container.decode(Int.self, forKey: .seconds)
                self.record = try container.decodeNil(forKey: .record) ? nil : container.decode(MomentRecord.self, forKey: .record)
                self.made = try container.decodeNil(forKey: .made) ? nil : container.decode(Made.self, forKey: .made)
            }
        }

        public struct WaitingAsk: Decodable, Sendable, Equatable {
            public let id: String
            public let reader: String
            public let name: String
            public let by: By
            public let head: String
            public let line: String
            public let askedLine: [PhrasePart]
            public let underLine: [PhrasePart]
            public let saysTitle: String
            public let wants: String
            public let under: String?
            public let reason: String?
            public let screen: String?
            public let adds: [String]
            public let keeps: String?
            public let choices: [Choice]
            public let editable: Bool
            public let `default`: AskAnswer
            public let version: Int
            public let atMs: Int
            public let untilMs: Int
            public let state: AskState
            public let outcome: [PhrasePart]?

            private enum Keys: String, CodingKey {
                case id
                case reader
                case name
                case by
                case head
                case line
                case askedLine = "asked_line"
                case underLine = "under_line"
                case saysTitle = "says_title"
                case wants
                case under
                case reason
                case screen
                case adds
                case keeps
                case choices
                case editable
                case `default`
                case version
                case atMs = "at_ms"
                case untilMs = "until_ms"
                case state
                case outcome
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.id = try container.decode(String.self, forKey: .id)
                self.reader = try container.decode(String.self, forKey: .reader)
                self.name = try container.decode(String.self, forKey: .name)
                self.by = try container.decode(By.self, forKey: .by)
                self.head = try container.decode(String.self, forKey: .head)
                self.line = try container.decode(String.self, forKey: .line)
                self.askedLine = try container.decode([PhrasePart].self, forKey: .askedLine)
                self.underLine = try container.decode([PhrasePart].self, forKey: .underLine)
                self.saysTitle = try container.decode(String.self, forKey: .saysTitle)
                self.wants = try container.decode(String.self, forKey: .wants)
                self.under = try container.decodeNil(forKey: .under) ? nil : container.decode(String.self, forKey: .under)
                self.reason = try container.decodeNil(forKey: .reason) ? nil : container.decode(String.self, forKey: .reason)
                self.screen = try container.decodeNil(forKey: .screen) ? nil : container.decode(String.self, forKey: .screen)
                self.adds = try container.decode([String].self, forKey: .adds)
                self.keeps = try container.decodeNil(forKey: .keeps) ? nil : container.decode(String.self, forKey: .keeps)
                self.choices = try container.decode([Choice].self, forKey: .choices)
                self.editable = try container.decode(Bool.self, forKey: .editable)
                self.`default` = try container.decode(AskAnswer.self, forKey: .`default`)
                self.version = try container.decode(Int.self, forKey: .version)
                self.atMs = try container.decode(Int.self, forKey: .atMs)
                self.untilMs = try container.decode(Int.self, forKey: .untilMs)
                self.state = try container.decode(AskState.self, forKey: .state)
                self.outcome = try container.decodeNil(forKey: .outcome) ? nil : container.decode([PhrasePart].self, forKey: .outcome)
            }

            public enum By: String, Decodable, Sendable, Equatable {
                case agent
                case chat
                case unknown

                public init(from decoder: Decoder) throws {
                    self = try Self(rawValue: decoder.singleValueContainer().decode(String.self)) ?? .unknown
                }
            }

            public struct Choice: Decodable, Sendable, Equatable {
                public let answer: AskAnswer
                public let words: String

                private enum Keys: String, CodingKey {
                    case answer
                    case words
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.answer = try container.decode(AskAnswer.self, forKey: .answer)
                    self.words = try container.decode(String.self, forKey: .words)
                }
            }
        }

        public struct WaitingSignIn: Decodable, Sendable, Equatable {
            public let id: String
            public let name: String
            public let checked: Bool
            public let host: String?
            public let choices: [Int]
            public let atMs: Int
            public let untilMs: Int
            public let head: String
            public let overLine: [PhrasePart]
            public let sentence: String
            public let pick: String
            public let pickLine: String
            public let over: String
            public let app: String?
            public let notice: String

            private enum Keys: String, CodingKey {
                case id
                case name
                case checked
                case host
                case choices
                case atMs = "at_ms"
                case untilMs = "until_ms"
                case head
                case overLine = "over_line"
                case sentence
                case pick
                case pickLine = "pick_line"
                case over
                case app
                case notice
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.id = try container.decode(String.self, forKey: .id)
                self.name = try container.decode(String.self, forKey: .name)
                self.checked = try container.decode(Bool.self, forKey: .checked)
                self.host = try container.decodeNil(forKey: .host) ? nil : container.decode(String.self, forKey: .host)
                self.choices = try container.decode([Int].self, forKey: .choices)
                self.atMs = try container.decode(Int.self, forKey: .atMs)
                self.untilMs = try container.decode(Int.self, forKey: .untilMs)
                self.head = try container.decode(String.self, forKey: .head)
                self.overLine = try container.decode([PhrasePart].self, forKey: .overLine)
                self.sentence = try container.decode(String.self, forKey: .sentence)
                self.pick = try container.decode(String.self, forKey: .pick)
                self.pickLine = try container.decode(String.self, forKey: .pickLine)
                self.over = try container.decode(String.self, forKey: .over)
                self.app = try container.decodeNil(forKey: .app) ? nil : container.decode(String.self, forKey: .app)
                self.notice = try container.decode(String.self, forKey: .notice)
            }
        }

        public struct Week: Decodable, Sendable, Equatable {
            public let start: String
            public let count: Int
            public let day: String?

            private enum Keys: String, CodingKey {
                case start
                case count
                case day
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.start = try container.decode(String.self, forKey: .start)
                self.count = try container.decode(Int.self, forKey: .count)
                self.day = try container.decodeNil(forKey: .day) ? nil : container.decode(String.self, forKey: .day)
            }
        }

        public struct WeekCall: Decodable, Sendable, Equatable {
            public let day: String
            public let atMs: Int
            public let title: String
            public let icon: String
            public let lengthMs: Int?
            public let focus: String

            private enum Keys: String, CodingKey {
                case day
                case atMs = "at_ms"
                case title
                case icon
                case lengthMs = "length_ms"
                case focus
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.day = try container.decode(String.self, forKey: .day)
                self.atMs = try container.decode(Int.self, forKey: .atMs)
                self.title = try container.decode(String.self, forKey: .title)
                self.icon = try container.decode(String.self, forKey: .icon)
                self.lengthMs = try container.decodeNil(forKey: .lengthMs) ? nil : container.decode(Int.self, forKey: .lengthMs)
                self.focus = try container.decode(String.self, forKey: .focus)
            }
        }

        public enum When: Decodable, Sendable, Equatable {
            case day(day: String)
            case month(month: String)
            case at(atMs: Int)
            case clock(atMs: Int)
            case unknown

            private enum Keys: String, CodingKey {
                case kind
                case day
                case month
                case atMs = "at_ms"
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                switch try container.decode(String.self, forKey: .kind) {
                case "day":
                    self = .day(
                        day: try container.decode(String.self, forKey: .day)
                    )
                case "month":
                    self = .month(
                        month: try container.decode(String.self, forKey: .month)
                    )
                case "at":
                    self = .at(
                        atMs: try container.decode(Int.self, forKey: .atMs)
                    )
                case "clock":
                    self = .clock(
                        atMs: try container.decode(Int.self, forKey: .atMs)
                    )
                default:
                    self = .unknown
                }
            }
        }

        public struct WrittenDay: Decodable, Sendable, Equatable {
            public let day: String
            public let counts: Counts

            private enum Keys: String, CodingKey {
                case day
                case counts
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.day = try container.decode(String.self, forKey: .day)
                self.counts = try container.decode(Counts.self, forKey: .counts)
            }

            public struct Counts: Decodable, Sendable, Equatable {
                public let total: Int
                public let families: [Family]

                private enum Keys: String, CodingKey {
                    case total
                    case families
                }

                public init(from decoder: Decoder) throws {
                    let container = try decoder.container(keyedBy: Keys.self)
                    self.total = try container.decode(Int.self, forKey: .total)
                    self.families = try container.decode([Family].self, forKey: .families)
                }

                public struct Family: Decodable, Sendable, Equatable {
                    public let family: String
                    public let count: Int

                    private enum Keys: String, CodingKey {
                        case family
                        case count
                    }

                    public init(from decoder: Decoder) throws {
                        let container = try decoder.container(keyedBy: Keys.self)
                        self.family = try container.decode(String.self, forKey: .family)
                        self.count = try container.decode(Int.self, forKey: .count)
                    }
                }
            }
        }

        public struct YearSpan: Decodable, Sendable, Equatable {
            public let first: Int
            public let last: Int

            private enum Keys: String, CodingKey {
                case first
                case last
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                self.first = try container.decode(Int.self, forKey: .first)
                self.last = try container.decode(Int.self, forKey: .last)
            }
        }
    }
}
