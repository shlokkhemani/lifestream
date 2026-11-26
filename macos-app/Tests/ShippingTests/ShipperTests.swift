import Evidence
import DeviceFiles
import HomeLink
import XCTest
@testable import Shipping

final class ShipperTests: XCTestCase {
    private var root: URL!
    private var state: ShippingState!
    private var clock: FixedClock!
    private var home: FakeHome!
    private var link: HomeLink!
    private var rows: Collected<ShipperRunRow>!
    private var built: Collected<[String]>!
    private var rotations: Collected<String>!

    private static let now = ShippingFixture.instant("2026-09-22T23:00:00.000Z")
    private static let machineBundle = "machine:local:unit-0001/20260922T230000.000Z"

    override func setUp() async throws {
        root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("shipper-tests-\(UUID().uuidString)")
        state = ShippingState(root: root, files: DeviceFiles(.plain))
        clock = FixedClock(Self.now)
        home = FakeHome(sources: [ShippingFixture.machineSource, ShippingFixture.messagesSource, ShippingFixture.inputSource],
                        clock: clock.read)
        link = try await ShippingFixture.link(home, folder: root)
        rows = Collected()
        built = Collected()
        rotations = Collected()
        try state.prepare()
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }


    private func makeShipper(_ domains: [FakeDomain], refresh: TimeInterval = MacSettings.readerRefresh,
                             settings given: MacSettings? = nil,
                             link: HomeLink? = nil, clock: FixedClock? = nil, fullDiskAccess: Bool = true,
                             grants: (@Sendable () -> [String: String]?)? = nil,
                             found: (@Sendable () -> [String]?)? = nil,
                             stores: DeclaredStores? = nil) -> Shipper {
        let built = self.built!, rows = self.rows!, rotations = self.rotations!
        let words = MacSettings.JSON.string(MacSettings.words(refresh))
        let settings = given ?? MacSettings(file: DomainFixtures.settingsFile, defaults: ["machine": ["refresh": words], "imessage": ["refresh": words],
                                                                  "input": ["refresh": words]], files: DeviceFiles(.plain))
        return Shipper(Shipper.Dependencies(
            state: state, link: link ?? self.link, settings: settings,
            domains: { sources in
                built.append(sources)
                return domains.filter { sources.contains($0.sourceId) }
            },
            offers: { unit in unit.isEmpty ? [] : ["chrome:default:\(unit)"] },
            clock: (clock ?? self.clock).read,
            record: { rows.append($0) },
            rotateBatches: { rotations.append("rotate") },
            fullDiskAccess: { fullDiskAccess },
            grants: grants ?? { nil },
            found: found ?? { nil },
            stores: stores,
            scratch: FileManager.default.temporaryDirectory.appendingPathComponent("scratch-\(UUID().uuidString)", isDirectory: true)))
    }

    private func machineDomain(_ seals: [FakeDomain.Seal], gate: (@Sendable () -> Void)? = nil) -> FakeDomain {
        FakeDomain(sourceId: ShippingFixture.machineSource, name: "machine_events", seals: seals, holdingSealAt: gate)
    }

    private func messagesDomain(_ seals: [FakeDomain.Seal]) -> FakeDomain {
        FakeDomain(sourceId: ShippingFixture.messagesSource, name: "imessage", seals: seals)
    }

    private func pairedLongAgo() throws {
        var schedule = ShippingSchedule()
        schedule.pass = ShippingFixture.pass
        schedule.pairedAt = Self.now.addingTimeInterval(-Shipper.youngFor)
        try state.writeSchedule(schedule)
    }

    private func grownUp(_ sources: [String]) throws {
        var schedule = ShippingSchedule()
        schedule.pass = ShippingFixture.pass
        schedule.pairedAt = Self.now.addingTimeInterval(-Shipper.youngFor)
        for source in sources { schedule.domains[source] = DomainSchedule(firstSealedAt: Self.now.addingTimeInterval(-Shipper.youngFor)) }
        try state.writeSchedule(schedule)
    }

