#if os(macOS)
import SwiftUI
@testable import Cockpit


private let ladder: [MenuRow<String>.Option] = [
    .init("5m", "Every 5 minutes"), .init("15m", "Every 15 minutes"), .init("30m", "Every 30 minutes"),
    .init("1h", "Every hour"), .init("6h", "Every 6 hours"), .init("1d", "Daily"),
]

private let precision: [MenuRow<String>.Option] = [
    .init("precise", "Precise"), .init("battery", "Battery saving", note: "Fewer points, less battery"),
]

private let models: [MenuRow<String>.Option] = [
    .init("default", "Default · Vision One"), .init("openrouter", "Vision One"),
    .init("runner", "Qwen 3.5", group: "Local"),
    .init("\n", "More", apart: true, opens: true), .init("off", "Off"),
]

private let askModels: [MenuRow<String>.Option] = [
    .init("claude/opus", "Opus 5.5", note: "Claude"), .init("openrouter/opus", "Opus 5.5", note: "OpenRouter"), .init("gpt-6.2-sol", "GPT-6.2 Sol"),
    .init("runner", "Qwen 3.5 9B", group: "Local"),
    .init("\n", "More", apart: true, opens: true),
]

private let about = "Battery saving records where you stay and each move of a few hundred metres, not every street."

