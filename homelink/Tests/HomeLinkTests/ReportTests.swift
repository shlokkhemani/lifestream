import Foundation
import XCTest
@testable import HomeLink

final class ReportTests: XCTestCase {
    static let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Fixtures/report.json")

    func testTheHomesReportReadsWholeAndExactly() throws {
        let bytes = try Data(contentsOf: Self.fixture)
        let report = try JSONDecoder().decode(HomeLink.StreamsReport.self, from: bytes)
        let written = try JSONSerialization.jsonObject(with: bytes)
        var drift: [String] = []
        Strict.walk(report, written, at: "report", drift: &drift)
        XCTAssertEqual(drift, [], "the report as HomeLink reads it is the report the home writes")

        XCTAssertEqual(Set(report.connectors.map(\.health.state)), Set(HomeLink.State.allCases), "every state, on a connector")
        XCTAssertTrue(report.needs.contains { $0.unit != nil && $0.connector != nil && $0.copy == nil }, "a device's unmet grant")
        XCTAssertTrue(report.devices.contains { $0.found?.isEmpty == false } && report.devices.contains { $0.kind == .phone }, "what a Mac finds, a phone")
        XCTAssertTrue(report.connectors.contains { $0.members.contains { $0.panel != nil && $0.only != nil } },
                      "a setting drawn that only some devices of its stream follow, and which")
        let takeout = try XCTUnwrap(report.imports.first { $0.root != nil })
        Self.assertTheImportShapes(report, takeout)
    }

    static func assertTheImportShapes(_ report: HomeLink.StreamsReport, _ takeout: HomeLink.Import,
                                      file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue([takeout.takes, takeout.drop.words, takeout.drop.line, takeout.line].allSatisfy { !$0.isEmpty },
                      "the kind's words", file: file, line: line)
        XCTAssertEqual(takeout.guide.compactMap(\.open).count, 1, "one step's button", file: file, line: line)
        XCTAssertFalse(takeout.products.isEmpty || takeout.recognise.isEmpty, "the products a reader reads, the patterns", file: file, line: line)
        XCTAssertTrue(takeout.coming.contains { $0.state == "sending" } && !takeout.held.isEmpty && takeout.held.allSatisfy { !$0.products.isEmpty },
                      "a file a Mac sends, an import held with its products", file: file, line: line)
        XCTAssertTrue(report.connectors.contains { $0.export?.import == takeout.kind && $0.export?.opens == true },
                      "a stream the kind alone brings, its Add more row opening the kind's window", file: file, line: line)
        XCTAssertTrue([takeout.titles.reads, takeout.titles.guide, takeout.titles.held, takeout.drop.choose, takeout.drop.away].allSatisfy { !$0.isEmpty },
                      "the window's words", file: file, line: line)
        let held = report.imports.flatMap(\.held)
        XCTAssertTrue(held.contains { $0.ask.map { !$0.choose.isEmpty && !$0.another.isEmpty } == true }, "a question's buttons", file: file, line: line)
        XCTAssertTrue(held.contains { $0.notice != nil && $0.open != nil && $0.downloaded != nil }, "an import in", file: file, line: line)
        XCTAssertTrue(held.contains { $0.notice == nil }, "an import not in", file: file, line: line)
    }

