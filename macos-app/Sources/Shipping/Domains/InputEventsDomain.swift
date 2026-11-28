import Evidence
import Foundation
import HomeLink
import InputEvents

public final class InputEventsDomain: ShippingDomain {
    static let feeder = "input-events"
    static let batchRetention: TimeInterval = 7 * 24 * 60 * 60

    public let sourceId: String
    public let name = "input_events"
    let batchRoot: URL
    let ledgers: Ledgers
    let clock: @Sendable () -> Date
    private let stated = SealNote<Through?>(nil)

    public init(sourceId: String, batchRoot: URL, ledgers: Ledgers,
                clock: @escaping @Sendable () -> Date = { Date() }) {
        self.sourceId = sourceId
        self.batchRoot = batchRoot
        self.ledgers = ledgers
        self.clock = clock
    }

    public func seal(_ request: SealRequest) throws -> [SealedBundle] {
        let custody = custody(pass: request.custody.pass)
        let (batches, lost) = try custody.owed(try sealedBatches(), received: request.custody.received)
        stated.value = nil
        guard !batches.isEmpty else {
            if request.owesThrough { stated.value = request.through(readThrough: Self.readThrough(fetchedAt: request.fetchedAt)) }
            return []
        }

        var chunks = 0
        var newest: String?
        var newestAt: Date?
        for batch in batches {
            for line in try lines(of: batch) {
                guard let data = line.data(using: .utf8),
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let at = object["at"] as? String, let when = UTCInstant.date(rfc3339: at) else {
                    throw InputEventsDomainError.line(batch)
                }
                chunks += 1
                if newestAt == nil || when > newestAt! {
                    newestAt = when
                    newest = at
                }
            }
        }

        let written = try BundleWriter.write(
            into: request.workDirectory, sourceId: sourceId, feeder: Self.feeder, fetchedAt: request.fetchedAt,
            files: batches.map { BundleWriter.File(name: $0, content: .kept(batchRoot.appendingPathComponent($0))) },
            facts: [("batches", .int(batches.count)),
                    ("chunks", .int(chunks)),
                    ("newest_chunk_at", newest.map { JSONText.string($0) } ?? .null),
                    ("snapshot_taken_at", .string(UTCInstant.rfc3339(request.fetchedAt)))],
            custody: (request.custody, lost), through: ledgers.files)
        try custody.record(batches, at: request.custody.seal, lost: lost)
        return [SealedBundle(file: written.file, sidecar: BundleSidecar(id: written.id, sourceId: sourceId, custody: request.custody, write: .new))]
    }

    public var through: Through? { stated.value }

    public func applied(_ answer: FreshAnswer) {
        guard let imported = answer.sources[sourceId]?.imported else { return }
        custody(pass: answer.pass).reclaimBatches(imported: imported, in: batchRoot, now: clock(),
                                                  retention: Self.batchRetention)
    }

    static func readThrough(fetchedAt: Date) -> Date {
        InputEventBatch.minute(of: fetchedAt.addingTimeInterval(-1))
    }


    private func sealedBatches() throws -> [String] {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: batchRoot.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            throw InputEventsDomainError.root(batchRoot.path)
        }
        return InputEventBatch.sealedBatches(in: batchRoot).sorted(by: JSONText.javaScriptOrder)
    }

    private func lines(of batch: String) throws -> [String] {
        let file = batchRoot.appendingPathComponent(batch)
        if (try? ledgers.files.size(of: file)) == 0 { return [] }
        guard let data = try? ledgers.files.read(file, maximumBytes: BatchFiles.maximumBytes), let text = String(data: data, encoding: .utf8) else {
            throw InputEventsDomainError.unreadable(batch)
        }
        var spellings = text.components(separatedBy: "\n")
        if spellings.last == "" { spellings.removeLast() }
        return spellings
    }

    private func custody(pass: String) -> SpoolCustody {
        SpoolCustody(ledgers: ledgers, pass: pass, source: sourceId, word: "input batches")
    }
}

enum InputEventsDomainError: Error, Equatable, CustomStringConvertible {
    case root(String)
    case unreadable(String)
    case line(String)

    var description: String {
        switch self {
        case .root(let path): return "\(path) is not a directory of input event batches"
        case .unreadable(let batch): return "the batch \(batch) is not readable UTF-8"
        case .line(let batch): return "the batch \(batch) states a line that is not a chunk with an instant"
        }
    }
}
