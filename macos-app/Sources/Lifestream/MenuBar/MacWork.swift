import Audio
import DeviceFiles
import Foundation
import HomeLink
import Recorder
import Shipping

@MainActor final class MacWork {
    @MainActor final class Slot {
        private(set) var work: MacWork?

        func begin(_ options: Options, process: MacProcess, link: HomeLink?) -> MacWork? {
            guard work == nil, let files = process.files, let link else { return nil }
            let made = MacWork(options: options, process: process, files: files, link: link)
            work = made
            return made
        }
    }

    let recorder: Recorder
    let audio: AudioRecorder
    let settings: MacSettings
    let shipping: ShippingCoordinator
    let imports: Imports
    let control: ControlResponder
    let carry: AudioCarry
    let diagnostics: AppDiagnostics
    let link: HomeLink

    init(options: Options, process: MacProcess, files: DeviceFiles, link: HomeLink) {
        self.link = link
        let logs = RecorderLogs(options, files: files, scratch: process.scratch)
        audio = logs.audio
        let recorder = Recorder.live(options, process: process, logs: logs)
        self.recorder = recorder
        let settings = MacSettings(file: MacLink.settingsFile, defaults: ScreenSettings.defaults(options, modes: logs.modes),
                                   files: files)
        self.settings = settings
        let homeFree = HomeFree()
        let limits = MacLimits(disk: logs.disk, link: link)
        let heard = ImportsHeard()
        let shipping = ShippingCoordinator(options: options, scratch: process.scratch, logs: logs, link: link, settings: settings, homeFree: homeFree, limits: limits,
                                           imports: heard)
        self.shipping = shipping
        logs.wakes.attach { [weak shipping] product in
            Task { @MainActor in shipping?.noteChanged(product: product) }
        }
        ScreenSettings.join(settings, recorder, knock: { Task { await shipping.knock() } })
        control = ControlResponder(recorder: recorder, ship: { await shipping.shipNow().outcome }, pair: { name, code in
            let response = await HomeCommands.pair(name: name, code: code, link: link)
            if response.ok { await shipping.paired() }
            return response
        })
        let imports = Imports(world: .live(link: link, files: files, scratch: process.scratch, ship: { shipping.shipSoon() }, homeFree: homeFree,
                                           disk: limits.disk))
        heard.imports = imports
        self.imports = imports
        carry = AudioCarry(directory: options.directory, files: files)
        diagnostics = AppDiagnostics(directory: options.directory, plain: process.plain)
        diagnostics.start()
    }
}
