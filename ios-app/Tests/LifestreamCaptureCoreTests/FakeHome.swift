import Foundation
import HomeLink

@testable import LifestreamCaptureCore

final class FakeHome: HomeTransport, @unchecked Sendable {
    struct Delivery {
        let id: String
        let seals: [String: Int]
        let lost: [String: [Lost]]
        let ranges: [String: [UInt64]]
        let blobs: Set<String>
        var named: Set<String> = []
        var kinds: [String: [String]] = [:]
        var satOut: [String] = []
    }

    struct PageAsk: Equatable {
        let path: String
        let query: String?
        let etag: String?
    }

    struct Custody: Equatable {
        var received = 0
        var imported = 0
    }

    static let code = "12345678"
    static let unit = "iphone-aa00"
    static let account = "person-a@example.com"
    static let home = "macbook-pro-0001"
    static let places = "places:local:\(home)"
    static let sources = ["location:local:\(unit)", "motion:local:\(unit)", "screen-time:local:\(unit)",
                          "voice-notes:local:\(unit)", "camera:local:\(unit)",
                          "checkin:local:\(unit)", "notes:local:\(unit)", "energy:local:\(unit)", "upload:local:\(unit)",
                          "machine:local:\(unit)",
                          "apple-health:<account>:cloud", "apple-contacts:<account>:\(unit)", "apple-photos:<account>:\(unit)"]

    static func sources(_ listed: [String] = sources, account: String?) -> [String] {
        listed.compactMap { source in
            guard source.contains("<account>") else { return source }
            return account.map { source.replacingOccurrences(of: "<account>", with: $0) }
        }
    }

    private let lock = NSLock()
    private var passes: [String: String] = [:]
    private var accounts: [String: String] = [:]
    private var custody: [String: [String: Custody]] = [:]
    private var sealed: [String: Delivery] = [:]
    private var order: [String] = []
    private var silent = false
    private var refusingPasses = false
    private var phoneFloor = "0.1.0"
    private var stated: [[String: Any]] = []
    private var answered = 0
    private var statedSending: [String: Any]?
    private var restoreDomains: [String: [[String: Any]]] = [:]
    private var restoreContacts: [String: [String]] = [:]
    private var restoreSince: [String: Int] = [:]
    private var restoreTypes: [String: [String]] = [:]
    private var blobs: [String: Data] = [:]
    private var staged: [String: Data] = [:]
    private var parts: [String: Data] = [:]
    private var fileCut: Int?
    private var dropsStage = false
    private var filesPut: [(name: String, offset: Int)] = []
    private var replaced: [String: String] = [:]
    private var delivered: Set<String>
    private var placeRows: [String: [String: Any]] = [:]
    private var hiddenRows: [String: [String: Any]] = [:]
    private var countedAs: [String: Data] = [:]
    private var holdingPair: HeldRequest?
    private var pairsCut = 0
    private var servesPlaces = true
    private var actAnswers: [String: [String: Any]] = [:]
    private var actsTaken: [[String: Any]] = []
    private var seq = 100
    private var paths: [String] = []
    private var day: (day: String, until: Date)?
    private var losing = 0
    private var cutting = 0
    private var notNowPairs: [(wait: String, words: String, retryAfter: String?)] = []
    private var pairsAsked: [(code: String, pass: String)] = []
    private var refusedNames: Set<String> = []
    private var placesAsked = 0
    private var placesUnchanged = 0
    private var asked = 0
    private var pageAnswers: [HomeResponse] = []
    private var pageAsks: [PageAsk] = []
    var stayFigures: [String: [String: Any]] {
        get { lock.withLock { figures } }
        set { lock.withLock { figures = newValue } }
    }
    var spots: [[String: Any]] {
        get { lock.withLock { spotList } }
        set { lock.withLock { spotList = newValue } }
    }
    private var figures: [String: [String: Any]] = [:]
    private var spotList: [[String: Any]] = []
    let clock: @Sendable () -> Date

    init(sources: [String] = FakeHome.sources, clock: @escaping @Sendable () -> Date) {
        delivered = Set(sources)
        self.clock = clock
    }


