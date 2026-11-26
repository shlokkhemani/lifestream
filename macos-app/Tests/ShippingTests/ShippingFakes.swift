import Evidence
import DeviceFiles
import Foundation
import HomeLink
import XCTest
@testable import Shipping


final class Collected<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Value] = []

    func append(_ value: Value) { lock.withLock { values.append(value) } }

    var all: [Value] { lock.withLock { values } }
    var count: Int { lock.withLock { values.count } }
    func clear() { lock.withLock { values.removeAll() } }
}

final class FixedClock: @unchecked Sendable {
    private let lock = NSLock()
    private var instant: Date

    init(_ instant: Date) { self.instant = instant }

    var now: Date { lock.withLock { instant } }

    func move(to next: Date) { lock.withLock { instant = next } }
    func move(by seconds: TimeInterval) { lock.withLock { instant += seconds } }

    var read: @Sendable () -> Date { { [self] in now } }
}

final class MemoryCredentials: Credentials, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?

    func read() throws -> Data? { lock.withLock { data } }
    func write(_ data: Data) throws { lock.withLock { self.data = data } }
    func delete() throws { lock.withLock { data = nil } }
}

final class MainThreadWatch: Credentials, @unchecked Sendable {
    private let lock = NSLock()
    private let kept = MemoryCredentials()
    private var onMain = 0

    var mainThreadReads: Int { lock.withLock { onMain } }

    func read() throws -> Data? {
        if Thread.isMainThread { lock.withLock { onMain += 1 } }
        return try kept.read()
    }
    func write(_ data: Data) throws { try kept.write(data) }
    func delete() throws { try kept.delete() }
}

final class FakeHome: HomeTransport, @unchecked Sendable {
    struct Delivery {
        let id: String
        let source: String
        let pass: String
        let seal: Int?
        let lost: [[String: Any]]
        let members: [String: Data]
        let facts: [String: Any]
        let kind: String?
    }

    struct Custody: Equatable {
        var received = 0
        var imported = 0
    }

    private let lock = NSLock()
    private var passes: [String: String] = [:]
    private var custody: [String: [String: Custody]] = [:]
    private var sealed: [String: Delivery] = [:]
    private var order: [String] = []
    private var made: [HomeRequest] = []
    private var waits: [(count: Int, kept: XCTestExpectation)] = []
    private var silentNow = false
    private var nextStatus: Int?
    private var nextSaid: [String: Any] = [:]
    private var refusals: [String: (status: Int, code: String, retryAfter: Int?)] = [:]
    private var losing = false
    private var stated: [[String: Any]] = []
    private var statedThrough: [[String: Any]] = []
    private var statedNetworks: [String] = []
    private var floor = "0.1.0"
    private var release: (version: String, generation: Int?) = ("0.2.0", nil)
    let clock: @Sendable () -> Date
    let unit = "unit-0001"
    var sources: Set<String> {
        get { lock.withLock { delivered } }
        set { lock.withLock { delivered = newValue } }
    }
    private var delivered: Set<String>

    init(sources: [String], clock: @escaping @Sendable () -> Date) {
        delivered = Set(sources)
        self.clock = clock
    }

    static let code = "12345678"

    static func wanting(_ ids: [String], files: [String] = ["photo"], unavailable: Int = 0) -> [String: Any] {
        ["photos": ids.map { ["asset": $0, "files": files] },
         "left": ["wanted": ids.count, "unavailable": unavailable, "bytes": ids.count * 1_000]]
    }


    var wanted: [String: Any]? {
        get { lock.withLock { photosWanted } }
        set { lock.withLock { photosWanted = newValue } }
    }
    private var photosWanted: [String: Any]?
    var asked: [String] { lock.withLock { wantedAsked } }
    private var wantedAsked: [String] = []

