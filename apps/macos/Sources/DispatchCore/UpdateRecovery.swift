import Foundation

/// Persisted before Sparkle can install on application termination. Never contains credentials.
public struct UpdateRecovery: Codable, Equatable {
    public let wasRunning: Bool
    public let targetBuild: String
    public init(wasRunning: Bool, targetBuild: String) {
        self.wasRunning = wasRunning; self.targetBuild = targetBuild
    }
    public static func path(root: URL) -> URL { root.appendingPathComponent("app-update-recovery.json") }
    public static func read(root: URL) throws -> Self? {
        let path = path(root: root)
        guard FileManager.default.fileExists(atPath: path.path) else { return nil }
        let value = try JSONDecoder().decode(Self.self, from: Data(contentsOf: path))
        guard !value.targetBuild.isEmpty else { throw ConfigurationError("The update recovery record is invalid.") }
        return value
    }
    public func save(root: URL) throws { try writePrivateJSON(self, to: Self.path(root: root)) }
    /// Health and the exact request acknowledgment are prerequisites, even for a stopped server.
    @discardableResult
    public func confirm(root: URL, installedBuild: String, request: ServiceRequest, runtime: ServiceRuntime?, healthy: Bool) throws -> Bool {
        guard request.start == wasRunning, runtime?.acknowledges(request) == true,
              !wasRunning || healthy else { return false }
        guard installedBuild == targetBuild else { return false }
        try FileManager.default.removeItem(at: Self.path(root: root))
        return true
    }
    /// A healthy old build after an abort is also a completed restoration. Keep audit
    /// history separately so future launches/check errors cannot replay its run state.
    @discardableResult
    public func completeRestoration(root: URL, installedBuild: String, request: ServiceRequest, runtime: ServiceRuntime?, healthy: Bool) throws -> Bool {
        guard request.start == wasRunning, runtime?.acknowledges(request) == true,
              !wasRunning || healthy else { throw ConfigurationError("The server has not acknowledged update recovery.") }
        try writePrivateJSON(self, to: root.appendingPathComponent("app-update-history.json"))
        try FileManager.default.removeItem(at: Self.path(root: root))
        return installedBuild == targetBuild
    }

}
