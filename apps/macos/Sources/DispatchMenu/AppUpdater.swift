#if SPARKLE_UPDATES
import AppKit
import Darwin
import DispatchCore
import ServiceManagement
import Sparkle

/// Owns the app/service handoff. Sparkle owns archive verification and bundle replacement.
@MainActor
final class AppUpdater: NSObject, SPUUpdaterDelegate {
    private var controller: SPUStandardUpdaterController!
    private let service: SMAppService
    private let root: URL
    private let build: String
    private var recovery: UpdateRecovery?
    private let handoff = UpdateHandoff()
    private var started = false
    private(set) var busy = false
    private(set) var needsRecovery = false
    // Progress of a check or install the web app asked for, plus what any check found.
    private var checking = false
    private var installing = false
    private var availableVersion: String?
    private var checkedAt: Date?
    private var remoteError: String?
    /// Set while a remote install has turned on automatic updates; holds the setting to
    /// restore. Persisted so a crash or relaunch mid-install cannot leave it switched on.
    private static let restoreAutomaticKey = "DispatchRemoteInstallRestoresAutomatic"
    var onChange: (() -> Void)?
    var onError: ((String) -> Void)?
    var wasRunning: () -> Bool = { ServiceRuntime.read()?.isActive == true && ServiceRuntime.read()?.phase != "stopping" }
    var controlsLocked: Bool { busy || handoff.active }
    var canCheck: Bool { !controlsLocked && !needsRecovery && controller?.updater.canCheckForUpdates == true }
    var automatic: Bool { controller.updater.automaticallyChecksForUpdates && controller.updater.automaticallyDownloadsUpdates }
    var requiresTerminationHandoff: Bool { handoff.active && !handoff.prepared }

    init(service: SMAppService, root: URL = AppPaths.root, build: String = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0") {
        self.service = service; self.root = root; self.build = build
        super.init()
        controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
    }
    func start() async {
        do {
            needsRecovery = FileManager.default.fileExists(atPath: UpdateRecovery.path(root: root).path)
            recovery = try UpdateRecovery.read(root: root)
            if recovery != nil { try await restore() }
            restoreAutomatic()
            try startUpdater()
        } catch { fail(error) }
    }
    func check() { if canCheck { controller.checkForUpdates(nil) } }
    func setAutomatic(_ value: Bool) {
        // An explicit choice replaces whatever a remote install would have restored.
        UserDefaults.standard.removeObject(forKey: Self.restoreAutomaticKey)
        applyAutomatic(value)
    }
    private func applyAutomatic(_ value: Bool) {
        controller.updater.automaticallyChecksForUpdates = value
        controller.updater.automaticallyDownloadsUpdates = value
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
                              error: phase == .error ? remoteError : nil, automatic: automatic)
    }
    /// Runs a check or install without showing Sparkle's windows, since the person
    /// asking may not be at this Mac.
    func perform(remote action: String) {
        guard started, !controlsLocked, !needsRecovery, !checking, !installing else { return }
        guard !controller.updater.sessionInProgress else {
            remoteError = "An update window is open on the Mac. Close it, then try again."
            onChange?(); return
        }
        remoteError = nil
        switch action {
        case "check":
            checking = true
            controller.updater.checkForUpdateInformation()
        case "install":
            installing = true
            // Sparkle downloads and installs silently only with automatic updates on.
            if !automatic {
                UserDefaults.standard.set(false, forKey: Self.restoreAutomaticKey)
                controller.updater.automaticallyChecksForUpdates = true
                controller.updater.automaticallyDownloadsUpdates = true
            }
            controller.updater.checkForUpdatesInBackground()
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
            recovery = try UpdateRecovery.read(root: root)
            guard recovery != nil else { throw ConfigurationError("No saved update recovery state was found. Inspect the Dispatch data folder before retrying.") }
            try await restore()
            try startUpdater()
        } catch { fail(error) }
    }
    private func fail(_ error: Error) {
        needsRecovery = needsRecovery || recovery != nil || handoff.active
        onChange?(); onError?(error.localizedDescription)
    }
    private func startUpdater() throws {
        guard !started else { return }
        try controller.updater.start()
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
    private func retainIntent(_ item: SUAppcastItem) throws {
        handoff.begin(UpdateRecovery(wasRunning: wasRunning(), targetBuild: item.versionString))
        guard let value = handoff.intent else { return }
        try value.save(root: root)
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
    func prepareTermination() async -> Bool {
        if handoff.prepared { return true }
        guard !busy else { return false }
        busy = true; onChange?()
        defer { busy = false; onChange?() }
        do {
            try await handoff.prepare(save: { value in
                try value.save(root: root)
                recovery = value
            }, stop: { try await stopService() })
            needsRecovery = false
            log("service stopped for installation")
            return true
        } catch { fail(error); return false }
    }
    private func install(_ item: SUAppcastItem, handler: @escaping () -> Void) {
        handoff.begin(UpdateRecovery(wasRunning: wasRunning(), targetBuild: item.versionString))
        handoff.postpone(handler)
        Task { if await prepareTermination() { handoff.resume() } }
    }
    private func restore() async throws {
        guard let recovery else { return }
        busy = true; needsRecovery = true; onChange?()
        defer { busy = false; onChange?() }
        // Also reconciles a crash before old-service cleanup finished.
        try await stopService()
        let command = ServiceRequest(start: recovery.wasRunning)
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
                    let confirmed = try recovery.completeRestoration(root: root, installedBuild: build, request: command, runtime: runtime, healthy: healthy)
                    self.recovery = nil
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
    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        restoreAutomatic()
        do { try retainIntent(item) } catch { fail(error) }
    }
    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        availableVersion = item.displayVersionString; checkedAt = Date(); onChange?()
    }
    func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        availableVersion = nil; checkedAt = Date(); onChange?()
    }
    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
        let wasRemote = checking || installing
        checking = false; installing = false
        // Sparkle has handed off (or given up on) any install by now.
        restoreAutomatic()
        if wasRemote, let error = error as NSError?, error.code != Int(SUError.noUpdateError.rawValue) {
            remoteError = error.localizedDescription
        }
        onChange?()
    }
    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock handler: @escaping () -> Void) -> Bool {
        install(item, handler: handler); return true
    }
    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem, untilInvokingBlock handler: @escaping () -> Void) -> Bool {
        install(item, handler: handler); return true
    }
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        guard handoff.abort() else { onChange?(); return }
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
