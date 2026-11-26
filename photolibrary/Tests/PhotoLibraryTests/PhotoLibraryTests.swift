import CryptoKit
import Foundation
import XCTest
@testable import PhotoLibrary

final class PhotoLibraryTests: XCTestCase {
    private static let day = Date(timeIntervalSince1970: 1_780_000_000)
    private static let still = PhotoResource(typeRaw: 1, uti: "public.heic", originalFilename: "IMG_0001.HEIC")
    private static let motion = PhotoResource(typeRaw: 9, uti: "com.apple.quicktime-movie", originalFilename: "IMG_0001.MOV")

    private static func photo(_ id: String, taken: Date?, edited: Date? = nil, resources: [PhotoResource] = [still]) -> PhotoSnapshot {
        PhotoSnapshot(localIdentifier: id, creationDate: taken, modificationDate: edited ?? taken ?? day, resources: resources)
    }

    private func library(_ count: Int, undated: Int = 0, access: PhotoAccess = .full) -> SyntheticLibrary {
        let library = SyntheticLibrary(access: access)
        for index in (0..<count).reversed() {
            library.put(Self.photo(String(format: "P%04d", index), taken: Self.day.addingTimeInterval(-60 * Double(index))))
        }
        for index in 0..<undated { library.put(Self.photo("U\(index)", taken: nil)) }
        return library
    }

    private func readAll(_ library: PhotoLibrary, from mark: ReadMark?, whole: Bool = true, limit: Int = 1_000)
        async throws -> (pages: [ReadPage], mark: ReadMark)
    {
        var pages: [ReadPage] = []
        var mark = mark
        while true {
            let page = try await library.read(after: mark, whole: whole, limit: limit)
            if page.mark == mark { return (pages, page.mark) }
            mark = try JSONDecoder().decode(ReadMark.self, from: JSONEncoder().encode(page.mark))
            pages.append(page)
        }
    }


    func testTheFirstReadStatesEveryPhotoNewestFirstInPagesUndatedLast() async throws {
        let synthetic = library(2_500, undated: 3)
        synthetic.put(PhotoSnapshot(localIdentifier: "HIDDEN", creationDate: Self.day.addingTimeInterval(-30), modificationDate: Self.day,
                                    isHidden: true, resources: [Self.still]))
        let library = PhotoLibrary(synthetic)
        let first = try await library.read(after: nil, whole: true)
        XCTAssertTrue(first.whole)
        XCTAssertEqual(first.snapshots.count, 1_000, "a page, never the library")
        XCTAssertEqual(first.mark.unread, 1_504)
        XCTAssertFalse(first.mark.restates, "a first read states photos never stated")

        let (pages, _) = try await readAll(library, from: first.mark)
        let ids = (first.snapshots + pages.flatMap(\.snapshots)).map(\.localIdentifier)
        XCTAssertEqual(pages.map(\.snapshots.count), [1_000, 504])
        XCTAssertTrue(pages.allSatisfy(\.whole))
        XCTAssertEqual(ids, ["P0000", "HIDDEN"] + (1..<2_500).map { String(format: "P%04d", $0) } + ["U0", "U1", "U2"])
        XCTAssertEqual(Set(ids).count, ids.count, "each photo once")
    }

    func testAReadThatMayNotTakeAWholePageReadsOnlyWhatChanged() async throws {
        let synthetic = library(1_005)
        let library = PhotoLibrary(synthetic)
        let owed = try await library.read(after: nil, whole: false)
        XCTAssertTrue(owed.snapshots.isEmpty)
        XCTAssertTrue(owed.begins, "a read that may not page begins the whole read: the token, and the backlog listed")
        XCTAssertEqual(owed.mark.unread, 1_005)
        XCTAssertEqual(synthetic.snapshotsRead, 0, "and reads no photo of it")
        let first = try await library.read(after: owed.mark, whole: true)
        XCTAssertEqual(first.snapshots.count, 1_000)
        synthetic.put(Self.photo("NEW", taken: Self.day.addingTimeInterval(60)))
        let changed = try await library.read(after: first.mark, whole: false)
        XCTAssertEqual(changed.snapshots.map(\.localIdentifier), ["NEW"], "what is new never waits behind the backlog")
        XCTAssertFalse(changed.whole)
        let caughtUp = try await library.read(after: changed.mark, whole: false)
        XCTAssertEqual(caughtUp.mark, changed.mark)
        XCTAssertEqual(caughtUp.mark.unread, 5)
    }


