import Cockpit
import Combine
import Foundation
import HomeLink
import LifestreamCaptureCore

@MainActor
final class AskBook: ObservableObject {
    static let shared = AskBook()

    @Published private(set) var listed: [HomeLink.Ask.Listed]?
    @Published private(set) var failure: LifeReader.Failure?
    @Published private(set) var ready: HomeLink.Ask.Ready?
    @Published private(set) var down: String?
    @Published private(set) var pick: HomeLink.Ask.Pick?
    @Published private(set) var chosen: Asks?
    @Published var draft = ""
    @Published var picked: [String] = []
    @Published private(set) var unkept: String?
    @Published var focus = false

    struct Asks: Equatable {
        let model: String
        let name: String
        let thinking: String
    }

    private var opened: [String: AskConversation] = [:]
    private var all: [AskConversation] = []
    private var begun = 0
    private var generation = 0
    private let defaults: UserDefaults
    private static let kept = "ask.pick"
    private let reader: @MainActor () -> LifeReader
    fileprivate var life: LifeReader { reader() }
    private let lacking: @MainActor () -> Bool
    let outbox: AskOutbox
    let recorder: ChatRecorder
    let player: NotePlayer
    let background: @MainActor () -> Background
    private var hearing: AnyCancellable?

    init(defaults: UserDefaults = .standard, life: @escaping @MainActor () -> LifeReader = { AppRuntime.shared.life },
         lacks: @escaping @MainActor () -> Bool = { AppRuntime.shared.reach.lacks }, outbox: AskOutbox? = nil,
         recorder: ((AskOutbox) -> ChatRecorder)? = nil, player: NotePlayer = .shared,
         background: @escaping @MainActor () -> Background = { Background.app() }) {
        self.defaults = defaults
        reader = life
        lacking = lacks
        self.player = player
        self.background = background
        let outbox = outbox ?? .shared
        self.outbox = outbox
        self.recorder = recorder?(outbox) ?? ChatRecorder(outbox: outbox)
        pick = defaults.data(forKey: Self.kept).flatMap { try? JSONDecoder().decode(HomeLink.Ask.Pick.self, from: $0) }
        hearing = player.heard.sink { [weak self] heard in MainActor.assumeIsolated { self?.heard(heard) } }
    }

    private func heard(_ heard: NotePlayer.Heard) {
        guard case .held(let audio) = heard.sound else { return }
        for conversation in all where !conversation.gone {
            if let voice = conversation.cited(audio) { conversation.heard(heard, of: voice) }
        }
    }

    var listDown: Bool {
        if case .busy(_, "ASK_DOWN", _, _) = failure { true } else { false }
    }


    var asks: Asks? {
        if let chosen { return chosen }
        guard let ready, let runs = runsOn ?? ready.models.first(where: { $0.id == ready.default.shown }).map({ (model: $0, thinking: ready.default.thinking) })
        else { return nil }
        return Asks(model: runs.model.id, name: runs.model.name, thinking: Self.level(of: runs.model, runs.thinking))
    }

    private var runsOn: (model: HomeLink.Ask.Ready.Model, thinking: String?)? {
        guard let ready else { return nil }
        if let pick, let model = ready.models.first(where: { $0.id == pick.model }) { return (model, pick.thinking) }
        guard let id = ready.default.model, let model = ready.models.first(where: { $0.id == id }) else { return nil }
        return (model, ready.default.thinking)
    }

    private static func level(of model: HomeLink.Ask.Ready.Model, _ wanted: String?) -> String {
        wanted.flatMap { model.thinking.contains($0) ? $0 : nil } ?? model.default
    }

    var models: [HomeLink.Ask.Ready.Model] { ready?.models ?? [] }

    var stays: Bool {
        guard let asks, let model = models.first(where: { $0.id == asks.model }) else { return true }
        return !model.hides
    }

    var chooseWords: String? { asks == nil ? ready?.default.choose : nil }

    var menu: HomeLink.Pages.ModelMenu? { ready?.menu }

    var waits: Bool { down != nil || (ready != nil && runsOn?.model.ready != true) }

    var askable: Bool { !waits }

    var limits: HomeLink.Ask.Ready.Limits? { ready?.limits }

    func unattachable(holding picked: Int) -> String? {
        if let asks, let off = models.first(where: { $0.id == asks.model })?.photosOff { return off }
        if let limits, picked >= limits.photos { return "At most \(limits.photos) photos a question." }
        return nil
    }


    var voice: HomeLink.Ask.Ready.Voice? { ready?.voice }

