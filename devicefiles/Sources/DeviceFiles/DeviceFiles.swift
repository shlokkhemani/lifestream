import Foundation
import CryptoKit
import Darwin

public final class DeviceFiles: @unchecked Sendable {
    public enum Form: @unchecked Sendable {
        case plain
        case keyed(SymmetricKey)
    }

    struct Keys {
        let files: SymmetricKey
        let name: SymmetricKey
        let digest: SymmetricKey
        let value: SymmetricKey

        init(_ key: SymmetricKey) {
            files = key
            name = Keys.derive(key, "lifestream-mac:1:name")
            digest = Keys.derive(key, "lifestream-mac:1:digest")
            value = Keys.derive(key, "lifestream-mac:1:value")
        }

        static func derive(_ key: SymmetricKey, _ info: String) -> SymmetricKey {
            HKDF<SHA256>.deriveKey(inputKeyMaterial: key, salt: Data(), info: Data(info.utf8), outputByteCount: 32)
        }
    }

    let lock = ReadWriteLock()
    private var keys: Keys?

    public init(_ form: Form) {
        switch form {
        case .plain: keys = nil
        case .keyed(let key): keys = Keys(key)
        }
    }

    public func becomeKeyed(_ key: SymmetricKey, emptying: (_ keyed: DeviceFiles) throws -> Void) throws {
        try lock.exclusive {
            guard keys == nil else { throw DeviceFileError.alreadyKeyed }
            try emptying(DeviceFiles(.keyed(key)))
            keys = Keys(key)
        }
    }

    public func read(_ file: URL, maximumBytes: Int) throws -> Data? {
        try shared { keys in
            guard let fd = try Durable.openForReading(file) else { return nil }
            defer { Darwin.close(fd) }
            let size = try Durable.regularSize(fd, naming: file, maximumBytes: maximumBytes)
            guard let keys else {
                guard size > 0, size <= maximumBytes else {
                    throw DeviceFileError.invalidSizeOrType(name: file.lastPathComponent, maximumBytes: maximumBytes)
                }
                return try Durable.read(fd, count: size, from: 0, naming: file)
            }
            guard size > 0 else {
                throw DeviceFileError.invalidSizeOrType(name: file.lastPathComponent, maximumBytes: maximumBytes)
            }
            let shape = try Shape.of(fd, size: size, naming: file)
            guard shape.plainBytes > 0, shape.plainBytes <= maximumBytes else {
                throw DeviceFileError.invalidSizeOrType(name: file.lastPathComponent, maximumBytes: maximumBytes)
            }
            switch shape {
            case .whole:
                let disk = try Durable.read(fd, count: size, from: 0, naming: file)
                return try WholeFile.decrypt(disk, .mac(keys.files), name: file.lastPathComponent)
            case .log(let walk):
                let opening = LogLayout.Opening(macKey: keys.files, name: file.lastPathComponent)
                let plain = try opening.update(try Durable.read(fd, count: walk.end, from: 0, naming: file))
                _ = try opening.finish()
                return plain
            }
        }
    }

    public func writeNew(_ file: URL, _ data: Data, flush: Flush) throws {
        try shared { keys in
            try Durable.writeNew(bytes(data, keys), to: file, flush: flush)
        }
    }

    public func replace(_ file: URL, with data: Data, commit: Commit) throws {
        try shared { keys in
            try Durable.replace(file, with: bytes(data, keys), commit: commit)
        }
    }

    public func replaceLog(_ file: URL, with data: Data) throws {
        try shared { keys in
            try Durable.replace(file, with: LogLayout.whole(data, macKey: keys?.files), commit: .durable)
        }
    }

    public func writer(_ file: URL, flush: Flush) throws -> Writer {
        try shared { keys in
            try Writer(files: self, url: file, flush: flush, keys: keys)
        }
    }

    public func place(_ made: URL, at file: URL, flush: Flush) throws {
        try shared { keys in
            guard let keys else {
                do {
                    try FileManager.default.moveItem(at: made, to: file)
                } catch {
                    throw Durable.failure("place \(file.lastPathComponent)", code: Durable.posixCode(of: error))
                }
                try DeviceFiles.syncFile(file, flush: flush)
                return
            }
            guard let source = try Durable.openForReading(made) else {
                throw Durable.failure("open \(made.lastPathComponent)", code: ENOENT)
            }
            defer { Darwin.close(source) }
            let beside = file.deletingLastPathComponent().appendingPathComponent(".\(file.lastPathComponent).placing")
            let target = try Durable.createAfresh(beside)
            do {
                defer { Darwin.close(target) }
                let encrypting = WholeFile.Encrypting(.mac(keys.files))
                var chunk = Data(count: WholeFile.segment)
                while true {
                    let read = chunk.withUnsafeMutableBytes { Darwin.read(source, $0.baseAddress!, $0.count) }
                    if read < 0 && errno == EINTR { continue }
                    guard read >= 0 else { throw Durable.failure("read \(made.lastPathComponent)") }
                    if read == 0 { break }
                    try Durable.write(encrypting.update(chunk.prefix(read)), to: target)
                }
                try Durable.write(encrypting.finish(), to: target)
                try Durable.issue(flush, on: target, naming: file)
                guard Darwin.rename(beside.path, file.path) == 0 else {
                    throw Durable.failure("place \(file.lastPathComponent)")
                }
            } catch {
                Darwin.unlink(beside.path)
                throw error
            }
            Darwin.unlink(made.path)
        }
    }