    func restoring(domains: [String: [[String: Any]]], since: [String: Int], types: [String: [String]] = [:], blobs: [Data] = [],
                   contacts: [String: [String]] = [:]) {
        lock.withLock {
            restoreDomains = domains
            restoreContacts = contacts
            restoreSince = since
            restoreTypes = types
            for blob in blobs { self.blobs[SHA256Digest.tagged(blob)] = blob }
        }
    }
    func holding(_ files: [Data]) { lock.withLock { for file in files { blobs[SHA256Digest.tagged(file)] = file } } }
    func replace(_ pass: String, at instant: String) { lock.withLock { replaced[pass] = instant } }
    func held(_ source: String, received: Int, pass: String = "p-0001") {
        lock.withLock { custody[pass, default: [:]][source] = Custody(received: received, imported: received) }
    }
    func silence() { lock.withLock { silent = true } }
    func speak() { lock.withLock { silent = false } }
    func forgetPasses() { lock.withLock { passes = [:] } }
    var refusing: Bool {
        get { lock.withLock { refusingPasses } }
        set { lock.withLock { refusingPasses = newValue } }
    }
    func servePlaces(_ served: Bool) { lock.withLock { servesPlaces = served } }
    var today: (day: String, until: Date)? {
        get { lock.withLock { day } }
        set { lock.withLock { day = newValue } }
    }
    func loseAnswers(_ count: Int) { lock.withLock { losing = count } }
    func cutNextAct() { lock.withLock { cutting = 1 } }
    func refuse(name: String) { lock.withLock { _ = refusedNames.insert(name) } }
    func dropStaged() { lock.withLock { staged = [:]; parts = [:] } }
    func dropStagedAtNextBundle() { lock.withLock { dropsStage = true } }
    func cutNextFile(after bytes: Int) { lock.withLock { fileCut = bytes } }
    var fileSends: [(name: String, offset: Int)] { lock.withLock { filesPut } }
    var stagedFiles: Set<String> { lock.withLock { Set(staged.keys) } }

    func name(_ slug: String, _ name: String, latitude: Double, longitude: Double, radius: Double,
              also: [(Double, Double, Double)] = [], ids: [String] = []) {
        lock.withLock {
            placeRows[slug] = ["slug": slug, "name": name, "latitude": latitude, "longitude": longitude, "radius_m": radius, "ids": ids,
                               "also": also.map { ["latitude": $0.0, "longitude": $0.1, "radius_m": $0.2] }]
            count()
        }
    }

    func derive() { lock.withLock { count() } }

    private func count() {
        countedAs = placeRows.merging(hiddenRows) { $1 }.mapValues(Self.countedBy)
    }

    private static func countedBy(_ row: [String: Any]) -> Data { json(row.filter { $0.key != "name" }) }

    var ownerActs: [[String: Any]] { lock.withLock { actsTaken } }

    func answersPairsNotNow(_ answers: [(wait: String, words: String, retryAfter: String?)]) { lock.withLock { notNowPairs = answers } }

    var pairings: [(code: String, pass: String)] { lock.withLock { pairsAsked } }

    func requests(to prefix: String) -> Int { lock.withLock { paths.filter { $0.hasPrefix(prefix) }.count } }

    func answersPages(_ answers: [HomeResponse]) { lock.withLock { pageAnswers = answers } }
    var pagesAsked: [PageAsk] { lock.withLock { pageAsks } }

    var placesReads: (asked: Int, unchanged: Int) { lock.withLock { (placesAsked, placesUnchanged) } }
    var requests: Int { lock.withLock { asked } }
    func raiseFloor(to version: String) { lock.withLock { phoneFloor = version } }
    var needs: [[String: Any]] {
        get { lock.withLock { stated } }
        set { lock.withLock { stated = newValue } }
    }

    func importAll() {
        lock.withLock {
            for (pass, sources) in custody {
                for source in sources.keys { custody[pass]![source]!.imported = custody[pass]![source]!.received }
            }
        }
    }

    func restore(to held: [String: Custody], pass: String = "p-0001") {
        lock.withLock {
            for source in custody[pass, default: [:]].keys { custody[pass]![source] = held[source] ?? Custody() }
            for (id, delivery) in sealed where delivery.seals.contains(where: { $0.value > (held[$0.key]?.received ?? 0) }) {
                sealed[id] = nil
                order.removeAll { $0 == id }
            }
        }
    }

    func custody(_ source: String, pass: String = "p-0001") -> Custody {
        lock.withLock { custody[pass]?[source] ?? Custody() }
    }

