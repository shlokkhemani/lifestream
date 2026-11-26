import XCTest

@MainActor
final class AskFlowUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testAskServerNotAnswering() throws {
        let app = launch("--ui-test-ask-down")
        let line = app.descendants(matching: .any)["ask.unreachable"].firstMatch
        line.appears("the line says Ask can't be reached")
        XCTAssertTrue(text(app, "Chat isn't answering on your Mac").exists, "the door's words for `ASK_DOWN`")
        XCTAssertFalse(app.buttons["Send"].isEnabled, "the composer waits")
        XCTAssertEqual(app.buttons.matching(identifier: "ask.chat").count, 0, "no list is drawn")
        let page = app.descendants(matching: .any)["ask.home"].firstMatch
        XCTAssertEqual(page.frame.width, app.windows.firstMatch.frame.width, accuracy: 1,
                       "with nothing over the composer, the page still takes the screen's width")
        shot(app, 9, "ask-unreachable")
    }


    func testJourneyPick() throws {
        let app = launch()
        let chip = app.buttons["ask.pick"].firstMatch
        chip.appears("the chip in the composer")
        until("the chip names the default: \(chip.value ?? "")") { chip.value as? String == "GPT-6.1 Terra, High" }

        chip.tap()
        let reset = item(app, "Reset to default")
        reset.appears("the menu of thinking and model")
        XCTAssertFalse(reset.isEnabled, "Reset does nothing while no pick is kept")
        XCTAssertTrue(item(app, "Extra high").exists, "Terra's levels")
        pickModel(app, "GPT-6 Sol")
        until("the model picked is drawn at its own level: \(chip.value ?? "")") { chip.value as? String == "GPT-6 Sol, Medium" }
        chip.tap()
        item(app, "Low").appears("Sol's levels")
        XCTAssertFalse(item(app, "Extra high").exists, "only the levels the model takes")
        XCTAssertTrue(item(app, "Reset to default").isEnabled, "a pick is kept: Reset forgets it")
        shot(app, 10, "ask-pick")
        item(app, "Low").tap()
        until("the chip says the pick: \(chip.value ?? "")") { chip.value as? String == "GPT-6 Sol, Low" }

        let level = app.buttons["ask.level"].firstMatch
        level.appears("the level chip beside the model chip")
        until("the level chip names Chat's setting: \(level.value ?? "")") { level.value as? String == "Hide all" }
        level.tap()
        item(app, "Keep names").appears("the level chip's menu")
        XCTAssertTrue(item(app, "Sensitive information").exists, "its title")
        XCTAssertTrue(item(app, "Don’t hide").exists)
        XCTAssertFalse(item(app, "Reset to default").exists, "its own menu, not the model chip's")
        shot(app, 24, "ask-level")
        item(app, "Keep names").tap()
        until("the level chip says the pick: \(level.value ?? "")") { level.value as? String == "Keep names" }

        send(app, "When did I last have dinner with Person A?")
        app.descendants(matching: .any)["ask.thread"].firstMatch.appears("the conversation opens")
        thought(app).firstMatch.appears("the turn answered")
        until("the level chip keeps the pick in the conversation: \(level.value ?? "")") { level.value as? String == "Keep names" }

        chip.tap()
        pickModel(app, "GPT-6 Luna")
        until("Luna drawn at the level kept: \(chip.value ?? "")") { chip.value as? String == "GPT-6 Luna, Low" }
        send(app, "And who paid?")
        until("the next turn answered too") { thought(app).count == 2 }

        chip.tap()
        item(app, "Reset to default").tap()
        until("the default drawn: \(chip.value ?? "")") { chip.value as? String == "GPT-6.1 Terra, High" }
        chip.tap()
        until("Reset dims with nothing kept") { item(app, "Reset to default").exists && !item(app, "Reset to default").isEnabled }
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.3)).tap()
        item(app, "Reset to default").vanishes("the menu closes")

        send(app, "Use my sign-in to answer")
        let foot = app.descendants(matching: .any)["ask.said"].firstMatch
        foot.appears("readiness read again: the foot says the sign-in is missing")
        XCTAssertTrue(text(app, "Chat needs your Claude sign-in on your Mac.").exists)
        text(app, "Use my sign-in to answer").appears("the question stays")
        until("the composer waits") { !composer(app).isEnabled }
        let said = app.staticTexts.matching(NSPredicate(format: "label == %@", "Chat needs your Claude sign-in on your Mac."))
        XCTAssertEqual(said.count, 1, "said once, by the foot")
        XCTAssertFalse(text(app, "ChatGPT sign-in").exists, "never the phone's own words")
        app.terminate()

        let refused = launch("--ui-test-ask-claude-refused")
        let picker = refused.buttons["ask.pick"].firstMatch
        until("the chip names the default: \(picker.value ?? "")") { picker.value as? String == "GPT-6.1 Terra, High" }
        XCTAssertTrue(composer(refused).isEnabled, "the default answers: the composer is ready")
        picker.tap()
        let models = item(refused, "Model")
        models.appears("the menu's Model row")
        models.tap()
        let sol = refused.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "GPT-6 Sol")).firstMatch
        sol.appears("a model row: its name alone")
        XCTAssertTrue(refused.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Qwen 3.5 9B")).firstMatch.exists,
                      "a local model by its name")
        XCTAssertFalse(item(refused, "Claude Opus 5.5").exists, "a model that can't answer now is left out")
        let more = item(refused, "More")
        more.comesToRest("More where the opened Model menu leaves it")
        more.tap()
        let find = refused.descendants(matching: .any)["ask.models.find"].firstMatch
        find.appears("More opens the search")
        refused.descendants(matching: .any)["models.find.claude:claude-haiku-5-5"].firstMatch.appears("the home's found models")
        shot(refused, 11, "ask-more")
        refused.swipeAway(find)
        until("the chip still names the default: \(picker.value ?? "")") { picker.value as? String == "GPT-6.1 Terra, High" }
        send(refused, "When did I last have dinner with Person A?")
        thought(refused).firstMatch.appears("the default answered")
        refused.terminate()

        let signedOut = launch("--ui-test-ask-signin")
        signedOut.descendants(matching: .any)["ask.said"].firstMatch.appears("the line says the sign-in is missing")
        XCTAssertTrue(text(signedOut, "Chat needs your Claude sign-in on your Mac.").exists)
        XCTAssertFalse(composer(signedOut).isEnabled, "the composer waits")
        let chosen = signedOut.buttons["ask.pick"].firstMatch
        until("the chip names the home's default, not ready: \(chosen.value ?? "")") { chosen.value as? String == "Claude Opus 5.5, High" }
        shot(signedOut, 12, "ask-signin")
    }

    func testAFreshHomeBeginsFromItsStarters() throws {
        let app = launch("--ui-test-ask-fresh")
        let starters = app.buttons.matching(identifier: "ask.starter")
        until("the home's three starters: \(starters.count)") { starters.count == 3 }
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier == 'ask.starter' AND label CONTAINS 'How far did I walk today?'")).firstMatch.exists,
                      "the home's words")
        XCTAssertTrue(app.descendants(matching: .any)["ask.heading"].firstMatch.exists, "the heading over the starters")
        shot(app, 13, "ask-fresh")
        starters.firstMatch.tap()
        app.descendants(matching: .any)["ask.thread"].firstMatch.appears("the starter is asked")
        text(app, "Where have I been today?").appears("its question")
    }

    func testTheKeyboardGoes() throws {
        let app = launch("--ui-test-ask-fresh")
        let page = app.descendants(matching: .any)["ask.home"].firstMatch
        page.appears("the blank page")
        until("the home's starters") { app.buttons.matching(identifier: "ask.starter").count == 3 }
        letsKeyboardGo(app, on: page, "the blank page")

        app.buttons.matching(identifier: "ask.starter").firstMatch.tap()
        let thread = app.descendants(matching: .any)["ask.thread"].firstMatch
        thread.appears("the starter is asked")
        letsKeyboardGo(app, on: thread, "a conversation")
    }


    func testJourneyAsk() throws {
        let app = launch()

        XCTAssertTrue(app.tab("Chat").isSelected, "the app opens on Ask")
        app.buttons["ask.pick"].firstMatch.appears("the chip in the composer")
        app.descendants(matching: .any)["ask.heading"].firstMatch.appears("the heading over the composer")
        XCTAssertTrue(text(app, "What shall we look back on?").exists, "its words")
        XCTAssertEqual(app.buttons.matching(identifier: "ask.starter").count, 0, "a home asked before: no starter")
        XCTAssertEqual(app.buttons.matching(identifier: "ask.chat").count, 0, "the drawer is shut")
        shot(app, 1, "ask-home")

        send(app, "When did I last have dinner with Person A?")
        app.descendants(matching: .any)["ask.thread"].firstMatch.appears("the conversation opens")
        app.buttons["Stop"].appears("the circle is Stop while it runs")
        text(app, "Searching messages").appears("the step under way")
        shot(app, 2, "ask-running")
        text(app, "Let me look at the photos too").appears("words before a step: the work line's next phrase")
        text(app, "Person A sent a photo").appears("the answer")
        XCTAssertFalse(text(app, "Let me look at the photos too").exists, "words before a step are folded away")
        let steps = thought(app).firstMatch
        steps.appears("done: how long it thought")
        XCTAssertTrue(app.buttons["Send"].exists, "the circle is Send again")
        shot(app, 3, "ask-answer")
        steps.tap()
        text(app, "Looked at 1 photo").appears("the steps disclosed")
        shot(app, 4, "ask-steps")
        steps.tap()

        let source = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Source 1'")).firstMatch
        source.appears("the first source is a button of its own")
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Source 2'")).firstMatch.appears("the photo is the second source")
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Source 3'")).firstMatch.exists, "two messages of one chat stand as one source")
        source.tap()
        let inspector = app.descendants(matching: .any)["inspector"].firstMatch
        inspector.appears("the capsule opens its moment")
        shot(app, 5, "ask-moment")
        app.swipeAway(inspector)

        send(app, "Tell me everything about the week")
        text(app, "Here is everything").appears("the answer runs")
        app.buttons["Stop"].tap()
        text(app, "Stopped").appears("Stopped")
        XCTAssertTrue(text(app, "Here is everything").exists, "its words kept")
        shot(app, 6, "ask-stopped")

        send(app, "Open the broken link")
        text(app, "ChatGPT didn't answer: this Mac can't reach it.").appears("what failed, in the Ask server's words")
        XCTAssertTrue(app.buttons["Try again"].exists)
        XCTAssertFalse(text(app, "connection was reset").exists, "never the raw error")
        shot(app, 7, "ask-failed")

        app.buttons["ask.new"].tap()
        app.descendants(matching: .any)["ask.home"].firstMatch.appears("New conversation brings the blank page back")
        app.keyboards.firstMatch.appears("New conversation: the composer takes the focus")
        openDrawer(app)
        app.keyboards.firstMatch.vanishes("the drawer takes the keyboard down")
        XCTAssertTrue(app.descendants(matching: .any)["ask.conversations"].firstMatch.exists, "the drawer still shows")
        shot(app, 8, "ask-drawer")
        row(app, "Dinner with Person A on Friday").tap()
        text(app, "And who paid?").appears("its last question")
        text(app, "You did").appears("its answer")
        XCTAssertFalse(app.descendants(matching: .any)["ask.conversations"].firstMatch.exists, "the drawer shuts")
        shot(app, 14, "ask-history")
        openDrawer(app)
        row(app, "What Person B said").tap()
        text(app, "Stopped").appears("a stopped answer says so")
        openDrawer(app)
        row(app, "Sleep this week").tap()
        text(app, "Not saved yet").appears("an answer not on disk says so")
        XCTAssertTrue(text(app, "Your three longest nights").exists, "its answer, as it ended")
        XCTAssertFalse(app.buttons["Try again"].exists, "nothing to press: asking again would ask the model twice")
        openDrawer(app)
        let search = app.searchFields["Search"].exists ? app.searchFields["Search"] : app.textFields["Search"]
        app.type("visa", into: search)
        until("only the visa guide: \(app.buttons.matching(identifier: "ask.chat").count)") {
            app.buttons.matching(identifier: "ask.chat").count == 1 && row(app, "The visa guide").exists
        }
        app.type("zzz", into: search)
        text(app, "Nothing matches \u{201C}visazzz\u{201D}.").appears("a search that keeps none says so")
        app.buttons["ask.drawer.new"].tap()
        app.descendants(matching: .any)["ask.home"].firstMatch.appears("New conversation, from the drawer")
        openDrawer(app)
        row(app, "Booking at Synthetic Cafe").tap()
        text(app, "On a Monday, by mail.").appears()
        openDrawer(app)
        row(app, "A call with Person A").tap()
        let eye = app.buttons["ask.seen"].firstMatch
        eye.appears("an answer whose model read a placeholder has its eye")
        XCTAssertFalse(eye.isSelected, "the person's words first")
        eye.tap()
        text(app, "[[Person").appears("the question reads as the model read it")
        XCTAssertTrue(eye.isSelected, "the eye says it is on")
        XCTAssertFalse(text(app, "When did Person A").exists, "the name is gone from the question")
        shot(app, 15, "ask-model-saw")
        eye.tap()
        text(app, "When did Person A last call?").appears("pressed again, the person's words come back")
        text(app, "[[Person").vanishes("no placeholder is left")
        app.tab("Chat").tap()
        app.descendants(matching: .any)["ask.home"].firstMatch.appears("Chat pressed in a conversation brings the blank page back")

        send(app, "When did I last have dinner with Person A?")
        app.buttons["Stop"].appears()
        XCUIDevice.shared.press(.home)
        app.activate()
        thought(app).firstMatch.appears("the turn followed again to its end")
        XCTAssertTrue(text(app, "Person A sent a photo").exists, "its answer")
    }


    func testJourneyPhotos() throws {
        let app = launch("--ui-test-picked-photo")
        app.buttons["ask.pick"].firstMatch.appears("readiness read: the composer takes a question")
        let pictures = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Picture'"))
        let sending = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Picture' AND value == 'Sending'"))
        add(app, "Photo Library")
        until("two pictures over the words: \(pictures.count)") { pictures.count == 2 }
        sending.firstMatch.appears("drawn sending while they go to the home")
        shot(app, 15, "ask-photo-uploading")
        sending.firstMatch.vanishes("ready once the stage answers")
        shot(app, 16, "ask-photo-ready")
        add(app, "Photo Library")
        XCTAssertEqual(pictures.count, 2, "the same photos again are attached once")

        add(app, "Choose File")
        text(app, "Lifestream can't read this picture.").appears("the door's words for a picture it can't read")
        shot(app, 17, "ask-photo-unreadable")
        app.buttons.matching(NSPredicate(format: "label == 'Remove the picture'")).element(boundBy: 2).tap()
        text(app, "Lifestream can't read this picture.").vanishes("its × takes it out")
        add(app, "Choose File")
        text(app, "Too large to send: over 25 MB.").appears("refused at pick")
        shot(app, 18, "ask-photo-too-large")
        app.buttons.matching(NSPredicate(format: "label == 'Remove the picture'")).element(boundBy: 2).tap()
        text(app, "Too large to send").vanishes()
        XCTAssertEqual(pictures.count, 2)

        send(app, "Where did I take these?")
        app.descendants(matching: .any)["ask.thread"].firstMatch.appears("the conversation opens")
        app.descendants(matching: .any)["ask.question.photos"].firstMatch.appears("its photos over the question, at once")
        text(app, "Person A sent a photo").appears("the answer")
        shot(app, 19, "ask-photo-sent")
    }


    func testAnAnswersVoiceNotePlays() throws {
        let app = launch()
        openDrawer(app)
        let booking = row(app, "Table booking")
        booking.appears("the drawer's list read")
        booking.tap()
        let bar = app.descendants(matching: .any)["ask.voice"].firstMatch
        bar.appears("the cited voice note's bar under its sentence")
        XCTAssertTrue(bar.staticTexts["0:06"].exists, "its length, as the citation states it")
        bar.buttons["Play"].firstMatch.tap()
        bar.buttons["Pause"].firstMatch.appears("it plays where it was cited")
        shot(app, 23, "ask-voice-cited")
        bar.buttons["Pause"].firstMatch.tap()
        bar.buttons["Play"].firstMatch.appears("paused")
    }

    func testJourneyVoiceNote() throws {
        let app = launch()
        app.buttons["ask.pick"].firstMatch.appears("readiness read: the composer takes a question")
        app.type("Typed and kept", into: composer(app))
        app.buttons["Record a voice note"].firstMatch.tap()
        let stop = app.buttons["Stop recording"].firstMatch
        stop.appears("the composer becomes the recorder")
        text(app, "0:02").appears("its time runs")
        shot(app, 20, "ask-voice-recording")
        app.buttons["Cancel the voice note"].firstMatch.tap()
        stop.vanishes("× lets it go")
        XCTAssertEqual(composer(app).value as? String, "Typed and kept", "the words wait in the field")

        app.buttons["Record a voice note"].firstMatch.tap()
        text(app, "0:02").appears("recording again")
        stop.tap()
        app.descendants(matching: .any)["ask.thread"].firstMatch.appears("the conversation opens")
        app.descendants(matching: .any)["ask.question.voice"].firstMatch.appears("its player in the question, at once")
        text(app, "Writing it out…").appears("writing it out until its words")
        shot(app, 21, "ask-voice-writing")
        text(app, "Where did I have dinner with Person A last week?").appears("its words under the player")
        text(app, "Writing it out…").vanishes()
        text(app, "Person A sent a photo").appears("the answer")
        shot(app, 22, "ask-voice-words")
        XCTAssertEqual(composer(app).value as? String, "Typed and kept", "the typed words stay in the field")
    }

    func testVoiceRowSaysWhereANoteGoes() throws {
        let app = launch("--ui-test-voice-cloud")
        let chip = app.buttons["ask.pick"].firstMatch
        chip.appears("readiness read")
        let caution = text(app, "sound can't be hidden")
        openVoice(app)
        caution.appears("the caution's words over its routes while the cloud route is chosen")
        shot(app, 23, "ask-voice-caution")
        item(app, "Parakeet · your Mac").tap()
        caution.vanishes("the menu closes")
        until("the cloud route's caution gone from the voice row") {
            openVoice(app)
            if !caution.exists { return true }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.3)).tap()
            return false
        }
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.3)).tap()
        item(app, "Parakeet · your Mac").vanishes("the menu closes")
    }

    private func openVoice(_ app: XCUIApplication) {
        app.buttons["ask.pick"].firstMatch.tap()
        let voice = item(app, "Voice")
        voice.appears("the chip's menu holds the voice row")
        voice.tap()
        let route = item(app, "Parakeet · your Mac")
        var seen = false
        var last = CGRect.null
        until("the voice row open on its routes, at rest: \(route.exists ? "\(route.frame)" : "folded")") {
            guard route.exists else {
                if seen, voice.exists, voice.isHittable {
                    voice.tap()
                    seen = false
                }
                last = .null
                return false
            }
            seen = true
            let now = route.frame
            defer { last = now }
            return now == last && route.isHittable
        }
    }

    func testMicWithNoVoiceModelSaysTheFix() throws {
        let app = launch("--ui-test-voice-none")
        app.buttons["ask.pick"].firstMatch.appears("readiness read")
        app.buttons["Record a voice note"].firstMatch.tap()
        text(app, "Choose a model for Voice notes").appears("the home's line, over the composer")
        XCTAssertFalse(app.buttons["Stop recording"].exists, "nothing recorded")
    }

    private func add(_ app: XCUIApplication, _ words: String) {
        app.buttons["Add a picture"].firstMatch.tap()
        let row = item(app, words)
        row.appears("the + menu's row")
        row.tap()
        row.vanishes("the menu closes")
    }


    private func launch(_ more: String...) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--ui-test-reset", "--ui-test-started", "--ui-test-dark-appearance"] + more
        app.launch()
        app.awaitShell()
        return app
    }

    private func composer(_ app: XCUIApplication) -> XCUIElement {
        app.textViews["Ask"].exists ? app.textViews["Ask"] : app.textFields["Ask"]
    }

    private func send(_ app: XCUIApplication, _ question: String) {
        let field = composer(app)
        field.appears("the composer")
        app.type(question, into: field)
        app.buttons["Send"].tap()
    }

    private func letsKeyboardGo(_ app: XCUIApplication, on page: XCUIElement, _ where: String) {
        let keyboard = app.keyboards.firstMatch
        app.focus(composer(app))
        keyboard.appears("the composer takes the keyboard: \(`where`)")
        let origin = app.coordinate(withNormalizedOffset: .zero)
        func dragDown(from y: CGFloat) {
            origin.withOffset(CGVector(dx: app.frame.midX, dy: y)).drag(to: origin.withOffset(CGVector(dx: app.frame.midX, dy: y + 200)))
        }
        dragDown(from: app.frame.height * 0.2)
        composer(app).typeText("a" + XCUIKeyboardKey.delete.rawValue)
        dragDown(from: composer(app).frame.minY - 30)
        keyboard.vanishes("a drag down from just over the composer takes the keyboard down: \(`where`)")
        app.focus(composer(app))
        keyboard.appears("the composer takes the keyboard again: \(`where`)")
        page.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        keyboard.vanishes("a tap outside the composer puts the keyboard away: \(`where`)")
    }

    private func item(_ app: XCUIApplication, _ words: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", words, words + ",")).firstMatch
    }

    private func pickModel(_ app: XCUIApplication, _ name: String) {
        let model = item(app, "Model")
        model.appears("the menu's Model row")
        model.tap()
        let picked = item(app, name)
        picked.appears("\(name) in the models")
        picked.comesToRest("\(name) where the opened Model menu leaves it")
        picked.tap()
        item(app, name).vanishes("the menu closes")
    }

    private func thought(_ app: XCUIApplication) -> XCUIElementQuery {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Thought for'"))
    }

    private func openDrawer(_ app: XCUIApplication) {
        app.buttons["ask.conversations.open"].firstMatch.tap()
        app.descendants(matching: .any)["ask.conversations"].firstMatch.appears("the drawer of conversations")
    }

    private func row(_ app: XCUIApplication, _ title: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier == 'ask.chat' AND label BEGINSWITH %@", title)).firstMatch
    }

    private func text(_ app: XCUIApplication, _ words: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
    }

    private func shot(_ app: XCUIApplication, _ slot: Int, _ name: String) {
        let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".build/shots/ask/dark")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent(String(format: "%02d-%@.png", slot, name))
        XCTAssertNoThrow(try XCUIScreen.main.screenshot().pngRepresentation.write(to: file), file.path)
    }
}
