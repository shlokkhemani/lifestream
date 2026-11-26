import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct MomentBody: View {
    let day: String
    let moment: HomeLink.Pages.DayMoment
    @Binding var only: Int?
    let read: @MainActor () async -> Void

    var body: some View {
        switch moment.view {
        case .thread(let chat?, let group): PageThread(day: day, chat: chat, group: group, marks: Set(moment.marks))
        case .thread(nil, _): Inspector.Line(text: "This conversation is not in Lifestream.")
        case .quiet(let chat): PageThread(day: day, chat: chat, group: true, marks: Set(moment.marks))
        case .ai(let work, let turns): MomentAI(work: work, turns: turns)
        case .call(let figure, let group, let name, let others, let week, _): MomentCall(figure: figure, group: group, name: name, others: others, week: week)
        case .mail(let list, let letters): MomentMail(list: list, letters: letters, only: $only)
        case .stay(let todayMs, _, let note, let inside): MomentStay(todayMs: todayMs, slug: moment.place?.slug, note: note, inside: inside)
        case .move(let km, let lengthMs, let from, let to, let mode, let legs, let note):
            MomentMove(km: km, lengthMs: lengthMs, from: from, to: to, mode: mode, legs: legs, note: note)
        case .body(let label, let lengthMs, let bedMs, let wakeMs, let facts, let vitals):
            MomentHealth(label: label, lengthMs: lengthMs, bedMs: bedMs, wakeMs: wakeMs, facts: facts, vitals: vitals)
        case .sitting(let account, let apps, let sites, let lines): MomentSitting(account: account, apps: apps, sites: sites, lines: lines)
        case .apps(let totalMs, let apps, let sites): MomentApps(totalMs: totalMs, apps: apps, sites: sites)
        case .event(let plan, let place, let with, let words): MomentEvent(plan: plan, place: place, with: with, words: words, startMs: moment.startMs)
        case .note(let words?) where !words.isEmpty: Inspector.Writing(words: words)
        case .note: Inspector.Line(text: "The note’s line holds no words beyond its title.")
        case .voice(let timed, let notes): MomentVoice(timed: timed, notes: notes, read: read)
        case .photos(let lines): MomentPhotos(pictures: moment.pictures, lines: lines)
        case .listening(let tracks): MomentList(lines: tracks.map { (nil, $0) }, icon: .music)
        case .checkIn(let head, let median, let lapses, let facts, let note):
            MomentCheckIn(head: head, median: median, lapses: lapses, facts: facts, note: note)
        case .payment(let amount, let direction, let facts): MomentPayment(amount: amount, direction: direction, facts: facts)
        case .lines(let lines): MomentList(lines: lines.map { (MomentReading.span($0.startMs, $0.endMs), $0.text) }, icon: .time)
        case .unknown: EmptyView()
        }
    }
}

private struct MomentList: View {
    let lines: [(at: String?, text: String)]
    let icon: Cockpit.Icon

    var body: some View {
        if !lines.isEmpty {
            Card(group: true, flat: true) {
                ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                    ListRow(line.text, wraps: true, meta: line.at, leading: .icon(icon), separator: index < lines.count - 1)
                }
            }
        }
    }
}

private struct MomentFacts: View {
    let facts: [HomeLink.Pages.MomentFact]

    var body: some View {
        if !facts.isEmpty { Inspector.Facts(facts: facts.map { ($0.label, $0.value) }) }
    }
}

private struct MomentMeters: View {
    let apps: [HomeLink.Pages.MomentApp]

    var body: some View {
        let timed = apps.compactMap { app in app.minutes.map { (app.name, $0) } }
        if !timed.isEmpty {
            Inspector.Meters(items: timed.map { name, minutes in
                (name, minutes == 0.5 ? "<1m" : Words.duration(minutes * 60), minutes)
            })
        }
    }
}

private struct MomentSites: View {
    let sites: [HomeLink.Pages.MomentSite]

