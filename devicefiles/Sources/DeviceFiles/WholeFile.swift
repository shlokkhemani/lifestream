import Foundation
import CryptoKit
import Darwin

enum WholeFile {
    static let mark: UInt8 = 40
    static let headerBytes = 40
    static let tagBytes = 16
    static let saltBytes = 32
    static let prefixBytes = 7
    static let segment = 64 * 1024
    static let associatedData = Data("lifestream-mac:1:file".utf8)

    struct Keying {
        let key: SymmetricKey
        let associatedData: Data
        let segment: Int

        static func mac(_ key: SymmetricKey) -> Keying {
            Keying(key: key, associatedData: WholeFile.associatedData, segment: WholeFile.segment)
        }

        func fileKey(salt: Data) -> SymmetricKey {
            HKDF<SHA256>.deriveKey(inputKeyMaterial: key, salt: salt, info: associatedData, outputByteCount: 32)
        }

        func firstPlain() -> Int { segment - headerBytes - tagBytes }

        func plainOf(_ index: Int) -> Int { index == 0 ? firstPlain() : segment - tagBytes }

        func diskOf(_ index: Int) -> Int { index == 0 ? segment - headerBytes : segment }
    }

    struct Layout {
        let segments: Int
        let plainLength: Int
    }

    static func layout(size: Int, segment: Int, name: String) throws -> Layout {
        guard size >= headerBytes + tagBytes else { throw damaged(name, "it is shorter than its header and one tag") }
        let segments = size <= segment ? 1 : 1 + (size - segment + segment - 1) / segment
        let lastDisk = segments == 1 ? size - headerBytes : size - segment * (segments - 1)
        if segments > 1 && lastDisk <= tagBytes { throw damaged(name, "an empty segment follows a full one, or bytes follow its end") }
        guard segments <= Int(UInt32.max) else { throw damaged(name, "it has more segments than a file may") }
        return Layout(segments: segments, plainLength: size - headerBytes - segments * tagBytes)
    }

    static func freshHeader() -> Data {
        var header = Data([mark])
        header.append(random(saltBytes + prefixBytes))
        return header
    }

    static func random(_ count: Int) -> Data {
        var bytes = Data(count: count)
        bytes.withUnsafeMutableBytes { arc4random_buf($0.baseAddress!, count) }
        return bytes
    }

    static func nonce(_ prefix: Data, _ index: Int, last: Bool) -> AES.GCM.Nonce {
        var bytes = prefix
        var big = UInt32(index).bigEndian
        withUnsafeBytes(of: &big) { bytes.append(contentsOf: $0) }
        bytes.append(last ? 1 : 0)
        return try! AES.GCM.Nonce(data: bytes)
    }

    static func damaged(_ name: String, _ why: String) -> DeviceFileError {
        .unreadable(name: name, why: why)
    }

    static func encrypt(_ plain: Data, _ keying: Keying, header: Data = freshHeader()) -> Data {
        let encrypting = Encrypting(keying, header: header)
        var out = encrypting.update(plain)
        out.append(encrypting.finish())
        return out
    }

    static func decrypt(_ disk: Data, _ keying: Keying, name: String) throws -> Data {
        _ = try layout(size: disk.count, segment: keying.segment, name: name)
        let decrypting = Decrypting(keying, name: name)
        var out = try decrypting.update(disk)
        out.append(try decrypting.finish())
        return out
    }

    final class Encrypting {
        private let keying: Keying
        private let header: Data
        private let fileKey: SymmetricKey
        private let prefix: Data
        private var held = Data()
        private var index = 0
        private var started = false

        init(_ keying: Keying, header: Data = WholeFile.freshHeader()) {
            self.keying = keying
            self.header = header
            fileKey = keying.fileKey(salt: header.subdata(in: 1..<(1 + saltBytes)))
            prefix = header.subdata(in: (1 + saltBytes)..<headerBytes)
        }

        func update(_ bytes: Data) -> Data {
            var out = start()
            held.append(bytes)
            var at = 0
            while held.count - at > keying.plainOf(index) {
                let room = keying.plainOf(index)
                out.append(segment(held.subdata(in: at..<(at + room)), last: false))
                at += room
            }
            if at > 0 { held = held.subdata(in: at..<held.count) }
            return out
        }

        func finish() -> Data {
            var out = start()
            out.append(segment(held, last: true))
            held = Data()
            return out
        }

        private func start() -> Data {
            guard !started else { return Data() }
            started = true
            return header
        }

        private func segment(_ plain: Data, last: Bool) -> Data {
            let box = try! AES.GCM.seal(plain, using: fileKey, nonce: WholeFile.nonce(prefix, index, last: last))
            index += 1
            var out = box.ciphertext
            out.append(box.tag)
            return out
        }
    }

    final class Decrypting: Unsealing {
        private let keying: Keying
        private let name: String
        private var fileKey: SymmetricKey?
        private var prefix = Data()
        private var held = Data()
        private var index = 0

        init(_ keying: Keying, name: String) {
            self.keying = keying
            self.name = name
        }