@MainActor let menuRowSheet = Sheet("menu-row", ios: 390, mac: 420, hosted: true) {
    Specimen("At rest · pressed (the Mac's hover) · busy") {
        VStack(alignment: .trailing, spacing: Cockpit.Space.s2) {
            MenuRow("Refresh rate", selection: .constant("30m"), options: ladder, default: "5m")
            set(MenuRow("Refresh rate", selection: .constant("30m"), options: ladder, default: "5m"), \.forced, .pressed)
            MenuRow("Refresh rate", selection: .constant("30m"), options: ladder, default: "5m", busy: true)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
    Specimen("Open: the chosen checked, a note under its words, Default quiet") {
        set(MenuRow("Precision", selection: .constant("precise"), options: precision, default: "precise"), \.forcedOpen, true)
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.bottom, 132)
    }
    Specimen("Open: a stream's model menu, names only, Local under its header, More, Off last") {
        set(MenuRow("Photo descriptions", selection: .constant("default"), options: models), \.forcedOpen, true)
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.bottom, 250)
    }
    Specimen("Open: Chat's models, a name held twice with its account under it") {
        set(MenuRow("Model", selection: .constant("claude/opus"), options: askModels), \.forcedOpen, true)
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.bottom, 250)
    }
    Specimen("A value off the ladder, said as it is; long words") {
        VStack(alignment: .trailing, spacing: Cockpit.Space.s2) {
            MenuRow("Range", selection: .constant("200d"), options: [.init("all", "All time"), .init("200d", "Last 200 days")], default: "all")
            MenuRow("Order", selection: .constant("relevance"), options: [.init("newest", "Newest"), .init("relevance", "Relevance")])
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
    Specimen("A pill: the one order control, a list's order and Notes'; pressed") {
        HStack(spacing: Cockpit.Space.s3) {
            MenuRow("Order", selection: .constant("newest"), options: [.init("newest", "Newest"), .init("relevance", "Relevance")],
                    default: "newest", pill: true)
            MenuRow("Sort notes", selection: .constant("edited"), options: [.init("edited", "Date edited"), .init("title", "Title")],
                    words: "Edited", pill: true)
            set(MenuRow("Order", selection: .constant("relevance"), options: [.init("newest", "Newest"), .init("relevance", "Relevance")],
                        pill: true), \.forced, .pressed)
        }
        .fixedSize()
    }
    Specimen("MonthMenu: Trips' year, a month of Days; open on the months, each year a section") {
        VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
            MonthMenu("Year", shown: .constant(.init(year: 2026)), months: [2026, 2025, 2024].map { .init(year: $0) })
            set(MenuRow("Month", selection: .constant(MonthMenu.Month(year: 2026, month: 11)),
                        options: [11, 10, 9].map { .init(MonthMenu.Month(year: 2026, month: $0), MonthMenu.Month(year: 2026, month: $0).name, group: "2026") }
                            + [.init(MonthMenu.Month(year: 2025, month: 12), "December", group: "2025")],
                        words: "November 2026", pill: true), \.forcedOpen, true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 250)
    }
    Specimen("A prompt while nothing is chosen (Edit’s Not a person?), no item checked") {
        MenuRow("Not a person?", selection: .constant(String?.none),
                options: [.init("AI", "AI"), .init("A business", "A business"), .init("An automated sender", "An automated sender")],
                prompt: "Not a person?")
    }
    OnPhone {
        Specimen("Accessibility size (AX3): the capsule grows with its words") {
            MenuRow("Refresh rate", selection: .constant("30m"), options: ladder, default: "5m")
                .frame(maxWidth: .infinity, alignment: .trailing)
                .environment(\.dynamicTypeSize, .accessibility3)
        }
    }
}

@MainActor let infoMarkSheet = Sheet("info-mark", hosted: true) {
    Specimen("After a label") {
        HStack(spacing: Cockpit.Space.s1) {
            Text("Precision").cockpit(.rowTitle).foregroundStyle(Cockpit.Color.text)
            InfoMark(about, label: "Precision")
        }
    }
    Specimen("Pressed: its sentence") {
        HStack(spacing: Cockpit.Space.s1) {
            Text("Precision").cockpit(.rowTitle).foregroundStyle(Cockpit.Color.text)
            set(InfoMark(about, label: "Precision"), \.forcedOpen, true)
        }
        .padding(.bottom, 96)
    }
}

private let backfillSteps: [MenuRow<String>.Option] = [
    .init("30s", "1 batch every 30 sec"), .init("1m", "1 batch a minute"), .init("2m", "1 batch every 2 min"),
    .init("5m", "1 batch every 5 min"), .init("1h", "1 batch an hour"),
]
private let reaches: [MenuRow<String>.Option] = [.init("all", "All time"), .init("90d", "Last 90 days")]

@MainActor let historySheet = Sheet("history", hosted: true) {
    Specimen("History while it reads: its line, Range and Pace") {
        SheetPart(nil) {
            ListRow("History", meta: "Back to Aug 2010 · 12,400 emails left · about 2 days") { EmptyView() }
            SettingRow("Range") {
                MenuRow("Range", selection: .constant("all"), options: reaches, default: "all")
            }
            SettingRow("Pace", separator: false) {
                MenuRow("Pace", selection: .constant("1m"), options: backfillSteps, default: "1m")
            }
        }
    }
    Specimen("Paged by a device: no Pace") {
        SheetPart(nil) {
            ListRow("History", meta: "Back to Mar 2019 · 12,000 messages left · about 20 min") { EmptyView() }
            SettingRow("Range", separator: false) {
                MenuRow("Range", selection: .constant("all"), options: reaches, default: "all")
            }
        }
    }
}

@MainActor let calloutSheet = Sheet("callout") {
    Specimen("Stopped, its act · busy") {
        VStack(spacing: Cockpit.Space.s2) {
            Callout("Couldn't sync Claude", detail: "Chrome didn't answer. Lifestream tries again in 4 min.", signal: .warning, action: "Try now")
            Callout("Couldn't sync Claude", detail: "Chrome didn't answer.", signal: .warning, action: "Syncing…", busy: true)
        }
    }
    Specimen("An offer: the home's choice, its first primary") {
        Callout("Another Claude account",
                detail: "Lifestream reads person-a@example.com. Read person-b@example.com too, or switch Claude back to person-a@example.com in Chrome.",
                signal: .caution, acts: [.init("Read it too", id: "read"), .init("Not this one", id: "ignore")])
            .frame(width: 360)
    }
    Specimen("Needs you · paused · off") {
        VStack(spacing: Cockpit.Space.s2) {
            Callout("Sign in to ChatGPT", detail: "In Chrome, where the Lifestream extension reads it.", signal: .caution)
            Callout("Paused", detail: "Paused from Connectors.", signal: .idle, action: "Resume")
            Callout("Every source is turned off", signal: .idle, action: "Turn on")
        }
    }
    Specimen("Not set up: what connecting it takes, the last step's button") {
        Callout("Connect Gmail", steps: ["Turn on 2-Step Verification for your Google account.",
                                         "Make an app password at myaccount.google.com/apppasswords."],
                action: "Sign in", primary: true)
    }
    Specimen("Long words: the act goes under them") {
        Callout("Lifestream needs Full Disk Access to read Messages on this Mac",
                detail: "Open System Settings, Privacy and Security, Full Disk Access, and switch on Lifestream.",
                signal: .caution, action: "Open System Settings…")
            .frame(width: 320)
    }
}

@MainActor let addRowSheet = Sheet("add-row", hosted: true) {
    Specimen("Things on or off, then the add row: empty · typed") {
        SectionGround {
            SheetPart(nil) {
                SettingRow("All Mail") { Toggle("All Mail", isOn: .constant(true)).labelsHidden().toggleStyle(.cockpit) }
                SettingRow("Spam") { Toggle("Spam", isOn: .constant(false)).labelsHidden().toggleStyle(.cockpit) }
                AddRow("Add a folder", text: .constant("")) {}
            }
            SheetPart(nil) {
                AddRow("Add a folder", text: .constant("Receipts")) {}
            }
        }
    }
    Specimen("On a card, the last of its rows (Edit’s Theirs): empty · lit · typed") {
        VStack(spacing: NameRow.gap) {
            NameRow("+1 555 000 0001", line: "Contacts", lead: .icon(.call), end: .remove("Remove") {}) {}
            AddRow("Add a number, email, link or person", text: .constant(""), field: true) {}
            set(AddRow("Add a number, email, link or person", text: .constant(""), field: true) {}, \.forcedLit, true)
            AddRow("Add a number, email, link or person", text: .constant("@sam.rivera"), field: true) {}
        }
        .padding(Cockpit.Space.s4)
        .background(RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous).fill(Cockpit.Color.surface))
    }
    OnPhone {
        Specimen("Accessibility size (AX3): the placeholder wraps") {
            AddRow("Add a number, email, link or person", text: .constant(""), field: true) {}
                .environment(\.dynamicTypeSize, .accessibility3)
        }
    }
}
private struct SectionGround<Content: View>: View {
    @ViewBuilder let content: Content
    @Environment(\.cockpitPlatform) private var platform

