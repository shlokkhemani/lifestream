import Combine
import Foundation
import HomeLink
import Passwords
import Security
import Shipping
import UserNotifications
import XCTest
@testable import Lifestream

@MainActor final class NeedsTests: XCTestCase {
    private func state(keyID: String? = "3fa2c91b", locked: Bool = false, recovery: String = "confirmed") -> VaultState {
        VaultState(answer: ["key_id": (keyID as Any?) ?? NSNull(), "locked": locked, "recovery": recovery])!
    }

    private func notice(_ id: String, since: Int64 = 1_760_342_400_000, words: String, acts: [[String: Any]] = []) -> HomeLink.Need {
        HomeReport.need(id, words, since: since, acts: acts)
    }

    func testEachNeedTheHomeStatesIsListedOnceWithItsButton() {
        let locked = notice("vault:locked", words: "Passwords are locked on this Mac", acts: [["do": "vault", "label": "Unlock"]])
        let unsaved = notice("vault:unsaved", words: "Your recovery key is not saved", acts: [["do": "vault", "label": "Make a new key"]])
        let none = notice("vault:none", words: "No vault yet: make your recovery key in the Lifestream app", acts: [["do": "vault", "label": "Make your recovery key"]])
        let password = HomeReport.password("x.password", connector: "x", member: "password", "X wants your password to make your export",
                                           since: 1_760_342_400_000)
        let failing = notice("poll:gmail-imap", words: "Gmail has failed: the app password was refused")
        let all = [locked, unsaved, none, password, failing]

        XCTAssertEqual(Needs.list(vault: state(locked: true), keyMayOpen: true, update: nil, ready: nil, needs: all), [
            .allow,
            .password(password, set: password.acts[0]),
            .notice(failing),
        ])
        XCTAssertEqual(Needs.list(vault: state(locked: true), keyMayOpen: false, update: nil, ready: nil, needs: []), [.unlock])
        XCTAssertEqual(Needs.list(vault: state(recovery: "unconfirmed"), keyMayOpen: true, update: nil, ready: nil, needs: [unsaved]), [.saveRecoveryKey(keyed: false)])
        XCTAssertEqual(Needs.list(vault: state(locked: true, recovery: "unconfirmed"), keyMayOpen: true, update: nil, ready: nil, needs: []), [.allow])
        XCTAssertEqual(Needs.list(vault: state(keyID: nil, locked: true, recovery: "none"), keyMayOpen: true, update: nil, ready: nil, needs: [none]), [])
        XCTAssertEqual(Needs.list(vault: nil, keyMayOpen: true, update: nil, ready: nil, needs: []), [])
        let refused = UpdateFailure.refused("the self-check refused: synthetic problem")
        let update = Needs.list(vault: state(), keyMayOpen: true, update: refused, ready: nil, needs: [])
        XCTAssertEqual(update, [.updateFailed(refused)])
        XCTAssertEqual(update.first?.key, "update")
        XCTAssertEqual(update.first?.line, "Lifestream didn't update")
        XCTAssertEqual(update.first?.detail, "It runs the release it has meanwhile", "no raw words of the refusal")
        XCTAssertEqual(update.first?.acts.map(\.label), [], "Try again offered where it repeats the refusal")
        let blocked = Need.updateFailed(.blocked("Lifestream's jobs run only from this app, and another definition runs x. Remove each, then try again."))
        XCTAssertEqual(blocked.acts.map(\.button), [.tryAgain])
        XCTAssertEqual(blocked.detail, "It runs the release it has meanwhile · Lifestream's jobs run only from this app, and another definition runs x. Remove each, then try again.")
        let ready = Needs.list(vault: state(locked: true), keyMayOpen: true, update: refused, ready: "1900", needs: [])
        XCTAssertEqual(ready, [.updateFailed(refused), .updateReady("1900"), .allow])
        XCTAssertEqual(ready[1].key, "update:ready")
        XCTAssertEqual(ready[1].line, "Lifestream 1900 is ready")
        XCTAssertEqual(ready[1].acts.map(\.button), [.do])
        XCTAssertEqual(ready[1].acts.map(\.label), ["Restart to Update"])
        XCTAssertEqual(NeedStrip.primary(ready[1])?.label, "Restart to Update")
        XCTAssertNil(ready[1].page)
        XCTAssertFalse(ready[1].home)
        XCTAssertNil(Need.saveRecoveryKey(keyed: false).page, "Save your recovery key opens the page, not the recovery key window")
        XCTAssertEqual(Need.saveRecoveryKey(keyed: false).acts.map(\.label), ["Save key"])
        XCTAssertNil(Need.allow.page)
        let asking = HomeReport.knock("arc", "Arc has been asking to connect since 14:02", since: 1_761_400_920_000)
        let connect = Needs.list(vault: state(), keyMayOpen: true, update: nil, ready: nil, needs: [asking])
        XCTAssertEqual(connect, [.connect(asking, browser: asking.acts[0])])
        XCTAssertEqual(connect.first?.key, "connect:arc")
        XCTAssertEqual(connect.first?.line, "Arc has been asking to connect since 14:02")
        XCTAssertEqual(connect.first?.said(saved: false), "Connect it if you just added the extension")
        XCTAssertEqual(connect.first?.acts.map(\.label), ["Connect"])
        XCTAssertEqual(connect.first?.page, "dialog=settings/chrome&flow=browser")
        XCTAssertEqual(NeedStrip.primary(.saveRecoveryKey(keyed: false))?.label, "Save key", "the failure view hides the recovery key window's door")
        XCTAssertNil(NeedStrip.primary(connect[0]), "the failure view offers Connect…")
        XCTAssertEqual(NeedStrip.primary(.allow)?.label, "Allow")
        XCTAssertEqual(Need.allow.line, "Passwords are locked on this Mac")
        let disk = notice("disk", words: "Your home's disk fills up in about 21 days", acts: [["do": "storage", "label": "Manage storage"]])
        let listed = Needs.list(vault: state(), keyMayOpen: true, update: nil, ready: nil, needs: [disk])
        XCTAssertEqual(listed, [.notice(disk)])
        XCTAssertEqual(listed.first?.line, "Your home's disk fills up in about 21 days")
        XCTAssertEqual(listed.first?.acts.map(\.label), ["Manage storage"])
        XCTAssertEqual(Needs.list(vault: state(), keyMayOpen: true, update: nil, ready: nil, needs: [failing]).first?.acts.map(\.label), [])
        XCTAssertEqual(Needs.list(vault: state(), keyMayOpen: true, update: nil, ready: nil, needs: [notice("disk", words: disk.words)]).first?.acts.map(\.label), [],
                       "placed by its id")
        XCTAssertEqual(Needs.list(vault: state(), keyMayOpen: true, update: nil, ready: nil, needs: [notice("vault:other", words: "x", acts: [["do": "vault", "label": "Unlock"]])]), [])
    }

    func testAnAdviceNeverMovesTheWindowAndAStoppedNeedDoes() {
        let advice = HomeReport.need("disk", "Your home's disk fills up in about 25 days", weight: "advice")
        let stopped = HomeReport.need("poll:gmail-imap", "Gmail has failed: the app password was refused", weight: "stopped")
        XCTAssertFalse(Need.notice(advice).steers, "a disk advice moved the window to Connectors")
        XCTAssertTrue(Need.notice(stopped).steers)
        XCTAssertTrue(Need.filesRefused.steers)
    }

