import Foundation
import XCTest
@testable import HomeLink

final class PagesTests: XCTestCase {
    private static let tests = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    static let fixtures = tests.appendingPathComponent("Fixtures/pages")
    static let contract = tests.deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("packages/home/contract/pages.json")

    static let decoders: [String: (Data) throws -> Void] = [
        "people": { _ = try JSONDecoder().decode(HomeLink.Pages.People.self, from: $0) },
        "person": { _ = try JSONDecoder().decode(HomeLink.Pages.Person.self, from: $0) },
        "group": { _ = try JSONDecoder().decode(HomeLink.Pages.Group.self, from: $0) },
        "peopleFind": { _ = try JSONDecoder().decode(HomeLink.Pages.PeopleFind.self, from: $0) },
        "connectors": { _ = try JSONDecoder().decode(HomeLink.Pages.Connectors.self, from: $0) },
        "agentsWaiting": { _ = try JSONDecoder().decode(HomeLink.Pages.AgentsWaiting.self, from: $0) },
        "agentGuides": { _ = try JSONDecoder().decode(HomeLink.Pages.AgentGuides.self, from: $0) },
        "search": { _ = try JSONDecoder().decode(HomeLink.Pages.Search.self, from: $0) },
        "searchKind": { _ = try JSONDecoder().decode(HomeLink.Pages.SearchKind.self, from: $0) },
        "places": { _ = try JSONDecoder().decode(HomeLink.Pages.Places.self, from: $0) },
        "place": { _ = try JSONDecoder().decode(HomeLink.Pages.Place.self, from: $0) },
        "placeEdit": { _ = try JSONDecoder().decode(HomeLink.Pages.PlaceEdit.self, from: $0) },
        "year": { _ = try JSONDecoder().decode(HomeLink.Pages.Year.self, from: $0) },
        "days": { _ = try JSONDecoder().decode(HomeLink.Pages.Days.self, from: $0) },
        "day": { _ = try JSONDecoder().decode(HomeLink.Pages.Day.self, from: $0) },
        "thread": { _ = try JSONDecoder().decode(HomeLink.Pages.Thread.self, from: $0) },
        "moment": { _ = try JSONDecoder().decode(HomeLink.Pages.Moment.self, from: $0) },
        "feedback": { _ = try JSONDecoder().decode(HomeLink.Pages.Feedback.self, from: $0) },
        "settings": { _ = try JSONDecoder().decode(HomeLink.Pages.Settings.self, from: $0) },
        "settingsPage": { _ = try JSONDecoder().decode(HomeLink.Pages.SettingsPage.self, from: $0) },
        "storage": { _ = try JSONDecoder().decode(HomeLink.Pages.Storage.self, from: $0) },
        "modelDefaults": { _ = try JSONDecoder().decode(HomeLink.Pages.ModelDefaults.self, from: $0) },
        "modelProviders": { _ = try JSONDecoder().decode(HomeLink.Pages.ModelProviders.self, from: $0) },
        "modelsFind": { _ = try JSONDecoder().decode(HomeLink.Pages.ModelsFind.self, from: $0) },
    ]

    static let folders = [fixtures, fixtures.appendingPathComponent("canned")]

    static func fixtureFiles() throws -> [URL] {
        try folders.flatMap { folder -> [URL] in
            guard FileManager.default.fileExists(atPath: folder.path) else { return [] }
            return try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
                .filter { $0.pathExtension == "json" }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
        }
    }

    private static func json(_ text: String) -> Data { Data(text.utf8) }

    private static let row = """
    {"id": "person:0001", "name": "Person A", "named": true, "face": false, "photo": null, "when": {"kind": "month", "month": "2026-10"}, "line": null, "find": ["person a"]}
    """

