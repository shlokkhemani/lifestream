import Combine
import Foundation
import HomeLink
import LifestreamCaptureCore
import os

@MainActor
final class LifeReader: ObservableObject {
    enum Failure: Error, Equatable {
        case unpaired
        case reach(begun: Int)
        case busy(String, code: String, until: Date, begun: Int)
        case missing
        case refused(String)
        case failed(String)
        case unknown(String)

        var later: Bool {
            switch self {
            case .reach, .busy: true
            default: false
            }
        }

        var begun: Int? {
            if case .reach(let begun) = self { begun } else { nil }
        }

        var since: Int? {
            switch self {
            case .reach(let begun), .busy(_, _, _, let begun): begun
            default: nil
            }
        }

        var until: Date? {
            if case .busy(_, _, let until, _) = self { until } else { nil }
        }
    }

    private static let log = Logger(subsystem: "org.lifestreamprotocol.phone", category: "reads")

    private var generation = 0
    @Published private(set) var checking = false
    @Published private(set) var checkRefused: CheckRefused?

    private let link: HomeLink
    private let clock: () -> Date

    struct CheckRefused: Equatable {
        let hold: HomeLink.Held
        let words: String
    }

    init(link: HomeLink, clock: @escaping () -> Date = { AppClock.now }) {
        self.link = link
        self.clock = clock
    }

    func forget() {
        generation += 1
        checkRefused = nil
    }

    func checkAgain() async {
        guard !checking, case .held(let hold) = link.snapshot.reach else { return }
        checking = true
        defer { checking = false }
        var refused: String?
        do {
            try await link.verifyHome()
        } catch {
            switch HomeLink.state(of: error, now: clock()) {
            case .refused(let words)?, .wait(let words, _)?, .unknown(let words)?: refused = words
            default: break
            }
        }
        if let refused, link.snapshot.reach == .held(hold) {
            checkRefused = CheckRefused(hold: hold, words: refused)
        } else {
            checkRefused = nil
        }
    }


    func days(from: String? = nil, to: String? = nil, after: String? = nil, limit: Int? = nil) async throws -> HomeLink.DayList {
        try await ask { try await $0.days(from: from, to: to, after: after, limit: limit) }
    }

    func `where`(from: HomeLink.Bound, to: HomeLink.Bound, etag: String?) async throws -> HomeLink.Tagged<HomeLink.Where.Pieces>? {
        try await ask { try await $0.where(from: from, to: to, etag: etag) }
    }

    func places(at points: [HomeLink.Where.Point]) async throws -> [HomeLink.PointPlace] {
        try await ask { try await $0.places(at: points) }
    }

    func searchKind(_ key: HomeLink.PageKey) async throws -> HomeLink.Pages.SearchKind {
        try await ask { try await $0.searchKind(key) }
    }

    func countTable(_ query: HomeLink.CountTableQuery) async throws -> HomeLink.CountTable {
        try await ask { try await $0.countTable(query) }
    }

    func count(_ query: HomeLink.CountQuery) async throws -> HomeLink.Counted {
        try await ask { try await $0.count(query) }
    }

    func describe(_ refs: [String]) async throws -> HomeLink.Described {
        try await ask { try await $0.describe(refs) }
    }

    func rowFacts(_ ref: String, cursor: String? = nil) async throws -> RowOpened {
        try await ask { link in
            switch try await link.read(ref: ref, cursor: cursor) {
            case .row(let row): .facts(row)
            default: .gone
            }
        }
    }

    enum RowOpened: Equatable {
        case facts(HomeLink.Read.Row)
        case gone
    }


    var takesPeople: Bool {
        (link.saved?.owner ?? []).contains { $0.hasPrefix("people:") }
    }

    func people() async throws -> HomeLink.People {
        try await ask { try await $0.people() }
    }

    func peopleAt() async throws -> HomeLink.Positioned<HomeLink.People> {
        try await ask { try await $0.peopleAt() }
    }

