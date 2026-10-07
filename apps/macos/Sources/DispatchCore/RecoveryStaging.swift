import Foundation
import Darwin

/// Pre-stage protection. Sparkle submits its installer job only after the synchronous
/// `shouldProceedWithUpdate`/`willExtractUpdate` delegate calls return, and that job
/// installs on any later termination. Before Sparkle may proceed, the running app is
/// already snapshotted and a durable `staged` journal plus helper exist, so a crash at
/// any later point leaves either the old app, or a fenced target that the helper can
/// swap back without touching data.
public struct AppSnapshotManifest: Codable, Equatable {
    public let build: String
    public let digest: String
    public let appPath: String
}

/// The last ordinary or probation database open, written durably before PostgreSQL
/// starts. Protocol 1 builds always write it, so its absence for the target build is
/// evidence that the target never opened the database.
public struct DatabaseOpenRecord: Codable, Equatable {
    public let build: String
    public let pid: Int32
    public let at: Date
    /// The postmaster this start launched, once it is running.
    public var postmaster: ProcessIdentity?
}

public enum StagedResolution: Equatable {
    /// The old app is installed and Sparkle's installer may still exist: keep protection.
    case wait
    /// The old app is installed and no installer exists: drop protection, nothing stopped.
    case abort(String)
    /// Sparkle installed the target while the menu was gone; the fenced target never
    /// opened the database, so swapping the app back is a complete rollback.
    case restoreApp
    /// Cannot prove the target stayed fenced (or unknown installed build): retain all.
    case recoveryRequired(String)
}

extension NativeRecoveryStore {
    public var snapshotSlot: URL { directory.appendingPathComponent("app-snapshot", isDirectory: true) }
    private var snapshotManifestURL: URL { snapshotSlot.appendingPathComponent("manifest.json") }
    private func snapshotApp(named name: String) -> URL { snapshotSlot.appendingPathComponent(name) }
    public var databaseOpenURL: URL { directory.appendingPathComponent("database-opened.json") }

