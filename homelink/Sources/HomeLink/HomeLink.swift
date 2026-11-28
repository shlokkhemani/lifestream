import DeviceFiles
import Foundation
import Security

public final class HomeLink: Sendable {
    public enum Kind: String, Sendable {
        case mac
        case phone
    }

    public struct Device: Sendable, Equatable {
        public let kind: Kind
        public let version: String
        public let model: String
        public let serial4: String?
        public let stamp: Int?

        public init(kind: Kind, version: String, model: String, serial4: String?, stamp: Int? = nil) {
            self.kind = kind
            self.version = version
            self.model = model
            self.serial4 = serial4
            self.stamp = stamp
        }

        var header: String { "\(kind.rawValue)/\(version)" }

        public func waits(for home: Answer.Home) -> Bool {
            guard let stamp, home.version != "checkout" else { return false }
            return home.generation.map { $0 < stamp } ?? true
        }
    }

    public static let deviceHeader = "Lifestream-Device"
    public static let kindHeader = "Lifestream-Kind"
    public static let waitHeader = "Lifestream-Wait"
    public static let uncompressedLengthHeader = "Lifestream-Uncompressed-Length"
    public static let sourceHeader = "Lifestream-Source"
    public static let silence: TimeInterval = 60
    public static let look: TimeInterval = 4
    public static let reach: TimeInterval = 8
    static let answeredFor: TimeInterval = 60

    static let mostKept = 16 << 20

    public let device: Device
    let credentials: any Credentials
    let files: DeviceFiles
    let becomeKeyed: (@Sendable () throws -> Void)?
    let answerFile: URL
    let clockFile: URL
    let reachFile: URL
    let countsFile: URL
    let pacer: Pacer
    let grace: TimeInterval
    let look: TimeInterval
    let reach: TimeInterval
    let reachBox = ReachBox()
    let transport: any HomeTransport
    let finder: any HomeFinder
    let clock: @Sendable () -> Date
    public let network: (any NetworkWatch)?
    private let answered = Answered()
    private let storing = NSLock()
    private let told = Told()
    private let tellsHeld = TellsHeld()
    private let waiting = Waiting()
    private let exchanges = Turns()
    private let newest = Newest()
    private let clocks = Clocks()
    private let counts = Counts()
    private let chosen = Chosen()
    let recipes = Recipes()

    public init(device: Device, credentials: any Credentials = KeychainCredentials(), folder: URL,
                transport: any HomeTransport = URLSessionTransport(), finder: any HomeFinder = BonjourFinder(),
                network: (any NetworkWatch)? = nil, clock: @escaping @Sendable () -> Date = { Date() },
                pacer: Pacer = .system, grace: TimeInterval = HomeLink.grace,
                look: TimeInterval = HomeLink.look, reach: TimeInterval = HomeLink.reach,
                files: DeviceFiles? = nil, becomeKeyed: (@Sendable () throws -> Void)? = nil) {
        self.device = device
        self.credentials = credentials
        self.files = files ?? DeviceFiles(.plain)
        self.becomeKeyed = becomeKeyed
        answerFile = folder.appendingPathComponent("answer.json")
        clockFile = folder.appendingPathComponent("clock.json")
        reachFile = folder.appendingPathComponent("reach.json")
        countsFile = folder.appendingPathComponent("counts.json")
        self.pacer = pacer
        self.grace = grace
        self.look = look
        self.reach = reach
        self.transport = transport
        self.finder = finder
        self.network = network
        self.clock = clock
    }


    public func name() throws -> URL? {
        guard let stored = try stored(), stored.paired else { return nil }
        return URL(string: stored.name)
    }

    public func addresses() throws -> [URL] {
        guard let stored = try stored(), stored.paired else { return [] }
        return stored.addresses.addresses
    }

    public func pin() throws -> String? {
        guard let stored = try stored(), stored.paired else { return nil }
        return stored.pin
    }

    public var unit: String? {
        guard let held = try? stored(), held.paired else { return nil }
        return held.unit ?? saved.map(\.unit).flatMap { $0.isEmpty ? nil : $0 }
    }

    public var saved: SavedAnswer? {
        guard let data = try? files.read(answerFile, maximumBytes: Self.mostKept),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let at = (object["at"] as? Double).map({ Date(timeIntervalSince1970: $0) }),
              let body = object["answer"], let bytes = try? JSONSerialization.data(withJSONObject: body),
              let answer = Answer(body: bytes) else { return nil }
        return SavedAnswer(answer, at: at)
    }


    public func pair(code: String, name text: String, account: String? = nil, offers: [String] = [],
                     phone: WhichPhone = .unsaid) async throws -> FreshAnswer {
        try await pair(code: code, at: try Self.name(text), pin: nil, account: account, name: nil, offers: offers, phone: phone)
    }

    public func pair(_ link: PairingLink, account: String?, name: String? = nil, offers: [String] = [],
                     phone: WhichPhone = .unsaid) async throws -> FreshAnswer {
        let address = try await reach(link.addresses, pin: link.fingerprint)
        return try await pair(code: link.code, at: address, pin: link.fingerprint, account: account,
                              name: name, offers: offers, phone: phone, reached: true)
    }

    public func look(for link: PairingLink) async -> LinkFailure? {
        do {
            _ = try await reach(link.addresses, pin: link.fingerprint)
            return nil
        } catch let failure as LinkFailure {
            return failure
        } catch {
            return .noAnswer(sent: false)
        }
    }

    public func find(within: TimeInterval? = nil) async -> [FoundHome] {
        let within = within ?? self.look
        var found: [FoundHome] = []
        for address in await finder.find(within: within) {
            guard let fingerprint = try? await transport.identify(address, within: self.look) else { continue }
            found.append(FoundHome(address: address, fingerprint: fingerprint))
        }
        return found
    }

    public static let nothingFound = "No Mac found on this Wi-Fi. On Tailscale, scan the code instead."

    func reach(_ addresses: [URL], pin: String) async throws -> URL {
        let facts = facts(of: addresses)
        let found = try await look(at: addresses.filter { Self.road(to: $0, on: facts) }, pin: pin, within: self.reach)
        answered.set(found, at: clock(), on: facts)
        return found
    }

