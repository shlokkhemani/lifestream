import CryptoKit
import DeviceFiles
import Foundation

public struct HomeRequest: Sendable, Equatable {
    public enum Body: Sendable, Equatable {
        case empty
        case json(Data)
        case bytes(Data)
        case file(URL)
        case stream(size: Int64, open: Opener)
    }

    public final class Opener: Sendable, Equatable {
        public let open: @Sendable () throws -> Reader

        public init(_ open: @escaping @Sendable () throws -> Reader) {
            self.open = open
        }

        public static func == (left: Opener, right: Opener) -> Bool { left === right }
    }

    public let method: String
    public let url: URL
    public let headers: [String: String]
    public let body: Body
    public let timeout: TimeInterval
    public var pin: String? = nil
    public var crossing = MobileData.Crossing.any
    public var progress: UploadProgress? = nil
}

public final class UploadProgress: Sendable, Equatable {
    public let heard: @Sendable (Int64) -> Void

    public init(_ heard: @escaping @Sendable (Int64) -> Void) {
        self.heard = heard
    }

    public static func == (left: UploadProgress, right: UploadProgress) -> Bool { left === right }
}

public struct HomeResponse: Sendable, Equatable {
    public let status: Int
    public let headers: [String: String]
    public let body: Data
    var pass: String? = nil
    var sent: Int? = nil

    public init(status: Int, headers: [String: String] = [:], body: Data) {
        self.status = status
        self.headers = headers
        self.body = body
    }

    func header(_ name: String) -> String? {
        headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
    }
}

public struct HomeStream: Sendable {
    public let status: Int
    public let headers: [String: String]
    public let lines: AsyncThrowingStream<Data, Error>

    public init(status: Int, headers: [String: String] = [:], lines: AsyncThrowingStream<Data, Error>) {
        self.status = status
        self.headers = headers
        self.lines = lines
    }

    public static func lines(of body: Data) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            for line in body.split(separator: 0x0A) { continuation.yield(Data(line)) }
            continuation.finish()
        }
    }
}

public struct HomeBytes: Sendable {
    public typealias Taking = @Sendable (_ status: Int, _ headers: [String: String]) -> Int64?

    public let status: Int
    public let headers: [String: String]
    public let body: AsyncThrowingStream<Data, Error>

    public init(status: Int, headers: [String: String] = [:], body: AsyncThrowingStream<Data, Error>) {
        self.status = status
        self.headers = headers
        self.body = body
    }

    func header(_ name: String) -> String? {
        headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
    }
}

public protocol HomeTransport: Sendable {
    func perform(_ request: HomeRequest) async throws -> HomeResponse
    func stream(_ request: HomeRequest) async throws -> HomeStream
    func bytes(_ request: HomeRequest, taking: @escaping HomeBytes.Taking) async throws -> HomeBytes
    func identify(_ address: URL, within: TimeInterval) async throws -> String
}

extension HomeTransport {
    public func stream(_ request: HomeRequest) async throws -> HomeStream {
        let response = try await perform(request)
        return HomeStream(status: response.status, headers: response.headers, lines: HomeStream.lines(of: response.body))
    }

    public func bytes(_ request: HomeRequest, taking: @escaping HomeBytes.Taking) async throws -> HomeBytes {
        let response = try await perform(request)
        let most = taking(response.status, response.headers)
        return HomeBytes(status: response.status, headers: response.headers, body: AsyncThrowingStream { continuation in
            guard let most else { return continuation.finish() }
            guard Int64(response.body.count) <= most else { return continuation.finish(throwing: TooLong()) }
            if !response.body.isEmpty { continuation.yield(response.body) }
            continuation.finish()
        })
    }

    public func identify(_ address: URL, within: TimeInterval) async throws -> String {
        throw URLError(.secureConnectionFailed)
    }
}

public struct NotTheHome: Error, Equatable {
    public init() {}
}

public struct TooLong: Error, Equatable {
    public init() {}
}

