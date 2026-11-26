import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI
import UIKit
import os

struct YourHomeSheet: View {
    private static let log = Logger(subsystem: "org.lifestreamprotocol.phone", category: "shipping")
    @EnvironmentObject private var model: CaptureAppModel
    @Environment(\.openConnectors) private var open
    private let service = AppRuntime.shared.shipping
    @ObservedObject private var shipper = AppRuntime.shared.shipping.shipper
    @ObservedObject private var reach = AppRuntime.shared.reach
    @State private var pairing = false
    @State private var confirmUnpair = false
    @State private var unpair: ActOutcome = .idle
    @State private var shared: [URL] = []
    @State private var typedAccount = ""
    @State private var addingAccount = false
    @State private var accountProblem: HomeLink.ActSaid?
    @State private var addedAccount: String?
    @State private var past: MobileData.Wait?

    var body: some View {
        frame
            .sheet(isPresented: $pairing) {
                PairingView()
            }
            .task {
                let link = service.link
                let changes = link.mobileChanges()
                past = Self.pastWait(link)
                for await _ in changes { past = Self.pastWait(link) }
            }
            .confirmationDialog("Unpair from Lifestream?", isPresented: $confirmUnpair, titleVisibility: .visible) {
                Button("Unpair this iPhone", role: .destructive) { Task { await unpairThisPhone() } }
                Button("Not now", role: .cancel) {}
            } message: {
                Text("Nothing more is sent to Lifestream. This iPhone keeps recording here, and you can pair again later. What Lifestream already holds stays there; to stop this iPhone there too, open Settings on the Mac, click iPhone, then click Remove beside This iPhone.")
            }
    }

    private static func pastWait(_ link: HomeLink) -> MobileData.Wait? {
        link.mobile(pressed: false).past.wait.flatMap { $0 == .past ? $0 : nil }
    }

    private func unpairThisPhone() async {
        await ActOutcome.run($unpair, said: { error in
            Self.log.error("Unpair did not finish: \(String(describing: error), privacy: .public)")
            return .failed(.refused("This iPhone couldn't finish unpairing. It is still paired."))
        }) {
            try await shipper.unpair()
            AppRuntime.shared.forgetHomeReads()
        }
    }

    @ViewBuilder private var frame: some View {
        SheetFrame("Lifestream", icon: .home) { content }
    }

    @ViewBuilder private var content: some View {
        let saved = shipper.saved
        let paired = shipper.paired
        if let home = shipper.homeName {
            let account = addedAccount ?? saved?.account
            let failed = shipper.state.outcome == .storeFailed ? nil : shipper.sendFailure
            let problems = [failed, shipper.leftOut].compactMap { $0 }
            let problem = problems.isEmpty ? nil : problems.joined(separator: " ")
            let sending = reach.snapshot.reach != .answering ? "Waiting to send." : shipper.shippingDescription
            let sends = sending != nil && ![.shipped, .nothingNew].contains(shipper.state.outcome) || problem != nil
            let more = sends || past != nil
            SheetPart(nil) {
                SettingRow("Mac", value: home,
                           line: reach.snapshot.lastReached.map { ReachWords.lastReached($0, clock: HomeClock.current.clock, now: AppClock.now) })
                    .accessibilityIdentifier("home.reached")
                SettingRow("This iPhone", value: HardwareIdentity.marketingName, separator: account != nil || more)
                if let account {
                    SettingRow("Apple ID", value: account, separator: more)
                        .accessibilityIdentifier("home.account")
                }
                if sends {
                    SettingRow("Last send", problem: problem, line: sending, separator: past != nil) { EmptyView() }
                }
                if let past {
                    SettingRow("Mobile data", line: past.words, separator: false, opens: { open(.settings("mobile-data", "Mobile data")) })
                        .opensFromLine()
                        .accessibilityIdentifier("home.mobile-data")
                }
            }
            if saved != nil, account == nil { addAccount }
        } else {
            SheetPart(nil, note: "To pair, scan the code in your Mac's iPhone step.") {
                SettingRow("Mac", line: "Not paired. What this iPhone records stays on it until you pair.", separator: false) {
                    Button("Pair with Lifestream") { pairing = true }
                        .buttonStyle(.cockpit(.primary, size: .small))
                        .accessibilityIdentifier("home.pair")
                }
            }
        }
        if paired {
            SheetPart(nil) {
                if !shipper.pending.isEmpty {
                    ListRow("Send now", meta: Words.count(shipper.pending.count, "bundle") + " waiting", action: { Task { await shipper.shipNow() } })
                        .environment(\.cockpitRowActs, true)
                        .accessibilityIdentifier("home.send")
                }
                exportRows
                ListRow("Unpair this iPhone", separator: false, action: unpair.running ? nil : { confirmUnpair = true }) {
                    if unpair.running { Spinner() }
                }
                    .environment(\.cockpitRowWarns, true)
                    .accessibilityIdentifier("home.unpair")
                    .actOutcome(unpair, identifier: "home.unpair.failed") { confirmUnpair = true }
            }
        } else {
            SheetPart("Export", line: "A copy of everything this iPhone has recorded, to keep or share.") { exportRows }
        }
    }