    var sending: [String: Any]? { lock.withLock { statedSending } }

    func holdNextPair() -> HeldRequest {
        let gate = HeldRequest()
        lock.withLock { holdingPair = gate }
        return gate
    }

    var pairingsCut: Int { lock.withLock { pairsCut } }

    var deliveries: [Delivery] { lock.withLock { order.compactMap { sealed[$0] } } }


    func perform(_ request: HomeRequest) async throws -> HomeResponse {
        let response = try lock.withLock {
            asked += 1
            paths.append(request.url.path)
            if silent { throw URLError(.cannotConnectToHost) }
            guard let device = request.headers["Lifestream-Device"], device.hasPrefix("phone/") else {
                return Self.refusal(400, "DEVICE_HEADER")
            }
            let path = request.url.path
            if request.method == "POST", path == "/v1/pair", case .json(let data) = request.body {
                let body = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
                pairsAsked.append((body["code"] as? String ?? "", body["pass"] as? String ?? ""))
                if !notNowPairs.isEmpty {
                    let notNow = notNowPairs.removeFirst()
                    let object: [String: Any] = ["code": "NOT_NOW", "message": notNow.words, "wait": notNow.wait, "title": notNow.words,
                                                 "line": NSNull(), "acts": [Any]()]
                    return HomeResponse(status: 503, headers: notNow.retryAfter.map { ["Retry-After": $0] } ?? [:], body: Self.json(object))
                }
                guard body["code"] as? String == Self.code, let pass = body["pass"] as? String else { return Self.refusal(403, "PAIR_CODE") }
                let id = passes[pass] ?? "p-\(String(format: "%04d", passes.count + 1))"
                if passes[pass] == nil { accounts[id] = body["account"] as? String }
                passes[pass] = id
                return HomeResponse(status: 200, body: Self.json(["unit": Self.unit, "answer": answer(id)]))
            }
            guard !refusingPasses, let bearer = request.headers["Authorization"], bearer.hasPrefix("Bearer "),
                  let pass = passes[String(bearer.dropFirst(7))] else { return Self.refusal(401, "PRINCIPAL_UNKNOWN") }
            if request.method == "POST", path == "/v1/exchange" {
                let body = (try? request.body.jsonObject()) ?? [:]
                if let sending = body["sending"] as? [String: Any] { statedSending = sending }
                guard body["drained"] as? Bool == true else { return HomeResponse(status: 200, body: Self.json(answer(pass))) }
                let held = custody[pass, default: [:]].values
                guard replaced[pass] != nil, held.allSatisfy({ $0.imported == $0.received }) else {
                    return HomeResponse(status: 409, body: Self.json(["code": "NOT_DRAINED", "message": "not drained", "answer": answer(pass)]))
                }
                let reply = answer(pass)
                passes = passes.filter { $0.value != pass }
                return HomeResponse(status: 200, body: Self.json(reply))
            }
            if request.method == "GET", path == "/v1/restore" {
                var since: [String: Any] = [:]
                for source in delivers(pass) { since[source] = restoreSince[source].map { $0 as Any } ?? NSNull() }
                return HomeResponse(status: 200, body: Self.json(["pass": pass, "unit": Self.unit, "since": since, "types": restoreTypes, "domains": restoreDomains,
                                                                     "contacts": restoreContacts]))
            }
            if request.method == "POST", path == "/v1/blobs/held" {
                let asked = (try? request.body.jsonObject())?["blobs"] as? [String] ?? []
                let holds = storeHolds()
                let unheld = asked.filter { !holds.contains($0) }
                return HomeResponse(status: 200, body: Self.json([
                    "held": asked.filter(holds.contains), "staged": unheld.filter { staged[$0] != nil },
                    "partly": Dictionary(uniqueKeysWithValues: unheld.compactMap { name in parts[name].map { (name, $0.count) } }),
                ]))
            }
            if request.method == "PUT", path.hasPrefix("/v1/files/") {
                return try putFile(String(path.dropFirst("/v1/files/".count)), offset: request.headers["Upload-Offset"], body: request.body)
            }
            if request.method == "GET", path.hasPrefix("/v1/blobs/") {
                guard let bytes = blobs[String(path.dropFirst("/v1/blobs/".count))] else { return Self.refusal(404, "BLOB_UNKNOWN") }
                return HomeResponse(status: 200, body: bytes)
            }
            if request.method == "GET", path == "/v1/people" {
                return HomeResponse(status: 200, body: Self.json(["people": [Any](), "chats": [Any]()]))
            }
            if request.method == "POST", path == "/v1/owner/act", case .json(let data) = request.body {
                let response = act(data)
                if cutting > 0 {
                    cutting -= 1
                    throw URLError(.cancelled)
                }
                if response.status == 200, losing > 0 {
                    losing -= 1
                    throw URLError(.networkConnectionLost)
                }
                return response
            }
            if request.method == "GET", path.hasPrefix("/v1/page/") {
                pageAsks.append(PageAsk(path: path, query: request.url.query, etag: request.headers["If-None-Match"]))
                guard !pageAnswers.isEmpty else { return Self.refusal(404, "ROUTE") }
                return pageAnswers.removeFirst()
            }
            if request.method == "GET", path == "/v1/places" {
                guard servesPlaces else { return Self.refusal(404, "ROUTE") }
                return places(ifNoneMatch: request.headers["If-None-Match"])
            }
            guard request.method == "PUT", path.hasPrefix("/v1/bundles/"), case .file(let file) = request.body else {
                return Self.refusal(404, "ROUTE")
            }
            if Self.older(String(device.dropFirst("phone/".count)), than: phoneFloor) {
                return HomeResponse(status: 426, body: Self.json(["code": "DEVICE_TOO_OLD", "message": "update", "floor": phoneFloor]))
            }
            return try put(file, id: String(path.dropFirst("/v1/bundles/".count)), pass: pass)
        }
        if request.method == "POST", request.url.path == "/v1/pair", response.status == 200,
           let gate = lock.withLock({ () -> HeldRequest? in defer { holdingPair = nil }; return holdingPair }) {
            await gate.pass()
            if Task.isCancelled {
                lock.withLock { pairsCut += 1 }
                throw URLError(.cancelled)
            }
        }
        return response
    }

