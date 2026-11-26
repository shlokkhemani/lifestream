import CryptoKit
import DeviceFiles
import Foundation
import HomeLink
import IOKit
import Shipping

enum MacLink {
    private static let made = Made()

    static var shared: HomeLink? { made.link }

    static func opened() throws -> HomeLink {
        guard let shared else { throw UsageError.message(MacProcess.current.refusal() ?? MacProcess.refusedWords) }
        return shared
    }

    static func link(_ process: MacProcess, files: DeviceFiles, root: URL = ShippingState.defaultRoot,
                     transport: any HomeTransport = URLSessionTransport(),
                     network: any NetworkWatch = SystemNetwork.shared) -> HomeLink {
        let state = ShippingState(root: root, files: files)
        return HomeLink(device: device(), credentials: FileCredentials(url: state.credentialsFile, files: files),
                        folder: state.root, transport: transport, network: network, files: files,
                        becomeKeyed: { try process.becomeKeyed() })
    }

    private final class Made: @unchecked Sendable {
        private let lock = NSLock()
        private var built: HomeLink?

        var link: HomeLink? {
            lock.withLock {
                if let built { return built }
                let process = MacProcess.current
                guard let files = process.files else { return nil }
                built = MacLink.link(process, files: files)
                return built
            }
        }
    }

    static func device() -> HomeLink.Device {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        return HomeLink.Device(kind: .mac, version: version, model: model(), serial4: serial().map(serial4), stamp: Int(version))
    }

    static func serial4(_ serial: String) -> String {
        String(SHA256.hash(data: Data(serial.trimmingCharacters(in: .whitespacesAndNewlines).utf8))
            .map { String(format: "%02x", $0) }.joined().prefix(4))
    }

    static let settingsFile = ShippingState.defaultRoot.appendingPathComponent(MacSettings.fileName)

    private static func model() -> String {
        if let named = platform("product-name") as? Data,
           let text = String(data: named, encoding: .utf8)?.trimmingCharacters(in: CharacterSet(charactersIn: "\0")) {
            let plain = text.split(separator: "(").first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
            if !plain.isEmpty { return plain }
        }
        var size = 0
        sysctlbyname("hw.model", nil, &size, nil, 0)
        var bytes = [CChar](repeating: 0, count: max(size, 1))
        sysctlbyname("hw.model", &bytes, &size, nil, 0)
        let identifier = String(cString: bytes)
        let letters = identifier.prefix { $0.isLetter }
        return letters.isEmpty ? "Mac" : String(letters)
    }

    private static func serial() -> String? {
        platform(kIOPlatformSerialNumberKey) as? String
    }

    private static func platform(_ key: String) -> Any? {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }
        return IORegistryEntryCreateCFProperty(service, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
    }
}
