import CryptoKit
import Foundation

public struct StagedCaptureLogSlice: Sendable, Equatable {
    public let blobs: [String]
    public let url: URL
    public let sha256: String
    let archiveCRC32: UInt32
    public let bytes: UInt64
    public let observations: UInt64
    public let firstSequence: UInt64?
    public let lastSequence: UInt64?
    public let firstObservedAt: String?
    public let lastObservedAt: String?
}

private struct ExportObservedTimeRange {
    private struct Key: Comparable {
        let wholeSecond: UInt64
        let nanosecond: UInt32

        static func < (lhs: Key, rhs: Key) -> Bool {
            lhs.wholeSecond < rhs.wholeSecond
                || (lhs.wholeSecond == rhs.wholeSecond && lhs.nanosecond < rhs.nanosecond)
        }
    }

    private var earliest: Key?
    private var latest: Key?
    private(set) var start: String?
    private(set) var end: String?

    mutating func include(_ bytes: Data.SubSequence) throws {
        let key = try Self.key(for: bytes)
        if earliest.map({ key < $0 }) ?? true {
            earliest = key
            start = String(decoding: bytes, as: UTF8.self)
        }
        if latest.map({ key > $0 }) ?? true {
            latest = key
            end = String(decoding: bytes, as: UTF8.self)
        }
    }

    private static func key(for bytes: Data.SubSequence) throws -> Key {
        let count = bytes.count
        let start = bytes.startIndex
        func byte(_ offset: Int) -> UInt8 { bytes[start + offset] }
        func digit(_ offset: Int) throws -> UInt64 {
            let value = byte(offset)
            guard value >= 0x30, value <= 0x39 else {
                throw CaptureError.corruptState("export time range contains invalid observed_at")
            }
            return UInt64(value - 0x30)
        }

        guard count >= 20, byte(4) == 0x2D, byte(7) == 0x2D, byte(10) == 0x54,
            byte(13) == 0x3A, byte(16) == 0x3A, byte(count - 1) == 0x5A
        else {
            throw CaptureError.corruptState("export time range contains non-UTC observed_at")
        }
        var wholeSecond: UInt64 = 0
        for offset in [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18] {
            wholeSecond = wholeSecond * 10 + (try digit(offset))
        }
        var nanosecond: UInt32 = 0
        if count > 20 {
            let fractionDigits = count - 21
            guard byte(19) == 0x2E, fractionDigits > 0, fractionDigits <= 9 else {
                throw CaptureError.corruptState("export time range contains invalid observed_at fraction")
            }
            for offset in 20..<(20 + fractionDigits) {
                nanosecond = nanosecond * 10 + UInt32(try digit(offset))
            }
            for _ in fractionDigits..<9 { nanosecond *= 10 }
        }
        return Key(wholeSecond: wholeSecond, nanosecond: nanosecond)
    }
}


extension CaptureStore {
    func stageExportSlices(
        _ wanted: [(domain: CaptureDomain, after: UInt64)],
        namedBytes: UInt64? = nil,
        held: Set<String> = [],
        in directory: URL
    ) async throws -> [CaptureDomain: Result<StagedCaptureLogSlice, any Error>] {
        let asked = wanted.map { ($0.domain, $0.after) }
        let bound = namedBytes.map { NamedBound(bytes: $0, held: held, blobs: blobsDirectory) }
        return try await snapshot { database in
            var staged: [CaptureDomain: Result<StagedCaptureLogSlice, any Error>] = [:]
            for (domain, after) in asked {
                do {
                    staged[domain] = .success(try Self.stage(domain, after: after, bound: bound,
                                                             to: directory.appendingPathComponent(domain.filename), in: database))
                } catch let error as CancellationError {
                    throw error
                } catch {
                    staged[domain] = .failure(error)
                }
            }
            return staged
        }
    }

    func namedBlobs(_ wanted: [(domain: CaptureDomain, after: UInt64)]) async throws -> Set<String> {
        let asked = wanted.map { ($0.domain, $0.after) }
        return try await snapshot { database in
            var named = Set<String>()
            for (domain, after) in asked {
                try database.query(
                    "SELECT line FROM \(domain.table) WHERE sequence > ? AND instr(line, ?) > 0",
                    .integer(Int64(clamping: after)), .blob(Data("\"hash\":\"sha256:".utf8))
                ) { row in
                    try Task.checkCancellation()
                    named.formUnion(try Self.blobHashes(in: row.blob(0)))
                }
            }
            return named
        }
    }

