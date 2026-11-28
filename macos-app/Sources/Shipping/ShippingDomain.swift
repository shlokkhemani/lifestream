import Evidence
import Foundation
import HomeLink

public protocol ShippingDomain: Sendable {
    var sourceId: String { get }
    var name: String { get }
    func seal(_ request: SealRequest) throws -> [SealedBundle]
    func applied(_ answer: FreshAnswer)
    var behindLive: Bool { get }
    var owes: Bool { get }
    func holds(_ bundle: SealedBundle) -> Bool
    func moved(_ bundle: SealedBundle, sent bytes: Int64)
    func taken(_ bundle: SealedBundle, answer: FreshAnswer)
    func kept(_ bundles: [SealedBundle])
    var unread: Unread? { get }
    var owesHistory: Bool { get }
    var through: Through? { get }
    var unsettled: Bool { get }
}

public struct Unread: Equatable, Sendable {
    public let code: String
    public let message: String
}

public extension ShippingDomain {
    func applied(_ answer: FreshAnswer) {}
    var behindLive: Bool { false }
    var owes: Bool { false }
    func holds(_ bundle: SealedBundle) -> Bool { false }
    func moved(_ bundle: SealedBundle, sent bytes: Int64) {}
    func taken(_ bundle: SealedBundle, answer: FreshAnswer) {}
    func kept(_ bundles: [SealedBundle]) {}
    var unread: Unread? { nil }
    var owesHistory: Bool { false }
    var through: Through? { nil }
    var unsettled: Bool { false }
}

final class SealNote<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var note: Value

    init(_ value: Value) { note = value }

    var value: Value {
        get { lock.withLock { note } }
        set { lock.withLock { note = newValue } }
    }
}

extension Unread {
    static let localAccess = "LOCAL_ACCESS"

    static func files(_ failing: [(locator: String, why: String)]) -> Unread? {
        guard let first = failing.first else { return nil }
        let more = failing.count > 1 ? " and \(failing.count - 1) more" : ""
        return Unread(code: localAccess,
                      message: "\(failing.count) file\(failing.count == 1 ? "" : "s") the store names could not be read for over an hour, "
                          + "left out while the rest ships: \(first.why) (\((first.locator as NSString).lastPathComponent)\(more))")
    }
}

protocol PathFreeError: Error, CustomStringConvertible {}

public enum SealWork {
    public enum Process: String, Sendable {
        case app, watch, cli
    }

    public static func scratch(machine: URL, _ process: Process) -> URL {
        machine.appendingPathComponent("scratch/mac/\(process.rawValue)", isDirectory: true)
    }

    public static func prepare(_ scratch: URL) throws {
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: scratch.path)
        var excluded = scratch
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
    }

    public static func directory(prefix: String, in scratch: URL) throws -> URL {
        try prepare(scratch)
        let work = scratch.appendingPathComponent(named(prefix) + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return work
    }

    static func named(_ prefix: String) -> String { "\(prefix)\(getpid())-" }
}

public struct StagedBlobs: Sendable {
    public static let threshold: Int64 = 256 * 1024

    public let thresholdBytes: Int64
    public let isReady: @Sendable (_ sha256: String) -> Bool
    public let enqueue: @Sendable (_ sha256: String, _ url: URL, _ bytes: Int64, _ kept: Bool, _ kind: WriteKind) -> Void

    public init(thresholdBytes: Int64 = threshold, isReady: @escaping @Sendable (_ sha256: String) -> Bool,
                enqueue: @escaping @Sendable (_ sha256: String, _ url: URL, _ bytes: Int64, _ kept: Bool, _ kind: WriteKind) -> Void) {
        self.thresholdBytes = thresholdBytes
        self.isReady = isReady
        self.enqueue = enqueue
    }
}

extension StagedBlobs {
    struct Large {
        let sha256: String
        let file: URL
        let bytes: Int64
    }

    func ready(_ files: [Large], held: Set<String>, kept: Bool, kind: WriteKind) -> Set<String>? {
        let owed = files.filter { $0.bytes > thresholdBytes && !held.contains($0.sha256) }
        let unready = owed.filter { !isReady($0.sha256) }
        for file in unready { enqueue(file.sha256, file.file, file.bytes, kept, kind) }
        return unready.isEmpty ? Set(owed.map(\.sha256)) : nil
    }
}

public struct SealRequest: Sendable {
    public static let coldInterval: TimeInterval = 3_600

    public let fetchedAt: Date
    public let workDirectory: URL
    public let scratch: URL
    public let custody: SealCustody
    public let owesThrough: Bool
    public let start: Date?
    public let held: @Sendable (Set<String>) -> Set<String>
    public let admitted: @Sendable (_ kind: String, _ digest: String) -> Bool
    public let monthsOwed: @Sendable ([String: Through.Month]) -> [String: Through.Month]?
    public let staged: StagedBlobs?
    public let forceCold: Bool
    public let coldInterval: TimeInterval