    var body: some View {
        if platform == .mac {
            VStack(alignment: .leading, spacing: 0) { content }
                .padding(.horizontal, Cockpit.Space.s6)
                .padding(.vertical, Cockpit.Space.s5)
                .background(RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous).fill(Cockpit.Color.surface))
        } else {
            VStack(alignment: .leading, spacing: 0) { content }
        }
    }
}

private struct Touched: View {
    let row: SettingRow<SettingValue, EmptyView>
    @Environment(\.cockpitPlatform) private var platform
    init(_ row: () -> SettingRow<SettingValue, EmptyView>) { self.row = row() }
    var body: some View {
        var row = row
        row.forced = .touched(platform)
        return row
    }
}

private let themes: [MenuRow<String>.Option] = [.init("system", "System"), .init("light", "Light"), .init("dark", "Dark")]
private let browsers: [MenuRow<String>.Option] = [.init("chrome", "Chrome"), .init("arc", "Arc"), .init("safari", "Safari")]
private let keepFor: [MenuRow<String>.Option] = [.init("30d", "30 days"), .init("1y", "A year"), .init("all", "Forever")]

@MainActor let settingsSheet = Sheet("settings", ios: 390, mac: 600, hosted: true) {
    Specimen("A section: its heading and line; a switch, a menu with its note, a value, a status, two buttons, a state before its act") {
        SectionGround {
            SheetPart("Recording", line: "What this Mac records while you use it. Each stream keeps its own settings.") {
                SettingRow("Record the screen", line: "A frame when what you see changes") {
                    Toggle("Record the screen", isOn: .constant(true)).labelsHidden().toggleStyle(.cockpit)
                }
                SettingRow("Record audio during calls") {
                    Toggle("Record audio during calls", isOn: .constant(false)).labelsHidden().toggleStyle(.cockpit)
                }
                SettingRow("Browser", line: "Where the extension runs errands in your own profile") {
                    MenuRow("Browser", selection: .constant("chrome"), options: browsers, default: "chrome", note: "Default")
                }
                SettingRow("Keep recordings", line: "Older frames are deleted; what was read from them stays") {
                    MenuRow("Keep recordings", selection: .constant("1y"), options: keepFor, default: "all")
                }
                SettingRow("Folder", value: "All Mail")
                SettingRow("Hiding model", value: "Downloaded", done: true, line: "Finds names Lifestream has never seen · 1.6 GB")
                SettingRow("Home", value: "Running", state: .engaged, line: "On this Mac")
                SettingRow("This Mac", line: "Pairs again with the home's new code") {
                    HStack(spacing: Cockpit.Space.s2) {
                        Button("Forget") {}.buttonStyle(.cockpit(.plain))
                        Button("Pair again") {}.buttonStyle(.cockpit(.secondary))
                    }
                }
                SettingRow("OpenRouter key", line: "Pay as you go, with a key from openrouter.ai/keys.", separator: false) {
                    HStack(spacing: Cockpit.Space.s2) {
                        SettingValue("Not set")
                        Button("Add key") {}.buttonStyle(.cockpit(.secondary))
                    }
                }
            }
        }
    }
    Specimen("Leads: a tile, a state's shape; a tag; a progress line") {
        SectionGround {
            SheetPart("On MacBook Pro") {
                SettingRow("Speech", line: "Turns calls and voice notes into words · 1.6 GB", lead: .icon(.audio)) {
                    Button("Download") {}.buttonStyle(.cockpit(.secondary))
                }
                SettingRow("Hiding model", line: "Downloading, 0.3 of 0.7 GB", lead: .icon(.screen), tag: "English first", progress: 0.41) {
                    Button("Cancel") {}.buttonStyle(.cockpit(.plain))
                }
                SettingRow("Runner", line: "Couldn't start · Try again in 4 min", separator: false, lead: .signal(.warning)) {
                    Button("Try now") {}.buttonStyle(.cockpit(.secondary))
                }
            }
        }
    }
    Specimen("Rows that open something: a value before the chevron; one under the pointer (the finger on iPhone)") {
        SectionGround {
            SheetPart("Devices") {
                SettingRow("This Mac", line: "Screen, audio, machine", opens: {}) { SettingValue("3 streams") }
                Touched { SettingRow("iPhone 17 Pro", line: "Last sent 2 min ago", opens: {}) { SettingValue("5 streams") } }
                SettingRow("Chrome", line: "Synced 19:02", signal: .engaged, separator: false, opens: {})
            }
        }
    }
    Specimen("What a row holds: a device waiting, which devices follow it, a problem, where it is changed") {
        SectionGround {
            SheetPart("Location", about: about) {
                SettingRow("Precision", waiting: "Waiting for iPhone 17 Pro · Open Lifestream on it to sync.",
                           line: "How closely your iPhone follows where you go") {
                    MenuRow("Precision", selection: .constant("battery"), options: precision, default: "precise")
                }
                SettingRow("Refresh rate", only: "On MacBook Pro") {
                    MenuRow("Refresh rate", selection: .constant("5m"), options: ladder, default: "5m")
                }
                SettingRow("Bedtime", problem: "Can't reach Lifestream") {
                    MenuRow("Bedtime", selection: .constant("23:00"), options: [.init("23:00", "23:00")], busy: true)
                }
                SettingRow("Apps and sites", value: "2 never", note: "Change it on your Mac.", separator: false)
            }
        }
    }
    Specimen("Asking once more in the row's place; the add row last") {
        SectionGround {
            SheetPart("Folders") {
                SettingRow("All Mail") { Toggle("All Mail", isOn: .constant(true)).labelsHidden().toggleStyle(.cockpit) }
                SettingRow("Remove Receipts?", line: "Its mail stays in Lifestream; nothing new is read from it.", asking: true) {
                    HStack(spacing: Cockpit.Space.s2) {
                        Button("Not now") {}.buttonStyle(.cockpit(.plain))
                        Button("Remove") {}.buttonStyle(.cockpit(.secondary, tone: .warning))
                    }
                }
                AddRow("Add a folder", text: .constant("")) {}
            }
        }
    }
    Specimen("A part a tab is named for: no heading; a long title and line wrap") {
        SectionGround {
            SheetPart(nil) {
                SettingRow("Theme") { MenuRow("Theme", selection: .constant("dark"), options: themes) }
                SettingRow("Mark a stretch of use after this many minutes in one app",
                           line: "A stretch shorter than this stays in the day, unmarked, as every other minute does.", separator: false) {
                    ValueStepper("Mark after", value: .constant(30), steps: [5, 10, 15, 30, 60]) { "\($0) min" }
                }
            }
        }
    }
    Specimen("Fields: a key at the end; a name typed under the line; a section that holds nothing draws nothing") {
        SectionGround {
            SheetPart("Keys") {
                SettingRow("OpenRouter key", line: "Pay as you go, with a key from openrouter.ai/keys.", fieldEnd: true) {
                    Field("OpenRouter key", text: .constant(""), placeholder: "sk-or-…")
                }
                SettingRow("Custom address", line: "A model your own machine serves", separator: false) {
                    Button("Save") {}.buttonStyle(.cockpit(.secondary))
                } held: {
                    Field("Address", text: .constant("http://127.0.0.1:11434/v1"))
                }
            }
            SheetPart("Nothing found") { EmptyView() }
        }
    }
    OnPhone {
        Specimen("Accessibility size (AX3): the end under the words at the row's width") {
            SectionGround {
                SheetPart("Recording") {
                    SettingRow("Browser", line: "Where the extension runs errands") {
                        MenuRow("Browser", selection: .constant("chrome"), options: browsers, default: "chrome")
                    }
                    SettingRow("Keep recordings") {
                        MenuRow("Keep recordings", selection: .constant("1y"), options: keepFor, words: "Every recording since you started")
                    }
                    SettingRow("This Mac", line: "Pairs again with the home's new code") {
                        HStack(spacing: Cockpit.Space.s2) {
                            Button("Forget") {}.buttonStyle(.cockpit(.plain))
                            Button("Pair again") {}.buttonStyle(.cockpit(.secondary))
                        }
                    }
                    SettingRow("Theme", separator: false, tag: "New") {
                        MenuRow("Theme", selection: .constant("dark"), options: themes)
                    }
                }
            }
            .environment(\.dynamicTypeSize, .accessibility3)
        }
        Specimen("Facts, a way out and acts on one card: one title, one line, one hairline (iPhone's acts are rows)") {
            SectionGround {
                SheetPart("About") {
                    SettingRow("Version", value: "0.9.0 (812)")
                    OutRow("Privacy policy", separator: false) {}
                }
                SheetPart(nil) {
                    ListRow("Build an export", meta: "A copy to keep or share", action: {}) { EmptyView() }
                        .environment(\.cockpitRowActs, true)
                    ListRow("Unpair this iPhone", separator: false, action: {})
                        .environment(\.cockpitRowWarns, true)
                }
            }
        }
    }
}