    var holds: Set<String>? {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
    private var stored: Set<String>?
    var heldAsked: [[String]] { lock.withLock { heldAsks } }
    private var heldAsks: [[String]] = []
    var admitted: Set<String>? {
        get { lock.withLock { took } }
        set { lock.withLock { took = newValue } }
    }
    private var took: Set<String>?
    var refusedWhole: Set<String> {
        get { lock.withLock { refusedFiles } }
        set { lock.withLock { refusedFiles = newValue } }
    }
    private var refusedFiles: Set<String> = []
    var letGo: Set<String> {
        get { lock.withLock { letGoFiles } }
        set { lock.withLock { letGoFiles = newValue } }
    }
    private var letGoFiles: Set<String> = []
    var importsAsked: [[String]] { lock.withLock { importsAsks } }
    private var importsAsks: [[String]] = []
    var heldUnanswered: Bool {
        get { lock.withLock { heldHangs } }
        set { lock.withLock { heldHangs = newValue } }
    }
    private var heldHangs = false

    var holdingBack: Set<String> {
        get { lock.withLock { pastHeld } }
        set { lock.withLock { pastHeld = newValue } }
    }
    private var pastHeld: Set<String> = []

    var noRoomFor: Set<String> {
        get { lock.withLock { roomless } }
        set { lock.withLock { roomless = newValue } }
    }
    private var roomless: Set<String> = []
    var full: Bool {
        get { lock.withLock { diskFull } }
        set { lock.withLock { diskFull = newValue } }
    }
    private var diskFull = false
    private var turns = 0

    var settings: [String: Any]? {
        get { lock.withLock { answerSettings } }
        set { lock.withLock { answerSettings = newValue } }
    }
    private var answerSettings: [String: Any]?

    var refresh: [String: Int]? {
        get { lock.withLock { stamps } }
        set { lock.withLock { stamps = newValue } }
    }
    private var stamps: [String: Int]?

    var settingAnswer: (@Sendable ([String: Any]) -> (Int, [String: Any]))? {
        get { lock.withLock { answeringSettings } }
        set { lock.withLock { answeringSettings = newValue } }
    }
    private var answeringSettings: (@Sendable ([String: Any]) -> (Int, [String: Any]))?

    var settingsSent: [[String: Any]] {
        requests.filter { $0.url.path == "/v1/settings" }.compactMap { request in
            guard case .json(let body) = request.body else { return nil }
            return try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        }
    }

    func refuse(_ source: String, _ refusal: (status: Int, code: String)?, retryAfter: Int? = nil) {
        lock.withLock { refusals[source] = refusal.map { ($0.status, $0.code, retryAfter) } }
    }
    func loseNextAnswer() { lock.withLock { losing = true } }
    var sendings: [[String: Any]] { lock.withLock { stated } }
    var throughs: [[String: Any]] { lock.withLock { statedThrough } }
    var networks: [String] { lock.withLock { statedNetworks } }

    func silence() { lock.withLock { silentNow = true } }
    func speak() { lock.withLock { silentNow = false } }
    func answerNext(_ status: Int, said: [String: Any] = [:]) { lock.withLock { (nextStatus, nextSaid) = (status, said) } }
    func raiseFloor(to version: String) { lock.withLock { floor = version } }
    func runs(version: String, generation: Int?) { lock.withLock { release = (version, generation) } }

    func importAll() {
        lock.withLock {
            for (pass, sources) in custody {
                for source in sources.keys { custody[pass]![source]!.imported = custody[pass]![source]!.received }
            }
        }
    }

    func restore(_ source: String, received: Int, imported: Int, pass: String = "p-00000001") {
        lock.withLock {
            custody[pass, default: [:]][source] = Custody(received: received, imported: imported)
            for (id, delivery) in sealed where delivery.source == source && delivery.pass == pass && (delivery.seal ?? 0) > received {
                sealed[id] = nil
                order.removeAll { $0 == id }
            }
        }
    }

    func nameTaken(_ id: String, source: String, pass: String = "p-00000001") {
        lock.withLock {
            sealed[id] = Delivery(id: id, source: source, pass: pass, seal: nil, lost: [], members: [:], facts: [:], kind: nil)
        }
    }

    func custody(_ source: String, pass: String = "p-00000001") -> Custody {
        lock.withLock { custody[pass]?[source] ?? Custody() }
    }

    var deliveries: [Delivery] { lock.withLock { order.compactMap { sealed[$0] } } }
    var requests: [HomeRequest] { lock.withLock { made } }
    func forgetRequests() { lock.withLock { made.removeAll() } }

    func exchanged(_ count: Int) -> XCTestExpectation {
        let kept = XCTestExpectation(description: "\(count) exchanges reached the home")
        lock.withLock {
            if exchanges >= count { kept.fulfill() } else { waits.append((count, kept)) }
        }
        return kept
    }

    private var exchanges: Int { made.filter { $0.url.path == "/v1/exchange" }.count }


    var gate: (@Sendable () async -> Void)? {
        get { lock.withLock { held } }
        set { lock.withLock { held = newValue } }
    }
    private var held: (@Sendable () async -> Void)?

    func perform(_ request: HomeRequest) async throws -> HomeResponse {
        if let gate { await gate() }
        if heldUnanswered, request.url.path == "/v1/blobs/held" { try await Task.sleep(nanoseconds: 86_400 * 1_000_000_000) }
        return try lock.withLock {
            made.append(request)
            waits.removeAll { wait in
                guard exchanges >= wait.count else { return false }
                wait.kept.fulfill()
                return true
            }
            if silentNow { throw URLError(.cannotConnectToHost) }
            if let status = nextStatus {
                nextStatus = nil
                defer { nextSaid = [:] }
                return Self.refusal(status, status >= 500 ? "NOT_NOW" : "HTTP_\(status)", said: nextSaid)
            }
            guard let device = request.headers["Lifestream-Device"], device.hasPrefix("mac/") else {
                return Self.refusal(400, "DEVICE_HEADER")
            }
            let path = request.url.path
            if request.method == "POST", path == "/v1/pair", case .json(let data) = request.body {
                let body = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
                guard body["code"] as? String == Self.code, let pass = body["pass"] as? String else {
                    return Self.refusal(403, "PAIR_CODE")
                }
                let id = passes[pass] ?? String(format: "p-%08d", passes.count + 1)
                passes[pass] = id
                return HomeResponse(status: 200, body: Self.json(["unit": unit, "answer": answerObject(id)]))
            }
            guard let bearer = request.headers["Authorization"], bearer.hasPrefix("Bearer "),
                  let pass = passes[String(bearer.dropFirst(7))] else {
                return Self.refusal(401, "PRINCIPAL_UNKNOWN")
            }
            if request.method == "POST", path == "/v1/exchange" {
                if case .json(let data) = request.body, let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    if let sending = body["sending"] as? [String: Any] { stated.append(sending) }
                    if let through = body["through"] as? [String: Any] { statedThrough.append(through) }
                    if let network = body["network"] as? String { statedNetworks.append(network) }
                }
                return answer(200, pass)
            }
            if request.method == "POST", path == "/v1/settings", case .json(let data) = request.body {
                let body = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
                guard let answering = answeringSettings else { return Self.refusal(404, "ROUTE") }
                let (status, answer) = answering(body)
                return HomeResponse(status: status, body: Self.json(answer))
            }
            if request.method == "POST", path == "/v1/blobs/held", case .json(let data) = request.body {
                let asked = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["blobs"] as? [String] ?? []
                heldAsks.append(asked)
                guard let stored else { return Self.refusal(404, "ROUTE") }
                guard asked.count <= 5_000 else { return Self.refusal(422, "TOO_MANY") }
                return HomeResponse(status: 200, body: Self.json(["held": asked.filter(stored.contains)]))
            }
            if request.method == "POST", path == "/v1/imports/held", case .json(let data) = request.body {
                let files = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["files"] as? [[String: String]] ?? []
                let asked = files.map { "\($0["kind"] ?? "")/\($0["digest"] ?? "")" }
                importsAsks.append(asked)
                guard let took else { return Self.refusal(404, "ROUTE") }
                let looked = files.compactMap { file -> [String: String]? in
                    let key = "\(file["kind"] ?? "")/\(file["digest"] ?? "")"
                    let state = took.contains(key) ? "in" : refusedFiles.contains(key) ? "refused" : letGoFiles.contains(key) ? "let-go" : nil
                    return state.map { file.merging(["state": $0]) { $1 } }
                }
                return HomeResponse(status: 200, body: Self.json(["held": looked]))
            }
            if request.method == "GET", path == "/v1/photos/wanted" {
                wantedAsked.append(URLComponents(url: request.url, resolvingAgainstBaseURL: false)?
                    .queryItems?.first { $0.name == "source" }?.value ?? "")
                guard let photosWanted else { return Self.refusal(404, "ROUTE") }
                return HomeResponse(status: 200, body: Self.json(photosWanted))
            }
            guard request.method == "PUT", path.hasPrefix("/v1/acquisitions/"), case .file(let file) = request.body else {
                return Self.refusal(404, "ROUTE")
            }
            if Self.older(String(device.dropFirst(4)), than: floor) {
                return HomeResponse(status: 426, body: Self.json(["code": "DEVICE_TOO_OLD", "message": "update", "floor": floor]))
            }
            if roomless.contains(request.headers[HomeLink.kindHeader] ?? "later") { return Self.refusal(503, "DISK_LOW") }
            if let progress = request.progress, let size = FileFacts.regularFileSize(file.path) {
                for sent in stride(from: 1 << 16, to: size, by: 1 << 16) { progress.heard(Int64(sent)) }
                progress.heard(Int64(size))
            }
            let response = try put(file, id: String(path.dropFirst("/v1/acquisitions/".count)), pass: pass, kind: request.headers[HomeLink.kindHeader])
            if losing, response.status == 201 {
                losing = false
                throw URLError(.networkConnectionLost)
            }
            return response
        }
    }