    func testTheWindowOpensWhenANeedBeginsAndNotAgainWhileItStands() {
        var watch = NeedWatch()
        XCTAssertFalse(watch.began(["vault:locked"]), "the first read opened the window")
        XCTAssertFalse(watch.began(["vault:locked"]), "a need that stands opened the window again")
        XCTAssertTrue(watch.began(["vault:locked", "update"]))
        XCTAssertFalse(watch.began(["update"]))
        XCTAssertFalse(watch.began([]))
        XCTAssertTrue(watch.began(["update"]), "a need that ended and came back did not open the window")
        let asked = HomeReport.password("x.password", connector: "x", member: "password", "X", since: 1_760_342_400_000)
        let askedAgain = HomeReport.password("x.password", connector: "x", member: "password", "X", since: 1_760_346_000_000)
        let first = Need.password(asked, set: asked.acts[0])
        let again = Need.password(askedAgain, set: askedAgain.acts[0])
        XCTAssertTrue(watch.began([first.id]))
        XCTAssertFalse(watch.began([first.id]))
        XCTAssertTrue(watch.began([again.id]), "a new occurrence of a password notice did not open the window")
        let knock = HomeReport.knock("arc", "Arc has been asking to connect since 14:02", since: 1_761_400_920_000)
        let knockAgain = HomeReport.knock("arc", "Arc has been asking to connect since 14:09", since: 1_761_401_340_000)
        let knocked = Need.connect(knock, browser: knock.acts[0])
        let restated = Need.connect(knockAgain, browser: knockAgain.acts[0])
        XCTAssertTrue(watch.began([knocked.id]))
        XCTAssertFalse(watch.began([restated.id]), "a knock stated again began again, so its notification posts twice")
    }

    func testTheNeedsAreReadWithoutTheKeychainAndAllowReadsItTwiceThenUnlocks() async throws {
        let vault = Vault()
        let home = try ScriptedHome { request in
            switch request["verb"] as? String {
            case "vault": return ["result": ["key_id": "3fa2c91b", "locked": vault.locked, "recovery": "confirmed"]]
            case "unlock":
                vault.locked = false
                return ["result": ["key_id": "3fa2c91b"]]
            default: return ["error": "no verb is named \(request["verb"] ?? "")"]
            }
        }
        defer { home.stop() }
        let store = MemoryStore()
        store.data = Data(repeating: 7, count: 32)
        let suite = "NeedsTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let socket = HomeSocket(path: home.path, folder: home.folder)
        let keeper = VaultKeeper(machine: store, old: MemoryStore(), trust: KeychainTrust(build: "build-2", defaults: defaults), socket: { socket })
        let model = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        var opened = 0
        model.began = { begun in
            opened += 1
            XCTAssertEqual(begun, [.allow], "what began is not the need that began")
        }
        await model.read()
        XCTAssertEqual(model.list, [])
        XCTAssertEqual(opened, 0)
        vault.locked = true
        await model.read()
        XCTAssertEqual(model.list, [.allow])
        XCTAssertEqual(opened, 1)
        XCTAssertEqual(store.prompted, [], "deciding the needs read the Keychain item")
        await model.read()
        XCTAssertEqual(opened, 1, "a need that stands opened the window again")
        model.allow()
        while model.working.contains("vault:locked") || !model.list.isEmpty { await Task.yield() }
        XCTAssertEqual(store.prompted, [true, true], "Allow did not read twice")
        XCTAssertEqual(home.requests.compactMap { $0["verb"] as? String }.filter { $0 == "unlock" }.count, 1)
        XCTAssertEqual(defaults.string(forKey: KeychainTrust.name), "build-2")
        XCTAssertNil(model.refusals["vault:locked"])
    }

    func testTheUnlockSheetOpensWithoutTheRefusalOfAnEarlierAllow() async throws {
        let notThis = "the Mac app offered a key that is not this vault's: nothing was changed"
        let wrongKey = "that recovery key does not open this vault: nothing was changed"
        let home = try ScriptedHome { request in
            switch request["verb"] as? String {
            case "vault": return ["result": ["key_id": "3fa2c91b", "locked": true, "recovery": "confirmed"]]
            case "unlock": return SocketMachine.wrongKey
            case "recover": return ["error": wrongKey]
            default: return ["error": "no verb is named \(request["verb"] ?? "")"]
            }
        }
        defer { home.stop() }
        let store = MemoryStore()
        store.data = Data(repeating: 7, count: 32)
        let suite = "NeedsTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let socket = HomeSocket(path: home.path, folder: home.folder)
        let keeper = VaultKeeper(machine: store, old: MemoryStore(), trust: KeychainTrust(build: "build-2", defaults: defaults), socket: { socket })
        let model = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        await model.read()
        XCTAssertEqual(model.list, [.allow])
        let allowed = try XCTUnwrap(model.allow())
        _ = await allowed.value
        XCTAssertEqual(model.refusals[Need.allow.id], notThis)
        XCTAssertEqual(model.list, [.unlock], "a key the vault refused left Allow standing")

        model.opened(.unlock)
        XCTAssertNil(model.refusals[Need.unlock.id], "the Unlock sheet opened under the refusal of an earlier Allow")
        model.unlock("MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAB")
        try await until("the unlock is refused") { model.refusals[Need.unlock.id] != nil && !model.working.contains(Need.unlock.id) }
        XCTAssertEqual(model.refusals[Need.unlock.id], "That recovery key does not open this vault: nothing was changed.",
                       "the sheet did not show its own refusal, as a sentence")
        model.opened(.unlock)
        XCTAssertNil(model.refusals[Need.unlock.id], "the Unlock sheet opened again under its last refusal")
    }

    func testARefusedRecoveryKeyLeavesNoKeyInTheKeychainAndTheNeedStaysUnlock() async throws {
        let vault = Vault()
        vault.locked = true
        let right = "MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAA"
        let home = try ScriptedHome { request in
            switch request["verb"] as? String {
            case "vault": return ["result": ["key_id": "3fa2c91b", "locked": vault.locked, "recovery": "confirmed"]]
            case "recover":
                guard request["recovery"] as? String == right else { return ["error": "that recovery key does not open this vault: nothing was changed"] }
                vault.locked = false
                return ["result": ["key_id": "3fa2c91b", "slot": "m-0a1b2c3d"]]
            default: return ["error": "no verb is named \(request["verb"] ?? "")"]
            }
        }
        defer { home.stop() }
        let store = MemoryStore()
        let socket = HomeSocket(path: home.path, folder: home.folder)
        let keeper = VaultKeeper(machine: store, old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { socket })
        let model = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        await model.read()
        XCTAssertEqual(model.list, [.unlock])

        model.unlock("MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAB")
        while model.working.contains("vault:locked") { await Task.yield() }
        XCTAssertEqual(model.refusals["vault:locked"], "That recovery key does not open this vault: nothing was changed.")
        XCTAssertNil(store.data, "a refused recovery left a key in the Keychain that opens no slot")
        XCTAssertEqual(model.list, [.unlock], "a refused recovery turned Unlock into an Allow that can only fail")
        let relaunched = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        await relaunched.read()
        XCTAssertEqual(relaunched.list, [.unlock])

        model.unlock(right)
        while model.working.contains("vault:locked") || !model.list.isEmpty { await Task.yield() }
        let recovered = try XCTUnwrap(home.requests.last { $0["verb"] as? String == "recover" })
        XCTAssertEqual(recovered["slot_key"] as? String, store.data?.base64EncodedString(), "the slot the home took has no key stored")
    }