    private func names(_ directory: URL) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
    }

    private var methods: [String] { home.requests.map { $0.method + " " + $0.url.path } }


    func testAnAcceptedBundleStatesTheNextSealAndIsSpent() async throws {
        let domain = machineDomain([.sealed(), .sealed()])
        let shipper = makeShipper([domain], refresh: 60)

        let report = await shipper.run(.timer)

        XCTAssertEqual(report.outcome, "shipped")
        XCTAssertEqual(rows.all, [ShipperRunRow(outcome: "shipped", domain: "machine_events", source: ShippingFixture.machineSource,
                                                bundle: Self.machineBundle, seal: 1)])
        XCTAssertEqual(methods, ["POST /v1/exchange", "PUT /v1/acquisitions/\(Self.machineBundle)"])
        XCTAssertTrue(home.requests.allSatisfy { $0.headers["Lifestream-Device"] == "mac/0.2.0" })
        XCTAssertEqual(home.custody(ShippingFixture.machineSource).received, 1)
        XCTAssertEqual(domain.requests.first?.custody, SealCustody(pass: ShippingFixture.pass, received: 0, imported: 0))
        XCTAssertEqual(try names(state.pendingDirectory), [], "the bundle went with the delivery")
        XCTAssertEqual(try names(state.workDirectory), [])
        XCTAssertEqual(domain.answers.last?.sources[ShippingFixture.machineSource]?.received, 1,
                       "the domain saw the answer the delivery brought")

        clock.move(by: 60)
        _ = await shipper.run(.timer)
        XCTAssertEqual(domain.requests.last?.custody.seal, 2, "the next bundle states the next seal")
        XCTAssertEqual(home.custody(ShippingFixture.machineSource).received, 2)
    }

    func testTheExchangeOffersWhatThisMacFindsForItsUnit() async throws {
        try FileManager.default.removeItem(at: root.appendingPathComponent("answer.json"))
        let shipper = makeShipper([machineDomain([.nothingNew])])
        _ = await shipper.run(.timer)
        _ = await shipper.run(.manual)
        let offers = try home.requests.filter { $0.url.path == "/v1/exchange" }.map { request -> [String] in
            guard case .json(let body) = request.body else { return [] }
            return try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])["offers"] as? [String] ?? []
        }
        XCTAssertEqual(offers, [[], ["chrome:default:unit-0001"]], "the unit is known once the home has answered")
    }

    func testTheExchangeCarriesWhatThisMacAllowsAndOnlyAChangeIsAnExchangeOfItsOwn() async throws {
        let allowed = Collected<[String: String]>()
        allowed.append(["fullDiskAccess": "not-asked", "screenRecording": "on"])
        let shipper = makeShipper([machineDomain([.nothingNew])], refresh: 60, grants: { allowed.all.last })
        func exchanged() throws -> [[String: String]?] {
            try home.requests.filter { $0.url.path == "/v1/exchange" }.map { request in
                guard case .json(let body) = request.body else { return nil }
                return try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])["grants"] as? [String: String]
            }
        }
        _ = await shipper.run(.timer)
        await fulfillment(of: [home.exchanged(2)], timeout: 30)
        XCTAssertEqual(try exchanged(), [allowed.all[0], allowed.all[0]], "told first, its own exchange behind the call, and the run's carries it")
        home.forgetRequests()
        clock.move(by: 60)
        _ = await shipper.run(.timer)
        XCTAssertEqual(try exchanged(), [allowed.all[0]], "unchanged: the run's exchange alone")
        home.forgetRequests()
        allowed.append(["fullDiskAccess": "on", "screenRecording": "on"])
        clock.move(by: 60)
        _ = await shipper.run(.timer)
        await fulfillment(of: [home.exchanged(2)], timeout: 30)
        XCTAssertEqual(try exchanged(), [allowed.all[1], allowed.all[1]])
    }

    func testTheExchangeStatesWhatThisMacFindsWithItsGrants() async throws {
        let held = Collected<[String]>()
        held.append(["whatsapp", "imessage"])
        let shipper = makeShipper([machineDomain([.nothingNew])], refresh: 60, grants: { ["fullDiskAccess": "on"] }, found: { held.all.last })
        func stated() throws -> [[String]?] {
            try home.requests.filter { $0.url.path == "/v1/exchange" }.map { request in
                guard case .json(let body) = request.body else { return nil }
                let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
                XCTAssertNotNil(object["grants"], "the grants with them")
                return object["found"] as? [String]
            }
        }
        _ = await shipper.run(.timer)
        await fulfillment(of: [home.exchanged(2)], timeout: 30)
        XCTAssertEqual(try stated(), [["imessage", "whatsapp"], ["imessage", "whatsapp"]], "stated sorted, by every exchange")
        home.forgetRequests()
        held.append(["imessage"])
        clock.move(by: 60)
        _ = await shipper.run(.timer)
        XCTAssertEqual(try stated(), [["imessage"]], "a change rides the run's exchange alone")
    }

    func testTheFirstExchangeBeforeAnyRunStatesWhatThisMacFinds() async throws {
        _ = makeShipper([machineDomain([.nothingNew])], found: { ["imessage", "apple-notes"] })
        link.tell(grants: ["fullDiskAccess": "not-asked"])
        await fulfillment(of: [home.exchanged(1)], timeout: 30)
        let request = try XCTUnwrap(home.requests.first { $0.url.path == "/v1/exchange" })
        guard case .json(let body) = request.body else { return XCTFail("the exchange carries JSON") }
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(object["found"] as? [String], ["apple-notes", "imessage"], "the grants' exchange carries what this Mac finds")
    }

    func testNothingNewWritesARowAndShipsNoBytes() async throws {
        let domain = machineDomain([.nothingNew])
        let report = await makeShipper([domain]).run(.timer)

        XCTAssertEqual(report.outcome, "nothing_new")
        XCTAssertEqual(rows.all, [ShipperRunRow(outcome: "nothing_new", domain: "machine_events", source: ShippingFixture.machineSource)])
        XCTAssertEqual(methods, ["POST /v1/exchange"])
        XCTAssertEqual(state.readSchedule().domains[ShippingFixture.machineSource]?.actedAt, Self.now)
    }


    func testASilentHomeSealsNothing() async throws {
        home.silence()
        let domain = machineDomain([.sealed()])
        let report = await makeShipper([domain]).run(.timer)

        XCTAssertEqual(report.outcome, "unreachable")
        XCTAssertEqual(rows.all, [ShipperRunRow(outcome: "unreachable")])
        XCTAssertEqual(domain.seals, 0, "nothing is sealed for a home that is not answering")
        XCTAssertNil(state.readSchedule().domains[ShippingFixture.machineSource])
    }

    func testAStateFolderThatCannotBeWrittenRefusesTheRunAsLocalStorageAndStatesTheWholeSendFailing() async throws {
        let blocked = root.appendingPathComponent("a-file-where-the-folder-goes")
        try Data().write(to: blocked)
        state = ShippingState(root: blocked, files: DeviceFiles(.plain))
        let domain = machineDomain([.sealed()])
        let shipper = makeShipper([domain])

        let report = await shipper.run(.timer)
        XCTAssertEqual(report.rows.map(\.summary), ["refused LOCAL_STORAGE"])
        XCTAssertEqual(home.requests.filter { $0.url.path == "/v1/exchange" }.count, 0, "nothing is asked of the home")
        XCTAssertEqual(domain.seals, 0, "nothing is sealed")

        _ = await shipper.knock()
        let send = try XCTUnwrap(home.sendings.last?["send"] as? [String: Any], "the next exchange states the whole send failing")
        XCTAssertEqual(send["code"] as? String, "LOCAL_STORAGE")
    }

    func testAHomeThatStopsAnsweringEndsTheRunWhereItIsAndNoDomainSealsAfter() async throws {
        let messages = ShippingFixture.messagesSource
        home.refuse(messages, (503, "NOT_NOW"))
        let messagesDomain = messagesDomain([.sealed(), .nothingNew])
        let machineDomain = machineDomain([.sealed(), .nothingNew])
        let shipper = makeShipper([messagesDomain, machineDomain], refresh: 60)

        let sealing = await shipper.run(.timer)
        XCTAssertEqual(sealing.rows.map(\.outcome), ["unreachable"])
        XCTAssertEqual([messagesDomain.seals, machineDomain.seals], [1, 0], "a bundle it sealed met the silent home: no domain after it seals")

        clock.move(by: Shipper.retryInterval)
        let pending = await shipper.run(.timer)
        XCTAssertEqual(pending.rows.map(\.outcome), ["unreachable"])
        XCTAssertEqual(pending.rows.first?.seal, 1, "the pending bundle met the silent home")
        XCTAssertEqual([messagesDomain.seals, machineDomain.seals], [1, 0], "a pending bundle met the silent home: no domain seals")

        home.refuse(messages, nil)
        clock.move(by: Shipper.retryInterval)
        _ = await shipper.run(.timer)
        XCTAssertEqual(home.custody(messages).received, 1)
        XCTAssertEqual(home.custody(ShippingFixture.machineSource).received, 1)
    }

    func testABundleIsJudgedOnTheNetworkItIsSentOn() async throws {
        let network = FakeNetwork()
        let away = try await away(network)
        let domain = FakeDomain(sourceId: ShippingFixture.messagesSource, name: "imessage", seals: [.sealedLater, .nothingNew],
                                holdingSealAt: { network.path = .costly })

        let report = await makeShipper([domain], link: away).run(.timer)
        XCTAssertTrue(report.rows.contains { $0.summary == "held past" }, "the past sealed on Wi-Fi waits once the network costs, and says why")
        XCTAssertEqual(report.waitsFor, .past)
        XCTAssertEqual(home.deliveries.map(\.seal), [], "nothing crossed the network that costs")
    }

    func testAPassTheHomeDoesNotKnowIsARefusalAndSealsNothing() async throws {
        let credentials = MemoryCredentials()
        _ = try await ShippingFixture.link(FakeHome(sources: [], clock: clock.read),
                                           folder: root.appendingPathComponent("elsewhere"), credentials: credentials)
        let stranger = HomeLink(device: link.device, credentials: credentials, folder: root, transport: home, files: DeviceFiles(.plain))
        let domain = machineDomain([.sealed()])
        let report = await makeShipper([domain], link: stranger).run(.timer)

        XCTAssertEqual(report.outcome, "refused PRINCIPAL_UNKNOWN")
        XCTAssertEqual(domain.seals, 0)
    }

    func testAnUnpairedMacWritesOneRowAndAsksNothing() async throws {
        let unpaired = HomeLink(device: link.device, credentials: MemoryCredentials(), folder: root, transport: home, files: DeviceFiles(.plain))
        let domain = machineDomain([.sealed()])
        let report = await makeShipper([domain], link: unpaired).run(.timer)

        XCTAssertEqual(report.outcome, "no_home")
        XCTAssertEqual(rows.all, [ShipperRunRow(outcome: "no_home")])
        XCTAssertEqual(home.requests, [])
        XCTAssertEqual(domain.seals, 0)
    }


    func testARefusedBundleWaitsWithItsSourceAnHourThenItsSourceSealsAgain() async throws {
        let machine = ShippingFixture.machineSource
        home.refuse(machine, (422, "ACQUISITION_MANIFEST"))
        let domain = machineDomain([.sealed(), .sealed(), .nothingNew])
        let shipper = makeShipper([domain], refresh: 60)

        let first = await shipper.run(.timer)
        XCTAssertEqual(first.outcome, "refused ACQUISITION_MANIFEST")
        let parked = try XCTUnwrap(state.pendingBundles().first)
        XCTAssertEqual(parked.sidecar.seal, 1)
        XCTAssertEqual(parked.sidecar.refused, BundleSidecar.Refusal(code: "ACQUISITION_MANIFEST", at: Self.now))

        home.refuse(machine, nil)
        for _ in 0..<3 {
            clock.move(by: Shipper.retryInterval)
            home.forgetRequests()
            rows.clear()
            _ = await shipper.run(.timer)
            XCTAssertEqual(methods, ["POST /v1/exchange"], "the refused bytes are never sent again as they are")
            XCTAssertEqual(rows.all, [], "the wait writes no row")
        }
        XCTAssertEqual(domain.seals, 1, "nothing is sealed behind it")
        XCTAssertEqual(state.readSchedule().sending?.sources[machine]?.code, "ACQUISITION_MANIFEST", "the source says the door's code")
        XCTAssertEqual(state.readSchedule().sending?.sources[machine]?.sinceMs, Int64(Self.now.timeIntervalSince1970 * 1000))

        clock.move(to: Self.now.addingTimeInterval(Shipper.refusedInterval))
        rows.clear()
        _ = await shipper.run(.timer)
        XCTAssertEqual(rows.all.map(\.summary), ["shipped"])
        XCTAssertEqual(domain.requests.map(\.custody.seal), [1, 1])
        XCTAssertEqual(home.custody(machine).received, 1)
        XCTAssertEqual(try state.pendingBundles(), [])
        XCTAssertNil(state.readSchedule().sending?.sources[machine], "once it ships it is no longer stated")
    }

    func testA413WaitsTooAndSyncNowSealsItAgainWithinTheHour() async throws {
        let messages = ShippingFixture.messagesSource
        home.refuse(messages, (413, "ACQUISITION_TOO_LARGE"))
        let domain = messagesDomain([.sealed(), .sealed(), .nothingNew])
        let shipper = makeShipper([domain], refresh: 60)

        let first = await shipper.run(.timer)
        XCTAssertEqual(first.outcome, "refused ACQUISITION_TOO_LARGE")
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.refused?.code), ["ACQUISITION_TOO_LARGE"])
        clock.move(by: 120)
        _ = await shipper.run(.timer)
        XCTAssertEqual(domain.seals, 1)

        home.refuse(messages, nil)
        clock.move(by: 120)
        rows.clear()
        _ = await shipper.run(.manual)
        XCTAssertEqual(rows.all.map(\.summary), ["shipped"], "Sync now lets it go at once")
        XCTAssertEqual(domain.requests.map(\.custody.seal), [1, 1])
        XCTAssertEqual(home.custody(messages).received, 1)
        XCTAssertEqual(try state.pendingBundles(), [])
    }

    func testARefusedHeadsTailWaitsBehindItUnsentAndIsSpentWithIt() async throws {
        let gate = home
        let refusedOnce = Collected<Bool>()
        let domain = FakeDomain(sourceId: ShippingFixture.messagesSource, name: "imessage",
                                seals: [.sealedWithPage, .sealed(), .nothingNew], holdingSealAt: {
            if refusedOnce.count == 0 { gate?.answerNext(422) }
            refusedOnce.append(true)
        })
        let shipper = makeShipper([domain], refresh: 60)

        let first = await shipper.run(.timer)
        XCTAssertEqual(first.outcome, "refused HTTP_422")
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.seal), [1, 2])
        XCTAssertEqual(try state.pendingBundles().map { $0.sidecar.refused != nil }, [true, false])

        clock.move(by: Shipper.retryInterval)
        home.forgetRequests()
        _ = await shipper.run(.timer)
        XCTAssertEqual(methods, ["POST /v1/exchange"], "the page never goes ahead of its refused head")
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.seal), [1, 2])

        clock.move(to: Self.now.addingTimeInterval(Shipper.refusedInterval))
        rows.clear()
        _ = await shipper.run(.timer)
        XCTAssertEqual(rows.all.map(\.summary), ["shipped"])
        XCTAssertEqual(domain.requests.map(\.custody.seal), [1, 1], "sealed again from received, its new data first")
        XCTAssertEqual(home.deliveries.map(\.seal), [1])
        XCTAssertEqual(try state.pendingBundles(), [], "the tail was spent with its head")
    }

    func testANewPassSpendsARefusedBundle() async throws {
        home.refuse(ShippingFixture.machineSource, (422, "ACQUISITION_MANIFEST"))
        _ = await makeShipper([machineDomain([.sealed()])]).run(.timer)
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.refused?.code), ["ACQUISITION_MANIFEST"])
        home.refuse(ShippingFixture.machineSource, nil)

        _ = try await link.pair(code: FakeHome.code, name: ShippingFixture.name)
        clock.move(by: 300)
        rows.clear()
        let domain = machineDomain([.sealed()])
        _ = await makeShipper([domain]).run(.timer)
        XCTAssertEqual(rows.all.map(\.summary), ["shipped"], "the old pass's bundle was never sent")
        XCTAssertEqual(domain.requests.first?.custody, SealCustody(pass: "p-00000002", received: 0, imported: 0))
        XCTAssertEqual(try state.pendingBundles(), [])
    }

    func testARefusalSavedBeforeACrashIsStatedFromItsSidecarWhileItWaits() async throws {
        let machine = ShippingFixture.machineSource
        home.refuse(machine, (422, "ACQUISITION_MANIFEST"))
        let domain = machineDomain([.sealed(), .nothingNew])
        _ = await makeShipper([domain], refresh: 60).run(.timer)
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.refused?.code), ["ACQUISITION_MANIFEST"])
        var schedule = state.readSchedule()
        schedule.sending = nil
        try state.writeSchedule(schedule)
        home.refuse(machine, nil)

        clock.move(by: Shipper.retryInterval)
        home.forgetRequests()
        rows.clear()
        _ = await makeShipper([domain], refresh: 60).run(.timer)
        XCTAssertEqual(methods, ["POST /v1/exchange"], "still never sent again as it is")
        XCTAssertEqual(rows.all, [], "the wait writes no row")
        XCTAssertEqual(state.readSchedule().sending?.sources[machine]?.code, "ACQUISITION_MANIFEST")
        XCTAssertEqual(state.readSchedule().sending?.sources[machine]?.sinceMs, Int64(Self.now.timeIntervalSince1970 * 1000),
                       "since the refusal, not since the restart")
    }


    func testA200BelowTheSealIsAConflictAndTheSourceSealsAgainOnlyAtTheNextRunUnderANewName() async throws {
        let machine = ShippingFixture.machineSource
        home.nameTaken(Self.machineBundle, source: machine)
        let domain = machineDomain([.sealed(), .sealed(), .nothingNew])
        let shipper = makeShipper([domain], refresh: 60)

        let first = await shipper.run(.timer)
        XCTAssertEqual(rows.all.map(\.summary), ["conflict NAME_TAKEN"])
        XCTAssertEqual(first.outcome, "conflict NAME_TAKEN")
        XCTAssertEqual(domain.seals, 1, "never sealed again at the run's one instant")
        XCTAssertEqual(try state.pendingBundles(), [], "spent")
        XCTAssertEqual(home.custody(machine).received, 0)
        XCTAssertEqual(state.readSchedule().sending?.sources[machine]?.code, "NAME_TAKEN", "the source says so")
        let next = await shipper.nextRun(after: Self.now)
        XCTAssertEqual(next, Self.now, "its domain is due at the next run")

        clock.move(by: 1)
        rows.clear()
        _ = await shipper.run(.timer)
        XCTAssertEqual(rows.all.map(\.summary), ["shipped"])
        XCTAssertEqual(domain.requests.map(\.custody.seal), [1, 1])
        XCTAssertEqual(home.deliveries.map(\.id), ["\(machine)/20260922T230001.000Z"])
        XCTAssertEqual(home.custody(machine).received, 1)
        XCTAssertNil(state.readSchedule().sending?.sources[machine], "once it ships it is no longer stated")
    }

    func testAConflictOfAPendingBundleOnSyncNowSealsNothingMoreThatRun() async throws {
        let machine = ShippingFixture.machineSource
        let gate = home
        let parkedOnce = Collected<Bool>()
        let domain = machineDomain([.sealed(), .sealed(), .nothingNew], gate: {
            if parkedOnce.count == 0 { gate?.answerNext(503) }
            parkedOnce.append(true)
        })
        let shipper = makeShipper([domain], refresh: 60)
        _ = await shipper.run(.timer)
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.seal), [1])
        home.nameTaken(Self.machineBundle, source: machine)

        clock.move(by: 60)
        rows.clear()
        _ = await shipper.run(.manual)
        XCTAssertEqual(rows.all.map(\.summary), ["conflict NAME_TAKEN"])
        XCTAssertEqual(domain.seals, 1, "Sync now, which makes every domain due, passes it over")

        clock.move(by: 60)
        rows.clear()
        _ = await shipper.run(.timer)
        XCTAssertEqual(rows.all.map(\.summary), ["shipped"])
        XCTAssertEqual(domain.requests.map(\.custody.seal), [1, 1])
        XCTAssertEqual(home.custody(machine).received, 1)
    }

    func testAConflictOnSyncNowSealsNothingMoreThatRunAndLeavesItsTailPending() async throws {
        let messages = ShippingFixture.messagesSource
        let gate = home
        let parkedOnce = Collected<Bool>()
        let domain = FakeDomain(sourceId: messages, name: "imessage", seals: [.sealedWithPage, .sealed(), .nothingNew],
                                holdingSealAt: {
            if parkedOnce.count == 0 { gate?.answerNext(503) }
            parkedOnce.append(true)
        })
        let shipper = makeShipper([domain], refresh: 60)
        _ = await shipper.run(.timer)
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.seal), [1, 2])
        home.nameTaken("\(messages)/20260922T230000.000Z", source: messages)

        clock.move(by: 60)
        rows.clear()
        _ = await shipper.run(.manual)
        XCTAssertEqual(rows.all.map(\.summary), ["conflict NAME_TAKEN"])
        XCTAssertEqual(domain.seals, 1, "Sync now seals nothing more of it that run")
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.seal), [2], "its tail is left where it was")

        clock.move(by: 60)
        rows.clear()
        _ = await shipper.run(.timer)
        XCTAssertEqual(rows.all.map(\.summary), ["stale STALE", "shipped"], "the next run finds the tail stale and seals again")
        XCTAssertEqual(domain.requests.map(\.custody.seal), [1, 1])
        XCTAssertEqual(home.custody(messages).received, 1)
        XCTAssertEqual(try state.pendingBundles(), [])
    }

    func testAnAnswerThatDoesNotStateTheSourceParksTheBundle() async throws {
        let gate = home
        home.nameTaken(Self.machineBundle, source: ShippingFixture.machineSource)
        let domain = machineDomain([.sealed()], gate: { _ = gate?.sources.remove(ShippingFixture.machineSource) })
        let report = await makeShipper([domain]).run(.timer)
        XCTAssertEqual(report.outcome, "held UNSTATED")
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.seal), [1])
    }

    func testABusyHomeParksTheBundleAndTheNextRunShipsItFirstNeverSealedTwice() async throws {
        let gate = home
        let domain = machineDomain([.sealed(), .nothingNew], gate: { gate?.answerNext(503) })
        let shipper = makeShipper([domain])

        let first = await shipper.run(.timer)
        XCTAssertEqual(first.outcome, "unreachable")
        XCTAssertEqual(try names(state.pendingDirectory), ["machine_local_unit-0001__20260922T230000.000Z.zip",
                                                           "machine_local_unit-0001__20260922T230000.000Z.zip.json"])
        XCTAssertEqual(try state.pendingBundles().first?.sidecar.seal, 1)

        home.forgetRequests()
        rows.clear()
        let second = await shipper.run(.timer)
        XCTAssertEqual(methods, ["POST /v1/exchange", "PUT /v1/acquisitions/\(Self.machineBundle)"])
        XCTAssertEqual(second.outcome, "shipped")
        XCTAssertNil(rows.all.first?.domain, "a parked bundle's row names its source, not a domain")
        XCTAssertEqual(rows.all.first?.seal, 1)
        XCTAssertEqual(domain.seals, 1, "the domain already acted, so nothing is sealed again")
        XCTAssertEqual(home.custody(ShippingFixture.machineSource).received, 1)
    }

    func testABundleTheHomeHasReceivedIsSpentUnsentAsASuccess() async throws {
        let domain = machineDomain([.sealed()])
        let shipper = makeShipper([domain])
        _ = await shipper.run(.timer)
        let delivered = try XCTUnwrap(home.deliveries.first)
        XCTAssertEqual(delivered.seal, 1)
        let parked = try FakeDomain(sourceId: ShippingFixture.machineSource, name: "m", seals: [.sealed()])
            .sealOne(SealRequest(fetchedAt: Self.now, workDirectory: state.workDirectory, scratch: state.workDirectory, custody: ShippingFixture.first))!
        try state.writeSidecar(parked)
        _ = try state.park(parked)

        rows.clear()
        home.forgetRequests()
        _ = await makeShipper([machineDomain([.nothingNew])]).run(.timer)
        XCTAssertEqual(rows.all.first?.summary, "shipped", "the home holds it: a success of its source")
        XCTAssertEqual(rows.all.first?.seal, 1)
        XCTAssertEqual(methods, ["POST /v1/exchange"], "never sent again")
        XCTAssertEqual(try names(state.pendingDirectory), [])
        XCTAssertEqual(home.custody(ShippingFixture.machineSource).received, 1)
    }

    func testABundleWhoseAnswerWasLostIsSpentAtTheExchangeThatSaysTheHomeHoldsItAndClearsItsSourcesFailure() async throws {
        let machine = ShippingFixture.machineSource
        let domain = machineDomain([.sealed(), .nothingNew])
        let shipper = makeShipper([domain])
        var schedule = state.readSchedule()
        var sending = Sending()
        sending.failed(machine, code: "ACQUISITION_TOO_LARGE", message: "an older refusal", at: Self.now.addingTimeInterval(-600))
        schedule.sending = sending
        try state.writeSchedule(schedule)

        home.loseNextAnswer()
        let lost = await shipper.run(.timer)
        XCTAssertEqual(lost.outcome, "unreachable", "the home took it; its answer never came back")
        XCTAssertEqual(home.custody(machine).received, 1)
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.seal), [1])

        clock.move(by: 60)
        rows.clear()
        let next = await shipper.run(.timer)
        XCTAssertEqual(home.requests.filter { $0.method == "PUT" }.count, 1, "no second upload of what the home holds")
        XCTAssertEqual(rows.all.map(\.summary), ["shipped", "nothing_new"])
        XCTAssertEqual(rows.all.first?.seal, 1)
        XCTAssertEqual(next.outcome, "nothing_new")
        XCTAssertEqual(try state.pendingBundles(), [])
        XCTAssertNil(state.readSchedule().sending?.sources[machine], "the source's old failure is cleared")
        XCTAssertEqual(domain.seals, 2, "its domain seals again behind it in the same run")
    }

    func testABundleTheDoorStillReadsWaitsItsRetryAfterWhileTheOtherSourcesShip() async throws {
        let messages = ShippingFixture.messagesSource, machine = ShippingFixture.machineSource
        home.refuse(messages, (409, "UPLOAD_ACTIVE"), retryAfter: 60)
        let messagesDomain = messagesDomain([.sealed(), .nothingNew])
        let machineDomain = machineDomain([.sealed(), .sealed(), .sealed(), .nothingNew])
        let shipper = makeShipper([messagesDomain, machineDomain], refresh: 60)
        let puts = { (source: String) in
            self.home.requests.filter { $0.method == "PUT" && $0.url.path.contains(source) }.count
        }

        let busy = await shipper.run(.timer)
        XCTAssertEqual(busy.rows.map(\.summary), ["held UPLOAD_ACTIVE", "shipped"])
        XCTAssertEqual(busy.rows.first?.seal, 1)
        XCTAssertEqual(home.custody(machine).received, 1, "the run went on: another source shipped after it")
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.sourceId), [messages], "kept, never sealed again")
        XCTAssertNil(state.readSchedule().sending?.sources[messages], "no refusal of its bytes: nothing stated failing")
        XCTAssertEqual(puts(messages), 1)
        let next = await shipper.nextRun(after: clock.now)
        XCTAssertEqual(next, clock.now.addingTimeInterval(60), "the timer's next run is when the door's wait ends")

        clock.move(by: 30)
        let early = await shipper.run(.manual)
        XCTAssertEqual(early.rows.map(\.summary), ["held UPLOAD_ACTIVE", "shipped"])
        XCTAssertEqual(puts(messages), 1, "not tried before the door's Retry-After")
        XCTAssertEqual(home.custody(machine).received, 2)

        home.refuse(messages, nil)
        clock.move(by: 30)
        _ = await shipper.run(.timer)
        XCTAssertEqual(puts(messages), 2)
        XCTAssertEqual(home.custody(messages).received, 1)
        XCTAssertEqual(home.deliveries.filter { $0.source == messages }.map(\.id), ["\(messages)/20260922T230000.000Z"],
                       "the same bundle, never sealed again")
        XCTAssertEqual(try state.pendingBundles(), [])
    }


    func testAPendingBundleSealedBeforeARestoreIsSealedAgainFromTheNewReceived() async throws {
        let gate = home
        let domain = machineDomain([.sealed(), .sealed(), .sealed(), .sealed()])
        let shipper = makeShipper([domain], refresh: 60)
        for _ in 0..<2 {
            _ = await shipper.run(.timer)
            clock.move(by: 60)
        }
        XCTAssertEqual(home.custody(ShippingFixture.machineSource).received, 2)
        let parking = machineDomain([.sealed()], gate: { gate?.answerNext(503) })
        _ = await makeShipper([parking]).run(.manual)
        XCTAssertEqual(try state.pendingBundles().first?.sidecar.seal, 3)
        home.restore(ShippingFixture.machineSource, received: 1, imported: 1)
        clock.move(by: 60)
        home.forgetRequests()
        rows.clear()

        _ = await shipper.run(.timer)

        XCTAssertEqual(rows.all.map(\.summary), ["stale STALE", "shipped"])
        XCTAssertEqual(methods, ["POST /v1/exchange", "PUT /v1/acquisitions/machine:local:unit-0001/20260922T230300.000Z"],
                       "the stale bundle never left; its domain sealed again at once")
        XCTAssertEqual(domain.requests.last?.custody, SealCustody(pass: ShippingFixture.pass, received: 1, imported: 1))
        XCTAssertEqual(home.custody(ShippingFixture.machineSource).received, 2)
    }

    func testABundleTheHomeFindsStaleIsSealedAgainInTheSameRun() async throws {
        _ = await makeShipper([machineDomain([.sealed()])]).run(.timer)
        clock.move(by: 300)
        let gate = home
        let restoredOnce = Collected<Bool>()
        let domain = machineDomain([.sealed(), .sealed()], gate: {
            if restoredOnce.count == 0 { gate?.restore(ShippingFixture.machineSource, received: 0, imported: 0) }
            restoredOnce.append(true)
        })
        rows.clear()
        let report = await makeShipper([domain]).run(.timer)

        XCTAssertEqual(rows.all.map(\.summary), ["stale STALE", "shipped"])
        XCTAssertEqual(domain.requests.map(\.custody.seal), [2, 1], "sealed again from the received the 409 carried")
        XCTAssertEqual(report.outcome, "shipped")
        XCTAssertEqual(home.custody(ShippingFixture.machineSource).received, 1)
    }

    func testAPendingTailIsSpentWhenItsHeadIsStale() async throws {
        let bundles = try messagesDomain([.sealedWithPage]).seal(
            SealRequest(fetchedAt: Self.now, workDirectory: state.workDirectory, scratch: state.workDirectory,
                        custody: SealCustody(pass: ShippingFixture.pass, received: 1, imported: 1)))
        for bundle in bundles { try state.writeSidecar(bundle); _ = try state.park(bundle) }
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.seal), [2, 3])
        clock.move(by: 300)
        let domain = messagesDomain([.sealed()])
        _ = await makeShipper([domain]).run(.timer)
        XCTAssertEqual(home.deliveries.map(\.id), ["\(ShippingFixture.messagesSource)/20260922T230500.000Z"])
        XCTAssertEqual(domain.requests.map(\.custody.seal), [1])
        XCTAssertEqual(try state.pendingBundles(), [])
    }

    func testAPageBehindAStaleLiveBundleIsSpentBeforeResealing() async throws {
        _ = await makeShipper([messagesDomain([.sealed()])]).run(.timer)
        clock.move(by: 300)
        let gate = home
        let restored = Collected<Bool>()
        let domain = FakeDomain(sourceId: ShippingFixture.messagesSource, name: "imessage",
                                seals: [.sealedWithPage, .sealed(), .nothingNew], holdingSealAt: {
            if restored.count == 0 { gate?.restore(ShippingFixture.messagesSource, received: 0, imported: 0) }
            restored.append(true)
        })
        rows.clear()
        let shipper = makeShipper([domain])
        _ = await shipper.run(.timer)
        XCTAssertEqual(rows.all.map(\.summary), ["stale STALE", "shipped"])
        XCTAssertEqual(domain.requests.map(\.custody.seal), [2, 1])
        XCTAssertEqual(try state.pendingBundles(), [], "the old page was sealed against replaced memory")
        clock.move(by: 300)
        _ = await shipper.run(.timer)
        XCTAssertFalse(home.deliveries.contains { $0.seal == 3 })
    }

    func testABundleHeldForAClockAheadWaitsAndIsNeverSealedAgain() async throws {
        let mac = FixedClock(Self.now.addingTimeInterval(3600))
        let domain = machineDomain([.sealed(), .nothingNew])
        let shipper = makeShipper([domain], refresh: 60, clock: mac)

        let first = await shipper.run(.timer)
        XCTAssertEqual(first.outcome, "held CLOCK_AHEAD")
        XCTAssertEqual(rows.all.last?.message, "this device's clock is ahead of Lifestream's")
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.seal), [1])

        for _ in 0..<3 {
            mac.move(by: 900)
            _ = await shipper.run(.timer)
        }
        XCTAssertEqual(domain.seals, 1, "held, never deleted and sealed again")
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.seal), [1])
        let held = state.readSchedule().sending?.sources[ShippingFixture.machineSource]
        XCTAssertEqual(held?.code, "CLOCK_AHEAD", "a held source is the home's fact too")
        XCTAssertEqual(held?.sinceMs, Int64(Self.now.addingTimeInterval(3600).timeIntervalSince1970 * 1000), "since stays put while it waits")

        mac.move(by: 900)
        clock.move(to: mac.now)
        rows.clear()
        _ = await shipper.run(.timer)
        XCTAssertEqual(rows.all.first?.summary, "shipped")
        XCTAssertEqual(rows.all.first?.seal, 1)
        XCTAssertEqual(home.custody(ShippingFixture.machineSource).received, 1)
        XCTAssertNil(state.readSchedule().sending?.sources[ShippingFixture.machineSource], "once it ships it is no longer stated")
    }

    func testABundleHeldForTheClockIsNotTriedBeforeItsQuarterHourByARunAnotherSourceStarts() async throws {
        let mac = FixedClock(Self.now.addingTimeInterval(3600))
        let machine = machineDomain([.sealed(), .nothingNew])
        let messages = messagesDomain([.nothingNew])
        let shipper = makeShipper([machine, messages], refresh: 60, clock: mac)
        let puts = { self.home.requests.filter { $0.method == "PUT" }.count }

        _ = await shipper.run(.timer)
        XCTAssertEqual(puts(), 1)
        let next = await shipper.nextRun(after: mac.now)
        XCTAssertEqual(next, mac.now.addingTimeInterval(60), "the other source is due each minute")
        for _ in 0..<14 {
            mac.move(by: 60)
            let run = await shipper.run(.timer)
            XCTAssertTrue(run.rows.contains { $0.summary == "held CLOCK_AHEAD" && $0.seal == 1 }, "said at every run it waits")
        }
        XCTAssertEqual(puts(), 1, "not tried again within its quarter of an hour")
        XCTAssertGreaterThan(messages.seals, 10, "the other source was read every minute")
        mac.move(by: 60)
        _ = await shipper.run(.timer)
        XCTAssertEqual(puts(), 2, "tried once its quarter of an hour passed")
        XCTAssertEqual(machine.seals, 1)
    }

    func testAMacBelowTheFloorHoldsItsBundleAndStopsUploading() async throws {
        let domain = machineDomain([.sealed(), .sealed()])
        let shipper = makeShipper([domain], refresh: 60)
        home.raiseFloor(to: "0.3.0")

        let first = await shipper.run(.timer)
        XCTAssertEqual(first.outcome, "held DEVICE_TOO_OLD")
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.seal), [1])
        home.forgetRequests()

        clock.move(by: Shipper.retryInterval)
        _ = await shipper.run(.timer)
        XCTAssertEqual(methods, ["POST /v1/exchange"], "below the floor the answer named, nothing is uploaded")
        XCTAssertEqual(domain.seals, 1, "the held bundle is not sealed again")
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.seal), [1])
    }

    func testAMacOnAnOlderHomeHoldsEverythingUntilTheHomeUpdates() async throws {
        home.runs(version: "checkout", generation: nil)
        let stamped = try await ShippingFixture.link(home, folder: root, version: "500", stamp: 500)
        let domain = machineDomain([.sealed(), .sealed()])
        let shipper = makeShipper([domain], refresh: 60, link: stamped)

        home.runs(version: "4f2a9c1", generation: 499)
        let first = await shipper.run(.timer)
        XCTAssertEqual(first.outcome, "held HOME_TOO_OLD")
        XCTAssertEqual(methods, ["POST /v1/exchange"], "the exchange alone: nothing sealed, nothing sent")
        XCTAssertEqual(domain.seals, 0)
        XCTAssertTrue(domain.answers.isEmpty, "no domain is handed an answer, so the spool deletes nothing")
        XCTAssertEqual(state.readSchedule().sending?.send?.code, "HOME_TOO_OLD", "the hold is the home's fact too")

        home.runs(version: "4f2a9c1", generation: nil)
        home.forgetRequests()
        clock.move(by: MacSettings.readerRefresh)
        let again = await shipper.run(.timer)
        XCTAssertEqual(again.outcome, "held HOME_TOO_OLD")
        XCTAssertEqual(methods, ["POST /v1/exchange"])
        XCTAssertEqual(home.sendings.last?["send"].flatMap { ($0 as? [String: Any])?["code"] as? String }, "HOME_TOO_OLD",
                       "the exchange states why this Mac sends nothing")

        home.runs(version: "5b3c0d2", generation: 500)
        home.forgetRequests()
        clock.move(by: MacSettings.readerRefresh)
        let updated = await shipper.run(.timer)
        XCTAssertEqual(updated.outcome, "shipped")
        XCTAssertEqual(methods.first, "POST /v1/exchange")
        XCTAssertEqual(home.custody(ShippingFixture.machineSource, pass: "p-00000002").received, 1, "the stamped Mac's own pass")
        XCTAssertNil(state.readSchedule().sending?.send)
    }

    func testANewPassStartsANewLedgerAndDropsWhatTheOldOneSealed() async throws {
        let gate = home
        let parking = machineDomain([.sealed()], gate: { gate?.answerNext(503) })
        _ = await makeShipper([parking]).run(.timer)
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.pass), [ShippingFixture.pass])
        let oldLedger = state.ledgers.file(pass: ShippingFixture.pass, source: ShippingFixture.machineSource)
        try ShippingState.replace(oldLedger, with: Data("{\"seals\":{}}\n".utf8), files: DeviceFiles(.plain))

        _ = try await link.pair(code: FakeHome.code, name: ShippingFixture.name)
        clock.move(by: 300)
        rows.clear()
        let domain = machineDomain([.sealed()])
        _ = await makeShipper([domain]).run(.timer)

        XCTAssertEqual(domain.requests.first?.custody, SealCustody(pass: "p-00000002", received: 0, imported: 0))
        XCTAssertEqual(rows.all.map(\.summary), ["shipped"], "the old pass's bundle was never sent")
        XCTAssertFalse(FileManager.default.fileExists(atPath: oldLedger.path), "the old pass's ledgers are gone")
        XCTAssertEqual(home.custody(ShippingFixture.machineSource, pass: "p-00000002").received, 1)
    }


    func testAScheduleThatDoesNotReadIsReplacedAndTheRunShips() async throws {
        try Data("{\"last_run_at\":".utf8).write(to: state.scheduleFile)
        let domain = machineDomain([.sealed()])
        let report = await makeShipper([domain]).run(.timer)
        XCTAssertEqual(report.outcome, "shipped")
        XCTAssertEqual(state.readSchedule().lastRunAt, Self.now, "a fresh schedule is written in its place")
    }

    func testABundleWhoseSidecarDoesNotReadIsSpentAndItsSealIsSealedAgain() async throws {
        let gate = home
        _ = await makeShipper([machineDomain([.sealed()], gate: { gate?.answerNext(503) })]).run(.timer)
        let parked = try XCTUnwrap(state.pendingBundles().first)
        try Data("{\"id\":".utf8).write(to: ShippingState.sidecarFile(for: parked.file))

        clock.move(by: Shipper.retryInterval)
        rows.clear()
        let domain = machineDomain([.sealed()])
        let report = await makeShipper([domain]).run(.timer)
        XCTAssertEqual(report.outcome, "shipped")
        XCTAssertEqual(domain.requests.first?.custody.seal, 1, "the spent bundle's seal, sealed again")
        XCTAssertEqual(home.custody(ShippingFixture.machineSource).received, 1)
        XCTAssertEqual(try names(state.pendingDirectory), [])
    }

    func testASourceTheHomeTurnedOffShipsNothing() async throws {
        home.sources = [ShippingFixture.messagesSource]
        let machine = machineDomain([.sealed()])
        let messages = messagesDomain([.nothingNew])
        _ = await makeShipper([machine, messages]).run(.timer)

        XCTAssertTrue(built.all.contains([ShippingFixture.messagesSource]))
        XCTAssertEqual(messages.seals, 1)
        XCTAssertEqual(machine.seals, 0, "a source absent from the answer has no domain")
    }


    func testADomainInsideItsIntervalWaitsUntilShipNow() async throws {
        try pairedLongAgo()
        let domain = machineDomain([.nothingNew, .nothingNew])
        let shipper = makeShipper([domain])
        _ = await shipper.run(.timer)
        clock.move(by: 120)

        let timed = await shipper.run(.timer)
        XCTAssertEqual(timed.outcome, "nothing_due")
        XCTAssertEqual(domain.seals, 1)
        let manual = await shipper.run(.manual)
        XCTAssertEqual(manual.outcome, "nothing_new")
        XCTAssertEqual(domain.seals, 2, "Sync now runs a domain still inside its interval")
    }

    func testADatabasesHistoryPageShipsAfterItsLiveBundleInSealOrder() async throws {
        let domain = messagesDomain([.sealedWithPage, .nothingNew])
        let shipper = makeShipper([domain], refresh: 60)
        let report = await shipper.run(.timer)

        XCTAssertEqual(report.outcome, "shipped")
        XCTAssertEqual(rows.all.map(\.kind), ["changes", "history"])
        XCTAssertEqual(rows.all.map(\.seal), [1, 2])
        XCTAssertEqual(home.custody(ShippingFixture.messagesSource).received, 2)
        XCTAssertEqual(state.readSchedule().domains[ShippingFixture.messagesSource]?.historySeal, 2)
        let importing = await shipper.status().importingHistory
        XCTAssertTrue(importing, "the home has not imported the page")
        home.importAll()
        _ = await shipper.knock()
        let imported = await shipper.status().importingHistory
        XCTAssertFalse(imported)
    }

    func testEveryUploadStatesWhatItIs() async throws {
        let shipper = makeShipper([messagesDomain([.sealedWithPage, .nothingNew]), machineDomain([.sealed()])], refresh: 60)
        _ = await shipper.run(.timer)
        XCTAssertEqual(home.deliveries.map { "\($0.source) \($0.seal ?? 0) \($0.kind ?? "none")" },
                       ["\(ShippingFixture.messagesSource) 1 new", "\(ShippingFixture.messagesSource) 2 later",
                        "\(ShippingFixture.machineSource) 1 new"],
                       "a live bundle is new, a history page later")
    }

    func testTheHomesMacOnAHotspotShipsEverythingOverLoopbackAndStatesNow() async throws {
        let here = try await ShippingFixture.link(home, folder: root.appendingPathComponent("here"), network: FakeNetwork(.costly))
        let domain = messagesDomain([.sealedWithPage])
        let shipper = makeShipper([domain], refresh: 60, link: here)
        let report = await shipper.run(.timer)
        XCTAssertEqual(report.outcome, "shipped")
        XCTAssertEqual(home.deliveries.map(\.kind), ["new", "later"], "loopback crosses no network: nothing waits for it")
        XCTAssertEqual(domain.requests.first?.custody.history, true, "its history pages on")
        clock.move(by: 60)
        let next = await shipper.run(.timer)
        XCTAssertFalse((report.rows + next.rows).contains { Shipper.heldForNetwork($0) != nil }, "a home on this Mac never waits for Wi-Fi")
        XCTAssertNil(report.waitsFor ?? next.waitsFor)
        XCTAssertEqual(Set(home.networks), ["now"], "each exchange states the hotspot: the home's own past waits for this Mac's Wi-Fi, though its sends do not")
    }

    func testAMacOnAHotspotSendsNewDataAndLetsAPageGoUntilTheNetworkIsFree() async throws {
        let network = FakeNetwork()
        let away = try await away(network)
        let gate = home
        let opened = Toggle(false)
        let domain = FakeDomain(sourceId: ShippingFixture.messagesSource, name: "imessage",
                                seals: [.sealedWithPage, .sealedWithPage, .sealedWithPage, .nothingNew],
                                holdingSealAt: { if !opened.value { opened.value = true; gate?.answerNext(503) } })
        let shipper = makeShipper([domain], refresh: 60, link: away)
        let first = await shipper.run(.timer)
        XCTAssertEqual(first.outcome, "unreachable")
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.write), [.new, .later])

        network.path = .costly
        clock.move(by: Shipper.retryInterval)
        let held = await shipper.run(.timer)
        XCTAssertEqual(home.deliveries.map { "\($0.seal ?? 0) \($0.kind ?? "none")" }, ["1 new", "2 new"],
                       "new data moves on mobile data, and its source's next seal is never behind the page")
        XCTAssertTrue(held.rows.contains { $0.summary == "held past" && $0.seal == 2 }, "the page waits, and says why")
        XCTAssertEqual(domain.requests.last?.custody.history, false, "no page is sealed while it would wait")
        XCTAssertEqual(try state.pendingBundles(), [], "nothing parked stands in front of the source")
        XCTAssertEqual(held.waitsFor, .past, "the menu says the wait for Wi-Fi")
        XCTAssertEqual(held.outcome, "shipped", "the network's wait is no outcome")
        try ShippingFixture.artifact("metered-mac.json", ["deliveries": home.deliveries.map { [$0.kind ?? "none", "\($0.seal ?? 0)"] },
                                                     "rows": held.rows.map(\.summary)])

        network.path = .free
        clock.move(by: Shipper.retryInterval)
        let free = await shipper.run(.timer)
        XCTAssertNil(free.waitsFor)
        XCTAssertEqual(home.deliveries.map { "\($0.seal ?? 0) \($0.kind ?? "none")" }, ["1 new", "2 new", "3 new", "4 later"])
        XCTAssertEqual(try state.pendingBundles(), [])
    }

    private func away(_ network: FakeNetwork) async throws -> HomeLink {
        try await ShippingFixture.link(home, folder: root.appendingPathComponent("away"), at: "http://100.100.1.1:4680", network: network)
    }

    private func awayOnAHotspot(_ messages: FakeDomain, _ machine: FakeDomain, network: FakeNetwork,
                                link: HomeLink? = nil) async throws -> Shipper {
        let every = { (seconds: TimeInterval) in ["refresh": MacSettings.JSON.string(MacSettings.words(seconds))] }
        let settings = MacSettings(file: DomainFixtures.settingsFile, defaults: ["machine": every(60), "imessage": every(300)], files: DeviceFiles(.plain))
        let link = if let link { link } else { try await away(network) }
        return makeShipper([messages, machine], settings: settings, link: link)
    }

    func testTheWaitForWiFiIsEveryRunsWhileOwedHistoryWaitsAndNoneOnceTheNetworkIsFree() async throws {
        let network = FakeNetwork(.costly)
        let messages = messagesDomain([.sealedWithPage])
        let shipper = try await awayOnAHotspot(messages, machineDomain([.sealed()]), network: network)
        var reports = [await shipper.run(.timer)]
        clock.move(by: Shipper.youngFor)
        for _ in 0..<5 {
            reports.append(await shipper.run(.timer))
            clock.move(by: 60)
        }
        XCTAssertEqual(messages.seals, 2, "four of the runs never asked the source that owes history")
        XCTAssertEqual(reports.map(\.waitsFor), Array(repeating: .past, count: 6), "the wait is every run's while it lasts")
        XCTAssertEqual(reports.map(\.outcome), Array(repeating: "shipped", count: 6), "and no run's outcome")
        XCTAssertFalse(reports.suffix(4).flatMap(\.rows).contains { $0.source == ShippingFixture.messagesSource },
                       "no row for a source that took no step")
        XCTAssertFalse(home.deliveries.contains { $0.kind == "later" }, "no page crossed the hotspot")

        network.path = .free
        let free = await shipper.run(.timer)
        XCTAssertNil(free.waitsFor, "a free network ends the wait at its next run")
        XCTAssertEqual(home.deliveries.last(where: { $0.source == ShippingFixture.messagesSource })?.kind, "later", "and the page goes")
        try ShippingFixture.artifact("metered-wait.json", ["waits": (reports + [free]).map { $0.waitsFor?.rawValue ?? "none" }])
    }

    func testASourceWhoseLastPageWentOnWiFiOwesNothingOnAHotspot() async throws {
        let network = FakeNetwork()
        let messages = messagesDomain([.sealedWithPage, .lastPage, .nothingNew])
        let shipper = try await awayOnAHotspot(messages, machineDomain([.sealed()]), network: network)
        _ = await shipper.run(.timer)
        clock.move(by: Shipper.youngFor)
        _ = await shipper.run(.timer)
        XCTAssertEqual(home.deliveries.filter { $0.kind == "later" }.count, 2, "both pages went on Wi-Fi, the last of its history")

        network.path = .costly
        clock.move(by: 60)
        let hotspot = await shipper.run(.timer)
        XCTAssertEqual(messages.seals, 2, "the source was not due")
        XCTAssertNil(hotspot.waitsFor, "nothing is owed, so nothing waits")
    }

    func testASourceThisMacNoLongerBuildsSaysNoWaitForWiFi() async throws {
        let network = FakeNetwork(.costly)
        let machine = machineDomain([.sealed()])
        let link = try await away(network)
        let before = try await awayOnAHotspot(messagesDomain([.sealedWithPage]), machine, network: network, link: link)
        let held = await before.run(.timer)
        XCTAssertEqual(held.waitsFor, .past)

        let after = makeShipper([machine], refresh: 60, link: link)
        clock.move(by: 60)
        let next = await after.run(.timer)
        XCTAssertEqual(built.all.last?.contains(ShippingFixture.messagesSource), true, "the home still lists it")
        XCTAssertNil(next.waitsFor, "a source this run cannot move waits for nothing")
    }

    func testASourceWhoseSealIsRefusedSaysNoWaitForWiFi() async throws {
        let messages = messagesDomain([.sealedWithPage, .failure])
        let shipper = try await awayOnAHotspot(messages, machineDomain([.sealed()]), network: FakeNetwork(.costly))
        let held = await shipper.run(.timer)
        XCTAssertEqual(held.waitsFor, .past)
        clock.move(by: Shipper.youngFor)
        let refused = await shipper.run(.timer)
        XCTAssertEqual(messages.seals, 2)
        XCTAssertTrue(refused.rows.contains { $0.source == ShippingFixture.messagesSource && $0.summary == "refused LOCAL_ACCESS" })
        XCTAssertNil(refused.waitsFor, "a source whose seal is refused moves nothing: its wait is the refusal's")
    }

    func testARelaunchedMacOnAHotspotSaysTheWaitAtItsFirstRun() async throws {
        let network = FakeNetwork(.costly)
        let messages = messagesDomain([.sealedWithPage])
        let machine = machineDomain([.sealed()])
        let link = try await away(network)
        let before = try await awayOnAHotspot(messages, machine, network: network, link: link)
        let held = await before.run(.timer)
        XCTAssertEqual(held.waitsFor, .past)

        let after = try await awayOnAHotspot(messages, machine, network: network, link: link)
        let status = await after.status()
        XCTAssertEqual(status.waitsFor, .past, "the menu says it before any run")
        clock.move(by: 10)
        let first = await after.run(.timer)
        XCTAssertEqual(messages.seals, 1, "the source was not due")
        XCTAssertEqual(first.waitsFor, .past, "the first run says the wait")
    }

    func testATroubleToActOnIsTheOutcomeWhileHistoryWaitsForWiFi() async throws {
        let shipper = try await awayOnAHotspot(messagesDomain([.sealedWithPage]), machineDomain([.failure]),
                                               network: FakeNetwork(.lowData))
        let report = await shipper.run(.timer)
        XCTAssertEqual(report.outcome, "refused LOCAL_ACCESS", "the person must act on it: the network mends itself")
        XCTAssertEqual(report.waitsFor, .lowData)
    }

    func testAWaitForRoomAtTheHomeIsSaidOverAWaitForWiFi() async throws {
        let away = try await away(FakeNetwork(.costly))
        let shipper = makeShipper([messagesDomain([.sealedWithPage]), machineDomain([.sealed()])], refresh: 60, link: away)
        home.noRoomFor = ["new", "later"]
        let report = await shipper.run(.timer)
        XCTAssertEqual(report.waitsFor, .past, "the history waits for Wi-Fi too")
        XCTAssertEqual(report.outcome, "held DISK_LOW", "the home's disk is the person's to free; the network mends itself")
    }

    func testSyncNowSendsWhatLowDataModeHolds() async throws {
        let away = try await away(FakeNetwork(.lowData))
        let domain = messagesDomain([.sealedWithPage, .sealedWithPage, .nothingNew])
        let shipper = makeShipper([domain], refresh: 60, link: away)
        _ = await shipper.run(.timer)
        XCTAssertEqual(home.deliveries.map(\.kind), ["new"], "Low Data Mode holds what a hotspot holds")
        clock.move(by: 60)
        _ = await shipper.run(.manual)
        XCTAssertEqual(home.deliveries.map(\.kind), ["new", "new", "later"], "a press moves what it sends on any network")
    }

    func testAHomeWithNoRoomForTheirPastKeepsTakingWhatThisMacRecordsNow() async throws {
        let messages = messagesDomain([.sealedWithPage, .sealed(kind: "changes"), .sealedWithPage, .nothingNew])
        let machine = machineDomain([.sealed()])
        let shipper = makeShipper([messages, machine], refresh: 60)
        home.noRoomFor = ["later"]
        var summaries: [[String]] = []

        let refused = await shipper.run(.timer)
        summaries.append(refused.rows.map(\.summary))
        XCTAssertTrue(refused.rows.contains { $0.summary == "held DISK_LOW" && $0.seal == 2 }, "the page waits for room")
        XCTAssertFalse(refused.rows.contains { $0.outcome == "unreachable" }, "a home without room is not a silent one")
        XCTAssertEqual(home.custody(ShippingFixture.machineSource).received, 1, "the machine's new data landed after it")
        XCTAssertEqual(refused.outcome, "held DISK_LOW", "the strongest wait, not the last row")
        XCTAssertEqual(try state.pendingBundles(), [], "nothing parked stands in front of the source")

        clock.move(by: Shipper.retryInterval)
        let next = await shipper.run(.timer)
        summaries.append(next.rows.map(\.summary))
        XCTAssertEqual(home.custody(ShippingFixture.messagesSource).received, 2)
        XCTAssertEqual(home.deliveries.filter { $0.source == ShippingFixture.messagesSource }.map { "\($0.seal ?? 0) \($0.kind ?? "none")" },
                       ["1 new", "2 new"])

        home.noRoomFor = []
        clock.move(by: Shipper.retryInterval)
        _ = await shipper.run(.timer)
        XCTAssertEqual(home.custody(ShippingFixture.messagesSource).received, 4, "its live bundle, then its page")
        XCTAssertEqual(try state.pendingBundles(), [])
        try ShippingFixture.artifact("roomless-home.json", ["runs": summaries])
    }

    func testAPageLeftPendingIsLetGoWhileTheHomeHoldsItsPastBackAndItsSourcesNewDataGoes() async throws {
        let gate = home
        let opened = Toggle(false)
        let domain = FakeDomain(sourceId: ShippingFixture.messagesSource, name: "imessage",
                                seals: [.sealedWithPage, .sealedWithPage, .nothingNew],
                                holdingSealAt: { if !opened.value { opened.value = true; gate?.answerNext(503) } })
        let shipper = makeShipper([domain], refresh: 60)
        _ = await shipper.run(.timer)
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.write), [.new, .later])

        home.holdingBack = [ShippingFixture.messagesSource]
        clock.move(by: Shipper.retryInterval)
        let holding = await shipper.run(.timer)
        XCTAssertTrue(holding.rows.contains { $0.summary == "held HISTORY" && $0.seal == 2 })
        XCTAssertEqual(home.deliveries.map { "\($0.seal ?? 0) \($0.kind ?? "none")" }, ["1 new", "2 new"],
                       "the past waits; the source's new data goes in the same run")
        XCTAssertEqual(try state.pendingBundles(), [])
    }

    func testNewDataTheHomeHasNoRoomForWaitsWithoutStoppingTheRunAndFullIsTheHomesOwnWord() async throws {
        let messages = messagesDomain([.sealed(kind: "changes"), .nothingNew])
        let machine = machineDomain([.sealed(), .nothingNew])
        let shipper = makeShipper([messages, machine], refresh: 60)
        home.noRoomFor = ["new", "later"]

        let low = await shipper.run(.timer)
        XCTAssertEqual(low.rows.filter { $0.summary == "held DISK_LOW" }.count, 2, "each source tried: one refusal stops nothing")
        XCTAssertEqual(low.outcome, "held DISK_LOW")
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.write), [.new, .new], "kept for when there is room")

        home.full = true
        clock.move(by: Shipper.retryInterval)
        let uploads = home.requests.filter { $0.method == "PUT" }.count
        let full = await shipper.run(.timer)
        XCTAssertEqual(full.rows.filter { $0.summary == "held DISK_FULL" }.count, 2)
        XCTAssertEqual(full.outcome, "held DISK_FULL")
        XCTAssertEqual(home.requests.filter { $0.method == "PUT" }.count, uploads, "a full home refuses every upload: none is sent")
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.write), [.new, .new], "each kept, never sealed again")

        home.full = false
        home.noRoomFor = []
        clock.move(by: Shipper.retryInterval)
        _ = await shipper.run(.timer)
        XCTAssertEqual(home.deliveries.count, 2, "both go once there is room, never sealed again")
        XCTAssertEqual(try state.pendingBundles(), [])
    }

    func testASourceTheDoorRefusedForRoomSealsNoPageUntilItsRetryAfter() async throws {
        let domain = messagesDomain([.sealedWithPage, .sealedWithPage, .sealedWithPage, .nothingNew])
        let shipper = makeShipper([domain], refresh: 60)
        home.noRoomFor = ["later"]
        let refused = await shipper.run(.timer)
        XCTAssertTrue(refused.rows.contains { $0.summary == "held DISK_LOW" && $0.seal == 2 })

        clock.move(by: 30)
        _ = await shipper.run(.manual)
        XCTAssertEqual(domain.requests.map(\.custody.history), [true, false], "no page is sealed while the door's wait runs")
        XCTAssertEqual(home.deliveries.map { "\($0.seal ?? 0) \($0.kind ?? "none")" }, ["1 new", "2 new"])

        home.noRoomFor = []
        clock.move(by: 60)
        _ = await shipper.run(.timer)
        XCTAssertEqual(domain.requests.last?.custody.history, true)
        XCTAssertEqual(home.deliveries.map { "\($0.seal ?? 0) \($0.kind ?? "none")" }, ["1 new", "2 new", "3 new", "4 later"])
    }

    func testWhatChangedThatItsSourceStillHoldsGoesWhileTheHomeHoldsItsPastBack() async throws {
        let network = FakeNetwork(.costly)
        let away = try await away(network)
        let photos = FakeDomain(sourceId: ShippingFixture.inputSource, name: "photos", seals: [.sealedLater, .sealedLater, .nothingNew])
        let shipper = makeShipper([photos], refresh: 60, link: away)
        let first = await shipper.run(.timer)
        XCTAssertTrue(first.rows.contains { $0.summary == "held past" })
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.write), [.later])

        home.holdingBack = [ShippingFixture.inputSource]
        network.path = .free
        clock.move(by: Shipper.retryInterval)
        let back = await shipper.run(.timer)
        XCTAssertFalse(back.rows.contains { $0.summary == "held HISTORY" })
        XCTAssertEqual(home.deliveries.map { "\($0.seal ?? 0) \($0.kind ?? "none")" }, ["1 later", "2 later"])
        XCTAssertEqual(try state.pendingBundles(), [])
    }

    func testABundleStatesHistoryWhenItIsAPageOrAHandedOverFile() {
        func sidecar(_ kind: String?, _ write: WriteKind) -> BundleSidecar {
            BundleSidecar(id: "sha256:00", sourceId: "s", seal: 1, kind: kind, write: write)
        }
        XCTAssertTrue(sidecar(HistoryPage.kind, .later).statesHistory)
        XCTAssertTrue(sidecar(ImportShipping.kind, .later).statesHistory)
        XCTAssertFalse(sidecar(nil, .later).statesHistory, "the photo pass's bundle, a dropped file: what changed")
        XCTAssertFalse(sidecar("changes", .new).statesHistory)
        XCTAssertFalse(sidecar(nil, .new).statesHistory)
    }

    func testARunsOutcomeIsTheStrongestWaitItMetElseItsLastRow() {
        func outcome(_ summaries: [(String, String?)]) -> String {
            Shipper.outcome(of: summaries.map { ShipperRunRow(outcome: $0.0, code: $0.1) })
        }
        XCTAssertEqual(outcome([("held", "past"), ("held", "DISK_LOW"), ("shipped", nil)]), "held DISK_LOW")
        XCTAssertEqual(outcome([("held", "large"), ("held", "DISK_FULL"), ("held", "DISK_LOW")]), "held DISK_FULL")
        XCTAssertEqual(outcome([("shipped", nil), ("nothing_new", nil), ("held", "past")]), "nothing_new",
                       "a wait for a free network is no outcome, though it is the last row")
        XCTAssertEqual(outcome([("refused", "LOCAL_ACCESS"), ("held", "low-data")]), "refused LOCAL_ACCESS")
        XCTAssertEqual(outcome([("held", "HISTORY"), ("shipped", nil)]), "shipped", "the home's own words say why the past waits")
        XCTAssertEqual(outcome([]), "nothing_due")
    }

    func testAPageBehindALiveBundleTheHomeDidNotTakeWaitsWithItInSealOrder() async throws {
        let gate = home
        let domain = FakeDomain(sourceId: ShippingFixture.messagesSource, name: "imessage", seals: [.sealedWithPage, .nothingNew],
                                holdingSealAt: { gate?.answerNext(503) })
        let shipper = makeShipper([domain], refresh: 60)
        let first = await shipper.run(.timer)
        XCTAssertEqual(first.outcome, "unreachable")
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.seal), [1, 2])

        clock.move(by: Shipper.retryInterval)
        _ = await shipper.run(.timer)
        XCTAssertEqual(home.deliveries.map(\.seal), [1, 2])
        XCTAssertEqual(domain.seals, 2, "sealed once more only after both shipped")
        XCTAssertEqual(try state.pendingBundles(), [])
    }

    func testAYoungSourceShipsEveryMinuteThenAtTheSetting() async throws {
        let shipper = makeShipper([machineDomain([.sealed(), .nothingNew])])
        _ = await shipper.run(.timer)
        let young = await shipper.nextRun(after: Self.now)
        XCTAssertEqual(young, Self.now.addingTimeInterval(Shipper.minimumInterval))

        clock.move(by: Shipper.youngFor - 60)
        _ = await shipper.run(.timer)
        let last = await shipper.nextRun(after: clock.now)
        XCTAssertEqual(last, clock.now.addingTimeInterval(Shipper.minimumInterval), "still young a minute before its hour")
        let grown = await shipper.nextRun(after: Self.now.addingTimeInterval(Shipper.youngFor))
        XCTAssertEqual(grown, clock.now.addingTimeInterval(MacSettings.readerRefresh), "grown, it waits the setting from its last act")
    }

    func testAQuietSourceGrowsUpWithThePairingAndALateOneIsYoungFromItsFirstSeal() async throws {
        let quiet = messagesDomain(Array(repeating: .nothingNew, count: 3))
        let late = machineDomain([.nothingNew, .nothingNew, .sealed(), .nothingNew])
        let shipper = makeShipper([quiet, late])
        _ = await shipper.run(.timer)
        let paired = await shipper.nextRun(after: Self.now)
        XCTAssertEqual(paired, Self.now.addingTimeInterval(Shipper.minimumInterval), "the pairing's hour")

        clock.move(by: Shipper.youngFor)
        _ = await shipper.run(.timer)
        let grown = await shipper.nextRun(after: clock.now)
        XCTAssertEqual(grown, clock.now.addingTimeInterval(MacSettings.readerRefresh), "quiet after the pairing's hour")

        clock.move(by: 86_400)
        _ = await shipper.run(.timer)
        XCTAssertEqual(late.seals, 3)
        XCTAssertEqual(quiet.seals, 3)
        let firstSeal = await shipper.nextRun(after: clock.now)
        XCTAssertEqual(firstSeal, clock.now.addingTimeInterval(Shipper.minimumInterval), "young from its first seal")
    }

    func testAnUnreadableSourceWaitsTheSettingEvenWhenYoung() async throws {
        let failing = messagesDomain([.failure, .failure])
        let shipper = makeShipper([failing])
        _ = await shipper.run(.timer)
        let next = await shipper.nextRun(after: Self.now)
        XCTAssertEqual(next, Self.now.addingTimeInterval(MacSettings.readerRefresh))
        clock.move(by: Shipper.minimumInterval)
        _ = await shipper.run(.timer)
        XCTAssertEqual(failing.seals, 1, "not tried again after a minute")
    }

    func testANewPassMakesEverySourceYoungAgain() async throws {
        try pairedLongAgo()
        var schedule = state.readSchedule()
        schedule.pass = "p-00000009"
        try state.writeSchedule(schedule)
        let shipper = makeShipper([machineDomain([.nothingNew])])
        _ = await shipper.run(.timer)
        let next = await shipper.nextRun(after: Self.now)
        XCTAssertEqual(next, Self.now.addingTimeInterval(Shipper.minimumInterval))
        XCTAssertEqual(state.readSchedule().pass, ShippingFixture.pass)
    }

    func testADomainThatCouldNotReadIsTriedAtOnceByTheNextLaunch() async throws {
        try pairedLongAgo()
        let failing = messagesDomain([.failure, .sealed()])
        let shipper = makeShipper([failing])
        _ = await shipper.run(.timer)
        clock.move(by: 30)
        let waits = await shipper.nextRun(after: clock.now)
        XCTAssertEqual(waits, Self.now.addingTimeInterval(MacSettings.readerRefresh), "retried every tick in one process")

        let relaunched = makeShipper([failing])
        let next = await relaunched.nextRun(after: clock.now)
        XCTAssertEqual(next, clock.now, "the launch waits the interval the last process tried in")
        _ = await relaunched.run(.timer)
        XCTAssertEqual(rows.all.map(\.summary), ["refused LOCAL_ACCESS", "shipped"])
    }

    func testAGuardedProductReadWithoutFullDiskAccessWaitsOnTheGrant() async throws {
        let stores = try StoreFixtures.stores(home: root.appendingPathComponent("mac", isDirectory: true),
                                              state: root.appendingPathComponent("stores", isDirectory: true), fullDiskAccess: false)
        _ = await makeShipper([messagesDomain([.failure]), machineDomain([.failure])], fullDiskAccess: false, stores: stores).run(.timer)
        XCTAssertEqual(rows.all.map(\.summary), ["refused FULL_DISK_ACCESS", "refused LOCAL_ACCESS"],
                       "iMessage waits on the grant; the recorder's own machine events are a sync's trouble")
    }

    func testAPhotosSealThatFailsWithoutFullDiskAccessIsASyncsTrouble() async throws {
        let photos = FakeDomain(sourceId: "apple-photos:a@example.com:unit-0001", name: "photos", seals: [.failure])
        home.sources.insert(photos.sourceId)
        _ = await makeShipper([photos], fullDiskAccess: false).run(.timer)
        XCTAssertEqual(rows.all.map(\.summary), ["refused LOCAL_ACCESS"])
    }

    func testASealThatThrowsIsRefusedLocallyAndTheOtherDomainsStillShip() async throws {
        let failing = messagesDomain([.failure])
        let machine = machineDomain([.sealed()])
        let report = await makeShipper([failing, machine]).run(.timer)

        XCTAssertEqual(rows.all.map(\.summary), ["refused LOCAL_ACCESS", "shipped"])
        XCTAssertEqual(rows.all.first?.reason, "ShippingTests.FakeSealFailure 1")
        XCTAssertEqual(report.outcome, "shipped")
        let stated = state.readSchedule().sending
        XCTAssertEqual(stated?.sources[ShippingFixture.messagesSource]?.code, "LOCAL_ACCESS", "kept for every exchange, across launches")
        XCTAssertNil(stated?.sources[ShippingFixture.machineSource])
    }


    func testASourceTheDoorRefusedIsStatedFailingWhileItWaitsAndTheOthersShip() async throws {
        try pairedLongAgo()
        let messages = ShippingFixture.messagesSource
        home.refuse(messages, (413, "ACQUISITION_TOO_LARGE"))
        let shipper = makeShipper([messagesDomain([.sealed()]), machineDomain([.sealed()])], refresh: 60)
        let began = Int64(Self.now.timeIntervalSince1970 * 1000)
        for _ in 0..<3 {
            _ = await shipper.run(.timer)
            clock.move(by: 300)
        }
        XCTAssertEqual(home.custody(ShippingFixture.machineSource).received, 3, "the others ship every run")
        XCTAssertEqual(home.custody(messages).received, 0)
        let failing = { (sending: [String: Any]) in (sending["sources"] as? [String: [String: Any]])?[messages] }
        let stating = home.sendings.compactMap(failing)
        XCTAssertGreaterThanOrEqual(stating.count, 2, "every exchange after the first refusal states it")
        XCTAssertEqual(stating.map { $0["code"] as? String }, Array(repeating: "ACQUISITION_TOO_LARGE", count: stating.count))
        XCTAssertEqual(stating.map { $0["since_ms"] as? Int64 }, Array(repeating: began, count: stating.count),
                       "since stays put while it repeats")
        XCTAssertNil((home.sendings.last?["sources"] as? [String: Any])?[ShippingFixture.machineSource], "a source that ships is not stated")

        let relaunched = makeShipper([messagesDomain([.sealed()]), machineDomain([.sealed()])], refresh: 60)
        _ = await relaunched.knock()
        XCTAssertEqual(failing(try XCTUnwrap(home.sendings.last))?["since_ms"] as? Int64, began)

        home.refuse(messages, nil)
        clock.move(to: Self.now.addingTimeInterval(Shipper.refusedInterval))
        _ = await relaunched.run(.timer)
        XCTAssertEqual(home.custody(messages).received, 1)
        _ = await relaunched.knock()
        XCTAssertEqual((home.sendings.last?["sources"] as? [String: Any])?.isEmpty, true, "the next exchange states none failing")
        try ShippingFixture.artifact("mac-sending.json", home.sendings)
    }

    func testAPartADomainCouldNotReadIsStatedWhileWhatItSealedShips() async throws {
        let messages = messagesDomain([.sealed(), .sealed()])
        messages.unreadPart = Unread(code: "SESSION_LOG_UNREADABLE", message: "1 session log read to 64 MiB without the line that says who started it: synthetic.jsonl")
        let shipper = makeShipper([messages])
        _ = await shipper.run(.timer)
        XCTAssertEqual(rows.all.map(\.summary), ["shipped"], "what it sealed ships, and the run says nothing of trouble")
        XCTAssertEqual(state.readSchedule().sending?.sources[ShippingFixture.messagesSource]?.code, "SESSION_LOG_UNREADABLE")
        messages.unreadPart = nil
        clock.move(by: 3600)
        _ = await shipper.run(.timer)
        XCTAssertNil(state.readSchedule().sending?.sources[ShippingFixture.messagesSource])
    }

    func testABundleLeftInWorkByACrashIsRecoveredAndShippedFirst() async throws {
        let crashed = try FakeDomain(sourceId: ShippingFixture.machineSource, name: "m", seals: [.sealed()])
            .sealOne(SealRequest(fetchedAt: Self.now, workDirectory: state.workDirectory, scratch: state.workDirectory, custody: ShippingFixture.first))!
        try state.writeSidecar(crashed)
        let domain = machineDomain([.nothingNew])
        _ = await makeShipper([domain]).run(.timer)

        XCTAssertEqual(rows.all.map(\.summary), ["shipped", "nothing_new"], "the recovered bundle first, then its domain")
        XCTAssertNil(rows.all.first?.domain)
        XCTAssertEqual(try names(state.workDirectory), [])
    }


    func testOneRunRotatesTheOpenBatchesOnceBeforeTheFirstDomainSeals() async throws {
        let rotations = self.rotations!
        let input = FakeDomain(sourceId: ShippingFixture.inputSource, name: "input_events", seals: [.sealed()],
                               holdingSealAt: { rotations.append("seal input") })
        let machine = machineDomain([.sealed()], gate: { rotations.append("seal machine") })
        let messages = messagesDomain([.nothingNew])
        _ = await makeShipper([machine, messages, input]).run(.timer)

        XCTAssertEqual(rotations.all, ["rotate", "seal input", "seal machine"])
        XCTAssertEqual(rows.all.filter { $0.outcome == "shipped" }.map(\.domain), ["input_events", "machine_events"])
    }

    func testAQuietDomainStatesItsReadThroughFiveMinutesAfterItLastSealedOrStatedOneAndSealsNothing() async throws {
        let input = ShippingFixture.inputSource
        let domain = FakeDomain(sourceId: input, name: "input_events", seals: [.sealed(), .quietWhenOwed])
        let shipper = makeShipper([domain], refresh: 60)
        var outcomes: [String] = []
        for minute in 0...11 {
            clock.move(to: Self.now.addingTimeInterval(Double(minute) * 60))
            outcomes.append(await shipper.run(.timer).outcome)
        }

        XCTAssertEqual(domain.requests.map(\.owesThrough), [true, false, false, false, false, true, false, false, false, false, true, false])
        XCTAssertEqual(outcomes, ["shipped"] + Array(repeating: "nothing_new", count: 11), "a read-through is no bundle")
        XCTAssertEqual(home.requests.filter { $0.method == "PUT" }.count, 1, "the one bundle, and no other upload")
        XCTAssertEqual(home.custody(input).received, 1)
        let said = home.throughs.map { $0[input] as? NSDictionary }
        XCTAssertEqual(said.count, 6, "said at every exchange from the one after the first statement")
        guard said.count == 6 else { return }
        XCTAssertEqual(said[0], ["read_through": "2026-09-22T23:05:00.000Z", "stated_at": "2026-09-22T23:05:00.000Z", "seal": 1] as NSDictionary)
        XCTAssertEqual(Array(said[1...4]), Array(repeating: said[0], count: 4), "said again, the same, until a newer one")
        XCTAssertEqual(said[5], ["read_through": "2026-09-22T23:10:00.000Z", "stated_at": "2026-09-22T23:10:00.000Z", "seal": 1] as NSDictionary)
    }

    func testAQuietDomainsCountIsStatedOnlyWhenItChanged() async throws {
        let input = ShippingFixture.inputSource
        let first = ["2026-08": Through.Month(items: 2, bytes: 10), "undated": Through.Month(items: 1, bytes: 0)]
        let grown = ["2026-08": Through.Month(items: 3, bytes: 12), "undated": Through.Month(items: 1, bytes: 0)]
        let domain = FakeDomain(sourceId: input, name: "input_events",
                                seals: [.quietCounted(first), .quietCounted(first), .quietCounted(grown)])
        let shipper = makeShipper([domain], refresh: 60)
        for minute in [0, 5, 10, 11] {
            clock.move(to: Self.now.addingTimeInterval(Double(minute) * 60))
            _ = await shipper.run(.timer)
        }
        var said: [(at: String, months: NSDictionary?)] = []
        for statement in home.throughs.compactMap({ $0[input] as? [String: Any] }) {
            let one = (at: statement["read_through"] as? String ?? "", months: statement["months"] as? NSDictionary)
            if said.last?.at != one.at { said.append(one) }
        }
        XCTAssertEqual(said.map(\.at), ["2026-09-22T23:00:00.000Z", "2026-09-22T23:05:00.000Z", "2026-09-22T23:10:00.000Z"])
        guard said.count == 3 else { return }
        XCTAssertEqual(said[0].months, ["2026-08": [2, 10], "undated": [1, 0]] as NSDictionary, "the first count was not stated")
        XCTAssertNil(said[1].months, "the same count was stated again")
        XCTAssertEqual(said[2].months, ["2026-08": [3, 12], "undated": [1, 0]] as NSDictionary, "a count that changed was not stated")
    }

    func testABundlesCountDeliveredIsNotStatedAgainAndAQuietCountThatChangedIs() async throws {
        let input = ShippingFixture.inputSource
        let first = ["2026-08": Through.Month(items: 2, bytes: 10), "undated": Through.Month(items: 1, bytes: 0)]
        let grown = ["2026-08": Through.Month(items: 3, bytes: 12), "undated": Through.Month(items: 1, bytes: 0)]
        let domain = FakeDomain(sourceId: input, name: "input_events",
                                seals: [.sealedCounted(first), .quietCounted(first), .quietCounted(grown)])
        let shipper = makeShipper([domain], refresh: 60)
        for minute in [0, 5, 10, 11] {
            clock.move(to: Self.now.addingTimeInterval(Double(minute) * 60))
            _ = await shipper.run(.timer)
            if minute == 0 { XCTAssertNil(link.monthsOwed(first, of: input), "delivered, it is the count the home holds") }
        }
        XCTAssertEqual(home.deliveries.first?.facts["months"] as? NSDictionary, ["2026-08": [2, 10], "undated": [1, 0]],
                       "the bundle carries the count the home had not kept")
        XCTAssertNil(link.monthsOwed(grown, of: input), "stated and taken, the grown count is the one the home holds")
        XCTAssertEqual(link.monthsOwed(first, of: input), first, "the older count is owed again once the home holds another")
        var said: [(at: String, months: NSDictionary?)] = []
        for statement in home.throughs.compactMap({ $0[input] as? [String: Any] }) {
            let one = (at: statement["read_through"] as? String ?? "", months: statement["months"] as? NSDictionary)
            if said.last?.at != one.at { said.append(one) }
        }
        XCTAssertEqual(said.map(\.at), ["2026-09-22T23:05:00.000Z", "2026-09-22T23:10:00.000Z"])
        guard said.count == 2 else { return }
        XCTAssertNil(said[0].months, "the quiet pass's count is the bundle's: not stated again")
        XCTAssertEqual(said[1].months, ["2026-08": [3, 12], "undated": [1, 0]] as NSDictionary, "a count that changed is stated")
    }

    func testAQuietSourcesReadThroughNamesWhatTheHomeReceived() async throws {
        let input = ShippingFixture.inputSource, machine = ShippingFixture.machineSource
        home.restore(input, received: 2, imported: 2)
        let spool = state.ledgers.ledger(SpoolEntry.self, pass: ShippingFixture.pass, source: input)
        try spool.record(SpoolEntry(items: ["a"]), at: 2)
        try spool.record(SpoolEntry(items: ["b"]), at: 3)
        let shipper = makeShipper([FakeDomain(sourceId: input, name: "input_events", seals: [.quietWhenOwed]),
                                   FakeDomain(sourceId: machine, name: "machine_events", seals: [.quietWhenOwed])])
        _ = await shipper.run(.timer)
        clock.move(by: 60)
        _ = await shipper.run(.timer)
        let said = try XCTUnwrap(home.throughs.last)
        XCTAssertEqual((said[input] as? [String: Any])?["seal"] as? Int, 2, "received, not the spent page's seal")
        XCTAssertEqual(said[machine] as? [String: String],
                       ["read_through": "2026-09-22T23:00:00.000Z", "stated_at": "2026-09-22T23:00:00.000Z"],
                       "nothing received, nothing pending: no seal")
    }

    func testASourceWithABundlePendingStatesNoReadThrough() async throws {
        let messages = ShippingFixture.messagesSource
        home.refuse(messages, (413, "ACQUISITION_TOO_LARGE"))
        let domain = messagesDomain([.sealed(), .quietWhenOwed])
        let shipper = makeShipper([domain], refresh: 60)
        for minute in 0...10 {
            clock.move(to: Self.now.addingTimeInterval(Double(minute) * 60))
            _ = await shipper.run(.timer)
        }
        XCTAssertEqual(domain.seals, 1, "its source waits behind its refused bundle")
        XCTAssertEqual(try state.pendingBundles().map(\.sidecar.seal), [1])
        XCTAssertTrue(home.throughs.isEmpty, "nothing stated past what the home has not taken")
    }

    func testASourceTheAnswerNoLongerStatesIsSaidNoMore() async throws {
        let input = ShippingFixture.inputSource
        let shipper = makeShipper([FakeDomain(sourceId: input, name: "input_events", seals: [.quietWhenOwed])])
        _ = await shipper.run(.timer)
        clock.move(by: 60)
        _ = await shipper.run(.timer)
        XCTAssertNotNil(home.throughs.last?[input], "stated, and said")

        home.sources.remove(input)
        clock.move(by: 60)
        _ = await shipper.run(.timer)
        clock.move(by: 60)
        _ = await shipper.run(.timer)
        XCTAssertEqual(home.throughs.count, 3)
        XCTAssertNotNil(home.throughs[1][input], "the exchange whose answer left it off still said it")
        XCTAssertEqual(home.throughs[2].count, 0, "the next says it no more")
    }

    func testASourceTheWatchsAnswerNoLongerStatesIsSaidNoMore() async throws {
        let input = ShippingFixture.inputSource
        let messages = ShippingFixture.messagesSource
        let shipper = makeShipper([FakeDomain(sourceId: input, name: "input_events", seals: [.quietWhenOwed]),
                                   messagesDomain([.quietWhenOwed])], refresh: 60)
        _ = await shipper.run(.timer)
        clock.move(by: 60)
        _ = await shipper.run(.timer)
        XCTAssertNotNil(home.throughs.last?[input], "stated, and said")
        XCTAssertNotNil(home.throughs.last?[messages], "stated, and said")
        let before = home.throughs.count

        home.sources.remove(input)
        clock.move(by: 60)
        _ = await shipper.knock()
        clock.move(by: 60)
        _ = await shipper.knock()
        clock.move(to: Self.now.addingTimeInterval(6 * 60))
        _ = await shipper.run(.timer)
        clock.move(by: 60)
        _ = await shipper.knock()

        let after = Array(home.throughs[before...])
        XCTAssertEqual(after.count, 4)
        guard after.count == 4 else { return }
        XCTAssertNotNil(after[0][input], "the watch's exchange whose answer left it off still said it")
        XCTAssertTrue(after[1...].allSatisfy { $0[input] == nil }, "the watch's next says it no more, nor does anything after")
        XCTAssertEqual(after[3][messages] as? [String: String],
                       ["read_through": "2026-09-22T23:06:00.000Z", "stated_at": "2026-09-22T23:06:00.000Z"],
                       "the source still delivered states anew, alone")
    }

    func testAReadThroughIsNeverSaidToAHomePairedSince() async throws {
        let input = ShippingFixture.inputSource
        let shipper = makeShipper([FakeDomain(sourceId: input, name: "input_events", seals: [.quietWhenOwed])], refresh: 60)
        _ = await shipper.run(.timer)
        clock.move(by: 60)
        _ = await shipper.run(.timer)
        XCTAssertEqual(home.throughs.last?[input] as? [String: String],
                       ["read_through": "2026-09-22T23:00:00.000Z", "stated_at": "2026-09-22T23:00:00.000Z"], "stated, and said")
        let before = home.throughs.count

        _ = try await link.pair(code: FakeHome.code, name: "https://second-home.example.ts.net")
        XCTAssertNotEqual(link.saved?.pass, ShippingFixture.pass, "a new pass: the home holds nothing of it")
        clock.move(by: 60)
        _ = await shipper.knock()
        _ = await shipper.knock()
        clock.move(by: 60)
        _ = await shipper.run(.timer)
        _ = await shipper.knock()

        let said = home.throughs[before...].compactMap { $0[input] as? [String: String] }
        XCTAssertEqual(said, [["read_through": "2026-09-22T23:03:00.000Z", "stated_at": "2026-09-22T23:03:00.000Z"]],
                       "nothing said to the new home until the source states anew against it")
    }

    func testAReadThroughIsNeverSaidToAHomeAnotherProcessPairedWith() async throws {
        let input = ShippingFixture.inputSource
        let credentials = MemoryCredentials()
        let app = try await ShippingFixture.link(home, folder: root.appendingPathComponent("app", isDirectory: true),
                                                 credentials: credentials)
        let shipper = makeShipper([FakeDomain(sourceId: input, name: "input_events", seals: [.quietWhenOwed])], refresh: 60,
                                  link: app)
        _ = await shipper.run(.timer)
        clock.move(by: 60)
        _ = await shipper.run(.timer)
        XCTAssertNotNil(home.throughs.last?[input], "stated, and said")

        let command = HomeLink(device: app.device, credentials: credentials,
                               folder: root.appendingPathComponent("command", isDirectory: true), transport: home, clock: home.clock, files: DeviceFiles(.plain))
        let paired = try await command.pair(code: FakeHome.code, name: "https://second-home.example.ts.net")
        home.forgetRequests()
        _ = await shipper.knock()
        _ = await shipper.knock()
        XCTAssertEqual(app.fresh?.pass, paired.pass, "the app's link went under the new pass")
        XCTAssertEqual(try said(input), [nil, nil], "no exchange to the new home says the last home's value, the first included")
    }

    func testAReadThatBeganBeforeAPairingStatesNothingToTheNewHome() async throws {
        let input = ShippingFixture.inputSource
        let meanwhile = Collected<@Sendable () async throws -> Void>()
        let domain = FakeDomain(sourceId: input, name: "input_events", seals: [.quietWhenOwed],
                                holdingSealAt: { whileReading(meanwhile) })
        let shipper = makeShipper([domain], refresh: 60)
        _ = await shipper.run(.timer)
        let link = self.link!
        meanwhile.append {
            _ = try await link.pair(code: FakeHome.code, name: "https://second-home.example.ts.net")
            await shipper.homeChanged()
        }
        clock.move(to: Self.now.addingTimeInterval(Shipper.throughInterval))
        _ = await shipper.run(.timer)
        XCTAssertEqual(domain.requests.last?.custody.pass, ShippingFixture.pass, "the read began under the first pairing")
        XCTAssertNotNil(domain.through, "and stated its read-through after the second")
        XCTAssertNotEqual(link.fresh?.pass, ShippingFixture.pass)

        home.forgetRequests()
        _ = await shipper.knock()
        XCTAssertEqual(try said(input), [nil], "the new home hears nothing of the read that began under the last")
        XCTAssertNil(link.through(of: input))
    }

    func testAReadThatBeganBeforeTheWatchLeftItsSourceOffStatesNothing() async throws {
        let input = ShippingFixture.inputSource
        let meanwhile = Collected<@Sendable () async throws -> Void>()
        let domain = FakeDomain(sourceId: input, name: "input_events", seals: [.quietWhenOwed],
                                holdingSealAt: { whileReading(meanwhile) })
        let shipper = makeShipper([domain], refresh: 60)
        _ = await shipper.run(.timer)
        let home = self.home!
        meanwhile.append {
            home.sources.remove(input)
            _ = await shipper.knock()
        }
        clock.move(to: Self.now.addingTimeInterval(Shipper.throughInterval))
        home.forgetRequests()
        _ = await shipper.run(.timer)
        XCTAssertNotNil(domain.through, "the read that ran across the watch's answer stated its read-through")
        _ = await shipper.knock()

        let first = ["read_through": "2026-09-22T23:00:00.000Z", "stated_at": "2026-09-22T23:00:00.000Z"]
        XCTAssertEqual(try said(input), [first, first, nil],
                       "the run's exchange and the watch's whose answer left it off say the first value; nothing after says any")
    }

    private func said(_ source: String) throws -> [[String: String]?] {
        try home.requests.filter { $0.url.path == "/v1/exchange" }.map { request in
            guard case .json(let data) = request.body else { return nil }
            let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            return (body?["through"] as? [String: Any])?[source] as? [String: String]
        }
    }


    func testNextRunIsNowUntilTheHomeWasEverAsked() async throws {
        let next = await makeShipper([machineDomain([.nothingNew])]).nextRun(after: Self.now)
        XCTAssertEqual(next, Self.now)
    }

    func testNextRunIsNowWhileNoAnswerIsSaved() async throws {
        let shipper = makeShipper([machineDomain([.nothingNew])])
        _ = await shipper.run(.timer)
        try FileManager.default.removeItem(at: root.appendingPathComponent("answer.json"))
        let next = await shipper.nextRun(after: Self.now.addingTimeInterval(60))
        XCTAssertEqual(next, Self.now.addingTimeInterval(60))
    }

    func testAnUnpairedMacRunsAgainOneIntervalLaterAndALaunchRunsAtOnce() async throws {
        let unpaired = HomeLink(device: link.device, credentials: MemoryCredentials(), folder: root, transport: home, files: DeviceFiles(.plain))
        try FileManager.default.removeItem(at: root.appendingPathComponent("answer.json"))
        let shipper = makeShipper([machineDomain([.nothingNew])], link: unpaired)
        let first = await shipper.nextRun(after: Self.now)
        XCTAssertEqual(first, Self.now, "the first run is now")
        let report = await shipper.run(.timer)
        XCTAssertEqual(report.outcome, "no_home")
        let next = await shipper.nextRun(after: Self.now)
        XCTAssertEqual(next, Self.now.addingTimeInterval(MacSettings.readerRefresh), "not again at once, forever")

        let relaunched = makeShipper([machineDomain([.nothingNew])], link: unpaired)
        let afterLaunch = await relaunched.nextRun(after: Self.now.addingTimeInterval(60))
        XCTAssertEqual(afterLaunch, Self.now.addingTimeInterval(60), "a launch with no answer saved runs now")
    }

    func testAHomeThatNeverAnsweredIsAskedAgainOneIntervalLater() async throws {
        try FileManager.default.removeItem(at: root.appendingPathComponent("answer.json"))
        home.silence()
        let shipper = makeShipper([machineDomain([.nothingNew])])
        let report = await shipper.run(.timer)
        XCTAssertEqual(report.outcome, "unreachable")
        let next = await shipper.nextRun(after: Self.now.addingTimeInterval(1))
        XCTAssertEqual(next, Self.now.addingTimeInterval(MacSettings.readerRefresh))
        await shipper.homeChanged()
        let changed = await shipper.nextRun(after: Self.now.addingTimeInterval(1))
        XCTAssertEqual(changed, Self.now.addingTimeInterval(1), "a new home or interval is tried at once")
    }

    func testNextRunIsTheIntervalAfterTheDomainsLastActOrThePendingRetry() async throws {
        try pairedLongAgo()
        let shipper = makeShipper([machineDomain([.nothingNew])])
        _ = await shipper.run(.timer)
        let next = await shipper.nextRun(after: Self.now)
        XCTAssertEqual(next, Self.now.addingTimeInterval(MacSettings.readerRefresh))

        let gate = home
        let parking = makeShipper([machineDomain([.sealed()], gate: { gate?.answerNext(503) })])
        clock.move(by: 300)
        _ = await parking.run(.timer)
        let retry = await parking.nextRun(after: clock.now)
        XCTAssertEqual(retry, clock.now.addingTimeInterval(Shipper.retryInterval))
    }

    func testASilentHomeIsAskedAgainOneIntervalLaterNotAtOnce() async throws {
        let shipper = makeShipper([machineDomain([.nothingNew])])
        _ = await shipper.run(.timer)
        clock.move(by: 600)
        home.silence()
        let report = await shipper.run(.timer)
        XCTAssertEqual(report.outcome, "unreachable")
        let next = await shipper.nextRun(after: clock.now)
        XCTAssertEqual(next, clock.now.addingTimeInterval(MacSettings.readerRefresh), "one interval after the silent run")
        await shipper.homeChanged()
        let changed = await shipper.nextRun(after: clock.now)
        XCTAssertEqual(changed, clock.now, "a new home or interval is tried at once")
    }

    func testASecondRunWhileOneIsInProgressAnswersBusy() async throws {
        let gate = RunGate()
        home.gate = { @Sendable in await gate.hold() }
        let domain = machineDomain([.nothingNew])
        let shipper = makeShipper([domain])

        async let first = shipper.run(.timer)
        do {
            try await until("await gate.reached") { await gate.reached }
        } catch {
            await gate.open()
            _ = await first
            throw error
        }
        let second = await shipper.run(.timer)
        await gate.open()
        let held = await first

        XCTAssertEqual(second.outcome, "busy")
        XCTAssertEqual(held.outcome, "nothing_new")
        XCTAssertEqual(domain.seals, 1)
    }

    func testAnAnswersSettingsRunAtOnceAndAChangeIsStatedInAnotherExchange() async throws {
        home.settings = ["machine": ["refresh": "5m"], "input": ["refresh": "5m"],
                         "imessage": ["refresh": "2m", "start_ms": 1_779_235_200_000]]
        let settings = MacSettings(file: DomainFixtures.settingsFile, files: DeviceFiles(.plain))
        let applied = Collected<String>()
        let home = self.home!
        settings.changed = { connector in
            await Task.yield()
            applied.append("\(connector) after \(home.requests.filter { $0.url.path == "/v1/exchange" }.count)")
        }
        let shipper = makeShipper([machineDomain([.nothingNew, .nothingNew])], settings: settings)
        _ = await shipper.run(.timer)
        XCTAssertEqual(applied.all, ["imessage after 1"],
                       "a change was stated before it was applied, or one that changed nothing applied")
        XCTAssertEqual(settings.refresh(of: "imessage"), 120, "the answer's refresh did not run")
        XCTAssertEqual(settings.start(of: "imessage"), Date(timeIntervalSince1970: 1_779_235_200))
        XCTAssertEqual(settings.statement()["imessage"], ["refresh": .string("2m")], "the start is read, never stated back")
        XCTAssertEqual(methods.filter { $0 == "POST /v1/exchange" }.count, 2, "a change of what is stated waited for the next run")
        clock.move(by: 300)
        _ = await shipper.run(.timer)
        XCTAssertEqual(methods.filter { $0 == "POST /v1/exchange" }.count, 3, "an answer that changed nothing was exchanged again")
    }

    func testADomainIsReadAtItsConnectorsRefreshNeverUnderAMinute() async {
        let settings = MacSettings(file: DomainFixtures.settingsFile, files: DeviceFiles(.plain))
        XCTAssertEqual(settings.refresh(of: "imessage"), 300, "before the home gives one")
        await settings.take(["imessage": ["refresh": .string("2m")], "chrome": ["refresh": .string("10s")], "screen": ["refresh": .string("2s")]])
        XCTAssertEqual(settings.refresh(of: "imessage"), 120)
        XCTAssertEqual(settings.refresh(of: "chrome"), 60, "under a minute")
        XCTAssertEqual(settings.refresh(of: "screen"), 300, "the capture interval ships the spool")
        XCTAssertEqual(settings.refresh(of: "machine"), 300, "a connector with no refresh")
        XCTAssertEqual(MacSettings.readerRefresh, Shipper.throughInterval, "a quiet domain is asked as often as its read-through is owed")
    }

    func testAStoresSettingsAreItsConnectorsWhateverProductItsSourceNames() async throws {
        let notes = "example-notes:local:unit-0001"
        let home = FakeHome(sources: [notes], clock: clock.read)
        let link = try await ShippingFixture.link(home, folder: root.appendingPathComponent("importer", isDirectory: true))
        let imessage = try XCTUnwrap(try StoreFixtures.all()["imessage"])
        let stores = try StoreFixtures.stores(home: root.appendingPathComponent("mac", isDirectory: true),
                                              state: root.appendingPathComponent("stores", isDirectory: true), declarations: [
                                                  "example-importer": HomeLink.DeclaredStore(app: nil, grants: [], product: "example-notes",
                                                                                             store: imessage.store)])
        home.settings = ["example-importer": ["refresh": "2m", "start_ms": 1_779_235_200_000],
                         "example-notes": ["refresh": "1h", "start_ms": NSNull()]]
        try pairedLongAgo()
        let domain = FakeDomain(sourceId: notes, name: "example_notes", seals: [.quietLeft(4)])
        let shipper = makeShipper([domain], settings: MacSettings(file: DomainFixtures.settingsFile, files: DeviceFiles(.plain)), link: link, stores: stores)
        _ = await shipper.run(.timer)
        XCTAssertEqual(domain.requests.last?.start, Date(timeIntervalSince1970: 1_779_235_200), "its start was not its connector's")
        clock.move(by: 120)
        _ = await shipper.run(.timer)
        XCTAssertEqual(domain.seals, 2, "it was not read at its connector's refresh")
        let said = try XCTUnwrap(home.throughs.last?[notes] as? [String: Any])
        XCTAssertEqual(said["left"] as? Int, 4)
        XCTAssertEqual(said["start_ms"] as? Int, 1_779_235_200_000, "left was stated without the start it was counted under")
    }


    func testAStampRunsItsSourceOnceLiveAndOnlyANewerOneRunsAgain() async throws {
        try grownUp([ShippingFixture.machineSource, ShippingFixture.messagesSource])
        let machine = machineDomain([.sealed(), .nothingNew])
        let messages = messagesDomain([.sealed(kind: "changes")])
        let shipper = makeShipper([machine, messages])
        _ = await shipper.run(.timer)
        XCTAssertEqual([machine.seals, messages.seals], [1, 1])
        XCTAssertEqual(messages.requests.last?.custody.history, true)
        let acted = state.readSchedule().domains[ShippingFixture.messagesSource]?.actedAt

        clock.move(by: 60)
        home.refresh = [ShippingFixture.messagesSource: 1_000, "whatsapp:local:unit-0001": 1_000]
        _ = await shipper.knock()
        let due = await shipper.nextRun(after: clock.now)
        XCTAssertEqual(due, clock.now, "a stamp the knock heard waited for its source's refresh")
        _ = await shipper.run(.timer)
        XCTAssertEqual(machine.seals, 1, "a source no stamp names was read before its refresh")
        XCTAssertEqual(messages.seals, 2, "the stamped source was not read")
        XCTAssertEqual(messages.requests.last?.custody.history, false, "a refresh read history")
        XCTAssertEqual(state.readSchedule().domains[ShippingFixture.messagesSource]?.actedAt, acted, "a refresh moved its source's clock")
        XCTAssertEqual(home.custody(ShippingFixture.messagesSource).received, 2, "what the refresh read was not sent")

        clock.move(by: 30)
        _ = await shipper.run(.timer)
        XCTAssertEqual(messages.seals, 2, "the same stamp carried again was read again")
        let later = await shipper.nextRun(after: clock.now)
        XCTAssertGreaterThan(later, clock.now, "a stamp already read still asks for a run")

        let relaunched = makeShipper([machine, messages])
        _ = await relaunched.run(.timer)
        XCTAssertEqual(messages.seals, 2, "a launch read a stamp already read")

        home.refresh = [ShippingFixture.messagesSource: 2_000]
        _ = await relaunched.run(.timer)
        XCTAssertEqual(messages.seals, 3, "a newer stamp was not read")
        XCTAssertEqual(machine.seals, 1)
    }

    func testAPressHereReadsItsSourcesAloneAndOneAskedDuringARunIsReadOnce() async throws {
        try grownUp([ShippingFixture.machineSource, ShippingFixture.messagesSource])
        let machine = machineDomain([.sealed(), .sealed()])
        let messages = messagesDomain([.sealed(kind: "changes")])
        let shipper = makeShipper([machine, messages])
        _ = await shipper.run(.timer)
        let sources = await shipper.sources(of: "imessage")
        XCTAssertEqual(sources, [ShippingFixture.messagesSource])
        let none = await shipper.sources(of: "whatsapp")
        XCTAssertEqual(none, [])

        clock.move(by: 600)
        await shipper.ask(sources)
        let asked = await shipper.nextRun(after: clock.now)
        XCTAssertEqual(asked, clock.now)
        let report = await shipper.run(.now)
        XCTAssertEqual(report.outcome, "shipped")
        XCTAssertEqual(machine.seals, 1, "a press read a source it did not ask for")
        XCTAssertEqual(messages.seals, 2)
        XCTAssertEqual(messages.requests.last?.custody.history, false, "a press read history")
        _ = await shipper.run(.now)
        XCTAssertEqual(messages.seals, 2, "one press was read twice")

        _ = await shipper.run(.manual)
        XCTAssertEqual([machine.seals, messages.seals], [2, 3])
        clock.move(by: 60)
        let gate = RunGate()
        home.gate = { @Sendable in await gate.hold() }
        async let first = shipper.run(.timer)
        do {
            try await until("await gate.reached") { await gate.reached }
        } catch {
            await gate.open()
            _ = await first
            throw error
        }
        await shipper.ask(sources)
        let busy = await shipper.run(.now)
        XCTAssertEqual(busy.outcome, "busy")
        home.gate = nil
        await gate.open()
        _ = await first
        XCTAssertEqual(messages.seals, 4, "a press during a run was not read")
        XCTAssertEqual(machine.seals, 2, "a source not asked for, and not due, was read")
        let after = await shipper.nextRun(after: clock.now)
        XCTAssertGreaterThan(after, clock.now, "a press already read still asks for a run")
    }

    @MainActor
    func testTheStatusNamesTheHomeAndReadsThePassOffTheMainThread() async throws {
        let watch = MainThreadWatch()
        let watched = try await ShippingFixture.link(home, folder: root, credentials: watch)
        let status = await makeShipper([], link: watched).status()
        XCTAssertEqual(status.home?.absoluteString, ShippingFixture.name)
        XCTAssertTrue(status.paired)
        XCTAssertEqual(watch.mainThreadReads, 0, "the pass is never read on the main thread")

        let unpaired = HomeLink(device: link.device, credentials: MainThreadWatch(), folder: root, transport: home, files: DeviceFiles(.plain))
        let none = await makeShipper([], link: unpaired).status()
        XCTAssertNil(none.home)
        XCTAssertFalse(none.paired)
    }

    func testTheKnockSaysWhetherTheHomeAnsweredAndTheLinkWhatTheDoorSaid() async throws {
        let shipper = makeShipper([])
        let before = await shipper.status().answerAsked
        XCTAssertNil(before, "an answer asked before any exchange")
        let asked = clock.now
        let answered = await shipper.knock()
        XCTAssertEqual(answered, true)
        let first = await shipper.status().answerAsked
        XCTAssertEqual(first, asked, "the status says when the answered exchange was asked")
        XCTAssertEqual(link.snapshot.reach, .answering)
        clock.move(to: asked.addingTimeInterval(60))
        home.silence()
        let silent = await shipper.knock()
        XCTAssertEqual(silent, false)
        let kept = await shipper.status().answerAsked
        XCTAssertEqual(kept, asked)
        XCTAssertEqual(link.snapshot.reach, .waiting(since: clock.now), "one exchange with no answer is a wait, inside the grace")
        home.speak()
        home.answerNext(503)
        let busy = await shipper.knock()
        XCTAssertEqual(busy, false, "a not-now is no answer")
        home.answerNext(503, said: ["message": "Lifestream's database is damaged. A check found damage in home.db.",
                                    "wait": "needs", "title": "Lifestream's database is damaged.",
                                    "line": "A check found damage in home.db.",
                                    "acts": [["do": "verify", "label": "Check again"]]])
        let holding = await shipper.knock()
        XCTAssertEqual(holding, false)
        guard case .held(let held) = link.snapshot.reach else { return XCTFail("a held home read as no hold: \(link.snapshot.reach)") }
        XCTAssertEqual(held.title, "Lifestream's database is damaged.")
        XCTAssertEqual(held.detail, "A check found damage in home.db.")
        XCTAssertEqual(held.acts.map(\.do), [.verify])
        XCTAssertEqual(held.acts.map(\.label), ["Check again"])
        let unpaired = HomeLink(device: link.device, credentials: MemoryCredentials(), folder: root, transport: home, files: DeviceFiles(.plain))
        let none = await makeShipper([], link: unpaired).knock()
        XCTAssertNil(none)
    }

    func testAnExchangesStartIsToldOnlyBesideItsSavedAnswer() async throws {
        let folder = root.appendingPathComponent("link-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let own = try await ShippingFixture.link(home, folder: folder)
        let shipper = makeShipper([], link: own)
        let asked = clock.now
        _ = await shipper.knock()
        let saved = await shipper.status()
        XCTAssertEqual(saved.answerAsked, asked)
        clock.move(to: asked.addingTimeInterval(60))
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: folder.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.path) }
        let answered = await shipper.knock()
        XCTAssertEqual(answered, true)
        let refused = await shipper.status()
        XCTAssertEqual(refused.lastContactAt, saved.lastContactAt, "the answer was saved after all")
        XCTAssertNil(refused.answerAsked, "the later start told beside the older answer")
    }

    func testAHeldAskTheDoorNeverAnswersHoldsNothingAtItsBound() async throws {
        let hex = ShippingFixture.hash("a")
        home.holds = ["sha256:" + hex]
        let held = Shipper.held(link, within: 0.5)
        let ask = { await withCheckedContinuation { asked in DispatchQueue.global().async { asked.resume(returning: held([hex])) } } }
        home.heldUnanswered = true
        let started = Date()
        let unanswered = await ask()
        XCTAssertEqual(unanswered, [], "no answer holds nothing")
        XCTAssertLessThan(Date().timeIntervalSince(started), 10, "the seal's thread went on at the bound")
        home.heldUnanswered = false
        let answered = await ask()
        XCTAssertEqual(answered, [hex], "a door that answers is believed")
    }
}

private func whileReading(_ meanwhile: Collected<@Sendable () async throws -> Void>) {
    let steps = meanwhile.all
    meanwhile.clear()
    for step in steps {
        let done = DispatchSemaphore(value: 0)
        Task {
            do { try await step() } catch { XCTFail("a step while the domain reads: \(error)") }
            done.signal()
        }
        if done.wait(timeout: .now() + 30) == .timedOut { XCTFail("a step while the domain reads did not end within 30 s") }
    }
}
