#if os(macOS)
import SwiftUI
@testable import Cockpit


@MainActor private func photo(_ fit: AskFit) -> AnyView {
    let block = Cockpit.Color.raised.overlay { Icon(.photo, size: .lg).foregroundStyle(Cockpit.Color.textTertiary) }
    return fit == .own ? AnyView(block.aspectRatio(4 / 3, contentMode: .fit).frame(maxWidth: 360)) : AnyView(block)
}

private let refs: [String: AskRef] = {
    var refs: [String: AskRef] = [
        "r1": AskRef("Chat with Person A", day: "Fri 16 Oct"),
        "r2": AskRef("Synthetic Cafe", day: "Fri 16 Oct"),
        "r3": AskRef("Mail: Synthetic booking confirmed", day: "Mon 12 Oct"),
        "r4": AskRef("Photo at Synthetic Cafe", day: "Fri 16 Oct", image: true),
    ]
    for n in 5...14 { refs["r\(n)"] = AskRef("Photo \(n - 4) of the walk", day: "Sat 3 Oct", image: true) }
    for n in 15...16 { refs["r\(n)"] = AskRef("Person A", day: "Fri 16 Oct", source: "Fri 16 Oct whatsapp:15550000001") }
    for (n, seconds, when) in [(20, 23, "Tue 4 Nov, 21:40"), (21, 8, "Tue 4 Nov, 21:43")] {
        refs["r\(n)"] = AskRef("Person A", day: "Tue 4 Nov", source: "Tue 4 Nov whatsapp:15550000001",
                               voice: .init(record: "record.note-\(n)", seconds: seconds, from: "Person A", mine: false, when: when))
    }
    refs["r22"] = AskRef("Voice note", day: "Wed 5 Nov", voice: .init(record: "record.note-22", seconds: 41, from: nil, mine: true, when: "Wed 5 Nov, 08:12"))
    refs["r23"] = AskRef("Person B", day: "Mon 6 Oct", voice: .init(record: "record.note-23", seconds: nil, from: "Person B", mine: false, when: "Mon 6 Oct, 19:02"))
    return refs
}()

private let answer = "You had dinner at Synthetic Cafe with Person A on **Friday 16 October**, from about 19:40 to 22:10 [r1][r2]. "
    + "The table was booked on Monday [r3].\n\nWhat came up:\n\n- The trip in November, which Person A is planning [r1]\n"
    + "- A photo of the two of you at the table [r4]\n\nThe booking’s page is [on the cafe’s site](https://example.com/booking)."
private let table = "Your three longest nights this week:\n\n| Night | Asleep | In bed |\n|---|---|---|\n| Mon 12 Oct | 8 h 10 m | 8 h 52 m |\n"
    + "| Thu 15 Oct | 7 h 48 m | 8 h 20 m |\n| Sat 17 Oct | 7 h 31 m | 8 h 05 m |\n\nEach is from the health stream [r1]."
private let steps: [AskTrace.Step] = [
    .init("Searched messages for “dinner”"), .init("Read the chat with Person A, 16 Oct"),
    .init("Checked where you were, Fri 16 Oct 19:00–23:00"), .init("Searched mail for “booking”"),
    .init("Looked at 1 photo"),
]

private func live(_ events: [(ago: TimeInterval, event: AskTrace.Event)], asked: TimeInterval = 4) -> AskTrace {
    let now = AskTrace.now
    var trace = AskTrace(asked: now - asked)
    for (ago, event) in events { trace.take(event, at: now - ago) }
    return trace
}

@MainActor private func answer(_ markdown: String, refs: [String: AskRef]? = refs, open: String? = nil,
                               end: AskEnd = .done, seen: AskSeen? = nil, modelView: Bool? = nil,
                               feedback: AskFeedback? = nil) -> AskAnswer<AnyView, EmptyView> {
    AskAnswer(AskTrace(markdown), refs: refs, open: open, end: end, seen: seen, modelView: modelView.map { .constant($0) },
              feedback: feedback, cite: { _ in }) { _, _, fit in photo(fit) }
}

@MainActor private let feedback = AskFeedback("Send feedback…") {}