    func find(_ words: String, for owner: String? = nil) async throws -> HomeLink.Pages.PeopleFind {
        let query = ["q": words].merging(owner.map { ["for": $0] } ?? [:]) { $1 }
        return try await ask { link in
            guard let answer = try await link.page(HomeLink.PageKey(HomeLink.Pages.PeopleFind.route, query), etag: nil) else {
                throw LinkFailure.unreadable(304)
            }
            return try JSONDecoder().decode(HomeLink.Pages.PeopleFind.self, from: answer.value)
        }
    }

    func findModels(_ words: String, for more: HomeLink.Pages.ModelMore) async throws -> HomeLink.Pages.ModelsFind {
        let query = ModelFind.query(more).merging(["q": words]) { $1 }
        return try await ask { link in
            guard let answer = try await link.page(HomeLink.PageKey(HomeLink.Pages.ModelsFind.route, query), etag: nil) else {
                throw LinkFailure.unreadable(304)
            }
            return try JSONDecoder().decode(HomeLink.Pages.ModelsFind.self, from: answer.value)
        }
    }

    func act(_ action: HomeLink.OwnerAction) async -> HomeLink.Acted {
        let home = generation
        let acted = await link.acted(action, now: clock())
        return generation == home ? acted : .unanswered(.notSent)
    }

    func personPhotos(id: String, after: String?, etag: String?) async throws -> HomeLink.Tagged<HomeLink.People.Photos>? {
        try await ask { try await $0.personPhotos(id: id, after: after, etag: etag) }
    }


    func place(slug: String, etag: String?) async throws -> HomeLink.Tagged<HomeLink.Place>? {
        try await ask { try await $0.place(slug: slug, etag: etag) }
    }

    func suggest(spot key: String, q: String?) async throws -> HomeLink.Suggestions {
        try await ask { try await $0.suggest(spot: key, q: q) }
    }

    func placePhotos(slug: String, after: String?, etag: String?) async throws -> HomeLink.Tagged<HomeLink.PlacePhotos>? {
        try await ask { try await $0.placePhotos(slug: slug, after: after, etag: etag) }
    }


    func products() async throws -> HomeLink.Products {
        try await ask { try await $0.products() }
    }

    func sources() async throws -> [HomeLink.SourceRead] {
        try await ask { try await $0.sources() }
    }

    func act(need: String, do act: String, of source: String? = nil) async throws {
        try await ask { try await $0.act(need: need, do: act, of: source) }
    }

    func choose(need: String, account: String) async throws {
        try await ask { try await $0.choose(need: need, account: account) }
    }

    func process(_ ask: HomeLink.Made.Ask, route: String) async throws {
        try await self.ask { try await $0.process(ask, route: route) }
    }

    static let soonest: TimeInterval = 1
    static let rereadEvery: Duration = AppRuntime.isUITesting ? .seconds(2) : .seconds(60)


    func extracts(family: String, unit: String) async throws -> [HomeLink.Extract] {
        try await ask { try await $0.extracts(family: family, unit: unit) }
    }

    func extracts(family: String, day: String) async throws -> [HomeLink.Extract] {
        try await ask { try await $0.extracts(family: family, day: day) }
    }

    func record(source: String, kind: String, key: String) async throws -> HomeLink.Record {
        try await ask { try await $0.record(source: source, kind: kind, key: key) }
    }

    func blob(_ hash: String) async throws -> Data {
        try await ask { try await $0.blob(hash) }
    }

    func video(_ play: HomeLink.Photo.Play) -> VideoLoader {
        VideoLoader(link: link, play: play)
    }

    func photo(_ hash: String) async throws -> HomeLink.Photo {
        try await ask { try await $0.photo(hash) }
    }

    func outbound(of item: HomeLink.Made.Ask) async throws -> [HomeLink.Outbound] {
        try await ask { try await $0.outbound(of: item) }
    }

    func outbound(seq: Int) async throws -> HomeLink.Outbound {
        try await ask { try await $0.outbound(seq: seq) }
    }

    func privacy() async throws -> HomeLink.PrivacyState {
        try await ask { try await $0.privacy() }
    }