    func record(for owner: String) {
        guard let voice, let limits else { return }
        player.stop()
        recorder.start(for: owner, unready: voice.ready ? nil : voice.line ?? "Voice notes need a voice model.", limits: limits)
    }

    var voiceChoice: String? {
        guard let voice else { return nil }
        if voice.value != "default" { return voice.value }
        return voice.choices.first { $0.words == voice.words }?.value
    }

    func chooseVoice(_ value: String) {
        guard let voice, value != voiceChoice else { return }
        let life = life
        Task {
            _ = try? await life.chooseVoice(value, was: voice.value)
            await readReady()
        }
    }

    func begin(voice note: ChatRecorder.Note, photos: [String] = []) -> String? {
        begin { $0.ask(voice: note, photos: photos) }
    }

    private func begin(_ asked: (AskConversation) -> Bool) -> String? {
        let made = upcoming()
        guard asked(made) else { return nil }
        begun += 1
        return made.key
    }

    var unread: Bool { ready == nil && down == nil }

    func choose(model id: String) {
        guard let model = models.first(where: { $0.id == id }) else { return }
        let level = pick?.thinking.flatMap { model.thinking.contains($0) ? $0 : nil }
        keep(HomeLink.Ask.Pick(model: id, thinking: level), drawn: Asks(model: id, name: model.name, thinking: level ?? model.default))
    }

    func choose(found row: HomeLink.Pages.ModelRow) {
        if models.contains(where: { $0.id == row.value }) { return choose(model: row.value) }
        keep(HomeLink.Ask.Pick(model: row.value, thinking: nil), drawn: Asks(model: row.value, name: row.name, thinking: ""))
    }

    func choose(thinking level: String) {
        guard let asks, let model = models.first(where: { $0.id == asks.model }) else { return }
        keep(HomeLink.Ask.Pick(model: asks.model, thinking: level), drawn: Asks(model: asks.model, name: model.name, thinking: level))
    }

    func reset() {
        guard pick != nil else { return }
        keep(nil, drawn: nil)
    }

    private func keep(_ new: HomeLink.Ask.Pick?, drawn: Asks?) {
        store(new)
        chosen = drawn
        Task { await readReady() }
    }

    private func store(_ new: HomeLink.Ask.Pick?) {
        pick = new
        if let new, let data = try? JSONEncoder().encode(new) { defaults.set(data, forKey: Self.kept) } else { defaults.removeObject(forKey: Self.kept) }
    }

    func readReady() async {
        generation += 1
        let mine = generation
        let sent = pick
        do {
            let answer = try await life.askReady(pick: sent)
            guard mine == generation, sent == pick else { return }
            if answer.gone == true { store(nil) }
            let fix = ready?.voice.line
            ready = answer
            chosen = nil
            down = nil
            if answer.voice.ready, let fix, recorder.said == fix { recorder.said = nil }
            resend()
        } catch is CancellationError {
        } catch let failure as LifeReader.Failure {
            guard mine == generation else { return }
            if case .busy(let words, "ASK_DOWN", _, _) = failure { down = words }
        } catch {}
    }


    var conversations: [Row] {
        var rows = (listed ?? []).map { Row(key: $0.chat, title: opened[$0.chat]?.title ?? $0.title, lastMs: $0.lastMs,
                                             running: opened[$0.chat]?.running ?? false) }
        for conversation in all where !rows.contains(where: { $0.key == conversation.chat }) && !conversation.turns.isEmpty {
            rows.append(Row(key: conversation.chat ?? conversation.key, title: conversation.title ?? "", lastMs: conversation.lastMs,
                            running: conversation.running))
        }
        return rows.sorted { $0.lastMs > $1.lastMs }
    }

    var starters: [HomeLink.Ask.Ready.Starter] {
        guard listed != nil, conversations.isEmpty, askable, !lacking() else { return [] }
        return ready?.starters ?? []
    }

    struct Row: Identifiable, Equatable {
        let key: String
        let title: String
        let lastMs: Int64
        let running: Bool
        var id: String { key }
    }

    func read() async {
        outbox.start()
        resend()
        do {
            var chats: [HomeLink.Ask.Listed] = []
            var after: String?
            repeat {
                let page = try await life.chats(after: after)
                chats += page.chats.filter { listed in !chats.contains { $0.chat == listed.chat } }
                after = page.next
            } while after != nil
            listed = chats
            failure = nil
        } catch is CancellationError {
        } catch let failure as LifeReader.Failure {
            self.failure = failure
            if listDown { listed = nil }
        } catch {
            failure = .refused("\(error)")
        }
    }


