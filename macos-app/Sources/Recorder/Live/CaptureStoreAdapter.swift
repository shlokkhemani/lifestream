import DeviceFiles
import Evidence
import Foundation
import Spool

final class CaptureStoreAdapter: RecorderStorage, @unchecked Sendable {
    private let store: CaptureStore

    init(_ store: CaptureStore) {
        self.store = store
    }

    static func open(directory: URL, files: DeviceFiles, scratch: URL, videoQuality: Double,
                     fits: (@Sendable () -> Bool)?, onSegmentSettled: (@Sendable () -> Void)? = nil) async throws -> CaptureStoreAdapter {
        try await Task.detached(priority: .utility) {
            CaptureStoreAdapter(try CaptureStore(directory: directory, files: files, scratch: scratch, videoQuality: videoQuality, fits: fits,
                                                 onSegmentSettled: onSegmentSettled))
        }.value
    }

    func append(_ observation: CaptureObservation, image: CaptureImage?) async throws {
        try await Task.detached(priority: .utility) { [store] in
            _ = try store.append(observation: observation, image: image)
        }.value
    }

    func append(_ observation: CaptureObservation, bundle: String) async throws {
        try await Task.detached(priority: .utility) { [store] in
            _ = try store.append(observation: observation, image: nil, bundle: bundle)
        }.value
    }

    var newestObservation: NewestObservation? { store.newestObservation }
    var newestUnreadable: Bool { store.newestUnreadable }

    func hasBackpressure() -> Bool {
        store.videoBackpressure()
    }

    func compact(flush: Bool) async throws -> VideoCompactionReport {
        let report: VideoCompactionReport
        do {
            report = try await store.compactPendingVideo(flush: flush)
        } catch {
            guard !(error is CancellationError), error as? VideoArchiveError != .cancelled, !Task.isCancelled else {
                throw error
            }
            _ = try? await store.compactText()
            throw error
        }
        _ = try await store.compactText()
        return report
    }
}
