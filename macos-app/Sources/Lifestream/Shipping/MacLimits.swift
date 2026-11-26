import Foundation
import HomeLink
import Shipping

final class MacLimits: @unchecked Sendable {
    static let every: TimeInterval = 60

    let disk: Volume
    private let link: HomeLink
    private var watching: [Task<Void, Never>] = []

    init(disk: Volume, link: HomeLink) {
        self.disk = disk
        self.link = link
    }

    deinit {
        for task in watching { task.cancel() }
    }

    func start() {
        let link = link
        disk.observe { link.tell(room: $0) }
        link.tell(room: disk.room)
        let disk = disk
        watching = [
            Task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(Self.every))
                    _ = disk.room
                }
            },
        ]
    }
}
