import Foundation

public struct BundleFileManifest: Sendable, Equatable, Codable {
    public let sha256: String
    public let bytes: UInt64
    public let observations: UInt64
    public let firstSequence: UInt64?
    public let lastSequence: UInt64?

    enum CodingKeys: String, CodingKey {
        case sha256, bytes, observations
        case firstSequence = "first_sequence"
        case lastSequence = "last_sequence"
    }
}

public struct BundleTimeRange: Sendable, Equatable, Codable {
    public let start: String?
    public let end: String?
}

public struct DeviceHardware: Sendable, Equatable {
    public let machineModel: String
    public let marketingName: String
    public let osVersion: String

    public init(machineModel: String, marketingName: String, osVersion: String) {
        self.machineModel = machineModel; self.marketingName = marketingName; self.osVersion = osVersion
    }
}

public struct BundleDevice: Sendable, Equatable, Codable {
    public let installID: String
    public let enrolledAt: String
    public let machineModel: String
    public let marketingName: String
    public let osVersion: String

    public init(install: CaptureInstall, hardware: DeviceHardware) {
        installID = install.id
        enrolledAt = install.createdAt
        machineModel = hardware.machineModel
        marketingName = hardware.marketingName
        osVersion = hardware.osVersion
    }

    enum CodingKeys: String, CodingKey {
        case installID = "install_id"
        case enrolledAt = "enrolled_at"
        case machineModel = "machine_model"
        case marketingName = "marketing_name"
        case osVersion = "os_version"
    }
}

public struct Lost: Sendable, Equatable, Codable {
    public let items: Int
    public let what: String

    public init(items: Int, what: String) {
        self.items = items; self.what = what
    }
}

public struct SourceCustody: Sendable, Equatable, Codable {
    public let seal: Int
    public let lost: [Lost]?
    public let historyThrough: String?
    public let types: [String]?

    public init(seal: Int, lost: [Lost]? = nil, historyThrough: String? = nil, types: [String]? = nil) {
        self.seal = seal; self.lost = lost; self.historyThrough = historyThrough; self.types = types
    }

    enum CodingKeys: String, CodingKey {
        case seal, lost, types
        case historyThrough = "history_through"
    }
}

public struct ExportBundleManifest: Sendable, Equatable, Codable {
    public let schemaVersion: Int
    public let bundleID: String
    public let device: BundleDevice
    public let appVersion: String
    public let createdAt: String
    public let timeRangeCovered: BundleTimeRange
    public let files: [String: BundleFileManifest]
    public let custody: [String: SourceCustody]
    public let satOut: [String]?

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case bundleID = "bundle_id"
        case device
        case appVersion = "app_version"
        case createdAt = "created_at"
        case timeRangeCovered = "time_range_covered"
        case files
        case custody
        case satOut = "sat_out"
    }
}

struct BundleIdentityMaterial: Codable {
    let schemaVersion: Int
    let device: BundleDevice
    let appVersion: String
    let createdAt: String
    let timeRangeCovered: BundleTimeRange
    let files: [String: BundleFileManifest]
    let custody: [String: SourceCustody]
    let satOut: [String]?

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version"
        case device
        case appVersion = "app_version"
        case createdAt = "created_at"
        case timeRangeCovered = "time_range_covered"
        case files
        case custody
        case satOut = "sat_out"
    }
}

public struct BuiltExportBundle: Sendable, Equatable {
    public init(url: URL, manifest: ExportBundleManifest, files: [PendingBundle.File]) {
        self.url = url; self.manifest = manifest; self.files = files
    }
    public let url: URL
    public let manifest: ExportBundleManifest
    public let files: [PendingBundle.File]
}
