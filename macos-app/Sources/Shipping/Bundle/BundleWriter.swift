import DeviceFiles
import Evidence
import Foundation

enum BundleWriter {
    static let manifestFormat = "org.lifestreamprotocol.acquisition/1"
    static let manifestFile = "manifest.json"

    static func basicInstant(_ fetchedAt: Date) -> String {
        UTCInstant.basic(fetchedAt)
    }

    static func id(sourceId: String, fetchedAt: Date) -> String {
        "\(sourceId)/\(basicInstant(fetchedAt))"
    }

    static func fileName(sourceId: String, fetchedAt: Date) -> String {
        "\(sourceId.replacingOccurrences(of: ":", with: "_"))__\(basicInstant(fetchedAt)).zip"
    }

    struct File {
        let name: String
        let content: Content

        enum Content {
            case file(URL)
            case kept(URL)
            case bytes(Data)
        }
    }

    struct Blob: Sendable {
        let sha256: String
        let file: URL?
        var opener: FileOpener = .own
        var kept = false
    }

    static let missingFiles = "files this Mac no longer holds"

    struct Written: Equatable {
        let file: URL
        let id: String
        let sourceId: String
        let carried: [String]
        let held: [String]
        let staged: [String]
        let files: [ZipWriter.Member]

        var named: [String] { (carried + held + staged).sorted() }
    }

    static func write(into directory: URL, sourceId: String, feeder: String, fetchedAt: Date,
                      files: [File], blobs: [Blob] = [], stagedBlobs: [String] = [],
                      held: (Set<String>) -> Set<String> = { _ in [] },
                      facts: [(String, JSONText)], custody: (seal: SealCustody, lost: [Lost])?,
                      through deviceFiles: DeviceFiles) throws -> Written {
        precondition(!facts.contains { $0.0 == "blobs_carried" }, "facts.blobs_carried is counted by the writer")
        var here: [String: Blob] = [:]
        for blob in blobs {
            guard ShippingState.isHexSHA256(blob.sha256) else { throw BundleWriterError.blobName(blob.sha256) }
            if blob.file != nil { here[blob.sha256] = blob }
        }
        let named = Set(blobs.map(\.sha256))
        var staged: Set<String> = []
        for sha256 in stagedBlobs {
            guard ShippingState.isHexSHA256(sha256) else { throw BundleWriterError.blobName(sha256) }
            guard !named.contains(sha256) else { throw BundleWriterError.stagedCarried(sha256) }
            guard staged.insert(sha256).inserted else { throw BundleWriterError.stagedTwice(sha256) }
        }
        let held = named.isEmpty ? [] : held(named).intersection(named)
        let missing = named.subtracting(held).subtracting(here.keys)
        precondition(missing.isEmpty || custody != nil, "a bundle that names a file it does not carry states custody")
        let lost = (custody?.lost ?? []) + (missing.isEmpty ? [] : [Lost(items: missing.count, what: missingFiles)])
        let target = directory.appendingPathComponent(fileName(sourceId: deviceFiles.name(sourceId), fetchedAt: fetchedAt))
        try? FileManager.default.removeItem(at: target)
        try? FileManager.default.removeItem(at: URL(fileURLWithPath: target.path + ".partial"))
        let writer = try ZipWriter(path: target, files: deviceFiles)
        do {
            var listed: [JSONText] = []
            var members: [ZipWriter.Member] = []
            var seen: Set<String> = []
            for file in files {
                guard file.name != manifestFile, !file.name.hasPrefix("blobs/"), seen.insert(file.name).inserted else {
                    throw BundleWriterError.listed(file.name)
                }
                let member: ZipWriter.Member
                do {
                    switch file.content {
                    case .file(let url): member = try writer.addFile(file.name, from: url)
                    case .kept(let url): member = try writer.addFile(file.name, kept: url, through: deviceFiles)
                    case .bytes(let data): member = try writer.addBytes(file.name, data)
                    }
                } catch ZipWriterError.changed {
                    throw BundleWriterError.changed(file.name)
                }
                members.append(member)
                listed.append(.object([("file", .string(file.name)), ("sha256", .string(member.sha256)), ("bytes", .int(member.bytes))]))
            }
            var carried: [String] = []
            for (sha256, blob) in here.sorted(by: { $0.key < $1.key }) where !held.contains(sha256) {
                let member = try carry(blob, into: writer, through: deviceFiles)
                guard member.sha256 == sha256 else { throw BundleWriterError.blobMismatch(sha256) }
                carried.append(sha256)
            }
            var manifestMembers: [(String, JSONText)] = [
                ("format", .string(manifestFormat)),
                ("source_id", .string(sourceId)),
                ("feeder", .string(feeder)),
                ("fetched_at", .string(UTCInstant.rfc3339(fetchedAt))),
                ("complete", .bool(true)),
                ("files", .array(listed)),
                ("facts", .object(facts + [("blobs_carried", .int(carried.count + staged.count))])),
            ]
            if !staged.isEmpty {
                manifestMembers.append(("staged_blobs", .array(staged.sorted().map { .string("sha256:\($0)") })))
            }
            if let custody { manifestMembers.append(("custody", custody.seal.manifest(sourceId, lost: lost))) }
            let manifest = JSONText.object(manifestMembers)
            _ = try writer.addBytes(manifestFile, manifest.data + Data("\n".utf8))
            try writer.close()
            return Written(file: target, id: id(sourceId: sourceId, fetchedAt: fetchedAt), sourceId: sourceId,
                           carried: carried, held: held.sorted(), staged: staged.sorted(), files: members)
        } catch {
            writer.abort()
            throw error
        }
    }
}

