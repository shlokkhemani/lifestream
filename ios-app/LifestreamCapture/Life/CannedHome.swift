import AVFoundation
import Cockpit
import CryptoKit
import Foundation
import HomeLink
import LifestreamCaptureCore
import Observation
import os
import SwiftUI
import UIKit

enum CannedHome {

    struct Member: Sendable {
        let slug: String
        let name: String
        let handle: (kind: String, value: String)
        let network: String
        let chat: String

        var id: String { "person:" + slug }
    }

    static let cast = baseCast + (crowd ? crowdMembers : [])

    static let baseCast = [
        Member(slug: "person-a", name: "Person A", handle: ("phone", "+15550000001"), network: "whatsapp",
               chat: "whatsapp:15550000001@s.whatsapp.net"),
        Member(slug: "person-b", name: "Person B", handle: ("phone", "+15550000002"), network: "whatsapp",
               chat: "whatsapp:15550000002@s.whatsapp.net"),
        Member(slug: "person-c", name: "Person C", handle: ("email", "person-c@example.com"), network: "imessage",
               chat: "imessage:person-c@example.com"),
    ]

    static let crowd = ProcessInfo.processInfo.arguments.contains("--ui-test-crowd")

    static let crowdNames = "Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet Kilo Lima Mike November Oscar Papa Quebec Romeo Sierra Tango Uniform Victor Whiskey Xray Yankee Zulu Amber Birch Cedar Dune Ember Fjord Grove Harbour".split(separator: " ")
        .enumerated().map { index, word in
            "Person \(word) Longfamilyname-Hyphenated" + (index == 0 ? " Secondgivenname Thirdgivenname Fourthfamilyname-Doublebarrelled Fifth" : "")
        }

    static let crowdMembers: [Member] = crowdNames.enumerated().map { index, name in
        let number = String(format: "+1555001%04d", index)
        return Member(slug: "crowd-\(index)", name: name, handle: ("phone", number), network: "whatsapp",
                      chat: "whatsapp:\(number.dropFirst())@s.whatsapp.net")
    }

    static let crowdLines = ["are you around this week?", "sent you the photos from Saturday", "can we move it to Thursday?",
                             "thanks again for yesterday", "did you see the plan?", "lunch tomorrow?", "landed, call you later",
                             "the keys are with the neighbour", "happy to help with the move", "what time works for you?"]

    static let faces = ProcessInfo.processInfo.arguments.contains("--ui-test-faces")

    static let portraits: [String: Data] = Dictionary(uniqueKeysWithValues: (0..<max(crowdMembers.count, 24)).map { index in
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let skins: [(CGFloat, CGFloat, CGFloat)] = [(0.07, 0.28, 0.96), (0.07, 0.38, 0.86), (0.07, 0.48, 0.72), (0.06, 0.55, 0.56), (0.06, 0.58, 0.42)]
        let hairs: [(CGFloat, CGFloat, CGFloat)] = [(0.08, 0.5, 0.16), (0.07, 0.6, 0.3), (0.09, 0.55, 0.62), (0.05, 0.6, 0.42), (0.6, 0.04, 0.68)]
        let skin = skins[index % skins.count], hair = hairs[(index * 3 + index / 5) % hairs.count]
        let ground = CGFloat(index * 7 % 24) / 24
        let long = index % 3 == 1
        let data = UIGraphicsImageRenderer(size: CGSize(width: 192, height: 192), format: format).pngData { context in
            let cg = context.cgContext
            UIColor(hue: ground, saturation: 0.22, brightness: 0.62, alpha: 1).setFill()
            cg.fill(CGRect(x: 0, y: 0, width: 192, height: 192))
            let hairColour = UIColor(hue: hair.0, saturation: hair.1, brightness: hair.2, alpha: 1)
            if long {
                hairColour.setFill()
                cg.fillEllipse(in: CGRect(x: 48, y: 34, width: 96, height: 128))
            }
            UIColor(hue: (ground + 0.45).truncatingRemainder(dividingBy: 1), saturation: 0.4, brightness: 0.42, alpha: 1).setFill()
            cg.fillEllipse(in: CGRect(x: 18, y: 138, width: 156, height: 130))
            let face = UIColor(hue: skin.0, saturation: skin.1, brightness: skin.2, alpha: 1)
            face.setFill()
            cg.fill(CGRect(x: 80, y: 112, width: 32, height: 40))
            cg.fillEllipse(in: CGRect(x: 60, y: 48, width: 72, height: 88))
            hairColour.setFill()
            cg.saveGState()
            cg.clip(to: CGRect(x: 0, y: 0, width: 192, height: 74))
            cg.fillEllipse(in: CGRect(x: 54, y: 36, width: 84, height: 76))
            cg.restoreGState()
        }
        return (hash(data), data)
    })

    static func portrait(of id: String) -> String? {
        guard faces || id.hasPrefix("person:crowd-") else { return nil }
        let sorted = portraits.keys.sorted()
        let index = id.unicodeScalars.reduce(0) { ($0 * 31 + Int($1.value)) % 9_973 }
        return sorted[index % sorted.count]
    }

    enum You {
        static let id = "person:sam-example"
        static let none = ProcessInfo.processInfo.arguments.contains("--ui-test-no-you")
        static let dayOne = ProcessInfo.processInfo.arguments.contains("--ui-test-you-day-one")
        static let long = ProcessInfo.processInfo.arguments.contains("--ui-test-you-long")
        static let name = long ? "Samantha-Alexandria Longfamilyname" : "Sam"
        static let fullName = long ? "Samantha-Alexandria Josephine Longfamilyname-Doublebarrelled" : "Sam Example"
        static let handles: [(kind: String, value: String, from: String, own: Bool)] = dayOne ? [] : [
            ("phone", "+15550000000", "Your WhatsApp", true),
            ("phone", "+15550000090", "Your iMessage", true),
            ("email", "sam@icloud.example.com", "Your iMessage", true),
            ("email", "sam@example.com", "Your Gmail", true),
            ("email", "sam.example@example.com", "Your Gmail", true),
            ("phone", "+15550000091", "Contacts", false),
            ("email", "sam@work.example.com", "Contacts", false),
            ("email", "s.example@example.net", "Contacts", false),
            ("phone", "+15550000092", "You added", false),
            ("email", "sam.2014@example.com", "You added", false),
        ]
        static let alsoCalled: [[String: String]] = dayOne ? [] : [["name": "Sammy", "from": "You added"], ["name": "S.E.", "from": "Contacts"]]
        static let photos = dayOne ? 0 : 12
    }

    static let emptyHome = ProcessInfo.processInfo.arguments.contains("--ui-test-empty-home")

    struct Former: Sendable {
        let id: String
        let name: String
        let by: String
        let slug: String?
        let handle: (kind: String, value: String)
        let network: String
        let chat: String?
        let received: Int
        let sent: Int
        let firstBack: Int
        let lastBack: Int
        let last30: Int
        let inGroup: Bool
    }

    static let former = [
        Former(id: "person:person-d", name: "Person D", by: "registry", slug: "person-d", handle: ("phone", "+15550000004"),
               network: "whatsapp", chat: "whatsapp:15550000004@s.whatsapp.net", received: 412, sent: 380, firstBack: 700, lastBack: 23,
               last30: 46, inGroup: true),
        Former(id: "phone:+15550000005", name: "Person E", by: "contact", slug: nil, handle: ("phone", "+15550000005"),
               network: "imessage", chat: "imessage:+15550000005", received: 88, sent: 61, firstBack: 300, lastBack: 52,
               last30: 0, inGroup: false),
        Former(id: "phone:+15550000006", name: "+15550000006", by: "none", slug: nil, handle: ("phone", "+15550000006"),
               network: "whatsapp", chat: "whatsapp:15550000006@s.whatsapp.net", received: 9, sent: 4, firstBack: 40, lastBack: 26,
               last30: 2, inGroup: false),
        Former(id: "phone:+15550000007", name: "+15550000007", by: "none", slug: nil, handle: ("phone", "+15550000007"),
               network: "whatsapp", chat: "whatsapp:15550000007@s.whatsapp.net", received: 20, sent: 1, firstBack: 210, lastBack: 200,
               last30: 0, inGroup: false),
        Former(id: "phone:+15550000008", name: "Person F", by: "contact", slug: nil, handle: ("phone", "+15550000008"),
               network: "whatsapp", chat: "whatsapp:15550000008@s.whatsapp.net", received: 140, sent: 122, firstBack: 900, lastBack: 410,
               last30: 0, inGroup: true),
        Former(id: "email:person-f@example.com", name: "Person F", by: "contact", slug: nil, handle: ("email", "person-f@example.com"),
               network: "imessage", chat: "imessage:person-f@example.com", received: 30, sent: 25, firstBack: 800, lastBack: 430,
               last30: 0, inGroup: false),
        Former(id: "phone:+15550000009", name: "Stranger G", by: "push-name", slug: nil, handle: ("phone", "+15550000009"),
               network: "whatsapp", chat: nil, received: 17, sent: 0, firstBack: 120, lastBack: 24, last30: 3, inGroup: true),
        Former(id: "person:person-h", name: "Person H", by: "registry", slug: "person-h", handle: ("phone", "+15550000010"),
               network: "whatsapp", chat: "whatsapp:15550000010@s.whatsapp.net", received: 1_800, sent: 1_500, firstBack: 2_000,
               lastBack: 4, last30: 2, inGroup: false),
        Former(id: "person:person-j", name: "Person J", by: "registry", slug: "person-j", handle: ("phone", "+15550000011"),
               network: "whatsapp", chat: "whatsapp:15550000011@s.whatsapp.net", received: 5, sent: 3, firstBack: 40,
               lastBack: 30, last30: 0, inGroup: false),
    ]

    static let formerGroup = (label: "Group Beta", chat: "whatsapp:120363000000000002@g.us", total: 1_210, mine: 214,
                              firstBack: 700, lastBack: 23)

    static let group = (label: "Group Alpha", chat: "whatsapp:120363000000000001@g.us", members: ["person-a", "person-b"])

    struct OtherGroup: Sendable {
        let label: String
        let chat: String
        let total: Int
        let mine: Int
        let theirs: Int
        let lastBack: Int
        var quiet: (why: String, lastBack: Int?)?
        var word: Bool?
    }

    static let moreGroups = ["Gamma", "Epsilon", "Zeta", "Eta", "Theta", "Iota"].enumerated().map { index, name in
        OtherGroup(label: "Group " + name, chat: String(format: "whatsapp:1203630000000000%02d@g.us", index + 3), total: 400 - index * 40,
                   mine: 60 - index * 5, theirs: 90 - index * 10, lastBack: 2 + index * 3)
    }

    static let quietGroups = [
        OtherGroup(label: "Group Delta", chat: "whatsapp:120363000000000011@g.us", total: 2_340, mine: 12, theirs: 310, lastBack: 0,
                   quiet: ("silent", 100)),
        OtherGroup(label: "Synthetic Shop Deals", chat: "whatsapp:120363000000000012@g.us", total: 54_817, mine: 0, theirs: 1_418,
                   lastBack: 0, quiet: ("archived", nil)),
        OtherGroup(label: "Group Kappa", chat: "whatsapp:120363000000000013@g.us", total: 820, mine: 40, theirs: 75, lastBack: 6,
                   quiet: ("owner", 30), word: true),
    ]


    static let unpaired = ProcessInfo.processInfo.arguments.contains("--ui-test-unpaired")

    static let clockLate = ProcessInfo.processInfo.arguments.contains("--ui-test-clock-late")

    static var elsewhere: TimeZone {
        let honolulu = TimeZone(identifier: "Pacific/Honolulu")!
        return TimeZone.current.secondsFromGMT() == honolulu.secondsFromGMT() ? TimeZone(identifier: "Asia/Tokyo")! : honolulu
    }

    static let suggesterAway = ProcessInfo.processInfo.arguments.contains("--ui-test-suggester-away")

    static let proof = ProcessInfo.processInfo.arguments.contains("--ui-test-proof")

    static let unit = "iphone-aa01"

    static let another = "iphone-aa03"

    static let code = "48213907"

    static let paired = OSAllocatedUnfairLock(initialState: CannedHome.unit)

    static let people = "people:local:home-canned"

    @MainActor static func link(folder: URL, reader: (any HomeTransport)?) -> HomeLink {
        if !unpaired {
            let now = AppClock.now.timeIntervalSince1970
            let saved: [String: Any] = ["at": now - 180, "answer": answer]
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try? JSONSerialization.data(withJSONObject: saved).write(to: folder.appendingPathComponent("answer.json"))
            if !clockLate {
                try? JSONSerialization.data(withJSONObject: clockAnswer(at: AppClock.now)).write(to: folder.appendingPathComponent("clock.json"))
            }
            try? Data(#"{"outcome":"shipped"}"#.utf8).write(to: folder.appendingPathComponent("shipper.json"))
        }
        let credentials: any Credentials
        if SpeedLog.shared != nil {
            let keychain = KeychainCredentials(service: "org.lifestreamprotocol.homelink.speed")
            try? keychain.write(Pass.paired)
            credentials = keychain
        } else {
            credentials = Pass(paired: !unpaired)
        }
        encodeMoviesBeforeAnyRequest()
        return HomeLink(device: PhoneLink.device(), credentials: credentials, folder: folder, transport: Transport(reader: reader), finder: Finder(),
                        network: Network(), grace: grace)
    }

    private static func encodeMoviesBeforeAnyRequest() {
        _ = (video, live)
    }

    static let grace: TimeInterval = 2

    #if DEBUG
    @MainActor @Observable final class Stated {
        static let shared = Stated()
        private(set) var lines: [String] = []

        func record(_ line: String) {
            lines.append(line)
        }
    }
    #endif

    static let placeActs = PlaceActs()

    final class PlaceActs: @unchecked Sendable {
        private let lock = NSLock()
        private var made: [[String: Any]] = []
        private var changed: [String: [String: Any]] = [:]
        private var removed: Set<String> = []
        private var hid: [[String: Any]] = []
        private var unhid: Set<String> = []
        private var renamed: Set<String> = []
        private var homed: Set<String> = []
        private var answers: [String: [String: Any]] = [:]
        private var acts = 0

        func act(_ asked: [String: Any], list: [String: Any], now: Date) -> (Int, [String: Any]) {
            let places = list["places"] as? [[String: Any]] ?? []
            let hidden = list["hidden"] as? [[String: Any]] ?? []
            return lock.withLock {
                guard let request = asked["request"] as? String else { return Self.refused(400, "BAD_ACTION") }
                if let kept = answers[request] { return (200, kept) }
                guard let id = drafted(asked, places: places, hidden: hidden, now: now) else { return Self.refused(404, "PLACE_UNKNOWN") }
                acts += 1
                let answer: [String: Any] = ["act": NSNull(), "id": id, "position": "\(acts):\(Self.ms(now))"]
                answers[request] = answer
                return (200, answer)
            }
        }

        private func drafted(_ asked: [String: Any], places: [[String: Any]], hidden: [[String: Any]], now: Date) -> String? {
            let circle = ["latitude", "longitude", "radius_m"].reduce(into: [String: Any]()) { held, member in held[member] = asked[member] }
            switch asked["kind"] as? String {
            case "create":
                guard let name = asked["name"] as? String else { return nil }
                let slug = Self.minted(name)
                made.append(circle.merging(["slug": slug, "name": name, "also": [Any](), "ids": asked["ids"] ?? [String](),
                                            "area": CannedHome.town.json, "stays": 0, "days": 0, "hours": 0, "longest_day_hours": 0,
                                            "today_hours": 0, "first_ms": NSNull(), "last_ms": NSNull(), "counting": true]) { $1 }
                    .merging((asked["home"] as? Bool).map { ["home": $0] } ?? [:]) { $1 })
                return "place:" + slug
            case "hide":
                let key = Self.minted("hidden")
                hid.append(["key": key, "latitude": asked["latitude"] ?? 0, "longitude": asked["longitude"] ?? 0,
                            "hidden_ms": Self.ms(now), "days": 0, "nearest": NSNull(), "counting": true])
                return "hidden:" + key
            case "unhide":
                guard let key = asked["key"] as? String, hidden.contains(where: { $0["key"] as? String == key }) else { return nil }
                unhid.insert(key)
                return "hidden:" + key
            default:
                guard let slug = asked["slug"] as? String, let place = places.first(where: { $0["slug"] as? String == slug }) else { return nil }
                var fields = changed[slug] ?? [:]
                switch asked["kind"] as? String {
                case "remove": removed.insert(slug)
                case "add-circle": fields["also"] = (place["also"] as? [[String: Any]] ?? []) + [circle]
                case "edit":
                    for member in ["name", "latitude", "longitude", "radius_m", "also", "home"] where asked[member] != nil {
                        fields[member] = asked[member]
                    }
                    if let name = asked["name"] as? String, name != place["name"] as? String { renamed.insert(slug) }
                    if asked["home"] as? Bool == true { homed.insert(slug) }
                default: return nil
                }
                changed[slug] = fields
                return "place:" + slug
            }
        }

        func placed(_ slug: String) -> String {
            lock.withLock { homed.contains(slug) ? slug + "-home" : renamed.contains(slug) ? slug + "-renamed" : slug }
        }

        var listed: String {
            lock.withLock { !unhid.isEmpty ? "places.unhidden" : !hid.isEmpty ? "places.named" : !made.isEmpty ? "places.gym" : "places.list" }
        }

        func over(_ list: [String: Any]) -> [String: Any] {
            lock.withLock {
                let places = ((list["places"] as? [[String: Any]] ?? []) + made).compactMap { place -> [String: Any]? in
                    guard let slug = place["slug"] as? String, !removed.contains(slug) else { return nil }
                    let placed = place.merging(changed[slug] ?? [:]) { $1 }
                    return placed.filter { !($0.value is NSNull) }
                }
                let hidden = ((list["hidden"] as? [[String: Any]] ?? []) + hid).filter { !unhid.contains($0["key"] as? String ?? "") }
                let circles = places.flatMap { place in [place] + (place["also"] as? [[String: Any]] ?? []) }.compactMap(Self.circle)
                    + hidden.compactMap { Self.circle($0.merging(["radius_m": PlaceRules.reachMeters]) { $1 }) }
                let spots = (list["spots"] as? [[String: Any]] ?? []).filter { spot in
                    guard let at = Self.circle(spot.merging(["radius_m": 0.0]) { $1 }) else { return true }
                    return !circles.contains { $0.holds(at.centre) }
                }
                return list.merging(["places": places, "hidden": hidden, "spots": spots]) { $1 }
            }
        }

        private static func circle(_ stated: [String: Any]) -> PlaceCircle? {
            guard let latitude = stated["latitude"] as? Double, let longitude = stated["longitude"] as? Double,
                  let radius = stated["radius_m"] as? Double else { return nil }
            return PlaceCircle(centre: PlaceCoordinate(latitude: latitude, longitude: longitude), radiusMeters: radius)
        }

        private static func minted(_ name: String) -> String {
            let words = name.lowercased().split { !($0.isASCII && ($0.isLetter || $0.isNumber)) }.joined(separator: "-")
            let hex = (0..<6).map { _ in String(Int.random(in: 0..<16), radix: 16) }.joined()
            return (words.isEmpty ? "" : String(words.prefix(48)) + "-") + hex
        }

        static func content(_ placed: [String: Any]) -> PlaceContent? {
            guard let first = circle(placed), let name = placed["name"] as? String else { return nil }
            return PlaceContent(name: name, centre: first.centre, radiusMeters: first.radiusMeters,
                                also: (placed["also"] as? [[String: Any]] ?? []).compactMap(circle))
        }

        private static func ms(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded(.down)) }

        private static func refused(_ status: Int, _ code: String) -> (Int, [String: Any]) {
            (status, ["code": code, "message": "There is no such place."])
        }
    }

    final class Namings: @unchecked Sendable {
        struct Named: Equatable {
            let words: String
            let name: String
            let slug: String
        }

        private let lock = NSLock()
        private var named: [Named] = []
        private var before: [Named] = []
        private var read: Set<String> = []

        static let reach: Double = 1_000
        static let listed: Set<String> = ["home-place", "the-office", "old-office", "corner-bakery", "harbour-inn", "willow-court"]

        func record(_ content: PlaceContent, slug: String) {
            guard !Self.listed.contains(slug) else { return }
            let circles = [PlaceCircle(centre: content.centre, radiusMeters: content.radiusMeters)] + content.also
            let spots = CannedHome.toName.filter { spot in
                let point = PlaceCoordinate(latitude: spot.latitude, longitude: spot.longitude)
                return circles.contains { $0.centre.distance(to: point) <= Self.reach }
            }
            guard !spots.isEmpty else { return }
            lock.withLock {
                before = named
                named = named.filter { held in !spots.contains { $0.words == held.words } }
                    + spots.map { Named(words: $0.words, name: content.name, slug: slug) }
                read = []
            }
        }

        var now: [Named] { lock.withLock { named } }

        func rendered(_ day: String) -> [Named] {
            lock.withLock { read.insert(day).inserted ? before : named }
        }

        func shown(_ day: String) -> [Named] {
            lock.withLock { read.contains(day) ? named : before }
        }
    }

    static let namings = Namings()

    static var answer: [String: Any] { answer(as: paired.withLock { $0 }) }

    private static let turns = OSAllocatedUnfairLock(initialState: 0)

    private static func answer(as unit: String) -> [String: Any] {
        let sources = ["location", "motion", "health", "photos", "contacts", "checkins", "notes"]
        let turn: Int = turns.withLock { written in
            written += 1
            return written
        }
        return [
            "home": ["id": "home-canned", "version": "1.0.0", "floors": [String: String]()],
            "pass": unit == CannedHome.unit ? "p-0001" : "p-0002", "unit": unit,
            "owner": [people],
            "sources": Dictionary(uniqueKeysWithValues: sources.enumerated().map { index, source in
                let id = "\(source):local:\(unit)", held = bundles.seal(of: id) ?? 40 + index
                return (id, ["received": held, "imported": held, "formats": [String](), "history": true] as [String: Any])
            }),
            "needs": report(unit: unit)["needs"] as? [[String: Any]] ?? [], "calls": [Any](), "settings": [String: Any](),
            "turn": ["run": "00000000000ca22e", "n": turn], "clock": clock(at: AppClock.now).id ?? "",
        ]
    }

    static func clock(at now: Date) -> HomeClock {
        let run = HomeClock.placeholder(at: now, zone: TimeZone.current).runs[0]
        let zone = clockLate ? elsewhere : run.zone
        let named = HomeClock.Run(day: run.day, startMs: run.startMs, days: run.days, zone: zone.identifier)!
        return HomeClock(id: "canned-\(run.day)-\(zone.identifier)", runs: [named])!
    }

    static var today: String {
        let now = AppClock.now
        return clock(at: now).dayAt(now).day
    }

    static func clockAnswer(at now: Date) -> [String: Any] {
        let clock = clock(at: now), run = clock.runs[0]
        return ["id": clock.id ?? "", "zone": run.zone.identifier, "start_hour": 4,
                "runs": [["day": run.day, "start_ms": run.startMs, "days": run.days, "zone": run.zone.identifier]]]
    }

    final class Settings: @unchecked Sendable {
        static let changed = ProcessInfo.processInfo.arguments.contains("--ui-test-home-changed")
        static let away = ProcessInfo.processInfo.arguments.contains("--ui-test-settings-away")
        private static let refused: Set<String> = ["secret", "email", "path"]

        private let lock = NSLock()
        private var held: [String: [String: HomeLink.JSON]] = [
            "location": ["precision": .string(changed ? "battery" : "precise")],
            "checkin": ["prompts": .bool(changed), "bedtime": .string(changed ? "22:30" : "23:30")],
        ]
        private var phone: [String: [String: HomeLink.JSON]] = [:]
        private var gone = false

        func laid(_ rows: [[String: Any]]) -> [[String: Any]] {
            let (held, stated) = lock.withLock { (self.held, self.phone) }
            return rows.map { row in
                let id = row["id"] as? String ?? ""
                let mine = held[id] ?? [:]
                let says = stated[id] ?? [:]
                guard !mine.isEmpty || !says.isEmpty else { return row }
                var row = row
                row["members"] = (row["members"] as? [[String: Any]] ?? []).map { member in
                    let key = member["key"] as? String ?? ""
                    var member = member
                    if let value = mine[key] {
                        member["value"] = Self.any(value)
                        let steps = member["steps"] as? [[String: Any]] ?? []
                        if case .string(let named) = value, let step = steps.first(where: { $0["value"] as? String == named }) {
                            member["words"] = step["words"]
                        }
                        if case .string(let named) = value, let menu = member["menu"] as? [String: Any] {
                            (member["menu"], member["words"]) = Self.chose(named, in: menu, words: member["words"])
                        }
                    }
                    if says[key] != nil, member["panel"] as? String == nil { member["panel"] = "settings" }
                    return member
                }
                return row
            }
        }

        var reads: Bool { lock.withLock { !gone } }

        private static func chose(_ value: String, in menu: [String: Any], words: Any?) -> ([String: Any], Any?) {
            var menu = menu
            var said = words
            let mark = { (row: [String: Any]) -> [String: Any] in
                var row = row
                row["chosen"] = row["value"] as? String == value
                if row["value"] as? String == value, value != "default" { said = row["name"] }
                return row
            }
            for key in ["default", "off"] { if let row = menu[key] as? [String: Any] { menu[key] = mark(row) } }
            menu["rows"] = (menu["rows"] as? [[String: Any]] ?? []).map(mark)
            if var local = menu["local"] as? [String: Any] {
                local["rows"] = (local["rows"] as? [[String: Any]] ?? []).map(mark)
                menu["local"] = local
            }
            return (menu, said)
        }

        func set(_ body: Data) -> (Int, [String: Any]) {
            guard !Self.away else {
                lock.withLock { gone = true }
                return (503, ["code": "HOME_STOPPED", "message": "the canned home is not running"])
            }
            guard let asked = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
                  let connector = asked["connector"] as? String, let member = asked["member"] as? String,
                  let raw = asked["value"], let value = Self.json(raw) else {
                return (422, ["code": "VALUE_BAD", "message": "the canned home reads no such change"])
            }
            let rows = CannedHome.report(unit: CannedHome.paired.withLock { $0 })["connectors"] as? [[String: Any]] ?? []
            let declared = rows.first { $0["id"] as? String == connector }
                .flatMap { ($0["members"] as? [[String: Any]])?.first { $0["key"] as? String == member } }
            return lock.withLock {
                let own = held[connector]?[member] != nil
                guard own || declared.map({ !Self.refused.contains($0["kind"] as? String ?? "") }) == true else {
                    return (403, ["code": "PRINCIPAL_SCOPE", "message": "set on the Mac"])
                }
                let home = held[connector]?[member] ?? declared.flatMap { $0["value"] }.flatMap(Self.json) ?? .null
                if let was = asked["was"].flatMap(Self.json), was != home {
                    return (409, ["code": "CHANGED", "message": "changed elsewhere", "value": Self.any(home)])
                }
                held[connector, default: [:]][member] = value
                return (200, ["landed": ["connector": connector, "member": member, "value": Self.any(value)]])
            }
        }