    public func reader(_ file: URL, from offset: Int64 = 0) throws -> Reader {
        try shared { keys in
            guard let fd = try Durable.openForReading(file) else {
                throw Durable.failure("open \(file.lastPathComponent)", code: ENOENT)
            }
            let name = file.lastPathComponent
            guard let keys else {
                guard offset == 0 || Darwin.lseek(fd, off_t(offset), SEEK_SET) == off_t(offset) else {
                    Darwin.close(fd)
                    throw Durable.failure("seek \(name)")
                }
                return Reader(descriptor: fd, opening: nil, name: name)
            }
            let opening: Unsealing
            do {
                opening = try Durable.firstByte(fd, naming: file) == LogLayout.mark
                    ? LogLayout.Opening(macKey: keys.files, name: name)
                    : WholeFile.Decrypting(.mac(keys.files), name: name)
            } catch {
                Darwin.close(fd)
                throw error
            }
            return Reader(descriptor: fd, opening: opening, name: name, skipping: offset)
        }
    }

    public func readable<T>(_ file: URL, in scratch: URL, _ body: (URL) throws -> T) throws -> T {
        guard let copy = try plainCopy(of: file, in: scratch) else { return try body(file) }
        defer { Darwin.unlink(copy.path) }
        return try body(copy)
    }

    private func plainCopy(of file: URL, in scratch: URL) throws -> URL? {
        guard keyed else { return nil }
        let source = try reader(file)
        do {
            try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
        } catch {
            throw Durable.failure("make \(scratch.lastPathComponent)", code: Durable.posixCode(of: error))
        }
        let copy = scratch.appendingPathComponent(UUID().uuidString.lowercased() + "-" + file.lastPathComponent)
        let target = try Durable.create(copy)
        do {
            defer { Darwin.close(target) }
            while let chunk = try source.next() { try Durable.write(chunk, to: target) }
        } catch {
            Darwin.unlink(copy.path)
            throw error
        }
        return copy
    }

    public func size(of file: URL) throws -> Int {
        try shared { keys in
            guard let fd = try Durable.openForReading(file) else {
                throw Durable.failure("open \(file.lastPathComponent)", code: ENOENT)
            }
            defer { Darwin.close(fd) }
            let size = try Durable.regularSize(fd, naming: file, maximumBytes: Int.max)
            guard keys != nil, size > 0 else { return size }
            return try Shape.of(fd, size: size, naming: file).plainBytes
        }
    }

    public func log(_ file: URL) throws -> Log {
        try shared { keys in
            try Log(files: self, url: file, keys: keys)
        }
    }

    public func digest(_ bytes: UnsafeRawBufferPointer) -> Data {
        shared { keys in
            guard let keys else { return Data(SHA256.hash(data: bytes)) }
            return Data(HMAC<SHA256>.authenticationCode(for: bytes, using: keys.digest))
        }
    }

    public var keyed: Bool {
        shared { $0 != nil }
    }

    public func name(_ text: String) -> String {
        shared { keys in
            guard let keys else { return text }
            return HMAC<SHA256>.authenticationCode(for: Data(text.utf8), using: keys.name)
                .map { String(format: "%02x", $0) }.joined()
        }
    }

    public func values() -> Values {
        Values(files: self)
    }

    func shared<T>(_ body: (Keys?) throws -> T) rethrows -> T {
        try lock.shared { try body(keys) }
    }

    private func bytes(_ data: Data, _ keys: Keys?) -> Data {
        guard let keys else { return data }
        return WholeFile.encrypt(data, .mac(keys.files))
    }
}

protocol Unsealing: AnyObject {
    func update(_ disk: Data) throws -> Data
    func finish() throws -> Data
}

enum Shape {
    case whole(WholeFile.Layout)
    case log(LogLayout.Walk)

    var plainBytes: Int {
        switch self {
        case .whole(let layout): return layout.plainLength
        case .log(let walk): return walk.plainBytes
        }
    }

    static func of(_ fd: Int32, size: Int, naming url: URL) throws -> Shape {
        guard size > 0 else { throw DeviceFileError.unreadable(name: url.lastPathComponent, why: "it is empty") }
        let first = try Durable.read(fd, count: 1, from: 0, naming: url)[0]
        switch first {
        case WholeFile.mark:
            return .whole(try WholeFile.layout(size: size, segment: WholeFile.segment, name: url.lastPathComponent))
        case LogLayout.mark:
            return .log(try LogLayout.walk(fd, size: size, naming: url))
        default:
            throw DeviceFileError.unreadable(name: url.lastPathComponent, why: "it is not a file this Mac encrypted")
        }
    }
}

final class ReadWriteLock: @unchecked Sendable {
    private let lock: UnsafeMutablePointer<pthread_rwlock_t>

    init() {
        lock = .allocate(capacity: 1)
        pthread_rwlock_init(lock, nil)
    }

    deinit {
        pthread_rwlock_destroy(lock)
        lock.deallocate()
    }

    func shared<T>(_ body: () throws -> T) rethrows -> T {
        pthread_rwlock_rdlock(lock)
        defer { pthread_rwlock_unlock(lock) }
        return try body()
    }

    func exclusive<T>(_ body: () throws -> T) rethrows -> T {
        pthread_rwlock_wrlock(lock)
        defer { pthread_rwlock_unlock(lock) }
        return try body()
    }

    func tryShared() -> Bool {
        guard pthread_rwlock_tryrdlock(lock) == 0 else { return false }
        pthread_rwlock_unlock(lock)
        return true
    }
}