    func testALockedKeyedHomeAsksAllowThenItsRecoveryKeyAndRestartsTheDoorOnceOpen() async throws {
        let vault = Vault()
        vault.locked = true
        let right = "MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAA"
        let why = "This Mac didn't hand Lifestream its key when it started."
        let slots: [[String: Any]] = [["id": "r-1", "kind": "recovery", "made_ms": 1_794_916_800_000, "confirmed_ms": 1_794_916_800_001]]
        let done = Collected<String>()
        let home = try ScriptedHome { request in
            switch request["verb"] as? String {
            case "vault":
                var state: [String: Any] = ["key_id": "3fa2c91b", "keyed": true, "locked": vault.locked, "recovery": "confirmed", "slots": vault.slots(slots)]
                if vault.locked { state["why"] = why }
                return ["result": state]
            case "unlock": return SocketMachine.wrongKey
            case "recover":
                guard request["recovery"] as? String == right, request["slot_key"] == nil else { return ["error": "that recovery key does not open this vault: nothing was changed"] }
                vault.locked = false
                return ["result": ["key_id": "3fa2c91b", "slot": "r-1"]]
            case "vault-slot":
                done.append("vault-slot")
                return ["result": ["slot": vault.keep(request)]]
            default: return ["error": "no verb is named \(request["verb"] ?? "")"]
            }
        }
        defer { home.stop() }
        let store = MemoryStore()
        store.data = Data(repeating: 7, count: 32)
        let socket = HomeSocket(path: home.path, folder: home.folder)
        let keeper = VaultKeeper(key: HomeKey(store: store, trust: KeychainTrust(build: ""), reader: .app, keyed: true), old: MemoryStore(), socket: { socket })
        let model = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        model.restartDoor = { done.append("restart door") }
        model.door = { done.values.contains("restart door") ? .serves : .locked }
        let faces = Collected<String>()
        let watch = model.$opening.combineLatest(model.$notKept).sink { opening, notKept in
            if !opening, let notKept { faces.append(notKept) }
        }
        defer { watch.cancel() }

        await model.read()
        XCTAssertEqual(model.list, [.homeLocked(allow: true)], "a keyed home whose Mac holds a key did not ask Allow first")
        XCTAssertEqual(model.lockedWhy, why, "the locked page did not show the why the home's vault answer carries")
        XCTAssertFalse(home.requests.contains { $0["verb"] as? String == "status" }, "the why was asked of the home a second time")
        XCTAssertEqual(model.cover, .locked(allow: true))
        XCTAssertEqual(LockedPage.face(model.cover, withKey: false), .allow)
        XCTAssertEqual(LockedPage.face(model.cover, withKey: true), .key)
        XCTAssertEqual(store.prompted, [], "deciding the locked page read the Keychain item")
        XCTAssertEqual(Need.homeLocked(allow: true).line, "Lifestream is locked")
        XCTAssertEqual(Need.homeLocked(allow: true).detail, "Unlock it.")
        XCTAssertTrue(NeedNotification.calls(.homeLocked(allow: true)))

        let allowed = try XCTUnwrap(model.allow())
        _ = await allowed.value
        XCTAssertEqual(model.refusals[Need.allow.id], "the Mac app offered a key that is not this vault's: nothing was changed")
        XCTAssertEqual(model.list, [.homeLocked(allow: false)], "a key the home refused left Allow standing")
        XCTAssertEqual(LockedPage.face(model.cover, withKey: false), .key)
        XCTAssertEqual(done.values, [], "a refused Allow restarted the door")

        let unlocked = try XCTUnwrap(model.unlock(right))
        let refused = await unlocked.value
        XCTAssertNil(refused)
        try await until("the door serves") { !model.opening && done.values.count == 2 }
        XCTAssertEqual(done.values, ["vault-slot", "restart door"], "the door was restarted before this Mac's slot was kept")
        XCTAssertEqual(faces.values, [], "the page left Opening Lifestream for another face before the door served")
        XCTAssertNil(model.cover)
        XCTAssertEqual(model.list, [])
        XCTAssertNil(model.lockedWhy)
        XCTAssertEqual(home.requests.compactMap { $0["verb"] as? String }.filter { $0 == "recover" || $0 == "vault-slot" }, ["recover", "vault-slot"])
    }

    private func keyedHome(_ vault: Vault, _ done: Collected<String>, held: Vault? = nil) throws -> ScriptedHome {
        try ScriptedHome { request in
            let verb = request["verb"] as? String ?? ""
            switch verb {
            case "vault": return ["result": ["key_id": "3fa2c91b", "keyed": true, "locked": vault.locked, "recovery": "confirmed", "slots": vault.slots()]]
            case "recover", "unlock":
                done.append(verb)
                vault.locked = false
                return ["result": ["key_id": "3fa2c91b", "slot": "r-1"]]
            case "vault-slot":
                if held?.locked == true {
                    let words = "Lifestream isn't ready yet"
                    return ["error": words, "refusal": ["status": 503, "code": "NOT_NOW", "words": words, "extra": [String: Any]()]]
                }
                done.append(verb)
                return ["result": ["slot": vault.keep(request)]]
            default: return ["error": "no verb is named \(verb)"]
            }
        }
    }

    func testARecoverTheKeychainWillNotKeepSaysTheHomeIsOpenButUnreadAndTryAgainKeepsTheKey() async throws {
        let vault = Vault()
        vault.locked = true
        let done = Collected<String>()
        let home = try keyedHome(vault, done)
        defer { home.stop() }
        let store = MemoryStore()
        store.refusal = .keychain(-25293)
        let socket = HomeSocket(path: home.path, folder: home.folder)
        let keeper = VaultKeeper(key: HomeKey(store: store, trust: KeychainTrust(build: ""), reader: .app, keyed: true), old: MemoryStore(), socket: { socket })
        let model = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        model.restartDoor = { done.append("restart door") }
        model.door = { done.values.contains("restart door") ? .serves : .locked }
        await model.read()
        XCTAssertEqual(model.list, [.homeLocked(allow: false)], "a Mac that holds no key for the home asked Allow")
        let unlocked = try XCTUnwrap(model.unlock("MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAA"))
        let refused = await unlocked.value
        XCTAssertNil(refused, "a home the recovery key opened said its Keychain's refusal as Unlock's")
        try await until("the page says why the home cannot be read") { !model.opening && model.notKept != nil }
        let why = "Your Mac's Keychain said: \(KeyStoreError.keychain(-25293).reason)"
        XCTAssertEqual(model.cover, .notKept(why))
        XCTAssertEqual(model.list, [], "the open home was said as a need besides its page")
        let face = LockedPage.face(model.cover, withKey: false)
        XCTAssertEqual(face, .notKept(why), "the page said Opening Lifestream while nothing could read the home")
        XCTAssertEqual(LockedPage.title(face), "This Mac couldn't keep Lifestream's key")
        XCTAssertEqual(LockedPage.notKeptWords, "Lifestream is open, but nothing can read it until this Mac keeps its key.")
        XCTAssertEqual(done.values, ["recover"], "the door was restarted with no key for it to read")

        store.refusal = nil
        model.keepAgain()
        try await until("Try again kept the key and the door serves") { !model.opening && model.cover == nil }
        XCTAssertEqual(done.values, ["recover", "vault-slot", "restart door"])
        let slot = home.requests.first { $0["verb"] as? String == "vault-slot" }?["slot_key"] as? String
        XCTAssertEqual(slot.flatMap { Data(base64Encoded: $0) }, store.data, "the slot sent is not the key the Keychain kept")
        XCTAssertEqual(LockedPage.title(LockedPage.face(nil, withKey: false)), "Lifestream is locked")
    }

