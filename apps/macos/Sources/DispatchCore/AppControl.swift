import Foundation
import Security

/// Per-launch secret the server worker hands to its API and the menu app reads, so
/// only this installation's menu app can drive updates through the server.
public enum AppControlToken {
    public static func path(root: URL) -> URL { root.appendingPathComponent("app-control-token") }
    public static func create(root: URL) throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw ConfigurationError("Could not create the app control token.")
        }
        let token = bytes.map { String(format: "%02x", $0) }.joined()
        try writePrivateJSON(token, to: path(root: root))
        return token
    }
    public static func read(root: URL) -> String? {
        guard let data = try? Data(contentsOf: path(root: root)) else { return nil }
        return try? JSONDecoder().decode(String.self, from: data)
    }
}

/// What the menu app reports to the web app. Matches the server's state schema.
public struct AppUpdateState: Codable, Equatable {
    public enum Phase: String, Codable { case idle, checking, downloading, installing, recovery, error }
    public var version: String
    public var phase: Phase
    public var availableVersion: String?
    public var checkedAt: Date?
    public var error: String?
    public var automatic: Bool
    public init(version: String, phase: Phase, availableVersion: String?, checkedAt: Date?, error: String?, automatic: Bool) {
        self.version = version; self.phase = phase; self.availableVersion = availableVersion
        self.checkedAt = checkedAt; self.error = error; self.automatic = automatic
    }
    /// Optionals are sent as explicit nulls; the server requires every field.
    public func encoded() throws -> Data {
        let body: [String: Any] = [
            "version": version, "phase": phase.rawValue, "automatic": automatic,
            "availableVersion": availableVersion ?? NSNull(),
            "checkedAt": checkedAt.map { $0.ISO8601Format() } ?? NSNull(),
            "error": error ?? NSNull(),
        ]
        return try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
    }
}

/// Runs one send at a time; requests made meanwhile collapse into one more send,
/// which reads the state current when it starts. The receiver keeps whatever
/// arrives last, so overlapping sends could leave it holding an older state.
@MainActor
public final class LatestOnlySender {
    private let send: () async -> Void
    private var sending = false
    private var pending = false
    public init(send: @escaping () async -> Void) { self.send = send }
    public func request() {
        if sending { pending = true; return }
        sending = true
        Task {
            repeat {
                pending = false
                await send()
            } while pending
            sending = false
        }
    }
}

/// One message on the server's control stream.
public enum AppControlEvent: Equatable {
    case ready
    case command(String)

    /// Parses one SSE line; comments, blank lines and unknown events yield nil.
    public init?(line: String) {
        guard line.hasPrefix("data: "),
              let object = try? JSONSerialization.jsonObject(with: Data(line.dropFirst(6).utf8)) as? [String: Any] else { return nil }
        switch object["type"] as? String {
        case "ready": self = .ready
        case "command":
            guard let action = object["action"] as? String else { return nil }
            self = .command(action)
        default: return nil
        }
    }
}