    private func look(at addresses: [URL], pin: String, within: TimeInterval) async throws -> URL {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(within))
        let transport = transport
        let lookLimit = self.look
        let pause = min(1, lookLimit / 4)
        enum Seen: Sendable { case home(URL), other, none }
        let found: URL? = try await withThrowingTaskGroup(of: Seen.self) { group in
            for address in addresses {
                group.addTask {
                    while true {
                        let started = clock.now
                        let left = started.duration(to: deadline)
                        guard left > .zero else { return .none }
                        if let seen = try? await transport.identify(address, within: min(lookLimit, Self.seconds(left))) {
                            return seen == pin ? .home(address) : .other
                        }
                        guard within > lookLimit else { return .none }
                        try Task.checkCancellation()
                        try await Task.sleep(until: started.advanced(by: .seconds(pause)), clock: clock)
                    }
                }
            }
            var other = false
            for try await seen in group {
                switch seen {
                case .home(let address):
                    group.cancelAll()
                    return address
                case .other: other = true
                case .none: break
                }
            }
            if other { throw LinkFailure.notTheHome }
            return nil
        }
        guard let found else { throw LinkFailure.noAnswer(sent: false) }
        return found
    }

    private static func seconds(_ duration: Duration) -> TimeInterval {
        Double(duration.components.seconds) + Double(duration.components.attoseconds) / 1e18
    }

    public func pair(code: String, at home: FoundHome, account: String?, name: String? = nil, offers: [String] = [],
                     phone: WhichPhone = .unsaid) async throws -> FreshAnswer {
        try await pair(code: code, at: home.address, pin: home.fingerprint, account: account, name: name, offers: offers, phone: phone)
    }

    private func pair(code: String, at address: URL, pin: String?, account: String?, name: String?, offers: [String],
                      phone: WhichPhone, reached: Bool = false) async throws -> FreshAnswer {
        let digits = code.trimmingCharacters(in: .whitespaces)
        guard Self.isCode(digits) else { throw LinkFailure.code }
        let account = try account.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : try Self.account($0) }
        guard account == nil || device.kind == .phone else { throw LinkFailure.account }
        if let pin, !reached { _ = try await reach([address], pin: pin) }
        let pass: String = try storing.withLock {
            let held = try stored()
            if let attempt = held.flatMap({ $0.paired ? $0.attempt : Attempt(name: $0.name, pass: $0.pass, pin: $0.pin) }),
               attempt.isAgain(at: address, pin: pin) {
                return attempt.pass
            }
            let attempt = Attempt(name: address.absoluteString, pass: try Self.newPass(), pin: pin)
            if var held, held.paired {
                held.attempt = attempt
                try store(held)
            } else {
                try store(Stored(name: attempt.name, pass: attempt.pass, paired: false, pin: pin))
            }
            return attempt.pass
        }
        var body: [String: Any] = ["code": digits, "pass": pass, "kind": device.kind.rawValue,
                                   "model": device.model, "offers": offers.sorted()]
        if let serial4 = device.serial4 { body["serial4"] = serial4 }
        if let account { body["account"] = account }
        if let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty { body["name"] = name }
        switch phone {
        case .unsaid: break
        case .continuing(let unit): body["unit"] = unit
        case .another: body["new"] = true
        }
        let bytes = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        let budget = budget(for: "POST /v1/pair")
        let send = { () async throws -> HomeResponse in
            let (headers, wait) = try self.waiting([Self.deviceHeader: self.device.header, "Content-Type": "application/json"],
                                                   Self.silence, on: budget)
            var request = HomeRequest(method: "POST", url: Self.route(address, "/v1/pair"), headers: headers, body: .json(bytes), timeout: wait)
            request.pin = pin
            let token = self.newest.sending()
            var response = try await self.perform(request)
            response.sent = token
            return response
        }
        var response = try await sending(on: budget, send)
        response.pass = pass
        guard response.status == 200 else { throw failure(response) }
        guard let object = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any],
              let inner = object["answer"], let bytes = try? JSONSerialization.data(withJSONObject: inner),
              let answer = Answer(body: bytes) else { throw LinkFailure.unreadable(response.status) }
        if answer.keyed, let becomeKeyed, !files.keyed {
            try storing.withLock {
                let held = try stored()
                do {
                    try becomeKeyed()
                } catch {
                    if !files.keyed { try? dropAttempt(held) }
                    throw error
                }
                if let held { try store(held) }
            }
        }
        let landed: FreshAnswer? = try storing.withLock {
            guard let held = try stored(), held.pass == pass || (held.paired && held.attempt?.pass == pass) else {
                throw LinkFailure.noAnswer(sent: true)
            }
            try store(Stored(name: address.absoluteString, pass: pass, paired: true, unit: answer.unit.isEmpty ? nil : answer.unit, pin: pin))
            newest.forget()
            do { return try land(answer, from: response).0 } catch LinkFailure.noAnswer { return nil }
        }
        answered.set(address, at: clock(), on: facts(of: [address]))
        reachPaired()
        guard let fresh = landed else { return try await exchange(offers: offers) }
        let kept = try judging(fresh, token: tick())
        newest.landed()
        readClockIfOwed()
        return kept
    }

    private func dropAttempt(_ held: Stored?) throws {
        guard var held, held.paired else { return try credentials.delete() }
        held.attempt = nil
        try store(held)
    }

    public func forget() throws {
        try storing.withLock {
            try credentials.delete()
            try? FileManager.default.removeItem(at: answerFile)
            try? FileManager.default.removeItem(at: clockFile)
            try? FileManager.default.removeItem(at: countsFile)
            counts.forget()
            newest.forget()
            clocks.set(nil)
        }
        reachForgotten()
        clocks.changed()
    }


    public func exchange(offers: [String] = [], drained: Bool = false,
                         settings: [String: [String: JSON]]? = nil) async throws -> FreshAnswer {
        try await exchanges.run {
            var stated = told.trying(at: clock())
            var under: String?
            let body = { (pass: String) throws -> HomeRequest.Body in
                stated = self.told.trying(at: self.clock())
                under = pass
                return .json(try self.exchangeBody(stated, under: pass, offers: offers, drained: drained, settings: settings))
            }
            let response = try await contact("POST", "/v1/exchange", ["Content-Type": "application/json"],
                                             body, timeout: Self.silence, whileHeld: true,
                                             route: drained ? "POST /v1/exchange drained" : "POST /v1/exchange", lands: true)
            guard response.status == 200 else { throw failure(response) }
            let fresh = try keep(response)
            told.carried(stated)
            if let through = stated.riding.through, through.pass == under {
                for (source, value) in through.sources {
                    if let months = value.months { keep(months, of: source, under: fresh.pass) }
                }
            }
            return fresh
        }
    }

    private func exchangeBody(_ stated: Told.Statement, under pass: String, offers: [String], drained: Bool,
                          settings: [String: [String: JSON]]?) throws -> Data {
        var fields: [String: Any] = ["offers": offers.sorted()]
        if drained { fields["drained"] = true }
        if let grants = stated.own.grants { fields["grants"] = grants }
        if let found = stated.riding.found { fields["found"] = found }
        if let imports = stated.own.imports { fields["imports"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(imports)) }
        if let sending = stated.riding.sending { fields["sending"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(sending)) }
        if let room = stated.own.room { fields["room"] = room.rawValue }
        fields["network"] = mobile(pressed: false).stated.rawValue
        if let recorder = stated.own.recorder { fields["recorder"] = recorder.stated }
        if let stores = stated.own.stores { fields["stores"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(stores)) }
        if let through = stated.riding.through, through.pass == pass {
            fields["through"] = Dictionary(uniqueKeysWithValues: through.sources.map { source, value in
                (source, value.stated(months: value.months.flatMap { owed($0, of: source, under: newest.fresh(under: pass)?.pass) }))
            })
        }
        if let settings { fields["settings"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) }
        return try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
    }

    public func tell(grants: [String: String]) {
        guard told.keep(at: clock(), { $0.own.grants = grants }) else { return }
        telling()
    }

    public func tell(sending: Sending) {
        told.hold { $0.riding.sending = sending }
    }

    public func tell(found: [String]) {
        told.hold { $0.riding.found = found.sorted() }
    }

    public func tell(through value: Through, of source: String, pass: String) {
        storing.withLock {
            guard let held = try? stored(), held.paired, let answer = newest.fresh(under: held.pass), answer.pass == pass,
                  answer.sources[source] != nil else { return }
            told.hold { statement in
                var kept = statement.riding.through.flatMap { $0.pass == held.pass ? $0 : nil } ?? Told.Throughs(pass: held.pass)
                kept.sources[source] = value
                statement.riding.through = kept
            }
        }
    }

    public func monthsOwed(_ months: [String: Through.Month], of source: String) -> [String: Through.Month]? {
        guard let held = try? stored(), held.paired else { return months }
        return owed(months, of: source, under: newest.fresh(under: held.pass)?.pass)
    }

    public func homeKept(months: [String: Through.Month], of source: String, pass: String) {
        keep(months, of: source, under: pass)
        storing.withLock {
            guard let held = try? stored(), held.paired, newest.fresh(under: held.pass)?.pass == pass else { return }
            told.hold { statement in
                guard var through = statement.riding.through, through.pass == held.pass, let value = through.sources[source],
                      value.months.map({ $0 != months }) == true else { return }
                through.sources[source] = value.with(months: nil)
                statement.riding.through = through
            }
        }
    }

    private func owed(_ months: [String: Through.Month], of source: String, under pass: String?) -> [String: Through.Month]? {
        guard let pass else { return months }
        return counts.months(of: source, under: pass, read: readCounts) == months ? nil : months
    }

    private func keep(_ months: [String: Through.Month], of source: String, under pass: String) {
        counts.keep(months, of: source, under: pass, read: readCounts) { [files, countsFile] kept in
            guard let data = try? JSONEncoder().encode(kept) else { return }
            try? FileManager.default.createDirectory(at: countsFile.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? files.replace(countsFile, with: data, commit: .atomic)
        }
    }

    private func readCounts() -> Counts.Kept? {
        (try? files.read(countsFile, maximumBytes: Self.mostKept)).flatMap { try? JSONDecoder().decode(Counts.Kept.self, from: $0) }
    }

    public func through(of source: String) -> Through? {
        guard let held = try? stored(), held.paired, let through = told.now.riding.through, through.pass == held.pass else {
            return nil
        }
        return through.sources[source]
    }

    public func tell(imports: [MacImport]) {
        guard told.keep(at: clock(), { $0.own.imports = imports }) else { return }
        telling()
    }

    public func tell(room: Room) {
        guard told.keep(at: clock(), { $0.own.room = room }) else { return }
        telling()
    }

    public func mobile(pressed: Bool) -> MobileData.Moment {
        let home = (try? name())?.flatMap(\.host) ?? ""
        return MobileData.Moment(path: network?.facts?.cost ?? .costly, choice: choice,
                                 loopback: Self.isLoopback(host: home), pressed: pressed)
    }

    public func mobileChanges() -> AsyncStream<Void> {
        AsyncStream { reader in
            let id = UUID()
            chosen.listen(id, reader)
            let paths = network.map { watch in
                let first = watch.facts?.cost
                return Task {
                    var last = first
                    for await facts in watch.changes() where facts.cost != last {
                        last = facts.cost
                        reader.yield()
                    }
                }
            }
            reader.onTermination = { [weak self] _ in
                paths?.cancel()
                self?.chosen.drop(id)
            }
        }
    }

    private var choice: MobileData.Choice {
        chosen.choice ?? newest.fresh?.mobileData ?? saved?.mobileData ?? .now
    }

    private func choose(_ choice: MobileData.Choice, after sent: Int) {
        let was = self.choice
        chosen.take(choice, after: sent)
        if self.choice != was { chosen.changed() }
    }

    private func telling() {
        guard !tellsHeld.owe() else { return }
        Task { _ = try? await exchange() }
    }

    public func tellsWait(for ready: @escaping @Sendable () async -> Void) {
        tellsHeld.hold()
        Task { [weak self] in
            await ready()
            guard let self, tellsHeld.release() else { return }
            telling()
        }
    }

    public func tell(recorder: RecorderStatement) {
        guard told.keep(at: clock(), { $0.own.recorder = recorder }) else { return }
        telling()
    }

    public func tell(recorder: RecorderStatement, grants: [String: String]) {
        guard told.keep(at: clock(), {
            $0.own.recorder = recorder
            $0.own.grants = grants
        }) else { return }
        telling()
    }

    public func tell(stores: StoresStated) {
        guard told.keep(at: clock(), { $0.own.stores = stores }) else { return }
        telling()
    }

    public var owesExchange: Bool { told.owed }

    public func owe() {
        told.hold { $0.riding.changes += 1 }
    }

    public var fresh: FreshAnswer? {
        guard waiting.now != true else { return nil }
        return newest.fresh
    }

    public func onAnswer(_ landed: @escaping @Sendable () -> Void) {
        newest.observe(landed)
    }

    public struct File: Sendable, Equatable {
        public let name: String
        public let url: URL
        public let bytes: Int64
        public let kept: Bool

        public init(name: String, url: URL, bytes: Int64, kept: Bool = true) {
            self.name = name
            self.url = url
            self.bytes = bytes
            self.kept = kept
        }
    }

    public func send(bundle file: URL, id: String, files given: [File] = [], kind: WriteKind, pressed: Bool = false,
                     compress: Bool = false, sent: (@Sendable (Int64) -> Void)? = nil) async throws -> FreshAnswer {
        let path = try bundlePath(file, id)
        let compressing = compress && device.kind == .mac
        if compressing { _ = try moving(kind, bytes: 0, pressed: pressed) }
        let packed = try packed(file, compress: compressing)
        defer { packed.drop() }
        let crossing = try moving(kind, bytes: packed.bytes, pressed: pressed)
        if !given.isEmpty {
            let holding = try await holding(Set(given.map(\.name)))
            let owed = given.filter { !holding.whole($0.name) }
            for file in owed.filter({ holding.partly[$0.name] != nil }) + owed.filter({ holding.partly[$0.name] == nil }) {
                try await put(file, from: holding.partly[file.name] ?? 0, kind: kind, pressed: pressed)
            }
        }
        let headers = ["Content-Type": "application/zip", Self.kindHeader: kind.rawValue].merging(packed.headers) { _, new in new }
        let progress = sent.map { heard in UploadProgress { heard(packed.raw(of: $0)) } }
        let bundle = { [self] in
            try await contact("PUT", path, headers, packed.body,
                              timeout: URLSessionTransport.uploadSilence, crossing: crossing, route: "PUT /v1/bundles/<id>",
                              lands: true, progress: progress)
        }
        var response = try await bundle()
        if let missing = Self.missingFiles(response) {
            let named = given.filter { missing.contains($0.name) }
            guard !named.isEmpty else { throw failure(response) }
            for file in named { try await put(file, from: 0, kind: kind, pressed: pressed) }
            response = try await bundle()
        }
        guard response.status == 200 || response.status == 201 else { throw failure(response) }
        return try keep(response)
    }

    private func moving(_ kind: WriteKind, bytes: Int64, pressed: Bool) throws -> MobileData.Crossing {
        switch mobile(pressed: pressed).decide(kind, bytes: bytes) {
        case .moves(let allowed): return allowed
        case .waits(let wait): throw LinkFailure.waits(wait)
        }
    }

    public func stage(file: File, source: String, from offset: Int64 = 0, kind: WriteKind, pressed: Bool = false,
                      sent: (@Sendable (Int64) -> Void)? = nil) async throws {
        try await put(file, from: offset, kind: kind, pressed: pressed, source: device.kind == .mac ? source : nil,
                      progress: sent.map(UploadProgress.init))
    }

    private func put(_ file: File, from offset: Int64, kind: WriteKind, pressed: Bool, source: String? = nil,
                     progress: UploadProgress? = nil, again: Bool = true) async throws {
        guard file.name.hasPrefix("sha256:"), file.name.utf8.count == 71, let name = Self.encoded(file.name) else {
            throw LinkFailure.unusableID
        }
        let crossing = try moving(kind, bytes: file.bytes, pressed: pressed)
        var headers = ["Content-Type": "application/octet-stream", Self.kindHeader: kind.rawValue, Self.offsetHeader: String(offset)]
        if let source { headers[Self.sourceHeader] = source }
        let response = try await contact("PUT", "/v1/files/" + name, headers, body(of: file, from: offset),
                                         timeout: URLSessionTransport.uploadSilence, crossing: crossing,
                                         route: "PUT /v1/files/<name>", progress: progress)
        switch response.status {
        case 200, 201:
            return
        case 409 where again:
            guard let held = Self.offsetHeld(response) else { throw failure(response) }
            try await put(file, from: held, kind: kind, pressed: pressed, source: source, progress: progress, again: false)
        default:
            throw failure(response)
        }
    }

    private func body(of file: File, from offset: Int64) -> HomeRequest.Body {
        guard offset < file.bytes else { return .empty }
        let url = file.url
        let road = file.kept ? files : Self.outside
        guard offset > 0 || (file.kept && files.keyed) else { return .file(url) }
        return .stream(size: file.bytes - offset, open: HomeRequest.Opener { try road.reader(url, from: offset) })
    }

    private static let outside = DeviceFiles(.plain)

    static let offsetHeader = "Upload-Offset"

    private static func offsetHeld(_ response: HomeResponse) -> Int64? {
        guard let object = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any],
              object["code"] as? String == "UPLOAD_OFFSET" else { return nil }
        guard let held = (object["held"] as? NSNumber)?.int64Value, held >= 0 else { return nil }
        return held
    }

    private static func missingFiles(_ response: HomeResponse) -> Set<String>? {
        guard response.status == 409, let object = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any],
              object["code"] as? String == "FILES_MISSING" else { return nil }
        return Set((object["missing"] as? [String: Any])?["files"] as? [String] ?? [])
    }

    private func upload(_ file: URL) throws -> (body: HomeRequest.Body, bytes: Int64) {
        let bytes = Int64(try files.size(of: file))
        guard files.keyed else { return (.file(file), bytes) }
        let files = files
        return (.stream(size: bytes, open: HomeRequest.Opener { try files.reader(file) }), bytes)
    }

    private struct Packed {
        let body: HomeRequest.Body
        let bytes: Int64
        let raw: Int64
        var made: URL?

        var headers: [String: String] {
            made == nil ? [:] : ["Content-Encoding": "gzip", HomeLink.uncompressedLengthHeader: String(raw)]
        }

        func raw(of wire: Int64) -> Int64 {
            guard made != nil, bytes > 0 else { return wire }
            guard wire < bytes else { return raw }
            return Int64((Double(wire) * Double(raw) / Double(bytes)).rounded(.down))
        }

        func drop() {
            if let made { try? FileManager.default.removeItem(at: made) }
        }
    }

    private func packed(_ file: URL, compress: Bool) throws -> Packed {
        let (body, bytes) = try upload(file)
        let plain = Packed(body: body, bytes: bytes, raw: bytes)
        guard compress else { return plain }
        let made = FileManager.default.temporaryDirectory.appendingPathComponent("lifestream-\(UUID().uuidString).gz")
        guard (try? Gzip.compress(file, to: made, files: files)) == true, let gz = try? upload(made), gz.bytes < bytes else {
            try? FileManager.default.removeItem(at: made)
            return plain
        }
        return Packed(body: gz.body, bytes: gz.bytes, raw: bytes, made: made)
    }

    private func bundlePath(_ file: URL, _ id: String) throws -> String {
        do {
            _ = try paired()
            if let floor = saved?.home.floors[device.kind.rawValue], Self.order(device.version, floor) < 0 {
                throw LinkFailure.tooOld(floor: floor)
            }
        } catch {
            observe(error, token: tick())
            throw error
        }
        let prefix = device.kind == .phone ? "/v1/bundles/" : "/v1/acquisitions/"
        guard let path = Self.encoded(id) else { throw LinkFailure.unusableID }
        return prefix + path
    }


    public func setSetting(connector: String, member: String, value: JSON, was: JSON?) async throws -> SettingOutcome {
        struct Body: Encodable {
            let connector: String
            let member: String
            let value: JSON
            let was: JSON?
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let body = try encoder.encode(Body(connector: connector, member: member, value: value, was: was))
        return try await postSetting(body) { (try? JSONDecoder().decode(SettingAnswer.self, from: $0.body))?.landed.value }
    }

    public func setHomeSetting(key: String, value: JSON) async throws -> SettingOutcome {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return try await postSetting(try encoder.encode([key: value])) { response in
            if let unit, key == MobileData.key(of: unit), case .string(let word) = value, let choice = MobileData.Choice(rawValue: word) {
                choose(choice, after: newest.sending())
            }
            return value
        }
    }

    private func postSetting(_ body: Data, landed: (HomeResponse) -> JSON?) async throws -> SettingOutcome {
        let response: HomeResponse
        do {
            response = try await contact("POST", "/v1/settings", ["Content-Type": "application/json"], .json(body))
        } catch LinkFailure.noAnswer, LinkFailure.notTheHome {
            return .unreachable
        }
        switch response.status {
        case 200:
            return .taken(landed(response))
        case 409:
            struct Changed: Decodable {
                let code: String
                let value: JSON
            }
            guard let changed = try? JSONDecoder().decode(Changed.self, from: response.body), changed.code == "CHANGED" else { return .unreachable }
            return .changed(changed.value)
        case 403:
            let code = (try? JSONSerialization.jsonObject(with: response.body) as? [String: Any])?["code"] as? String
            return code == "PRINCIPAL_SCOPE" ? .refused : .unreachable
        case 422:
            return .refused
        case 503 where Self.unanswered(response) != nil:
            let said = Self.unanswered(response)
            let again = said?.again == true, began = said?.began == true
            return again && began ? .saving : .unknown(ReachWords.unanswered(again: again, began: began))
        default:
            return .unreachable
        }
    }


    public enum StreamChange: Sendable, Equatable {
        case turnOff
        case pause
        case resume
        case pauseHistory
        case resumeHistory
    }

    public func change(stream id: String, _ change: StreamChange) async throws {
        guard let path = Self.encoded(id) else { throw LinkFailure.unusableID }
        let said: [String: Bool] = switch change {
        case .turnOff: ["on": false]
        case .pause: ["paused": true]
        case .resume: ["paused": false]
        case .pauseHistory: ["paused": true, "history": true]
        case .resumeHistory: ["paused": false, "history": true]
        }
        let body = try JSONSerialization.data(withJSONObject: said, options: [.sortedKeys])
        let response = try await contact("POST", "/v1/connectors/" + path, ["Content-Type": "application/json"], .json(body),
                                         route: "POST /v1/connectors/<id>")
        guard response.status == 200 else { throw failure(response) }
    }


    public func restore() async throws -> Restore {
        guard let response = try await get("/v1/restore"), let restore = Restore(body: response.body) else {
            throw LinkFailure.unreadable(200)
        }
        return restore
    }


    public func act(need: String, do act: String, of source: String? = nil) async throws {
        var sent = ["need": need, "do": act]
        if let source { sent["of"] = source }
        let body = try JSONSerialization.data(withJSONObject: sent, options: [.sortedKeys])
        let response = try await contact("POST", "/v1/act", ["Content-Type": "application/json"], .json(body))
        guard response.status == 200 else { throw failure(response) }
    }

    public func choose(need: String, account: String) async throws {
        let sent = ["need": need, "do": "choose", "account": account]
        let body = try JSONSerialization.data(withJSONObject: sent, options: [.sortedKeys])
        let response = try await contact("POST", "/v1/act", ["Content-Type": "application/json"], .json(body))
        guard response.status == 200 else { throw failure(response) }
    }

    public func process(_ ask: Made.Ask, route: String) async throws {
        let sent = ["family": ask.family, "item": ask.item, "prompt": ask.prompt, "route": route]
        let body = try JSONSerialization.data(withJSONObject: sent, options: [.sortedKeys])
        let response = try await contact("POST", "/v1/process", ["Content-Type": "application/json"], .json(body))
        guard response.status == 200 else { throw failure(response) }
    }

    public func verifyHome() async throws {
        let response = try await contact("POST", "/v1/home/verify", [:], .empty, timeout: Self.silence)
        guard response.status == 202 else { throw failure(response) }
    }

    private func keep(_ answer: Answer, from response: HomeResponse) throws -> FreshAnswer {
        let was = choice
        let (fresh, newer) = try storing.withLock { try land(answer, from: response) }
        if newer { chosen.answered(sent: response.sent ?? 0) }
        if choice != was { chosen.changed() }
        let kept = try judging(fresh, token: response.sent ?? tick())
        if newer { newest.landed() }
        readClockIfOwed()
        return kept
    }

    private func keep(_ response: HomeResponse) throws -> FreshAnswer {
        guard let answer = Answer(body: response.body) else {
            observe(.answered, token: response.sent ?? tick(), moves: true)
            throw LinkFailure.unreadable(response.status)
        }
        return try keep(answer, from: response)
    }

    private func judging(_ fresh: FreshAnswer, token: Int) throws -> FreshAnswer {
        do {
            let kept = try judged(fresh)
            observe(.answered, token: token, moves: true)
            return kept
        } catch {
            observe(.needsUpdate(.home), token: token, moves: true)
            throw error
        }
    }


    public var homeClock: HomeClock? {
        keptClock.clock
    }

    public var keptClock: KeptClock {
        clocks.kept { (try? files.read(clockFile, maximumBytes: Self.mostKept)).flatMap(HomeClock.init(body:)) }
    }

    public struct KeptClock: Sendable, Equatable {
        public let clock: HomeClock?
        public let revision: Int

        public init(clock: HomeClock?, revision: Int) {
            self.clock = clock
            self.revision = revision
        }
    }

    public func onHomeClock(_ changed: @escaping @Sendable () -> Void) {
        clocks.observe(changed)
    }

    private func readClockIfOwed() {
        guard device.kind == .phone, let named = newest.fresh?.clock, homeClock?.id != named, clocks.begin(named) else { return }
        clocks.started(named, Task { [self] in
            defer { clocks.end(named) }
            guard let response = try? await get("/v1/clock"), let read = HomeClock(body: response.body), let id = read.id else { return }
            let kept: Bool = storing.withLock {
                guard let held = try? stored(), held.paired, newest.fresh?.clock == id else { return false }
                do {
                    try FileManager.default.createDirectory(at: clockFile.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try files.replace(clockFile, with: response.body, commit: .atomic)
                } catch {
                    return false
                }
                clocks.set(read)
                return true
            }
            if kept { clocks.changed() }
        })
    }

    func clockReadsEnded() async {
        for task in clocks.inFlight() { await task.value }
    }

    private func judged(_ fresh: FreshAnswer) throws -> FreshAnswer {
        let waits = device.waits(for: fresh.home)
        waiting.set(waits)
        if waits { throw LinkFailure.homeTooOld }
        return fresh
    }

    private func land(_ answer: Answer, from response: HomeResponse) throws -> (FreshAnswer, Bool) {
        guard let pass = response.pass, var held = try? stored(), held.paired, held.pass == pass else { throw LinkFailure.noAnswer(sent: true) }
        if !newest.taken(answer.turn, sent: response.sent ?? 0, else: { saved?.turn }) {
            guard let kept = newest.fresh, kept.pass == answer.pass else { throw LinkFailure.noAnswer(sent: true) }
            return (kept, false)
        }
        let at = clock()
        let listed = answer.addresses.map(\.absoluteString)
        if !listed.isEmpty, held.listed != listed {
            held.listed = listed
            try? store(held)
        }
        if let object = try? JSONSerialization.jsonObject(with: answer.body),
           let data = try? JSONSerialization.data(withJSONObject: ["at": at.timeIntervalSince1970, "answer": object],
                                                  options: [.sortedKeys]) {
            try? FileManager.default.createDirectory(at: answerFile.deletingLastPathComponent(),
                                                     withIntermediateDirectories: true)
            try? files.replace(answerFile, with: data, commit: .atomic)
        }
        let fresh = FreshAnswer(answer, at: at)
        newest.set(fresh, under: pass)
        told.hold { statement in
            statement.riding.through = statement.riding.through.flatMap { through in
                through.pass == pass ? Told.Throughs(pass: pass, sources: through.sources.filter { answer.sources[$0.key] != nil }) : nil
            }
        }
        return (fresh, true)
    }

    private func holding() throws {
        if waiting.now ?? saved.map({ device.waits(for: $0.home) }) ?? (device.stamp != nil) { throw LinkFailure.homeTooOld }
    }

    func failure(_ response: HomeResponse) -> LinkFailure {
        let object = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any]
        let code = object?["code"] as? String ?? "HTTP_\(response.status)"
        let message = object?["message"] as? String ?? "Lifestream refused with \(response.status)"
        switch (response.status, code) {
        case (409, "PAIR_WHICH_PHONE"):
            return .whichPhone((object?["phones"] as? [[String: Any]] ?? []).compactMap(PhoneChoice.init))
        case (409, "FILES_MISSING") where device.kind == .mac:
            return .filesMissing(Self.missingFiles(response) ?? [])
        case (409, "UPLOAD_ACTIVE"):
            return .busy(retryAfter: response.header("Retry-After").flatMap(TimeInterval.init))
        case (409, "STALE"):
            guard let answer = (object?["answer"]).flatMap({ try? JSONSerialization.data(withJSONObject: $0) })
                    .flatMap(Answer.init(body:)) ?? Answer(body: response.body) else { return .unreadable(409) }
            do { return .stale(try keep(answer, from: response)) } catch { return error as? LinkFailure ?? .noAnswer(sent: true) }
        case (426, _):
            return .tooOld(floor: object?["floor"] as? String ?? "")
        case (422, "CLOCK_AHEAD"):
            return .clockAhead
        case (503, "OUTCOME_UNKNOWN"):
            let said = Self.unanswered(response)
            return .unanswered(again: said?.again == true, began: said?.began == true)
        case (503, _), (500...599, _):
            return .unavailable(code: code, message: object?["message"] as? String,
                                retryAfter: response.header("Retry-After").flatMap(TimeInterval.init),
                                notNow: response.status == 503 && code == Self.notNow ? NotNow.read(response.body, object) : nil)
        default:
            return .refused(status: response.status, code: code, message: message)
        }
    }


    func perform(_ request: HomeRequest) async throws -> HomeResponse {
        do {
            return try await transport.perform(request)
        } catch is NotTheHome {
            throw LinkFailure.notTheHome
        } catch {
            throw Self.reached(error)
        }
    }

    func stream(_ request: HomeRequest) async throws -> HomeStream {
        do {
            return try await transport.stream(request)
        } catch is NotTheHome {
            throw LinkFailure.notTheHome
        } catch {
            throw Self.reached(error)
        }
    }

    func bytes(_ request: HomeRequest, taking: @escaping HomeBytes.Taking) async throws -> HomeBytes {
        do {
            return try await transport.bytes(request, taking: taking)
        } catch is NotTheHome {
            throw LinkFailure.notTheHome
        } catch {
            throw Self.reached(error)
        }
    }

    func contact(_ method: String, _ path: String, _ extra: [String: String], _ body: HomeRequest.Body,
                 timeout: TimeInterval = HomeLink.silence, within: TimeInterval? = nil, whileHeld: Bool = false,
                 crossing: MobileData.Crossing = .any, route: String? = nil, lands: Bool = false,
                 progress: UploadProgress? = nil) async throws -> HomeResponse {
        try await contact(method, path, extra, { _ in body }, timeout: timeout, within: within, whileHeld: whileHeld,
                          crossing: crossing, route: route, lands: lands, progress: progress)
    }

    func contact(_ method: String, _ path: String, _ extra: [String: String], _ body: @escaping (_ pass: String) throws -> HomeRequest.Body,
                 timeout: TimeInterval = HomeLink.silence, within: TimeInterval? = nil, whileHeld: Bool = false,
                 crossing: MobileData.Crossing = .any, route: String? = nil, lands: Bool = false,
                 progress: UploadProgress? = nil) async throws -> HomeResponse {
        let key = route ?? Self.route(method: method, path: path)
        let budget = budget(for: key)
        let once: () async throws -> HomeResponse = {
            try await self.contact(method, path, extra, body, timeout: timeout, within: within, whileHeld: whileHeld,
                                   route: key, budget: budget) { request, pass in
                var request = request
                request.crossing = crossing
                request.progress = progress
                let sent = self.newest.sending()
                var response = try await self.perform(request)
                response.pass = pass
                response.sent = sent
                return response
            }
        }
        while true {
            let token = tick()
            let response: HomeResponse
            do {
                response = try await sending(on: budget, once)
            } catch LinkFailure.noAnswer(let sent) where tripped(since: token) && (!sent || Self.sentAgain(key))
                        && budget?.hasSend(clock()) ?? true {
                continue
            } catch {
                observe(error, token: token)
                throw error
            }
            if !(lands && Self.landsAnswer(response)) { observe(response, token: token) }
            return response
        }
    }

    func budget(for route: String) -> Budget? {
        Self.acts[route].map { Budget($0, now: clock()) }
    }

    func sending(on budget: Budget?, _ once: () async throws -> HomeResponse) async throws -> HomeResponse {
        guard let budget else { return try await once() }
        return try await budget.sending(clock, once)
    }

    func waiting(_ headers: [String: String], _ timeout: TimeInterval, on budget: Budget?) throws -> ([String: String], TimeInterval) {
        guard let budget else { return (headers, timeout) }
        guard let wait = budget.wait(clock()) else { throw LinkFailure.noAnswer(sent: false) }
        return (headers.merging([Self.waitHeader: String(Int((wait * 1000).rounded(.down)))]) { _, new in new }, wait)
    }

    static func route(method: String, path: String) -> String {
        method + " " + (path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? path)
    }

    private static func landsAnswer(_ response: HomeResponse) -> Bool {
        guard response.status != 409 else {
            return ((try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any])?["code"] as? String == "STALE"
        }
        return (200...299).contains(response.status)
    }

    func tick() -> Int {
        newest.sending()
    }

    func tripped(since token: Int) -> Bool {
        reachBox.lock.withLock { reachBox.trip > token }
    }

    static func sendAgain(_ response: HomeResponse) -> Bool {
        unanswered(response)?.again == true
    }

    static func unanswered(_ response: HomeResponse) -> (again: Bool, began: Bool)? {
        guard response.status == 503, let object = (try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any],
              object["code"] as? String == "OUTCOME_UNKNOWN" else { return nil }
        return (object["again"] as? Bool == true, object["began"] as? Bool == true)
    }

    static func refusedNotNow(_ response: HomeResponse) -> Bool {
        guard response.status == 503 else { return false }
        return ((try? JSONSerialization.jsonObject(with: response.body)) as? [String: Any])?["code"] as? String == Self.notNow
    }

    static let acts: [String: Relay] = [
        "POST /v1/pair": Relay(again: true),
        "POST /v1/account": Relay(again: true),
        "POST /v1/settings": Relay(again: true),
        "POST /v1/process": Relay(again: true),
        "POST /v1/connectors/<id>": Relay(again: true),
        "POST /v1/owner/act": Relay(again: true),
        "POST /v1/act": Relay(again: false),
        "POST /v1/refresh": Relay(again: true),
        "POST /v1/seal": Relay(again: false),
        "POST /v1/signin/<way>": Relay(again: false),
        "POST /v1/exchange drained": Relay(again: false),
        "POST /v1/agents/answer": Relay(again: false),
        "GET /v1/agents/waiting": Relay(again: true),
        "GET /v1/places/suggest": Relay(again: false, wait: 5),
        "POST /v1/feedback/draft": Relay(again: true),
        "POST /v1/feedback/screenshot": Relay(again: true),
        "POST /v1/feedback/send": Relay(again: true),
    ]

    static let answeredAgain: Set<String> = ["POST /v1/exchange", "POST /v1/blobs/held", "POST /v1/imports/held", "PUT /v1/bundles/<id>",
                                             "POST /v1/ask/files", "POST /v1/ask/notes/<id>",
                                             "PUT /v1/ask/notes/<id>/<k>", "DELETE /v1/ask/notes/<id>"]

    static func sentAgain(_ route: String) -> Bool {
        acts[route]?.again ?? (route.hasPrefix("GET ") || answeredAgain.contains(route))
    }

    static func reached(_ error: Error) -> Error {
        if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled { return CancellationError() }
        return LinkFailure.noAnswer(sent: !beforeTheBody.contains((error as? URLError)?.code ?? .unknown))
    }

    static let beforeTheBody: Set<URLError.Code> = [
        .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .notConnectedToInternet, .internationalRoamingOff,
        .callIsActive, .dataNotAllowed, .secureConnectionFailed, .serverCertificateHasBadDate, .serverCertificateUntrusted,
        .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected, .clientCertificateRequired,
        .appTransportSecurityRequiresSecureConnection, .badURL, .unsupportedURL,
    ]

    func headers(_ pass: String) -> [String: String] {
        [Self.deviceHeader: device.header, "Authorization": "Bearer " + pass]
    }

    func contact<Answer>(_ method: String, _ path: String, _ extra: [String: String], _ body: (_ pass: String) throws -> HomeRequest.Body,
                         timeout: TimeInterval, within: TimeInterval? = nil, whileHeld: Bool = false,
                         route: String? = nil, budget: Budget? = nil,
                         send: (HomeRequest, _ pass: String) async throws -> Answer) async throws -> Answer {
        let within = within ?? self.look
        let (home, pass) = try paired()
        if !whileHeld { try holding() }
        let headers = headers(pass).merging(extra) { _, new in new }
        let facts = facts(of: home.addresses)
        var left = home.addresses.filter { Self.road(to: $0, on: facts) }
        var sent = false
        var other = false
        var failed: LinkFailure { sent ? .noAnswer(sent: true) : other ? .notTheHome : .noAnswer(sent: false) }
        while !left.isEmpty {
            let now = clock()
            let address: URL
            if let at = left.first(where: { answered.recently($0, on: facts, now: now, within: Self.answeredFor) })
                ?? left.first(where: { home.pin($0) == nil }) {
                address = at
            } else {
                guard let pin = home.pin else { throw failed }
                do {
                    address = try await look(at: left, pin: pin, within: budget.map { min(within, $0.left(now)) } ?? within)
                } catch LinkFailure.noAnswer {
                    throw failed
                }
            }
            left.removeAll { $0 == address }
            guard let stamped = try? waiting(headers, timeout, on: budget) else { throw failed }
            var request = HomeRequest(method: method, url: Self.route(address, path), headers: stamped.0, body: try body(pass), timeout: stamped.1)
            request.pin = home.pin(address)
            do {
                let answer = try await send(request, pass)
                answered.set(address, at: clock(), on: facts)
                return answer
            } catch LinkFailure.noAnswer(let lost) {
                answered.forget(address)
                sent = sent || lost
                guard !lost || Self.sentAgain(route ?? Self.route(method: method, path: path)),
                      left.isEmpty || budget.map({ $0.send(clock()) != nil }) ?? true else { throw failed }
                continue
            } catch LinkFailure.notTheHome {
                other = true
            }
        }
        throw failed
    }

    private func facts(of addresses: [URL]) -> NetworkFacts? {
        addresses.allSatisfy { Self.isLoopback(host: $0.host ?? "") } ? nil : network?.facts
    }


    private struct Stored: Codable, Equatable {
        let name: String
        let pass: String
        var paired: Bool
        var attempt: Attempt? = nil
        var unit: String? = nil
        var listed: [String]? = nil
        var pin: String? = nil

        var addresses: Addresses {
            let https = (listed ?? []).filter { URL(string: $0)?.scheme?.lowercased() == "https" && pin != nil }
            var seen = Set<String>()
            let kept = (https.isEmpty ? [name] : https).filter { seen.insert($0).inserted }
            return Addresses(addresses: kept.compactMap(URL.init(string:)), pin: pin)
        }

        enum CodingKeys: String, CodingKey {
            case name, pass, paired, attempt, unit, pin
            case listed = "addresses"
        }
    }

    struct Addresses {
        let addresses: [URL]
        let pin: String?

        func pin(_ address: URL) -> String? {
            address.scheme?.lowercased() == "https" ? pin : nil
        }
    }

    private struct Attempt: Codable, Equatable {
        let name: String
        let pass: String
        var pin: String? = nil

        func isAgain(at address: URL, pin: String?) -> Bool {
            self.pin == pin && (pin != nil || name == address.absoluteString)
        }
    }

    private func stored() throws -> Stored? {
        guard let data = try credentials.read() else { return nil }
        guard let stored = try? JSONDecoder().decode(Stored.self, from: data) else { throw LinkFailure.credentials }
        return stored
    }

    private func store(_ stored: Stored) throws {
        try credentials.write(try JSONEncoder().encode(stored))
    }

    func paired() throws -> (Addresses, String) {
        guard let stored = try stored(), stored.paired, !stored.addresses.addresses.isEmpty else { throw LinkFailure.unpaired }
        return (stored.addresses, stored.pass)
    }

    static func newPass() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw LinkFailure.credentials }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }


    public static func name(_ text: String) throws -> URL {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = URLComponents(string: trimmed), let scheme = parts.scheme?.lowercased(),
              scheme == "http" || scheme == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/", var url = parts.url else {
            throw LinkFailure.name("Enter Lifestream's address, such as https://lifestream.example.ts.net")
        }
        if scheme == "http", !isPrivate(host: host) {
            throw LinkFailure.name("Plain http reaches only loopback or a Tailscale address; use https elsewhere")
        }
        if url.absoluteString.hasSuffix("/") { url = URL(string: String(url.absoluteString.dropLast())) ?? url }
        return url
    }

    public static func account(_ text: String) throws -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.split(separator: "@", omittingEmptySubsequences: false)
        let email = parts.count == 2 && !parts[0].isEmpty && parts[1].split(separator: ".").count >= 2
            && !parts[1].hasPrefix(".") && !parts[1].hasSuffix(".")
            && !trimmed.contains(where: { $0.isWhitespace })
        let body = trimmed.hasPrefix("+") ? trimmed.dropFirst() : Substring(trimmed)
        let phone = body.allSatisfy({ $0.isASCII && ($0.isNumber || " -.()".contains($0)) })
            && body.filter(\.isNumber).count >= 7 && body.first.map({ $0.isNumber || $0 == "(" }) ?? false
        guard email || phone else { throw LinkFailure.account }
        return trimmed
    }

    static func isPrivate(host: String) -> Bool {
        let lowered = host.lowercased()
        if isLoopback(host: lowered) { return true }
        let octets = lowered.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ $0.map { (0...255).contains($0) } ?? false }) else { return false }
        return octets[0] == 100 && (64...127).contains(octets[1]!)
    }

    public static func isLoopback(host: String) -> Bool {
        ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host.lowercased())
    }

    static func road(to address: URL, on facts: NetworkFacts?) -> Bool {
        let host = address.host ?? ""
        if isLoopback(host: host) { return true }
        guard let facts else { return true }
        guard facts.online else { return false }
        return isPrivate(host: host) ? facts.tunnelUp : facts.onLocalNetwork
    }

    static func route(_ name: URL, _ path: String) -> URL {
        URL(string: name.absoluteString + path) ?? name
    }

    static func encoded(_ id: String) -> String? {
        let segments = id.split(separator: "/", omittingEmptySubsequences: false).map {
            $0.addingPercentEncoding(withAllowedCharacters: pathSegment) ?? ""
        }
        guard segments.allSatisfy({ !$0.isEmpty }) else { return nil }
        return segments.joined(separator: "/")
    }

    private static let pathSegment: CharacterSet = {
        var allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        allowed.insert(charactersIn: "-._~:@+")
        return allowed
    }()

    static func order(_ one: String, _ other: String) -> Int {
        let left = one.split(separator: "."), right = other.split(separator: ".")
        for index in 0..<max(left.count, right.count) {
            let a = index < left.count ? String(left[index]) : "0"
            let b = index < right.count ? String(right[index]) : "0"
            if let x = Int(a), let y = Int(b) {
                if x != y { return x < y ? -1 : 1 }
            } else if a != b {
                return a < b ? -1 : 1
            }
        }
        return 0
    }
}