        func exchange(_ body: Data) -> [String: Any] {
            let asked = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
            return lock.withLock {
                if let stated = asked?["settings"] as? [String: Any] {
                    phone = stated.compactMapValues { members in
                        (members as? [String: Any])?.compactMapValues(Self.json)
                    }
                }
                return ["location": held["location"].map(Self.any) ?? [:], "checkin": held["checkin"].map(Self.any) ?? [:]]
            }
        }

        var said: String {
            lock.withLock {
                let mine = ["location", "checkin"]
                let object: [String: Any] = [
                    "home": Dictionary(uniqueKeysWithValues: mine.map { ($0, Self.any(held[$0] ?? [:])) }),
                    "phone": Dictionary(uniqueKeysWithValues: mine.compactMap { id in phone[id].map { (id, Self.any($0)) } }),
                ]
                let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
                return String(decoding: data, as: UTF8.self)
            }
        }

        @MainActor final class Probe: ObservableObject {
            static let shared = Probe()
            @Published private(set) var said = ""

            func show(_ said: String) { if said != self.said { self.said = said } }

            struct View: SwiftUI.View {
                @ObservedObject private var probe = Probe.shared

                var body: some SwiftUI.View {
                    Text(probe.said).font(.system(size: 1)).opacity(0.01)
                        .allowsHitTesting(false)
                        .accessibilityIdentifier("ui-test.settings")
                }
            }
        }

        private static func json(_ raw: Any) -> HomeLink.JSON? {
            guard let bytes = try? JSONSerialization.data(withJSONObject: raw, options: [.fragmentsAllowed]) else { return nil }
            return try? JSONDecoder().decode(HomeLink.JSON.self, from: bytes)
        }

        private static func any(_ value: HomeLink.JSON) -> Any {
            (try? JSONEncoder().encode(value)).flatMap { try? JSONSerialization.jsonObject(with: $0, options: [.fragmentsAllowed]) } ?? NSNull()
        }

        private static func any(_ members: [String: HomeLink.JSON]) -> [String: Any] {
            members.mapValues { any($0) }
        }
    }

    static let settings = Settings()

    final class HomeSettings: @unchecked Sendable {
        private static let device: Set<String> = ["model.cap", "history.start"]
        private let lock = NSLock()
        private var held: [String: Double] = [:]

        func set(_ body: Data) -> (Int, [String: Any]) {
            guard let asked = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any], asked.count == 1,
                  let (key, value) = asked.first else {
                return (422, ["code": "BAD_REQUEST", "message": "a body naming no connector names one setting and its value"])
            }
            guard Self.device.contains(key) else { return (403, ["code": "PRINCIPAL_SCOPE", "message": "\(key) is set on the Mac"]) }
            guard let number = (value as? NSNumber)?.doubleValue, number >= 1 else {
                return (422, ["code": "SETTING_REFUSED", "message": "the canned home refuses \(key) \(value)"])
            }
            lock.withLock { held[key] = number }
            return (200, [:])
        }

        func page(_ answered: Data) -> Data {
            let held = lock.withLock { self.held }
            guard !held.isEmpty, var page = (try? JSONSerialization.jsonObject(with: answered)) as? [String: Any],
                  let parts = page["parts"] as? [[String: Any]] else { return answered }
            page["parts"] = parts.map { part in
                var part = part
                part["rows"] = (part["rows"] as? [[String: Any]] ?? []).map { Self.chosen($0, held) }
                return part
            }
            return (try? JSONSerialization.data(withJSONObject: page, options: [.sortedKeys])) ?? answered
        }

