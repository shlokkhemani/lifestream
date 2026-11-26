import Foundation
import HomeLink
import LifestreamCaptureCore
import UIKit
import XCTest

@testable import Lifestream

final class StreamsReportTests: XCTestCase {
    private let unit = "iphone-17-pro-aa01"

    private func report() throws -> HomeLink.StreamsReport {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "report", withExtension: "json"), "the app carries the home's fixture")
        return try JSONDecoder().decode(HomeLink.StreamsReport.self, from: Data(contentsOf: url))
    }

    @MainActor
    func testASettingThatDidNotLandSaysWhatAnActSays() async throws {
        let words = "Lifestream did not answer in time: it may have kept the change."
        XCTAssertNil(HomeConnectorsModel.said(.taken(.bool(true))))
        XCTAssertNil(HomeConnectorsModel.said(.changed(.bool(true))), "someone else's value landed: the read shows it")
        XCTAssertEqual(HomeConnectorsModel.said(.unknown(words)), .unknown(words), "the door's words, never offered again")

        let door = SettingsDoor()
        let link = try await paired(door)
        door.answer = nil
        let silent = try await link.setSetting(connector: "gmail", member: "spam", value: .bool(true), was: .bool(false))
        XCTAssertEqual(HomeConnectorsModel.said(silent), .notSent, "no answer: not sent, with Try again")
        guard case .waiting = link.snapshot.reach else { return XCTFail("reach heard the silence: \(link.snapshot.reach)") }

        door.answer = 422
        let refused = try await link.setSetting(connector: "gmail", member: "spam", value: .bool(true), was: .bool(false))
        XCTAssertEqual(HomeConnectorsModel.said(refused), .refused(ReachWords.refused), "a real refusal is the home's")
        XCTAssertEqual(link.snapshot.reach, .answering, "a refusal is an answer")

        var changes = MemberChanges()
        let key = MemberChanges.key("gmail", "spam")
        changes.landed[key] = MemberChanges.Landed(connector: "gmail", member: "spam", value: .bool(true))
        XCTAssertNil(changes.problem(key, read: .reach(begun: 0)), "the read after failed for reach: the banner says it")
        XCTAssertEqual(changes.problem(key, read: .busy("Your home is busy.", code: "INDEX_BUSY", until: Date(), begun: 0)), "Your home is busy.")
    }

    func testASettingSettlesWhenTheReadHoldsTheValueTheHomeSaidLandedNeverOnTheNextRead() {
        XCTAssertEqual(MemberChanges.landed(.taken(.string("1h")), sent: .string("30m")), .string("1h"), "the home's landed value")
        XCTAssertEqual(MemberChanges.landed(.taken(nil), sent: .string("30m")), .string("30m"), "an answer naming none: the value taken")
        XCTAssertEqual(MemberChanges.landed(.changed(.string("2h")), sent: .string("30m")), .string("2h"), "another's value landed")
        XCTAssertNil(MemberChanges.landed(.refused, sent: .string("30m")))

        var changes = MemberChanges()
        let key = MemberChanges.key("gmail", "refresh")
        changes.busy.insert(key)
        changes.landed[key] = MemberChanges.Landed(connector: "gmail", member: "refresh", value: .string("1h"))
        changes.settle { _, _ in .string("30m") }
        XCTAssertTrue(changes.busy.contains(key), "a read before the value landed leaves it busy")
        XCTAssertNotNil(changes.landed[key])
        changes.settle { connector, member in connector == "gmail" && member == "refresh" ? .string("1h") : nil }
        XCTAssertFalse(changes.busy.contains(key), "the read that holds the landed value settles it")
        XCTAssertNil(changes.landed[key])

        changes.busy.insert(key)
        changes.landed[key] = MemberChanges.Landed(connector: "gmail", member: "refresh", value: .null)
        changes.settle { _, _ in nil }
        XCTAssertFalse(changes.busy.contains(key), "a value cleared lands as a member holding none")
    }

    @MainActor
    private func paired(_ door: SettingsDoor) async throws -> HomeLink {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("streams-report-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        let link = HomeLink(device: HomeLink.Device(kind: .phone, version: "1.0.0", model: "iPhone", serial4: nil),
                            credentials: MemoryPass(), folder: folder, transport: door,
                            network: TestNetwork(NetworkFacts(online: true, onLocalNetwork: false, tunnelUp: true, path: 1, cost: .free)))
        _ = try await link.pair(code: "12345678", name: "http://100.64.0.42:4680", account: "person-a@example.com")
        return link
    }

    func testAPhoneTakesOnlyTheActsItCan() throws {
        let report = try report()
        let ofStream = Dictionary(uniqueKeysWithValues: report.connectors.map { ($0.id, $0) })
        let acts = report.needs.flatMap { need in need.acts.map { ($0, need.connector.flatMap { ofStream[$0] }) } }
            + report.connectors.flatMap { connector in connector.health.acts.map { ($0, Optional(connector)) } }
        let taken = Set(acts.filter { $0.0.taken(by: unit, on: $0.1) }.map(\.0.do))
        XCTAssertEqual(taken, Set(acts.map(\.0.do)).intersection([.try, .skip, .read, .ignore, .open, .grant, .signin, .set, .import, .letGo]),
                       "the door's acts, a page, a sign-in, the form's Set, an import kind's window and this phone's grant")
        XCTAssertTrue(taken.isSuperset(of: [.grant, .signin, .set]), "this phone's grant, a sign-in and WHOOP's password")
        XCTAssertFalse(acts.contains { [.pair, .turn].contains($0.0.do) && $0.0.taken(by: unit, on: $0.1) }, "a Mac's pairing, turning on")
        let set = try XCTUnwrap(acts.first { $0.0.do == .set }?.0)
        XCTAssertFalse(set.taken(by: unit), "a Set with no stream to hold its form")
        let grant = try XCTUnwrap(report.needs.first { $0.unit == unit && $0.reason == .grant })
        XCTAssertEqual(grant.acts.filter { $0.taken(by: "iphone-12-cc03") }, [], "another phone's grant is not its to take")
    }

    private func answer() throws -> StreamsAnswer {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "connectors.report", withExtension: "json", subdirectory: "pages/canned"),
                                "the app carries the home's answer to this phone")
        return try JSONDecoder().decode(StreamsAnswer.self, from: Data(contentsOf: url))
    }

    func testADialogDrawsEveryNeedOfItsStreamButTheOneItsHealthSays() throws {
        let answer = try answer()
        let report = answer.report
        for connector in report.connectors {
            let drawn = answer.callout(of: connector.id)
            let ofIt = report.needs.filter { $0.heldBack.contains(connector.id) }
            for need in ofIt where !drawn.contains(need) {
                XCTAssertEqual(need.words, connector.health.words, "\(connector.id): \(need.id) is its health's, drawn as it")
                XCTAssertEqual(need.acts, connector.health.acts, "\(connector.id): \(need.id)'s acts are its health's")
            }
        }
        let takeout = try XCTUnwrap(report.connectors.first { $0.id == "google-takeout" })
        XCTAssertEqual(takeout.health.state, .paused)
        XCTAssertEqual(answer.callout(of: takeout.id).map(\.id), report.needs.filter { $0.connector == "google-takeout" }.map(\.id))
        XCTAssertTrue(answer.callout(of: takeout.id).contains { $0.acts.contains { $0.do == .skip } }, "Skip it, within reach")
        let claude = try XCTUnwrap(report.connectors.first { $0.id == "claude" })
        XCTAssertEqual(answer.callout(of: claude.id), [])
        let photos = try XCTUnwrap(report.connectors.first { $0.id == "apple-photos" })
        XCTAssertTrue(answer.callout(of: photos.id).contains { $0.unit == unit && $0.reason == .grant })
        XCTAssertEqual(photos.health.state, .ok)
    }

    @MainActor
    func testAFullPhoneSaysSoItselfUntilTheHomesNeedForItIsListed() throws {
        let line = try XCTUnwrap(PhoneNeeds.room(.full, listed: [], unit: unit, name: "iPhone 17 Pro"))
        XCTAssertEqual(line.title, "iPhone 17 Pro's disk is full")
        XCTAssertEqual(line.line, "Location and Health aren't saved · free some space on it")
        XCTAssertEqual(line.weight, .stopped, "nothing is kept while it is full")
        XCTAssertNil(PhoneNeeds.room(.low, listed: [], unit: unit, name: "iPhone 17 Pro"), "low is the home's to say")
        XCTAssertNil(PhoneNeeds.room(.ok, listed: [], unit: unit, name: "iPhone 17 Pro"))
        XCTAssertNotNil(PhoneNeeds.room(.full, listed: [], unit: nil, name: "iPhone"), "unpaired, the phone alone can say it")
        for dismissed in [false, true] {
            let need = #"{"id":"room:\#(unit)","state":"broken","reason":null,"words":"iPhone 17 Pro's disk is full","since_ms":null,"next_ms":null,"acts":[],"detail":null,"line":"Location and Health aren't saved · free some space on it","connector":null,"copy":null,"unit":"\#(unit)","at":null,"weight":"stopped","banner":false,"dismissed":\#(dismissed),"kind":"notice","about":null}"#
            let listed = try JSONDecoder().decode(HomeLink.Need.self, from: Data(need.utf8))
            XCTAssertNil(PhoneNeeds.room(.full, listed: [listed], unit: unit, name: "iPhone 17 Pro"), "one disk, one line")
        }
        let another = #"{"id":"room:iphone-12-aa02","state":"broken","reason":null,"words":"iPhone 12's disk is full","since_ms":null,"next_ms":null,"acts":[],"detail":null,"connector":null,"copy":null,"unit":"iphone-12-aa02","at":null,"weight":"stopped","banner":false,"dismissed":false,"kind":"notice","about":null}"#
        XCTAssertNotNil(PhoneNeeds.room(.full, listed: [try JSONDecoder().decode(HomeLink.Need.self, from: Data(another.utf8))],
                                        unit: unit, name: "iPhone 17 Pro"), "another phone's need is not this one's")
    }

    @MainActor
    func testEachMemberIsARowOfItsPanelsPartDrawnByTheReportsControl() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "proof-report", withExtension: "json"), "the app carries the proof fixture")
        let proof = try JSONDecoder().decode(HomeLink.StreamsReport.self, from: Data(contentsOf: url))
        let drawn: [HomeLink.Connector.Member.Control: StreamMemberRow.Drawn] = [
            .menu: .menu, .zone: .zone, .toggle: .toggle, .stepper: .stepper, .list: .list, .text: .typed, .email: .typed,
            .date: .date, .secret: .secret,
        ]
        let panels: [String: Set<HomeLink.Connector.Panel>] = ["settings": [.account, .settings, .groups], "history": [.backfill]]
        let parts: [StreamRows: String] = [.form: "settings", .settings: "settings", .groups: "settings", .backfill: "history"]
        var controls = Set<HomeLink.Connector.Member.Control>()
        var refreshes = 0
        var routed = 0
        for connector in proof.connectors where connector.shown == .stream {
            let rows = Dictionary(grouping: StreamRows.allCases) { parts[$0]! }.mapValues { $0.flatMap { $0.members(connector).map(\.key) } }
            for member in connector.members {
                let at = "\(connector.id).\(member.key)"
                let sets = connector.routes.contains { $0.sets.contains(member.key) }
                if sets { routed += 1 }
                let owed = sets ? nil : panels.first { $0.value.contains(member.panel ?? .comesFrom) }?.key
                let on = rows.filter { $0.value.contains(member.key) }.map(\.key)
                XCTAssertEqual(on, owed.map { [$0] } ?? [], "\(at) on \(member.panel.map { "\($0)" } ?? "no panel")")
                guard owed != nil, let control = member.control else { continue }
                controls.insert(control)
                if control == .path {
                    let place = try XCTUnwrap(member.where, "\(at): a path is chosen on one Mac")
                    XCTAssertEqual(StreamMemberRow.drawn(member), .said(note: "Choose it on \(place.name)."), "\(at): no control, where it is chosen")
                } else {
                    XCTAssertEqual(StreamMemberRow.drawn(member), drawn[control], "\(at): its \(control)")
                }
            }
            if let refresh = connector.refreshNow {
                refreshes += 1
                XCTAssertTrue(StreamSettings.stands(connector), "\(connector.id): Refresh now stands in Settings")
                if let blocked = refresh.blocked {
                    XCTAssertEqual(StreamRefreshRow.line(refresh), blocked.words, "\(connector.id): blocked in the home's words")
                }
            }
        }
        XCTAssertEqual(controls, Set(HomeLink.Connector.Member.Control.allCases).subtracting([.email, .secret]),
                       "the proof connectors draw every control on the page but a sign-in route's own (an email, a secret)")
        XCTAssertGreaterThan(refreshes, 0, "a proof connector offers Refresh now")
        XCTAssertGreaterThan(routed, 0, "a proof connector's sign-in sets a member")
    }

    @MainActor
    func testTheWholeAndItsPastPauseApart() throws {
        let takeout = try XCTUnwrap(try report().connectors.first { $0.id == "google-takeout" })
        XCTAssertNotNil(takeout.paused(.all), "the report draws Google activity paused whole")
        XCTAssertEqual(StreamFoot.change(takeout), .resume, "Resume on its foot")
        XCTAssertTrue(StreamFoot.shown(takeout), "a pause of it all keeps its foot")
        XCTAssertFalse(StreamCallout.says(takeout), "its Resume says it: no Paused above")
        XCTAssertNil(StreamFoot.historyChange(takeout), "no pause of its past offered while the whole is paused")

        let running = try whatsapp(paused: [])
        XCTAssertEqual(StreamFoot.change(running), .pause)
        XCTAssertEqual(StreamFoot.historyChange(running), .pauseHistory, "its past's own pause, a row of the acts card")
        let past = try whatsapp(paused: ["history"])
        XCTAssertEqual(StreamFoot.change(past), .pause, "the whole stream still runs")
        XCTAssertEqual(StreamFoot.historyChange(past), .resumeHistory)
        let both = try whatsapp(paused: ["all", "history"])
        XCTAssertEqual(StreamFoot.change(both), .resume)
        XCTAssertEqual(StreamFoot.historyChange(both), .resumeHistory, "its past's pause stands under the whole's")
        let whole = try whatsapp(paused: ["all"])
        XCTAssertEqual(StreamFoot.change(whole), .resume)
        XCTAssertNil(StreamFoot.historyChange(whole), "no Pause history while the whole is paused")
    }

    private func whatsapp(paused scopes: [String]) throws -> HomeLink.Connector {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "report", withExtension: "json"))
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        var connectors = try XCTUnwrap(object["connectors"] as? [[String: Any]])
        let at = try XCTUnwrap(connectors.firstIndex { $0["id"] as? String == "whatsapp" })
        connectors[at]["pauses"] = scopes.map { ["scope": $0, "by": "person", "reason": "paused here", "at_ms": 0] as [String: Any] }
        object["connectors"] = connectors
        let report = try JSONDecoder().decode(HomeLink.StreamsReport.self, from: JSONSerialization.data(withJSONObject: object))
        return try XCTUnwrap(report.connectors.first { $0.id == "whatsapp" })
    }

    @MainActor
    func testDataBackfillSaysTheHomesLineWithTheMembersTheReportPutsThere() throws {
        let report = try report()
        let streams = report.connectors.filter {
            $0.shown == .stream && $0.history != nil && $0.health.state != .setup && !$0.roads.contains(.phone)
        }
        XCTAssertFalse(streams.isEmpty, "the report gives a stream a history")
        for stream in streams {
            XCTAssertTrue(StreamHistory.stands(stream), "\(stream.id): its History")
            let words = StreamHistoryRow.words(stream)
            XCTAssertEqual([words.label, words.meta].compactMap { $0 }.joined(separator: " · "), stream.history?.words, "\(stream.id): the home's line")
            let backfill = StreamRows.backfill.members(stream)
            XCTAssertEqual(backfill.map(\.key), stream.members.filter { $0.panel == .backfill }.map(\.key), "\(stream.id): Backfill's rows")
            XCTAssertTrue(backfill.allSatisfy { StreamMemberRow.drawn($0) == ($0.kind == "start" ? .date : .menu) },
                          "\(stream.id): its start a day, every other a menu")
        }
        let chatgpt = try XCTUnwrap(report.connectors.first { $0.id == "chatgpt" })
        XCTAssertEqual(StreamRows.backfill.members(chatgpt).map(\.key), ["start", "pace"], "the fixture puts Starts from and Pace on ChatGPT's Backfill")
        let calendar = try XCTUnwrap(report.connectors.first { $0.id == "google-calendar" })
        XCTAssertEqual(StreamRows.backfill.members(calendar).map(\.key), ["start"], "Calendar's Pace stands where the report puts it, never on Backfill")
        let lead = try XCTUnwrap(chatgpt.lead, "ChatGPT's past arrives")
        XCTAssertEqual(StreamRow.line(chatgpt), "\(lead) · \(chatgpt.line)", "the home's lead before its line")
    }

    @MainActor
    func testTheEntrySheetShowsTheHomesLineAndCopiesIt() throws {
        let adding = try report().adding
        XCTAssertTrue(adding.prompt.contains(adding.blank), "the fixture's prompt holds its blank")
        let searched = AddingSheet.line(adding, query: "  Obsidian ")
        XCTAssertEqual(searched, adding.prompt.replacingOccurrences(of: adding.blank, with: "Obsidian"))
        XCTAssertFalse(searched.contains(adding.blank), "no blank's mark left with a search")
        XCTAssertTrue(searched.contains("add a connector for Obsidian;"), searched)
        XCTAssertEqual(AddingSheet.line(adding, query: "   "), adding.prompt, "no search: the home's line, its blank to fill")
        let board = try XCTUnwrap(UIPasteboard(name: UIPasteboard.Name("lifestream.tests.\(UUID().uuidString)"), create: true))
        defer { UIPasteboard.remove(withName: board.name) }
        AddingSheet.copy(searched, to: board)
        XCTAssertEqual(board.string, searched, "Copy puts the line on the clipboard")
    }

    func testOneListByKindSetUpFirstImportsLastAndAStreamAnImportBringsOpensItsWindow() throws {
        let report = try report()
        let photos = StreamsWords.Kind(key: "photos", name: "Photos", icon: nil)
        let mail = StreamsWords.Kind(key: "mail", name: "Mail", icon: nil)
        let places = StreamsWords.Kind(key: "places", name: "Places", icon: nil)
        let row = { (sheet: StreamSheet, kind: StreamsWords.Kind?, opens: String?, state: HomeLink.State, starter: Bool) in
            StreamRow(sheet: sheet, name: "\(sheet)", icon: .file, place: nil, kind: kind, gives: nil, state: state, line: "",
                      identifier: "\(sheet)", opensImport: opens, starter: starter)
        }
        let rows = [row(.home("gmail"), mail, nil, .setup, false), row(.phone(.location), places, nil, .ok, true),
                    row(.home("google-photos"), photos, "google-takeout", .setup, false), row(.home("outlook"), mail, nil, .ok, false)]
        let sections = StreamRow.sections(rows, imports: report.imports, fresh: false)
        XCTAssertEqual(sections.map(\.label), ["Mail", "Places", "Photos", "Imports"], "one list by kind, a phone's stream in its kind, imports last")
        XCTAssertEqual(sections[0].rows.map(\.id), [.home("outlook"), .home("gmail")], "what is set up leads its kind")
        XCTAssertEqual(sections[3].imports.map(\.kind), report.imports.map(\.kind), "the kinds' rows in Imports")
        XCTAssertEqual(StreamRow.sections([rows[1]], imports: report.imports, fresh: false).map(\.label), ["Places", "Imports"],
                       "Imports stands with no stream in it")
        XCTAssertEqual(StreamRow.sections(rows, fresh: true).map(\.label), [StreamsWords.start, "Mail", "Photos"],
                       "a new home starts with the home's starters, the rest by kind")
        XCTAssertEqual(rows[2].opens, .importKind("google-takeout"), "an import alone brings it: the kind's window")
        XCTAssertEqual(rows[0].opens, .home("gmail"))
    }

    func testARowSaysWhereItIsReadInItsLineAndEndsInItsStateOrItsLastTime() {
        let row = { (state: HomeLink.State, last: String?) in
            StreamRow(sheet: .phone(.location), name: "Location", icon: .places, place: .phone, kind: nil, gives: nil, state: state,
                      line: "Where you go, point by point.", identifier: "location", last: last)
        }
        XCTAssertNil(row(.setup, "09:41").end, "not set up: nothing at the end")
        XCTAssertEqual(row(.setup, nil).meta, "Where you go, point by point · iPhone", "where it is read after the line, its stop dropped")
        XCTAssertEqual(row(.ok, "09:41").meta, "Where you go, point by point · iPhone")
        XCTAssertEqual(row(.broken, "09:41").end, .state(.warning, "Stopped"))
        XCTAssertEqual(row(.needsYou, nil).end, .state(.caution, "Needs you"))
        XCTAssertEqual(row(.ok, "09:41").end, .time("09:41"), "fine: its last time")
        XCTAssertEqual(row(.syncing, "Sun").end, .time("Sun"), "catching up is fine")
        XCTAssertNil(row(.ok, nil).end)
    }

    func testConnectedWhenAnythingIsSetUpOrAnImportHoldsFilesElseNotConnectedUnlessChosen() throws {
        let report = try report()
        let row = { (state: HomeLink.State) in
            StreamRow(sheet: .phone(.location), name: "Location", icon: .places, place: .phone, kind: nil, gives: nil, state: state,
                      line: "", identifier: "location")
        }
        let idle = report.imports.filter { !$0.connected }
        XCTAssertEqual(ConnectorsShown.of(nil, rows: [row(.setup)], imports: idle), .not, "nothing set up: Not connected")
        XCTAssertEqual(ConnectorsShown.of(nil, rows: [row(.setup), row(.ok)], imports: idle), .connected)
        XCTAssertEqual(ConnectorsShown.of(.not, rows: [row(.ok)], imports: idle), .not, "the person's pick stands")
        XCTAssertFalse(row(.setup).connected)
        XCTAssertTrue(row(.needsYou).connected)
    }

    func testDisconnectSaysWhatStopsInTheStreamsOwnNouns() throws {
        let whatsapp = try XCTUnwrap(try report().connectors.first { $0.id == "whatsapp" })
        XCTAssertEqual(ConnectorWords.disconnectTitle(whatsapp.name), "Disconnect \(whatsapp.name)?")
        XCTAssertEqual(ConnectorWords.disconnectBody(whatsapp),
                       "Lifestream will stop getting new messages. Messages already in Lifestream won’t be deleted.")
        XCTAssertTrue(ConnectorWords.disconnectBody(nil).hasPrefix("Lifestream will stop getting new items."), "no stream: items")
    }

    func testAStreamAnExportFeedsDrawsItsImport() throws {
        let report = try report()
        let fed = try XCTUnwrap(report.connectors.first { $0.export?.import == "spotify" }, "a stream an export feeds")
        XCTAssertTrue(StreamSheet.home(fed.id).draws(import: "spotify", in: report))
        XCTAssertFalse(StreamSheet.home(fed.id).draws(import: "google-takeout", in: report))
        XCTAssertTrue(StreamSheet.importKind("spotify").draws(import: "spotify", in: report))
        let takeout = try XCTUnwrap(report.imports.first { $0.kind == "google-takeout" })
        XCTAssertTrue(takeout.underWay, "files coming and an import being brought in: read again")
        let spotify = try XCTUnwrap(report.imports.first { $0.kind == "spotify" })
        XCTAssertFalse(spotify.underWay, "nothing held, nothing coming")
    }

    func testAKindsWindowSaysWhatItReadsInTheReportsWords() throws {
        let report = try report()
        let takeout = try XCTUnwrap(report.imports.first { $0.kind == "google-takeout" })
        XCTAssertFalse(takeout.products.isEmpty)
        XCTAssertEqual(ImportWords.reads(takeout), takeout.products.map(\.name).joined(separator: " · "))
        let spotify = try XCTUnwrap(report.imports.first { $0.kind == "spotify" })
        XCTAssertTrue(spotify.products.isEmpty)
        XCTAssertEqual(ImportWords.reads(spotify), try XCTUnwrap(spotify.reads))
    }

    func testThePhonePressesTheHomesImportActsAndKeepsTheQuestion() throws {
        let report = try report()
        let kept = report.imports.flatMap(\.held).flatMap(\.files).filter { $0.state == "kept" }
        XCTAssertFalse(kept.isEmpty, "the fixture keeps a file")
        for file in kept {
            let letGo = try XCTUnwrap(file.acts.first, "\(file.name): Let go")
            XCTAssertEqual(letGo.do, .letGo)
            XCTAssertTrue(letGo.taken(by: unit), "Let go is pressed on any device")
            XCTAssertEqual(letGo.need, "import:\(try XCTUnwrap(report.imports.flatMap(\.held).first { $0.files.contains(file) }).id):file:\(file.id)")
        }
        let window = #"{"do":"import","label":"Choose","kind":"spotify"}"#
        let act = try JSONDecoder().decode(HomeLink.Act.self, from: Data(window.utf8))
        XCTAssertEqual(act.kind, "spotify")
        XCTAssertTrue(act.taken(by: unit) && act.opensPage, "the window opens from the need's row")
        let asked = #"""
        {"id":"c0ffee0000000001","account":null,"made_at":"2026-11-01T08:00:00.000Z","name":"1 Nov 2026",
         "health":{"state":"needs-you","reason":"choose","words":"Whose Spotify is this?","since_ms":null,"next_ms":null,
                   "acts":[{"do":"import","label":"Choose","kind":"spotify"}],"detail":null,"line":"Your Spotify export"},
         "line":"Whose Spotify is this?",
         "ask":{"words":"Whose Spotify is this?","choices":["person-a","person-b"],"other":true,"choose":"Choose","another":"Another…"},
         "files":[{"id":"f1","name":"my_spotify_data.zip","bytes":41000000,"state":"held","words":"In your home","line":"41 MB",
                   "acts":[{"do":"let-go","label":"Let go","need":"import:c0ffee0000000001:file:f1"}]}],
         "products":[{"id":"spotify","name":"Spotify","state":"asked","count":0,"line":"Spotify"}],
         "span":null,"open_day":null,"open":null,"downloaded":null,"notice":null}
        """#
        let held = try JSONDecoder().decode(HomeLink.Import.Held.self, from: Data(asked.utf8))
        let ask = try XCTUnwrap(held.ask)
        XCTAssertEqual(ask.choices, ["person-a", "person-b"])
        XCTAssertTrue(ask.other)
        XCTAssertEqual([ask.choose, ask.another], ["Choose", "Another…"], "its buttons in the home's words")
        XCTAssertEqual(ImportWords.whose(held.id), "import:c0ffee0000000001:whose", "answered under its question's need")
        let provisional = try XCTUnwrap(held.files.first?.acts.first, "a file of an import asked whose: Let go")
        XCTAssertEqual(provisional.do, .letGo)
        XCTAssertTrue(provisional.taken(by: unit), "pressed here, through the act path")
        XCTAssertNil(held.notice, "asked: not in")
        let refused = #"""
        {"id":"c0ffee0000000002","account":"person-a","made_at":"2026-11-01T08:00:00.000Z","name":"1 Nov 2026 · person-a",
         "health":{"state":"needs-you","reason":"import","words":"Couldn't read this file","since_ms":null,"next_ms":null,
                   "acts":[{"do":"skip","label":"Skip it","need":"import:c0ffee0000000002:refused"}],"detail":null,"line":"Your Spotify export"},
         "line":"Couldn't read this file","ask":null,"files":[],"products":[],"span":null,"open_day":null,"open":null,
         "downloaded":null,"notice":null}
        """#
        let whole = try JSONDecoder().decode(HomeLink.Import.Held.self, from: Data(refused.utf8))
        XCTAssertEqual(whole.health.reason, .import)
        let skip = try XCTUnwrap(whole.health.acts.first)
        XCTAssertEqual(skip.do, .skip)
        XCTAssertTrue(skip.taken(by: unit) && skip.do != .import, "Skip it drawn with the import's health and pressed here")
    }

    func testTheWindowDrawsTheHomesWordsAsSent() throws {
        let report = try report()
        let spotify = try XCTUnwrap(report.imports.first { $0.kind == "spotify" })
        XCTAssertEqual([spotify.titles.reads, spotify.titles.guide, spotify.titles.held],
                       ["What it brings", "How to get it", "Your imports"])
        XCTAssertEqual(spotify.drop.away, "On your Mac")
        let held = report.imports.flatMap(\.held)
        for one in held where one.open != nil || one.downloaded != nil {
            XCTAssertNotNil(one.notice, "\(one.name): Open and the files downloaded stand only once In, which is the notice")
        }
        let into = try XCTUnwrap(spotify.held.first { $0.notice != nil }, "the fixture holds an import in")
        XCTAssertNotNil(into.downloaded)
        XCTAssertNotNil(into.openDay)
        let product = try XCTUnwrap(into.products.first)
        XCTAssertTrue(product.line.hasPrefix(product.name), "the home's line begins with the name")
        let meta = try XCTUnwrap(ImportWords.meta(product))
        XCTAssertFalse(meta.hasPrefix(product.name), "said once: \(meta)")
        XCTAssertEqual(product.name + " · " + meta, product.line)
        let asked = try XCTUnwrap(spotify.held.first { $0.ask != nil })
        XCTAssertNil(ImportWords.meta(try XCTUnwrap(asked.products.first)), "a line that is the name alone: no line")
    }
}

private final class SettingsDoor: HomeTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var paired = false
    private var status: Int? = 200

    var answer: Int? {
        get { lock.withLock { status } }
        set { lock.withLock { status = newValue } }
    }

    func perform(_ request: HomeRequest) async throws -> HomeResponse {
        let first = lock.withLock { () -> Bool in
            defer { paired = true }
            return !paired
        }
        if first {
            let answer = #"{"home":{"id":"h-0001","version":"0.2.0","floors":{"mac":"0.1.0","phone":"1.0.0","extension":"0.1.0"}},"#
                + #""pass":"p-0000aa00","unit":"iphone-aa00","sources":{},"owner":[],"needs":[],"calls":[],"settings":{},"#
                + #""turn":{"run":"0000000000000001","n":1}}"#
            return HomeResponse(status: 200, body: Data(#"{"unit":"iphone-aa00","answer":\#(answer)}"#.utf8))
        }
        guard let status = answer else { throw URLError(.cannotConnectToHost) }
        return HomeResponse(status: status, body: Data(#"{"code":"VALUE_BAD","message":"That isn't a value of it."}"#.utf8))
    }
}