    public init(fetchedAt: Date, workDirectory: URL, scratch: URL, custody: SealCustody, owesThrough: Bool = false,
                start: Date? = nil, held: @escaping @Sendable (Set<String>) -> Set<String> = { _ in [] },
                admitted: @escaping @Sendable (_ kind: String, _ digest: String) -> Bool = { _, _ in false },
                monthsOwed: @escaping @Sendable ([String: Through.Month]) -> [String: Through.Month]? = { _ in nil },
                staged: StagedBlobs? = nil, forceCold: Bool = false, coldInterval: TimeInterval = coldInterval) {
        self.fetchedAt = fetchedAt
        self.workDirectory = workDirectory
        self.scratch = scratch
        self.custody = custody
        self.owesThrough = owesThrough
        self.start = start
        self.held = held
        self.admitted = admitted
        self.monthsOwed = monthsOwed
        self.staged = staged
        self.forceCold = forceCold
        self.coldInterval = coldInterval
    }
}

extension SealRequest {
    func through(readThrough: Date, left: Int? = nil, months: Months? = nil) -> Through {
        Through(readThrough: min(readThrough, fetchedAt), statedAt: fetchedAt, left: left, start: left == nil ? nil : start,
                months: months?.stated)
    }

    func owed(_ months: Months) -> [String: Through.Month]? { monthsOwed(months.stated) }
}

enum HistoryPage {
    static let kind = "history"
    static var fact: (String, JSONText) { ("history", .bool(true)) }
    static let recent: TimeInterval = 3_600

    static func paced(_ custody: SealCustody) -> Bool { custody.history && custody.imported == custody.received }
}

public struct SealedBundle: Sendable, Equatable {
    public let file: URL
    public let sidecar: BundleSidecar

    public init(file: URL, sidecar: BundleSidecar) {
        self.file = file
        self.sidecar = sidecar
    }
}

public struct BundleSidecar: Codable, Sendable, Equatable {
    public let id: String
    public let sourceId: String
    public let pass: String?
    public let seal: Int
    public let kind: String?
    public let write: WriteKind
    public let refused: Refusal?
    public let months: [String: Through.Month]?
    public let stagedBlobs: [String]?

    public struct Refusal: Codable, Sendable, Equatable {
        public let code: String
        public let at: Date

        public init(code: String, at: Date) {
            self.code = code
            self.at = at
        }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            code = try container.decode(String.self, forKey: .code)
            let spelled = try container.decode(String.self, forKey: .at)
            guard let at = UTCInstant.date(rfc3339: spelled) else {
                throw DecodingError.dataCorruptedError(forKey: .at, in: container, debugDescription: "not an instant")
            }
            self.at = at
        }

        public func encode(to encoder: any Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(code, forKey: .code)
            try container.encode(UTCInstant.rfc3339(at), forKey: .at)
        }

        enum CodingKeys: String, CodingKey {
            case code, at
        }
    }

    public init(id: String, sourceId: String, pass: String? = nil, seal: Int, kind: String? = nil, write: WriteKind,
                refused: Refusal? = nil, months: [String: Through.Month]? = nil, stagedBlobs: [String]? = nil) {
        self.id = id
        self.sourceId = sourceId
        self.pass = pass
        self.seal = seal
        self.kind = kind
        self.write = write
        self.refused = refused
        self.months = months
        self.stagedBlobs = stagedBlobs.flatMap { $0.isEmpty ? nil : $0 }
    }

    func refused(_ code: String, at: Date) -> BundleSidecar {
        BundleSidecar(id: id, sourceId: sourceId, pass: pass, seal: seal, kind: kind, write: write, refused: Refusal(code: code, at: at),
                      months: months, stagedBlobs: stagedBlobs)
    }

    var statesHistory: Bool { kind == HistoryPage.kind || kind == ImportShipping.kind }

    init(id: String, sourceId: String, custody: SealCustody, kind: String? = nil, write: WriteKind,
         months: [String: Through.Month]? = nil, stagedBlobs: [String]? = nil) {
        self.init(id: id, sourceId: sourceId, pass: custody.pass, seal: custody.seal, kind: kind, write: write, months: months,
                  stagedBlobs: stagedBlobs)
    }

    init(id: String, sourceId: String, custody: SealCustody, history: Bool, live: String? = nil,
         months: [String: Through.Month]? = nil, stagedBlobs: [String]? = nil) {
        self.init(id: id, sourceId: sourceId, custody: custody, kind: history ? HistoryPage.kind : live, write: history ? .later : .new,
                  months: months, stagedBlobs: stagedBlobs)
    }

    enum CodingKeys: String, CodingKey {
        case id, pass, seal, kind, write, refused, months
        case sourceId = "source_id"
        case stagedBlobs = "staged_blobs"
    }
}
