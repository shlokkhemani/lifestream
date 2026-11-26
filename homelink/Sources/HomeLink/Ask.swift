import Foundation

extension HomeLink {
    public func ask(_ question: Ask.Question, chat: String? = nil, level: Ask.Level?, pick: Ask.Pick?) async throws -> AsyncThrowingStream<Ask.Event, Error> {
        var body = question.body
        if let chat { body["chat"] = chat }
        if let level { body["level"] = level.rawValue }
        if let pick {
            body["model"] = pick.model
            if let thinking = pick.thinking { body["thinking"] = thinking }
        }
        let (answer, token) = try await stream("POST", "/v1/ask", body: try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]))
        guard answer.status == 200 else { throw try await failure(answer, token: token) }
        return events(answer, token: token)
    }

    public func ask(_ question: String, chat: String? = nil, level: Ask.Level?, pick: Ask.Pick?) async throws -> AsyncThrowingStream<Ask.Event, Error> {
        try await ask(Ask.Question(words: question), chat: chat, level: level, pick: pick)
    }

    public func follow(chat: String) async throws -> AsyncThrowingStream<Ask.Event, Error>? {
        guard let path = Self.encoded(chat) else { throw LinkFailure.unusableID }
        let (answer, token) = try await stream("GET", "/v1/ask/chats/" + path + "/events", body: nil)
        if answer.status == 204 {
            observe(.answered, token: token, moves: true)
            return nil
        }
        guard answer.status == 200 else { throw try await failure(answer, token: token) }
        return events(answer, token: token)
    }

    public func stopAsking(chat: String) async throws -> Bool {
        let body = try JSONSerialization.data(withJSONObject: ["chat": chat])
        let response = try await contact("POST", "/v1/ask/stop", ["Content-Type": "application/json"], .json(body), timeout: Self.silence)
        guard response.status == 200 else { throw failure(response) }
        return try Self.decoded(Ask.Stopped.self, response).stopped
    }

    public func askReady(pick: Ask.Pick?) async throws -> Ask.Ready {
        guard let response = try await get("/v1/ask", [("model", pick?.model), ("thinking", pick?.thinking)]) else {
            throw LinkFailure.unreadable(304)
        }
        return try Self.decoded(Ask.Ready.self, response)
    }

    public func chatPrivacy(_ chat: String) async throws -> Ask.Privacy {
        guard let path = Self.encoded(chat) else { throw LinkFailure.unusableID }
        guard let response = try await get("/v1/privacy/chat/" + path) else { throw LinkFailure.unreadable(304) }
        return try Self.decoded(Ask.Privacy.self, response)
    }

    public func chats(after: String? = nil) async throws -> Ask.Chats {
        guard let response = try await get("/v1/ask/chats", [("after", after)]) else { throw LinkFailure.unreadable(304) }
        return try Self.decoded(Ask.Chats.self, response)
    }

    public func chat(_ chat: String) async throws -> Ask.Chat {
        guard let path = Self.encoded(chat) else { throw LinkFailure.unusableID }
        do {
            guard let response = try await get("/v1/ask/chats/" + path) else { throw LinkFailure.unreadable(304) }
            return try Self.decoded(Ask.Chat.self, response)
        } catch LinkFailure.refused(410, _, _) {
            throw Ask.Erased()
        }
    }


    private func stream(_ method: String, _ path: String, body: Data?) async throws -> (HomeStream, token: Int) {
        let token = tick()
        do {
            let answer = try await contact(method, path, body == nil ? [:] : ["Content-Type": "application/json"],
                                           { _ in body.map { .json($0) } ?? .empty }, timeout: Self.silence) { request, _ in
                try await self.stream(request)
            }
            return (answer, token)
        } catch {
            observe(error, token: token)
            throw error
        }
    }

    private func failure(_ answer: HomeStream, token: Int) async throws -> LinkFailure {
        var body = Data()
        do {
            for try await line in answer.lines { body += line + Data([0x0A]) }
        } catch {
            let reached = Self.reached(error)
            observe(reached, token: token)
            throw reached
        }
        let response = HomeResponse(status: answer.status, headers: answer.headers, body: body)
        observe(response, token: token)
        if response.status == 410 { throw Ask.Erased() }
        if let missing = Ask.Missing(response) { throw missing }
        let failure = failure(response)
        let object = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any]
        guard case .refused(let status, let code, _) = failure, object?["message"] == nil, let words = object?["error"] as? String else { return failure }
        return .refused(status: status, code: code, message: words)
    }

    private func events(_ answer: HomeStream, token: Int) -> AsyncThrowingStream<Ask.Event, Error> {
        let reader = Lines(answer.lines.makeAsyncIterator())
        let heard = { (heard: Heard) in
            guard !reader.heard else { return }
            reader.heard = true
            self.observe(heard, token: token, moves: heard == .answered)
        }
        return AsyncThrowingStream(unfolding: {
            while true {
                let line: Data?
                do {
                    line = try await reader.next()
                } catch {
                    let reached = Self.reached(error)
                    if reached is LinkFailure { heard(.silent) }
                    throw reached
                }
                guard let line else {
                    if reader.done { return nil }
                    heard(.silent)
                    throw LinkFailure.noAnswer(sent: true)
                }
                guard let read = try? JSONDecoder().decode(Ask.Line.self, from: line) else {
                    heard(.answered)
                    throw LinkFailure.unreadable(200)
                }
                switch read.event {
                case .chat?: reader.began = true
                case .done?: reader.done = true
                case .error(let kind, _)? where !reader.began || kind == "erased": reader.done = true
                default: break
                }
                if reader.done { heard(.answered) }
                if let event = read.event { return event }
            }
        })
    }

    private final class Lines: @unchecked Sendable {
        private var lines: AsyncThrowingStream<Data, Error>.AsyncIterator
        var began = false
        var done = false
        var heard = false

        init(_ lines: AsyncThrowingStream<Data, Error>.AsyncIterator) {
            self.lines = lines
        }

        func next() async throws -> Data? {
            try await lines.next()
        }
    }
}


