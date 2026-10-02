import Foundation
import Darwin

/// The one service-intent handoff for a terminal transaction. The request ID is pinned
/// when the record is created, so every redelivery after a crash is the same request
/// and can never supersede a later user Start/Stop. The helper never writes a service
/// request; it opens the menu at most once per `opened` flag, and the menu delivers.
public struct RecoveryServiceHandoff: Codable, Equatable {
    public let transactionId: String
    public let requestID: UUID
    public let start: Bool
    public var opened: Bool
    public var handled: Bool
}

public enum RecoveryTerminalStep: Equatable {
    /// First visit (or a crash before the open was recorded): open the menu, then `markOpened`.
    case openApp
    /// The menu owns delivery. Nothing is replayed; launchd ticks are no-ops.
    case wait
    /// Handled: the per-transaction launcher can be retired.
    case retire
}

extension NativeRecoveryStore {
    public var handoffURL: URL { directory.appendingPathComponent("service-handoff.json") }
    public func handoff(for journal: NativeRecoveryJournal) -> RecoveryServiceHandoff? {
        guard let data = try? Data(contentsOf: handoffURL),
              let value = try? JSONDecoder().decode(RecoveryServiceHandoff.self, from: data),
              value.transactionId == journal.id else { return nil }
        return value
    }
    /// Idempotent: an existing record for this transaction (and its pinned ID) wins.
    /// The record is durable before anything is delivered, and `opened` is recorded only
    /// after delivery, so a crash between them repeats delivery rather than losing it.
    @discardableResult
    public func beginHandoff(_ journal: NativeRecoveryJournal, opened: Bool = false, handled: Bool = false) throws -> RecoveryServiceHandoff {
        guard journal.terminal else { throw ConfigurationError("Service handoff requires a terminal recovery decision.") }
        if let existing = handoff(for: journal) {
            guard handled && !existing.handled else { return existing }
            var value = existing; value.handled = true; value.opened = value.opened || opened
            try Self.durableJSON(value, to: handoffURL); return value
        }
        let value = RecoveryServiceHandoff(transactionId: journal.id, requestID: UUID(), start: journal.wasRunning, opened: opened, handled: handled)
        try Self.durableJSON(value, to: handoffURL)
        return value
    }
    public func markHandoffOpened(_ journal: NativeRecoveryJournal) throws {
        var value = try beginHandoff(journal)
        guard !value.opened else { return }
        value.opened = true; try Self.durableJSON(value, to: handoffURL)
    }
    /// The menu restored (or never needed to restore) the service intent.
    public func markHandoffHandled(_ journal: NativeRecoveryJournal) throws {
        try beginHandoff(journal, opened: true, handled: true)
    }
    /// The menu's only abort path. Applies only while this transaction is still in the
    /// menu-owned preparation phases. Without a fence nothing was stopped, so the handoff
    /// is handled now; otherwise the menu owns delivery and restore() marks it handled.
    /// Returns false when the helper already owns the journal (nothing is written).
    @discardableResult
    public func abortPreparation(_ journal: inout NativeRecoveryJournal, error: String, fenced: Bool) throws -> Bool {
        guard let saved = try? read(), saved.id == journal.id, [.preparing, .backedUp].contains(saved.phase) else { return false }
        journal.phase = .aborted; journal.error = error; try save(journal)
        if fenced { try beginHandoff(journal, opened: true) } else { try markHandoffHandled(journal) }
        return true
    }
    /// What the helper does once the preparing menu is gone (its transaction lease is
    /// free). Only a verified backup plus evidence that Sparkle is installing (target
    /// build installed, or its staged installer proven present) continues to activation;
    /// everything else aborts promptly instead of waiting out the preparation deadline.
    public enum OrphanedPreparation: Equatable { case activate, abort(String) }
    public func orphanedPreparation(_ journal: NativeRecoveryJournal, installedBuild: String?, installerStaged: () -> Bool) -> OrphanedPreparation {
        guard journal.phase == .backedUp else { return .abort("The update preparer stopped before a verified recovery point existed.") }
        do { try verifyBackup(journal) } catch { return .abort("The update preparer stopped and its recovery point did not verify: \(error.localizedDescription)") }
        if installedBuild == journal.targetBuild || installerStaged() { return .activate }
        return .abort("The update preparer stopped before Sparkle began installing.")
    }
    /// Enters the existing activation → probation → commit/rollback path.
    public func promoteOrphanedPreparation(_ journal: inout NativeRecoveryJournal, now: Date = Date()) throws {
        guard journal.phase == .backedUp else { throw ConfigurationError("Only a verified backup can be activated.") }
        journal.phase = .activating; journal.deadline = now.addingTimeInterval(300); try save(journal)
    }
    public func terminalStep(_ journal: NativeRecoveryJournal) throws -> RecoveryTerminalStep {
        let value = try beginHandoff(journal)
        if value.handled { return .retire }
        return value.opened ? .wait : .openApp
    }
}

/// The menu's bounded wait for an unfinished journal. A live helper holds its OS lease;
/// a timestamp alone never proves liveness. Ordinary startup stays fenced throughout.
public struct HelperWatch {
    public enum Decision: Equatable { case wait, kickstart, fail }
    public static let grace: TimeInterval = 120
    public static let maxKickstarts = 3
    public static let kickstartSpacing: TimeInterval = 10
    public var kickstarts = 0
    public var lastKickstart = Date.distantPast
    public init() {}
    public mutating func decide(now: Date, deadline: Date, helperAlive: Bool) -> Decision {
        if now >= deadline.addingTimeInterval(Self.grace) { return .fail }
        guard !helperAlive else { return .wait }
        guard kickstarts < Self.maxKickstarts else { return now.timeIntervalSince(lastKickstart) >= Self.kickstartSpacing * 3 ? .fail : .wait }
        guard now.timeIntervalSince(lastKickstart) >= Self.kickstartSpacing else { return .wait }
        kickstarts += 1; lastKickstart = now
        return .kickstart
    }
    public static func failure(store: NativeRecoveryStore, phase: NativeRecoveryJournal.Phase) -> String {
        "The Dispatch recovery helper is not finishing the pending update (\(phase.rawValue)); the server stays stopped to protect your data. Allow Dispatch in System Settings › General › Login Items & Extensions, then choose Retry Update Recovery. Without the app: \(store.directory.appendingPathComponent("DispatchRecovery").path) watch \(store.root.path)"
    }
}