    func testALockedOrRefusingKeychainWhileTheHomeServesShowsNoPageAndKeepsTheTrust() async throws {
        let vault = Vault()
        let done = Collected<String>()
        let home = try keyedHome(vault, done)
        defer { home.stop() }
        let suite = "NeedsTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let store = MemoryStore()
        store.data = Data(repeating: 7, count: 32)
        vault.kept(store.data)
        let trust = KeychainTrust(build: "build-7", defaults: defaults, record: "vault.machineKeyReadBy.machine:home-a")
        let key = HomeKey(store: store, trust: trust, reader: .app, keyed: true)
        _ = try key.read()
        XCTAssertTrue(trust.allowed)
        let socket = HomeSocket(path: home.path, folder: home.folder)
        let keeper = VaultKeeper(key: key, old: MemoryStore(), socket: { socket })
        let model = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        model.door = { .serves }
        try await until("the door's answer is heard") {
            await model.read()
            return model.doorSaid == .serves
        }
        let reads = store.prompted.count

        store.attributesRefusal = .keychain(-25308)
        store.refusal = .keychain(-25308)
        await model.read()
        XCTAssertNil(model.cover, "a locked Keychain covered a serving home")
        XCTAssertTrue(trust.allowed, "a locked Keychain cleared this build's trust, so the next start is locked")

        store.attributesRefusal = nil
        store.refusal = .keychain(errSecAuthFailed)
        await model.read()
        XCTAssertNil(model.cover, "a Keychain refusing the key's value covered a serving home")
        XCTAssertTrue(trust.allowed, "a menu read cleared this build's trust")
        XCTAssertEqual(store.prompted.count, reads, "deciding the page read the key's value")

        store.mark = "00000000"
        await model.read()
        XCTAssertEqual(model.cover, .notKept(NeedsModel.slotMissing), "an item naming another key was said as kept")
        XCTAssertEqual(done.values, [])
    }

    func testARefusedKeepIsNotSaidAgainWhileTheHomeRestartsAndTheSlotIsSaidFromStateOnceItAnswers() async throws {
        let vault = Vault()
        vault.locked = true
        let done = Collected<String>()
        let first = try keyedHome(vault, done)
        defer { first.stop() }
        let sockets = Collected<HomeSocket>()
        sockets.append(HomeSocket(path: first.path, folder: first.folder))
        let store = MemoryStore()
        store.refusal = .keychain(-25293)
        let keeper = VaultKeeper(key: HomeKey(store: store, trust: KeychainTrust(build: ""), reader: .app, keyed: true), old: MemoryStore(),
                                 socket: { sockets.values.last })
        let model = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        model.restartDoor = { done.append("restart door") }
        model.door = { .serves }
        await model.read()
        _ = await model.unlock("MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAA")?.value
        let why = "Your Mac's Keychain said: \(KeyStoreError.keychain(-25293).reason)"
        try await until("the keep's refusal is said") { !model.opening && model.cover == .notKept(why) }

        first.stop()
        await model.read()
        XCTAssertNil(model.notKept, "a home that did not answer kept the refusal of a keep before its restart")

        let back = try keyedHome(vault, done)
        defer { back.stop() }
        sockets.append(HomeSocket(path: back.path, folder: back.folder))
        await model.read()
        XCTAssertEqual(model.cover, .notKept(NeedsModel.slotMissing), "the home back did not say the slot this Mac never kept")
        XCTAssertEqual(done.values, ["recover"])
    }

    func testAnAllowTheDoorsLaunchCannotReadSaysSoAndTryAgainAsksTheKeychainAgain() async throws {
        let vault = Vault()
        vault.locked = true
        let done = Collected<String>()
        let home = try keyedHome(vault, done)
        defer { home.stop() }
        let suite = "NeedsTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let store = MemoryStore()
        store.data = Data(repeating: 7, count: 32)
        vault.kept(store.data)
        let trust = KeychainTrust(build: "build-7", defaults: defaults, record: "vault.machineKeyReadBy.machine:home-a")
        let socket = HomeSocket(path: home.path, folder: home.folder)
        let keeper = VaultKeeper(key: HomeKey(store: store, trust: trust, reader: .app, keyed: true), old: MemoryStore(), socket: { socket })
        let model = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        model.doorPace = .milliseconds(20)
        let launched = Collected<KeyRead>()
        model.restartDoor = {
            done.append("restart door")
            let first = launched.values.isEmpty
            launched.append(HomeKey(store: first ? Unanswered() : store, trust: trust, reader: .helper, keyed: true).launchRead(within: 0.2))
        }
        model.door = {
            guard case .key? = launched.values.last else { return .locked }
            return .serves
        }
        await model.read()
        XCTAssertEqual(model.list, [.homeLocked(allow: true)])
        let allowed = try XCTUnwrap(model.allow())
        let refused = await allowed.value
        XCTAssertNil(refused)
        try await until("the page says the door has no key") { !model.opening && model.notKept != nil }
        XCTAssertEqual(launched.values.map { if case .unanswered = $0 { true } else { false } }, [true])
        XCTAssertEqual(model.cover, .notKept(NeedsModel.doorKeyless))
        XCTAssertEqual(done.values, ["unlock", "restart door"])
        XCTAssertTrue(trust.allowed, "the door's launch macOS could not ask for took this build's trust")

        let prompted = store.prompted.count
        model.keepAgain()
        try await until("Try again read the Keychain and the door serves") { !model.opening && model.cover == nil }
        let after = Array(store.prompted.dropFirst(prompted))
        XCTAssertEqual(after.filter { $0 }, [true, true], "Try again did not ask the Keychain as Allow does")
        XCTAssertEqual(after.first, true, "the Keychain was read before Try again asked it")
        XCTAssertEqual(after.last, false, "the door's launch did not read the key Try again kept")
        XCTAssertEqual(done.values, ["unlock", "restart door", "vault-slot", "restart door"])
        XCTAssertTrue(trust.allowed)
    }