    private struct NamedBound: Sendable {
        let bytes: UInt64
        let held: Set<String>
        let blobs: URL

        func size(of hash: String) throws -> UInt64 {
            guard !held.contains(hash) else { return 0 }
            do {
                return try FileDurability.regularFileSize(at: blobs.appendingPathComponent(String(hash.dropFirst(7))))
            } catch let error as POSIXError where error.code == .ENOENT {
                return 0
            }
        }
    }

    private static func stage(
        _ domain: CaptureDomain,
        after afterSequence: UInt64,
        bound: NamedBound?,
        to destination: URL,
        in database: SQLiteDatabase
    ) throws -> StagedCaptureLogSlice {
        let writer = try FileDurability.createRegularFileExclusively(at: destination)
        defer { try? writer.close() }
        var hasher = SHA256()
        var crc = CRC32.Accumulator()
        var range = ExportObservedTimeRange()
        var hashes: [String] = []
        var named = Set<String>()
        var namedBytes: UInt64 = 0
        var observations: UInt64 = 0
        var buffer = Data()
        func flush() throws {
            try writer.write(contentsOf: buffer)
            hasher.update(data: buffer)
            crc.update(buffer)
            buffer.removeAll(keepingCapacity: true)
        }
        try Self.forEachLine(domain, after: afterSequence, in: database) { _, line in
            let new = try Self.blobHashes(in: line).filter { !named.contains($0) }
            if let bound {
                let bytes = try new.reduce(namedBytes) { $0 + (try bound.size(of: $1)) }
                guard observations == 0 || bytes < bound.bytes else { return false }
                namedBytes = bytes
            }
            try range.include(try Self.observedAt(in: line))
            hashes += new
            named.formUnion(new)
            buffer.append(line)
            buffer.append(0x0A)
            observations += 1
            if buffer.count >= 1_048_576 { try flush() }
            return true
        }
        try flush()
        try writer.synchronize()
        return .init(
            blobs: hashes,
            url: destination,
            sha256: "sha256:" + hasher.finalize().map { String(format: "%02x", $0) }.joined(),
            archiveCRC32: crc.finalized,
            bytes: try FileDurability.regularFileSize(at: destination),
            observations: observations,
            firstSequence: observations == 0 ? nil : afterSequence + 1,
            lastSequence: observations == 0 ? nil : afterSequence + observations,
            firstObservedAt: range.start,
            lastObservedAt: range.end)
    }

    private static func observedAt(in line: Data) throws -> Data.SubSequence {
        guard let marker = line.range(of: Data("\"observed_at\":\"".utf8)),
            let end = line[marker.upperBound...].firstIndex(of: 0x22)
        else {
            throw CaptureError.corruptState("capture entry has no observed_at")
        }
        return line[marker.upperBound..<end]
    }

    static func blobHashes(in line: Data) throws -> [String] {
        let marker = Data("\"hash\":\"sha256:".utf8)
        var result: [String] = []
        var search = line.startIndex
        while search < line.endIndex, let match = line.range(of: marker, in: search..<line.endIndex) {
            let end = match.upperBound + 64
            guard end < line.endIndex, line[end] == 0x22 else {
                throw CaptureError.corruptState("invalid export blob reference framing")
            }
            let hash = "sha256:" + String(decoding: line[match.upperBound..<end], as: UTF8.self)
            guard SHA256Digest.isCanonicalTagged(hash) else {
                throw CaptureError.corruptState("invalid export blob reference")
            }
            if !result.contains(hash) { result.append(hash) }
            search = end + 1
        }
        return result.isEmpty || !isGone(line) ? result : []
    }

    private static func isGone(_ line: Data) -> Bool {
        guard let entry = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return false }
        return entry["kind"] as? String == "gone"
    }

    func createExportStagingDirectory() throws -> URL {
        let directory = exportStagingRoot.appendingPathComponent("staging-\(UUID().uuidString)", isDirectory: true)
        try FileDurability.createPrivateDirectoryDurably(at: directory)
        return directory
    }
}


extension CaptureStore {
    public func storeBlob(_ data: Data) async throws -> String {
        try await storeBlob(data, tagged: SHA256Digest.tagged(data))
    }

