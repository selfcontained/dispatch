import XCTest
import Foundation
import Darwin
import CryptoKit
@testable import DispatchCore

final class NativeRecoveryTests: XCTestCase {
    private func fixture() throws -> (URL, NativeRecoveryStore, NativeRecoveryJournal) {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-native-recovery-\(UUID().uuidString)").resolvingSymlinksInPath()
        let root = base.appendingPathComponent("state")
        let app = base.appendingPathComponent("Dispatch.app")
        try FileManager.default.createDirectory(at: app.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: URL(fileURLWithPath: "/usr/bin/true"), to: app.appendingPathComponent("Contents/MacOS/Dispatch"))
        let plist: [String: Any] = ["CFBundleIdentifier": "test.dispatch.recovery", "CFBundleVersion": "1", "CFBundleExecutable": "Dispatch", "CFBundlePackageType": "APPL"]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: app.appendingPathComponent("Contents/Info.plist"))
        try RecoveryCommand.run(URL(fileURLWithPath: "/usr/bin/codesign"), ["--force", "--sign", "-", app.path])
        let config = Configuration(databaseURL: "postgres://dispatch_mac:\(String(repeating: "ab", count: 32))@127.0.0.1:55431/dispatch_mac", managedDatabase: true)
        try config.save(to: root.appendingPathComponent("configuration.json"))
        try Data("previous-session".utf8).write(to: root.appendingPathComponent("session"))
        let store = NativeRecoveryStore(root: root); try store.initialize()
        let journal = NativeRecoveryJournal(instanceID: config.instanceID, appPath: app.path, oldBuild: "1", targetBuild: "2", targetIdentity: "signed-artifact-2", wasRunning: true)
        return (base, store, journal)
    }
    func testVerifiedSnapshotRestoresAppAndStatePreservingFailedCopiesExactlyOnce() throws {
        let (base, store, initial) = try fixture(); defer { try? FileManager.default.removeItem(at: base) }
        var journal = initial; try store.save(journal)
        var verified = false
        try store.backup(&journal, verifyCluster: { _, _ in verified = true })
        XCTAssertTrue(verified); XCTAssertEqual(journal.phase, .backedUp)
        try Data("failed-session".utf8).write(to: store.root.appendingPathComponent("session"))
        journal.phase = .probation; try store.save(journal)
        try store.restore(&journal, verifyCluster: { _, _ in })
        XCTAssertTrue(journal.restoredApp); XCTAssertTrue(journal.restoredState)
        XCTAssertEqual(try String(contentsOf: store.root.appendingPathComponent("session")), "previous-session")
        let failed = store.directory.appendingPathComponent("failed-state-" + journal.id)
        XCTAssertEqual(try String(contentsOf: failed.appendingPathComponent("session")), "failed-session")
        try store.restore(&journal, verifyCluster: { _, _ in XCTFail("A resumed restore must not start a second attempt") })
        XCTAssertEqual(try String(contentsOf: failed.appendingPathComponent("session")), "failed-session")
    }
    func testCommittedRecoveryNeverRewindsAcceptedData() throws {
        let (base, store, initial) = try fixture(); defer { try? FileManager.default.removeItem(at: base) }
        var journal = initial; try store.backup(&journal, verifyCluster: { _, _ in })
        journal.phase = .committed; try store.save(journal)
        try Data("accepted-after-commit".utf8).write(to: store.root.appendingPathComponent("session"))
        XCTAssertThrowsError(try store.restore(&journal, verifyCluster: { _, _ in XCTFail("Must reject before verification") }))
        XCTAssertEqual(try String(contentsOf: store.root.appendingPathComponent("session")), "accepted-after-commit")
    }
    func testCorruptedBackupFailsBeforeReplacingLiveState() throws {
        let (base, store, initial) = try fixture(); defer { try? FileManager.default.removeItem(at: base) }
        var journal = initial; try store.backup(&journal, verifyCluster: { _, _ in })
        try Data("corrupt".utf8).write(to: store.transaction(journal).appendingPathComponent("state/session"))
        journal.phase = .probation
        XCTAssertThrowsError(try store.restore(&journal, verifyCluster: { _, _ in }))
        XCTAssertFalse(journal.restoreStarted)
        XCTAssertEqual(try String(contentsOf: store.root.appendingPathComponent("session")), "previous-session")
    }
    func testResumeAfterStateRenameBeforeJournalWrite() throws {
        let (base, store, initial) = try fixture(); defer { try? FileManager.default.removeItem(at: base) }
        var journal = initial; try store.backup(&journal, verifyCluster: { _, _ in })
        journal.phase = .restoring; journal.restoreStarted = true; journal.restoredApp = true
        try store.save(journal)
        try FileManager.default.moveItem(at: store.root, to: store.directory.appendingPathComponent("failed-state-" + journal.id))
        try store.restore(&journal, verifyCluster: { _, _ in XCTFail("Already verified") })
        XCTAssertEqual(try String(contentsOf: store.root.appendingPathComponent("session")), "previous-session")
        XCTAssertTrue(journal.restoredState)
    }
    func testWriterLeaseAndStateSymlinksBlockBackup() throws {
        let (base, store, initial) = try fixture(); defer { try? FileManager.default.removeItem(at: base) }
        var journal = initial
        do {
            let lease = try RecoveryLease(store.root.appendingPathComponent("recovery-worker.lock"))
            XCTAssertThrowsError(try store.backup(&journal, verifyCluster: { _, _ in }))
            withExtendedLifetime(lease) {}
        }
        try FileManager.default.createSymbolicLink(at: store.root.appendingPathComponent("repository"), withDestinationURL: base)
        XCTAssertThrowsError(try store.backup(&journal, verifyCluster: { _, _ in }))
        XCTAssertEqual(journal.phase, .preparing)
    }
    func testFailedRestoreTestNeverMakesBackupUsable() throws {
        let (base, store, initial) = try fixture(); defer { try? FileManager.default.removeItem(at: base) }
        var journal = initial; try store.save(journal)
        XCTAssertThrowsError(try store.backup(&journal, verifyCluster: { _, _ in throw ConfigurationError("injected SQL failure") }))
        XCTAssertEqual(try store.read()?.phase, .preparing)
        XCTAssertNil(journal.stateDigest)
    }
    func testProcessIdentityAndPrivateJournal() throws {
        let (base, store, initial) = try fixture(); defer { try? FileManager.default.removeItem(at: base) }
        try store.save(initial)
        let identity = try RecoveryProcess.current(transaction: initial, build: "1")
        XCTAssertTrue(identity.matches)
        XCTAssertThrowsError(try identity.stop(expectedExecutable: URL(fileURLWithPath: "/not-this-process"), transaction: initial))
        XCTAssertEqual(try store.read(), initial)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: store.journalURL.path)[.posixPermissions] as? Int, 0o600)
    }
    func testRealStoppedPostgresSnapshotRestoresIntoIsolatedCluster() throws {
        guard let binaries = ProcessInfo.processInfo.environment["DISPATCH_TEST_POSTGRES_BUNDLE"] else { throw XCTSkip("Set DISPATCH_TEST_POSTGRES_BUNDLE to a PG17 runtime including pg_controldata.") }
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-recovery-pg-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: base) }
        let state = base.appendingPathComponent("state")
        let app = base.appendingPathComponent("Fixture.app")
        try FileManager.default.createDirectory(at: app.appendingPathComponent("Contents/Helpers"), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: app.appendingPathComponent("Contents/Helpers/Postgres"), withDestinationURL: URL(fileURLWithPath: binaries))
        var database: LocalDatabase? = LocalDatabase(root: state, binaries: URL(fileURLWithPath: binaries))
        let config = try database!.configuration(port: 6768, instanceID: UUID().uuidString)
        try database!.start(config)
        let url = URLComponents(string: config.databaseURL)!
        let env = ["PGHOST": "127.0.0.1", "PGPORT": String(url.port!), "PGUSER": LocalDatabase.role, "PGPASSWORD": url.password!, "PGDATABASE": LocalDatabase.role]
        defer { try? database?.stop() }
        try RecoveryCommand.run(URL(fileURLWithPath: binaries).appendingPathComponent("bin/psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-c", "CREATE TABLE pgmigrations (id serial PRIMARY KEY, name text); INSERT INTO pgmigrations(name) VALUES ('baseline'); CREATE TABLE preserved (id serial, value text); INSERT INTO preserved(value) VALUES ('before');"], environment: env)
        try database!.stop(); database = nil
        let before = try NativeRecoveryStore.digest(state)
        try NativeRecoveryStore.verifyCluster(state: state, app: app)
        XCTAssertEqual(try NativeRecoveryStore.digest(state), before, "Restore testing must never modify the retained source snapshot")
        XCTAssertFalse(FileManager.default.fileExists(atPath: state.appendingPathComponent("postgres/postmaster.pid").path))
    }

    func testServerHMACProofBindsNonceChallengeAndExactBody() throws {
        let body: [String: Any] = ["ready": true, "transactionId": "123", "instance": ["stateDir": "/tmp/a", "macInstanceId": "abc"], "pid": 123, "database": ["name": "dispatch_mac", "systemIdentifier": NSNull(), "migrations": ["count": 2, "latest": "λ"]]]
        let proof = "6d318e0ffab78bce0c79ce4b6137dc951ac94ee6db131019ae5c2e4ad6a2cbbf"
        let challenge = String(repeating: "a", count: 32)
        XCTAssertTrue(try RecoveryProtocol.verifyProof(proof, body: body, key: "key", route: "readiness", challenge: challenge, nonce: "nonce"))
        XCTAssertFalse(try RecoveryProtocol.verifyProof(proof, body: body, key: "key", route: "readiness", challenge: challenge, nonce: "different"))
        XCTAssertFalse(try RecoveryProtocol.verifyProof(proof, body: body, key: "key", route: "fence", challenge: challenge, nonce: "nonce"))
        XCTAssertFalse(try RecoveryProtocol.verifyProof(proof, body: body, key: "key", route: "readiness", challenge: String(repeating: "b", count: 32), nonce: "nonce"))
    }

    func testServerRealpathInventoryAcceptsMacAliasesAndRejectsExternalState() throws {
        let base = URL(fileURLWithPath: "/tmp/dispatch-recovery-inventory-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: base) }
        let root = base.appendingPathComponent("state")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let serverPath = "/private" + root.path
        XCTAssertTrue(RecoveryProtocol.acceptsInventory([serverPath], root: root))
        XCTAssertTrue(RecoveryProtocol.acceptsInventory([root.path, serverPath + "/not-created-yet/files"], root: root))
        XCTAssertFalse(RecoveryProtocol.acceptsInventory([], root: root))
        XCTAssertFalse(RecoveryProtocol.acceptsInventory([root.path, base.path + "/external"], root: root))
        XCTAssertFalse(RecoveryProtocol.acceptsInventory([root.path + "-other"], root: root))
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("external-link"), withDestinationURL: base)
        XCTAssertFalse(RecoveryProtocol.acceptsInventory([root.appendingPathComponent("external-link/absent").path], root: root))
    }


    // MARK: Service handoff (one-shot, pinned, never replayed)

    func testTerminalHandoffOpensOnceWithPinnedRequestAndNeverReplaysServiceRequests() throws {
        let (base, store, initial) = try fixture(); defer { try? FileManager.default.removeItem(at: base) }
        var journal = initial; journal.phase = .committed; try store.save(journal)
        XCTAssertEqual(try store.terminalStep(journal), .openApp)
        let pinned = try XCTUnwrap(store.handoff(for: journal))
        // Crash after the durable record but before the open was recorded: delivery repeats, same ID.
        XCTAssertEqual(try store.terminalStep(journal), .openApp)
        XCTAssertEqual(store.handoff(for: journal)?.requestID, pinned.requestID)
        try store.markHandoffOpened(journal)
        for _ in 0..<5 { XCTAssertEqual(try store.terminalStep(journal), .wait, "launchd ticks must not reopen the app or replay") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.root.appendingPathComponent("service-request.json").path), "The helper never writes service requests")
        // The menu redelivers with the pinned ID, so a user Stop issued later is never superseded.
        XCTAssertEqual(try store.beginHandoff(journal, opened: true).requestID, pinned.requestID)
        XCTAssertEqual(ServiceRequest(id: pinned.requestID, start: pinned.start).id, pinned.requestID)
        XCTAssertTrue(pinned.start)
        try store.markHandoffHandled(journal)
        XCTAssertEqual(try store.terminalStep(journal), .retire)
        XCTAssertEqual(try store.beginHandoff(journal).requestID, pinned.requestID)
    }
    func testMenuOwnedAbortIsHandledOrOpenedSoTheHelperNeverOpensOrDelivers() throws {
        let (base, store, initial) = try fixture(); defer { try? FileManager.default.removeItem(at: base) }
        var unfenced = initial; unfenced.phase = .aborted; try store.save(unfenced)
        try store.markHandoffHandled(unfenced)
        XCTAssertEqual(try store.terminalStep(unfenced), .retire)
        let handledID = try XCTUnwrap(store.handoff(for: unfenced)).requestID
        var fenced = NativeRecoveryJournal(instanceID: initial.instanceID, appPath: initial.appPath, oldBuild: "1", targetBuild: "2", targetIdentity: "id", wasRunning: false)
        fenced.phase = .aborted; try store.save(fenced)
        let record = try store.beginHandoff(fenced, opened: true)
        XCTAssertNotEqual(record.requestID, handledID, "A new transaction never reuses a handled request ID")
        XCTAssertEqual(try store.terminalStep(fenced), .wait)
        XCTAssertFalse(record.start)
        var unfinished = fenced; unfinished.phase = .probation
        XCTAssertThrowsError(try store.beginHandoff(unfinished))
    }
    func testMenuAbortIsLimitedToPreparationPhasesAndRecordsTheHandoff() throws {
        let (base, store, initial) = try fixture(); defer { try? FileManager.default.removeItem(at: base) }
        var unfenced = initial; try store.save(unfenced)
        XCTAssertTrue(try store.abortPreparation(&unfenced, error: "busy", fenced: false))
        XCTAssertEqual(try store.read()?.phase, .aborted)
        XCTAssertEqual(try store.terminalStep(unfenced), .retire)
        var fenced = NativeRecoveryJournal(instanceID: initial.instanceID, appPath: initial.appPath, oldBuild: "1", targetBuild: "2", targetIdentity: "id", wasRunning: true)
        fenced.phase = .backedUp; try store.save(fenced)
        XCTAssertTrue(try store.abortPreparation(&fenced, error: "backup", fenced: true))
        XCTAssertEqual(try store.terminalStep(fenced), .wait, "Menu owns delivery; the helper never opens the app")
        // Once the helper owns the journal, the menu cannot abort it.
        var helperOwned = NativeRecoveryJournal(instanceID: initial.instanceID, appPath: initial.appPath, oldBuild: "1", targetBuild: "2", targetIdentity: "id", wasRunning: true)
        helperOwned.phase = .activating; try store.save(helperOwned)
        XCTAssertFalse(try store.abortPreparation(&helperOwned, error: "late", fenced: true))
        XCTAssertEqual(try store.read()?.phase, .activating)
        XCTAssertNil(store.handoff(for: helperOwned))
    }
    // MARK: Orphaned preparation (preparer died before activation)

    func testOrphanedPreparationWithoutVerifiedBackupAbortsPromptly() throws {
        let (base, store, initial) = try fixture(); defer { try? FileManager.default.removeItem(at: base) }
        var journal = initial; try store.save(journal)
        XCTAssertEqual(journal.deadline > Date().addingTimeInterval(1700), true, "Prompt abort must not depend on the 30 minute deadline")
        guard case .abort = store.orphanedPreparation(journal, installedBuild: "2", installerStaged: { XCTFail("No backup, so installer state is irrelevant"); return true }) else { return XCTFail("preparing must abort") }
        // A partially written snapshot is never treated as a recovery point.
        try FileManager.default.createDirectory(at: store.transaction(journal), withIntermediateDirectories: true)
        journal.phase = .backedUp
        guard case .abort = store.orphanedPreparation(journal, installedBuild: "2", installerStaged: { true }) else { return XCTFail("missing digests must abort") }
        var preparing = initial
        XCTAssertThrowsError(try store.promoteOrphanedPreparation(&preparing))
    }
    func testOrphanedVerifiedBackupActivatesOnlyWithInstallEvidenceAndReentersOnce() throws {
        let (base, store, initial) = try fixture(); defer { try? FileManager.default.removeItem(at: base) }
        var journal = initial; try store.save(journal)
        try store.backup(&journal, verifyCluster: { _, _ in })
        XCTAssertEqual(try store.read()?.phase, .backedUp)
        guard case .abort = store.orphanedPreparation(journal, installedBuild: "1", installerStaged: { false }) else { return XCTFail("No install in progress must abort") }
        XCTAssertEqual(store.orphanedPreparation(journal, installedBuild: "1", installerStaged: { true }), .activate)
        XCTAssertEqual(store.orphanedPreparation(journal, installedBuild: "2", installerStaged: { false }), .activate)
        let now = Date()
        try store.promoteOrphanedPreparation(&journal, now: now)
        let saved = try XCTUnwrap(store.read())
        XCTAssertEqual(saved.phase, .activating)
        XCTAssertEqual(saved.deadline.timeIntervalSince(now), 300, accuracy: 1)
        // Re-entry after a helper crash sees activating and cannot promote or abort it again.
        var reentered = saved
        XCTAssertThrowsError(try store.promoteOrphanedPreparation(&reentered))
        XCTAssertFalse(try store.abortPreparation(&reentered, error: "late menu", fenced: true))
        XCTAssertEqual(try store.read()?.phase, .activating)
    }
    func testOrphanedDamagedBackupNeverActivates() throws {
        let (base, store, initial) = try fixture(); defer { try? FileManager.default.removeItem(at: base) }
        var journal = initial; try store.save(journal)
        try store.backup(&journal, verifyCluster: { _, _ in })
        try Data("corrupt".utf8).write(to: store.transaction(journal).appendingPathComponent("state/session"))
        guard case .abort(let reason) = store.orphanedPreparation(journal, installedBuild: "2", installerStaged: { true }) else { return XCTFail("damaged backup must abort") }
        XCTAssertTrue(reason.contains("did not verify"))
    }
    func testProvenStagedRequiresPositiveEvidence() {
        let uid = getuid()
        XCTAssertTrue(StagedInstallerWithdrawal(bundleIdentifier: "test.dispatch", run: FakeLaunchd(["gui/\(uid)/test.dispatch-sparkle-updater"]).run).provenStaged())
        XCTAssertFalse(StagedInstallerWithdrawal(bundleIdentifier: "test.dispatch", run: FakeLaunchd([]).run).provenStaged())
        let unknown = FakeLaunchd(["gui/\(uid)/test.dispatch-sparkle-updater"]); unknown.printFailure = 5
        XCTAssertFalse(StagedInstallerWithdrawal(bundleIdentifier: "test.dispatch", run: unknown.run).provenStaged())
    }
    func testPackagedPostgresCrashAfterBackupResumesIntoActivation() throws {
        guard let binaries = ProcessInfo.processInfo.environment["DISPATCH_TEST_POSTGRES_BUNDLE"] else { throw XCTSkip("Set DISPATCH_TEST_POSTGRES_BUNDLE to a PG17 runtime including pg_controldata.") }
        let (base, store, _) = try fixture(); defer { try? FileManager.default.removeItem(at: base) }
        try FileManager.default.removeItem(at: store.root)
        let pgApp = base.appendingPathComponent("Postgres.app")
        try FileManager.default.createDirectory(at: pgApp.appendingPathComponent("Contents/Helpers"), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: pgApp.appendingPathComponent("Contents/Helpers/Postgres"), withDestinationURL: URL(fileURLWithPath: binaries))
        var database: LocalDatabase? = LocalDatabase(root: store.root, binaries: URL(fileURLWithPath: binaries))
        let config = try database!.configuration(port: 6769, instanceID: UUID().uuidString)
        try config.save(to: store.root.appendingPathComponent("configuration.json"))
        try database!.start(config)
        defer { try? database?.stop() }
        let url = URLComponents(string: config.databaseURL)!
        let env = ["PGHOST": "127.0.0.1", "PGPORT": String(url.port!), "PGUSER": LocalDatabase.role, "PGPASSWORD": url.password!, "PGDATABASE": LocalDatabase.role]
        try RecoveryCommand.run(URL(fileURLWithPath: binaries).appendingPathComponent("bin/psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-c", "CREATE TABLE pgmigrations (id serial PRIMARY KEY, name text); INSERT INTO pgmigrations(name) VALUES ('baseline');"], environment: env)
        try database!.stop(); database = nil
        let app = base.appendingPathComponent("Dispatch.app")
        var journal = NativeRecoveryJournal(instanceID: config.instanceID, appPath: app.path, oldBuild: "1", targetBuild: "2", targetIdentity: "signed-artifact-2", wasRunning: true)
        try store.prepareSnapshot(app: app, build: "1")
        try store.stage(&journal, app: app); try store.save(journal)
        XCTAssertThrowsError(try store.admitWorker(build: "2", environment: [:]), "The target is fenced from the real cluster while staged")
        journal.phase = .preparing; try store.save(journal)
        try store.backup(&journal, verifyCluster: { state, _ in try NativeRecoveryStore.verifyCluster(state: state, app: pgApp) })
        // Preparer crashed here, before writing activating; Sparkle then installed the target.
        let crashed = try XCTUnwrap(store.read())
        XCTAssertEqual(crashed.phase, .backedUp)
        XCTAssertEqual(store.orphanedPreparation(crashed, installedBuild: "2", installerStaged: { false }), .activate)
        var resumed = crashed
        try store.promoteOrphanedPreparation(&resumed)
        // The verified snapshot then drives the existing journaled rollback with the real cluster.
        resumed.phase = .probation; try store.save(resumed)
        try Data("failed-target".utf8).write(to: store.root.appendingPathComponent("target-wrote"))
        try store.restore(&resumed, verifyCluster: { state, _ in try NativeRecoveryStore.verifyCluster(state: state, app: pgApp) })
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.root.appendingPathComponent("target-wrote").path))
        XCTAssertEqual(try NativeRecoveryStore.digest(store.root), resumed.stateDigest)
        try NativeRecoveryStore.verifyCluster(state: store.root, app: pgApp)
    }
    // MARK: Pre-stage protection (staged journal before Sparkle may stage an installer)

    private func makeApp(_ app: URL, build: String, protocolVersion: Int?, sign: Bool = true) throws {
        try FileManager.default.createDirectory(at: app.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: URL(fileURLWithPath: "/usr/bin/true"), to: app.appendingPathComponent("Contents/MacOS/Dispatch"))
        var plist: [String: Any] = ["CFBundleIdentifier": "test.dispatch.recovery", "CFBundleVersion": build, "CFBundleExecutable": "Dispatch", "CFBundlePackageType": "APPL"]
        if let protocolVersion { plist["DispatchRecoveryProtocol"] = protocolVersion }
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: app.appendingPathComponent("Contents/Info.plist"))
        if sign { try RecoveryCommand.run(URL(fileURLWithPath: "/usr/bin/codesign"), ["--force", "--sign", "-", app.path]) }
    }
    /// Sparkle replacing the bundle at the same path.
    private func install(target: URL, over live: URL) throws {
        try FileManager.default.removeItem(at: live)
        try FileManager.default.copyItem(at: target, to: live)
    }
    private func stagedFixture() throws -> (URL, NativeRecoveryStore, NativeRecoveryJournal) {
        let (base, store, initial) = try fixture()
        let app = URL(fileURLWithPath: initial.appPath)
        try store.prepareSnapshot(app: app, build: "1")
        var journal = initial; journal.declaredProtocol = 1
        try store.stage(&journal, app: app)
        try store.save(journal)
        return (base, store, journal)
    }
    func testStagedGateFencesEveryBuildButTheOldOneAndRecordsOpensFirst() throws {
        let (base, store, initial) = try fixture(); defer { try? FileManager.default.removeItem(at: base) }
        var journal = initial; journal.phase = .staged; journal.stagedAt = Date(); try store.save(journal)
        XCTAssertThrowsError(try store.admitWorker(build: "2", environment: [:]))
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.databaseOpenURL.path), "A fenced target leaves no open record because it never opens the database")
        XCTAssertNil(try store.admitWorker(build: "1", environment: [:]), "The old build keeps running ordinarily while staged")
        let record = try JSONDecoder().decode(DatabaseOpenRecord.self, from: Data(contentsOf: store.databaseOpenURL))
        XCTAssertEqual(record.build, "1")
        journal.phase = .preparing; try store.save(journal)
        XCTAssertThrowsError(try store.admitWorker(build: "1", environment: [:]))
        XCTAssertEqual(try store.admitWorker(build: "1", environment: ["DISPATCH_UPDATE_RECOVERY_ID": journal.id, "DISPATCH_UPDATE_RECOVERY_NONCE": journal.nonce])?.id, journal.id)
        journal.phase = .committed; try store.save(journal)
        XCTAssertNil(try store.admitWorker(build: "2", environment: [:]))
    }
    func testStagingVetoesWithoutSnapshotThenStagesDurably() throws {
        let (base, store, initial) = try fixture(); defer { try? FileManager.default.removeItem(at: base) }
        let app = URL(fileURLWithPath: initial.appPath)
        var journal = initial
        XCTAssertNil(store.readySnapshot(app: app, build: "1"))
        XCTAssertThrowsError(try store.stage(&journal, app: app), "No snapshot: Sparkle must not proceed")
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.transaction(journal).path))
        XCTAssertNil(try store.read())
        try store.prepareSnapshot(app: app, build: "1")
        let manifest = try XCTUnwrap(store.readySnapshot(app: app, build: "1"))
        XCTAssertNil(store.readySnapshot(app: app, build: "2"), "A snapshot belongs to one build")
        try store.stage(&journal, app: app); try store.save(journal)
        XCTAssertEqual(try store.read()?.phase, .staged)
        XCTAssertEqual(journal.appDigest, manifest.digest)
        XCTAssertNotNil(journal.stagedAt)
        XCTAssertEqual(try NativeRecoveryStore.digest(store.transaction(journal).appendingPathComponent("previous.app"), app: true), manifest.digest)
        XCTAssertNil(store.readySnapshot(app: app, build: "1"), "The snapshot moved into the transaction")
        var second = NativeRecoveryJournal(instanceID: initial.instanceID, appPath: initial.appPath, oldBuild: "1", targetBuild: "3", targetIdentity: "x", wasRunning: true)
        try store.prepareSnapshot(app: app, build: "1")
        XCTAssertThrowsError(try store.stage(&second, app: app), "One unfinished transaction at a time")
    }
    func testStagedOldAppWaitsForInstallerThenReleasesAndReturnsSnapshot() throws {
        let (base, store, staged) = try stagedFixture(); defer { try? FileManager.default.removeItem(at: base) }
        var journal = staged
        XCTAssertEqual(store.staged(journal, installedBuild: "1", installerMaybeStaged: { true }), .wait, "A possibly staged installer keeps protection")
        guard case .abort(let reason) = store.staged(journal, installedBuild: "1", installerMaybeStaged: { false }) else { return XCTFail("no installer must release") }
        XCTAssertThrowsError(try store.unstage(&journal, reason: reason, installerAbsent: { false }), "Never terminal while an installer may exist")
        XCTAssertEqual(try store.read()?.phase, .staged)
        try store.unstage(&journal, reason: reason, installerAbsent: { true })
        XCTAssertEqual(try store.read()?.phase, .aborted)
        XCTAssertEqual(try store.terminalStep(journal), .retire, "Nothing was stopped; handled immediately")
        XCTAssertNotNil(store.readySnapshot(app: URL(fileURLWithPath: journal.appPath), build: "1"), "The verified snapshot is reused")
    }
    func testStagedTargetAppOnlyRestoreIsRetrySafeAndLeavesStateUntouched() throws {
        let (base, store, staged) = try stagedFixture(); defer { try? FileManager.default.removeItem(at: base) }
        let live = URL(fileURLWithPath: staged.appPath)
        let target = base.appendingPathComponent("Target.app")
        try makeApp(target, build: "2", protocolVersion: 1)
        let stateBefore = try NativeRecoveryStore.digest(store.root)
        try install(target: target, over: live)
        var journal = staged
        XCTAssertEqual(store.staged(journal, installedBuild: "2", installerMaybeStaged: { XCTFail("installed target needs no installer probe"); return true }), .restoreApp)
        // Crash after the journaled start and the first rename, before the journal records it.
        journal.restoreStarted = true; try store.save(journal)
        try FileManager.default.moveItem(at: live, to: URL(fileURLWithPath: journal.appPath + ".failed-" + journal.id))
        var resumed = try XCTUnwrap(store.read())
        XCTAssertEqual(store.staged(resumed, installedBuild: nil, installerMaybeStaged: { true }), .restoreApp, "Re-entry continues the started restore")
        try store.restoreStagedApp(&resumed)
        XCTAssertEqual(try NativeRecoveryStore.build(of: live), "1")
        XCTAssertEqual(try NativeRecoveryStore.build(of: URL(fileURLWithPath: journal.appPath + ".failed-" + journal.id)), "2")
        XCTAssertEqual(try NativeRecoveryStore.digest(store.root), stateBefore, "App-only rollback never touches state")
        let finished = try XCTUnwrap(store.read())
        XCTAssertEqual(finished.phase, .aborted, "An interrupted install is not a failed trial")
        XCTAssertEqual(finished.interruptedInstall, true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.directory.appendingPathComponent("quarantine.json").path), "The same artifact may be offered again")
        XCTAssertNil(try store.admitWorker(build: "1", environment: [:]))
        XCTAssertEqual(try store.terminalStep(resumed), .openApp)
        XCTAssertThrowsError(try store.restoreStagedApp(&resumed), "A finished rollback is not repeated")
    }
    func testStagedTargetWithoutProofIsRetainedForOperator() throws {
        let (base, store, staged) = try stagedFixture(); defer { try? FileManager.default.removeItem(at: base) }
        let live = URL(fileURLWithPath: staged.appPath)
        func required(_ value: StagedResolution) -> Bool { if case .recoveryRequired = value { return true }; return false }
        let legacy = base.appendingPathComponent("Legacy.app"); try makeApp(legacy, build: "2", protocolVersion: nil)
        try install(target: legacy, over: live)
        XCTAssertTrue(required(store.staged(staged, installedBuild: "2", installerMaybeStaged: { true })), "Unknown capability: may have opened the database")
        XCTAssertEqual(try NativeRecoveryStore.build(of: live), "2", "Absent capability never switches the app")
        let unsigned = base.appendingPathComponent("Unsigned.app"); try makeApp(unsigned, build: "2", protocolVersion: 1, sign: false)
        try install(target: unsigned, over: live)
        XCTAssertTrue(required(store.staged(staged, installedBuild: "2", installerMaybeStaged: { true })))
        let capable = base.appendingPathComponent("Capable.app"); try makeApp(capable, build: "2", protocolVersion: 1)
        try install(target: capable, over: live)
        try store.recordDatabaseOpen(build: "2", now: staged.stagedAt!.addingTimeInterval(-60))
        XCTAssertEqual(store.staged(staged, installedBuild: "2", installerMaybeStaged: { true }), .restoreApp, "An open before staging (earlier probation) is not evidence")
        try store.recordDatabaseOpen(build: "2", now: staged.stagedAt!.addingTimeInterval(5))
        XCTAssertTrue(required(store.staged(staged, installedBuild: "2", installerMaybeStaged: { true })), "The target opened the database after staging")
        XCTAssertTrue(required(store.staged(staged, installedBuild: "3", installerMaybeStaged: { true })), "Unknown installed build")
        // A damaged snapshot never replaces the installed target.
        try store.recordDatabaseOpen(build: "1")
        try Data("tampered".utf8).write(to: store.transaction(staged).appendingPathComponent("previous.app/Contents/MacOS/Dispatch"))
        var journal = staged
        XCTAssertThrowsError(try store.restoreStagedApp(&journal))
        XCTAssertFalse(journal.restoreStarted)
        XCTAssertEqual(try NativeRecoveryStore.build(of: live), "2")
    }
    func testFailedPreparationRevertsToStagedAndBackupResumesFromTheSnapshot() throws {
        let (base, store, staged) = try stagedFixture(); defer { try? FileManager.default.removeItem(at: base) }
        var journal = staged; journal.phase = .preparing; try store.save(journal)
        try store.backup(&journal, verifyCluster: { _, _ in })
        XCTAssertEqual(journal.phase, .backedUp)
        XCTAssertTrue(try store.revertToStaged(&journal, error: "busy after fence"))
        XCTAssertEqual(try store.read()?.phase, .staged)
        XCTAssertNil(journal.stateDigest)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.transaction(journal).appendingPathComponent("state").path))
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: store.transaction(journal).path).contains { $0.hasPrefix("state-incomplete-") }, "Partial copies are retained")
        XCTAssertFalse(try store.abortPreparation(&journal, error: "x", fenced: false), "Staged protection is not dropped by a preparation abort")
        journal.phase = .preparing; try store.save(journal)
        try store.backup(&journal, verifyCluster: { _, _ in })
        XCTAssertEqual(journal.phase, .backedUp)
        // A changed live app no longer matches the staged snapshot.
        var changed = staged; changed.phase = .preparing; changed.stateDigest = nil; try store.save(changed)
        try FileManager.default.moveItem(at: store.transaction(changed).appendingPathComponent("state"), to: store.transaction(changed).appendingPathComponent("state-old"))
        try Data("patched".utf8).write(to: URL(fileURLWithPath: changed.appPath).appendingPathComponent("Contents/Resources-extra"))
        XCTAssertThrowsError(try store.backup(&changed, verifyCluster: { _, _ in }))
    }
    func testStagedOldBuildMenuRunsNormallyAndTargetMenuIsBlocked() throws {
        let (base, store, staged) = try stagedFixture(); defer { try? FileManager.default.removeItem(at: base) }
        XCTAssertFalse(store.menuBlocked(build: "1"), "Old build: registration, controls, and checks stay normal")
        XCTAssertTrue(store.menuBlocked(build: "2"))
        try RecoveryEnrollment.menuAcknowledgment(store: store, build: "1")
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.directory.appendingPathComponent("menu-ready.json").path), "The old menu is not a probation participant")
        try RecoveryEnrollment.menuAcknowledgment(store: store, build: "2")
        XCTAssertNotNil(try? JSONDecoder().decode(RecoveryProcess.self, from: Data(contentsOf: store.directory.appendingPathComponent("menu-ready.json"))))
        // A cycle that ends without an installer (skip, dismiss, failed download) cleans up.
        var journal = staged
        try store.unstage(&journal, reason: "Update cycle ended without a staged installer.", installerAbsent: { true })
        XCTAssertEqual(try store.read()?.phase, .aborted)
        XCTAssertFalse(store.menuBlocked(build: "1")); XCTAssertFalse(store.menuBlocked(build: "2"))
        XCTAssertNil(try store.admitWorker(build: "1", environment: [:]))
        XCTAssertEqual(try store.terminalStep(journal), .retire)
        XCTAssertNotNil(store.readySnapshot(app: URL(fileURLWithPath: journal.appPath), build: "1"))
    }
    func testAppOnlyRestoreRequiresRecordedPostmasterAndNoLiveTargetProcess() throws {
        let (base, store, staged) = try stagedFixture(); defer { try? FileManager.default.removeItem(at: base) }
        let target = base.appendingPathComponent("Target.app"); try makeApp(target, build: "2", protocolVersion: 1)
        try install(target: target, over: URL(fileURLWithPath: staged.appPath))
        func required(_ value: StagedResolution) -> Bool { if case .recoveryRequired = value { return true }; return false }
        // A live "postmaster" (this test process) that no old-build record owns.
        try FileManager.default.createDirectory(at: store.root.appendingPathComponent("postgres"), withIntermediateDirectories: true)
        try Data("\(getpid())\n".utf8).write(to: store.root.appendingPathComponent("postgres/postmaster.pid"))
        XCTAssertTrue(required(store.staged(staged, installedBuild: "2", installerMaybeStaged: { true })))
        try store.recordDatabaseOpen(build: "1", now: staged.stagedAt!.addingTimeInterval(-10))
        XCTAssertTrue(required(store.staged(staged, installedBuild: "2", installerMaybeStaged: { true })), "PID alone is not ownership")
        try store.recordPostmaster(build: "1")
        XCTAssertEqual(store.staged(staged, installedBuild: "2", installerMaybeStaged: { true }), .restoreApp, "Exactly the old build's recorded postmaster")
        // A target menu still alive blocks the swap before anything is renamed.
        try NativeRecoveryStore.durableJSON(RecoveryProcess.current(transaction: staged, build: "2"), to: store.directory.appendingPathComponent("menu-ready.json"))
        var journal = staged
        XCTAssertThrowsError(try store.restoreStagedApp(&journal))
        XCTAssertFalse(journal.restoreStarted)
        XCTAssertEqual(try NativeRecoveryStore.build(of: URL(fileURLWithPath: staged.appPath)), "2")
    }
    func testFeedDeclarationGatesStagingBeforeDownload() throws {
        let key = RecoveryTargetDeclaration.self
        XCTAssertNoThrow(try key.verify(properties: [key.protocolKey: "1"], requiresSignedFeed: true))
        XCTAssertThrowsError(try key.verify(properties: [key.protocolKey: "1"], requiresSignedFeed: false), "Unsigned feeds cannot authenticate the claim")
        for properties: [AnyHashable: Any] in [[:], [key.protocolKey: "2"], [key.protocolKey: ""], ["other:recoveryProtocol": "1"], ["recoveryProtocol": "1"]] {
            XCTAssertThrowsError(try key.verify(properties: properties, requiresSignedFeed: true)) { XCTAssertNotNil($0 as? RecoveryRefusal) }
        }
    }
    func testSparkleResumesOnlyUnderAProtectedStagedJournal() throws {
        let (base, store, staged) = try stagedFixture(); defer { try? FileManager.default.removeItem(at: base) }
        XCTAssertEqual(store.resumeDecision(build: "1", installerMaybeStaged: true), .start, "Protected resume reuses the veto-created journal")
        XCTAssertEqual(store.resumeDecision(build: "2", installerMaybeStaged: true), .withdrawFirst, "Another build never resumes it")
        XCTAssertFalse(store.menuBlocked(build: "1"), "The old menu does not wait on its own staged journal (no deadlock)")
        var undeclared = staged; undeclared.declaredProtocol = nil; try store.save(undeclared)
        XCTAssertEqual(store.resumeDecision(build: "1", installerMaybeStaged: true), .withdrawFirst)
        try store.save(staged)
        var journal = staged
        try store.unstage(&journal, reason: "x", installerAbsent: { true })
        XCTAssertEqual(store.resumeDecision(build: "1", installerMaybeStaged: true), .withdrawFirst, "No unfinished journal: unprotected installer")
        XCTAssertEqual(store.resumeDecision(build: "1", installerMaybeStaged: false), .start)
        try Data("{damaged".utf8).write(to: store.journalURL)
        XCTAssertEqual(store.resumeDecision(build: "1", installerMaybeStaged: true), .withdrawFirst, "A damaged journal is never protection")
        XCTAssertTrue(store.menuBlocked(build: "1"))
    }
    func testHelperCrashMatrixNeverDropsProtectionWhileAnInstallerMayExist() throws {
        let (base, store, staged) = try stagedFixture(); defer { try? FileManager.default.removeItem(at: base) }
        func step(_ j: NativeRecoveryJournal, installed: String?, maybe: Bool, proven: Bool = false, withdraws: Bool = false) -> NativeRecoveryStore.OwnedStep {
            store.ownedStep(j, installedBuild: installed, installerMaybeStaged: { maybe }, installerProven: { proven }, withdraw: { withdraws })
        }
        // Crash while staged, old app installed: expiry never releases a possibly staged installer.
        var expired = staged; expired.deadline = Date(timeIntervalSinceNow: -3600); try store.save(expired)
        XCTAssertEqual(step(expired, installed: "1", maybe: true), .wait)
        XCTAssertEqual(step(expired, installed: "1", maybe: false), .abort("Sparkle did not stage an installer; update protection released."))
        // Crash while staged, target installed by Sparkle.
        let target = base.appendingPathComponent("Target.app"); try makeApp(target, build: "2", protocolVersion: 1)
        let live = URL(fileURLWithPath: staged.appPath)
        let original = base.appendingPathComponent("Original.app"); try FileManager.default.copyItem(at: live, to: original)
        try install(target: target, over: live)
        XCTAssertEqual(step(staged, installed: "2", maybe: true), .restoreApp)
        try install(target: original, over: live)
        // Crash during preparation (staged-derived): back to staged, never terminal.
        var preparing = staged; preparing.phase = .preparing; try store.save(preparing)
        guard case .revertToStaged = step(preparing, installed: "1", maybe: true) else { return XCTFail("preparing must revert") }
        // Crash after a verified backup: activation needs install evidence; otherwise revert.
        try store.backup(&preparing, verifyCluster: { _, _ in })
        XCTAssertEqual(step(preparing, installed: "1", maybe: true, proven: true), .activate)
        guard case .revertToStaged = step(preparing, installed: "1", maybe: true, proven: false) else { return XCTFail("backedUp without evidence must revert") }
        // A journal without staged protection aborts only after a proven withdrawal.
        var unstaged = preparing; unstaged.stagedAt = nil; unstaged.appDigest = nil; unstaged.phase = .preparing
        XCTAssertEqual(step(unstaged, installed: "1", maybe: true, withdraws: false), .wait)
        guard case .abort = step(unstaged, installed: "1", maybe: true, withdraws: true) else { return XCTFail("proven withdrawal may abort") }
    }
    func testDurableWriteFailureVetoesAndKeepsTheSnapshot() throws {
        let (base, store, initial) = try fixture()
        defer { chmod(store.directory.path, 0o700); try? FileManager.default.removeItem(at: base) }
        let app = URL(fileURLWithPath: initial.appPath)
        try store.prepareSnapshot(app: app, build: "1")
        var journal = initial
        chmod(store.directory.path, 0o500)
        XCTAssertThrowsError(try store.stage(&journal, app: app), "A failed durable write must veto")
        chmod(store.directory.path, 0o700)
        XCTAssertNil(try store.read())
        XCTAssertNotNil(store.readySnapshot(app: app, build: "1"), "Snapshot stays cached for the retry")
        // Staged but enrollment failed before the journal was saved: undo returns the snapshot.
        try store.stage(&journal, app: app)
        XCTAssertNil(store.readySnapshot(app: app, build: "1"))
        try store.unstage(&journal, reason: "enrollment failed", installerAbsent: { XCTFail("No saved journal: nothing to drop"); return false })
        XCTAssertNil(try store.read())
        XCTAssertNotNil(store.readySnapshot(app: app, build: "1"))
        // Helper acknowledgment is bounded.
        var slept = 0.0
        XCTAssertFalse(RecoveryEnrollment.awaitAcknowledgment(store: store, journal: journal, timeout: 0.3, sleep: { slept += $0; Thread.sleep(forTimeInterval: $0) }))
        try NativeRecoveryStore.durableJSON(["transactionId": journal.id], to: store.directory.appendingPathComponent("helper-ready.json"))
        XCTAssertTrue(RecoveryEnrollment.awaitAcknowledgment(store: store, journal: journal, timeout: 0.3))
    }
    func testRetireRemovesLauncherBeforeUnloading() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-retire-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: base) }
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        let plist = base.appendingPathComponent("agent.plist"); try Data("x".utf8).write(to: plist)
        var unloaded: [String] = []
        try RecoveryEnrollment.retire(instanceID: "ABC", plist: plist) { target in
            XCTAssertFalse(FileManager.default.fileExists(atPath: plist.path)); unloaded.append(target)
        }
        XCTAssertEqual(unloaded, ["gui/\(getuid())/dev.bradharris.dispatch.recovery.abc"])
    }

    // MARK: Busy deferral and staged-installer withdrawal

    private func signed(_ body: [String: Any], route: String, challenge: String, key: String, nonce: String? = nil) throws -> Data {
        let secret: [String: Any] = nonce.map { ["nonce": $0] } ?? [:]
        let payload = try "dispatch-recovery-v1\n\(RecoveryProtocol.prefix + route)\n\(challenge)\n\(RecoveryProtocol.canonical(body))\n\(RecoveryProtocol.canonical(secret))"
        let mac = HMAC<SHA256>.authenticationCode(for: Data(payload.utf8), using: SymmetricKey(data: Data(key.utf8)))
        var full = body; full["proof"] = mac.map { String(format: "%02x", $0) }.joined()
        return try JSONSerialization.data(withJSONObject: full)
    }
    func testAuthenticatedBusyIsDeferralWhileUnsignedOrOtherConflictsFailClosed() throws {
        let (base, _, journal) = try fixture(); defer { try? FileManager.default.removeItem(at: base) }
        let challenge = String(repeating: "c", count: 32)
        let busy = try signed(["code": "BUSY", "reasons": ["turn:agt_1"]], route: "fence", challenge: challenge, key: "k")
        XCTAssertThrowsError(try RecoveryProtocol.authenticated(status: 409, data: busy, action: "prepare", key: "k", challenge: challenge, journal: journal)) { error in
            XCTAssertEqual(error as? RecoveryDeferral, RecoveryDeferral(code: "BUSY", reasons: ["turn:agt_1"]))
        }
        // A forged busy reply (wrong key) is never trusted as a deferral.
        XCTAssertThrowsError(try RecoveryProtocol.authenticated(status: 409, data: busy, action: "prepare", key: "other", challenge: challenge, journal: journal)) { error in
            XCTAssertNil(error as? RecoveryDeferral)
        }
        let mismatch = try signed(["code": "INSTANCE_MISMATCH", "reasons": []], route: "fence", challenge: challenge, key: "k")
        XCTAssertThrowsError(try RecoveryProtocol.authenticated(status: 409, data: mismatch, action: "prepare", key: "k", challenge: challenge, journal: journal)) { error in
            XCTAssertNil(error as? RecoveryDeferral)
        }
        // Stopped-instance readiness failures are signed without the nonce.
        let hosts = try signed(["ready": false, "code": "HOSTS_RUNNING", "liveHosts": ["host-1"]], route: "readiness", challenge: challenge, key: "k")
        XCTAssertThrowsError(try RecoveryProtocol.authenticated(status: 409, data: hosts, action: "readiness", key: "k", challenge: challenge, journal: journal)) { error in
            XCTAssertEqual((error as? RecoveryDeferral)?.reasons, ["host-1"])
        }
        let ok = try signed(["mode": "fenced", "transactionId": journal.id, "instance": ["macInstanceId": journal.instanceID]], route: "fence", challenge: challenge, key: "k")
        XCTAssertEqual(try RecoveryProtocol.authenticated(status: 200, data: ok, action: "prepare", key: "k", challenge: challenge, journal: journal)["mode"] as? String, "fenced")
    }
    func testDeferralRetriesAreBounded() {
        var schedule = UpdateDeferralSchedule()
        let now = Date(timeIntervalSince1970: 0)
        for attempt in 1...UpdateDeferralSchedule.maxAttempts {
            XCTAssertEqual(schedule.next(after: now), now.addingTimeInterval(UpdateDeferralSchedule.interval), "attempt \(attempt)")
        }
        XCTAssertNil(schedule.next(after: now))
    }
    private final class FakeLaunchd {
        var loaded: Set<String>
        var unremovable: Set<String> = []
        var printFailure: Int32?
        var commands: [[String]] = []
        init(_ loaded: Set<String>) { self.loaded = loaded }
        func run(_ args: [String]) -> (Int32, String) {
            commands.append(args)
            switch args[0] {
            case "print": return printFailure.map { ($0, "") } ?? (loaded.contains(args[1]) ? (0, "state = waiting") : (113, "Could not find service"))
            case "bootout": if !unremovable.contains(args[1]) { loaded.remove(args[1]) }; return (0, "")
            default: return (1, "")
            }
        }
    }
    func testStagedInstallerIsWithdrawnAndProvenGoneBeforeQuit() {
        let uid = getuid()
        let launchd = FakeLaunchd(["gui/\(uid)/test.dispatch-sparkle-updater", "gui/\(uid)/test.dispatch-sparkle-progress"])
        let withdrawal = StagedInstallerWithdrawal(bundleIdentifier: "test.dispatch", run: launchd.run)
        XCTAssertTrue(withdrawal.staged())
        XCTAssertTrue(withdrawal.withdraw(attempts: 2, sleep: { _ in }))
        XCTAssertFalse(withdrawal.staged())
        XCTAssertTrue(launchd.commands.contains(["bootout", "gui/\(uid)/test.dispatch-sparkle-updater"]))
    }
    func testUnprovableWithdrawalHoldsQuit() {
        let uid = getuid()
        let stuck = FakeLaunchd(["gui/\(uid)/test.dispatch-sparkle-updater"]); stuck.unremovable = ["gui/\(uid)/test.dispatch-sparkle-updater"]
        XCTAssertFalse(StagedInstallerWithdrawal(bundleIdentifier: "test.dispatch", run: stuck.run).withdraw(attempts: 3, sleep: { _ in }))
        // A root (system-domain) installer cannot be removed by this user.
        let system = FakeLaunchd(["system/test.dispatch-sparkle-updater"])
        XCTAssertFalse(StagedInstallerWithdrawal(bundleIdentifier: "test.dispatch", run: system.run).withdraw(attempts: 2, sleep: { _ in }))
        // An unknown launchctl failure is never read as "nothing staged".
        let unknown = FakeLaunchd([]); unknown.printFailure = 5
        XCTAssertFalse(StagedInstallerWithdrawal(bundleIdentifier: "test.dispatch", run: unknown.run).withdraw(attempts: 2, sleep: { _ in }))
    }

    // MARK: Bounded helper wait

    func testHelperWaitKickstartsBoundedlyThenFails() {
        var watch = HelperWatch()
        let start = Date(timeIntervalSince1970: 1000)
        let deadline = start.addingTimeInterval(3600)
        XCTAssertEqual(watch.decide(now: start, deadline: deadline, helperAlive: false), .kickstart)
        XCTAssertEqual(watch.decide(now: start.addingTimeInterval(1), deadline: deadline, helperAlive: false), .wait)
        XCTAssertEqual(watch.decide(now: start.addingTimeInterval(10), deadline: deadline, helperAlive: false), .kickstart)
        XCTAssertEqual(watch.decide(now: start.addingTimeInterval(20), deadline: deadline, helperAlive: false), .kickstart)
        XCTAssertEqual(watch.decide(now: start.addingTimeInterval(30), deadline: deadline, helperAlive: false), .wait)
        XCTAssertEqual(watch.kickstarts, HelperWatch.maxKickstarts)
        XCTAssertEqual(watch.decide(now: start.addingTimeInterval(51), deadline: deadline, helperAlive: false), .fail)
        var alive = HelperWatch()
        XCTAssertEqual(alive.decide(now: deadline, deadline: deadline, helperAlive: true), .wait)
        XCTAssertEqual(alive.decide(now: deadline.addingTimeInterval(HelperWatch.grace), deadline: deadline, helperAlive: true), .fail, "A live but overdue helper is still bounded")
        XCTAssertEqual(alive.kickstarts, 0)
    }
    func testHelperLeaseProbeDetectsLiveHelper() throws {
        let (base, store, _) = try fixture(); defer { try? FileManager.default.removeItem(at: base) }
        XCTAssertFalse(store.helperRunning())
        let lease = try RecoveryLease(store.directory.appendingPathComponent("helper.lock"))
        XCTAssertTrue(store.helperRunning())
        withExtendedLifetime(lease) {}
    }

    // MARK: Rollback permission preflight

    func testPermissionPreflightPassesWithoutResidue() throws {
        let (base, store, journal) = try fixture(); defer { try? FileManager.default.removeItem(at: base) }
        let app = URL(fileURLWithPath: journal.appPath)
        try store.preflightRollbackPermissions(app: app)
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: base.path).filter { $0.hasPrefix(".dispatch-preflight") }
        XCTAssertEqual(leftovers, [])
    }
    func testPermissionPreflightRejectsUnwritableAppParentAndApp() throws {
        let (base, store, journal) = try fixture()
        let app = URL(fileURLWithPath: journal.appPath)
        let parent = base.appendingPathComponent("Applications")
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        let installed = parent.appendingPathComponent("Dispatch.app")
        try FileManager.default.moveItem(at: app, to: installed)
        defer {
            chmod(parent.path, 0o755); chmod(installed.path, 0o755)
            try? FileManager.default.removeItem(at: base)
        }
        chmod(parent.path, 0o555)
        XCTAssertThrowsError(try store.preflightRollbackPermissions(app: installed)) { XCTAssertNotNil($0 as? RecoveryRefusal) }
        chmod(parent.path, 0o755); chmod(installed.path, 0o555)
        XCTAssertThrowsError(try store.preflightRollbackPermissions(app: installed)) { XCTAssertNotNil($0 as? RecoveryRefusal) }
        chmod(installed.path, 0o755)
        let translocated = base.appendingPathComponent("AppTranslocation/X/Dispatch.app")
        try FileManager.default.createDirectory(at: translocated, withIntermediateDirectories: true)
        XCTAssertThrowsError(try store.preflightRollbackPermissions(app: translocated)) { XCTAssertNotNil($0 as? RecoveryRefusal) }
        XCTAssertNoThrow(try store.preflightRollbackPermissions(app: installed))
    }
}