@MainActor private func voiced(_ markdown: String, looks: [String: VoiceCite.Look] = [:], modelView: Bool? = nil) -> AskAnswer<AnyView, VoiceCite> {
    AskAnswer(AskTrace(markdown), refs: refs, seen: modelView.map { _ in AskSeen(asked: [], answered: placed(markdown, [("Person A", "[[Person 1]]")])) },
              modelView: modelView.map { .constant($0) }, cite: { _ in }) { _, _, fit in photo(fit) } voice: { handle, voice in
        VoiceCite(voice, look: looks[handle] ?? .ready, toggle: {}, open: {})
    }
}

private func placed(_ text: String, _ pairs: [(String, String)]) -> [AskSeen.Span] {
    var from = text.startIndex
    return pairs.compactMap { words, said in
        guard let range = text.range(of: words, range: from..<text.endIndex) else { return nil }
        from = range.upperBound
        return .placeholder(text.utf16.distance(from: text.startIndex, to: range.lowerBound),
                            text.utf16.distance(from: text.startIndex, to: range.upperBound), said)
    }
}

private let seenAsked = "Who’s with me and Person A here?"
private let seenWords = "That’s **Person A** on the left, at Synthetic Cafe with Person B [r4].\n\n"
    + "Person A wrote to person-a@example.com the day before [r1]."
private let seen = AskSeen(
    asked: placed(seenAsked, [("Person A", "[[Person 1]]")]) + [
        .added(seenAsked.utf16.count, "\n[Photo 1: taken 3 Nov 2026 14:02 at "), .placeholder(seenAsked.utf16.count, seenAsked.utf16.count, "[[Place 1]]"),
        .added(seenAsked.utf16.count, "]"),
    ],
    answered: placed(seenWords, [("Person A", "[[Person 1]]"), ("Person B", "[[Person 2]]"), ("Person A", "[[Person 1]]"),
                                 ("person-a@example.com", "[[Email 1]]")]),
    photos: ["sha256:0000000000000000000000000000000000000000000000000000000000000001"])
private let spokenWords = "Call Person A tomorrow"
private let spoken: [AskSeen.Span] = [.added(0, "[A voice note, written out:]\n\n")] + placed(spokenWords, [("Person A", "[[Person 1]]")])

@MainActor private func composer(_ words: String, _ state: Composer.State = .ready, focused: Bool = false, tools: Bool = false,
                                 pictures: [Composer.Picture.State] = [], recording: Bool = false) -> Composer {
    let pick = Composer.Pick(words: "Claude Opus 5.5 · Medium",
                             levels: ["low", "medium", "high", "xhigh"].map { MenuRow.Option($0, $0 == "xhigh" ? "Extra high" : $0.capitalized) },
                             level: .constant("medium"), default: "high",
                             models: [MenuRow.Option("claude/opus", "Claude Opus 5.5"), MenuRow.Option("gpt-6.1-terra", "GPT-6.1 Terra"),
                                      MenuRow.Option("runner", "Qwen 3.5 9B", group: "Local"), MenuRow.Option("\n", "More", apart: true, opens: true)],
                             model: .constant("claude/opus"), modelName: "Claude Opus 5.5", reset: {})
    let level = Composer.Level(glyph: .hidden, words: "Hide all",
                               choices: [MenuRow.Option("all", "Hide all"), MenuRow.Option("names", "Keep names"), MenuRow.Option("none", "Don’t hide")],
                               choice: .constant("all"), waits: state == .running)
    let attach = Composer.Attach(library: {}, camera: {}, file: {})
    let photo = Image(nsImage: NSImage(size: NSSize(width: 64, height: 64), flipped: false) { rect in
        NSColor(red: 0.91, green: 0.55, blue: 0.43, alpha: 1).setFill()
        rect.fill()
        return true
    })
    let record = Composer.Record(start: {}, recording: recording
        ? Composer.Recording(time: "0:07", levels: (0..<60).map { 0.2 + 0.8 * abs(sin(Double($0) * 0.45 + 2)) }, stop: {}, send: {}, cancel: {})
        : nil)
    var composer = Composer(text: .constant(words), state: state, pick: pick, level: level, attach: tools ? attach : nil,
                            pictures: pictures.indices.map { Composer.Picture(id: "p\($0)", image: photo, state: pictures[$0], remove: {}) },
                            record: tools ? record : nil, send: {}, stop: {})
    composer.forcedFocus = focused
    return composer
}