    /// Cheap check for the main thread: manifest for this build and path plus the copy.
    /// The full digest and signature are re-verified before any restore uses it.
    public func readySnapshot(app: URL, build: String) -> AppSnapshotManifest? {
        guard let data = try? Data(contentsOf: snapshotManifestURL),
              let manifest = try? JSONDecoder().decode(AppSnapshotManifest.self, from: data),
              manifest.build == build, manifest.appPath == app.standardizedFileURL.path,
              FileManager.default.fileExists(atPath: snapshotApp(named: app.lastPathComponent).path) else { return nil }
        return manifest
    }
    /// Heavy; run off the main thread. Copies, verifies, and atomically publishes a
    /// snapshot of the running signed app. Never touches the live app or state.
    public func prepareSnapshot(app: URL, build: String) throws {
        try initialize()
        if readySnapshot(app: app, build: build) != nil { return }
        // The pool copy plus a later failed-target copy must fit without crowding backups.
        var appBytes: Int64 = 0
        if let files = fm.enumerator(at: app, includingPropertiesForKeys: [.fileSizeKey]) {
            for case let url as URL in files { appBytes += Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
        }
        let available = try directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage ?? 0
        guard available > appBytes * 2 + 256 * 1024 * 1024 else { throw ConfigurationError("Insufficient free disk space to prepare update protection.") }
        try Self.verifySignedApp(app)
        guard try Self.build(of: app) == build else { throw ConfigurationError("The installed app changed while preparing update protection.") }
        let temp = directory.appendingPathComponent(".snapshot-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: temp, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        var published = false
        defer { if !published { try? fm.removeItem(at: temp) } }
        let copy = temp.appendingPathComponent(app.lastPathComponent)
        try self.copy(app, copy)
        let digest = try Self.digest(app, app: true)
        guard try Self.digest(copy, app: true) == digest else { throw ConfigurationError("The update protection snapshot did not verify.") }
        try Self.durableJSON(AppSnapshotManifest(build: build, digest: digest, appPath: app.standardizedFileURL.path), to: temp.appendingPathComponent("manifest.json"))
        try Self.flushTree(temp)
        if fm.fileExists(atPath: snapshotSlot.path) {
            let old = directory.appendingPathComponent(".snapshot-old-\(UUID().uuidString)")
            try fm.moveItem(at: snapshotSlot, to: old); try? fm.removeItem(at: old)
        }
        guard rename(temp.path, snapshotSlot.path) == 0 else { throw ConfigurationError("Cannot publish the update protection snapshot.") }
        published = true
        try Self.syncDirectory(directory)
    }
    /// Moves the ready snapshot into a new transaction. Does not save the journal: the
    /// caller enrolls (which saves it and starts the helper) and must `unstage` on error.
    public func stage(_ journal: inout NativeRecoveryJournal, app: URL, now: Date = Date()) throws {
        guard journal.phase == .preparing, journal.appDigest == nil else { throw ConfigurationError("Only a new transaction can be staged.") }
        if let existing = try read(), !existing.terminal { throw ConfigurationError("Finish the pending native recovery before starting another update.") }
        guard let manifest = readySnapshot(app: app, build: journal.oldBuild) else { throw ConfigurationError("Update protection is still being prepared.") }
        let tx = transaction(journal)
        try fm.createDirectory(at: tx, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        guard rename(snapshotApp(named: app.lastPathComponent).path, tx.appendingPathComponent("previous.app").path) == 0 else { throw ConfigurationError("Cannot stage the update protection snapshot.") }
        try Self.syncDirectory(tx); try Self.syncDirectory(snapshotSlot)
        journal.appDigest = manifest.digest; journal.phase = .staged; journal.stagedAt = now
        journal.deadline = now.addingTimeInterval(1800)
    }
    /// Drops staged protection once no installer can exist (or staging failed before
    /// Sparkle proceeded). The snapshot returns to the pool when still current.
    /// `installerAbsent` must prove no Sparkle installer exists (withdraw first): staged
    /// protection is never made terminal while an installer could still install.
    public func unstage(_ journal: inout NativeRecoveryJournal, reason: String, installerAbsent: () -> Bool) throws {
        let saved = try? read()
        if let saved, saved.id == journal.id {
            guard saved.phase == .staged else { throw ConfigurationError("Only staged protection can be dropped.") }
            guard installerAbsent() else { throw ConfigurationError("A Sparkle installer may still exist; staged protection is kept.") }
            journal.phase = .aborted; journal.error = reason; try save(journal)
            try markHandoffHandled(journal)
        }
        returnSnapshot(journal)
    }
    private func returnSnapshot(_ journal: NativeRecoveryJournal) {
        let previous = transaction(journal).appendingPathComponent("previous.app")
        let name = URL(fileURLWithPath: journal.appPath).lastPathComponent
        guard fm.fileExists(atPath: previous.path), !fm.fileExists(atPath: snapshotApp(named: name).path),
              let data = try? Data(contentsOf: snapshotManifestURL),
              let manifest = try? JSONDecoder().decode(AppSnapshotManifest.self, from: data),
              manifest.digest == journal.appDigest else { return }
        if rename(previous.path, snapshotApp(named: name).path) == 0 { try? Self.syncDirectory(snapshotSlot) }
    }
    /// A failed or deferred preparation of a staged transaction returns to `staged`, so
    /// Sparkle's still-staged installer stays covered. Partial state copies are moved
    /// aside, never deleted. Returns false when the journal is not this menu's to revert.
    @discardableResult
    public func revertToStaged(_ journal: inout NativeRecoveryJournal, error: String) throws -> Bool {
        guard let saved = try? read(), saved.id == journal.id, [.preparing, .backedUp].contains(saved.phase),
              saved.stagedAt != nil, saved.appDigest != nil else { return false }
        journal = saved
        let state = transaction(journal).appendingPathComponent("state")
        if fm.fileExists(atPath: state.path) {
            try fm.moveItem(at: state, to: transaction(journal).appendingPathComponent("state-incomplete-\(UUID().uuidString)"))
        }
        journal.phase = .staged; journal.stateDigest = nil; journal.error = error
        try save(journal)
        return true
    }
    /// The worker startup gate (protocol 1). Returns the journal when this is a nonce-
    /// bearing recovery worker, nil for an ordinary start. Either way the database-open
    /// evidence is durable before the caller may touch PostgreSQL.
    public func admitWorker(build: String, environment: [String: String]) throws -> NativeRecoveryJournal? {
        let journal = try read()
        var recovery: NativeRecoveryJournal?
        if let journal, !journal.permitsOrdinaryStart(build: build) {
            guard [.preparing, .probation, .restoring].contains(journal.phase),
                  environment["DISPATCH_UPDATE_RECOVERY_ID"] == journal.id,
                  environment["DISPATCH_UPDATE_RECOVERY_NONCE"] == journal.nonce else {
                throw ConfigurationError("Native update recovery owns this instance; ordinary startup is fenced.")
            }
            recovery = journal
        }
        try recordDatabaseOpen(build: build)
        return recovery
    }
    /// Written by every protocol 1 server start, before PostgreSQL is opened.
    public func recordDatabaseOpen(build: String, now: Date = Date()) throws {
        try initialize()
        try Self.durableJSON(DatabaseOpenRecord(build: build, pid: getpid(), at: now), to: databaseOpenURL)
    }
    /// Called by the admitted worker once its managed PostgreSQL is running.
    public func recordPostmaster(build: String) throws {
        guard let data = try? Data(contentsOf: databaseOpenURL),
              var record = try? JSONDecoder().decode(DatabaseOpenRecord.self, from: data), record.build == build,
              let pid = livePostmasterPID(), let identity = ProcessIdentity.live(pid) else { return }
        record.postmaster = identity
        try Self.durableJSON(record, to: databaseOpenURL)
    }
    private func livePostmasterPID() -> Int32? {
        guard let text = try? String(contentsOf: root.appendingPathComponent("postgres/postmaster.pid")) else { return nil }
        return Int32(text.split(separator: "\n").first ?? "")
    }
    /// The menu and the startup paths share one rule: the old build of a staged update
    /// runs normally (registration, controls, checks); any other unfinished journal
    /// blocks, and an unreadable one blocks too.
    public func menuBlocked(build: String) -> Bool {
        do { return try read().map { !$0.permitsOrdinaryStart(build: build) } ?? false } catch { return true }
    }
    /// No recorded menu or worker of this transaction may still be alive.
    public func requireNoTransactionProcesses(_ journal: NativeRecoveryJournal) throws {
        for name in ["menu-ready.json", "worker.json"] {
            guard let data = try? Data(contentsOf: directory.appendingPathComponent(name)),
                  let record = try? JSONDecoder().decode(RecoveryProcess.self, from: data) else { continue }
            if record.transactionId == journal.id && record.matches {
                throw ConfigurationError("A Dispatch process from the installed update is still running (\(name)). All copies were retained.")
            }
        }
    }
    /// The helper's decision for a menu-owned phase once the menu's lease is free.
    public enum OwnedStep: Equatable { case activate, revertToStaged(String), wait, abort(String), restoreApp, recoveryRequired(String) }
    /// Nothing here becomes terminal while an installer may exist: staged-derived work
    /// falls back to `staged`; an unstaged journal aborts only after `withdraw` proves
    /// the installer gone. Deadlines are not consulted for staged protection.
    public func ownedStep(_ journal: NativeRecoveryJournal, installedBuild: String?, installerMaybeStaged: () -> Bool, installerProven: () -> Bool, withdraw: () -> Bool) -> OwnedStep {
        switch journal.phase {
        case .staged:
            switch staged(journal, installedBuild: installedBuild, installerMaybeStaged: installerMaybeStaged) {
            case .wait: return .wait
            case .abort(let reason): return .abort(reason)
            case .restoreApp: return .restoreApp
            case .recoveryRequired(let reason): return .recoveryRequired(reason)
            }
        case .preparing, .backedUp:
            var reason = "The update preparer stopped before a verified recovery point existed."
            if journal.phase == .backedUp {
                switch orphanedPreparation(journal, installedBuild: installedBuild, installerStaged: installerProven) {
                case .activate: return .activate
                case .abort(let why): reason = why
                }
            }
            if journal.stagedAt != nil, journal.appDigest != nil { return .revertToStaged(reason) }
            return withdraw() ? .abort(reason) : .wait
        default: return .wait
        }
    }
    public func staged(_ journal: NativeRecoveryJournal, installedBuild: String?, installerMaybeStaged: () -> Bool) -> StagedResolution {
        if journal.restoreStarted { return .restoreApp }
        if installedBuild == journal.oldBuild {
            return installerMaybeStaged() ? .wait : .abort("Sparkle did not stage an installer; update protection released.")
        }
        guard installedBuild == journal.targetBuild else {
            return .recoveryRequired("An unexpected app build (\(installedBuild ?? "unreadable")) replaced Dispatch during a staged update. All copies were retained.")
        }
        do { try requireFencedTarget(journal) } catch { return .recoveryRequired(error.localizedDescription) }
        return .restoreApp
    }
    /// The target may be swapped back app-only only if it is a signed protocol 1 build
    /// (honors the staged gate and records database opens), it left no open record, and
    /// no PostgreSQL process started after staging.
    public func requireFencedTarget(_ journal: NativeRecoveryJournal) throws {
        let target = URL(fileURLWithPath: journal.appPath)
        guard (try? Self.verifySignedApp(target)) != nil else { throw ConfigurationError("The installed update is not validly signed; its startup behavior is unknown. All copies were retained.") }
        guard (NSDictionary(contentsOf: target.appendingPathComponent("Contents/Info.plist"))?["DispatchRecoveryProtocol"] as? NSNumber)?.intValue == 1 else {
            throw ConfigurationError("The installed update does not declare the staged startup gate, so it may have opened the database. All copies were retained.")
        }
        guard let stagedAt = journal.stagedAt else { throw ConfigurationError("The staged journal has no staging time.") }
        if let data = try? Data(contentsOf: databaseOpenURL) {
            guard let record = try? JSONDecoder().decode(DatabaseOpenRecord.self, from: data) else { throw ConfigurationError("Database-open evidence is unreadable. All copies were retained.") }
            if record.build == journal.targetBuild && record.at >= stagedAt {
                throw ConfigurationError("The update opened the database after it was installed without a recovery point. Automatic app-only rollback is unsafe; all copies were retained.")
            }
        }
        // A live postmaster must be exactly the one the old build recorded (kernel start
        // time and executable), never merely a PID that predates staging.
        if let pid = livePostmasterPID(), let live = ProcessIdentity.live(pid) {
            let record = (try? Data(contentsOf: databaseOpenURL)).flatMap { try? JSONDecoder().decode(DatabaseOpenRecord.self, from: $0) }
            guard let record, record.build == journal.oldBuild, record.postmaster == live else {
                throw ConfigurationError("A PostgreSQL server not recorded by the previous app is running. Automatic app-only rollback is unsafe; all copies were retained.")
            }
        }
    }
    /// Journaled and retry-safe: the failed target is preserved once next to the app,
    /// and the verified snapshot replaces it through staged renames. State is untouched.
    public func restoreStagedApp(_ journal: inout NativeRecoveryJournal) throws {
        guard journal.phase == .staged, let digest = journal.appDigest else { throw ConfigurationError("Only staged protection restores the app alone.") }
        let previous = transaction(journal).appendingPathComponent("previous.app")
        if !journal.restoreStarted {
            try requireNoTransactionProcesses(journal)
            guard try Self.digest(previous, app: true) == digest else { throw ConfigurationError("The staged app snapshot is damaged; the installed update was left in place and remains fenced.") }
            try Self.verifySignedApp(previous)
            journal.restoreStarted = true; try save(journal)
        }
        if !journal.restoredApp {
            try switchCopy(source: previous, live: URL(fileURLWithPath: journal.appPath), failed: URL(fileURLWithPath: journal.appPath + ".failed-" + journal.id), expected: digest, app: true)
            journal.restoredApp = true
        }
        // An interrupted install, not a failed trial: no quarantine; may be offered again.
        journal.phase = .aborted; journal.interruptedInstall = true
        journal.error = "Sparkle installed \(journal.targetBuild) while Dispatch was not running to protect it. The update never opened your data; the previous app was restored and the update will be offered again."
        try save(journal)
    }
}

/// The release feed's per-item capability claim, checked before Sparkle may download.
/// Sparkle 2.10 keeps unknown item elements under their literal qualified name with
/// only the string value (`SUAppcast.m`), so the publisher always emits the `dispatch`
/// prefix. The publisher derives the element from the built app's Info.plist
/// (`DispatchRecoveryProtocol` = 1 with the item's `CFBundleVersion`) and never
/// synthesizes it for older entries. The claim is trusted only when this bundle makes
/// Sparkle reject unsigned feeds, so it is authenticated by the feed signature.
public enum RecoveryTargetDeclaration {
    public static let namespace = "https://dispatch.berad.dev/xml-namespaces/update"
    public static let protocolKey = "dispatch:recoveryProtocol"
    public static func verify(properties: [AnyHashable: Any], requiresSignedFeed: Bool) throws {
        guard requiresSignedFeed else {
            throw RecoveryRefusal("This build does not require a signed update feed, so release capability claims cannot be trusted. Install updates manually (see docs/macos-native-recovery.md).", disablesAutomatic: false)
        }
        guard (properties[protocolKey] as? String) == "1" else {
            throw RecoveryRefusal("This release does not declare Dispatch's protected-update startup gate, so it cannot be installed automatically. Install it manually (see docs/macos-native-recovery.md).", disablesAutomatic: false)
        }
    }
}

/// Whether Sparkle may start when it could resume an already staged installer.
public enum SparkleResumeDecision: Equatable { case start, withdrawFirst }
extension NativeRecoveryStore {
    /// Sparkle resumes a staged installer as soon as it starts. That is allowed only
    /// under this build's durable staged journal for an authenticated protocol 1
    /// target (created in the throwing veto). No journal, a damaged one, or one for
    /// another build means the installer is unprotected: withdraw it first.
    public func resumeDecision(build: String, installerMaybeStaged: Bool) -> SparkleResumeDecision {
        guard installerMaybeStaged else { return .start }
        guard let journal = try? read(), journal.phase == .staged, journal.oldBuild == build,
              journal.stagedAt != nil, journal.appDigest != nil, journal.declaredProtocol == 1,
              !journal.targetIdentity.isEmpty, !journal.restoreStarted else { return .withdrawFirst }
        return .start
    }
}