    private func storeHolds() -> Set<String> {
        sealed.values.reduce(Set(blobs.keys)) { $0.union($1.blobs) }
    }

    private func putFile(_ name: String, offset stated: String?, body: HomeRequest.Body) throws -> HomeResponse {
        guard let offset = Int(stated ?? "0"), offset >= 0 else { return Self.refusal(422, "UPLOAD_HEADERS") }
        if storeHolds().contains(name) || staged[name] != nil { return HomeResponse(status: 200, body: Self.json(["file": name, "held": true])) }
        let had = parts[name] ?? Data()
        guard offset == had.count else {
            return HomeResponse(status: 409, body: Self.json(["code": "UPLOAD_OFFSET", "message": "go on from what the door holds",
                                                              "held": had.count]))
        }
        filesPut.append((name, offset))
        let sent = try Self.bytes(of: body)
        if let cut = fileCut {
            fileCut = nil
            parts[name] = had + sent.prefix(cut)
            throw URLError(.networkConnectionLost)
        }
        parts[name] = nil
        let whole = had + sent
        guard SHA256Digest.tagged(whole) == name else { return Self.refusal(422, "FILE_BAD") }
        staged[name] = whole
        return HomeResponse(status: 201, body: Self.json(["file": name]))
    }

    private static func bytes(of body: HomeRequest.Body) throws -> Data {
        switch body {
        case .empty: return Data()
        case .json(let data), .bytes(let data): return data
        case .file(let url): return try Data(contentsOf: url)
        case .stream(_, let open):
            let reader = try open.open()
            var data = Data()
            while let piece = try reader.next() { data.append(piece) }
            return data
        }
    }