    func testAnOpenKeyedHomeSaysThisMacsKeyFromItsSlotAndTheDoorsLastAnswerAndAReadNeverWaitsOnTheDoor() async throws {
        let vault = Vault()
        let done = Collected<String>()
        let home = try keyedHome(vault, done)
        defer { home.stop() }
        let suite = "NeedsTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let store = MemoryStore()
        store.data = Data(repeating: 7, count: 32)
        vault.kept(store.data)
        let trust = KeychainTrust(build: "build-7", defaults: defaults, record: "vault.machineKeyReadBy.machine:home-a")
        let socket = HomeSocket(path: home.path, folder: home.folder)
        let keeper = VaultKeeper(key: HomeKey(store: store, trust: trust, reader: .app, keyed: true), old: MemoryStore(), socket: { socket })
        let trusted = VaultKeeper(key: HomeKey(store: store, trust: KeychainTrust(build: ""), reader: .app, keyed: true), old: MemoryStore(), socket: { socket })

        let silent = DoorGate()
        let asked = Collected<String>()
        let waiting = NeedsModel(keeper: trusted, recovery: RecoveryKey(keeper: trusted))
        waiting.door = {
            asked.append("door")
            await silent.wait()
            return .locked
        }
        let reads = Collected<String>()
        Task { @MainActor in
            await waiting.read()
            reads.append("read")
        }
        try await until("a read ends while the door has not answered") { reads.values == ["read"] }
        XCTAssertEqual(asked.values, ["door"], "an open keyed home's read did not ask the door beside it")
        XCTAssertNil(waiting.cover, "a Mac whose slot is kept was said as not kept before its door answered")
        await waiting.read()
        XCTAssertEqual(asked.values, ["door"], "a second read asked the door again while the first probe was out")
        await silent.open()
        try await until("a door that started without the key this Mac keeps is said") { waiting.cover == .notKept(NeedsModel.doorKeyless) }
        XCTAssertEqual(NeedsModel.doorKeyless, "Lifestream started without this Mac's key.")

        let serving = NeedsModel(keeper: trusted, recovery: RecoveryKey(keeper: trusted))
        serving.door = { .serves }
        try await until("the door's answer is heard") {
            await serving.read()
            return serving.doorSaid == .serves
        }
        await serving.read()
        XCTAssertNil(serving.cover, "a Mac whose slot the vault holds was said as not keeping its key")
        XCTAssertFalse(store.prompted.contains(true), "deciding the page asked the Keychain with a dialog")

        let relaunched = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        relaunched.restartDoor = { done.append("restart door") }
        relaunched.door = { .serves }
        let read = store.prompted.count
        await relaunched.read()
        XCTAssertEqual(relaunched.cover, .notKept(NeedsModel.notHanded),
                       "a build whose next launch cannot read the key without asking was not said while the door serves")
        XCTAssertEqual(relaunched.list, [], "an open home was said as locked")
        XCTAssertEqual(LockedPage.title(LockedPage.face(relaunched.cover, withKey: false)), "This Mac couldn't keep Lifestream's key")
        XCTAssertEqual(store.prompted.count, read, "deciding the page for a build the Keychain has not trusted read the item")

        relaunched.keepAgain()
        try await until("Try again kept the key and the door serves") { !relaunched.opening && relaunched.cover == nil }
        XCTAssertEqual(done.values, ["vault-slot", "restart door"], "Try again did not keep the key and then restart the door")
        XCTAssertTrue(trust.allowed)

        store.data = nil
        await relaunched.read()
        XCTAssertEqual(relaunched.cover, .notKept(NeedsModel.slotMissing), "a Keychain that lost this Mac's item was not said")
        XCTAssertEqual(NeedsModel.slotMissing, "Without it, Lifestream asks for the recovery key the next time it starts.")

        let plainHome = try ScriptedHome { request in
            request["verb"] as? String == "vault" ? ["result": ["key_id": "3fa2c91b", "locked": false, "recovery": "confirmed"]] : ["error": "no verb"]
        }
        defer { plainHome.stop() }
        let plainSocket = HomeSocket(path: plainHome.path, folder: plainHome.folder)
        let plainKeeper = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { plainSocket })
        let plain = NeedsModel(keeper: plainKeeper, recovery: RecoveryKey(keeper: plainKeeper))
        plain.door = {
            asked.append("plain door")
            return .locked
        }
        await plain.read()
        XCTAssertNil(plain.cover, "a plain home showed the keyed home's page")
        XCTAssertFalse(asked.values.contains("plain door"), "a plain home's read asked the door")
    }

    private actor DoorGate {
        private var opened = false
        private var waiters: [CheckedContinuation<Void, Never>] = []

        func wait() async {
            guard !opened else { return }
            await withCheckedContinuation { waiters.append($0) }
        }

        func open() {
            opened = true
            waiters.forEach { $0.resume() }
            waiters = []
        }
    }

    func testUnlockOnAHeldHomeWaitsSayingTheHoldNotOpening() async throws {
        let vault = Vault()
        vault.locked = true
        let held = Vault()
        held.locked = true
        let done = Collected<String>()
        let home = try keyedHome(vault, done, held: held)
        defer { home.stop() }
        let store = MemoryStore()
        store.data = Data(repeating: 7, count: 32)
        let socket = HomeSocket(path: home.path, folder: home.folder)
        let keeper = VaultKeeper(key: HomeKey(store: store, trust: KeychainTrust(build: ""), reader: .app, keyed: true), old: MemoryStore(), socket: { socket })
        let model = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        model.doorPace = .milliseconds(20)
        let hold = "Lifestream is checking its files: it opens when the check ends"
        model.restartDoor = { done.append("restart door") }
        model.door = {
            if held.locked { return .notNow(hold, retryAfter: 5, starting: false) }
            return done.values.contains("restart door") ? .serves : .locked
        }
        await model.read()
        let unlocked = try XCTUnwrap(model.unlock("MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAA"))
        _ = await unlocked.value
        try await until("the wait says the hold") { model.cover == .opening(need: hold) }
        XCTAssertEqual(LockedPage.face(model.cover, withKey: false), .opening(need: hold))
        XCTAssertEqual(done.values, ["recover"])

        held.locked = false
        try await until("the hold ended, the key was kept and the door serves") { !model.opening && model.cover == nil }
        XCTAssertEqual(done.values, ["recover", "vault-slot", "restart door"])
        XCTAssertEqual(LockedPage.face(.opening(need: nil), withKey: false), .opening(need: nil))
        XCTAssertEqual(LockedPage.openingWaits, "It goes on once Lifestream answers on this Mac.")
        XCTAssertEqual(DoorAnswer.notNow(hold, retryAfter: nil, starting: false).need, hold)
        XCTAssertNil(DoorAnswer.notNow("Lifestream is starting", retryAfter: nil, starting: true).need, "a start was said as a hold")
    }

    func testUnlockOnAHeldHomeWhoseSocketStopsOutlastsTheLimitSaysTheDoorsHoldAndTryAgainGoesOn() async throws {
        let vault = Vault()
        vault.locked = true
        let held = Vault()
        held.locked = true
        let done = Collected<String>()
        let checking = try keyedHome(vault, done, held: held)
        defer { checking.stop() }
        let sockets = Collected<HomeSocket>()
        sockets.append(HomeSocket(path: checking.path, folder: checking.folder))
        let store = MemoryStore()
        store.data = Data(repeating: 7, count: 32)
        let keeper = VaultKeeper(key: HomeKey(store: store, trust: KeychainTrust(build: ""), reader: .app, keyed: true), old: MemoryStore(), socket: { sockets.values.last })
        let model = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        model.doorPace = .milliseconds(20)
        model.keepWithin = 0.5
        let hold = "Lifestream is checking its files: it opens when the check ends"
        let up = Collected<String>()
        model.restartDoor = { done.append("restart door") }
        model.door = {
            if !up.values.isEmpty { return .serves }
            if held.locked { return .notNow(hold, retryAfter: 5, starting: false) }
            return done.values.contains("restart door") ? .serves : .locked
        }
        await model.read()
        _ = await model.unlock("MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIMZ XW6Y TBOI MZXW 6YTB OIAA")?.value
        try await until("this Mac asked the held home for its slot") { checking.requests.contains { $0["verb"] as? String == "vault-slot" } }
        checking.stop()
        let why = "\(hold). This Mac stopped waiting after a minute: press Try again once that ends."
        try await until("the wait ends at its limit and says the door's hold and Try again") { !model.opening && model.cover == .notKept(why) }
        XCTAssertEqual(LockedPage.face(model.cover, withKey: false), .notKept(why))
        await model.read()
        XCTAssertEqual(model.cover, .notKept(why), "a read the stopped socket did not answer put the Unlock page back")
        XCTAssertEqual(done.values, ["recover"], "the door was restarted while this Mac's key was not kept")
        XCTAssertEqual(NeedsModel.notOpened(held: nil, after: 300), "Lifestream didn't open on this Mac within 5 minutes. Press Try again once it runs.")

        held.locked = false
        let opened = try keyedHome(vault, done)
        defer { opened.stop() }
        sockets.append(HomeSocket(path: opened.path, folder: opened.folder))
        up.append("the home opened and its restarted door serves")
        try await until("the open home's door serves and the page still says this Mac's key was not kept") {
            await model.read()
            return model.doorSaid == .serves && model.cover == .notKept(NeedsModel.slotMissing)
        }
        XCTAssertEqual(done.values, ["recover"], "a slot was kept with no Try again")
        model.keepAgain()
        try await until("Try again kept the key and the door serves") { !model.opening && model.cover == nil }
        XCTAssertEqual(done.values, ["recover", "vault-slot", "restart door"])
    }

    func testADoorAnswerOlderThanTheLastHeardIsNeverTheDoorsLastAnswer() async throws {
        let vault = Vault()
        let done = Collected<String>()
        let home = try keyedHome(vault, done)
        defer { home.stop() }
        let store = MemoryStore()
        store.data = Data(repeating: 7, count: 32)
        let socket = HomeSocket(path: home.path, folder: home.folder)
        let keeper = VaultKeeper(key: HomeKey(store: store, trust: KeychainTrust(build: ""), reader: .app, keyed: true), old: MemoryStore(), socket: { socket })
        vault.kept(store.data)
        let model = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        model.doorPace = .milliseconds(20)
        let late = DoorGate()
        let quiet = DoorGate()
        let slow = Collected<String>()
        let asked = Collected<String>()
        model.restartDoor = { done.append("restart door") }
        model.door = {
            if done.values.contains("restart door") {
                if slow.values.contains("new door") {
                    asked.append("fresh")
                    await quiet.wait()
                }
                return .serves
            }
            if slow.values.contains("old door") {
                asked.append("asked")
                await late.wait()
                asked.append("answered")
            }
            return .locked
        }
        await model.read()
        try await until("the old door's LOCKED is said") { model.cover == .notKept(NeedsModel.doorKeyless) }
        slow.append("old door")
        await model.read()
        try await until("a probe of the old door is out") { asked.values.contains("asked") }
        model.keepAgain()
        try await until("Try again kept the key and the restarted door serves") { !model.opening && model.cover == nil }
        XCTAssertEqual(model.doorSaid, .serves)
        slow.append("new door")
        let out = asked.values.count
        await late.open()
        try await until("the old door answered every probe asked of it") { asked.values.filter { $0 == "answered" }.count == out }
        try await until("the probe out before the restart ended and a read asks the door again") {
            await model.read()
            return asked.values.contains("fresh")
        }
        XCTAssertEqual(model.doorSaid, .serves, "an answer the old door gave after the restarted one served was taken as the last")
        XCTAssertNil(model.cover, "a late answer of the old door put the page back")
        await quiet.open()
    }

    func testTheDoorsAddressReadsThePassEachTimeAndAsksTheReleaseOncePerFolder() {
        let first = URL(fileURLWithPath: "/tmp/home-a")
        let second = URL(fileURLWithPath: "/tmp/home-b")
        let pass = Collected<URL>()
        let pointed = Collected<URL>()
        let looks = Collected<URL>()
        let address = DoorAddress(named: { pass.values.last }, pointed: { pointed.values.last }, looked: { folder in
            looks.append(folder)
            return URL(string: "http://127.0.0.1:\(4680 + looks.values.count)")
        })
        XCTAssertNil(address.url(), "a Mac pointed at no folder was given a door")
        pointed.append(first)
        XCTAssertEqual(address.url(), URL(string: "http://127.0.0.1:4681"))
        XCTAssertEqual(address.url(), URL(string: "http://127.0.0.1:4681"))
        XCTAssertEqual(looks.values, [first], "the release was asked again for a folder it already said")
        let paired = URL(string: "http://macbook-pro-0001.example.ts.net:4680")!
        pass.append(paired)
        XCTAssertEqual(address.url(), paired, "a pass paired after the first read was not seen at once")
        let repaired = URL(string: "http://macbook-pro-0001.example.ts.net:4690")!
        pass.append(repaired)
        XCTAssertEqual(address.url(), repaired, "a re-pair's new name was not seen at once")
        XCTAssertEqual(looks.values, [first])
        let unpaired = DoorAddress(named: { nil }, pointed: { pointed.values.last }, looked: { folder in
            looks.append(folder)
            return URL(string: "http://127.0.0.1:4700")
        })
        _ = unpaired.url()
        pointed.append(second)
        XCTAssertEqual(unpaired.url(), URL(string: "http://127.0.0.1:4700"))
        XCTAssertEqual(looks.values, [first, first, second], "a newly pointed folder was not asked of the release")
    }

    func testTheRecoveryKeyNeedNamesWhatALostMacLosesAndARefusedKeyIsASentence() {
        let keyed = VaultState(answer: ["key_id": "3fa2c91b", "keyed": true, "locked": false, "recovery": "unconfirmed"])!
        let need = Needs.list(vault: keyed, keyMayOpen: true, update: nil, ready: nil, needs: [])
        XCTAssertEqual(need, [.saveRecoveryKey(keyed: true)])
        XCTAssertEqual(need.first?.detail, "Without it, a lost Mac loses everything in Lifestream")
        XCTAssertEqual(Need.saveRecoveryKey(keyed: false).detail, "Without it, a lost Mac loses your passwords")
        XCTAssertEqual(Needs.list(vault: state(recovery: "confirmed"), keyMayOpen: true, update: nil, ready: nil, needs: []), [],
                       "a home that answers its key saved was said not saved")
        XCTAssertEqual(NeedsModel.sentence("a recovery key is 52 letters A–Z and digits 2–7, in groups of four"),
                       "A recovery key is 52 letters A–Z and digits 2–7, in groups of four.")
        XCTAssertEqual(NeedsModel.sentence("Type the recovery key first."), "Type the recovery key first.")
    }

    func testTheNeedsStandWhileTheHomeIsSilentAndBeginNothingWhenItComesBack() async throws {
        let place = Place()
        let first = try ScriptedHome(answering(locked: true))
        place.path = first.path
        let store = MemoryStore()
        store.data = Data(repeating: 7, count: 32)
        let keeper = VaultKeeper(machine: store, old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { HomeSocket(path: place.path, folder: first.folder) })
        let model = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        let password = HomeReport.password("gmail-imap.password", connector: "gmail", member: "password",
                                           "Gmail refused its app password: make a new one and type it here", since: 1_760_342_400_000)

        model.noticed([password])
        await model.read()
        var opened = 0
        model.began = { _ in opened += 1 }
        let need = try XCTUnwrap(model.list.last)
        XCTAssertEqual(model.list.first, .allow)
        XCTAssertEqual(model.list.count, 2)
        model.type("abcd-efgh", for: need)

        first.stop()
        model.noticed([password])
        await model.read()
        XCTAssertEqual(model.list.count, 2, "the home going quiet emptied the needs")
        XCTAssertEqual(model.drafts[need.id], "abcd-efgh", "the home going quiet dropped what was typed")

        let again = try ScriptedHome(answering(locked: true))
        defer { again.stop() }
        place.path = again.path
        model.noticed([password])
        await model.read()
        XCTAssertEqual(model.list.count, 2)
        XCTAssertEqual(opened, 0, "the home coming back opened the window for a need that stood")
        XCTAssertEqual(model.drafts[need.id], "abcd-efgh")

        model.noticed([])
        await model.read()
        XCTAssertEqual(model.list, [.allow])
        XCTAssertEqual(model.drafts, [:])
    }

    func testASaveTheHomeAcceptedEmptiesTheFieldKnocksAndChecksUntilTheNeedEnds() async throws {
        let refusal = Words()
        let home = try ScriptedHome { request in
            switch request["verb"] as? String {
            case "vault": return ["result": ["key_id": "3fa2c91b", "locked": false, "recovery": "confirmed"]]
            case "seal":
                if let words = refusal.words { return ["error": words] }
                return ["result": ["sealed": request["secret"] ?? "", "key": "3fa2c91b"]]
            default: return ["error": "no verb is named \(request["verb"] ?? "")"]
            }
        }
        defer { home.stop() }
        let socket = HomeSocket(path: home.path, folder: home.folder)
        let keeper = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { socket })
        let model = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        var knocks = 0
        model.knock = { knocks += 1 }
        let password = HomeReport.password("gmail-imap.password", connector: "gmail", member: "password",
                                           "Gmail refused its app password: make a new one and type it here", since: 1_760_342_400_000)
        model.noticed([password])
        await model.read()
        let need = try XCTUnwrap(model.list.first)
        func seals() -> [[String: Any]] { home.requests.filter { $0["verb"] as? String == "seal" } }

        refusal.words = "Passwords are locked on this Mac: the home holds no vault key to seal gmail-imap.password with"
        model.type("abcd-efgh-ijkl-mnop", for: need)
        model.save(need, secret: "gmail-imap.password")
        while model.working.contains(need.id) { await Task.yield() }
        XCTAssertEqual(model.refusals[need.id], refusal.words)
        XCTAssertFalse(model.saved.contains(need.id))
        XCTAssertEqual(knocks, 0, "a refused Save knocked")
        XCTAssertEqual(model.drafts[need.id], "abcd-efgh-ijkl-mnop", "a refused Save emptied the field")

        refusal.words = nil
        model.save(need, secret: "gmail-imap.password")
        XCTAssertTrue(model.working.contains(need.id), "the Save is not in flight at once")
        model.save(need, secret: "gmail-imap.password")
        while model.working.contains(need.id) || knocks == 0 { await Task.yield() }
        XCTAssertEqual(seals().count, 2, "a second press while saving sent a second seal")
        XCTAssertEqual(seals().last?["value"] as? String, "abcd-efgh-ijkl-mnop")
        XCTAssertEqual(seals().last?["secret"] as? String, "gmail-imap.password", "sealed as another secret than its member's")
        XCTAssertNil(model.refusals[need.id])
        XCTAssertEqual(knocks, 1, "an accepted Save did not knock for a fresh answer")
        XCTAssertNil(model.drafts[need.id], "the field still holds the password the home accepted")
        XCTAssertTrue(model.saved.contains(need.id), "an accepted Save said nothing")
        XCTAssertEqual(PasswordSheet.saved, "Saved. Checking…")
        model.noticed([password])
        await model.read()
        XCTAssertEqual(model.list, [need])
        XCTAssertTrue(model.saved.contains(need.id))
        model.type("typed-again", for: need)
        model.forget()
        XCTAssertEqual(model.drafts, [:])
        XCTAssertTrue(model.saved.contains(need.id))
        model.noticed([])
        await model.read()
        XCTAssertEqual(model.list, [])
        XCTAssertEqual(model.saved, [])
    }

    func testAnAllowUnlockOrSaveTheHomeDidNotHearOrThisMacFailedSaysAPlainSentence() async throws {
        let alone = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { nil })
        let model = NeedsModel(keeper: alone, recovery: RecoveryKey(keeper: alone))
        let silent = ReachWords.notSent
        model.allow()
        try await until("the allow is refused") { model.refusals[Need.allow.id] != nil }
        XCTAssertEqual(model.refusals[Need.allow.id], silent)
        model.unlock("MZXW 6YTB")
        try await until("the unlock is refused") { model.refusals[Need.unlock.id] != nil }
        XCTAssertEqual(model.refusals[Need.unlock.id], silent)
        let asked = HomeReport.password("x.password", connector: "x", member: "password", "X")
        let need = Need.password(asked, set: asked.acts[0])
        model.type("fake-password", for: need)
        model.save(need, secret: "x.password")
        try await until("the save is refused") { model.refusals[need.id] != nil }
        XCTAssertEqual(model.refusals[need.id], silent)

        let home = try ScriptedHome(answering(locked: true))
        defer { home.stop() }
        let socket = HomeSocket(path: home.path, folder: home.folder)
        let store = MemoryStore()
        store.data = Data(repeating: 7, count: 32)
        store.refusal = .keychain(-25293)
        let keeper = VaultKeeper(machine: store, old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { socket })
        let here = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        here.allow()
        try await until("the allow is refused") { here.refusals[Need.allow.id] != nil }
        XCTAssertEqual(here.refusals[Need.allow.id], "Lifestream couldn't open your passwords on this Mac. Try again.")
        here.unlock("MZXW 6YTB")
        try await until("the unlock is refused") { here.refusals[Need.unlock.id] != nil }
        XCTAssertEqual(here.refusals[Need.unlock.id], "Lifestream couldn't unlock your passwords on this Mac. Try again.")
    }

    func testTheUnlockSheetNamesTheKeysThatOpenThePasswordsNewestFirst() throws {
        let day17 = 1_794_916_800_000, day3 = 1_793_707_200_000
        func vault(_ slots: [[String: Any]]) -> VaultState {
            VaultState(answer: ["key_id": "3fa2c91b", "locked": true, "recovery": "confirmed", "slots": slots])!
        }
        let machine: [String: Any] = ["id": "m-1", "kind": "machine", "unit": "macbook-air-bb17", "made_ms": day3]
        let two: [String: Any] = ["id": "r-2", "kind": "recovery", "made_ms": day3, "confirmed_ms": day3 + 1]
        let three: [String: Any] = ["id": "r-3", "kind": "recovery", "made_ms": day17]
        XCTAssertEqual(KeyName.opensWith(vault([machine, two])), "Your passwords open with recovery key 2, made on 3 November 2026.")
        XCTAssertEqual(KeyName.opensWith(vault([two, machine, three])),
                       "Your passwords open with recovery key 3, made on 17 November 2026, or recovery key 2, made on 3 November 2026.")
        XCTAssertNil(KeyName.opensWith(vault([machine])))
        XCTAssertNil(KeyName.opensWith(nil))
    }

    func testTheNeedSheetsAreDrawn() async throws {
        let keeper = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { nil })
        let model = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        let size = CGSize(width: 480, height: 280)
        try await Shots.draw("sheet-need-allow", size: size) { VaultAllowSheet(needs: model) }
        try await Shots.draw("sheet-need-recovery-key", size: size) { RecoveryKeySheet(needs: model) }
        let asked = HomeReport.password("x.password", connector: "x", member: "password", "X wants your password to make your export")
        try await Shots.draw("sheet-need-password", size: size) { PasswordSheet(needs: model, need: .password(asked, set: asked.acts[0]), secret: "x.password") }
        model.unlock(" ")
        try await until("the blank key is refused") { model.refusals[Need.unlock.id] != nil }
        try await Shots.draw("sheet-need-recovery-key-refused", size: size) { RecoveryKeySheet(needs: model) }
        let page = CGSize(width: 720, height: 420)
        try await Shots.draw("locked-page-key", size: page) { LockedPage(needs: model) }
    }

    private func answering(locked: Bool) -> ([String: Any]) -> [String: Any] {
        { request in
            request["verb"] as? String == "vault"
                ? ["result": ["key_id": "3fa2c91b", "locked": locked, "recovery": "confirmed"]]
                : ["error": "no verb is named \(request["verb"] ?? "")"]
        }
    }
    func testTheMacsOwnFilesAreANeedWhenRefusedAndPairAgainOnlyWhereNoSetUpPairsIt() {
        let refused = Needs.list(vault: state(locked: true), keyMayOpen: true, update: nil, ready: nil, needs: [], files: .refused)
        XCTAssertEqual(refused, [.filesRefused, .allow], "the Mac's own files are not the first need")
        XCTAssertEqual("\(Need.filesRefused.line). \(Need.filesRefused.detail ?? "")", MacProcess.refusedWords)
        XCTAssertEqual(Need.filesRefused.line, "Lifestream can't open what this Mac records")
        XCTAssertEqual(NeedStrip.primary(.filesRefused)?.label, "Allow")
        XCTAssertNil(Need.filesRefused.page)
        XCTAssertFalse(Need.filesRefused.home)
        XCTAssertFalse(Need.filesRefused.locks, "the Mac's files took the vault's locked window")
        XCTAssertNotEqual(Need.filesRefused.key, Need.allow.key)
        let gone = Needs.list(vault: state(), keyMayOpen: true, update: nil, ready: nil, needs: [], files: .pairAgain)
        XCTAssertEqual(gone, [.pairAgain])
        XCTAssertEqual(gone.first?.line, "Pair this Mac again")
        XCTAssertEqual(gone.first?.detail,
                       "Make a pairing code in Lifestream, then type in Terminal: lifestream home --name <Lifestream's address> --code <the code>")
        XCTAssertEqual(gone.first?.acts.map(\.label), [])
        XCTAssertEqual(MacFilesNeed.of(.refused("errSecAuthFailed"), keyed: true, homeHere: true, paired: true), .refused)
        XCTAssertEqual(MacFilesNeed.of(.startedAgain, keyed: true, homeHere: false, paired: false), .pairAgain)
        XCTAssertEqual(MacFilesNeed.of(.open, keyed: true, homeHere: false, paired: false), .pairAgain,
                       "the need was gone at the next launch while the Mac still had no pass")
        XCTAssertNil(MacFilesNeed.of(.startedAgain, keyed: true, homeHere: true, paired: false), "set up pairs the Mac that hosts its home again")
        XCTAssertNil(MacFilesNeed.of(.open, keyed: true, homeHere: false, paired: true), "the need stood once the Mac was paired again")
        XCTAssertNil(MacFilesNeed.of(.open, keyed: false, homeHere: false, paired: false), "a plain Mac not yet paired was asked to pair again")
        XCTAssertEqual(Need.macFilesKeys, [Need.filesRefused.key, Need.pairAgain.key])
    }

    func testARefusedKeyIsANeedUntilAllowOpensTheMacsFilesAndADenyLeavesItSaid() async throws {
        let fixture = try MacFilesFixture()
        defer { fixture.remove() }
        try fixture.keyed()
        let process = fixture.process(.app)
        guard case .refused = process.opened else { return XCTFail("an untrusted build opened a keyed Mac") }
        let keeper = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { nil })
        let model = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        model.macFiles = { MacFilesNeed.of(process.opened, keyed: true, homeHere: false, paired: true) }
        model.openFiles = {
            if case .refused(let why) = process.allow() { return NeedsModel.sentence(why) }
            return nil
        }
        await model.read()
        XCTAssertEqual(model.list, [.filesRefused])
        fixture.store.refusal = .keychain(errSecAuthFailed)
        guard let deny = model.allowFiles() else { return XCTFail("Allow was running already") }
        let denied = await deny.value
        XCTAssertNotNil(denied, "a Deny said nothing")
        XCTAssertEqual(model.list, [.filesRefused], "a Deny took the need away")
        XCTAssertNil(process.files)
        XCTAssertEqual(fixture.watcher.made, [])
        fixture.store.refusal = nil
        guard let allow = model.allowFiles() else { return XCTFail("Allow was running already") }
        let allowed = await allow.value
        XCTAssertNil(allowed)
        XCTAssertEqual(model.list, [], "the need stood once the key read")
        XCTAssertNotNil(process.files)
        XCTAssertEqual(fixture.watcher.made, ["start"], "Allow did not start the watcher again")
        XCTAssertNil(model.refusals[Need.filesRefused.id])
    }

    func testAGoneKeyAsksToPairAMacRecordingElsewhereAgainUntilItIsAndSaysSoOnce() async throws {
        let fixture = try MacFilesFixture()
        defer { fixture.remove() }
        try fixture.keyed()
        _ = try fixture.keys.macFiles.read()
        fixture.store.data = nil
        let process = fixture.process(.app)
        XCTAssertEqual(process.opened, .startedAgain)
        let paired = Flag()
        let keeper = VaultKeeper(machine: MemoryStore(), old: MemoryStore(), trust: KeychainTrust(build: ""), socket: { nil })
        let model = NeedsModel(keeper: keeper, recovery: RecoveryKey(keeper: keeper))
        model.macFiles = { MacFilesNeed.of(process.opened, keyed: (try? process.macFiles.keyID()) != nil, homeHere: false, paired: paired.on) }
        await model.read()
        XCTAssertEqual(model.list, [.pairAgain])
        paired.on = true
        await model.read()
        XCTAssertEqual(model.list, [], "Pair this Mac again stood after it was paired")
        var posted: [UNNotificationRequest] = []
        await NeedNotification.startedAgain(ask: { false }, post: { posted.append($0) })
        XCTAssertEqual(posted.count, 0, "posted without permission")
        await NeedNotification.startedAgain(ask: { true }, post: { posted.append($0) })
        XCTAssertEqual(posted.map(\.identifier), [NeedNotification.startedAgainID])
        XCTAssertEqual(posted.first?.content.body,
                       "Lifestream couldn't open what this Mac recorded and hadn't sent yet, so it started again. Lifestream keeps everything it already received.")
    }
}

