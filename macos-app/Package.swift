// swift-tools-version: 6.0
import Foundation
import PackageDescription

let package = Package(
    name: "Lifestream",
    platforms: [.macOS("14.2")],
    products: [.executable(name: "Lifestream", targets: ["Lifestream"]),
               .executable(name: "phone-backup-fixture", targets: ["PhoneBackupFixture"])],
    dependencies: [.package(path: "../homelink"), .package(path: "../photolibrary"), .package(path: "../devicefiles"), .package(path: "../design/swift"),
                   .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.0")],
    targets: [
        .target(name: "Evidence", dependencies: [.product(name: "DeviceFiles", package: "devicefiles")]),
        .target(name: "Spool", dependencies: ["Evidence", .product(name: "DeviceFiles", package: "devicefiles")]),
        .target(name: "BrowserPages", dependencies: ["Evidence"]),
        .target(name: "Screen", dependencies: ["Evidence", "BrowserPages"]),
        .target(name: "MachineEvents", dependencies: ["Evidence", .product(name: "DeviceFiles", package: "devicefiles")]),
        .target(name: "InputEvents", dependencies: ["Evidence", "BrowserPages", .product(name: "DeviceFiles", package: "devicefiles")]),
        .target(name: "Audio", dependencies: ["Evidence", .product(name: "DeviceFiles", package: "devicefiles")]),
        .target(name: "Shipping", dependencies: ["Evidence", "MachineEvents", "InputEvents", "Audio",
                                                .product(name: "HomeLink", package: "homelink"),
                                                .product(name: "PhotoLibrary", package: "photolibrary"),
                                                .product(name: "DeviceFiles", package: "devicefiles")]),
        .target(name: "Recorder", dependencies: ["Evidence", "Spool", "Screen", "MachineEvents", "InputEvents", "Audio", .product(name: "DeviceFiles", package: "devicefiles")]),
        .target(name: "ResourceWatch", dependencies: ["Evidence", .product(name: "DeviceFiles", package: "devicefiles")]),
        .target(name: "Passwords"),
        .target(name: "PhoneBackup", dependencies: [.product(name: "DeviceFiles", package: "devicefiles")]),
        .executableTarget(name: "Lifestream", dependencies: ["Evidence", "Spool", "BrowserPages", "Screen", "MachineEvents", "InputEvents", "Audio", "Shipping", "Recorder", "ResourceWatch", "Passwords", "PhoneBackup",
                                                                .product(name: "HomeLink", package: "homelink"),
                                                                .product(name: "PhotoLibrary", package: "photolibrary"),
                                                                .product(name: "DeviceFiles", package: "devicefiles"),
                                                                .product(name: "Cockpit", package: "swift"),
                                                                .product(name: "Sparkle", package: "Sparkle")],
                          linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@loader_path/../Frameworks"])]),
        .executableTarget(name: "PhoneBackupFixture", dependencies: ["PhoneBackup"]),
        .testTarget(name: "EvidenceTests", dependencies: ["Evidence", .product(name: "DeviceFiles", package: "devicefiles")]),
        .testTarget(name: "SpoolTests", dependencies: ["Evidence", "Spool", .product(name: "DeviceFiles", package: "devicefiles")]),
        .testTarget(name: "BrowserPagesTests", dependencies: ["Evidence", "BrowserPages"]),
        .testTarget(name: "ScreenTests", dependencies: ["Evidence", "BrowserPages", "Spool", "Screen", .product(name: "DeviceFiles", package: "devicefiles")]),
        .testTarget(name: "MachineEventsTests", dependencies: ["Evidence", "MachineEvents", .product(name: "DeviceFiles", package: "devicefiles")]),
        .testTarget(name: "InputEventsTests", dependencies: ["Evidence", "InputEvents", .product(name: "DeviceFiles", package: "devicefiles")]),
        .testTarget(name: "AudioTests", dependencies: ["Evidence", "Audio", .product(name: "DeviceFiles", package: "devicefiles")]),
        .testTarget(name: "ShippingTests", dependencies: ["Evidence", "Spool", "MachineEvents", "Audio", "Shipping", "PhoneBackup", "PhoneBackupFixture",
                                                        .product(name: "HomeLink", package: "homelink"),
                                                        .product(name: "PhotoLibrary", package: "photolibrary"),
                                                        .product(name: "DeviceFiles", package: "devicefiles")]),
        .testTarget(name: "RecorderTests", dependencies: ["Evidence", "Audio", "Spool", "Recorder", .product(name: "DeviceFiles", package: "devicefiles")]),
        .testTarget(name: "ResourceWatchTests", dependencies: ["Evidence", "ResourceWatch", .product(name: "DeviceFiles", package: "devicefiles")]),
        .testTarget(name: "PasswordsTests", dependencies: ["Passwords"]),
        .testTarget(name: "PhoneBackupTests", dependencies: ["PhoneBackup", "PhoneBackupFixture", .product(name: "DeviceFiles", package: "devicefiles")]),
        .testTarget(name: "LifestreamTests", dependencies: ["Lifestream", "Shipping", "Passwords", "PhoneBackup", "PhoneBackupFixture",
                                                            .product(name: "HomeLink", package: "homelink"),
                                                            .product(name: "DeviceFiles", package: "devicefiles")]),
        .testTarget(name: "PackageTests"),
    ],
    swiftLanguageModes: [.v5]
)

for target in package.targets where FileManager.default.fileExists(atPath: "\(Context.packageDirectory)/Sources/\(target.name)/README.md") {
    target.exclude.append("README.md")
}
