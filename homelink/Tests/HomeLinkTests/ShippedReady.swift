struct ShippedReady: Decodable, Equatable {
    enum Login: String, Decodable { case missing, ready, refused }

    struct Model: Decodable, Equatable {
        let id: String
        let name: String
        let thinking: [String]
        let `default`: String
        let group: String?
        let photos: Bool
    }

    let model: String
    let name: String
    let thinking: String
    let login: Login
    let said: String?
    let gone: Bool?
    let models: [Model]
    let starters: [Starter]
    let voice: Voice
    let limits: Limits

    struct Limits: Decodable, Equatable {
        let photos: Int
        let photoBytes: Int
        let voiceMs: Int

        enum CodingKeys: String, CodingKey {
            case photos
            case photoBytes = "photo_bytes"
            case voiceMs = "voice_ms"
        }
    }

    struct Voice: Decodable, Equatable {
        let ready: Bool
        let words: String
        let line: String?
        let caution: String?
        let value: String
        let choices: [Choice]

        struct Choice: Decodable, Equatable {
            let value: String
            let words: String
            let sent: Bool
        }
    }

    struct Starter: Decodable, Equatable {
        let kind: String
        let question: String
    }
}