extension HomeLink {
    public enum Ask {
        public enum Event: Sendable, Equatable {
            case chat(chat: String, n: Int, audio: String? = nil)
            case stepBegan(call: Int, words: String, said: String?)
            case stepEnded(call: Int, words: String, error: String?)
            case ref(handle: String, cited: Cited)
            case waiting(String)
            case words(String)
            case text(String)
            case done(Message)
            case title(chat: String, title: String)
            case error(kind: String, message: String)
            case access(AccessChange)
        }

        public struct Message: Decodable, Sendable, Equatable {
            public enum Role: String, Decodable, Sendable { case user, assistant }
            public enum End: String, Decodable, Sendable { case done, stopped, failed }

            public let chat: String
            public let n: Int
            public let atMs: Int64
            public let role: Role
            public let text: String
            public let refs: [String: Cited]?
            public let steps: [Step]?
            public let ms: Int?
            public let thoughtMs: Int?
            public let end: End?
            public let error: String?
            public let failed: String?
            public let unsaved: Bool?
            public let photos: [String]?
            public let voice: Voice?
            public let access: [AccessChange]?
            public let seen: Seen?

            public struct Seen: Decodable, Sendable, Equatable {
                public struct Span: Decodable, Sendable, Equatable {
                    public let start: Int
                    public let end: Int
                    public let placeholder: String?
                    public let added: String?

                    public init(start: Int, end: Int, placeholder: String? = nil, added: String? = nil) {
                        self.start = start
                        self.end = end
                        self.placeholder = placeholder
                        self.added = added
                    }

                    enum CodingKeys: String, CodingKey { case start, end, placeholder, added }

                    public init(from decoder: Decoder) throws {
                        let container = try decoder.container(keyedBy: CodingKeys.self)
                        start = try container.decode(Int.self, forKey: .start)
                        end = try container.decode(Int.self, forKey: .end)
                        placeholder = try container.decodeIfPresent(String.self, forKey: .placeholder)
                        added = try container.decodeIfPresent(String.self, forKey: .added)
                        guard (placeholder == nil) != (added == nil), end >= start, start >= 0, added == nil || end == start else {
                            throw DecodingError.dataCorruptedError(forKey: .start, in: container, debugDescription: "not a span")
                        }
                    }
                }

                public let asked: [Span]
                public let spoken: String?
                public let answered: [Span]
                public let photos: [String?]?

                public init(asked: [Span], spoken: String? = nil, answered: [Span], photos: [String?]? = nil) {
                    self.asked = asked
                    self.spoken = spoken
                    self.answered = answered
                    self.photos = photos
                }
            }

            public struct Voice: Decodable, Sendable, Equatable {
                public let audio: String
                public let ms: Int
                public let words: String?
                public let writing: Bool?
                public let failed: String?