extension HomeLink {
    public enum NotNow: Sendable, Equatable {
        case starting(Starting)
        case needs(Held)
        case busy

        static func read(_ body: Data, _ object: [String: Any]?) -> NotNow {
            let title = object?["title"] as? String, line = object?["line"] as? String
            switch object?["wait"] as? String {
            case "starting": return .starting(Starting(title: title ?? ReachWords.waiting, line: line))
            case "needs": return .needs(Held(title: title ?? "", detail: line ?? "", acts: HeldActs.read(body)))
            default: return .busy
            }
        }
    }

    public struct Starting: Sendable, Equatable {
        public let title: String
        public let line: String?

        public init(title: String, line: String? = nil) {
            self.title = title
            self.line = line
        }
    }

    public struct Held: Sendable, Equatable {
        public let title: String
        public let detail: String
        public let acts: [Act]

        public init(title: String, detail: String, acts: [Act] = []) {
            self.title = title
            self.detail = detail
            self.acts = acts
        }
    }
}

private struct HeldActs: Decodable {
    let acts: [HomeLink.Act]

    enum CodingKeys: String, CodingKey { case acts }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let stated = try container.contains(.acts) && !container.decodeNil(forKey: .acts)
        acts = stated ? try HomeLink.Act.known(container, .acts) : []
    }

    static func read(_ body: Data) -> [HomeLink.Act] {
        (try? JSONDecoder().decode(Self.self, from: body))?.acts ?? []
    }
}