    var body: some View {
        if !sites.isEmpty {
            Card(group: true, flat: true) {
                ForEach(Array(sites.enumerated()), id: \.offset) { index, site in
                    let row = ListRow(site.title, meta: [site.line, site.atMs.map(MomentReading.clock)].compactMap { $0 }.joined(separator: Words.dot),
                                      leading: .icon(Cockpit.Icon(rawValue: site.icon) ?? .web), separator: index < sites.count - 1)
                    if let href = site.href, let url = URL(string: href) {
                        Link(destination: url) { row }.buttonStyle(.plain)
                    } else {
                        row
                    }
                }
            }
        }
    }
}

private struct MomentNote: View {
    let words: String?

    var body: some View {
        if let words, !words.isEmpty {
            Text(words)
                .cockpit(.footnote)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct MomentAI: View {
    let work: [String]
    let turns: [HomeLink.Pages.MomentTurn]
    @State private var open: Set<Int> = []

    private static let folded = 1600

    var body: some View {
        ScrollViewReader { scroll in
            LazyVStack(alignment: .leading, spacing: Cockpit.Space.s4) {
                ForEach(Array(work.enumerated()), id: \.offset) { _, words in
                    HStack(spacing: Cockpit.Space.s2) {
                        Icon(.ai, size: .xs)
                        Text(words).cockpit(.subhead)
                    }
                    .foregroundStyle(Cockpit.Color.textTertiary)
                }
                ForEach(Array(turns.enumerated()), id: \.offset) { index, turn in
                    self.turn(turn, at: index).id(index)
                }
            }
            .padding(.top, 6)
            .task { if let marked = turns.firstIndex(where: \.marked) { scroll.scrollTo(marked, anchor: .center) } }
        }
    }

    @ViewBuilder
    private func turn(_ turn: HomeLink.Pages.MomentTurn, at index: Int) -> some View {
        if turn.mine {
            MessageBubble(turn.words, mine: true, marked: turn.marked)
        } else {
            let long = turn.full && turn.words.count > Self.folded && !open.contains(index)
            VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                Text(markdown(long ? String(turn.words.prefix(Self.folded)) + "…" : turn.words))
                    .cockpit(.body)
                    .foregroundStyle(Cockpit.Color.text)
                    .tint(Cockpit.Color.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                if long {
                    Button("Show all") { open.insert(index) }
                        .buttonStyle(.cockpit(.plain, size: .small))
                }
            }
            .padding(turn.marked ? Cockpit.Space.s3 : 0)
            .background { if turn.marked { FoundWash(shape: RoundedRectangle(cornerRadius: 16, style: .continuous)) } }
        }
        if !turn.tools.isEmpty {
            HStack(spacing: Cockpit.Space.s2) {
                Icon(.ai, size: .xs)
                Text("Used " + turn.tools.joined(separator: ", ")).cockpit(.subhead)
            }
            .foregroundStyle(Cockpit.Color.textTertiary)
        }
    }

    private func markdown(_ words: String) -> AttributedString {
        (try? AttributedString(markdown: words, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(words)
    }
}

private struct MomentCall: View {
    let figure: HomeLink.Pages.CallFigure?
    let group: String
    let name: String
    let others: [HomeLink.Pages.OtherCall]
    let week: HomeLink.Pages.CallWeek?
    @Environment(\.inspectorGo) private var go

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Gap.section) {
            if let figure {
                Figure(figure.lengthMs.map(MomentReading.length) ?? figure.words ?? "", label: figure.label, size: .xl)
            }
            Inspector.Facts(facts: [("In", group)])
            if let week {
                let which = week.current ? "this" : "that"
                Inspector.Section("\(week.current ? "This" : "That") week with \(name)") {
                    if week.calls.isEmpty {
                        NoneLine("No other calls \(which) week.")
                    } else {
                        let today = HomeClock.current.today()
                        Card(group: true, flat: true) {
                            ForEach(Array(week.calls.enumerated()), id: \.offset) { index, call in
                                ListRow(call.title,
                                        meta: [Words.shortDay(call.day, today: today), MomentReading.clock(call.atMs), call.lengthMs.map(MomentReading.length)]
                                            .compactMap { $0 }.joined(separator: Words.dot),
                                        leading: .icon(Cockpit.Icon(rawValue: call.icon) ?? .call), chevron: true, separator: index < week.calls.count - 1,
                                        action: { go(.day(call.day, focus: call.focus)) })
                            }
                        }
                    }
                }
            } else if !others.isEmpty {
                Inspector.Section("Other calls with \(name) today") {
                    MomentList(lines: others.map { other in
                        (MomentReading.clock(other.atMs), [other.way, other.lengthMs.map(MomentReading.length)].compactMap { $0 }.joined(separator: Words.dot))
                    }, icon: .call)
                }
            }
        }
    }
}

private struct MomentMail: View {
    let list: Bool
    let letters: [HomeLink.Pages.Letter]
    @Binding var only: Int?

    var body: some View {
        if let only, letters.indices.contains(only) {
            MomentLetter(letter: letters[only])
        } else if list {
            Card(group: true, flat: true) {
                ForEach(Array(letters.enumerated()), id: \.offset) { index, letter in
                    ListRow(letter.subject.isEmpty ? "(no subject)" : letter.subject,
                            meta: [letter.from, letter.atMs.map(MomentReading.clock)].compactMap { $0 }.joined(separator: Words.dot),
                            leading: .icon(.mail), chevron: true, separator: index < letters.count - 1, action: { only = index })
                }
            }
        } else if let letter = letters.first {
            MomentLetter(letter: letter)
        }
    }
}

private struct MomentLetter: View {
    let letter: HomeLink.Pages.Letter

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Gap.section) {
            LetterHead(letter.from.isEmpty ? "Unknown sender" : letter.from, address: letter.address,
                       to: letter.to.isEmpty ? nil : "to " + letter.to)
            if !letter.words.isEmpty { Inspector.Writing(words: letter.words) }
            if !letter.attached.isEmpty {
                Inspector.Section(Words.count(letter.attached.count, "attachment")) {
                    MomentList(lines: letter.attached.map { (nil, $0) }, icon: .file)
                }
            }
        }
    }
}

private struct MomentStay: View {
    let todayMs: Int
    let slug: String?
    let note: String?
    let inside: [HomeLink.Pages.MomentTimed]
    @Environment(\.inspectorGo) private var go

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Gap.section) {
            VStack(alignment: .leading, spacing: Cockpit.Gap.group) {
                FigureStrip { Figure(MomentReading.length(todayMs), label: "Here today", size: .m) }
                if let slug {
                    Button("Every day here") { go(.place(slug)) }
                        .buttonStyle(.cockpit(.secondary, size: .small))
                }
            }
            MomentNote(words: note)
            if !inside.isEmpty {
                Inspector.Section("Inside the stay") {
                    MomentList(lines: inside.map { (MomentReading.span($0.startMs, $0.endMs), $0.text) }, icon: .walk)
                }
            }
        }
    }
}