    func storeBlob(_ data: Data, tagged: String) async throws -> String {
        try admit(bytes: Int64(data.count))
        try await finishPendingPhotoCleanup()
        return try publishBlob(tagged: tagged) { destination in
            try FileDurability.writeNewRegularFileDurably(data, to: destination)
        }
    }

    public func storeBlob(file: OwnedMediaFile) async throws -> (hash: String, bytes: UInt64) {
        try admit(bytes: 0)
        try await finishPendingPhotoCleanup()
        let stagedURL = blobsDirectory.appendingPathComponent(".media-\(UUID().uuidString)")
        let worker = Task.detached(priority: Task.currentPriority) {
            try Task.checkCancellation()
            let admitted = try FileDurability.openRegularFileForReading(at: file.url)
            try admitted.close()
            try FileManager.default.moveItem(at: file.url, to: stagedURL)
            let staged = OwnedMediaFile(takingOwnershipOf: stagedURL)
            try FileDurability.protectMediaFile(at: stagedURL)
            let hash = try SHA256Digest.taggedFile(at: stagedURL)
            let bytes = try FileDurability.regularFileSize(at: stagedURL)
            try Task.checkCancellation()
            return (staged, hash, bytes)
        }
        let (staged, hash, bytes) = try await withTaskCancellationHandler {
            try await worker.value
        } onCancel: { worker.cancel() }
        _ = try publishBlob(tagged: hash) { destination in
            try FileManager.default.moveItem(at: staged.url, to: destination)
            try FileDurability.synchronizeParentDirectory(of: destination)
        }
        return (hash, bytes)
    }

    private func publishBlob(tagged: String, create: (URL) throws -> Void) throws -> String {
        let hex = String(tagged.dropFirst("sha256:".count))
        let destination = blobsDirectory.appendingPathComponent(hex)
        do {
            guard try SHA256Digest.taggedFile(at: destination) == tagged else {
                throw CaptureError.corruptState("blob hash path contains different bytes: \(hex)")
            }
            try FileDurability.synchronizeFile(at: destination)
            try FileDurability.synchronizeParentDirectory(of: destination)
        } catch let error as POSIXError where error.code == .ENOENT {
            try create(destination)
        }
        return tagged
    }

    func blobURL(_ hash: String) throws -> URL {
        guard SHA256Digest.isCanonicalTagged(hash) else {
            throw CaptureError.corruptState("invalid blob reference")
        }
        return blobsDirectory.appendingPathComponent(String(hash.dropFirst(7)))
    }

    public func blobFile(forTaggedHash hash: String) throws -> URL? {
        let url = try blobURL(hash)
        do {
            guard try SHA256Digest.taggedFile(at: url) == hash else {
                throw CaptureError.corruptState("referenced blob hash mismatch")
            }
            return url
        } catch let error as POSIXError where error.code == .ENOENT {
            return nil
        }
    }

    public struct VerifiedBlob: Sendable {
        public let url: URL
        public let hash: String
        public let bytes: UInt64
        let crc32: UInt32
    }

    public func validatedBlobInventory(archiveChecksum: Bool = false, hashes: Set<String>? = nil) async throws -> [VerifiedBlob] {
        let directory = blobsDirectory
        let worker = Task.detached(priority: Task.currentPriority) {
            let files: [URL]
            if let hashes {
                guard hashes.allSatisfy(SHA256Digest.isCanonicalTagged) else {
                    throw CaptureError.corruptState("invalid export blob reference")
                }
                files = hashes.sorted().map { directory.appendingPathComponent(String($0.dropFirst(7))) }
            } else {
                files = try FileManager.default.contentsOfDirectory(
                    at: directory, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])
                    .sorted { $0.lastPathComponent < $1.lastPathComponent }
            }
            return try files.compactMap { file -> VerifiedBlob? in
                try Task.checkCancellation()
                let expected = "sha256:" + file.lastPathComponent
                guard SHA256Digest.isCanonicalTagged(expected) else {
                    throw CaptureError.corruptState("blob entry is not a canonical content-addressed file")
                }
                let digest: (hash: String, bytes: UInt64, crc32: UInt32)
                do {
                    digest = try SHA256Digest.inspectFile(at: file, archiveChecksum: archiveChecksum)
                } catch let error as POSIXError where error.code == .ENOENT {
                    return nil
                }
                guard digest.hash == expected else {
                    throw CaptureError.corruptState("blob bytes do not match their content-addressed filename")
                }
                return VerifiedBlob(url: file, hash: digest.hash, bytes: digest.bytes, crc32: digest.crc32)
            }
        }
        return try await withTaskCancellationHandler { try await worker.value }
            onCancel: { worker.cancel() }
    }

    public func blobInventory() throws -> [(hash: String, bytes: UInt64)] {
        let keys: Set<URLResourceKey> = [.fileSizeKey]
        return try FileManager.default.contentsOfDirectory(
            at: blobsDirectory, includingPropertiesForKeys: Array(keys), options: [.skipsHiddenFiles])
            .compactMap { file in
                let hash = "sha256:" + file.lastPathComponent
                guard SHA256Digest.isCanonicalTagged(hash) else { return nil }
                let bytes = try file.resourceValues(forKeys: keys).fileSize ?? 0
                return (hash, UInt64(max(bytes, 0)))
            }
    }
}


