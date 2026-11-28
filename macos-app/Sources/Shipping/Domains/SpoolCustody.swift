import Evidence
import Foundation
import HomeLink

struct SpoolEntry: DeletingEntry {
    var items: [String]
    var deleted: Int = 0

    func absorbing(_ older: SpoolEntry) -> SpoolEntry {
        SpoolEntry(items: Array(Set(items).union(older.items)).sorted(), deleted: deleted + older.deleted)
    }
}

struct SpoolCustody {
    let ledger: SealLedger<SpoolEntry>
    let word: String

    init(ledgers: Ledgers, pass: String, source: String, word: String) {
        ledger = ledgers.ledger(pass: pass, source: source)
        self.word = word
    }

    func owed(_ present: [String], received: Int) throws -> (items: [String], lost: [Lost]) {
        let carried = Set(try ledger.held(through: received).flatMap(\.entry.items))
        return (present.filter { !carried.contains($0) }, try ledger.lost(after: received, word: word))
    }

    func record(_ items: [String], at seal: Int, lost: [Lost] = []) throws {
        try ledger.record(SpoolEntry(items: items, deleted: lost.reduce(0) { $0 + $1.items }), at: seal)
    }

    func reclaim(imported: Int, _ release: (String) -> Bool) {
        guard (try? ledger.prune(imported: imported)) != nil,
              let base = (try? ledger.held(through: imported))?.last else { return }
        let gone = Set(base.entry.items.filter(release))
        guard !gone.isEmpty else { return }
        try? ledger.update { seal, entry in
            var kept = entry
            kept.items = entry.items.filter { !gone.contains($0) }
            if seal == base.seal { kept.deleted += gone.count }
            return kept
        }
    }


    static let batchRetention: TimeInterval = 30 * 24 * 60 * 60

    static func batchOpenedAt(_ name: String) -> Date? {
        UTCInstant.date(basic: String(name.prefix(20)))
    }

    func reclaimBatches(imported: Int, in root: URL, now: Date, retention: TimeInterval = Self.batchRetention) {
        let cutoff = now.addingTimeInterval(-retention)
        reclaim(imported: imported) { name in
            guard let opened = Self.batchOpenedAt(name), opened < cutoff else { return false }
            let file = root.appendingPathComponent(name)
            try? FileManager.default.removeItem(at: file)
            return !FileManager.default.fileExists(atPath: file.path)
        }
    }
}
