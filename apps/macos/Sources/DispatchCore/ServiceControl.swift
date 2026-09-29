import Foundation

public struct StartupPreferences: Codable {
    public var startServerAtLogin: Bool
    public init(startServerAtLogin: Bool = true) { self.startServerAtLogin = startServerAtLogin }
    public static func read(root: URL = PreviewPaths.root) -> Self {
        (try? JSONDecoder().decode(Self.self, from: Data(contentsOf: root.appendingPathComponent("startup.json")))) ?? Self()
    }
    public func save(root: URL = PreviewPaths.root) throws { try writePrivateJSON(self, to: root.appendingPathComponent("startup.json")) }
}

public struct ServiceRequest: Codable {
    public let id: UUID
    public let start: Bool
    public let created: Date
    public init(start: Bool) { id = UUID(); self.start = start; created = Date() }
    public func save(root: URL = PreviewPaths.root) throws { try writePrivateJSON(self, to: root.appendingPathComponent("service-request.json")) }
    public static func take(root: URL = PreviewPaths.root) -> Self? {
        let path = root.appendingPathComponent("service-request.json")
        guard let data = try? Data(contentsOf: path) else { return nil }
        try? FileManager.default.removeItem(at: path)
        guard let result = try? JSONDecoder().decode(Self.self, from: data), abs(result.created.timeIntervalSinceNow) < 60 else { return nil }
        return result
    }
}

public struct ServiceRuntime: Codable {
    public var phase: String
    public var configuration: Configuration?
    public var requestID: UUID?
    public var updated: Date = Date()
    public var isActive: Bool { phase == "starting" || phase == "running" || phase == "stopping" }
    public init(phase: String, configuration: Configuration? = nil, requestID: UUID? = nil) {
        self.phase = phase; self.configuration = configuration; self.requestID = requestID
    }
    public static func read(root: URL = PreviewPaths.root) -> Self? {
        guard let data = try? Data(contentsOf: root.appendingPathComponent("service-runtime.json")),
              let state = try? JSONDecoder().decode(Self.self, from: data),
              abs(state.updated.timeIntervalSinceNow) < 10 else { return nil }
        return state
    }
    public func acknowledges(_ request: ServiceRequest) -> Bool {
        requestID == request.id && phase == (request.start ? "running" : "stopped")
    }
    public func save(root: URL = PreviewPaths.root) throws {
        var current = self; current.updated = Date()
        try writePrivateJSON(current, to: root.appendingPathComponent("service-runtime.json"))
    }
}

public func writePrivateJSON<T: Encodable>(_ value: T, to path: URL) throws {
    try FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let temporary = path.deletingLastPathComponent().appendingPathComponent(".write-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: temporary) }
    guard FileManager.default.createFile(atPath: temporary.path, contents: try JSONEncoder().encode(value), attributes: [.posixPermissions: 0o600]) else {
        throw ConfigurationError("Could not save settings.")
    }
    if FileManager.default.fileExists(atPath: path.path) { _ = try FileManager.default.replaceItemAt(path, withItemAt: temporary) }
    else { try FileManager.default.moveItem(at: temporary, to: path) }
}
