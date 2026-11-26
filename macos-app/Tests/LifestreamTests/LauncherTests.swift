import Foundation
import XCTest
@testable import Lifestream

final class LauncherTests: XCTestCase {
    func testEachJobExecsTheReleasesNodeOnItsScriptWithItsWords() throws {
        let machine = FileManager.default.temporaryDirectory.appendingPathComponent("launcher-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: machine) }
        let release = machine.appendingPathComponent("releases/0000000000000000000000000000000000000000")
        try FileManager.default.createDirectory(at: release, withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: release.appendingPathComponent("RELEASE.json"))
        try FileManager.default.createSymbolicLink(at: machine.appendingPathComponent("current"), withDestinationURL: release)
        let resolved = release.resolvingSymlinksInPath().path
        let node = "\(resolved)/node"

        XCTAssertEqual(Launcher.command(.home, machine: machine)?.arguments, [node, "\(resolved)/dist/home.mjs", "serve"])
        XCTAssertEqual(Launcher.command(.door, machine: machine)?.arguments, [node, "\(resolved)/dist/door.mjs", "serve"])
        XCTAssertEqual(Launcher.command(.dashboard, machine: machine)?.arguments, [node, "\(resolved)/dashboard/server.mjs"])
        XCTAssertEqual(Launcher.command(.mcp, machine: machine)?.arguments, [node, "\(resolved)/mcp/server.mjs"])
        XCTAssertEqual(Launcher.command(.runner, machine: machine)?.arguments,
                       [node, "\(resolved)/dist/runner.mjs", "serve", "--door", "http://127.0.0.1:4680",
                        "--pass", "\(machine.path)/runner/door-token", "--files", "\(machine.path)/models"])
        XCTAssertEqual(Launcher.command(.runner, machine: machine)?.environment, [:])
        XCTAssertEqual(Launcher.command(.home, machine: machine)?.executable, node)
        XCTAssertNil(Launcher.command(.resourceWatch, machine: machine))
        XCTAssertEqual(HomeJob.allCases.filter(\.handedKey), [.home, .door], "the door is not handed the slot key the home is, or another job is")

        try FileManager.default.removeItem(at: release.appendingPathComponent("RELEASE.json"))
        XCTAssertNil(Launcher.command(.home, machine: machine))
    }

    func testTheDashboardRunsFromTheCheckoutItsMachineNamesAndOtherwiseFromTheRelease() throws {
        let machine = FileManager.default.temporaryDirectory.appendingPathComponent("launcher-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: machine) }
        let release = machine.appendingPathComponent("releases/0000000000000000000000000000000000000000")
        try FileManager.default.createDirectory(at: release, withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: release.appendingPathComponent("RELEASE.json"))
        try FileManager.default.createSymbolicLink(at: machine.appendingPathComponent("current"), withDestinationURL: release)
        let resolved = release.resolvingSymlinksInPath().path
        let node = "\(resolved)/node"
        let fromRelease = [node, "\(resolved)/dashboard/server.mjs"]
        let checkout = machine.appendingPathComponent("checkout")
        try FileManager.default.createDirectory(at: checkout.appendingPathComponent("dashboard"), withIntermediateDirectories: true)
        try Data().write(to: checkout.appendingPathComponent("dashboard/server.mjs"))
        let empty = machine.appendingPathComponent("empty")
        try FileManager.default.createDirectory(at: empty, withIntermediateDirectories: true)
        let named = machine.appendingPathComponent("dashboard-from")
        let state = ["VIEWER_STATE_DIR": machine.appendingPathComponent("dashboard").path]

        XCTAssertEqual(Launcher.command(.dashboard, machine: machine)?.arguments, fromRelease)

        try Data("\(checkout.path)\n".utf8).write(to: named)
        XCTAssertEqual(Launcher.command(.dashboard, machine: machine)?.arguments, [node, "\(checkout.path)/dashboard/server.mjs"])
        XCTAssertEqual(Launcher.command(.dashboard, machine: machine)?.executable, node)
        XCTAssertEqual(Launcher.command(.dashboard, machine: machine)?.environment, state)
        XCTAssertEqual(Launcher.command(.mcp, machine: machine)?.arguments, [node, "\(resolved)/mcp/server.mjs"])

        try Data(empty.path.utf8).write(to: named)
        XCTAssertEqual(Launcher.command(.dashboard, machine: machine)?.arguments, fromRelease)

        try Data("checkout".utf8).write(to: named)
        XCTAssertEqual(Launcher.command(.dashboard, machine: machine)?.arguments, fromRelease)
    }
}
