import DispatchCore
import Darwin
import Foundation
import XCTest

final class LocalDatabaseTests: XCTestCase {
    func testIsolatedModeCannotUseUserState() throws {
        defer { AppPaths.testRoot = nil }
        for path in ["/Users/brad/.dispatch-mac", "/tmp", "/tmp/something-else", "/tmp/dispatch-macos-test-a/nested"] {
            XCTAssertThrowsError(try AppPaths.enableIsolatedTest(root: path))
        }
        try AppPaths.enableIsolatedTest(root: "/tmp/dispatch-macos-test-unit")
        XCTAssertEqual(AppPaths.root.lastPathComponent, "dispatch-macos-test-unit")
    }

    func testOldConfigurationStillUsesExternalDatabase() throws {
        let json = Data("{\"port\":6768,\"databaseURL\":\"postgres://localhost/preview\",\"instanceID\":\"\(UUID().uuidString)\"}".utf8)
        let config = try JSONDecoder().decode(Configuration.self, from: json)
        XCTAssertFalse(config.usesManagedDatabase)
        try config.validate()
    }

    func testGeneratedCredentialsPersistAndSetupIsExclusive() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = LocalDatabase(root: root, binaries: root)
        let config = try database.configuration(port: 6768, instanceID: UUID().uuidString)
        XCTAssertTrue(config.usesManagedDatabase)
        // Setup must still be able to repair a malformed active configuration.
        try Data("invalid".utf8).write(to: root.appendingPathComponent("configuration.json"))
        XCTAssertEqual(try database.configuration(port: 6768, instanceID: config.instanceID), config)
        XCTAssertThrowsError(try LocalDatabase(root: root, binaries: root).acquire())
        let permissions = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent("local-database.json").path)[.posixPermissions] as? Int
        XCTAssertEqual(permissions, 0o600)
        var invalid = config
        invalid.databaseURL = config.databaseURL.replacingOccurrences(of: "127.0.0.1", with: "example.com")
        XCTAssertThrowsError(try invalid.validate())
    }

    private func writeLegacyCredentials(root: URL) throws -> String {
        let url = "postgres://dispatch_preview:\(String(repeating: "ab", count: 32))@127.0.0.1:55433/dispatch_preview"
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try JSONEncoder().encode(Configuration(databaseURL: url, managedDatabase: true)).write(to: root.appendingPathComponent("local-database.json"))
        return url
    }

    func testLegacyCredentialsWithoutClusterAreRenamedForFirstStart() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-rename-uninit-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        _ = try writeLegacyCredentials(root: root)
        let renamed = try XCTUnwrap(try LocalDatabase(root: root, binaries: root).migrateLegacyRole())
        XCTAssertEqual(URLComponents(string: renamed)?.user, LocalDatabase.role)
        XCTAssertEqual(try Configuration.read(from: root.appendingPathComponent("local-database.json")).databaseURL, renamed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("postgres").path))
    }

    func testFailedMigrationStartStopsTheCluster() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-rename-start-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        _ = try writeLegacyCredentials(root: root)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("postgres"), withIntermediateDirectories: true)
        try Data("17\n".utf8).write(to: root.appendingPathComponent("postgres/PG_VERSION"))
        // A start that times out while the server keeps starting in the background.
        let bin = root.appendingPathComponent("fake/bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let flag = root.appendingPathComponent("fake/running").path, calls = root.appendingPathComponent("fake/calls").path
        let script = """
            #!/bin/sh
            for a in "$@"; do last="$a"; done
            echo "$last" >> '\(calls)'
            case "$last" in
              status) [ -f '\(flag)' ] && exit 0 || exit 3 ;;
              start) touch '\(flag)'; exit 1 ;;
              stop) rm -f '\(flag)'; exit 0 ;;
            esac
            """
        try Data(script.utf8).write(to: bin.appendingPathComponent("pg_ctl"))
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: bin.appendingPathComponent("pg_ctl").path)
        XCTAssertThrowsError(try LocalDatabase(root: root, binaries: root.appendingPathComponent("fake")).migrateLegacyRole())
        XCTAssertFalse(FileManager.default.fileExists(atPath: flag), "A failed start must not leave the cluster running")
        XCTAssertEqual(try String(contentsOfFile: calls).split(separator: "\n"), ["status", "start", "status", "stop"])
    }

    func testPreReleaseRoleAndDatabaseAreRenamedWithDataKept() throws {
        guard let path = ProcessInfo.processInfo.environment["DISPATCH_TEST_POSTGRES_BUNDLE"] else {
            throw XCTSkip("Set DISPATCH_TEST_POSTGRES_BUNDLE to exercise the real bundled PostgreSQL.")
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-rename-test-\(UUID().uuidString)")
        let binaries = URL(fileURLWithPath: path)
        var database: LocalDatabase? = LocalDatabase(root: root, binaries: binaries)
        defer { try? FileManager.default.removeItem(at: root) }
        // Set up a cluster the way pre-release builds did, then use the current code path to fill it.
        let current = try database!.configuration(port: 6768, instanceID: UUID().uuidString)
        try database!.start(current)
        XCTAssertEqual(try sql("CREATE TABLE kept (value text); INSERT INTO kept VALUES ('agents');", configuration: current, binaries: binaries).0, 0)
        let legacyURL = current.databaseURL.replacingOccurrences(of: LocalDatabase.role, with: "dispatch_preview")
        // Build the legacy identity from the current one: rename via a helper superuser.
        let password = URLComponents(string: current.databaseURL)!.password!
        XCTAssertEqual(try sql("CREATE ROLE helper SUPERUSER LOGIN PASSWORD '\(password)'", configuration: current, binaries: binaries, database: "postgres").0, 0)
        var helper = URLComponents(string: current.databaseURL)!; helper.user = "helper"
        var asHelper = current; asHelper.databaseURL = helper.string!
        XCTAssertEqual(try sql("ALTER ROLE \(LocalDatabase.role) RENAME TO dispatch_preview", configuration: asHelper, binaries: binaries, database: "postgres").0, 0)
        XCTAssertEqual(try sql("ALTER DATABASE \(LocalDatabase.role) RENAME TO dispatch_preview", configuration: asHelper, binaries: binaries, database: "postgres").0, 0)
        var legacy = current; legacy.databaseURL = legacyURL
        XCTAssertEqual(try sql("DROP ROLE helper", configuration: legacy, binaries: binaries, database: "postgres").0, 0)
        // Leave the cluster running, as after a timed-out start or a crash mid-migration.
        database = nil // Releases the setup lock for the migration.
        try JSONEncoder().encode(legacy).write(to: root.appendingPathComponent("local-database.json"))

        let renamed = try XCTUnwrap(try LocalDatabase(root: root, binaries: binaries).migrateLegacyRole())
        XCTAssertEqual(URLComponents(string: renamed)?.user, LocalDatabase.role)
        XCTAssertNil(try LocalDatabase(root: root, binaries: binaries).migrateLegacyRole(), "A second run has nothing to rename")
        var migrated = current; migrated.databaseURL = renamed
        XCTAssertEqual(try Configuration.read(from: root.appendingPathComponent("local-database.json")), migrated)
        let after = LocalDatabase(root: root, binaries: binaries)
        defer { try? after.stop() }
        try after.start(migrated)
        XCTAssertEqual(try sql("SELECT value FROM kept", configuration: migrated, binaries: binaries).1.trimmingCharacters(in: .whitespacesAndNewlines), "agents")
        XCTAssertEqual(try sql("SELECT count(*) FROM pg_roles WHERE rolname IN ('dispatch_preview', 'dispatch_mac_migration')", configuration: migrated, binaries: binaries).1.trimmingCharacters(in: .whitespacesAndNewlines), "0")
        XCTAssertNotEqual(try sql("SELECT 1", configuration: legacy, binaries: binaries, database: "postgres").0, 0)
    }

    func testBundledDatabaseCreationRestartAuthenticationAndRetry() throws {
        guard let path = ProcessInfo.processInfo.environment["DISPATCH_TEST_POSTGRES_BUNDLE"] else {
            throw XCTSkip("Set DISPATCH_TEST_POSTGRES_BUNDLE to exercise the real bundled PostgreSQL.")
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-database-test-\(UUID().uuidString)")
        let binaries = URL(fileURLWithPath: path)
        var failedSetup: LocalDatabase? = LocalDatabase(root: root, binaries: root.appendingPathComponent("missing-bundle"))
        let original = try failedSetup!.configuration(port: 6768, instanceID: UUID().uuidString)
        XCTAssertThrowsError(try failedSetup!.start(original))
        failedSetup = nil
        let database = LocalDatabase(root: root, binaries: binaries)
        defer { try? database.stop(); try? FileManager.default.removeItem(at: root) }
        let config = try database.configuration(port: 6768, instanceID: original.instanceID)
        XCTAssertEqual(config, original, "Failed initialization must retain recoverable credentials")
        try database.start(config)
        XCTAssertEqual(try sql("CREATE TABLE persistence_check (value text); INSERT INTO persistence_check VALUES ('kept');", configuration: config, binaries: binaries).0, 0)
        try database.stop()
        try database.start(config)
        let persisted = try sql("SELECT value FROM persistence_check", configuration: config, binaries: binaries)
        XCTAssertEqual(persisted.0, 0)
        XCTAssertEqual(persisted.1.trimmingCharacters(in: .whitespacesAndNewlines), "kept")
        let unauthorized = try sql("SELECT 1", configuration: config, binaries: binaries, password: "wrong-password")
        XCTAssertNotEqual(unauthorized.0, 0)
        try database.stop()
        // Re-running setup restores the same credentials and never initializes over data.
        XCTAssertEqual(try database.configuration(port: 6768, instanceID: config.instanceID), config)
        try database.start(config)
        XCTAssertEqual(try sql("SELECT value FROM persistence_check", configuration: config, binaries: binaries).1.trimmingCharacters(in: .whitespacesAndNewlines), "kept")
        try database.stop()
        try config.save(to: root.appendingPathComponent("configuration.json"))
        let listener = socket(AF_INET, SOCK_STREAM, 0)
        XCTAssertGreaterThanOrEqual(listener, 0)
        defer { close(listener) }
        var reuse: Int32 = 1
        _ = setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        address.sin_port = UInt16(URLComponents(string: config.databaseURL)!.port!).bigEndian
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        XCTAssertEqual(bound, 0)
        XCTAssertEqual(listen(listener, 1), 0)
        let recovered = try database.configuration(port: 6768, instanceID: config.instanceID)
        let oldURL = URLComponents(string: config.databaseURL)!
        let newURL = URLComponents(string: recovered.databaseURL)!
        XCTAssertNotEqual(newURL.port, oldURL.port)
        XCTAssertEqual(newURL.password, oldURL.password)
        XCTAssertEqual(try Configuration.read(from: root.appendingPathComponent("local-database.json")), recovered)
        XCTAssertEqual(try Configuration.read(from: root.appendingPathComponent("configuration.json")), recovered)
        // Simulate interruption after the canonical metadata changed but before
        // the active config write: the next launcher/setup reconciliation repairs it.
        try config.save(to: root.appendingPathComponent("configuration.json"))
        XCTAssertEqual(try database.configuration(port: 6768, instanceID: config.instanceID), recovered)
        XCTAssertEqual(try Configuration.read(from: root.appendingPathComponent("configuration.json")), recovered)
        try database.start(recovered)
        XCTAssertEqual(try sql("SELECT value FROM persistence_check", configuration: recovered, binaries: binaries).1.trimmingCharacters(in: .whitespacesAndNewlines), "kept")
        XCTAssertEqual(try database.configuration(port: 6768, instanceID: config.instanceID), recovered, "Never move a running private cluster")
        XCTAssertEqual(fcntl(listener, F_GETFD), 0, "Unrelated listener remains open")
    }

    func testStoppedDatabasePortSurvivesTCPTimeWait() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = LocalDatabase(root: root, binaries: root)
        let config = try database.configuration(port: 6768, instanceID: UUID().uuidString)
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        address.sin_port = UInt16(URLComponents(string: config.databaseURL)!.port!).bigEndian
        let listener = socket(AF_INET, SOCK_STREAM, 0)
        let client = socket(AF_INET, SOCK_STREAM, 0)
        var reuse: Int32 = 1
        XCTAssertEqual(setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size)), 0)
        try withUnsafePointer(to: &address) { pointer in
            try pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { endpoint in
                guard Darwin.bind(listener, endpoint, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0,
                      listen(listener, 1) == 0,
                      connect(client, endpoint, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 else {
                    close(listener); close(client)
                    throw ConfigurationError("Cannot create isolated TCP fixture")
                }
            }
        }
        let connection = accept(listener, nil, nil)
        XCTAssertGreaterThanOrEqual(connection, 0)
        // Server initiates close, leaving its local port in TIME_WAIT after the
        // client acknowledges the FIN. PostgreSQL can rebind with SO_REUSEADDR.
        close(connection)
        var byte: UInt8 = 0
        XCTAssertEqual(recv(client, &byte, 1, 0), 0)
        close(client)
        close(listener)
        XCTAssertEqual(try database.configuration(port: config.port, instanceID: config.instanceID), config)
    }

    private func sql(_ statement: String, configuration: Configuration, binaries: URL, password: String? = nil, database: String = LocalDatabase.role) throws -> (Int32, String) {
        let url = URLComponents(string: configuration.databaseURL)!
        let process = Process()
        process.executableURL = binaries.appendingPathComponent("bin/psql")
        process.arguments = ["-X", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1", "-c", statement]
        process.environment = ["PGHOST": "127.0.0.1", "PGPORT": String(url.port!), "PGUSER": url.user!, "PGPASSWORD": password ?? url.password!, "PGDATABASE": database, "PGCONNECT_TIMEOUT": "5"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: data, as: UTF8.self))
    }
}
