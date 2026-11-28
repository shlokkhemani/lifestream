import CryptoKit
import DeviceFiles
import Evidence
import Foundation
import HomeLink

public final class ScreenSpoolDomain: ShippingDomain {
    static let feeder = "screen-recorder"
    static let observationsFile = "observations.jsonl"
    static let retention: TimeInterval = 7 * 24 * 60 * 60
    static let grace: TimeInterval = 30
    static let pendingLimit: TimeInterval = 60 * 60
    static let hourMicroseconds = 3_600_000_000
    public static let maximumObservations = 20_000
    public static let maximumObservationBytes = 256 * 1024 * 1024

    public let sourceId: String
    public let name = "screen"
    let spoolRoot: URL
    let ledgers: Ledgers
    let maximumObservations: Int
    let maximumObservationBytes: Int
    let clock: @Sendable () -> Date
    private let historyOwed = SealNote(false)
    private let stated = SealNote<Through?>(nil)

    public init(sourceId: String, spoolRoot: URL, ledgers: Ledgers,
                maximumObservations: Int = ScreenSpoolDomain.maximumObservations,
                maximumObservationBytes: Int = ScreenSpoolDomain.maximumObservationBytes,
                clock: @escaping @Sendable () -> Date = { Date() }) {
        self.sourceId = sourceId
        self.spoolRoot = spoolRoot
        self.ledgers = ledgers
        self.maximumObservations = max(1, maximumObservations)
        self.maximumObservationBytes = max(1, maximumObservationBytes)
        self.clock = clock
    }

    public var owesHistory: Bool { historyOwed.value }
    public var through: Through? { stated.value }

    public func seal(_ request: SealRequest) throws -> [SealedBundle] {
        let ledger = ledger(pass: request.custody.pass)
        let held = ScreenEntry.union(try ledger.held(through: request.custody.received).map(\.entry))
        let lost = try ledger.lost(after: request.custody.received, word: "screen observations")
        let mark = held?.through
        let listings = try listings(after: mark)
        let owed = Owed(late: try lateNames(carried: held), listings: listings)
        let recent = owed.count > maximumObservations ? Self.recentStart(request.fetchedAt) : nil
        let (older, newest) = recent.map { owed.split(at: $0) } ?? (Owed(), owed)

        var bundles: [SealedBundle] = []
        var custody = request.custody
        var shipped = Set(held?.blobs ?? [])
        let live = try sealBundle(newest, listings: listings, mark: mark, followed: false, request: request,
                                  custody: custody, shipped: shipped, lost: lost, ledger: ledger)
        guard !live.yielded else {
            historyOwed.value = older.count > 0
            stated.value = nil
            return []
        }
        if let bundle = live.bundle {
            bundles.append(bundle)
            shipped.formUnion(live.blobs)
            custody = SealCustody(pass: custody.pass, received: custody.seal, imported: custody.imported, history: custody.history)
        }
        var paged = 0
        var yielded = false
        if let recent, older.count > 0, HistoryPage.paced(request.custody) {
            let followed = newest.count > 0 || (mark ?? "") >= recent
            let page = try sealBundle(older, listings: listings, mark: mark, followed: followed, request: request,
                                      custody: custody, shipped: shipped, lost: bundles.isEmpty ? lost : [], ledger: ledger,
                                      history: true)
            if let bundle = page.bundle { bundles.append(bundle) }
            paged = page.carried
            yielded = page.yielded
        }
        historyOwed.value = older.count > paged
        stated.value = bundles.isEmpty && !yielded && request.owesThrough ? request.through(readThrough: live.settledThrough) : nil
        return bundles
    }

    static func recentStart(_ fetchedAt: Date) -> String {
        let hours = (fetchedAt.timeIntervalSince1970 / 3_600).rounded(.down) - HistoryPage.recent / 3_600
        let micros = Int(hours) * hourMicroseconds
        let day = UTCInstant.rfc3339(Date(timeIntervalSince1970: Double(micros) / 1_000_000)).prefix(10)
        let digits = String(micros)
        return day + "/" + String(repeating: "0", count: max(0, 20 - digits.count)) + digits
    }

