import AppKit
import CoreWLAN
import DeviceFiles
import Evidence
import Foundation
import IOKit
import IOKit.ps
import notify

public final class MachineEventSources: NSObject, @unchecked Sendable {
    private let queue = DispatchQueue(label: "org.lifestreamprotocol.machine-events")
    private let directory: URL
    private let files: DeviceFiles
    private let zone: TimeZone
    private let report: (String) -> Void

    private var log: MachineEventLog?
    private var state = MachineState()
    private var workspaceObservers: [NSObjectProtocol] = []
    private var distributedObservers: [NSObjectProtocol] = []
    private var powerToken: Int32?
    private var lidPort: IONotificationPortRef?
    private var lidNotifier: io_object_t = 0
    private var rotationTimer: DispatchSourceTimer?
    private var wifiClient: CWWiFiClient?
    private let devices: DeviceUseMonitor
    private var deviceRead: DeviceUse?
    private var modes: RecordingModes
    private let peripheralProbe: any PeripheralProbe
    private let lightInterval: TimeInterval
    private var light = LightRule(stated: nil)
    private var lightTimer: DispatchSourceTimer?
    private let grants: @Sendable () -> [String: String]
    private let drops = LineDrops()
    private let onUserOrSystemEvent: (@Sendable () -> Void)?
    private let told: DispatchQueue

    public var availabilityChanged: ((_ displayAwake: Bool?, _ sessionActive: Bool?) -> Void)?

    public var deviceUseChanged: ((DeviceUse) -> Void)?

    private static let clamshellStateChange: natural_t = 0xE003_4100

    public convenience init(directory: URL,
                            files: DeviceFiles,
                            timeZone: TimeZone = .current,
                            modes: RecordingModes = .defaults,
                            probe: any DeviceUseProbe = SystemDeviceUseProbe(),
                            grants: @escaping @Sendable () -> [String: String] = { [:] },
                            report: @escaping (String) -> Void = { _ in },
                            onUserOrSystemEvent: (@Sendable () -> Void)? = nil) {
        self.init(directory: directory, files: files, timeZone: timeZone, modes: modes, probe: probe,
                  peripherals: SystemPeripheralProbe(), grants: grants, report: report,
                  onUserOrSystemEvent: onUserOrSystemEvent)
    }

    init(directory: URL,
         files: DeviceFiles,
         timeZone: TimeZone = .current,
         modes: RecordingModes = .defaults,
         probe: any DeviceUseProbe = SystemDeviceUseProbe(),
         peripherals: any PeripheralProbe,
         lightInterval: TimeInterval = PeripheralEvents.lightInterval,
         grants: @escaping @Sendable () -> [String: String] = { [:] },
         report: @escaping (String) -> Void = { _ in },
         onUserOrSystemEvent: (@Sendable () -> Void)? = nil) {
        self.directory = directory
        self.files = files
        self.zone = timeZone
        self.modes = modes
        self.report = report
        devices = DeviceUseMonitor(probe: probe, queue: queue)
        peripheralProbe = peripherals
        self.lightInterval = lightInterval
        self.grants = grants
        let told = DispatchQueue(label: "org.lifestreamprotocol.machine-events.told", qos: .utility)
        self.told = told
        self.onUserOrSystemEvent = onUserOrSystemEvent.map { tell in { @Sendable in told.async { tell() } } }
        super.init()
    }


    public func start() {
        let attached = peripheralProbe.start(queue: queue) { [weak self] signal in self?.peripheralsChanged(signal) }
        queue.async { [self] in
            guard log == nil else { return }
            state = MachineReader.state()
            state.access = grants()
            state.peripherals = attached
            light = LightRule(stated: attached.lux)
            let first = devices.start { [weak self] use in self?.devicesChanged(use) }
            deviceRead = first
            state.devices = DeviceUseEvents.visible(first, under: modes)
            deviceUseChanged?(first)
            do {
                log = try MachineEventLog(recorderDirectory: directory, files: files, timeZone: zone, drops: drops) { [weak self] in
                    self?.state ?? MachineState()
                }
            } catch {
                report("machine events: the batch spool could not be opened")
            }
            scheduleRotation(after: Date())
            if attached.lux != nil { scheduleLight() }
        }
        observeWorkspace()
        observeScreenLock()
        observePower()
        observeLid()
        observeWiFi()
        emit(.recorderStart)
    }