    func conversation(_ key: String) -> AskConversation {
        if let held = opened[key] { return held }
        let made = AskConversation(key: key, chat: key.hasPrefix("new-") ? nil : key, book: self)
        made.title = listed?.first { $0.chat == key }?.title
        opened[key] = made
        all.append(made)
        return made
    }

    func upcoming() -> AskConversation {
        conversation("new-\(begun + 1)")
    }

    func begin(_ question: String, photos: [String] = []) -> String? {
        begin { $0.ask(question, photos: photos) }
    }

    func resend() {
        let waiting = Set(outbox.waiting.map(\.submission))
        for entry in outbox.held where entry.failed != nil || waiting.contains(entry.submission) {
            let key = entry.chat ?? opened.first { $0.value.holds(entry.submission) }?.key ?? "new-" + entry.submission
            if entry.failed == nil { conversation(key).resume(entry) } else { conversation(key).restore(entry) }
        }
        outbox.retry()
    }

    func kept(_ kept: Bool) {
        unkept = kept ? nil : AskOutbox.unkept
    }

    func erase(_ conversation: AskConversation) {
        outbox.purge(chat: conversation.chat, key: conversation.key)
        for id in conversation.picked { outbox.remove(id) }
        if recorder.holds(conversation.key) { recorder.cancel() }
        player.stop(conversation)
        conversation.erased()
        for (key, held) in opened where held === conversation { opened[key] = nil }
        all.removeAll { $0 === conversation }
        if let chat = conversation.chat { listed?.removeAll { $0.chat == chat } }
        changed()
    }

    func named(_ conversation: AskConversation, _ chat: String) {
        opened[chat] = conversation
    }

    func changed() {
        objectWillChange.send()
    }

    func cameBack() {
        for conversation in all where conversation.running && conversation.chat != nil { conversation.rejoin() }
        Task { await readReady() }
    }

    func forget() {
        for conversation in all { conversation.leave() }
        opened = [:]
        all = []
        listed = nil
        failure = nil
        generation += 1
        store(nil)
        ready = nil
        chosen = nil
        down = nil
        draft = ""
        picked = []
        unkept = nil
        recorder.cancel()
        player.stop()
        outbox.purge()
    }
}

@MainActor
final class AskConversation: ObservableObject {
    let key: String
    @Published private(set) var chat: String?
    @Published var title: String?
    @Published private(set) var turns: [Turn] = []
    @Published private(set) var read: Read = .unread
    @Published var draft = ""
    @Published var picked: [String] = []
    @Published var focus = false
    @Published private(set) var level: HomeLink.Ask.Level?
    @Published private(set) var replays: [String: Replay] = [:]
    private var plays: [String: Int] = [:]
    private var unsent: HomeLink.Ask.Level?
    private var reading = 0
    private var asked = 0

    enum Read: Equatable {
        case unread, read
        case failed(LifeReader.Failure)
    }

    struct Turn: Identifiable, Equatable {
        let id: Int
        var question: String
        var at: Date
        var answer: Answer
        var photos: [Photo] = []
        var note: Note?
        var submission: String?
    }

    enum Photo: Equatable, Hashable {
        case own(String)
        case held(String)
    }

    enum Replay: Equatable {
        case unreached(String)
        case erased
        case unplayed(HomeLink.Citation.Voice)
        case held(HomeLink.Citation.Voice)
        case plain
    }

    struct Note: Equatable {
        var sound: NotePlayer.Sound
        let ms: Int
        var levels: [Double]
        var words: String?
        var writing: Bool
    }

    struct Answer: Equatable {
        enum End: Equatable {
            case running, done, stopped
            case failed(String)
        }

        var trace: AskTrace
        var refs: [String: HomeLink.Ask.Cited]?
        var end: End = .running {
            didSet { if end != .running { trace.take(.cut()) } }
        }
        var waiting: String?
        var signIn = false
        var unsaved = false
        var access: [HomeLink.AccessChange] = []
        var seen: HomeLink.Ask.Message.Seen?
        var n: Int?

        init(asked: Date = AppClock.now, followed: Bool = false) {
            trace = AskTrace(asked: AskTrace.now - AppClock.now.timeIntervalSince(asked), followed: followed)
        }

        init(_ trace: AskTrace) {
            self.trace = trace
        }

        var text: String { trace.text }

        static let notSaved = "Not saved yet: Chat can't write to your Mac's disk. It keeps trying."
        static let sending = "Sending your photos…"
        static let sendingNote = "Sending your voice note…"
        static let held = "Not sent yet. It goes when Lifestream answers."
    }

    private(set) var gone = false
    private weak var book: AskBook?
    private var following: Task<Void, Never>?
    private var holding: Background?
    private var stopWanted = false
    private var made = 0
    private var failedKind: String?
    private var failedWords: String?
    private let life: LifeReader