private struct MomentMove: View {
    let km: String?
    let lengthMs: Int?
    let from: String
    let to: String
    let mode: String?
    let legs: [HomeLink.Pages.MomentTimed]
    let note: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Gap.section) {
            FigureStrip {
                if let km { Figure(km, label: "Distance") }
                if let lengthMs { Figure(MomentReading.length(lengthMs), label: "Duration") }
            }
            Inspector.Facts(facts: [("From", from), ("To", to)] + (mode.map { [("Mode", $0)] } ?? []))
            if !legs.isEmpty {
                Inspector.Section(Words.count(legs.count, "leg")) {
                    MomentList(lines: legs.map { (MomentReading.span($0.startMs, $0.endMs), $0.text) }, icon: .move)
                }
            }
            MomentNote(words: note)
        }
    }
}

private struct MomentHealth: View {
    let label: String
    let lengthMs: Int?
    let bedMs: Int?
    let wakeMs: Int?
    let facts: [[HomeLink.Pages.MomentFact]]
    let vitals: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Gap.section) {
            if let lengthMs, lengthMs > 0 { Figure(MomentReading.length(lengthMs), label: label, size: .xl) }
            if let bedMs, let wakeMs {
                FigureStrip {
                    Figure(MomentReading.clock(bedMs), label: "Bed", size: .m)
                    Figure(MomentReading.clock(wakeMs), label: "Wake", size: .m)
                }
            }
            ForEach(Array(facts.enumerated()), id: \.offset) { _, group in MomentFacts(facts: group) }
            if !vitals.isEmpty {
                Inspector.Section("The day’s vitals") {
                    ForEach(Array(vitals.enumerated()), id: \.offset) { _, words in Inspector.Line(text: words) }
                }
            }
        }
    }
}