public enum LinkFailure: Error, Equatable, CustomStringConvertible {
    case unpaired
    case noAnswer(sent: Bool)
    case name(String)
    case code
    case account
    case tooOld(floor: String)
    case homeTooOld
    case clockAhead
    case stale(FreshAnswer)
    case whichPhone([PhoneChoice])
    case busy(retryAfter: TimeInterval?)
    case refused(status: Int, code: String, message: String)
    case unavailable(code: String, message: String?, retryAfter: TimeInterval?, notNow: HomeLink.NotNow? = nil)
    case unanswered(again: Bool, began: Bool)
    case unreadable(Int)
    case unusableID
    case credentials
    case notTheHome
    case waits(MobileData.Wait)
    case filesMissing(Set<String>)

    public var code: String {
        switch self {
        case .unpaired: return "NO_HOME"
        case .noAnswer(let sent): return sent ? "NO_ANSWER" : "NOT_SENT"
        case .name: return "NAME"
        case .code: return "PAIR_CODE"
        case .account: return "PAIR_ACCOUNT"
        case .tooOld: return "DEVICE_TOO_OLD"
        case .homeTooOld: return "HOME_TOO_OLD"
        case .clockAhead: return "CLOCK_AHEAD"
        case .stale: return "STALE"
        case .whichPhone: return "PAIR_WHICH_PHONE"
        case .busy: return "UPLOAD_ACTIVE"
        case .refused(_, let code, _), .unavailable(let code, _, _, _): return code
        case .unanswered: return "OUTCOME_UNKNOWN"
        case .unreadable: return "ANSWER_UNREADABLE"
        case .unusableID: return "BUNDLE_ID"
        case .credentials: return "CREDENTIALS"
        case .notTheHome: return "NOT_THE_HOME"
        case .waits: return "WAITS_FOR_NETWORK"
        case .filesMissing: return "FILES_MISSING"
        }
    }