@MainActor let composerSheet = Sheet("composer", ios: 390, mac: 640, hosted: true) {
    Specimen("Empty: the circle dim") { composer("") }
    Specimen("Words typed, focused: Send") { composer("Which of these days did I run?", focused: true) }
    Specimen("Grown with its words") {
        composer("Read everything from the trip in September and tell me:\n- where we stayed each night\n- who joined for which part\n- what it cost in all")
    }
    Specimen("An answer runs: Stop, the level chip dimmed") { composer("", .running) }
    Specimen("Chat can’t be asked") { composer("", .waiting) }
    Specimen("With + and the mic") { composer("", tools: true) }
    Specimen("A picture waiting over the words") { composer("Where did I take this?", tools: true, pictures: [.ready]) }
    Specimen("Pictures sending, ready and refused") { composer("Where did I take these?", tools: true, pictures: [.uploading, .ready, .refused]) }
    Specimen("Recording a note: stop, the waveform, the time, send") { composer("", tools: true, recording: true) }
}

@MainActor let askQuestionSheet = Sheet("ask-question", ios: 390, mac: 560) {
    let levels = (0..<34).map { 0.2 + 0.8 * abs(sin(Double($0) * 0.45 + 5)) }
    let photo = AnyView(LinearGradient(colors: [Color(red: 0.95, green: 0.70, blue: 0.48), Color(red: 0.43, green: 0.30, blue: 0.44)],
                                       startPoint: .top, endPoint: .bottom))
    Specimen("Short") { AskQuestion("Where was I on Friday night?") }
    Specimen("Long, wrapping at 78 % of the column") {
        AskQuestion("What did Person B and I decide about the move, and was there anything left open at the end of it that I said I would come back to?")
    }
    Specimen("Beginning a sitting: the time over it") { AskQuestion("One of these days I did a run, which was it?", stamp: "Today 08:29") }
    Specimen("A picture sent with it") { AskQuestion("Where did I take this?", stamp: "Today 08:29", picture: photo) }
    Specimen("A voice note, writing it out") {
        AskQuestion(voice: .init(time: "0:07", levels: levels, words: nil, play: {}))
    }
    Specimen("A voice note and its words") {
        AskQuestion(voice: .init(time: "0:07", levels: levels, played: 12,
                                 words: "How long was I at the gym yesterday, and was that longer than usual?", play: {}))
    }
    Specimen("Under the pointer: Edit (Mac)") { set(AskQuestion("And my sleep after it?", edit: {}), \.forcedHover, true) }
    Specimen("What the model saw: the name as its placeholder, the photo’s line after the words") {
        AskQuestion(seenAsked, stamp: "Today 08:29", picture: photo, seen: seen.asked, modelView: true)
    }
    Specimen("What the model saw: a voice note’s words as written out for it") {
        AskQuestion(voice: .init(time: "0:04", levels: levels, words: spokenWords, play: {}), seen: spoken, modelView: true)
    }
    Specimen("Reading: its bubble’s shape") {
        AskQuestion("When did I last have dinner with Person A?").reading(true).environment(\.skeletonForced, 0)
    }
}