    public func stop() {
        stopObserving()
        queue.sync {
            rotationTimer?.cancel()
            rotationTimer = nil
            lightTimer?.cancel()
            lightTimer = nil
            devices.stop()
            deviceRead = nil
            guard log != nil else { return }
            let now = Date()
            pollDerived(at: now)
            write(MachineEvent(at: now, name: .recorderStop))
            do { try log?.rotate() } catch { report("machine events: the open batch was not sealed") }
            log = nil
        }
    }

    private func stopObserving() {
        let workspace = NSWorkspace.shared.notificationCenter
        for observer in workspaceObservers { workspace.removeObserver(observer) }
        workspaceObservers = []
        let distributed = DistributedNotificationCenter.default()
        for observer in distributedObservers { distributed.removeObserver(observer) }
        distributedObservers = []
        if let powerToken { notify_cancel(powerToken) }
        powerToken = nil
        peripheralProbe.stop()
        queue.sync {
            if lidNotifier != 0 { IOObjectRelease(lidNotifier) }
            if let lidPort { IONotificationPortDestroy(lidPort) }
        }
        lidNotifier = 0
        lidPort = nil
        if let wifiClient {
            wifiClient.delegate = nil
            try? wifiClient.stopMonitoringAllEvents()
        }
        wifiClient = nil
    }


    private func observeWorkspace() {
        let center = NSWorkspace.shared.notificationCenter
        let pairs: [(Notification.Name, MachineEventName)] = [
            (NSWorkspace.willSleepNotification, .sleep),
            (NSWorkspace.didWakeNotification, .wake),
            (NSWorkspace.screensDidSleepNotification, .displaySleep),
            (NSWorkspace.screensDidWakeNotification, .displayWake),
            (NSWorkspace.sessionDidBecomeActiveNotification, .sessionActive),
            (NSWorkspace.sessionDidResignActiveNotification, .sessionInactive),
        ]
        for (notification, event) in pairs {
            let observer = center.addObserver(forName: notification, object: nil, queue: .main) { [weak self] _ in
                switch event {
                case .displaySleep, .displayWake: self?.availabilityChanged?(event == .displayWake, nil)
                case .sessionActive, .sessionInactive: self?.availabilityChanged?(nil, event == .sessionActive)
                case .wake: self?.devices.recheck()
                default: break
                }
                self?.emit(event) { state in
                    switch event {
                    case .sleep: state.awake = false
                    case .wake: state.awake = true
                    case .displaySleep: state.displayAwake = false
                    case .displayWake: state.displayAwake = true
                    case .sessionActive: state.sessionActive = true
                    case .sessionInactive: state.sessionActive = false
                    default: break
                    }
                }
            }
            workspaceObservers.append(observer)
        }
    }

    private func observeScreenLock() {
        let center = DistributedNotificationCenter.default()
        let pairs: [(String, MachineEventName)] = [
            ("com.apple.screenIsLocked", .lock),
            ("com.apple.screenIsUnlocked", .unlock),
        ]
        for (name, event) in pairs {
            let notification = Notification.Name(name)
            let observer = center.addObserver(forName: notification, object: nil, queue: nil) { [weak self] _ in
                self?.emit(event) { state in state.locked = event == .lock }
            }
            distributedObservers.append(observer)
        }
    }

    private func observePower() {
        var token: Int32 = 0
        guard notify_register_dispatch(kIOPSNotifyPowerSource, &token, queue, { [weak self] _ in
            self?.pollDerived(at: Date())
        }) == NOTIFY_STATUS_OK else {
            report("machine events: the power source notification is unavailable")
            return
        }
        powerToken = token
    }

    private func observeLid() {
        let root = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
        guard root != 0, let port = IONotificationPortCreate(kIOMainPortDefault) else {
            if root != 0 { IOObjectRelease(root) }
            report("machine events: the lid notification is unavailable")
            return
        }
        defer { IOObjectRelease(root) }
        IONotificationPortSetDispatchQueue(port, queue)
        var notifier: io_object_t = 0
        let context = Unmanaged.passUnretained(self).toOpaque()
        guard IOServiceAddInterestNotification(port, root, kIOGeneralInterest, { context, _, message, _ in
            guard let context, message == MachineEventSources.clamshellStateChange else { return }
            Unmanaged<MachineEventSources>.fromOpaque(context).takeUnretainedValue().pollDerived(at: Date())
        }, context, &notifier) == KERN_SUCCESS else {
            IONotificationPortDestroy(port)
            report("machine events: the lid notification is unavailable")
            return
        }
        lidPort = port
        lidNotifier = notifier
    }