public enum Pinning {
    public static func answer(_ challenge: URLAuthenticationChallenge, pin: String?)
        -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust, let pin else { return (.performDefaultHandling, nil) }
        return fingerprint(trust) == pin ? (.useCredential, URLCredential(trust: trust)) : (.cancelAuthenticationChallenge, nil)
    }

    public static func fingerprint(_ trust: SecTrust) -> String? {
        guard let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first else { return nil }
        return HomeLink.base32(Data(SHA256.hash(data: SecCertificateCopyData(leaf) as Data)))
    }
}

public struct URLSessionTransport: HomeTransport {
    public static let uploadSilence: TimeInterval = 5 * 60
    public static let uploadLifetime: TimeInterval = 6 * 60 * 60

    public typealias Metrics = @Sendable (HomeRequest, URLSessionTaskMetrics, Int?) -> Void

    private let session: Session
    private let metrics: Metrics?
    private let protocols: [AnyClass]
    private let origin: URL?

    public init(protocolClasses: [AnyClass] = [], metrics: Metrics? = nil, origin: URL? = nil) {
        protocols = protocolClasses
        self.metrics = metrics
        self.origin = origin
        session = Session(URLSession(configuration: Self.configuration(protocolClasses)))
    }

    private static func configuration(_ protocols: [AnyClass] = []) -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        if !protocols.isEmpty { configuration.protocolClasses = protocols + (configuration.protocolClasses ?? []) }
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForResource = Self.uploadLifetime
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCache = nil
        return configuration
    }

    public func perform(_ request: HomeRequest) async throws -> HomeResponse {
        var made = Self.made(request, at: origin)
        var judge = judge(request)
        let (data, response): (Data, URLResponse)
        do {
            switch request.body {
            case .empty:
                (data, response) = try await session.value.data(for: made, delegate: judge)
            case .json(let body), .bytes(let body):
                made.httpBody = body
                (data, response) = try await session.value.data(for: made, delegate: judge)
            case .file(let file):
                (data, response) = try await session.value.upload(for: made, fromFile: file, delegate: judge)
            case .stream(let size, let opener):
                made.setValue(String(size), forHTTPHeaderField: "Content-Length")
                let streamer = self.judge(request, Streamer.self)
                judge = streamer
                let task = session.value.uploadTask(withStreamedRequest: made)
                task.delegate = streamer
                (data, response) = try await withTaskCancellationHandler {
                    try await streamer.send(task, opener: opener)
                } onCancel: {
                    task.cancel()
                }
            }
        } catch {
            // external: URLSession reports a server the pin refused as a cancelled task.
            if judge.refused { throw NotTheHome() }
            throw error
        }
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return HomeResponse(status: http.statusCode, headers: Self.headers(http), body: data)
    }

    public func stream(_ request: HomeRequest) async throws -> HomeStream {
        let answer = try await bytes(request) { _, _ in .max }
        let reader = Reader(answer.body.makeAsyncIterator())
        return HomeStream(status: answer.status, headers: answer.headers, lines: AsyncThrowingStream(unfolding: { try await reader.line() }))
    }

    public func bytes(_ request: HomeRequest, taking: @escaping HomeBytes.Taking) async throws -> HomeBytes {
        var made = Self.made(request, at: origin)
        if case .json(let body) = request.body { made.httpBody = body }
        let judge = judge(request, Receiver.self)
        let task = session.value.dataTask(with: made)
        task.delegate = judge
        do {
            return try await withTaskCancellationHandler {
                try await judge.receive(task, taking: taking)
            } onCancel: {
                task.cancel()
            }
        } catch {
            // external: URLSession reports a server the pin refused as a cancelled task.
            if judge.refused { throw NotTheHome() }
            throw error
        }
    }

    fileprivate static func headers(_ http: HTTPURLResponse) -> [String: String] {
        var headers: [String: String] = [:]
        for (name, value) in http.allHeaderFields {
            if let name = name as? String, let value = value as? String { headers[name] = value }
        }
        return headers
    }

    public func identify(_ address: URL, within: TimeInterval) async throws -> String {
        var made = URLRequest(url: address)
        made.timeoutInterval = within
        let judge = Judge(pin: nil, reading: true)
        let looking = URLSession(configuration: Self.configuration(protocols))
        defer { looking.invalidateAndCancel() }
        _ = try? await looking.data(for: made, delegate: judge)
        guard let seen = judge.seen else { throw URLError(.secureConnectionFailed) }
        return seen
    }

    private func judge<Kind: Judge>(_ request: HomeRequest, _ kind: Kind.Type = Judge.self) -> Kind {
        guard let metrics else { return Kind(pin: request.pin, progress: request.progress) }
        return Kind(pin: request.pin, progress: request.progress, metrics: { @Sendable in metrics(request, $0, $1) })
    }

    static func url(_ url: URL, at origin: URL?) -> URL {
        guard let origin, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        parts.scheme = origin.scheme
        parts.host = origin.host
        parts.port = origin.port
        return parts.url ?? url
    }

    static func made(_ request: HomeRequest) -> URLRequest {
        made(request, at: nil)
    }

    static func made(_ request: HomeRequest, at origin: URL?) -> URLRequest {
        var made = URLRequest(url: Self.url(request.url, at: origin))
        made.httpMethod = request.method
        made.timeoutInterval = request.timeout
        made.allowsExpensiveNetworkAccess = request.crossing.costly
        made.allowsConstrainedNetworkAccess = request.crossing.lowData
        for (name, value) in request.headers { made.setValue(value, forHTTPHeaderField: name) }
        return made
    }

    private final class Reader: @unchecked Sendable {
        private var pieces: AsyncThrowingStream<Data, Error>.AsyncIterator
        private var held = Data()

        init(_ pieces: AsyncThrowingStream<Data, Error>.AsyncIterator) {
            self.pieces = pieces
        }

        func line() async throws -> Data? {
            while true {
                while let newline = held.firstIndex(of: 0x0A) {
                    let line = held[held.startIndex..<newline]
                    held = held[(newline + 1)...]
                    if !line.isEmpty { return Data(line) }
                }
                guard let piece = try await pieces.next() else { break }
                held.append(piece)
            }
            guard held.isEmpty else { throw URLError(.networkConnectionLost) }
            return nil
        }
    }

    private class Judge: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        private let pin: String?
        private let reading: Bool
        private let progress: UploadProgress?
        private let metrics: (@Sendable (URLSessionTaskMetrics, Int?) -> Void)?
        let lock = NSLock()
        private var refusedHere = false
        private var seenHere: String?

        required init(pin: String?, reading: Bool = false, progress: UploadProgress? = nil,
                      metrics: (@Sendable (URLSessionTaskMetrics, Int?) -> Void)? = nil) {
            self.pin = pin
            self.reading = reading
            self.progress = progress
            self.metrics = metrics
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64,
                        totalBytesExpectedToSend: Int64) {
            progress?.heard(totalBytesSent)
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
            self.metrics?(metrics, (task.response as? HTTPURLResponse)?.statusCode)
        }

        var refused: Bool { lock.withLock { refusedHere } }
        var seen: String? { lock.withLock { seenHere } }

        func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge)
            async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
            if reading {
                let seen = challenge.protectionSpace.serverTrust.flatMap(Pinning.fingerprint)
                lock.withLock { seenHere = seen }
                return (.cancelAuthenticationChallenge, nil)
            }
            let answer = Pinning.answer(challenge, pin: pin)
            if answer.0 == .cancelAuthenticationChallenge { lock.withLock { refusedHere = true } }
            return answer
        }
    }

    private final class Receiver: Judge, URLSessionDataDelegate, @unchecked Sendable {
        private var head: CheckedContinuation<HomeBytes, Error>?
        private var taking: HomeBytes.Taking?
        private weak var pieces: Pieces?

        func receive(_ task: URLSessionDataTask, taking: @escaping HomeBytes.Taking) async throws -> HomeBytes {
            try await withCheckedThrowingContinuation { head in
                lock.withLock {
                    self.head = head
                    self.taking = taking
                }
                task.resume()
            }
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse)
            async -> URLSession.ResponseDisposition {
            let (waiting, taking) = lock.withLock { () -> (CheckedContinuation<HomeBytes, Error>?, HomeBytes.Taking?) in
                defer { (head, self.taking) = (nil, nil) }
                return (head, self.taking)
            }
            guard let http = response as? HTTPURLResponse, let waiting, let taking else {
                waiting?.resume(throwing: URLError(.badServerResponse))
                return .cancel
            }
            let headers = URLSessionTransport.headers(http)
            guard let most = taking(http.statusCode, headers) else {
                waiting.resume(returning: HomeBytes(status: http.statusCode, headers: headers, body: AsyncThrowingStream { $0.finish() }))
                return .cancel
            }
            let pieces = Pieces(most: most, pause: { [weak dataTask] in dataTask?.suspend() },
                                go: { [weak dataTask] in dataTask?.resume() }, stop: { [weak dataTask] in dataTask?.cancel() })
            lock.withLock { self.pieces = pieces }
            waiting.resume(returning: HomeBytes(status: http.statusCode, headers: headers,
                                                body: AsyncThrowingStream(unfolding: { try await pieces.next() })))
            return .allow
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            guard let pieces = lock.withLock({ self.pieces }) else { return dataTask.cancel() }
            pieces.put(data)
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            let (waiting, pieces) = lock.withLock { () -> (CheckedContinuation<HomeBytes, Error>?, Pieces?) in
                defer { (head, taking, self.pieces) = (nil, nil, nil) }
                return (head, self.pieces)
            }
            waiting?.resume(throwing: error ?? URLError(.badServerResponse))
            pieces?.end(error)
        }
    }

    private final class Streamer: Judge, URLSessionDataDelegate, @unchecked Sendable {
        static let buffered = 1 << 18

        private var opener: HomeRequest.Opener?
        private var done: CheckedContinuation<(Data, URLResponse), Error>?
        private var received = Data()
        private var failure: Error?

        func send(_ task: URLSessionUploadTask, opener: HomeRequest.Opener) async throws -> (Data, URLResponse) {
            try await withCheckedThrowingContinuation { done in
                lock.withLock {
                    self.done = done
                    self.opener = opener
                }
                task.resume()
            }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask,
                        needNewBodyStream completionHandler: @escaping @Sendable (InputStream?) -> Void) {
            guard let opener = lock.withLock({ self.opener }) else { return completionHandler(nil) }
            var input: InputStream?
            var output: OutputStream?
            Stream.getBoundStreams(withBufferSize: Self.buffered, inputStream: &input, outputStream: &output)
            guard let input, let output else { return completionHandler(nil) }
            let pump = Thread { [weak self, weak task] in
                output.open()
                do {
                    try Self.pump(opener, into: output)
                } catch {
                    self?.fail(error)
                    task?.cancel()
                }
                output.close()
            }
            pump.name = "HomeLink upload body"
            pump.start()
            completionHandler(input)
        }

        private func fail(_ error: Error) {
            lock.withLock { failure = failure ?? error }
        }

        private static func pump(_ opener: HomeRequest.Opener, into output: OutputStream) throws {
            let reader = try opener.open()
            while let chunk = try reader.next() {
                guard write(chunk, to: output) else { return }
            }
        }

        private static func write(_ chunk: Data, to output: OutputStream) -> Bool {
            chunk.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
                var at = 0
                while at < bytes.count {
                    let wrote = output.write(bytes.baseAddress!.advanced(by: at).assumingMemoryBound(to: UInt8.self),
                                             maxLength: bytes.count - at)
                    guard wrote > 0 else { return false }
                    at += wrote
                }
                return true
            }
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            lock.withLock { received.append(data) }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            let (waiting, body, failed) = lock.withLock { () -> (CheckedContinuation<(Data, URLResponse), Error>?, Data, Error?) in
                defer { (done, opener, received) = (nil, nil, Data()) }
                return (done, received, failure)
            }
            if let failure = failed ?? error { return waiting?.resume(throwing: failure) ?? () }
            guard let response = task.response else { return waiting?.resume(throwing: URLError(.badServerResponse)) ?? () }
            waiting?.resume(returning: (body, response))
        }
    }

    private final class Session: @unchecked Sendable {
        let value: URLSession

        init(_ value: URLSession) {
            self.value = value
        }
    }
}

