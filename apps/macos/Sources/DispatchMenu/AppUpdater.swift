#if SPARKLE_UPDATES
import AppKit
import Darwin
import DispatchCore
import ServiceManagement
import Sparkle

/// Owns the app/service handoff. Sparkle owns archive verification and bundle replacement.
@MainActor
final class AppUpdater: NSObject, SPUUpdaterDelegate {
    private var updater: SPUUpdater!
    private let userDriver = UpdateUserDriver(hostBundle: .main, delegate: nil)
    private let service: SMAppService
    private let root: URL
    private let build: String
    private var recovery: UpdateRecovery?
    private let handoff = UpdateHandoff()
    private var nativeStore: NativeRecoveryStore { NativeRecoveryStore(root: root) }
    private var started = false
    private var targetIdentity = ""
    private(set) var busy = false
    private(set) var needsRecovery = false
    // Progress of a check or install the web app asked for, plus what any check found.
    private var checking = false
    private var installing = false
    private var availableVersion: String?
    private var checkedAt: Date?
    private var remoteError: String?
    /// Bounded idle retries after the server reported active work. Nothing is staged
    /// meanwhile, so Quit, logout, and restart never install an unprotected update.
    private var deferral = UpdateDeferralSchedule()
    private var deferralTask: Task<Void, Never>?
    private(set) var deferredNote: String?
    /// Held for the whole life of a `staged` journal this menu owns, so the helper can
    /// tell a live menu from a dead one. Reused by preparation; released at activation.
    private var stagedLease: RecoveryLease?
    private var preparingSnapshot = false
    private var snapshotRetry = false
    /// Extraction began without staged protection (resume path whose staging failed).
    /// Its installer is withdrawn at the install hook instead of being fenced.
    private var unprotectedExtraction = false
    /// Sparkle keeps a dismissed downloaded update in memory and later resumes it
    /// without `shouldProceedWithUpdate`; its staged journal is kept for that resume.
    private var resumableDownload = false
    private var withdrawal: StagedInstallerWithdrawal { StagedInstallerWithdrawal(bundleIdentifier: Bundle.main.bundleIdentifier ?? "") }
    /// Set while a remote install has turned on automatic updates; holds the setting to
    /// restore. Persisted so a crash or relaunch mid-install cannot leave it switched on.
    private static let restoreAutomaticKey = "DispatchRemoteInstallRestoresAutomatic"
    var onChange: (() -> Void)?
    var onError: ((String) -> Void)?
    var wasRunning: () -> Bool = { ServiceRuntime.read()?.isActive == true && ServiceRuntime.read()?.phase != "stopping" }
    var controlsLocked: Bool { busy || handoff.active }
    var canCheck: Bool { !controlsLocked && !needsRecovery && updater?.canCheckForUpdates == true }
    var automatic: Bool { updater.automaticallyChecksForUpdates && updater.automaticallyDownloadsUpdates }
    var requiresTerminationHandoff: Bool { (handoff.active && !handoff.prepared) || ownedStagedJournal() != nil }
    private func ownedStagedJournal() -> NativeRecoveryJournal? {
        guard let j = try? nativeStore.read(), j.phase == .staged, j.oldBuild == build, !j.restoreStarted else { return nil }
        return j
    }