    private func sealBundle(_ owed: Owed, listings: [String: Spool.Listing], mark: String?, followed: Bool,
                            request: SealRequest, custody: SealCustody, shipped: Set<String>, lost: [Lost],
                            ledger: SealLedger<ScreenEntry>, history: Bool = false, cut: String? = nil, heldKnown: Set<String>? = nil)
        throws -> (bundle: SealedBundle?, blobs: [String], settledThrough: Date, carried: Int, yielded: Bool) {
        let lines = request.workDirectory.appendingPathComponent("screen-observations-\(UUID().uuidString).jsonl")
        let writer: Writer
        do { writer = try ledgers.files.writer(lines, flush: .data) } catch { throw ScreenSpoolDomainError.work(lines.path) }
        defer { try? FileManager.default.removeItem(at: lines) }
        var sealing = Sealing(writer: writer, files: ledgers.files, request: request, shipped: shipped,
                              maximumObservations: maximumObservations, maximumBytes: maximumObservationBytes, spoolRoot: spoolRoot)
        let settledThrough: Date
        do {
            settledThrough = try walk(owed, listings: listings, mark: mark, followed: followed, at: request.fetchedAt, until: cut,
                                      into: &sealing)
            try writer.finish()
        } catch {
            writer.abandon()
            throw error
        }
        guard let first = sealing.carried.first, let last = sealing.carried.last else { return (nil, [], settledThrough, 0, cut != nil) }
        let blobs = try sealing.segmentBlobs()
        var held = heldKnown.map { known in { @Sendable asked in known.intersection(asked) } } ?? request.held
        var staged: Set<String> = []
        if let staging = request.staged {
            let large = blobs.compactMap { blob -> StagedBlobs.Large? in
                guard let file = blob.file, let bytes = sealing.sizes[blob.sha256], bytes > staging.thresholdBytes else { return nil }
                return StagedBlobs.Large(sha256: blob.sha256, file: file, bytes: bytes)
            }
            if !large.isEmpty {
                let named = Set(blobs.map(\.sha256))
                let heldNow = (heldKnown ?? request.held(named)).intersection(named)
                held = { heldNow.intersection($0) }
                let owedLarge = large.filter { !heldNow.contains($0.sha256) }
                let unready = owedLarge.filter { !staging.isReady($0.sha256) }
                if !unready.isEmpty {
                    for file in unready { staging.enqueue(file.sha256, file.file, file.bytes, true, history ? .later : .new) }
                    let waiting = Set(unready.map(\.sha256))
                    guard let blocked = sealing.carried.firstIndex(where: { observation in
                        [observation.video?.sha256, observation.text?.sha256].contains { $0.map(waiting.contains) ?? false }
                    }), blocked > 0 else {
                        return (nil, [], settledThrough, 0, true)
                    }
                    return try sealBundle(owed, listings: listings, mark: mark, followed: followed, request: request, custody: custody,
                                          shipped: shipped, lost: lost, ledger: ledger, history: history, cut: sealing.carried[blocked].path,
                                          heldKnown: heldNow)
                }
                staged = Set(owedLarge.map(\.sha256))
            }
        }
        let fetchedAt = history ? request.fetchedAt.addingTimeInterval(0.001) : request.fetchedAt
        var facts: [(String, JSONText)] = [
            ("observations", .int(sealing.observations - sealing.unreadable)),
            ("metadata_unreadable", .int(sealing.unreadable)),
            ("frames_archived", .int(sealing.archived)),
            ("segments", .int(sealing.videoSegments.count + sealing.unreadableSegments)),
            ("segments_missing", .int(sealing.missing)),
            ("frames_text", .int(sealing.framesText)),
            ("text_segments", .int(sealing.textSegments.count)),
            ("text_unproven", .int(sealing.textUnproven)),
            ("gap_runs", .int(sealing.runs)),
            ("first_captured_at", .string(Spool.capturedAt(first.bundle))),
            ("last_captured_at", .string(Spool.capturedAt(last.bundle))),
            ("snapshot_taken_at", .string(UTCInstant.rfc3339(fetchedAt))),
        ]
        if history { facts.append(HistoryPage.fact) }
        let bundle = try BundleWriter.write(
            into: request.workDirectory, sourceId: sourceId, feeder: Self.feeder, fetchedAt: fetchedAt,
            files: [.init(name: Self.observationsFile, content: .kept(lines))],
            blobs: blobs.filter { !staged.contains($0.sha256) }, stagedBlobs: staged.sorted(), held: held, facts: facts,
            custody: (custody, lost), through: ledgers.files)
        try ledger.record(ScreenEntry(carrying: sealing.carried, blobs: bundle.named, deleted: lost.reduce(0) { $0 + $1.items }),
                          at: custody.seal)
        let sidecar = BundleSidecar(id: bundle.id, sourceId: sourceId, custody: custody, history: history, stagedBlobs: bundle.staged)
        return (SealedBundle(file: bundle.file, sidecar: sidecar), bundle.named, settledThrough, sealing.carried.count, false)
    }

    public func applied(_ answer: FreshAnswer) {
        guard let imported = answer.sources[sourceId]?.imported else { return }
        let ledger = ledger(pass: answer.pass)
        guard (try? ledger.prune(imported: imported)) != nil, let seals = try? ledger.read(),
              let baseSeal = seals.keys.filter({ $0 <= imported }).max(), var base = seals[baseSeal] else { return }
        let later = ScreenEntry.union(seals.filter { $0.key > imported }.sorted { $0.key < $1.key }.map(\.value))
        let cutoff = clock().addingTimeInterval(-Self.retention)
        var gone: Set<String> = []
        for (day, runs) in base.days.sorted(by: { $0.key < $1.key }) {
            guard let ended = Spool.dayEnd(day), ended < cutoff, later?.days[day] == nil else { continue }
            let folder = spoolRoot.appendingPathComponent(day, isDirectory: true)
            guard let present = try? Spool.listing(of: day, in: spoolRoot).bundles, CarriedDay.covers(present, runs) else { continue }
            try? FileManager.default.removeItem(at: folder)
            if !FileManager.default.fileExists(atPath: folder.path) {
                gone.insert(day)
                base.deleted += runs.reduce(0) { $0 + $1.count }
                base.days[day] = nil
            }
        }
        var retired: Set<String> = []
        for (name, segment) in base.segments {
            let remaining = segment.days.filter { !gone.contains($0) }
            base.segments[name]!.days = remaining
            guard remaining.isEmpty, later?.segments[name] == nil else { continue }
            for file in Spool.segmentFiles(name, in: spoolRoot) { try? FileManager.default.removeItem(at: file) }
            if Spool.segmentFiles(name, in: spoolRoot).isEmpty {
                base.segments[name] = nil
                if let sha256 = segment.sha256 { retired.insert(sha256) }
            }
        }
        base.blobs.removeAll { retired.contains($0) }
        let kept = base
        try? ledger.update { seal, entry in seal == baseSeal ? kept : entry }
    }