final class Pieces: @unchecked Sendable {
    static let held = 1 << 20

    private let most: Int64
    private let held: Int
    private let pause, go, stop: @Sendable () -> Void
    private let lock = NSLock()
    private var waiting: [Data] = []
    private var queued = 0
    private var taken: Int64 = 0
    private var paused = false
    private var ending: Error??
    private var reader: CheckedContinuation<Data?, Error>?

    init(most: Int64, held: Int = Pieces.held, pause: @escaping @Sendable () -> Void, go: @escaping @Sendable () -> Void,
         stop: @escaping @Sendable () -> Void) {
        self.most = most
        self.held = held
        self.pause = pause
        self.go = go
        self.stop = stop
    }

    deinit {
        if ending == nil { stop() }
    }

    var counts: (queued: Int, taken: Int64) { lock.withLock { (queued, taken) } }

    func put(_ piece: Data) {
        enum Then { case none, stop }
        let (reader, then) = lock.withLock { () -> (CheckedContinuation<Data?, Error>?, Then) in
            guard ending == nil else { return (nil, .none) }
            guard Int64(piece.count) <= most - taken else {
                ending = .some(TooLong())
                defer { self.reader = nil }
                return (self.reader, .stop)
            }
            taken += Int64(piece.count)
            if let reader = self.reader {
                self.reader = nil
                return (reader, .none)
            }
            waiting.append(piece)
            queued += piece.count
            if queued >= held, !paused {
                paused = true
                pause()
            }
            return (nil, .none)
        }
        switch then {
        case .none: reader?.resume(returning: piece)
        case .stop:
            reader?.resume(throwing: TooLong())
            stop()
        }
    }