@MainActor let askStepsSheet = Sheet("ask-steps", ios: 390, mac: 560) {
    Group {
        Specimen("Sending, before the home names the turn") { AskSteps(live([], asked: 0.2), open: .constant(false)) }
        Specimen("Thinking, before a step") { AskSteps(live([(3, .named)]), open: .constant(false)) }
        Specimen("Held until hiding is ready: the home’s line") {
            AskSteps(live([]), waiting: "Waiting for People to list the names of your people", open: .constant(false))
        }
        Specimen("Held, a long line wraps") {
            AskSteps(live([]), waiting: "Lifestream is erasing something you asked it to: hiding goes on once it is done",
                     open: .constant(false))
        }
        Specimen("A step under way: its start’s words, shimmering") {
            AskSteps(live([(3, .named), (2, .began(call: 1, words: "Searching messages for “visa guide”"))]), open: .constant(false))
        }
        Specimen("A long phrase ends in an ellipsis on its one line") {
            AskSteps(live([(3, .named), (2, .began(call: 1, words: "Reading the chat with Person A and Person B about the move, 2 Nov to 16 Nov"))]),
                     open: .constant(false))
        }
        Specimen("Done: how long it thought") { AskSteps(AskTrace("", steps: steps, thoughtMs: 9_400), open: .constant(false)) }
        Specimen("Done, opened: each step in its end’s words, flush left") {
            AskSteps(AskTrace("", steps: steps, thoughtMs: 39_000), open: .constant(true))
        }
        Specimen("Done, opened, a step that failed") {
            AskSteps(AskTrace("", steps: [.init("Searched messages for “ridge”"), .init("Couldn’t open example.com", failed: true),
                                          .init("Read Sat 3 Oct")], thoughtMs: 96_400), open: .constant(true))
        }
        Specimen("Done with no step: the line opens nothing") { AskSteps(AskTrace("", thoughtMs: 800), open: .constant(false)) }
    }
    .environment(\.skeletonForced, 0.3)
}

@MainActor let askAnswerSheet = Sheet("ask-answer", ios: 390, mac: 600) {
    Specimen("Streaming: its capsules quiet, a citation still being written unprinted, its pictures waiting") {
        answer(String(answer[..<answer.range(of: "[r3]")!.lowerBound]) + "[r", refs: nil, end: .running)
    }
    Specimen("Done: capsules in the order cited, one open; a list, a link, its photo under the list") {
        answer(answer, open: "r2")
    }
    Specimen("A chat on a day is one source, however many of its messages are cited") {
        answer("Person A said so twice [r15, r16], and again that evening [r16].", refs: refs)
    }
    Specimen("Past two sources at one place: the first two, then how many more; two stand as two") {
        answer("Four reservations in all [r1, r2, r3, r4], the first on Monday [r2, r3]. The photos are from the ridge [r5] [r6].", open: "r3")
    }
    Specimen("Under the pointer: Copy (Mac)") { set(answer("You slept 7 h 48 m on Thursday [r1]."), \.forcedHover, true) }
    Specimen("A handle in code or an address stays as written") {
        answer("Cited as `[r1]` in code, and in an [address](https://example.com/a[r2]b) [r3].\n\n```\nsee [r1]\n```")
    }
    Specimen("Under the pointer, something hidden: the eye beside Copy (Mac)") {
        set(answer(seenWords, seen: seen, modelView: false), \.forcedHover, true)
    }
    Specimen("Feedback: … after Copy and the eye, its menu holding Send feedback… (Mac: under the pointer)") {
        set(answer(seenWords, seen: seen, modelView: false, feedback: feedback), \.forcedHover, true)
    }
    Specimen("Failed: no Copy, the … alone under the retry") {
        set(answer("You walked along the ridge on", refs: [:], end: .failed("Lifestream couldn’t finish this answer.", retry: {}),
                   feedback: feedback), \.forcedHover, true)
    }
    Specimen("What the model saw: each detail its placeholder, the capsule as written, its photo folded away") {
        answer(seenWords, seen: seen, modelView: true)
    }
    Specimen("What the model saw in code: a block swaps whole, a code span keeps its chip") {
        let words = "Write to `person-a@example.com`:\n\n```\nto: person-a@example.com\n```"
        return answer(words, seen: AskSeen(asked: [], answered: placed(words, [("person-a@example.com", "[[Email 1]]"),
                                                                                ("person-a@example.com", "[[Email 1]]")])),
                      modelView: true)
    }
    Specimen("What the model saw: a sender’s address is one chip, a handle that resolves to nothing reads as written") {
        let words = "Person A <person-a@example.com> wrote last, about the booking [r3][r30]."
        return answer(words, seen: AskSeen(asked: [], answered: placed(words, [("Person A", "[[Person 1]]"),
                                                                                ("person-a@example.com", "[[Email 1]]")])),
                      modelView: true)
    }
    Specimen("The same answer as the person reads it: the address as drawn, no capsule for the handle") {
        let words = "Person A <person-a@example.com> wrote last, about the booking [r3][r30]."
        return answer(words, seen: AskSeen(asked: [], answered: placed(words, [("Person A", "[[Person 1]]"),
                                                                                ("person-a@example.com", "[[Email 1]]")])),
                      modelView: false)
    }
    Specimen("A table") { answer(table) }
    Specimen("Three photos in a row") { answer("Three photos from the ridge on Saturday 3 October [r5][r6][r7].") }
    Specimen("Seven in a grid, the sixth saying how many more") {
        answer("Your walk on 3 October, in photos [r8][r9][r10][r11][r12][r13][r14].")
    }
    Specimen("A voice note cited: its bar under the paragraph, after its photo, the caption who and when") {
        voiced("Person A sent it on the 4th, with a photo of the table [r20][r4].\n\nYou said the same the next morning [r22].")
    }
    Specimen("Two notes from one chat and day: never one source, two numbers, two bars in cited order") {
        voiced("Person A said it twice that evening [r20, r21], and once more later [r16].")
    }
    Specimen("What the model saw: the bars folded away with the photo") {
        voiced("Person A sent it on the 4th, with a photo of the table [r20][r4].", modelView: true)
    }
    Specimen("Stopped") { answer("You walked along the ridge on Saturday 3 October and again on", refs: [:], end: .stopped) }
    Specimen("Failed: what failed, Try again") { answer("", refs: [:], end: .failed("ChatGPT didn’t answer.", retry: {})) }
    Specimen("Reading: lines at the answer’s measure") {
        answer("You had dinner at Synthetic Cafe with Person A on Friday 16 October, from about 19:40 to 22:10.", refs: [:])
            .reading(true).environment(\.skeletonForced, 0)
    }
}