private struct MomentSitting: View {
    let account: HomeLink.Pages.ScreenAccount?
    let apps: [HomeLink.Pages.MomentApp]
    let sites: [HomeLink.Pages.MomentSite]
    let lines: [HomeLink.Pages.MomentTimed]

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Gap.section) {
            if let account {
                if !account.narrative.isEmpty { Inspector.Writing(words: account.narrative) }
                if !account.tasks.isEmpty {
                    Inspector.Section("Time per task") {
                        Inspector.Meters(items: account.tasks.map { ($0.task, Words.duration(TimeInterval($0.seconds)), Double($0.seconds)) })
                    }
                }
            }
            if apps.contains(where: { $0.minutes != nil }) {
                Inspector.Section("Apps") { MomentMeters(apps: apps) }
            }
            if account == nil, !lines.isEmpty {
                Inspector.Section("What the screen shows") {
                    MomentList(lines: lines.map { ($0.startMs.map(MomentReading.clock), $0.text) }, icon: .screen)
                }
            }
            if !sites.isEmpty {
                Inspector.Section("Sites") { MomentSites(sites: sites) }
            }
            if let account {
                if !account.people.isEmpty { Inspector.Section("People") { Tags(names: account.people) } }
                if !account.projects.isEmpty { Inspector.Section("Projects") { Tags(names: account.projects) } }
                if !account.steps.isEmpty {
                    Inspector.Folded("Step by step") {
                        MomentList(lines: account.steps.map { step in
                            (MomentReading.clock(step.startMs), [step.task, step.doing].compactMap { $0 }.joined(separator: Words.dot))
                        }, icon: .screen)
                    }
                }
            }
        }
    }
}

private struct Tags: View {
    let names: [String]

    var body: some View {
        FlowLayout(spacing: Cockpit.Space.s2, lineSpacing: Cockpit.Space.s2) {
            ForEach(names, id: \.self) { Tag($0) }
        }
    }
}

private struct MomentApps: View {
    let totalMs: Int?
    let apps: [HomeLink.Pages.MomentApp]
    let sites: [HomeLink.Pages.MomentSite]

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Gap.section) {
            if let totalMs { Figure(MomentReading.length(totalMs), label: "Screen Time says", size: .xl) }
            MomentMeters(apps: apps)
            MomentSites(sites: sites)
        }
    }
}

private struct MomentEvent: View {
    let plan: Bool
    let place: HomeLink.Pages.EventWhere?
    let with: String?
    let words: String
    let startMs: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Gap.section) {
            if plan, let startMs {
                let ahead = max(0, Int64(startMs) - Int64(AppClock.now.timeIntervalSince1970 * 1000))
                Tag("Coming up" + Words.dot + "in " + Words.duration(TimeInterval(ahead) / 1000), tone: .plan)
            }
            let facts = (place.map { [("Where", $0.text)] } ?? []) + (with.map { [("With", $0)] } ?? [])
            if !facts.isEmpty {
                Inspector.Facts(facts: facts, links: place.flatMap { place in URL(string: place.href).map { ["Where": $0] } } ?? [:])
            }
            if !words.isEmpty { Inspector.Writing(words: words) }
        }
    }
}

