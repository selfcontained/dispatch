import DispatchCore
import Foundation
import XCTest

final class LegacyMigrationTests: XCTestCase {
    private var base: URL!
    private var legacy: URL { base.appendingPathComponent(".dispatch-mac-preview") }
    private var root: URL { base.appendingPathComponent(".dispatch-mac") }

    override func setUpWithError() throws {
        base = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-legacy-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: legacy.appendingPathComponent("agents/agt_1"), withIntermediateDirectories: true)
        try Data("journal".utf8).write(to: legacy.appendingPathComponent("agents/agt_1/journal.jsonl"))
        try Configuration(databaseURL: "postgres://localhost/external").save(to: legacy.appendingPathComponent("configuration.json"))
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: base) }

    func testMovesDataLeavesSymlinkAndRestoresRunningState() throws {
        let migration = LegacyMigration(legacy: legacy, root: root)
        XCTAssertTrue(migration.pending)
        var stopped: URL?
        let running = try migration.run(wasRunning: true, stopService: { stopped = $0 }, renameDatabase: { _ in nil })
        XCTAssertTrue(running)
        XCTAssertEqual(stopped?.standardizedFileURL.path, legacy.standardizedFileURL.path)
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("agents/agt_1/journal.jsonl")), "journal")
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: legacy.path), root.path)
        // Agents and stored file paths keep resolving through the old location.
        XCTAssertEqual(try String(contentsOf: legacy.appendingPathComponent("agents/agt_1/journal.jsonl")), "journal")
        // The running state is kept until the new service acknowledges it, across relaunches.
        XCTAssertTrue(migration.pending)
        XCTAssertTrue(try migration.run(wasRunning: false, stopService: { _ in XCTFail("already moved") }, renameDatabase: { _ in nil }))
        migration.complete()
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("legacy-migration.json").path))
        XCTAssertFalse(migration.pending)
    }

    func testFailedStopChangesNothingAndRetryKeepsOriginalState() throws {
        let migration = LegacyMigration(legacy: legacy, root: root)
        XCTAssertThrowsError(try migration.run(wasRunning: true, stopService: { _ in throw ConfigurationError("busy") }, renameDatabase: { _ in nil }))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
        XCTAssertTrue(migration.pending)
        // By the retry the old server is already stopped; the recorded intent still wins.
        XCTAssertTrue(try migration.run(wasRunning: false, stopService: { _ in }, renameDatabase: { _ in nil }))
    }

    func testResumesAfterMoveAndSyncsManagedURL() throws {
        let migration = LegacyMigration(legacy: legacy, root: root)
        let managed = "postgres://\(LocalDatabase.role):\(String(repeating: "a", count: 64))@127.0.0.1:55432/\(LocalDatabase.role)"
        XCTAssertThrowsError(try migration.run(wasRunning: true, stopService: { _ in }, renameDatabase: { _ in throw ConfigurationError("database failed") }))
        XCTAssertTrue(migration.pending, "A failed database step must be retried on the next launch")
        // Simulate the configuration still carrying the pre-rename URL.
        let legacyURL = managed.replacingOccurrences(of: LocalDatabase.role, with: "dispatch_preview")
        let old = Data("{\"port\":6768,\"databaseURL\":\"\(legacyURL)\",\"instanceID\":\"\(UUID().uuidString)\",\"managedDatabase\":true}".utf8)
        try old.write(to: root.appendingPathComponent("configuration.json"))
        try Configuration(databaseURL: managed, managedDatabase: true).save(to: root.appendingPathComponent("local-database.json"))
        XCTAssertTrue(try migration.run(wasRunning: false, stopService: { _ in XCTFail("already moved") }, renameDatabase: { _ in managed }))
        XCTAssertEqual(try Configuration.read(from: root.appendingPathComponent("configuration.json")).databaseURL, managed)
        migration.complete()
        XCTAssertFalse(migration.pending)
    }

    func testInterruptedUpdateRecoveryOwnsTheRestart() throws {
        let migration = LegacyMigration(legacy: legacy, root: root)
        XCTAssertFalse(try migration.run(wasRunning: false, stopService: { _ in }, renameDatabase: { _ in nil }))
        XCTAssertEqual(try migration.restoreRequest(wasRunning: false)?.start, false, "Without update recovery, migration replays its own state")
        // The old Sparkle handoff stopped a running server and kept its intent.
        try UpdateRecovery(wasRunning: true, targetBuild: "41").save(root: root)
        XCTAssertNil(try migration.restoreRequest(wasRunning: false))
        XCTAssertEqual(try UpdateRecovery.read(root: root), UpdateRecovery(wasRunning: true, targetBuild: "41"))
        XCTAssertFalse(migration.pending, "Update recovery took ownership; migration must not replay a competing request")
    }

    func testMigratedRunningStateIsFoldedIntoUpdateRecovery() throws {
        let migration = LegacyMigration(legacy: legacy, root: root)
        XCTAssertTrue(try migration.run(wasRunning: true, stopService: { _ in }, renameDatabase: { _ in nil }))
        try UpdateRecovery(wasRunning: false, targetBuild: "41").save(root: root)
        XCTAssertNil(try migration.restoreRequest(wasRunning: true))
        XCTAssertEqual(try UpdateRecovery.read(root: root)?.wasRunning, true)
    }

    func testFreshInstallIsNotPending() {
        XCTAssertFalse(LegacyMigration(legacy: base.appendingPathComponent("missing"), root: root).pending)
    }
}