    func testAnImportIsInByItsNoticeAndItsWordsAreTheHomes() throws {
        let health = #"{"state":"ok","reason":null,"words":"","since_ms":null,"next_ms":null,"acts":[],"detail":null}"#
        let held = { (line: String, notice: String) in
            #"{"id":"a1","account":"person-a","made_at":"2026-11-01T00:00:00.000Z","name":"1 Nov 2026 · person-a","health":\#(health),"#
                + #""line":"\#(line)","ask":null,"files":[],"products":[],"span":null,"open_day":"2026-11-01","open":"Open a day","#
                + #""downloaded":"You can delete the files you downloaded.","notice":\#(notice)}"#
        }
        let decode = { (json: String) in try JSONDecoder().decode(HomeLink.Import.Held.self, from: Data(json.utf8)) }
        let inNow = try decode(held("Brought in, its words changed", #"{"title":"Your Spotify export is in","body":"48,112 plays"}"#))
        XCTAssertEqual(inNow.notice, HomeLink.Import.Held.Notice(title: "Your Spotify export is in", body: "48,112 plays"))
        XCTAssertEqual([inNow.open, inNow.downloaded], ["Open a day", "You can delete the files you downloaded."])
        XCTAssertNil(try decode(held("In · 48,112 plays", "null")).notice, "a line that reads In is not in: the notice says it")
        XCTAssertThrowsError(try decode(held("In", #"{"title":"Your Spotify export is in"}"#)), "a notice is its two strings")
    }

    func testAnActOfADoNotKnownIsLeftOutAndTheRestReads() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.fixture)) as? [String: Any])
        var connectors = try XCTUnwrap(object["connectors"] as? [[String: Any]])
        let index = try XCTUnwrap(connectors.firstIndex { (($0["health"] as? [String: Any])?["acts"] as? [Any])?.isEmpty == false })
        var health = try XCTUnwrap(connectors[index]["health"] as? [String: Any])
        let acts = try XCTUnwrap(health["acts"] as? [Any])
        health["acts"] = [["do": "later", "label": "Later…", "what": 1]] + acts
        connectors[index]["health"] = health
        object["connectors"] = connectors
        let report = try JSONDecoder().decode(HomeLink.StreamsReport.self, from: JSONSerialization.data(withJSONObject: object))
        let original = try JSONDecoder().decode(HomeLink.StreamsReport.self, from: Data(contentsOf: Self.fixture))
        XCTAssertEqual(report.connectors[index].health.acts, original.connectors[index].health.acts, "the act not known is left out, the rest kept in order")
        XCTAssertEqual(report.connectors.count, original.connectors.count)
    }

    func testAnActMissingWhatItsDoCarriesDoesNotRead() throws {
        for (act, lacks) in [(#"{"do":"try","label":"Try now"}"#, "need"), (#"{"do":"grant","label":"Allow","unit":"iphone-aa01"}"#, "grant"),
                             (#"{"do":"let-go","label":"Let go"}"#, "need"), (#"{"do":"import","label":"Choose"}"#, "kind"),
                             (#"{"do":"read","label":"Read it too","need":"offer:a"}"#, "of"), (#"{"do":"open","label":"Open"}"#, "url")] {
            XCTAssertThrowsError(try JSONDecoder().decode(HomeLink.Act.self, from: Data(act.utf8)), "an act with no \(lacks)")
        }
        let pair = try JSONDecoder().decode(HomeLink.Act.self, from: Data(#"{"do":"pair","label":"Pair"}"#.utf8))
        XCTAssertEqual([pair.need, pair.of, pair.unit, pair.url, pair.kind], [nil, nil, nil, nil, nil], "a host's own flow carries nothing")
        let choose = try JSONDecoder().decode(HomeLink.Act.self, from: Data(#"{"do":"import","label":"Choose","kind":"spotify"}"#.utf8))
        XCTAssertEqual([choose.kind, choose.need], ["spotify", nil], "the whose question's act opens the kind's window")
    }

    func testABrowserAccountIsReadByItsEmailOrItsNameAlone() throws {
        let read = { (json: String) in try JSONDecoder().decode(HomeLink.Connector.ChromeAccount.self, from: Data(json.utf8)) }
        let named = try read(#"{"name":"Person A","verdict":"offered"}"#)
        let mailed = try read(#"{"email":"person-a@example.com","verdict":"read"}"#)
        XCTAssertEqual([named.words, named.verdict, mailed.words, mailed.verdict], ["Person A", "offered", "person-a@example.com", "read"])
        XCTAssertEqual([named.email, mailed.name], [nil, nil])
        for json in [#"{"email":"person-a@example.com","name":"Person A","verdict":"read"}"#, #"{"verdict":"read"}"#] {
            XCTAssertThrowsError(try read(json), json)
        }
    }

    func testAMemberTheHomeDoesNotWriteIsDrift() throws {
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.fixture)) as? [String: Any])
        var connectors = try XCTUnwrap(object["connectors"] as? [[String: Any]])
        let index = try XCTUnwrap(connectors.firstIndex { ($0["copies"] as? [Any])?.isEmpty == false })
        connectors[index]["lead"] = nil
        connectors[index]["later"] = 1
        var copies = try XCTUnwrap(connectors[index]["copies"] as? [[String: Any]])
        copies[0]["unit"] = nil
        connectors[index]["copies"] = copies
        object["connectors"] = connectors
        let bytes = try JSONSerialization.data(withJSONObject: object)
        let report = try JSONDecoder().decode(HomeLink.StreamsReport.self, from: bytes)
        var drift: [String] = []
        Strict.walk(report, try JSONSerialization.jsonObject(with: bytes), at: "report", drift: &drift)
        XCTAssertEqual(drift, ["report.connectors[\(index)].lead: missing", "report.connectors[\(index)].copies[0].unit: missing",
                               "report.connectors[\(index)].later: unknown"])
    }
}

enum Strict {
    static let absent: [ObjectIdentifier: Set<String>] = [
        ObjectIdentifier(HomeLink.Act.self): ["need", "of", "ids", "member", "unit", "grant", "url", "kind", "text"],
        ObjectIdentifier(HomeLink.Connector.Member.self): ["min", "max", "secret", "held", "folder", "items", "add", "placeholder", "waiting", "only", "route", "menu"],
        ObjectIdentifier(HomeLink.Connector.Route.self): ["about"],
        ObjectIdentifier(HomeLink.Import.self): ["root", "lists", "which"],
        ObjectIdentifier(HomeLink.Import.Step.self): ["title", "open"],
        ObjectIdentifier(HomeLink.Health.self): ["line"],
        ObjectIdentifier(HomeLink.Need.self): ["line", "streams"],
        ObjectIdentifier(HomeLink.Connector.Processing.Privacy.self): ["found"],
        ObjectIdentifier(HomeLink.Connector.ChromeAccount.self): ["email", "name"],
    ]
    static let unread: [ObjectIdentifier: Set<String>] = [
        ObjectIdentifier(HomeLink.StreamsReport.HomeRow.self): ["settings"],
        ObjectIdentifier(HomeLink.StreamsReport.self): ["rows", "badge"],
        ObjectIdentifier(HomeLink.Connector.self): ["callout", "line_parts"],
    ]

    static func walk(_ value: Any, _ json: Any, at path: String, drift: inout [String]) {
        let mirror = Mirror(reflecting: value)
        switch mirror.displayStyle {
        case .optional:
            if let some = mirror.children.first?.value {
                walk(some, json, at: path, drift: &drift)
            } else if !(json is NSNull) {
                drift.append("\(path): read as nil")
            }
        case .struct:
            guard let object = json as? [String: Any] else { return drift.append("\(path): not an object") }
            let absent = Self.absent[ObjectIdentifier(type(of: value))] ?? []
            let members = mirror.children.compactMap { child in child.label.map { (snake($0), child.value) } }
            var read = Set<String>()
            for (key, member) in members {
                read.insert(key)
                if let written = object[key] {
                    walk(member, written, at: "\(path).\(key)", drift: &drift)
                } else if !(absent.contains(key) && isNil(member)) {
                    drift.append("\(path).\(key): missing")
                }
            }
            let unread = Self.unread[ObjectIdentifier(type(of: value))] ?? []
            for key in object.keys.sorted() where !read.contains(key) && !unread.contains(key) { drift.append("\(path).\(key): unknown") }
        case .collection:
            guard let array = json as? [Any] else { return drift.append("\(path): not a list") }
            let items = Array(mirror.children)
            guard items.count == array.count else { return drift.append("\(path): \(items.count) read of \(array.count)") }
            for (index, item) in items.enumerated() { walk(item.value, array[index], at: "\(path)[\(index)]", drift: &drift) }
        case .dictionary:
            if !(json is [String: Any]) { drift.append("\(path): not an object") }
        default:
            if !same(value, json) { drift.append("\(path): read \(value), written \(json)") }
        }
    }

    private static func isNil(_ value: Any) -> Bool {
        let mirror = Mirror(reflecting: value)
        return mirror.displayStyle == .optional && mirror.children.isEmpty
    }

    private static func same(_ value: Any, _ json: Any) -> Bool {
        switch value {
        case let value as String: return json as? String == value
        case let value as Bool: return (json as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue == value } ?? false
        case let value as Int: return (json as? NSNumber)?.int64Value == Int64(value)
        case let value as Int64: return (json as? NSNumber)?.int64Value == value
        case let value as Double: return (json as? NSNumber)?.doubleValue == value
        case let value as any RawRepresentable: return json as? String == value.rawValue as? String
        case let value as HomeLink.JSON:
            guard let bytes = try? JSONSerialization.data(withJSONObject: json, options: [.fragmentsAllowed]) else { return false }
            return (try? JSONDecoder().decode(HomeLink.JSON.self, from: bytes)) == value
        default: return false
        }
    }

    static func snake(_ label: String) -> String {
        label.reduce(into: "") { name, character in
            if character.isUppercase { name += "_" + character.lowercased() } else { name.append(character) }
        }
    }
}