    init(service: SMAppService, root: URL = AppPaths.root, build: String = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0") {
        self.service = service; self.root = root; self.build = build
        super.init()
        updater = SPUUpdater(hostBundle: .main, applicationBundle: .main, userDriver: userDriver, delegate: self)
    }
    func start() async {
        do {
            needsRecovery = FileManager.default.fileExists(atPath: UpdateRecovery.path(root: root).path)
            recovery = try UpdateRecovery.read(root: root)
            try RecoveryEnrollment.menuAcknowledgment(store: nativeStore, build: build)
            try await awaitNativeRecovery()
            reclaimStaged()
            if recovery != nil { try await restore() }
            restoreAutomatic()
            if let native = try nativeStore.read(), native.terminal, recovery == nil { try nativeStore.markHandoffHandled(native) }
            try await requireProtectedResume()
            try startUpdater()
            prepareSnapshot()
        } catch { busy = false; fail(error) }
    }
    /// A staged journal left by an earlier run of this build: keep protecting a still
    /// staged installer (Quit then runs the protected handoff), otherwise release it.
    private func reclaimStaged() {
        guard var j = ownedStagedJournal() else { return }
        if withdrawal.staged() {
            targetIdentity = j.targetIdentity
            if stagedLease == nil { stagedLease = try? RecoveryLease(nativeStore.directory.appendingPathComponent("transaction.lock")) }
            log("adopted staged protection target=\(j.targetBuild)")
        } else {
            try? nativeStore.unstage(&j, reason: "No Sparkle installer remained after relaunch.", installerAbsent: { !self.withdrawal.staged() })
            log("released staged protection target=\(j.targetBuild)")
        }
    }
    /// Starting Sparkle resumes any staged installer. Only a protected one may resume;
    /// otherwise it is withdrawn and proven absent first, or the updater stays stopped
    /// with an actionable error. Never a blind resume.
    private func requireProtectedResume() async throws {
        let probe = withdrawal
        let maybe = await Task.detached { probe.staged() }.value
        guard nativeStore.resumeDecision(build: build, installerMaybeStaged: maybe) == .withdrawFirst else { return }
        log("unprotected staged installer found before starting Sparkle; withdrawing")
        let withdrawn = await Task.detached { probe.withdraw() }.value
        guard withdrawn else {
            needsRecovery = true
            throw ConfigurationError("Sparkle has an update installer staged without Dispatch's recovery protection, and Dispatch could not remove it. Updates stay stopped so it cannot install unprotected. Run `launchctl bootout gui/\(getuid())/\(probe.labels[0])`, then choose Retry Update Recovery.")
        }
    }
    /// Keeps one verified snapshot of this build ready so staging never waits on a copy.
    private func prepareSnapshot() {
        guard !preparingSnapshot, !busy, !handoff.active, nativeStore.readySnapshot(app: Bundle.main.bundleURL, build: build) == nil,
              (try? Configuration.read(from: root.appendingPathComponent("configuration.json")))?.usesManagedDatabase == true,
              (try? NativeRecoveryStore.requireCompatibleApp(Bundle.main.bundleURL)) != nil else {
            if snapshotRetry, nativeStore.readySnapshot(app: Bundle.main.bundleURL, build: build) != nil { snapshotRetry = false; retryDeferredInstall() }
            return
        }
        preparingSnapshot = true
        let store = nativeStore, app = Bundle.main.bundleURL, build = self.build
        Task {
            let error: String? = await Task.detached(priority: .utility) {
                do { try store.prepareSnapshot(app: app, build: build); return nil } catch { return error.localizedDescription }
            }.value
            preparingSnapshot = false
            log(error.map { "update protection snapshot failed: \($0)" } ?? "update protection snapshot ready")
            if error == nil, snapshotRetry { snapshotRetry = false; retryDeferredInstall() }
        }
    }
    /// Checks every refusal before Sparkle may download, fence, or stop anything.
    private func protectionPreflight(identity: String) throws -> Configuration {
        guard !identity.isEmpty else { throw RecoveryRefusal("The update is missing its signed artifact identity, so it cannot be installed with a recovery point. Dispatch withdrew it.") }
        let config = try Configuration.read(from: root.appendingPathComponent("configuration.json"))
        guard config.usesManagedDatabase else {
            throw RecoveryRefusal("Dispatch did not install this update: automatic recovery covers only the app’s own PostgreSQL database, and this Mac uses an external database. Automatic downloads are now off. Follow the manual operator update in docs/macos-native-recovery.md: stop the server, back up your database and the Dispatch data folder, then replace the app.")
        }
        do { try NativeRecoveryStore.requireCompatibleApp(Bundle.main.bundleURL) } catch { throw RecoveryRefusal(error.localizedDescription) }
        // Prove rollback can rename the app and state before anything else happens.
        try nativeStore.preflightRollbackPermissions(app: Bundle.main.bundleURL)
        if let data = try? Data(contentsOf: nativeStore.directory.appendingPathComponent("quarantine.json")),
           let quarantine = try? JSONDecoder().decode([String: String].self, from: data), quarantine["identity"] == identity {
            throw RecoveryRefusal("This update artifact failed recovery probation and is quarantined. Choose a later release or inspect the recovery files before an explicit retry.")
        }
        return config
    }
    /// Synchronous and durable before Sparkle may stage an installer: snapshot moved
    /// into a transaction, helper enrolled, `staged` journal fsynced, lease held.
    /// Throws (vetoing the update) on any failure; never returns unprotected.
    private func stageProtection(_ item: SUAppcastItem) throws {
        let identity = Self.artifactIdentity(item)
        let store = nativeStore
        if let existing = try store.read(), !existing.terminal {
            if existing.phase == .staged, existing.oldBuild == build, !existing.restoreStarted,
               existing.targetIdentity == identity, existing.targetBuild == item.versionString {
                if stagedLease == nil { stagedLease = try RecoveryLease(store.directory.appendingPathComponent("transaction.lock")) }
                targetIdentity = identity; return
            }
            guard var stale = ownedStagedJournal(), !withdrawal.staged() else {
                throw ConfigurationError("Another update is still pending. Finish or retry it before installing a different one.")
            }
            try store.unstage(&stale, reason: "Superseded by update \(item.versionString).", installerAbsent: { !self.withdrawal.staged() })
        }
        // Capability baseline: this build declares protocol 1 (checked in preflight), and
        // Sparkle never installs an older build, so only strictly newer targets, which
        // must keep the protocol 1 startup gate, may be staged.
        guard SUStandardVersionComparator.default.compareVersion(build, toVersion: item.versionString) == .orderedAscending else {
            throw RecoveryRefusal("Update \(item.versionString) is not newer than this build; it cannot be installed with staged protection.", disablesAutomatic: false)
        }
        // The signed feed must declare protocol 1 for this target before download.
        try Self.declarationGate(item, host: Bundle.main)
        let config = try protectionPreflight(identity: identity)
        guard store.readySnapshot(app: Bundle.main.bundleURL, build: build) != nil else {
            snapshotRetry = true; prepareSnapshot()
            throw ConfigurationError("Dispatch is preparing update protection and will continue this update automatically.")
        }
        var journal = NativeRecoveryJournal(instanceID: config.instanceID, appPath: Bundle.main.bundleURL.path, oldBuild: build, targetBuild: item.versionString, targetIdentity: identity, wasRunning: wasRunning())
        journal.declaredProtocol = 1
        let lease = try stagedLease ?? RecoveryLease(store.directory.appendingPathComponent("transaction.lock"))
        do {
            try store.stage(&journal, app: Bundle.main.bundleURL)
            try RecoveryEnrollment.enroll(store: store, app: Bundle.main.bundleURL, journal: journal)
            // The helper must be alive for this transaction before Sparkle may proceed.
            guard RecoveryEnrollment.awaitAcknowledgment(store: store, journal: journal) else {
                throw RecoveryRefusal("The independent recovery launcher did not start, so Dispatch did not download the update. Allow Dispatch in System Settings › General › Login Items & Extensions, then choose Check for Updates.", disablesAutomatic: false)
            }
        } catch {
            try? store.unstage(&journal, reason: error.localizedDescription, installerAbsent: { !self.withdrawal.staged() })
            throw error
        }
        stagedLease = lease; targetIdentity = identity
        log("staged protection target=\(journal.targetBuild) transaction=\(journal.id)")
    }
    /// The declaration is trusted only when this bundle makes Sparkle reject unsigned
    /// feeds. Shared with the real-Sparkle feed fixture so the test runs this code.
    nonisolated static func declarationGate(_ item: SUAppcastItem, host: Bundle) throws {
        try RecoveryTargetDeclaration.verify(properties: item.propertiesDictionary,
                                             requiresSignedFeed: (host.object(forInfoDictionaryKey: "SURequireSignedFeed") as? NSNumber)?.boolValue == true)
    }
    /// Drops this menu's staged protection, only once no installer can exist.
    private func releaseStaged(_ reason: String) {
        guard var j = ownedStagedJournal(), !withdrawal.staged() else { return }
        try? nativeStore.unstage(&j, reason: reason, installerAbsent: { !self.withdrawal.staged() })
        stagedLease = nil
        log("released staged protection: \(reason)")
    }
    /// Bounded by the journal deadline plus grace. A missing helper is kickstarted a few
    /// times; then the wait fails with an actionable error. Ordinary server starts stay
    /// fenced by the journal either way, and Retry Update Recovery re-enters this wait.
    private func awaitNativeRecovery() async throws {
        guard let first = try nativeStore.read(), !first.permitsOrdinaryStart(build: build) else { return }
        needsRecovery = true; busy = true; onChange?()
        defer { busy = false; onChange?() }
        var watch = HelperWatch()
        let store = nativeStore
        while let current = try store.read(), !current.permitsOrdinaryStart(build: build) {
            guard current.phase != .recoveryRequired else { throw ConfigurationError(current.error ?? "Native recovery needs operator attention. Open the retained recovery directory.") }
            switch watch.decide(now: Date(), deadline: current.deadline, helperAlive: store.helperRunning()) {
            case .wait: break
            case .kickstart:
                log("recovery helper not running; kickstart \(watch.kickstarts)")
                let instance = current.instanceID
                _ = await Task.detached { try? RecoveryEnrollment.kickstart(instanceID: instance) }.value
            case .fail:
                log("recovery helper wait expired phase=\(current.phase.rawValue)")
                throw ConfigurationError(HelperWatch.failure(store: store, phase: current.phase))
            }
            try await Task.sleep(for: .seconds(1))
        }
    }
    func check() { if canCheck { updater.checkForUpdates() } }
    func setAutomatic(_ value: Bool) {
        // An explicit choice replaces whatever a remote install would have restored.
        UserDefaults.standard.removeObject(forKey: Self.restoreAutomaticKey)
        applyAutomatic(value)
    }
    private func applyAutomatic(_ value: Bool) {
        updater.automaticallyChecksForUpdates = value
        updater.automaticallyDownloadsUpdates = value
        onChange?()
    }
    private func restoreAutomatic() {
        guard let previous = UserDefaults.standard.object(forKey: Self.restoreAutomaticKey) as? Bool else { return }
        UserDefaults.standard.removeObject(forKey: Self.restoreAutomaticKey)
        applyAutomatic(previous)
    }