    func testADecoderForEveryPageOfTheContract() throws {
        let file = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.contract)) as? [String: Any])
        let pages = try XCTUnwrap(file["pages"] as? [String: Any])
        XCTAssertEqual(Set(Self.decoders.keys), Set(pages.keys))
    }

    func testEveryFixtureOfTheHomeDecodes() throws {
        let files = try Self.fixtureFiles()
        XCTAssertTrue(files.contains { $0.deletingLastPathComponent().lastPathComponent == "canned" }, "the canned home's answers are among the fixtures")
        for file in files {
            let name = file.lastPathComponent
            let parts = name.split(separator: ".")
            XCTAssertEqual(parts.count, 3, "\(name) is named <page>.<case>.json")
            guard parts.count == 3 else { continue }
            let decode = try XCTUnwrap(Self.decoders[String(parts[0])], "\(name) names no page of the contract")
            XCTAssertNoThrow(try decode(Data(contentsOf: file)), name)
        }
    }

    func testTheAskingFixturesDecodeTheirIsThisHome() throws {
        let places = try JSONDecoder().decode(HomeLink.Pages.Places.self,
            from: Data(contentsOf: Self.fixtures.appendingPathComponent("places.asking.json")))
        let spot = try XCTUnwrap(places.toName.compactMap(\.ask).first, "places.asking holds a spot to name that asks")
        XCTAssertTrue(spot.line.hasPrefix("You've slept here"), spot.line)
        guard case .day = spot.since else { return XCTFail("a spot's first night is a day: \(spot.since)") }
        let place = try JSONDecoder().decode(HomeLink.Pages.Place.self,
            from: Data(contentsOf: Self.fixtures.appendingPathComponent("place.asking.json")))
        let home = try XCTUnwrap(place.askHome, "place.asking holds a place that asks")
        XCTAssertTrue(home.line.hasPrefix("You've slept here"), home.line)
        guard case .day = home.since else { return XCTFail("a place's first night is a day: \(home.since)") }
    }

    func testAWholeAnswerDecodes() throws {
        let answer = try JSONDecoder().decode(HomeLink.Pages.PeopleFind.self, from: Self.json("""
        {"position": "12:1763700000000", "today": "2026-11-21", "rows": [\(Self.row),
         {"id": "person:0002", "name": "Person B", "named": false, "face": true, "photo": "photo-0002", "when": null, "line": "Contact card", "find": []}], "profiles": []}
        """))
        XCTAssertEqual(answer.rows.map(\.id), ["person:0001", "person:0002"])
        XCTAssertEqual(answer.rows.map(\.when), [.month(month: "2026-10"), nil])
        XCTAssertEqual(answer.rows.map(\.line), [nil, "Contact card"])
    }

    func testAWhenDecodesByItsTagAndAnUnknownTagAsUnknown() throws {
        let whens = try JSONDecoder().decode([HomeLink.Pages.When].self, from: Self.json("""
        [{"kind": "day", "day": "2026-11-21"}, {"kind": "month", "month": "2026-11"}, {"kind": "at", "at_ms": 1763700000000},
         {"kind": "week", "week": "2026-W47"}]
        """))
        XCTAssertEqual(whens, [.day(day: "2026-11-21"), .month(month: "2026-11"), .at(atMs: 1_763_700_000_000), .unknown])
    }

    func testAnUnknownChipDecodesAsUnknown() throws {
        let chips = try JSONDecoder().decode([HomeLink.Pages.Person.Head.Chip].self, from: Self.json("""
        [{"kind": "birthday", "month": 3, "day": 14}, {"kind": "zodiac", "sign": "pisces"}]
        """))
        XCTAssertEqual(chips.last, .unknown)
        XCTAssertEqual(chips.count, 2)
    }

    func testASettingsEndOfAKindItDoesNotKnowDecodesAsUnknown() throws {
        let rows = try JSONDecoder().decode([HomeLink.Pages.SettingsRow].self, from: Self.json("""
        [{"id": "zone", "label": "Time zone", "line": null, "end": {"kind": "value", "value": [{"kind": "words", "words": "UTC"}], "signal": null}},
         {"id": "model-cap", "label": "Model calls at once", "line": null, "end": {"kind": "choice", "key": "model.cap",
          "choices": [{"words": "8", "value": 8, "chosen": true, "default": true}]}},
         {"id": "later", "label": "A later control", "line": "Its line", "end": {"kind": "slider", "key": "later.key", "from": 1, "to": 9}}]
        """))
        XCTAssertEqual(rows.map(\.id), ["zone", "model-cap", "later"])
        guard case .choice(let key, let choices)? = rows[1].end else { return XCTFail("\(String(describing: rows[1].end))") }
        XCTAssertEqual([key, choices.first?.words], ["model.cap", "8"])
        XCTAssertEqual(rows[2].end, .unknown)
        XCTAssertEqual(rows[2].line, "Its line")
    }

    func testAnUnknownEnumValueDecodesAsUnknown() throws {
        let entities = try JSONDecoder().decode([HomeLink.Pages.Entity].self, from: Self.json(#"["person", "robot", "bot"]"#))
        XCTAssertEqual(entities, [.person, .unknown, .bot])
    }

    func testAMissingNullableMemberIsRefused() {
        let missing = Self.row.replacingOccurrences(of: #""photo": null, "#, with: "")
        XCTAssertThrowsError(try JSONDecoder().decode(HomeLink.Pages.Row.self, from: Self.json(missing))) { error in
            guard case DecodingError.keyNotFound(let key, _) = error else { return XCTFail("\(error)") }
            XCTAssertEqual(key.stringValue, "photo")
        }
    }

    func testAWhenThatIsANumberIsRefused() {
        let zero = Self.row.replacingOccurrences(of: #"{"kind": "month", "month": "2026-10"}"#, with: "0")
        XCTAssertNotEqual(zero, Self.row)
        XCTAssertThrowsError(try JSONDecoder().decode(HomeLink.Pages.Row.self, from: Self.json(zero))) { error in
            guard case DecodingError.typeMismatch = error else { return XCTFail("\(error)") }
        }
    }

    func testAWhenWithoutItsTagIsRefused() {
        XCTAssertThrowsError(try JSONDecoder().decode(HomeLink.Pages.When.self, from: Self.json(#"{"day": "2026-11-21"}"#)))
    }

    func testTheGuidesKeepEachKeySeesStepsAccessBesideThePage() throws {
        let mac = try JSONDecoder().decode(HomeLink.AgentGuides.self, from: Data(contentsOf: Self.fixtures.appendingPathComponent("agentGuides.mac.json")))
        let phone = try JSONDecoder().decode(HomeLink.AgentGuides.self, from: Data(contentsOf: Self.fixtures.appendingPathComponent("agentGuides.phone.json")))
        XCTAssertEqual(mac.apps.map(\.app), [.claude, .chatgpt, .muse, .grokBot, .instinct, .another])
        XCTAssertEqual(phone.apps.map(\.app), mac.apps.map(\.app), "both devices list the same six apps in the home's order")
        XCTAssertEqual(Set(mac.sees.keys), [.grokBot, .instinct, .another], "every key app the Mac guides whole shows what it will see")
        XCTAssertEqual(Set(phone.sees.keys), [.instinct], "the phone guides only Instinct's key whole")
        let written = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.fixtures.appendingPathComponent("agentGuides.phone.json"))) as? [String: Any])
        let instinct = try XCTUnwrap((written["apps"] as? [[String: Any]])?.first { $0["app"] as? String == "instinct" })
        let step = try XCTUnwrap((instinct["steps"] as? [[String: Any]])?.first { $0["kind"] as? String == "sees" })
        let access = try JSONSerialization.data(withJSONObject: XCTUnwrap(step["access"]), options: [.sortedKeys, .withoutEscapingSlashes])
        XCTAssertEqual(try HomeLink.wire(XCTUnwrap(phone.sees[.instinct]).access), access, "the access goes back as the home wrote it")
        var without = written
        var apps = try XCTUnwrap(written["apps"] as? [[String: Any]])
        let at = try XCTUnwrap(apps.firstIndex { $0["app"] as? String == "instinct" })
        var steps = try XCTUnwrap(apps[at]["steps"] as? [[String: Any]])
        let sees = try XCTUnwrap(steps.firstIndex { $0["kind"] as? String == "sees" })
        steps[sees]["view"] = nil
        apps[at]["steps"] = steps
        without["apps"] = apps
        XCTAssertThrowsError(try JSONDecoder().decode(HomeLink.AgentGuides.self, from: JSONSerialization.data(withJSONObject: without)),
                             "a sees step without its view is no answer")
    }
}
