import SwiftUI
#if os(iOS)
import UIKit
#endif

public struct Composer: View {
    public enum State: Sendable { case ready, running, waiting }

    public struct Pick {
        let words: String
        let levels: [MenuRow<String>.Option]
        let level: Binding<String>
        let defaultLevel: String?
        let models: [MenuRow<String>.Option]
        let model: Binding<String>
        let modelName: String
        let reset: (() -> Void)?
        let voice: Voice?
        let reading: Bool

        public struct Voice {
            let words: String
            let caution: String?
            let choices: [MenuRow<String>.Option]
            let choice: Binding<String>

            public init(words: String, caution: String?, choices: [MenuRow<String>.Option], choice: Binding<String>) {
                self.words = words
                self.caution = caution
                self.choices = choices
                self.choice = choice
            }
        }

        public init(words: String, levels: [MenuRow<String>.Option], level: Binding<String>, default defaultLevel: String?,
                    models: [MenuRow<String>.Option], model: Binding<String>, modelName: String, voice: Voice? = nil,
                    reset: (() -> Void)?) {
            self.words = words
            self.levels = levels
            self.level = level
            self.defaultLevel = defaultLevel
            self.models = models
            self.model = model
            self.modelName = modelName
            self.voice = voice
            self.reset = reset
            reading = false
        }

        public static func reading(_ words: String) -> Pick {
            Pick(words: words)
        }

        private init(words: String) {
            self.words = words
            levels = []
            level = .constant("")
            defaultLevel = nil
            models = []
            model = .constant("")
            modelName = ""
            reset = nil
            voice = nil
            reading = true
        }

        func draws(as other: Pick) -> Bool {
            words == other.words && levels == other.levels && level.wrappedValue == other.level.wrappedValue
                && defaultLevel == other.defaultLevel && models == other.models && model.wrappedValue == other.model.wrappedValue
                && modelName == other.modelName && (reset == nil) == (other.reset == nil) && reading == other.reading
                && voice?.words == other.voice?.words && voice?.caution == other.voice?.caution
                && voice?.choices == other.voice?.choices && voice?.choice.wrappedValue == other.voice?.choice.wrappedValue
        }
    }

    public struct Level {
        let glyph: Cockpit.Icon
        let words: String
        let choices: [MenuRow<String>.Option]
        let choice: Binding<String>
        let waits: Bool

        public init(glyph: Cockpit.Icon, words: String, choices: [MenuRow<String>.Option], choice: Binding<String>, waits: Bool) {
            self.glyph = glyph
            self.words = words
            self.choices = choices
            self.choice = choice
            self.waits = waits
        }
    }

    public struct Attach {
        let library: () -> Void
        let camera: () -> Void
        let file: () -> Void
        let unable: String?

        public init(library: @escaping () -> Void, camera: @escaping () -> Void, file: @escaping () -> Void, unable: String? = nil) {
            self.library = library
            self.camera = camera
            self.file = file
            self.unable = unable
        }
    }

    public struct Picture: Identifiable {
        public enum State: Sendable { case ready, uploading, refused }

        public let id: String
        let image: Image
        let state: State
        let remove: () -> Void

        public init(id: String, image: Image, state: State = .ready, remove: @escaping () -> Void) {
            self.id = id
            self.image = image
            self.state = state
            self.remove = remove
        }
    }

    public struct Record {
        let start: () -> Void
        let recording: Recording?

        public init(start: @escaping () -> Void, recording: Recording? = nil) {
            self.start = start
            self.recording = recording
        }
    }

    public struct Recording {
        let time: String
        let levels: [Double]
        let stop: () -> Void
        let send: () -> Void
        let cancel: (() -> Void)?

        public init(time: String, levels: [Double], stop: @escaping () -> Void, send: @escaping () -> Void,
                    cancel: (() -> Void)? = nil) {
            self.time = time
            self.levels = levels
            self.stop = stop
            self.send = send
            self.cancel = cancel
        }
    }

    @Binding var text: String
    let state: State
    let placeholder: String
    let send: () -> Void
    let stop: () -> Void
    let focus: FocusState<Bool>.Binding?
    let pick: Pick?
    let level: Level?
    let attach: Attach?
    let pictures: [Picture]
    let record: Record?
    let notice: AnyView?
    var forcedFocus = false
    @FocusState private var ownFocus: Bool
    @Environment(\.cockpitPlatform) private var platform