    private func put(_ file: URL, id: String, pass: String, kind: String?) throws -> HomeResponse {
        let zip = try StoredZipReader(file)
        guard let manifestBytes = zip.bytes("manifest.json"),
              let manifest = try JSONSerialization.jsonObject(with: manifestBytes) as? [String: Any],
              let source = manifest["source_id"] as? String, let fetchedAt = manifest["fetched_at"] as? String,
              let fetched = UTCInstant.date(rfc3339: fetchedAt) else { return Self.refusal(422, "ACQUISITION_MANIFEST") }
        guard id == "\(source)/\(UTCInstant.basic(fetched))" else { return Self.refusal(422, "ACQUISITION_ID_MISMATCH") }
        if sealed[id] != nil { return answer(200, pass) }
        guard delivered.contains(source) else { return Self.refusal(403, "PRINCIPAL_SCOPE") }
        if let refusal = refusals[source] { return Self.refusal(refusal.status, refusal.code, retryAfter: refusal.retryAfter) }
        let facts = manifest["facts"] as? [String: Any] ?? [:]
        let stated = (facts["snapshot_taken_at"] as? String).flatMap(UTCInstant.date(rfc3339:)) ?? fetched
        if stated.timeIntervalSince(clock()) > 600 { return Self.refusal(422, "CLOCK_AHEAD") }
        let stating = (manifest["custody"] as? [String: Any])?[source] as? [String: Any]
        let seal = stating?["seal"] as? Int
        var mine = custody[pass]?[source] ?? Custody()
        if let seal {
            guard seal == mine.received + 1 else {
                return HomeResponse(status: 409, body: Self.json(["code": "STALE", "message": "seal \(seal) is not the next",
                                                                  "answer": answerObject(pass)]))
            }
            mine.received = seal
            custody[pass, default: [:]][source] = mine
        }
        var members: [String: Data] = [:]
        for member in zip.members { members[member.name] = member.bytes }
        sealed[id] = Delivery(id: id, source: source, pass: pass, seal: seal,
                              lost: stating?["lost"] as? [[String: Any]] ?? [], members: members, facts: facts, kind: kind)
        order.append(id)
        return answer(201, pass)
    }