    init(key: String, chat: String?, book: AskBook) {
        self.key = key
        self.chat = chat
        self.book = book
        life = book.life
    }

    var running: Bool { turns.last?.answer.end == .running }
    var lastMs: Int64 { Int64(((turns.last?.at ?? AppClock.now).timeIntervalSince1970 * 1000).rounded()) }


    func open() async {
        guard let chat, !gone, !running || following == nil else { return }
        do {
            let kept = try await life.chat(chat)
            guard !gone else { return }
            read = .read
            take(kept)
            if kept.running != nil { follow() }
        } catch is CancellationError {
        } catch is HomeLink.Ask.Erased {
            land(.refused(410), in: .named)
        } catch let failure as LifeReader.Failure {
            read = .failed(failure)
        } catch {
            read = .failed(.refused("\(error)"))
        }
    }

    func readLevel() async {
        reading += 1
        let mine = reading
        let read: HomeLink.Ask.Level?
        if let chat {
            guard let kept = try? await life.chatPrivacy(chat), unsent == nil, mine == reading else { return }
            read = kept.level
        } else {
            guard let setting = try? await life.privacy(), unsent == nil, mine == reading, self.chat == nil else { return }
            read = HomeLink.Ask.Level(rawValue: setting.chat)
        }
        guard read != level else { return }
        level = read
        book?.changed()
    }

    func pick(level new: HomeLink.Ask.Level) {
        guard !running else { return }
        level = new
        unsent = new
        book?.changed()
    }

    func rejoin() {
        following?.cancel()
        following = nil
        guard let chat else { return }
        following = Task { [weak self] in
            guard let self else { return }
            do {
                let kept = try await life.chat(chat)
                guard !Task.isCancelled else { return }
                take(kept)
                Task { [weak self] in await self?.readLevel() }
                if kept.running != nil { await events { try await self.life.follow(chat: chat) } }
            } catch is CancellationError {
            } catch {
                guard !Task.isCancelled else { return }
                land(Self.answer(of: error), in: .named, words: Self.sentence(error), failure: error as? LifeReader.Failure)
            }
            if !Task.isCancelled { following = nil }
        }
    }

    func leave() {
        following?.cancel()
        following = nil
    }

    func erased() {
        gone = true
        leave()
        turns = []
        picked = []
        read = .failed(.missing)
    }

    private func take(_ kept: HomeLink.Ask.Chat) {
        guard !gone else { return }
        title = kept.title
        let held = Set(book?.outbox.entries.map(\.submission) ?? [])
        let pending = turns.filter { $0.submission.map(held.contains) ?? false }
        let placed = turns.filter { !($0.submission.map(held.contains) ?? false) }
        var read: [Turn] = []
        for message in kept.messages.sorted(by: { $0.n < $1.n }) {
            switch message.role {
            case .user:
                let before = placed.indices.contains(read.count) ? placed[read.count] : nil
                let note = message.voice.map { voice in
                    Note(sound: .held(voice.audio), ms: voice.ms, levels: before?.note?.levels ?? [], words: voice.words,
                         writing: voice.writing == true)
                }
                read.append(Turn(id: before?.id ?? next(), question: message.text, at: Words.date(ms: message.atMs), answer: Answer(),
                                 photos: (message.photos ?? []).map { .held($0) }, note: note))
            case .assistant:
                guard !read.isEmpty else { continue }
                read[read.count - 1].answer = Self.answer(message)
            }
        }
        if kept.running == nil, let last = read.last, last.answer.end == .running, last.answer.text.isEmpty, last.answer.trace.steps.isEmpty {
            read[read.count - 1].answer.end = .failed("Lost the connection to Chat.")
        }
        turns = read + pending
        book?.changed()
    }

    private static func answer(_ message: HomeLink.Ask.Message) -> Answer {
        var answer = Answer(AskTrace(message.text, steps: (message.steps ?? []).map { AskTrace.Step($0.words, failed: $0.error != nil) },
                                     thoughtMs: message.thoughtMs ?? message.ms))
        answer.refs = message.refs ?? [:]
        answer.unsaved = message.unsaved == true
        answer.access = message.access ?? []
        answer.seen = message.seen
        answer.n = message.n
        answer.end = end(message)
        return answer
    }

    private static func end(_ message: HomeLink.Ask.Message) -> Answer.End {
        switch message.end {
        case .stopped: .stopped
        case .failed: .failed(sentence(kind: message.failed, words: message.error))
        case .done, nil: .done
        }
    }


