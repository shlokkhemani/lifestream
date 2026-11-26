import AppKit
import DeviceFiles
import Evidence
import HomeLink
import ImageIO
import Passwords
import Recorder
import Shipping
import XCTest
@testable import Lifestream

@MainActor final class MacHostTests: XCTestCase {
    private var scratch: URL!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory.appendingPathComponent("host-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: scratch)
    }

    private static func privacy(_ member: String) -> [String: Any] {
        ["member": member, "value": "default", "words": "Personal details hidden", "steps": [] as [Any],
         "note": "Names, numbers and faces are replaced. The model still reads what was said.",
         "waiting": false]
    }

    private static let report: [String: Any] = HomeReport.report([
        HomeReport.connector("screen", "Screen", sources: ["screen:local:macbook-pro-0001"], setUp: true,
                             members: [HomeReport.member("refresh", "duration", panel: nil), HomeReport.member("ocr", "choice", panel: nil)]),
        HomeReport.connector("imessage", "iMessage", sources: ["imessage:person-a@example.com:macbook-pro-0001", "imessage:person-a@example.com:macbook-pro-bb17"],
                             setUp: true, members: [HomeReport.member("refresh", "duration"), HomeReport.member("start", "start", panel: "backfill")]),
        HomeReport.connector("gmail", "Gmail", before: ["Make an app password.", "Type it here."], sources: ["gmail:person-a+tag@example.com:cloud"],
                             members: [HomeReport.member("refresh", "duration"), HomeReport.member("password", "secret", panel: "account"),
                                       HomeReport.member("account", "email", panel: "account"), HomeReport.member("folders", "list"),
                                       HomeReport.member("start", "start", panel: "backfill"), HomeReport.member("pace", "duration", panel: "backfill")]),
        HomeReport.connector("whoop", "WHOOP", members: [HomeReport.member("email", "email", panel: "account"),
                                                        HomeReport.member("password", "secret", panel: "account",
                                                                          ["secret": "lifestream-whoop-password", "value": "lifestream-whoop-password.2"])]),
        HomeReport.connector("claude", "Claude", sources: ["claude:person-a@example.com:cloud"], setUp: true,
                             members: [HomeReport.member("export", "path", panel: "export", label: "Export file", ["folder": false])]),
        HomeReport.connector("whatsapp", "WhatsApp", sources: ["whatsapp:+15550000001:macbook-pro-0001"], setUp: true,
                             members: [HomeReport.member("backups", "path", panel: "comes-from", label: "the backups folder", ["folder": true])]),
        HomeReport.connector("faces", "Faces", setUp: true),
        HomeReport.granola,
        HomeReport.connector("calendar", "Calendar", members: [HomeReport.member("token", "secret", panel: "account", ["secret": "calendar-token"])])
            .merging(["roads": ["poll"]]) { $1 },
        HomeReport.connector("photos", "Photos", setUp: true,
                             members: ["llm.photos", "llm.faces", "llm.range", "privacy.photos", "privacy.faces"].map { HomeReport.member($0, "choice", panel: nil) })
            .merging(["processing": ["rows": [["member": "llm.photos", "shape": "off", "line": NSNull(), "privacy": MacHostTests.privacy("privacy.photos")],
                                              ["member": "llm.range", "shape": NSNull(), "line": NSNull(), "privacy": NSNull()]]]]) { $1 },
    ], devices: [
        HomeReport.phone("iphone-17-pro-0001", "iPhone 17 Pro", pass: "p-0000aa02", replaced: ["p-0000aa01"]),
        HomeReport.phone("iphone-15-0002", "iPhone 15", retired: true, pass: nil),
    ] + (HomeReport.fixture["devices"] as! [[String: Any]]).filter { $0["kind"] as? String == "mac" })

    private final class Paused: @unchecked Sendable {
        private let lock = NSLock()
        private var all: Set<String> = []
        private var history: Set<String> = []

        func set(_ id: String, _ on: Bool, history scope: Bool) {
            lock.withLock {
                if on {
                    _ = scope ? history.insert(id) : all.insert(id)
                } else if scope {
                    history.remove(id)
                } else {
                    all.remove(id)
                }
            }
        }

        func report(_ report: [String: Any]) -> [String: Any] {
            let (all, history) = lock.withLock { (self.all, self.history) }
            let rows = (report["connectors"] as! [[String: Any]]).map { row -> [String: Any] in
                guard let id = row["id"] as? String else { return row }
                let scopes = [all.contains(id) ? "all" : nil, history.contains(id) ? "history" : nil].compactMap { $0 }
                return row.merging(["pauses": scopes.map { ["scope": $0, "by": "you", "reason": "", "at_ms": 1_760_252_400_000] }]) { $1 }
            }
            return report.merging(["connectors": rows]) { $1 }
        }
    }

    private final class Vault: @unchecked Sendable {
        private let lock = NSLock()
        private var _locked = false
        private var _recovery = "confirmed"
        var locked: Bool {
            get { lock.withLock { _locked } }
            set { lock.withLock { _locked = newValue } }
        }
        var recovery: String {
            get { lock.withLock { _recovery } }
            set { lock.withLock { _recovery = newValue } }
        }
    }

    private func home(_ vault: Vault = Vault()) throws -> ScriptedHome {
        let paused = Paused()
        let handed = Locked<[String: String]>([:])
        return try ScriptedHome { request in
            let args = request["args"] as? [String] ?? []
            let set = Array(args.drop { $0 != "--" }.dropFirst())
            switch (request["verb"] as? String, args.first) {
            case ("connectors", _) where set.count == 4 && set[0] == "set":
                let row = (Self.report["connectors"] as! [[String: Any]]).first { $0["id"] as? String == set[1] }
                let export = row?["export"] as? [String: Any]
                let reads = export?["member"] as? String == set[2]
                let queued = reads && export?["reads"] is String && handed.value[set[1]] != set[3]
                if reads { handed.value[set[1]] = set[3] }
                let value = try? JSONSerialization.jsonObject(with: Data(set[3].utf8), options: .fragmentsAllowed)
                return ["result": ["changed": [["member": set[2], "value": value ?? NSNull()]], "queued": queued]]
            case ("vault", _): return ["result": ["key_id": "3fa2c91b", "locked": vault.locked, "recovery": vault.recovery]]
            case ("vault-recovery", _): return ["result": ["recovery": Self.recoveryKey, "recovery_slot": "r-2", "made_ms": 1_794_916_800_000]]
            case ("connectors", nil): return ["result": paused.report(Self.report)]
            case ("connectors", "pause"), ("connectors", "resume"):
                paused.set(args[1], args[0] == "pause", history: false)
                return ["result": ["done": true]]
            case ("connectors", "backfill"):
                paused.set(args[1], args[2] == "pause", history: true)
                return ["result": ["done": true]]
            case ("connectors", _) where args.last == "fax": return ["error": "fax: not a source name, nor a Streams row's id"]
            case ("connectors", _), ("principals", _), ("device", _), ("act", _): return ["result": ["done": true]]
            case ("faces", _): return ["result": ["state": args.first ?? ""]]
            case ("seal", _): return ["result": ["sealed": request["secret"] ?? "", "key": "3fa2c91b"]]
            case ("seal-field", _) where request["member"] as? String == "token":
                return ["result": ["refused": "Unlock Lifestream on MacBook Pro first.", "field": "token"]]
            case ("seal-field", _): return ["result": ["sealed": true]]
            case ("models", _) where args.contains("runner:gone"): return ["error": "no model runner:gone; the home reaches openrouter:fake-model"]
            case ("models", _): return ["result": ["openrouter": ["connected": true]]]
            case ("pause", _): return ["result": ["paused": args.first ?? "", "by": request["by"] ?? ""]]
            case ("resume", _): return ["result": ["resumed": args.last ?? ""]]
            case ("settings", _) where args.last == "0": return ["error": "model.cap is at least 1, not 0"]
            case ("settings", _): return ["result": ["changed": ["key": "model.cap"]]]
            default: return ["error": "no verb is named \(request["verb"] ?? "")"]
            }
        }
    }

    private var drop: URL { scratch.appendingPathComponent("drop", isDirectory: true) }