                public init(audio: String, ms: Int, words: String? = nil, writing: Bool? = nil, failed: String? = nil) {
                    self.audio = audio
                    self.ms = ms
                    self.words = words
                    self.writing = writing
                    self.failed = failed
                }
            }

            public init(chat: String, n: Int, atMs: Int64, role: Role, text: String, refs: [String: Cited]? = nil,
                        steps: [Step]? = nil, ms: Int? = nil, thoughtMs: Int? = nil, end: End? = nil, error: String? = nil,
                        failed: String? = nil, unsaved: Bool? = nil, photos: [String]? = nil, voice: Voice? = nil,
                        access: [AccessChange]? = nil, seen: Seen? = nil) {
                self.chat = chat
                self.n = n
                self.atMs = atMs
                self.role = role
                self.text = text
                self.refs = refs
                self.steps = steps
                self.ms = ms
                self.thoughtMs = thoughtMs
                self.end = end
                self.error = error
                self.failed = failed
                self.unsaved = unsaved
                self.photos = photos
                self.voice = voice
                self.access = access
                self.seen = seen
            }

            enum CodingKeys: String, CodingKey {
                case chat, n, role, text, refs, steps, ms, end, error, failed, unsaved, photos, voice, access, seen
                case atMs = "at_ms"
                case thoughtMs = "thought_ms"
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                chat = try container.decode(String.self, forKey: .chat)
                n = try container.decode(Int.self, forKey: .n)
                atMs = try container.decode(Int64.self, forKey: .atMs)
                role = try container.decode(Role.self, forKey: .role)
                text = try container.decode(String.self, forKey: .text)
                refs = try container.decodeIfPresent([String: Decodes<Cited>].self, forKey: .refs)?.compactMapValues(\.value)
                steps = try container.decodeIfPresent([Step].self, forKey: .steps)
                ms = try container.decodeIfPresent(Int.self, forKey: .ms)
                thoughtMs = try container.decodeIfPresent(Int.self, forKey: .thoughtMs)
                end = try container.decodeIfPresent(End.self, forKey: .end)
                error = try container.decodeIfPresent(String.self, forKey: .error)
                failed = try container.decodeIfPresent(String.self, forKey: .failed)
                unsaved = try container.decodeIfPresent(Bool.self, forKey: .unsaved)
                photos = try container.decodeIfPresent([String].self, forKey: .photos)
                voice = try container.decodeIfPresent(Voice.self, forKey: .voice)
                access = try container.decodeIfPresent([AccessChange].self, forKey: .access)
                seen = (try? container.decodeIfPresent(Seen.self, forKey: .seen)) ?? nil
            }
        }

        public enum Cited: Decodable, Sendable, Equatable {
            case described(Citation)
            case ref(String)

            private enum Keys: String, CodingKey { case ref, kind }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: Keys.self)
                if container.contains(.kind) {
                    self = .described(try Citation(from: decoder))
                } else {
                    self = .ref(try container.decode(String.self, forKey: .ref))
                }
            }

            public var ref: String {
                switch self {
                case .described(let citation): citation.ref
                case .ref(let ref): ref
                }
            }