    func end(_ error: Error?) {
        let reader = lock.withLock { () -> CheckedContinuation<Data?, Error>? in
            guard ending == nil else { return nil }
            ending = .some(error)
            defer { self.reader = nil }
            return self.reader
        }
        if let error { reader?.resume(throwing: error) } else { reader?.resume(returning: nil) }
    }

    func next() async throws -> Data? {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (reader: CheckedContinuation<Data?, Error>) in
                enum Answer { case piece(Data), end(Error?), wait }
                let answer = lock.withLock { () -> Answer in
                    if !waiting.isEmpty {
                        let piece = waiting.removeFirst()
                        queued -= piece.count
                        if paused, queued < held, ending == nil {
                            paused = false
                            go()
                        }
                        return .piece(piece)
                    }
                    if let ending { return .end(ending) }
                    self.reader = reader
                    return .wait
                }
                switch answer {
                case .piece(let piece):
                    reader.resume(returning: piece)
                case .end(let error):
                    if let error { reader.resume(throwing: error) } else { reader.resume(returning: nil) }
                case .wait: break
                }
            }
        } onCancel: {
            cancel()
        }
    }

    private func cancel() {
        let reader = lock.withLock { () -> CheckedContinuation<Data?, Error>? in
            if ending == nil { ending = .some(CancellationError()) }
            defer { self.reader = nil }
            return self.reader
        }
        reader?.resume(throwing: CancellationError())
        stop()
    }
}
