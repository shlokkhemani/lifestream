import Foundation

public struct Answer: Sendable, Equatable {
    public struct Home: Sendable, Equatable {
        public let id: String
        public let version: String
        public let generation: Int?
        public let floors: [String: String]
    }

    public struct Custody: Sendable, Equatable {
        public let received: Int
        public let imported: Int
        public let formats: [String]
        public let history: Bool
    }

    public struct Turn: Sendable, Equatable {
        public let run: String
        public let n: Int

        public init(run: String, n: Int) {
            self.run = run
            self.n = n
        }

        public func follows(_ other: Turn) -> Bool {
            run != other.run || n > other.n
        }
    }

    public let home: Home
    public let turn: Turn
    public let clock: String?
    public let pass: String
    public let unit: String
    public let sources: [String: Custody]
    public let owner: [String]
    public let needs: [HomeLink.Need]
    public let calls: [Data]
    public let replaced: Date?
    public let account: String?
    public let addresses: [URL]
    public let settings: [String: [String: HomeLink.JSON]]
    public let stores: [String: HomeLink.DeclaredStore]?
    public let refresh: [String: Int]?
    public let keyed: Bool
    public let mobileData: MobileData.Choice
    public let body: Data

    init?(body: Data) {
        guard let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              let home = object["home"] as? [String: Any], let id = home["id"] as? String, let version = home["version"] as? String,
              let floors = home["floors"] as? [String: Any],
              let pass = object["pass"] as? String, !pass.isEmpty, let unit = object["unit"] as? String,
              let stated = object["sources"] as? [String: Any], let owner = object["owner"] as? [String],
              let needs = object["needs"] as? [Any], let calls = object["calls"] as? [Any],
              let settings = object["settings"] as? [String: Any],
              let turn = object["turn"] as? [String: Any], let run = turn["run"] as? String, run.count == 16,
              run.allSatisfy(\.isHexDigit), let n = Self.count(turn["n"]) else { return nil }
        var sources: [String: Custody] = [:]
        for (source, value) in stated {
            guard let custody = value as? [String: Any],
                  let received = Self.count(custody["received"]), let imported = Self.count(custody["imported"]),
                  imported <= received, let formats = custody["formats"] as? [String],
                  let history = custody["history"] as? Bool else { return nil }
            sources[source] = Custody(received: received, imported: imported, formats: formats, history: history)
        }
        self.home = Home(id: id, version: version, generation: Self.count(home["generation"]),
                         floors: floors.compactMapValues { $0 as? String })
        self.pass = pass
        self.turn = Turn(run: run, n: n)
        clock = (object["clock"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.unit = unit
        self.sources = sources
        self.owner = owner
        self.needs = needs.compactMap { item in
            guard let bytes = try? JSONSerialization.data(withJSONObject: item) else { return nil }
            return try? JSONDecoder().decode(HomeLink.Need.self, from: bytes)
        }
        self.calls = calls.compactMap { try? JSONSerialization.data(withJSONObject: $0) }
        replaced = (object["replaced"] as? String).flatMap(Self.instant)
        account = (object["account"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        addresses = (object["addresses"] as? [Any] ?? []).compactMap { ($0 as? String).flatMap { try? HomeLink.name($0) } }
        self.settings = settings.compactMapValues { members in
            guard members is [String: Any], let bytes = try? JSONSerialization.data(withJSONObject: members) else { return nil }
            return try? JSONDecoder().decode([String: HomeLink.JSON].self, from: bytes)
        }
        stores = (object["stores"] as? [String: Any])?.compactMapValues { store in
            guard let bytes = try? JSONSerialization.data(withJSONObject: store) else { return nil }
            return try? JSONDecoder().decode(HomeLink.DeclaredStore.self, from: bytes)
        }
        refresh = (object["refresh"] as? [String: Any])?.compactMapValues { Self.count($0) }
        keyed = object["keyed"] as? Bool == true
        mobileData = (object["mobile_data"] as? String).flatMap(MobileData.Choice.init(rawValue:)) ?? .now
        self.body = body
    }

    static func instant(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }

    private static func count(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              let whole = Int(exactly: number.doubleValue), whole >= 0 else { return nil }
        return whole
    }
}

@dynamicMemberLookup
public struct FreshAnswer: Sendable, Equatable {
    let answer: Answer
    public let at: Date

    init(_ answer: Answer, at: Date) {
        self.answer = answer
        self.at = at
    }

    public subscript<Value>(dynamicMember member: KeyPath<Answer, Value>) -> Value { answer[keyPath: member] }
}

@dynamicMemberLookup
public struct SavedAnswer: Sendable, Equatable {
    let answer: Answer
    public let at: Date

    init(_ answer: Answer, at: Date) {
        self.answer = answer
        self.at = at
    }

    public subscript<Value>(dynamicMember member: KeyPath<Answer, Value>) -> Value { answer[keyPath: member] }
}
