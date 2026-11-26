import Foundation

public struct PendingBundle: Sendable, Equatable, Codable {
    public let id: String
    public let file: String
    public let pass: String
    public let seals: [String: Int]
    public let files: [File]
    public var last: Request?

    public struct File: Sendable, Equatable, Codable {
        public let name: String
        public let bytes: UInt64

        public init(name: String, bytes: UInt64) {
            self.name = name; self.bytes = bytes
        }
    }

    public struct Request: Sendable, Equatable, Codable {
        public let heard: Heard?
        public let code: String?
        public let at: Date

        public enum Heard: String, Sendable, Codable {
            case taken
            case stale
            case notYet
            case held
            case refused
            case passRefused
            case homeTooOld
        }

        public init(heard: Heard?, code: String?, at: Date) {
            self.heard = heard; self.code = code; self.at = at
        }

        public var answered: Bool { heard != nil && heard != .notYet }
    }

    public init(id: String, file: String, pass: String, seals: [String: Int], files: [File] = [], last: Request? = nil) {
        self.id = id; self.file = file; self.pass = pass; self.seals = seals; self.files = files; self.last = last
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(id: container.decode(String.self, forKey: .id), file: container.decode(String.self, forKey: .file),
                      pass: container.decode(String.self, forKey: .pass), seals: container.decode([String: Int].self, forKey: .seals),
                      files: container.decodeIfPresent([File].self, forKey: .files) ?? [],
                      last: container.decodeIfPresent(Request.self, forKey: .last))
    }

    public var sources: Set<String> { Set(seals.keys) }
}

struct CarriedRange: Sendable, Equatable {
    let source: String
    let seal: Int
    let first: UInt64
    let last: UInt64
}

extension CaptureStore {
    static func createLedger(in database: SQLiteDatabase) throws {
        try database.execute("""
            CREATE TABLE IF NOT EXISTS ledger (
                pass TEXT NOT NULL,
                source TEXT NOT NULL,
                seal INTEGER NOT NULL,
                first_sequence INTEGER NOT NULL,
                last_sequence INTEGER NOT NULL,
                PRIMARY KEY (pass, source, seal)) WITHOUT ROWID;
            """)
    }

    func carried(pass: String, source: String, through seal: Int) throws -> UInt64 {
        let last = try database.integer("""
            SELECT last_sequence FROM ledger WHERE pass = ? AND source = ? AND seal <= ?
            ORDER BY seal DESC LIMIT 1
            """, .text(pass), .text(source), .integer(Int64(seal)))
        return last.map { UInt64($0) } ?? 0
    }

    func newestSeal(pass: String, source: String) throws -> Int? {
        try database.integer("SELECT max(seal) FROM ledger WHERE pass = ? AND source = ?", .text(pass), .text(source)).map(Int.init)
    }

    func record(_ ranges: [CarriedRange], pass: String, pending added: [PendingBundle]) throws {
        try database.write {
            var pending = try Self.pending(in: database)
            let flying = pending.reduce(into: Set<String>()) { $0.formUnion($1.sources) }
            for bundle in added {
                guard flying.isDisjoint(with: bundle.sources) else {
                    throw CaptureError.corruptState("a bundle is in flight for \(bundle.sources.intersection(flying).sorted()); its seals are the next ones")
                }
            }
            for range in ranges {
                try database.run("DELETE FROM ledger WHERE pass = ? AND source = ? AND seal >= ?",
                                 .text(pass), .text(range.source), .integer(Int64(range.seal)))
                try database.run("""
                    INSERT INTO ledger (pass, source, seal, first_sequence, last_sequence) VALUES (?, ?, ?, ?, ?)
                    """, .text(pass), .text(range.source), .integer(Int64(range.seal)),
                    .integer(Int64(range.first)), .integer(Int64(range.last)))
            }
            pending += added
            try Self.setPending(pending, in: database)
        }
    }

    func pendingBundles() throws -> [PendingBundle] {
        try Self.pending(in: database)
    }

    func forgetPending(_ id: String) throws {
        try database.write {
            try Self.setPending(try Self.pending(in: database).filter { $0.id != id }, in: database)
        }
    }

    func setLast(_ request: PendingBundle.Request, of id: String) throws {
        try database.write {
            let pending = try Self.pending(in: database).map { bundle in
                var bundle = bundle
                if bundle.id == id { bundle.last = request }
                return bundle
            }
            try Self.setPending(pending, in: database)
        }
    }

    private static func pending(in database: SQLiteDatabase) throws -> [PendingBundle] {
        guard let text = try fact(Fact.pendingBundle, in: database) else { return [] }
        do {
            return try JSONDecoder.lifestream().decode([PendingBundle].self, from: Data(text.utf8))
        } catch {
            throw CaptureError.corruptState("the bundles in flight do not read: \(error)")
        }
    }

    private static func setPending(_ pending: [PendingBundle], in database: SQLiteDatabase) throws {
        let text = pending.isEmpty ? nil : String(decoding: try JSONEncoder.lifestream().encode(pending), as: UTF8.self)
        try setFact(Fact.pendingBundle, text, in: database)
    }

    func prune(pass: String, imported: [String: Int]) throws {
        try database.write {
            try Self.setFact(Fact.answeredPass, pass, in: database)
            try database.run("UPDATE OR REPLACE ledger SET pass = ? WHERE seal = 0 AND pass <> ?", .text(pass), .text(pass))
            try database.run("DELETE FROM ledger WHERE pass <> ?", .text(pass))
            for (source, imported) in imported {
                guard let base = try database.integer(
                    "SELECT max(seal) FROM ledger WHERE pass = ? AND source = ? AND seal <= ?",
                    .text(pass), .text(source), .integer(Int64(imported))) else { continue }
                try database.run("DELETE FROM ledger WHERE pass = ? AND source = ? AND seal > 0 AND seal < ?",
                                 .text(pass), .text(source), .integer(base))
            }
        }
    }

    public func answeredPass() throws -> String? {
        try Self.fact(Fact.answeredPass, in: database)
    }
}