    @discardableResult
    func ask(_ question: String, photos: [String] = []) -> Bool {
        let words = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Composer.sends(words), !running, let book else { return false }
        guard let entry = try? book.outbox.keep(words: words, photos: photos, key: key, chat: chat, pick: book.pick, level: unsent) else {
            book.kept(false)
            return false
        }
        book.kept(true)
        spend()
        if title == nil { title = Self.opening(words) }
        turns.append(Turn(id: next(), question: words, at: Words.date(ms: entry.atMs), answer: Answer(), photos: Self.shown(photos),
                          submission: entry.submission))
        post(entry)
        return true
    }

    @discardableResult
    func ask(voice note: ChatRecorder.Note, photos: [String] = []) -> Bool {
        guard ask(.note(note.id, seconds: note.seconds), ms: note.ms, levels: note.levels, sound: .own(note.id), photos: photos) else { return false }
        book?.recorder.sent(note.id)
        return true
    }

    private func ask(_ voice: HomeLink.Ask.Question.Voice, ms: Int, levels: [Double], sound: NotePlayer.Sound, photos: [String]) -> Bool {
        guard !running, let book else { return false }
        guard let entry = try? book.outbox.keep(words: nil, photos: photos, voice: voice, voiceMs: ms, key: key, chat: chat, pick: book.pick, level: unsent) else {
            book.kept(false)
            return false
        }
        book.kept(true)
        spend()
        if title == nil { title = "Voice note" }
        turns.append(Turn(id: next(), question: "", at: Words.date(ms: entry.atMs), answer: Answer(), photos: Self.shown(photos),
                          note: Note(sound: sound, ms: ms, levels: levels, words: nil, writing: true), submission: entry.submission))
        post(entry)
        return true
    }

    private func spend() {
        if chat != nil {
            unsent = nil
            reading += 1
        }
        asked += 1
    }

    func retry(_ turn: Turn) {
        if let submission = turn.submission, let book, book.outbox.entries.contains(where: { $0.submission == submission }) {
            book.outbox.again(submission)
            guard let again = book.outbox.entries.first(where: { $0.submission == submission }), again.failed == nil else { return }
            return resume(again)
        }
        let photos = turn.photos.compactMap { if case .held(let name) = $0 { name } else { nil } }
        guard let note = turn.note else {
            ask(turn.question, photos: photos)
            return
        }
        guard case .held(let audio) = note.sound else { return }
        _ = ask(.audio(audio), ms: note.ms, levels: note.levels, sound: note.sound, photos: photos)
    }

    enum Mend {
        case again, photo, remove
    }

    func mend(_ turn: Turn) -> Mend {
        guard let submission = turn.submission, let entry = book?.outbox.entries.first(where: { $0.submission == submission }) else { return .again }
        return switch entry.again {
        case .photoRemoved?: .photo
        case HomeLink.Ask.Outcome.Again.none?: .remove
        default: .again
        }
    }

    func unrefuse(_ turn: Turn) {
        guard let submission = turn.submission, let book else { return }
        let removed = book.outbox.unrefuse(submission)
        guard let index = turns.firstIndex(where: { $0.id == turn.id }) else { return }
        turns[index].photos.removeAll { photo in
            if case .own(let id) = photo { removed.contains(id) } else { false }
        }
    }

    func play(_ turn: Turn) {
        guard let book, let note = turn.note else { return }
        book.player.toggle(note.sound, of: self)
    }

    func voice(_ kept: HomeLink.Citation.Voice?) -> HomeLink.Citation.Voice? {
        guard let kept else { return nil }
        switch replays[kept.record] {
        case .plain?: return nil
        case .unplayed(let newer)?, .held(let newer)?: return newer
        case .unreached?, .erased?, nil: return kept
        }
    }

    @discardableResult
    func play(_ voice: HomeLink.Citation.Voice) -> Task<Void, Never>? {
        book?.player.toggle(.held(voice.audio), of: self)
    }

    func cited(_ audio: String) -> HomeLink.Citation.Voice? {
        let shown = turns.flatMap { turn in turn.answer.refs.map { Array($0.values) } ?? [] }.compactMap { voice($0.citation?.voice) }
        return shown.first { $0.audio == audio }
    }

    @discardableResult
    func heard(_ heard: NotePlayer.Heard, of voice: HomeLink.Citation.Voice) -> Task<Void, Never>? {
        plays[voice.record] = heard.play
        switch heard.outcome {
        case .began:
            return nil
        case .failed:
            return Task { await unplayed(voice, play: heard.play) }
        case .sounded:
            if case .unplayed(let newer)? = replays[voice.record] { replays[voice.record] = .held(newer) }
            if case .unreached? = replays[voice.record] { replays[voice.record] = nil }
            return nil
        }
    }