    @ViewBuilder private var exportRows: some View {
        let follows = shipper.paired || !shared.isEmpty
        let build = { Task { shared = await model.makeExport() } }
        ListRow("Build an export", meta: shipper.paired ? "A copy to keep or share" : nil, separator: follows,
                action: model.export.running ? nil : { _ = build() }) {
            if model.export.running { Spinner() }
        }
        .environment(\.cockpitRowActs, true)
        .accessibilityIdentifier("export.build")
        .actOutcome(model.export, identifier: "export.failed") { _ = build() }
        if !shared.isEmpty {
            ShareLink(items: shared) {
                ListRow("Share the export", separator: shipper.paired) { EmptyView() }
                    .environment(\.cockpitRowActs, true)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("export.share")
        }
    }
}

extension YourHomeSheet {
    @ViewBuilder fileprivate var addAccount: some View {
        let typed = !typedAccount.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        SheetPart(nil) {
            SettingRow("Apple ID", separator: false) {
                if typed {
                    Button("Add") { Task { await stateAccount() } }
                        .buttonStyle(.cockpit(.secondary, size: .small, busy: addingAccount))
                        .accessibilityIdentifier("home.account.add")
                }
            } held: {
                VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                    Field("Apple ID", text: $typedAccount, placeholder: "Email or phone number", spaces: false)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    AppleIDWaits()
                    if let accountProblem {
                        InPlaceLine(InPlaceLine.Said(accountProblem)) { Task { await stateAccount() } }
                            .accessibilityIdentifier("home.account.message")
                    }
                }
            }
        }
    }

    fileprivate func stateAccount() async {
        guard !addingAccount else { return }
        addingAccount = true
        defer { addingAccount = false }
        accountProblem = nil
        do {
            addedAccount = try await service.state(account: typedAccount)
        } catch {
            accountProblem = HomeLink.state(of: error, now: AppClock.now).flatMap(ReachWords.act) ?? .refused(String(describing: error))
        }
    }
}

struct ReachDetailsSheet: View {
    let close: () -> Void
    private let service = AppRuntime.shared.shipping
    @ObservedObject private var reach = AppRuntime.shared.reach

    var body: some View {
        let snapshot = reach.snapshot
        VStack(spacing: 0) {
            if let diagnosis = ReachWords.diagnosis(snapshot, device: .phone, clock: HomeClock.current.clock, now: AppClock.now) {
                PathChecklist(diagnosis.title, line: diagnosis.line, links: diagnosis.path.map(Self.link),
                              retry: .init("Try again", busy: snapshot.checking) { Task { await service.link.checkAgain() } },
                              close: close, identifier: "home.check")
            }
        }
        .padding(.horizontal, Cockpit.Gap.edge)
        .padding(.top, Cockpit.Space.s6)
        .padding(.bottom, Cockpit.Space.s2)
        .frame(maxHeight: .infinity, alignment: .top)
        .groundColor(Cockpit.Color.surface)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .onChange(of: snapshot.reach.isUnreachable, initial: true) { _, out in if !out { close() } }
    }

    private static func link(_ link: ReachWords.Link) -> PathChecklist.Link {
        let state: PathChecklist.Link.State = switch link.state {
        case .passed: .passed
        case .failed: .failed
        case .unchecked: .unchecked
        }
        let act = link.act.map { act in
            StatusStrip.Act(act.label) {
                guard act == .tailscale, let app = URL(string: "tailscale://"),
                      let store = URL(string: "https://apps.apple.com/app/id1470499037") else { return }
                UIApplication.shared.open(app) { opened in if !opened { UIApplication.shared.open(store) } }
            }
        }
        return PathChecklist.Link(link.id, name: link.name, state: state, value: link.value, fix: link.fix, act: act)
    }
}

extension PhoneShipper {
    var leftOut: String? {
        let count = state.sending.sources.count
        guard count > 0 else { return nil }
        return (count == 1 ? "One connector" : "\(count) connectors") + " couldn't be sent. The rest were, and Lifestream shows which."
    }

    private var failingLong: Bool {
        guard let since = state.sending.send?.sinceMs else { return false }
        return AppClock.now.timeIntervalSince1970 * 1000 - Double(since) >= 3_600_000
    }

    private var waitingDescription: String? {
        switch state.outcome {
        case .waiting, .shipped, .nothingNew: waits.map(\.words).min()
        default: nil
        }
    }

    var shippingDescription: String? {
        waitingDescription ?? ReachWords.sending(state.outcome.word, device: .phone, long: failingLong)
    }
}