    private func answerObject(_ pass: String) -> [String: Any] {
        var stated: [String: Any] = [:]
        for source in delivered {
            let mine = custody[pass]?[source] ?? Custody()
            stated[source] = ["received": mine.received, "imported": mine.imported,
                              "formats": ["org.lifestreamprotocol.acquisition/1"], "history": !pastHeld.contains(source)]
        }
        var home: [String: Any] = ["id": "h-00000001", "version": release.version, "floors": ["mac": floor, "phone": "1.0.0", "extension": "0.1.0"]]
        if let generation = release.generation { home["generation"] = generation }
        turns += 1
        let needs: [Any] = diskFull ? [["id": "disk:full", "state": "broken", "reason": NSNull(), "words": "Lifestream's disk is full",
                                        "since_ms": NSNull(), "next_ms": NSNull(), "acts": [Any](), "detail": NSNull(),
                                        "connector": NSNull(), "copy": NSNull(), "unit": NSNull(), "at": NSNull(), "weight": "stopped", "banner": true, "dismissed": false,
                                        "kind": "notice", "about": NSNull()]] : []
        var object: [String: Any] = ["home": home, "pass": pass, "unit": unit, "sources": stated, "owner": [String](), "needs": needs,
                                     "calls": [Any](), "settings": answerSettings ?? [:], "turn": ["run": "00000000000fa4e0", "n": turns]]
        if let stamps { object["refresh"] = stamps }
        return object
    }