    private func put(_ file: URL, id: String, pass: String) throws -> HomeResponse {
        if dropsStage {
            dropsStage = false
            staged = [:]
            parts = [:]
        }
        if sealed[id] != nil { return HomeResponse(status: 200, body: Self.json(answer(pass))) }
        let manifest = try StoredZIPWriter.readManifest(from: file)
        guard manifest.bundleID == id else { return Self.refusal(422, "IOS_BUNDLE_ID_MISMATCH") }
        if manifest.custody.isEmpty { return Self.refusal(422, "CUSTODY_MISSING") }
        let carrying = manifest.files.keys.compactMap { name in CaptureDomain.allCases.first { $0.filename == name } }
            .compactMap { domain in delivers(pass).first { $0.hasPrefix(domain.product + ":") } }
        if let unstated = carrying.sorted().first(where: { manifest.custody[$0] == nil }) {
            return Self.refusal(422, "CUSTODY_MISSING", "\(unstated) carries data its custody does not state")
        }
        if let outside = manifest.custody.keys.first(where: { !delivers(pass).contains($0) }) {
            return Self.refusal(403, "PRINCIPAL_SCOPE", "\(outside) is turned off")
        }
        guard let created = CaptureTime.date(rfc3339: manifest.createdAt), created <= clock().addingTimeInterval(600) else {
            return Self.refusal(422, "CLOCK_AHEAD")
        }
        let satOut = manifest.satOut ?? []
        if satOut.isEmpty && manifest.satOut != nil { return Self.refusal(422, "IOS_BUNDLE_BAD_MANIFEST", "an empty sat_out") }
        if let wrong = satOut.first(where: { manifest.custody[$0] != nil || !delivers(pass).contains($0) }) {
            return Self.refusal(422, "IOS_BUNDLE_BAD_MANIFEST", "\(wrong) sat out and is stated or not delivered")
        }
        var kinds: [String: [String]] = [:]
        var carried = Set<String>()
        for name in manifest.files.keys where !name.hasPrefix("blobs/") {
            for line in try Self.member(name, of: file).split(separator: 0x0A) {
                let entry = try JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] ?? [:]
                let kind = entry["kind"] as? String ?? ""
                kinds[name, default: []].append(kind)
                if kind != "gone" { carried.formUnion(Self.hashes(in: entry)) }
            }
        }
        let bundled = Set(manifest.files.keys.filter { $0.hasPrefix("blobs/") }.map { "sha256:" + $0.dropFirst(6) })
        let lacked = carried.subtracting(storeHolds().union(bundled))
        let fromStage = lacked.filter { staged[$0] != nil }
        let missing = lacked.subtracting(fromStage)
        let stated = manifest.custody.values.flatMap { $0.lost ?? [] }.reduce(0) { $0 + $1.items }
        if missing.count > stated {
            return HomeResponse(status: 409, body: Self.json([
                "code": "FILES_MISSING", "message": "The home lacks files this bundle names: send them, then the bundle again.",
                "missing": ["files": missing.sorted()]]))
        }
        let stale = manifest.custody.filter { $0.value.seal != (custody[pass]?[$0.key]?.received ?? 0) + 1 }
        if !stale.isEmpty {
            return HomeResponse(status: 409, body: Self.json(["code": "STALE", "message": "seal again", "answer": answer(pass)]))
        }
        for (source, stated) in manifest.custody { custody[pass, default: [:]][source, default: Custody()].received = stated.seal }
        for name in fromStage { staged[name] = nil }
        sealed[id] = Delivery(
            id: id, seals: manifest.custody.mapValues(\.seal), lost: manifest.custody.compactMapValues(\.lost),
            ranges: manifest.files.compactMapValues { file in file.firstSequence.map { [$0, file.lastSequence ?? $0] } },
            blobs: bundled.union(fromStage), named: carried, kinds: kinds, satOut: satOut)
        order.append(id)
        return HomeResponse(status: 201, body: Self.json(answer(pass)))
    }


    private func act(_ data: Data) -> HomeResponse {
        guard let action = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let request = action["request"] as? String else {
            return Self.refusal(400, "BAD_ACTION", "An action carries its request: the id its device made for it.")
        }
        guard action["of"] as? String == "places", let kind = action["kind"] as? String else {
            return Self.refusal(400, "BAD_ACTION", "A place's action is create, edit, add-circle, remove, hide or unhide.")
        }
        actsTaken.append(action)
        if let answered = actAnswers[request] { return HomeResponse(status: 200, body: Self.json(answered)) }
        if let name = action["name"] as? String, refusedNames.contains(name) {
            return Self.refusal(422, "STATEMENTS_BAD", "line 1 is refused")
        }
        let circle: [String: Any] = ["latitude": action["latitude"] ?? 0, "longitude": action["longitude"] ?? 0, "radius_m": action["radius_m"] ?? 0]
        let id: String
        switch kind {
        case "create":
            let slug = Self.minted(action["name"] as? String ?? "")
            placeRows[slug] = circle.merging(["slug": slug, "name": action["name"] ?? "", "also": [Any](), "ids": action["ids"] ?? [String]()]) { $1 }
                .merging((action["home"] as? Bool).map { ["home": $0] } ?? [:]) { $1 }
            id = "place:" + slug
        case "hide":
            let key = Self.minted("hidden")
            hiddenRows[key] = ["key": key, "latitude": circle["latitude"]!, "longitude": circle["longitude"]!, "hidden_ms": Self.ms(clock()),
                               "nearest": NSNull()]
            id = "hidden:" + key
        case "unhide":
            guard let key = action["key"] as? String, hiddenRows.removeValue(forKey: key) != nil else {
                return Self.refusal(404, "PLACE_UNKNOWN", "There is no such place.")
            }
            id = "hidden:" + key
        default:
            guard let slug = action["slug"] as? String, var row = placeRows[slug] else {
                return Self.refusal(404, "PLACE_UNKNOWN", "There is no such place.")
            }
            switch kind {
            case "remove": placeRows[slug] = nil
            case "add-circle": row["also"] = (row["also"] as? [Any] ?? []) + [circle]
            case "edit":
                let sent = action.filter { !["of", "kind", "request", "slug", "was"].contains($0.key) }
                let was = action["was"] as? [String: Any] ?? [:]
                let holds = { (member: String, value: Any?) in
                    NSDictionary(dictionary: [member: row[member] ?? NSNull()]).isEqual(to: [member: value ?? NSNull()])
                }
                if sent.contains(where: { !holds($0.key, was[$0.key]) && !holds($0.key, $0.value) }) {
                    return Self.refusal(409, "CHANGED", "This place changed since it was read.")
                }
                row.merge(sent) { $1 }
                if row["home"] is NSNull { row["home"] = nil }
            default:
                return Self.refusal(400, "BAD_ACTION", "A place's action is create, edit, add-circle, remove, hide or unhide.")
            }
            if kind != "remove" { placeRows[slug] = row }
            id = "place:" + slug
        }
        seq += 1
        let answered: [String: Any] = ["act": NSNull(), "id": id, "position": "\(seq):\(Self.ms(clock()))"]
        actAnswers[request] = answered
        return HomeResponse(status: 200, body: Self.json(answered))
    }

    private static func minted(_ name: String) -> String {
        let words = name.lowercased().split { !($0.isASCII && ($0.isLetter || $0.isNumber)) }.joined(separator: "-")
        let hex = (0..<6).map { _ in String(Int.random(in: 0..<16), radix: 16) }.joined()
        return (words.isEmpty ? "" : words + "-") + hex
    }

    private func places(ifNoneMatch: String?) -> HomeResponse {
        placesAsked += 1
        let counted = { (key: String, row: [String: Any]) in self.countedAs[key] == Self.countedBy(row) }
        let zero: [String: Any] = ["stays": 0, "days": 0, "hours": 0, "longest_day_hours": 0, "today_hours": 0, "first_ms": NSNull(), "last_ms": NSNull()]
        let places = placeRows.map { slug, row in
            row.merging(counted(slug, row) ? figures[slug] ?? [:] : ["counting": true]) { $1 }.merging(zero) { kept, _ in kept }
        }.sorted { ($0["name"] as! String, $0["slug"] as! String) < ($1["name"] as! String, $1["slug"] as! String) }
        let hidden = hiddenRows.map { key, row in row.merging(counted(key, row) ? ["days": 0] : ["days": 0, "counting": true]) { $1 } }
            .sorted { ($0["hidden_ms"] as! Int64) > ($1["hidden_ms"] as! Int64) }
        let circles = places.flatMap { place in [place] + (place["also"] as? [[String: Any]] ?? []) }
        let spots = spotList.filter { spot in
            !hidden.contains { Self.metres(spot, $0) <= 80 } && !circles.contains { Self.metres(spot, $0) <= $0["radius_m"] as? Double ?? 0 }
        }
        var list: [String: Any] = ["position": 1, "here": NSNull(), "places": places, "spots": spots, "hidden": hidden]
        if let day {
            list["day"] = day.day
            list["day_until_ms"] = Self.ms(day.until)
        }
        let body = Self.json(list)
        let etag = "\"" + SHA256Digest.hex(body) + "\""
        if ifNoneMatch == etag {
            placesUnchanged += 1
            return HomeResponse(status: 304, headers: ["ETag": etag], body: Data())
        }
        return HomeResponse(status: 200, headers: ["ETag": etag], body: body)
    }

    private static func ms(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded()) }

    private static func metres(_ one: [String: Any], _ other: [String: Any]) -> Double {
        let (a, b) = (one["latitude"] as? Double ?? 0, other["latitude"] as? Double ?? 0)
        let (c, d) = (one["longitude"] as? Double ?? 0, other["longitude"] as? Double ?? 0)
        return hypot((a - b) * 111_320, (c - d) * 111_320 * cos(a * .pi / 180))
    }

    private static func hashes(in value: Any) -> Set<String> {
        if let object = value as? [String: Any] {
            var found = Set(object.compactMap { key, value in key == "hash" ? (value as? String).flatMap { $0.hasPrefix("sha256:") ? $0 : nil } : nil })
            for member in object.values { found.formUnion(hashes(in: member)) }
            return found
        }
        if let array = value as? [Any] { return array.reduce(into: Set<String>()) { $0.formUnion(hashes(in: $1)) } }
        return []
    }

    private static func member(_ name: String, of archive: URL) throws -> Data {
        try unzip(["-p", archive.path, name])
    }

    private static func unzip(_ arguments: [String]) throws -> Data {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        process.arguments = arguments
        let output = Pipe()
        process.standardOutput = output
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw URLError(.cannotDecodeContentData) }
        return data
    }

    private func delivers(_ pass: String) -> Set<String> {
        Set(Self.sources(Array(delivered), account: accounts[pass]))
    }

    private func answer(_ pass: String) -> [String: Any] {
        var sources: [String: Any] = [:]
        for source in delivers(pass) {
            let held = custody[pass]?[source] ?? Custody()
            sources[source] = ["received": held.received, "imported": held.imported, "formats": ["ios-bundle-3"], "history": true]
        }
        answered += 1
        var answer: [String: Any] = [
            "home": ["id": "h-0001", "version": "0.3.0", "floors": ["mac": "0.1.0", "phone": phoneFloor, "extension": "0.1.0"]],
            "pass": pass, "unit": Self.unit, "sources": sources, "needs": stated, "calls": [], "settings": [String: Any](),
            "owner": [Self.places, "people:local:\(Self.home)"],
            "turn": ["run": "00000000000fa4e0", "n": answered]]
        if let at = replaced[pass] { answer["replaced"] = at }
        return answer
    }

    private static func refusal(_ status: Int, _ code: String, _ message: String = "refused") -> HomeResponse {
        HomeResponse(status: status, body: json(["code": code, "message": message]))
    }

    private static func json(_ object: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
    }

    private static func older(_ one: String, than other: String) -> Bool {
        let left = one.split(separator: ".").map { Int($0) ?? 0 }, right = other.split(separator: ".").map { Int($0) ?? 0 }
        for index in 0..<max(left.count, right.count) {
            let a = index < left.count ? left[index] : 0, b = index < right.count ? right[index] : 0
            if a != b { return a < b }
        }
        return false
    }
}

final class HeldRequest: @unchecked Sendable {
    private let arrivals: AsyncStream<Void>
    private let arrival: AsyncStream<Void>.Continuation
    private let openings: AsyncStream<Void>
    private let opening: AsyncStream<Void>.Continuation

    init() {
        (arrivals, arrival) = AsyncStream.makeStream()
        (openings, opening) = AsyncStream.makeStream()
    }

    func pass() async {
        arrival.yield()
        for await _ in openings { return }
    }

    func arrived() async {
        for await _ in arrivals { return }
    }

    func open() { opening.yield() }
}

final class MemoryCredentials: Credentials, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?

    func read() throws -> Data? { lock.withLock { data } }
    func write(_ data: Data) throws { lock.withLock { self.data = data } }
    func delete() throws { lock.withLock { data = nil } }
}

final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date

    init(_ start: Date) { current = start }

    var now: Date { lock.withLock { current } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current = current.addingTimeInterval(seconds) } }
}

extension HomeRequest.Body {
    func jsonObject() throws -> [String: Any]? {
        guard case .json(let data) = self else { return nil }
        return try JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}