    public var description: String {
        switch self {
        case .unpaired: return "this device is not paired with Lifestream"
        case .noAnswer(let sent): return sent ? "no answer" : "not sent"
        case .name(let message): return message
        case .code: return "Enter the eight-digit code Lifestream shows"
        case .account: return "An Apple ID is an email address or a phone number."
        case .tooOld(let floor): return "update needed: Lifestream accepts this kind of device from version \(floor)"
        case .homeTooOld: return "Lifestream needs an update"
        case .clockAhead: return "this device's clock is ahead of Lifestream's"
        case .stale: return "Lifestream holds another seal; this one is sealed again"
        case .whichPhone: return "Lifestream holds a phone already: say which one this phone continues"
        case .busy: return "Lifestream is still reading this bundle from an earlier request"
        case .refused(_, _, let message): return message
        case .unavailable(let code, let message, _, _): return message ?? "Lifestream cannot take it now (\(code))"
        case .unanswered(_, let began): return began ? "Lifestream is still working on this." : "Lifestream didn't answer."
        case .unreadable(let status): return "Lifestream answered \(status) with something that is not an answer"
        case .unusableID: return "the bundle's id is not a delivery path"
        case .credentials: return "the pass could not be read or saved. Unlock this device and try again."
        case .notTheHome: return "This isn't your Mac."
        case .waits(let wait): return wait.words
        case .filesMissing(let missing): return "Lifestream lacks \(missing.count) file(s) this bundle names; they are sent again first"
        }
    }
}