    private func answer(_ status: Int, _ pass: String) -> HomeResponse {
        HomeResponse(status: status, body: Self.json(answerObject(pass)))
    }

    private static func older(_ version: String, than floor: String) -> Bool {
        let one = version.split(separator: ".").map { Int($0) ?? 0 }, other = floor.split(separator: ".").map { Int($0) ?? 0 }
        for index in 0..<max(one.count, other.count) {
            let (a, b) = (index < one.count ? one[index] : 0, index < other.count ? other[index] : 0)
            if a != b { return a < b }
        }
        return false
    }

    private static func refusal(_ status: Int, _ code: String, said: [String: Any] = [:], retryAfter: Int? = nil) -> HomeResponse {
        HomeResponse(status: status, headers: retryAfter.map { ["Retry-After": String($0)] } ?? (status >= 500 ? ["Retry-After": "60"] : [:]),
                     body: json(["code": code, "message": "the synthetic home refused with \(code)"].merging(said) { _, said in said }))
    }

    private static func json(_ object: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
    }
}

struct FakeSealFailure: Error, CustomStringConvertible {
    let sourceId: String
    var description: String { "the synthetic domain \(sourceId) cannot read its own data" }
}

final class FakeNetwork: NetworkWatch, @unchecked Sendable {
    private let lock = NSLock()
    private var now: MobileData.Path

    init(_ path: MobileData.Path = .free) { now = path }

    var path: MobileData.Path {
        get { lock.withLock { now } }
        set { lock.withLock { now = newValue } }
    }

    var facts: NetworkFacts? { NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: true, path: 1, cost: path) }

    func changes() -> AsyncStream<NetworkFacts> {
        AsyncStream { $0.yield(NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: true, path: 1, cost: path)) }
    }
}

final class FakeDomain: ShippingDomain, @unchecked Sendable {
    enum Seal: Sendable {
        case sealed(kind: String? = nil)
        case sealedWithPage
        case lastPage
        case sealedLater
        case nothingNew
        case quietWhenOwed
        case quietLeft(Int)
        case quietCounted([String: Through.Month])
        case sealedCounted([String: Through.Month])
        case failure
    }

    let sourceId: String
    let name: String

    private let lock = NSLock()
    private var script: [Seal]
    private var seen: [SealRequest] = []
    private var answersSeen: [FreshAnswer] = []
    private let gate: (@Sendable () -> Void)?

    init(sourceId: String, name: String, seals: [Seal] = [.nothingNew],
         holdingSealAt gate: (@Sendable () -> Void)? = nil) {
        self.sourceId = sourceId
        self.name = name
        script = seals
        self.gate = gate
    }

    var requests: [SealRequest] { lock.withLock { seen } }
    var seals: Int { lock.withLock { seen.count } }
    var unreadPart: Unread? {
        get { lock.withLock { stated } }
        set { lock.withLock { stated = newValue } }
    }
    private var stated: Unread?
    var unread: Unread? { unreadPart }
    var owesHistory: Bool { lock.withLock { owing } }
    private var owing = false
    var through: Through? { lock.withLock { quiet } }
    private var quiet: Through?
    var answers: [FreshAnswer] { lock.withLock { answersSeen } }

    func arm(_ seals: [Seal]) { lock.withLock { script = seals } }

    func seal(_ request: SealRequest) throws -> [SealedBundle] {
        gate?()
        let step = lock.withLock { () -> Seal in
            seen.append(request)
            quiet = nil
            let first = script.first ?? .nothingNew
            if script.count > 1 { script.removeFirst() }
            switch first {
            case .sealedWithPage: owing = true
            case .lastPage: owing = !request.custody.history
            default: owing = false
            }
            return first
        }
        switch step {
        case .nothingNew:
            return []
        case .quietWhenOwed:
            if request.owesThrough { lock.withLock { quiet = request.through(readThrough: request.fetchedAt) } }
            return []
        case .quietLeft(let left):
            if request.owesThrough { lock.withLock { quiet = request.through(readThrough: request.fetchedAt, left: left) } }
            return []
        case .quietCounted(let months):
            if request.owesThrough {
                lock.withLock {
                    quiet = Through(readThrough: request.fetchedAt, statedAt: request.fetchedAt, months: months)
                }
            }
            return []
        case .failure:
            throw FakeSealFailure(sourceId: sourceId)
        case .sealed(let kind):
            return [try bundle(request, at: request.fetchedAt, custody: request.custody, kind: kind)]
        case .sealedCounted(let months):
            return [try bundle(request, at: request.fetchedAt, custody: request.custody, kind: nil, months: request.monthsOwed(months))]
        case .sealedLater:
            return [try bundle(request, at: request.fetchedAt, custody: request.custody, kind: nil, write: .later)]
        case .sealedWithPage, .lastPage:
            let changes = try bundle(request, at: request.fetchedAt, custody: request.custody, kind: "changes")
            guard request.custody.history else { return [changes] }
            let page = SealCustody(pass: request.custody.pass, received: request.custody.seal, imported: request.custody.imported)
            return [changes, try bundle(request, at: request.fetchedAt.addingTimeInterval(0.001), custody: page, kind: "history")]
        }
    }