extension CaptureStore {
    public func photoExportFloor() throws -> UInt64 {
        try Self.fact(Fact.photosClearedThrough, in: database).flatMap(UInt64.init) ?? 0
    }

    func clearPhotoCopies(through: UInt64) async throws {
        let floor = try photoExportFloor()
        let captured = try lastSequence(.photos)
        guard through >= floor, through <= captured else {
            throw CaptureError.corruptState("photo clearing is outside captured history")
        }
        var photoHashes = Set<String>()
        var otherHashes = Set<String>()
        let marker = Data("\"hash\":\"sha256:".utf8)
        for domain in CaptureDomain.allCases {
            try database.query(
                "SELECT sequence, line FROM \(domain.table) WHERE instr(line, ?) > 0", .blob(marker)
            ) { row in
                let hashes = try Self.blobHashes(in: row.blob(1))
                if domain == .photos && UInt64(row.integer(0)) <= through {
                    photoHashes.formUnion(hashes)
                } else {
                    otherHashes.formUnion(hashes)
                }
            }
        }
        try database.write {
            try Self.setFact(Fact.photosClearedThrough, String(through), in: database)
            try Self.setFact(Fact.photoCleanup, "pending", in: database)
        }
        for hash in photoHashes.subtracting(otherHashes).sorted() {
            let file = blobsDirectory.appendingPathComponent(String(hash.dropFirst(7)))
            do {
                try FileDurability.removeRegularFileIfPresent(at: file)
            } catch let error as POSIXError where error.code == .ENOENT {
            }
        }
        try FileDurability.synchronizeDirectory(at: blobsDirectory)
        try database.write { try Self.setFact(Fact.photoCleanup, nil, in: database) }
    }

    public func finishPendingPhotoCleanup() async throws {
        if try Self.fact(Fact.photoCleanup, in: database) != nil {
            try await clearPhotoCopies(through: try photoExportFloor())
        }
    }

    func clearImportedPhotos(through: UInt64) async throws {
        try await finishPendingPhotoCleanup()
        guard through > (try photoExportFloor()) else { return }
        try await clearPhotoCopies(through: through)
        _ = try append(domain: .location, draft: .init(kind: "lifecycle", observedAt: CaptureTime.rfc3339(AppClock.now),
            payload: .object(["event": .string("photo_copies_cleared"), "through_sequence": .unsigned(through)])))
    }

    func clearedPhotoCopies(_ domain: CaptureDomain, after: UInt64, through: UInt64) throws -> Set<String> {
        let floor: UInt64
        switch domain {
        case .photos: floor = try photoExportFloor()
        case .contacts: floor = try Self.fact(Fact.contactsClearedThrough, in: database).flatMap(UInt64.init) ?? 0
        default: return []
        }
        let last = min(through, floor)
        guard after < last else { return [] }
        var named = Set<String>()
        try database.query(
            "SELECT line FROM \(domain.table) WHERE sequence > ? AND sequence <= ? AND instr(line, ?) > 0",
            .integer(Int64(after)), .integer(Int64(last)), .blob(Data("\"hash\":\"sha256:".utf8))
        ) { row in named.formUnion(try Self.blobHashes(in: row.blob(0))) }
        return try Set(named.filter { hash in
            try !FileDurability.entryExists(at: blobsDirectory.appendingPathComponent(String(hash.dropFirst(7))))
        })
    }
}