        private static func chosen(_ row: [String: Any], _ held: [String: Double]) -> [String: Any] {
            guard var end = row["end"] as? [String: Any], end["kind"] as? String == "choice", let key = end["key"] as? String,
                  let value = held[key], var choices = end["choices"] as? [[String: Any]] else { return row }
            if !choices.contains(where: { ($0["value"] as? NSNumber)?.doubleValue == value }) {
                choices.append(["words": String(Int(value)), "value": value, "chosen": false, "default": false])
            }
            end["choices"] = choices.map { choice in
                var choice = choice
                choice["chosen"] = (choice["value"] as? NSNumber)?.doubleValue == value
                return choice
            }.sorted { (($0["value"] as? NSNumber)?.doubleValue ?? 0) < (($1["value"] as? NSNumber)?.doubleValue ?? 0) }
            var row = row
            row["end"] = end
            return row
        }
    }

    static let homeSettings = HomeSettings()

    final class Streams: @unchecked Sendable {
        private struct Pauses { var all: Bool; var history: Bool }

        private let lock = NSLock()
        private var off: Set<String> = []
        private var pauses: [String: Pauses] = [:]

        func isOff(_ id: String) -> Bool { lock.withLock { off.contains(id) } }

        func laid(_ rows: [[String: Any]], at: Int64) -> [[String: Any]] {
            let (off, pauses) = lock.withLock { (self.off, self.pauses) }
            return rows.map { row in
                let id = row["id"] as? String ?? ""
                var row = row
                if off.contains(id) {
                    row["on"] = false
                    row["copies"] = (row["copies"] as? [[String: Any]] ?? []).map { copy in copy.merging(["on": false]) { $1 } }
                }
                if let pause = pauses[id] {
                    row["pauses"] = [pause.all ? "all" : nil, pause.history ? "history" : nil].compactMap { $0 }
                        .map { ["scope": $0, "by": "you", "reason": "", "at_ms": at] }
                }
                return row
            }
        }

        func change(_ id: String, _ body: Data, rows: [[String: Any]]) -> (Int, [String: Any]?) {
            guard let row = rows.first(where: { $0["id"] as? String == id }) else {
                return (404, ["code": "CONNECTOR_UNKNOWN", "message": "the home declares no \(id)"])
            }
            guard row["shown"] as? String != "home" else {
                return (403, ["code": "PRINCIPAL_SCOPE", "message": "\(id) is the home's own: it is turned off on the Mac"])
            }
            let asked = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
            let history = asked["history"] as? Bool == true
            return lock.withLock {
                if asked.count == 1, asked["on"] as? Bool == false {
                    off.insert(id)
                } else if let pause = asked["paused"] as? Bool, asked.count == (history ? 2 : 1) {
                    let standing = (row["pauses"] as? [[String: Any]] ?? []).compactMap { $0["scope"] as? String }
                    var stands = pauses[id] ?? Pauses(all: standing.contains("all"), history: standing.contains("history"))
                    if history { stands.history = pause } else { stands.all = pause }
                    pauses[id] = stands
                } else {
                    return (422, ["code": "BAD_REQUEST", "message": "a stream is turned off, or it or its past paused or resumed"])
                }
                return (200, nil)
            }
        }
    }

    static let streams = Streams()

    static let refreshed = OSAllocatedUnfairLock(initialState: Set<String>())

    static func onlyThisPhoneShips(_ row: [String: Any], unit: String) -> Bool {
        let copies = row["copies"] as? [[String: Any]] ?? []
        let roads = Set(copies.compactMap { $0["road"] as? String })
        return roads.isDisjoint(with: ["poll", "chrome", "mac"])
            && copies.contains { $0["road"] as? String == "phone" && $0["unit"] as? String == unit && $0["on"] as? Bool == true }
    }

    static func refusesRefresh(_ body: Data) -> Bool {
        guard let asked = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any], let id = asked["connector"] as? String
        else { return false }
        let unit = paired.withLock { $0 }
        return (report(unit: unit)["connectors"] as? [[String: Any]] ?? [])
            .contains { $0["id"] as? String == id && onlyThisPhoneShips($0, unit: unit) }
    }

    final class Bundles: @unchecked Sendable {
        private let lock = NSLock()
        private var seals: [String: Int] = [:]
        private var taken: [[String]] = []

        func seal(of source: String) -> Int? { lock.withLock { seals[source] } }

        func take(_ file: URL) -> Bool {
            guard let manifest = try? StoredZIPWriter.readManifest(from: file) else { return false }
            lock.withLock {
                for (source, custody) in manifest.custody { seals[source] = Int(custody.seal) }
                taken.append(manifest.custody.keys.sorted())
            }
            return true
        }

        var said: String { lock.withLock { taken.map { $0.joined(separator: "+") }.joined(separator: " | ") } }

        @MainActor final class Probe: ObservableObject {
            static let shared = Probe()
            @Published private(set) var said = ""

            func show(_ said: String) { if said != self.said { self.said = said } }

            struct View: SwiftUI.View {
                @ObservedObject private var probe = Probe.shared

                var body: some SwiftUI.View {
                    Text(probe.said).font(.system(size: 1)).opacity(0.01)
                        .allowsHitTesting(false)
                        .accessibilityIdentifier("ui-test.bundles")
                }
            }
        }
    }

    static let bundles = Bundles()

    static func connecting(_ path: String, _ body: Data) -> [String: Any]? {
        guard path == "/v1/refresh" || path == "/v1/seal" || path.hasPrefix("/v1/signin/"),
              let asked = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { return nil }
        let connector = asked["connector"] as? String ?? ""
        let signedIn: [String: Any] = ["account": "person-a@example.com", "source": "\(connector):person-a@example.com:cloud"]
        let ends = Int64(AppClock.now.timeIntervalSince1970 * 1000) + 600_000
        switch path {
        case "/v1/refresh":
            refreshed.withLock { _ = $0.insert(connector) }
            return ["state": "queued"]
        case "/v1/seal": return ["sealed": true]
        case "/v1/signin/key", "/v1/signin/device/poll": return signedIn
        case "/v1/signin/device/start":
            return ["code": "WDJB-MJHT", "open": "https://example.com/device", "interval_ms": 1000, "expires_ms": ends, "attempt": ["n": 1]]
        case "/v1/signin/client/start":
            let port = asked["port"] as? Int ?? 9
            return ["open": "http://127.0.0.1:\(port)/?code=canned&state=canned", "attempt": ["n": 1], "expires_ms": ends, "listening": false]
        case "/v1/signin/client/finish":
            return (asked["address"] as? String ?? "").contains("code=") ? signedIn : ["refused": "That address holds no code.", "field": "address"]
        default: return nil
        }
    }

    private static let reportUnit = "iphone-17-pro-aa01"

    private static func need(_ id: String, _ weight: String, _ words: String, _ line: String?, acts: [[String: Any]] = [],
                             unit: String? = nil, banner: Bool = false) -> [String: Any] {
        ["id": id, "state": weight == "stopped" ? "broken" : "needs-you", "reason": NSNull(), "words": words, "line": line ?? NSNull(),
         "since_ms": Int64(AppClock.now.addingTimeInterval(-3 * 3600).timeIntervalSince1970 * 1000), "next_ms": NSNull(), "acts": acts, "detail": NSNull(),
         "connector": NSNull(), "copy": NSNull(), "unit": unit ?? NSNull(), "at": NSNull(), "weight": weight, "banner": banner,
         "dismissed": false, "kind": "notice", "about": NSNull()]
    }

    private static func alerts(_ needs: [[String: Any]]) -> [[String: Any]] {
        let full = AppRuntime.asked("--ui-test-home-full")
            ? [need("disk:full", "stopped", "Lifestream's disk is full", "Nothing new is saved", acts: [["do": "storage", "label": "Free up space"]],
                    banner: true)] : []
        guard AppRuntime.asked("--ui-test-alerts") else { return full + needs }
        let whoop = needs.filter { $0["id"] as? String == "password:lifestream-whoop-password" }
        return full + [
            need("room:macbook-air-bb07", "stopped", "MacBook Air's disk is full", "It stopped recording · free space on it", unit: "macbook-air-bb07"),
            need("disk", "advice", "Lifestream's disk fills in about 4 days", "18 GB left on Studio SSD",
                 acts: [["do": "storage", "label": "Free up space"]]),
        ] + whoop + [
            need("loose:home", "advice", "Other accounts can open Lifestream's folder", "Run the fix in Terminal",
                 acts: [["do": "copy", "label": "Copy fix", "text": "chmod 700 \"/Volumes/Studio SSD/lifestream\""]]),
            need("vault:unsaved", "advice", "Recovery key not saved", "Without it, a lost Mac loses your passwords",
                 acts: [["do": "vault", "label": "Save key"]]),
            need("rest:machine", "advice", "This Mac's disk isn't encrypted", "Turn on FileVault"),
        ]
    }

    static func report(unit: String) -> [String: Any] {
        let text = streamsAnswer.flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? "{}"
        let named = rebased(text.replacingOccurrences(of: "\"\(reportUnit)\"", with: "\"\(unit)\""))
        var report = (try? JSONSerialization.jsonObject(with: Data(named.utf8))) as? [String: Any] ?? [:]
        report["day"] = today
        let taken = acted.withLock { $0 }
        let settled = { (act: [String: Any]) in taken.contains(act["need"] as? String ?? "") }
        let dismissed = self.dismissed.withLock { $0 }
        let refreshing = refreshed.withLock { $0 }
        report["needs"] = alerts(report["needs"] as? [[String: Any]] ?? [])
        report["needs"] = (report["needs"] as? [[String: Any]] ?? []).filter { need in
            let id = need["id"] as? String ?? ""
            return !taken.contains(id) && !dismissed.contains(id) && !(need["acts"] as? [[String: Any]] ?? []).contains(where: settled)
        }
        if var badge = report["badge"] as? [String: Any] {
            badge["needs"] = (report["needs"] as? [[String: Any]] ?? []).filter { $0["banner"] as? Bool != true }.count
            badge["asks"] = Agents.open.withLock { $0 }
            report["badge"] = badge
        }
        if proof, let rows = Bundle.main.url(forResource: "proof-report", withExtension: "json")
            .flatMap({ try? Data(contentsOf: $0) }).flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })?["connectors"] as? [[String: Any]] {
            report["connectors"] = (report["connectors"] as? [[String: Any]] ?? []) + rows
        }
        report["connectors"] = (report["connectors"] as? [[String: Any]] ?? []).map { row in
            var row = row["id"] as? String == "notes" ? withoutNotes(row) : row
            if let copies = row["copies"] as? [[String: Any]] {
                row["copies"] = copies.map { copy in
                    guard copy["road"] as? String == "phone", copy["unit"] as? String == unit, let id = copy["id"] as? String else { return copy }
                    return copy.merging(["id": id.replacingOccurrences(of: ":\(reportUnit)", with: ":\(unit)")]) { $1 }
                }
            }
            if proof, row["refresh_now"] is NSNull, row["set_up"] as? Bool == true, row["on"] as? Bool == true,
               !["needs-you", "broken"].contains((row["health"] as? [String: Any])?["state"] as? String ?? ""),
               onlyThisPhoneShips(row, unit: unit) {
                let act: [String: String] = ["do": "refresh", "label": "Check now", "of": row["id"] as? String ?? ""]
                row["refresh_now"] = ["act": act, "blocked": NSNull(), "asked": [Any]()] as [String: Any]
            }
            if refreshing.contains(row["id"] as? String ?? ""), var refresh = row["refresh_now"] as? [String: Any], refresh["blocked"] is NSNull {
                refresh["blocked"] = ["reason": "running", "words": "Refreshing", "until_ms": NSNull()]
                row["refresh_now"] = refresh
            }
            let listed = Set((report["needs"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String })
            row["callout"] = (row["callout"] as? [[String: Any]] ?? []).filter { listed.contains($0["id"] as? String ?? "") }
            guard var health = row["health"] as? [String: Any] else { return row }
            health["acts"] = (health["acts"] as? [[String: Any]] ?? []).filter { !settled($0) }
            return row.merging(["health": health]) { $1 }
        }
        report["rows"] = (report["rows"] as? [[String: Any]] ?? []).map { row in
            guard let act = row["act"] as? [String: Any], settled(act) else { return row }
            return row.merging(["act": NSNull()]) { $1 }
        }
        report["imports"] = (report["imports"] as? [[String: Any]] ?? []).map { kind in
            kind.merging(["held": (kind["held"] as? [[String: Any]] ?? []).filter { held in
                !(held["notice"] is NSNull && taken.contains("import:\(held["id"] as? String ?? ""):refused"))
            }.map { held in
                var held = held
                held["files"] = (held["files"] as? [[String: Any]] ?? []).filter { !($0["acts"] as? [[String: Any]] ?? []).contains(where: settled) }
                if taken.contains("import:\(held["id"] as? String ?? ""):whose") { held["ask"] = NSNull() }
                return held
            }]) { $1 }
        }
        return report
    }

    private static var streamsAnswer: URL? {
        emptyHome ? Bundle.main.url(forResource: "connectors.phone", withExtension: "json", subdirectory: "pages")
            : Bundle.main.url(forResource: "connectors.report", withExtension: "json", subdirectory: "pages/canned")
    }

    static func products() -> [String: Any] {
        let report = Self.report(unit: paired.withLock { $0 })
        var products: [String: Any] = [:]
        for (id, name, row, icon, type) in [
            ("apple-calls", "Calls", "Calls", "call", "calls"), ("apple-notes", "Notes", "Notes", "note", "notes"),
            ("bank", "Bank", "Bank", "money", "money"), ("chrome", "Chrome", "Chrome", "web", "web"),
            ("google-calendar", "Google Calendar", "Calendar", "calendar-event", "plans"),
            ("imessage", "iMessage", "iMessage", "message", "messages"),
            ("now-playing", "Now playing", "Listening", "listening", "listening"),
            ("voice", "Voice notes", "Voice notes", "voice-note", "voice"),
        ] {
            products[id] = ["name": name, "row": row, "vendor": "example", "icon": icon, "type": type, "connector": id]
        }
        for row in report["connectors"] as? [[String: Any]] ?? [] {
            guard let product = row["product"] as? String, let name = row["name"] as? String else { continue }
            products[product] = [
                "name": name, "row": name, "vendor": "example", "icon": row["icon"] as? String ?? "info",
                "type": (row["type"] as? [String: Any])?["key"] ?? NSNull(), "connector": row["id"] ?? product,
            ]
        }
        return ["digest": report["products"] ?? "sha256:canned", "products": products]
    }

    private static func withoutNotes(_ row: [String: Any]) -> [String: Any] {
        var row = row
        row["line"] = "Nothing yet"
        if var figure = row["figure"] as? [String: Any] {
            figure["today"] = 0
            figure["week"] = (figure["week"] as? [Any] ?? []).map { _ in 0 }
            row["figure"] = figure
        }
        row["copies"] = (row["copies"] as? [[String: Any]] ?? []).map { copy in
            copy.merging(["held": 0, "newest_ms": NSNull(), "oldest_ms": NSNull(), "line": "Nothing yet"]) { $1 }
        }
        return row
    }

    private static func rebased(_ text: String) -> String {
        let names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        guard let taken = text.firstMatch(of: /"day": "(\d{4}-\d{2}-\d{2})"/).map({ String($0.1) }) else { return text }
        let moved = Words.daysBetween(taken, today)
        return text.replacing(/· last (Sun|Mon|Tue|Wed|Thu|Fri|Sat)"/) { found in
            let at = names.firstIndex(of: String(found.1)) ?? 0
            return "· last \(names[((at + moved) % 7 + 7) % 7])\""
        }
    }

    static let acted = OSAllocatedUnfairLock(initialState: Set<String>())

    static let dismissed = OSAllocatedUnfairLock(initialState: Set<String>())

    static func offers(key: String?, do act: String?, of source: String?) -> String? {
        let report = report(unit: paired.withLock { $0 })
        let needs = report["needs"] as? [[String: Any]] ?? []
        if act == "dismiss", let key, needs.contains(where: { $0["id"] as? String == key }) {
            dismissed.withLock { _ = $0.insert(key) }
            return "dismissed"
        }
        let held = (report["imports"] as? [[String: Any]] ?? []).flatMap { $0["held"] as? [[String: Any]] ?? [] }
        if act == "choose", let key, held.contains(where: { "import:\($0["id"] as? String ?? ""):whose" == key && $0["ask"] is [String: Any] }) {
            acted.withLock { _ = $0.insert(key) }
            return "chosen"
        }
        let offered = needs.flatMap { $0["acts"] as? [[String: Any]] ?? [] }
            + held.flatMap { $0["files"] as? [[String: Any]] ?? [] }.flatMap { $0["acts"] as? [[String: Any]] ?? [] }
        guard let key, offered.contains(where: { $0["do"] as? String == act && $0["need"] as? String == key && $0["of"] as? String == source }) else {
            return nil
        }
        acted.withLock { _ = $0.insert(key) }
        return "done"
    }

    static let mac = URL(string: "https://lifestream-canned.local:4682")!
    static let macFingerprint = String(repeating: "A", count: 52)
    static let wifi = URL(string: "https://lifestream.localhost:9")!
    static let tailnet = URL(string: "https://100.64.0.42:4682")!

    private struct Finder: HomeFinder {
        func find(within: TimeInterval) async -> [URL] { [CannedHome.mac] }
    }

    static let fixes: @Sendable (Date) async -> [PlaceFix] = { _ in
        let now = AppClock.now
        return (0...40).map { minute in
            PlaceFix(at: now.addingTimeInterval(-90 - Double(minute) * 60), centre: gym, horizontalAccuracyMeters: 12)
        }
    }

    private final class Pass: Credentials, @unchecked Sendable {
        private let lock = NSLock()
        private var data: Data?
        static let paired = Data((#"{"name":"\#(CannedHome.wifi.absoluteString)","pass":"canned-pass","paired":true,"unit":"\#(CannedHome.unit)","#
            + (net == "wifi-only" ? "" : #""addresses":["\#(CannedHome.wifi.absoluteString)","\#(CannedHome.tailnet.absoluteString)"],"#)
            + #""pin":"\#(CannedHome.macFingerprint)"}"#).utf8)

        init(paired: Bool) {
            data = paired ? Self.paired : nil
        }

        func read() throws -> Data? { lock.withLock { data } }
        func write(_ data: Data) throws { lock.withLock { self.data = data } }
        func delete() throws { lock.withLock { data = nil } }
    }


    static let net: String = {
        let arguments = ProcessInfo.processInfo.arguments
        guard let flag = arguments.firstIndex(of: "--ui-test-net"), flag + 1 < arguments.count else { return "silent" }
        return arguments[flag + 1]
    }()

    static let door: URL? = {
        let arguments = ProcessInfo.processInfo.arguments
        guard let flag = arguments.firstIndex(of: "--ui-test-door"), flag + 1 < arguments.count else { return nil }
        return URL(string: arguments[flag + 1])
    }()

    private struct Network: NetworkWatch {
        var facts: NetworkFacts? {
            let trips = tunnel.trips
            return switch net {
            case "offline": NetworkFacts(online: false, onLocalNetwork: false, tunnelUp: false)
            case "tailscale-off", "wifi-only": NetworkFacts(online: true, onLocalNetwork: false, tunnelUp: false)
            case "tailscale-flips": NetworkFacts(online: true, onLocalNetwork: false, tunnelUp: trips != 1, path: trips)
            default: NetworkFacts(online: true, onLocalNetwork: true, tunnelUp: true)
            }
        }

        func changes() -> AsyncStream<NetworkFacts> {
            AsyncStream { continuation in
                if let now = facts { continuation.yield(now) }
                nonisolated(unsafe) let back = NotificationCenter.default.addObserver(
                    forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil) { _ in
                    if let now = facts { continuation.yield(now) }
                }
                continuation.onTermination = { _ in NotificationCenter.default.removeObserver(back) }
            }
        }
    }

    final class Tunnel: @unchecked Sendable {
        private let lock = NSLock()
        private var gone = 0
        private var looksSinceBack = 0
        private var observer: NSObjectProtocol?

        init() {
            observer = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
                                                              object: nil, queue: nil) { [weak self] _ in
                guard let self else { return }
                lock.withLock { gone += 1 }
            }
        }

        var trips: Int { lock.withLock { gone } }

        func looked() -> Bool {
            lock.withLock {
                switch (net, gone) {
                case ("tailscale-flips", 0):
                    return true
                case ("tailscale-flips", 1):
                    return false
                case ("tailscale-flips", _):
                    looksSinceBack += 1
                    return looksSinceBack > 2
                default:
                    return false
                }
            }
        }
    }

    static let tunnel = Tunnel()

    final class Silence: @unchecked Sendable {
        private let lock = NSLock()
        private var quiet = ProcessInfo.processInfo.arguments.contains("--ui-test-home-silent")
        private let heals = ProcessInfo.processInfo.arguments.contains("--ui-test-home-heals")
        private var answers = AppRuntime.asked("--ui-test-home-goes-silent") ? 6 : nil as Int?
        private let silent = ["where", "places"].filter { AppRuntime.asked("--ui-test-\($0)-silent") }.map { "/v1/" + $0 }

        func holds(_ request: HomeRequest) -> Bool {
            if silent.contains(request.url.path) { return true }
            return lock.withLock {
                if let left = answers {
                    if left == 0 { quiet = true } else { answers = left - 1 }
                }
                if quiet, heals, request.method == "GET", request.url.path == "/v1/status" { quiet = false }
                return quiet
            }
        }
    }

    static let silence = Silence()

    final class SearchReady: @unchecked Sendable {
        private let lock = NSLock()
        private let fresh = AppRuntime.asked("--ui-test-search-building")
        private var reads = 0

        func building() -> [String: Any]? {
            lock.withLock {
                guard fresh, reads < 2 else { return nil }
                return ["code": "INDEX_BUILDING", "message": "the search index is being built", "building": ["words"]]
            }
        }

        func readying(counted: Bool) -> Int? {
            lock.withLock {
                guard fresh, reads < 2 else { return nil }
                defer { if counted { reads += 1 } }
                return 40 + 20 * reads
            }
        }

        var pendingToday: Bool { fresh }
    }

    static let searchReady = SearchReady()

    final class NotNow: @unchecked Sendable {
        static let starting = (words: "Lifestream is starting: it answers in a moment.", title: "Lifestream is starting", line: "It answers in a moment.")
        static let preparing = "Your people are being prepared."
        static let held = (title: "Lifestream couldn't finish checking its database.", detail: "The check stopped before it ended.")

        private let lock = NSLock()
        private var startingUp = AppRuntime.asked("--ui-test-home-starting")
        private var holding = AppRuntime.asked("--ui-test-home-held")
        private var preparing = AppRuntime.asked("--ui-test-person-not-now")
        private var observer: NSObjectProtocol?

        init() {
            guard startingUp, AppRuntime.asked("--ui-test-home-starts") else { return }
            observer = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
                                                              object: nil, queue: nil) { [weak self] _ in
                guard let self else { return }
                lock.withLock { startingUp = false }
            }
        }

        func answer(_ request: HomeRequest) -> HomeResponse? {
            lock.withLock {
                if startingUp {
                    return Self.reply(503, ["code": "NOT_NOW", "message": Self.starting.words, "wait": "starting", "title": Self.starting.title,
                                            "line": Self.starting.line, "acts": [Any]()], ["Retry-After": "5"])
                }
                if preparing, request.method == "GET", request.url.path == HomeLink.Pages.Person.route {
                    preparing = false
                    return Self.reply(503, ["code": "NOT_NOW", "message": Self.preparing, "wait": "busy", "title": NSNull(), "line": NSNull(),
                                            "acts": [Any]()], ["Retry-After": "3"])
                }
                guard holding else { return nil }
                if request.method == "POST", request.url.path == "/v1/home/verify" {
                    holding = false
                    return Self.reply(202, ["asked": true])
                }
                return Self.reply(503, ["code": "NOT_NOW", "message": "\(Self.held.title) \(Self.held.detail)", "wait": "needs",
                                        "title": Self.held.title, "line": Self.held.detail,
                                        "acts": [["do": "verify", "label": "Check again"]]])
            }
        }

        private static func reply(_ status: Int, _ object: [String: Any], _ headers: [String: String] = [:]) -> HomeResponse {
            HomeResponse(status: status, headers: headers, body: (try? JSONSerialization.data(withJSONObject: object)) ?? Data())
        }
    }

    static let notNow = NotNow()


    final class Chosen: @unchecked Sendable {
        private struct Route { let value: String; let words: String; let note: String }

        private static let qwen = Route(value: "runner:runner-macbook-pro-0001/qwen3.5-4b", words: "Qwen 3.5",
                                        note: "Stays on MacBook Pro")
        private static let gemini = Route(value: "openrouter:google/gemini-3.8-flash", words: "Gemini 3.8 Flash",
                                          note: "Sent to OpenRouter")
        private static let haiku = Route(value: "claude:claude-haiku-5-5", words: "Claude Haiku 5.5", note: "Sent to Anthropic")
        private static let routes = [qwen, gemini, haiku]

        private let lock = NSLock()
        private var chosen: [String: (route: Route, at: Date, trips: Int)] = [:]
        private var trips = 0
        private var observer: NSObjectProtocol?

        init() {
            observer = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
                                                              object: nil, queue: nil) { [weak self] _ in
                guard let self else { return }
                lock.withLock { trips += 1 }
            }
        }

        var mark: String {
            lock.withLock { "\(chosen.count)-\(chosen.values.filter { $0.trips < trips }.count)" }
        }

        func choose(_ body: Data) -> (Int, [String: Any]) {
            guard let asked = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any], asked["family"] is String,
                  let item = asked["item"] as? String, asked["prompt"] is String, let named = asked["route"] as? String else {
                return (422, ["code": "BAD_PARAMETER", "message": "family, item, prompt and route are needed"])
            }
            guard let route = Self.routes.first(where: { $0.value == named }) else {
                return (422, ["code": "PROCESS_REFUSED", "message": "That model isn't connected."])
            }
            lock.withLock { chosen[item] = (route, AppClock.now, trips) }
            return (200, [:])
        }

        func transcript(of key: String, routine: CannedHome.Routine) -> HomeLink.Made {
            made("voice:" + key, family: "voice", prompt: "transcript", answered: key == "voice-\(routine.trip[2])" ? nil : Self.gemini,
                 none: ("off", "Older than this stream's range"))
        }

        func description(of hash: String) -> [String: Any] {
            let item = "photo:" + hash.dropFirst("sha256:".count)
            let made: HomeLink.Made
            switch CannedHome.scene(of: hash) {
            case .park: made = self.made(item, family: "photos", prompt: "describe", answered: nil,
                                                          none: ("off", "Older than this stream's range"))
            case .dusk: made = self.made(item, family: "photos", prompt: "describe", answered: nil,
                                                         none: ("off", nil))
            case .coffee: made = self.made(item, family: "photos", prompt: "describe", answered: Self.gemini)
            default: made = self.made(item, family: "photos", prompt: "describe", answered: Self.qwen)
            }
            return (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(made))) as? [String: Any] ?? [:]
        }

        func answered(_ hash: String) -> Bool {
            description(of: hash)["by"] is String
        }

        private func made(_ item: String, family: String, prompt: String, answered: Route?,
                          none: (state: String, line: String?) = ("off", nil)) -> HomeLink.Made {
            let ask = HomeLink.Made.Ask(family: family, item: item, prompt: prompt)
            let step = { (route: Route) in HomeLink.Connector.Member.Step(value: route.value, words: route.words, note: route.note) }
            let now = AppClock.now
            var by = answered
            var at = by.map { _ in now.addingTimeInterval(-86_400 * 2) }
            let ms = { (at: Date?) in at.map { Int64($0.timeIntervalSince1970 * 1000) } }
            let (choice, trips) = lock.withLock { (chosen[item], self.trips) }
            if let choice {
                guard choice.trips < trips else {
                    return .init(by: by?.words, atMs: ms(at), state: .waiting, line: "In the queue", ask: ask, choose: [])
                }
                (by, at) = (choice.route, choice.at)
            }
            guard let by, let at else {
                return .init(by: nil, atMs: nil, state: HomeLink.Made.State(rawValue: none.state) ?? .off, line: none.line, ask: ask,
                             choose: [step(Self.gemini)])
            }
            return .init(by: by.words, atMs: ms(at), state: .done, line: "\(by.words) · \(Self.date.string(from: at))", ask: ask,
                         choose: Self.routes.filter { $0.value != by.value }.map(step))
        }

        private static let date: DateFormatter = {
            let format = DateFormatter()
            format.locale = Locale(identifier: "en_GB")
            format.setLocalizedDateFormatFromTemplate("dMMM")
            return format
        }()
    }

    static let chosen = Chosen()



    private struct Transport: HomeTransport {
        let reader: (any HomeTransport)?

        func identify(_ address: URL, within: TimeInterval) async throws -> String {
            await Asks.shared.knocked()
            guard address == CannedHome.mac || address == CannedHome.wifi || (address == CannedHome.tailnet && tunnel.looked()) else {
                throw URLError(.cannotConnectToHost)
            }
            return CannedHome.macFingerprint
        }

        func perform(_ request: HomeRequest) async throws -> HomeResponse {
            await Asks.shared.knocked()
            if let reader, request.method == "GET" { return try await reader.perform(request) }
            if silence.holds(request) { throw URLError(.cannotConnectToHost) }
            if let said = notNow.answer(request) { return said }
            if request.url.path.hasPrefix("/v1/ask") || request.url.path.hasPrefix("/v1/privacy") { return await CannedAsk.shared.perform(request) }
            if request.url.path.hasPrefix("/v1/feedback/") {
                let rows = Home(now: AppClock.now).connectors()["connectors"] as? [[String: Any]] ?? []
                let names = Dictionary(rows.compactMap { row in (row["id"] as? String).map { ($0, row["name"] as? String ?? $0) } }) { first, _ in first }
                return await CannedFeedback.shared.perform(request, names: names)
            }
            if request.method == "POST", request.url.path == "/v1/pair" { return pair(request) }
            if request.method == "POST", request.url.path == "/v1/act" {
                guard case .json(let body) = request.body,
                      let asked = (try? JSONSerialization.jsonObject(with: body)) as? [String: String],
                      let acted = CannedHome.offers(key: asked["need"], do: asked["do"], of: asked["of"]) else {
                    return reply(409, ["code": "NOT_OFFERED", "message": "the home offers no such act now"])
                }
                return reply(200, ["acted": acted])
            }
            if request.method == "POST", request.url.path == "/v1/owner/act", case .json(let body) = request.body,
               let asked = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any], asked["of"] as? String == "places" {
                #if DEBUG
                let line = String(decoding: body, as: UTF8.self)
                await MainActor.run { Stated.shared.record(line) }
                #endif
                let now = AppClock.now
                let (status, answer) = CannedHome.placeActs.act(asked, list: Home(now: now).places(), now: now)
                if status == 200, let id = answer["id"] as? String, id.hasPrefix("place:") {
                    let slug = String(id.dropFirst("place:".count))
                    let placed = (Home(now: now).places()["places"] as? [[String: Any]])?.first { $0["slug"] as? String == slug }
                    if let placed, let content = PlaceActs.content(placed) { namings.record(content, slug: slug) }
                }
                return reply(status, answer)
            }
            if request.method == "POST", request.url.path == "/v1/owner/act", case .json(let body) = request.body {
                let home = Home(now: AppClock.now)
                let (status, answer) = await PeopleEdits.shared.act(body) { home.person($0) }
                if await PeopleEdits.shared.loses(body) { throw URLError(.networkConnectionLost) }
                return HomeResponse(status: status, body: answer)
            }
            if request.method == "POST", request.url.path == "/v1/process", case .json(let body) = request.body {
                let (status, answer) = chosen.choose(body)
                return reply(status, answer)
            }
            if request.method == "POST", request.url.path == "/v1/settings", case .json(let body) = request.body,
               let asked = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any], asked["connector"] as? String == "ask",
               asked["member"] as? String == "llm.voice", let value = asked["value"] as? String {
                let taken = await CannedAsk.shared.choose(voice: value, was: asked["was"] as? String)
                return taken ? reply(200, ["value": value]) : reply(409, ["code": "CHANGED", "value": "default"])
            }
            if request.method == "POST", request.url.path == "/v1/settings", case .json(let body) = request.body,
               ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any])?["connector"] == nil {
                let (status, answer) = homeSettings.set(body)
                return reply(status, answer)
            }
            if request.method == "POST", request.url.path == "/v1/settings", case .json(let body) = request.body {
                let (status, answer) = settings.set(body)
                await Settings.Probe.shared.show(settings.said)
                return reply(status, answer)
            }
            if request.method == "POST", request.url.path == "/v1/refresh", case .json(let body) = request.body, CannedHome.refusesRefresh(body) {
                return reply(409, ["code": "NOT_OFFERED", "message": "nothing of it refreshes from here"])
            }
            if request.method == "PUT", request.url.path.hasPrefix("/v1/bundles/"), case .file(let file) = request.body {
                guard CannedHome.bundles.take(file) else { return reply(422, ["code": "IOS_BUNDLE_BAD_MANIFEST", "message": "no manifest reads"]) }
                await Bundles.Probe.shared.show(CannedHome.bundles.said)
                return reply(201, CannedHome.answer)
            }
            if request.method == "POST", case .json(let body) = request.body, let answer = CannedHome.connecting(request.url.path, body) {
                return reply(200, answer)
            }
            if request.method == "POST", request.url.path.hasPrefix("/v1/connectors/"), case .json(let body) = request.body {
                let id = request.url.lastPathComponent
                let home = CannedScale.factor == nil ? Home(now: AppClock.now) : Self.scaled
                let (status, refused) = streams.change(id, body, rows: home.connectors()["connectors"] as? [[String: Any]] ?? [])
                if let refused { return reply(status, refused) }
                return reply(200, [:])
            }
            if request.method == "POST", request.url.path == "/v1/exchange" {
                await Asks.shared.count(request.url.path, Asked(request.url), tagged: false)
                var answer = CannedHome.answer
                if case .json(let body) = request.body { answer["settings"] = settings.exchange(body) }
                await Settings.Probe.shared.show(settings.said)
                return reply(200, answer)
            }
            if request.url.path == "/v1/agents" || request.url.path.hasPrefix("/v1/agents/"),
               case let (status, answer)? = await Agents.shared.route(request) {
                return HomeResponse(status: status, body: answer)
            }
            guard request.method == "GET" else {
                return reply(503, ["code": "HOME_STOPPED", "message": "the canned home takes no edit"], ["Retry-After": "60"])
            }
            let home = CannedScale.factor == nil ? Home(now: AppClock.now) : Self.scaled
            let asked = Asked(request.url)
            let path = request.url.path
            let tag = request.headers["If-None-Match"]
            await Asks.shared.count(path, asked, tagged: tag != nil)
            switch path {
            case "/v1/places":
                guard let slug = asked.one("slug") else { return answer("places", home, tag) { home.places() } }
                return home.place(slug).map { tagged(["position": "0:1", "place": $0], tag) } ?? missing("PLACE_UNKNOWN")
            case "/v1/places/suggest":
                if CannedHome.suggesterAway { throw URLError(.notConnectedToInternet) }
                return home.suggest(spot: asked.one("spot"), q: asked.one("q")).map { reply(200, $0) } ?? missing("SPOT_UNKNOWN")
            case "/v1/places/photos":
                return asked.one("slug").flatMap { home.placePhotos($0, after: asked.one("after")) }.map { tagged($0, tag) }
                    ?? missing("PLACE_UNKNOWN")
            case "/v1/clock":
                await LateClock.shared.held()
                return reply(200, CannedHome.clockAnswer(at: home.now))
            case "/v1/days": return reply(200, home.dayList(asked))
            case "/v1/extracts": return home.extracts(asked).map { reply(200, $0) } ?? missing("EXTRACT_UNKNOWN")
            case "/v1/conversation": return home.conversation(asked).map { reply(200, $0) } ?? missing("DAY_UNKNOWN")
            case "/v1/where":
                return tagged(Self.named(where: home.where(asked), namings.now), tag)
            case "/v1/labels": return reply(200, Self.named(labels: home.labels(asked), namings.now))
            case "/v1/search":
                if let building = CannedHome.searchReady.building() { return reply(503, building, ["Retry-After": "5"]) }
                return reply(200, home.search(asked))
            case HomeLink.Pages.Search.route:
                return tagged(home.searchPage(asked, readying: CannedHome.searchReady.readying(counted: true)), tag)
            case HomeLink.Pages.SearchKind.route:
                return tagged(home.searchKindPage(asked, readying: asked.one("see") == nil ? nil : CannedHome.searchReady.readying(counted: false)), tag)
            case "/v1/describe": return reply(200, home.describe(asked.all("ref")))
            case "/v1/count":
                guard asked.all("by").count <= 2 else { return reply(422, ["code": "BAD_PARAMETER", "message": "by is one or two keys, each once"]) }
                return reply(200, home.count(asked))
            case "/v1/people":
                let edits = await PeopleEdits.shared.held
                let now = AppClock.now
                let list = answer("people", home, nil) { edits.over(home.people(), now: now) }
                return HomeResponse(status: 200, headers: ["Lifestream-Position": edits.position(now)], body: list.body)
            case "/v1/people/photos":
                return asked.one("id").flatMap { home.personPhotos($0, after: asked.one("after")) }.map { tagged($0, tag) }
                    ?? missing("PERSON_UNKNOWN")
            case HomeLink.Pages.People.route:
                let edits = await PeopleEdits.shared.held
                return CannedPages.people(edits, now: AppClock.now).map { tagged($0, tag) } ?? missing("PAGE_UNKNOWN")
            case HomeLink.Pages.Person.route:
                let edits = await PeopleEdits.shared.held
                return asked.one("id").flatMap { CannedPages.person($0, edits, now: AppClock.now) }.map { tagged($0, tag) }
                    ?? missing("PERSON_UNKNOWN")
            case HomeLink.Pages.Group.route:
                let edits = await PeopleEdits.shared.held
                return asked.one("chat").flatMap { CannedPages.group($0, word: edits.word(of: $0, now: AppClock.now)) }.map { tagged($0, tag) }
                    ?? missing("CHAT_UNKNOWN")
            case HomeLink.Pages.PeopleFind.route:
                return asked.one("q").flatMap(CannedPages.find).map { tagged($0, tag) } ?? missing("PAGE_UNKNOWN")
            case HomeLink.Pages.Places.route:
                return CannedPages.places(CannedHome.placeActs.listed).map { tagged($0, tag) } ?? missing("PAGE_UNKNOWN")
            case HomeLink.Pages.Place.route:
                return asked.one("slug").flatMap { CannedPages.place(CannedHome.placeActs.placed($0)) }.map { tagged($0, tag) } ?? missing("PLACE_UNKNOWN")
            case HomeLink.Pages.PlaceEdit.route:
                return CannedPages.placeEdit(slug: asked.one("slug"), spot: asked.one("spot")).map { tagged($0, tag) } ?? missing("PLACE_UNKNOWN")
            case HomeLink.Pages.Year.route:
                return asked.one("year").flatMap(CannedPages.year).map { tagged($0, tag) } ?? missing("YEAR_UNKNOWN")
            case HomeLink.Pages.Days.route:
                guard asked.one("after") == nil else { return missing("PAGE_UNKNOWN") }
                return CannedPages.days().map { tagged($0, tag) } ?? missing("PAGE_UNKNOWN")
            case HomeLink.Pages.Day.route:
                await LateClock.shared.asked(day: asked.one("day"), today: CannedHome.today)
                return asked.one("day").flatMap { CannedPages.day($0, named: !namings.rendered($0).isEmpty) }.map { tagged($0, tag) }
                    ?? missing("DAY_UNKNOWN")
            case HomeLink.Pages.Moment.route:
                guard let day = asked.one("day"), let focus = asked.one("focus") else { return missing("PAGE_UNKNOWN") }
                return CannedPages.moment(day, focus: focus).map { tagged($0, tag) } ?? missing("PAGE_UNKNOWN")
            case HomeLink.Pages.Thread.route:
                guard let chat = asked.one("chat"), let day = asked.one("day") else { return missing("PAGE_UNKNOWN") }
                return CannedPages.thread(chat, day: day).map { tagged($0, tag) } ?? missing("CHAT_UNKNOWN")
            case HomeLink.Pages.Settings.route:
                return CannedPages.settings().map { tagged($0, tag) } ?? missing("PAGE_UNKNOWN")
            case HomeLink.Pages.SettingsPage.route:
                return asked.one("id").flatMap(CannedPages.settingsPage).map { tagged(CannedHome.homeSettings.page($0), tag) } ?? missing("NOT_FOUND")
            case HomeLink.Pages.Storage.route:
                return CannedPages.storage().map { tagged($0, tag) } ?? missing("PAGE_UNKNOWN")
            case HomeLink.Pages.ModelsFind.route:
                return CannedPages.modelsFind().map { tagged($0, tag) } ?? missing("PAGE_UNKNOWN")
            case HomeLink.Pages.Feedback.route:
                return CannedFeedback.page().map { tagged($0, tag) } ?? missing("PAGE_UNKNOWN")
            case "/v1/connectors":
                guard settings.reads else { return reply(503, ["code": "HOME_STOPPED", "message": "the canned home is not running"]) }
                return reply(200, home.connectors())
            case "/v1/status": return reply(200, home.status())
            case "/v1/products": return reply(200, CannedHome.products())
            case "/v1/sources": return reply(200, home.readThroughs())
            case "/v1/pictures": return reply(200, ["recipe": CannedHome.recipe])
            case "/v1/record": return reply(200, home.record(asked))
            case "/v1/photos/wanted": return reply(200, ["photos": [String](), "left": ["wanted": 0, "unavailable": 0, "bytes": 0]])
            default: break
            }
            if path.hasPrefix("/v1/days/") {
                guard var file = home.file(String(path.dropFirst("/v1/days/".count))) else { return missing("DAY_UNKNOWN") }
                file = Self.named(file, namings.shown(file.day))
                let etag = "\"\(file.inputs)\""
                if tag == etag { return HomeResponse(status: 304, headers: ["ETag": etag], body: Data()) }
                if CannedScale.factor != nil, file.day == home.days.last?.day { file = CannedScale.padded(file) }
                return HomeResponse(status: 200, headers: ["ETag": etag], body: (try? JSONEncoder().encode(file)) ?? Data())
            }
            if path.hasPrefix("/v1/photos/") {
                return home.photo(String(path.dropFirst("/v1/photos/".count))).map { reply(200, ["position": "0:1", "photo": $0]) }
                    ?? missing("PHOTO_UNKNOWN")
            }
            if path.hasPrefix("/v1/pictures/") {
                let hash = String(path.dropFirst("/v1/pictures/".count))
                guard let size = asked.one("size"), ["tile", "screen", "full"].contains(size) else {
                    return reply(422, ["code": "BAD_PARAMETER", "message": "size is tile, screen or full"])
                }
                guard let picture = await Self.picture(hash) else { return missing("BLOB_UNKNOWN") }
                Self.pictured.withLock { _ = $0.insert(hash) }
                let type = picture.starts(with: [0xFF, 0xD8, 0xFF]) ? "image/jpeg" : "image/png"
                guard asked.one("recipe") == String(CannedHome.recipe) else {
                    return HomeResponse(status: 200, headers: ["Content-Type": type, "Cache-Control": "no-store"], body: picture)
                }
                let etag = "\"\(hash.dropFirst("sha256:".count))-\(size)-\(CannedHome.recipe)\""
                if tag == etag { return HomeResponse(status: 304, headers: ["ETag": etag], body: Data()) }
                return HomeResponse(status: 200, headers: ["Content-Type": type, "ETag": etag, "Cache-Control": "private, max-age=86400"],
                                    body: picture)
            }
            if path.hasPrefix("/v1/blobs/") {
                let hash = String(path.dropFirst("/v1/blobs/".count))
                if let audio = await CannedAsk.shared.audio(hash) { return HomeResponse(status: 200, body: audio) }
                if let movie = CannedHome.movie(hash) ?? CannedPages.movies[hash] { return Self.blob(movie, range: request.headers["Range"]) }
                guard let picture = await Self.picture(hash), Self.pictured.withLock({ $0.contains(hash) }) else { return missing("BLOB_UNKNOWN") }
                return Self.blob(picture, range: request.headers["Range"])
            }
            return missing("ROUTE")
        }

        private static func named(_ file: HomeLink.DayFile, _ names: [Namings.Named]) -> HomeLink.DayFile {
            guard !names.isEmpty else { return file }
            let atoms = file.atoms.map { atom in
                HomeLink.DayFile.Atom(n: atom.n, family: atom.family, unit: atom.unit, startMs: atom.startMs, endMs: atom.endMs,
                                      localStart: atom.localStart, localEnd: atom.localEnd, flags: atom.flags,
                                      text: names.reduce(atom.text) { $0.replacingOccurrences(of: $1.words, with: $1.name) },
                                      record: atom.record, item: atom.item, block: atom.block, video: atom.video)
            }
            return HomeLink.DayFile(day: file.day, window: file.window,
                                    renderer: file.renderer, inputs: file.inputs + "-named-\(names.count)", counts: file.counts,
                                    coverage: file.coverage, atoms: atoms)
        }

        private static func named(where answer: [String: Any], _ names: [Namings.Named]) -> [String: Any] {
            guard !names.isEmpty, let pieces = answer["pieces"] as? [[String: Any]] else { return answer }
            return answer.merging(["pieces": pieces.map { piece in
                var piece = piece
                var ends = piece["names"] as? [String: Any] ?? [:]
                for (end, value) in ends {
                    guard var said = value as? [String: Any], let named = names.first(where: { $0.words == said["words"] as? String }) else { continue }
                    said["words"] = named.name
                    ends[end] = said
                    if end == "point" { piece["spot"] = NSNull() }
                }
                piece["names"] = ends
                return piece
            }]) { $1 }
        }

        private static func named(labels answer: [String: Any], _ names: [Namings.Named]) -> [String: Any] {
            guard !names.isEmpty, let places = answer["places"] as? [[Any]] else { return answer }
            return answer.merging(["places": places.map { label -> [Any] in
                guard label.count == 5, let shown = label[4] as? String, let named = names.first(where: { $0.words == shown }) else { return label }
                return [label[0], label[1], named.slug, named.name, named.name]
            }]) { $1 }
        }

        private static func blob(_ bytes: Data, range words: String?) -> HomeResponse {
            let headers = ["Content-Type": "application/octet-stream", "Accept-Ranges": "bytes"]
            guard let words, words.hasPrefix("bytes=") else { return HomeResponse(status: 200, headers: headers, body: bytes) }
            let ends = words.dropFirst("bytes=".count).split(separator: "-", omittingEmptySubsequences: false)
            guard ends.count == 2, let start = Int(ends[0]) else { return HomeResponse(status: 200, headers: headers, body: bytes) }
            let last = ends[1].isEmpty ? bytes.count - 1 : min(Int(ends[1]) ?? bytes.count - 1, bytes.count - 1)
            guard start < bytes.count, start <= last else {
                return HomeResponse(status: 416, headers: headers.merging(["Content-Range": "bytes */\(bytes.count)"]) { $1 }, body: Data())
            }
            return HomeResponse(status: 206, headers: headers.merging(["Content-Range": "bytes \(start)-\(last)/\(bytes.count)"]) { $1 },
                                body: bytes.subdata(in: start..<last + 1))
        }

        private static func picture(_ hash: String) async -> Data? {
            if hash == photoHash { return photo }
            if hash == video.hash || CannedPages.movies[hash] != nil { return poster }
            if let portrait = portraits[hash] { return portrait }
            if let card = CannedPages.pictures[hash] { return card }
            if let held = await PeopleEdits.shared.held.blobs[hash] { return held }
            if let staged = await CannedAsk.shared.picture(hash) { return staged }
            return CannedHome.picture(of: hash) ?? theirPhotos.first { $0.hash == hash }?.jpeg
        }

        private static let pictured = OSAllocatedUnfairLock<Set<String>>(initialState: [])

        func stream(_ request: HomeRequest) async throws -> HomeStream {
            let path = request.url.path
            if (path == "/v1/ask" && request.method == "POST") || (path.hasPrefix("/v1/ask/chats/") && path.hasSuffix("/events")) {
                await Asks.shared.knocked()
                if silence.holds(request) { throw URLError(.cannotConnectToHost) }
                return await CannedAsk.shared.stream(request)
            }
            let response = try await perform(request)
            return HomeStream(status: response.status, headers: response.headers, lines: HomeStream.lines(of: response.body))
        }

        private static let scaled = Home(now: AppClock.now)

        private func answer(_ route: String, _ home: Home, _ tag: String?, _ make: () -> [String: Any]) -> HomeResponse {
            let body = CannedScale.factor == nil ? Self.data(make()) : CannedScale.mapped(route, day: home.civilDay(home.now)) { make() }
            return route == "places" ? tagged(body, tag) : HomeResponse(status: 200, body: body)
        }

        private func pair(_ request: HomeRequest) -> HomeResponse {
            guard case .json(let body) = request.body, let asked = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else {
                return reply(422, ["code": "PAIR_REQUEST", "message": "a pairing states its code and pass"])
            }
            guard asked["code"] as? String == CannedHome.code else {
                return reply(403, ["code": "PAIR_CODE", "message": "the code is unknown, used or expired"])
            }
            let unit: String
            if let continued = asked["unit"] as? String {
                guard continued == CannedHome.unit else {
                    return reply(409, ["code": "PAIR_UNIT_UNKNOWN", "message": "the home holds no phone \(continued)"])
                }
                unit = continued
            } else if asked["new"] as? Bool == true {
                unit = CannedHome.another
            } else {
                let phone: [String: Any] = ["unit": CannedHome.unit, "model": "iPhone 17 Pro", "last_ms": AppClock.now.timeIntervalSince1970 * 1000 - 3_600_000]
                return reply(409, ["code": "PAIR_WHICH_PHONE", "message": "the home holds a phone already", "phones": [phone]])
            }
            CannedHome.paired.withLock { $0 = unit }
            return reply(200, ["unit": unit, "answer": CannedHome.answer(as: unit)])
        }

        private func reply(_ status: Int, _ object: [String: Any], _ headers: [String: String] = [:]) -> HomeResponse {
            HomeResponse(status: status, headers: headers, body: Self.data(object))
        }

        private func tagged(_ object: [String: Any], _ tag: String?) -> HomeResponse {
            tagged(Self.data(object), tag)
        }

        private func tagged(_ body: Data, _ tag: String?) -> HomeResponse {
            let etag = "\"" + SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined() + "\""
            if tag == etag { return HomeResponse(status: 304, headers: ["ETag": etag], body: Data()) }
            return HomeResponse(status: 200, headers: ["ETag": etag], body: body)
        }

        private static func data(_ object: [String: Any]) -> Data {
            (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
        }

        private func missing(_ code: String) -> HomeResponse {
            reply(404, ["code": code, "message": "the canned home holds none"])
        }
    }

    @MainActor final class Agents: ObservableObject {
        static let shared = Agents()

        private static let numbers = ["agent-claude": 64, "agent-hermes": 12, "agent-atlas": 49]
        private nonisolated static let signIns = "claude-hermes-atlas"
        private static let guideSignIn = "--ui-test-guide-sign-in"
        private static let guided = "agent-claude"
        private nonisolated static let asked = "ask-instinct-ask-claude-ask-hermes-ask-chatgpt"
        nonisolated static let open = OSAllocatedUnfairLock(initialState: opening("--ui-test-agent-asks", asked, "asks").count)

        private var requests: [[String: Any]]
        private var asks: [[String: Any]] {
            didSet {
                let count = asks.count
                Self.open.withLock { $0 = count }
            }
        }
        private var ended: [String: [String: Any]] = [:]
        private var recorded: [String: (Int, Data)] = [:]
        private var gone: Set<String> = []
        private var unlisted: Set<String> = []
        @Published private(set) var answered: [String] = []
        private var addressOn = false
        private var approved: Set<String> = []
        private var away: NSObjectProtocol?

        private init() {
            requests = Self.opening("--ui-test-agent-requests", Self.signIns, "requests")
            asks = Self.opening("--ui-test-agent-asks", Self.asked, "asks")
            away = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil,
                                                          queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.requests.removeAll { $0["id"] as? String == "agent-atlas" } }
            }
        }

        private nonisolated static func opening(_ flag: String, _ held: String, _ part: String) -> [[String: Any]] {
            guard ProcessInfo.processInfo.arguments.contains(flag) else { return [] }
            return (waiting(held).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?[part] as? [[String: Any]]) ?? []
        }

        private nonisolated static func waiting(_ held: String) -> Data? {
            Bundle.main.url(forResource: "agentsWaiting." + held, withExtension: "json", subdirectory: "pages/canned").flatMap { try? Data(contentsOf: $0) }
        }

        private var held: String {
            let named = requests.compactMap { ($0["name"] as? String)?.lowercased() } + asks.compactMap { ($0["name"] as? String).map { "ask-" + $0.lowercased() } }
            return named.isEmpty ? "none" : named.joined(separator: "-")
        }

        nonisolated static func contract(_ name: String, in folder: String = "agents/door") -> [String: Any] {
            let file = Bundle.main.url(forResource: name, withExtension: "json", subdirectory: folder)
            return file.flatMap { try? Data(contentsOf: $0) }.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        }

        nonisolated static func decoded<Value: Decodable>(_ type: Value.Type, _ name: String) -> Value? {
            (contract(name)["answer"]).flatMap { try? JSONSerialization.data(withJSONObject: $0) }
                .flatMap { try? JSONDecoder().decode(type, from: $0) }
        }

        nonisolated static func asks(now: Int64) -> [[String: Any]] {
            ((contract("waiting")["answer"] as? [String: Any])?["asks"] as? [[String: Any]] ?? []).map { ask in
                var ask = ask
                ask["at_ms"] = now - 60_000
                ask["until_ms"] = now + 86_400_000
                return ask
            }
        }

        func route(_ request: HomeRequest) -> (Int, Data)? {
            let path = request.url.path
            let body: Data? = if case .json(let body) = request.body { body } else { nil }
            switch (request.method, path) {
            case ("GET", HomeLink.Pages.AgentGuides.route):
                return Self.guides().map { (200, $0) }
            case ("GET", "/v1/agents/address"):
                return Self.guide(addressOn ? "address-on" : "address-off")
            case ("POST", "/v1/agents/address"):
                guard body.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })?["on"] as? Bool == true else {
                    return Self.guide("address-bad")
                }
                addressOn = true
                answered.append("address on")
                arrive()
                return Self.guide("address-on")
            case ("POST", "/v1/agents/keys"):
                let app = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["app"] as? String
                guard app == HomeLink.KeyApp.instinct.rawValue else { return Self.guide("keys-phone-refused") }
                guard addressOn else { return Self.guide("keys-not-ready") }
                answered.append("instinct key")
                return Self.guide("keys-instinct")
            case ("GET", "/v1/agents/waiting"):
                let held = self.held
                return (Self.waiting(held) ?? waitingFromAll()).map { (200, $0) }
                    ?? (404, Self.bytes(["message": "the canned home holds no waiting answer agentsWaiting.\(held): its e2e case writes one"]))
            case ("POST", "/v1/agents/answer"):
                return body.flatMap { try? JSONDecoder().decode(HomeLink.AnswerRequest.self, from: $0) }.map(answer)
            case ("POST", "/v1/agents/edit"):
                return body.flatMap { try? JSONDecoder().decode(HomeLink.EditRequest.self, from: $0) }.map(edit)
            case ("GET", _) where path.hasPrefix("/v1/agents/signins/"):
                let id = String(path.dropFirst("/v1/agents/signins/".count))
                if approved.contains(id) { return Self.signIn(id, "signin-connected", in: "agents/guide-door") }
                guard requests.contains(where: { $0["id"] as? String == id }) else { return Self.signIn(id, "signin-over") }
                return (200, Self.bytes(["id": id, "state": "waiting", "outcome": NSNull(), "reader": NSNull(), "connected": NSNull()]))
            case ("GET", _) where path.hasPrefix("/v1/agents/asks/"):
                let id = String(path.dropFirst("/v1/agents/asks/".count))
                if let ask = asks.first(where: { $0["id"] as? String == id }) ?? ended[id] { return (200, Self.bytes(ask)) }
                return Self.file("ask-unknown")
            case ("POST", _) where path.hasSuffix("/access"):
                answered.append(String(path.dropFirst("/v1/agents/".count).dropLast("/access".count)) + " set")
                return Self.file("access-widened")
            case ("POST", _) where path.hasSuffix("/disconnect"):
                let id = String(path.dropFirst("/v1/agents/".count).dropLast("/disconnect".count))
                guard rows.contains(where: { $0["id"] as? String == id }), !gone.contains(id) else { return Self.file("access-unknown") }
                gone.insert(id)
                answered.append(id + " disconnected")
                return reader(id)
            case ("POST", _) where path.hasSuffix("/unlist"):
                let id = String(path.dropFirst("/v1/agents/".count).dropLast("/unlist".count))
                guard rows.contains(where: { $0["id"] as? String == id }) else { return Self.file("access-unknown") }
                guard gone.contains(id) else { return Self.file("unlist-connected") }
                unlisted.insert(id)
                answered.append(id + " unlisted")
                return (200, Self.bytes(list))
            case ("GET", "/v1/agents"):
                return (200, Self.bytes(list))
            case ("GET", _) where path.hasSuffix("/history"):
                let query = request.url.query ?? ""
                return Self.file(query.contains("before=") ? "history-earlier" : query.contains("kind=") ? "history-kind" : "history")
            case ("GET", _) where path.hasSuffix("/things"):
                return Self.file("things")
            case ("GET", _) where path.contains("/reads/"):
                return Self.file("read")
            case ("GET", _):
                return reader(String(path.dropFirst("/v1/agents/".count)))
            default:
                return nil
            }
        }

        private var list: [String: Any] {
            ["readers": rows]
        }

        private var rows: [[String: Any]] {
            let listed = (Self.contract("list")["answer"] as? [String: Any])?["readers"] as? [[String: Any]] ?? []
            let away = Self.contract("disconnect")["answer"] as? [String: Any] ?? [:]
            return listed.filter { !unlisted.contains($0["id"] as? String ?? "") }.map { row in
                guard gone.contains(row["id"] as? String ?? "") else { return row }
                var row = row
                row["state"] = "disconnected"
                row["summary"] = away["disconnected"]
                row["has_ask"] = false
                return row
            }
        }

        private func reader(_ id: String) -> (Int, Data) {
            guard let row = rows.first(where: { $0["id"] as? String == id }) else { return Self.file("access-unknown") }
            let named = gone.contains(id) ? "disconnect" : ["reader-ask", "reader-agent", "reader-no-access", "reader-overlapping", "reader-chat",
                                                             "reader-reads"].first { name in
                (Self.contract(name)["answer"] as? [String: Any])?["name"] as? String == row["name"] as? String
            } ?? "reader-agent"
            var read = Self.contract(named)["answer"] as? [String: Any] ?? [:]
            let was = read["name"] as? String ?? ""
            read["id"] = id
            read["name"] = row["name"]
            read["kind"] = row["kind"]
            read["reads"] = row["reads"]
            read["mark"] = row["mark"]
            if var disconnect = read["disconnect"] as? [String: Any], let name = row["name"] as? String, !was.isEmpty {
                for part in ["stops", "stays"] {
                    guard let rows = disconnect[part] as? [[String: Any]] else { continue }
                    disconnect[part] = rows.map { row in row.mapValues { ($0 as? String)?.replacingOccurrences(of: was, with: name) ?? $0 } }
                }
                read["disconnect"] = disconnect
            }
            if var ask = read["ask"] as? [String: Any] {
                ask["reader"] = id
                read["ask"] = ask
            }
            return (200, Self.bytes(read))
        }

        private static func file(_ name: String, in folder: String = "agents/door") -> (Int, Data) {
            let contract = contract(name, in: folder)
            return (contract["status"] as? Int ?? 500, bytes(contract["answer"] as? [String: Any] ?? [:]))
        }

        private static func guide(_ name: String) -> (Int, Data) { file(name, in: "agents/guide-door") }

        private static func guides() -> Data? {
            let file = Bundle.main.url(forResource: "agentGuides.phone", withExtension: "json", subdirectory: "pages")
            guard var page = file.flatMap({ try? Data(contentsOf: $0) }).flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }),
                  let apps = page["apps"] as? [[String: Any]] else { return nil }
            page["apps"] = apps.map { app in app.merging(["connected": NSNull()]) { $1 } }
            return bytes(page)
        }

        private static func signIn(_ id: String, _ name: String, in folder: String = "agents/door") -> (Int, Data) {
            let contract = contract(name, in: folder)
            let answer = (contract["answer"] as? [String: Any] ?? [:]).merging(["id": id]) { $1 }
            return (contract["status"] as? Int ?? 500, bytes(answer))
        }

        private func arrive() {
            guard ProcessInfo.processInfo.arguments.contains(Self.guideSignIn), !answered.contains(where: { $0.hasPrefix(Self.guided + " ") }),
                  !requests.contains(where: { $0["id"] as? String == Self.guided }),
                  let signIn = Self.everySignIn().first(where: { $0["id"] as? String == Self.guided }) else { return }
            requests.append(signIn)
        }

        private func waitingFromAll() -> Data? {
            guard asks.isEmpty, let every = Self.waiting(Self.signIns),
                  var page = (try? JSONSerialization.jsonObject(with: every)) as? [String: Any] else { return nil }
            let held = Set(requests.compactMap { $0["id"] as? String })
            page["requests"] = Self.everySignIn().filter { held.contains($0["id"] as? String ?? "") }
            return Self.bytes(page)
        }

        private static func everySignIn() -> [[String: Any]] {
            (waiting(signIns).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["requests"] as? [[String: Any]]) ?? []
        }

        private static func bytes(_ object: [String: Any]) -> Data {
            (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
        }

        private func answer(_ said: HomeLink.AnswerRequest) -> (Int, Data) {
            let id = said.id
            if let reply = recorded[id] { return reply }
            let carried: String = switch said {
            case .number(_, _, .some), .allow(_, _, _, .some): " +access"
            default: ""
            }
            switch said {
            case .number, .deny:
                guard let index = requests.firstIndex(where: { $0["id"] as? String == id }) else { return Self.file("answer-unknown") }
                let reply: (Int, Data)
                let word: String
                if case .number(_, let number, _) = said {
                    let right = number == Self.numbers[id]
                    if right { approved.insert(id) }
                    reply = Self.file(right ? "answer-sign-in" : "answer-sign-in-wrong")
                    word = "\(number) " + (right ? "approved" : "wrong")
                } else {
                    reply = Self.file("answer-sign-in-deny")
                    word = "deny denied"
                }
                requests.remove(at: index)
                recorded[id] = reply
                answered.append("\(id) \(word)\(carried)")
                return reply
            case .allow, .no:
                guard let index = asks.firstIndex(where: { $0["id"] as? String == id }) else { return Self.file("answer-unknown") }
                let name: String
                let word: String
                if case .allow(_, let grant, let expect, let access) = said {
                    guard expect == asks[index]["version"] as? Int else { return Self.file("answer-stale") }
                    name = access == nil ? (grant == .once ? "answer-once" : "answer-always") : "answer-edited"
                    word = grant.rawValue
                } else {
                    name = "answer-no"
                    word = "no"
                }
                let reply = Self.file(name)
                var ask = asks.remove(at: index)
                let replied = (try? JSONSerialization.jsonObject(with: reply.1)) as? [String: Any] ?? [:]
                ask["state"] = replied["state"]
                ask["outcome"] = replied["outcome"]
                ended[id] = ask
                recorded[id] = reply
                answered.append("\(id) \(word) \(replied["state"] as? String ?? "")\(carried)")
                return reply
            }
        }

        private func edit(_ said: HomeLink.EditRequest) -> (Int, Data) {
            if case .key = said.target { return Self.guide("edit-key") }
            switch said.edit {
            case nil:
                guard case .request(let id) = said.target else { return Self.file("edit-draw") }
                return Self.file(Self.asks(now: 0).contains { $0["id"] as? String == id } ? "edit-ask" : "edit-sign-in")
            case .window?: return Self.file("edit-window")
            case .type?: return Self.file("edit-type-on")
            case .typeWindow?: return Self.file("edit-type-window")
            case .account?: return Self.file("edit-account-on")
            case .accountWindow?: return Self.file("edit-account-window")
            case .hide?: return Self.file("edit-hide")
            case .detail?: return Self.file("edit-detail")
            case .mode(let mode)?: return Self.file(mode == .only ? "edit-mode-only" : "edit-mode-but")
            }
        }

        struct Probe: View {
            @ObservedObject private var agents = Agents.shared

            var body: some View {
                Text(agents.answered.isEmpty ? "none" : agents.answered.joined(separator: "; "))
                    .font(.system(size: 1)).opacity(0.01)
                    .allowsHitTesting(false)
                    .accessibilityIdentifier("ui-test.agents.answered")
            }
        }
    }

    @MainActor final class Asks: ObservableObject {
        static let shared = Asks()
        static let routes = ["places", "place", "year", "photos", "where", "where.day", "where.month", "where.year", "day", "status", "exchange", "clock"]

        @Published private(set) var counts: [String: Int] = [:]
        @Published private(set) var loops: [String: String] = [:]
        private var generations: [String: Int] = [:]

        func began(_ day: String, front: Bool) -> Int {
            let generation = (generations[day] ?? 0) + 1
            generations[day] = generation
            loops[day] = String(generation)
            loops["\(day)#\(generation)"] = front ? "front" : "beside"
            return generation
        }

        func ended(_ day: String, _ generation: Int, cancelled: Bool) {
            loops["\(day)#\(generation)"] = cancelled ? "cancelled" : "ended"
        }

        func knocked() {
            counts["door", default: 0] += 1
        }

        fileprivate func count(_ path: String, _ asked: Asked, tagged: Bool) {
            let route: String
            switch path {
            case HomeLink.Pages.Places.route: route = "places"
            case HomeLink.Pages.Place.route: route = "place"
            case HomeLink.Pages.Year.route: route = "year"
            case "/v1/places" where asked.one("slug") == nil: route = "places.book"
            case "/v1/places/photos": route = "photos"
            case "/v1/where": route = asked.one("grain").map { "where." + $0 } ?? "where"
            case HomeLink.Pages.Day.route: route = "day"
            case "/v1/status": route = "status"
            case "/v1/exchange": route = "exchange"
            case "/v1/clock": route = "clock"
            default: return
            }
            counts[route, default: 0] += 1
            if tagged { counts[route + ".tagged", default: 0] += 1 }
            if route == "day", let day = asked.one("day") { counts["day." + day, default: 0] += 1 }
        }

        struct Probe: View {
            @ObservedObject private var asks = Asks.shared

            var body: some View {
                VStack {
                    ForEach(Asks.routes.flatMap { [$0, $0 + ".tagged"] } + ["door"]
                            + asks.counts.keys.filter { $0.hasPrefix("day.") && $0 != "day.tagged" }.sorted(), id: \.self) { route in
                        Text("\(asks.counts[route] ?? 0)").font(.system(size: 1)).opacity(0.01)
                            .accessibilityIdentifier("ui-test.asks." + route)
                    }
                    ForEach(asks.loops.keys.sorted(), id: \.self) { loop in
                        Text(asks.loops[loop] ?? "").font(.system(size: 1)).opacity(0.01)
                            .accessibilityIdentifier("ui-test.loop." + loop)
                    }
                }
                .allowsHitTesting(false)
            }
        }
    }

    @MainActor final class PeopleEdits: ObservableObject {
        static let shared = PeopleEdits()

        struct Landing: Sendable {
            let seq: Int64
            let act: String
            let id: String
            let laid: [String: AnySendable]
            let unlink: [String]
            let answered: [String]
            let undoes: String?
        }

        struct AnySendable: @unchecked Sendable {
            let value: Any
        }

        struct Held: Sendable {
            var landings: [Landing] = []
            var blobs: [String: Data] = [:]

            func standing(_ now: Date) -> [Landing] {
                let undone = Set(landings.compactMap(\.undoes))
                return landings.filter { $0.undoes == nil && !undone.contains($0.act) }
            }

            func position(_ now: Date) -> String {
                let seq = landings.map(\.seq).max() ?? 1
                return "\(seq):\(Int64(now.timeIntervalSince1970 * 1000))"
            }

            func over(_ list: [String: Any], now: Date) -> [String: Any] {
                var list = list
                let standing = standing(now)
                list["people"] = (list["people"] as? [[String: Any]] ?? []).map { over(person: $0, standing) }
                if let you = list["you"] as? [String: Any] { list["you"] = over(person: you, standing) }
                list["chats"] = (list["chats"] as? [[String: Any]] ?? []).map { over(chat: $0, standing) }
                list["position"] = position(now)
                return list
            }

            private func over(chat: [String: Any], _ standing: [Landing]) -> [String: Any] {
                guard let landing = standing.last(where: { $0.id == chat["key"] as? String }), let word = landing.laid["word"]?.value else { return chat }
                var chat = chat
                let lastDay = (chat["quiet"] as? [String: Any])?["last_day"] ?? NSNull()
                switch word as? Bool {
                case true?:
                    chat["word"] = true
                    chat["quiet"] = ["why": "owner", "last_day": lastDay]
                case false?:
                    chat["word"] = false
                    chat["quiet"] = NSNull()
                case nil:
                    chat["word"] = NSNull()
                    if (chat["quiet"] as? [String: Any])?["why"] as? String == "owner" { chat["quiet"] = ["why": "silent", "last_day": lastDay] }
                }
                return chat
            }

            func word(of chat: String, now: Date) -> Bool? {
                standing(now).last { $0.id == chat && $0.laid["word"] != nil }?.laid["word"]?.value as? Bool
            }

            func photos(_ now: Date) -> [String: Any] {
                var photos: [String: Any] = [:]
                for landing in standing(now) {
                    guard let laid = landing.laid["photo"]?.value else { continue }
                    photos[landing.id] = (laid as? [String: Any])?["crop"] as? String ?? NSNull()
                }
                return photos
            }

            private func over(person: [String: Any], _ standing: [Landing]) -> [String: Any] {
                var person = person
                for landing in standing where landing.id == person["id"] as? String {
                    for (key, laid) in landing.laid {
                        if key == "details" {
                            var details = person["details"] as? [String: Any] ?? ["work": NSNull(), "birthday": NSNull(), "profiles": [Any]()]
                            for (member, value) in laid.value as? [String: Any] ?? [:] { details[member] = value }
                            person["details"] = details
                            person["work"] = details["work"]
                        } else if laid.value is NSNull {
                            person[key] = NSNull()
                        } else {
                            person[key] = laid.value
                        }
                    }
                    if !landing.unlink.isEmpty {
                        person["handles"] = (person["handles"] as? [[String: Any]] ?? []).filter { handle in
                            !landing.unlink.contains("\(handle["kind"] as? String ?? ""):\(handle["value"] as? String ?? "")")
                        }
                    }
                    if !landing.answered.isEmpty, let suggestions = person["suggestions"] as? [[String: Any]] {
                        person["suggestions"] = suggestions.filter { !landing.answered.contains($0["id"] as? String ?? "") }
                    }
                }
                return person
            }
        }

        private(set) var held = Held()
        private var answers: [String: (Int, Data)] = [:]
        private let losing = ProcessInfo.processInfo.arguments.contains("--ui-test-acts-lost")
        private var lost: Set<String> = []
        @Published private(set) var taken = (actions: 0, photos: 0)
        @Published private(set) var asked = (asks: 0, requests: Set<String>())
        @Published private(set) var image: String?
        @Published private(set) var side: Int?
        @Published private(set) var said = "none"

        func loses(_ body: Data) -> Bool {
            guard losing, let request = ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any])?["request"] as? String else { return false }
            return lost.insert(request).inserted
        }

        func act(_ body: Data, person: (String) -> [String: Any]?) -> (Int, Data) {
            guard let action = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
                  let request = action["request"] as? String, let kind = action["kind"] as? String else {
                return (400, Self.bytes(["code": "BAD_ACTION", "message": "An action is a kind and a request."]))
            }
            asked.asks += 1
            asked.requests.insert(request)
            if let answer = answers[request] { return answer }
            let (status, object) = land(kind, action, person: person)
            let answer = (status, Self.bytes(object))
            if status == 200 { answers[request] = answer }
            return answer
        }

        private static func bytes(_ object: [String: Any]) -> Data {
            (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
        }

        private func land(_ kind: String, _ action: [String: Any], person: (String) -> [String: Any]?) -> (Int, [String: Any]) {
            let seq = (held.landings.map(\.seq).max() ?? 1) + 1
            let now = AppClock.now
            let answer = { (act: String?, id: String) -> (Int, [String: Any]) in
                (200, ["act": act.map { $0 as Any } ?? NSNull(), "id": id, "position": "\(seq):\(Int64(now.timeIntervalSince1970 * 1000))"])
            }
            switch kind {
            case "undo":
                let last = held.landings.last { $0.undoes == nil }
                guard let act = action["act"] as? String, let last, last.act == act,
                      !held.landings.contains(where: { $0.undoes == act }) else {
                    return (409, ["code": "NOT_LAST", "message": "Another device changed your people since."])
                }
                held.landings.append(Landing(seq: seq, act: "act-\(seq)", id: last.id,
                                             laid: [:], unlink: [], answered: [], undoes: act))
                taken.actions += 1
                return answer(nil, last.id)
            case "photo":
                guard let id = action["id"] as? String, person(id) != nil else {
                    return (404, ["code": "PERSON_UNKNOWN", "message": "Lifestream doesn't know this person."])
                }
                guard let upload = (action["upload"] as? String).flatMap({ Data(base64Encoded: $0) }),
                      let picture = UIImage(data: upload)?.cgImage, picture.width == picture.height, (1...1_024).contains(picture.width),
                      upload.starts(with: [0xFF, 0xD8, 0xFF]) else {
                    return (422, ["code": "STATEMENTS_BAD", "message": "line 1: the picture is not a square JPEG of 1 to 1,024"])
                }
                let hash = SHA256Digest.tagged(upload)
                held.blobs[hash] = upload
                image = hash
                side = picture.width
                held.landings.append(Landing(seq: seq, act: "act-\(seq)", id: id,
                                             laid: ["photo": AnySendable(value: ["crop": hash])], unlink: [], answered: [], undoes: nil))
                taken = (taken.actions + 1, taken.photos + 1)
                return answer("act-\(seq)", id)
            case "group":
                guard let chat = action["chat"] as? String, chat.hasSuffix("@g.us"), action.keys.contains("quiet") else {
                    return (400, ["code": "BAD_ACTION", "message": "A group's word names a group."])
                }
                var members = action
                members["request"] = nil
                said = (try? JSONSerialization.data(withJSONObject: members, options: [.sortedKeys, .withoutEscapingSlashes]))
                    .map { String(decoding: $0, as: UTF8.self) } ?? "none"
                held.landings.append(Landing(seq: seq, act: "act-\(seq)", id: chat,
                                             laid: ["word": AnySendable(value: action["quiet"] ?? NSNull())], unlink: [], answered: [],
                                             undoes: nil))
                taken.actions += 1
                return answer("act-\(seq)", chat)
            case "confirm":
                guard let id = action["id"] as? String, person(id) != nil else {
                    return (404, ["code": "PERSON_UNKNOWN", "message": "Lifestream doesn't know this person."])
                }
                var members = action
                members["request"] = nil
                members["kind"] = nil
                said = (try? JSONSerialization.data(withJSONObject: members, options: [.sortedKeys, .withoutEscapingSlashes]))
                    .map { String(decoding: $0, as: UTF8.self) } ?? "none"
                var laid: [String: AnySendable] = [:]
                if let name = action["name"] { laid["name"] = AnySendable(value: name); laid["call_name"] = AnySendable(value: name) }
                for key in ["full_name", "relationship", "entity", "hidden", "details"] {
                    if let value = action[key] { laid[key] = AnySendable(value: value) }
                }
                if action["entity"] != nil { laid["entity_by"] = AnySendable(value: "you") }
                let answered = (action["accept"] as? [String] ?? []) + (action["decline"] as? [String] ?? [])
                held.landings.append(Landing(seq: seq, act: "act-\(seq)", id: id, laid: laid,
                                             unlink: action["unlink"] as? [String] ?? [], answered: answered, undoes: nil))
                taken.actions += 1
                return answer("act-\(seq)", id)
            default:
                return (400, ["code": "BAD_ACTION", "message": "No such action."])
            }
        }

        struct Probe: View {
            @ObservedObject private var edits = PeopleEdits.shared

            var body: some View {
                VStack {
                    Text("\(edits.taken.actions) \(edits.taken.photos)")
                        .accessibilityIdentifier("ui-test.people.taken")
                    Text("\(edits.asked.asks) \(edits.asked.requests.count)")
                        .accessibilityIdentifier("ui-test.people.asked")
                    Text(edits.image ?? "none").accessibilityIdentifier("ui-test.people.image")
                    Text(edits.side.map(String.init) ?? "none").accessibilityIdentifier("ui-test.people.side")
                    Text(edits.said).accessibilityIdentifier("ui-test.people.said")
                }
                .font(.system(size: 1)).opacity(0.01)
                .allowsHitTesting(false)
            }
        }
    }


    enum CannedPages {
        private static let canned = "pages/canned"

        static func people(_ edits: PeopleEdits.Held, now: Date) -> Data? {
            if CannedHome.emptyHome { return answer("people.nothing", in: "pages") }
            guard let answered = answer("people.list") else { return nil }
            guard !edits.landings.isEmpty, var list = (try? JSONSerialization.jsonObject(with: answered)) as? [String: Any] else { return answered }
            list = laid(edits.photos(now), over: list) as? [String: Any] ?? list
            list["position"] = edits.position(now)
            return try? JSONSerialization.data(withJSONObject: list, options: [.sortedKeys])
        }

        static func person(_ id: String, _ edits: PeopleEdits.Held, now: Date) -> Data? {
            let name = "person." + caseOf(id.hasPrefix("person:") ? String(id.dropFirst("person:".count)) : id)
            let confirms = edits.landings.filter { $0.id == id && $0.undoes == nil && $0.laid["photo"] == nil }.map(\.act)
            let standing = Set(edits.standing(now).map(\.act))
            let variant = confirms.contains(where: standing.contains) ? "-saved" : confirms.isEmpty ? nil : "-undone"
            guard let answered = variant.flatMap({ answer(name + $0) }) ?? answer(name) else { return nil }
            guard !edits.landings.isEmpty, var page = (try? JSONSerialization.jsonObject(with: answered)) as? [String: Any] else { return answered }
            let photos = edits.photos(now)
            page = laid(photos, over: page) as? [String: Any] ?? page
            if var head = page["head"] as? [String: Any], let photo = photos[id] {
                head["photo"] = photo
                page["head"] = head
            }
            page["position"] = edits.position(now)
            return try? JSONSerialization.data(withJSONObject: page, options: [.sortedKeys])
        }

        static let shots = held(["jpg"])

        static let pictures = held(["png"]).merging(shots) { first, _ in first }

        static let movies = held(["mov"])

        static func hash(of file: String) -> String? { named[file] }

        static let motions: [String: String] = Dictionary(named.compactMap { file, hash in
            guard file.hasSuffix(".jpg"), let motion = named[file.dropLast(".jpg".count) + ".mov"] else { return nil }
            return (hash, motion)
        }, uniquingKeysWith: { first, _ in first })

        private static let named: [String: String] = Dictionary(["jpg", "mov", "png"].flatMap { Bundle.main.urls(forResourcesWithExtension: $0, subdirectory: canned) ?? [] }
            .compactMap { url in (try? Data(contentsOf: url)).map { (url.lastPathComponent, SHA256Digest.tagged($0)) } }, uniquingKeysWith: { first, _ in first })

        private static func held(_ extensions: [String]) -> [String: Data] {
            Dictionary(extensions.flatMap { Bundle.main.urls(forResourcesWithExtension: $0, subdirectory: canned) ?? [] }.compactMap { url in
                (try? Data(contentsOf: url)).map { (SHA256Digest.tagged($0), $0) }
            }, uniquingKeysWith: { first, _ in first })
        }

        private static func laid(_ photos: [String: Any], over value: Any) -> Any {
            if let values = value as? [Any] { return values.map { laid(photos, over: $0) } }
            guard var object = value as? [String: Any] else { return value }
            for (key, member) in object { object[key] = laid(photos, over: member) }
            if let id = object["id"] as? String, object["photo"] != nil, let photo = photos[id] { object["photo"] = photo }
            return object
        }

        static func group(_ chat: String, word: Bool?) -> Data? {
            let name = "group." + caseOf(chat)
            return (word == true ? answer(name + "-always") : nil) ?? answer(name)
        }

        static func find(_ q: String) -> Data? {
            answer("peopleFind." + caseOf(q))
        }

        static func places(_ listed: String) -> Data? {
            answer(CannedHome.emptyHome ? "places.nothing" : CannedScale.factor != nil ? "places.scaled" : listed)
        }

        static func place(_ placed: String) -> Data? {
            answer("place." + caseOf(placed))
        }

        static func year(_ year: String) -> Data? {
            CannedHome.emptyHome ? nil : answer("year." + caseOf(year))
        }

        static func placeEdit(slug: String?, spot: String?) -> Data? {
            (slug ?? spot).flatMap { answer("placeEdit." + caseOf($0)) }
        }

        static func days() -> Data? {
            answer(CannedHome.emptyHome ? "days.nothing" : "days.list")
        }

        static func day(_ day: String, named: Bool) -> Data? {
            (named ? answer("day.\(day)-named") : nil) ?? answer("day.\(day)")
        }

        static func moment(_ day: String, focus: String) -> Data? {
            answer("moment.\(day)-\(caseOf(focus))")
        }

        static func thread(_ chat: String, day: String) -> Data? {
            answer("thread.\(caseOf(chat))-\(day)")
        }

        static func settings() -> Data? {
            answer("settings.phone", in: "pages")
        }

        static func settingsPage(_ id: String) -> Data? {
            HomeLink.SettingsIndex.phone.flatMap(\.entries).contains { $0.id == id && $0.answer == .settingsPage }
                ? answer("settingsPage." + caseOf(id), in: "pages") : nil
        }

        static func storage() -> Data? {
            answer("storage.counted", in: "pages")
        }

        static func modelsFind() -> Data? {
            answer("modelsFind.claude", in: "pages")
        }

        static func caseOf(_ words: String) -> String {
            var out = ""
            for character in words.lowercased() {
                if character.isASCII, character.isLetter || character.isNumber {
                    out.append(character)
                } else if !out.isEmpty, out.last != "-" {
                    out.append("-")
                }
            }
            return out.hasSuffix("-") ? String(out.dropLast()) : out
        }

        private static func answer(_ name: String, in folder: String = canned) -> Data? {
            Bundle.main.url(forResource: name, withExtension: "json", subdirectory: folder).flatMap { try? Data(contentsOf: $0) }
        }
    }

    static let picksPhoto = ProcessInfo.processInfo.arguments.contains("--ui-test-picked-photo")

    static let pickedPhoto: Data? = StandInPhoto.image(0, size: 1600, height: 1200).flatMap { UIImage(cgImage: $0).jpegData(compressionQuality: 0.9) }

    fileprivate struct Asked {
        let items: [URLQueryItem]

        init(_ url: URL) {
            items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        }

        func one(_ name: String) -> String? { items.first { $0.name == name }?.value }
        func all(_ name: String) -> [String] { items.filter { $0.name == name }.compactMap(\.value) }
    }


    struct Spot: Equatable {
        let slug: String?
        let words: String
        let latitude: Double
        let longitude: Double
        let area: Area
    }

    struct Area: Equatable {
        let city: String
        let cityID: String
        let region: String

        var json: [String: Any] {
            ["city": city, "city_id": cityID, "region": region, "country": "Synthetic Country", "country_code": "XS"]
        }
    }

    fileprivate static let town = Area(city: "Synthetic Town", cityID: "37.33490,-122.00900 Synthetic Town", region: "Synthetic Region")
    fileprivate static let city = Area(city: "Synthetic City", cityID: "36.60020,-121.89470 Synthetic City", region: "Other Region")
    private static let gym = PlaceCoordinate(latitude: 37.3187, longitude: -122.0090)
    fileprivate static let home = Spot(slug: "home-place", words: "Home", latitude: 37.3349, longitude: -122.0090, area: town)
    fileprivate static let office = Spot(slug: "the-office", words: "The Office", latitude: 37.3220, longitude: -122.0010, area: town)
    fileprivate static let spot = Spot(slug: nil, words: "an unnamed place 1.8 km from Home", latitude: gym.latitude,
                                       longitude: gym.longitude, area: town)
    fileprivate static let away = Spot(slug: nil, words: "an unnamed place in Synthetic City", latitude: 36.6002, longitude: -121.8947, area: city)
    fileprivate static let stop = Spot(slug: nil, words: "an unnamed place 0.6 km from The Office", latitude: 37.3274,
                                       longitude: -122.0010, area: town)
    fileprivate static let toName = [spot, away]

    private static let historyDays = 400
    private static let phoneOffDay = 9


    struct Laid {
        var start: Date
        var end: Date
        let at: Spot?
        let from: Spot?
        let to: Spot?
        let mode: String
        let distance: Double
        var units: [String] = []

        var isGap: Bool { at == nil && from == nil }

        static func gap(_ start: Date, _ end: Date) -> Laid {
            Laid(start: start, end: end, at: nil, from: nil, to: nil, mode: "", distance: 0)
        }
    }

    struct Routine {
        let now: Date
        let clock: HomeClock
        let zone: TimeZone
        let today: String
        let trip: [String]
        let off: String
        let first: String
        private let calendar: Calendar

        init(now: Date) {
            clock = CannedHome.clock(at: now)
            zone = clock.runs[0].zone
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = zone
            self.now = now
            self.calendar = calendar
            today = clock.dayAt(now).day
            let (year, month) = (Int(today.prefix(4)) ?? 1970, Int(today.dropFirst(5).prefix(2)) ?? 1)
            let last = month == 1 ? String(format: "%04d-12", year - 1) : String(format: "%04d-%02d", year, month - 1)
            trip = (12...14).map { String(format: "%@-%02d", last, $0) }
            off = Words.shiftDay(today, -CannedHome.phoneOffDay)
            first = Words.shiftDay(today, -CannedHome.historyDays)
        }

        func day(back: Int) -> String { Words.shiftDay(today, -back) }

        func back(of day: String) -> Int {
            Words.daysBetween(day, today)
        }

        func start(of day: String) -> Date {
            let run = clock.runs.last { $0.day <= day } ?? clock.runs[0]
            return Words.date(ms: run.startMs + Int64(Words.daysBetween(run.day, day)) * 86_400_000)
        }

        func midnight(of day: String) -> Date {
            Self.midnight(of: day, calendar)
        }

        func isWeekend(_ day: String) -> Bool {
            [1, 7].contains(Words.weekday(ofDay: day))
        }

        func pieces(of day: String) -> [Laid] {
            guard day >= first, day != off else { return [] }
            let midnight = self.midnight(of: day)
            func at(_ hours: Double) -> Date { midnight.addingTimeInterval((hours * 3600).rounded()) }
            let start = self.start(of: day).timeIntervalSince(midnight) / 3600
            let end = self.start(of: Words.shiftDay(day, 1)).timeIntervalSince(midnight) / 3600
            let home = CannedHome.home, office = CannedHome.office, spot = CannedHome.spot, away = CannedHome.away
            func stay(_ spot: Spot, _ from: Double, _ to: Double) -> Laid {
                Laid(start: at(from), end: at(to), at: spot, from: nil, to: nil, mode: "", distance: 0,
                     units: ["stay/\(CannedDays.location)/\(ms(at(from)))"])
            }
            func move(_ from: Spot, _ to: Spot, _ start: Double, _ end: Double, _ mode: String, _ metres: Double) -> Laid {
                Laid(start: at(start), end: at(end), at: nil, from: from, to: to, mode: mode, distance: metres,
                     units: ["trip/\(CannedDays.location)/\(ms(at(start)))"])
            }
            switch trip.firstIndex(of: day) {
            case 0: return [stay(home, start, 9), move(home, away, 9, 12, "drive", 160_000), stay(away, 12, end)]
            case 1: return [stay(away, start, end)]
            case 2: return [stay(away, start, 16), move(away, home, 16, 19, "drive", 160_000), stay(home, 19, end)]
            default: break
            }
            func homeward(_ leave: Double, _ walk: Double) -> [Laid] {
                guard back(of: day) == 1 else { return [move(spot, home, leave, leave + walk, "walk", 1800), stay(home, leave + walk, end)] }
                let stop = CannedHome.stop
                return [move(spot, stop, leave, leave + 0.1, "walk", 1000), stay(stop, leave + 0.1, leave + 0.5),
                        move(stop, home, leave + 0.5, leave + 0.8, "walk", 1100), stay(home, leave + 0.8, end)]
            }
            if isWeekend(day) {
                return [stay(home, start, 10.5), move(home, spot, 10.5, 10.8, "walk", 1800), stay(spot, 10.8, 12.2)] + homeward(12.2, 0.3)
            }
            return [stay(home, start, 8.5), move(home, office, 8.5, 8.9, "walk", 1800), stay(office, 8.9, 17.6),
                    move(office, spot, 17.6, 17.85, "walk", 900), stay(spot, 17.85, 19)] + homeward(19, 0.4)
        }

        private func ms(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded(.down)) }

        private static func midnight(of day: String, _ calendar: Calendar) -> Date {
            let parts = day.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3 else { return Date(timeIntervalSince1970: 0) }
            return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) ?? Date(timeIntervalSince1970: 0)
        }
    }


    static let photo: Data = {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: CGSize(width: 120, height: 90), format: format).pngData { context in
            UIColor(hue: 0.58, saturation: 0.3, brightness: 0.85, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 120, height: 56))
            UIColor(hue: 0.3, saturation: 0.35, brightness: 0.5, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 56, width: 120, height: 34))
        }
    }()

    static let photoHash = "sha256:" + SHA256.hash(data: photo).map { String(format: "%02x", $0) }.joined()

    static let scenes: [String: Data] = Dictionary(uniqueKeysWithValues: drawn.values.map { ($0.hash, $0.jpeg) })

    private static let drawn: [StandInPhoto.Scene: (hash: String, jpeg: Data)] = Dictionary(uniqueKeysWithValues:
        StandInPhoto.Scene.allCases.compactMap { scene in
            let tall = scene == .dusk
            guard let image = StandInPhoto.image(scene.rawValue, size: tall ? 180 : 360, height: tall ? 390 : nil) else { return nil }
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let side = tall ? CGSize(width: 1_179, height: 2_556) : CGSize(width: 1_800, height: 1_800)
            let large = UIGraphicsImageRenderer(size: side, format: format).image { _ in
                UIImage(cgImage: image).draw(in: CGRect(origin: .zero, size: side))
            }
            guard let jpeg = large.jpegData(compressionQuality: 0.85) else { return nil }
            return (scene, (hash(jpeg), jpeg))
        })


    static let recipe = 2

    static let video = movie(seconds: 4, shade: 0x40)

    static let live = movie(seconds: 2, shade: 0xA0)

    static func movie(_ hash: String) -> Data? {
        [video, live].first { $0.hash == hash }?.bytes
    }

    static let poster: Data = {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: CGSize(width: 640, height: 360), format: format).jpegData(withCompressionQuality: 0.8) { context in
            UIColor(white: 0.25, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 640, height: 360))
        }
    }()

    private static func movie(seconds: Int, shade: UInt8) -> (hash: String, bytes: Data) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("canned-\(UUID().uuidString).mov")
        defer { try? FileManager.default.removeItem(at: url) }
        guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mov) else { return ("", Data()) }
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 64, AVVideoHeightKey: 36,
        ])
        input.expectsMediaDataInRealTime = false
        let frames = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 36,
        ])
        writer.add(input)
        guard writer.startWriting() else { return ("", Data()) }
        writer.startSession(atSourceTime: .zero)
        let count = seconds * 30
        let written = DispatchSemaphore(value: 0)
        let next = OSAllocatedUnfairLock(initialState: 0)
        input.requestMediaDataWhenReady(on: DispatchQueue(label: "CannedHome.movie")) {
            while input.isReadyForMoreMediaData {
                let frame = next.withLock { frame in
                    defer { frame += 1 }
                    return frame
                }
                guard frame < count else {
                    if frame == count {
                        input.markAsFinished()
                        writer.finishWriting { written.signal() }
                    }
                    return
                }
                var buffer: CVPixelBuffer?
                CVPixelBufferCreate(nil, 64, 36, kCVPixelFormatType_32BGRA, nil, &buffer)
                guard let pixels = buffer else { continue }
                CVPixelBufferLockBaseAddress(pixels, [])
                memset(CVPixelBufferGetBaseAddress(pixels), Int32(shade &+ UInt8(truncatingIfNeeded: frame)), CVPixelBufferGetDataSize(pixels))
                CVPixelBufferUnlockBaseAddress(pixels, [])
                frames.append(pixels, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: 30))
            }
        }
        written.wait()
        guard writer.status == .completed, let bytes = try? Data(contentsOf: url) else { return ("", Data()) }
        return (hash(bytes), bytes)
    }

    static func scene(_ scene: StandInPhoto.Scene) -> String {
        drawn[scene]?.hash ?? photoHash
    }

    static func scene(of hash: String) -> StandInPhoto.Scene? {
        drawn.first { $0.value.hash == hash }?.key ?? homeShots[hash]
    }

    static func picture(of hash: String) -> Data? {
        scenes[hash] ?? homeShots[hash].flatMap { drawn[$0]?.jpeg }
    }

    private static let homeShots: [String: StandInPhoto.Scene] = Dictionary(uniqueKeysWithValues:
        StandInPhoto.Scene.allCases.filter { $0 != .face }.flatMap { scene in
            (0..<homeShotCount).map { n in (hash(Data("synthetic canned photo \(scene) \(n)".utf8)), scene) }
        })

    private static let homeShotCount = 32

    static func scene(for caption: String) -> String {
        let words = caption.lowercased()
        let pairs: [(String, StandInPhoto.Scene)] = [("bowl", .plate), ("courtyard with", .park), ("coffee", .coffee), ("gate", .window),
                                                     ("street", .dusk), ("market", .cafe)]
        return scene(pairs.first { words.contains($0.0) }?.1 ?? .sea)
    }

    private static func hash(_ data: Data) -> String {
        "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static let theirFace = 160.0

    static let theirPhotos: [(hash: String, jpeg: Data, box: [Double])] = {
        let grounds: [StandInPhoto.Scene] = [.cafe, .park, .dusk, .sea, .window, .plate]
        let corners: [CGPoint] = [.init(x: 520, y: 140), .init(x: 120, y: 260), .init(x: 320, y: 80), .init(x: 560, y: 320),
                                  .init(x: 80, y: 120), .init(x: 400, y: 380)]
        guard let face = StandInPhoto.image(StandInPhoto.Scene.face.rawValue, size: Int(theirFace)) else { return [] }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return zip(grounds, corners).compactMap { ground, at in
            guard let scene = StandInPhoto.image(ground.rawValue, size: 800, height: 600) else { return nil }
            let jpeg = UIGraphicsImageRenderer(size: CGSize(width: 800, height: 600), format: format).jpegData(withCompressionQuality: 0.8) { _ in
                UIImage(cgImage: scene).draw(in: CGRect(x: 0, y: 0, width: 800, height: 600))
                UIImage(cgImage: face).draw(in: CGRect(origin: at, size: CGSize(width: theirFace, height: theirFace)))
            }
            let box = [at.x + 0.31 * theirFace, at.y + 0.2 * theirFace, at.x + 0.69 * theirFace, at.y + 0.68 * theirFace].map { $0.rounded() }
            return (hash(jpeg), jpeg, box)
        }
    }()
}