    private func ledger(pass: String) -> SealLedger<ScreenEntry> {
        ledgers.ledger(pass: pass, source: sourceId)
    }

    private func lateNames(carried: ScreenEntry?) throws -> [String: [String]] {
        guard let carried else { return [:] }
        let frontierDay = String(carried.through.prefix(10))
        var late: [String: [String]] = [:]
        for day in try Spool.days(in: spoolRoot) where day <= frontierDay {
            let runs = carried.days[day] ?? []
            var present = try Spool.listing(of: day, in: spoolRoot).bundles
            if day == frontierDay { present = present.filter { day + "/" + $0 <= carried.through } }
            guard !CarriedDay.covers(present, runs) else { continue }
            let intact = runs.filter { run in
                let names = present.filter { $0 >= run.first && $0 <= run.last }
                return names.count == run.count && CarriedDay.digest(names) == run.sha256
            }
            let names = present.filter { name in !intact.contains { name >= $0.first && name <= $0.last } }
            if !names.isEmpty { late[day] = names }
        }
        return late
    }

    private func listings(after mark: String?) throws -> [String: Spool.Listing] {
        let markDay = mark.map { String($0.prefix(10)) }
        var listings: [String: Spool.Listing] = [:]
        for day in try Spool.days(in: spoolRoot) where markDay == nil || day >= markDay! {
            listings[day] = try Spool.listing(of: day, in: spoolRoot, after: mark)
        }
        return listings
    }

    struct Owed {
        var days: [(day: String, names: [String])] = []
        var count: Int { days.reduce(0) { $0 + $1.names.count } }

        init() {}

        init(late: [String: [String]], listings: [String: Spool.Listing]) {
            for day in Set(late.keys).union(listings.keys).sorted() {
                let names = (late[day] ?? []) + (listings[day]?.bundles ?? [])
                if !names.isEmpty { days.append((day, names)) }
            }
        }

        func split(at path: String) -> (before: Owed, from: Owed) {
            var before = Owed(), from = Owed()
            for (day, names) in days {
                let cut = names.firstIndex { day + "/" + $0 >= path } ?? names.count
                if cut > 0 { before.days.append((day, Array(names[..<cut]))) }
                if cut < names.count { from.days.append((day, Array(names[cut...]))) }
            }
            return (before, from)
        }
    }


    struct Observation {
        let path: String
        let day: String
        let bundle: String
        var video: SegmentReference?
        var text: SegmentReference?
    }

    struct SegmentReference: Equatable {
        let segment: String
        let sha256: String
        let ordinal: Int
        let frames: Int
    }

    private enum Stop {
        case exhausted
        case blocker(String)
        case young
        case unsettled
        case full
    }

    private struct Run {
        let first: Observation
        let json: Data
        let split: GapAttempt?
        let hour: Int
        var attempts: [(observation: Observation, tokens: [String?])]
        var opensClosure: Bool {
            ObservationBytes.member("reason", of: json) == Self.closureReason
                && ObservationBytes.member("capturedUntil", of: json) == nil
        }
        private static let closureReason = Data("\"\(CaptureGapReason.displayAsleepOrSessionInactive.rawValue)\"".utf8)

        func continues(with attempt: GapAttempt?, json: Data, hour: Int) -> Bool {
            guard let split, let attempt, hour == self.hour, attempt.shared == split.shared else { return false }
            return split.rebuild(attempt.tokens) == json
        }

        var line: Data {
            var line = Data("{\"bundle\":\(JSONText.string(first.path).text),\"observation\":".utf8)
            line.append(json)
            if attempts.count == 1 {
                line.append(Data(",\"run\":null}\n".utf8))
                return line
            }
            let items = attempts.map { attempt in
                ([JSONText.string(attempt.observation.path).text]
                    + attempt.tokens.map { $0.map { "\"\($0)\"" } ?? "null" }).joined(separator: ",")
            }
            line.append(Data(",\"run\":{\"attempts\":[[\(items.joined(separator: "],["))]]}}\n".utf8))
            return line
        }
    }