private struct MomentVoice: View {
    let timed: Bool
    let notes: [HomeLink.Pages.VoiceNote]
    let read: @MainActor () async -> Void
    @StateObject private var acts = Inspector.MadeActs()

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Gap.section) {
            ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
                VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                    if timed, let at = note.atMs {
                        Text(MomentReading.clock(at)).cockpit(.monoData).foregroundStyle(Cockpit.Color.textTertiary)
                    }
                    if !note.words.isEmpty { Inspector.Voice(words: note.words) }
                    if let made = note.made.map(MomentReading.made) {
                        Inspector.Made(made: made, verb: .transcribe, acts: acts, read: read)
                    }
                    if let record = note.record {
                        VoicePlayer(ref: MomentReading.ref(record), stated: TimeInterval(note.seconds ?? 0))
                    }
                }
            }
        }
        .readsAgain(while: notes.contains { acts.awaits($0.made.map(MomentReading.made)) }) { await read() }
    }
}

private struct MomentPhotos: View {
    let pictures: [HomeLink.Pages.MomentPicture]
    let lines: [HomeLink.Pages.PhotoLine]
    @State private var page = 0
    @State private var opening: PhotoViewer.Opening?
    @Environment(\.inspectorGo) private var go

    private static let height: CGFloat = 300
    private static let dots: CGFloat = 36

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Gap.section) {
            if pictures.isEmpty {
                Inspector.Line(text: "These photos are not in Lifestream.")
            } else {
                burst
            }
            MomentList(lines: lines.map { ($0.startMs.map(MomentReading.clock), $0.text) }, icon: .photo)
        }
        .photoViewer($opening) { go($0) }
    }

    private var burst: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
            Text(pictures.indices.contains(page) ? pictures[page].words : "")
                .cockpit(Cockpit.Style.iosBody)
                .foregroundStyle(Cockpit.Color.text)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            TabView(selection: $page) {
                ForEach(Array(pictures.enumerated()), id: \.element.hash) { index, picture in
                    Button { opening = PhotoViewer.Opening(photos: pictures.map(\.hash), at: index) } label: {
                        if picture.video {
                            PlaceShot.Picture(hash: picture.hash)
                                .frame(maxWidth: .infinity)
                                .frame(height: Self.height)
                                .background(Cockpit.Color.well)
                                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                                .overlay(alignment: .bottomTrailing) {
                                    VideoMark(length: picture.durationMs.map { Double($0) / 1000 }).padding(Cockpit.Space.s1)
                                }
                                .contentShape(Rectangle())
                        } else {
                            Inspector.Picture(hash: picture.hash, height: Self.height, fill: true, corner: 16)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(label(picture))
                    .accessibilityHint(picture.video ? "Plays it in the photo viewer" : "Opens it in the photo viewer")
                    .accessibilityIdentifier("inspector.\(picture.video ? "video" : "photo").\(index)")
                    .frame(maxHeight: .infinity, alignment: .top)
                    .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: pictures.count > 1 ? .always : .never))
            .frame(height: Self.height + (pictures.count > 1 ? Self.dots : 0))
        }
    }

    private func label(_ picture: HomeLink.Pages.MomentPicture) -> String {
        let what = picture.video ? (["Video"] + [picture.durationMs.map { VideoClock.length(Double($0) / 1000) }].compactMap { $0 })
            .joined(separator: ", ") : picture.alt
        if picture.words.isEmpty { return what }
        return picture.video || picture.live ? what + ", " + picture.words : picture.words
    }
}

private struct MomentCheckIn: View {
    let head: String?
    let median: String?
    let lapses: String?
    let facts: [HomeLink.Pages.MomentFact]
    let note: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Gap.section) {
            if let head {
                MomentNote(words: head)
                MomentFacts(facts: facts)
                if let note, !note.isEmpty { Inspector.Voice(words: note) }
            } else {
                FigureStrip {
                    if let median { Figure(median, label: "Median") }
                    if let lapses { Figure(lapses, label: "Lapses") }
                }
                MomentFacts(facts: facts)
            }
        }
    }
}

private struct MomentPayment: View {
    let amount: String?
    let direction: HomeLink.Pages.MomentView.Direction
    let facts: [HomeLink.Pages.MomentFact]

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Gap.section) {
            if let amount { Figure(amount, label: direction == .in ? "In" : "Out", size: .xl) }
            MomentFacts(facts: facts)
        }
    }
}
