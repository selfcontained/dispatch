import DispatchCore
import Foundation
import XCTest

final class LocalDatabaseTests: XCTestCase {
    func testIsolatedModeCannotUseUserState() throws {
        defer { PreviewPaths.testRoot = nil }
        for path in ["/Users/brad/.dispatch-mac-preview", "/tmp", "/tmp/something-else", "/tmp/dispatch-macos-test-a/nested"] {
            XCTAssertThrowsError(try PreviewPaths.enableIsolatedTest(root: path))
        }
        try PreviewPaths.enableIsolatedTest(root: "/tmp/dispatch-macos-test-unit")
        XCTAssertEqual(PreviewPaths.root.lastPathComponent, "dispatch-macos-test-unit")
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
        XCTAssertEqual(try database.configuration(port: 6768, instanceID: config.instanceID), config)
        XCTAssertThrowsError(try LocalDatabase(root: root, binaries: root).acquire())
        let permissions = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent("local-database.json").path)[.posixPermissions] as? Int
        XCTAssertEqual(permissions, 0o600)
        var invalid = config
        invalid.databaseURL = config.databaseURL.replacingOccurrences(of: "127.0.0.1", with: "example.com")
        XCTAssertThrowsError(try invalid.validate())
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
    }

    private func sql(_ statement: String, configuration: Configuration, binaries: URL, password: String? = nil) throws -> (Int32, String) {
        let url = URLComponents(string: configuration.databaseURL)!
        let process = Process()
        process.executableURL = binaries.appendingPathComponent("bin/psql")
        process.arguments = ["-X", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1", "-c", statement]
        process.environment = ["PGHOST": "127.0.0.1", "PGPORT": String(url.port!), "PGUSER": url.user!, "PGPASSWORD": password ?? url.password!, "PGDATABASE": "dispatch_preview", "PGCONNECT_TIMEOUT": "5"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: data, as: UTF8.self))
    }
}