    private func unplayed(_ voice: HomeLink.Citation.Voice, play: Int) async {
        let replay: Replay
        do {
            let described = try await life.describe([voice.record]).described.first
            replay = switch (described?.kind, described?.voice) {
            case (.gone?, _): .erased
            case (_, let newer?): .unplayed(newer)
            default: .plain
            }
        } catch {
            replay = .unreached((error as? LifeReader.Failure).flatMap(PeopleWords.failure) ?? ReachWords.title)
        }
        guard !gone, plays[voice.record] == play else { return }
        replays[voice.record] = replay
    }

    func withdraw(_ turn: Turn) {
        guard let submission = turn.submission, let book else { return }
        book.outbox.withdraw(submission)
        turns.removeAll { $0.id == turn.id }
        book.changed()
    }

    func holds(_ submission: String) -> Bool {
        turns.contains { $0.submission == submission }
    }

    func resume(_ entry: AskOutbox.Entry) {
        guard let book, book.outbox.entries.contains(where: { $0.submission == entry.submission }), !(running && following != nil),
              book.outbox.posting(entry.submission) else { return }
        if let index = turns.firstIndex(where: { $0.submission == entry.submission }) {
            var turn = turns.remove(at: index)
            turn.answer = Answer()
            if turn.note?.words == nil { turn.note?.writing = true }
            turns.append(turn)
        } else {
            draw(entry, answer: Answer())
        }
        post(entry, claimed: true)
    }

    func restore(_ entry: AskOutbox.Entry) {
        guard let failed = entry.failed, let book, !holds(entry.submission), !(running && following != nil) else { return }
        var answer = Answer()
        answer.end = .failed(failed)
        draw(entry, answer: answer, outbox: book.outbox)
    }

    private func draw(_ entry: AskOutbox.Entry, answer: Answer, outbox: AskOutbox? = nil) {
        guard let outbox = outbox ?? book?.outbox else { return }
        if title == nil { title = entry.words.map(Self.opening) ?? "Voice note" }
        turns.append(Turn(id: next(), question: entry.words ?? "", at: Words.date(ms: entry.atMs), answer: answer,
                          photos: Self.shown(entry.photos), note: Self.note(entry, outbox), submission: entry.submission))
    }

    private static func shown(_ ids: [String]) -> [Photo] {
        ids.map { $0.hasPrefix("sha256:") ? .held($0) : .own($0) }
    }

    private static func note(_ entry: AskOutbox.Entry, _ outbox: AskOutbox) -> Note? {
        switch entry.voice {
        case .note(let id, _)?:
            Note(sound: .own(id), ms: entry.voiceMs ?? 0, levels: outbox.notes[id]?.levels ?? [], words: nil, writing: true)
        case .audio(let audio)?:
            Note(sound: .held(audio), ms: entry.voiceMs ?? 0, levels: [], words: nil, writing: true)
        case nil: nil
        }
    }

    private func post(_ entry: AskOutbox.Entry, claimed: Bool = false) {
        guard let book, claimed || book.outbox.posting(entry.submission) else { return }
        stopWanted = false
        failedKind = nil
        failedWords = nil
        book.changed()
        following?.cancel()
        let outbox = book.outbox
        let limits = book.limits
        let chat = entry.chat ?? self.chat
        let background = book.background()
        holding = background
        following = Task { [weak self] in
            defer {
                outbox.done(entry.submission)
                background.end()
            }
            guard let self else { return }
            let note: String? = if case .note(let note, _)? = entry.voice { note } else { nil }
            let sending = Task { @MainActor [weak self] in
                guard let self else { return }
                if entry.photos.contains(where: { outbox.photos[$0]?.state == .uploading }) { return self.waiting(Answer.sending) }
                if let note, let held = outbox.notes[note], held.posted.count < held.seconds { self.waiting(Answer.sendingNote) }
            }
            let phase = await events(submission: entry.submission) {
                var tries = 0
                while true {
                    let files = try await outbox.files(entry.photos, limits: limits)
                    if let note { try await outbox.seconds(note) }
                    sending.cancel()
                    let question = HomeLink.Ask.Question(submission: entry.submission, words: entry.words, photos: files, voice: entry.voice)
                    do {
                        return try await self.life.ask(question, chat: chat, level: entry.level, pick: entry.pick)
                    } catch let missing as HomeLink.Ask.Missing where tries < 2 && missing.audio.isEmpty {
                        tries += 1
                        outbox.missing(missing.photos, of: entry.photos)
                        if let note { outbox.missing(seconds: missing.seconds, of: note) }
                    }
                }
            }
            sending.cancel()
            guard !Task.isCancelled else { return }
            following = nil
            if phase == .named { book.resend() }
        }
    }

