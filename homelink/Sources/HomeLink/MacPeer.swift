import Foundation

extension HomeLink {
    public static let macExchangeRoute = "/v1/mac/exchange"
    public static let macPoll: TimeInterval = 35

    public struct MacExchangeRequest: Sendable, Equatable, Encodable {
        public var boot: String
        public var sources: [String]
        public var running: [String]
        public var results: [MacCommandResult]
        public var sleep: Bool

        public init(boot: String, sources: [String], running: [String] = [], results: [MacCommandResult] = [], sleep: Bool = false) {
            self.boot = boot
            self.sources = sources
            self.running = running
            self.results = results
            self.sleep = sleep
        }

        enum CodingKeys: String, CodingKey {
            case boot, sources, running, results, sleep
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(boot, forKey: .boot)
            try container.encode(sources, forKey: .sources)
            try container.encode(running, forKey: .running)
            try container.encode(results, forKey: .results)
            if sleep { try container.encode(true, forKey: .sleep) }
        }
    }

    public struct MacCommandError: Sendable, Equatable, Codable {
        public let code: String
        public let message: String

        public init(code: String, message: String) {
            self.code = code
            self.message = message
        }
    }

    public struct MacCommandResult: Sendable, Equatable, Codable {
        public static let unknownCommand = "UNKNOWN_COMMAND"

        public let id: String
        public let ok: Bool
        public let seals: [String: Int]?
        public let error: MacCommandError?

        public static func done(_ id: String, seals: [String: Int]? = nil) -> MacCommandResult {
            MacCommandResult(id: id, ok: true, seals: seals, error: nil)
        }

        public static func failed(_ id: String, code: String, message: String) -> MacCommandResult {
            MacCommandResult(id: id, ok: false, seals: nil, error: MacCommandError(code: code, message: message))
        }

        enum CodingKeys: String, CodingKey {
            case id, ok, seals, error
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(id, forKey: .id)
            try container.encode(ok, forKey: .ok)
            try container.encodeIfPresent(seals, forKey: .seals)
            if !ok { try container.encodeIfPresent(error, forKey: .error) }
        }
    }

    public enum MacCommand: Sendable, Equatable, Decodable {
        case refresh(id: String, connector: String)
        case settings(id: String)
        case flush(id: String, sources: [String]?, budgetMs: Int)
        case unknown(id: String, kind: String)

        public var id: String {
            switch self {
            case .refresh(let id, _), .settings(let id), .flush(let id, _, _), .unknown(let id, _): id
            }
        }

        enum CodingKeys: String, CodingKey {
            case id, kind, connector, sources
            case budgetMs = "budget_ms"
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let id = try container.decode(String.self, forKey: .id)
            let kind = (try? container.decode(String.self, forKey: .kind)) ?? ""
            switch kind {
            case "refresh":
                guard let connector = try? container.decode(String.self, forKey: .connector) else {
                    self = .unknown(id: id, kind: kind)
                    return
                }
                self = .refresh(id: id, connector: connector)
            case "settings":
                self = .settings(id: id)
            case "flush":
                guard let budget = try? container.decode(Int.self, forKey: .budgetMs), budget >= 0 else {
                    self = .unknown(id: id, kind: kind)
                    return
                }
                self = .flush(id: id, sources: try? container.decodeIfPresent([String].self, forKey: .sources), budgetMs: budget)
            default:
                self = .unknown(id: id, kind: kind)
            }
        }
    }

    public struct MacExchangeAnswer: Sendable, Equatable, Decodable {
        public let hand: Int
        public let calls: [MacCommand]

        public init(hand: Int, calls: [MacCommand]) {
            self.hand = hand
            self.calls = calls
        }

        enum CodingKeys: String, CodingKey {
            case hand, calls
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            hand = try container.decode(Int.self, forKey: .hand)
            calls = (try container.decodeIfPresent([Lossy].self, forKey: .calls) ?? []).compactMap(\.command)
        }

        private struct Lossy: Decodable {
            let command: MacCommand?

            init(from decoder: Decoder) throws {
                command = try? MacCommand(from: decoder)
            }
        }
    }

    public func macExchange(_ request: MacExchangeRequest, timeout: TimeInterval = HomeLink.macPoll) async throws -> MacExchangeAnswer {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let body = try encoder.encode(request)
        let response = try await contact("POST", Self.macExchangeRoute, ["Content-Type": "application/json"], .json(body),
                                         timeout: timeout)
        guard response.status == 200 else { throw failure(response) }
        return try Self.decoded(MacExchangeAnswer.self, response)
    }
}