    private func walk(_ owed: Owed, listings: [String: Spool.Listing], mark: String?, followed: Bool,
                      at fetchedAt: Date, until cut: String? = nil, into sealing: inout Sealing) throws -> Date {
        let days = try Spool.days(in: spoolRoot)
        let newest = fetchedAt.addingTimeInterval(-Self.grace)
        let stale = fetchedAt.addingTimeInterval(-Self.pendingLimit)
        let firstStaleDay = String(UTCInstant.rfc3339(stale.addingTimeInterval(-1)).prefix(10))
        var blocker = cut
        var settledThrough = cut.flatMap { Spool.capturedDate(($0 as NSString).lastPathComponent) }.map { min(newest, $0) } ?? newest
        for day in days where day >= firstStaleDay {
            guard let listing = listings[day] ?? (try? Spool.listing(of: day, in: spoolRoot, after: mark)) else { continue }
            for staged in listing.staging {
                guard let at = Spool.capturedDate(staged), at >= stale else { continue }
                let path = day + "/" + staged
                if blocker == nil || path < blocker! { blocker = path }
                settledThrough = min(settledThrough, at)
            }
        }
        let first = owed.days.first?.names.first.flatMap { Spool.microseconds($0) }
        let files = ledgers.files
        var text = TextIndex(spoolRoot: spoolRoot, files: files, after: first.map { $0 - 1 } ?? mark.flatMap(Spool.microseconds(ofPath:)))
        let compactor = Spool.textCompactor(in: spoolRoot, files: files)
        let stuck = compactor.since.map { fetchedAt.timeIntervalSince($0) > Self.pendingLimit } ?? false
        let handled = { (micros: Int) in compactor.position.map { micros < $0 } ?? false }
        var run: Run?
        var stop = Stop.exhausted
        walking: for (day, names) in owed.days {
            for bundle in names {
                let path = day + "/" + bundle
                if let blocker, path >= blocker {
                    stop = .blocker(blocker)
                    break walking
                }
                guard let at = Spool.capturedDate(bundle), at <= newest, let micros = Spool.microseconds(bundle) else {
                    stop = .young
                    break walking
                }
                let folder = spoolRoot.appendingPathComponent(path, isDirectory: true)
                guard FileFacts.isRegularFile(folder.appendingPathComponent(Spool.metadata).path) else { continue }
                var observation = Observation(path: path, day: day, bundle: bundle)
                let listed = text.entry(for: path, at: micros)
                observation.text = listed?.reference

                guard let json = Spool.observationJSON(in: folder, files: files) else {
                    guard try flush(&run, into: &sealing), sealing.carryUnreadable(observation) else {
                        stop = .full
                        break walking
                    }
                    continue
                }
                let status = ObservationBytes.status(of: json)
                if let status, ObservationBytes.gapStatuses.contains(status) {
                    let attempt = GapAttempt(json)
                    let hour = micros / Self.hourMicroseconds
                    if run?.continues(with: attempt, json: json, hour: hour) == true {
                        run!.attempts.append((observation, attempt!.tokens))
                        continue
                    }
                    guard try flush(&run, into: &sealing) else {
                        stop = .full
                        break walking
                    }
                    run = Run(first: observation, json: json, split: attempt, hour: hour,
                              attempts: [(observation, attempt?.tokens ?? [])])
                    continue
                }
                guard try flush(&run, into: &sealing) else {
                    stop = .full
                    break walking
                }
                var image = Image.none
                var sidecar = Spool.sidecar(in: folder, files: files)
                let awaitsSegment = sidecar == nil && Spool.awaitsOpenSegment(folder, in: spoolRoot, files: files)
                if sidecar == nil, !awaitsSegment { sidecar = Spool.sidecar(in: folder, files: files) }
                if let sidecar {
                    image = .archived(sidecar, Self.reference(sidecar))
                    observation.video = Self.reference(sidecar)
                } else if awaitsSegment {
                    settledThrough = min(settledThrough, at)
                    stop = .unsettled
                    break walking
                }
                if status == ObservationBytes.capturedStatus, listed == nil, !handled(micros), !(stuck && at < stale) {
                    settledThrough = min(settledThrough, at)
                    stop = .unsettled
                    break walking
                }
                guard try sealing.writeFrame(observation, json: json, image: image, listed: listed, text: &text) else {
                    stop = .full
                    break walking
                }
            }
        }
        guard var open = run else { return settledThrough }
        let hourEnd = (open.hour + 1) * Self.hourMicroseconds
        var ended = false
        if case .exhausted = stop { ended = followed }
        var settled = Int((newest.timeIntervalSince1970 * 1_000_000).rounded(.down)) >= hourEnd && (ended || !open.opensClosure)
        if let blocker, (Spool.microseconds(ofPath: blocker) ?? 0) < hourEnd { settled = false }
        switch stop {
        case .exhausted, .young, .blocker:
            break
        case .unsettled, .full:
            settled = false
        }
        if settled, try flush(&open, into: &sealing) { return settledThrough }
        return min(settledThrough, Spool.capturedDate(open.first.bundle) ?? settledThrough)
    }

    private func flush(_ run: inout Run?, into sealing: inout Sealing) throws -> Bool {
        guard var open = run else { return true }
        guard try flush(&open, into: &sealing) else { return false }
        run = nil
        return true
    }

    private func flush(_ run: inout Run, into sealing: inout Sealing) throws -> Bool {
        let carried = run.attempts.map(\.observation)
        guard try sealing.write(run.line, carrying: carried) else { return false }
        if run.attempts.count > 1 { sealing.runs += 1 }
        return true
    }

    enum Image {
        case none
        case archived(Data, SegmentReference?)
    }

    static func reference(_ sidecar: Data) -> SegmentReference? {
        guard let object = try? JSONSerialization.jsonObject(with: sidecar) as? [String: Any],
              let reference = object["reference"] as? [String: Any],
              let segment = reference["segment"] as? String, Spool.isSegmentPath(segment),
              let spelled = reference["segmentSHA256"] as? String, let sha256 = Spool.hexSHA256(base64: spelled),
              let ordinal = reference["ordinal"] as? Int, let frames = reference["frameCount"] as? Int,
              ordinal >= 0, frames > ordinal else { return nil }
        return SegmentReference(segment: segment, sha256: sha256, ordinal: ordinal, frames: frames)
    }


    private struct Sealing {
        let writer: Writer
        let files: DeviceFiles
        let request: SealRequest
        let shipped: Set<String>
        let maximumObservations: Int
        let maximumBytes: Int
        let spoolRoot: URL
        var carried: [Observation] = []
        var observations = 0, lines = 0, bytes = 0
        var unreadable = 0, archived = 0, missing = 0, unreadableSegments = 0
        var framesText = 0, textUnproven = 0, runs = 0
        var videoSegments: [String: SegmentReference] = [:]
        var textSegments: [String: SegmentReference] = [:]
        var sizes: [String: Int64] = [:]

