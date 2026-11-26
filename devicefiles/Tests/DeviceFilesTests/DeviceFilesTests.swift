import CryptoKit
import Darwin
import Foundation
import XCTest
@testable import DeviceFiles

final class DeviceFilesTests: FilesTestCase {
    private let commits: [DeviceFiles.Commit] = [.ordered, .durable, .atomic, .pass]

    private func mode(_ url: URL) throws -> Int {
        var info = stat()
        XCTAssertEqual(lstat(url.path, &info), 0)
        return Int(info.st_mode & 0o777)
    }

    private func inode(_ url: URL) -> UInt64 {
        var info = stat()
        XCTAssertEqual(lstat(url.path, &info), 0)
        return UInt64(info.st_ino)
    }

    private func excluded(_ url: URL) throws -> Bool {
        try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup ?? false
    }

    private func readAll(_ reader: Reader) throws -> Data {
        var data = Data()
        while let chunk = try reader.next() { data.append(chunk) }
        return data
    }

    func testReadOfAnAbsentFileIsNilInBothForms() throws {
        for (form, files) in forms() {
            XCTAssertNil(try files.read(file("absent", form), maximumBytes: 10), form)
        }
    }

    func testEachPlainCommitWritesTodaysBytesModeAndBackupFlag() throws {
        let files = DeviceFiles(.plain)
        let data = Data("{\"answer\":1}".utf8)
        for commit in commits {
            let folder = directory.appendingPathComponent("\(commit)")
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appendingPathComponent("state.json")
            try files.replace(url, with: Data("old".utf8), commit: commit)
            try files.replace(url, with: data, commit: commit)
            XCTAssertEqual(try raw(url), data, "\(commit)")
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), ["state.json"], "\(commit) leaves nothing beside")
            switch commit {
            case .ordered, .durable, .pass: XCTAssertEqual(try mode(url), 0o600, "\(commit)")
            case .atomic:
                let today = folder.appendingPathComponent("today.json")
                try data.write(to: today, options: .atomic)
                XCTAssertEqual(try mode(url), try mode(today), "Foundation's own atomic write")
                try FileManager.default.removeItem(at: today)
            }
            XCTAssertEqual(try excluded(url), commit == .pass, "\(commit)")
        }
    }

    func testThePassCommitMakesItsFolder() throws {
        let url = directory.appendingPathComponent("ship/credentials.json")
        try DeviceFiles(.plain).replace(url, with: Data("{}".utf8), commit: .pass)
        XCTAssertEqual(try raw(url), Data("{}".utf8))
    }

    func testEachKeyedCommitWritesEncryptedBytesThatReadBack() throws {
        let files = DeviceFiles(.keyed(testKey))
        let data = Data("{\"answer\":1}".utf8)
        for commit in commits {
            let url = file("\(commit).json")
            try files.replace(url, with: data, commit: commit)
            let disk = try raw(url)
            XCTAssertEqual(disk.first, WholeFile.mark)
            XCTAssertEqual(disk.count, data.count + WholeFile.headerBytes + WholeFile.tagBytes)
            XCTAssertNil(disk.range(of: Data("answer".utf8)))
            XCTAssertEqual(try files.read(url, maximumBytes: 100), data)
            XCTAssertEqual(try excluded(url), commit == .pass, "\(commit)")
        }
    }

    func testEachWriteFlushesAlikeInBothForms() throws {
        var sequences: [[String]] = []
        for (form, files) in forms() {
            var seen: [String] = []
            DeviceFiles.flushObserver = { url, flush in
                seen.append("\(url.lastPathComponent.hasPrefix(".") ? "beside" : url.lastPathComponent) \(flush)")
            }
            try files.writeNew(file("new", form), Data("n".utf8), flush: .full)
            let writer = try files.writer(file("bundle", form), flush: .data)
            try writer.write(vectorPlain(150_000))
            try writer.finish()
            try files.replace(file("state", form), with: Data("s".utf8), commit: .durable)
            try files.replace(file("journal", form), with: Data("j".utf8), commit: .ordered)
            let log = try files.log(file("log", form))
            try log.append(Data("A\n".utf8), flush: .full)
            try log.append(Data("B\n".utf8), flush: nil)
            try log.flush(.barrier)
            try log.truncate()
            try log.append(Data("C\n".utf8), flush: .data)
            sequences.append(seen.map { $0.replacingOccurrences(of: "\(form)-", with: "") })
        }
        XCTAssertEqual(sequences[0], sequences[1])
        XCTAssertEqual(sequences[0], [
            "new full", "bundle data", "beside barrier", "\(directory.lastPathComponent) full", "beside barrier",
            "log full", "log barrier", "log data",
        ])
    }

    func testSizeOfCountsPlainBytes() throws {
        for (form, files) in forms() {
            let whole = file("whole", form)
            try files.writeNew(whole, vectorPlain(100_000), flush: .data)
            XCTAssertEqual(try files.size(of: whole), 100_000, form)
            let streamed = file("streamed", form)
            let writer = try files.writer(streamed, flush: .data)
            for _ in 0..<5 { try writer.write(vectorPlain(30_001)) }
            try writer.finish()
            XCTAssertEqual(try files.size(of: streamed), 150_005, form)
            let empty = file("empty", form)
            try files.writeNew(empty, Data(), flush: .data)
            XCTAssertEqual(try files.size(of: empty), 0, form)
            let log = file("log", form)
            try files.log(log).append(Data("ABC\n".utf8), flush: nil)
            XCTAssertEqual(try files.size(of: log), 4, form)
            XCTAssertThrowsError(try files.size(of: file("absent", form)), form)
        }
    }

    func testAReadIsBoundedByPlainBytes() throws {
        let files = DeviceFiles(.keyed(testKey))
        let url = file("state")
        try files.writeNew(url, vectorPlain(100), flush: .data)
        XCTAssertEqual(try files.read(url, maximumBytes: 100), vectorPlain(100))
        XCTAssertThrowsError(try files.read(url, maximumBytes: 99)) {
            XCTAssertEqual($0 as? DeviceFileError, .invalidSizeOrType(name: "state", maximumBytes: 99))
        }
    }

    func testDigestAndNameAreTodaysValuesPlainAndKeyedUnderTheirOwnKeys() throws {
        let hello = Data("hello".utf8)
        let plain = DeviceFiles(.plain)
        let keyed = DeviceFiles(.keyed(testKey))
        XCTAssertEqual(hello.withUnsafeBytes { plain.digest($0) }, Data(SHA256.hash(data: hello)))
        XCTAssertEqual(hello.withUnsafeBytes { plain.digest($0) }, hex("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"))
        XCTAssertEqual(hello.withUnsafeBytes { keyed.digest($0) }, hex("ac429f12293a591e6a12cc8550220b97ed193ca2fa93ffff137dff99bc6e7884"))
        XCTAssertEqual(plain.name("person-a@example.com"), "person-a@example.com")
        XCTAssertEqual(keyed.name("person-a@example.com"), "ce6c366af6bd5b2de9326b1fa1678b4a25b6983e0ede2e0c59e1dedefc5829ee")
        XCTAssertNotEqual(keyed.name("hello"), hello.withUnsafeBytes { keyed.digest($0) }.map { String(format: "%02x", $0) }.joined())
    }

    func testValuesAnswerTheirArgumentPlainAndAreBoxedKeyed() throws {
        let text = "2026-11-14T10:00:00Z"
        let plain = DeviceFiles(.plain).values()
        XCTAssertEqual(plain.encrypt(text), text)
        XCTAssertEqual(try plain.decrypt(text), text)
        let vector = "wMHCw8TFxsfIycrLrKa0siIndQy3CrsI5ahawimXKekda+sCkjH4nQRR37y2QsaC"
        XCTAssertEqual(Values.encrypt(text, key: DeviceFiles.Keys(testKey).value, nonce: bytes(from: 0xc0, count: 12)), vector)
        let keyed = DeviceFiles(.keyed(testKey)).values()
        XCTAssertEqual(try keyed.decrypt(vector), text)
        let boxed = keyed.encrypt(text)
        XCTAssertNotEqual(boxed, text)
        XCTAssertNotEqual(keyed.encrypt(text), boxed, "a fresh nonce each time")
        XCTAssertEqual(try keyed.decrypt(boxed), text)
        var broken = Data(base64Encoded: vector)!
        broken[broken.count - 1] ^= 1
        XCTAssertThrowsError(try keyed.decrypt(broken.base64EncodedString())) {
            XCTAssertEqual($0 as? DeviceFileError, .unreadable(name: "a value", why: "it fails its tag"))
        }
        XCTAssertThrowsError(try keyed.decrypt(text))
    }

    func testBecomeKeyedRunsOnceAndHoldsEveryCallOutWhileEmptying() throws {
        let files = DeviceFiles(.plain)
        var ran = false
        try files.becomeKeyed(testKey) { _ in
            ran = true
            XCTAssertFalse(files.lock.tryShared(), "no call of the switching instance runs between the emptying and the swap")
        }
        XCTAssertTrue(ran)
        XCTAssertTrue(files.lock.tryShared())
        XCTAssertThrowsError(try files.becomeKeyed(testKey) { _ in XCTFail("a second switch never empties") }) {
            XCTAssertEqual($0 as? DeviceFileError, .alreadyKeyed)
        }
        XCTAssertThrowsError(try DeviceFiles(.keyed(testKey)).becomeKeyed(testKey) { _ in }) {
            XCTAssertEqual($0 as? DeviceFileError, .alreadyKeyed)
        }
    }

    func testEmptyingWritesThroughAKeyedInstanceWhileTheSwitchingOneIsStillPlain() throws {
        let files = DeviceFiles(.plain)
        let fixed = DeviceFiles(.plain)
        let modes = file("app-modes.json")
        let carry = file("app-modes.json.carry")
        let data = Data("{\"private\":[]}".utf8)
        try files.replace(modes, with: data, commit: .durable)
        try files.becomeKeyed(testKey) { keyed in
            let kept = try XCTUnwrap(fixed.read(modes, maximumBytes: 100))
            try keyed.replace(carry, with: kept, commit: .durable)
            XCTAssertEqual(try raw(carry).first, WholeFile.mark)
            XCTAssertEqual(try raw(modes), data, "the switching instance has not switched")
            XCTAssertEqual(Darwin.rename(carry.path, modes.path), 0)
        }
        XCTAssertEqual(try files.read(modes, maximumBytes: 100), data)
        try files.writeNew(file("after"), data, flush: .data)
        XCTAssertEqual(try raw(file("after")).first, WholeFile.mark)
    }

    func testAFailedEmptyingLeavesThePlainFormAndMayRunAgain() throws {
        let files = DeviceFiles(.plain)
        struct Cut: Error {}
        XCTAssertThrowsError(try files.becomeKeyed(testKey) { _ in throw Cut() }) { XCTAssertTrue($0 is Cut) }
        try files.writeNew(file("plain"), Data("p".utf8), flush: .data)
        XCTAssertEqual(try raw(file("plain")), Data("p".utf8))
        try files.becomeKeyed(testKey) { _ in }
        try files.writeNew(file("keyed"), Data("k".utf8), flush: .data)
        XCTAssertEqual(try raw(file("keyed")).first, WholeFile.mark)
    }

    func testAWriterOpenedPlainThrowsSwitchedAfterTheSwitchAndLeavesNothing() throws {
        let files = DeviceFiles(.plain)
        let url = file("bundle.zip")
        let writer = try files.writer(url, flush: .full)
        try writer.write(Data("PK".utf8))
        try files.becomeKeyed(testKey) { _ in }
        XCTAssertThrowsError(try writer.finish()) {
            XCTAssertEqual($0 as? DeviceFileError, .switched(name: "bundle.zip"))
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testAWriterAbandonedLeavesNoPartialFile() throws {
        for (form, files) in forms() {
            let url = file("bundle", form)
            let writer = try files.writer(url, flush: .data)
            try writer.write(vectorPlain(100_000))
            writer.abandon()
            XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), form)
        }
    }

    func testTheWriterDeclaresNoWriteAtAnOffset() throws {
        let source = try String(contentsOf: repository.appendingPathComponent("devicefiles/Sources/DeviceFiles/WholeFile.swift"), encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "public final class Writer {"))
        let end = try XCTUnwrap(source.range(of: "\n}\n", range: start.upperBound..<source.endIndex))
        let declaration = String(source[start.lowerBound..<end.upperBound])
        let calls = declaration.components(separatedBy: "\n").filter { $0.contains("public func") }.map { $0.trimmingCharacters(in: .whitespaces) }
        XCTAssertEqual(calls, ["public func write(_ bytes: Data) throws {", "public func finish() throws {", "public func abandon() {"])
        for word in ["pwrite", "lseek", "seek", "offset", "ftruncate"] {
            XCTAssertNil(declaration.range(of: word), word)
        }
    }

    func testPlaceRenamesPlainAndEncryptsKeyed() throws {
        let data = vectorPlain(70_000)
        let plain = DeviceFiles(.plain)
        let made = file("made.mov")
        try data.write(to: made)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: made.path)
        let before = inode(made)
        let kept = file("kept.mov")
        var flushes: [DeviceFiles.Flush] = []
        DeviceFiles.flushObserver = { _, flush in flushes.append(flush) }
        try plain.place(made, at: kept, flush: .full)
        XCTAssertEqual(inode(kept), before, "a rename: the same file")
        XCTAssertFalse(FileManager.default.fileExists(atPath: made.path))
        XCTAssertEqual(try raw(kept), data)
        XCTAssertEqual(try mode(kept), 0o600)
        XCTAssertEqual(flushes, [.full])

        let keyed = DeviceFiles(.keyed(testKey))
        let madeKeyed = file("made.m4a")
        try data.write(to: madeKeyed)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: madeKeyed.path)
        let keptKeyed = file("kept.m4a")
        flushes = []
        try keyed.place(madeKeyed, at: keptKeyed, flush: .full)
        XCTAssertFalse(FileManager.default.fileExists(atPath: madeKeyed.path))
        XCTAssertEqual(try raw(keptKeyed).first, WholeFile.mark)
        XCTAssertNil(try raw(keptKeyed).range(of: data.prefix(64)))
        XCTAssertEqual(try keyed.read(keptKeyed, maximumBytes: 100_000), data)
        XCTAssertEqual(try keyed.size(of: keptKeyed), data.count)
        XCTAssertEqual(try mode(keptKeyed), 0o600)
        XCTAssertEqual(flushes, [.full])
    }

    func testReadableHandsAPlainFileItselfAndMakesNoCopy() throws {
        let data = vectorPlain(70_000)
        let kept = file("kept.mov")
        try data.write(to: kept)
        let scratch = directory.appendingPathComponent("scratch")
        let seen = try DeviceFiles(.plain).readable(kept, in: scratch) { url -> URL in
            XCTAssertEqual(try raw(url), data)
            return url
        }
        XCTAssertEqual(seen, kept)
        XCTAssertFalse(FileManager.default.fileExists(atPath: scratch.path))
    }

    func testReadableHandsAKeyedFileAsAPlainCopyGoneAfterItsBody() throws {
        let data = vectorPlain(200_000)
        let keyed = DeviceFiles(.keyed(testKey))
        let kept = file("kept.mov")
        let writer = try keyed.writer(kept, flush: .data)
        try writer.write(data)
        try writer.finish()
        let scratch = directory.appendingPathComponent("scratch")
        let seen = try keyed.readable(kept, in: scratch) { url -> URL in
            XCTAssertEqual(try raw(url), data)
            XCTAssertEqual(url.deletingLastPathComponent().path, scratch.path)
            XCTAssertEqual(url.pathExtension, "mov")
            XCTAssertEqual(try mode(url), 0o600)
            return url
        }
        XCTAssertNotEqual(seen, kept)
        XCTAssertFalse(FileManager.default.fileExists(atPath: seen.path))
        XCTAssertEqual(try mode(scratch), 0o700)

        struct Refused: Error {}
        var thrownFrom: URL?
        XCTAssertThrowsError(try keyed.readable(kept, in: scratch) { url -> Void in
            thrownFrom = url
            throw Refused()
        }) { XCTAssertTrue($0 is Refused) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(thrownFrom).path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: scratch.path), [])
        XCTAssertEqual(try raw(kept).first, WholeFile.mark)
    }

    func testReadableOfAnAbsentKeyedFileThrowsAbsenceAndLeavesNoCopy() throws {
        let scratch = directory.appendingPathComponent("scratch")
        XCTAssertThrowsError(try DeviceFiles(.keyed(testKey)).readable(file("absent.mov"), in: scratch) { _ in }) {
            guard case DeviceFileError.io(_, ENOENT) = $0 else { return XCTFail("\($0)") }
        }
        XCTAssertEqual((try? FileManager.default.contentsOfDirectory(atPath: scratch.path)) ?? [], [])
    }

    func testAPlainPlaceRefusesAKeptNameAndAKeyedOneReplacesIt() throws {
        let plain = DeviceFiles(.plain)
        let made = file("made", "plain")
        let kept = file("kept", "plain")
        try Data("new".utf8).write(to: made)
        try Data("old".utf8).write(to: kept)
        XCTAssertThrowsError(try plain.place(made, at: kept, flush: .data))
        XCTAssertEqual(try raw(kept), Data("old".utf8))
        XCTAssertTrue(FileManager.default.fileExists(atPath: made.path))

        let keyed = DeviceFiles(.keyed(testKey))
        let madeKeyed = file("made", "keyed")
        let keptKeyed = file("kept", "keyed")
        try Data("new".utf8).write(to: madeKeyed)
        try keyed.writeNew(keptKeyed, Data("old".utf8), flush: .data)
        try keyed.place(madeKeyed, at: keptKeyed, flush: .data)
        XCTAssertEqual(try keyed.read(keptKeyed, maximumBytes: 100), Data("new".utf8))
        XCTAssertFalse(FileManager.default.fileExists(atPath: madeKeyed.path))
    }

    func testAKeyedPlaceCutAfterItsWriteLeavesNothingAtTheKeptNameAndPlacesAgain() throws {
        let data = vectorPlain(140_000)
        let keyed = DeviceFiles(.keyed(testKey))
        let made = file("made.m4a")
        let kept = file("kept.m4a")
        try data.write(to: made)
        DeviceFiles.failStep = { url, step in url == kept && step == .flush(.data) ? EIO : nil }
        XCTAssertThrowsError(try keyed.place(made, at: kept, flush: .data))
        DeviceFiles.failStep = nil
        XCTAssertFalse(FileManager.default.fileExists(atPath: kept.path), "nothing at the kept name before the rename")
        XCTAssertEqual(try raw(made), data, "the made file is still whole")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["made.m4a"])

        let beside = directory.appendingPathComponent(".kept.m4a.placing")
        try Data(repeating: 0x5a, count: 90_000).write(to: beside)
        try keyed.place(made, at: kept, flush: .data)
        XCTAssertEqual(try keyed.read(kept, maximumBytes: 200_000), data)
        XCTAssertEqual(try mode(kept), 0o600)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["kept.m4a"])
    }

    func testAKeyedPlaceCutAfterItsRenameIsWholeAndPlacesAgainOverIt() throws {
        let data = vectorPlain(70_000)
        let keyed = DeviceFiles(.keyed(testKey))
        let made = file("made.jpg")
        let kept = file("kept.jpg")
        try data.write(to: made)
        try keyed.place(made, at: kept, flush: .data)
        try data.write(to: made)
        XCTAssertEqual(try keyed.read(kept, maximumBytes: 100_000), data, "a file at the kept name is whole")
        try keyed.place(made, at: kept, flush: .data)
        XCTAssertEqual(try keyed.read(kept, maximumBytes: 100_000), data)
        XCTAssertFalse(FileManager.default.fileExists(atPath: made.path))
    }

    func testAPlainPlaceIsOneRenameAndOneFlushWritingNoByte() throws {
        let data = vectorPlain(70_000)
        let made = file("made.mov")
        let kept = file("kept.mov")
        try data.write(to: made)
        let before = inode(made)
        var metered: [DeviceFiles.Metered] = []
        DeviceFiles.meter = { metered.append($0) }
        var flushed: [URL] = []
        DeviceFiles.flushObserver = { url, _ in flushed.append(url) }
        try DeviceFiles(.plain).place(made, at: kept, flush: .data)
        XCTAssertEqual(inode(kept), before)
        XCTAssertEqual(metered, [.flush(.data)])
        XCTAssertEqual(flushed, [kept])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["kept.mov"])
    }

    func testAReaderReadsPlainBytesInBothForms() throws {
        let data = vectorPlain(200_000)
        for (form, files) in forms() {
            let url = file("bundle", form)
            let writer = try files.writer(url, flush: .data)
            try writer.write(data)
            try writer.finish()
            XCTAssertEqual(try readAll(try files.reader(url)), data, form)
        }
    }

    func testAReaderFromAnOffsetReadsTheRestInBothForms() throws {
        let data = vectorPlain(200_000)
        for (form, files) in forms() {
            let url = file("bundle", form)
            let writer = try files.writer(url, flush: .data)
            try writer.write(data)
            try writer.finish()
            for offset in [0, 1, 65_537, 199_999, 200_000] {
                XCTAssertEqual(try readAll(try files.reader(url, from: Int64(offset))), data.dropFirst(offset), "\(form) from \(offset)")
            }
        }
    }

    func testAReaderReadsALogsRecordsInOrderInBothForms() throws {
        let lines = (0..<3_000).map { Data("record \($0)\n".utf8) }
        for (form, files) in forms() {
            let url = file("batch", form)
            let log = try files.log(url)
            for line in lines { try log.append(line, flush: nil) }
            log.close()
            XCTAssertEqual(try readAll(try files.reader(url)), lines.reduce(Data(), +), form)
        }
    }

    func testAnEmptyFileIsTheSameRefusalInBothForms() throws {
        for (form, files) in forms() {
            let url = file("empty", form)
            try Data().write(to: url)
            XCTAssertThrowsError(try files.read(url, maximumBytes: 100), form) {
                XCTAssertEqual($0 as? DeviceFileError, .invalidSizeOrType(name: url.lastPathComponent, maximumBytes: 100), form)
            }
        }
    }

    func testAReaderOpenedBeforeTheSwitchReadsItsPlainFileToTheEnd() throws {
        let files = DeviceFiles(.plain)
        let url = file("pending.zip")
        let data = vectorPlain(100_000)
        try files.writeNew(url, data, flush: .data)
        let reader = try files.reader(url)
        try files.becomeKeyed(testKey) { _ in try FileManager.default.removeItem(at: url) }
        XCTAssertEqual(try readAll(reader), data)
    }

    func testADamagedKeyedFileStopsItsReader() throws {
        let files = DeviceFiles(.keyed(testKey))
        let url = file("bundle")
        try files.writeNew(url, vectorPlain(100_000), flush: .data)
        var disk = try raw(url)
        disk[70_000] ^= 1
        try disk.write(to: url)
        let reader = try files.reader(url)
        var total = 0
        XCTAssertThrowsError(try { while let chunk = try reader.next() { total += chunk.count } }())
        XCTAssertLessThan(total, 70_000)
        XCTAssertThrowsError(try files.read(url, maximumBytes: 200_000))
    }

    func testAKeyedReadRefusesAPlainFile() throws {
        let url = file("answer.json")
        try Data("{}".utf8).write(to: url)
        XCTAssertThrowsError(try DeviceFiles(.keyed(testKey)).read(url, maximumBytes: 100)) {
            guard case .unreadable = $0 as? DeviceFileError else { return XCTFail("\($0)") }
        }
    }
}