    private func host(_ home: ScriptedHome?, grants: @escaping () async -> [Grant: Bool] = { [:] },
                      folder: URL? = nil, settings: MacSettings? = nil,
                      locate: (@Sendable (String) -> Detection.App?)? = nil,
                      verifyHome: (@Sendable () async throws -> Void)? = nil, unit: @escaping @Sendable () -> String? = { nil },
                      stores: DeclaredStores? = nil, tellStores: @escaping (HomeLink.StoresStated) -> Void = { _ in },
                      refreshHere: (@Sendable (String) -> Void)? = nil, lines: StatusLines? = nil,
                      failed: @escaping @Sendable () -> Void = {}, probe: (@Sendable () async -> HomeLink.ReachSnapshot)? = nil,
                      pairAgain: MacHost.PairAgain? = nil, openHome: (@Sendable () async throws -> Void)? = nil,
                      sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) -> MacHost {
        let socket = home.map { HomeSocket(path: $0.path, folder: $0.folder, patience: 0.5, failed: failed) }
        let store = MemoryStore()
        store.data = Data(repeating: 7, count: 32)
        let keeper = VaultKeeper(machine: store, old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { socket })
        let needs = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        let lines = lines ?? StatusLines(recorder: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true))
        return MacHost(needs: needs, lines: lines,
                    socket: { socket }, readGrants: grants, readFolder: { folder }, locate: locate, unit: unit, verifyHome: verifyHome,
                    probe: probe, openHome: openHome, pairAgain: pairAgain,
                    refreshHere: refreshHere, stores: { stores }, tellStores: tellStores,
                    ask: .untouched, settings: settings, sleep: sleep)
    }

    private func refusal(_ work: () async throws -> String?) async -> String? {
        do {
            _ = try await work()
            return nil
        } catch {
            return (error as? HostRefusal)?.words ?? "not words: \(error)"
        }
    }

    func testTheHomesReportReadsAndOffersEachActOnlyForItsTarget() throws {
        let fixture = try JSONDecoder().decode(ConnectorsReport.self, from: JSONSerialization.data(withJSONObject: HomeReport.fixture))
        let members = fixture.connectors.flatMap { connector in connector.members.map { (connector.id, $0) } }
        let secret = try XCTUnwrap(members.first { $0.1.kind == "secret" })
        XCTAssertFalse(fixture.offers(.setting(secret.0, member: secret.1.key)), "a secret")
        let processed = { (id: String, key: String) in fixture.connector(id)?.processing?.rows.contains { $0.member == key || $0.privacy?.member == key } == true }
        for (id, member) in members where member.control != .secret && !processed(id, member.key) {
            XCTAssertEqual(fixture.offers(.setting(id, member: member.key), here: "macbook-pro-0001"), member.control != nil && member.panel != nil,
                           "\(id).\(member.key): only a member a panel draws, by its control")
        }
        let running = try XCTUnwrap(fixture.connectors.first { $0.setUp && !$0.copies.isEmpty && $0.pauses.isEmpty })
        for history in [false, true] {
            XCTAssertTrue(fixture.offers(.pause(running.id, history: history)), "a stream set up with a copy")
            XCTAssertFalse(fixture.offers(.resume(running.id, history: history)), "Resume while no pause stands")
        }
        let paused = try XCTUnwrap(fixture.connectors.first { $0.paused(.all) != nil && $0.paused(.history) == nil })
        XCTAssertTrue(fixture.offers(.resume(paused.id, history: false)), "Resume while its pause stands")
        XCTAssertFalse(fixture.offers(.resume(paused.id, history: true)), "its past's Resume while the whole is paused")
        XCTAssertFalse(fixture.offers(.pause(paused.id, history: false)), "a pause again")
        let unset = try XCTUnwrap(fixture.connectors.first { !$0.setUp })
        XCTAssertFalse(fixture.offers(.pause(unset.id, history: false)), "a stream not set up")
        XCTAssertFalse(fixture.offers(.pause(unset.id, history: true)), "a stream not set up")
        let report = try JSONDecoder().decode(ConnectorsReport.self, from: JSONSerialization.data(withJSONObject: Self.report))
        XCTAssertEqual(report.connector("gmail")?.before.count, 2)
        XCTAssertTrue(report.offers(.setting("gmail", member: "refresh")))
        XCTAssertFalse(report.offers(.setting("screen", member: "refresh")), "a refresh no device states was set at the home")
        XCTAssertFalse(report.offers(.setting("screen", member: "ocr")), "a field no device states")
        XCTAssertFalse(report.offers(.setting("whoop", member: "folders")), "a member it does not have")
        XCTAssertTrue(report.offers(.setting("imessage", member: "start")), "a start the report draws")
        XCTAssertFalse(report.offers(.setting("imessage", member: "pace")), "a member it does not have")
        XCTAssertTrue(report.offers(.setting("gmail", member: "pace")))
        XCTAssertTrue(report.offers(.setting("gmail", member: "folders")))
        XCTAssertFalse(report.offers(.setting("gmail", member: "password")), "a secret was set from the page")
        XCTAssertFalse(report.offers(.setting("gmail", member: "colour")))
        XCTAssertFalse(report.offers(.setting("site:x", member: "refresh")))
        XCTAssertTrue(report.offers(.setting("photos", member: "llm.photos")), "a work's menu is dead")
        XCTAssertTrue(report.offers(.setting("photos", member: "llm.range")), "the range's menu is dead")
        XCTAssertFalse(report.offers(.setting("photos", member: "llm.faces")), "a member the part does not draw")
        XCTAssertTrue(report.offers(.setting("photos", member: "privacy.photos")), "a work's level is dead")
        XCTAssertFalse(report.offers(.setting("photos", member: "privacy.faces")), "a level the part does not draw")
        XCTAssertTrue(report.offers(.endInstall("p-0000aa01")))
        XCTAssertFalse(report.offers(.endInstall("p-0000aa02")), "the live install could be ended")
        XCTAssertFalse(report.offers(.endInstall("p-0000aa09")), "a pass no device's replaced names could be ended")
        XCTAssertTrue(report.offers(.retirePhone("iphone-17-pro-0001")))
        XCTAssertFalse(report.offers(.retirePhone("iphone-15-0002")), "a retired phone could be retired again")
        XCTAssertFalse(report.offers(.retirePhone("iphone-16-0003")))
        XCTAssertEqual(report.device("iphone-17-pro-0001")?.name, "iPhone 17 Pro")
    }

    func testScreenshotTakeAnswersOneJPEGWithinTheCapsAndNoneForAWindowThatWasShut() async throws {
        let host = host(nil)
        let none = try await host.reply(.screenshotTake)
        XCTAssertTrue(none.isEmpty, "a picture with no page to take it of")
        let image = try XCTUnwrap(Self.noise(width: 3_600, height: 2_400))
        host.snapshot = { image }
        let reply = try await host.reply(.screenshotTake)
        XCTAssertEqual(Set(reply.keys), ["jpeg"])
        let jpeg = try XCTUnwrap((reply["jpeg"] as? String).flatMap { Data(base64Encoded: $0) })
        XCTAssertEqual(Array(jpeg.prefix(3)), [0xFF, 0xD8, 0xFF], "not a JPEG")
        XCTAssertLessThanOrEqual(jpeg.count, WindowPicture.mostBytes, "larger than the relay takes")
        let read = try XCTUnwrap(CGImageSourceCreateWithData(jpeg as CFData, nil).flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) })
        XCTAssertLessThanOrEqual(max(read.width, read.height), WindowPicture.longestSide)
        XCTAssertEqual(Double(read.width) / Double(read.height), 1.5, accuracy: 0.01, "the picture's shape changed")
        let small = try XCTUnwrap(WindowPicture.jpeg(image, most: 200_000), "a picture too large was dropped, not scaled down")
        XCTAssertLessThanOrEqual(small.count, 200_000)

        host.pictureless = true
        let shut = try await host.reply(.screenshotTake)
        XCTAssertTrue(shut.isEmpty, "the window was shut, yet its picture was offered")
        let after = try await host.reply(.screenshotTake)
        XCTAssertEqual(Set(after.keys), ["jpeg"], "only the one form a shut window opened goes without a picture")
    }

    private static func noise(width: Int, height: Int) -> CGImage? {
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue),
              let pixels = context.data else { return nil }
        arc4random_buf(pixels, width * height * 4)
        return context.makeImage()
    }

    func testTheFacesDialogsActsAreTheHomesFacesVerb() async throws {
        let home = try home()
        defer { home.stop() }
        let host = host(home)
        for what in [HostAct.FacesAct.on, .off] {
            let reply = try await host.perform(.faces(what))
            XCTAssertNil(reply, what.rawValue)
        }
        XCTAssertEqual(home.requests.map { ([$0["verb"] as? String ?? ""] + ($0["args"] as? [String] ?? [])).joined(separator: " ") }, [
            "faces on", "faces off",
        ])
    }

    func testCheckAgainPostsTheRouteThenReadsTheHomeAgainAndARefusalIsTheDoorsWords() async throws {
        let door = Pressed()
        let host = host(nil, verifyHome: { try await door.press() })
        var knocks = 0
        host.needs.knock = { knocks += 1 }
        let reply = try await host.perform(.verifyHome)
        XCTAssertNil(reply)
        let pressed = await door.count
        XCTAssertEqual(pressed, 1, "the route was not posted once")
        XCTAssertEqual(knocks, 1, "the home was not read again after the press")

        for (failure, words) in [(LinkFailure.refused(status: 409, code: "NOT_HELD", message: "Your home is fine now."), "Your home is fine now."),
                                 (.refused(status: 409, code: "CHECKING", message: "Your home is checking already."), "Your home is checking already.")] {
            await door.refuse(failure)
            let said = await refusal { try await host.perform(.verifyHome) }
            XCTAssertEqual(said, words)
        }
        XCTAssertEqual(knocks, 3, "a refused press did not read the home again")
        let none = await refusal { try await self.host(nil).perform(.verifyHome) }
        XCTAssertEqual(none, HostRefusal.notHere.words, "a host with no door pressed nothing and said so")
    }

    private actor Pressed {
        private(set) var count = 0
        private var refusal: LinkFailure?

        func refuse(_ failure: LinkFailure) { refusal = failure }

        func press() throws {
            if let refusal { throw refusal }
            count += 1
        }
    }

    func testAnActOnTheHomeIsCheckedAgainstItsReportAndRunOneAfterAnother() async throws {
        let home = try home()
        defer { home.stop() }
        let host = host(home)
        func sent() -> [String] {
            home.requests.map { ([$0["verb"] as? String ?? ""] + ($0["args"] as? [String] ?? [])).joined(separator: " ") }
        }

        let refused = await refusal { try await host.perform(.turn(sources: ["fax"], on: false)) }
        XCTAssertEqual(refused, "fax: not a source name, nor a Streams row's id")
        XCTAssertEqual(sent(), ["connectors off fax"], "a turn was checked against the report")
        let live = await refusal { try await host.perform(.endInstall(pass: "p-0000aa02")) }
        XCTAssertNotNil(live, "the live install was ended")
        let retired = await refusal { try await host.perform(.retirePhone(unit: "iphone-15-0002")) }
        XCTAssertNotNil(retired)
        XCTAssertEqual(sent(), ["connectors off fax", "connectors", "connectors"], "a refused act sent more than the report's read")

        let ended = try await host.perform(.endInstall(pass: "p-0000aa01"))
        XCTAssertEqual(ended, "The previous install is removed. Anything it hadn't synced won't reach Lifestream.")
        let stopped = try await host.perform(.retirePhone(unit: "iphone-17-pro-0001"))
        XCTAssertEqual(stopped, "iPhone 17 Pro is removed. It stops recording once it has synced what it holds.")
        XCTAssertEqual(Array(sent().suffix(4)), ["connectors", "principals revoke p-0000aa01", "connectors", "device retire iphone-17-pro-0001"])

        let before = home.requests.count
        let off = Task { try await host.perform(.turn(sources: ["screen:local:macbook-pro-0001", "gmail:person-a+tag@example.com:cloud"], on: false)) }
        let on = Task { try await host.perform(.turn(sources: ["screen:local:macbook-pro-0001"], on: true)) }
        _ = try await (off.value, on.value)
        XCTAssertEqual(Array(sent().dropFirst(before)), [
            "connectors off screen:local:macbook-pro-0001", "connectors off gmail:person-a+tag@example.com:cloud",
            "connectors on screen:local:macbook-pro-0001",
        ])

        let none = await refusal { try await self.host(nil).perform(.retirePhone(unit: "iphone-17-pro-0001")) }
        XCTAssertEqual(none, "Lifestream isn’t set up on this Mac yet.")
        home.stop()
        let silent = await refusal { try await host.perform(.retirePhone(unit: "iphone-17-pro-0001")) }
        XCTAssertNotNil(silent)
    }

    func testAStreamsPauseAndResumeAreTheHomesConnectorsVerbs() async throws {
        let home = try home()
        defer { home.stop() }
        let host = host(home)
        func sent() -> [String] {
            home.requests.map { ([$0["verb"] as? String ?? ""] + ($0["args"] as? [String] ?? [])).joined(separator: " | ") }
        }

        for id in ["gmail", "whoop", "site:x"] {
            for history in [false, true] {
                let paused = await refusal { try await host.perform(.pause(connector: id, history: history)) }
                XCTAssertEqual(paused, "Lifestream on this Mac doesn't offer that, so nothing was done.", id)
                let resumed = await refusal { try await host.perform(.resume(connector: id, history: history)) }
                XCTAssertEqual(resumed, "Lifestream on this Mac doesn't offer that, so nothing was done.", id)
            }
        }
        XCTAssertEqual(sent(), Array(repeating: "connectors", count: 12), "a refused act sent more than the report's read")

        let acts: [HostAct] = [.pause(connector: "imessage", history: true), .pause(connector: "imessage", history: false),
                               .resume(connector: "imessage", history: true), .resume(connector: "imessage", history: false)]
        for act in acts {
            let answer = try await host.perform(act)
            XCTAssertNil(answer)
        }
        XCTAssertEqual(Array(sent().dropFirst(12)), ["connectors", "connectors | backfill | imessage | pause", "connectors", "connectors | pause | imessage",
                                                     "connectors", "connectors | backfill | imessage | resume", "connectors", "connectors | resume | imessage"])
        XCTAssertEqual(home.requests.filter { ($0["args"] as? [String])?.count ?? 0 > 1 }.map { $0["by"] as? String }, ["you", "you", "you", "you"])
    }

    func testADialogsControlIsTheHomesConnectorsVerbCheckedFirst() async throws {
        let home = try home()
        defer { home.stop() }
        let host = host(home)
        func sent() -> [String] {
            home.requests.map { ([$0["verb"] as? String ?? ""] + ($0["args"] as? [String] ?? [])).joined(separator: " | ") }
        }
        for act in [HostAct.setting(connector: "gmail", member: "refresh", value: .string("10m")),
                    .setting(connector: "gmail", member: "folders", value: .array([.string("INBOX")]))] {
            let reply = try await host.perform(act)
            XCTAssertNil(reply, "\(act)")
        }
        for act in [HostAct.setting(connector: "gmail", member: "refresh", value: .string("30m"), was: .null),
                    .setting(connector: "gmail", member: "folders", value: .array([]), was: .array([.string("INBOX")]))] {
            let reply = try await host.perform(act)
            XCTAssertNil(reply, "\(act)")
        }
        XCTAssertEqual(sent(), [
            "connectors", "connectors | -- | set | gmail | refresh | \"10m\"",
            "connectors", "connectors | -- | set | gmail | folders | [\"INBOX\"]",
            "connectors", "connectors | --was=null | -- | set | gmail | refresh | \"30m\"",
            "connectors", "connectors | --was=[\"INBOX\"] | -- | set | gmail | folders | []",
        ])
        let landed = try await host.reply(.setting(connector: "gmail", member: "refresh", value: .string("15m"), was: .string("30m")))
        XCTAssertEqual(landed as NSDictionary, ["landed": ["connector": "gmail", "member": "refresh", "value": "15m"]],
                       "the window was not told the value the home holds, so it settles on a read that may not hold it yet")
        let folders = try await host.reply(.setting(connector: "gmail", member: "folders", value: .array([.string("INBOX")])))
        XCTAssertEqual(folders as NSDictionary, ["landed": ["connector": "gmail", "member": "folders", "value": ["INBOX"]]])
        let before = home.requests.count
        for act in [HostAct.setting(connector: "gmail", member: "password", value: .string("app-password-synthetic")),
                    .setting(connector: "screen", member: "refresh", value: .string("5s"))] {
            let refused = await refusal { try await host.perform(act) }
            XCTAssertEqual(refused, "Lifestream on this Mac doesn't offer that, so nothing was done.", "\(act)")
        }
        XCTAssertEqual(Array(sent().dropFirst(before)), ["connectors", "connectors"])
    }

    func testAFormsSecretIsSealedByTheHomeOnAnyRoadAndNoOtherIs() async throws {
        let home = try home()
        defer { home.stop() }
        let host = host(home)
        func seals() -> [[String: String]] {
            home.requests.filter { $0["verb"] as? String == "seal-field" }.map { request in
                request.compactMapValues { $0 as? String }.filter { $0.key != "verb" && $0.key != "by" }
            }
        }
        let reply = try await host.perform(.seal(connector: "whoop", member: "password", value: "fake password 0001"))
        XCTAssertNil(reply)
        XCTAssertEqual(seals(), [["connector": "whoop", "member": "password", "value": "fake password 0001"]], "not sealed as typed")
        let locked = await refusal { try await host.perform(.seal(connector: "calendar", member: "token", value: "fake-token")) }
        XCTAssertEqual(locked, "Unlock Lifestream on MacBook Pro first.")
        for act in [HostAct.seal(connector: "whoop", member: "email", value: "person-a@example.com"),
                    .seal(connector: "gmail", member: "password", value: "fake-app-password"),
                    .seal(connector: "granola", member: "key", value: "fake-key"),
                    .seal(connector: "whoop", member: "token", value: "fake")] {
            let refused = await refusal { try await host.perform(act) }
            XCTAssertEqual(refused, "Lifestream on this Mac doesn't offer that, so nothing was done.", "\(act)")
        }
        XCTAssertEqual(seals().count, 2, "a member the form does not take was sealed")
        XCTAssertTrue(home.requests.allSatisfy { $0["verb"] as? String != "seal" }, "a form's secret sealed by the vault's own seal, past the home's rules")
    }

    func testSettingsModelActsAreTheHomesModelsVerbAndTheKeyIsSealed() async throws {
        let home = try home()
        defer { home.stop() }
        let host = host(home)
        for act in [HostAct.models(.default(use: .pictures, model: "openrouter:fake-model")),
                    .models(.file(runner: "runner-macbook-pro-0001", id: "fake-file", fetch: true)),
                    .models(.file(runner: "runner-macbook-pro-0001", id: "fake-file", fetch: false)),
                    .models(.runner("runner-macbook-pro-0001", pause: true)),
                    .models(.runner("runner-macbook-pro-0001", pause: false)),
                    .models(.battery("runner-macbook-pro-0001", save: false)),
                    .models(.battery("runner-macbook-pro-0001", save: true)),
                    .models(.address(url: "http://127.0.0.1:11434/v1", input: [.text, .image])),
                    .process(family: "photos", item: "-ph-0001", prompt: "describe", route: "openrouter:fake-model")] {
            let reply = try await host.perform(act)
            XCTAssertNil(reply, "\(act)")
        }
        XCTAssertEqual(home.requests.map { ([$0["verb"] as? String ?? ""] + ($0["args"] as? [String] ?? [])).joined(separator: " | ") }, [
            "models | -- | default | pictures | openrouter:fake-model",
            "models | -- | file | runner-macbook-pro-0001 | fake-file | fetch",
            "models | -- | file | runner-macbook-pro-0001 | fake-file | remove",
            "models | -- | runner | runner-macbook-pro-0001 | pause",
            "models | -- | runner | runner-macbook-pro-0001 | resume",
            "models | -- | battery | runner-macbook-pro-0001 | spend",
            "models | -- | battery | runner-macbook-pro-0001 | save",
            "models | -- | address | http://127.0.0.1:11434/v1 | text,image",
            "models | -- | process | photos | -ph-0001 | describe | openrouter:fake-model",
        ])
        XCTAssertEqual(home.requests.map { $0["by"] as? String }, Array(repeating: "you", count: 9))
        let refused = await refusal { try await host.perform(.models(.default(use: .text, model: "runner:gone"))) }
        XCTAssertEqual(refused, "no model runner:gone; the home reaches openrouter:fake-model")

        _ = try await host.perform(.openRouterKey("sk-or-v1-fake0000"))
        _ = try await host.perform(.openRouterKey(nil))
        let seals = home.requests.filter { $0["verb"] as? String == "seal" }
        XCTAssertEqual(seals.map { $0["secret"] as? String }, ["openrouter", "openrouter"])
        XCTAssertEqual(seals.first?["value"] as? String, "sk-or-v1-fake0000")
        XCTAssertTrue(seals.last?["value"] is NSNull, "Remove sent something other than null")
        XCTAssertFalse(try HostBridge.scriptLiteral(host.state).contains("sk-or-v1"), "the key reached the state")

        let before = home.requests.count
        _ = try await host.perform(.models(.address(url: "https://api.example.com/v1", input: nil, key: "sk-fake0000")))
        _ = try await host.perform(.models(.addressNone))
        let address = home.requests.dropFirst(before).filter { ["seal", "models"].contains($0["verb"] as? String) }
        XCTAssertEqual(address.map { request in
            ([request["verb"] as? String ?? "", request["secret"] as? String ?? ""] + (request["args"] as? [String] ?? [])).joined(separator: " | ")
        }, [
            "seal | address",
            "models |  | --key | -- | address | https://api.example.com/v1",
            "models |  | -- | address | none",
            "seal | address",
        ], "the key is sealed before the address names it, and forgotten with the address")
        XCTAssertEqual(address.first?["value"] as? String, "sk-fake0000")
        XCTAssertTrue(address.last?["value"] is NSNull, "Remove left the address's key sealed")
        XCTAssertFalse(address.contains { ($0["args"] as? [String] ?? []).contains("sk-fake0000") }, "the key reached the verb's arguments")
    }

    func testASealThePageAskedIsRefusedInTheHomesWordsOrAPlainSentence() async throws {
        let locked = try ScriptedHome { _ in ["error": "Passwords are locked on this Mac"] }
        defer { locked.stop() }
        let refused = await refusal { try await self.host(locked).perform(.openRouterKey("sk-or-v1-fake0000")) }
        XCTAssertEqual(refused, "Passwords are locked on this Mac")
        let alone = await refusal { try await self.host(nil).perform(.openRouterKey("sk-or-v1-fake0000")) }
        XCTAssertEqual(alone, ReachWords.notSent)
    }

    func testSettingsActsOnTheHomeAreItsOwnVerbsAndARenameIsAMacsTheHomeHolds() async throws {
        let home = try home()
        defer { home.stop() }
        let host = host(home, unit: { "macbook-pro-0001" })
        for act in [HostAct.pauseHome, .pauseHome, .resumePause(target: "home"), .resumePause(target: "-pause:gmail"),
                    .homeSetting(.modelCap(16)), .homeSetting(.historyStart("all")),
                    .homeSetting(.privacy([.word(.chat, "names"), .word(.level, "none")])),
                    .homeSetting(.privacy([.words(.always, ["-Project Fake"]), .words(.never, nil)])),
                    .deviceName(unit: "macbook-pro-0001", name: "-Studio Mac"), .deviceName(unit: "macbook-air-bb07", name: "Desk Mac")] {
            let reply = try await host.perform(act)
            XCTAssertNil(reply, "\(act)")
        }
        XCTAssertEqual(home.requests.map { ([$0["verb"] as? String ?? ""] + ($0["args"] as? [String] ?? [])).joined(separator: " | ") }, [
            "pause | home | --reason | Paused by you",
            "pause | home | --reason | Paused by you",
            "resume | -- | home",
            "resume | -- | -pause:gmail",
            "settings | set | model.cap | 16",
            #"settings | set | {"history.start":"all"}"#,
            #"settings | set | {"privacy.chat":"names","privacy.level":"none"}"#,
            #"settings | set | {"privacy.always":["-Project Fake"],"privacy.never":null}"#,
            "connectors",
            "device | -- | name | macbook-pro-0001 | -Studio Mac",
            "connectors",
            "device | -- | name | macbook-air-bb07 | Desk Mac",
        ])
        let changes = home.requests.filter { $0["verb"] as? String != "connectors" }
        XCTAssertEqual(changes.map { $0["by"] as? String }, Array(repeating: "you", count: 10))
        let refused = await refusal { try await host.perform(.homeSetting(.modelCap(0))) }
        XCTAssertEqual(refused, "model.cap is at least 1, not 0")
        let renames = { home.requests.filter { $0["verb"] as? String == "device" }.count }
        let before = renames()
        let phone = await refusal { try await host.perform(.deviceName(unit: "iphone-17-pro-0001", name: "Phone")) }
        XCTAssertEqual(phone, "Lifestream renames only a Mac it holds.")
        let gone = await refusal { try await host.perform(.deviceName(unit: "macbook-pro-ffff", name: "Mac")) }
        XCTAssertEqual(gone, "Lifestream renames only a Mac it holds.")
        XCTAssertEqual(renames(), before, "a rename of a device that is no Mac the home holds reached the home")
        let away = await refusal { try await self.host(nil).perform(.pauseHome) }
        XCTAssertEqual(away, HostRefusal.noHome.words)
    }

    func testASettingThisMacAppliesRunsHereFirstWithNoHomeAtAll() async throws {
        let settings = MacSettings(file: FileManager.default.temporaryDirectory.appendingPathComponent("mac-settings-\(UUID().uuidString)/settings.json"), defaults: ["screen": ["refresh": .string("2s"), "ocr": .string("exact")]], files: DeviceFiles(.plain))
        let host = host(nil, settings: settings)
        let reply = try await host.perform(.setting(connector: "screen", member: "refresh", value: .string("5s")))
        XCTAssertNil(reply, "refused for want of a home")
        XCTAssertEqual(settings.value("screen", "refresh"), .string("5s"), "not applied at once")
        XCTAssertEqual(settings.queue.changes.map(\.member), ["refresh"], "not queued for the home")
        let landed = try await host.reply(.setting(connector: "screen", member: "refresh", value: .string("10s"), was: .string("5s")))
        XCTAssertEqual(landed as NSDictionary, ["landed": ["connector": "screen", "member": "refresh", "value": "10s"]],
                       "a setting this Mac keeps did not answer landed with the value it now holds, so the window cannot settle")
        let wrong = await refusal { try await host.perform(.setting(connector: "screen", member: "ocr", value: .string("sometimes"))) }
        XCTAssertEqual(wrong, "Lifestream cannot use that setting, so nothing was done.")
        XCTAssertEqual(settings.value("screen", "ocr"), .string("exact"), "a value this Mac cannot use was applied")
        XCTAssertEqual(settings.queue.changes.count, 1)
        let homeOnly = await refusal { try await host.perform(.setting(connector: "gmail", member: "refresh", value: .string("10m"))) }
        XCTAssertEqual(homeOnly, "Lifestream isn’t set up on this Mac yet.")
    }

    func testOtherAppAddsTheChosenAppAtActivityOnlyThroughTheSettingsPath() async throws {
        let vault: HomeLink.JSON = .object(["app": .string("com.example.vault-fake"), "mode": .string("exclude")])
        let settings = MacSettings(file: FileManager.default.temporaryDirectory.appendingPathComponent("mac-settings-\(UUID().uuidString)/settings.json"), defaults: ["screen": ["apps": .array([vault])]], files: DeviceFiles(.plain))
        let host = host(nil, settings: settings)
        func bundle(_ name: String, id: String?) throws -> URL {
            let app = scratch.appendingPathComponent("Elsewhere/\(name).app", isDirectory: true)
            let contents = app.appendingPathComponent("Contents", isDirectory: true)
            try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
            let info: [String: Any] = id.map { ["CFBundleIdentifier": $0, "CFBundleName": name] } ?? ["CFBundleName": name]
            try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
                .write(to: contents.appendingPathComponent("Info.plist"))
            return app
        }
        var answer: URL? = try bundle("Notes Fake", id: "com.example.notes-fake")
        var panels = 0
        host.pickApp = {
            panels += 1
            return answer
        }

        let added = try await host.reply(.chooseApp)
        XCTAssertEqual(added["notice"] as? String, "Notes Fake added.")
        XCTAssertEqual(added["added"] as? Bool, true, "the page cannot tell an app added from one listed already")
        let notes: HomeLink.JSON = .object(["app": .string("com.example.notes-fake"), "mode": .string("activity")])
        XCTAssertEqual(settings.value("screen", "apps"), .array([notes, vault]), "not added at Activity only, or the list not kept whole")
        XCTAssertEqual(settings.queue.changes.map(\.member), ["apps"], "not queued for the home as a setting is")
        XCTAssertEqual(host.state.apps?.offered.map(\.id), ["com.example.notes-fake"],
                       "an app detection never finds was not offered, so the page cannot show it")

        let again = try await host.reply(.chooseApp)
        XCTAssertEqual(again["notice"] as? String, "Notes Fake is already listed.")
        XCTAssertNil(again["added"], "an app already listed said added")
        XCTAssertEqual(settings.value("screen", "apps"), .array([notes, vault]))
        XCTAssertEqual(settings.queue.changes.count, 1)

        answer = try bundle("Lifestream", id: RecordingModes.ownApp)
        let own = await refusal { try await host.perform(.chooseApp) }
        XCTAssertEqual(own, "Lifestream never records itself.")
        answer = try bundle("Tool Fake", id: nil)
        let unnamed = await refusal { try await host.perform(.chooseApp) }
        XCTAssertEqual(unnamed, "That app has no bundle identifier, so Lifestream can't tell it apart.")
        XCTAssertEqual(settings.value("screen", "apps"), .array([notes, vault]))

        answer = nil
        let cancelled = try await host.reply(.chooseApp)
        XCTAssertTrue(cancelled.isEmpty, "Cancel answered something")
        XCTAssertEqual(panels, 5)
        XCTAssertEqual(settings.queue.changes.count, 1, "a cancel or a refusal changed the list")

        let notesApp = try bundle("Notes Fake", id: "com.example.notes-fake")
        let reopened = self.host(nil, settings: settings, locate: { id in id == "com.example.notes-fake" ? Detection.app(at: notesApp) : nil })
        await reopened.read()
        XCTAssertEqual(reopened.state.apps?.offered.map(\.id), ["com.example.notes-fake"], "the chosen app went with the window")
        reopened.pickApp = { notesApp }
        let listed = try await reopened.perform(.chooseApp)
        XCTAssertEqual(listed, "Notes Fake is already listed.")

        let closing = self.host(nil, settings: settings)
        let other = try bundle("Other Fake", id: "com.example.other-fake")
        closing.pickApp = {
            closing.stop()
            return other
        }
        let late = try await closing.perform(.chooseApp)
        XCTAssertNil(late)
        XCTAssertEqual(settings.value("screen", "apps"), .array([notes, vault]), "an app chosen after the window closed was added")
        XCTAssertEqual(settings.queue.changes.count, 1)

        let none = await refusal { try await self.host(nil).perform(.chooseApp) }
        XCTAssertEqual(none, "Lifestream on this Mac doesn't offer that, so nothing was done.")
    }

    func testAnActsFailureOverTheSocketIsSaidByTheOneCodeTableAndOnlyANotNowAsksAProbe() async throws {
        let acts = try XCTUnwrap(try Self.hostReach()["acts"] as? [[String: Any]])
        let asked = Counter()
        let probes = Counter()
        let home = try ScriptedHome { _ in
            let met = acts[asked.next()]
            let door = met["door"] as! [String: Any]
            let reply = met["reply"] as! [String: String]
            let words = door["message"] as? String ?? reply["refused"]!
            let extra: [String: Any] = (door["wait"] as? String).map { ["wait": $0] } ?? [:]
            var refusal: [String: Any] = ["status": door["status"]!, "code": door["code"]!, "words": words, "extra": extra]
            refusal["retryAfter"] = door["retryAfter"]
            return ["error": "[\(door["code"]!)] \(words)", "refusal": refusal]
        }
        defer { home.stop() }
        let host = host(home, failed: { probes.bump() })
        for act in acts {
            let before = probes.value
            do {
                _ = try await host.perform(.faces(.on))
                XCTFail("a refused act answered done: \(act)")
            } catch {
                let said = try XCTUnwrap(error as? HostRefusal, "\(error)")
                XCTAssertEqual(said.answer as NSDictionary, try XCTUnwrap(act["reply"] as? [String: String]) as NSDictionary, "\(act)")
            }
            XCTAssertEqual(probes.value - before, act["probe"] as? Bool == true ? 1 : 0, "\(act)")
        }
        XCTAssertEqual(HomeSocketError.of("faces: something failed", refusal: nil), .refused(SocketRefusal(words: "faces: something failed")))
        XCTAssertEqual(MacHost.said(HomeSocketError.of("faces: something failed", refusal: nil)) as? HostRefusal,
                       HostRefusal("faces: something failed"))
        XCTAssertEqual(MacHost.said(LinkFailure.unanswered(again: true, began: true)) as? HostRefusal,
                       HostRefusal(ReachWords.saving, said: .saving, code: "OUTCOME_UNKNOWN"))
        XCTAssertEqual(MacHost.said(LinkFailure.unanswered(again: true, began: false)) as? HostRefusal,
                       HostRefusal(ReachWords.unknown, said: .unknown, code: "OUTCOME_UNKNOWN"))
        XCTAssertEqual(MacHost.said(LinkFailure.unanswered(again: false, began: true)) as? HostRefusal,
                       HostRefusal(ReachWords.unknownDone, said: .unknown, code: "OUTCOME_UNKNOWN"))
    }

    func testTheProbeAnswersReachOnceItEndsAndTheStateCarriesReachAndTheLastSend() async throws {
        let probe = try XCTUnwrap(try Self.hostReach()["probe"] as? [String: Any])
        XCTAssertEqual(HostAct.read(try XCTUnwrap(probe["request"])), .success(.probeHome))
        let probes = Counter()
        let lines = StatusLines(recorder: RecorderPresentation(status: RuntimeStatus(state: .recording), running: true))
        let host = host(nil, lines: lines, probe: {
            probes.bump()
            return HomeLink.ReachSnapshot(reach: .answering, lastReached: Date(), revision: 8)
        })
        let reply = try await host.reply(.probeHome)
        XCTAssertEqual(reply as NSDictionary, try XCTUnwrap(probe["reply"] as? [String: Any]) as NSDictionary)
        XCTAssertEqual(probes.value, 1)
        let none = await refusal { try await self.host(nil).perform(.probeHome) }
        XCTAssertEqual(none, HostRefusal.notHere.words)

        XCTAssertNil(host.state.reach, "reach stated before the link said it")
        lines.reach = HomeLink.ReachSnapshot(reach: .unreachable(.notRunning, since: Date()), lastReached: nil, revision: 4)
        XCTAssertEqual(host.state.reach?.state, "unreachable")
        XCTAssertEqual(host.state.reach?.line, "Lifestream isn't running on its Mac")
        XCTAssertEqual(host.state.reach?.revision, 4)
        func status(_ outcome: String) -> ShipperStatus {
            ShipperStatus(home: URL(string: "http://127.0.0.1:4680"), lastRunAt: Date(), lastOutcome: outcome, lastContactAt: Date(),
                          pending: 0, nextRunAt: Date(), running: false, sources: [], importingHistory: false)
        }
        lines.shipper = status("held DISK_LOW")
        XCTAssertEqual(host.state.sending, "Waiting for space on Lifestream's disk")
        lines.shipper = status("unreachable")
        XCTAssertNil(host.state.sending, "a send that met no answer said beside the strip")
    }

    func testOpenLifestreamStartsTheHomeThroughTheAgentsAndSaysAStartThatFailed() async throws {
        let states = try XCTUnwrap(try Self.hostReach()["states"] as? [String: [String: Any]])
        let reach = try XCTUnwrap(states["unreachable, Lifestream not running"]?["reach"] as? [String: Any])
        XCTAssertEqual((reach["acts"] as? [[String: Any]])?.map { $0["do"] as? String }, ["open"], "the strip's Open Lifestream")
        let open = try XCTUnwrap((reach["path"] as? [[String: Any]])?.first { $0["id"] as? String == "lifestream" })
        XCTAssertEqual((open["act"] as? [String: Any])?["do"] as? String, "open", "the link that broke carries the same act")
        XCTAssertEqual(HostAct.read(["type": "act", "act": "home", "do": "open"]), .success(.openHome))

        let opened = Counter()
        let host = host(nil, openHome: { opened.bump() })
        let reply = try await host.reply(.openHome)
        XCTAssertEqual(reply as NSDictionary, [:] as NSDictionary, "nothing but done: the strip follows reach")
        XCTAssertEqual(opened.value, 1)
        let none = await refusal { try await self.host(nil).perform(.openHome) }
        XCTAssertEqual(none, HostRefusal.notHere.words)
        struct Refused: Error, CustomStringConvertible { var description: String { "launchctl said no" } }
        let failed = await refusal { try await self.host(nil, openHome: { throw Refused() }).perform(.openHome) }
        XCTAssertEqual(failed, "Lifestream couldn't start: launchctl said no")
    }

    func testPairAgainForgetsARefusedPassAndOpensSetUpButKeepsAPassThatWorks() async throws {
        let pair = try XCTUnwrap(try Self.hostReach()["pair"] as? [String: Any])
        XCTAssertEqual(HostAct.read(try XCTUnwrap(pair["request"])), .success(.pairHome))
        let door = StandInDoor()
        let time = ManualPacer(Date(timeIntervalSince1970: 1_794_837_720))
        let stored = try JSONSerialization.data(withJSONObject: ["name": "http://127.0.0.1:4680", "pass": "fake-pass-000000000000",
                                                                 "paired": true, "unit": "macbook-pro-0001"])
        let link = HomeLink(device: .init(kind: .mac, version: "500", model: "Mac15,3", serial4: nil), credentials: StoredPass(stored),
                            folder: scratch.appendingPathComponent("link"), transport: door,
                            clock: time.clock, pacer: time.pacer, files: DeviceFiles(.plain))
        var setUps = 0
        let host = host(nil, pairAgain: MacHost.PairAgain(link: link, setUp: { setUps += 1 }))
        let refused = try XCTUnwrap(pair["refused"] as? [String: String]) as NSDictionary
        func answer(_ work: () async throws -> String?) async -> NSDictionary? {
            do {
                _ = try await work()
                return nil
            } catch {
                return ((error as? HostRefusal)?.answer ?? ["not words": "\(error)"]) as NSDictionary
            }
        }

        let working = await link.probeSoon().reach
        XCTAssertEqual(working, .answering)
        let kept = await answer { try await host.perform(.pairHome) }
        XCTAssertEqual(kept, refused)
        XCTAssertNotNil(try link.name(), "a pass that works was forgotten")
        XCTAssertEqual(setUps, 0)

        door.mode = .refusing
        let refusing = await link.probeSoon().reach
        XCTAssertEqual(refusing, .passRefused)
        let reply = try await host.reply(.pairHome)
        XCTAssertEqual(reply as NSDictionary, try XCTUnwrap(pair["reply"] as? [String: Any]) as NSDictionary)
        XCTAssertNil(try link.name(), "a refused pass kept")
        XCTAssertEqual(link.snapshot.reach, .unpaired)
        XCTAssertEqual(setUps, 1)
        let again = await answer { try await host.perform(.pairHome) }
        XCTAssertEqual(again, ["refused": "This Mac isn't paired, so there was no pass to forget.", "said": "refused"])
        XCTAssertEqual(setUps, 1)

        let none = await refusal { try await self.host(nil).perform(.pairHome) }
        XCTAssertEqual(none, HostRefusal.notHere.words)
    }

    private static func hostReach() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../dashboard/test/fixtures/host-reach.json")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        var value: Int { lock.withLock { count } }
        func bump() { lock.withLock { count += 1 } }
        func next() -> Int { lock.withLock { defer { count += 1 }; return count } }
    }


    private static let firefoxFolder = "~/Library/Application Support/Firefox"

    private static func firefox(also: [String] = [], folder given: String? = nil) throws -> HomeLink.DeclaredStore {
        let folder = given ?? firefoxFolder
        let files = (["history.json"] + also).map { ["member": $0, "path": "\(folder)/\($0)"] }
        let store: [String: Any] = ["feeder": "firefox-mac", "name": "firefox", "held": "\(folder)/history.json", "account": "local",
                                    "engine": ["kind": "file", "files": files]]
        return HomeLink.DeclaredStore(app: nil, grants: [], product: "firefox",
                                      store: try JSONDecoder().decode(HomeLink.MacStore.self, from: JSONSerialization.data(withJSONObject: store)))
    }

    private func firefoxStores(known: Set<String> = []) throws -> DeclaredStores {
        let home = scratch.appendingPathComponent("person", isDirectory: true)
        let history = home.appendingPathComponent("Library/Application Support/Firefox/history.json")
        try FileManager.default.createDirectory(at: history.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"{"visits":[{"url":"https://example.com/","at":1790000000}]}"#.utf8).write(to: history)
        let state = scratch.appendingPathComponent("shipping-\(UUID().uuidString)", isDirectory: true)
        let mac = DeclaredStores.Mac(home: home, lifestream: { [] }, applications: [], fullDiskAccess: { true }, wake: { _ in },
                                     ledgers: Ledgers(root: state.appendingPathComponent("ledger", isDirectory: true), files: DeviceFiles(.plain)),
                                     hashCacheDirectory: state.appendingPathComponent("hash-cache", isDirectory: true),
                                     sessionDirectory: state.appendingPathComponent("sessions", isDirectory: true))
        let stores = DeclaredStores(file: state.appendingPathComponent("stores.json"),
                                    consent: StoreConsent(file: state.appendingPathComponent("allowed.json"), known: known, files: DeviceFiles(.plain)), mac: mac)
        try stores.take(["firefox": try Self.firefox()])
        return stores
    }

    private func firefoxHome() throws -> ScriptedHome {
        try ScriptedHome { request in
            request["verb"] as? String == "connectors" ? ["result": HomeReport.report([HomeReport.connector("firefox", "Firefox")])]
                : ["error": "no verb is named \(request["verb"] ?? "")"]
        }
    }

    func testAStoresAllowOpensItsSheetAndAnAllowKeptIsReadAtOnce() async throws {
        let home = try firefoxHome()
        defer { home.stop() }
        let stores = try firefoxStores()
        let source = "firefox:local:macbook-pro-0001"
        var told: [HomeLink.StoreState?] = []
        let read = Locked<[String]>([])
        let host = host(home, stores: stores, tellStores: { told.append($0.states["firefox"]) }, refreshHere: { read.value.append($0) })
        func shown() -> StoreAsking? {
            if case .store(let asking, _)? = host.sheet { return asking }
            return nil
        }

        let allow = Task { try await host.perform(.allowStore(connector: "firefox")) }
        try await until("the store's sheet shows") { shown() != nil }
        guard case .store(let asking, let name)? = host.sheet else { return XCTFail("no store sheet") }
        XCTAssertEqual(name, "Firefox")
        XCTAssertEqual(asking.paths, ["\(Self.firefoxFolder)/history.json"])
        XCTAssertNil(stores.domain(for: source), "a store was read before its Allow")
        XCTAssertEqual(read.value, [])

        XCTAssertNil(host.answerStore(.allowed, to: asking))
        XCTAssertNil(host.sheet)
        _ = try await allow.value
        XCTAssertEqual(stores.state(of: "firefox"), .allowed)
        XCTAssertEqual(told, [.allowed])
        XCTAssertEqual(read.value, ["firefox"], "an Allow kept did not read the store at once")
        let work = scratch.appendingPathComponent("work", isDirectory: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let sealed = try XCTUnwrap(stores.domain(for: source)).seal(SealRequest(fetchedAt: Date(timeIntervalSince1970: 1_790_000_100), workDirectory: work, scratch: work,
                                                                                custody: SealCustody(pass: "p-00000001", received: 0, imported: 0)))
        XCTAssertEqual(sealed.count, 1, "the store's first delivery")

        _ = try await host.perform(.allowStore(connector: "firefox"))
        XCTAssertNil(host.sheet)
        XCTAssertEqual(read.value, ["firefox"])

        try stores.take(["firefox": try Self.firefox(also: ["sessions.json"])])
        XCTAssertNil(stores.domain(for: source), "a changed store was read on its old Allow")
        let again = Task { try await host.perform(.allowStore(connector: "firefox")) }
        try await until("the changed store's sheet shows") { shown() != nil }
        let changed = try XCTUnwrap(shown())
        XCTAssertEqual(changed.new, ["\(Self.firefoxFolder)/sessions.json"])
        try stores.take(["firefox": try Self.firefox(also: ["sessions.json", "forms.json"])])
        XCTAssertNil(host.answerStore(.allowed, to: changed))
        _ = try await again.value
        XCTAssertEqual(stores.state(of: "firefox"), .asked)
        XCTAssertNil(stores.domain(for: source))
        XCTAssertEqual(read.value, ["firefox"], "an answer to an old sheet read the store")

        let refuse = Task { try await host.perform(.allowStore(connector: "firefox")) }
        try await until("the third sheet shows") { shown() != nil }
        XCTAssertNil(host.answerStore(.refused, to: try XCTUnwrap(shown())))
        _ = try await refuse.value
        XCTAssertEqual(stores.state(of: "firefox"), .refused)
        XCTAssertEqual(read.value, ["firefox"])

        let known = try firefoxStores(known: [try Self.firefox().digest])
        let releaseHost = self.host(home, stores: known)
        _ = try await releaseHost.perform(.allowStore(connector: "firefox"))
        XCTAssertNil(releaseHost.sheet)

        let none = await refusal { try await host.perform(.allowStore(connector: "arc")) }
        XCTAssertEqual(none, "This Mac has not been told of that store yet, so there is nothing to allow.")
    }

    func testAStoreTheSafetyRuleRefusesSaysWhyItsAllowDoesNothing() async throws {
        let home = try firefoxHome()
        defer { home.stop() }
        let stores = try firefoxStores()
        try stores.take(["firefox": try Self.firefox(folder: "~/.ssh")])
        XCTAssertEqual(stores.state(of: "firefox"), .unsafe)
        let read = Locked<[String]>([])
        let host = host(home, stores: stores, refreshHere: { read.value.append($0) })
        let said = await refusal { try await host.perform(.allowStore(connector: "firefox")) }
        XCTAssertEqual(said, "This Mac never reads Firefox's store, so there is nothing to allow: mac.store.held: ~/.ssh/history.json lies under ~/.ssh, which is never read.")
        XCTAssertNil(host.sheet)
        XCTAssertEqual(read.value, [])
    }

    private final class Locked<Value>: @unchecked Sendable {
        private let lock = NSLock()
        private var held: Value
        init(_ value: Value) { held = value }
        var value: Value {
            get { lock.withLock { held } }
            set { lock.withLock { held = newValue } }
        }
    }

    func testChooseSetsAPathFieldToAFileOrTheFolderTheReportSays() async throws {
        let home = try home()
        defer { home.stop() }
        let host = host(home, unit: { "macbook-pro-0001" })
        var panels: [FilePanel] = []
        let folder = scratch.appendingPathComponent("backups", isDirectory: true)
        host.choose = { panels.append($0); return folder }
        _ = try await host.perform(.chooseFile(connector: "whatsapp", member: "backups"))
        _ = try await host.perform(.chooseFile(connector: "claude", member: "export"))
        XCTAssertEqual(panels, [FilePanel(title: "Choose the backups folder", folder: true), FilePanel(title: "Choose Export file", folder: false)])
        let sets = home.requests.compactMap { $0["args"] as? [String] }.filter { $0.dropFirst().first == "set" }
        let path = "\"\(folder.path)\""
        XCTAssertEqual(sets, [["--", "set", "whatsapp", "backups", path], ["--", "set", "claude", "export", path]],
                       "a value spelt otherwise than the door spells a phone's: a string that reads as JSON, or starts with a dash, misread")
        for member in ["folders", "colour"] {
            let refused = await refusal { try await host.perform(.chooseFile(connector: "gmail", member: member)) }
            XCTAssertEqual(refused, "Lifestream on this Mac doesn't offer that, so nothing was done.", member)
        }
        let elsewhere = await refusal { try await self.host(home, unit: { "macbook-air-bb07" }).perform(.chooseFile(connector: "whatsapp", member: "backups")) }
        XCTAssertEqual(elsewhere, "Lifestream on this Mac doesn't offer that, so nothing was done.")
        XCTAssertEqual(panels.count, 2)
    }

    func testASheetOpensAsAskedAndItsActResolvesOnlyOnceItCloses() async throws {
        let vault = Vault()
        let home = try home(vault)
        defer { home.stop() }
        let host = host(home)
        let resolved = Flag()
        let first = Task {
            _ = try await host.perform(.sheet(.init(connector: "gmail", route: "gmail-imap")))
            resolved.set = true
        }
        try await until("host.sheet != nil") { host.sheet != nil }
        let second = await refusal { try await host.perform(.sheet(.init(connector: "gmail", route: "gmail-imap"))) }
        XCTAssertEqual(second, "Close the sheet that is open first.")
        XCTAssertFalse(resolved.set, "the act resolved before its sheet closed")
        host.sheet = nil
        try await first.value

        vault.recovery = "unconfirmed"
        await host.needs.read()
        XCTAssertEqual(host.needs.list, [.saveRecoveryKey(keyed: false)])
        var pages: [String] = []
        var doors: [RecoveryKey.Door] = []
        host.showPage = { pages.append($0) }
        host.needs.openKey = { doors.append($0) }
        _ = try await host.perform(.need(key: "vault:unsaved", button: .do))
        XCTAssertEqual(doors, [.asked], "Save your recovery key did not open the recovery key window")
        XCTAssertEqual(pages, [], "the recovery key need opened the page")
        XCTAssertNil(host.sheet, "a native sheet opened for the recovery key")

        vault.locked = true
        vault.recovery = "confirmed"
        await host.needs.read()
        XCTAssertEqual(host.needs.list, [.allow])
        let locked = Task { try await host.perform(.sheet(.init(connector: "gmail", route: "gmail-imap"))) }
        try await until("host.sheet == .vaultAllow") { host.sheet == .vaultAllow }
        host.sheet = nil
        _ = try await locked.value
        XCTAssertNil(host.sheet, "an account opened while the vault stayed locked")
        vault.locked = false
        await host.needs.read()
        let gmail = Task { try await host.perform(.sheet(.init(connector: "gmail", route: "gmail-imap"))) }
        try await until("host.sheet != nil") { host.sheet != nil }
        guard case .account(let connector, let route)? = host.sheet else { return XCTFail("not Gmail's sheet: \(String(describing: host.sheet))") }
        XCTAssertEqual([connector.id, route.id, route.way], ["gmail", "gmail-imap", "key"])
        XCTAssertEqual(connector.before, ["Make an app password.", "Type it here."])
        host.sheet = nil
        _ = try await gmail.value
        let noSheet = await refusal { try await host.perform(.sheet(.init(connector: "imessage", route: "imessage"))) }
        XCTAssertEqual(noSheet, "Lifestream has no such sign-in for that connector.")
        XCTAssertNil(try JSONDecoder().decode(ConnectorsReport.self, from: JSONSerialization.data(withJSONObject: Self.report)).connector("site:x"))
    }

    static let recoveryKey = "MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAA"

    func testThePageReadsTheVaultAsAStateAndASavedDayAndNeverAKey() async throws {
        let slots: [[String: Any]] = [["id": "r-1", "kind": "recovery", "made_ms": 1, "confirmed_ms": 5],
                                      ["id": "r-2", "kind": "recovery", "made_ms": 6]]
        func vault(_ keyID: String?, locked: Bool = false, keyed: Bool = false, _ recovery: String) -> VaultState {
            VaultState(answer: ["key_id": (keyID as Any?) ?? NSNull(), "locked": locked, "keyed": keyed, "recovery": recovery, "slots": slots])!
        }
        let cases: [(VaultState, Need?, HostState.Vault)] = [
            (vault(nil, "none"), nil, .init(state: "none")),
            (vault("3fa2c91b", "unconfirmed"), .saveRecoveryKey(keyed: false), .init(state: "unsaved", savedMs: 5)),
            (vault("3fa2c91b", "confirmed"), nil, .init(state: "saved", savedMs: 5)),
            (vault("3fa2c91b", locked: true, "confirmed"), .allow, .init(state: "locked", savedMs: 5)),
            (vault("3fa2c91b", locked: true, "confirmed"), .unlock, .init(state: "lost", savedMs: 5)),
            (vault("3fa2c91b", keyed: true, "confirmed"), nil, .init(state: "saved", savedMs: 5, keyed: true)),
            (vault("3fa2c91b", locked: true, keyed: true, "confirmed"), .homeLocked(allow: false), .init(state: "lost", savedMs: 5, keyed: true)),
        ]
        for (state, need, expected) in cases {
            let shown = try XCTUnwrap(HostState.Vault.of(state, need: need))
            XCTAssertEqual(shown, expected)
            let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(shown)) as? [String: Any])
            XCTAssertEqual(Set(encoded.keys), expected.keyed ? ["state", "saved_ms", "keyed"] : ["state", "saved_ms"],
                           "the page is told more than the state, the saved day and whether Lifestream is encrypted")
            XCTAssertEqual(encoded["state"] as? String, expected.state)
        }
        XCTAssertNil(HostState.Vault.of(nil, need: nil))

        let state = Vault()
        state.recovery = "unconfirmed"
        let home = try home(state)
        defer { home.stop() }
        let host = host(home)
        await host.needs.read()
        XCTAssertEqual(host.state.vault, .init(state: "unsaved"))
        let made = await host.needs.recovery.make()
        XCTAssertTrue(made)
        XCTAssertEqual(host.needs.recovery.shown?.key, Self.recoveryKey)
        XCTAssertEqual(host.state.vault, .init(state: "unsaved"), "a key shown changed what the page reads")
        let whole = String(decoding: try JSONEncoder().encode(host.state), as: UTF8.self)
        XCTAssertFalse(whole.contains("MZXW"), "the key reached the page's state")

        XCTAssertEqual(HostAct.read(["type": "act", "act": "vault", "do": "open"]), .success(.vault(.open)))
        XCTAssertEqual(HostAct.read(["type": "act", "act": "vault", "do": "unlock"]), .success(.vault(.unlock)))
        for removed in ["make", "save", "kept", "copy", "forget", "new", "show"] {
            XCTAssertEqual(HostAct.read(["type": "act", "act": "vault", "do": removed]), .failure(.unreadable(nil)), "the page may still \(removed)")
        }
        var doors: [RecoveryKey.Door] = []
        host.needs.openKey = { doors.append($0) }
        _ = try await host.perform(.vault(.open))
        XCTAssertEqual(doors, [.asked])
        XCTAssertEqual(host.needs.recovery.shown?.key, Self.recoveryKey, "the page's open forgot the key the window shows")
    }

    func testANeedsButtonIsItsOwnAndAnInPlaceRefusalIsTheRejection() async throws {
        let home = try home()
        defer { home.stop() }
        let host = host(home)
        let blocked = "another definition runs org.example.synthetic. Remove it, then try again."
        host.needs.retryUpdate = { .blocked("still \(blocked)") }
        host.needs.updated(.blocked(blocked))
        XCTAssertEqual(host.state.needs.map(\.id), ["update"], "the state waited for the run loop to say a need")
        host.needs.noticed([HomeReport.password("gmail.password", connector: "gmail", member: "password",
                                                "Gmail refused its app password: make a new one and type it here"),
                            HomeReport.need("fetch:whoop", "WHOOP can't sync right now. Lifestream tries again every 30 m.")])
        try await until("host.needs.list.count == 3 && host.state.needs.count == 3") { host.needs.list.count == 3 && host.state.needs.count == 3 }
        XCTAssertEqual(host.state.needs.map(\.id), ["update", "password:gmail.password", "fetch:whoop"], "a need is known by an id other than the home's")
        XCTAssertEqual(host.state.needs.map(\.home), [false, true, true], "the Mac's own need said the home's, or a home need the Mac's")
        XCTAssertEqual(host.state.needs[0].acts, [.init(id: "try-again", label: "Try again", tone: "caution")])
        XCTAssertEqual(host.state.needs[1].acts, [.init(id: "do", label: "Set", tone: "caution")], "a password's button is its act's")
        XCTAssertEqual(host.state.needs[2].line, "WHOOP can't sync right now. Lifestream tries again every 30 m.")
        XCTAssertEqual(host.state.needs[2].acts, [])
        let unmendable = await refusal { try await host.perform(.need(key: "fetch:whoop", button: .do)) }
        XCTAssertEqual(unmendable, "That no longer needs doing.")
        XCTAssertTrue(host.state.needs[0].detail?.contains(blocked) == true)
        XCTAssertNil(host.state.needs[1].detail, "a password need's words are its sheet's")

        let notItsOwn = await refusal { try await host.perform(.need(key: "update", button: .do)) }
        XCTAssertEqual(notItsOwn, "That no longer needs doing.")
        let gone = await refusal { try await host.perform(.need(key: "vault:locked", button: .do)) }
        XCTAssertEqual(gone, "That no longer needs doing.")
        let unlocked = await refusal { try await host.perform(.vault(.unlock)) }
        XCTAssertEqual(unlocked, "Your passwords are not locked.", "the page's unlock opened a need the vault does not state")
        let again = await refusal { try await host.perform(.need(key: "update", button: .tryAgain)) }
        XCTAssertEqual(again, "still \(blocked)")

        var installs = 0
        let restart = HostState.NeedRow.Act(id: "do", label: "Restart to Update", tone: "caution")
        host.needs.installUpdate = { installs += 1 }
        host.needs.update(holding: "1900", waiting: nil)
        XCTAssertEqual(host.state.update?.id, "update:ready", "the state waited for the run loop to say the update held")
        XCTAssertEqual(host.state.update?.line, "Lifestream 1900 is ready")
        XCTAssertEqual(host.state.update?.acts, [restart])
        XCTAssertFalse(host.state.needs.contains { $0.id == "update:ready" }, "the update held was a need before it waited")
        _ = try await host.perform(.need(key: "update:ready", button: .do))
        XCTAssertEqual(installs, 1)
        host.needs.update(holding: "1900", waiting: "1900")
        try await until("host.state.needs has the ready update") { host.state.needs.contains { $0.id == "update:ready" } }
        XCTAssertEqual(host.state.needs.filter { $0.id == "update:ready" }.map(\.acts), [[restart]])
        XCTAssertEqual(host.state.update?.id, "update:ready")
        _ = try await host.perform(.need(key: "update:ready", button: .do))
        XCTAssertEqual(installs, 2)
        host.needs.update(holding: nil, waiting: nil)
        XCTAssertNil(host.state.update)
        try await until("the ready update's need is gone") { !host.state.needs.contains { $0.id == "update:ready" } }
        let installed = await refusal { try await host.perform(.need(key: "update:ready", button: .do)) }
        XCTAssertEqual(installed, "That no longer needs doing.")
        XCTAssertEqual(installs, 2)

        let password = Task { try await host.perform(.need(key: "password:gmail.password", button: .do)) }
        try await until("host.sheet != nil") { host.sheet != nil }
        guard case .password(let need, let secret)? = host.sheet else { return XCTFail("not the password's sheet") }
        XCTAssertEqual(need.key, "password:gmail.password")
        XCTAssertEqual(secret, "gmail.password", "sealed as another secret than the member's its act sets")
        host.sheet = nil
        _ = try await password.value
    }

    func testThisMacIsReadAsTheWindowOpensAndWhenTheAppComesBack() async throws {
        let reads = Reads()
        let folder = URL(fileURLWithPath: "/Volumes/Drive-A/Lifestream")
        let host = host(nil, grants: {
            reads.add()
            return Dictionary(uniqueKeysWithValues: Grant.allCases.map { ($0, $0 != .fullDiskAccess) })
        }, folder: folder)
        var published: [HostState] = []
        host.published = { published.append($0) }
        host.start(polling: { false })
        defer { host.stop() }
        try await until("host.state.folder != nil") { host.state.folder != nil }
        XCTAssertEqual(reads.value, 1)
        XCTAssertEqual(host.state.folder, folder.path)
        XCTAssertEqual(host.state.grants.filter { !$0.granted }.map(\.id), ["fullDiskAccess"])
        XCTAssertEqual(host.state.grants.first { $0.id == "fullDiskAccess" }?.asking, false)
        XCTAssertEqual(published.last, host.state, "the state read was not set in the page")
        NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: nil)
        try await until("reads.value == 2") { reads.value == 2 }
        host.inset = HostState.Inset(left: 78, centre: 14)
        XCTAssertEqual(published.last?.inset, HostState.Inset(left: 78, centre: 14))
    }

    func testASheetsOpeningEndsWithItsSheetOrTheWindowAndWhatComesLateGoesNowhere() async throws {
        let report = HeldRequest(), signin = HeldRequest()
        let home = try ScriptedHome { request in
            let args = request["args"] as? [String] ?? []
            switch (request["verb"] as? String, args.first) {
            case ("connectors", nil):
                report.pass()
                return ["result": Self.report]
            case ("account-connect", _):
                signin.pass()
                return ["result": ["refused": "Gmail did not accept this app password.", "field": "password"]]
            case ("vault", _): return ["result": ["key_id": "3fa2c91b", "locked": false, "recovery": "confirmed"]]
            default: return ["error": "no verb is named \(request["verb"] ?? "")"]
            }
        }
        defer {
            for gate in [report, signin] where gate.arrived { gate.open() }
            home.stop()
        }

        do {
            let host = host(home)
            report.armed = true
            let act = Task { try await host.perform(.sheet(.init(connector: "gmail", route: "gmail-imap"))) }
            try await until("report.arrived") { report.arrived }
            host.stop()
            report.open()
            let settled = try await act.value
            XCTAssertNil(settled)
            XCTAssertNil(host.sheet, "Gmail showed after the window closed")
        }

        let host = host(home)
        let typed = ["account": "person-a@example.com", "password": "fake-app-password"]
        let first = Task { try await host.perform(.sheet(.init(connector: "gmail", route: "gmail-imap"))) }
        try await until("host.sheet != nil") { host.sheet != nil }
        signin.armed = true
        let signIn = host.connectAccount("gmail", route: "gmail-imap", values: typed)
        try await until("signin.arrived") { signin.arrived }
        XCTAssertTrue(host.working)
        host.sheet = nil
        _ = try await first.value
        signin.open()
        let answered = await signIn?.value
        XCTAssertEqual(answered, false, "an answer for a closed sheet counted as its own")
        XCTAssertNil(host.failure, "a late answer brought back the refusal")
        let again = Task { try await host.perform(.sheet(.init(connector: "gmail", route: "gmail-imap"))) }
        try await until("host.sheet != nil") { host.sheet != nil }
        XCTAssertNil(host.refusedField, "Gmail opened again at the refused row")
        XCTAssertFalse(host.working, "Sign in stays held by the closed sheet's request")
        host.sheet = nil
        _ = try await again.value
    }

    func testAKeyRoutesSheetDrawsItsFieldsAndSendsOneAccountConnect() async throws {
        let refused = Refusal(), failed = Refusal()
        let home = try ScriptedHome { request in
            switch (request["verb"] as? String, (request["args"] as? [String])?.first) {
            case ("connectors", nil): return ["result": Self.report]
            case ("vault", _): return ["result": ["key_id": "3fa2c91b", "locked": false, "recovery": "confirmed"]]
            case ("account-connect", _):
                if let words = failed.words { return ["error": words] }
                if let words = refused.words { return ["result": ["refused": words, "field": "key"]] }
                return ["result": ["account": "person-a@example.com", "source": "granola:person-a@example.com:cloud"]]
            default: return ["error": "no verb is named \(request["verb"] ?? "")"]
            }
        }
        defer { home.stop() }
        let host = host(home)
        var github = HomeReport.fixture["connectors"] as! [[String: Any]]
        github = github.filter { $0["id"] as? String == "github" }
        XCTAssertNil(MacHost.sheet(of: try JSONDecoder().decode(Connector.self, from: JSONSerialization.data(withJSONObject: github[0].merging(["members": [Any]()]) { $1 })),
                                   "github-api"), "a key route's sheet with a row no member labels")
        for asked in [HostAct.Sheet(connector: "granola", route: "granola-web"),
                      HostAct.Sheet(connector: "granola", route: "gmail-imap"),
                      HostAct.Sheet(connector: "imessage", route: "imessage")] {
            let words = await refusal { try await host.perform(.sheet(asked)) }
            XCTAssertEqual(words, "Lifestream has no such sign-in for that connector.", "\(asked)")
            XCTAssertNil(host.sheet)
        }
        let sheet = Task { try await host.perform(.sheet(.init(connector: "granola", route: "granola-api"))) }
        try await until("host.sheet != nil") { host.sheet != nil }
        guard case .account(let connector, let route)? = host.sheet else { return XCTFail("not the key route's sheet: \(String(describing: host.sheet))") }
        XCTAssertEqual(AccountSheet.rows(connector, route), [
            AccountSheet.Row(field: "account", label: "Granola email", secure: false, spaces: false, placeholder: "Required"),
            AccountSheet.Row(field: "key", label: "API key", secure: true, spaces: true, placeholder: "Required")])
        XCTAssertEqual(RouteWords.head(connector, route).title, "Connect Granola")
        XCTAssertEqual(RouteWords.head(connector, route).line,
                       "\(connector.gives) Use an API key · Business or Enterprise. Every meeting, with transcripts.",
                       "two routes: its sheet says which it is and what it takes")
        XCTAssertEqual(RouteWords.send(connector), "Connect Granola")
        XCTAssertEqual(route.steps.map(\.title), ["Make an API key"])

        let values = ["account": "person-a@example.com", "key": "grn_fake0000000000"]
        refused.words = "Granola did not take that API key."
        let first = await host.connectAccount("granola", route: "granola-api", values: values)?.value
        XCTAssertEqual(first, false)
        XCTAssertEqual(host.failure, refused.words)
        XCTAssertEqual(host.refusedField, "key")
        refused.words = nil
        failed.words = "No vault yet: make your recovery key in the Lifestream app first"
        let second = await host.connectAccount("granola", route: "granola-api", values: values)?.value
        XCTAssertEqual(second, false)
        XCTAssertEqual(host.failure, failed.words)
        XCTAssertNil(host.refusedField)
        failed.words = nil
        let third = await host.connectAccount("granola", route: "granola-api", values: values)?.value
        XCTAssertEqual(third, true)
        XCTAssertNil(host.failure)
        XCTAssertNil(host.refusedField)

        let attempts = home.requests.filter { $0["verb"] as? String == "account-connect" }
        XCTAssertEqual(attempts.count, 3)
        for attempt in attempts {
            XCTAssertEqual(attempt["connector"] as? String, "granola")
            XCTAssertEqual(attempt["route"] as? String, "granola-api")
            XCTAssertEqual(attempt["values"] as? [String: String], values)
            XCTAssertEqual(Set(attempt.keys), ["verb", "connector", "route", "values", "by"])
        }
        for request in home.requests where request["verb"] as? String != "account-connect" {
            XCTAssertFalse("\(request)".contains("grn_fake"), "a request carries the key: \(request)")
        }
        host.connected("Granola")
        host.sheet = nil
        let said = try await sheet.value
        XCTAssertEqual(said, "Granola is connected.")
    }

    func testADeviceRoutesSheetShowsItsCodeAsksAtTheIntervalAndStopsWhenClosed() async throws {
        let answers = Answers()
        let home = try ScriptedHome { request in
            switch (request["verb"] as? String, (request["args"] as? [String])?.first) {
            case ("connectors", nil): return ["result": Self.report]
            case ("vault", _): return ["result": ["key_id": "3fa2c91b", "locked": false, "recovery": "confirmed"]]
            case ("device-start", _):
                return ["result": ["code": "WDJB-MJHT", "open": "https://auth.example/device", "interval_ms": 5000,
                                   "expires_ms": 1_800_000_000_000, "attempt": ["client_id": "client-0001", "device_code": "device-code-0001"]]]
            case ("device-poll", _): return ["result": answers.next()]
            default: return ["error": "no verb is named \(request["verb"] ?? "")"]
            }
        }
        defer { home.stop() }
        let sleeps = Sleeps()
        let host = host(home, sleep: { try await sleeps.sleep($0) })
        let polls = { home.requests.filter { $0["verb"] as? String == "device-poll" } }
        let sheet = Task { try await host.perform(.sheet(.init(connector: "granola", route: "granola-mcp"))) }
        try await until("host.sheet != nil") { host.sheet != nil }
        guard case .device(_, let route)? = host.sheet else { return XCTFail("not the device route's sheet: \(String(describing: host.sheet))") }
        XCTAssertEqual(route.label, "Sign in with Granola")

        answers.queue = [["state": "pending", "interval_ms": 10000],
                         ["state": "signed_in", "account": "person-a@example.com", "source": "granola:person-a@example.com:cloud"]]
        let started = await host.startDevice("granola", route: "granola-mcp")?.value
        XCTAssertEqual(started, true)
        XCTAssertEqual(host.device, .code("WDJB-MJHT", open: URL(string: "https://auth.example/device")!))
        try await until("the first wait") { sleeps.waiting }
        XCTAssertEqual(sleeps.asked, [.milliseconds(5000)])
        XCTAssertTrue(polls().isEmpty, "asked before the interval")
        sleeps.release()
        try await until("the second wait") { sleeps.waiting && sleeps.asked.count == 2 }
        XCTAssertEqual(sleeps.asked.last, .milliseconds(10000))
        sleeps.release()
        try await until("signed in") { host.device == .signedIn }
        XCTAssertEqual(polls().map { $0["interval_ms"] as? Int }, [5000, 10000])
        for poll in polls() {
            XCTAssertEqual(poll["connector"] as? String, "granola")
            XCTAssertEqual(poll["route"] as? String, "granola-mcp")
            XCTAssertEqual(poll["attempt"] as? [String: String], ["client_id": "client-0001", "device_code": "device-code-0001"],
                           "the attempt not sent back as the home gave it")
        }
        XCTAssertFalse(sleeps.waiting, "asked on once signed in")
        XCTAssertEqual(sleeps.asked.count, 2)

        for (said, ended) in [("denied", DeviceSignIn.denied), ("expired", .expired)] {
            answers.queue = [["state": said]]
            let asked = polls().count
            _ = await host.startDevice("granola", route: "granola-mcp")?.value
            try await until("a wait for \(said)") { sleeps.waiting }
            sleeps.release()
            try await until(said) { host.device == ended }
            XCTAssertEqual(polls().count, asked + 1)
            XCTAssertFalse(sleeps.waiting, "asked on once \(said)")
        }

        answers.queue = [["state": "pending", "interval_ms": 5000]]
        _ = await host.startDevice("granola", route: "granola-mcp")?.value
        try await until("a wait") { sleeps.waiting }
        let asked = polls().count
        host.sheet = nil
        try await until("the wait ended with the sheet") { sleeps.cancelled == 1 }
        XCTAssertEqual(polls().count, asked, "asked once the sheet closed")
        XCTAssertNil(host.device)
        let closed = try await sheet.value
        XCTAssertNil(closed)
    }

    func testADeviceSignInsRefusalsAreTheHomesWords() async throws {
        let started = Refusal(), polled = Refusal()
        let home = try ScriptedHome { request in
            switch (request["verb"] as? String, (request["args"] as? [String])?.first) {
            case ("connectors", nil): return ["result": Self.report]
            case ("vault", _): return ["result": ["key_id": "3fa2c91b", "locked": false, "recovery": "confirmed"]]
            case ("device-start", _):
                if let words = started.words { return ["result": ["refused": words]] }
                return ["result": ["code": "WDJB-MJHT", "open": "https://auth.example/device", "interval_ms": 5000,
                                   "expires_ms": 1_800_000_000_000, "attempt": ["client_id": "client-0001", "device_code": "device-code-0001"]]]
            case ("device-poll", _):
                if let words = polled.words { return ["result": ["refused": words]] }
                return ["result": ["state": "pending", "interval_ms": 5000]]
            default: return ["error": "no verb is named \(request["verb"] ?? "")"]
            }
        }
        defer { home.stop() }
        let sleeps = Sleeps()
        let host = host(home, sleep: { try await sleeps.sleep($0) })
        let polls = { home.requests.filter { $0["verb"] as? String == "device-poll" } }
        let sheet = Task { try await host.perform(.sheet(.init(connector: "granola", route: "granola-mcp"))) }
        try await until("host.sheet != nil") { host.sheet != nil }

        started.words = "Another sign-in to Granola is under way. Finish it, or wait a minute."
        let refused = await host.startDevice("granola", route: "granola-mcp")?.value
        XCTAssertEqual(refused, false)
        XCTAssertEqual(host.failure, started.words)
        XCTAssertNil(host.device)
        XCTAssertTrue(sleeps.asked.isEmpty, "waited to ask after a refused code")

        started.words = nil
        polled.words = "Your vault is locked. Allow Lifestream on this Mac, then sign in again."
        let code = await host.startDevice("granola", route: "granola-mcp")?.value
        XCTAssertEqual(code, true)
        XCTAssertNil(host.failure)
        try await until("the first wait") { sleeps.waiting }
        sleeps.release()
        try await until("the refusal") { host.failure != nil }
        XCTAssertEqual(host.failure, polled.words)
        XCTAssertNil(host.device)
        XCTAssertEqual(polls().count, 1)
        XCTAssertFalse(sleeps.waiting, "asked on after a refusal")
        XCTAssertEqual(sleeps.asked.count, 1)
        host.sheet = nil
        _ = try await sheet.value
    }

    func testADevicePollWaitingItsTurnIsNotSentOnceItsSheetCloses() async throws {
        let faces = HeldRequest()
        let home = try ScriptedHome { request in
            switch (request["verb"] as? String, (request["args"] as? [String])?.first) {
            case ("connectors", nil): return ["result": Self.report]
            case ("vault", _): return ["result": ["key_id": "3fa2c91b", "locked": false, "recovery": "confirmed"]]
            case ("device-start", _):
                return ["result": ["code": "WDJB-MJHT", "open": "https://auth.example/device", "interval_ms": 5000,
                                   "expires_ms": 1_800_000_000_000, "attempt": ["client_id": "client-0001", "device_code": "device-code-0001"]]]
            case ("device-poll", _): return ["result": ["state": "signed_in", "account": "person-a@example.com",
                                                        "source": "granola:person-a@example.com:cloud"]]
            case ("faces", _):
                faces.pass()
                return ["result": [String: Any]()]
            default: return ["error": "no verb is named \(request["verb"] ?? "")"]
            }
        }
        defer {
            if faces.arrived { faces.open() }
            home.stop()
        }
        let sleeps = Sleeps()
        let host = host(home, sleep: { try await sleeps.sleep($0) })
        let polls = { home.requests.filter { $0["verb"] as? String == "device-poll" } }
        let sheet = Task { try await host.perform(.sheet(.init(connector: "granola", route: "granola-mcp"))) }
        try await until("host.sheet != nil") { host.sheet != nil }
        _ = await host.startDevice("granola", route: "granola-mcp")?.value
        try await until("the first wait") { sleeps.waiting }

        faces.armed = true
        let held = Task { try await host.perform(.faces(.on)) }
        try await until("the request held") { faces.arrived }
        sleeps.release()
        try await until("the poll waits its turn") { host.waiting == 1 }
        host.sheet = nil
        _ = try await sheet.value
        faces.open()
        _ = try await held.value
        try await until("the queue empty") { host.waiting == 0 }
        _ = try await host.perform(.faces(.on))
        XCTAssertTrue(polls().isEmpty, "a poll was sent once its sheet closed: \(polls())")
        XCTAssertNil(host.device)
    }

}