extension NativeRecoveryStore {
    /// True while a helper holds its lease. The probe lease is released immediately.
    public func helperRunning() -> Bool {
        (try? RecoveryLease(directory.appendingPathComponent("helper.lock"))) == nil
    }
    /// Rollback renames the app inside its parent and moves state into the recovery
    /// directory. Prove those exact operations work for this user before anything is
    /// fenced or stopped, so an unprivileged rollback can never be discovered mid-restore.
    public func preflightRollbackPermissions(app: URL) throws {
        let app = app.standardizedFileURL
        guard !app.path.contains("/AppTranslocation/") else { throw RecoveryRefusal("Dispatch is running from a translocated copy. Move it to Applications and open it there before updating.") }
        var info = stat()
        guard lstat(app.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else { throw RecoveryRefusal("Cannot inspect the installed app for a protected update.") }
        guard info.st_uid == getuid(), access(app.path, W_OK) == 0 else {
            throw RecoveryRefusal("Protected updates need Dispatch.app to be owned and writable by you, so a failed update can be rolled back without an administrator. Reinstall Dispatch by dragging it to Applications as this user, or update it manually (see Help: manual update).")
        }
        try preflightDirectory(app.deletingLastPathComponent(), what: "the folder containing Dispatch.app")
        try initialize()
        try preflightDirectory(root.deletingLastPathComponent(), what: "the folder containing Dispatch data")
        var rootInfo = stat(), recoveryInfo = stat()
        guard stat(root.path, &rootInfo) == 0, stat(directory.path, &recoveryInfo) == 0, rootInfo.st_dev == recoveryInfo.st_dev else {
            throw RecoveryRefusal("Dispatch data and its recovery folder must be on the same volume for an atomic rollback.")
        }
        try preflightDirectory(directory, what: "the recovery folder")
    }
    private func preflightDirectory(_ parent: URL, what: String) throws {
        let first = parent.appendingPathComponent(".dispatch-preflight-\(UUID().uuidString)")
        let second = parent.appendingPathComponent(".dispatch-preflight-\(UUID().uuidString)")
        let refusal = RecoveryRefusal("Dispatch cannot create, rename, and remove items in \(what) (\(parent.path)) as this user, so a failed update could not be rolled back. Fix the folder's permissions or update manually.")
        guard mkdir(first.path, 0o700) == 0 else { throw refusal }
        guard rename(first.path, second.path) == 0 else { rmdir(first.path); throw refusal }
        guard rmdir(second.path) == 0 else { throw refusal }
    }
}

/// Sparkle 2 stages a launchd job, `<bundle id>-sparkle-updater`, that installs when the
/// app terminates, even if the in-process driver aborted. Its public API offers no
/// cancel on the silent path, so a deferred or refused update removes that job (the
/// same label Sparkle itself clears before staging) and proves it is gone before Quit.
public struct StagedInstallerWithdrawal {
    public let bundleIdentifier: String
    /// Returns the exit status and output; injectable for tests.
    public var run: ([String]) -> (Int32, String)
    public var uid = getuid()
    public init(bundleIdentifier: String, run: (([String]) -> (Int32, String))? = nil) {
        self.bundleIdentifier = bundleIdentifier
        self.run = run ?? { RecoveryCommand.status(URL(fileURLWithPath: "/bin/launchctl"), $0, timeout: 10) }
    }
    public var labels: [String] { ["\(bundleIdentifier)-sparkle-updater", "\(bundleIdentifier)-sparkle-progress"] }
    /// launchctl exits 113 for a service that does not exist. Any other failure is unknown.
    private func absent(_ target: String) -> Bool { run(["print", target]).0 == 113 }
    public func staged() -> Bool { !labels.allSatisfy { absent("gui/\(uid)/\($0)") && absent("system/\($0)") } }
    /// Positive evidence only: the installer job exists. Unknown failures are not proof.
    public func provenStaged() -> Bool {
        let updater = labels[0]
        return run(["print", "gui/\(uid)/\(updater)"]).0 == 0 || run(["print", "system/\(updater)"]).0 == 0
    }
    /// True only when no staged installer remains in either domain.
    public func withdraw(attempts: Int = 20, sleep: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }) -> Bool {
        for label in labels where !absent("gui/\(uid)/\(label)") { _ = run(["bootout", "gui/\(uid)/\(label)"]) }
        for _ in 0..<attempts {
            if !staged() { return true }
            sleep(0.25)
        }
        return false
    }
}

/// Bounded idle retry after an authenticated busy deferral.
public struct UpdateDeferralSchedule: Equatable {
    public static let interval: TimeInterval = 300
    public static let maxAttempts = 12
    public private(set) var attempts = 0
    public init() {}
    /// The next retry time, or nil when the bounded budget is spent.
    public mutating func next(after now: Date) -> Date? {
        guard attempts < Self.maxAttempts else { return nil }
        attempts += 1
        return now.addingTimeInterval(Self.interval)
    }
}