public enum SettingOutcome: Sendable, Equatable {
    case taken(HomeLink.JSON?)
    case changed(HomeLink.JSON)
    case refused
    case saving
    case unknown(String)
    case unreachable
}

private final class Answered: @unchecked Sendable {
    private let lock = NSLock()
    private var last: (address: URL, at: Date, on: NetworkFacts?)?

    func set(_ address: URL, at: Date, on facts: NetworkFacts?) {
        lock.withLock { last = (address, at, facts) }
    }

    func forget(_ address: URL) {
        lock.withLock { if last?.address == address { last = nil } }
    }

    func recently(_ address: URL, on facts: NetworkFacts?, now: Date, within: TimeInterval) -> Bool {
        lock.withLock { last.map { $0.address == address && $0.on == facts && now.timeIntervalSince($0.at) < within } ?? false }
    }
}

private final class TellsHeld: @unchecked Sendable {
    private let lock = NSLock()
    private var holds = 0
    private var owed = false

    func hold() {
        lock.withLock { holds += 1 }
    }

    func owe() -> Bool {
        lock.withLock {
            guard holds > 0 else { return false }
            owed = true
            return true
        }
    }

    func release() -> Bool {
        lock.withLock {
            holds -= 1
            guard holds == 0, owed else { return false }
            owed = false
            return true
        }
    }
}