@MainActor let voiceCiteSheet = Sheet("voice-cite", ios: 390, mac: 440) {
    let theirs = AskRef.Voice(record: "record.note-a", seconds: 23, from: "Person A", mine: false, when: "Tue 4 Nov, 21:40")
    Specimen("Ready: its stated length") { VoiceCite(theirs, look: .ready, toggle: {}, open: {}) }
    Specimen("A source that states no length, until its audio loads") {
        VoiceCite(.init(record: "record.note-b", seconds: nil, from: "Person B", mine: false, when: "Mon 6 Oct, 19:02"), look: .ready, toggle: {}, open: {})
    }
    Specimen("Your own: the own-bubble fill, You") {
        VoiceCite(.init(record: "record.note-c", seconds: 41, from: nil, mine: true, when: "Wed 5 Nov, 08:12"), look: .ready, toggle: {}, open: {})
    }
    Specimen("Loading: a second tap cancels") { VoiceCite(theirs, look: .loading, toggle: {}, open: {}) }
    Specimen("Playing: the line fills, the time counts up") { VoiceCite(theirs, look: .playing(at: 9, of: 23.4), toggle: {}, open: {}) }
    Specimen("Paused: the line and time hold") { VoiceCite(theirs, look: .paused(at: 9, of: 23.4), toggle: {}, open: {}) }
    Specimen("Erased") { VoiceCite(theirs, look: .erased, toggle: {}, open: {}) }
    Specimen("Held, but didn't play") { VoiceCite(theirs, look: .unplayed, toggle: {}, open: {}) }
    Specimen("The home not reached, in the reach's words") {
        VoiceCite(theirs, look: .unreached("Can't reach your Mac."), toggle: {}, open: {})
    }
}

@MainActor let chatRowSheet = Sheet("chat-row", ios: 318, mac: 320) {
    Specimen("Yesterday and Previous 30 days: the open one, one still answering, a long title") {
        VStack(alignment: .leading, spacing: 0) {
            ChatLabel("Yesterday")
            ChatRow("Dinner with Person A on Friday", selected: true) {}
            ChatRow("Who did I see most this month", running: true) {}
            ChatLabel("Previous 30 days")
            ChatRow("Sleep this week") {}
            ChatRow("What Person B said about the move, and everything that followed from it") {}
        }
        .environment(\.skeletonForced, 0.3)
    }
    Specimen("Not read yet") {
        VStack(alignment: .leading, spacing: 0) {
            ChatLabel("Today")
            ChatRow("Dinner with Person A on Friday") {}
            ChatRow("Sleep this week") {}
        }
        .reading(true).environment(\.skeletonForced, 0)
    }
    Specimen("A fresh home: its starter questions") {
        VStack(alignment: .leading, spacing: 0) {
            AskStartRow(.place, "Where have I been today?") {}
            AskStartRow(.steps, "How far did I walk today?") {}
            AskStartRow(.photos, "What did I photograph this week?") {}
        }
    }
}