    private func observeWiFi() {
        let client = CWWiFiClient.shared()
        client.delegate = self
        do {
            try client.startMonitoringEvent(with: .linkDidChange)
            try client.startMonitoringEvent(with: .ssidDidChange)
            wifiClient = client
        } catch {
            client.delegate = nil
            report("machine events: Wi-Fi changes are not being watched")
        }
    }

    private func scheduleRotation(after instant: Date) {
        let next = MachineEventBatch.nextRotation(after: instant, in: zone)
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(wallDeadline: .now() + max(0, next.timeIntervalSinceNow), leeway: .seconds(1))
        timer.setEventHandler { [weak self] in self?.rotate(at: next) }
        rotationTimer?.cancel()
        rotationTimer = timer
        timer.resume()
    }

    private func rotate(at instant: Date) {
        if log != nil {
            do {
                try log?.rotate()
                if !pollDerived(at: instant) {
                    try log?.append(MachineEvent(at: instant, name: .state, detail: state.detail))
                }
            } catch {
                report("machine events: the day boundary was not sealed")
            }
            devices.recheck()
        }
        scheduleRotation(after: instant)
    }

    public func rotate() {
        queue.sync { [self] in
            guard log != nil else { return }
            accessChanged(at: Date())
            do { try log?.rotate() } catch { report("machine events: the open batch was not sealed") }
            devices.recheck()
        }
    }

    func waitUntilTold() {
        queue.sync {}
        told.sync {}
    }

    @discardableResult
    public func rotateIfSafe(now: Date = Date()) -> Bool {
        rotated(now: now, nothingOpen: false) { try $0.rotateIfSafe(now: now) }
    }

    public func rotateForShipping(now: Date = Date()) -> Bool {
        rotated(now: now, nothingOpen: true) { try $0.rotateForShipping(now: now) }
    }

    private func rotated(now: Date, nothingOpen: Bool, _ rotate: (MachineEventLog) throws -> Bool) -> Bool {
        queue.sync { [self] in
            guard log != nil else { return nothingOpen }
            accessChanged(at: now)
            guard let log else { return nothingOpen }
            let open = log.batchOpen
            let rotated: Bool
            do {
                rotated = try rotate(log)
            } catch {
                report("machine events: the open batch was not sealed")
                return false
            }
            if rotated, open { devices.recheck() }
            return rotated
        }
    }


    public func record(shipperRun detail: [String: String]) {
        let now = Date()
        let event = MachineEvent(at: now, name: .shipperRun,
                                 detail: detail.mapValues { MachineEventValue.text($0) })
        queue.async { [self] in
            guard log == nil else {
                pollDerived(at: now)
                write(event)
                return
            }
            do {
                let standalone = try MachineEventLog(recorderDirectory: directory, files: files, timeZone: zone, drops: drops) { [self] in
                    var state = MachineReader.state()
                    state.devices = DeviceUseEvents.visible(devices.read(), under: modes)
                    state.access = grants()
                    return state
                }
                try standalone.append(event)
                try standalone.rotate()
            } catch {
                report("machine events: one shipper row was dropped")
            }
        }
    }


    public func setModes(_ modes: RecordingModes) {
        queue.async { [self] in
            self.modes = modes
            if let deviceRead { state.devices = DeviceUseEvents.visible(deviceRead, under: modes) }
        }
    }

    private func devicesChanged(_ read: DeviceUse) {
        let merged = DeviceUseEvents.merged(read, over: deviceRead)
        deviceRead = merged
        deviceUseChanged?(merged)
        let visible = DeviceUseEvents.visible(merged, under: modes)
        let events = DeviceUseEvents.events(from: state.devices, to: visible)
        state.devices = visible
        guard log != nil, !events.isEmpty else { return }
        pollDerived(at: read.at)
        for event in events { write(event) }
    }


    private func accessChanged(at instant: Date) {
        let now = grants()
        let changed = now.keys.sorted().filter { now[$0] != state.access[$0] }
        state.access = now
        guard log != nil, !changed.isEmpty else { return }
        pollDerived(at: instant)
        for grant in changed {
            write(MachineEvent(at: instant, name: .access, detail: ["grant": .text(grant), "state": .text(now[grant] ?? "")]))
        }
    }