    func picture(_ hash: String, size: HomeLink.PictureSize) async throws -> Data {
        try await ask { try await $0.picture(hash, size: size) }
    }


    func askReady(pick: HomeLink.Ask.Pick?) async throws -> HomeLink.Ask.Ready {
        try await ask { try await $0.askReady(pick: pick) }
    }

    func chats(after: String? = nil) async throws -> HomeLink.Ask.Chats {
        try await ask { try await $0.chats(after: after) }
    }

    func chat(_ chat: String) async throws -> HomeLink.Ask.Chat {
        try await ask { try await $0.chat(chat) }
    }

    func ask(_ question: HomeLink.Ask.Question, chat: String?, level: HomeLink.Ask.Level?, pick: HomeLink.Ask.Pick?) async throws -> AsyncThrowingStream<HomeLink.Ask.Event, Error> {
        try await ask { link in
            do {
                return try await link.ask(question, chat: chat, level: level, pick: pick)
            } catch LinkFailure.refused(let status, _, let words) where status != 401 && status != 426 {
                throw AskOutbox.Refused(status: status, words: words)
            }
        }
    }

    var home: String? {
        (try? link.pin()).flatMap { $0 } ?? (try? link.name()).flatMap { $0 }?.absoluteString
    }

    func chatPrivacy(_ chat: String) async throws -> HomeLink.Ask.Privacy {
        try await ask { try await $0.chatPrivacy(chat) }
    }

    var revision: Int { link.snapshot.revision }

    func stage(photo file: URL) async throws -> HomeLink.Ask.Staged {
        try await ask { link in
            do {
                return try await link.stage(photo: file)
            } catch LinkFailure.refused(let status, _, let words) where status != 401 && status != 426 {
                throw AskOutbox.Refused(status: status, words: words)
            } catch LinkFailure.unavailable("STAGE_FULL", let words?, _, _) {
                throw AskOutbox.Refused(status: 507, words: words)
            }
        }
    }

    func openNote(_ note: String) async throws {
        try await ask { try await $0.openNote(note) }
    }

    func sendSecond(note: String, _ k: Int, file: URL) async throws {
        try await ask { try await $0.sendSecond(note: note, k, file: file) }
    }

    func cancelNote(_ note: String) async throws {
        try await ask { try await $0.cancelNote(note) }
    }

    func chooseVoice(_ value: String, was: String) async throws -> SettingOutcome {
        try await ask { try await $0.setSetting(connector: "ask", member: "llm.voice", value: .string(value), was: .string(was)) }
    }

    func follow(chat: String) async throws -> AsyncThrowingStream<HomeLink.Ask.Event, Error>? {
        try await ask { try await $0.follow(chat: chat) }
    }

    func stopAsking(chat: String) async throws {
        _ = try await ask { try await $0.stopAsking(chat: chat) }
    }


    private func ask<Value>(_ read: (HomeLink) async throws -> Value) async throws -> Value {
        let home = generation
        let begun = link.snapshot.revision
        do {
            return try await read(link)
        } catch let failure as LinkFailure {
            guard generation == home else { throw CancellationError() }
            if case .unpaired = failure { throw Failure.unpaired }
            if case .refused(404, _, _) = failure { throw Failure.missing }
            switch HomeLink.state(of: failure, now: clock()) {
            case .reach?: throw Failure.reach(begun: begun)
            case .wait(let words, let until)?:
                throw Failure.busy(words, code: failure.code, until: max(until, clock().addingTimeInterval(Self.soonest)), begun: begun)
            case .refused(let words)?: throw Failure.refused(words)
            case .saving?: throw failure
            case .unknown(let words)?: throw Failure.unknown(words)
            case .failed?: throw Failure.failed(failure.description)
            case .inFlight?, nil: throw Failure.refused(failure.description)
            }
        }
    }

    private static func value<Value>(_ tagged: HomeLink.Tagged<Value>?) throws -> Value {
        guard let tagged else { throw LinkFailure.unreadable(304) }
        return tagged.value
    }
}
