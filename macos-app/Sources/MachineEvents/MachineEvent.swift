import Evidence
import Foundation

enum MachineEventName: String, CaseIterable, Sendable {
    case state
    case sleep
    case wake
    case displaySleep = "display_sleep"
    case displayWake = "display_wake"
    case lock
    case unlock
    case sessionActive = "session_active"
    case sessionInactive = "session_inactive"
    case powerAC = "power_ac"
    case powerBattery = "power_battery"
    case lidClose = "lid_close"
    case lidOpen = "lid_open"
    case wifiJoin = "wifi_join"
    case wifiLeave = "wifi_leave"
    case recorderStart = "recorder_start"
    case recorderStop = "recorder_stop"
    case shipperRun = "shipper_run"
    case micStart = "mic_start"
    case micStop = "mic_stop"
    case soundStart = "sound_start"
    case soundStop = "sound_stop"
    case cameraStart = "camera_start"
    case cameraStop = "camera_stop"
    case outputDevice = "output_device"
    case outputVolume = "output_volume"
    case displayAttach = "display_attach"
    case displayDetach = "display_detach"
    case displayChange = "display_change"
    case bluetoothConnect = "bluetooth_connect"
    case bluetoothDisconnect = "bluetooth_disconnect"
    case ambientLight = "ambient_light"
    case access

    var isUserOrSystem: Bool {
        switch self {
        case .state, .recorderStart, .recorderStop, .shipperRun, .ambientLight: false
        default: true
        }
    }
}

enum MachineEventValue: Equatable, Sendable {
    case text(String)
    case number(Double)
    case flag(Bool)
}

struct MachineEvent: Equatable, Sendable {
    let at: Date
    let name: MachineEventName
    let detail: [String: MachineEventValue]

    init(at: Date, name: MachineEventName, detail: [String: MachineEventValue] = [:]) {
        self.at = UTCInstant.millisecond(at)
        self.name = name
        self.detail = detail
    }
}
