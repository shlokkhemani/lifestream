import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct AskTab: View {
    @ObservedObject private var book = AskBook.shared
    @ObservedObject private var reach = AppRuntime.shared.reach
    @FocusState private var focused: Bool

    var body: some View {
        AskBlank(starters: book.starters, ask: { ask($0) })
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            .padding(.horizontal, Cockpit.Gap.edge)
            .tappingKeyboardAway($focused)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("ask.home")
            .groundColor(Cockpit.Color.canvas)
        .chatBar()
        .pageFoot(lettingKeyboardGo: $focused) {
            AskFoot(draft: $book.draft, picked: $book.picked, owner: AskFoot.page, running: false, focus: $focused,
                    send: send, sendNote: send, stop: {}, conversation: book.upcoming())
        }
        .task {
            let book = book
            async let ready: Void = book.readReady()
            await book.read()
            await ready
        }
        .readsAgain(unread: { book.unread }) { await book.readReady() }
        .readsAgain(failed: { book.failure }) { await book.read() }
        .onChange(of: book.focus, initial: true) { _, focus in
            guard focus else { return }
            focused = true
            book.focus = false
        }
    }

    private func send() {
        guard book.askable, book.outbox.refusal(book.picked, limits: book.limits) == nil, ask(book.draft, photos: book.picked) else { return }
        book.draft = ""
        book.picked = []
    }

    private func send(_ note: ChatRecorder.Note) -> Bool {
        guard book.askable, let key = book.begin(voice: note, photos: book.picked) else { return false }
        focused = false
        book.conversation(key).draft = book.draft
        book.draft = ""
        book.picked = []
        AppNavigation.shared.openChat(key)
        return true
    }

    @discardableResult
    private func ask(_ question: String, photos: [String] = []) -> Bool {
        guard book.askable, let key = book.begin(question, photos: photos) else { return false }
        focused = false
        AppNavigation.shared.openChat(key)
        return true
    }
}

struct AskBlank: View {
    let starters: [HomeLink.Ask.Ready.Starter]
    let ask: (String) -> Void

    var body: some View {
        ViewThatFits(in: .vertical) {
            page(heading: true)
            page(heading: false)
        }
        .animation(.easeOut(duration: Cockpit.Duration.fast), value: starters)
    }

    private func page(heading: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: Cockpit.Space.s6)
            if heading {
                AskStartHeading()
                    .accessibilityIdentifier("ask.heading")
                Spacer(minLength: Cockpit.Space.s8)
            }
            ForEach(starters.indices, id: \.self) { index in
                let starter = starters[index]
                AskStartRow(AskWords.icon(starter.kind), starter.question) { ask(starter.question) }
                    .accessibilityIdentifier("ask.starter")
            }
        }
        .padding(.bottom, Cockpit.Space.s3 - 2)
    }
}

struct AskFoot: View {
    @Binding var draft: String
    @Binding var picked: [String]
    let owner: String
    let running: Bool
    var focus: FocusState<Bool>.Binding
    let send: () -> Void
    let sendNote: (ChatRecorder.Note) -> Bool
    let stop: () -> Void
    var conversation: AskConversation?
    static let page = "page"
    @ObservedObject private var book = AskBook.shared
    @ObservedObject private var recorder = AskBook.shared.recorder
    @ObservedObject private var reach = AppRuntime.shared.reach
    @ObservedObject private var outbox = AskBook.shared.outbox
    @State private var keyboard = false
    @State private var picking: AskPick?
    @State private var finding = false