    func testWhatChangesDuringAWholeReadIsReadBeforeItsNextPage() async throws {
        let synthetic = library(2_000)
        let library = PhotoLibrary(synthetic)
        let first = try await library.read(after: nil, whole: true)
        synthetic.put(Self.photo("NEW", taken: Self.day.addingTimeInterval(60)))
        synthetic.put(Self.photo("P0003", taken: Self.day.addingTimeInterval(-180), edited: Self.day.addingTimeInterval(600)))
        synthetic.delete("P1500")

        let changes = try await library.read(after: first.mark, whole: true)
        XCTAssertFalse(changes.whole)
        XCTAssertEqual(changes.snapshots.map(\.localIdentifier), ["NEW", "P0003"])
        XCTAssertEqual(changes.snapshots.last?.modificationDate, Self.day.addingTimeInterval(600))
        XCTAssertEqual(changes.gone, ["P1500"])

        let (pages, mark) = try await readAll(library, from: changes.mark)
        let rest = pages.flatMap(\.snapshots).map(\.localIdentifier)
        XCTAssertEqual(rest.count, 999, "the backlog less the photo deleted")
        XCTAssertFalse(rest.contains("P1500"))
        XCTAssertEqual(mark.unread, 0)
    }

    func testThousandsOfChangesComeInPagesAndTheMarkMovesOnlyPastWhatAPageReturned() async throws {
        let synthetic = library(1)
        let library = PhotoLibrary(synthetic)
        let (_, read) = try await readAll(library, from: nil)
        for index in 0..<2_500 { synthetic.put(Self.photo("N\(index)", taken: Self.day.addingTimeInterval(Double(index)))) }

        let first = try await library.read(after: read, whole: true)
        XCTAssertEqual(first.snapshots.count, 1_000)
        let again = try await library.read(after: read, whole: true)
        XCTAssertEqual(again.snapshots.map(\.localIdentifier), first.snapshots.map(\.localIdentifier))
        let (pages, _) = try await readAll(library, from: first.mark)
        XCTAssertEqual(pages.map(\.snapshots.count), [1_000, 500])
        XCTAssertEqual(Set((first.snapshots + pages.flatMap(\.snapshots)).map(\.localIdentifier)).count, 2_500)
    }


    func testAPrunedHistoryRestatesTheWholeLibraryAndStatesNothingGone() async throws {
        let synthetic = library(1_500)
        let library = PhotoLibrary(synthetic)
        let (_, read) = try await readAll(library, from: nil)
        synthetic.delete("P0007")
        synthetic.prune()

        let pages = try await readAll(library, from: read)
        XCTAssertTrue(pages.pages.first?.mark.restates == true, "it reads what was stated, and adds nothing")
        XCTAssertEqual(pages.pages.first?.snapshots.count, 0, "the read returns the mark that owes a whole read before any page")
        XCTAssertTrue(pages.pages.allSatisfy { $0.gone.isEmpty }, "absence is never gone")
        XCTAssertEqual(pages.pages.flatMap(\.snapshots).count, 1_499)
        XCTAssertFalse(pages.mark.restates)

        synthetic.put(Self.photo("AFTER", taken: Self.day.addingTimeInterval(60)))
        let next = try await library.read(after: pages.mark, whole: true)
        XCTAssertEqual(next.snapshots.map(\.localIdentifier), ["AFTER"], "the history answers again from the new mark")
    }

    func testAPrunedHistoryReadInTheBackgroundBeginsAgainAndReadsNoPhoto() async throws {
        let synthetic = library(3)
        let library = PhotoLibrary(synthetic)
        let (_, read) = try await readAll(library, from: nil)
        synthetic.prune()
        let owed = try await library.read(after: read, whole: false)
        XCTAssertTrue(owed.mark.restates)
        let begun = try await library.read(after: owed.mark, whole: false)
        XCTAssertTrue(begun.begins, "the next read takes a token and lists the backlog: its photos are past")
        XCTAssertTrue(begun.snapshots.isEmpty)
        XCTAssertTrue(begun.mark.restates)
        XCTAssertEqual(begun.mark.unread, 3)
        let again = try await library.read(after: begun.mark, whole: false)
        XCTAssertEqual(again.mark, begun.mark, "it waits for a read that may page")
        XCTAssertEqual(synthetic.snapshotsRead, 3)
    }

