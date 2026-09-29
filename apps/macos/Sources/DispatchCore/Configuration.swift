import Foundation

public struct Configuration: Codable, Equatable {
    public var port: Int
    public var databaseURL: String
    public var instanceID: String
    public var managedDatabase: Bool?

    public var usesManagedDatabase: Bool { managedDatabase == true }

    public init(port: Int = 6768, databaseURL: String = "", instanceID: String = UUID().uuidString, managedDatabase: Bool? = nil) {
        self.port = port
        self.databaseURL = databaseURL
        self.instanceID = instanceID
        self.managedDatabase = managedDatabase
    }

    public var serverURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    public func validate() throws {
        guard (1024...65535).contains(port), port != 6767 else {
            throw ConfigurationError("Choose a port between 1024 and 65535 other than 6767 (reserved for your existing Dispatch installation).")
        }
        guard let url = URLComponents(string: databaseURL),
              ["postgres", "postgresql"].contains(url.scheme ?? ""),
              let host = url.host, !host.isEmpty,
              url.fragment == nil,
              url.path.count > 1 else {
            throw ConfigurationError("Enter a PostgreSQL connection URL with a host and a dedicated preview database name.")
        }
        let database = String(url.path.dropFirst())
        guard !["dispatch", "postgres", ".", ".."].contains(database), !database.contains("/") else {
            throw ConfigurationError("Use a dedicated preview database, not the production ‘dispatch’ database or the ‘postgres’ maintenance database.")
        }
        // libpq parameters can otherwise override the database in the URL path.
        let allowedParameters: Set<String> = ["sslmode", "sslcert", "sslkey", "sslrootcert", "connect_timeout", "application_name"]
        guard (url.queryItems ?? []).allSatisfy({ allowedParameters.contains($0.name) }) else {
            throw ConfigurationError("The connection URL contains unsupported parameters. Specify the database and host in the URL itself.")
        }
        if usesManagedDatabase {
            guard url.host == "127.0.0.1", let databasePort = url.port,
                  (1024...65535).contains(databasePort), databasePort != 6767, databasePort != port,
                  url.user == "dispatch_preview", url.path == "/dispatch_preview",
                  let password = url.password, password.count == 64,
                  password.allSatisfy({ $0.isHexDigit }), (url.queryItems ?? []).isEmpty else {
                throw ConfigurationError("The managed database configuration is invalid. Run local setup again.")
            }
        }
        guard UUID(uuidString: instanceID) != nil else {
            throw ConfigurationError("The preview instance identifier is invalid. Restore a valid configuration before starting.")
        }
    }

    public static func read(from url: URL) throws -> Configuration {
        let config = try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
        try config.validate()
        return config
    }

    public func save(to url: URL) throws {
        try validate()
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // Atomic replacement, including private permissions on the temporary file.
        let temporary = directory.appendingPathComponent(".configuration-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: temporary) }
        let data = try JSONEncoder().encode(self)
        guard FileManager.default.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw ConfigurationError("Could not save the preview configuration.")
        }
        if FileManager.default.fileExists(atPath: url.path) {
            _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary)
        } else {
            try FileManager.default.moveItem(at: temporary, to: url)
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

public struct ConfigurationError: LocalizedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

public enum PreviewPaths {
    /// Explicit test mode is confined to a fresh temporary directory, never user state.
    public static var testRoot: URL?
    public static func enableIsolatedTest(root: String) throws {
        let url = URL(fileURLWithPath: root).resolvingSymlinksInPath()
        guard url.deletingLastPathComponent().path == URL(fileURLWithPath: "/tmp").resolvingSymlinksInPath().path,
              url.lastPathComponent.hasPrefix("dispatch-macos-test-") else {
            throw ConfigurationError("Isolated testing requires a dispatch-macos-test-* directory directly under /tmp.")
        }
        testRoot = url
    }
    public static var root: URL {
        testRoot ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".dispatch-mac-preview", isDirectory: true)
    }
    public static var configuration: URL { root.appendingPathComponent("configuration.json") }
    public static var log: URL { root.appendingPathComponent("server.log") }
}

/// Validation mode is a browser-only connection to an explicitly selected dev stack.
/// It never registers services, changes server configuration, or touches production.
public func validationURL(_ value: String) throws -> URL {
    guard let url = URL(string: value), url.scheme == "http", url.host == "127.0.0.1",
          let port = url.port, (1024...65535).contains(port), port != 6767,
          url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
          url.path.isEmpty || url.path == "/" else {
        throw ConfigurationError("Validation requires an HTTP loopback URL with an explicit non-production port.")
    }
    return url
}