private final class Chosen: @unchecked Sendable {
    private let lock = NSLock()
    private var taken: (choice: MobileData.Choice, after: Int)?
    private var readers: [UUID: AsyncStream<Void>.Continuation] = [:]

    var choice: MobileData.Choice? { lock.withLock { taken?.choice } }

    func take(_ choice: MobileData.Choice, after sent: Int) {
        lock.withLock { taken = (choice, sent) }
    }

    func answered(sent: Int) {
        lock.withLock {
            if let held = taken, sent > held.after { taken = nil }
        }
    }

    func listen(_ id: UUID, _ reader: AsyncStream<Void>.Continuation) {
        lock.withLock { readers[id] = reader }
    }

    func drop(_ id: UUID) {
        _ = lock.withLock { readers.removeValue(forKey: id) }
    }

    func changed() {
        for reader in lock.withLock({ Array(readers.values) }) { reader.yield() }
    }
}

private final class Waiting: @unchecked Sendable {
    private let lock = NSLock()
    private var waits: Bool?

    var now: Bool? { lock.withLock { waits } }

    func set(_ value: Bool) {
        lock.withLock { waits = value }
    }
}

private final class Told: @unchecked Sendable {
    static let again: TimeInterval = 60

    struct Throughs: Equatable {
        let pass: String
        var sources: [String: Through] = [:]
    }

