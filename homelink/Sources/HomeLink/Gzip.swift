import DeviceFiles
import Foundation
import zlib

enum Gzip {
    static let probe: Int64 = 4 << 20
    static let chunk = 1 << 16

    struct Failed: Error, CustomStringConvertible {
        let status: Int32

        var description: String { "gzip failed with zlib status \(status)" }
    }

    static func compress(_ source: URL, to target: URL, files: DeviceFiles, probe: Int64 = probe) throws -> Bool {
        var stream = z_stream()
        let opened = deflateInit2_(&stream, Z_DEFAULT_COMPRESSION, Z_DEFLATED, MAX_WBITS + 16, 8, Z_DEFAULT_STRATEGY,
                                   zlibVersion(), Int32(MemoryLayout<z_stream>.size))
        guard opened == Z_OK else { throw Failed(status: opened) }
        defer { deflateEnd(&stream) }
        let reader = try files.reader(source)
        defer { reader.close() }
        let writer = try files.writer(target, flush: .barrier)
        do {
            var taken: Int64 = 0
            var made: Int64 = 0
            var output = Data(count: chunk)
            while true {
                let input = try reader.next()
                let flush = input == nil ? Z_FINISH : Z_NO_FLUSH
                let given = input ?? Data()
                taken += Int64(given.count)
                var status = Z_OK
                try given.withUnsafeBytes { raw in
                    stream.next_in = UnsafeMutablePointer(mutating: raw.bindMemory(to: Bytef.self).baseAddress)
                    stream.avail_in = uInt(raw.count)
                    repeat {
                        let have = output.withUnsafeMutableBytes { out -> Int in
                            stream.next_out = out.bindMemory(to: Bytef.self).baseAddress
                            stream.avail_out = uInt(out.count)
                            status = deflate(&stream, flush)
                            return out.count - Int(stream.avail_out)
                        }
                        guard status == Z_OK || status == Z_STREAM_END || status == Z_BUF_ERROR else { throw Failed(status: status) }
                        if status == Z_BUF_ERROR, flush == Z_FINISH, have == 0 { throw Failed(status: status) }
                        if have > 0 {
                            try writer.write(output.prefix(have))
                            made += Int64(have)
                        }
                    } while stream.avail_out == 0 || (flush == Z_FINISH && status != Z_STREAM_END)
                }
                if flush == Z_FINISH { break }
                if taken >= probe, made * 20 > taken * 19 {
                    writer.abandon()
                    return false
                }
            }
            try writer.finish()
            return true
        } catch {
            writer.abandon()
            throw error
        }
    }
}