private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var on: Bool {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}

struct MacFilesFixture {
    let root: URL
    let machine: URL
    let spool: URL
    let store = MemoryStore()
    let suite = "needs-mac-files-\(UUID().uuidString)"
    let defaults: UserDefaults
    let watcher = MacFilesTests.WatcherCalls()

    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("needs-mac-files-\(UUID().uuidString)", isDirectory: true)
        machine = root.appendingPathComponent("machine", isDirectory: true)
        spool = root.appendingPathComponent("spool", isDirectory: true)
        try FileManager.default.createDirectory(at: machine, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: spool, withIntermediateDirectories: true)
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    }

    var keys: HomeKeys { HomeKeys(reader: .app, machine: machine, build: "build-7", defaults: defaults, files: store) }

    func keyed() throws {
        let key = Data(repeating: 7, count: 32)
        store.data = key
        try Data(#"{"form":"keyed","key":"\#(VaultKeyID.of(key))"}"#.utf8).write(to: machine.appendingPathComponent(MacFiles.fileName))
    }

    func process(_ name: SealWork.Process) -> MacProcess {
        let watcher = watcher
        return MacProcess.opened(name, spool: spool, machine: machine, ship: machine.appendingPathComponent("ship", isDirectory: true),
                                 keys: keys, watcher: MacFiles.Watcher(stop: { watcher.add("stop") }, start: { watcher.add("start") }))
    }

    func remove() {
        try? FileManager.default.removeItem(at: root)
        defaults.removePersistentDomain(forName: suite)
    }
}

