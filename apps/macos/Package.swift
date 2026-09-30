// swift-tools-version: 5.9
import PackageDescription
import Foundation

// Explicitly opt-in for the isolated Sparkle feasibility experiment only.
let sparkleProbeSDK = ProcessInfo.processInfo.environment["DISPATCH_SPARKLE_PROBE_SDK"]
let sparkleSDK = sparkleProbeSDK ?? ProcessInfo.processInfo.environment["DISPATCH_SPARKLE_SDK"]
let probeSwift: [SwiftSetting] = sparkleSDK.map { [.define(sparkleProbeSDK == nil ? "SPARKLE_UPDATES" : "SPARKLE_PROBE"), .unsafeFlags(["-F", $0])] } ?? []
let probeLink: [LinkerSetting] = sparkleSDK.map { [.unsafeFlags(["-F", $0, "-framework", "Sparkle", "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])] } ?? []

let package = Package(
    name: "DispatchMenu",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "DispatchMenu", targets: ["DispatchMenu"])],
    targets: [
        .target(name: "DispatchCore"),
        .executableTarget(name: "DispatchMenu", dependencies: ["DispatchCore"], swiftSettings: probeSwift, linkerSettings: probeLink),
        .testTarget(name: "DispatchCoreTests", dependencies: ["DispatchCore"]),
        .testTarget(name: "DispatchMenuTests", dependencies: ["DispatchMenu", "DispatchCore"]),
    ]
)
