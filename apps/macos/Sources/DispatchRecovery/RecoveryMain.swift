import Foundation
import Darwin
import DispatchCore

/// No AppKit, Sparkle, target-server code, or target bundle libraries are linked.
/// launchd re-enters this retained executable after logout/reboot or helper failure.
@main struct RecoveryMain {
    static let enrollmentGrace: TimeInterval = 15
    static func main() async {
        do {
            let args = CommandLine.arguments
            guard args.count == 3, ["watch", "inspect"].contains(args[1]), args[2].hasPrefix("/") else { throw ConfigurationError("Usage: DispatchRecovery watch|inspect /absolute/instance-directory") }
            let root = URL(fileURLWithPath: args[2]).standardizedFileURL
            let store = NativeRecoveryStore(root: root); try store.initialize()
            if args[1] == "inspect" {
                if let j = try store.read() { print("Transaction \(j.id): \(j.phase.rawValue), \(j.oldBuild) → \(j.targetBuild). \(j.error ?? "")") }
                return
            }
            let lease = try RecoveryLease(store.directory.appendingPathComponent("helper.lock"))
            defer { withExtendedLifetime(lease) {} }
            guard var j = try store.read(), j.phase != .recoveryRequired else { return }
            if j.terminal { try finish(store: store, journal: j); return }
            try NativeRecoveryStore.durableJSON(["transactionId": j.id], to: store.directory.appendingPathComponent("helper-ready.json"))
            // The menu holds the transaction lease for a staged journal and through
            // preparation until activation. A free lease after a short grace means it is
            // gone: act now rather than waiting out a deadline. A live menu still
            // flushing a large backup keeps its lease, and no timestamp overrides that.
            let helperStarted = Date()
            var lastProbe = Date.distantPast
            var heldLease: RecoveryLease?
            let owned: [NativeRecoveryJournal.Phase] = [.staged, .preparing, .backedUp]
            while owned.contains(j.phase) {
                if Date().timeIntervalSince(helperStarted) >= enrollmentGrace, Date().timeIntervalSince(lastProbe) >= 5,
                   let lease = try? RecoveryLease(store.directory.appendingPathComponent("transaction.lock")) {
                    lastProbe = Date()
                    guard let current = try store.read() else { return }
                    j = current
                    guard owned.contains(j.phase) else { heldLease = lease; break }
                    let app = URL(fileURLWithPath: j.appPath)
                    let withdrawal = (NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))?["CFBundleIdentifier"] as? String)
                        .map { StagedInstallerWithdrawal(bundleIdentifier: $0) }
                    let installed = try? NativeRecoveryStore.build(of: app)
                    let step = store.ownedStep(j, installedBuild: installed,
                                               installerMaybeStaged: { withdrawal?.staged() ?? true },
                                               installerProven: { withdrawal?.provenStaged() ?? false },
                                               withdraw: { withdrawal?.withdraw() ?? false })
                    switch step {
                    case .wait: break
                    case .activate:
                        try store.promoteOrphanedPreparation(&j); heldLease = lease
                    case .revertToStaged(let reason):
                        // Staged-derived work falls back to app-only protection.
                        _ = try? await RecoveryProtocol.request("abort", journal: j, root: store.root)
                        try stopRecorded("worker.json", role: "Dispatch Worker", store: store, journal: j)
                        try store.revertToStaged(&j, error: reason); lastProbe = .distantPast; continue
                    case .abort(let reason):
                        // Only reached with the installer proven absent.
                        if j.phase == .staged {
                            try store.unstage(&j, reason: reason, installerAbsent: { !(withdrawal?.staged() ?? true) })
                        } else {
                            _ = try? await RecoveryProtocol.request("abort", journal: j, root: store.root)
                            try stopRecorded("worker.json", role: "Dispatch Worker", store: store, journal: j)
                            j.phase = .aborted; j.error = reason; try store.save(j)
                        }
                        try finish(store: store, journal: j); return
                    case .restoreApp:
                        // A fenced target menu is stopped first; it never opened the database.
                        try stopRecorded("menu-ready.json", role: "Dispatch", store: store, journal: j)
                        do { try store.restoreStagedApp(&j) } catch {
                            // The fenced target stays installed and fenced; retain everything.
                            j.phase = .recoveryRequired; j.error = error.localizedDescription; try store.save(j); return
                        }
                        try finish(store: store, journal: j); return
                    case .recoveryRequired(let reason):
                        j.phase = .recoveryRequired; j.error = reason; try store.save(j); return
                    }
                    if step == .activate { break }
                }
                try await Task.sleep(for: .seconds(1)); guard let next = try store.read() else { return }; j = next
            }
            guard !j.terminal, j.phase != .recoveryRequired else { return }
            let transactionLease = try heldLease ?? RecoveryLease(store.directory.appendingPathComponent("transaction.lock"))
            defer { withExtendedLifetime(transactionLease) {} }
            do {
                if j.phase == .activating {
                    while Date() < j.deadline && (try? NativeRecoveryStore.build(of: URL(fileURLWithPath: j.appPath))) != j.targetBuild {
                        try await Task.sleep(for: .seconds(1))
                    }
                    guard Date() < j.deadline else { throw ConfigurationError("Sparkle activation did not complete before its deadline.") }
                    try NativeRecoveryStore.verifySignedApp(URL(fileURLWithPath: j.appPath))
                    try NativeRecoveryStore.requireCompatibleApp(URL(fileURLWithPath: j.appPath))
                    j.phase = .probation; j.deadline = Date(timeIntervalSinceNow: 180); try store.save(j)
                }
                if j.phase == .probation {
                    try stopRecorded("worker.json", role: "Dispatch Worker", store: store, journal: j)
                    try await probation(store: store, journal: j, build: j.targetBuild)
                    j.phase = .committed; try store.save(j)
                    try finish(store: store, journal: j)
                    return
                }
            } catch {
                j.error = error.localizedDescription
                try store.save(j)
            }
            // Restore re-entry is idempotent; probation of the old bundle is attempted
            // once after restoration. A failed old health check never starts a loop.
            do {
                try stopRecorded("worker.json", role: "Dispatch Worker", store: store, journal: j)
                try stopRecorded("menu-ready.json", role: "Dispatch", store: store, journal: j)
                try store.restore(&j)
                if !j.rollbackProbationStarted {
                    j.rollbackProbationStarted = true; j.deadline = Date(timeIntervalSinceNow: 180); try store.save(j)
                }
                try await probation(store: store, journal: j, build: j.oldBuild)
                j.phase = .rolledBack; try store.save(j)
                try finish(store: store, journal: j)
            } catch {
                j.phase = .recoveryRequired; j.error = error.localizedDescription; try store.save(j)
            }
        } catch {
            fputs("Dispatch recovery: \(error.localizedDescription)\n", stderr)
            // Fail closed; a damaged journal is never treated as no transaction.
            exit(1)
        }
    }
    static func probation(store: NativeRecoveryStore, journal: NativeRecoveryJournal, build: String) async throws {
        let app = URL(fileURLWithPath: journal.appPath)
        do { let leases = try store.requireStopped(); withExtendedLifetime(leases) {} }
        // The worker holds its own lease for its entire lifetime. If this helper is
        // killed, a replacement cannot restore while the orphan can still write.
        let worker = Process(); worker.executableURL = app.appendingPathComponent("Contents/MacOS/Dispatch Worker")
        worker.arguments = ["--worker"]
        worker.environment = ["PATH": "/usr/bin:/bin", "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
                              "DISPATCH_UPDATE_RECOVERY_ID": journal.id, "DISPATCH_UPDATE_RECOVERY_NONCE": journal.nonce]
        worker.standardOutput = FileHandle.nullDevice; worker.standardError = FileHandle.nullDevice
        try worker.run()
        do {
            _ = try? RecoveryCommand.run(URL(fileURLWithPath: "/usr/bin/open"), [app.path])
            try await RecoveryProtocol.awaitReadiness(
                deadline: journal.deadline,
                workerRunning: { worker.isRunning },
                menuReady: {
                    let menu = (try? Data(contentsOf: store.directory.appendingPathComponent("menu-ready.json")))
                        .flatMap { try? JSONDecoder().decode(RecoveryProcess.self, from: $0) }
                    return menu?.transactionId == journal.id && menu?.build == build && menu?.matches == true
                },
                serverReady: { await RecoveryProtocol.ready(journal, root: store.root, build: build) }
            )
            try stop(worker)
        } catch { try stop(worker); throw error }
    }
    static func stop(_ worker: Process) throws {
        guard worker.isRunning else { return }
        worker.terminate()
        let deadline = Date(timeIntervalSinceNow: 55)
        while worker.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        guard !worker.isRunning else { throw ConfigurationError("The probation worker did not stop. Automatic restoration is blocked; inspect retained recovery files.") }
        worker.waitUntilExit()
    }
    static func stopRecorded(_ name: String, role: String, store: NativeRecoveryStore, journal: NativeRecoveryJournal) throws {
        let path = store.directory.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: path.path) else { return }
        let record = try JSONDecoder().decode(RecoveryProcess.self, from: Data(contentsOf: path))
        guard record.transactionId == journal.id else { return }
        try record.stop(expectedExecutable: URL(fileURLWithPath: journal.appPath).appendingPathComponent("Contents/MacOS/" + role), transaction: journal)
    }
    /// Idempotent on every launchd tick. The helper never writes a service request: the
    /// menu delivers the pinned request from the durable handoff record and marks it
    /// handled. The menu is opened once, so a later Quit or user Stop is never overridden.
    static func finish(store: NativeRecoveryStore, journal: NativeRecoveryJournal) throws {
        switch try store.terminalStep(journal) {
        case .openApp:
            _ = try? RecoveryCommand.run(URL(fileURLWithPath: "/usr/bin/open"), [journal.appPath])
            try store.markHandoffOpened(journal)
        case .wait: return
        case .retire: try RecoveryEnrollment.retire(instanceID: journal.instanceID)
        }
    }
}