@MainActor let settingsFrameSheet = Sheet("settings-frame", ios: 390, mac: 520, hosted: true, platforms: [.mac]) {
    Specimen("A sheet: a part with no heading, then a section") {
        SheetFrame("Screen", icon: .screen) {
            SheetPart(nil) {
                SettingRow("Record the screen", separator: false) {
                    Toggle("Record the screen", isOn: .constant(true)).labelsHidden().toggleStyle(.cockpit)
                }
            }
            SheetPart("Apps and sites", line: "What is never recorded") {
                SettingRow("Never record", separator: false) { SettingValue("2 apps") }
            }
        }
    }
}

@MainActor let settingControlsSheet = Sheet("settings-controls", ios: 390, mac: 420, hosted: true) {
    Specimen("Switch: off · on") {
        HStack(spacing: Cockpit.Space.s4) {
            Toggle("Off", isOn: .constant(false)).labelsHidden().toggleStyle(.cockpit)
            Toggle("On", isOn: .constant(true)).labelsHidden().toggleStyle(.cockpit)
        }
        .environment(\.inSettingSection, true)
    }
    Specimen("Menu: at rest · pressed (the Mac's hover) · its note · busy") {
        VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
            MenuRow("Browser", selection: .constant("chrome"), options: browsers)
            set(MenuRow("Browser", selection: .constant("chrome"), options: browsers), \.forced, .touched(.mac))
            MenuRow("Browser", selection: .constant("chrome"), options: browsers, note: "Default")
            MenuRow("Browser", selection: .constant("chrome"), options: browsers, busy: true)
        }
        .environment(\.inSettingSection, true)
    }
}
#endif