    var remoteState: AppUpdateState {
        let phase: AppUpdateState.Phase = needsRecovery ? .recovery
            : controlsLocked ? .installing
            : installing ? .downloading
            : checking ? .checking
            : remoteError != nil ? .error : .idle
        return AppUpdateState(version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0",
                              phase: phase, availableVersion: availableVersion, checkedAt: checkedAt,
                              error: phase == .error || phase == .recovery ? remoteError : nil, automatic: automatic)
    }
    /// Runs a check or install without showing Sparkle's windows, since the person
    /// asking may not be at this Mac.
    func perform(remote action: String) {
        guard started, !controlsLocked, !needsRecovery, !checking, !installing else { return }
        guard !updater.sessionInProgress else {
            remoteError = "An update window is open on the Mac. Close it, then try again."
            onChange?(); return
        }
        remoteError = nil
        switch action {
        case "check":
            checking = true
            updater.checkForUpdateInformation()
        case "install":
            installing = true
            // Sparkle downloads and installs silently only with automatic updates on.
            if !automatic {
                UserDefaults.standard.set(false, forKey: Self.restoreAutomaticKey)
                updater.automaticallyChecksForUpdates = true
                updater.automaticallyDownloadsUpdates = true
            }
            updater.checkForUpdatesInBackground()
        default: return
        }
        onChange?()
    }
    func retry() async {
        guard !busy else { return }
        do {
            if handoff.active {
                if await prepareTermination() { handoff.resume() }
                return
            }
            try await awaitNativeRecovery()
            recovery = try UpdateRecovery.read(root: root)
            if recovery != nil { try await restore() }
            else if let native = try nativeStore.read(), native.terminal { try nativeStore.markHandoffHandled(native) }
            needsRecovery = false; remoteError = nil
            try await requireProtectedResume()
            try startUpdater()
            onChange?()
        } catch { fail(error) }
    }
    private func fail(_ error: Error) {
        remoteError = error.localizedDescription
        needsRecovery = needsRecovery || recovery != nil || handoff.active
        onChange?()
        if !userDriver.stopped(error.localizedDescription) { onError?(error.localizedDescription) }
    }
    private func startUpdater() throws {
        guard !started else { return }
        try updater.start()
        started = true
        onChange?()
    }
    private func log(_ message: String) {
        let path = root.appendingPathComponent("app-update.log")
        if !FileManager.default.fileExists(atPath: path.path) {
            FileManager.default.createFile(atPath: path.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        guard let file = try? FileHandle(forWritingTo: path) else { return }
        defer { try? file.close() }
        _ = try? file.seekToEnd()
        try? file.write(contentsOf: Data("\(Date().ISO8601Format()) build=\(build) \(message)\n".utf8))
    }
    private static func artifactIdentity(_ item: SUAppcastItem) -> String {
        guard let enclosure = item.propertiesDictionary["enclosure"] as? [String: Any],
              let signature = enclosure["sparkle:edSignature"] as? String, !signature.isEmpty else { return "" }
        return "ed25519:" + signature
    }
    private func retainIntent(_ item: SUAppcastItem) throws {
        handoff.begin(UpdateRecovery(wasRunning: wasRunning(), targetBuild: item.versionString))
        targetIdentity = Self.artifactIdentity(item)
        guard let value = handoff.intent else { return }
        recovery = value
        log("installation pending target=\(value.targetBuild) running=\(value.wasRunning)")
    }
    private func leaseReleased() -> Bool {
        let file = root.appendingPathComponent("service.lock")
        if !FileManager.default.fileExists(atPath: file.path) { return true }
        let fd = open(file.path, O_RDWR | O_CLOEXEC | O_NOFOLLOW)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        return flock(fd, LOCK_EX | LOCK_NB) == 0
    }
    private func stopService() async throws {
        if !service.status.needsRegistration { try await service.unregister() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(55))
        while ContinuousClock.now < deadline {
            if leaseReleased() && !FileManager.default.fileExists(atPath: root.appendingPathComponent("postgres/postmaster.pid").path) { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw ConfigurationError("Dispatch could not stop its server for the update. Your data is unchanged. Try again or open the data folder to inspect server.log.")
    }
    /// True when the app may terminate: either the protected handoff is prepared, or a
    /// deferred/refused update was withdrawn from Sparkle and nothing installs on quit.
    func prepareTermination() async -> Bool {
        if handoff.prepared { return true }
        guard !busy else { return false }
        if !handoff.active, let staged = ownedStagedJournal() {
            // Sparkle may install on this termination (e.g. "install on quit" was chosen).
            guard withdrawal.staged() else { releaseStaged("Quit with no staged installer."); return true }
            handoff.begin(UpdateRecovery(wasRunning: wasRunning(), targetBuild: staged.targetBuild))
            targetIdentity = staged.targetIdentity
        }
        busy = true; userDriver.preparing(); onChange?()
        defer { userDriver.preparationFinished(); busy = false; onChange?() }
        do {
            try await handoff.prepare(save: { value in
                recovery = value
            }, stop: { try await prepareNativeRecovery() })
            needsRecovery = false
            clearDeferral()
            userDriver.restarting()
            log("service stopped for installation")
            return true
        } catch let error as RecoveryDeferral {
            // Nothing was stopped or fenced: clear the intent before any await so a
            // concurrent Sparkle abort cannot "restore" (restart) a server mid-turn.
            recovery = nil
            return await withdrawStagedInstall(error, retry: true)
        } catch let error as RecoveryRefusal {
            recovery = nil
            return await withdrawStagedInstall(error, retry: false, disableAutomatic: error.disablesAutomatic)
        } catch { fail(error); return false }
    }
    /// Sparkle's staged installer would install on any termination (see
    /// docs/macos-native-recovery.md). Remove it and prove it is gone before releasing
    /// the handoff; if that cannot be proven, Quit stays held with exact instructions.
    private func withdrawStagedInstall(_ reason: LocalizedError, retry: Bool, disableAutomatic: Bool = false) async -> Bool {
        let withdrawal = StagedInstallerWithdrawal(bundleIdentifier: Bundle.main.bundleIdentifier ?? "")
        let withdrawn = await Task.detached { withdrawal.withdraw() }.value
        let message = reason.errorDescription ?? "The update could not be protected."
        guard withdrawn else {
            log("staged installer could not be withdrawn: \(message)")
            fail(ConfigurationError("\(message)\n\nSparkle has already staged this update to install when Dispatch quits, and Dispatch could not withdraw it, so Dispatch will not quit or log out while it would install unprotected. Choose Retry Update Recovery when agents are idle, or remove the staged installer with `launchctl bootout gui/\(getuid())/\(withdrawal.labels[0])` and quit again."))
            return false
        }
        handoff.abort(); needsRecovery = false
        releaseStaged(message)
        unprotectedExtraction = false
        log("staged installer withdrawn retry=\(retry): \(message)")
        if retry {
            remoteError = message
            scheduleDeferredRetry()
            userDriver.stopped(deferredNote != nil ? "\(message) Dispatch will retry automatically when agents are idle." : remoteError ?? message)
        } else {
            clearDeferral()
            if disableAutomatic {
                // Stop re-downloading an update that will be refused again. Checks stay
                // on, so new releases are still announced; installing one asks again.
                UserDefaults.standard.removeObject(forKey: Self.restoreAutomaticKey)
                updater.automaticallyDownloadsUpdates = false
            }
            remoteError = message
            if !userDriver.stopped(message) { onError?(message) }
        }
        onChange?()
        return true
    }
    private func scheduleDeferredRetry() {
        deferralTask?.cancel()
        guard let when = deferral.next(after: Date()) else {
            clearDeferral()
            remoteError = "Dispatch postponed the update because agents stayed busy. Choose Check for Updates when work is idle."
            userDriver.retryExhausted(remoteError!)
            onChange?(); return
        }
        deferredNote = "Update waits for agents to finish"
        deferralTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(1, when.timeIntervalSinceNow)))
            guard !Task.isCancelled else { return }
            self?.retryDeferredInstall()
        }
    }
    private func retryDeferredInstall() {
        deferralTask = nil
        guard started, !controlsLocked, !needsRecovery, !updater.sessionInProgress else { scheduleDeferredRetry(); return }
        log("retrying deferred update attempt=\(deferral.attempts)")
        // Same silent path as a remote install; the setting is restored after the cycle.
        if !automatic {
            UserDefaults.standard.set(false, forKey: Self.restoreAutomaticKey)
            updater.automaticallyChecksForUpdates = true
            updater.automaticallyDownloadsUpdates = true
        }
        updater.checkForUpdatesInBackground()
    }
    private func clearDeferral() {
        deferralTask?.cancel(); deferralTask = nil
        deferral = UpdateDeferralSchedule(); deferredNote = nil
    }
    private func prepareNativeRecovery() async throws {
        guard let intent = handoff.intent else { throw ConfigurationError("No pending installation.") }
        if unprotectedExtraction { throw RecoveryDeferral(code: "UNPROTECTED_STAGE", reasons: ["update protection was not staged before extraction"]) }
        let config = try protectionPreflight(identity: targetIdentity)
        let store = nativeStore
        let transactionLease = try stagedLease ?? RecoveryLease(store.directory.appendingPathComponent("transaction.lock"))
        defer { withExtendedLifetime(transactionLease) {} }
        // Continue the staged transaction (its snapshot predates Sparkle's installer);
        // without one, this is an older-style full backup with a new journal.
        guard var journal = ownedStagedJournal(), journal.targetIdentity == targetIdentity, journal.targetBuild == intent.targetBuild, journal.instanceID == config.instanceID else {
            throw RecoveryDeferral(code: "UNPROTECTED_STAGE", reasons: ["no staged protection matches this installer"])
        }
        var preparationWorker: Process?
        var fenced = false
        do {
            journal.phase = .preparing; journal.wasRunning = intent.wasRunning
            journal.deadline = Date(timeIntervalSinceNow: 1800); try store.save(journal)
            let deadline = Date(timeIntervalSinceNow: 15)
            while Date() < deadline && !RecoveryEnrollment.acknowledged(store: store, journal: journal) { try await Task.sleep(for: .milliseconds(100)) }
            guard RecoveryEnrollment.acknowledged(store: store, journal: journal) else { throw RecoveryRefusal("The independent recovery launcher did not start, so Dispatch withdrew the update before stopping anything. Allow Dispatch in System Settings › General › Login Items & Extensions, then choose Check for Updates.", disablesAutomatic: false) }
            if !intent.wasRunning {
                let worker = Process()
                worker.executableURL = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/Dispatch Worker")
                worker.arguments = ["--worker"]
                worker.environment = ["HOME": FileManager.default.homeDirectoryForCurrentUser.path, "PATH": "/usr/bin:/bin", "DISPATCH_UPDATE_RECOVERY_ID": journal.id, "DISPATCH_UPDATE_RECOVERY_NONCE": journal.nonce]
                try worker.run(); preparationWorker = worker
                let readyDeadline = Date(timeIntervalSinceNow: 120)
                while Date() < readyDeadline {
                    if await LocalServerTrust.isHealthy(configuration: config, root: root) { break }
                    guard worker.isRunning else { throw ConfigurationError("The private readiness server failed to start.") }
                    try await Task.sleep(for: .milliseconds(250))
                }
            }
            try await RecoveryProtocol.prepare(journal, root: root)
            fenced = true
            try intent.save(root: root)
            if let identifier = Bundle.main.bundleIdentifier,
               let preferences = UserDefaults.standard.persistentDomain(forName: identifier) {
                let data = try PropertyListSerialization.data(fromPropertyList: preferences, format: .binary, options: 0)
                let path = root.appendingPathComponent("native-update-preferences.plist")
                try data.write(to: path, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
            }
            if let preparationWorker { try await stopPreparationWorker(preparationWorker) }
            try await stopService()
            let prepared = journal
            journal = try await Task.detached { var value = prepared; try store.backup(&value); return value }.value
            journal.phase = .activating; journal.deadline = Date(timeIntervalSinceNow: 300)
            try store.save(journal)
            stagedLease = nil
        } catch {
            if let preparationWorker { try? await stopPreparationWorker(preparationWorker) }
            // A staged transaction returns to staged: Sparkle's installer may still exist,
            // so protection stays until a withdrawal is proven.
            if try store.revertToStaged(&journal, error: error.localizedDescription) {
                _ = try? await RecoveryProtocol.request("abort", journal: journal, root: root)
                if fenced { try? await restore() }
            }
            throw error
        }
    }
    private func stopPreparationWorker(_ worker: Process) async throws {
        if worker.isRunning { worker.terminate() }
        let deadline = Date(timeIntervalSinceNow: 55)
        while worker.isRunning && Date() < deadline { try await Task.sleep(for: .milliseconds(100)) }
        guard !worker.isRunning else { throw ConfigurationError("The private readiness worker did not stop; installation is blocked.") }
    }
    private func install(_ item: SUAppcastItem, handler: @escaping () -> Void) {
        handoff.begin(UpdateRecovery(wasRunning: wasRunning(), targetBuild: item.versionString))
        targetIdentity = Self.artifactIdentity(item)
        handoff.postpone(handler)
        Task { if await prepareTermination() { handoff.resume() } }
    }
    private func restore() async throws {
        guard let recovery else { return }
        if let native = try nativeStore.read(), !native.permitsOrdinaryStart(build: build) {
            throw ConfigurationError("The independent recovery launcher owns this update. Wait for it to complete, or inspect its retained journal.")
        }
        busy = true; needsRecovery = true; onChange?()
        defer { busy = false; onChange?() }
        // Also reconciles a crash before old-service cleanup finished.
        try await stopService()
        // A native transaction's handoff pins one request ID, so a redelivery after a
        // crash is the same request. A handled (older) record never lends its ID.
        let native = try nativeStore.read()
        let pinned = try native.flatMap { !$0.terminal || nativeStore.handoff(for: $0)?.handled == true ? nil : try nativeStore.beginHandoff($0, opened: true) }
        let command = pinned.map { ServiceRequest(id: $0.requestID, start: recovery.wasRunning) } ?? ServiceRequest(start: recovery.wasRunning)
        try command.save(root: root)
        try service.register()
        if service.status == .requiresApproval {
            SMAppService.openSystemSettingsLoginItems()
            throw ConfigurationError("Allow Dispatch in Login Items, then choose Retry Update Recovery.")
        }
        let deadline = ContinuousClock.now.advanced(by: .seconds(60))
        while ContinuousClock.now < deadline {
            let runtime = ServiceRuntime.read(root: root)
            if runtime?.acknowledges(command) == true {
                var healthy = !recovery.wasRunning
                if recovery.wasRunning, let config = runtime?.configuration {
                    healthy = await LocalServerTrust.isHealthy(configuration: config, root: root)
                }
                if healthy {
                    if let native = try nativeStore.read(), native.phase == .rolledBack {
                        if let identifier = Bundle.main.bundleIdentifier,
                           let data = try? Data(contentsOf: root.appendingPathComponent("native-update-preferences.plist")),
                           let preferences = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] {
                            UserDefaults.standard.setPersistentDomain(preferences, forName: identifier)
                        }
                        UserDefaults.standard.removeObject(forKey: Self.restoreAutomaticKey)
                        applyAutomatic(false)
                    }
                    let confirmed = try recovery.completeRestoration(root: root, installedBuild: build, request: command, runtime: runtime, healthy: healthy)
                    self.recovery = nil
                    if let native, native.terminal { try nativeStore.markHandoffHandled(native) }
                    needsRecovery = false
                    log("restored request=\(command.id) running=\(recovery.wasRunning) target=\(recovery.targetBuild) confirmed=\(confirmed)")
                    if confirmed { UpdateNotifier.shared.notifyUpdated(serverRunning: recovery.wasRunning) }
                    return
                }
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        try await stopService()
        log("recovery failed readiness; pending intent retained")
        throw ConfigurationError("The updated server could not start. Your settings and database are preserved. Resolve the problem in server.log, then choose Retry Update Recovery.")
    }
    /// Read per check, so a channel picked in Settings applies to the next one.
    func allowedChannels(for updater: SPUUpdater) -> Set<String> { UpdateChannel.current().sparkleChannels }
    func updater(_ updater: SPUUpdater, mayPerform updateCheck: SPUUpdateCheck) throws {
        if controlsLocked || needsRecovery { throw ConfigurationError("Finish update recovery before checking for another update.") }
    }
    /// The last point where an update can be vetoed before Sparkle downloads, extracts,
    /// and submits its installer job. Information-only checks never stage anything.
    func updater(_ updater: SPUUpdater, shouldProceedWithUpdate item: SUAppcastItem, updateCheck: SPUUpdateCheck) throws {
        guard updateCheck != .updateInformation else { return }
        do { try stageProtection(item) } catch let refusal as RecoveryRefusal {
            remoteError = refusal.message
            if refusal.disablesAutomatic {
                UserDefaults.standard.removeObject(forKey: Self.restoreAutomaticKey)
                updater.automaticallyDownloadsUpdates = false
            }
            onChange?(); throw refusal
        }
    }
    /// Synchronous, immediately before Sparkle launches its installer. This hook cannot
    /// veto, so it only validates that a matching staged journal exists (resumed
    /// downloads skip `shouldProceedWithUpdate`); otherwise it latches a refusal and the
    /// installer is withdrawn at the install hook rather than allowed to install.
    func updater(_ updater: SPUUpdater, willExtractUpdate item: SUAppcastItem) {
        let identity = Self.artifactIdentity(item)
        let protected = ownedStagedJournal().map { $0.targetIdentity == identity && $0.targetBuild == item.versionString } ?? false
        resumableDownload = false
        unprotectedExtraction = !protected
        if !protected { log("extraction without staged protection; the installer will be withdrawn at the install hook") }
    }
    func updater(_ updater: SPUUpdater, userDidMake choice: SPUUserUpdateChoice, forUpdate updateItem: SUAppcastItem, state: SPUUserUpdateState) {
        resumableDownload = choice == .dismiss && state.stage == .downloaded
    }
    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        restoreAutomatic()
        do { try retainIntent(item) } catch { fail(error) }
    }
    // Any successful check, remote or not, supersedes an earlier remote failure.
    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        availableVersion = item.displayVersionString; checkedAt = Date(); remoteError = nil; onChange?()
    }
    func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        clearDeferral()
        availableVersion = nil; checkedAt = Date(); remoteError = nil; onChange?()
    }
    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        let wasRemote = checking || installing
        checking = false; installing = false
        // Sparkle has handed off (or given up on) any install by now.
        restoreAutomatic()
        if wasRemote, let error = error as NSError?, error.code != Int(SUError.noUpdateError.rawValue) {
            remoteError = error.localizedDescription
        }
        // A cycle that ended with no installer (failed download, veto) releases staging;
        // a still-staged installer (e.g. "install on quit") keeps its protection.
        if !handoff.active && !resumableDownload { releaseStaged("Update cycle ended without a staged installer.") }
        // A deferred retry whose cycle ended without reaching the fence tries again later.
        if deferredNote != nil, deferralTask == nil, !handoff.active { scheduleDeferredRetry() }
        onChange?()
    }
    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock handler: @escaping () -> Void) -> Bool {
        install(item, handler: handler); return true
    }
    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem, untilInvokingBlock handler: @escaping () -> Void) -> Bool {
        install(item, handler: handler); return true
    }
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        guard handoff.abort() else { releaseStaged("Update cycle aborted without a staged installer."); onChange?(); return }
        Task {
            while busy { try? await Task.sleep(for: .milliseconds(100)) }
            do {
                // A save failure never stopped the service; there is nothing to replay.
                if recovery != nil { try await restore() }
                else { needsRecovery = false; onChange?() }
            } catch { fail(error) }
        }
    }
}
#endif