    private func waiting(_ words: String) {
        guard running, turns[turns.count - 1].answer.trace.steps.isEmpty, turns[turns.count - 1].answer.text.isEmpty else { return }
        turns[turns.count - 1].answer.waiting = words
    }

    func stop() {
        guard running else { return }
        guard let chat else {
            stopWanted = true
            return
        }
        Task { try? await life.stopAsking(chat: chat) }
    }

    private func follow() {
        guard let chat else { return }
        following?.cancel()
        following = Task { [weak self] in
            guard let self else { return }
            await events { try await self.life.follow(chat: chat) }
            if !Task.isCancelled { following = nil }
        }
    }

    @discardableResult
    private func events(submission: String? = nil,
                        _ open: @escaping () async throws -> AsyncThrowingStream<HomeLink.Ask.Event, Error>?) async -> HomeLink.Ask.Phase {
        var phase: HomeLink.Ask.Phase = submission == nil ? .named : .sending
        let answer: HomeLink.Ask.Answer
        let words: String
        var waits = Answer.held
        var failure: LifeReader.Failure?
        var erased = false
        var done: Bool?
        let question = asked
        defer {
            if submission != nil, question == asked { Task { [weak self] in await self?.readLevel() } }
        }
        do {
            guard let events = try await open() else {
                if let chat { take(try await life.chat(chat)) }
                return phase
            }
            if let last = turns.last { turns[turns.count - 1].answer = Answer(asked: last.at, followed: submission == nil) }
            for try await event in events {
                switch event {
                case .chat(_, _, let audio) where phase == .sending:
                    phase = .named
                    named(submission, audio: audio)
                    unsent = nil
                    Task { [weak self] in await self?.readLevel() }
                case .error(kind: "erased", message: _):
                    erased = true
                case .done(let message):
                    done = message.end == .failed
                default:
                    break
                }
                take(event)
            }
            answer = erased ? .error(erased: true) : done.map { .done(failed: $0) } ?? (failedKind == nil ? .ended : .error(erased: false))
            words = Self.sentence(kind: failedKind, words: failedWords)
        } catch is CancellationError {
            return phase
        } catch {
            guard !Task.isCancelled else { return phase }
            answer = Self.answer(of: error)
            words = Self.words(of: error)
            failure = error as? LifeReader.Failure
            if case .busy(let said, _, _, _)? = failure { waits = said }
        }
        land(answer, in: phase, submission: submission, words: words, waits: waits, failure: failure)
        return phase
    }

    private func land(_ answer: HomeLink.Ask.Answer, in phase: HomeLink.Ask.Phase, submission: String? = nil, words: String = "",
                      waits: String = Answer.held, failure: LifeReader.Failure? = nil) {
        let outcome = book?.outbox.settle(submission, answer, in: phase, words: words) ?? .of(answer, in: phase)
        if outcome.copies == .drop, let submission, let index = turns.lastIndex(where: { $0.submission == submission }) {
            turns[index].submission = nil
        }
        let held = submission.flatMap { submission in book?.outbox.entries.first { $0.submission == submission }?.failed }
        switch outcome.turn {
        case .erased:
            book?.erase(self)
        case .follow:
            guard chat != nil else { break }
            if let failure { read = .failed(failure) } else { rejoin() }
        case .sending where held == nil:
            guard running else { break }
            let last = turns.count - 1
            turns[last].answer = Answer()
            turns[last].answer.waiting = waits
        case .failed, .sending:
            guard running else { break }
            turns[turns.count - 1].answer.signIn = failedKind == "login"
            end(.failed(held ?? words))
        case .named, .done:
            if running { end(.failed(words)) }
        }
    }

    private func named(_ submission: String?, audio: String?) {
        holding?.end()
        holding = nil
        guard let submission, let outbox = book?.outbox else { return }
        if let index = turns.lastIndex(where: { $0.submission == submission }) {
            turns[index].submission = nil
            turns[index].photos = turns[index].photos.map { photo in
                if case .own(let id) = photo, let name = outbox.name(id) { .held(name) } else { photo }
            }
            if let audio, case .own? = turns[index].note?.sound { turns[index].note?.sound = .held(audio) }
        }
        outbox.settle(submission, .chat, in: .sending)
    }

