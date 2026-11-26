import Foundation
import XCTest
@testable import HomeLink

final class ReadsTests: XCTestCase {
    private var folder: URL!
    private let phone = HomeLink.Device(kind: .phone, version: "1.4.0", model: "iPhone", serial4: nil)
    private let home = "https://lifestream.example.ts.net"

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("homelink-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func paired(_ script: [ScriptedTransport.Step]) async throws -> (HomeLink, ScriptedTransport, String) {
        let credentials = MemoryCredentials()
        let pairing = ScriptedTransport([.reply(200, Fixture.paired())])
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: pairing)
            .pair(code: "12345678", name: home, account: Fixture.account)
        let pass = try XCTUnwrap(Fixture.object(pairing.requests[0])["pass"] as? String)
        let transport = ScriptedTransport(script)
        return (HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport), transport, pass)
    }


    func testEachReadAsksItsRouteWithThePassAndTheDevice() async throws {
        let instant = Date(timeIntervalSince1970: 1_792_000_000.5)
        let (link, transport, pass) = try await paired([
            .reply(200, Answers.days), .reply(200, Answers.day), .reply(200, Answers.whereAt), .reply(200, Answers.wherePieces),
            .reply(200, Answers.whereSummaries), .reply(200, Answers.search), .reply(200, Answers.count),
            .reply(200, Answers.people),
            .reply(200, Answers.person), .reply(200, Answers.connectors), .reply(200, Answers.status), .reply(200, Answers.extracts),
            .reply(200, Answers.extracts), .reply(200, Answers.record), .reply(200, Answers.devices), .reply(200, Answers.wanted),
            .reply(200, Answers.wanted), .reply(200, Answers.place), .reply(200, Answers.placePhotos), .reply(200, Answers.suggest),
            .reply(200, Answers.suggestTyped), .reply(200, Answers.sources),
        ])
        _ = try await link.days(from: "2026-10-01", to: "2026-10-14", after: "IjIwMjYtMTAtMDIi", limit: 30)
        _ = try await link.day("2026-10-14")
        _ = try await link.where(at: instant)
        _ = try await link.where(from: .day("2026-10-14"), to: .instant(instant))
        _ = try await link.where(from: .day("2026-01-01"), to: .day("2026-12-31"), grain: .month)
        _ = try await link.search(HomeLink.SearchQuery(query: "corner cafe", from: "2026-10-01", families: ["messages", "mail"],
                                                       person: ["person:person-a"], order: .newest, limit: 50,
                                                       lists: [.record], typing: true))
        _ = try await link.count(HomeLink.CountQuery(of: "calls", person: ["person:person-a"], from: "2026-10-16", to: "2026-11-14"))
        _ = try await link.people()
        _ = try await link.person(id: "person:person-a")
        _ = try await link.page(HomeLink.PageKey("/v1/connectors", link.unit.map { ["unit": $0] } ?? [:]), etag: nil)
        _ = try await link.status()
        _ = try await link.extracts(family: "health", unit: "sleep/whoop:person-a@example.com:cloud/41")
        _ = try await link.extracts(family: "health", day: "2026-10-14")
        _ = try await link.record(source: "whatsapp:15550000000:phone-aa01", kind: "msg", key: "m 1/2")
        _ = try await link.devices()
        let _: Wanted = try await link.photosWanted(source: "apple-photos:person-a@example.com:iphone-aa01")
        let _: Wanted = try await link.photosWanted(source: "apple-photos:person-a@example.com:iphone-aa01",
                                                    owed: ["A1B2C3D4-0000-4000-8000-000000000001/L0/001", "A1B2C3D4-0000-4000-8000-000000000002/L0/001"])
        _ = try await link.place(slug: "the-office")
        _ = try await link.placePhotos(slug: "the-office", after: "NjA=")
        _ = try await link.suggest(spot: "spot:37.3187,-122.009", q: "Kiln & Co")
        _ = try await link.suggest(spot: "spot:37.3187,-122.009", q: "")
        _ = try await link.sources()

        XCTAssertEqual(transport.requests.map(\.url.absoluteString).map { $0.replacingOccurrences(of: home, with: "") }, [
            "/v1/days?from=2026-10-01&to=2026-10-14&after=IjIwMjYtMTAtMDIi&limit=30",
            "/v1/days/2026-10-14",
            "/v1/where?at=1792000000500",
            "/v1/where?from=2026-10-14&to=1792000000500",
            "/v1/where?from=2026-01-01&to=2026-12-31&grain=month",
            "/v1/search?query=corner%20cafe&from=2026-10-01&families=messages&families=mail&person=person%3Aperson-a&order=newest&limit=50&lists=record&typing=1",
            "/v1/count?of=calls&person=person%3Aperson-a&from=2026-10-16&to=2026-11-14",
            "/v1/people",
            "/v1/people?id=person%3Aperson-a",
            "/v1/connectors?unit=macbook-pro-0001",
            "/v1/status",
            "/v1/extracts?family=health&unit=sleep%2Fwhoop%3Aperson-a%40example.com%3Acloud%2F41",
            "/v1/extracts?family=health&day=2026-10-14",
            "/v1/record?source=whatsapp%3A15550000000%3Aphone-aa01&kind=msg&key=m%201%2F2&text=1",
            "/v1/devices",
            "/v1/photos/wanted?source=apple-photos%3Aperson-a%40example.com%3Aiphone-aa01&files=1",
            "/v1/photos/wanted?source=apple-photos%3Aperson-a%40example.com%3Aiphone-aa01&files=1"
                + "&owed=A1B2C3D4-0000-4000-8000-000000000001%2FL0%2F001&owed=A1B2C3D4-0000-4000-8000-000000000002%2FL0%2F001",
            "/v1/places?slug=the-office",
            "/v1/places/photos?slug=the-office&after=NjA%3D",
            "/v1/places/suggest?spot=spot%3A37.3187%2C-122.009&q=Kiln%20%26%20Co",
            "/v1/places/suggest?spot=spot%3A37.3187%2C-122.009&q=",
            "/v1/sources",
        ])
        for request in transport.requests {
            XCTAssertEqual(request.method, "GET")
            XCTAssertEqual(request.headers["Authorization"], "Bearer \(pass)", request.url.path)
            XCTAssertEqual(request.headers["Lifestream-Device"], "phone/1.4.0", request.url.path)
            XCTAssertNil(request.headers["If-None-Match"], "asked with no tag: \(request.url.path)")
            XCTAssertEqual(request.body, .empty)
        }
    }

    func testHeldIsAskedFiveThousandAtATimeAndBelievesOnlyWhatWasAsked() async throws {
        let blobs = Set((0..<5_001).map { "sha256:" + String(format: "%064x", $0) })
        let ordered = blobs.sorted()
        let held = [ordered[0], ordered[5_000]]
        let stranger = "sha256:" + String(repeating: "f", count: 64)
        let (link, transport, pass) = try await paired([
            .reply(200, #"{"held":["\#(held[0])","\#(stranger)"]}"#), .reply(200, #"{"held":["\#(held[1])"]}"#),
            .reply(422, #"{"code":"BLOBS_TOO_MANY","message":"at most 5000"}"#),
        ])
        let answered = try await link.held(blobs: blobs)
        XCTAssertEqual(answered, Set(held))
        XCTAssertEqual(transport.requests.map(\.method), ["POST", "POST"])
        XCTAssertEqual(transport.requests.map { $0.url.path }, ["/v1/blobs/held", "/v1/blobs/held"])
        let asked = try transport.requests.map { request -> [String] in
            guard case .json(let body) = request.body else { throw LinkFailure.unreadable(0) }
            return try XCTUnwrap((JSONSerialization.jsonObject(with: body) as? [String: Any])?["blobs"] as? [String])
        }
        XCTAssertEqual(asked.map(\.count), [5_000, 1])
        XCTAssertEqual(asked.flatMap { $0 }, ordered)
        XCTAssertEqual(transport.requests.first?.headers["Authorization"], "Bearer \(pass)")
        do {
            _ = try await link.held(blobs: [stranger])
            XCTFail("a refusal brought an answer")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure.code, "BLOBS_TOO_MANY")
        }
    }

    func testImportsHeldAsksByKindAndDigestAndBelievesOnlyWhatWasAsked() async throws {
        let one = HomeLink.ImportDigest(kind: "spotify", digest: String(repeating: "a", count: 64))
        let two = HomeLink.ImportDigest(kind: "google-takeout", digest: String(repeating: "b", count: 64))
        let three = HomeLink.ImportDigest(kind: "claude", digest: String(repeating: "c", count: 64))
        let four = HomeLink.ImportDigest(kind: "google-takeout", digest: String(repeating: "d", count: 64))
        let stranger = String(repeating: "f", count: 64)
        let (link, transport, _) = try await paired([
            .reply(200, #"{"held":[{"kind":"spotify","digest":"\#(one.digest)","state":"in"},{"kind":"claude","digest":"\#(three.digest)","state":"refused"},{"kind":"google-takeout","digest":"\#(four.digest)","state":"let-go"},{"kind":"spotify","digest":"\#(stranger)","state":"in"}]}"#),
            .reply(403, #"{"code":"PRINCIPAL_SCOPE","message":"no Mac's"}"#),
        ])
        let answered = try await link.held(imports: [one, two, three, four])
        XCTAssertEqual(answered, [one: .admitted, three: .refused, four: .letGo], "a file never looked at is left out")
        XCTAssertEqual(transport.requests.first?.url.path, "/v1/imports/held")
        XCTAssertEqual(transport.requests.first?.method, "POST")
        let asked = try XCTUnwrap(try Fixture.object(transport.requests[0])["files"] as? [[String: String]])
        XCTAssertEqual(asked, [["kind": "claude", "digest": three.digest], ["kind": "google-takeout", "digest": two.digest],
                               ["kind": "google-takeout", "digest": four.digest], ["kind": "spotify", "digest": one.digest]])
        do {
            _ = try await link.held(imports: [one])
            XCTFail("a refusal brought an answer")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure.code, "PRINCIPAL_SCOPE")
        }
    }

    func testACancelledReadIsACancellationNotNoAnswer() async throws {
        let (link, _, _) = try await paired([.cancelled])
        do {
            _ = try await link.people()
            XCTFail("a cancelled read brought an answer")
        } catch is CancellationError {
        } catch {
            XCTFail("a cancelled read failed as \(error)")
        }
        let (other, _, _) = try await paired([.unreachable])
        do {
            _ = try await other.people()
            XCTFail("no answer brought an answer")
        } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .noAnswer(sent: false))
        }
    }

    func testQueryValuesReachTheDoorAsTyped() throws {
        let query = HomeLink.query([("id", "whatsapp:+15550000001"), ("q", "a&b=c d \"x\" -y é"), ("none", nil)])
        XCTAssertEqual(query, "?id=whatsapp%3A%2B15550000001&q=a%26b%3Dc%20d%20%22x%22%20-y%20%C3%A9",
                       "a plus a door would read as a space, and & and = that would split the query, are encoded")
        let items = try XCTUnwrap(URLComponents(string: home + "/v1/search" + query)?.queryItems)
        XCTAssertEqual(items.map(\.name), ["id", "q"])
        XCTAssertEqual(items.map(\.value), ["whatsapp:+15550000001", "a&b=c d \"x\" -y é"])
        XCTAssertEqual(HomeLink.query([]), "")
    }


    func testADayAskedWithItsInputsIsNilOn304() async throws {
        let (link, transport, _) = try await paired([.reply(304, ""), .reply(200, Answers.day, ["ETag": "\"sha256:00aa\""])])
        let unchanged = try await link.day("2026-10-14", etag: "sha256:00aa")
        XCTAssertNil(unchanged, "304: the copy held is the day")
        XCTAssertEqual(transport.requests[0].headers["If-None-Match"], "\"sha256:00aa\"", "the inputs, quoted as the door's ETag")
        let changed = try await link.day("2026-10-14", etag: "sha256:00bb")
        XCTAssertEqual(changed?.inputs, "sha256:00aa")
        XCTAssertEqual(changed?.atoms.first?.record, HomeLink.DayFile.RecordRef(source: "whatsapp:15550000000:phone-aa01", kind: "msg", key: "m157"))
    }

    func testADayWithAnEmojiReadsAndOneWithHalfACharacterAloneIsUnreadable() async throws {
        let party = Answers.day.replacingOccurrences(of: "message 157", with: "message 157 \u{1F389}")
        let half = Answers.day.replacingOccurrences(of: "message 157", with: #"message 157 \ud83c"#)
        let (link, _, _) = try await paired([.reply(200, party), .reply(200, half)])
        let day = try await link.day("2026-10-14")
        XCTAssertEqual(day?.atoms.first?.text, "Person A: message 157 \u{1F389}")
        do { _ = try await link.day("2026-10-14"); XCTFail("half of a character alone") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unreadable(200))
        }
    }

    func testADaysCoverageReadsItsWordsAndAnOlderFileStatesNone() throws {
        let decode = { (text: String) in try JSONDecoder().decode(HomeLink.DayFile.self, from: Data(text.utf8)) }
        let day = try decode(Answers.day)
        XCTAssertEqual(day.coverage.flatMap(\.sources).map(\.read), [.through, .into, .notRead])
        let old = try decode(Answers.day.replacingOccurrences(of: #""read":"through""#, with: #""read_ms":1792108800000"#)
            .replacingOccurrences(of: #""read":"into""#, with: #""read_ms":1792050000000"#)
            .replacingOccurrences(of: #""read":"none""#, with: #""read_ms":null"#))
        XCTAssertEqual(old.coverage.flatMap(\.sources).map(\.read), [nil, nil, nil])
        XCTAssertEqual(old.atoms, day.atoms)
        let later = try decode(Answers.day.replacingOccurrences(of: #""read":"into""#, with: #""read":"partly""#))
        XCTAssertEqual(later.coverage.flatMap(\.sources).map(\.read), [.through, nil, .notRead])

        let kept = HomeLink.DayFile(day: day.day, window: day.window,
                                    renderer: day.renderer, inputs: day.inputs, counts: day.counts,
                                    coverage: day.coverage + old.coverage, atoms: day.atoms)
        let written = try JSONSerialization.jsonObject(with: JSONEncoder().encode(kept)) as? [String: Any]
        let sources = (written?["coverage"] as? [[String: Any]])?.flatMap { $0["sources"] as? [[String: Any]] ?? [] }
        XCTAssertEqual(sources?.map { $0["read"] as? String }, ["through", "into", "none", nil, nil, nil])
        XCTAssertEqual(sources?.map { $0.keys.sorted() }, [["read", "source"], ["read", "source"], ["read", "source"], ["source"], ["source"], ["source"]])
        XCTAssertEqual(try JSONDecoder().decode(HomeLink.DayFile.self, from: JSONEncoder().encode(kept)), kept)
    }

    func testTheSourcesArePageAfterPageEachWithItsReadThrough() async throws {
        let first = #"{"position":"0:9","sources":[{"id":"chrome:local:macbook-pro-0001","connector":"chrome","options":{},"read_through_ms":1792050000000,"added_ms":1790000000000,"kinds":["visit"],"later":true}],"next":"ImNocm9tZTpsb2NhbDptYWNib29rLXByby1hYTQyIg"}"#
        let (link, transport, _) = try await paired([.reply(200, first), .reply(200, Answers.sources)])
        let sources = try await link.sources()
        XCTAssertEqual(sources, [
            .init(id: "chrome:local:macbook-pro-0001", readThroughMs: 1_792_050_000_000),
            .init(id: "gmail:person-a@example.com:cloud", readThroughMs: nil),
            .init(id: "whatsapp:15550000000:phone-aa01", readThroughMs: 1_792_051_234_567),
        ])
        XCTAssertEqual(transport.requests.map(\.url.path), ["/v1/sources", "/v1/sources"])
        XCTAssertNil(transport.requests[0].url.query)
        XCTAssertEqual(transport.requests[1].url.query, "after=ImNocm9tZTpsb2NhbDptYWNib29rLXByby1hYTQyIg")
    }

    func testWhereAskedWithItsTagIsNilOn304AndCarriesItsTag() async throws {
        let (link, transport, _) = try await paired([.reply(200, Answers.wherePieces, ["etag": "\"w-1\""]), .reply(304, "")])
        let first = try await link.where(from: .day("2026-10-14"), to: .day("2026-10-14"))
        XCTAssertEqual(first?.etag, "\"w-1\"")
        let again = try await link.where(from: .day("2026-10-14"), to: .day("2026-10-14"), etag: first?.etag)
        XCTAssertNil(again)
        XCTAssertEqual(transport.requests[1].headers["If-None-Match"], "\"w-1\"")
    }

    func testAPageIsAskedByItsKeyWithItsTagAndSettledAndIsNilOn304() async throws {
        let body = #"{"position":"1:1791968400000"}"#
        let (link, transport, _) = try await paired([.reply(200, body, ["ETag": "\"g-1\""]), .reply(304, "")])
        let key = HomeLink.PageKey("/v1/page/people/find", ["q": "ann", "after": "c1", "settled": "1"])
        XCTAssertEqual(key, HomeLink.PageKey("/v1/page/people/find", ["after": "c1", "q": "ann"]), "settled is never part of a key")
        XCTAssertEqual(key.description, "/v1/page/people/find?after=c1&q=ann")
        let first = try await link.page(key, etag: nil)
        XCTAssertEqual(first?.etag, "\"g-1\"")
        XCTAssertEqual(first?.value, Data(body.utf8))
        let again = try await link.page(key, etag: "\"g-1\"", settled: true)
        XCTAssertNil(again)
        XCTAssertEqual(transport.requests.map(\.url.path), ["/v1/page/people/find", "/v1/page/people/find"])
        XCTAssertEqual(transport.requests.map(\.url.query), ["after=c1&q=ann", "after=c1&q=ann&settled=1"])
        XCTAssertNil(transport.requests[0].headers["If-None-Match"])
        XCTAssertEqual(transport.requests[1].headers["If-None-Match"], "\"g-1\"")
    }

    func testAMergedAwayKeyBecomesTheSurvivorsKey() {
        let key = HomeLink.PageKey("/v1/page/person", ["id": "person-b"])
        XCTAssertEqual(key.became("person-x"), HomeLink.PageKey("/v1/page/person", ["id": "person-x"]))
    }

    func testAPlaceItsPhotosAndAYearAskedWithTheirTagsAreNilOn304() async throws {
        let (link, transport, _) = try await paired([
            .reply(200, Answers.place, ["ETag": "\"p-1\""]), .reply(304, "", ["ETag": "\"p-1\""]),
            .reply(200, Answers.placePhotos, ["ETag": "\"f-1\""]), .reply(304, ""),
            .reply(200, Answers.whereYear, ["ETag": "\"y-1\""]), .reply(304, ""),
        ])
        let place = try await link.place(slug: "the-office")
        XCTAssertEqual(place?.etag, "\"p-1\"")
        XCTAssertEqual(place?.value.name, "The Office")
        let unchanged = try await link.place(slug: "the-office", etag: place?.etag)
        XCTAssertNil(unchanged, "304: the place held is the place")
        XCTAssertEqual(transport.requests[1].headers["If-None-Match"], "\"p-1\"", "the tag as the door wrote it")
        XCTAssertEqual(transport.requests[1].url.query, "slug=the-office")

        let photos = try await link.placePhotos(slug: "the-office")
        XCTAssertEqual(photos?.etag, "\"f-1\"")
        let samePhotos = try await link.placePhotos(slug: "the-office", etag: photos?.etag)
        XCTAssertNil(samePhotos, "304: the first page held stands")
        XCTAssertEqual(transport.requests[3].headers["If-None-Match"], "\"f-1\"")

        let year = try await link.where(from: .day("2026-01-01"), to: .day("2026-12-31"), grain: .year)
        XCTAssertEqual(year?.etag, "\"y-1\"")
        XCTAssertEqual(year?.value.grain, .year)
        XCTAssertEqual(year?.value.summaries.map(\.period), ["2026"], "the year row, as the door computed it")
        let sameYear = try await link.where(from: .day("2026-01-01"), to: .day("2026-12-31"), grain: .year, etag: year?.etag)
        XCTAssertNil(sameYear)
        XCTAssertEqual(transport.requests[5].url.query, "from=2026-01-01&to=2026-12-31&grain=year")
        XCTAssertEqual(transport.requests[5].headers["If-None-Match"], "\"y-1\"")
    }

    func testARefusalIsAFailureAndA404KeepsItsStatus() async throws {
        let (link, _, _) = try await paired([
            .reply(404, #"{"code":"DAY_UNKNOWN","message":"no files for 2026-10-15"}"#),
            .reply(404, #"{"code":"PERSON_UNKNOWN","message":"no person person:nobody"}"#),
            .reply(503, #"{"code":"INDEX_BUILDING","message":"the search index is being built","zone":"UTC","day_start_hour":4,"building":["words"],"read":12}"#, ["Retry-After": "5"]),
            .reply(503, #"{"code":"NOT_NOW","message":"the search index is being written"}"#, ["Retry-After": "5"]),
            .reply(200, #"{"code":"BAD_PARAMETER"}"#),
            .reply(304, ""),
        ])
        do { _ = try await link.day("2026-10-15"); XCTFail("no day") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .refused(status: 404, code: "DAY_UNKNOWN", message: "no files for 2026-10-15"))
        }
        do { _ = try await link.person(id: "person:nobody"); XCTFail("no person") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .refused(status: 404, code: "PERSON_UNKNOWN", message: "no person person:nobody"))
        }
        let building = try await link.search(HomeLink.SearchQuery(query: "x"))
        XCTAssertEqual(building, .building(["words"]), "11: search not ready is a state of its own, naming what is made")
        do { _ = try await link.search(HomeLink.SearchQuery(query: "x")); XCTFail("busy") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unavailable(code: "NOT_NOW", message: "the search index is being written", retryAfter: 5, notNow: .busy),
                           "11: any other not-now is the failure it is")
        }
        do { _ = try await link.people(); XCTFail("not people") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unreadable(200), "a body that is not the shape is no answer")
        }
        do { _ = try await link.status(); XCTFail("a 304 asked for nothing") } catch let failure as LinkFailure {
            XCTAssertEqual(failure.code, "HTTP_304")
        }
    }

    func testAnUnpairedDeviceReadsNothing() async throws {
        let transport = ScriptedTransport([.reply(200, Answers.days)])
        let link = HomeLink(device: phone, credentials: MemoryCredentials(), folder: folder, transport: transport)
        let reads: [() async throws -> Void] = [
            { _ = try await link.days() }, { _ = try await link.day("2026-10-14") }, { _ = try await link.where(at: Date()) },
            { _ = try await link.search(HomeLink.SearchQuery(query: "x")) },
            { _ = try await link.count(HomeLink.CountQuery(of: "calls")) }, { _ = try await link.people() }, { _ = try await link.person(id: "person:a") },
            { _ = try await link.page(HomeLink.PageKey("/v1/connectors"), etag: nil) }, { _ = try await link.status() }, { _ = try await link.devices() },
            { _ = try await link.extracts(family: "health", day: "2026-10-14") },
            { _ = try await link.record(source: "s", kind: "k", key: "1") }, { _ = try await link.places(etag: nil) },
            { _ = try await link.place(slug: "the-office") }, { _ = try await link.placePhotos(slug: "the-office") },
            { _ = try await link.blob(Restore.sha256(Data())) }, { _ = try await link.picture(Restore.sha256(Data()), size: .tile) },
        ]
        for read in reads {
            do { try await read(); XCTFail("unpaired") } catch let failure as LinkFailure {
                XCTAssertEqual(failure, .unpaired)
            }
        }
        XCTAssertTrue(transport.requests.isEmpty, "nothing leaves an unpaired device")
    }


    func testAnActIsPressedOnItsRouteWithThePassAndRefusedWhenNotOffered() async throws {
        let (link, transport, pass) = try await paired([
            .reply(200, #"{"acted":"queued","later":1}"#),
            .reply(409, #"{"code":"NOT_OFFERED","message":"poll:gmail-imap offers no try now"}"#),
            .reply(200, #"{"acted":"read","source":"claude:user-synthetic0004:browser"}"#),
        ])
        try await link.act(need: "poll:site:claude", do: "try")
        let request = transport.requests[0]
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.absoluteString, home + "/v1/act")
        XCTAssertEqual(request.headers["Authorization"], "Bearer \(pass)")
        XCTAssertEqual(request.headers["Lifestream-Device"], "phone/1.4.0")
        XCTAssertEqual(request.headers["Content-Type"], "application/json")
        XCTAssertEqual(try Fixture.object(request) as NSDictionary, ["need": "poll:site:claude", "do": "try"] as NSDictionary)
        do { try await link.act(need: "poll:gmail-imap", do: "try"); XCTFail("not offered") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .refused(status: 409, code: "NOT_OFFERED", message: "poll:gmail-imap offers no try now"))
        }
        try await link.act(need: "poll:claude-browser", do: "read", of: "claude:user-synthetic0004:browser")
        XCTAssertEqual(try Fixture.object(transport.requests[2]) as NSDictionary,
                       ["need": "poll:claude-browser", "do": "read", "of": "claude:user-synthetic0004:browser"] as NSDictionary)

        let unpaired = ScriptedTransport([.reply(200, #"{"acted":"queued"}"#)])
        let none = HomeLink(device: phone, credentials: MemoryCredentials(), folder: folder, transport: unpaired)
        do { try await none.act(need: "poll:whoop", do: "try"); XCTFail("unpaired") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unpaired)
        }
        XCTAssertTrue(unpaired.requests.isEmpty, "nothing leaves an unpaired device")
    }

    func testWhoseAnImportIsIsChosenOnTheActsRouteAndARefusalIsTheHomes() async throws {
        let (link, transport, _) = try await paired([
            .reply(200, #"{"acted":"chosen"}"#),
            .reply(200, #"{"acted":"chosen"}"#),
            .reply(422, #"{"code":"BAD_REQUEST","message":"This isn't person-b's Spotify history · choose whose it is"}"#),
            .reply(200, #"{"acted":"let-go"}"#),
        ])
        try await link.choose(need: "import:a000000000000001:whose", account: "person-a")
        XCTAssertEqual(transport.requests[0].url.absoluteString, home + "/v1/act")
        XCTAssertEqual(try Fixture.object(transport.requests[0]) as NSDictionary,
                       ["need": "import:a000000000000001:whose", "do": "choose", "account": "person-a"] as NSDictionary)
        try await link.choose(need: "import:a000000000000002:whose", account: "person-a")
        XCTAssertEqual(try Fixture.object(transport.requests[1]) as NSDictionary,
                       ["need": "import:a000000000000002:whose", "do": "choose", "account": "person-a"] as NSDictionary)
        do { try await link.choose(need: "import:a000000000000001:whose", account: "person-b"); XCTFail("refused") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .refused(status: 422, code: "BAD_REQUEST", message: "This isn't person-b's Spotify history · choose whose it is"))
        }
        try await link.act(need: "import:a000000000000001:file:f-1", do: "let-go")
        XCTAssertEqual(try Fixture.object(transport.requests[3]) as NSDictionary,
                       ["need": "import:a000000000000001:file:f-1", "do": "let-go"] as NSDictionary)
    }


    func testANotNowsKindIsReadFromItsWaitAlone() async throws {
        let held = "Lifestream's database is damaged."
        let line = "A check found damage in home.db. It needs a good copy of home.db put back."
        let (link, _, _) = try await paired([
            .reply(503, #"{"code":"NOT_NOW","wait":"needs","message":"\#(held) \#(line)","title":"\#(held)","line":"\#(line)","acts":[{"do":"verify","label":"Check again"},{"do":"someday","label":"Not known"}]}"#,
                   ["Retry-After": "60"]),
            .reply(503, #"{"code":"NOT_NOW","wait":"needs","message":"checking","title":"Lifestream is checking its database.","line":"It can take up to an hour.","acts":[]}"#),
            .reply(503, #"{"code":"NOT_NOW","wait":"starting","message":"Your home is starting: it answers in a moment.","title":"Your home is starting","line":"It answers in a moment.","acts":[]}"#, ["Retry-After": "5"]),
            .reply(503, #"{"code":"NOT_NOW","wait":"busy","message":"Your people are being prepared.","title":null,"line":null,"acts":[]}"#, ["Retry-After": "5"]),
            .reply(503, #"{"code":"NOT_NOW","wait":"someday","message":"A kind not known.","title":"Not","line":"known"}"#, ["Retry-After": "5"]),
            .reply(500, #"{"code":"INTERNAL","message":"the door failed","wait":"needs","line":"a line of its own"}"#),
        ])
        do { _ = try await link.days(); XCTFail("held") } catch let failure as LinkFailure {
            guard case .unavailable(let code, let message, let retryAfter, .needs(let found)?) = failure else { return XCTFail("\(failure)") }
            XCTAssertEqual(code, "NOT_NOW")
            XCTAssertEqual(message, "\(held) \(line)")
            XCTAssertEqual(retryAfter, 60)
            XCTAssertEqual(found.title, held)
            XCTAssertEqual(found.detail, line)
            XCTAssertEqual(found.acts.map(\.do), [.verify], "an act of a do this build does not know is left out")
            XCTAssertEqual(found.acts.map(\.label), ["Check again"])
        }
        do { _ = try await link.days(); XCTFail("checking") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unavailable(code: "NOT_NOW", message: "checking", retryAfter: nil,
                                                 notNow: .needs(HomeLink.Held(title: "Lifestream is checking its database.", detail: "It can take up to an hour."))))
        }
        do { _ = try await link.days(); XCTFail("starting") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unavailable(code: "NOT_NOW", message: "Your home is starting: it answers in a moment.", retryAfter: 5,
                                                 notNow: .starting(HomeLink.Starting(title: "Your home is starting", line: "It answers in a moment."))),
                           "a start in its title and line, apart")
        }
        for words in ["Your people are being prepared.", "A kind not known."] {
            do { _ = try await link.days(); XCTFail("busy") } catch let failure as LinkFailure {
                XCTAssertEqual(failure, .unavailable(code: "NOT_NOW", message: words, retryAfter: 5, notNow: .busy),
                               "a request's own wait, and a kind not known, are the request's")
            }
        }
        do { _ = try await link.days(); XCTFail("failed") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unavailable(code: "INTERNAL", message: "the door failed", retryAfter: nil),
                           "a 500 is no not-now, whatever it states")
        }
    }

    func testCheckAgainIsAskedOnItsRouteWithThePassAndRefusedInTheDoorsWords() async throws {
        let (link, transport, pass) = try await paired([
            .reply(202, #"{"asked":true}"#),
            .reply(409, #"{"code":"NOT_HELD","message":"Your home is not held."}"#),
            .reply(403, #"{"code":"PRINCIPAL_SCOPE","message":"Only a Mac or an iPhone may ask for a check."}"#),
        ])
        try await link.verifyHome()
        let request = transport.requests[0]
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.absoluteString, home + "/v1/home/verify")
        XCTAssertEqual(request.headers["Authorization"], "Bearer \(pass)")
        XCTAssertEqual(request.body, .empty)
        do { try await link.verifyHome(); XCTFail("not held") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .refused(status: 409, code: "NOT_HELD", message: "Your home is not held."))
        }
        do { try await link.verifyHome(); XCTFail("scope") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .refused(status: 403, code: "PRINCIPAL_SCOPE", message: "Only a Mac or an iPhone may ask for a check."))
        }

        let unpaired = ScriptedTransport([.reply(202, "{}")])
        let none = HomeLink(device: phone, credentials: MemoryCredentials(), folder: folder, transport: unpaired)
        do { try await none.verifyHome(); XCTFail("unpaired") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unpaired)
        }
        XCTAssertTrue(unpaired.requests.isEmpty, "nothing leaves an unpaired device")
    }


    func testWhoseWordAPersonsEntityIsIsReadAndAnOlderHomesIsTheHomes() throws {
        func person(_ members: String) throws -> HomeLink.Person {
            let json = #"{"id":"person:person-a","name":"Person A","handles":[],"networks":[],"chats":[],"received":0,"sent":0,"last_30":0,"days_count":0,"# + members + "}"
            return try JSONDecoder().decode(HomeLink.Person.self, from: Data(json.utf8))
        }
        let yours = try person(#""entity":"ai","entity_by":"you""#)
        XCTAssertEqual([yours.entity, yours.entityBy], ["ai", "you"])
        XCTAssertTrue(yours.entityIsYours, "the owner's word")
        let judged = try person(#""entity":"business","entity_by":"home""#)
        XCTAssertFalse(judged.entityIsYours, "People's judgement")
        let older = try person(#""entity":"bot""#)
        XCTAssertNil(older.entityBy)
        XCTAssertFalse(older.entityIsYours, "a home before entity_by: read as the home's")
        let unsaid = try person(#""entity":null,"entity_by":"home","record":{"type":"people.person","slug":"person-a","entity":null}"#)
        XCTAssertNil(unsaid.entity, "a null entity decodes")
        XCTAssertEqual(unsaid.record?["entity"], .null, "a record that says nothing of what they are, kept as written")
    }

    func testWhatEditOpensWithIsReadWithThePositionPeopleStoodAt() async throws {
        let (link, _, _) = try await paired([
            .reply(200, Answers.editedPerson, ["Lifestream-Position": "41:1792060000000"]),
        ])
        let read = try await link.person(id: "person:person-a")
        XCTAssertEqual(read.position, HomeLink.Position("41:1792060000000"), "the header's, where People stood")
        let person = read.value
        XCTAssertEqual([person.callName, person.fullName, person.show, person.entity], ["Sam", "Sam Rivera", "full_name", "person"])
        XCTAssertEqual([person.me, person.hidden, person.organised], [false, false, true])
        XCTAssertEqual(person.handles.map(\.id), ["phone:+15550000001", "email:sam@example.com", "jid:1234@lid"])
        XCTAssertEqual(person.handles.map(\.words), ["+1 555 000 0001", "sam@example.com", "Hidden number"], "what a screen says of each, the home's")
        XCTAssertEqual(person.namesSeen, ["Sam R", "Samuel Rivera"])
        XCTAssertEqual(person.suggestions, [
            .init(id: "1111111111111111", kind: "handle", value: "email:sam.r@example.com", reasons: ["mails_from": 3, "mails_to": 2], ticked: true),
            .init(id: "2222222222222222", kind: "birthday", value: "08-14", reasons: ["wished": 3], ticked: false),
        ])
        XCTAssertEqual(person.suggestions?[0].reason("mails_from"), 3)
        XCTAssertEqual(person.suggestions?[1].reason("cards"), 0, "a reason it rests on none of")
        XCTAssertEqual(person.record?["slug"], .string("sam-rivera"), "their record, kept as the door wrote it")
        XCTAssertEqual(person.record?["anchor"]?["value"], .string("+15550000001"))
        let kept = try JSONDecoder().decode(HomeLink.Person.self, from: JSONEncoder().encode(person))
        XCTAssertEqual(kept, person, "kept whole")
    }

    func testAPositionIsOrderedByItsSequence() {
        let nine = HomeLink.Position("9:1792060000000"), ten = HomeLink.Position("10:1792000000000")
        XCTAssertNotNil(nine)
        XCTAssertLessThan(nine!, ten!, "by sequence, never as text")
        XCTAssertEqual(HomeLink.Position("10:1792000000000"), ten)
        XCTAssertGreaterThanOrEqual(ten!, HomeLink.Position("10:1792000000000")!)
        for text in ["", "10", "10:", ":5", "a:b", "1:2:3", nil] as [String?] { XCTAssertNil(HomeLink.Position(text), "\(text ?? "nil")") }
        XCTAssertEqual(ten?.description, "10:1792000000000")
    }

    func testAnActionIsSentOnItsRouteSayingOnlyWhatTheOwnerSaid() async throws {
        let answer = #"{"act":"20261026T101500.120Z.0123456789ab","id":"person:sam-rivera","position":"42:1792060001000","later":1}"#
        let (link, transport, pass) = try await paired([
            .reply(200, answer), .reply(200, answer), .reply(200, answer),
            .reply(200, #"{"act":null,"id":"person:sam-rivera","position":"43:1792060002000"}"#),
        ])
        var confirm = HomeLink.Confirm(id: "phone:+15550000001")
        confirm.accept = ["1111111111111111"]
        confirm.name = .some("Sam")
        confirm.relationship = .some(nil)
        confirm.unlink = ["email:old@example.com"]
        confirm.details = .init(birthday: .some(.init(month: 8, day: 14, year: nil)))
        let answered = try await link.act(.people(request: "8F2C1E40-0000-4000-8000-000000000001", .confirm(confirm)))
        XCTAssertEqual(answered, .init(act: "20261026T101500.120Z.0123456789ab", id: "person:sam-rivera", position: "42:1792060001000"))
        let request = transport.requests[0]
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.absoluteString, home + "/v1/owner/act")
        XCTAssertEqual(request.headers["Authorization"], "Bearer \(pass)")
        XCTAssertEqual(request.headers["Lifestream-Device"], "phone/1.4.0")
        XCTAssertEqual(request.headers["Content-Type"], "application/json")
        XCTAssertEqual(try Fixture.object(request) as NSDictionary, [
            "of": "people", "kind": "confirm", "request": "8F2C1E40-0000-4000-8000-000000000001", "id": "phone:+15550000001",
            "accept": ["1111111111111111"], "name": "Sam", "relationship": NSNull(), "unlink": ["email:old@example.com"],
            "details": ["birthday": ["month": 8, "day": 14, "year": NSNull()]],
        ] as NSDictionary, "only what was said: no decline, no full name, no add, details by the one member changed")

        _ = try await link.act(.people(request: "r-2", .confirm(.hide("person:sam-rivera"))))
        XCTAssertEqual(try Fixture.object(transport.requests[1]) as NSDictionary,
                       ["of": "people", "kind": "confirm", "request": "r-2", "id": "person:sam-rivera", "hidden": true] as NSDictionary, "Hide alone")
        let square = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
        _ = try await link.act(.people(request: "r-3", .photo(id: "person:sam-rivera", square: square)))
        XCTAssertEqual(try Fixture.object(transport.requests[2]) as NSDictionary,
                       ["of": "people", "kind": "photo", "request": "r-3", "id": "person:sam-rivera", "upload": square.base64EncodedString()] as NSDictionary)
        let undone = try await link.act(.people(request: "r-4", .undo(act: "20261026T101500.120Z.0123456789ab")))
        XCTAssertNil(undone.act, "an undo is undone by nothing")
        XCTAssertEqual(try Fixture.object(transport.requests[3]) as NSDictionary,
                       ["of": "people", "kind": "undo", "request": "r-4", "act": "20261026T101500.120Z.0123456789ab"] as NSDictionary)
        XCTAssertEqual(HomeLink.OwnerAction.people(request: "r-4", .undo(act: "a")).request, "r-4")
    }

    func testAnActionsRefusalsKeepTheirCodesAndNoAnswerIsTheReachs() async throws {
        let (link, transport, _) = try await paired([
            .reply(409, #"{"code":"NOT_OFFERED","message":"That suggestion is no longer offered: open the person again."}"#),
            .reply(503, #"{"code":"OUTCOME_UNKNOWN","message":"Lifestream did not answer in time: it may have kept the change."}"#, ["Retry-After": "2"]),
            .reply(503, #"{"code":"NOT_NOW","wait":"starting","message":"Your home is starting up.","title":"Your home is starting","line":"It answers in a moment.","acts":[]}"#),
            .reply(200, "{}"),
            .reply(200, #"{"act":"x"}"#),
            .unreachable,
        ])
        let undo = HomeLink.OwnerAction.people(request: "r-1", .undo(act: "x"))
        do { _ = try await link.act(undo); XCTFail("refused") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .refused(status: 409, code: "NOT_OFFERED", message: "That suggestion is no longer offered: open the person again."))
        }
        do { _ = try await link.act(undo); XCTFail("unknown") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unanswered(again: false, began: false), "the door's word: not sent again")
        }
        do { _ = try await link.act(undo); XCTFail("not now") } catch let failure as LinkFailure {
            XCTAssertEqual(failure.code, "NOT_NOW", "never reached: nothing ran")
        }
        await link.probesEnded()
        XCTAssertEqual(transport.requests.last?.url.path, "/v1/status")
        do { _ = try await link.act(undo); XCTFail("no position") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unreadable(200), "an answer with no position is none")
        }
        do { _ = try await link.act(undo); XCTFail("no answer") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .noAnswer(sent: false), "the reach's failure, not a refusal")
        }
        XCTAssertEqual(transport.requests.count, 7, "the probe, and the act no address answered sent once more: the writer answers a request once")

        let unpaired = ScriptedTransport([.reply(200, #"{"act":null,"id":null,"position":"1:1"}"#)])
        let none = HomeLink(device: phone, credentials: MemoryCredentials(), folder: folder, transport: unpaired)
        do { _ = try await none.act(undo); XCTFail("unpaired") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unpaired)
        }
        XCTAssertTrue(unpaired.requests.isEmpty, "nothing leaves an unpaired device")
    }

    func testAnOutcomeUnknownIsSentOnceMoreOnlyWhenTheDoorSaysItMayBe() async throws {
        let unknown = #"{"code":"OUTCOME_UNKNOWN","message":"Lifestream did not answer in time: it may have kept the change.","again":true}"#
        let (link, transport, _) = try await paired([
            .reply(503, unknown, ["Retry-After": "5"]),
            .reply(200, #"{"act":"x","id":null,"position":"1:1"}"#),
            .reply(503, unknown, ["Retry-After": "5"]),
            .reply(503, unknown, ["Retry-After": "5"]),
            .reply(503, #"{"code":"OUTCOME_UNKNOWN","message":"Lifestream did not answer in time: it may have kept the change.","again":false}"#, ["Retry-After": "5"]),
        ])
        let undo = HomeLink.OwnerAction.people(request: "r-1", .undo(act: "x"))
        let answered = try await link.act(undo)
        XCTAssertEqual(answered.act, "x", "sent once more, and answered")
        XCTAssertEqual(try Fixture.object(transport.requests[1]) as NSDictionary, try Fixture.object(transport.requests[0]) as NSDictionary, "the same request")
        do { _ = try await link.act(undo); XCTFail("still unknown") } catch let failure as LinkFailure {
            XCTAssertEqual(failure.code, "OUTCOME_UNKNOWN", "once more, then the door's words")
        }
        XCTAssertEqual(transport.requests.count, 4)
        do { _ = try await link.act(undo); XCTFail("not again") } catch let failure as LinkFailure {
            XCTAssertEqual(failure.code, "OUTCOME_UNKNOWN", "an act its door says may not be sent again is said at once")
        }
        XCTAssertEqual(transport.requests.count, 5)
    }

    func testAFindReadsPeopleAndTheProfilesTheWordsReadAs() async throws {
        let (link, transport, _) = try await paired([
            .reply(200, #"{"position":"0:9","people":[{\#(Answers.personA)}],"profiles":[{"network":"instagram","value":"sam.r"},{"network":"x","value":"sam.r"}]}"#),
        ])
        let found = try await link.findPeople(q: "@sam.r +1")
        XCTAssertEqual(found.people.map(\.id), ["person:person-a"])
        XCTAssertEqual(found.profiles, [.init(network: "instagram", value: "sam.r"), .init(network: "x", value: "sam.r")])
        XCTAssertEqual(transport.requests[0].url.path, "/v1/people")
        XCTAssertEqual(transport.requests[0].url.query, "q=%40sam.r%20%2B1")
    }

    func testADaysExtractsArePageAfterPage() async throws {
        let first = #"{"position":"0:9","extracts":[\#(Answers.sleep)],"next":"InNsZWVwLzEi"}"#
        let (link, transport, _) = try await paired([.reply(200, first), .reply(200, Answers.extracts)])
        let extracts = try await link.extracts(family: "health", day: "2026-10-14")
        XCTAssertEqual(extracts.count, 2)
        XCTAssertEqual(transport.requests.last?.url.query, "family=health&day=2026-10-14&after=InNsZWVwLzEi")
    }

    func testABlobMustBeItsName() async throws {
        let bytes = "a synthetic picture"
        let (link, transport, _) = try await paired([.reply(200, bytes), .reply(200, "other bytes")])
        let name = Restore.sha256(Data(bytes.utf8))
        let blob = try await link.blob(name)
        XCTAssertEqual(blob, Data(bytes.utf8))
        XCTAssertEqual(transport.requests[0].url.path, "/v1/blobs/" + name)
        do { _ = try await link.blob(name); XCTFail("not its name") } catch LinkFailure.unreadable {}
    }

    func testAPictureIsReadByItsHashAtItsSizeAndA404IsOneTheHomeDoesNotHold() async throws {
        let name = Restore.sha256(Data("a synthetic photo's original".utf8))
        let (link, transport, _) = try await paired([
            .reply(200, Answers.pictures), .reply(200, "a tile made of it"), .reply(200, "a screen made of it"),
            .reply(404, #"{"code":"BLOB_UNKNOWN","message":"no such blob"}"#),
            .reply(404, #"{"code":"NOT_A_PICTURE","message":"not a picture"}"#),
        ])
        let tile = try await link.picture(name, size: .tile)
        XCTAssertEqual(tile, Data("a tile made of it".utf8), "the made picture, never checked against the original's hash")
        let screen = try await link.picture(name, size: .screen)
        XCTAssertEqual(screen, Data("a screen made of it".utf8))
        XCTAssertEqual(transport.requests.map { $0.url.path }, ["/v1/pictures", "/v1/pictures/" + name, "/v1/pictures/" + name],
                       "the recipe read once, by the first picture")
        XCTAssertEqual(transport.requests.map { $0.url.query }, [nil, "size=tile&recipe=2", "size=screen&recipe=2"])
        do { _ = try await link.picture(name, size: .tile); XCTFail("not held") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .refused(status: 404, code: "BLOB_UNKNOWN", message: "no such blob"))
        }
        do { _ = try await link.picture(name, size: .tile); XCTFail("no picture") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .refused(status: 404, code: "NOT_A_PICTURE", message: "not a picture"))
        }
        do { _ = try await link.picture("data:image/jpeg;base64,AAAA", size: .tile); XCTFail("not a hash") } catch LinkFailure.unusableID {}
        XCTAssertEqual(transport.requests.count, 5, "a hash of another shape is never asked")
    }

    func testTheRecipeIsReadOnceAndAgainOnlyOnceAnAnswerSaysItMoved() async throws {
        let name = Restore.sha256(Data("a synthetic photo's original".utf8))
        let moved = #"{"recipe":3}"#
        let (link, transport, _) = try await paired([
            .unreachable, .reply(200, Answers.pictures), .reply(200, "a tile"), .reply(200, "a tile", ["Cache-Control": "no-store"]),
            .reply(200, moved), .reply(200, "a tile", ["Cache-Control": "private, max-age=86400"]), .reply(200, "a tile"),
        ])
        do { _ = try await link.picture(name, size: .tile); XCTFail("the recipe's read found no home") } catch LinkFailure.noAnswer {}
        for _ in 0..<4 { _ = try await link.picture(name, size: .tile) }
        XCTAssertEqual(transport.requests.map { $0.url.path == "/v1/pictures" ? "recipe" : $0.url.query ?? "" },
                       ["recipe", "recipe", "size=tile&recipe=2", "size=tile&recipe=2", "recipe", "size=tile&recipe=3", "size=tile&recipe=3"])
        XCTAssertEqual(try Self.contract(HomeLink.Pictures.self, "pictures.json").recipe, 2, "the door's contract file")
    }

    private static func contract<Value: Decodable>(_ type: Value.Type, _ name: String) throws -> Value {
        try JSONDecoder().decode(type, from: Data(contentsOf: ProofTests.fixtures.appendingPathComponent(name)))
    }


    private static let file = Data((0..<1_000).map { UInt8(0x41 + $0 % 26) })
    private static let fileName = "sha256:" + String(repeating: "4c", count: 32)

    private struct Ranged: Equatable {
        let bytes: Data
        let total: Int64
    }

    private static func read(_ link: HomeLink, _ range: Range<Int64>, _ hash: String = fileName) async throws -> Ranged {
        var bytes = Data()
        let total = try await link.blob(hash, range: range) { piece, _ in bytes += piece }
        return Ranged(bytes: bytes, total: total)
    }

    private static func partial(_ start: Int, _ end: Int, total: Int = file.count, body: Data? = nil) -> ScriptedTransport.Step {
        .reply(206, String(decoding: body ?? file[start...end], as: UTF8.self),
               ["Content-Range": "bytes \(start)-\(end)/\(total)", "Content-Type": "application/octet-stream"])
    }

    func testARangeIsAskedByItsBytesAndBelievedOnlyAsTheDoorAnswersIt() async throws {
        let (link, transport, _) = try await paired([
            Self.partial(0, 99, body: Self.file[0...99]), Self.partial(900, 999, body: Self.file[900...999]),
            .reply(416, "", ["Content-Range": "bytes */1000"]),
        ])
        let first = try await Self.read(link, 0..<100)
        XCTAssertEqual(first, .init(bytes: Self.file[0...99], total: 1_000))
        let tail = try await Self.read(link, 900..<4_194_304)
        XCTAssertEqual(tail, .init(bytes: Self.file[900...999], total: 1_000), "a range past the file ends at its last byte")
        let end = try await Self.read(link, 1_000..<1_100)
        XCTAssertEqual(end, .init(bytes: Data(), total: 1_000), "a start at the end is no bytes")
        XCTAssertEqual(transport.requests.map { $0.url.path }, Array(repeating: "/v1/blobs/" + Self.fileName, count: 3))
        XCTAssertEqual(transport.requests.map { $0.headers["Range"] }, ["bytes=0-99", "bytes=900-4194303", "bytes=1000-1099"])
        XCTAssertEqual(transport.requests.map { $0.method }, ["GET", "GET", "GET"])
        do { _ = try await Self.read(link, 5..<5); XCTFail("an empty range") } catch LinkFailure.unusableID {}
        do { _ = try await Self.read(link, 0..<5, "sha256:00"); XCTFail("a hash of another shape") } catch LinkFailure.unusableID {}
        XCTAssertEqual(transport.requests.count, 3, "neither is asked")
    }

    func testARangeAnsweredOtherwiseIsUnreadableAndARefusalKeepsItsCode() async throws {
        let wrong: [(ScriptedTransport.Step, LinkFailure)] = [
            (.reply(200, String(decoding: Self.file, as: UTF8.self)), .unreadable(200)),
            (Self.partial(0, 99, body: Self.file[0...98]), .unreadable(206)),
            (Self.partial(0, 99, body: Self.file[0...100]), .unreadable(206)),
            (Self.partial(1, 100, body: Self.file[1...100]), .unreadable(206)),
            (Self.partial(0, 49, body: Self.file[0...49]), .unreadable(206)),
            (.reply(206, String(decoding: Self.file[0...99], as: UTF8.self), ["Content-Range": "bytes 0-99/*"]), .unreadable(206)),
            (.reply(206, String(decoding: Self.file[0...99], as: UTF8.self)), .unreadable(206)),
            (.reply(416, "", ["Content-Range": "bytes */1000"]), .unreadable(416)),
            (.reply(404, #"{"code":"BLOB_UNKNOWN","message":"no blob"}"#), .refused(status: 404, code: "BLOB_UNKNOWN", message: "no blob")),
        ]
        for (answer, failure) in wrong {
            let (link, _, _) = try await paired([answer])
            do { _ = try await Self.read(link, 0..<100); XCTFail("believed: \(failure)") } catch let said as LinkFailure {
                XCTAssertEqual(said, failure)
            }
            try? FileManager.default.removeItem(at: folder)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        }
    }

    func testARangeLostToReachIsAskedAgainOnceTheHomeAnswersAndNotPastTheDeadline() async throws {
        let clock = TestClock(Date(timeIntervalSince1970: 1_792_000_000))
        let pacer = ManualPacer(clock)
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: home, account: Fixture.account)
        let transport = ScriptedTransport([.unreachable, .reply(200, Answers.status), Self.partial(0, 99)])
        let link = HomeLink(device: phone, credentials: credentials, folder: folder, transport: transport,
                            clock: { clock.now }, pacer: pacer.pacer)
        let read = Task { try await Self.read(link, 0..<100) }
        await fulfillment(of: [transport.reached(1)], timeout: 30)
        _ = try await ended("the reach waiting once the range went unanswered",
                            Task { await link.snapshots().first { if case .waiting = $0.reach { true } else { false } } })
        XCTAssertEqual(transport.requests.count, 1, "not asked again while the home does not answer")
        pacer.pass(HomeLink.probeEvery)
        let answered = try await ended("the range asked again once the probe was answered", read)
        XCTAssertEqual(answered, .init(bytes: Self.file[0...99], total: 1_000))
        XCTAssertEqual(transport.requests.map { $0.url.path }, ["/v1/blobs/" + Self.fileName, "/v1/status", "/v1/blobs/" + Self.fileName])

        let silent = ScriptedTransport([.unreachable])
        let armed = XCTestExpectation(description: "the read's deadline armed")
        armed.assertForOverFulfill = false
        let deadlines = Pacer { seconds, fire in
            pacer.pacer.after(seconds, fire)
            if seconds == HomeLink.silence { armed.fulfill() }
        }
        let lost = HomeLink(device: phone, credentials: credentials, folder: folder, transport: silent, clock: { clock.now }, pacer: deadlines)
        let late = Task { try await Self.read(lost, 0..<100) }
        await fulfillment(of: [armed], timeout: 30)
        pacer.pass(HomeLink.silence)
        do { _ = try await ended("the range given up at its deadline", late); XCTFail("past the deadline") } catch LinkFailure.noAnswer {}

        let cancelled = Task { try await Self.read(lost, 0..<100) }
        cancelled.cancel()
        do { _ = try await ended("the cancelled range's end", cancelled); XCTFail("cancelled") } catch is CancellationError {}
    }

    func testARangeLostWhileTheHomeAnsweredAnotherIsAskedAgainAtOnceThoughTheReachIsWaitingAgain() async throws {
        let clock = TestClock(Date(timeIntervalSince1970: 1_792_000_000))
        let pacer = ManualPacer(clock)
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: home, account: Fixture.account)
        let scripted = ScriptedTransport([.unreachable, .reply(200, Answers.status), .unreachable, .unreachable, Self.partial(0, 99)])
        let held = HeldTransport(scripted, hold: 1)
        let link = HomeLink(device: phone, credentials: credentials, folder: folder, transport: held,
                            clock: { clock.now }, pacer: pacer.pacer)
        do { _ = try await link.status(); XCTFail("the home answered") } catch LinkFailure.noAnswer {}
        let read = Task { try await Self.read(link, 0..<100) }
        await fulfillment(of: [held.asked], timeout: 30)
        _ = try await link.status()
        XCTAssertEqual(link.snapshot.reach, .answering)
        do { _ = try await link.status(); XCTFail("the home answered") } catch LinkFailure.noAnswer {}
        guard case .waiting = link.snapshot.reach else { return XCTFail("not waiting: \(link.snapshot.reach)") }
        held.answer()
        let answered = try await ended("the range asked again with no probe passed", read)
        XCTAssertEqual(answered, .init(bytes: Self.file[0...99], total: 1_000))
        XCTAssertEqual(scripted.requests.map { $0.url.path },
                       ["/v1/status", "/v1/status", "/v1/status", "/v1/blobs/" + Self.fileName, "/v1/blobs/" + Self.fileName])
    }

    private struct RangeAnswers: Decodable {
        struct Answer: Decodable {
            let range: String
            let status: Int
            let headers: [String: String]
            let body: String
        }
        let hash: String
        let total: Int64
        let inside, past: Answer
    }

    private final class RangeDoor: HomeTransport, @unchecked Sendable {
        let answers: [RangeAnswers.Answer]
        private let lock = NSLock()
        private var asked: [String] = []
        init(_ answers: [RangeAnswers.Answer]) { self.answers = answers }
        var ranges: [String] { lock.withLock { asked } }

        func perform(_ request: HomeRequest) async throws -> HomeResponse {
            let range = request.headers["Range"] ?? ""
            lock.withLock { asked.append(range) }
            guard let answer = answers.first(where: { $0.range == range }) else { return HomeResponse(status: 400, body: Data()) }
            return HomeResponse(status: answer.status, headers: answer.headers, body: Data(base64Encoded: answer.body)!)
        }
    }

    func testTheDoorsRangesOfALivePhotosMotionReadAsItAnswersThem() async throws {
        let contract = try Self.contract(RangeAnswers.self, "blob-range.json")
        let credentials = MemoryCredentials()
        _ = try await HomeLink(device: phone, credentials: credentials, folder: folder, transport: ScriptedTransport([.reply(200, Fixture.paired())]))
            .pair(code: "12345678", name: home, account: Fixture.account)
        let door = RangeDoor([contract.inside, contract.past])
        let link = HomeLink(device: phone, credentials: credentials, folder: folder, transport: door)
        let first = try await Self.read(link, 0..<1_024, contract.hash)
        XCTAssertEqual(first, .init(bytes: try XCTUnwrap(Data(base64Encoded: contract.inside.body)), total: contract.total))
        XCTAssertEqual(first.bytes.count, 1_024)
        let end = try await Self.read(link, contract.total..<(contract.total + 1_024), contract.hash)
        XCTAssertEqual(end, .init(bytes: Data(), total: contract.total), "a read from the end is no bytes and the length")
        XCTAssertEqual(door.ranges, [contract.inside.range, contract.past.range], "each range asked as the door was asked it")
    }


    func testAPhotosPlayReadsAsTheDoorWritesItAndOneWithoutItIsRefused() throws {
        struct Facts: Decodable { let video, live, chat, still: OnePhoto }
        struct OnePhoto: Decodable { let photo: HomeLink.Photo }
        let facts = try Self.contract(Facts.self, "photo-play.json")
        XCTAssertEqual(facts.video.photo.kind, "video")
        XCTAssertEqual(facts.video.photo.play, .init(hash: facts.video.photo.hash, mediaType: "video/quicktime", live: false))
        XCTAssertEqual(facts.live.photo.kind, "image")
        let live = try XCTUnwrap(facts.live.photo.play)
        XCTAssertTrue(live.live)
        XCTAssertNotEqual(live.hash, facts.live.photo.hash, "a Live Photo plays its motion, not its still")
        XCTAssertEqual(live.mediaType, "video/quicktime")
        XCTAssertEqual(facts.chat.photo.kind, "video")
        XCTAssertEqual(facts.chat.photo.play, .init(hash: facts.chat.photo.hash, mediaType: "video/mp4", live: false))
        XCTAssertNotNil(facts.chat.photo.chat)
        XCTAssertNil(facts.still.photo.play)

        let file = try JSONSerialization.jsonObject(with: Data(contentsOf: ProofTests.fixtures.appendingPathComponent("photo-play.json")))
        var still = try XCTUnwrap(((file as? [String: Any])?["still"] as? [String: Any])?["photo"] as? [String: Any])
        still.removeValue(forKey: "play")
        let without = try JSONSerialization.data(withJSONObject: still)
        XCTAssertThrowsError(try JSONDecoder().decode(HomeLink.Photo.self, from: without), "a missing play is not a still")
    }

    func testADaysVideoAtomCarriesItsLengthAndItsKeptCopyWritesIt() throws {
        let day = try Self.contract(HomeLink.DayFile.self, "day-video.json")
        XCTAssertEqual(day.atoms.map(\.video), [nil, nil, .init(durationMs: 42_400)])
        XCTAssertEqual(day.atoms.map(\.live), [nil, true, nil], "a Live Photo says so; a still and a video never")
        let kept = try JSONEncoder().encode(day)
        XCTAssertEqual(try JSONDecoder().decode(HomeLink.DayFile.self, from: kept), day)
        let atoms = try XCTUnwrap((JSONSerialization.jsonObject(with: kept) as? [String: Any])?["atoms"] as? [[String: Any]])
        XCTAssertEqual(atoms.map { $0["video"] as? [String: Int] }, [nil, nil, ["duration_ms": 42_400]])
        XCTAssertEqual(atoms.map { $0["live"] as? Bool }, [nil, true, nil])
        let unknown = try JSONEncoder().encode(HomeLink.DayFile.Video(durationMs: nil))
        XCTAssertEqual(String(decoding: unknown, as: UTF8.self), #"{"duration_ms":null}"#, "a length no library times")
    }

    func testABoxPicksItsSizeByItsLongestSide() {
        XCTAssertEqual(HomeLink.PictureSize(box: 390), .tile, "the 130-point tile at 3x")
        XCTAssertEqual(HomeLink.PictureSize(box: 640), .tile)
        XCTAssertEqual(HomeLink.PictureSize(box: 641), .screen)
        XCTAssertEqual(HomeLink.PictureSize(box: 900), .screen, "the 300-point viewer at 3x")
    }


    func testAPlaceAPersonAndAHiddenSpotTheHomeHasNotCountedReadCountingWithTheirCountsZero() throws {
        let place = #"{"slug":"synthetic-gym-0a0b0c","name":"Synthetic Gym","latitude":37.3187,"longitude":-122.009,"radius_m":80,"also":[],"ids":[],"area":{"city":null,"region":null,"country":null},"part_of":null,"inside":[],"days":0,"hours":0,"first_ms":null,"last_ms":null,"visits_count":0,"nights":0,"here":false,"ask_home":null,"rhythm":null,"visits":[],"photos":[],"photos_count":0,"people":[],"counting":true}"#
        let read = try JSONDecoder().decode(HomeLink.Place.self, from: Data(place.utf8))
        XCTAssertEqual(read.name, "Synthetic Gym", "the definition, from the home's head")
        XCTAssertEqual(read.counting, true, "the counted parts draw the reading skeleton")
        XCTAssertEqual([read.days, read.visitsCount, read.photosCount], [0, 0, 0])
        XCTAssertEqual(read.visits, [])
        let counted = try JSONDecoder().decode(HomeLink.Place.self, from: Data(place.replacingOccurrences(of: #","counting":true"#, with: "").utf8))
        XCTAssertNil(counted.counting, "no member: counted")

        let person = #"{"id":"person:person-k","name":"Person K","handles":[{"id":"phone:+15550000011","kind":"phone","network":null,"words":"+1 555 000 0011","from":null}],"counting":true}"#
        let named = try JSONDecoder().decode(HomeLink.Person.self, from: Data(person.utf8))
        XCTAssertEqual(named.name, "Person K", "a person the file has not got, read from their head")
        XCTAssertEqual(named.counting, true)
        XCTAssertEqual([named.received, named.sent, named.last30, named.daysCount], [0, 0, 0, 0])

        let hidden = #"{"hidden":[{"key":"hidden-0a0b0c","latitude":37.3,"longitude":-122.0,"hidden_ms":1791000000000,"days":0,"nearest":null,"counting":true}]}"#
        let spot = try XCTUnwrap(HomeLink.Places.hidden(in: Data(hidden.utf8)).first)
        XCTAssertEqual(spot.days, 0)
        XCTAssertEqual(spot.counting, true)
    }

    func testAPersonsPhotoAndItsDayReadAndAreKept() async throws {
        let (link, _, _) = try await paired([.reply(200, Answers.people), .reply(200, Answers.person), .reply(200, Answers.cardPeople), .reply(200, Answers.dayless)])
        let people = try await link.people()
        XCTAssertEqual(people.people.map(\.photo), [.init(crop: Answers.crop, card: nil), nil], "a crop, and none said as null")
        let kept = try JSONDecoder().decode(HomeLink.People.self, from: JSONEncoder().encode(people))
        XCTAssertEqual(kept, people, "the kept copy carries them all")
        let person = try await link.person(id: "person:person-a").value
        XCTAssertEqual(person.photo, .init(crop: Answers.crop, card: nil))
        let cards = try await link.people()
        XCTAssertEqual(cards.people.map(\.photo), [.init(crop: nil, card: "sha256:" + String(repeating: "cd", count: 32)), nil])
        let dayless = try await link.people()
        XCTAssertEqual(dayless.people, [], "a list that states no zone or day start reads: the home's clock says them")
    }

    func testTheOwnerTheirOtherNamesTheirOwnHandlesAndWhoIsJoinedReadAsTheDoorServesThem() throws {
        let contract = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/home/test/people-you.json")
        let served = try JSONSerialization.jsonObject(with: Data(contentsOf: contract)) as! [String: Any]
        func decoded<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
            try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: object))
        }
        let list: [String: Any] = ["you": served["you"]!, "people": [], "chats": [], "zone": "UTC", "day_start_hour": 4]
        let people = try decoded(HomeLink.People.self, list)
        let you = try XCTUnwrap(people.you, "the owner, beside the list")
        XCTAssertEqual(you.me, true)
        XCTAssertEqual(you.suggested, 2)
        XCTAssertEqual(you.alsoCalled, [.init(name: "Sammy", from: "You added")])
        XCTAssertEqual(you.handles.map(\.own), [true, true])
        XCTAssertEqual(you.handles.map(\.from), ["Your iMessage and WhatsApp", "Your Gmail"])
        XCTAssertEqual(you.joined, [], "a list's person names no one joined")
        XCTAssertEqual(try decoded(HomeLink.People.self, list).you, you)
        XCTAssertEqual(try JSONDecoder().decode(HomeLink.People.self, from: JSONEncoder().encode(people)), people, "the kept copy")
        var none = list
        none["you"] = NSNull()
        XCTAssertNil(try decoded(HomeLink.People.self, none).you, "a home with no You")
        none.removeValue(forKey: "you")
        XCTAssertNil(try decoded(HomeLink.People.self, none).you, "a copy kept before it")

        let me = try decoded(HomeLink.Person.self, served["me"]!)
        XCTAssertEqual(me.id, you.id, "?id=me answers You")
        XCTAssertNil(me.suggested, "on the list's You alone")
        XCTAssertEqual(me.suggestions?.map(\.kind), ["handle", "same"])
        let person = try decoded(HomeLink.Person.self, served["person"]!)
        XCTAssertEqual(person.alsoCalled, [.init(name: "Big Riley", from: "You added"), .init(name: "Bear", from: "Contacts")])
        XCTAssertEqual(person.handles.map(\.own), [false, false, false, false])
        XCTAssertEqual(person.joined, [
            .init(id: "person:riley-work", name: "Riley Work", photo: nil,
                  handles: ["phone:+15550000022", "phone:+15550000023", "email:riley@work.example"], with: ["Riley Old"]),
            .init(id: "person:riley-old", name: "Riley Old", photo: nil, handles: ["phone:+15550000023"], with: []),
        ], "in merge order")
        XCTAssertEqual(try JSONDecoder().decode(HomeLink.Person.self, from: JSONEncoder().encode(person)), person, "the kept copy")

        let before = try decoded(HomeLink.People.self, try JSONSerialization.jsonObject(with: Data(Answers.people.utf8)))
        XCTAssertEqual(before.people[0].alsoCalled, [], "a person from before them reads none")
        XCTAssertEqual(before.people[0].joined, [])
        XCTAssertNil(before.people[0].suggested)
        XCTAssertEqual(before.people[0].handles.map(\.own), [false], "a handle from before it is not the owner's")
    }

    func testAConfirmSaysTheNamesAddedAndTakenOffAndWhoIsSplitOffOnlyWhenAny() throws {
        var confirm = HomeLink.Confirm(id: "person:riley")
        let quiet = try JSONSerialization.jsonObject(with: HomeLink.OwnerAction.people(request: "r-1", .confirm(confirm)).body()) as! [String: Any]
        XCTAssertEqual(Set(quiet.keys), ["id", "kind", "of", "request"], "nothing said while empty")
        confirm.addNames = ["Big Riley"]
        confirm.removeNames = ["Bear"]
        confirm.split = ["person:riley-old"]
        let said = try JSONSerialization.jsonObject(with: HomeLink.OwnerAction.people(request: "r-1", .confirm(confirm)).body()) as! [String: Any]
        XCTAssertEqual(said["add_names"] as? [String], ["Big Riley"])
        XCTAssertEqual(said["remove_names"] as? [String], ["Bear"])
        XCTAssertEqual(said["split"] as? [String], ["person:riley-old"])
    }

    func testTheListReadAfterAnActionSaysWherePeopleStood() async throws {
        let (link, _, _) = try await paired([
            .reply(200, Answers.people, ["Lifestream-Position": "12:1792060000000"]),
        ])
        let read = try await link.peopleAt()
        XCTAssertEqual(read.position, HomeLink.Position("12:1792060000000"), "the header's")
        XCTAssertEqual(read.value.people.count, 2)
    }

    func testAPersonsDetailsAndTheirPhotosRead() async throws {
        let (link, transport, _) = try await paired([
            .reply(200, Answers.detailedPeople), .reply(200, Answers.detailedPerson), .reply(200, Answers.person),
            .reply(200, Answers.personPhotos, ["ETag": "\"p-1\""]), .reply(304, ""),
            .reply(200, #"{"position":"0:9","photos":[],"total":62}"#), .reply(200, #"{"position":"0:9","photos":[]}"#),
            .reply(404, #"{"code":"PERSON_UNKNOWN","message":"no person person:nobody"}"#),
        ])
        let people = try await link.people()
        XCTAssertEqual(people.people.map(\.relationship), ["Friend from college", nil])
        XCTAssertEqual(people.people.map(\.work), ["Product designer, Lumen Labs", nil], "the list's work, only where held")
        XCTAssertEqual(people.people.map(\.details), [nil, nil], "the list carries no details")
        let kept = try JSONDecoder().decode(HomeLink.People.self, from: JSONEncoder().encode(people))
        XCTAssertEqual(kept, people, "the kept copy carries them")

        let person = try await link.person(id: "person:person-a").value
        let details = try XCTUnwrap(person.details)
        XCTAssertEqual(details.work, "Product designer, Lumen Labs")
        XCTAssertEqual(details.birthday, .init(month: 8, day: 14, year: nil), "a birthday with no year")
        XCTAssertEqual(details.profiles, [.init(network: "instagram", value: "person.a"), .init(network: "site", value: "example.com/person-a")])
        XCTAssertEqual(person.relationship, "Friend from college")
        let none = try await link.person(id: "person:person-a").value
        XCTAssertNil(none.details, "a person with no details statement")
        XCTAssertNil(none.relationship)

        let firstRead = try await link.personPhotos(id: "person:person-a")
        let first = try XCTUnwrap(firstRead)
        XCTAssertEqual(first.etag, "\"p-1\"")
        XCTAssertEqual(first.value.photos.map(\.atMs), [1792041000000, nil], "newest first, an untimed photo last")
        XCTAssertEqual(first.value.photos[0].box, [1193, 260, 1307, 404.5])
        XCTAssertEqual(first.value.photos[0].blob, "sha256:" + String(repeating: "ab", count: 32), "the whole photo, by its hex named")
        XCTAssertEqual(first.value.photos[0].face, String(repeating: "ab", count: 32) + ":1193,260,1307,405")
        XCTAssertEqual(first.value.next, "NjA=")
        XCTAssertEqual(first.value.total, 62, "how many the home holds of them")
        let same = try await link.personPhotos(id: "person:person-a", etag: first.etag)
        XCTAssertNil(same, "unchanged, nothing sent again")
        let lastRead = try await link.personPhotos(id: "person:person-a", after: first.value.next)
        let last = try XCTUnwrap(lastRead).value
        XCTAssertTrue(last.photos.isEmpty)
        XCTAssertNil(last.next, "the last page names none")
        do { _ = try await link.personPhotos(id: "person:person-a"); XCTFail("a page that states no count reads") } catch LinkFailure.unreadable {}
        XCTAssertEqual(transport.requests[3].url.path, "/v1/people/photos")
        XCTAssertEqual(transport.requests[3].url.query, "id=person%3Aperson-a")
        XCTAssertEqual(transport.requests[4].headers["If-None-Match"], "\"p-1\"")
        XCTAssertEqual(transport.requests[5].url.query, "id=person%3Aperson-a&after=NjA%3D")

        do { _ = try await link.personPhotos(id: "person:nobody"); XCTFail("no person") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .refused(status: 404, code: "PERSON_UNKNOWN", message: "no person person:nobody"))
        }
    }

    func testEachShapeReadsAndIgnoresWhatItDoesNotKnow() async throws {
        let (link, _, _) = try await paired([
            .reply(200, Answers.days), .reply(200, Answers.whereAt), .reply(200, Answers.wherePieces), .reply(200, Answers.whereSummaries),
            .reply(200, Answers.countFirst), .reply(200, Answers.people), .reply(200, Answers.person),
            .reply(200, Answers.connectors), .reply(200, Answers.status), .reply(200, Answers.extracts), .reply(200, Answers.record),
            .reply(200, Answers.devices), .reply(200, Answers.wanted),
        ])
        let days = try await link.days()
        XCTAssertEqual(days.days.map(\.day), ["2026-10-13", "2026-10-14"])
        XCTAssertEqual(days.days[1].counts.perFamily["messages"], 12)
        XCTAssertEqual(days.next, "IjIwMjYtMTAtMTQi")

        let asked = try await link.where(at: Date())
        let at = try XCTUnwrap(asked).value
        XCTAssertEqual(at.piece.kind, .gap)
        XCTAssertNil(at.piece.level, "a gap nothing reaches has no level, point or how")
        XCTAssertNil(at.piece.how)
        XCTAssertEqual(at.before?.names.point?.words, "an unnamed place 1.8 km from Home")
        XCTAssertEqual(at.before?.spot, "spot:19.0912,72.8501", "a stay in a spot worth naming carries its key")
        XCTAssertNil(at.piece.spot, "a gap carries no spot")
        XCTAssertNil(at.after)

        let laid = try await link.where(from: .day("2026-10-14"), to: .day("2026-10-14"))
        let pieces = try XCTUnwrap(laid).value
        XCTAssertEqual(pieces.pieces.map(\.kind), [.stay, .move])
        XCTAssertEqual(pieces.pieces[0].open, nil)
        XCTAssertEqual(pieces.pieces[0].names.point?.area.city, "Synthetic Town")
        XCTAssertEqual(pieces.pieces[0].how, .observed)
        XCTAssertEqual(pieces.pieces[0].by, "Phone")
        XCTAssertEqual(pieces.pieces[1].legs?.first?.mode, "walk")
        XCTAssertEqual(pieces.pieces[1].names.to?.words, "The Office")
        XCTAssertEqual(pieces.pieces[1].distanceM, 1800)
        XCTAssertNil(pieces.pieces[0].spot, "a stay at an owner place: spot null")
        XCTAssertNil(pieces.pieces[1].spot, "a move carries no spot")

        let summarised = try await link.where(from: .day("2026-01-01"), to: .day("2026-12-31"), grain: .month)
        let summaries = try XCTUnwrap(summarised).value
        XCTAssertEqual(summaries.grain, .month)
        let month = try XCTUnwrap(summaries.summaries.first)
        XCTAssertEqual(month.base, HomeLink.Where.Base(city: "Synthetic Town", nights: 28))
        XCTAssertEqual(month.trips.first?.cities, ["Synthetic City"])
        XCTAssertEqual(month.places.first?.slug, "home-place")
        XCTAssertNil(month.places.last?.slug, "an unnamed place has no slug")
        XCTAssertEqual(month.cities.first?.guessedNights, 1)
        XCTAssertEqual(month.coverage.nightsUnknown, ["2026-09-03"])

        let counted = try await link.count(HomeLink.CountQuery(of: "calls"))
        XCTAssertNil(counted.total, "6: a count that states no total")
        XCTAssertEqual(counted.n, counted.population.facts, "6: counts the facts of its population")

        let people = try await link.people()
        XCTAssertEqual(people.people.map(\.id), ["person:person-a", "whatsapp:+15550000009"])
        XCTAssertEqual(people.people[0].handles.first, .init(id: "phone:+15550000001", kind: "phone", network: nil, words: "+1 555 000 0001", from: nil))
        XCTAssertEqual(people.people[0].last30, 14)
        XCTAssertEqual(people.people[0].chats, [.init(key: "whatsapp:15550000001@s.whatsapp.net", count: 7),
                                                .init(key: "whatsapp:120363000000000001@g.us", count: 3)])
        XCTAssertNil(people.people[0].days, "the list carries no days")
        XCTAssertNil(people.people[1].person, "below the registry, no slug")
        XCTAssertNil(people.people[1].firstMs)
        XCTAssertEqual(people.chats.map(\.group), [false, true])

        let person = try await link.person(id: "person:person-a").value
        XCTAssertEqual(person.days, ["2026-10-13": 4, "2026-10-14": 10])
        XCTAssertEqual(person.daysCount, 2)

        let answered = try await link.page(HomeLink.PageKey("/v1/connectors", link.unit.map { ["unit": $0] } ?? [:]), etag: nil)
        let connectors = try JSONDecoder().decode(HomeLink.StreamsReport.self, from: try XCTUnwrap(answered).value)
        XCTAssertEqual(connectors, try JSONDecoder().decode(HomeLink.StreamsReport.self, from: Data(contentsOf: ReportTests.fixture)),
                       "the door's answer is the report and its position")

        let status = try await link.status()
        XCTAssertEqual(status.needs.map(\.id), ["password:gmail.password", "fetch:whoop", "offer:claude:person-b@example.com:browser", "disk"],
                       "the home's one list, in its order")
        XCTAssertEqual(status.needs[0].acts.map(\.member), ["password"], "a Set names its member")
        XCTAssertEqual(status.needs[1].nextMs, 1_792_060_720_000)
        XCTAssertEqual(status.needs[1].acts.map(\.need), ["fetch:whoop"], "a try names its need")
        XCTAssertEqual(status.needs[2].acts.map(\.do), [.read, .ignore], "an offer's two acts, in the home's order")
        XCTAssertEqual(status.needs[2].acts.map(\.of), ["claude:user-synthetic0004:browser", "claude:user-synthetic0004:browser"], "the source the offer makes")
        XCTAssertEqual(status.needs[3].acts, [], "a need the home offers no button on")
        XCTAssertEqual(status.today.first?.counts["msg"], 41)
        XCTAssertEqual(status.paused.first?.holds, ["gmail-imap"])
        XCTAssertEqual(status.report["disk"]?["days_left"]?.number, 212, "what a phone does not type is kept")

        let extracts = try await link.extracts(family: "health", unit: "sleep/whoop:person-a@example.com:cloud/41")
        XCTAssertEqual(extracts.first?.content["nap"]?.bool, false)

        let record = try await link.record(source: "whatsapp:15550000000:phone-aa01", kind: "msg", key: "m157")
        XCTAssertEqual(record.version?.content["text"]?.string, "message 157")
        XCTAssertEqual(record.blobs, ["sha256:" + String(repeating: "ab", count: 32)])
        XCTAssertEqual(record.text?.who, ["whatsapp:+15550000001"])

        let cameras = try await link.devices()
        XCTAssertEqual(cameras.map(\.mine), [true, false])
        XCTAssertEqual(cameras[0].word, .init(mine: true, from: "2025-03-01", to: nil))
        XCTAssertNil(cameras[1].make)

        let wanted: Wanted = try await link.photosWanted(source: "apple-photos:person-a@example.com:iphone-aa01")
        XCTAssertEqual(wanted, .init(photos: [.init(asset: "B2C3D4E5-0000-4000-8000-000000000002/L0/001", files: ["pairedVideo"])],
                                     left: .init(wanted: 3, unavailable: 1, bytes: 1_998_035)))
    }

    func testAPlaceReadsWholeAndItsPhotosPageAfterPage() async throws {
        let (link, transport, _) = try await paired([
            .reply(200, Answers.place), .reply(200, Answers.placeOnce),
            .reply(200, Answers.placePhotos), .reply(200, #"{"position":"0:9","photos":[]}"#),
            .reply(404, #"{"code":"PLACE_UNKNOWN","message":"no place nowhere-000000"}"#),
        ])
        let officeRead = try await link.place(slug: "the-office")
        let office = try XCTUnwrap(officeRead).value
        XCTAssertEqual(office.name, "The Office")
        XCTAssertEqual(office.radiusM, 90)
        XCTAssertEqual(office.also, [.init(latitude: 37.3245, longitude: -122.0031, radiusM: 60),
                                     .init(latitude: 37.3199, longitude: -121.998, radiusM: 40)], "its other circles, in the order added")
        XCTAssertEqual(office.area.city, "Synthetic Town")
        XCTAssertEqual(office.home, true)
        XCTAssertEqual([office.visitsCount, office.nights, office.days, office.photosCount], [3, 0, 3, 14])
        XCTAssertTrue(office.here)
        XCTAssertNil(office.askHome, "not asked")
        XCTAssertEqual(office.partOf, .init(slug: "campus-0a1b2c", name: "The Campus"))
        XCTAssertEqual(office.inside, [.init(slug: "desk-3d4e5f", name: "The Desk")])
        XCTAssertEqual(office.rhythm, "3 days here since Oct 2026 · usually Tue and Thu evenings")
        XCTAssertEqual(office.visits.map(\.startMs), [1792040000000, 1791950000000, 1791860000000], "newest first, as the door lays them")
        XCTAssertEqual(office.visits[0].unit, "stay/location:local:iphone-aa01/1791950000000")
        XCTAssertEqual(office.visits[1].unit, office.visits[0].unit, "one stay cut in two")
        XCTAssertNotEqual(office.visits[1].id, office.visits[0].id, "two visits of one stay are two")
        XCTAssertEqual(office.visits[0].day, "2026-10-14")
        XCTAssertEqual(office.visits[1].people, ["person:person-a", "phone:+15550000002"])
        XCTAssertEqual(office.visits[0].centre, .init(latitude: 37.3221, longitude: -122.0012), "where the visit was")
        XCTAssertNil(office.visits[1].centre, "a home that does not say it yet")
        XCTAssertEqual(office.visits[0].focus, "u:stay/location:local:iphone-aa01/1791950000000@1792040000000-1792046000000", "a visit opens its day where the home says")
        XCTAssertEqual(office.people.map(\.id), ["person:person-a", "phone:+15550000002"])
        XCTAssertEqual(office.people.first?.days, 2)
        XCTAssertEqual(office.people.map(\.photo), [.init(crop: "sha256:" + String(repeating: "ef", count: 32), card: nil),
                                                    .init(crop: nil, card: "sha256:" + String(repeating: "cd", count: 32))])
        XCTAssertEqual(office.photos.first?.blob, "sha256:" + String(repeating: "ab", count: 32), "a photo's blob is its hex, named")

        let onceRead = try await link.place(slug: "corner-bakery-1a2b3c")
        let once = try XCTUnwrap(onceRead).value
        XCTAssertNil(once.home, "never asked")
        XCTAssertEqual(once.also, [], "one circle")
        XCTAssertNil(once.partOf)
        XCTAssertNil(once.rhythm, "below the bar")
        XCTAssertEqual(once.area, .init(city: nil, cityID: nil, region: nil, country: nil, countryCode: nil), "an area that knows nothing")
        XCTAssertEqual(once.askHome, "You’ve slept here 3 nights, since Monday.", "the home's why-line, as it says it")
        XCTAssertEqual(once.visits.count, 1)
        XCTAssertNil(once.people.first?.photo, "a person with no photo")

        let firstRead = try await link.placePhotos(slug: "the-office")
        let first = try XCTUnwrap(firstRead).value
        XCTAssertEqual(first.photos.map(\.atMs), [1792041000000, 1791951000000])
        XCTAssertEqual(first.next, "Mg==")
        let lastRead = try await link.placePhotos(slug: "the-office", after: first.next)
        let last = try XCTUnwrap(lastRead).value
        XCTAssertTrue(last.photos.isEmpty)
        XCTAssertNil(last.next, "the last page names none")
        XCTAssertEqual(transport.requests[3].url.query, "slug=the-office&after=Mg%3D%3D")

        do { _ = try await link.place(slug: "nowhere-000000"); XCTFail("no place") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .refused(status: 404, code: "PLACE_UNKNOWN", message: "no place nowhere-000000"))
        }
    }

    func testTheSuggestionsReadWithAndWithoutTheirIdAndWhy() async throws {
        let (link, _, _) = try await paired([.reply(200, Answers.suggest)])
        let names = try await link.suggest(spot: "spot:37.3187,-122.009")
        XCTAssertEqual(names, .init(suggestions: [
            .init(name: "Lantern Noodle Bar", id: "google:lantern", distanceM: 24,
                  why: .init(product: "Calendar", family: "calendar", atMs: 1792001400000, tier: 3)),
            .init(name: "Kiln Coffee", slug: "kiln-coffee-3f9a2c", distanceM: 40),
            .init(name: "Lantern Park", id: "google:park", distanceM: 90),
            .init(name: "Harbour Deli", distanceM: 120, why: .init(product: "Files", family: nil, atMs: 1791990000000, tier: 2)),
        ]), "best first; an own place by its slug, a name no record named has no why, a record no family read has no family; "
            + "asked with no words, no word of who answers words typed")
    }

    func testATypedAskReadsItsProvidersNeedAndANameWithNoDistance() async throws {
        let need = #"{"words":"Names from Google Places come once Lifestream holds a key","act":{"do":"set","label":"Add key","connector":"google-places","member":"key","later":1}}"#
        let (link, _, _) = try await paired([
            .reply(200, Answers.suggestTyped),
            .reply(200, #"{"position":"0:9","suggestions":[],"provider":{"name":"Google Places","need":\#(need)}}"#),
            .reply(404, #"{"code":"SPOT_UNKNOWN","message":"no spot spot:1,2 in the list"}"#),
        ])
        let typed = try await link.suggest(spot: "spot:37.3187,-122.009", q: "Kiln")
        XCTAssertEqual(typed.provider, .init(name: "Google Places"), "answered: nothing needed")
        XCTAssertEqual(typed.suggestions, [
            .init(name: "Kiln Coffee", slug: "kiln-coffee-3f9a2c", distanceM: 400),
            .init(name: "Kiln Bakery", id: "google:kiln-bakery", distanceM: nil),
        ], "an own place far off, then Google's with no distance")
        let none = try await link.suggest(spot: "spot:37.3187,-122.009", q: "Kiln")
        XCTAssertEqual(none.provider, .init(name: "Google Places", need: .init(words: "Names from Google Places come once Lifestream holds a key",
            act: .init(do: "set", label: "Add key", connector: "google-places", member: "key"))), "the home's words and its act, a member it adds aside")
        do { _ = try await link.suggest(spot: "spot:1,2"); XCTFail("the list moved") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .refused(status: 404, code: "SPOT_UNKNOWN", message: "no spot spot:1,2 in the list"))
        }
    }

    func testTheListsSpotsReadWhatTheCardDraws() throws {
        let spots = try HomeLink.Places.spots(in: Data(Answers.places.utf8))
        XCTAssertEqual(spots.map(\.latitude), [37.3215, 37.31], "the home's asking order")
        let worth = spots[0]
        XCTAssertTrue(worth.worth)
        XCTAssertEqual(worth.key, "spot:37.3215,-122.0126", "the key as the home spells it")
        XCTAssertEqual(worth.witnessed, "You took 14 photos here on 16 days between 2019 and 2026.")
        XCTAssertEqual(worth.last, "Last time Tue 20 Oct 2026 from 14:10 to 15:30", "the home's sentence, as it is")
        XCTAssertEqual(worth.photos.map(\.blob), ["sha256:" + String(repeating: "ab", count: 32), "sha256:" + String(repeating: "cd", count: 32)])
        XCTAssertEqual(worth.photosCount, 14)
        XCTAssertEqual([worth.stays, worth.days], [21, 16])
        XCTAssertEqual(worth.lastMs, 1792040000000)
        XCTAssertEqual(worth.area?.city, "Synthetic Town")
        let plain = spots[1]
        XCTAssertFalse(plain.worth)
        XCTAssertNil(plain.key, "a spot not worth naming carries nothing the card draws")
        XCTAssertNil(plain.witnessed)
        XCTAssertNil(plain.last)
        XCTAssertEqual(plain.photos, [])
        XCTAssertEqual(plain.photosCount, 0)
        XCTAssertEqual(try HomeLink.Places.spots(in: Data(#"{"position":"0:9","places":[]}"#.utf8)), [], "a list with no spots")
        XCTAssertThrowsError(try HomeLink.Places.spots(in: Data(#"{"spots":[{"key":"spot:1,2"}]}"#.utf8))) { error in
            XCTAssertEqual(error as? LinkFailure, .unreadable(200))
        }
    }

    func testTheListsHiddenSpotsReadAndAHomeBeforeThemHasNone() throws {
        let hidden = try HomeLink.Places.hidden(in: Data(Answers.places.utf8))
        XCTAssertEqual(hidden.map(\.key), ["hidden-3f9a2c", "hidden-0b1c2d"])
        XCTAssertEqual(hidden[0].latitude, 37.3412)
        XCTAssertEqual(hidden[0].longitude, -122.0215)
        XCTAssertEqual(hidden[0].hiddenMs, 1792000000000)
        XCTAssertEqual(hidden[0].days, 4)
        XCTAssertEqual(hidden[0].nearest, .init(name: "Harbour Home", distanceM: 210))
        XCTAssertNil(hidden[1].nearest, "no named place near it")
        XCTAssertEqual(try HomeLink.Places.hidden(in: Data(#"{"position":"0:9","places":[],"spots":[]}"#.utf8)), [],
                       "a home before hidden spots")
        XCTAssertThrowsError(try HomeLink.Places.hidden(in: Data(#"{"hidden":[{"key":"hidden-3f9a2c"}]}"#.utf8))) { error in
            XCTAssertEqual(error as? LinkFailure, .unreadable(200))
        }
    }

    func testAPhotosFactsReadWholeAndAChatsImageWithOnlyWhatTheHomeKnows() async throws {
        let library = "sha256:" + String(repeating: "ab", count: 32), received = "sha256:" + String(repeating: "cd", count: 32)
        let (link, transport, _) = try await paired([
            .reply(200, Answers.libraryPhoto), .reply(200, Answers.chatImage),
            .reply(404, #"{"code":"PHOTO_UNKNOWN","message":"no burst and no message names it"}"#),
        ])
        let photo = try await link.photo(library)
        XCTAssertEqual(transport.requests[0].url.path, "/v1/photos/" + library, "the hash in the path, as the door reads it")
        XCTAssertEqual(photo.hash, library)
        XCTAssertEqual(photo.kind, "photograph")
        XCTAssertEqual(photo.atMs, 1_792_000_000_000)
        XCTAssertEqual(photo.unit, "burst/1791999990000")
        XCTAssertEqual(photo.caption, "Two friends on a terrace at sunset.")
        XCTAssertEqual(photo.people.map(\.id), ["person:person-a", "person:me"], "left to right, as the door orders them")
        XCTAssertEqual(photo.people[0].box, [1193, 260, 1307, 404.5])
        XCTAssertEqual(photo.people[0].photo, .init(crop: "sha256:" + String(repeating: "ef", count: 32), card: nil))
        XCTAssertEqual(photo.people.map(\.me), [false, true])
        XCTAssertNil(photo.people[1].box, "a face with no box")
        XCTAssertNil(photo.people[1].photo, "a person with no photo")
        XCTAssertEqual(photo.size, .init(width: 4032, height: 3024))
        let place = try XCTUnwrap(photo.place)
        XCTAssertEqual([place.slug, place.name], ["harbour-terrace", "Harbour Terrace"])
        XCTAssertEqual([place.latitude, place.longitude, place.radiusM], [37.32, -122.0, 60])
        XCTAssertEqual(place.area, .init(city: "Synthetic Town", region: "Synthetic Region", country: "Synthetic Country"))
        XCTAssertNil(photo.area, "the place's area, not the photo's")
        XCTAssertEqual(photo.camera, .init(id: "apple/iphone-17-pro", name: "iPhone 17 Pro", mine: true))
        XCTAssertEqual(photo.from, "phone")
        XCTAssertNil(photo.chat)

        let image = try await link.photo(received)
        XCTAssertEqual(image.kind, "image")
        XCTAssertNil(image.unit, "no burst holds a chat's image")
        XCTAssertNil(image.caption)
        XCTAssertNil(image.size)
        XCTAssertNil(image.place)
        XCTAssertNil(image.camera)
        XCTAssertNil(image.from)
        XCTAssertNil(image.area, "a chat's image has no area: the cameras labeler reads no chat source")
        let chat = try XCTUnwrap(image.chat)
        XCTAssertEqual([chat.network, chat.chat, chat.title, chat.day], ["whatsapp", "whatsapp:15550000001@s.whatsapp.net", "Person A", "2026-10-11"])
        XCTAssertFalse(chat.group)
        XCTAssertFalse(chat.mine)
        XCTAssertEqual(chat.sender, .init(id: "person:person-a", name: "Person A"))
        XCTAssertEqual(chat.atMs, 1_792_000_100_000)
        XCTAssertEqual(chat.record, .init(source: "whatsapp:15550000000:phone-aa01", kind: "msg", key: "m 1/2"), "the message the link opens")

        do { _ = try await link.photo(library); XCTFail("no photo") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .refused(status: 404, code: "PHOTO_UNKNOWN", message: "no burst and no message names it"))
        }
        do { _ = try await link.photo(String(repeating: "ab", count: 32)); XCTFail("a hash of another shape") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unusableID, "never asked")
        }
        XCTAssertEqual(transport.requests.count, 3)
    }

    func testAGoneRecordHasNoVersionAndNoWords() async throws {
        let gone = #"{"position":"0:3","source":"s","kind":"msg","key":"m1","head":{"version":null,"stated_ms":1,"since_ms":1,"start_ms":null,"end_ms":null},"version":null,"blobs":[],"text":null}"#
        let (link, _, _) = try await paired([.reply(200, gone)])
        let record = try await link.record(source: "s", kind: "msg", key: "m1")
        XCTAssertNil(record.version)
        XCTAssertNil(record.text)
        XCTAssertEqual(record.body, Data(gone.utf8), "the raw view shows the door's answer exactly as it came")
    }

    func testChatLabelsCarryTheirOpenInAndTheProductsAreRead() async throws {
        let chats = #"{"names":[],"chats":[["example-chat:12345","Person A",false,{"label":"Open in Example Chat","href":"https://chat.example.com/12345"}],["example-chat:g1",null,true,null]],"places":[]}"#
        let products = #"{"digest":"sha256:aa","products":{"example-chat":{"name":"Example Chat","row":"Example Chat","vendor":"example","icon":"messages","type":"messages","connector":"example-chat"}}}"#
        let (link, transport, _) = try await paired([.reply(200, chats), .reply(200, products)])
        let labels = try await link.chats(["example-chat:12345", "example-chat:g1"])
        XCTAssertEqual(labels.map(\.key), ["example-chat:12345", "example-chat:g1"])
        XCTAssertEqual(labels.map(\.open?.label), ["Open in Example Chat", nil], "a one-to-one chat's, none for a group")
        XCTAssertEqual(labels.first?.open?.href, "https://chat.example.com/12345")
        XCTAssertEqual(labels.map(\.title), ["Person A", nil])
        XCTAssertEqual(labels.map(\.group), [false, true])
        let read = try await link.products()
        XCTAssertEqual(read.digest, "sha256:aa")
        XCTAssertEqual(read.products["example-chat"]?.row, "Example Chat")
        XCTAssertEqual(transport.requests.map(\.url.path), ["/v1/labels", "/v1/products"])
        XCTAssertEqual(URLComponents(url: transport.requests[0].url, resolvingAgainstBaseURL: false)?.queryItems?.map(\.value),
                       ["example-chat:12345", "example-chat:g1"], "each key asked as typed")
    }


    static let contract = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("packages/home/test/contract")

    private static func fixture(_ name: String) throws -> Data {
        try Data(contentsOf: contract.appendingPathComponent(name + ".json"))
    }

    private static func written(_ name: String) throws -> [String: Any] {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: fixture(name)) as? [String: Any])
    }

    func testEverySearchAndDescribeAnswerOfTheContractDecodes() throws {
        let names = try FileManager.default.contentsOfDirectory(atPath: Self.contract.path).filter { $0.hasSuffix(".json") }.sorted()
        let searches = names.filter { $0.hasPrefix("search") }
        XCTAssertEqual(searches.count, 8, "every search fixture, none passed over: \(searches)")
        for name in searches {
            XCTAssertNoThrow(try JSONDecoder().decode(HomeLink.SearchAnswer.self, from: Data(contentsOf: Self.contract.appendingPathComponent(name))), name)
        }
        XCTAssertNoThrow(try JSONDecoder().decode(HomeLink.Described.self, from: Self.fixture("describe")))
        XCTAssertNoThrow(try JSONDecoder().decode([String: HomeLink.Citation].self, from: Self.fixture("citations")))
    }

    func testACitedVoiceNoteReadsItsAudioItsRecordAndWhatTheSourceStatesAndAPlainCitationHasNone() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Fixtures/describe-voice.json"))
        let described = try JSONDecoder().decode(HomeLink.Described.self, from: data).described
        XCTAssertEqual(described.map(\.kind), [.message, .record, .line, .message], "every citation read, none left out")

        let whatsapp = try XCTUnwrap(described[0].voice)
        XCTAssertEqual(whatsapp, .init(audio: "sha256:" + String(repeating: "0", count: 63) + "1", record: described[0].ref, seconds: 23, from: "Person A"))
        XCTAssertFalse(whatsapp.mine)

        let recording = try XCTUnwrap(described[1].voice)
        XCTAssertEqual(recording.seconds, 0, "a length of 0 is a length")
        XCTAssertTrue(recording.mine)
        XCTAssertNil(recording.from, "the person's own note names no one")

        let line = try XCTUnwrap(described[2].voice)
        XCTAssertNil(line.seconds, "a source that states no length")
        XCTAssertNotEqual(line.record, described[2].ref, "a line's note is its own record, never the line")
        XCTAssertTrue(line.record.hasPrefix("record."))

        XCTAssertNil(described[3].voice, "a citation with no voice reads as before")

        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: [[String: Any]]])
        var unrecorded = try XCTUnwrap(object["described"]?[0])
        unrecorded["voice"] = ["audio": whatsapp.audio, "seconds": 23]
        let refused = try JSONSerialization.data(withJSONObject: ["described": [unrecorded, object["described"]![3]]])
        XCTAssertEqual(try JSONDecoder().decode(HomeLink.Described.self, from: refused).described.map(\.ref), [described[3].ref],
                       "a voice with no record is refused, its citation with it")

        let kept = try JSONSerialization.data(withJSONObject: object["described"]![0])
        XCTAssertEqual(try JSONDecoder().decode(HomeLink.Ask.Cited.self, from: kept).citation?.voice, whatsapp,
                       "a turn keeps its cited note as the describe drew it")
    }

    func testTheContractsSearchReadsWhatAPageDraws() throws {
        let decoder = JSONDecoder()
        let answer = try decoder.decode(HomeLink.SearchAnswer.self, from: Self.fixture("search"))
        let record = try XCTUnwrap(answer.record)
        XCTAssertEqual(record.total, 10000)
        XCTAssertEqual(record.capped, true, "a capped total is at least, never exact")
        XCTAssertEqual(record.reached, .init(side: .newest, at: "2026-09-03T14:22+01:00", whole: "2026-09-04"))
        XCTAssertEqual(record.next, "cursor:record:k1")
        XCTAssertNil(record.order, "a page by rank")
        XCTAssertEqual(record.spread?.months["2026-09"], .init(n: 120, partial: true), "a month counted in part says so")
        XCTAssertEqual(record.spread?.months["2026-10"], .init(n: 310))
        XCTAssertEqual(record.spread?.families["messages"]?.n, 9200)
        XCTAssertEqual(record.hits.map(\.at), ["2026-10-04T09:15+01:00", "2026-10-02T18:40+01:00", nil], "a date stays a date")
        XCTAssertEqual(record.hits.map(\.chatTitle), ["Person A", nil, nil])
        XCTAssertEqual(record.hits.map(\.picture), [1, nil, nil])
        XCTAssertEqual(record.hits.map(\.more), [nil, true, nil])

        let counted = try decoder.decode(HomeLink.Counted.self, from: Self.fixture("count"))
        XCTAssertEqual(counted.n, 7, "6: a count's total")
        XCTAssertEqual(counted.asked, "sum of amount over payments, by item")
        XCTAssertEqual(try decoder.decode(HomeLink.Counted.self, from: Self.fixture("count-by-month")).n, 58, "a count by month, its total")

        let unread = try decoder.decode(HomeLink.SearchAnswer.self, from: Self.fixture("search-unread"))
        XCTAssertEqual(unread.person?.map(\.name), ["Person A"], "one person a value, by ref and name")
        XCTAssertEqual(unread.record?.pending, [.init(day: "2026-11-14", why: .new)])
        XCTAssertEqual(unread.record?.held, .init(first: "2019-02-01", last: "2026-11-13"))
        XCTAssertNil(unread.record?.capped)

        let waits = try decoder.decode(HomeLink.SearchAnswer.self, from: Self.fixture("search-screen-next"))
        XCTAssertNil(waits.record, "a cursor answers its list alone")

        let byTime = try XCTUnwrap(try decoder.decode(HomeLink.SearchAnswer.self, from: Self.fixture("search-record-by-time")).record)
        XCTAssertEqual(byTime.order, .newest)
        XCTAssertEqual(byTime.pending?.count, 100)
        XCTAssertEqual(byTime.pendingMore, 30, "the days still read past the 100 named")
    }

    func testAReadOpensWhatItsRefNames() throws {
        let decoder = JSONDecoder()
        guard case .row(let row) = try decoder.decode(HomeLink.Read.Answer.self, from: Self.fixture("read-row")) else { return XCTFail("a row") }
        XCTAssertEqual(row.n, 7)
        XCTAssertEqual(row.now, 8, "a row opened after the record moved states both counts")
        let rows = try XCTUnwrap(try Self.written("read-row")["rows"] as? [[Any]])
        XCTAssertEqual(row.rows.first?.last, .string(try XCTUnwrap(rows.first?.last as? String)), "each fact ends with its ref")
        XCTAssertEqual(try decoder.decode(HomeLink.Read.Answer.self, from: Self.fixture("read-gone")), .gone)
        XCTAssertThrowsError(try decoder.decode(HomeLink.Read.Answer.self, from: Data(#"{"what":"map","ref":"x"}"#.utf8)),
                             "a kind no build knows is no answer")
    }

    func testASearchIsAskedWithTheContractsParameters() async throws {
        let body = String(decoding: try Self.fixture("search"), as: UTF8.self)
        let (link, transport, _) = try await paired([.reply(200, body), .reply(200, body), .reply(200, body)])
        let read = try await link.search(HomeLink.SearchQuery(query: "corner, cafe", from: "2026-10-01", to: "2026-10-31T18:00+01:00",
                                                                families: ["messages", "mail"], person: ["Person A, Jr", "person:p1"],
                                                                order: .newest, limit: 20, lists: [.record], typing: true))
        guard case .answer(let answer) = read else { return XCTFail("an answer") }
        XCTAssertEqual(answer.record?.hits.count, 3)
        let items = try XCTUnwrap(URLComponents(url: transport.requests[0].url, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(transport.requests[0].url.path, "/v1/search")
        XCTAssertEqual(items.map(\.name), ["query", "from", "to", "families", "families", "person", "person", "order", "limit",
                                           "lists", "typing"])
        XCTAssertEqual(items.map(\.value), ["corner, cafe", "2026-10-01", "2026-10-31T18:00+01:00", "messages", "mail",
                                            "Person A, Jr", "person:p1", "newest", "20", "record", "1"],
                       "each value whole, a name with a comma one person, an offset's plus as typed")
        _ = try await link.search(HomeLink.SearchQuery(cursor: "cursor:screen:s1"))
        XCTAssertEqual(transport.requests[1].url.query, "cursor=cursor%3Ascreen%3As1", "a cursor alone")
        _ = try await link.search(HomeLink.SearchQuery(person: ["person:p1"]))
        XCTAssertEqual(transport.requests[2].url.query, "person=person%3Ap1", "no `query`, no `typing` when not typing")
    }

    func testARefIsReadOnItsRouteAndARefusalKeepsItsCode() async throws {
        let (link, transport, _) = try await paired([
            .reply(200, String(decoding: try Self.fixture("read-row"), as: UTF8.self)),
            .reply(409, #"{"code":"LINE_MOVED","message":"the day was written again and the line is no one line now"}"#),
            .reply(200, #"{"what":"map"}"#),
        ])
        guard case .row(let row) = try await link.read(ref: "row.r1", cursor: "cursor:row:r1:p2") else { return XCTFail("a row") }
        XCTAssertEqual(row.n, 7)
        XCTAssertEqual(transport.requests.map(\.url.path), ["/v1/read"])
        XCTAssertEqual(transport.requests[0].url.query, "ref=row.r1&cursor=cursor%3Arow%3Ar1%3Ap2")
        do { _ = try await link.read(ref: "line:2026-10-01:calendar:e3:rev9"); XCTFail("moved") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .refused(status: 409, code: "LINE_MOVED", message: "the day was written again and the line is no one line now"))
        }
        do { _ = try await link.read(ref: "x"); XCTFail("no kind this build knows") } catch let failure as LinkFailure {
            XCTAssertEqual(failure, .unreadable(200))
        }
    }
}

private struct Wanted: Decodable, Equatable {
    struct Photo: Decodable, Equatable {
        let asset: String
        let files: [String]
    }

    struct Left: Decodable, Equatable {
        let wanted: Int
        let unavailable: Int
        let bytes: Int64
    }

    let photos: [Photo]
    let left: Left
}

enum Answers {
    static let days = #"{"position":"0:9","days":[{"day":"2026-10-13","inputs":"sha256:00a1","counts":{"total":20,"per_family":{"messages":8}}},{"day":"2026-10-14","inputs":"sha256:00aa","counts":{"total":31,"per_family":{"messages":12,"physical":4}},"later":1}],"next":"IjIwMjYtMTAtMTQi"}"#

    static let day = #"{"day":"2026-10-14","zone":"UTC","day_start_hour":4,"window":{"start_ms":1792022400000,"end_ms":1792108800000},"renderer":"5/2-d9f8a5b4946e/2","inputs":"sha256:00aa","counts":{"total":1,"per_family":{"messages":1}},"coverage":[{"family":"messages","sources":[{"source":"whatsapp:15550000000:phone-aa01","read":"through"},{"source":"imessage:person-a@example.com:macbook-pro-0001","read":"into"}]},{"family":"mail","sources":[{"source":"gmail:person-a@example.com:cloud","read":"none"}]}],"atoms":[{"n":1,"family":"messages","unit":"+15550000001/2026-10-14","start_ms":1792033920000,"end_ms":null,"local_start":"07:12","local_end":null,"flags":[],"text":"Person A: message 157","record":{"source":"whatsapp:15550000000:phone-aa01","kind":"msg","key":"m157"},"block":{"key":"+15550000001","title":"Person A"}}],"later":true}"#

    static let sources = #"{"position":"0:9","sources":[{"id":"gmail:person-a@example.com:cloud","connector":"gmail","options":{},"read_through_ms":null,"added_ms":1790000000000,"kinds":[],"owner":true},{"id":"whatsapp:15550000000:phone-aa01","connector":"whatsapp","options":{},"read_through_ms":1792051234567,"added_ms":1790000000000,"kinds":["msg"]}]}"#

    private static let home = #"{"words":"Home","area":{"city":"Synthetic Town","city_id":"synthetic-town","region":"Synthetic Region","country":"Synthetic Country","country_code":"XS"}}"#
    private static let office = #"{"words":"The Office","area":{"city":"Synthetic Town","city_id":"synthetic-town","region":"Synthetic Region","country":"Synthetic Country","country_code":"XS"}}"#
    private static let stay = #"{"start_ms":1792022400000,"end_ms":1792053000000,"kind":"stay","level":"place","point":{"latitude":19.0796,"longitude":72.8412},"from":null,"to":null,"how":"observed","by":"Phone","units":["stay/location:local:iphone-aa01/1"],"walks":[],"silences":[{"start_ms":1792030000000,"end_ms":1792032000000}],"names":{"point":\#(home),"from":null,"to":null},"spot":null,"later":0}"#
    private static let unnamedStay = #"{"start_ms":1792010000000,"end_ms":1792020000000,"kind":"stay","level":"place","point":{"latitude":19.0912,"longitude":72.8501},"from":null,"to":null,"how":"seen","by":"Photos","units":["seen/google-photos:person-a@example.com:export/2026-10-14"],"walks":[],"silences":[],"names":{"point":{"words":"an unnamed place 1.8 km from Home","area":{"city":"Synthetic Town","city_id":"synthetic-town","region":"Synthetic Region","country":"Synthetic Country","country_code":"XS"}},"from":null,"to":null},"spot":"spot:19.0912,72.8501"}"#

    static let whereAt = #"{"position":"0:9","zone":"UTC","day_start_hour":4,"at_ms":1792060000000,"piece":{"start_ms":1792054000000,"end_ms":1792070000000,"kind":"gap","level":null,"point":null,"from":{"latitude":19.0796,"longitude":72.8412},"to":null,"how":null,"units":[],"names":{"point":null,"from":null,"to":null}},"before":\#(unnamedStay),"after":null}"#

    static let wherePieces = #"{"position":"0:9","zone":"UTC","day_start_hour":4,"from_ms":1792022400000,"to_ms":1792060000000,"pieces":[\#(stay),{"start_ms":1792053000000,"end_ms":1792054500000,"kind":"move","level":"place","point":null,"from":{"latitude":19.0796,"longitude":72.8412},"to":{"latitude":19.0598,"longitude":72.8302,"id":"google:office"},"how":"observed","by":"Phone","units":["trip/location:local:iphone-aa01/2"],"legs":[{"start_ms":1792053000000,"end_ms":1792054500000,"mode":"walk","distance_m":1800,"motion":null,"stated":null}],"distance_m":1800,"names":{"point":null,"from":\#(home),"to":\#(office)}}]}"#

    static let whereSummaries = #"{"position":"0:9","zone":"UTC","day_start_hour":4,"from_ms":1788220800000,"to_ms":1792060000000,"grain":"month","summaries":[{"period":"2026-09","from":"2026-09-01","to":"2026-09-30","places":[{"slug":"home-place","name":"Home","latitude":19.0796,"longitude":72.8412,"hours":410.5,"days":27},{"slug":null,"name":"an unnamed place in Synthetic City","latitude":20.5,"longitude":74.0,"hours":50,"days":3}],"cities":[{"name":"Synthetic Town","country":"Synthetic Country","days":28,"nights":27,"guessed_days":0,"guessed_nights":1}],"regions":[],"countries":[{"name":"Synthetic Country","country":"Synthetic Country","days":30,"nights":30,"guessed_days":0,"guessed_nights":0}],"base":{"city":"Synthetic Town","nights":28},"trips":[{"first":"2026-09-12","last":"2026-09-13","cities":["Synthetic City"],"guessed":false}],"coverage":{"place":0.9,"moving":0.05,"city":0,"region":0,"country":0,"guessed":0.01,"unknown":0.04,"days_unknown":[],"nights_unknown":["2026-09-03"]},"later":[]}]}"#
    static let whereYear = #"{"position":"0:9","zone":"UTC","day_start_hour":4,"from_ms":1788220800000,"to_ms":1792060000000,"grain":"year","summaries":[{"period":"2026","from":"2026-01-01","to":"2026-12-31","places":[{"slug":"home-place","name":"Home","latitude":19.0796,"longitude":72.8412,"hours":410.5,"days":27},{"slug":null,"name":"an unnamed place in Synthetic City","latitude":20.5,"longitude":74.0,"hours":50,"days":3}],"cities":[{"name":"Synthetic Town","country":"Synthetic Country","days":28,"nights":27,"guessed_days":0,"guessed_nights":1}],"regions":[],"countries":[{"name":"Synthetic Country","country":"Synthetic Country","days":30,"nights":30,"guessed_days":0,"guessed_nights":0}],"base":{"city":"Synthetic Town","nights":28},"trips":[{"first":"2026-09-12","last":"2026-09-13","cities":["Synthetic City"],"guessed":false}],"coverage":{"place":0.9,"moving":0.05,"city":0,"region":0,"country":0,"guessed":0.01,"unknown":0.04,"days_unknown":[],"nights_unknown":["2026-09-03"]},"later":[]}]}"#

    static let search = contract("search")
    static let count = contract("count")
    static let countFirst = #"{"asked":"count of calls","population":{"facts":4,"valued":4,"missing":0,"excluded":{}},"counted":"counted from calls","columns":["day","ref"],"rows":[],"as_of":"2026-11-14T22:10+00:00","later":"x"}"#

    static func contract(_ name: String) -> String {
        (try? String(contentsOf: ReadsTests.contract.appendingPathComponent(name + ".json"), encoding: .utf8)) ?? ""
    }

    static let personA = #""id":"person:person-a","name":"Person A","by":"registry","person":"person-a","handles":[{"id":"phone:+15550000001","kind":"phone","network":null,"words":"+1 555 000 0001","from":null}],"networks":["whatsapp"],"chats":[{"key":"whatsapp:15550000001@s.whatsapp.net","count":7},{"key":"whatsapp:120363000000000001@g.us","count":3}],"received":10,"sent":4,"first_ms":1791900000000,"last_ms":1792040000000,"last_30":14,"days_count":2,"photo":{"crop":"\#(crop)"}"#

    static let crop = "sha256:" + String(repeating: "ef", count: 32)

    static let people = #"{"position":"0:9","people":[{\#(personA)},{"id":"whatsapp:+15550000009","name":"+1 555 000 0009","by":"none","person":null,"handles":[{"id":"phone:+15550000009","kind":"phone","network":null,"words":"+1 555 000 0009","from":null}],"networks":["whatsapp"],"chats":[],"received":0,"sent":0,"first_ms":null,"last_ms":null,"last_30":0,"days_count":0,"photo":null}],"zone":"Asia/Kolkata","day_start_hour":4,"chats":[{"key":"whatsapp:15550000001@s.whatsapp.net","network":"whatsapp","chat":"15550000001@s.whatsapp.net","group":false,"label":"Person A","total":9,"mine":4,"first_ms":1791900000000,"last_ms":1792040000000},{"key":"whatsapp:120363000000000001@g.us","network":"whatsapp","chat":"120363000000000001@g.us","group":true,"label":"Group Alpha","total":5,"mine":0,"first_ms":1791900000000,"last_ms":1792040000000,"later":1}]}"#

    static let person = #"{"position":"0:9","person":{\#(personA),"days":{"2026-10-13":4,"2026-10-14":10}}}"#

    static let editedPerson = #"{"position":"40:1792050000000","person":{"id":"person:sam-rivera","name":"Sam Rivera","call_name":"Sam","full_name":"Sam Rivera","show":"full_name","by":"registry","person":"sam-rivera","entity":"person","me":false,"hidden":false,"organised":true,"handles":[{"id":"phone:+15550000001","kind":"phone","network":null,"words":"+1 555 000 0001","from":null},{"id":"email:sam@example.com","kind":"email","network":null,"words":"sam@example.com","from":null},{"id":"jid:1234@lid","kind":"jid","network":null,"words":"Hidden number","from":null}],"networks":["whatsapp"],"chats":[],"received":3,"sent":1,"first_ms":null,"last_ms":null,"last_30":0,"days_count":0,"photo":null,"days":{},"suggestions":[{"id":"1111111111111111","kind":"handle","value":"email:sam.r@example.com","reasons":{"mails_from":3,"mails_to":2},"ticked":true,"later":1},{"id":"2222222222222222","kind":"birthday","value":"08-14","reasons":{"wished":3},"ticked":false}],"names_seen":["Sam R","Samuel Rivera"],"record":{"type":"people.person","slug":"sam-rivera","name":"Sam","full_name":"Sam Rivera","show":"full_name","anchor":{"kind":"phone","value":"+15550000001"},"handles":[],"later":[1,2]}}}"#

    static let detailedPeople = people.replacingOccurrences(of: #""photo":{"crop":"\#(crop)"}"#,
                                                             with: #""photo":{"crop":"\#(crop)"},"relationship":"Friend from college","work":"Product designer, Lumen Labs""#)
    static let detailedPerson = #"{"position":"0:9","person":{\#(personA),"relationship":"Friend from college","days":{"2026-10-14":10},"details":{"work":"Product designer, Lumen Labs","birthday":{"month":8,"day":14,"year":null},"profiles":[{"network":"instagram","value":"person.a"},{"network":"site","value":"example.com/person-a","later":1}],"later":1}}}"#
    static let personPhotos = #"{"position":"0:9","photos":[{"image":"\#(String(repeating: "ab", count: 32))","face":"\#(String(repeating: "ab", count: 32)):1193,260,1307,405","box":[1193,260,1307,404.5],"at_ms":1792041000000,"crop":"\#(crop)","camera":true,"later":1},{"image":"\#(String(repeating: "cd", count: 32))","face":"\#(String(repeating: "cd", count: 32)):10,10,90,90","box":[10,10,90,90],"at_ms":null,"crop":null,"camera":false}],"next":"NjA=","total":62}"#

    static let cardPeople = #"{"position":"0:9","people":[{"id":"person:person-c","name":"Person C","by":"registry","person":"person-c","handles":[],"networks":["imessage"],"chats":[],"received":1,"sent":0,"first_ms":null,"last_ms":null,"last_30":0,"days_count":0,"photo":{"card":"sha256:\#(String(repeating: "cd", count: 32))"}},{"id":"phone:+15550000002","name":"Person B","by":"contact","person":null,"handles":[],"networks":["whatsapp"],"chats":[],"received":1,"sent":0,"first_ms":null,"last_ms":null,"last_30":0,"days_count":0,"photo":null}],"zone":"Asia/Kolkata","day_start_hour":4,"chats":[]}"#
    static let dayless = #"{"position":"0:9","people":[],"chats":[]}"#

    static let connectors: String = {
        var report = try! JSONSerialization.jsonObject(with: Data(contentsOf: ReportTests.fixture)) as! [String: Any]
        report["position"] = "0:9"
        return String(decoding: try! JSONSerialization.data(withJSONObject: report), as: UTF8.self)
    }()

    static let status = #"{"position":"0:9","at_ms":1792060000000,"day":"2026-10-14","needs":[{"id":"password:gmail.password","state":"needs-you","reason":"password","words":"Type your Gmail password again","since_ms":1792000000000,"next_ms":null,"acts":[{"do":"set","label":"Set","member":"password"}],"detail":null,"at":null,"connector":"gmail","copy":"gmail:person-a@example.com:cloud","unit":null,"weight":"advice","banner":false,"dismissed":false,"kind":"password","about":"Lifestream keeps it locked with your other passwords."},{"id":"fetch:whoop","state":"broken","reason":"failing","words":"WHOOP isn't answering","since_ms":1792000000000,"next_ms":1792060720000,"acts":[{"do":"try","label":"Try now","need":"fetch:whoop","later":1}],"detail":null,"at":null,"connector":"whoop","copy":"whoop:person-a@example.com:cloud","unit":null,"weight":"stopped","banner":false,"dismissed":false,"kind":"notice","about":null},{"id":"offer:claude:person-b@example.com:browser","state":"needs-you","reason":"other-account","words":"Chrome is signed in to Claude as person-b@example.com","since_ms":1792000000000,"next_ms":null,"acts":[{"do":"read","label":"Read it too","need":"offer:claude:person-b@example.com:browser","of":"claude:user-synthetic0004:browser"},{"do":"ignore","label":"Not this one","need":"offer:claude:person-b@example.com:browser","of":"claude:user-synthetic0004:browser"}],"detail":null,"at":null,"connector":"claude","copy":"claude:person-a@example.com:browser","unit":null,"weight":"advice","banner":false,"dismissed":false,"kind":"notice","about":null},{"id":"disk","state":"needs-you","reason":null,"words":"The home's disk fills in about 20 days","since_ms":null,"next_ms":null,"acts":[],"detail":null,"at":null,"connector":null,"copy":null,"unit":null,"weight":"advice","banner":false,"dismissed":false,"kind":"notice","about":null}],"today":{"sources":[{"source":"whatsapp:15550000000:macbook-pro-0001","deliveries":3,"imports":3,"counts":{"msg":41},"changed_paths":{},"likely_noise":[],"read_through_ms":1792059000000}],"families":[],"render":{"runs":1,"days":1,"written":1,"current":0,"set_aside":0},"operations":[]},"grants":[],"running":{"lanes":[],"jobs":[],"repairs":[]},"paused":[{"target":"kind:poll","reason":"away","at_ms":1792000000000,"holds":["gmail-imap"]}],"inbox":{"lanes":[],"since":null},"search":{"seq":95,"of":95,"bytes":1024},"disk":{"free_bytes":100000000000,"days_left":212}}"#

    static let sleep = #"{"family":"health","unit":"sleep/whoop:person-a@example.com:cloud/41","reading":"sha256:00dd","content":{"kind":"sleep","start_ms":1791999000000,"end_ms":1792020000000,"nap":false},"start_ms":1791999000000,"end_ms":1792020000000,"days":["2026-10-14"],"items":[]}"#

    static let extracts = #"{"position":"0:9","extracts":[\#(sleep)]}"#

    static let record = #"{"position":"0:9","source":"whatsapp:15550000000:phone-aa01","kind":"msg","key":"m157","head":{"version":"sha256:00ee","stated_ms":1792033920000,"since_ms":1792033920000,"start_ms":1792033920000,"end_ms":null},"version":{"id":"sha256:00ee","content":{"text":"message 157","from":"+15550000001"},"start_ms":1792033920000,"end_ms":null,"offset_min":0,"precision":"ms"},"blobs":["sha256:abababababababababababababababababababababababababababababababab"],"text":{"title":"Person A","text":"message 157","who":["whatsapp:+15550000001"]}}"#

    private static let photo = #"{"image":"\#(String(repeating: "ab", count: 32))","at_ms":1792041000000,"later":1}"#

    static let place = #"{"position":"0:9","place":{"slug":"the-office","name":"The Office","latitude":37.322,"longitude":-122.001,"radius_m":90,"also":[{"latitude":37.3245,"longitude":-122.0031,"radius_m":60},{"latitude":37.3199,"longitude":-121.998,"radius_m":40,"later":1}],"ids":["google:office"],"home":true,"area":{"city":"Synthetic Town","region":"Synthetic Region","country":"Synthetic Country"},"days":3,"hours":20.5,"first_ms":1791860000000,"last_ms":1792046000000,"visits_count":3,"nights":0,"here":true,"part_of":{"slug":"campus-0a1b2c","name":"The Campus"},"inside":[{"slug":"desk-3d4e5f","name":"The Desk"}],"ask_home":null,"rhythm":"3 days here since Oct 2026 · usually Tue and Thu evenings","visits":[{"unit":"stay/location:local:iphone-aa01/1791950000000","start_ms":1792040000000,"end_ms":1792046000000,"focus":"u:stay/location:local:iphone-aa01/1791950000000@1792040000000-1792046000000","day":"2026-10-14","people":[],"centre":{"latitude":37.3221,"longitude":-122.0012}},{"unit":"stay/location:local:iphone-aa01/1791950000000","start_ms":1791950000000,"end_ms":1791957000000,"focus":"u:stay/location:local:iphone-aa01/1791950000000@1791950000000-1791957000000","day":"2026-10-13","people":["person:person-a","phone:+15550000002"],"later":1},{"unit":"stay/google-timeline:person-a@example.com:export/k1","start_ms":1791860000000,"end_ms":1791867000000,"focus":"u:stay/google-timeline:person-a@example.com:export/k1@1791860000000-1791867000000","day":"2026-10-12","people":["person:person-a"]}],"photos":[\#(photo)],"photos_count":14,"people":[{"id":"person:person-a","name":"Person A","days":2,"photo":{"crop":"sha256:\#(String(repeating: "ef", count: 32))"}},{"id":"phone:+15550000002","name":"Person B","days":1,"photo":{"card":"sha256:\#(String(repeating: "cd", count: 32))"},"later":1}],"later":{}}}"#

    static let placeOnce = #"{"position":"0:9","place":{"slug":"corner-bakery-1a2b3c","name":"Corner Bakery","latitude":37.3301,"longitude":-122.0142,"radius_m":80,"also":[],"ids":[],"area":{"city":null,"city_id":null,"region":null,"country":null,"country_code":null},"days":1,"hours":0.6,"first_ms":1792040000000,"last_ms":1792042000000,"visits_count":1,"nights":0,"here":false,"part_of":null,"inside":[],"ask_home":"You’ve slept here 3 nights, since Monday.","rhythm":null,"visits":[{"unit":"stay/location:local:iphone-aa01/1792040000000","start_ms":1792040000000,"end_ms":1792042000000,"focus":"u:stay/location:local:iphone-aa01/1792040000000@1792040000000-1792042000000","day":"2026-10-14","people":[]}],"photos":[{"image":"\#(String(repeating: "cd", count: 32))","at_ms":1792041000000}],"photos_count":1,"people":[{"id":"person:person-c","name":"Person C","days":1}]}}"#

    static let suggest = #"{"position":"0:9","suggestions":[{"name":"Lantern Noodle Bar","id":"google:lantern","distance_m":24,"why":{"product":"Calendar","family":"calendar","at_ms":1792001400000,"tier":3,"later":1}},{"name":"Kiln Coffee","slug":"kiln-coffee-3f9a2c","distance_m":40},{"name":"Lantern Park","id":"google:park","distance_m":90,"later":true},{"name":"Harbour Deli","distance_m":120,"why":{"product":"Files","family":null,"at_ms":1791990000000,"tier":2}}]}"#
    static let suggestTyped = #"{"position":"0:9","suggestions":[{"name":"Kiln Coffee","slug":"kiln-coffee-3f9a2c","distance_m":400},{"name":"Kiln Bakery","id":"google:kiln-bakery","distance_m":null,"later":1}],"provider":{"name":"Google Places","need":null}}"#
    static let places = #"{"position":"0:9","places":[],"spots":[{"latitude":37.3215,"longitude":-122.0126,"stays":21,"days":16,"hours":4.75,"longest_day_hours":0.5,"first_ms":1560000000000,"last_ms":1792040000000,"worth":true,"area":{"city":"Synthetic Town","region":null,"country":"Synthetic Country"},"ask_home":null,"key":"spot:37.3215,-122.0126","witnessed":"You took 14 photos here on 16 days between 2019 and 2026.","last":"Last time Tue 20 Oct 2026 from 14:10 to 15:30","photos":[\#(photo),{"image":"\#(String(repeating: "cd", count: 32))","at_ms":1791951000000}],"photos_count":14,"later":1},{"latitude":37.31,"longitude":-122.02,"stays":1,"days":1,"hours":0.1,"longest_day_hours":0.1,"first_ms":1792000000000,"last_ms":1792000000000,"worth":false,"ask_home":null}],"hidden":[{"key":"hidden-3f9a2c","latitude":37.3412,"longitude":-122.0215,"hidden_ms":1792000000000,"days":4,"nearest":{"name":"Harbour Home","distance_m":210,"slug":"harbour-home"},"later":1},{"key":"hidden-0b1c2d","latitude":36.6,"longitude":-121.9,"hidden_ms":1791000000000,"days":1,"nearest":null}]}"#
    static let placePhotos = #"{"position":"0:9","photos":[\#(photo),{"image":"\#(String(repeating: "cd", count: 32))","at_ms":1791951000000}],"next":"Mg=="}"#

    static let wanted = #"{"photos":[{"asset":"B2C3D4E5-0000-4000-8000-000000000002/L0/001","files":["pairedVideo"]}],"left":{"wanted":3,"unavailable":1,"bytes":1998035},"route":"phone"}"#
    static let libraryPhoto = #"{"position":"0:9","photo":{"hash":"sha256:\#(String(repeating: "ab", count: 32))","kind":"photograph","play":null,"at_ms":1792000000000,"zone":"Europe/London","date":"2026-10-12","day":"2026-10-11","unit":"burst/1791999990000","caption":"Two friends on a terrace at sunset.","people":[{"id":"person:person-a","name":"Person A","me":false,"box":[1193,260,1307,404.5],"photo":{"crop":"sha256:\#(String(repeating: "ef", count: 32))"},"later":1},{"id":"person:me","name":"You","me":true,"box":null,"photo":null}],"size":{"width":4032,"height":3024},"place":{"slug":"harbour-terrace","name":"Harbour Terrace","latitude":37.32,"longitude":-122.0,"radius_m":60,"area":{"city":"Synthetic Town","region":"Synthetic Region","country":"Synthetic Country"}},"area":null,"camera":{"id":"apple/iphone-17-pro","name":"iPhone 17 Pro","mine":true},"from":"phone","chat":null,"later":{}}}"#
    static let chatImage = #"{"position":"0:9","photo":{"hash":"sha256:\#(String(repeating: "cd", count: 32))","kind":"image","play":null,"at_ms":1792000100000,"zone":"Europe/London","date":"2026-10-11","day":"2026-10-11","unit":null,"caption":null,"people":[],"size":null,"place":null,"area":null,"camera":null,"from":null,"chat":{"network":"whatsapp","chat":"whatsapp:15550000001@s.whatsapp.net","title":"Person A","group":false,"sender":{"id":"person:person-a","name":"Person A"},"mine":false,"at_ms":1792000100000,"day":"2026-10-11","record":{"source":"whatsapp:15550000000:phone-aa01","kind":"msg","key":"m 1/2"},"focus":"rec:whatsapp:15550000000:phone-aa01 msg m 1/2","later":1}}}"#
    static let pictures = #"{"recipe":2}"#
    static let devices = #"{"position":"0:9","cameras":[{"camera":"apple/iphone-17-pro","make":"Apple","model":"iPhone 17 Pro","photos":1240,"first_ms":1700000000000,"last_ms":1792000000000,"sample":"sha256:abababababababababababababababababababababababababababababababab","phones":["iphone-aa01"],"word":{"mine":true,"from":"2025-03-01"},"mine":true,"why":"owner"},{"camera":"phone/iphone-aa02","make":null,"model":null,"photos":3,"first_ms":null,"last_ms":null,"sample":null,"phones":[],"word":null,"mine":false,"why":"none"}]}"#
}
