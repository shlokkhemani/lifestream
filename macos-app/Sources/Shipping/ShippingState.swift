import DeviceFiles
import Evidence
import Foundation
import HomeLink
import os

public struct ShippingState: Sendable {
    static let log = Logger(subsystem: "org.lifestreamprotocol.screen-capture", category: "shipping")

    public let root: URL
    public let files: DeviceFiles

    public init(root: URL, files: DeviceFiles) {
        self.root = root
        self.files = files
    }

    public static var defaultRoot: URL { root(home: FileManager.default.homeDirectoryForCurrentUser) }

    public static func root(home: URL) -> URL {
        home.appendingPathComponent("Library/Application Support/lifestream/ship", isDirectory: true)
    }

    public var scheduleFile: URL { root.appendingPathComponent("schedule.json") }
    public var ledgers: Ledgers { Ledgers(root: root.appendingPathComponent("ledger", isDirectory: true), files: files) }
    public var pendingDirectory: URL { root.appendingPathComponent("pending", isDirectory: true) }
    public var workDirectory: URL { root.appendingPathComponent("work", isDirectory: true) }
    public var hashCacheDirectory: URL { root.appendingPathComponent("hash-cache", isDirectory: true) }
    public var sessionDirectory: URL { root.appendingPathComponent("sessions", isDirectory: true) }
    public var photosDirectory: URL { root.appendingPathComponent("photos", isDirectory: true) }
    public var carriedDirectory: URL { root.appendingPathComponent("carried", isDirectory: true) }
    public var credentialsFile: URL { root.appendingPathComponent("credentials.json") }

    public static func fileName(forSource sourceId: String) -> String {
        sourceId.replacingOccurrences(of: ":", with: "_")
    }

    public func hashCacheFile(_ sourceId: String) -> URL {
        hashCacheDirectory.appendingPathComponent(ledgers.fileName(forSource: sourceId) + ".json")
    }

    public func prepare() throws {
        for directory in [root, ledgers.root, pendingDirectory, workDirectory, hashCacheDirectory] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
        }
    }

    public static func isHexSHA256(_ text: String) -> Bool {
        text.utf8.count == 64 && text.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }


    public func readSchedule() -> ShippingSchedule {
        do {
            guard let data = try files.read(scheduleFile, maximumBytes: Self.mostKept) else { return ShippingSchedule() }
            return try ShippingSchedule.decoder.decode(ShippingSchedule.self, from: data)
        } catch {
            Self.log.error("schedule.json does not read and is replaced: \(String(describing: error), privacy: .public)")
            return ShippingSchedule()
        }
    }

    public func writeSchedule(_ schedule: ShippingSchedule) throws {
        try Self.replace(scheduleFile, with: try ShippingSchedule.encoder.encode(schedule) + Data("\n".utf8),
                         commit: .durable, files: files)
    }


    public static func sidecarFile(for bundle: URL) -> URL {
        URL(fileURLWithPath: bundle.path + ".json")
    }

    public func writeSidecar(_ bundle: SealedBundle) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try Self.replace(Self.sidecarFile(for: bundle.file), with: try encoder.encode(bundle.sidecar) + Data("\n".utf8), files: files)
    }

    public func pendingBundles() throws -> [SealedBundle] {
        try bundles(in: pendingDirectory)
    }

    public func recoverWork() throws {
        for bundle in try bundles(in: workDirectory) {
            _ = try park(bundle)
        }
    }

    public func park(_ bundle: SealedBundle) throws -> SealedBundle {
        let destination = pendingDirectory.appendingPathComponent(bundle.file.lastPathComponent)
        if destination.path != bundle.file.path {
            try? FileManager.default.removeItem(at: destination)
            try? FileManager.default.removeItem(at: Self.sidecarFile(for: destination))
            try FileManager.default.moveItem(at: bundle.file, to: destination)
            try FileManager.default.moveItem(at: Self.sidecarFile(for: bundle.file), to: Self.sidecarFile(for: destination))
        }
        return SealedBundle(file: destination, sidecar: bundle.sidecar)
    }

    public func refuse(_ bundle: SealedBundle, code: String, at: Date) throws -> SealedBundle {
        let refused = SealedBundle(file: bundle.file, sidecar: bundle.sidecar.refused(code, at: at))
        try writeSidecar(refused)
        return try park(refused)
    }

    public func spend(_ bundle: SealedBundle) {
        try? FileManager.default.removeItem(at: bundle.file)
        try? FileManager.default.removeItem(at: Self.sidecarFile(for: bundle.file))
    }

    public func retireArchives() {
        for directory in [pendingDirectory, workDirectory] {
            for bundle in (try? bundles(in: directory)) ?? [] where bundle.sidecar.kind == "archive" { spend(bundle) }
        }
        try? FileManager.default.removeItem(at: carriedDirectory.appendingPathComponent("archives.json"))
    }

    private func bundles(in directory: URL) throws -> [SealedBundle] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
        var found: [SealedBundle] = []
        for name in names where name.hasSuffix(".zip") {
            let file = directory.appendingPathComponent(name)
            guard let data = try? files.read(Self.sidecarFile(for: file), maximumBytes: Self.mostKept) else { continue }
            guard let sidecar = try? JSONDecoder().decode(BundleSidecar.self, from: data) else {
                Self.log.error("the sidecar of a bundle does not read; the bundle is spent")
                try? FileManager.default.removeItem(at: file)
                try? FileManager.default.removeItem(at: Self.sidecarFile(for: file))
                continue
            }
            found.append(SealedBundle(file: file, sidecar: sidecar))
        }
        return found
    }


    public static let mostKept = Int.max

    public func size(of bundle: SealedBundle) -> Int {
        (try? files.size(of: bundle.file)) ?? 0
    }

    public static func replace(_ url: URL, with data: Data, commit: DeviceFiles.Commit = .ordered,
                               files: DeviceFiles) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try files.replace(url, with: data, commit: commit)
    }
}

public struct ShippingSchedule: Codable, Sendable, Equatable {
    public var lastRunAt: Date?
    public var lastOutcome: String?
    public var domains: [String: DomainSchedule] = [:]
    public var pass: String?
    public var pairedAt: Date?
    public var sending: Sending?
    public var waitsFor: String?

    public init() {}

    enum CodingKeys: String, CodingKey {
        case domains, pass, sending
        case lastRunAt = "last_run_at"
        case lastOutcome = "last_outcome"
        case pairedAt = "paired_at"
        case waitsFor = "waits_for"
    }

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(UTCInstant.rfc3339(date))
        }
        return encoder
    }()

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let date = UTCInstant.date(rfc3339: text) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not an instant"))
            }
            return date
        }
        return decoder
    }()
}

public struct DomainSchedule: Codable, Sendable, Equatable {
    public var actedAt: Date?
    public var sealedAt: Date?
    public var firstSealedAt: Date?
    public var historySeal: Int?
    public var owesHistory: Bool?
    public var stamp: Int?

    public init(actedAt: Date? = nil, sealedAt: Date? = nil, firstSealedAt: Date? = nil, historySeal: Int? = nil,
                owesHistory: Bool? = nil, stamp: Int? = nil) {
        self.actedAt = actedAt
        self.sealedAt = sealedAt
        self.firstSealedAt = firstSealedAt
        self.historySeal = historySeal
        self.owesHistory = owesHistory
        self.stamp = stamp
    }

    enum CodingKeys: String, CodingKey {
        case actedAt = "acted_at"
        case sealedAt = "sealed_at"
        case firstSealedAt = "first_sealed_at"
        case historySeal = "history_seal"
        case owesHistory = "owes_history"
        case stamp
    }
}