extension CannedHome {
    actor LateClock {
        static let shared = LateClock()
        private var released = !CannedHome.clockLate
        private var waiting: [CheckedContinuation<Void, Never>] = []

        func held() async {
            guard !released else { return }
            await withCheckedContinuation { waiting.append($0) }
        }

        fileprivate func asked(day: String?, today: String) {
            guard !released, day == Words.shiftDay(today, -22) else { return }
            released = true
            waiting.forEach { $0.resume() }
            waiting = []
        }
    }
}


private func nullable<Value>(_ value: Value?) -> Any {
    value.map { $0 as Any } ?? NSNull()
}

private struct Home {
    let now: Date
    let zone: TimeZone
    let routine: CannedHome.Routine
    let days: [HomeLink.DayFile]
    let sleep: [HomeLink.Extract]
    private let calendar: Calendar
    private let format: DateFormatter

    init(now: Date) {
        self.now = now
        routine = CannedHome.Routine(now: now)
        zone = routine.zone
        var days = CannedDays.days(routine)
        if CannedScale.factor != nil, let today = days.popLast() { days.append(CannedScale.marked(today)) }
        self.days = days
        sleep = CannedDays.sleep(routine)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        self.calendar = calendar
        format = DateFormatter()
        format.calendar = calendar
        format.timeZone = zone
        format.locale = Locale(identifier: "en_US_POSIX")
        format.dateFormat = "yyyy-MM-dd"
    }