        func update(_ disk: Data) throws -> Data {
            held.append(disk)
            try header()
            guard fileKey != nil else { return Data() }
            var out = Data()
            var at = 0
            while held.count - at > keying.diskOf(index) {
                let length = keying.diskOf(index)
                out.append(try segment(held.subdata(in: at..<(at + length)), last: false))
                at += length
            }
            if at > 0 { held = held.subdata(in: at..<held.count) }
            return out
        }

        func finish() throws -> Data {
            try header()
            guard fileKey != nil else { throw damaged(name, "it is shorter than its header and one tag") }
            guard held.count >= tagBytes else { throw damaged(name, "it is cut short") }
            if index > 0 && held.count == tagBytes { throw damaged(name, "an empty segment follows a full one") }
            let out = try segment(held, last: true)
            held = Data()
            return out
        }

        private func header() throws {
            guard fileKey == nil, let first = held.first else { return }
            guard first == mark else { throw damaged(name, "its header says \(first) bytes, not \(headerBytes)") }
            guard held.count >= headerBytes else { return }
            fileKey = keying.fileKey(salt: held.subdata(in: 1..<(1 + saltBytes)))
            prefix = held.subdata(in: (1 + saltBytes)..<headerBytes)
            held = held.subdata(in: headerBytes..<held.count)
        }

        private func segment(_ disk: Data, last: Bool) throws -> Data {
            guard disk.count >= tagBytes, let fileKey else { throw damaged(name, "segment \(index) is shorter than its tag") }
            do {
                let box = try AES.GCM.SealedBox(
                    nonce: WholeFile.nonce(prefix, index, last: last),
                    ciphertext: disk.subdata(in: 0..<(disk.count - tagBytes)),
                    tag: disk.subdata(in: (disk.count - tagBytes)..<disk.count)
                )
                let plain = try AES.GCM.open(box, using: fileKey)
                index += 1
                return plain
            } catch {
                throw damaged(name, "segment \(index) fails its tag")
            }
        }
    }
}

public final class Writer {
    private let files: DeviceFiles
    private let url: URL
    private let flush: DeviceFiles.Flush
    private let keyed: Bool
    private let encrypting: WholeFile.Encrypting?
    private var descriptor: Int32

    init(files: DeviceFiles, url: URL, flush: DeviceFiles.Flush, keys: DeviceFiles.Keys?) throws {
        self.files = files
        self.url = url
        self.flush = flush
        keyed = keys != nil
        encrypting = keys.map { WholeFile.Encrypting(.mac($0.files)) }
        descriptor = try Durable.create(url)
    }

    deinit {
        if descriptor >= 0 { Darwin.close(descriptor) }
    }

    public func write(_ bytes: Data) throws {
        try files.shared { keys in
            try stillOpen(keys)
            try Durable.write(encrypting?.update(bytes) ?? bytes, to: descriptor)
        }
    }

    public func finish() throws {
        try files.shared { keys in
            try stillOpen(keys)
            if let encrypting { try Durable.write(encrypting.finish(), to: descriptor) }
            try Durable.issue(flush, on: descriptor, naming: url)
            Darwin.close(descriptor)
            descriptor = -1
        }
    }

    public func abandon() {
        if descriptor >= 0 { Darwin.close(descriptor) }
        descriptor = -1
        Darwin.unlink(url.path)
    }

    private func stillOpen(_ keys: DeviceFiles.Keys?) throws {
        guard descriptor >= 0 else { throw Durable.failure("write \(url.lastPathComponent)", code: EBADF) }
        guard (keys != nil) == keyed else {
            abandon()
            throw DeviceFileError.switched(name: url.lastPathComponent)
        }
    }
}

public final class Reader {
    private var descriptor: Int32
    private let opening: Unsealing?
    private let name: String
    private var ended = false
    private var skipping: Int64

    init(descriptor: Int32, opening: Unsealing?, name: String, skipping: Int64 = 0) {
        self.descriptor = descriptor
        self.opening = opening
        self.name = name
        self.skipping = skipping
    }

    deinit {
        close()
    }

    public func next() throws -> Data? {
        while !ended {
            guard descriptor >= 0 else { throw Durable.failure("read \(name)", code: EBADF) }
            var chunk = Data(count: WholeFile.segment)
            let read = chunk.withUnsafeMutableBytes { bytes in
                Darwin.read(descriptor, bytes.baseAddress!, bytes.count)
            }
            if read < 0 {
                if errno == EINTR { continue }
                throw Durable.failure("read \(name)")
            }
            if read == 0 {
                ended = true
                close()
                if let last = try opening?.finish(), case let kept = skipped(last), !kept.isEmpty { return kept }
                return nil
            }
            chunk.count = read
            let plain = skipped(try opening?.update(chunk) ?? chunk)
            if !plain.isEmpty { return plain }
        }
        return nil
    }

    private func skipped(_ plain: Data) -> Data {
        guard skipping > 0 else { return plain }
        let dropped = min(Int64(plain.count), skipping)
        skipping -= dropped
        return Data(plain.dropFirst(Int(dropped)))
    }

    public func close() {
        if descriptor >= 0 { Darwin.close(descriptor) }
        descriptor = -1
    }
}