private final class Place: @unchecked Sendable {
    private let lock = NSLock()
    private var _path = ""
    var path: String {
        get { lock.withLock { _path } }
        set { lock.withLock { _path = newValue } }
    }
}

private final class Words: @unchecked Sendable {
    private let lock = NSLock()
    private var _words: String?
    var words: String? {
        get { lock.withLock { _words } }
        set { lock.withLock { _words = newValue } }
    }
}

private final class Unanswered: KeyStore, @unchecked Sendable {
    func read(prompting: Bool) throws -> Data? { throw KeyStoreError.keychain(-25308) }
    func held() throws -> Bool { true }
    func keyID() throws -> String? { throw KeyStoreError.keychain(-25308) }
    func mark(keyID: String) throws {}
    func add(_ data: Data) throws {}
    func delete() throws {}
}

private final class Vault: @unchecked Sendable {
    private let lock = NSLock()
    private var _locked = false
    private var _machines: [String] = []
    var locked: Bool {
        get { lock.withLock { _locked } }
        set { lock.withLock { _locked = newValue } }
    }
    var machines: [String] { lock.withLock { _machines } }

    func keep(_ request: [String: Any]) -> String {
        let slot = "m-\(VaultKeyID.of(Data(base64Encoded: request["slot_key"] as? String ?? "") ?? Data()))"
        lock.withLock { _machines = _machines.filter { $0 != slot } + [slot] }
        return slot
    }

    func kept(_ key: Data?) {
        let slot = "m-\(VaultKeyID.of(key ?? Data()))"
        lock.withLock { _machines.append(slot) }
    }

    func slots(_ more: [[String: Any]] = []) -> [[String: Any]] {
        more + machines.map { ["id": $0, "kind": "machine", "unit": "macbook-pro-0001", "made_ms": 1_794_916_800_000] }
    }
}