    func testAFirstReadCutShortByAPrunedHistoryStaysAFirstRead() async throws {
        let synthetic = library(1_500)
        let library = PhotoLibrary(synthetic)
        let first = try await library.read(after: nil, whole: true)
        synthetic.prune()
        let next = try await library.read(after: first.mark, whole: false)
        XCTAssertFalse(next.mark.restates, "its photos were never stated: a background wake still reads them")
        let (pages, _) = try await readAll(library, from: next.mark)
        XCTAssertEqual(pages.flatMap(\.snapshots).count, 1_500, "begun again, it lists the whole library")
    }


    func testALimitedSelectionThatShrinksDeletesNothingAndOneThatGrowsIsRead() async throws {
        let synthetic = library(10)
        synthetic.allow(.limited, selecting: ["P0001", "P0002", "P0003"])
        let library = PhotoLibrary(synthetic)
        let (pages, read) = try await readAll(library, from: nil)
        XCTAssertEqual(pages.flatMap(\.snapshots).map(\.localIdentifier), ["P0001", "P0002", "P0003"])

        synthetic.allow(.limited, selecting: ["P0001", "P0004"])
        let (changes, _) = try await readAll(library, from: read)
        XCTAssertEqual(changes.flatMap(\.snapshots).map(\.localIdentifier), ["P0004"])
        XCTAssertTrue(changes.allSatisfy { $0.gone.isEmpty }, "a smaller selection deletes nothing")
    }

    func testAChangeOfAccessReadsWholeAndStatesNothingGone() async throws {
        let synthetic = library(6)
        let library = PhotoLibrary(synthetic)
        let (_, full) = try await readAll(library, from: nil)

        synthetic.allow(.limited, selecting: ["P0001"])
        let (limited, narrowed) = try await readAll(library, from: full)
        XCTAssertEqual(limited.flatMap(\.snapshots).map(\.localIdentifier), ["P0001"])
        XCTAssertTrue(limited.allSatisfy { $0.gone.isEmpty }, "Full becoming Limited deletes nothing")

        synthetic.allow(.full)
        let (widened, _) = try await readAll(library, from: narrowed)
        XCTAssertEqual(widened.flatMap(\.snapshots).count, 6, "every photo the selection hid is read")

        synthetic.allow(.denied)
        do {
            _ = try await library.read(after: narrowed, whole: true)
            XCTFail("nothing is read without access")
        } catch { XCTAssertEqual(error as? PhotoLibraryError, .noAccess) }
    }


    func testTheObserverIsRegisteredOnceAReadIsAllowedAndThereIsOne() async throws {
        let synthetic = SyntheticLibrary(access: .undecided)
        let library = PhotoLibrary(synthetic)
        let heard = expectation(description: "the change after Photos was allowed is heard")
        library.observe { XCTFail("the first observer is replaced") }
        library.observe { heard.fulfill() }
        synthetic.put(Self.photo("P0000", taken: Self.day))
        XCTAssertEqual(synthetic.changesTold, 0, "undecided: nothing is registered, so nothing is told")

        synthetic.allow(.full)
        synthetic.put(Self.photo("P0001", taken: Self.day))
        XCTAssertEqual(synthetic.changesTold, 0, "allowed, but not yet seen by a read")
        _ = try await library.read(after: nil, whole: false)
        synthetic.put(Self.photo("P0002", taken: Self.day))
        XCTAssertEqual(synthetic.changesTold, 1, "registered once a read found Photos allowed")
        await fulfillment(of: [heard], timeout: 30)
    }