    private static func answer(of error: Error) -> HomeLink.Ask.Answer {
        switch error {
        case let missing as HomeLink.Ask.Missing: missing.audio.isEmpty ? .missing : .noteGone
        case is HomeLink.Ask.Erased: .refused(410)
        case let refused as AskOutbox.Refused: refused.photo ? .photo(refused.status) : .refused(refused.status)
        case let failure as LifeReader.Failure:
            switch failure {
            case .missing: .refused(404)
            case .refused: .refused(400)
            case .reach, .busy, .failed, .unknown, .unpaired: .away
            }
        case LinkFailure.noAnswer: .lost
        default: .away
        }
    }

    private static func words(of error: Error) -> String {
        switch error {
        case let missing as HomeLink.Ask.Missing: missing.words ?? ReachWords.notSent
        case let refused as AskOutbox.Refused: refused.words
        default: sentence(error)
        }
    }

    private func take(_ event: HomeLink.Ask.Event) {
        guard !turns.isEmpty else { return }
        let last = turns.count - 1
        switch event {
        case .chat(let chat, _, _):
            turns[last].answer.trace.take(.named)
            if self.chat == nil {
                self.chat = chat
                book?.named(self, chat)
            }
            if stopWanted {
                stopWanted = false
                stop()
            }
        case .waiting(let words):
            turns[last].answer.waiting = words
        case .stepBegan(let call, let words, let said):
            turns[last].answer.waiting = nil
            turns[last].answer.trace.take(.began(call: call, words: words, said: said))
        case .stepEnded(let call, let words, let error):
            turns[last].answer.waiting = nil
            turns[last].answer.trace.take(.ended(call: call, words: words, failed: error != nil))
        case .ref(let handle, let cited):
            turns[last].answer.refs = (turns[last].answer.refs ?? [:]).merging([handle: cited]) { $1 }
        case .words(let words):
            turns[last].note?.words = words
            turns[last].note?.writing = false
        case .text(let delta):
            turns[last].answer.waiting = nil
            turns[last].answer.trace.take(.text(delta))
        case .done(let message):
            var answer = turns[last].answer
            answer.trace.take(message.end == .done || message.end == nil ? .done(message.text, thoughtMs: message.thoughtMs) : .cut(thoughtMs: message.thoughtMs))
            answer.refs = message.refs ?? [:]
            answer.unsaved = message.unsaved == true
            answer.waiting = nil
            answer.end = Self.end(message)
            if let access = message.access { answer.access = access }
            answer.seen = message.seen
            answer.n = message.n
            if message.end == .failed {
                answer.end = .failed(Self.sentence(kind: failedKind ?? message.failed, words: failedWords ?? message.error))
                answer.signIn = (failedKind ?? message.failed) == "login"
            }
            turns[last].answer = answer
            turns[last].note?.writing = false
            book?.changed()
        case .title(_, let title):
            self.title = title
            book?.changed()
        case .error(let kind, let words):
            failedKind = kind
            failedWords = words
            if kind == "login" { Task { await self.book?.readReady() } }
        case .access(let change):
            turns[last].answer.waiting = nil
            turns[last].answer.access.append(change)
        }
    }

    private func end(_ end: Answer.End) {
        guard running else { return }
        turns[turns.count - 1].answer.end = end
        turns[turns.count - 1].note?.writing = false
        book?.changed()
    }

    private func next() -> Int {
        made += 1
        return made
    }

    private static func sentence(kind: String?, words: String?) -> String {
        let said = words.flatMap { $0.isEmpty ? nil : $0 }
        return switch kind {
        case "model", "login": said ?? "The model didn't answer."
        case "door": said ?? ReachWords.notSent
        case "restart": "Chat restarted before it finished."
        default: "Lost the connection to Chat."
        }
    }

    private static func sentence(_ error: Error) -> String {
        switch error {
        case LifeReader.Failure.busy(let words, _, _, _): words
        case LifeReader.Failure.reach, LinkFailure.noAnswer: ReachWords.notSent
        default: "Lost the connection to Chat."
        }
    }

    private static func opening(_ question: String) -> String {
        let words = question.split(whereSeparator: \.isWhitespace)
        return words.prefix(8).joined(separator: " ") + (words.count > 8 ? "…" : "")
    }
}

extension NotePlayer {
    static let shared = NotePlayer(read: { sound throws(NotePlayer.Unplayed) in
        switch sound {
        case .own(let note):
            guard let data = AskBook.shared.outbox.sound(note) else { throw .missing }
            return data
        case .held(let audio):
            do {
                return try await AppRuntime.shared.life.blob(audio)
            } catch {
                throw NotePlayer.unplayed(error)
            }
        }
    }, recording: { AskBook.shared.recorder.phase == .recording }, muted: AppRuntime.isUITesting)
}