    var body: some View {
        Composer(text: $draft, state: running ? .running : book.askable ? .ready : .waiting,
                 focus: focus, pick: pick, level: level, attach: book.limits == nil ? nil : attach, pictures: pictures, record: record,
                 notice: notice, send: send, stop: stop)
        .askPickers($picking, limit: (book.limits?.photos ?? 0) - picked.count, picked: take)
        .sheet(isPresented: $finding) { find }
        .padding(.horizontal, keyboard ? Cockpit.Space.s2 : Cockpit.Gap.edge)
        .padding(.bottom, keyboard ? Cockpit.Space.s2 : Cockpit.Space.s3)
        .task(id: conversation?.key) { await conversation?.readLevel() }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in moved(true) }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in moved(false) }

    }

    private var notice: AnyView? {
        if let refused = outbox.refusal(picked, limits: book.limits) {
            return AnyView(InPlaceLine(refused).accessibilityIdentifier("ask.picture.refused"))
        }
        if let unkept = book.unkept {
            return AnyView(InPlaceLine(unkept).accessibilityIdentifier("ask.unkept"))
        }
        if let said = recorder.said {
            return AnyView(InPlaceLine(said, severity: .needs).accessibilityIdentifier("ask.voice.said"))
        }
        if let down = book.down {
            return AnyView(InPlaceLine(down) { Task { await book.readReady() } }.accessibilityIdentifier("ask.unreachable"))
        }
        if let said = book.ready?.said, !said.isEmpty {
            return AnyView(InPlaceLine(said, severity: book.waits ? .stopped : .needs).accessibilityIdentifier("ask.said"))
        }
        return nil
    }

    private var attach: Composer.Attach {
        Composer.Attach(library: { open(.library) }, camera: { open(.camera) }, file: { open(.file) },
                        unable: book.unattachable(holding: picked.count))
    }

    private var pictures: [Composer.Picture] {
        picked.map { id in
            let state: Composer.Picture.State = switch outbox.photos[id]?.state {
            case .uploading?: .uploading
            case .refused?, .tooLarge?: .refused
            default: .ready
            }
            let image = Image(uiImage: outbox.thumbnails[id] ?? UIImage())
            return Composer.Picture(id: id, image: image, state: state) {
                picked.removeAll { $0 == id }
                outbox.remove(id)
            }
        }
    }

    private var record: Composer.Record? {
        guard book.voice != nil else { return nil }
        let recording = recorder.holds(owner) ? Composer.Recording(time: ChatRecorder.time(ms: recorder.ms), levels: recorder.levels,
                                                                   stop: sendRecorded, send: sendRecorded, cancel: { recorder.cancel() }) : nil
        return Composer.Record(start: { book.record(for: owner) }, recording: recording)
    }

    private func sendRecorded() {
        guard book.askable, !running, outbox.refusal(picked, limits: book.limits) == nil else { return recorder.halt() }
        Task {
            guard let note = await recorder.take() else { return }
            _ = sendNote(note)
        }
    }

    private func open(_ pick: AskPick) {
        if CannedHome.picksPhoto { return take(AskPick.synthetic(pick)) }
        if pick == .camera, !UIImagePickerController.isSourceTypeAvailable(.camera) { return }
        picking = pick
    }

    private func take(_ pictures: [AskPick.Picked]) {
        guard let limits = book.limits else { return }
        for picture in pictures where picked.count < limits.photos {
            if let id = outbox.pick(picture.data, ext: picture.ext, holding: picked, limits: limits) { picked.append(id) }
        }
    }

    private var pick: Composer.Pick? {
        let book = book
        let models = book.menu.map(ModelFind.options) ?? []
        let finding = $finding
        let choose: @MainActor @Sendable (String) -> Void = { value in
            if value == ModelFind.opens { finding.wrappedValue = true } else { book.choose(model: value) }
        }
        if let asks = book.asks, !models.isEmpty {
            let model = book.models.first { $0.id == asks.model }
            let levels: [MenuRow<String>.Option] = (model?.thinking ?? [asks.thinking]).map { MenuRow<String>.Option($0, AskWords.level($0)) }
            let level = Binding<String>(get: { asks.thinking }, set: { book.choose(thinking: $0) })
            let picked = Binding<String>(get: { asks.model }, set: choose)
            let reset: (() -> Void)? = book.pick == nil ? nil : { book.reset() }
            let words = asks.thinking.isEmpty ? asks.name : asks.name + " · " + AskWords.level(asks.thinking)
            return Composer.Pick(words: words, levels: levels, level: level,
                                 default: model?.default, models: models, model: picked, modelName: asks.name, voice: voice, reset: reset)
        }
        if let words = book.chooseWords, !models.isEmpty {
            return Composer.Pick(words: words, levels: [], level: .constant(""), default: nil, models: models,
                                 model: Binding(get: { "" }, set: choose), modelName: words, voice: voice, reset: nil)
        }
        return book.unread && !reach.lacks ? .reading(Self.readingWords) : nil
    }

    private static let readingWords = "Model · Thinking"

    private var find: some View {
        let book = book
        let finding = $finding
        return NavigationStack {
            if let more = book.menu?.more {
                SheetPage(more.words) {
                    ModelFindList(more: more, chosen: book.asks?.model, busy: false) { row in
                        book.choose(found: row)
                        finding.wrappedValue = false
                    }
                }
            }
        }
        .drawerRest(.large)
        .accessibilityIdentifier("ask.models.find")
    }

    private var voice: Composer.Pick.Voice? {
        guard let voice = book.voice else { return nil }
        let book = book
        let chosen = book.voiceChoice
        let choices = voice.choices.map { choice in
            MenuRow<String>.Option(choice.value, choice.words, note: choice.value == chosen ? voice.caution : nil)
        }
        return Composer.Pick.Voice(words: voice.words, caution: voice.caution, choices: choices,
                                   choice: Binding(get: { chosen ?? "" }, set: { book.chooseVoice($0) }))
    }

    private var level: Composer.Level? {
        guard pick != nil, !book.stays, let conversation, let level = conversation.level,
              let held = AskWords.privacy.first(where: { $0.level == level }) else { return nil }
        return Composer.Level(glyph: held.glyph, words: held.words,
                              choices: AskWords.privacy.map { MenuRow<String>.Option($0.level.rawValue, $0.words) },
                              choice: Binding(get: { level.rawValue }, set: { HomeLink.Ask.Level(rawValue: $0).map(conversation.pick(level:)) }),
                              waits: conversation.running)
    }

    private func moved(_ up: Bool) {
        withAnimation(.easeOut(duration: Cockpit.Duration.instant)) { keyboard = up }
    }
}

