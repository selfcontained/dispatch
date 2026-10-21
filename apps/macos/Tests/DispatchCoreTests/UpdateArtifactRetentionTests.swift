import XCTest
import Foundation
@testable import DispatchCore

final class UpdateArtifactRetentionTests: XCTestCase {
    private let fm = FileManager.default
    private func fixture() throws -> (URL, NativeRecoveryStore) {
        let base = fm.temporaryDirectory.appendingPathComponent("dispatch-retention-\(UUID().uuidString)").resolvingSymlinksInPath()
        let store = NativeRecoveryStore(root: base.appendingPathComponent("state"))
        try store.initialize()
        return (base, store)
    }
    private func transaction(_ store: NativeRecoveryStore, phase: NativeRecoveryJournal.Phase,
                             instance: String = "instance", restoreStarted: Bool = false) throws -> NativeRecoveryJournal {
        var journal = NativeRecoveryJournal(instanceID: instance, appPath: store.root.deletingLastPathComponent().appendingPathComponent("Dispatch.app").path, oldBuild: "1", targetBuild: "2", targetIdentity: "signed", wasRunning: true)
        journal.phase = phase; journal.restoreStarted = restoreStarted
        let directory = store.transaction(journal)
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("snapshot".utf8).write(to: directory.appendingPathComponent("previous.app"))
        try store.save(journal)
        return journal
    }
    private func exists(_ store: NativeRecoveryStore, _ journal: NativeRecoveryJournal) -> Bool {
        fm.fileExists(atPath: store.transaction(journal).path)
    }
    func testRepeatedSuccessfulUpdatesDiscardAllCompletedRecoveryPoints() throws {
        let (base, store) = try fixture(); defer { try? fm.removeItem(at: base) }
        var journals: [NativeRecoveryJournal] = []
        for _ in 0..<12 {
            let journal = try transaction(store, phase: .committed)
            journals.append(journal)
            XCTAssertEqual(try store.pruneHistory(), 0, "Keep the backup until service handoff finishes")
            try store.markHandoffHandled(journal)
            try store.pruneHistory()
            XCTAssertTrue(journals.allSatisfy { !exists(store, $0) })
            XCTAssertEqual(try store.read()?.id, journal.id)
            XCTAssertEqual(try store.terminalStep(journal), .retire)
            try store.save(journal)
            XCTAssertFalse(exists(store, journal), "Saving a terminal receipt must not recreate its backup")
        }
    }
    func testRetriesRemoveAbortedAndSuccessfulBackupsAfterHandoff() throws {
        let (base, store) = try fixture(); defer { try? fm.removeItem(at: base) }
        let success = try transaction(store, phase: .committed)
        var previous: NativeRecoveryJournal?
        for _ in 0..<12 {
            let current = try transaction(store, phase: .aborted)
            try store.markHandoffHandled(current)
            try store.pruneHistory()
            XCTAssertFalse(exists(store, success)); XCTAssertFalse(exists(store, current))
            if let previous { XCTAssertFalse(exists(store, previous)) }
            previous = current
        }
        XCTAssertEqual(try store.pruneHistory(), 0)
    }
    func testPendingUpdatesAndHeldTransactionLeasePreventPruning() throws {
        let (base, store) = try fixture(); defer { try? fm.removeItem(at: base) }
        let old = try transaction(store, phase: .aborted)
        for phase: NativeRecoveryJournal.Phase in [.staged, .preparing, .backedUp, .activating, .probation, .restoring, .recoveryRequired] {
            _ = try transaction(store, phase: phase)
            XCTAssertEqual(try store.pruneHistory(), 0)
            XCTAssertTrue(exists(store, old))
        }
        let current = try transaction(store, phase: .committed)
        try store.markHandoffHandled(current)
        let lease = try RecoveryLease(store.directory.appendingPathComponent("transaction.lock"))
        XCTAssertThrowsError(try store.pruneHistory())
        XCTAssertTrue(exists(store, old))
        withExtendedLifetime(lease) {}
    }
    func testUnfinishedRecoveryOtherInstancesAndUnknownEntriesArePreserved() throws {
        let (base, store) = try fixture(); defer { try? fm.removeItem(at: base) }
        let rollback = try transaction(store, phase: .rolledBack)
        let failed = try transaction(store, phase: .recoveryRequired)
        let interrupted = try transaction(store, phase: .aborted, restoreStarted: true)
        let other = try transaction(store, phase: .aborted, instance: "other")
        let unknown = store.directory.appendingPathComponent(UUID().uuidString)
        try fm.createDirectory(at: unknown, withIntermediateDirectories: false)
        try Data("bad manifest".utf8).write(to: unknown.appendingPathComponent("manifest.json"))
        let linked = store.directory.appendingPathComponent(UUID().uuidString)
        try fm.createSymbolicLink(at: linked, withDestinationURL: store.transaction(other))
        let current = try transaction(store, phase: .committed)
        try store.markHandoffHandled(current)
        let failedState = store.directory.appendingPathComponent("failed-state-" + rollback.id)
        try fm.createDirectory(at: failedState, withIntermediateDirectories: true)
        let failedApp = URL(fileURLWithPath: rollback.appPath + ".failed-" + rollback.id)
        try fm.createDirectory(at: failedApp, withIntermediateDirectories: true)
        XCTAssertEqual(try store.pruneHistory(), 3)
        XCTAssertFalse(exists(store, rollback)); XCTAssertFalse(exists(store, interrupted))
        XCTAssertFalse(fm.fileExists(atPath: failedState.path))
        XCTAssertFalse(fm.fileExists(atPath: failedApp.path))
        for journal in [failed, other] { XCTAssertTrue(exists(store, journal)) }
        XCTAssertTrue(fm.fileExists(atPath: unknown.path)); XCTAssertTrue(fm.fileExists(atPath: linked.path))
        try Data("broken journal".utf8).write(to: store.journalURL)
        XCTAssertThrowsError(try store.pruneHistory())
    }
    func testFailedHistoryEntryDoesNotBlockOtherBackupsOrInstallerCleanup() throws {
        let (base, store) = try fixture(); defer { try? fm.removeItem(at: base) }
        let blocked = try transaction(store, phase: .aborted)
        let readOnly = store.transaction(blocked).appendingPathComponent("readonly")
        try fm.createDirectory(at: readOnly, withIntermediateDirectories: false)
        try Data("keep".utf8).write(to: readOnly.appendingPathComponent("payload"))
        try fm.setAttributes([.posixPermissions: 0o500], ofItemAtPath: readOnly.path)
        defer { try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: readOnly.path) }
        let removable = try transaction(store, phase: .committed)
        try store.markHandoffHandled(removable)
        let cache = try SparkleInstallationCache(caches: base.appendingPathComponent("caches"), bundleIdentifier: "test.dispatch")
        try fm.createDirectory(at: cache.directory.appendingPathComponent("old"), withIntermediateDirectories: true)
        XCTAssertThrowsError(try store.pruneHistory())
        XCTAssertTrue(fm.fileExists(atPath: store.transaction(blocked).appendingPathComponent("manifest.json").path))
        XCTAssertFalse(exists(store, removable))
        XCTAssertEqual(try cache.prune(installerAbsent: { true }), 1)
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: readOnly.path)
        XCTAssertEqual(try store.pruneHistory(), 1)
    }
    func testIdleInstallerCleanupLeavesDownloadsAndOtherBundlesAlone() throws {
        let (base, _) = try fixture(); defer { try? fm.removeItem(at: base) }
        let caches = base.appendingPathComponent("caches")
        let cache = try SparkleInstallationCache(caches: caches, bundleIdentifier: "test.dispatch")
        let installer = cache.directory.appendingPathComponent("old/extracted.app")
        let downloads = cache.directory.deletingLastPathComponent().appendingPathComponent("PersistentDownloads/archive.zip")
        let other = caches.appendingPathComponent("other/Installation/update.zip")
        for file in [installer, downloads, other] {
            try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("artifact".utf8).write(to: file)
        }
        XCTAssertEqual(try cache.prune(installerAbsent: { false }), 0)
        XCTAssertTrue(fm.fileExists(atPath: installer.path))
        XCTAssertEqual(try cache.prune(installerAbsent: { true }), 1)
        XCTAssertFalse(fm.fileExists(atPath: installer.path))
        XCTAssertTrue(fm.fileExists(atPath: downloads.path)); XCTAssertTrue(fm.fileExists(atPath: other.path))
        XCTAssertEqual(try cache.prune(installerAbsent: { true }), 0)
    }
    func testInstallerReappearanceStopsDeletionAndSymlinksAreNotFollowed() throws {
        let (base, _) = try fixture(); defer { try? fm.removeItem(at: base) }
        let caches = base.appendingPathComponent("caches")
        let cache = try SparkleInstallationCache(caches: caches, bundleIdentifier: "test.dispatch")
        for name in ["one", "two"] { try fm.createDirectory(at: cache.directory.appendingPathComponent(name), withIntermediateDirectories: true) }
        var probes = 0
        XCTAssertEqual(try cache.prune(installerAbsent: { probes += 1; return probes < 3 }), 1)
        let outside = base.appendingPathComponent("outside")
        try fm.createDirectory(at: outside, withIntermediateDirectories: false)
        try fm.createSymbolicLink(at: cache.directory.appendingPathComponent("linked"), withDestinationURL: outside)
        XCTAssertEqual(try cache.prune(installerAbsent: { true }), 1)
        XCTAssertTrue(fm.fileExists(atPath: outside.path))
        let linkedCaches = base.appendingPathComponent("linked-caches")
        try fm.createSymbolicLink(at: linkedCaches, withDestinationURL: caches)
        let linked = try SparkleInstallationCache(caches: linkedCaches, bundleIdentifier: "test.dispatch")
        XCTAssertThrowsError(try linked.prune(installerAbsent: { true }))
        XCTAssertThrowsError(try SparkleInstallationCache(caches: caches, bundleIdentifier: "../other"))
    }
}