    func testASnapshotIsTheWireByteForByte() throws {
        let fixed = Date(timeIntervalSince1970: 1_700_000_000)
        var sized = Self.still
        sized.size = 1_998_035
        var live = PhotoSnapshot(
            localIdentifier: "A1/L0/001", mediaTypeRaw: 1, mediaSubtypesRaw: 1 << 3,
            creationDate: fixed, modificationDate: fixed.addingTimeInterval(10), pixelWidth: 4032, pixelHeight: 3024,
            isFavorite: true, sourceTypeRaw: 1, latitude: 12.5, longitude: 77.25, resources: [sized, Self.motion])
        let entry = live.asset(now: Self.day)
        XCTAssertEqual(entry.kind, .asset)
        XCTAssertEqual(live.name, "photos:A1/L0/001:2023-11-14T22:13:30.000000000Z")
        XCTAssertEqual(entry.replayKey, live.name + ":" + Self.sha256(String(decoding: entry.payload, as: UTF8.self)))
        XCTAssertEqual(entry.observedAt, "2023-11-14T22:13:20.000000000Z")
        let expected =
            #"{"burst_identifier":null,"cloud_identifier":null,"creation_date":"2023-11-14T22:13:20.000000000Z","#
            + #""duration":null,"is_favorite":true,"is_hidden":false,"local_identifier":"A1/L0/001","#
            + #""location":{"latitude":12.5,"longitude":77.25},"media_subtypes":["photoLive"],"#
            + #""media_subtypes_raw":8,"media_type":"image","media_type_raw":1,"#
            + #""modification_date":"2023-11-14T22:13:30.000000000Z","pixel_height":3024,"#
            + #""pixel_width":4032,"represents_burst":false,"resources":[{"blob":null,"not_local":true,"#
            + #""not_local_reason":null,"original_filename":"IMG_0001.HEIC","size":1998035,"#
            + #""type":"photo","type_raw":1,"uti":"public.heic"},{"blob":null,"not_local":true,"#
            + #""not_local_reason":null,"original_filename":"IMG_0001.MOV","size":null,"type":"pairedVideo","#
            + #""type_raw":9,"uti":"com.apple.quicktime-movie"}],"source_type":"user_library","#
            + #""source_type_raw":1}"#
        XCTAssertEqual(String(decoding: entry.payload, as: UTF8.self), expected)

        XCTAssertEqual(live.asset(now: Self.day.addingTimeInterval(60)), entry, "a restatement is the same line")

        live.cloudIdentifier = "CLOUD-0001:001:AbCd"
        let clouded = live.asset(now: Self.day)
        XCTAssertTrue(String(decoding: clouded.payload, as: UTF8.self).contains(#""cloud_identifier":"CLOUD-0001:001:AbCd""#))
        XCTAssertNotEqual(clouded.replayKey, entry.replayKey, "a cloud id learnt later is written once more")
        XCTAssertTrue(clouded.replayKey.hasPrefix(live.name + ":"))

        let hash = "sha256:" + String(repeating: "ab", count: 32)
        let more = live.availability([.blob(hash: hash, bytes: 5), .absent(.downloadFailed)], now: Self.day)
        XCTAssertEqual(more.kind, .availability)
        XCTAssertEqual(more.observedAt, "2026-05-28T20:26:40.000000000Z")
        let tuples = [#"[1,"public.heic","IMG_0001.HEIC","\#(hash)"]"#]
        XCTAssertEqual(more.replayKey, live.name + ":availability:" + Self.sha256("[" + tuples.joined(separator: ",") + "]")
                       + ":2026-05-28T20:26:40.000000000Z")
        XCTAssertNotEqual(live.availability([.blob(hash: hash, bytes: 5), .absent(.downloadFailed)], now: Self.day.addingTimeInterval(1)).replayKey,
                          more.replayKey)
        XCTAssertTrue(String(decoding: more.payload, as: UTF8.self).contains(#""not_local_reason":"download_failed""#))
        XCTAssertTrue(String(decoding: more.payload, as: UTF8.self).hasPrefix(
                       #"{"local_identifier":"A1/L0/001","modification_date":"2023-11-14T22:13:30.000000000Z","resources":[{"blob":{"bytes":5,"hash":"\#(hash)","role":"original","type":"image/heic"},"original_filename":"IMG_0001.HEIC","size":1998035,"#),
                      "a carried file states its size too")

        let gone = PhotoEntry.gone(of: .asset, replayKey: entry.replayKey, payload: entry.payload, now: Self.day)
        XCTAssertEqual(gone.kind.rawValue, "gone")
        XCTAssertEqual(gone.replayKey, entry.replayKey + ":gone")
        XCTAssertEqual(String(decoding: gone.payload, as: UTF8.self), #"{"of":"asset","payload":"# + expected + "}")
    }

    func testARefusalNamesTheSnapshotTheDeviceStated() throws {
        let stored = Data(#"{"local_identifier":"GONE/L0/001","modification_date":"2026-10-01T10:00:00.123456789Z","resources":[{"blob":null,"not_local":true,"not_local_reason":"in iCloud","original_filename":"IMG_0009.HEIC","type":"photo","type_raw":1,"uti":"public.heic"}],"media_type":"image"}"#.utf8)
        let refusal = try PhotoEntry.refusal(ofAsset: stored, .notFound, now: Self.day)
        XCTAssertEqual(refusal.kind, .availability)
        XCTAssertEqual(refusal.replayKey, "photos:GONE/L0/001:2026-10-01T10:00:00.123456789Z:availability:" + Self.sha256("[]")
                       + ":2026-05-28T20:26:40.000000000Z")
        XCTAssertEqual(String(decoding: refusal.payload, as: UTF8.self),
                       #"{"local_identifier":"GONE/L0/001","modification_date":"2026-10-01T10:00:00.123456789Z","resources":[{"blob":null,"not_local":true,"not_local_reason":"not_found","original_filename":"IMG_0009.HEIC","size":null,"type":"photo","type_raw":1,"uti":"public.heic"}],"snapshot_replay_key":"photos:GONE/L0/001:2026-10-01T10:00:00.123456789Z"}"#,
                       "a payload stated before sizes states none")
    }

    func testTheCloudIdIsReadWithTheSnapshot() async throws {
        let synthetic = SyntheticLibrary()
        var photo = Self.photo("A/L0/001", taken: Self.day)
        photo.cloudIdentifier = "CLOUD-A"
        synthetic.put(photo)
        synthetic.put(Self.photo("B/L0/001", taken: Self.day.addingTimeInterval(-1)))
        let page = try await PhotoLibrary(synthetic).read(after: nil, whole: true)
        XCTAssertEqual(page.snapshots.map(\.cloudIdentifier), ["CLOUD-A", nil])
    }


    func testEveryFileComesOrSaysWhyNot() async throws {
        let raw = PhotoResource(typeRaw: 4, uti: "com.adobe.raw-image", originalFilename: "IMG_0001.DNG")
        let render = PhotoResource(typeRaw: 5, uti: "public.jpeg", originalFilename: "FullSizeRender.jpg")
        let edits = PhotoResource(typeRaw: 7, uti: "com.apple.photos.adjustmentdata", originalFilename: "Adjustments.plist")
        let synthetic = SyntheticLibrary()
        synthetic.put(Self.photo("MIXED", taken: Self.day, resources: [Self.still, Self.motion, raw, render, edits]),
                      files: [.here(Data("still".utf8)), .inCloud(Data("motion".utf8)), .missing, .failing, .offline])
        let library = PhotoLibrary(synthetic)
        let directory = try temporaryDirectory()

        let fetched = try await library.files(of: "MIXED", network: false, costly: false, into: directory)
        let local = try XCTUnwrap(fetched)
        XCTAssertEqual(local.files.count, 5)
        XCTAssertEqual(local.snapshot.resources.map(\.size), [5, 6, nil, nil, nil], "the size of each file the library holds, here or in iCloud")
        XCTAssertEqual(try Data(contentsOf: try fileURL(local.files[0])), Data("still".utf8))
        XCTAssertEqual(Array(local.files.dropFirst()), [.later, .refused(.notFound), .refused(.downloadFailed), .later],
                       "iCloud without the network and a network error come later, never refused")
        XCTAssertEqual(synthetic.downloads, 0)

        let named = try await library.files(of: "MIXED", only: ["pairedVideo", "fullSizePhoto"], network: true, costly: false, into: directory)
        XCTAssertEqual(try XCTUnwrap(named).files.dropFirst(2).first, .unasked, "a file not named is never read")
        XCTAssertEqual(try XCTUnwrap(named).files.first, .unasked)
        XCTAssertEqual(try XCTUnwrap(named).files[3], .refused(.downloadFailed))
        XCTAssertEqual(synthetic.downloads, 1, "the one named file only iCloud held")

        let fetchedAgain = try await library.files(of: "MIXED", network: true, costly: false, into: directory)
        let downloaded = try XCTUnwrap(fetchedAgain)
        XCTAssertEqual(try Data(contentsOf: try fileURL(downloaded.files[1])), Data("motion".utf8))
        XCTAssertEqual(synthetic.downloads, 2)
        XCTAssertEqual(downloaded.files[4], .later, "a network error is the device's to retry")

        synthetic.delete("MIXED")
        let gone = try await library.files(of: "MIXED", network: true, costly: false, into: directory)
        XCTAssertNil(gone, "a photo no longer in the library has no files to fetch")
    }

    func testAFileOfNoStatedSizePastTheRoomLeavesNoFile() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.statesSizes = false
        synthetic.put(Self.photo("BIG", taken: Self.day), files: [.here(Data(repeating: 0x42, count: 100))])
        let directory = try temporaryDirectory()
        let fetched = try await PhotoLibrary(synthetic).files(of: "BIG", network: false, costly: false, room: 50, into: directory)
        XCTAssertEqual(try XCTUnwrap(fetched).files, [.noRoom])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [], "no file, whole or partial")
    }

    func testOnACostlyPathAVideoOf500MBWaitsUnaskedAndOneLessIsFetched() async throws {
        let synthetic = SyntheticLibrary()
        let movie = PhotoResource(typeRaw: 2, uti: "com.apple.quicktime-movie", originalFilename: "IMG_0002.MOV")
        synthetic.put(Self.photo("LARGE", taken: Self.day, resources: [movie, Self.still]),
                      files: [.sized(PhotoLibrary.wifiVideoBytes, Data("large".utf8)), .here(Data("still".utf8))])
        synthetic.put(Self.photo("SMALLER", taken: Self.day, resources: [movie]),
                      files: [.sized(PhotoLibrary.wifiVideoBytes - 1, Data("smaller".utf8))])
        let directory = try temporaryDirectory()
        let library = PhotoLibrary(synthetic)
        let waits = try await library.files(of: "LARGE", network: false, costly: true, into: directory)
        XCTAssertEqual(try XCTUnwrap(waits).files, [.waits, .waits], "the photo waits whole")
        XCTAssertEqual(synthetic.filesAsked, 0, "and nothing of it is asked for")
        let smaller = try await library.files(of: "SMALLER", network: false, costly: true, into: directory)
        XCTAssertEqual(try XCTUnwrap(smaller).files.count(where: { if case .file = $0 { true } else { false } }), 1)
        let free = try await library.files(of: "LARGE", network: false, costly: false, into: directory)
        XCTAssertEqual(try XCTUnwrap(free).files.count(where: { if case .file = $0 { true } else { false } }), 2,
                       "a free path takes it")
    }

    func testAFileStillBeingWrittenComesLaterWithNoRequest() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.put(Self.photo("WRITING", taken: Self.day, resources: [Self.still, Self.motion]),
                      files: [.here(Data()), .here(Data("v".utf8))])
        let directory = try temporaryDirectory()
        let files = try await PhotoLibrary(synthetic).files(of: "WRITING", network: true, costly: false, into: directory)
        let fetched = try XCTUnwrap(files)
        XCTAssertEqual(fetched.snapshot.resources.map(\.size), [0, 1])
        XCTAssertEqual(fetched.files.first, .later, "a file that states 0 bytes is still being written")
        XCTAssertEqual(synthetic.filesAsked, 1, "only the file that states its bytes is asked for")
    }

    func testARefusedFileEndsThePhotosAllowance() async throws {
        let synthetic = SyntheticLibrary()
        synthetic.statesSizes = false
        synthetic.put(Self.photo("LIVE", taken: Self.day, resources: [Self.still, Self.motion]),
                      files: [.here(Data(repeating: 0x42, count: 100)), .here(Data("v".utf8))])
        let directory = try temporaryDirectory()
        let fetched = try await PhotoLibrary(synthetic).files(of: "LIVE", network: false, costly: false, room: 50, into: directory)
        XCTAssertEqual(try XCTUnwrap(fetched).files, [.noRoom, .noRoom])
        XCTAssertEqual(synthetic.filesAsked, 1, "the second file is never asked")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
    }


    func testWhatADeviceFetchesNow() {
        let gb: Int64 = 1_000_000_000
        func due(pastMoves: Bool = true, iCloud: Bool = true, charging: Bool = false, spare: Int64 = 45 * gb,
                 bringingIn: Bool = false) -> Due {
            PhotoLibrary.due(device: Device(pastMoves: pastMoves, iCloud: iCloud, charging: charging, spare: spare),
                             bringingIn: bringingIn)
        }
        XCTAssertEqual(due(pastMoves: false, charging: true, bringingIn: true), .waits(.network),
                       "nothing while the past may not move, whatever else")
        XCTAssertEqual(due(iCloud: false, charging: true, bringingIn: true), .fetch(network: false, bytes: PhotoLibrary.bundleBytes),
                       "the files it holds, and nothing from iCloud while iCloud may not move")
        XCTAssertEqual(due(), .fetch(network: false, bytes: PhotoLibrary.bundleBytes), "on a free network: the files it holds")
        XCTAssertEqual(due(charging: true), .fetch(network: true, bytes: PhotoLibrary.bundleBytes), "while it charges: iCloud too")
        XCTAssertEqual(due(bringingIn: true), .fetch(network: true, bytes: PhotoLibrary.bundleBytes),
                       "while Bring in all photos runs: iCloud too")
        XCTAssertEqual(due(spare: 0, bringingIn: true), .waits(.space), "nothing at the line the disk keeps")
        XCTAssertEqual(due(pastMoves: false, spare: 0), .waits(.space), "space said first: the person frees it, the network mends itself")
        XCTAssertEqual(due(spare: 10_000_000), .fetch(network: false, bytes: 10_000_000), "never past the line")
    }


    private static func sha256(_ text: String) -> String {
        "sha256:" + SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("photolibrary-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func fileURL(_ fetched: Fetched) throws -> URL {
        guard case .file(let url) = fetched else { throw XCTSkip("not a file: \(fetched)") }
        return url
    }
}

#if canImport(Photos)
final class ResourceFileTests: XCTestCase {
    func testChunksAndLateCallbacksKeepTheExactBytesAndTheFirstEnding() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("resource-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: url) }
        let sink = try ResourceFile(url, most: .max)
        let fetched: Fetched = await withCheckedContinuation { continuation in
            sink.receive(continuation)
            sink.append(Data([0, 1]))
            sink.append(Data())
            sink.append(Data("🟢".utf8))
            sink.finish(nil)
            sink.append(Data([9]))
            sink.finish(.refused(.downloadFailed))
        }
        XCTAssertEqual(fetched, .file(url))
        XCTAssertEqual(try Data(contentsOf: url), Data([0, 1]) + Data("🟢".utf8))
    }

    func testAFileThatDoesNotComeWholeIsRemoved() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("resource-\(UUID().uuidString)")
        let sink = try ResourceFile(url, most: .max)
        sink.append(Data([1, 2, 3]))
        sink.cancel()
        let fetched: Fetched = await withCheckedContinuation { sink.receive($0) }
        XCTAssertEqual(fetched, .later)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        XCTAssertEqual(PhotoKitSource.outcome(NSError(domain: "PHPhotosErrorDomain", code: 3169)), .later, "a network error")
        XCTAssertEqual(PhotoKitSource.outcome(NSError(domain: "PHPhotosErrorDomain", code: 3164)), .later, "iCloud, not allowed")
        XCTAssertEqual(PhotoKitSource.outcome(NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet)), .later)
        XCTAssertEqual(PhotoKitSource.outcome(NSError(domain: "PHPhotosErrorDomain", code: 3303)), .refused(.notFound))
        XCTAssertEqual(PhotoKitSource.outcome(NSError(domain: "CloudPhotoLibraryErrorDomain", code: 80)), .later,
                       "no iCloud error is known to be final: a refusal is for good")
        XCTAssertEqual(PhotoKitSource.outcome(NSError(domain: "PHPhotosErrorDomain", code: 3114)), .later, "the library's volume is away")
    }

    func testAChunkPastTheCeilingEndsTheFetchWithNoRoom() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("resource-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: url) }
        let sink = try ResourceFile(url, most: 4)
        let cancels = Asks()
        let fetched: Fetched = await withCheckedContinuation { continuation in
            sink.receive(continuation)
            sink.onCancel {
                cancels.count()
                sink.finish(.later)
            }
            sink.append(Data([0, 1, 2]))
            XCTAssertTrue(FileManager.default.fileExists(atPath: url.path), "what fits is written")
            sink.append(Data([3, 4]))
            sink.append(Data([5]))
            sink.finish(nil)
            sink.cancel()
        }
        XCTAssertEqual(fetched, .noRoom)
        XCTAssertEqual(cancels.asks, 1, "the request is cancelled once")
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), "the partial file is gone")
    }
}
#endif