    struct Statement: Equatable {
        struct Own: Equatable {
            var grants: [String: String]?
            var imports: [MacImport]?
            var recorder: RecorderStatement?
            var room: Room?
            var stores: HomeLink.StoresStated?
        }
        struct Riding: Equatable {
            var found: [String]?
            var sending: Sending?
            var through: Throughs?
            var changes = 0
        }
        var own = Own()
        var riding = Riding()
    }

    private let lock = NSLock()
    private var told = Statement()
    private var tried = Statement()
    private var triedAt: Date?
    private var sent = Statement()
    private var waiting = false

    var now: Statement { lock.withLock { told } }

    var owed: Bool { lock.withLock { told != sent } }

    func carried(_ statement: Statement) {
        lock.withLock { sent = statement }
    }

    func hold(_ change: (inout Statement) -> Void) {
        lock.withLock { change(&told) }
    }

    func trying(at now: Date) -> Statement {
        lock.withLock {
            tried = told
            triedAt = now
            waiting = false
            return told
        }
    }

    func keep(at now: Date, _ change: (inout Statement) -> Void) -> Bool {
        lock.withLock {
            change(&told)
            guard !waiting else { return false }
            let due = told.own != tried.own
                || (told.own != sent.own && triedAt.map { now.timeIntervalSince($0) >= Self.again } ?? true)
            if due { waiting = true }
            return due
        }
    }
}

private final class Counts: @unchecked Sendable {
    struct Kept: Codable, Equatable {
        let pass: String
        var sources: [String: [String: Through.Month]] = [:]
    }

    private let lock = NSLock()
    private var kept: Kept??

    func months(of source: String, under pass: String, read: () -> Kept?) -> [String: Through.Month]? {
        lock.withLock { loaded(read).flatMap { $0.pass == pass ? $0.sources[source] : nil } }
    }

    func keep(_ months: [String: Through.Month], of source: String, under pass: String, read: () -> Kept?,
              write: (Kept) -> Void) {
        lock.withLock {
            var next = loaded(read).flatMap { $0.pass == pass ? $0 : nil } ?? Kept(pass: pass)
            guard next.sources[source] != months else { return }
            next.sources[source] = months
            write(next)
            kept = .some(next)
        }
    }

    func forget() {
        lock.withLock { kept = .some(nil) }
    }

    private func loaded(_ read: () -> Kept?) -> Kept? {
        if case .some(let value) = kept { return value }
        let value = read()
        kept = .some(value)
        return value
    }
}

private final class Newest: @unchecked Sendable {
    private let lock = NSLock()
    private var kept: FreshAnswer?
    private var under: String?
    private var seen: Answer.Turn?
    private var read = false
    private var sent = 0
    private var retired: [String: Int] = [:]
    private var observer: (@Sendable () -> Void)?

    var fresh: FreshAnswer? { lock.withLock { kept } }

    func fresh(under pass: String) -> FreshAnswer? { lock.withLock { under == pass ? kept : nil } }

    func observe(_ landed: @escaping @Sendable () -> Void) { lock.withLock { observer = landed } }

    func landed() { lock.withLock { observer }?() }

    func sending() -> Int {
        lock.withLock {
            sent += 1
            return sent
        }
    }

    func taken(_ turn: Answer.Turn, sent request: Int, else saved: () -> Answer.Turn?) -> Bool {
        lock.withLock {
            if let last = retired[turn.run] { return request > last }
            if !read {
                seen = seen ?? saved()
                read = true
            }
            return seen.map { turn.follows($0) } ?? true
        }
    }

    func set(_ fresh: FreshAnswer, under pass: String) {
        lock.withLock {
            if let seen, seen.run != fresh.turn.run { retired[seen.run] = sent }
            retired[fresh.turn.run] = nil
            kept = fresh
            under = pass
            seen = fresh.turn
            read = true
        }
    }

    func forget() {
        lock.withLock {
            kept = nil
            under = nil
            seen = nil
            read = true
        }
    }
}

private final class Clocks: @unchecked Sendable {
    private let lock = NSLock()
    private var kept: HomeClock??
    private var revision = 0
    private var reading: [String: Task<Void, Never>?] = [:]
    private var observer: (@Sendable () -> Void)?

    func kept(else load: () -> HomeClock?) -> HomeLink.KeptClock {
        lock.withLock {
            if kept == nil { kept = .some(load()) }
            return HomeLink.KeptClock(clock: kept ?? nil, revision: revision)
        }
    }

    func set(_ clock: HomeClock?) {
        lock.withLock {
            kept = .some(clock)
            revision += 1
        }
    }

    func begin(_ id: String) -> Bool {
        lock.withLock {
            guard reading[id] == nil else { return false }
            reading[id] = .some(nil)
            return true
        }
    }

    func started(_ id: String, _ task: Task<Void, Never>) {
        lock.withLock { if reading[id] != nil { reading[id] = task } }
    }

    func end(_ id: String) {
        lock.withLock { _ = reading.removeValue(forKey: id) }
    }

    func inFlight() -> [Task<Void, Never>] {
        lock.withLock { reading.values.compactMap { $0 } }
    }

    func observe(_ changed: @escaping @Sendable () -> Void) {
        lock.withLock { observer = changed }
    }

    func changed() {
        lock.withLock { observer }?()
    }
}
