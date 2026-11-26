import XCTest

@MainActor
final class StreamDialogUITests: XCTestCase {
    private var report: HomeReport!

    override func setUpWithError() throws {
        continueAfterFailure = false
        report = try HomeReport()
    }

    func testJourneyAHomeConnectorsPageSaysTheReportsPartsAndAChangeIsTaken() throws {
        let gmail = try report.connector("gmail")
        let refreshMember = try HomeReport.member(gmail, "refresh")
        let app = launch(open: "streams")
        app.rootHead("Connectors").appears()
        let gmailRow = app.buttons["home-connector.gmail"].firstMatch
        gmailRow.appears("the home's connectors are read")
        XCTAssertTrue(app.buttons["machinery.library"].firstMatch.exists, "this phone's Photos among the connectors")
        keep("00-streams")
        app.openMachinery("home-connector.gmail")
        app.expandSheet()
        let figure = gmail["figure"] as? [String: Any]
        XCTAssertEqual(figure?["today"] as? Int, 0, "the canned home counts no email today")
        let emails = (gmail["noun"] as? [String])?.last ?? ""
        app.staticTexts["No \(emails) today · \(HomeReport.said(figure, "words"))"].appears("the head's line: today, then the home's words")
        let sheet = app.descendants(matching: .any)["connector.detail"].firstMatch
        XCTAssertTrue(sheet.buttons["Close"].exists, "a connector's sheet closes by its ×, as every sheet")
        let head = sheet.staticTexts[HomeReport.said(gmail, "name")].firstMatch
        XCTAssertLessThan(head.frame.minY - app.sheetGrabber().frame.minY, 48, "the head under the grabber, no bar between: \(head.frame)")
        for title in ["Where it goes", "What it costs", "What it records"] {
            XCTAssertFalse(app.staticTexts[title].exists, "no trust row: \(title)")
        }
        let state = app.descendants(matching: .any)["connector.detail.state"].firstMatch
        XCTAssertTrue(state.label.contains(HomeReport.said(HomeReport.health(gmail), "words")), state.label)
        XCTAssertNil(gmail["history"] as? [String: Any], "the report gives Gmail no history")
        XCTAssertFalse(tabbed(app), "one page, no tabs")
        let comesFrom = sheet.part("Comes from")
        let settingsPart = sheet.part("Settings")
        let week = app.descendants(matching: .any)["connector.detail.week"].firstMatch
        XCTAssertTrue(week.exists, "the figure")
        app.bringIntoView(comesFrom)
        XCTAssertLessThan(week.frame.maxY, comesFrom.frame.minY, "the figure, then Comes from")
        let account = try XCTUnwrap(gmail["account"] as? [String: Any])
        let copies = gmail["copies"] as? [[String: Any]] ?? []
        if copies.count == 1 {
            let row = app.descendants(matching: .any)["connector.detail.source.\(HomeReport.said(copies[0], "name"))"].firstMatch
            XCTAssertTrue(row.exists, "the one source's row")
            XCTAssertTrue(row.label.hasPrefix(HomeReport.said(account, "name")) && row.label.contains(HomeReport.said(copies[0], "line")),
                          "the account named, the source's line under it: \(row.label)")
        } else {
            let accountRow = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", HomeReport.said(account, "line"))).firstMatch
            XCTAssertTrue(accountRow.exists, "the account's row")
            XCTAssertTrue(accountRow.label.hasPrefix(HomeReport.said(account, "name")), "the account: \(accountRow.label)")
            for copy in copies {
                let row = app.descendants(matching: .any)["connector.detail.source.\(HomeReport.said(copy, "name"))"].firstMatch
                XCTAssertTrue(row.label.contains(HomeReport.said(copy, "line")), "the copy: \(row.label)")
            }
        }
        XCTAssertTrue(app.buttons["connector.detail.import"].exists, "its export's row, Show opening the kind's window")
        for key in ["account", "password"] {
            XCTAssertFalse(app.staticTexts[HomeReport.said(try HomeReport.member(gmail, key), "label")].exists, "\(key) is no setting")
        }
        keep("01-gmail")

        let refresh = app.buttons["connector.setting.refresh"].firstMatch
        app.bringIntoView(refresh)
        XCTAssertLessThan(comesFrom.frame.maxY, settingsPart.frame.minY, "Comes from, then Settings")
        XCTAssertLessThan(settingsPart.frame.maxY, refresh.frame.minY, "Settings' rows under its label")
        XCTAssertTrue(app.buttons["connector.detail.pause"].firstMatch.exists, "the foot under it all")
        XCTAssertEqual(refresh.value as? String, HomeReport.said(refreshMember, "words"))
        let steps = refreshMember["steps"] as? [[String: Any]] ?? []
        let next = try XCTUnwrap(steps.last { $0["value"] as? String != refreshMember["value"] as? String }, "another step")
        refresh.tap()
        app.menuItem(HomeReport.said(steps.first, "words")).appears("the menu opens at its first step")
        keep("02-refresh-menu")
        app.menuItem(HomeReport.said(next, "words")).tap()
        until("the home took it: \(String(describing: refresh.value))") { refresh.value as? String == HomeReport.said(next, "words") }
        XCTAssertTrue(head.exists && settingsPart.exists, "a change keeps the page")
        keep("03-refresh-taken")
        app.closeConnectorDetail()

        app.openMachinery("home-connector.google-calendar", notConnected: true)
        app.expandSheet()
        let step = app.descendants(matching: .any)["connector.detail.connect"].firstMatch
        step.appears("a connector not set up: its steps")
        XCTAssertFalse(sheet.part("Settings").exists, "no section before it is set up")
        XCTAssertFalse(app.buttons["connector.setting.calendars"].exists, "its settings wait for it to be set up")
        keep("04-calendar-steps")
        app.closeConnectorDetail()

        let whatsapp = try report.connector("whatsapp")
        let quiet = try HomeReport.member(whatsapp, "groups_quiet_after")
        let quietSteps = quiet["steps"] as? [[String: Any]] ?? []
        let other = try XCTUnwrap(quietSteps.last { $0["value"] as? String != quiet["value"] as? String }, "another step")
        app.openMachinery("home-connector.whatsapp")
        app.expandSheet()
        let pause = app.buttons["connector.detail.pause"].firstMatch
        XCTAssertFalse(tabbed(app), "no tabs: one page")
        XCTAssertFalse(sheet.part("Groups").exists, "the groups' rows are Settings'")
        XCTAssertTrue(app.descendants(matching: .any)["connector.detail.week"].firstMatch.exists, "the figure")
        let parts = ["Comes from", "Settings", "AI", "History"].map(sheet.part)
        for (part, name) in zip(parts, ["Comes from", "Settings", "AI", "History"]) { XCTAssertTrue(part.exists, "\(name) on the page") }
        for (above, below) in zip(parts, parts.dropFirst()) {
            XCTAssertLessThan(above.frame.minY, below.frame.minY, "\(above.label) above \(below.label)")
        }
        let after = app.buttons["connector.setting.groups_quiet_after"].firstMatch
        XCTAssertLessThan(parts[1].frame.maxY, after.frame.minY, "Quiet after under Settings")
        XCTAssertLessThan(after.frame.maxY, parts[2].frame.minY, "and above AI")
        let voice = app.descendants(matching: .any)["connector.ai.llm.voice"].firstMatch
        let needs = try XCTUnwrap((whatsapp["processing"] as? [String: Any])?["rows"] as? [[String: Any]])
            .first { $0["member"] as? String == "llm.voice" }
        XCTAssertTrue(voice.label.contains(HomeReport.said(needs, "line")), "the work needing a model says so on its row: \(voice.label)")
        keep("05-whatsapp-page")
        let top = app.sheetGrabber().frame.minY

        app.bringIntoView(after)
        after.tap()
        app.menuItem(HomeReport.said(other, "words")).tap()
        until("the home took it: \(String(describing: after.value))") { after.value as? String == HomeReport.said(other, "words") }
        XCTAssertTrue(parts[1].exists && !app.buttons["drawer.back"].exists, "a change keeps the page")
        XCTAssertEqual(app.sheetGrabber().frame.minY, top, accuracy: 1, "the sheet stands where it stood")

        let photosMember = try HomeReport.member(whatsapp, "llm.photos")
        let models = try XCTUnwrap((photosMember["menu"] as? [String: Any])?["rows"] as? [[String: Any]])
        let model = try XCTUnwrap(models.last.flatMap { $0["name"] as? String })
        app.openAI("llm.photos")
        let back = app.buttons["drawer.back"].firstMatch
        XCTAssertEqual(back.label, "Back to \(HomeReport.said(whatsapp, "name"))")
        XCTAssertFalse(parts[0].exists, "the work's page alone")
        let photos = app.buttons["connector.setting.llm.photos"].firstMatch
        app.bringIntoView(photos)
        photos.tap()
        let choice = app.menuItem(model)
        choice.appears("the work's menu")
        keep("06-ai-page-menu")
        choice.tap()
        until("the home took it: \(String(describing: photos.value))") { photos.value as? String == model }
        XCTAssertTrue(back.exists, "a change keeps the work's page")
        back.tap()
        parts[2].appears("back on WhatsApp's page")
        XCTAssertEqual(app.sheetGrabber().frame.minY, top, accuracy: 1, "the sheet stands where it stood")
        app.bringIntoView(app.descendants(matching: .any)["connector.detail.backfill"].firstMatch)
        app.bringIntoView(pause)
        keep("07-whatsapp-history")
        app.closeConnectorDetail()
        app.openMachinery("home-connector.whatsapp")
        pause.appears("opened again")
        XCTAssertFalse(app.buttons["drawer.back"].exists, "opened again on its own page, no work pushed")

        XCTAssertEqual(pause.label, "Pause")
        let off = app.buttons["connector.detail.turnOff"].firstMatch
        XCTAssertEqual(off.label, "Disconnect")
        pause.tap()
        until("its pause of it all stands: \(pause.label)") { pause.label == "Resume" }
        app.descendants(matching: .any)["connector.detail.paused"].firstMatch.appears("the paused callout under the head")
        keep("08-foot-paused")
        pause.tap()
        until("resumed: \(pause.label)") { pause.label == "Pause" }

        off.tap()
        let ask = app.staticTexts["Disconnect \(HomeReport.said(whatsapp, "name"))?"].firstMatch
        ask.appears("asked once more before it disconnects")
        keep("09-disconnect-ask")
        app.otherElements["PopoverDismissRegion"].firstMatch.tap()
        ask.vanishes("a tap beside the question takes it back")
        off.tap()
        app.buttons["connector.detail.turnOff.confirm"].firstMatch.tap()
        off.vanishes("disconnected: every copy off, nothing left to disconnect")
        pause.appears("its Pause stays")
        app.closeConnectorDetail()

        app.openMachinery("machinery.library")
        app.expandSheet()
        let authorization = app.descendants(matching: .any)["photos.authorization"].firstMatch
        authorization.appears("the permission on Photos' page")
        let copied = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Last copied")).firstMatch
        app.bringIntoView(copied)
        XCTAssertLessThan(authorization.frame.maxY, copied.frame.minY, "the permission, then Photos' own part")
        keep("10-photos-page")
        let photosStream = try report.connector("apple-photos")
        let backfillSentence = app.staticTexts[HomeReport.said(photosStream, "backfill_about")].firstMatch
        let status = app.descendants(matching: .any)["connector.detail.backfill"].firstMatch
        app.bringIntoView(status)
        XCTAssertTrue(backfillSentence.exists, "History's sentence in words")
        XCTAssertLessThan(copied.frame.maxY, status.frame.minY, "History under Photos' own part")
        XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "About History")).firstMatch.exists,
                       "no info mark: the sentence says it")
        app.bringIntoView(pause)
        keep("11-photos-history")
        app.closeConnectorDetail()

        app.openMachinery("machinery.location")
        app.expandSheet()
        let permission = app.descendants(matching: .any)["permissions.row.location"].firstMatch
        let allow = app.buttons["Allow"].firstMatch
        permission.appears("the permission's row")
        XCTAssertTrue(allow.exists, "the permission's row and its Allow")
        XCTAssertTrue(permission.frame.insetBy(dx: 0, dy: 1).contains(CGPoint(x: allow.frame.midX, y: allow.frame.midY)),
                      "Allow at the row's end: \(allow.frame) in \(permission.frame)")
        let precision = app.buttons["location.precision"].firstMatch
        let foot = app.buttons["connector.detail.pause"].firstMatch
        XCTAssertTrue(foot.exists, "the foot")
        app.bringIntoView(precision, and: foot)
        XCTAssertTrue(permission.exists, "one page: the permission and Precision together")
        XCTAssertLessThan(permission.frame.maxY, precision.frame.minY, "the permission, then Settings")
        XCTAssertEqual(precision.value as? String, "Precise")
        let mark = app.buttons["About Precision"].firstMatch
        mark.appears("the info mark, once the home draws the member this phone states")
        mark.tap()
        let sentence = app.staticTexts[HomeReport.said(try HomeReport.member(try report.connector("location"), "precision"), "about")]
        sentence.appears("the info mark's sentence")
        var last = CGRect.null
        until("the popover settled: \(sentence.frame)") {
            let now = sentence.frame
            defer { last = now }
            return now == last && sentence.isHittable
        }
        XCTAssertLessThan(sentence.frame.maxY, foot.frame.minY, "the tip never stands over the foot")
        XCTAssertTrue(app.frame.contains(sentence.frame), "the whole sentence on screen: \(sentence.frame)")
        XCTAssertGreaterThan(sentence.frame.height, 30, "the sentence on its lines, never cut to one: \(sentence.frame)")
        keep("12-precision-about")
        mark.tap()
        sentence.vanishes("the tip closes")
        precision.tap()
        app.menuItem("Battery saving").tap()
        until("applied at once") { precision.value as? String == "Battery saving" }
        settings(app, "the home took it and the phone states it: \(said(app))") { $0.home("location", "precision") == "battery" && $0.phone("location", "precision") == "battery" }
        keep("13-precision-battery")
        app.bringIntoView(foot)
        foot.tap()
        until("the home's Location paused from this phone's page: \(foot.label)") { foot.label == "Resume" }
        keep("14-phone-source-paused")
    }


    private func tabbed(_ app: XCUIApplication) -> Bool {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "connector.tab.")).firstMatch.exists
    }


    private struct Said {
        let object: [String: Any]

        func home(_ connector: String, _ member: String) -> String? { value("home", connector, member) }
        func phone(_ connector: String, _ member: String) -> String? { value("phone", connector, member) }

        private func value(_ side: String, _ connector: String, _ member: String) -> String? {
            guard let raw = ((object[side] as? [String: Any])?[connector] as? [String: Any])?[member] else { return nil }
            if let on = raw as? Bool { return on ? "true" : "false" }
            return raw as? String
        }
    }

    private func said(_ app: XCUIApplication) -> String {
        app.descendants(matching: .any)["ui-test.settings"].firstMatch.label
    }

    private func settings(_ app: XCUIApplication, _ what: @autoclosure () -> String, file: StaticString = #filePath, line: UInt = #line,
                          _ holds: (Said) -> Bool) {
        until(what(), file: file, line: line) {
            let said = self.said(app)
            guard let object = (try? JSONSerialization.jsonObject(with: Data(said.utf8))) as? [String: Any] else { return false }
            return holds(Said(object: object))
        }
    }
}