    private var position: String { "0:1" }

    func readThroughs() -> [String: Any] {
        let ids = Set(days.flatMap { $0.coverage.flatMap(\.sources).map(\.source) }).sorted()
        return ["position": position, "sources": ids.map { ["id": $0, "read_through_ms": Self.ms(now)] as [String: Any] }]
    }

    private static func ms(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded(.down)) }


    func civilDay(_ date: Date) -> String {
        routine.clock.dayAt(date).day
    }

    func start(_ day: String) -> Date {
        routine.start(of: day)
    }

    func next(_ day: String) -> String {
        Words.shiftDay(day, 1)
    }

    func civilDays(_ first: String, _ last: String) -> [String] {
        var out: [String] = []
        var day = first
        while day <= last, out.count < 800 {
            out.append(day)
            day = next(day)
        }
        return out
    }

    private func bound(_ text: String?, end: Bool) -> Date? {
        guard let text else { return nil }
        if let ms = Int64(text) { return Date(timeIntervalSince1970: Double(ms) / 1000) }
        return end ? start(next(text)) : start(text)
    }


    func places() -> [String: Any] {
        let pieces = laid(historyStart, now)
        let stays = pieces.filter { $0.at != nil }
        let today = civilDay(now)
        func visits(_ spot: CannedHome.Spot) -> [String: Any] {
            let held = stays.filter { $0.at == spot }
            var byDay: [String: Double] = [:]
            for stay in held {
                var cursor = stay.start
                while cursor < stay.end {
                    let end = min(stay.end, start(next(civilDay(cursor))))
                    byDay[civilDay(cursor), default: 0] += end.timeIntervalSince(cursor) / 3600
                    cursor = end
                }
            }
            return ["stays": held.count, "days": byDay.count, "hours": Self.tenth(byDay.values.reduce(0, +)),
                    "longest_day_hours": Self.tenth(byDay.values.max() ?? 0), "today_hours": Self.tenth(byDay[today] ?? 0),
                    "first_ms": nullable(held.first.map { Self.ms($0.start) }), "last_ms": nullable(held.last.map { Self.ms($0.end) })]
        }
        func place(_ spot: CannedHome.Spot, radius: Int) -> [String: Any] {
            ["slug": spot.slug ?? "", "name": spot.words, "latitude": spot.latitude, "longitude": spot.longitude, "radius_m": radius,
             "also": [Any](), "ids": [String](), "area": spot.area.json].merging(visits(spot)) { _, counted in counted }
        }
        func spot(_ spot: CannedHome.Spot, witnessed: String, last: String?, photos: Int = 0, askHome: String? = nil) -> [String: Any] {
            let held = stays.filter { $0.at == spot }
            return ["latitude": spot.latitude, "longitude": spot.longitude, "worth": true, "area": spot.area.json,
                    "ask_home": nullable(askHome), "key": Self.key(spot.latitude, spot.longitude), "witnessed": witnessed,
                    "last": nullable(last), "photos": Self.spotPhotos(photos, at: held.last?.start ?? now), "photos_count": photos]
                    .merging(visits(spot)) { _, counted in counted }
                    .filter { $0.key != "today_hours" }
        }
        let asked: [String: Any] = ["position": position, "day": today, "day_until_ms": Self.ms(start(next(today)))]
        if CannedHome.emptyHome {
            return CannedHome.placeActs.over(asked.merging(["here": NSNull(), "places": [Any](), "spots": [Any](), "hidden": [Any]()]) { $1 })
        }
        let open = pieces.last.flatMap { $0.at != nil && $0.end >= now.addingTimeInterval(-60) ? $0 : nil }
        let here = open.flatMap { stay in stay.at.map { at in
            ["latitude": at.latitude, "longitude": at.longitude, "start_ms": Self.ms(stay.start), "end_ms": Self.ms(stay.end),
             "slug": nullable(at.slug)] as [String: Any]
        } }
        let seen = Self.ms(historyStart.addingTimeInterval(-120 * 86_400))
        let filler = CannedScale.places(now: now, town: CannedHome.town.json)
        func place(_ slug: String, _ name: String, _ latitude: Double, _ longitude: Double, _ area: CannedHome.Area,
                  days: Int, hours: Double, first: Double, last: Double) -> [String: Any] {
            ["slug": slug, "name": name, "latitude": latitude, "longitude": longitude, "radius_m": 80, "also": [Any](), "ids": [String](),
             "area": area.json, "stays": days, "days": days, "hours": hours, "longest_day_hours": min(hours, 9), "today_hours": 0,
             "first_ms": Self.ms(now.addingTimeInterval(-first * 86_400)), "last_ms": Self.ms(now.addingTimeInterval(-last * 86_400))]
        }
        let kept = [
            place("old-office", "Old Office", 37.3275, -121.9905, CannedHome.town, days: 160, hours: 1_240, first: 900, last: 330),
            place("corner-bakery", "Corner Bakery", 37.3301, -122.0142, CannedHome.town, days: 1, hours: 0.6, first: 19, last: 19),
            place("harbour-inn", "Harbour Inn", 36.6031, -121.8991, CannedHome.city, days: 1, hours: 2.5, first: 36, last: 36),
            place("willow-court", "Willow Court", 37.3420, -122.0170, CannedHome.town, days: 40, hours: 96, first: 300, last: 4)
                .merging(["radius_m": 55, "also": [["latitude": 37.3420, "longitude": -122.01626, "radius_m": 30],
                                                   ["latitude": 37.34097, "longitude": -122.0170, "radius_m": 80]]]) { $1 },
        ]
        let listed = ([place(CannedHome.home, radius: 120), place(CannedHome.office, radius: 90)] + kept + filler.places).map { place in
            place.merging(["ask_home": nullable(Self.said(place["slug"] as? String ?? "").ask)]) { _, said in said }
        }
        return CannedHome.placeActs.over(asked.merging([
            "here": nullable(here),
            "places": listed,
            "spots": [
                spot(CannedHome.spot, witnessed: "You were here on 5 days in 2026. You took 9 photos here.",
                     last: "Last time Thu 22 Oct 2026 from 12:30 to 13:40", photos: 9),
                spot(CannedHome.away, witnessed: "You were here on 3 days in Oct 2026.",
                     last: "Last time Mon 26 Oct 2026 from 21:40 to Tue 27 Oct 2026 07:15",
                     askHome: "You’ve slept here 3 nights, since Sunday."),
                ["latitude": 37.3412, "longitude": -122.0215, "stays": 2, "days": 2, "hours": 3.0, "longest_day_hours": 1.5,
                 "first_ms": seen, "last_ms": seen + 7 * 86_400_000, "worth": true, "area": CannedHome.town.json, "ask_home": NSNull(),
                 "key": Self.key(37.3412, -122.0215),
                 "witnessed": "You took a photo here on 2 days in 2025.", "last": "Last time Sat 14 Jun 2025 at 16:20",
                 "photos": Self.spotPhotos(1, at: Date(timeIntervalSince1970: Double(seen) / 1000)), "photos_count": 1],
                ["latitude": 37.3426, "longitude": -122.0153, "stays": 2, "days": 2, "hours": 0.8, "longest_day_hours": 0.5,
                 "first_ms": Self.ms(now.addingTimeInterval(-40 * 86_400)), "last_ms": Self.ms(now.addingTimeInterval(-12 * 86_400)),
                 "worth": false, "area": CannedHome.town.json, "ask_home": NSNull()],
            ] + filler.spots,
            "hidden": [
                ["key": "hidden-c0ffee", "latitude": 37.3365, "longitude": -122.0110, "hidden_ms": Self.ms(now.addingTimeInterval(-11 * 86_400)),
                 "days": 4, "nearest": ["name": "Home", "distance_m": 250]],
                ["key": "hidden-0a0b0c", "latitude": 37.3150, "longitude": -122.0300, "hidden_ms": Self.ms(now.addingTimeInterval(-30 * 86_400)),
                 "days": 1, "nearest": NSNull()],
            ],
        ]) { $1 })
    }

    private static func key(_ latitude: Double, _ longitude: Double) -> String { "spot:\(latitude),\(longitude)" }

    private static func spotPhotos(_ count: Int, at last: Date) -> [[String: Any]] {
        let scenes = StandInPhoto.Scene.allCases.filter { $0 != .face }.map { String(CannedHome.scene($0).dropFirst("sha256:".count)) }
        return (0..<min(count, 6)).map { ["image": scenes[$0 % scenes.count], "at_ms": ms(last.addingTimeInterval(-Double($0) * 3_600))] }
    }

    func suggest(spot key: String?, q: String?) -> [String: Any]? {
        let list = places()
        let listed = (list["spots"] as? [[String: Any]] ?? []).compactMap { $0["key"] as? String }
        if let key, !listed.contains(key) { return nil }
        let names: [[String: Any]] = [
            ["name": "Synthetic Gym", "id": "google:canned-gym", "distance_m": 12,
             "why": ["product": "Calendar", "family": "calendar", "at_ms": Self.ms(now.addingTimeInterval(-50 * 60)), "tier": 3]],
            ["name": "Corner Cafe", "id": "google:canned-cafe", "distance_m": 60,
             "why": ["product": "WhatsApp", "family": "messages", "at_ms": Self.ms(now.addingTimeInterval(-55 * 60)), "tier": 2]],
            ["name": "Park Club", "id": "google:canned-park", "distance_m": 40],
            ["name": "Synthetic Station", "id": "google:canned-station", "distance_m": 140],
        ]
        guard let q = q?.trimmingCharacters(in: .whitespacesAndNewlines), !q.isEmpty else { return ["position": position, "suggestions": names] }
        let words = Self.words(q)
        func holds(_ name: String) -> Bool {
            let have = Self.words(name)
            return words.allSatisfy { word in have.contains { $0.hasPrefix(word) } }
        }
        let gym = PlaceCoordinate(latitude: CannedHome.spot.latitude, longitude: CannedHome.spot.longitude)
        let own: [[String: Any]] = (list["places"] as? [[String: Any]] ?? []).compactMap { place in
            guard let name = place["name"] as? String, holds(name), let slug = place["slug"] as? String,
                  let latitude = place["latitude"] as? Double, let longitude = place["longitude"] as? Double else { return nil }
            return ["name": name, "slug": slug,
                    "distance_m": (PlaceCoordinate(latitude: latitude, longitude: longitude).distance(to: gym)).rounded()]
        }
        let typed: [String: Any] = ["name": q + " Commons", "id": "google:canned-typed", "distance_m": NSNull()]
        return ["position": position, "suggestions": names.filter { holds($0["name"] as? String ?? "") } + own + [typed],
                "provider": ["name": "Google Places", "need": NSNull()] as [String: Any]]
    }

    private static func words(_ text: String) -> [String] {
        text.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
    }

    private static func tenth(_ hours: Double) -> Double { (hours * 10).rounded() / 10 }

    private static func said(_ slug: String) -> (rhythm: ((Int, String) -> String)?, ask: String?) {
        switch slug {
        case "home-place":
            return ({ days, since in "\(Words.count(days)) days here since \(since) · usually evenings" },
                    "You’ve slept here 3 nights, since Monday.")
        case "the-office", "old-office":
            return ({ days, since in "\(Words.count(days)) days here since \(since) · usually weekday mornings" }, nil)
        default:
            return (nil, nil)
        }
    }

    func place(_ slug: String) -> [String: Any]? {
        guard var place = (places()["places"] as? [[String: Any]])?.first(where: { $0["slug"] as? String == slug }) else { return nil }
        let visits = visits(place)
        let names = Dictionary(uniqueKeysWithValues: CannedHome.cast.map { ($0.id, $0.name) })
        var days: [String: Set<String>] = [:]
        for visit in visits {
            for id in who(slug, visit.start) { days[id, default: []].insert(civilDay(visit.start)) }
        }
        let photos = photos(slug, visits)
        let rhythm = Self.said(slug).rhythm
        place["visits_count"] = visits.count
        place["nights"] = slug == "home-place" ? place["days"] as? Int ?? 0 : 0
        place["here"] = visits.first.map { $0.end >= now.addingTimeInterval(-60) } ?? false
        place["part_of"] = NSNull()
        place["inside"] = [Any]()
        place["rhythm"] = nullable(visits.last.flatMap { first in rhythm?(Set(visits.map { civilDay($0.start) }).count, Words.monthYear(ofDay: civilDay(first.start))) })
        let latitude = place["latitude"] as? Double ?? 0, longitude = place["longitude"] as? Double ?? 0
        place["visits"] = visits.map { visit in
            ["unit": "stay/location:local:\(CannedHome.unit)/\(Self.ms(visit.start))", "start_ms": Self.ms(visit.start),
             "end_ms": Self.ms(visit.end), "day": civilDay(visit.start),
             "focus": "u:stay/location:local:\(CannedHome.unit)/\(Self.ms(visit.start))@\(Self.ms(visit.start))-\(Self.ms(visit.end))", "people": who(slug, visit.start),
             "centre": Self.scattered(latitude, longitude, seed: Self.ms(visit.start))] as [String: Any]
        }
        place["photos"] = Array(photos.prefix(4))
        place["photos_count"] = photos.count
        place["people"] = days.map { id, on -> [String: Any] in
            var person: [String: Any] = ["id": id, "name": names[id] ?? id, "days": on.count]
            if let photo = Self.photo(of: id) { person["photo"] = photo }
            return person
        }
        .sorted { ($0["days"] as! Int, $1["name"] as! String) > ($1["days"] as! Int, $0["name"] as! String) }
        return place
    }

    func photo(_ hash: String) -> [String: Any]? {
        if let carried = chatCarried(hash) { return carried }
        if hash == CannedHome.photoHash { return chatImage(hash) }
        if hash == CannedHome.video.hash || CannedHome.CannedPages.movies[hash] != nil { return video(hash) }
        if CannedHome.CannedPages.shots[hash] != nil { return still(hash) }
        guard let scene = CannedHome.scene(of: hash) else { return nil }
        let item = "photo:" + CannedHome.scene(scene).dropFirst("sha256:".count)
        let shown = days.reversed().lazy.compactMap { file in file.atoms.first { $0.item == item }.map { (file.day, $0) } }.first
        let at = shown?.1.startMs
        let atHome = [StandInPhoto.Scene.plate, .park, .sea].contains(scene)
        let spot = atHome ? CannedHome.home : CannedHome.office
        let person = CannedHome.cast[atHome ? 1 : 0]
        let area: [String: Any] = ["city": spot.area.city, "region": spot.area.region, "country": "Synthetic Country"]
        let live = scene == .park
        return [
            "hash": hash, "kind": "photograph",
            "play": nullable(live ? ["hash": CannedHome.live.hash, "media_type": "video/quicktime", "live": true] as [String: Any] : nil),
            "at_ms": nullable(at), "unit": nullable(shown?.1.unit), "day": nullable(shown?.0), "focus": nullable(shown.map { "u:" + $0.1.unit }),
            "caption": nullable(CannedHome.chosen.answered(hash) ? shown.map { String($0.1.text.dropFirst("Photo: ".count)) } : nil),
            "described": CannedHome.chosen.description(of: hash),
            "people": [["id": person.id, "name": person.name, "me": false, "box": [120, 80, 220, 200],
                        "photo": nullable(Self.photo(of: person.id))]],
            "size": ["width": 360, "height": 360],
            "place": ["slug": spot.slug ?? "", "name": spot.words, "latitude": spot.latitude, "longitude": spot.longitude,
                      "radius_m": atHome ? 120 : 90, "area": area],
            "area": NSNull(),
            "camera": ["id": "apple/iphone-17-pro", "name": "iPhone 17 Pro", "mine": true],
            "from": "phone", "chat": NSNull(),
        ]
    }

    private func video(_ hash: String) -> [String: Any] {
        let item = "photo:" + hash.dropFirst("sha256:".count)
        let shown = days.reversed().lazy.compactMap { file in file.atoms.first { $0.item == item }.map { (file.day, $0) } }.first
        return [
            "hash": hash, "kind": "video", "play": ["hash": hash, "media_type": "video/quicktime", "live": false],
            "at_ms": nullable(shown?.1.startMs), "unit": nullable(shown?.1.unit), "day": nullable(shown?.0), "focus": nullable(shown.map { "u:" + $0.1.unit }),
            "caption": NSNull(), "people": [Any](),
            "size": NSNull(), "place": NSNull(), "area": NSNull(), "camera": NSNull(), "from": "phone", "chat": NSNull(),
        ]
    }

    private func still(_ hash: String) -> [String: Any] {
        [
            "hash": hash, "kind": "photograph",
            "play": nullable(CannedHome.CannedPages.motions[hash].map { ["hash": $0, "media_type": "video/quicktime", "live": true] as [String: Any] }),
            "at_ms": NSNull(), "unit": NSNull(), "day": NSNull(), "focus": NSNull(), "caption": NSNull(), "people": [Any](),
            "size": NSNull(), "place": NSNull(), "area": NSNull(), "camera": NSNull(), "from": "phone", "chat": NSNull(),
        ]
    }

    private func chatImage(_ hash: String) -> [String: Any]? {
        guard let person = CannedHome.cast.first(where: { $0.slug == "person-a" }) else { return nil }
        for file in days {
            let atoms = file.atoms.filter { $0.family == "messages" && $0.block?.key == person.chat }
            let mine = { (atom: HomeLink.DayFile.Atom) in atom.text.hasPrefix("the user: ") }
            guard let index = atoms.indices.first(where: { $0 > 0 && mine(atoms[$0]) && !mine(atoms[$0 - 1]) }),
                  let record = atoms[index - 1].record, let at = atoms[index - 1].startMs else { continue }
            return sent(hash, video: false, by: person, record: record, at: at, day: file.day)
        }
        return nil
    }

    private static func photoListed(_ member: CannedHome.Member) -> Bool {
        member.slug == "person-c" || CannedHome.faces
    }

    private static func face(_ member: CannedHome.Member) -> String? {
        guard photoListed(member), let photo = photo(of: member.id) else { return nil }
        return photo["crop"] ?? photo["card"]
    }

    private func chatCarried(_ hash: String) -> [String: Any]? {
        let item = "photo:" + hash.dropFirst("sha256:".count)
        guard let (day, atom) = days.reversed().lazy.compactMap({ file in
            file.atoms.first { $0.family == "messages" && $0.item == item }.map { (file.day, $0) }
        }).first, let record = atom.record, let at = atom.startMs,
              let person = CannedHome.cast.first(where: { $0.chat == atom.block?.key }) else { return nil }
        return sent(hash, video: CannedHome.CannedPages.movies[hash] != nil, by: person, record: record, at: at, day: day)
    }

    private func sent(_ hash: String, video: Bool, by person: CannedHome.Member, record: HomeLink.DayFile.RecordRef, at: Int64, day: String) -> [String: Any] {
        let focus = "rec:\(record.source) \(record.kind) \(record.key)"
        return [
            "hash": hash, "kind": video ? "video" : "image",
            "play": video ? ["hash": hash, "media_type": "video/quicktime", "live": false] as [String: Any] : NSNull(),
            "at_ms": at, "unit": NSNull(), "day": day, "focus": focus, "caption": NSNull(), "people": [Any](), "size": NSNull(), "place": NSNull(), "area": NSNull(),
            "camera": NSNull(), "from": NSNull(),
            "chat": ["network": person.network, "chat": person.chat, "title": person.name, "group": false,
                     "sender": ["id": person.id, "name": person.name], "mine": false, "at_ms": at, "day": day,
                     "record": ["source": record.source, "kind": record.kind, "key": record.key], "focus": focus],
        ]
    }

    private static func photo(of id: String) -> [String: String]? {
        switch id {
        case "person:person-a" where !CannedHome.faces: ["crop": CannedHome.photoHash]
        case "person:person-c" where !CannedHome.faces: ["card": CannedHome.photoHash]
        default: CannedHome.portrait(of: id).map { ["crop": $0] }
        }
    }

    func placePhotos(_ slug: String, after: String?) -> [String: Any]? {
        guard let place = (places()["places"] as? [[String: Any]])?.first(where: { $0["slug"] as? String == slug }) else { return nil }
        let photos = photos(slug, visits(place))
        let from = after.flatMap(Int.init) ?? 0
        let page = Array(photos.dropFirst(from).prefix(60))
        var answer: [String: Any] = ["position": position, "photos": page]
        if from + page.count < photos.count { answer["next"] = String(from + page.count) }
        return answer
    }

    private static func scattered(_ latitude: Double, _ longitude: Double, seed: Int64) -> [String: Double] {
        let mixed = UInt64(bitPattern: seed / 60_000) &* 0x9E37_79B9_7F4A_7C15
        let turn = Double((mixed >> 40) % 360) * .pi / 180
        let far = 4 + Double((mixed >> 20) % 37) + ((mixed >> 8) % 9 == 0 ? 30 : 0)
        let north = far * cos(turn) / 111_320, east = far * sin(turn) / (111_320 * cos(latitude * .pi / 180))
        return ["latitude": latitude + north, "longitude": longitude + east]
    }

    private func visits(_ place: [String: Any]) -> [(start: Date, end: Date)] {
        if let spot = [CannedHome.home, CannedHome.office].first(where: { $0.slug == place["slug"] as? String }) {
            return laid(historyStart, now).filter { $0.at == spot }.map { ($0.start, $0.end) }.reversed()
        }
        guard let first = place["first_ms"] as? Int64, let last = place["last_ms"] as? Int64 else { return [] }
        let count = max(1, place["days"] as? Int ?? 1)
        let length = (place["hours"] as? Double ?? 1) / Double(count) * 3_600_000
        let gap = count > 1 ? Double(last - first) / Double(count - 1) : 0
        return (0..<count).map { index in
            let start = Date(timeIntervalSince1970: (Double(last) - gap * Double(index)) / 1000)
            return (start, start.addingTimeInterval(length / 1000))
        }
    }

    private func who(_ slug: String, _ start: Date) -> [String] {
        let weekday = calendar.component(.weekday, from: start)
        switch slug {
        case "the-office" where weekday == 3 || weekday == 5: return ["person:person-a"]
        case "the-office" where weekday == 6: return ["person:person-a", "person:person-b"]
        case "home-place" where weekday == 7, "corner-bakery": return ["person:person-c"]
        default: return []
        }
    }

    private func photos(_ slug: String, _ visits: [(start: Date, end: Date)]) -> [[String: Any]] {
        let taken = visits.count == 1 ? [visits[0].start.addingTimeInterval(1_200), visits[0].start.addingTimeInterval(600)]
            : visits.enumerated().filter { $0.offset % 2 == 0 }.map { $0.element.start.addingTimeInterval(600) }
        let scenes = StandInPhoto.Scene.allCases.filter { $0 != .face }.map { String(CannedHome.scene($0).dropFirst("sha256:".count)) }
        return taken.enumerated().map { ["image": scenes[$0.offset % scenes.count], "at_ms": Self.ms($0.element)] }
    }


    private var firstListed: String {
        let first = routine.first
        guard let last = days.last?.day, let span = offset(first, last) else { return first }
        return day(first, plus: -max(0, CannedScale.listed - span - 1))
    }

    private func day(_ day: String, plus count: Int) -> String {
        format.date(from: day).flatMap { calendar.date(byAdding: .day, value: count, to: $0) }.map { format.string(from: $0) } ?? day
    }

    private func offset(_ from: String, _ to: String) -> Int? {
        guard let start = format.date(from: from), let end = format.date(from: to) else { return nil }
        return calendar.dateComponents([.day], from: start, to: end).day
    }

    func file(_ day: String) -> HomeLink.DayFile? {
        if CannedHome.emptyHome { return nil }
        if let file = days.first(where: { $0.day == day }) { return file }
        guard let last = days.last?.day, day >= firstListed, day < last else { return nil }
        return CannedDays.file(day, routine)
    }

    func dayList(_ asked: CannedHome.Asked) -> [String: Any] {
        if CannedHome.emptyHome { return ["position": position, "days": [Any](), "total": 0] }
        let first = firstListed
        let total = days.last.flatMap { offset(first, $0.day) }.map { $0 + 1 } ?? 0
        let lower = max(0, asked.one("from").flatMap { offset(first, $0) } ?? 0,
                        asked.one("after").flatMap(Self.unpage).flatMap { offset(first, $0) }.map { $0 + 1 } ?? 0)
        let upper = min(total, asked.one("to").flatMap { offset(first, $0) }.map { $0 + 1 } ?? total)
        let limit = asked.one("limit").flatMap(Int.init) ?? 256
        let page = lower < upper ? (lower..<min(upper, lower + limit)).compactMap { file(day(first, plus: $0)) } : []
        var answer: [String: Any] = [
            "position": position,
            "days": page.map { ["day": $0.day, "inputs": $0.inputs, "counts": ["total": $0.counts.total, "per_family": $0.counts.perFamily]] },
        ]
        if lower + limit < upper, let last = page.last { answer["next"] = Self.page(last.day) }
        return answer
    }

    private func spoken(_ family: String, _ unit: String) -> [String: Any] {
        let day = unit.split(separator: "/").last.map(String.init) ?? ""
        let midnight = routine.midnight(of: day)
        let start = Int64((midnight.timeIntervalSince1970 + 16 * 3_600 + 60) * 1000)
        let evening = start + 4 * 3_600_000 - 60_000
        let plays: [[String: Any]] = family != "listening" ? []
            : unit.hasPrefix("now-playing:") ? [("Synthetic Song One", "Artist A", 0, 4), ("Synthetic Song Two", "Artist B", 4, 7), ("Synthetic Song Three", "Artist C", 7, 12),
                                              ("Synthetic Song Four", "Artist A", 12, 17), ("Synthetic Song Five", "Artist B", 17, 21), ("Synthetic Song Six", "Artist C", 21, 26),
                                              ("Synthetic Song Seven", "Artist A", 26, 31), ("Synthetic Song Eight", "Artist B", 31, 37), ("Synthetic Song Nine", "Artist C", 37, 42)]
                .map { title, artist, from, to in
                    ["start_ms": evening + Int64(from) * 60_000, "end_ms": evening + Int64(to) * 60_000, "title": title, "artist": artist] }
            : [["start_ms": start, "end_ms": start + 3_000_000, "title": "Synthetic Episode 12", "artist": "Synthetic Show"]]
        return ["family": family, "unit": unit, "reading": "canned", "content": ["plays": plays], "start_ms": start, "end_ms": start,
                "days": [String](), "items": [String]()]
    }

    func extracts(_ asked: CannedHome.Asked) -> [String: Any]? {
        let family = asked.one("family") ?? ""
        let rows = family == "health" ? sleep : family == "messages" ? chatDays : []
        if family == "listening" || family == "physical", let unit = asked.one("unit") {
            return ["position": position, "extracts": [spoken(family, unit)]]
        }
        if family == "screen", let unit = asked.one("unit") {
            let extract: [String: Any] = ["family": family, "unit": unit, "reading": "canned", "content": ["apps": [String]()],
                                          "start_ms": 0, "end_ms": 0, "days": [String](), "items": [String]()]
            return ["position": position, "extracts": [extract]]
        }
        if let unit = asked.one("unit") {
            guard let row = rows.first(where: { $0.unit == unit }) else { return nil }
            return ["position": position, "extracts": [Self.object(row)]]
        }
        let day = asked.one("day") ?? ""
        return ["position": position, "extracts": rows.filter { $0.days.contains(day) }.map(Self.object)]
    }

    var chatDays: [HomeLink.Extract] {
        days.flatMap { file -> [HomeLink.Extract] in
            let atoms = file.atoms.filter { $0.family == "messages" && $0.record != nil }
            return Dictionary(grouping: atoms, by: \.unit).sorted { $0.key < $1.key }.map { unit, atoms in
                let group = atoms.first?.block?.key.hasSuffix("@g.us") == true
                let mine = { (atom: HomeLink.DayFile.Atom) in atom.text.hasPrefix("the user: ") }
                var answered: [Int: HomeLink.DayFile.Atom] = [:]
                if !group {
                    for (index, atom) in atoms.enumerated() where index > 0 && mine(atom) && !mine(atoms[index - 1]) {
                        answered[atom.n] = atoms[index - 1]
                    }
                }
                let carrying = Set(answered.values.map(\.n))
                let messages: [HomeLink.JSON] = atoms.compactMap { atom in
                    guard let record = atom.record else { return nil }
                    let words = atom.text.range(of: ": ").map { String(atom.text[$0.upperBound...]) } ?? atom.text
                    var fact: [String: HomeLink.JSON] = [
                        "source": .string(record.source), "key": .string(record.key), "at": .number(Double(atom.startMs ?? 0)),
                        "from": .object(["id": .string(mine(atom) ? "me" : "other"), "kind": .string("handle")]),
                        "text": .string(words),
                    ]
                    if carrying.contains(atom.n) {
                        fact["parts"] = .array([.object(["what": .string("photo"), "blob": .string(CannedHome.photoHash), "media_type": .string("image/png")]),
                                                .object(["what": .string("video"), "blob": .string(CannedHome.video.hash), "media_type": .string("video/quicktime")])])
                    }
                    if let parent = answered[atom.n]?.record {
                        fact["reply_to"] = .string(parent.key)
                    }
                    return .object(fact)
                }
                return HomeLink.Extract(family: "messages", unit: unit, reading: "canned", content: .object(["messages": .array(messages)]),
                                        startMs: atoms.first?.startMs, endMs: atoms.last?.startMs, days: [file.day], items: [])
            }
        }
    }

    func conversation(_ asked: CannedHome.Asked) -> [String: Any]? {
        guard let chat = asked.one("chat"), let day = asked.one("day"), let file = days.first(where: { $0.day == day }) else { return nil }
        let title: String
        let atoms: [HomeLink.DayFile.Atom]
        if let line = file.atoms.first(where: { $0.family == "messages" && $0.block?.key == chat && $0.block?.title == CannedDays.quietHeading }),
           let group = CannedDays.quiet.first(where: { $0.group.chat == chat }) {
            title = group.group.label
            let id = String(chat.drop { $0 != ":" }.dropFirst())
            let senders = ["Person A", "Person B", "+15550000009"]
            atoms = (0..<group.count).map { index in
                HomeLink.DayFile.Atom(n: index + 1, family: "messages", unit: line.unit,
                                      startMs: file.window.startMs + Int64(9 * 3_600_000 + index * 240_000), endMs: nil,
                                      localStart: nil, localEnd: nil, flags: [],
                                      text: senders[index % senders.count] + ": "
                                          + ["Deals today only", "Is the shop open on Sunday?", "Yes, from ten", "Thanks!"][index % 4],
                                      record: .init(source: "whatsapp:15550000000:phone-aa01", kind: "msg", key: "\(id):\(day)-quiet-\(index)"),
                                      block: .init(key: chat, title: title))
            }
        } else {
            let said = file.atoms.filter { $0.family == "messages" && $0.block?.key == chat && $0.startMs != nil }
            title = said.first?.block?.title ?? chat
            atoms = said.enumerated().map { index, atom in
                HomeLink.DayFile.Atom(n: index + 1, family: atom.family, unit: atom.unit, startMs: atom.startMs, endMs: atom.endMs,
                                      localStart: atom.localStart, localEnd: atom.localEnd, flags: atom.flags, text: atom.text,
                                      record: atom.record, item: atom.item, block: atom.block)
            }
        }
        return ["position": position, "chat": chat, "day": day, "window": Self.object(file.window), "title": title, "atoms": atoms.map(Self.object), "messages": [Any]()]
    }


    var historyStart: Date { start(routine.first) }

    func laid(_ from: Date, _ to: Date) -> [CannedHome.Laid] {
        let end = min(to, now)
        guard end > from else { return [] }
        var pieces: [CannedHome.Laid] = []
        let first = max(from, historyStart)
        if end > first {
            for day in civilDays(civilDay(first), civilDay(end.addingTimeInterval(-0.001))) {
                for piece in routine.pieces(of: day) {
                    if var last = pieces.last, let at = last.at, at == piece.at, last.end == piece.start {
                        last.end = piece.end
                        last.units += piece.units
                        pieces[pieces.count - 1] = last
                    } else {
                        pieces.append(piece)
                    }
                }
            }
        }
        var out: [CannedHome.Laid] = []
        var cursor = from
        for piece in pieces {
            var clipped = piece
            clipped.start = max(piece.start, from)
            clipped.end = min(piece.end, end)
            guard clipped.end > clipped.start else { continue }
            if clipped.start > cursor { out.append(CannedHome.Laid.gap(cursor, clipped.start)) }
            out.append(clipped)
            cursor = clipped.end
        }
        if cursor < end { out.append(CannedHome.Laid.gap(cursor, end)) }
        return out
    }

    func `where`(_ asked: CannedHome.Asked) -> [String: Any] {
        var answer: [String: Any] = ["position": position]
        if let at = bound(asked.one("at"), end: false) {
            let around = laid(at.addingTimeInterval(-3 * 86_400), at.addingTimeInterval(3 * 86_400))
            let index = around.firstIndex { $0.start <= at && at < $0.end } ?? around.count - 1
            answer["at_ms"] = Self.ms(at)
            answer["piece"] = nullable(around.indices.contains(index) ? json(around[index]) : nil)
            if around.indices.contains(index), around[index].isGap {
                answer["before"] = nullable(around[..<index].last { !$0.isGap }.map(json))
                answer["after"] = nullable(around[(index + 1)...].first { !$0.isGap }.map(json))
            }
            return answer
        }
        let from = bound(asked.one("from"), end: false) ?? now
        let to = min(bound(asked.one("to"), end: true) ?? now, now)
        answer["from_ms"] = Self.ms(from)
        answer["to_ms"] = Self.ms(to)
        answer["pieces"] = laid(from, to).map(json)
        return answer
    }

    func labels(_ asked: CannedHome.Asked) -> [String: Any] {
        let spots = [CannedHome.home, CannedHome.office, CannedHome.spot, CannedHome.away, CannedHome.stop]
        let places = asked.all("point").map { point -> [Any] in
            let parts = point.split(separator: ",").prefix(2).compactMap { Double($0) }
            let latitude = parts.first ?? 0, longitude = parts.count > 1 ? parts[1] : 0
            let spot = spots.first { $0.latitude == latitude && $0.longitude == longitude }
            return [latitude, longitude, nullable(spot?.slug), nullable(spot?.slug == nil ? nil : spot?.words),
                    spot?.words ?? "an unnamed place"]
        }
        let chats = asked.all("chat").map { key -> [Any] in
            let member = CannedHome.cast.first { $0.chat == key }
            let group = key.hasSuffix("@g.us")
            let chat = key.split(separator: ":", maxSplits: 1).last.map(String.init) ?? ""
            let number = chat.split(separator: "@").first.map(String.init) ?? ""
            var open: Any = NSNull()
            if !group, key.hasPrefix("whatsapp:") { open = ["label": "Open in WhatsApp", "href": "https://wa.me/" + number] as [String: String] }
            if !group, key.hasPrefix("imessage:") { open = ["label": "Open in iMessage", "href": "imessage:" + chat] as [String: String] }
            var title: Any = NSNull()
            if let member { title = member.name } else if key == CannedHome.group.chat { title = CannedHome.group.label }
            return [key, title, group, open]
        }
        return ["names": [Any](), "chats": chats, "places": places]
    }

    private func json(_ piece: CannedHome.Laid) -> [String: Any] {
        func point(_ spot: CannedHome.Spot?) -> Any {
            nullable(spot.map { ["latitude": $0.latitude, "longitude": $0.longitude] as [String: Any] })
        }
        func named(_ spot: CannedHome.Spot?) -> Any {
            nullable(spot.map { ["words": $0.words, "area": $0.area.json] as [String: Any] })
        }
        var object: [String: Any] = [
            "start_ms": Self.ms(piece.start), "end_ms": Self.ms(piece.end), "level": "place", "how": "observed", "by": "Phone",
            "point": point(piece.at), "from": point(piece.from), "to": point(piece.to),
            "names": ["point": named(piece.at), "from": named(piece.from), "to": named(piece.to)],
        ]
        if piece.isGap {
            object["kind"] = "gap"
            object["level"] = NSNull()
            object["how"] = NSNull()
            object["by"] = nil
            object["units"] = [String]()
        } else if let at = piece.at {
            object["kind"] = "stay"
            object["units"] = piece.units
            object["spot"] = nullable(CannedHome.toName.contains(at) ? Self.key(at.latitude, at.longitude) : nil)
            object["walks"] = [Any]()
            object["silences"] = [Any]()
            if piece.end >= now.addingTimeInterval(-60) { object["open"] = true }
        } else {
            object["kind"] = "move"
            object["units"] = piece.units
            object["distance_m"] = piece.distance
            object["legs"] = [["start_ms": Self.ms(piece.start), "end_ms": Self.ms(piece.end), "mode": piece.mode,
                               "distance_m": piece.distance, "motion": NSNull(), "stated": NSNull()]]
        }
        return object
    }

    private var atoms: [(day: String, atom: HomeLink.DayFile.Atom)] {
        let older = [75, 45].map { routine.day(back: $0) }.filter { day in !days.contains { $0.day == day } }
            .map { CannedDays.file($0, routine) }
        return (older + days).flatMap { file in file.atoms.map { (file.day, $0) } }
    }

    func search(_ asked: CannedHome.Asked) -> [String: Any] {
        guard let cursor = asked.one("cursor") else { return ["record": record(asked, from: 0)] }
        let parts = cursor.split(separator: "|", maxSplits: 1).map(String.init)
        guard parts.count == 2, let at = Int(parts[0]), let query = URL(string: "https://home.invalid/v1/search?" + parts[1])
        else { return [:] }
        return ["record": record(CannedHome.Asked(query), from: at)]
    }

    private static var olderOnly: Bool { AppRuntime.asked("--ui-test-search-older-only") }

    private static func continued(_ asked: CannedHome.Asked) -> String {
        var parts = URLComponents()
        parts.queryItems = asked.items.filter { $0.name != "cursor" }
        return parts.percentEncodedQuery ?? ""
    }

    private func matching(_ asked: CannedHome.Asked, families: [String]) -> [(day: String, atom: HomeLink.DayFile.Atom)] {
        let text = (asked.one("query") ?? "").trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "\"", with: "")
        let (first, last) = (asked.one("from"), asked.one("to"))
        let from = bound(first, end: false), to = bound(last, end: true)
        let isDay = { (text: String) in text.wholeMatch(of: /\d{4}-\d{2}-\d{2}/) != nil }
        let members = asked.all("person").compactMap { id in CannedHome.cast.first { $0.id == id || $0.name == id } }
        var found = atoms.filter { entry in
            let atom = entry.atom
            let at = atom.startMs.map { Date(timeIntervalSince1970: Double($0) / 1000) } ?? start(entry.day)
            return (text.isEmpty || atom.text.range(of: text, options: [.caseInsensitive, .diacriticInsensitive]) != nil)
                && (families.isEmpty || families.contains(atom.family))
                && (first.map { isDay($0) ? entry.day >= $0 : from.map { at >= $0 } ?? true } ?? true)
                && (last.map { isDay($0) ? entry.day <= $0 : to.map { at < $0 } ?? true } ?? true)
                && (members.isEmpty || members.contains { Self.from($0, atom) || atom.block?.title == $0.name || atom.text.contains($0.name) })
        }
        found.sort { ($0.atom.startMs ?? 0, $0.day) > ($1.atom.startMs ?? 0, $1.day) }
        if asked.one("order") == "oldest" { found.reverse() }
        return found
    }

    private func record(_ asked: CannedHome.Asked, from offset: Int) -> [String: Any] {
        let text = (asked.one("query") ?? "").trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "\"", with: "")
        let found = Self.olderOnly ? [] : matching(asked, families: asked.all("families"))
        let limit = asked.one("limit").flatMap(Int.init) ?? 20
        let page = found.dropFirst(offset).prefix(limit)
        var families: [String: Int] = [:], months: [String: Int] = [:]
        for entry in found {
            families[entry.atom.family, default: 0] += 1
            months[String(entry.day.prefix(7)), default: 0] += 1
        }
        var list: [String: Any] = [
            "as_of": "2026-11-14T22:10+00:00", "total": found.count,
            "hits": page.map { hit($0, words: text) },
            "spread": ["families": families, "months": months],
            "next": found.count > offset + limit ? "\(offset + limit)|" + Self.continued(asked) : NSNull() as Any,
        ]
        if CannedHome.searchReady.pendingToday { list["pending"] = [["day": civilDay(now), "why": "new"]] }
        return list
    }

    private func hit(_ entry: (day: String, atom: HomeLink.DayFile.Atom), words: String) -> [String: Any] {
        let atom = entry.atom
        var hit: [String: Any] = ["ref": "record.canned-\(entry.day)-\(atom.n)", "day": entry.day, "family": atom.family,
                                  "title": Self.title(atom), "snippet": Self.snippet(atom.text, words)]
        if let ms = atom.startMs, !atom.flags.contains("date_only") { hit["at"] = instant(ms) }
        if let record = atom.record { hit["product"] = String(record.source.prefix { $0 != ":" }) }
        if let sender = CannedHome.cast.first(where: { Self.from($0, atom) }) { hit["from"] = sender.name }
        if atom.family == "messages", let block = atom.block {
            hit["chat"] = "chat.canned-" + block.key
            hit["chat_title"] = block.title
        }
        return hit
    }

    private func instant(_ ms: Int64) -> String {
        let format = DateFormatter()
        format.calendar = Calendar(identifier: .gregorian)
        format.timeZone = zone
        format.locale = Locale(identifier: "en_US_POSIX")
        format.dateFormat = "yyyy-MM-dd'T'HH:mmxxx"
        return format.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }

    private static func window(_ text: String) -> (app: String, title: String) {
        if let found = text.firstMatch(of: /^(\w+): visited ([^:]+): "(.*)"/) { return (String(found.1), String(found.3)) }
        if let found = text.firstMatch(of: /\[(.*)\] in (\w+)/) { return (String(found.2), String(found.1)) }
        return ("Screen", String(text.prefix(40)))
    }

    private func goto(_ words: String) -> [String: Any] {
        let asked = words.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        func named(_ name: String) -> Bool {
            let own = name.lowercased().split { $0.isWhitespace || $0 == "-" }
            return !asked.isEmpty && asked.allSatisfy { word in own.contains { $0.hasPrefix(word) } }
        }
        let people = CannedHome.cast.filter { named($0.name) }.prefix(3)
            .map { ["ref": Self.personRef + $0.slug, "name": $0.name] }
        let spots = ((places()["places"] as? [[String: Any]]) ?? []).filter { named($0["name"] as? String ?? "") }.prefix(3)
            .map { ["ref": Self.placeRef + ($0["slug"] as? String ?? ""), "name": $0["name"] as? String ?? ""] }
        let today = civilDay(now)
        let lowered = words.trimmingCharacters(in: .whitespaces).lowercased()
        let day: String? = lowered == "today" ? today : lowered == "yesterday" ? Words.shiftDay(today, -1)
            : lowered.wholeMatch(of: /\d{4}-\d{2}-\d{2}/) != nil ? lowered : nil
        return ["people": Array(people), "places": Array(spots), "day": nullable(day), "month": NSNull()]
    }

    private static let personRef = "person.canned-", placeRef = "place.canned-"

    func describe(_ refs: [String]) -> [String: Any] {
        let spots = (places()["places"] as? [[String: Any]]) ?? []
        return ["described": refs.map { ref -> [String: Any] in
            if ref.hasPrefix(Self.personRef), let member = CannedHome.cast.first(where: { Self.personRef + $0.slug == ref }) {
                return ["ref": ref, "kind": "person", "name": member.name, "opens": ["page": "people", "id": member.handle.kind + ":" + member.handle.value]]
            }
            if ref.hasPrefix(Self.placeRef), let spot = spots.first(where: { Self.placeRef + ($0["slug"] as? String ?? "") == ref }) {
                return ["ref": ref, "kind": "place", "name": spot["name"] as? String ?? "",
                        "opens": ["page": "places", "id": spot["slug"] as? String ?? ""]]
            }
            if let entry = atoms.first(where: { "record.canned-\($0.day)-\($0.atom.n)" == ref }) {
                var opens: [String: Any] = ["page": "days", "day": entry.day]
                if let record = entry.atom.record { opens["focus"] = "rec:\(record.source) \(record.kind) \(record.key)" }
                return ["ref": ref, "kind": "record", "day": entry.day, "title": Self.title(entry.atom), "opens": opens]
            }
            if let entry = atoms.first(where: { "window.canned-\($0.day)-\($0.atom.n)" == ref }), let ms = entry.atom.startMs {
                let minute = ms - ms % 60_000
                return ["ref": ref, "kind": "window", "day": entry.day, "app": Self.window(entry.atom.text).app, "title": Self.window(entry.atom.text).title,
                        "opens": ["page": "days", "day": entry.day, "focus": "u:\(entry.atom.block?.key ?? entry.atom.unit)@\(minute)-\(minute + 60_000)"]]
            }
            return ["ref": ref, "kind": "gone", "why": "this record is no longer held"]
        }]
    }

    func kinds(_ asked: CannedHome.Asked) -> [String: Any] {
        let text = (asked.one("query") ?? "").trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "\"", with: "")
        let found = Self.olderOnly ? [] : matching(asked, families: [])
        let today = civilDay(now)
        let named = goto(text)
        let people = ((named["people"] as? [[String: Any]]) ?? []).map { entry -> [String: Any] in
            let member = CannedHome.cast.first { Self.personRef + $0.slug == entry["ref"] as? String }
            let said = member.map { member in atoms.filter { Self.from(member, $0.atom) }.count } ?? 0
            return ["person": ["ref": entry["ref"] ?? "", "name": entry["name"] ?? "", "messages": said]]
        }
        let spots = ((named["places"] as? [[String: Any]]) ?? []).map { entry -> [String: Any] in
            let slug = (entry["ref"] as? String ?? "").replacingOccurrences(of: Self.placeRef, with: "")
            let days = ((places()["places"] as? [[String: Any]]) ?? []).first { $0["slug"] as? String == slug }?["days"] as? Int ?? 0
            return ["place": ["ref": entry["ref"] ?? "", "name": entry["name"] ?? "", "days": days]]
        }
        let records = found.filter { !["listening", "screen"].contains($0.atom.family) }
        let named3 = Array((people + spots).prefix(3))
        let topHits = Array(records.prefix(max(0, 3 - named3.count)))
        let inTop = Set(topHits.map { "\($0.day)-\($0.atom.n)" })
        var kinds: [[String: Any]] = []
        for family in Set(records.map(\.atom.family)) {
            let all = records.filter { $0.atom.family == family }
            var kind: [String: Any] = ["family": family, "n": all.count,
                                       "hits": all.filter { !inTop.contains("\($0.day)-\($0.atom.n)") }.prefix(3).map { kindsHit($0, words: text) }]
            let upcoming = all.filter { $0.day > today }.count
            if upcoming > 0 { kind["upcoming"] = upcoming }
            kinds.append(kind)
        }
        let heard = plays(text, match: [:])
        if !heard.isEmpty { kinds.append(["family": "listening", "n": heard.count, "tracks": Array(tracks(heard).prefix(3))]) }
        let screen = sittings(asked)
        if !screen.isEmpty { kinds.append(["family": "screen", "n": screen.count, "sittings": Array(screen.prefix(3))]) }
        kinds.sort { ($1["n"] as? Int ?? 0, $0["family"] as? String ?? "") < ($0["n"] as? Int ?? 0, $1["family"] as? String ?? "") }
        var answer: [String: Any] = ["as_of": "2026-11-14T22:10+00:00", "held": ["first": routine.day(back: 75), "last": today],
                                     "total": kinds.reduce(0) { $0 + ($1["n"] as? Int ?? 0) },
                                     "top": named3 + topHits.map { ["hit": kindsHit($0, words: text)] }, "kinds": kinds]
        if let day = named["day"] as? String { answer["day"] = day }
        if let month = named["month"] as? String { answer["month"] = month }
        if CannedHome.searchReady.pendingToday { answer["pending"] = [["day": today, "why": "new"]] }
        return answer
    }

    private static let seePage = 40

    func kindsPage(_ asked: CannedHome.Asked) -> [String: Any] {
        var asked = asked, offset = 0
        if let cursor = asked.one("cursor") {
            let parts = cursor.split(separator: "|", maxSplits: 1).map(String.init)
            guard parts.count == 2, let at = Int(parts[0]), let query = URL(string: "https://home.invalid/v1/search/kinds?" + parts[1])
            else { return [:] }
            asked = CannedHome.Asked(query)
            offset = at
        }
        let family = asked.one("see") ?? ""
        let text = (asked.one("query") ?? "").trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "\"", with: "")
        switch family {
        case "listening":
            return ["family": family, "tracks": tracks(plays(text, match: [:])), "next": NSNull()]
        case "screen":
            return ["family": family, "sittings": sittings(asked), "next": NSNull()]
        default:
            let today = civilDay(now), upcoming = asked.one("upcoming") == "1"
            var found = (Self.olderOnly ? [] : matching(asked, families: [family])).filter { upcoming ? $0.day > today : $0.day <= today }
            if upcoming { found.reverse() }
            var page: [String: Any] = ["family": family, "hits": found.dropFirst(offset).prefix(Self.seePage).map { kindsHit($0, words: text) },
                                       "next": found.count > offset + Self.seePage ? "\(offset + Self.seePage)|" + Self.continued(asked) : NSNull() as Any]
            if upcoming { page["upcoming"] = true }
            if CannedHome.searchReady.pendingToday { page["pending"] = [["day": today, "why": "new"]] }
            return page
        }
    }

    func searchPage(_ asked: CannedHome.Asked, readying: Int?) -> [String: Any] {
        let today = civilDay(now)
        var page: [String: Any] = ["position": "1:\(Int64(now.timeIntervalSince1970 * 1000))", "today": today, "held": NSNull(), "nothing": NSNull()]
        if let readying {
            page.merge(["top": [Any](), "kinds": [Any](), "total": ["n": 0, "partial": false],
                        "reading": ["state": "building", "line": "Search is getting ready: \(readying)% read", "percent": readying]]) { $1 }
            return page
        }
        let found = kinds(asked)
        let top = (found["top"] as? [[String: Any]]) ?? []
        let sections = (found["kinds"] as? [[String: Any]]) ?? []
        let opens = pageOpens(top.compactMap { ($0.values.first as? [String: Any])?["ref"] as? String } + sections.flatMap(Self.refs))
        var rows: [[String: Any]] = (found["day"] as? String).map { day in
            [["kind": "date", "when": ["kind": "day", "day": day], "opens": ["page": "days", "day": day, "focus": NSNull()]]]
        } ?? []
        rows += top.compactMap { row -> [String: Any]? in
            if let person = row["person"] as? [String: Any], let ref = person["ref"] as? String {
                let said = opens[ref] as? [String: Any]
                let member = CannedHome.cast.first { $0.handle.kind + ":" + $0.handle.value == said?["id"] as? String }
                return ["kind": "person", "ref": ref, "name": person["name"] ?? "", "line": Words.count(person["messages"] as? Int ?? 0, "message"),
                        "picture": nullable(member.flatMap(Self.face)), "opens": said.map { $0.merging(["person": nullable(member?.id)]) { $1 } } ?? NSNull()]
            }
            if let place = row["place"] as? [String: Any], let ref = place["ref"] as? String {
                return ["kind": "place", "ref": ref, "name": place["name"] ?? "", "line": Words.count(place["days"] as? Int ?? 0, "day"), "opens": opens[ref] ?? NSNull()]
            }
            return (row["hit"] as? [String: Any]).map { Self.hitRow($0, opens) }
        }
        let kinds = sections.map { section -> [String: Any] in
            let shown = Self.rows(section, opens)
            let n = section["n"] as? Int ?? 0
            let family = section["family"] as? String ?? ""
            return ["family": family, "title": SearchWords.family(family).label, "count": ["n": n, "partial": false],
                    "upcoming": nullable((section["upcoming"] as? Int).map { ["n": $0, "partial": false] as [String: Any] }),
                    "see": n > shown.count, "unread": section["unread"] ?? NSNull(), "rows": shown]
        }
        page["top"] = rows
        page["kinds"] = kinds
        page["total"] = ["n": found["total"] as? Int ?? 0, "partial": false]
        page["held"] = found["held"] ?? NSNull()
        page["reading"] = Self.behind(found, today: today)
        if rows.isEmpty && kinds.isEmpty { page["nothing"] = "Nothing matches \u{201C}\((asked.one("query") ?? "").trimmingCharacters(in: .whitespaces))\u{201D}." }
        return page
    }

    func searchKindPage(_ asked: CannedHome.Asked, readying: Int?) -> [String: Any] {
        let family = asked.one("see") ?? ""
        var page: [String: Any] = ["position": "1:\(Int64(now.timeIntervalSince1970 * 1000))", "today": civilDay(now), "unread": NSNull(), "nothing": NSNull()]
        if let readying {
            page.merge(["family": family, "title": SearchWords.family(family).label, "upcoming": asked.one("upcoming") == "1", "rows": [Any](),
                        "next": NSNull(), "reading": ["state": "building", "line": "Search is getting ready: \(readying)% read", "percent": readying]]) { $1 }
            return page
        }
        let read = kindsPage(asked)
        let seen = read["family"] as? String ?? family
        let rows = Self.rows(read, pageOpens(Self.refs(read)))
        page.merge(["family": seen, "title": SearchWords.family(seen).label, "upcoming": read["upcoming"] as? Bool ?? false, "rows": rows,
                    "next": read["next"] ?? NSNull(), "reading": Self.behind(read, today: civilDay(now))]) { $1 }
        if rows.isEmpty && asked.one("cursor") == nil {
            page["nothing"] = "Nothing matches \u{201C}\((asked.one("query") ?? "").trimmingCharacters(in: .whitespaces))\u{201D}."
        }
        return page
    }

    private func pageOpens(_ refs: [String]) -> [String: Any] {
        var opens: [String: Any] = [:]
        for each in (describe(refs)["described"] as? [[String: Any]]) ?? [] {
            guard let ref = each["ref"] as? String, var said = each["opens"] as? [String: Any] else { continue }
            switch said["page"] as? String {
            case "days": said = said.merging(["focus": said["focus"] ?? NSNull()]) { $1 }
            case "people": said = said.merging(["person": said["person"] ?? NSNull(), "group": said["group"] ?? NSNull()]) { $1 }
            default: break
            }
            opens[ref] = said
        }
        return opens
    }

    private static func refs(_ kind: [String: Any]) -> [String] {
        let hits = ((kind["hits"] as? [[String: Any]]) ?? []).compactMap { $0["ref"] as? String }
        let windows = ((kind["sittings"] as? [[String: Any]]) ?? []).flatMap { ($0["matched"] as? [[String: Any]]) ?? [] }.compactMap { $0["ref"] as? String }
        return hits + windows
    }

    private static func rows(_ kind: [String: Any], _ opens: [String: Any]) -> [[String: Any]] {
        if let hits = kind["hits"] as? [[String: Any]] { return hits.map { hitRow($0, opens) } }
        if let tracks = kind["tracks"] as? [[String: Any]] {
            return tracks.map { track in
                let artist = track["artist"] as? String
                return ["kind": "track", "ref": track["ref"] ?? "", "title": track["track"] ?? "", "artist": nullable(artist),
                        "line": [Words.count(track["plays"] as? Int ?? 0, "play"), artist].compactMap { $0 }.joined(separator: Words.dot)]
            }
        }
        return ((kind["sittings"] as? [[String: Any]]) ?? []).map { sitting in
            let matched = (sitting["matched"] as? [[String: Any]]) ?? []
            let windows = Words.count(sitting["windows"] as? Int ?? 0, "window")
            let first = matched.first
            let said = sitting["snippet"] as? String
            return ["kind": "sitting", "key": sitting["focus"] ?? "", "title": sitting["summary"] ?? first?["title"] ?? "Mac",
                    "line": nullable(first.map { [windows, $0["app"] as? String ?? "", $0["snippet"] as? String ?? ""].joined(separator: Words.dot) } ?? said),
                    "said": nullable(said), "when": when(sitting["at"] as? String, day: sitting["day"] as? String),
                    "windows": matched.map { window in
                        ["ref": window["ref"] ?? "", "app": window["app"] ?? "", "title": window["title"] ?? "",
                         "line": [window["app"] as? String ?? "", window["snippet"] as? String ?? ""].joined(separator: Words.dot),
                         "when": when(window["at"] as? String, day: nil), "opens": opens[window["ref"] as? String ?? ""] ?? NSNull()] as [String: Any]
                    },
                    "windows_line": first == nil ? NSNull() as Any : windows,
                    "opens": ["page": "days", "day": sitting["day"] ?? "", "focus": sitting["focus"] ?? NSNull()]]
        }
    }

    private static func hitRow(_ hit: [String: Any], _ opens: [String: Any]) -> [String: Any] {
        let ref = hit["ref"] as? String ?? ""
        let family = hit["family"] as? String ?? ""
        let title = (hit["chat_title"] as? String) ?? (hit["title"] as? String) ?? ""
        let snippet = hit["snippet"] as? String ?? ""
        let speaker = (hit["from"] as? String).map(SearchWords.who).flatMap { family == "messages" && $0 != title ? $0 : nil }
        let line = speaker.map { "\($0): \(snippet)" } ?? snippet
        return ["kind": "hit", "ref": ref, "family": family, "title": title.isEmpty ? SearchWords.family(family).label : title,
                "line": line.isEmpty ? NSNull() as Any : line, "when": when(hit["at"] as? String, day: hit["day"] as? String),
                "picture": hit["image"] ?? NSNull(), "opens": opens[ref] ?? NSNull()]
    }

    private static func when(_ at: String?, day: String?) -> Any {
        if let instant = SearchWords.instant(at) { return ["kind": "at", "at_ms": Int64((instant.timeIntervalSince1970 * 1000).rounded(.down))] }
        return day.map { ["kind": "day", "day": $0] } ?? NSNull()
    }

    private static func behind(_ read: [String: Any], today: String) -> Any {
        guard read["pending"] != nil else { return NSNull() }
        return ["state": "behind", "line": "Still reading", "newest": ["kind": "day", "day": today]]
    }

    private func tracks(_ heard: [Play]) -> [[String: Any]] {
        Dictionary(grouping: heard) { $0.track + "\u{0}" + ($0.artist ?? "") }.values
            .map { group in (group[0], group.count) }.sorted { ($1.1, $0.0.track) < ($0.1, $1.0.track) }
            .map { play, count in
                var track: [String: Any] = ["ref": "row.canned-\(play.track)", "track": play.track, "plays": count]
                if let artist = play.artist { track["artist"] = artist }
                return track
            }
    }

    private func kindsHit(_ entry: (day: String, atom: HomeLink.DayFile.Atom), words: String) -> [String: Any] {
        var said = hit(entry, words: words)
        if entry.atom.family == "photos", let item = entry.atom.item, item.hasPrefix("photo:") {
            said["image"] = "sha256:" + item.dropFirst("photo:".count)
        }
        return said
    }

    func sittings(_ asked: CannedHome.Asked) -> [[String: Any]] {
        let text = (asked.one("query") ?? "").trimmingCharacters(in: .whitespaces)
        let held = atoms
        var drawn: Set<String> = []
        return (Self.olderOnly ? [] : matching(asked, families: ["screen", "web"])).compactMap { entry in
            let unit = entry.atom.block?.key ?? entry.atom.unit
            guard let ms = entry.atom.startMs, drawn.insert(unit).inserted else { return nil }
            let line = held.first { $0.day == entry.day && $0.atom.family == "screen" && $0.atom.unit == unit }?.atom ?? entry.atom
            let window = Self.window(entry.atom.text)
            var sitting: [String: Any] = ["focus": "u:" + unit, "at": instant(line.startMs ?? ms), "day": entry.day, "summary": Self.title(line),
                                          "windows": 1,
                                          "matched": [["ref": "window.canned-\(entry.day)-\(entry.atom.n)", "at": instant(ms), "app": window.app,
                                                       "title": window.title, "snippet": Self.snippet(entry.atom.text, text),
                                                       "focus": "u:\(unit)@\(ms)-\(ms + 60_000)"]]]
            if entry.atom.family == "screen" { sitting["snippet"] = Self.snippet(entry.atom.text, text) }
            return sitting
        }
    }

    private struct Play {
        let track: String
        let artist: String?
        let at: String
        let day: String
        let app: String
    }

    private func plays(_ words: String, match: [String: String]) -> [Play] {
        atoms.filter { $0.atom.family == "listening" }.compactMap { entry -> Play? in
            guard let ms = entry.atom.startMs, let said = entry.atom.text.split(separator: ":", maxSplits: 1).last else { return nil }
            let halves = said.trimmingCharacters(in: .whitespaces).components(separatedBy: " by ")
            let play = Play(track: halves[0], artist: halves.count > 1 ? halves[1].components(separatedBy: ",")[0] : nil, at: instant(ms), day: entry.day,
                            app: String(entry.atom.text.prefix { $0 != " " }))
            let fits = (words.isEmpty || entry.atom.text.range(of: words, options: [.caseInsensitive, .diacriticInsensitive]) != nil)
                && match["track"].map { $0 == "=" + play.track } ?? true && match["artist"].map { $0 == "=" + (play.artist ?? "") } ?? true
            return fits ? play : nil
        }.sorted { $0.at > $1.at }
    }

    private func playsCount(_ asked: CannedHome.Asked) -> [String: Any] {
        let match = Dictionary(asked.items.filter { $0.name.hasPrefix("match.") }.map { (String($0.name.dropFirst(6)), $0.value ?? "") }) { one, _ in one }
        var found = plays(asked.one("words") ?? "", match: match)
        if let from = asked.one("from") { found = found.filter { $0.day >= from } }
        if let to = asked.one("to") { found = found.filter { $0.day <= to } }
        let by = asked.all("by")
        let columns: [String], rows: [[Any]]
        if by.first == "month" {
            let artists = by.contains("artist")
            columns = ["month"] + (artists ? ["artist"] : []) + ["n", "sum", "missing", "ref"]
            rows = Dictionary(grouping: found) { String($0.day.prefix(7)) + (artists ? "\u{0}" + ($0.artist ?? "") : "") }.sorted { $0.key < $1.key }
                .map { group -> [Any] in
                    let play = group.value[0], month = String(play.day.prefix(7))
                    return [month] + (artists ? [play.artist.map { $0 as Any } ?? NSNull()] : [])
                        + [group.value.count, group.value.count, 0, "row.canned-month-\(month)"]
                }
        } else if by == ["item"] {
            columns = ["time", "track", "artist", "album", "app", "device", "minutes", "times", "ref"]
            rows = found.reversed().map { play -> [Any] in
                [play.at, play.track, play.artist.map { $0 as Any } ?? NSNull(), NSNull(), play.app, "iphone-aa01", "4 min", 1, "record.canned-play-\(play.at)"]
            }
        } else {
            columns = ["track", "artist", "n", "sum", "missing", "ref"]
            rows = Dictionary(grouping: found) { $0.track + "\u{0}" + ($0.artist ?? "") }.values.sorted { $0.count > $1.count }
                .map { group -> [Any] in
                    [group[0].track, group[0].artist.map { $0 as Any } ?? NSNull(), group.count, group.count, 0, "row.canned-\(group[0].track)"]
                }
        }
        return ["asked": "sum of times over plays", "population": ["facts": found.count, "valued": found.count, "missing": 0, "excluded": [:]],
                "counted": "counted from the canned home's days", "columns": columns, "rows": rows, "as_of": "2026-11-14T22:10+00:00",
                "total": ["n": found.count, "sum": found.count], "next": NSNull()]
    }

    func count(_ asked: CannedHome.Asked) -> [String: Any] {
        if asked.one("of") == "plays" { return playsCount(asked) }
        let found = matching(asked, families: [asked.one("of") == "calls" ? "calls" : asked.one("of") ?? ""])
        return ["asked": "count of \(asked.one("of") ?? "")", "population": ["facts": found.count, "valued": found.count, "missing": 0, "excluded": [:]],
                "counted": "counted from the canned home's days", "columns": ["day", "ref"],
                "rows": found.map { [$0.day, "record.canned-\($0.day)-\($0.atom.n)"] }, "as_of": "2026-11-14T22:10+00:00",
                "total": ["n": found.count]]
    }

    static func title(_ atom: HomeLink.DayFile.Atom) -> String {
        if let block = atom.block?.title { return block }
        if let open = atom.text.firstIndex(of: "“"), let close = atom.text[open...].firstIndex(of: "”") {
            return String(atom.text[atom.text.index(after: open)..<close])
        }
        let clause = atom.text.prefix { !",:—\n".contains($0) }.trimmingCharacters(in: .whitespaces)
        return String(clause.prefix(60))
    }

    private static func snippet(_ words: String, _ match: String) -> String {
        guard !match.isEmpty, let range = words.range(of: match, options: [.caseInsensitive, .diacriticInsensitive]) else { return words }
        return words[..<range.lowerBound] + "«" + words[range] + "»" + words[range.upperBound...]
    }


    private static func from(_ member: CannedHome.Member, _ atom: HomeLink.DayFile.Atom) -> Bool {
        atom.text.hasPrefix(member.name + ":")
    }

    private static func mine(_ atom: HomeLink.DayFile.Atom) -> Bool {
        !CannedHome.cast.contains { from($0, atom) }
    }

    private func person(_ member: CannedHome.Member, days withDays: Bool) -> [String: Any] {
        let received = atoms.filter { Self.from(member, $0.atom) && [member.name, CannedHome.group.label].contains($0.atom.block?.title) }
        let others = member.slug == "person-a" ? CannedHome.moreGroups + CannedHome.quietGroups
            : member.slug == "person-b" ? Array(CannedHome.quietGroups.prefix(1)) : []
        let chats = ([(member.chat, member.name)] + (CannedHome.group.members.contains(member.slug) ? [(CannedHome.group.chat, CannedHome.group.label)] : []))
            .map { key, label in (key: key, count: received.filter { $0.atom.block?.title == label }.count) }
            .filter { $0.count > 0 }
            .map { ["key": $0.key, "count": $0.count] as [String: Any] }
            + others.map { ["key": $0.chat, "count": $0.theirs] as [String: Any] }
        let sent = atoms.filter { $0.atom.block?.title == member.name && Self.mine($0.atom) }
        let touch = received + sent
        var days: [String: Int] = [:]
        for entry in received { days[entry.day, default: 0] += 1 }
        let times = touch.compactMap(\.atom.startMs)
        let since = atoms.map(\.day).max().map { civilDay(start($0).addingTimeInterval(12 * 3600 - 29 * 86_400)) } ?? ""
        var object: [String: Any] = [
            "id": member.id, "name": member.name, "call_name": member.name, "full_name": NSNull(), "show": "name", "by": "registry",
            "person": member.slug, "entity": "person", "entity_by": "home", "me": false, "hidden": false, "organised": true,
            "handles": [Self.handle(member.handle, from: "Contacts")]
                + (member.slug == "person-a" ? [Self.handle(("email", "person-a.home@example.com"), from: "Contacts")] : []),
            "networks": [member.network], "chats": chats, "received": received.count, "sent": sent.count,
            "first_ms": nullable(times.min()), "last_ms": nullable(times.max()),
            "last_30": days.filter { $0.key >= since }.values.reduce(0, +), "days_count": days.count,
            "last_day": received.map(\.day).max().map { last in received.filter { $0.day == last }.count } ?? 0,
        ]
        object.merge(stated(member, whole: withDays)) { _, stated in stated }
        if Self.photoListed(member) { object["photo"] = Self.photo(of: member.id) }
        if withDays {
            object["days"] = days
            object.merge(Self.offered(member)) { _, offered in offered }
        }
        return object
    }

    private static func offered(_ member: CannedHome.Member) -> [String: Any] {
        switch member.slug {
        case "person-a":
            return ["suggestions": [
                ["id": "a0000000000000f1", "kind": "full_name", "value": "Person A Example", "reasons": ["whatsapp": 1, "mail": 4], "ticked": true],
                ["id": "a0000000000000e1", "kind": "handle", "value": "email:person-a.work@example.com",
                 "reasons": ["mails_from": 6, "mails_to": 2], "ticked": false],
            ], "names_seen": ["Person A", "Person A Example"],
               "also_called": [["name": "Ace", "from": "You added"], ["name": "P.A.", "from": "Contacts"]],
               "joined": [
                ["id": "person:person-a-home", "name": "Person A Home", "photo": NSNull(), "handles": ["email:person-a.home@example.com"],
                 "with": [Any]()],
                ["id": "person:person-a-school", "name": "Person A School", "photo": NSNull(), "handles": [Any](),
                 "with": ["Person A Class"]],
               ]]
        case "person-c":
            return ["suggestions": [["id": "c0000000000000b1", "kind": "birthday", "value": "09-01", "reasons": ["wished": 3], "ticked": false]],
                    "names_seen": ["Person C"]]
        default:
            return ["suggestions": [Any](), "names_seen": [member.name]]
        }
    }

    private func stated(_ member: CannedHome.Member, whole: Bool) -> [String: Any] {
        func birthday(in days: Double) -> [String: Any] {
            let day = civilDay(now.addingTimeInterval(days * 86_400))
            return ["month": Int(day.dropFirst(5).prefix(2)) ?? 1, "day": Int(day.suffix(2)) ?? 1, "year": NSNull()]
        }
        switch member.slug {
        case "person-a":
            let work = "Community lead, Northern Harbour Synthetic Supporters' Club (Coast District)"
            var said: [String: Any] = ["relationship": "Friend from college", "work": work]
            if whole {
                said["details"] = ["work": work, "birthday": birthday(in: 3),
                                   "profiles": [["network": "instagram", "value": "person.a"], ["network": "site", "value": "example.com/person-a"]]]
            }
            return said
        case "person-b":
            return whole ? ["details": ["work": NSNull(), "birthday": birthday(in: 40), "profiles": [Any]()]] : [:]
        default:
            return [:]
        }
    }

    func personPhotos(_ id: String, after: String?) -> [String: Any]? {
        guard person(id) != nil else { return nil }
        let count = switch id {
        case "person:person-a": 70
        case "person:person-b": 2
        case CannedHome.You.id: CannedHome.You.photos
        default: 0
        }
        let theirs = CannedHome.theirPhotos
        let all: [[String: Any]] = (0..<count).map { index in
            let photo = theirs[index % theirs.count]
            let image = String(photo.hash.dropFirst("sha256:".count))
            return ["image": image, "face": image + ":" + photo.box.map { String(Int($0)) }.joined(separator: ","), "box": photo.box,
                    "at_ms": Self.ms(now.addingTimeInterval(-Double(index) * 3_600)), "crop": NSNull(), "camera": true]
        }
        let from = after.flatMap(Int.init) ?? 0
        let page = Array(all.dropFirst(from).prefix(60))
        var answer: [String: Any] = ["position": position, "photos": page, "total": all.count]
        if from + page.count < all.count { answer["next"] = String(from + page.count) }
        return answer
    }

    private func you(whole: Bool) -> [String: Any] {
        typealias You = CannedHome.You
        var object: [String: Any] = [
            "id": You.id, "name": You.name, "call_name": You.name, "full_name": You.fullName, "show": "name", "by": "registry",
            "person": "sam-example", "entity": "person", "entity_by": "you", "relationship": NSNull(), "me": true, "hidden": false,
            "organised": true, "card": false, "score": 0,
            "handles": You.handles.map { handle -> [String: Any] in
                var served = Self.handle((handle.kind, handle.value), from: handle.from)
                served["own"] = handle.own
                return served
            },
            "networks": [Any](), "chats": [Any](), "received": 0, "sent": 0, "first_ms": NSNull(), "last_ms": NSNull(),
            "last_30": 0, "days_count": 0, "last_day": 0, "photo": nullable(CannedHome.faces ? Self.photo(of: You.id) : nil),
            "also_called": You.alsoCalled,
        ]
        let suggestions: [[String: Any]] = You.dayOne ? [] : [
            ["id": "50000000000000a1", "kind": "handle", "value": "email:sam@studio.example.com",
             "reasons": ["mails_from": 6, "mails_to": 0], "ticked": true],
            ["id": "50000000000000b1", "kind": "same", "value": "phone:+15550000093", "reasons": ["named": 1], "ticked": false],
        ]
        if whole {
            object["days"] = [String: Int]()
            object["suggestions"] = suggestions
            object["names_seen"] = [Any]()
            object["joined"] = [Any]()
            object["record"] = ["type": "people.person", "slug": "sam-example", "name": You.name, "full_name": You.fullName, "show": "name",
                                "me": true, "also_called": You.alsoCalled.filter { $0["from"] == "You added" }.map { $0["name"] ?? "" },
                                "anchor": NSNull(), "handles": [Any](), "excluded": [Any](), "dismissed": [Any](), "merged_into": NSNull()]
        } else {
            object["suggested"] = suggestions.count
        }
        return object
    }

    private func person(_ former: CannedHome.Former, days withDays: Bool) -> [String: Any] {
        let first = now.addingTimeInterval(-Double(former.firstBack) * 86_400), last = now.addingTimeInterval(-Double(former.lastBack) * 86_400)
        let span = max(1, former.firstBack - former.lastBack)
        let touched = Array(Set(stride(from: 0, through: span, by: max(1, span / 24)).map { former.lastBack + $0 } + [former.lastBack]))
        var days: [String: Int] = [:]
        for back in touched { days[civilDay(now.addingTimeInterval(-Double(back) * 86_400)), default: 0] += max(1, former.received / touched.count) }
        let chats = ([former.chat.map { ($0, former.received - (former.inGroup ? former.received / 4 : 0)) }].compactMap { $0 }
            + (former.inGroup ? [(CannedHome.formerGroup.chat, former.chat == nil ? former.received : former.received / 4)] : []))
            .map { ["key": $0.0, "count": $0.1] as [String: Any] }
        var object: [String: Any] = [
            "id": former.id, "name": former.name, "by": former.by, "person": nullable(former.slug),
            "handles": [Self.handle(former.handle, from: nil)],
            "networks": [former.network], "chats": chats, "received": former.received, "sent": former.sent,
            "first_ms": Self.ms(first), "last_ms": Self.ms(last), "last_30": former.last30, "days_count": days.count,
            "last_day": 3,
        ]
        if CannedHome.faces { object["photo"] = Self.photo(of: former.id) }
        if withDays { object["days"] = days }
        return object
    }

    func people() -> [String: Any] {
        let direct = CannedHome.cast.map { member in
            (key: member.chat, network: member.network, label: member.name, group: false)
        }
        let all = direct + [(key: CannedHome.group.chat, network: "whatsapp", label: CannedHome.group.label, group: true)]
        let chats = all.map { chat -> [String: Any] in
            let held = atoms.filter { $0.atom.block?.title == chat.label }
            let times = held.compactMap(\.atom.startMs)
            return ["key": chat.key, "network": chat.network, "chat": String(chat.key.drop { $0 != ":" }.dropFirst()),
                    "group": chat.group, "label": chat.label, "total": held.count, "mine": held.filter { Self.mine($0.atom) }.count,
                    "first_ms": nullable(times.min()), "last_ms": nullable(times.max()), "quiet": NSNull(), "word": NSNull()]
        }
        let others = CannedHome.moreGroups.map(otherGroup)
        let group = CannedHome.formerGroup
        let formerChats = CannedHome.former.compactMap { former -> [String: Any]? in
            guard let chat = former.chat else { return nil }
            return ["key": chat, "network": former.network, "chat": String(chat.drop { $0 != ":" }.dropFirst()), "group": false,
                    "label": former.name, "total": former.received + former.sent, "mine": former.sent,
                    "first_ms": Self.ms(now.addingTimeInterval(-Double(former.firstBack) * 86_400)),
                    "last_ms": Self.ms(now.addingTimeInterval(-Double(former.lastBack) * 86_400))]
        } + [["key": group.chat, "network": "whatsapp", "chat": String(group.chat.drop { $0 != ":" }.dropFirst()), "group": true,
              "label": group.label, "total": group.total, "mine": group.mine,
              "first_ms": Self.ms(now.addingTimeInterval(-Double(group.firstBack) * 86_400)),
              "last_ms": Self.ms(now.addingTimeInterval(-Double(group.lastBack) * 86_400)), "quiet": NSNull(), "word": NSNull()]]
        let day: [String: Any] = ["position": position]
        if CannedHome.emptyHome { return day.merging(["people": [Any](), "chats": [Any]()]) { $1 } }
        let filler = CannedScale.people(now: now)
        let people = Self.served(CannedHome.cast.map { person($0, days: false) } + CannedHome.former.map { person($0, days: false) })
            + filler.people
        let quiet = CannedHome.quietGroups.map(otherGroup)
        return day.merging(["you": CannedHome.You.none ? NSNull() : you(whole: false), "people": people,
                            "chats": chats + formerChats + others + quiet + filler.chats]) { $1 }
    }

    private static func served(_ people: [[String: Any]]) -> [[String: Any]] {
        let messages = { (person: [String: Any]) in (person["received"] as? Int ?? 0) + (person["sent"] as? Int ?? 0) }
        return people.enumerated().sorted { (messages($1.element), $0.offset) < (messages($0.element), $1.offset) }.map(\.element)
    }

    private func otherGroup(_ other: CannedHome.OtherGroup) -> [String: Any] {
        let last = now.addingTimeInterval(-Double(other.lastBack) * 86_400)
        let quiet: Any = other.quiet.map { quiet -> [String: Any] in
            ["why": quiet.why, "last_day": quiet.lastBack.map { civilDay(now.addingTimeInterval(-Double($0) * 86_400)) as Any } ?? NSNull()]
        } ?? NSNull()
        return ["key": other.chat, "network": "whatsapp", "chat": String(other.chat.drop { $0 != ":" }.dropFirst()), "group": true,
                "label": other.label, "total": other.total, "mine": other.mine, "first_ms": Self.ms(last.addingTimeInterval(-400 * 86_400)),
                "last_ms": Self.ms(last), "quiet": quiet, "word": other.word.map { $0 as Any } ?? NSNull()]
    }

    func person(_ id: String) -> [String: Any]? {
        if CannedHome.emptyHome { return nil }
        if id == CannedHome.You.id { return CannedHome.You.none ? nil : you(whole: true) }
        return CannedHome.cast.first { $0.id == id }.map { person($0, days: true) }
            ?? CannedHome.former.first { $0.id == id }.map { person($0, days: true) }
    }

    private func ago(_ seconds: Double) -> Int64 { Self.ms(now.addingTimeInterval(-seconds)) }

    private var sources: [(id: String, name: String, on: Bool, last: Int64?, today: Int)] {
        [("screen:local:macbook-pro-0001", "MacBook Pro", true, ago(120), 1204),
         ("whatsapp:15550000000:macbook-pro-0001", "MacBook Pro", true, ago(300), 86),
         ("gmail:person-a@example.com:cloud", "Gmail", true, ago(26 * 3600), 0)]
    }

    func connectors() -> [String: Any] {
        var report = CannedHome.report(unit: CannedHome.paired.withLock { $0 })
        report["connectors"] = CannedFeedback.reportable(
            CannedHome.streams.laid(CannedHome.settings.laid(report["connectors"] as? [[String: Any]] ?? []), at: Self.ms(now)))
        report["position"] = position
        report["today"] = CannedHome.today
        return report
    }

    private func needs() -> [[String: Any]] {
        CannedHome.report(unit: CannedHome.paired.withLock { $0 })["needs"] as? [[String: Any]] ?? []
    }

    private var disk: [String: Any] { ["free_bytes": 120_000_000_000] }

    func status() -> [String: Any] {
        [
            "position": position, "at_ms": Self.ms(now), "day": civilDay(now), "needs": needs(),
            "today": [
                "sources": sources.map { held -> [String: Any] in
                    ["source": held.id, "deliveries": held.today > 0 ? 3 : 0, "imports": held.today > 0 ? 3 : 0,
                     "counts": held.today > 0 ? ["entry": held.today] : [String: Int](), "changed_paths": [String: Int](),
                     "likely_noise": [Any](), "read_through_ms": nullable(held.last)]
                },
                "families": [Any](), "render": ["runs": 1, "days": 1, "written": 1, "current": 0, "set_aside": 0], "operations": [Any](),
            ],
            "grants": [Any](), "running": ["lanes": [Any](), "jobs": [Any](), "repairs": [Any]()], "paused": [Any](),
            "inbox": ["lanes": [Any](), "since": NSNull()], "search": ["seq": 100, "of": 100, "bytes": 1_048_576],
            "disk": disk,
        ]
    }

    static func handle(_ handle: (kind: String, value: String), from: String?) -> [String: Any] {
        let digits = handle.value.dropFirst()
        let words = handle.kind == "phone" && handle.value.hasPrefix("+1") && digits.count == 11
            ? "+1 \(digits.dropFirst().prefix(3)) \(digits.dropFirst(4).prefix(3)) \(digits.suffix(4))" : handle.value
        return ["id": handle.kind + ":" + handle.value, "kind": handle.kind, "network": NSNull(), "words": words, "from": nullable(from)]
    }

    func record(_ asked: CannedHome.Asked) -> [String: Any] {
        let source = asked.one("source") ?? "", kind = asked.one("kind") ?? "", key = asked.one("key") ?? ""
        let atom = atoms.first { $0.atom.record == HomeLink.DayFile.RecordRef(source: source, kind: kind, key: key) }?.atom
        let at = atom?.startMs ?? ago(3600)
        let words = atom?.text ?? "Person A: see you at the Corner Cafe"
        let content: [String: Any]
        let text: [String: Any]
        var blobs: [String] = []
        if kind.contains("photo") || kind.contains("asset") {
            content = ["taken_ms": at, "width": 120, "height": 90, "hash": CannedHome.photoHash]
            text = ["title": "Photo", "text": words]
            blobs = [CannedHome.photoHash]
        } else if kind == "call" {
            let party = CannedHome.cast.first { words.contains(" \($0.name),") || words.hasSuffix(" \($0.name)") }
            let number = party?.handle.value ?? "+15550000009"
            let who = source.hasPrefix("whatsapp:") ? [String(number.dropFirst()) + "@s.whatsapp.net", number] : [number]
            content = ["text": words, "at": at]
            text = ["title": who.joined(separator: ", "), "text": "", "who": who]
        } else if kind == "event" {
            let guests = CannedHome.cast.prefix(7).map { "\($0.handle.kind):\($0.handle.value)" } + ["email:guest@example.com"]
            content = ["text": words, "at": at]
            text = ["title": atom.map(Self.title) ?? "Design review", "text": "at Room 4\nThe week's drawers, one by one.", "who": guests]
        } else if kind == "note" {
            let body = words.components(separatedBy: " written: ").dropFirst().joined(separator: " written: ")
            content = ["text": body, "at": at]
            text = ["title": atom.map(Self.title) ?? "Groceries", "text": body]
        } else if source.hasPrefix("gmail") || kind.contains("mail") || kind == "message" {
            let subject = atom.map(Self.title) ?? "Lunch this week?"
            let body = words.components(separatedBy: " — ").dropFirst().joined(separator: " — ")
            content = ["subject": subject, "from": "person-c@example.com", "to": ["person-a@example.com"], "date_ms": at, "body": body]
            text = ["title": subject, "text": body, "who": ["email:person-c@example.com"]]
        } else {
            content = ["text": words, "from": "+15550000001", "at": at]
            text = ["title": atom.map(Self.title) ?? "Person A", "text": words, "who": ["whatsapp:+15550000001"]]
        }
        var read: [String: Any] = [
            "position": position, "source": source, "kind": kind, "key": key,
            "head": ["version": "sha256:canned-\(key)", "stated_ms": at, "since_ms": at, "start_ms": at, "end_ms": NSNull()],
            "version": ["id": "sha256:canned-\(key)", "content": content, "start_ms": at, "end_ms": NSNull(), "offset_min": 0, "precision": "ms"],
            "blobs": blobs, "text": text,
        ]
        if kind == "voice" { read["transcribed"] = Self.object(CannedHome.chosen.transcript(of: key, routine: routine)) }
        read["open"] = NSNull()
        if source.hasPrefix("gmail:") { read["open"] = ["label": "Open in Gmail", "href": "https://mail.google.com/mail/#all/" + key] as [String: String] }
        if source.hasPrefix("chatgpt:") {
            let conversation = key.split(separator: ":").first.map(String.init) ?? key
            read["open"] = ["label": "Open in ChatGPT", "href": "https://chatgpt.com/c/" + conversation] as [String: String]
        }
        return read
    }


    private static func page(_ key: String) -> String {
        Data(key.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func unpage(_ text: String) -> String? {
        var base = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base.count % 4 != 0 { base += "=" }
        return Data(base64Encoded: base).flatMap { String(data: $0, encoding: .utf8) }
    }

    private static func object<Value: Encodable>(_ value: Value) -> Any {
        nullable((try? JSONEncoder().encode(value)).flatMap { try? JSONSerialization.jsonObject(with: $0, options: .fragmentsAllowed) })
    }
}