private let shot = Image(nsImage: NSImage(size: NSSize(width: 60, height: 120), flipped: true) { rect in
    NSColor(white: 0.16, alpha: 1).setFill()
    rect.fill()
    NSColor(white: 0.4, alpha: 1).setFill()
    NSRect(x: 8, y: 14, width: 44, height: 8).fill()
    NSRect(x: 8, y: 30, width: 30, height: 6).fill()
    return true
})

@MainActor private func chips(@ViewBuilder _ content: () -> some View) -> some View {
    FlowLayout(spacing: Cockpit.Space.s2, lineSpacing: Cockpit.Space.s2) { content() }
}

@MainActor let attachmentChipSheet = Sheet("attachment-chip", ios: 390, mac: 480) {
    Specimen("Opened on an answer: what is attached, each with its ×; the screenshot offered with its picture") {
        chips {
            AttachmentChip("This answer", lead: .icon(.chat), act: .kept(open: {}, remove: {}))
            AttachmentChip("App details", lead: .icon(.info), act: .kept(open: {}, remove: {}))
            AttachmentChip("Add screenshot", lead: .picture(shot), act: .offered(add: {}))
        }
    }
    Specimen("The screenshot added: its picture, opened full size, removed by its ×") {
        chips {
            AttachmentChip("App details", lead: .icon(.info), act: .kept(open: {}, remove: {}))
            AttachmentChip("Screenshot", lead: .picture(shot), act: .kept(open: {}, remove: {}))
        }
    }
    Specimen("A connector's status, a name too long for the line; no screenshot to offer") {
        chips {
            AttachmentChip("Example Bank Statements Uploader's status", lead: .icon(.streams), act: .kept(open: nil, remove: {}))
            AttachmentChip("App details", lead: .icon(.info), act: .kept(open: nil, remove: {}))
        }
    }
}

@MainActor let askPageSheet = Sheet("ask-page", ios: 390, mac: 640, hosted: true) {
    Specimen("Blank") {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: Cockpit.Space.s10)
            AskStartHeading()
            Spacer(minLength: Cockpit.Space.s10)
            composer("")
        }
        .frame(height: 560)
    }
}

@MainActor let askThreadSheet = Sheet("ask-thread", ios: 390, mac: 640) {
    Specimen("A turn as the model saw it") {
        VStack(alignment: .leading, spacing: 0) {
            AskQuestion(seenAsked, seen: seen.asked, modelView: true)
            AskSteps(AskTrace("", steps: steps, thoughtMs: 9_400), open: .constant(false)).padding(.top, Cockpit.Space.s3 + 2)
            answer(seenWords, seen: seen, modelView: true).padding(.top, Cockpit.Space.s3)
        }
        .environment(\.skeletonForced, 0.3)
    }
    Specimen("A thread") {
        VStack(alignment: .leading, spacing: 0) {
            AskQuestion("When did I last have dinner with Person A?", edit: {})
            AskSteps(AskTrace("", steps: steps, thoughtMs: 14_200), open: .constant(false)).padding(.top, Cockpit.Space.s3 + 2)
            answer(answer).padding(.top, Cockpit.Space.s3)
            AskQuestion("And my sleep after it?", stamp: "Mon 19 Oct 08:29", edit: {}).padding(.top, Cockpit.Space.s10)
            AskSteps(live([(3, .named), (2, .began(call: 1, words: "Reading Sat 17 Oct"))]), open: .constant(false))
                .padding(.top, Cockpit.Space.s3 + 2)
        }
        .environment(\.skeletonForced, 0.3)
    }
}
#endif
