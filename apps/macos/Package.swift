// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "DispatchMenu",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "DispatchMenu", targets: ["DispatchMenu"])],
    targets: [
        .target(name: "DispatchCore"),
        .executableTarget(name: "DispatchMenu", dependencies: ["DispatchCore"]),
        .testTarget(name: "DispatchCoreTests", dependencies: ["DispatchCore"]),
    ]
)