    private func bundle(_ request: SealRequest, at fetchedAt: Date, custody: SealCustody, kind: String?,
                        write: WriteKind? = nil, months: [String: Through.Month]? = nil) throws -> SealedBundle {
        let written = try BundleWriter.write(
            into: request.workDirectory, sourceId: sourceId, feeder: "synthetic", fetchedAt: fetchedAt,
            files: [BundleWriter.File(name: "synthetic.txt", content: .bytes(Data("synthetic \(name) bundle\n".utf8)))],
            facts: [("snapshot_taken_at", .string(UTCInstant.rfc3339(fetchedAt)))] + Months.facts(months),
            custody: (custody, []), through: DeviceFiles(.plain))
        return SealedBundle(file: written.file, sidecar: BundleSidecar(id: written.id, sourceId: sourceId, custody: custody, kind: kind,
                                                                       write: write ?? (kind == HistoryPage.kind ? .later : .new),
                                                                       months: months))
    }

    func applied(_ answer: FreshAnswer) {
        lock.withLock { answersSeen.append(answer) }
    }
}

actor RunGate {
    private(set) var reached = false
    private var opened = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func hold() async {
        reached = true
        if opened { return }
        await withCheckedContinuation { waiting.append($0) }
    }

    func open() {
        opened = true
        for continuation in waiting { continuation.resume() }
        waiting = []
    }
}

enum ShippingFixture {
    static func artifact(_ name: String, _ object: Any) throws {
        let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent(".build/e2e", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]).write(to: folder.appendingPathComponent(name))
    }

    static let zone = TimeZone(identifier: "Asia/Kolkata")!
    static let machineSource = "machine:local:unit-0001"
    static let messagesSource = "imessage:a@example.com:unit-0001"
    static let inputSource = "input:local:unit-0001"
    static let pass = "p-00000001"

    static func hash(_ digit: Character) -> String { String(repeating: digit, count: 64) }

    static func instant(_ spelling: String) -> Date {
        guard let date = UTCInstant.date(rfc3339: spelling) else {
            fatalError("the fixture instant \(spelling) is not the spelling under test")
        }
        return date
    }

    static let name = "http://127.0.0.1:4680"

    static func link(_ home: FakeHome, folder: URL, version: String = "0.2.0", stamp: Int? = nil,
                     credentials: any Credentials = MemoryCredentials(), at address: String = name,
                     network: (any NetworkWatch)? = nil) async throws -> HomeLink {
        let link = HomeLink(device: HomeLink.Device(kind: .mac, version: version, model: "MacBook Pro", serial4: "0001", stamp: stamp),
                            credentials: credentials, folder: folder, transport: home, network: network, clock: home.clock,
                            files: DeviceFiles(.plain))
        _ = try await link.pair(code: FakeHome.code, name: address)
        home.forgetRequests()
        return link
    }

    static let first = SealCustody(pass: pass, received: 0, imported: 0)
}

extension ShippingDomain {
    func sealOne(_ request: SealRequest) throws -> SealedBundle? {
        let sealed = try seal(request)
        XCTAssertLessThanOrEqual(sealed.count, 1, "\(name) sealed more than one bundle")
        return sealed.first
    }
}

extension ImportRoom {
    static func roomy(_ root: URL) -> ImportRoom {
        ImportRoom(onPower: { true }, disk: Volume(root, every: 0, read: { _ in 1 << 40 }), homeFree: { nil })
    }
}