enum AskWords {
    static func level(_ level: String) -> String {
        switch level {
        case "off": "No thinking"
        case "xhigh": "Extra high"
        default: level.prefix(1).uppercased() + level.dropFirst()
        }
    }

    static let privacy: [(level: HomeLink.Ask.Level, words: String, glyph: Cockpit.Icon)] = [
        (.all, "Hide all", .hidden), (.names, "Keep names", .person), (.none, "Don’t hide", .visible),
    ]

    static func byWhen(_ rows: [AskBook.Row], today: String) -> [(label: String, rows: [AskBook.Row])] {
        var groups: [(label: String, rows: [AskBook.Row])] = []
        for row in rows {
            let label = Words.groupWhen(HomeClock.current.dayAt(row.lastMs).day, today: today)
            if groups.last?.label == label { groups[groups.count - 1].rows.append(row) } else { groups.append((label, [row])) }
        }
        return groups
    }

    static func stamp(_ at: Date, today: String) -> String {
        Words.stampWhen(HomeClock.current.dayAt(at).day, today: today, clock: Words.clock(at))
    }

    static func icon(_ kind: String) -> Cockpit.Icon? {
        switch kind {
        case "places": .place
        case "walking": .steps
        case "photos": .photos
        case "sleep": .sleep
        case "workouts": .workout
        case "people": .people
        case "calendar": .calendarEvent
        case "screen": .screen
        case "music": .music
        case "mail": .mail
        default: nil
        }
    }
}