    public init(text: Binding<String>, state: State = .ready, placeholder: String = "Ask anything",
                focus: FocusState<Bool>.Binding? = nil, pick: Pick? = nil, level: Level? = nil, attach: Attach? = nil, pictures: [Picture] = [],
                record: Record? = nil, notice: AnyView? = nil, send: @escaping () -> Void, stop: @escaping () -> Void) {
        self._text = text
        self.state = state
        self.placeholder = placeholder
        self.focus = focus
        self.pick = pick
        self.level = level
        self.attach = attach
        self.pictures = pictures
        self.record = record
        self.notice = notice
        self.send = send
        self.stop = stop
    }

    private var phone: Bool { platform == .ios }
    private var control: CGFloat { phone ? Cockpit.Size.composerControl : Cockpit.Size.controlMac }
    private var recording: Recording? { record?.recording }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: phone ? Cockpit.Radius.composer : Cockpit.Radius.s2xl, style: .continuous)
        VStack(alignment: .leading, spacing: 0) {
            if let notice {
                notice
                    .padding(.trailing, Cockpit.Space.s2)
                    .padding(.bottom, Cockpit.Space.s3 - 2)
            }
            if !pictures.isEmpty {
                HStack(spacing: Cockpit.Space.s3 - 2) {
                    ForEach(pictures) { thumb($0) }
                }
                .padding(.top, Cockpit.Space.s1 + 2)
                .padding(.bottom, Cockpit.Space.s3 - 2)
            }
            if recording == nil {
                field
            } else {
                Color.clear.frame(height: platform.style(.reading).lineHeight)
            }
            tools
                .padding(.top, Cockpit.Space.s3 - 2)
                .padding(.leading, -(control - Cockpit.Size.iconLg) / 2 - Cockpit.Space.s1 / 2)
        }
        .padding(.top, Cockpit.Space.s3 + 2)
        .padding(.leading, Cockpit.Space.s4)
        .padding([.trailing, .bottom], phone ? Cockpit.Space.s2 : Cockpit.Space.s3 - 2)
        .modifier(ComposerGround(shape: shape, phone: phone, waiting: state == .waiting))
        .contentShape(shape)
        .onTapGesture { if recording == nil { (focus ?? $ownFocus).wrappedValue = true } }
        .modifier(KeyboardFollowsFocus(focused: (focus ?? $ownFocus).wrappedValue))
    }


    private var field: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(placeholder)
                    .foregroundStyle(state == .waiting ? Cockpit.Color.textDisabled
                        : phone ? Cockpit.Color.textSecondary : Cockpit.Color.textTertiary)
                    .lineLimit(1)
                    .accessibilityHidden(true)
            }
            TextField("", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .focusEffectDisabled()
                .focused(focus ?? $ownFocus)
                .lineLimit(1...(platform == .mac ? 10 : 6))
                .foregroundStyle(Cockpit.Color.text)
                .disabled(state == .waiting)
                .accessibilityLabel("Ask")
                .onSubmit(asked)
        }
        .cockpit(.reading)
        .frame(maxWidth: .infinity, minHeight: platform.style(.reading).lineHeight, alignment: .leading)
        .padding(.trailing, Cockpit.Space.s2)
    }


    @ViewBuilder private var tools: some View {
        if let recording {
            HStack(spacing: Cockpit.Space.s3 - 2) {
                if let cancel = recording.cancel {
                    Button(action: cancel) {
                        Icon(.close, size: phone ? .md : .sm)
                            .foregroundStyle(Cockpit.Color.textSecondary)
                            .frame(width: control, height: control)
                            .modifier(Target(side: control, platform: platform))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Cancel the voice note")
                }
                Button(action: recording.stop) {
                    Circle().fill(Cockpit.Color.bubbleOwn)
                        .overlay {
                            RoundedRectangle(cornerRadius: 3, style: .continuous)
                                .fill(Cockpit.Color.text)
                                .frame(width: Cockpit.Size.iconXs, height: Cockpit.Size.iconXs)
                        }
                        .frame(width: control, height: control)
                        .modifier(Target(side: control, platform: platform))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop recording")
                Wave(levels: recording.levels, height: phone ? 24 : 22)
                Text(recording.time)
                    .cockpit(phone ? .subhead : .footnote)
                    .monospacedDigit()
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .fixedSize()
                circle(live: true, action: recording.send, label: "Send")
            }
        } else {
            HStack(spacing: Cockpit.Space.s1 + 2) {
                if let attach { plus(attach) }
                if let pick { PickChip(pick: pick, height: control).equatable() }
                if let level { LevelChip(level: level, height: control) }
                Spacer(minLength: 0)
                if let record {
                    Button(action: record.start) {
                        Icon(.voiceNote, size: phone ? .md : .sm)
                            .foregroundStyle(state == .waiting ? Cockpit.Color.textDisabled : Cockpit.Color.textSecondary)
                            .frame(width: control, height: control)
                            .modifier(Target(side: control, platform: platform))
                    }
                    .buttonStyle(.plain)
                    .disabled(state == .waiting)
                    .accessibilityLabel("Record a voice note")
                }
                sendCircle
            }
        }
    }

    private func plus(_ attach: Attach) -> some View {
        Menu {
            if let unable = attach.unable {
                Section(unable) { sources(attach) }.disabled(true)
            } else {
                sources(attach)
            }
        } label: {
            Icon(.add, size: phone ? .lg : .md)
                .foregroundStyle(state == .waiting ? Cockpit.Color.textDisabled : Cockpit.Color.text)
                .frame(width: control, height: control)
                .modifier(Target(side: control, platform: platform))
        }
        .menuOrder(.fixed)
        .buttonStyle(.plain)
        .disabled(state == .waiting)
        .accessibilityLabel("Add a picture")
    }

    @ViewBuilder private func sources(_ attach: Attach) -> some View {
        source("Photo Library", .photos, attach.library)
        source("Take Photo", .photo, attach.camera)
        source("Choose File", .folder, attach.file)
    }

    private func source(_ words: String, _ icon: Cockpit.Icon, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Label { Text(words) } icon: { MenuIcon.image(icon) } }
    }

    private func thumb(_ picture: Picture) -> some View {
        let side = phone ? Cockpit.Size.thumb : 56
        return picture.image
            .resizable()
            .scaledToFill()
            .frame(width: side, height: side)
            .overlay {
                if picture.state != .ready {
                    ZStack {
                        Cockpit.Color.overlay.opacity(0.6)
                        if picture.state == .uploading {
                            Spinner().foregroundStyle(Cockpit.Color.text)
                        } else {
                            SignalShape(.warning, size: 16)
                        }
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous))
            .overlay(alignment: .topTrailing) {
                Button(action: picture.remove) {
                    Circle().fill(Cockpit.Color.overlay)
                        .overlay(Circle().strokeBorder(Cockpit.Color.hairline, lineWidth: Cockpit.Stroke.border))
                        .overlay { Icon(.close, size: .xs).foregroundStyle(Cockpit.Color.textSecondary) }
                        .frame(width: 22, height: 22)
                        .modifier(Target(side: 22, platform: platform))
                }
                .buttonStyle(.plain)
                .offset(x: 6, y: -6)
                .accessibilityLabel("Remove the picture")
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Picture")
            .accessibilityValue(picture.state == .uploading ? "Sending" : picture.state == .refused ? "Can't be sent" : "")
    }


    public static func sends(_ text: String) -> Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private var empty: Bool { !Self.sends(text) }

    private func asked() {
        if state == .ready && !empty { send() }
    }

    private var sendCircle: some View {
        let live = state == .running || (state == .ready && !empty)
        return circle(live: live, running: state == .running, action: state == .running ? stop : asked,
                      label: state == .running ? "Stop" : "Send")
            .disabled(!live)
            .keyboardShortcut(state == .running ? KeyboardShortcut(".", modifiers: .command) : nil)
            .help(state == .running ? "Stop ⌘." : "Send")
    }

    private func circle(live: Bool, running: Bool = false, action: @escaping () -> Void, label: String) -> some View {
        Button(action: action) {
            ZStack {
                Circle().fill(live ? Cockpit.Color.accentSolid : Cockpit.Color.bubbleOwn)
                if running {
                    RoundedRectangle(cornerRadius: 2 * Cockpit.Radius.s2xs, style: .continuous)
                        .fill(Cockpit.Color.accentInk)
                        .frame(width: Cockpit.Size.iconXs, height: Cockpit.Size.iconXs)
                } else {
                    Icon(.send, size: phone ? .md : .sm)
                        .foregroundStyle(live ? Cockpit.Color.accentInk : state == .waiting ? Cockpit.Color.textDisabled : Cockpit.Color.textTertiary)
                }
            }
            .frame(width: control, height: control)
            .animation(.easeOut(duration: Cockpit.Duration.fast), value: live)
            .modifier(Target(side: control, platform: platform))
        }
        .buttonStyle(SendPress(side: phone ? control : nil))
        .accessibilityLabel(label)
    }
}

@MainActor enum MenuIcon {
    private static var drawn: [Cockpit.Icon: Image] = [:]

    static func image(_ meaning: Cockpit.Icon) -> Image {
        if let image = drawn[meaning] { return image }
        let side = Cockpit.Size.iconMd
        let renderer = ImageRenderer(content: IconShape(meaning: meaning).frame(width: side, height: side))
        renderer.scale = 3
        #if canImport(UIKit)
        let image = renderer.uiImage.map { Image(uiImage: $0.withRenderingMode(.alwaysTemplate)) } ?? Image(systemName: "photo")
        #else
        let image = renderer.cgImage.map { Image(decorative: $0, scale: 3).renderingMode(.template) } ?? Image(decorative: "")
        #endif
        drawn[meaning] = image
        return image
    }

    private static var signals: [Cockpit.SignalKind: Image] = [:]

    static func signal(_ kind: Cockpit.SignalKind) -> Image {
        if let image = signals[kind] { return image }
        let side = Cockpit.Size.iconMd
        let renderer = ImageRenderer(content: SignalShape(kind, size: side))
        renderer.scale = 3
        #if canImport(UIKit)
        let image = renderer.uiImage.map { Image(uiImage: $0.withRenderingMode(.alwaysOriginal)) } ?? Image(systemName: "exclamationmark.triangle.fill")
        #else
        let image = renderer.cgImage.map { Image(decorative: $0, scale: 3) } ?? Image(decorative: "")
        #endif
        signals[kind] = image
        return image
    }
}

private struct Target: ViewModifier {
    let side: CGFloat
    let platform: Cockpit.Platform

    func body(content: Content) -> some View {
        let room = max(0, platform.hitSize - side) / 2
        content.padding(room).contentShape(Rectangle()).padding(-room)
    }
}

private struct SendPress: ButtonStyle {
    let side: CGFloat?

    func makeBody(configuration: Configuration) -> some View {
        configuration.label.overlay {
            if let side, configuration.isPressed {
                Circle().fill(Cockpit.Color.pressed).frame(width: side, height: side).allowsHitTesting(false)
            }
        }
    }
}

struct PickChip: View, Equatable {
    let pick: Composer.Pick
    let height: CGFloat
    @Environment(\.cockpitPlatform) private var platform

    nonisolated static func == (one: PickChip, other: PickChip) -> Bool {
        MainActor.assumeIsolated { one.height == other.height && one.pick.draws(as: other.pick) }
    }

    var body: some View {
        if pick.reading {
            face(pressed: false).reading(true)
        } else {
            Menu {
                if !pick.levels.isEmpty {
                    Section("Thinking") {
                        MenuChoices(options: pick.levels, selection: pick.level, default: pick.defaultLevel)
                    }
                }
                Menu {
                    MenuChoices(options: pick.models, selection: pick.model, default: nil)
                } label: {
                    Text("Model")
                    Text(pick.modelName)
                }
                if let voice = pick.voice { VoiceRow(voice: voice) }
                Section {
                    Button("Reset to default") { pick.reset?() }
                        .disabled(pick.reset == nil)
                }
            } label: {
                EmptyView()
            }
            .menuStyle(.button)
            .menuOrder(.fixed)
            .buttonStyle(Cockpit.Pressable(forced: nil) { _, state in face(pressed: state != nil) })
            .accessibilityLabel("Model and thinking")
            .accessibilityValue(pick.words.replacingOccurrences(of: " · ", with: ", "))
            .accessibilityIdentifier("ask.pick")
        }
    }

    private func face(pressed: Bool) -> some View {
        ChipFace(words: pick.words, height: height, pressed: pressed)
    }
}

struct LevelChip: View {
    let level: Composer.Level
    let height: CGFloat
    @Environment(\.cockpitPlatform) private var platform

    var body: some View {
        Menu {
            Section("Sensitive information") {
                MenuChoices(options: level.choices, selection: level.choice, default: nil)
            }
        } label: {
            EmptyView()
        }
        .menuStyle(.button)
        .menuOrder(.fixed)
        .buttonStyle(Cockpit.Pressable(forced: nil) { _, state in
            ChipFace(glyph: level.glyph, words: platform == .ios ? nil : level.words, height: height, pressed: state != nil,
                     dimmed: level.waits)
        })
        .disabled(level.waits)
        .accessibilityLabel("Sensitive information")
        .accessibilityValue(level.words)
        .accessibilityIdentifier("ask.level")
    }
}

private struct ChipFace: View {
    var glyph: Cockpit.Icon?
    let words: String?
    let height: CGFloat
    let pressed: Bool
    var dimmed = false
    @Environment(\.cockpitPlatform) private var platform

    var body: some View {
        HStack(spacing: Cockpit.Space.s1) {
            if let glyph { Icon(glyph, size: platform == .ios ? .md : .sm) }
            if let words {
                Text(words)
                    .cockpit(platform == .ios ? .subhead : .footnote)
                    .fontWeight(.medium)
                    .lineLimit(1)
                Icon(.expand, size: .sm)
            }
        }
        .foregroundStyle(dimmed ? Cockpit.Color.textDisabled : Cockpit.Color.textSecondary)
        .padding(.horizontal, words == nil ? 0 : platform == .ios ? Cockpit.Space.s3 - 2 : Cockpit.Space.s2)
        .frame(minWidth: height)
        .frame(height: height)
        .background(Capsule(style: .continuous).fill(pressed ? Cockpit.Color.bubbleOwn : Color.clear))
        .contentShape(Capsule(style: .continuous))
        .animation(.easeOut(duration: Cockpit.Duration.instant), value: pressed)
    }
}

private struct VoiceRow: View {
    let voice: Composer.Pick.Voice

    var body: some View {
        Menu {
            if let caution = voice.caution {
                Section(caution) { MenuChoices(options: voice.choices, selection: voice.choice, default: nil) }
            } else {
                MenuChoices(options: voice.choices, selection: voice.choice, default: nil)
            }
        } label: {
            Label {
                Text("Voice")
                Text(voice.words)
            } icon: {
                if voice.caution != nil { MenuIcon.signal(.caution) }
            }
        }
        .disabled(voice.choices.isEmpty)
        .accessibilityIdentifier("ask.pick.voice")
    }
}

struct Wave: View {
    let levels: [Double]
    let height: CGFloat
    var quiet: Int?
    var tone: Color = Cockpit.Color.text

    var body: some View {
        GeometryReader { box in
            let fits = max(0, Int((box.size.width + 2) / 5))
            let shown = Array(levels.suffix(fits))
            let first = levels.count - shown.count
            HStack(alignment: .center, spacing: 2) {
                ForEach(shown.indices, id: \.self) { index in
                    Capsule(style: .continuous)
                        .fill(quiet.map { first + index >= $0 } == true ? Cockpit.Color.textTertiary : tone)
                        .frame(width: 3, height: max(3, (shown[index].clamped * height).rounded()))
                }
            }
            .frame(maxHeight: .infinity)
        }
        .frame(height: height)
        .frame(maxWidth: .infinity)
        .accessibilityHidden(true)
    }
}

private extension Double {
    var clamped: CGFloat { CGFloat(Swift.min(1, Swift.max(0, self))) }
}

private struct ComposerGround: ViewModifier {
    let shape: RoundedRectangle
    let phone: Bool
    let waiting: Bool

    func body(content: Content) -> some View {
        if phone {
            content
                .background { Color.clear.cockpitGlass(in: shape, interactive: false) }
                .overlay { if waiting { shape.strokeBorder(Cockpit.Color.border, lineWidth: Cockpit.Stroke.border) } }
        } else {
            content
                .background { if !waiting { shape.fill(Cockpit.Color.raised) } }
                .overlay {
                    shape.strokeBorder(waiting ? Cockpit.Color.border : Cockpit.Color.hairline,
                                       lineWidth: waiting ? Cockpit.Stroke.border : Cockpit.Stroke.hairline)
                }
        }
    }
}

public extension View {
    func tappingKeyboardAway(_ focus: FocusState<Bool>.Binding) -> some View {
        contentShape(Rectangle())
            .simultaneousGesture(TapGesture().onEnded {
                focus.wrappedValue = false
                KeyboardAway.now()
            })
    }
}

private struct KeyboardFollowsFocus: ViewModifier {
    let focused: Bool

    func body(content: Content) -> some View {
        content.onChange(of: focused) { _, held in if !held { KeyboardAway.now() } }
    }
}

enum KeyboardAway {
    static func now() {
        #if os(iOS)
        // external: iOS 26 and 27 keep a field inside a safeAreaBar first responder when its FocusState turns false, and leave the FocusState false when a tap refocuses it
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        #endif
    }
}