extension BundleWriter {
    private static func carry(_ blob: Blob, into writer: ZipWriter, through deviceFiles: DeviceFiles) throws -> ZipWriter.Member {
        let sha256 = blob.sha256, file = blob.file!
        let read: ((Data) throws -> Void) throws -> Void
        if blob.kept {
            read = { emit in try FileChunks.read(file, through: deviceFiles, emit) }
        } else {
            let opened: OpenedFile
            do { opened = try blob.opener.file(file) } catch let refused as StoreFiles.Unsafe { throw refused } catch {
                throw BundleWriterError.uncarried(sha256, ShipperRunRow.reason(error))
            }
            read = { emit in try opened.chunks(emit) }
        }
        do {
            return try writer.addStream("blobs/\(sha256)") { emit in
                do {
                    try read { chunk in
                        do { try emit(chunk) } catch { throw OwnWrite(error: error) }
                    }
                } catch let own as OwnWrite {
                    throw own.error
                } catch {
                    throw BundleWriterError.uncarried(sha256, ShipperRunRow.reason(error))
                }
            }
        } catch ZipWriterError.changed {
            throw BundleWriterError.blobMismatch(sha256)
        }
    }
}

private struct OwnWrite: Error {
    let error: any Error
}

enum BundleWriterError: Error, Equatable, CustomStringConvertible {
    case listed(String)
    case blobName(String)
    case blobMismatch(String)
    case stagedTwice(String)
    case stagedCarried(String)
    case uncarried(String, String)
    case changed(String)

    var description: String {
        switch self {
        case .listed(let name): return "bundle file \(name) cannot be listed"
        case .blobName(let name): return "blob \(name) is not a hex SHA-256"
        case .blobMismatch(let name): return "blob \(name) bytes do not match its name"
        case .stagedTwice(let name): return "blob \(name) is staged twice"
        case .stagedCarried(let name): return "blob \(name) is both staged and named to carry"
        case .uncarried(let name, let why): return "blob \(name) cannot be carried: \(why)"
        case .changed(let name): return "bundle file \(name) changed while it was written"
        }
    }

    var uncarriedBlob: (sha256: String, why: String)? {
        switch self {
        case .blobMismatch(let name): return (name, "it changed after it was measured")
        case .uncarried(let name, let why): return (name, why)
        default: return nil
        }
    }
}