private final class HeldRequest: @unchecked Sendable {
    private let lock = NSLock()
    private let opened = DispatchSemaphore(value: 0)
    private var _armed = false
    private var _arrived = false
    var armed: Bool {
        get { lock.withLock { _armed } }
        set { lock.withLock { _armed = newValue } }
    }
    var arrived: Bool { lock.withLock { _arrived } }

    func pass() {
        guard armed else { return }
        lock.withLock { _arrived = true }
        opened.wait()
    }

    func open() {
        lock.withLock { (_armed, _arrived) = (false, false) }
        opened.signal()
    }
}

@MainActor private final class Flag {
    var set = false
}

private final class Reads: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func add() { lock.withLock { count += 1 } }
}

private final class Refusal: @unchecked Sendable {
    private let lock = NSLock()
    private var _words: String?
    var words: String? {
        get { lock.withLock { _words } }
        set { lock.withLock { _words = newValue } }
    }
}

private final class Answers: @unchecked Sendable {
    private let lock = NSLock()
    private var _queue: [[String: Any]] = []
    var queue: [[String: Any]] {
        get { lock.withLock { _queue } }
        set { lock.withLock { _queue = newValue } }
    }

    func next() -> [String: Any] {
        lock.withLock { _queue.isEmpty ? ["state": "pending", "interval_ms": 5000] : _queue.removeFirst() }
    }
}

@MainActor private final class Sleeps {
    private(set) var asked: [Duration] = []
    private(set) var cancelled = 0
    private var held: CheckedContinuation<Void, Error>?
    var waiting: Bool { held != nil }

    func sleep(_ duration: Duration) async throws {
        asked.append(duration)
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { held = $0 }
        } onCancel: {
            Task { @MainActor in self.cancel() }
        }
    }

    func release() {
        held?.resume()
        held = nil
    }

    private func cancel() {
        cancelled += 1
        held?.resume(throwing: CancellationError())
        held = nil
    }
}