    private func peripheralsChanged(_ signal: PeripheralSignal) {
        guard var held = state.peripherals else { return }
        var events: [MachineEvent]
        switch signal {
        case .displays(let displays, let at):
            events = PeripheralEvents.displays(from: held.displays, to: displays, at: at)
            held.displays = displays
        case .connected(let device, let at):
            (held.bluetooth, events) = PeripheralEvents.bluetooth(connected: true, device, held: held.bluetooth, at: at)
        case .disconnected(let device, let at):
            (held.bluetooth, events) = PeripheralEvents.bluetooth(connected: false, device, held: held.bluetooth, at: at)
        }
        state.peripherals = held
        guard log != nil, let first = events.first else { return }
        pollDerived(at: first.at)
        for event in events { write(event) }
    }

    private func scheduleLight() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + lightInterval, repeating: lightInterval,
                       leeway: .milliseconds(Int(lightInterval * 200)))
        timer.setEventHandler { [weak self] in self?.readLight() }
        lightTimer?.cancel()
        lightTimer = timer
        timer.resume()
    }

    private func readLight() {
        guard log != nil else { return }
        let uncovered = state.displayAwake && state.lidOpen != false
        let lux = uncovered ? ResourceMeter.shared.measure(.machineEvents) { peripheralProbe.lux() } : nil
        let now = Date()
        guard let event = light.read(lux, uncovered: uncovered, at: now) else { return }
        state.peripherals?.lux = light.stated
        pollDerived(at: now)
        write(event)
    }


    private func emit(_ name: MachineEventName,
                      detail: [String: MachineEventValue] = [:],
                      change: ((inout MachineState) -> Void)? = nil) {
        let now = Date()
        queue.async { [self] in
            guard log != nil else { return }
            pollDerived(at: now)
            change?(&state)
            write(MachineEvent(at: now, name: name, detail: detail))
        }
    }

    private func write(_ event: MachineEvent) {
        guard let log else { return }
        do {
            try log.append(event)
        } catch {
            report("machine events: one line was dropped")
            return
        }
        if event.name.isUserOrSystem { onUserOrSystemEvent?() }
    }

    @discardableResult
    private func pollDerived(at instant: Date) -> Bool {
        guard log != nil else { return false }
        var wrote = false
        let lid = MachineReader.lidOpen()
        if let lid, lid != state.lidOpen {
            state.lidOpen = lid
            write(MachineEvent(at: instant, name: lid ? .lidOpen : .lidClose))
            wrote = true
        } else if lid == nil {
            state.lidOpen = nil
        }
        let power = MachineReader.power()
        let batteryChanged = power.percent != state.batteryPercent
        if power.source != state.power, power.source != .unknown {
            state.power = power.source
            state.batteryPercent = power.percent
            var detail: [String: MachineEventValue] = [:]
            if let percent = power.percent { detail["battery_percent"] = .number(percent) }
            write(MachineEvent(at: instant,
                               name: power.source == .ac ? .powerAC : .powerBattery,
                               detail: detail))
            wrote = true
        } else if batteryChanged {
            state.batteryPercent = power.percent
        }
        return wrote
    }

    private func wifiChanged() {
        let now = Date()
        queue.async { [self] in
            guard log != nil else { return }
            let wifi = MachineReader.wifi()
            let joinedChanged = wifi.joined != state.wifiJoined
            let nameChanged = wifi.name != state.wifiName || wifi.nameUnavailable != state.wifiNameUnavailable
            guard joinedChanged || (wifi.joined && nameChanged) else { return }
            pollDerived(at: now)
            state.wifiJoined = wifi.joined
            state.wifiName = wifi.name
            state.wifiNameUnavailable = wifi.nameUnavailable
            var detail: [String: MachineEventValue] = [:]
            if let name = wifi.name { detail["name"] = .text(name) }
            if wifi.nameUnavailable { detail["name_unavailable"] = .flag(true) }
            write(MachineEvent(at: now,
                               name: wifi.joined ? .wifiJoin : .wifiLeave,
                               detail: wifi.joined ? detail : [:]))
        }
    }
}

extension MachineEventSources: CWEventDelegate {
    public func linkDidChangeForWiFiInterface(withName interfaceName: String) {
        wifiChanged()
    }

    public func ssidDidChangeForWiFiInterface(withName interfaceName: String) {
        wifiChanged()
    }
}