        init(writer: Writer, files: DeviceFiles, request: SealRequest, shipped: Set<String>, maximumObservations: Int, maximumBytes: Int,
             spoolRoot: URL) {
            self.writer = writer
            self.files = files
            self.request = request
            self.shipped = shipped
            self.maximumObservations = maximumObservations
            self.maximumBytes = maximumBytes
            self.spoolRoot = spoolRoot
        }

        mutating func write(_ line: Data, carrying observations: [Observation]) throws -> Bool {
            if !carried.isEmpty,
               bytes + line.count > maximumBytes || self.observations + observations.count > maximumObservations {
                return false
            }
            try writer.write(line)
            lines += 1
            bytes += line.count
            self.observations += observations.count
            carried += observations
            return true
        }

        mutating func carryUnreadable(_ observation: Observation) -> Bool {
            if !carried.isEmpty, observations + 1 > maximumObservations { return false }
            observations += 1
            unreadable += 1
            carried.append(observation)
            return true
        }

        mutating func writeFrame(_ observation: Observation, json: Data, image: Image,
                                 listed: TextIndex.Listed?, text: inout TextIndex) throws -> Bool {
            var archive = "null", unreadableReference = false
            switch image {
            case .none:
                break
            case .archived(let sidecar, let named):
                if let text = Spool.oneLineJSON(sidecar) { archive = text }
                unreadableReference = named == nil
            }
            var observationBytes = json, reference = "null", proven: TextIndex.Listed?
            if let listed, let (reduced, segmentBytes) = text.prove(listed, path: observation.path, json: json) {
                observationBytes = reduced
                proven = listed
                reference = "{\"segment\":\(JSONText.string(listed.manifest.segment).text),"
                    + "\"segmentSHA256\":\(JSONText.string(listed.manifest.segmentSHA256.base64EncodedString()).text),"
                    + "\"ordinal\":\(listed.ordinal),\"observationSHA256\":\"\(listed.observationSHA256)\","
                    + "\"segmentBytes\":\(segmentBytes)}"
            }
            var line = Data("{\"bundle\":\(JSONText.string(observation.path).text),\"observation\":".utf8)
            line.append(observationBytes)
            line.append(Data(",\"archive\":\(archive),\"pending\":null,\"text\":\(reference)}\n".utf8))
            guard try write(line, carrying: [observation]) else { return false }
            switch image {
            case .none: break
            case .archived(_, let named):
                archived += 1
                if let named { videoSegments[named.segment] = named }
            }
            if unreadableReference { unreadableSegments += 1 }
            if let proven {
                framesText += 1
                textSegments[proven.reference.segment] = proven.reference
            } else if listed != nil {
                textUnproven += 1
            }
            return true
        }

        mutating func segmentBlobs() throws -> [BundleWriter.Blob] {
            var blobs: [String: BundleWriter.Blob] = [:]
            missing += unreadableSegments
            for reference in videoSegments.values.sorted(by: { $0.segment < $1.segment }) {
                let file = Spool.segmentFile(reference.segment, in: spoolRoot)
                let named = shipped.contains(reference.sha256) || blobs[reference.sha256] != nil
                if file != nil, named { continue }
                guard let file, let measured = try? FileChunks.measure(file, through: files), measured.sha256 == reference.sha256 else {
                    missing += 1
                    if !named { blobs[reference.sha256] = .init(sha256: reference.sha256, file: nil) }
                    continue
                }
                blobs[reference.sha256] = .init(sha256: reference.sha256, file: file, kept: true)
                sizes[reference.sha256] = Int64(measured.bytes)
            }
            for reference in textSegments.values where !shipped.contains(reference.sha256) {
                guard let file = Spool.segmentFile(reference.segment, in: spoolRoot) else { continue }
                blobs[reference.sha256] = .init(sha256: reference.sha256, file: file, kept: true)
                if let bytes = try? files.size(of: file) { sizes[reference.sha256] = Int64(bytes) }
            }
            return blobs.keys.sorted().compactMap { blobs[$0] }
        }
    }


    struct TextIndex {
        struct Listed {
            let manifest: ScreenText.Manifest
            let ordinal: Int
            let observationSHA256: String
            let reference: SegmentReference
        }

        private var ahead: [(window: ScreenText.Window, url: URL)] = []
        private var current: [(window: ScreenText.Window, entries: [String: Listed])] = []
        private var segment: (name: String, loaded: (segment: ScreenText.Segment, bytes: Int)?)?
        private let directory: URL
        private let files: DeviceFiles

        private static let windows = Windows()

        init(spoolRoot: URL, files: DeviceFiles, after mark: Int?) {
            directory = spoolRoot.appendingPathComponent(Spool.textDirectory, isDirectory: true)
            self.files = files
            let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
            let known = Self.windows[directory.path]
            var listed: [String: ScreenText.Window] = [:]
            for name in names where Spool.isManifestName(name) {
                let url = directory.appendingPathComponent(name)
                guard let window = known[name]
                        ?? (FileFacts.isRegularFile(url.path) ? Self.window(of: url, files: files) : nil) else { continue }
                listed[name] = window
                if let mark, window.end <= mark { continue }
                ahead.append((window, url))
            }
            Self.windows[directory.path] = listed
            ahead.sort { $0.window.start < $1.window.start }
        }

        private final class Windows: @unchecked Sendable {
            private let lock = NSLock()
            private var byFolder: [String: [String: ScreenText.Window]] = [:]

            subscript(folder: String) -> [String: ScreenText.Window] {
                get { lock.withLock { byFolder[folder] ?? [:] } }
                set { lock.withLock { byFolder[folder] = newValue } }
            }
        }

