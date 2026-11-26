import CryptoKit
import Foundation
import HomeLink
import LifestreamCaptureCore
import UIKit

actor CannedAsk {
    static let shared = CannedAsk()

    static let down = ProcessInfo.processInfo.arguments.contains("--ui-test-ask-down")
    static let agentChat = ProcessInfo.processInfo.arguments.contains { $0.hasPrefix("agent-chat") }
    static let agentChatScreen = ProcessInfo.processInfo.arguments.contains("agent-chat-screen")
    static let signedOut = ProcessInfo.processInfo.arguments.contains("--ui-test-ask-signin")
    static let claudeRefused = ProcessInfo.processInfo.arguments.contains("--ui-test-ask-claude-refused")
    static let fresh = ProcessInfo.processInfo.arguments.contains("--ui-test-ask-fresh")
    static let voiceCloud = ProcessInfo.processInfo.arguments.contains("--ui-test-voice-cloud")
    static let voiceNone = ProcessInfo.processInfo.arguments.contains("--ui-test-voice-none")
    static let noteWords = "Where did I have dinner with Person A last week?"

    private static var starters: [[String: String]] {
        if CannedHome.emptyHome { return [] }
        return [["kind": "places", "question": "Where have I been today?"],
                ["kind": "walking", "question": "How far did I walk today?"],
                ["kind": "photos", "question": "What did I photograph this week?"]]
    }

    private struct Chat {
        let id: String
        var title: String
        var messages: [Data]
        var lastMs: Int64
    }

    private final class Turn {
        let n: Int
        var lines: [Data] = []
        var followers: [AsyncThrowingStream<Data, Error>.Continuation] = []
        var finished = false
        var stopping = false
        var said = ""
        var steps: [[String: Any]] = []
        var thought: Int?
        let started = AppClock.now

        init(n: Int) { self.n = n }
    }

    private var chats: [Chat] = []
    private var staged: [String: Data] = [:]
    private var submitted: [String: (chat: String, n: Int)] = [:]
    private var signInRefused = false
    private var seeded = false
    private var running: [String: Turn] = [:]
    private var levels: [String: String] = [:]
    private var seconds: [String: [Int: Data]] = [:]
    private var cancelled: Set<String> = []
    private var audios: [String: Data] = [:]
    private var voiceValue = "default"


    func perform(_ request: HomeRequest) async -> HomeResponse {
        seed()
        let path = request.url.path
        if path.hasPrefix("/v1/privacy/chat/") {
            let chat = String(path.dropFirst("/v1/privacy/chat/".count))
            return Self.reply(200, ["chat": chat, "level": levels[chat] ?? "all", "epoch": 0])
        }
        if path == "/v1/privacy" {
            return Self.reply(200, [
                "epoch": 0, "ready": true, "line": NSNull(), "marking": NSNull(), "level": "all", "chat": "all",
                "detector": ["runner": "off", "file": NSNull(), "state": "off", "line": NSNull(), "bytes": NSNull(), "total": NSNull(), "model": NSNull()],
                "levels": [String: [String]](), "links": "tokens", "always": [String](), "never": [String](), "types": [Any](), "today": [Any](),
            ])
        }
        if path == "/v1/ask/files", request.method == "POST" { return await stage(request) }
        if path.hasPrefix("/v1/ask/notes/") { return note(request) }
        if Self.down { return Self.reply(503, ["code": "ASK_DOWN", "message": "Ask is not answering on the home's Mac"]) }
        if path == "/v1/ask", request.method == "GET" {
            let query = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            return Self.reply(200, ready(model: query.first { $0.name == "model" }?.value, thinking: query.first { $0.name == "thinking" }?.value))
        }
        if path == "/v1/ask/stop", request.method == "POST" {
            guard case .json(let body) = request.body,
                  let chat = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["chat"] as? String else {
                return Self.reply(400, ["error": "Send JSON: {\"chat\": \"…\"}."])
            }
            let turn = running[chat]
            turn?.stopping = true
            return Self.reply(200, ["stopped": turn != nil])
        }
        if path == "/v1/ask/chats" {
            let listed = chats.sorted { $0.lastMs > $1.lastMs }.map { chat -> [String: Any] in
                ["chat": chat.id, "title": chat.title, "first_ms": Int64(chat.id.prefix(13)) ?? 0, "last_ms": chat.lastMs,
                 "messages": chat.messages.count]
            }
            return Self.reply(200, ["chats": listed])
        }
        let id = String(path.dropFirst("/v1/ask/chats/".count))
        guard path.hasPrefix("/v1/ask/chats/"), let chat = chats.first(where: { $0.id == id }) else {
            return Self.reply(404, ["error": "No conversation \(id)."])
        }
        var answer: [String: Any] = ["chat": chat.id, "title": chat.title,
                                     "messages": chat.messages.compactMap { try? JSONSerialization.jsonObject(with: $0) }]
        if let turn = running[chat.id] { answer["running"] = ["n": turn.n] }
        return Self.reply(200, answer)
    }

    private func stage(_ request: HomeRequest) async -> HomeResponse {
        guard case .file(let file) = request.body, let data = try? Data(contentsOf: file) else {
            return Self.reply(400, ["code": "FILE_KIND", "message": "Send the photo's bytes."])
        }
        if data.count > 25 * 1024 * 1024 { return Self.reply(413, ["code": "FILE_TOO_LARGE", "message": "Too large to send: over 25 MB."]) }
        try? await Task.sleep(for: .seconds(1.5))
        guard let image = UIImage(data: data), let cg = image.cgImage else {
            return Self.reply(422, ["code": "PICTURE_UNREADABLE", "message": "Lifestream can't read this picture."])
        }
        let name = "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        staged[name] = data
        return Self.reply(200, ["file": name, "kind": "photo", "width": cg.width, "height": cg.height])
    }

    func picture(_ name: String) -> Data? { staged[name] }

    func audio(_ name: String) -> Data? { audios[name] }

    private func note(_ request: HomeRequest) -> HomeResponse {
        let parts = request.url.path.dropFirst("/v1/ask/notes/".count).split(separator: "/").map(String.init)
        guard let note = parts.first else { return Self.reply(404, ["error": "No note."]) }
        switch (request.method, parts.count) {
        case ("POST", 1):
            seconds[note] = seconds[note] ?? [:]
            return Self.reply(200, ["note": note])
        case ("PUT", 2):
            guard let k = Int(parts[1]), case .file(let file) = request.body, let data = try? Data(contentsOf: file) else {
                return Self.reply(400, ["code": "SECOND_SHAPE", "message": "Send the second's bytes."])
            }
            if cancelled.contains(note) { return Self.reply(409, ["code": "NOTE_CLOSED", "message": "This voice note was let go."]) }
            seconds[note, default: [:]][k] = data
            return Self.reply(200, ["note": note, "k": k])
        case ("DELETE", 1):
            seconds[note] = nil
            cancelled.insert(note)
            return Self.reply(200, ["note": note])
        default:
            return Self.reply(404, ["error": "No route \(request.url.path)."])
        }
    }

    private func claim(_ voice: [String: Any]) -> (audio: String, ms: Int)? {
        if let audio = voice["audio"] as? String, let held = audios[audio] { return (audio, (held.count - 44) / 32) }
        guard let note = voice["note"] as? String, let count = voice["seconds"] as? Int, let held = seconds[note] else { return nil }
        let pcm = (0..<count).reduce(into: Data()) { $0.append(held[$1] ?? Data()) }
        let wav = ChatAudio.wav(pcm)
        let name = "sha256:" + SHA256.hash(data: wav).map { String(format: "%02x", $0) }.joined()
        audios[name] = wav
        return (name, pcm.count / 32)
    }

    private func missingSeconds(_ voice: [String: Any]?) -> [Int] {
        guard let voice, let note = voice["note"] as? String, let count = voice["seconds"] as? Int else { return [] }
        return (0..<count).filter { seconds[note]?[$0] == nil }
    }

    func choose(voice value: String, was: String?) -> Bool {
        guard was == nil || was == voiceValue else { return false }
        voiceValue = value
        return true
    }

    func stream(_ request: HomeRequest) async -> HomeStream {
        seed()
        if Self.down { return Self.lines(await perform(request)) }
        let chat: String
        if request.method == "POST" {
            guard case .json(let body) = request.body, let asked = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let submission = asked["submission"] as? String else {
                return Self.lines(Self.reply(400, ["error": "Send JSON: {\"submission\": \"…\", \"question\": \"…\"}."]))
            }
            let photos = asked["photos"] as? [String] ?? []
            let question = asked["question"] as? String ?? ""
            let voice = asked["voice"] as? [String: Any]
            if question.isEmpty, voice == nil { return Self.lines(Self.reply(422, ["error": "A question is typed words or a voice note: send one."])) }
            let gone = submitted[submission] == nil ? missingSeconds(voice) : []
            if let missing = photos.first(where: { staged[$0] == nil }) {
                return Self.lines(Self.reply(409, ["error": "Some files are missing.", "missing": ["photos": [missing], "seconds": gone]]))
            }
            if !gone.isEmpty {
                return Self.lines(Self.reply(409, ["error": "Some files are missing.", "missing": ["photos": [String](), "seconds": gone]]))
            }
            if let made = submitted[submission] {
                if running[made.chat] != nil { return HomeStream(status: 200, headers: ["Content-Type": "application/x-ndjson"], lines: AsyncThrowingStream { follow(made.chat, $0) }) }
                let messages = chats.first { $0.id == made.chat }?.messages.compactMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? []
                let audio = (messages.first { $0["n"] as? Int == made.n - 1 }?["voice"] as? [String: Any])?["audio"] as? String
                return Self.lines(Self.reply(200, Self.named(made.chat, made.n, audio: audio)),
                                  then: ["type": "done", "message": messages.last ?? [:]])
            }
            let wanted = asked["chat"] as? String
            if let wanted, running[wanted] != nil {
                return Self.lines(Self.reply(409, ["error": "This conversation is still answering its last question."]))
            }
            if let wanted, !chats.contains(where: { $0.id == wanted }) { return Self.lines(Self.reply(404, ["error": "No conversation \(wanted)."])) }
            let level = asked["level"] as? String
            if let level, !["all", "names", "none"].contains(level) {
                return Self.lines(Self.reply(422, ["code": "BAD_REQUEST", "message": "a conversation's level is all, names, none"]))
            }
            if question.lowercased().contains("sign-in") {
                signInRefused = true
                let refusal = (try? JSONSerialization.data(withJSONObject: ["type": "error", "error": "login", "message": Self.signInSentence])) ?? Data()
                return Self.lines(HomeResponse(status: 200, headers: ["Content-Type": "application/x-ndjson"], body: refusal))
            }
            let runs = asks(asked["model"] as? String, asked["thinking"] as? String)
            if let line = runs.line {
                let refusal = (try? JSONSerialization.data(withJSONObject: ["type": "error", "error": "login", "message": line])) ?? Data()
                return Self.lines(HomeResponse(status: 200, headers: ["Content-Type": "application/x-ndjson"], body: refusal))
            }
            let id = wanted ?? "\(Self.ms(AppClock.now))-" + String(format: "%06x", Int.random(in: 0..<0xFFFFFF))
            if let level { levels[id] = level }
            chat = begin(question, photos: photos, voice: voice.flatMap(claim), in: id, fresh: wanted == nil, asks: runs)
            submitted[submission] = (chat, running[chat]?.n ?? 0)
        } else {
            chat = String(request.url.path.dropFirst("/v1/ask/chats/".count).dropLast("/events".count))
            guard running[chat] != nil else { return HomeStream(status: 204, lines: HomeStream.lines(of: Data())) }
        }
        return HomeStream(status: 200, headers: ["Content-Type": "application/x-ndjson"], lines: AsyncThrowingStream { continuation in
            follow(chat, continuation)
        })
    }

    private func follow(_ chat: String, _ continuation: AsyncThrowingStream<Data, Error>.Continuation) {
        guard let turn = running[chat] else { return continuation.finish() }
        for line in turn.lines { continuation.yield(line) }
        if turn.finished { continuation.finish() } else { turn.followers.append(continuation) }
    }


    private func begin(_ question: String, photos: [String], voice: (audio: String, ms: Int)? = nil, in id: String, fresh: Bool, asks: Asks) -> String {
        let now = Self.ms(AppClock.now)
        let opening = voice != nil ? "Voice note" : Self.opening(question)
        if fresh { chats.append(Chat(id: id, title: opening, messages: [], lastMs: now)) }
        let index = chats.firstIndex { $0.id == id }!
        let n = chats[index].messages.count + 1
        chats[index].messages.append(Self.message(id, n, now, "user", question, photos: photos,
                                                  voice: voice.map { ["audio": $0.audio, "ms": $0.ms, "writing": true] }))
        chats[index].lastMs = now
        running[id] = Turn(n: n + 1)
        let lowered = question.lowercased()
        let script: Script = lowered.contains("everything") ? .endless : lowered.contains("broken") ? .broken : .answer
        Task { await self.answer(id, script: script, titled: fresh, asks: asks, voice: voice) }
        return id
    }

    private enum Script { case answer, endless, broken }

    private func answer(_ chat: String, script: Script, titled: Bool, asks: Asks, voice: (audio: String, ms: Int)? = nil) async {
        guard let turn = running[chat] else { return }
        let started = turn.started
        emit(turn, Self.named(chat, turn.n, audio: voice?.audio))
        if let voice {
            _ = await pause(turn, 1.5)
            emit(turn, ["type": "words", "words": Self.noteWords])
            if let index = chats.firstIndex(where: { $0.id == chat }), let last = chats[index].messages.indices.last {
                chats[index].messages[last] = Self.message(chat, turn.n - 1, Self.ms(started), "user", "",
                                                           voice: ["audio": voice.audio, "ms": voice.ms, "words": Self.noteWords])
            }
        }
        var end = "done"
        var error: String?
        var failed: String?
        let refs = Self.refs()
        run: do {
            guard await pause(turn, 0.4),
                  await step(turn, 1, "search", "Searching messages for “dinner”", "Searched messages for “dinner”", ms: 612) else { end = "stopped"; break run }
            switch script {
            case .answer:
                guard await pause(turn, 0.3),
                      await step(turn, 2, "photos", "Looking at 1 photo", "Looked at 1 photo", ms: 540, said: "Let me look at the photos too") else { end = "stopped"; break run }
                guard await write(turn, Self.pieces(Self.answer), every: 0.2, refs: refs) else { end = "stopped"; break run }
            case .endless:
                guard await write(turn, Array(repeating: "Here is everything, day by day. ", count: 200), every: 0.3) else { end = "stopped"; break run }
            case .broken:
                guard await step(turn, 2, "fetch", "Opening example.com", "Couldn’t open example.com", ms: 2_100, error: "fetch failed"),
                      await write(turn, ["I found the chat, but "], every: 0.3) else { end = "stopped"; break run }
                end = "failed"
                error = "ChatGPT didn't answer: this Mac can't reach it. Check that it's online."
                failed = "model"
                emit(turn, ["type": "error", "error": "model", "message": error!])
            }
        }
        let now = Self.ms(AppClock.now)
        var message: [String: Any] = ["type": "ask.msg", "chat": chat, "n": turn.n, "at_ms": now, "role": "assistant", "text": turn.said,
                                      "model": asks.id, "thinking": asks.thinking, "ms": Int(AppClock.now.timeIntervalSince(started) * 1000), "end": end]
        if let thought = turn.thought { message["thought_ms"] = thought }
        if !turn.steps.isEmpty { message["steps"] = turn.steps }
        if end == "done", script == .answer { message["refs"] = refs }
        if let error { message["error"] = error }
        if let failed { message["failed"] = failed }
        if let index = chats.firstIndex(where: { $0.id == chat }) {
            chats[index].messages.append((try? JSONSerialization.data(withJSONObject: message)) ?? Data())
            chats[index].lastMs = now
        }
        emit(turn, ["type": "done", "message": message])
        if titled, let index = chats.firstIndex(where: { $0.id == chat }) {
            if script == .answer { chats[index].title = "Dinner with Person A" }
            emit(turn, ["type": "title", "chat": chat, "title": chats[index].title])
        }
        turn.finished = true
        for follower in turn.followers { follower.finish() }
        turn.followers = []
        running[chat] = nil
    }

    private func pause(_ turn: Turn, _ seconds: Double) async -> Bool {
        try? await Task.sleep(for: .seconds(seconds))
        return !turn.stopping
    }

    private func step(_ turn: Turn, _ call: Int, _ name: String, _ underWay: String, _ words: String, ms: Int,
                      error: String? = nil, said: String? = nil) async -> Bool {
        var began: [String: Any] = ["type": "step", "call": call, "name": name, "words": underWay]
        if let said { began["said"] = said }
        emit(turn, began)
        turn.thought = nil
        guard await pause(turn, 1.2) else { return false }
        var ended: [String: Any] = ["type": "step", "call": call, "words": words, "ms": ms]
        var kept: [String: Any] = ["name": name, "words": words, "ms": ms]
        if let error {
            ended["error"] = error
            kept["error"] = error
        }
        emit(turn, ended)
        turn.steps.append(kept)
        return true
    }

    private func write(_ turn: Turn, _ pieces: [String], every seconds: Double, refs: [String: Any] = [:]) async -> Bool {
        var told: Set<String> = []
        for piece in pieces {
            if turn.thought == nil { turn.thought = Int(AppClock.now.timeIntervalSince(turn.started) * 1000) }
            for cited in piece.matches(of: /\b(r\d+)\b/) {
                let handle = String(cited.output.1)
                if let ref = refs[handle], told.insert(handle).inserted { emit(turn, ["type": "ref", "handle": handle, "cited": ref]) }
            }
            emit(turn, ["type": "text", "delta": piece])
            turn.said += piece
            guard await pause(turn, seconds) else { return false }
        }
        return true
    }

    private func emit(_ turn: Turn, _ event: [String: Any]) {
        guard let line = try? JSONSerialization.data(withJSONObject: event) else { return }
        turn.lines.append(line)
        for follower in turn.followers { follower.yield(line) }
    }


    private var offered: [[String: Any]] {
        let claude = Self.claudeRefused || Self.signedOut || signInRefused
        let claudes = [Self.model("claude/opus", "Claude Opus 5.5", ["low", "medium", "high", "max"], "high", ready: !claude),
                       Self.model("claude/sonnet", "Claude Sonnet 5.5", ["low", "medium", "high"], "medium", ready: !claude)]
        if Self.signedOut || signInRefused { return claudes }
        return [
            Self.model("gpt-6.1-terra", "GPT-6.1 Terra", ["low", "medium", "high", "xhigh", "max"], "high"),
            Self.model("gpt-6-luna", "GPT-6 Luna", ["low", "medium", "high", "xhigh", "max"], "high"),
            Self.model("gpt-6-sol", "GPT-6 Sol", ["low", "medium"], "medium", photos: false),
        ] + claudes + [
            ["id": Self.qwen, "name": "Qwen 3.5 9B", "thinking": [String](), "default": "", "state": "ready",
             "photos_off": "Qwen 3.5 9B can't see photos.", "hides": false],
        ]
    }

    private static let qwen = "runner:macbook-pro-0001/qwen-3.5-9b"

    private func menu(chosen: String) -> [String: Any] {
        let usable = offered.filter { $0["state"] as? String == "ready" }
        let row = { (model: [String: Any]) -> [String: Any] in
            ["value": model["id"] ?? "", "name": model["name"] ?? "", "account": NSNull(), "chosen": model["id"] as? String == chosen]
        }
        let local = usable.filter { $0["id"] as? String == Self.qwen }.map(row)
        return ["default": NSNull(), "rows": usable.filter { $0["id"] as? String != Self.qwen }.map(row),
                "local": local.isEmpty ? NSNull() as Any : ["label": "Local", "rows": local] as Any,
                "more": ["words": "More", "use": "chat", "work": NSNull()], "off": NSNull()]
    }

    private static func model(_ id: String, _ name: String, _ thinking: [String], _ level: String, photos: Bool = true,
                              ready: Bool = true) -> [String: Any] {
        ["id": id, "name": name, "thinking": thinking, "default": level, "state": ready ? "ready" : "unavailable",
         "photos_off": photos ? NSNull() as Any : "\(name) can't see photos." as Any, "hides": true]
    }

    private var chatDefault: (model: String, thinking: String) {
        Self.signedOut || signInRefused ? ("claude/opus", "high") : ("gpt-6.1-terra", "high")
    }

    private static var limits: [String: Any] { ["photos": 10, "photo_bytes": 26_214_400, "voice_ms": 600_000] }

    private static let signInSentence = "Chat needs your Claude sign-in on your Mac."

    private struct Asks {
        let id: String
        let name: String
        let thinking: String
        let gone: Bool
        let line: String?
    }

    private func asks(_ model: String?, _ thinking: String?) -> Asks {
        let rows = offered
        let listed = model.flatMap { id in rows.first { $0["id"] as? String == id } }
        let chosen = listed ?? rows.first { $0["id"] as? String == chatDefault.model } ?? rows[0]
        let levels = chosen["thinking"] as? [String] ?? []
        let wanted = listed == nil ? chatDefault.thinking : thinking
        return Asks(id: chosen["id"] as? String ?? "", name: chosen["name"] as? String ?? "",
                    thinking: wanted.flatMap { levels.contains($0) ? $0 : nil } ?? chosen["default"] as? String ?? "",
                    gone: model != nil && listed == nil, line: chosen["state"] as? String == "ready" ? nil : Self.signInSentence)
    }

    private func ready(model: String?, thinking: String?) -> [String: Any] {
        let runs = asks(model, thinking)
        var answer: [String: Any] = ["models": offered, "menu": menu(chosen: runs.id),
                                     "default": ["model": chatDefault.model, "thinking": chatDefault.thinking, "shown": chatDefault.model, "choose": NSNull()],
                                     "starters": Self.starters, "limits": Self.limits, "voice": voiceReady]
        if runs.gone { answer["gone"] = true }
        if let line = runs.line {
            answer["said"] = line
            answer["act"] = "Sign in with Claude…"
        }
        return answer
    }


    private static let answer = "You had dinner with Person A at The Office on Friday [r1, r2, r3], and Person A sent a photo of the table [r2].\n\n"
        + "What came up:\n\n- The trip next month, which Person A is planning [r1]\n- Who books the table next time"

    private static func pieces(_ text: String) -> [String] {
        var pieces: [String] = []
        var piece = ""
        for word in text.split(separator: " ", omittingEmptySubsequences: false) {
            piece += (piece.isEmpty && pieces.isEmpty ? "" : " ") + word
            if piece.count > 18 {
                pieces.append(piece)
                piece = ""
            }
        }
        if !piece.isEmpty { pieces.append(piece) }
        return pieces
    }

    private static func refs() -> [String: Any] {
        let days = CannedDays.days(CannedHome.Routine(now: AppClock.now)).reversed()
        var refs: [String: Any] = [:]
        func message(_ atom: HomeLink.DayFile.Atom, _ record: HomeLink.DayFile.RecordRef, on day: String) -> [String: Any] {
            ["ref": "record.canned-\(day)-\(atom.n)", "kind": "message", "day": day, "title": "Chat with Person A",
             "chat": "chat.canned-" + (atom.block?.key ?? ""), "chat_title": "Person A",
             "opens": ["page": "days", "day": day, "focus": "rec:\(record.source) \(record.kind) \(record.key)"]]
        }
        for file in days {
            if refs["r1"] == nil, let atom = file.atoms.first(where: { $0.family == "messages" && $0.record != nil && $0.text.hasPrefix("Person A:") }),
               let record = atom.record {
                refs["r1"] = message(atom, record, on: file.day)
                if let other = file.atoms.first(where: { $0.n != atom.n && $0.record != nil && $0.block?.key == atom.block?.key }), let record = other.record {
                    refs["r3"] = message(other, record, on: file.day)
                }
            }
            if refs["r2"] == nil, let atom = file.atoms.first(where: { $0.family == "photos" }) {
                refs["r2"] = ["ref": "record.canned-\(file.day)-\(atom.n)", "kind": "photo", "day": file.day, "title": "Photo with Person A",
                              "image": CannedHome.photoHash, "opens": ["page": "days", "day": file.day, "focus": "u:" + atom.unit]]
            }
        }
        return refs
    }

    private static let voiceNote: (name: String, bytes: Data) = {
        let bytes = ChatAudio.wav(Data(count: 32_000 * 6))
        return ("sha256:" + SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(), bytes)
    }()

    private static func voiced() -> [String: Any] {
        var cited = refs()["r1"] as? [String: Any] ?? [:]
        cited["voice"] = ["audio": voiceNote.name, "record": cited["ref"] ?? "", "seconds": 6, "from": "Person A"]
        return cited
    }

    private func seed() {
        guard !seeded else { return }
        seeded = true
        if CannedHome.emptyHome || Self.fresh { return }
        let now = AppClock.now
        func at(_ hoursBack: Double) -> Int64 { Self.ms(now.addingTimeInterval(-hoursBack * 3600)) }
        func chat(_ hoursBack: Double, _ hex: String, _ title: String, _ turns: [(question: String, back: Double, answer: [String: Any])]) {
            let id = "\(at(hoursBack))-\(hex)"
            var messages: [Data] = []
            for turn in turns {
                messages.append(Self.message(id, messages.count + 1, at(turn.back), "user", turn.question))
                var answer = turn.answer
                answer.merge(["type": "ask.msg", "chat": id, "n": messages.count + 1, "at_ms": at(turn.back - 0.01),
                              "role": "assistant", "model": "gpt-6.1-terra", "thinking": "high"]) { kept, _ in kept }
                messages.append((try? JSONSerialization.data(withJSONObject: answer)) ?? Data())
            }
            chats.append(Chat(id: id, title: title, messages: messages, lastMs: at(turns.last!.back - 0.01)))
        }
        let searched: [[String: Any]] = [["name": "search", "words": "Searched messages for “dinner”", "ms": 612],
                                         ["name": "photos", "words": "Looked at 1 photo", "ms": 540]]
        chat(26, "0a11f0", "Dinner with Person A on Friday", [
            ("When did I last have dinner with Person A?", 26, ["text": Self.answer, "refs": Self.refs(), "steps": searched, "ms": 9_400, "thought_ms": 6_800, "end": "done"]),
            ("And who paid?", 2, ["text": "You did: the payment that evening is yours [r1].", "refs": ["r1": Self.refs()["r1"]!],
                                  "steps": [["name": "search", "words": "Searched payments for “dinner”", "ms": 380]], "ms": 3_200, "thought_ms": 2_400, "end": "done"]),
        ])
        chat(5, "0b22e1", "Sleep this week", [
            ("How did I sleep this week?", 5, ["text": "Your three longest nights this week:\n\n| Night | Asleep |\n|---|---|\n| Mon | 8 h 10 m |\n| Thu | 7 h 48 m |\n| Sat | 7 h 31 m |",
                                               "steps": [["name": "day", "words": "Read your sleep, 7 nights", "ms": 1_840]], "ms": 6_100, "end": "done",
                                               "unsaved": true]),
        ])
        chat(30, "0c33d2", "What Person B said about the move", [
            ("What did Person B say about the move?", 30, ["text": "Person B said the move could wait until",
                                                         "steps": [["name": "conversation", "words": "Read the chat with Person B", "ms": 2_200]],
                                                         "ms": 4_000, "end": "stopped"]),
        ])
        chat(80, "0d44c3", "The visa guide", [
            ("Where is the visa guide Person C sent?", 80, ["text": "", "steps": [["name": "search", "words": "Searched messages for “visa guide”", "ms": 700]],
                                                          "ms": 30_000, "end": "failed", "failed": "model",
                                                          "error": "ChatGPT didn't answer: this Mac can't reach it. Check that it's online."]),
        ])
        chat(24 * 40, "0e55b4", "Booking at Synthetic Cafe", [
            ("When did I book Synthetic Cafe?", 24 * 40, ["text": "On a Monday, by mail.", "ms": 2_000, "end": "done"]),
        ])
        chat(24 * 50, "0e66c5", "A call with Person A", [
            ("When did Person A last call?", 24 * 50, ["text": "Person A called on Sunday, for 12 minutes.", "ms": 2_400, "end": "done",
                                                       "seen": ["asked": [["start": 9, "end": 17, "placeholder": "[[Person 1]]"]],
                                                                "answered": [["start": 0, "end": 8, "placeholder": "[[Person 1]]"]]]]),
        ])
        audios[Self.voiceNote.name] = Self.voiceNote.bytes
        chat(24 * 55, "0e77d6", "Table booking", [
            ("What did Person A say about the table?", 24 * 55, ["text": "Person A said the table is booked for eight [r1].",
                                                                 "refs": ["r1": Self.voiced()], "ms": 2_100, "end": "done"]),
        ])
        if Self.agentChat {
            let change = { (name: String) in CannedHome.Agents.contract(name)["answer"] as Any }
            let asked = change(Self.agentChatScreen ? "propose-asked-screen" : "propose-asked")
            chat(0.05, "0f66a5", "Agents\u{2019} access", [
                ("let Instinct read only the past 24 hours", 0.06, ["text": "", "end": "done", "access": [change("propose-narrowed")]]),
                ("and let it read Health", 0.05, ["text": "", "end": "done", "access": [asked]]),
            ])
        }
        guard AppRuntime.asked("--ui-test-crowd") else { return }
        for month in 0..<16 {
            let back = Double(24 * (60 + 9 * month))
            chat(back, String(format: "1f%04x", month), "What happened in synthetic week \(month + 1)", [
                ("What happened in synthetic week \(month + 1)?", back, ["text": "A quiet week.", "ms": 1_500, "end": "done"]),
            ])
        }
    }

    private var voiceReady: [String: Any] {
        let parakeet = "runner:macbook-pro-0001/parakeet-unified-en-0.6b"
        let cloud = "openrouter:elevenlabs/scribe-v2"
        let choices: [[String: Any]] = [["value": parakeet, "words": "Parakeet · your Mac", "sent": false],
                                        ["value": cloud, "words": "Scribe v2 · Sent as it is", "sent": true]]
        if Self.voiceNone {
            return ["ready": false, "words": "No voice model",
                    "line": "Choose a model for Voice notes", "caution": NSNull(),
                    "value": "default", "choices": [[String: Any]]()]
        }
        let route = voiceValue == "default" ? (Self.voiceCloud ? cloud : parakeet) : voiceValue
        let leaves = route == cloud
        return ["ready": true, "words": leaves ? "Scribe v2 · Sent as it is" : "Parakeet · your Mac", "line": NSNull(),
                "caution": leaves ? "Voice notes go to OpenRouter as they are: sound can't be hidden." : NSNull(),
                "value": voiceValue, "choices": choices]
    }


    private static func message(_ chat: String, _ n: Int, _ atMs: Int64, _ role: String, _ text: String, photos: [String] = [],
                                voice: [String: Any]? = nil) -> Data {
        var message: [String: Any] = ["type": "ask.msg", "chat": chat, "n": n, "at_ms": atMs, "role": role, "text": text]
        if !photos.isEmpty { message["photos"] = photos }
        if let voice { message["voice"] = voice }
        return (try? JSONSerialization.data(withJSONObject: message)) ?? Data()
    }

    private static func opening(_ question: String) -> String {
        let words = question.split(separator: " ")
        return words.prefix(8).joined(separator: " ") + (words.count > 8 ? "…" : "")
    }

    private static func ms(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded(.down)) }

    private static func named(_ chat: String, _ n: Int, audio: String?) -> [String: Any] {
        var event: [String: Any] = ["type": "chat", "chat": chat, "n": n]
        if let audio { event["audio"] = audio }
        return event
    }

    private static func reply(_ status: Int, _ object: [String: Any]) -> HomeResponse {
        HomeResponse(status: status, body: (try? JSONSerialization.data(withJSONObject: object)) ?? Data())
    }

    private static func lines(_ response: HomeResponse, then more: [String: Any]? = nil) -> HomeStream {
        let next = more.flatMap { try? JSONSerialization.data(withJSONObject: $0) }.map { Data([0x0A]) + $0 } ?? Data()
        return HomeStream(status: response.status, headers: response.headers, lines: HomeStream.lines(of: response.body + next))
    }
}
