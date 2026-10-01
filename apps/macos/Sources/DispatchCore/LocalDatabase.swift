import Darwin
import Foundation
import Security

/// Owns only the app's private cluster. Never discovers or administers system Postgres.
public final class LocalDatabase {
    /// Managed role and database name. Builds before the release rename used `legacyRole`.
    public static let role = "dispatch_mac"
    static let legacyRole = "dispatch_preview"
    private static let migrationRole = "dispatch_mac_migration"
    private let root: URL
    private let binaries: URL
    private var lockFD: Int32 = -1
    private var data: URL { root.appendingPathComponent("postgres") }
    private var savedConfiguration: URL { root.appendingPathComponent("local-database.json") }

    public init(root: URL = AppPaths.root, binaries: URL) {
        self.root = root
        self.binaries = binaries
    }

    deinit { if lockFD >= 0 { close(lockFD) } }

    public func acquire() throws {
        guard lockFD < 0 else { return }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let fd = open(root.appendingPathComponent("database.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw ConfigurationError("Cannot open the local database lock.") }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            close(fd)
            throw ConfigurationError("The database is already in use. Stop the server before changing setup.")
        }
        lockFD = fd
    }

    public func configuration(port: Int, instanceID: String) throws -> Configuration {
        try acquire()
        if FileManager.default.fileExists(atPath: savedConfiguration.path) {
            var result = try Configuration.read(from: savedConfiguration)
            guard result.usesManagedDatabase else { throw ConfigurationError("The saved local database configuration is invalid.") }
            result.port = port
            result.instanceID = instanceID
            let activeURL = root.appendingPathComponent("configuration.json")
            var active = try? Configuration.read(from: activeURL)
            let running = FileManager.default.fileExists(atPath: data.appendingPathComponent("PG_VERSION").path)
                ? try run("pg_ctl", ["-D", data.path, "status"], allowed: [0, 3]) == 0 : false
            var url = URLComponents(string: result.databaseURL)!
            if !running && (url.port == port || (try? Self.availablePort(requested: url.port!)) == nil) {
                var replacement = try Self.availablePort()
                let reserved = [6767, port, active?.port ?? port]
                while reserved.contains(replacement) { replacement = try Self.availablePort() }
                url.port = replacement
                result.databaseURL = url.string!
            }
            try result.validate()
            // Canonical local metadata is saved first. The launcher reconciles it
            // again before every start, recovering interruption between these writes.
            try result.save(to: savedConfiguration)
            if active?.usesManagedDatabase == true {
                active!.databaseURL = result.databaseURL
                try active!.save(to: activeURL)
            }
            return result
        }
        guard !FileManager.default.fileExists(atPath: data.path) else {
            throw ConfigurationError("Local database credentials are missing. Your data has been kept; restore local-database.json from your backup.")
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw ConfigurationError("Could not generate a local database password.")
        }
        let password = bytes.map { String(format: "%02x", $0) }.joined()
        var databasePort = try Self.availablePort()
        while databasePort == port || databasePort == 6767 { databasePort = try Self.availablePort() }
        let result = Configuration(port: port, databaseURL: "postgres://\(Self.role):\(password)@127.0.0.1:\(databasePort)/\(Self.role)", instanceID: instanceID, managedDatabase: true)
        // Save credentials before initialization, so interrupted setup can safely retry.
        try result.save(to: savedConfiguration)
        return result
    }

    public func start(_ configuration: Configuration) throws {
        try acquire()
        try configuration.validate()
        guard configuration.usesManagedDatabase else { throw ConfigurationError("Expected a managed local database.") }
        let saved = try Configuration.read(from: savedConfiguration)
        guard saved.usesManagedDatabase, saved.databaseURL == configuration.databaseURL else {
            throw ConfigurationError("Local database credentials do not match. Run local setup again.")
        }
        let url = URLComponents(string: configuration.databaseURL)!
        if !FileManager.default.fileExists(atPath: data.path) {
            let staging = root.appendingPathComponent("postgres-initializing-\(UUID().uuidString)")
            let passwordFile = root.appendingPathComponent(".database-password-\(UUID().uuidString)")
            defer {
                try? FileManager.default.removeItem(at: passwordFile)
                try? FileManager.default.removeItem(at: staging)
            }
            guard FileManager.default.createFile(atPath: passwordFile.path, contents: Data((url.password! + "\n").utf8), attributes: [.posixPermissions: 0o600]) else {
                throw ConfigurationError("Cannot create private database credentials.")
            }
            try run("initdb", ["-D", staging.path, "-U", Self.role, "--pwfile", passwordFile.path, "--auth-local=scram-sha-256", "--auth-host=scram-sha-256", "--encoding=UTF8", "--locale=C"])
            try FileManager.default.moveItem(at: staging, to: data)
        }
        guard (try String(contentsOf: data.appendingPathComponent("PG_VERSION"))).trimmingCharacters(in: .whitespacesAndNewlines) == "17" else {
            throw ConfigurationError("Dispatch requires PostgreSQL 17 data. Your existing data has not been changed.")
        }
        do {
            if try run("pg_ctl", ["-D", data.path, "status"], allowed: [0, 3]) == 3 {
                // No public listener or shared Unix socket. SCRAM is required even on loopback.
                try run("pg_ctl", ["-D", data.path, "-l", root.appendingPathComponent("postgres.log").path, "-w", "-t", "30", "-o", "-h 127.0.0.1 -p \(url.port!) -k ''", "start"])
            }
            // pg_ctl readiness checks the PID file; authenticate and check cluster identity
            // before running SQL in case an unrelated process occupies the chosen port.
            let environment = ["PGHOST": "127.0.0.1", "PGPORT": String(url.port!), "PGUSER": Self.role, "PGPASSWORD": url.password!, "PGDATABASE": "postgres", "PGCONNECT_TIMEOUT": "5"]
            let actual = try output("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", "SHOW data_directory"], environment: environment)
            guard URL(fileURLWithPath: actual.trimmingCharacters(in: .whitespacesAndNewlines)).resolvingSymlinksInPath() == data.resolvingSymlinksInPath() else {
                throw ConfigurationError("The database port belongs to another database. Your data has not been changed.")
            }
            let exists = try output("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1 FROM pg_database WHERE datname = '\(Self.role)'"], environment: environment)
            if exists.trimmingCharacters(in: .whitespacesAndNewlines) != "1" {
                try run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-c", "CREATE DATABASE \(Self.role)"], environment: environment)
            }
        } catch {
            try? stop()
            throw error
        }
    }

    /// Renames a pre-release cluster's role and database to `role`, then saves the new
    /// credentials. Returns the new URL, or nil when nothing needed renaming. Postgres
    /// refuses to rename the session user, so a temporary superuser performs that step.
    /// Every step checks current state first, so an interrupted run can simply repeat.
    public func migrateLegacyRole() throws -> String? {
        guard FileManager.default.fileExists(atPath: savedConfiguration.path) else { return nil }
        var saved = try JSONDecoder().decode(Configuration.self, from: Data(contentsOf: savedConfiguration))
        guard saved.usesManagedDatabase, var url = URLComponents(string: saved.databaseURL),
              url.user == Self.legacyRole, let password = url.password, password.allSatisfy({ $0.isHexDigit }) else { return nil }
        try acquire()
        func saveRenamed() throws -> String {
            url.user = Self.role
            url.path = "/\(Self.role)"
            saved.databaseURL = url.string!
            try saved.save(to: savedConfiguration)
            return saved.databaseURL
        }
        // Setup saves credentials before the first start creates the cluster. With no
        // cluster yet, the next start initializes it under the release names.
        if !FileManager.default.fileExists(atPath: data.path) { return try saveRenamed() }
        guard (try? String(contentsOf: data.appendingPathComponent("PG_VERSION")))?.trimmingCharacters(in: .whitespacesAndNewlines) == "17" else {
            throw ConfigurationError("Dispatch requires PostgreSQL 17 data. Your existing data has not been changed.")
        }
        // A previous attempt can leave the cluster running (a timed-out start keeps
        // starting in the background, or the app quit mid-migration). Reuse it on its port.
        let running = try run("pg_ctl", ["-D", data.path, "status"], allowed: [0, 3]) == 0
        if running, let port = runningPort() { url.port = port }
        else if (try? Self.availablePort(requested: url.port!)) == nil { url.port = try Self.availablePort() }
        func environment(_ user: String) -> [String: String] {
            ["PGHOST": "127.0.0.1", "PGPORT": String(url.port!), "PGUSER": user, "PGPASSWORD": password, "PGDATABASE": "postgres", "PGCONNECT_TIMEOUT": "5"]
        }
        func sql(_ user: String, _ statement: String) throws {
            // Over stdin, so the password in CREATE ROLE never appears in process arguments.
            try run("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1"], environment: environment(user), input: statement)
        }
        func query(_ user: String, _ statement: String) throws -> String {
            try output("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", statement], environment: environment(user)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        do {
            if !running {
                try run("pg_ctl", ["-D", data.path, "-l", root.appendingPathComponent("postgres.log").path, "-w", "-t", "30", "-o", "-h 127.0.0.1 -p \(url.port!) -k ''", "start"])
            }
            let renamed = (try? query(Self.role, "SELECT 1")) == "1"
            let actual = try query(renamed ? Self.role : Self.legacyRole, "SHOW data_directory")
            guard URL(fileURLWithPath: actual).resolvingSymlinksInPath() == data.resolvingSymlinksInPath() else {
                throw ConfigurationError("The database port belongs to another database. Your data has not been changed.")
            }
            if !renamed {
                try sql(Self.legacyRole, """
                    DO $$ BEGIN
                      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '\(Self.migrationRole)') THEN
                        CREATE ROLE \(Self.migrationRole) SUPERUSER LOGIN PASSWORD '\(password)';
                      END IF;
                    END $$;
                    """)
                try sql(Self.migrationRole, "ALTER ROLE \(Self.legacyRole) RENAME TO \(Self.role);")
            }
            if try query(Self.role, "SELECT 1 FROM pg_database WHERE datname = '\(Self.legacyRole)'") == "1" {
                try sql(Self.role, "ALTER DATABASE \(Self.legacyRole) RENAME TO \(Self.role);")
            }
            try sql(Self.role, "DROP ROLE IF EXISTS \(Self.migrationRole);")
        } catch {
            try? stop()
            throw error
        }
        try stop()
        return try saveRenamed()
    }

    /// The listening port recorded in a running cluster's postmaster.pid (fourth line).
    private func runningPort() -> Int? {
        guard let pid = try? String(contentsOf: data.appendingPathComponent("postmaster.pid")) else { return nil }
        let lines = pid.split(separator: "\n", omittingEmptySubsequences: false)
        return lines.count > 3 ? Int(lines[3].trimmingCharacters(in: .whitespaces)) : nil
    }

    public func stop() throws {
        guard lockFD >= 0 else { throw ConfigurationError("Local database lock is required.") }
        if FileManager.default.fileExists(atPath: data.appendingPathComponent("PG_VERSION").path),
           try run("pg_ctl", ["-D", data.path, "status"], allowed: [0, 3]) == 0 {
            try run("pg_ctl", ["-D", data.path, "-m", "fast", "-w", "-t", "30", "stop"])
        }
    }

    private func process(_ name: String, _ arguments: [String], environment: [String: String]) throws -> Process {
        let executable = binaries.appendingPathComponent("bin/\(name)")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw ConfigurationError("The bundled database is missing. Download a complete Dispatch app.")
        }
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        // Ignore PG*, DYLD*, and locale settings from the calling shell.
        process.environment = ["PATH": "/usr/bin:/bin", "HOME": FileManager.default.homeDirectoryForCurrentUser.path, "LC_ALL": "C"].merging(environment) { _, value in value }
        process.currentDirectoryURL = root
        return process
    }

    @discardableResult
    private func run(_ name: String, _ arguments: [String], environment: [String: String] = [:], allowed: Set<Int32> = [0], input: String? = nil) throws -> Int32 {
        let process = try process(name, arguments, environment: environment)
        let logURL = root.appendingPathComponent("database-setup.log")
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        let log = try FileHandle(forWritingTo: logURL)
        defer { try? log.close() }
        try log.seekToEnd()
        process.standardOutput = log
        process.standardError = log
        let stdin = input.map { _ in Pipe() }
        if let stdin { process.standardInput = stdin }
        try process.run()
        if let stdin, let input {
            stdin.fileHandleForWriting.write(Data(input.utf8))
            try stdin.fileHandleForWriting.close()
        }
        process.waitUntilExit()
        guard allowed.contains(process.terminationStatus) else {
            throw ConfigurationError("Local database \(name) failed. See database-setup.log and postgres.log in the Dispatch data folder, then retry setup. Your existing data has been kept.")
        }
        return process.terminationStatus
    }

    private func output(_ name: String, _ arguments: [String], environment: [String: String]) throws -> String {
        let process = try process(name, arguments, environment: environment)
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw ConfigurationError("Could not connect to the private database. Check postgres.log in the Dispatch data folder and retry setup.") }
        return String(decoding: data, as: UTF8.self)
    }

    private static func availablePort(requested: Int = 0) throws -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ConfigurationError("Cannot choose a local database port.") }
        defer { close(fd) }
        // Match PostgreSQL's bind behavior: closed connections in TIME_WAIT do
        // not make the saved port unavailable. A live listener still conflicts.
        var reuse: Int32 = 1
        guard setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
            throw ConfigurationError("Cannot check the local database port.")
        }
        var address = sockaddr_in()
        address.sin_port = UInt16(requested).bigEndian
        address.sin_family = sa_family_t(AF_INET)
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        var size = socklen_t(MemoryLayout<sockaddr_in>.size)
        let read = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &size) }
        }
        guard bound == 0, read == 0 else { throw ConfigurationError("Cannot choose a local database port.") }
        return Int(UInt16(bigEndian: address.sin_port))
    }
}