        private static func window(of url: URL, files: DeviceFiles) -> ScreenText.Window? {
            if let prefix = try? Spool.prefix(of: url, count: ScreenText.Manifest.prefixBytes, files: files),
               let window = ScreenText.Manifest.window(prefix: prefix) {
                return window
            }
            return Spool.manifest(at: url, files: files)?.window
        }

        mutating func entry(for path: String, at micros: Int) -> Listed? {
            current.removeAll { $0.window.end <= micros }
            while let next = ahead.first, next.window.start <= micros {
                ahead.removeFirst()
                guard next.window.end > micros, let manifest = Spool.manifest(at: next.url, files: files) else { continue }
                var entries: [String: Listed] = [:]
                let reference = { (ordinal: Int) in
                    SegmentReference(segment: Spool.textDirectory + "/" + manifest.segment,
                                     sha256: ScreenText.hex(manifest.segmentSHA256), ordinal: ordinal,
                                     frames: manifest.frames.count)
                }
                for entry in manifest.frames {
                    entries[entry.bundle] = Listed(manifest: manifest, ordinal: entry.ordinal,
                                                   observationSHA256: entry.observationSHA256, reference: reference(entry.ordinal))
                }
                current.append((next.window, entries))
            }
            return current.lazy.compactMap { $0.entries[path] }.first
        }

        mutating func prove(_ listed: Listed, path: String, json: Data) -> (reduced: Data, segmentBytes: Int)? {
            if segment?.name != listed.manifest.segment {
                segment = (listed.manifest.segment, Self.load(directory.appendingPathComponent(listed.manifest.segment),
                                                              sha256: listed.manifest.segmentSHA256, files: files))
            }
            guard let (loaded, bytes) = segment?.loaded,
                  loaded.frames.indices.contains(listed.ordinal),
                  loaded.frames[listed.ordinal].bundle == path,
                  loaded.frames[listed.ordinal].observationSHA256 == listed.observationSHA256,
                  ScreenText.hex(SHA256.hash(data: json)) == listed.observationSHA256,
                  let reduction = ScreenText.reduce(json),
                  loaded.rebuild(ordinal: listed.ordinal, reduced: reduction.reduced) == json else {
                return nil
            }
            return (reduction.reduced, bytes)
        }

        private static func load(_ url: URL, sha256: Data, files: DeviceFiles) -> (segment: ScreenText.Segment, bytes: Int)? {
            guard let file = try? files.read(url, maximumBytes: ScreenText.maximumFileBytes), Data(SHA256.hash(data: file)) == sha256,
                  let body = try? ScreenText.decompress(file),
                  let segment = try? ScreenText.Segment(body: body) else { return nil }
            return (segment, file.count)
        }
    }


    struct ScreenEntry: DeletingEntry {
        var through: String
        var days: [String: [CarriedDay]]
        var segments: [String: CarriedSegment]
        var blobs: [String]
        var deleted: Int = 0

        init(through: String, days: [String: [CarriedDay]], segments: [String: CarriedSegment], blobs: [String], deleted: Int = 0) {
            self.through = through
            self.days = days
            self.segments = segments
            self.blobs = blobs
            self.deleted = deleted
        }

        init(carrying observations: [Observation], blobs: [String], deleted: Int = 0) {
            var names: [String: [String]] = [:]
            var segments: [String: CarriedSegment] = [:]
            for observation in observations {
                names[observation.day, default: []].append(observation.bundle)
                for reference in [observation.video, observation.text].compactMap({ $0 }) {
                    var segment = segments[reference.segment]
                        ?? CarriedSegment(frames: reference.frames, ordinals: [], days: [], sha256: reference.sha256)
                    if !segment.ordinals.contains(reference.ordinal) { segment.ordinals.append(reference.ordinal) }
                    if !segment.days.contains(observation.day) { segment.days.append(observation.day) }
                    segments[reference.segment] = segment
                }
            }
            self.init(through: observations.map(\.path).max() ?? "",
                      days: names.mapValues { [CarriedDay(names: $0)] },
                      segments: segments.mapValues { CarriedSegment(frames: $0.frames, ordinals: $0.ordinals.sorted(),
                                                                    days: $0.days.sorted(), sha256: $0.sha256) },
                      blobs: blobs.sorted(), deleted: deleted)
        }

        func absorbing(_ older: ScreenEntry) -> ScreenEntry {
            var days = older.days
            for (day, runs) in self.days {
                let kept = (days[day] ?? []).filter { old in !runs.contains { $0.first <= old.first && old.last <= $0.last } }
                days[day] = kept + runs
            }
            var segments = older.segments
            for (name, segment) in self.segments {
                guard let known = segments[name] else { segments[name] = segment; continue }
                segments[name] = CarriedSegment(frames: segment.frames, ordinals: Array(Set(known.ordinals + segment.ordinals)).sorted(),
                                                days: Array(Set(known.days + segment.days)).sorted(), sha256: segment.sha256 ?? known.sha256)
            }
            return ScreenEntry(through: max(through, older.through), days: days.mapValues { $0.sorted { $0.first < $1.first } },
                               segments: segments, blobs: Array(Set(blobs + older.blobs)).sorted(), deleted: deleted + older.deleted)
        }

        static func union(_ entries: [ScreenEntry]) -> ScreenEntry? {
            guard var all = entries.first else { return nil }
            for entry in entries.dropFirst() { all = entry.absorbing(all) }
            return all
        }
    }

    struct CarriedDay: Codable, Equatable {
        var count: Int
        var first: String
        var last: String
        var sha256: String

        init(names: [String]) {
            count = names.count
            first = names.first ?? ""
            last = names.last ?? ""
            sha256 = Self.digest(names)
        }