            public var citation: Citation? {
                if case .described(let citation) = self { citation } else { nil }
            }
        }

        public struct Step: Decodable, Sendable, Equatable {
            public let words: String
            public let error: String?

            public init(words: String, error: String? = nil) {
                self.words = words
                self.error = error
            }
        }

        public struct Pick: Codable, Sendable, Equatable {
            public let model: String
            public let thinking: String?

            public init(model: String, thinking: String? = nil) {
                self.model = model
                self.thinking = thinking
            }
        }

        public struct Ready: Decodable, Sendable, Equatable {
            public enum Login: String, Decodable, Sendable { case missing, ready, refused }

            public struct Model: Decodable, Sendable, Equatable, Identifiable {
                public let id: String
                public let name: String
                public let thinking: [String]
                public let `default`: String
                public let state: String
                public let photosOff: String?
                public let hides: Bool

                public var ready: Bool { state == "ready" }

                enum CodingKeys: String, CodingKey {
                    case id, name, thinking, `default`, state, hides
                    case photosOff = "photos_off"
                }
            }

            public struct Default: Decodable, Sendable, Equatable {
                public let model: String?
                public let thinking: String?
                public let shown: String?
                public let choose: String?
            }

            public let model: String?
            public let name: String?
            public let thinking: String?
            public let login: Login?
            public let said: String?
            public let gone: Bool?
            public let models: [Model]
            public let menu: Pages.ModelMenu
            public let `default`: Default
            public let starters: [Starter]
            public let voice: Voice
            public let limits: Limits

            public struct Limits: Decodable, Sendable, Equatable {
                public let photos: Int
                public let photoBytes: Int
                public let voiceMs: Int

                public init(photos: Int, photoBytes: Int, voiceMs: Int) {
                    self.photos = photos
                    self.photoBytes = photoBytes
                    self.voiceMs = voiceMs
                }

                enum CodingKeys: String, CodingKey {
                    case photos
                    case photoBytes = "photo_bytes"
                    case voiceMs = "voice_ms"
                }
            }

            public struct Voice: Decodable, Sendable, Equatable {
                public let ready: Bool
                public let words: String
                public let line: String?
                public let caution: String?
                public let value: String
                public let choices: [Choice]

                public struct Choice: Decodable, Sendable, Equatable {
                    public let value: String
                    public let words: String
                    public let sent: Bool
                }
            }

            public struct Starter: Decodable, Sendable, Equatable {
                public let kind: String
                public let question: String
            }
        }

        public enum Level: String, Codable, Sendable, CaseIterable {
            case all, names, none
        }

        public struct Privacy: Decodable, Sendable, Equatable {
            public let chat: String
            public let level: Level
            public let epoch: Int

            public init(chat: String, level: Level, epoch: Int) {
                self.chat = chat
                self.level = level
                self.epoch = epoch
            }
        }

        public struct Chats: Decodable, Sendable, Equatable {
            public let chats: [Listed]
            public let next: String?
        }

        public struct Listed: Decodable, Sendable, Equatable {
            public let chat: String
            public let title: String
            public let firstMs: Int64
            public let lastMs: Int64
            public let messages: Int

            enum CodingKeys: String, CodingKey {
                case chat, title, messages
                case firstMs = "first_ms"
                case lastMs = "last_ms"
            }
        }

        public struct Chat: Decodable, Sendable, Equatable {
            public struct Running: Decodable, Sendable, Equatable {
                public let n: Int
            }

            public let chat: String
            public let title: String
            public let messages: [Message]
            public let running: Running?
        }

        public struct Erased: Error, Sendable, Equatable {
            public init() {}
        }

        struct Stopped: Decodable {
            let stopped: Bool
        }

        struct Line: Decodable {
            let event: Event?

            private enum Keys: String, CodingKey { case type, chat, n, audio, call, words, said, ms, error, handle, cited, delta, message, title }

            init(from decoder: Decoder) throws {
                let line = try decoder.container(keyedBy: Keys.self)
                switch try line.decode(String.self, forKey: .type) {
                case "chat":
                    event = .chat(chat: try line.decode(String.self, forKey: .chat), n: try line.decode(Int.self, forKey: .n),
                                  audio: try line.decodeIfPresent(String.self, forKey: .audio))
                case "step" where line.contains(.ms):
                    event = .stepEnded(call: try line.decode(Int.self, forKey: .call), words: try line.decode(String.self, forKey: .words),
                                       error: try line.decodeIfPresent(String.self, forKey: .error))
                case "step":
                    event = .stepBegan(call: try line.decode(Int.self, forKey: .call), words: try line.decode(String.self, forKey: .words),
                                       said: try line.decodeIfPresent(String.self, forKey: .said))
                case "ref":
                    event = .ref(handle: try line.decode(String.self, forKey: .handle), cited: try line.decode(Cited.self, forKey: .cited))
                case "waiting":
                    event = .waiting(try line.decode(String.self, forKey: .words))
                case "words":
                    event = .words(try line.decode(String.self, forKey: .words))
                case "text":
                    event = .text(try line.decode(String.self, forKey: .delta))
                case "done":
                    event = .done(try line.decode(Message.self, forKey: .message))
                case "title":
                    event = .title(chat: try line.decode(String.self, forKey: .chat), title: try line.decode(String.self, forKey: .title))
                case "error":
                    event = .error(kind: try line.decode(String.self, forKey: .error), message: try line.decodeIfPresent(String.self, forKey: .message) ?? "")
                case "access":
                    event = .access(try AccessEvent(from: decoder).change)
                default:
                    event = nil
                }
            }
        }
    }
}