        static func digest(_ names: [String]) -> String {
            SHA256.hash(data: Data(names.map { $0 + "\n" }.joined().utf8)).map { String(format: "%02x", $0) }.joined()
        }

        static func covers(_ present: [String], _ runs: [CarriedDay]) -> Bool {
            var matched = 0
            for run in runs {
                let names = present.filter { $0 >= run.first && $0 <= run.last }
                guard names.count == run.count, digest(names) == run.sha256 else { return false }
                matched += names.count
            }
            return matched == present.count
        }
    }

    struct CarriedSegment: Codable, Equatable {
        var frames: Int
        var ordinals: [Int]
        var days: [String]
        var sha256: String?
    }
}

enum Spool {
    static let metadata = "observation.lsm"
    static let sidecar = "image.archive"
    static let openImage = "image.open"
    static let openSegmentPrefix = ".video/.open-"

    static func awaitsOpenSegment(_ bundle: URL, in root: URL, files: DeviceFiles) -> Bool {
        let file = bundle.appendingPathComponent(openImage)
        guard let data = try? files.read(file, maximumBytes: 1024),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let segment = object["segment"] as? String, isUUIDName(segment) else { return false }
        return FileFacts.isDirectory(root.appendingPathComponent(openSegmentPrefix + segment).path)
    }
    static let stagingPrefix = ".pending-"
    static let maximumSidecarBytes = 32 * 1024
    static let textDirectory = ".text"
    static let maximumManifestBytes = 16 * 1024 * 1024


    static func isDayName(_ name: UnsafeBufferPointer<UInt8>) -> Bool {
        name.count == 10 && name[4] == dash && name[7] == dash
            && digits(name, 0..<4) && digits(name, 5..<7) && digits(name, 8..<10)
    }

    static func isBundleName(_ name: UnsafeBufferPointer<UInt8>) -> Bool {
        name.count == 57 && digits(name, 0..<20) && name[20] == dash && isUUID(name, at: 21)
    }

    static func isBundleName(_ name: String) -> Bool { utf8(name, isBundleName) }

    static func isSegmentPath(_ path: String) -> Bool { isUUIDName(path, prefix: ".video/", suffix: ".mov") }

    static func isTextSegmentPath(_ path: String) -> Bool {
        isUUIDName(path, prefix: textDirectory + "/", suffix: ".lstext")
    }

    static func isManifestName(_ name: String) -> Bool { isUUIDName(name, suffix: ".json") }

    private static let dash = UInt8(ascii: "-")

    private static func isUUIDName(_ text: String, prefix: String = "", suffix: String = "") -> Bool {
        utf8(text) { bytes in
            let start = prefix.utf8.count
            return bytes.count == start + 36 + suffix.utf8.count && bytes.starts(with: prefix.utf8)
                && bytes[(start + 36)...].elementsEqual(suffix.utf8) && isUUID(bytes, at: start)
        }
    }

    private static func isUUID(_ bytes: UnsafeBufferPointer<UInt8>, at start: Int) -> Bool {
        guard bytes.count >= start + 36 else { return false }
        for offset in 0..<36 {
            let byte = bytes[start + offset]
            switch offset {
            case 8, 13, 18, 23: if byte != dash { return false }
            default: if !(0x30...0x39).contains(byte) && !(0x61...0x66).contains(byte) { return false }
            }
        }
        return true
    }

    private static func digits(_ bytes: UnsafeBufferPointer<UInt8>, _ range: Range<Int>) -> Bool {
        range.allSatisfy { (0x30...0x39).contains(bytes[$0]) }
    }

    private static func utf8<T>(_ text: String, _ body: (UnsafeBufferPointer<UInt8>) -> T) -> T {
        var text = text
        return text.withUTF8(body)
    }


    static func textCompactor(in root: URL, files: DeviceFiles) -> (position: Int?, since: Date?) {
        let directory = root.appendingPathComponent(textDirectory, isDirectory: true)
        let file = directory.appendingPathComponent("position")
        if let status = FileFacts.of(file.path), status.st_mode & S_IFMT == S_IFREG {
            let bytes = try? files.read(file, maximumBytes: 32)
            let position = bytes.flatMap { $0.allSatisfy({ (0x30...0x39).contains($0) }) && !$0.isEmpty
                ? Int(String(decoding: $0, as: UTF8.self)) : nil }
            return (position, date(status.st_mtimespec))
        }
        guard let status = FileFacts.entry(directory.path), status.st_mode & S_IFMT == S_IFDIR else { return (nil, nil) }
        return (nil, date(status.st_birthtimespec))
    }

    private static func date(_ time: timespec) -> Date {
        Date(timeIntervalSince1970: Double(time.tv_sec) + Double(time.tv_nsec) / 1_000_000_000)
    }

    static func manifest(at url: URL, files: DeviceFiles) -> ScreenText.Manifest? {
        guard let data = try? files.read(url, maximumBytes: maximumManifestBytes) else { return nil }
        return ScreenText.Manifest.decode(data)
    }

    static func prefix(of url: URL, count: Int, files: DeviceFiles) throws -> Data {
        let reader = try files.reader(url)
        var prefix = Data()
        while prefix.count < count, let chunk = try reader.next() {
            prefix.append(chunk.prefix(count - prefix.count))
        }
        return prefix
    }

    static func hexSHA256(base64 text: String) -> String? {
        guard text.utf8.count == 44, let digest = Data(base64Encoded: text), digest.count == 32,
              digest.base64EncodedString() == text else { return nil }
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    static func days(in root: URL) throws -> [String] {
        guard FileFacts.isDirectory(root.path) else { throw ScreenSpoolDomainError.root(root.path) }
        var days: [String] = []
        try entries(in: root) { name, isDirectory in
            if isDayName(name), isDirectory() { days.append(String(decoding: name, as: UTF8.self)) }
        }
        return days.sorted()
    }

    struct Listing {
        var bundles: [String] = []
        var staging: [String] = []
    }

    static func listing(of day: String, in root: URL, after mark: String? = nil) throws -> Listing {
        let prefix = day + "/"
        var after: [UInt8]?, none = false
        if let mark {
            if mark.hasPrefix(prefix) { after = Array(mark.utf8.dropFirst(prefix.utf8.count)) } else { none = prefix < mark }
        }
        let staging = Array(stagingPrefix.utf8)
        var listing = Listing()
        try entries(in: root.appendingPathComponent(day, isDirectory: true)) { name, isDirectory in
            if name.starts(with: staging) {
                let staged = UnsafeBufferPointer(rebasing: name[staging.count...])
                if isBundleName(staged) { listing.staging.append(String(decoding: staged, as: UTF8.self)) }
                return
            }
            if none { return }
            if let after, !after.lexicographicallyPrecedes(name) { return }
            if isBundleName(name), isDirectory() { listing.bundles.append(String(decoding: name, as: UTF8.self)) }
        }
        listing.bundles.sort()
        return listing
    }

    private static func entries(in folder: URL,
                                _ body: (UnsafeBufferPointer<UInt8>, () -> Bool) throws -> Void) throws {
        guard let stream = opendir(folder.path) else { throw ScreenSpoolDomainError.listing(folder.path, errno) }
        defer { closedir(stream) }
        let nameOffset = MemoryLayout<dirent>.offset(of: \dirent.d_name)!
        while true {
            errno = 0
            guard let entry = readdir(stream) else {
                guard errno == 0 else { throw ScreenSpoolDomainError.listing(folder.path, errno) }
                return
            }
            let type = entry.pointee.d_type
            let name = UnsafeBufferPointer(
                start: UnsafeRawPointer(entry).advanced(by: nameOffset).assumingMemoryBound(to: UInt8.self),
                count: Int(entry.pointee.d_namlen))
            try body(name) {
                if type != DT_UNKNOWN { return type == DT_DIR }
                return FileFacts.isDirectory(folder.appendingPathComponent(String(decoding: name, as: UTF8.self)).path)
            }
        }
    }

    static func sidecar(in bundle: URL, files: DeviceFiles) -> Data? {
        let file = bundle.appendingPathComponent(sidecar)
        do { return try files.read(file, maximumBytes: maximumSidecarBytes) } catch {
            return (try? files.size(of: file)) == 0 ? Data() : nil
        }
    }

    static func observationJSON(in bundle: URL, files: DeviceFiles) -> Data? {
        let file = bundle.appendingPathComponent(metadata)
        guard let packet = try? files.read(file, maximumBytes: MetadataCodec.maximumPacketBytes),
              let json = try? MetadataCodec.decode(packet),
              !json.contains(0x0A), json.first == UInt8(ascii: "{") else { return nil }
        return json
    }

    static func oneLineJSON(_ bytes: Data) -> String? {
        var trimmed = bytes
        while let last = trimmed.last, last == 0x0A || last == 0x0D || last == 0x20 { trimmed.removeLast() }
        guard !trimmed.contains(0x0A), (try? JSONSerialization.jsonObject(with: trimmed)) is [String: Any] else { return nil }
        return String(data: trimmed, encoding: .utf8)
    }

    static func segmentFile(_ path: String, in root: URL) -> URL? {
        guard isSegmentPath(path) || isTextSegmentPath(path) else { return nil }
        let file = root.appendingPathComponent(path)
        return FileFacts.isRegularFile(file.path) ? file : nil
    }

    static func segmentFiles(_ path: String, in root: URL) -> [URL] {
        var files: [URL] = []
        if isTextSegmentPath(path) {
            let manifest = root.appendingPathComponent(String(path.dropLast(".lstext".count)) + ".json")
            if FileFacts.isRegularFile(manifest.path) { files.append(manifest) }
        }
        if let segment = segmentFile(path, in: root) { files.append(segment) }
        return files
    }

    static func capturedDate(_ bundle: String) -> Date? {
        guard isBundleName(bundle), let micro = UInt64(bundle.prefix(20)) else { return nil }
        return Date(timeIntervalSince1970: Double(micro / 1000) / 1000)
    }

    static func microseconds(_ bundle: String) -> Int? {
        guard isBundleName(bundle) else { return nil }
        return Int(bundle.prefix(20))
    }

    static func microseconds(ofPath path: String) -> Int? {
        path.split(separator: "/").last.flatMap { microseconds(String($0)) }
    }

    static func capturedAt(_ bundle: String) -> String {
        capturedDate(bundle).map(UTCInstant.rfc3339) ?? ""
    }

    static func dayEnd(_ day: String) -> Date? {
        UTCInstant.date(rfc3339: day + "T00:00:00.000Z").map { $0.addingTimeInterval(24 * 60 * 60) }
    }
}

enum ScreenSpoolDomainError: Error, Equatable, CustomStringConvertible {
    case root(String)
    case listing(String, Int32)
    case work(String)

    var description: String {
        switch self {
        case .root(let path): return "\(path) is not a screen spool"
        case .listing(let path, let code): return "cannot list \(path) (errno \(code))"
        case .work(let path): return "\(path) could not be written"
        }
    }
}
