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
    private var unsavedIntent: UpdateRecovery?
    private var prepared = false
    private var installationPending = false
    private var started = false
    private(set) var busy = false
    private(set) var needsRecovery = false
    var onChange: (() -> Void)?
    var onError: ((String) -> Void)?
    var wasRunning: () -> Bool = { ServiceRuntime.read()?.isActive == true && ServiceRuntime.read()?.phase != "stopping" }
    var controlsLocked: Bool { busy || installationPending }
    var canCheck: Bool { !controlsLocked && !needsRecovery && controller?.updater.canCheckForUpdates == true }
    var automatic: Bool { controller.updater.automaticallyChecksForUpdates && controller.updater.automaticallyDownloadsUpdates }
    var requiresTerminationHandoff: Bool { installationPending && !prepared }

    init(service: SMAppService, root: URL = PreviewPaths.root, build: String = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0") {
        self.service = service; self.root = root; self.build = build
        super.init()
        controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
    }
    func start() async {
        do {
            needsRecovery = FileManager.default.fileExists(atPath: UpdateRecovery.path(root: root).path)
            recovery = try UpdateRecovery.read(root: root)
            if recovery != nil { try await restore() }
            try startUpdater()
        } catch { fail(error) }
    }
    func check() { if canCheck { controller.checkForUpdates(nil) } }
    func setAutomatic(_ value: Bool) {
        controller.updater.automaticallyChecksForUpdates = value
        controller.updater.automaticallyDownloadsUpdates = value
        onChange?()
    }
    func retry() async {
        guard !busy else { return }
        do {
            if let unsavedIntent {
                try unsavedIntent.save(root: root)
                self.unsavedIntent = nil
            }
            recovery = try UpdateRecovery.read(root: root)
            guard recovery != nil else { throw ConfigurationError("No saved update recovery state was found. Inspect the Dispatch data folder before retrying.") }
            try await restore()
            try startUpdater()
        } catch { fail(error) }
    }
    private func fail(_ error: Error) {
        needsRecovery = needsRecovery || recovery != nil || installationPending
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
        let alreadyPending = installationPending
        installationPending = true
        if !alreadyPending {
            let value = UpdateRecovery(wasRunning: wasRunning(), targetBuild: item.versionString)
            unsavedIntent = value
            try value.save(root: root)
            recovery = value
            unsavedIntent = nil
            log("installation pending target=\(value.targetBuild) running=\(value.wasRunning)")
        }
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
        if prepared { return true }
        guard !busy else { return false }
        busy = true; onChange?()
        defer { busy = false; onChange?() }
        do {
            guard recovery != nil else { throw ConfigurationError("Update recovery state could not be saved. The update was stopped.") }
            try await stopService()
            prepared = true
            log("service stopped for installation")
            return true
        } catch { fail(error); return false }
    }
    private func install(_ item: SUAppcastItem, handler: @escaping () -> Void) {
        do { try retainIntent(item) }
        catch { fail(error); return }
        Task { if await prepareTermination() { handler() } }
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
                    var request = URLRequest(url: config.serverURL.appendingPathComponent("api/v1/health"))
                    request.timeoutInterval = 1; request.cachePolicy = .reloadIgnoringLocalCacheData
                    if let (data, response) = try? await URLSession.shared.data(for: request),
                       (response as? HTTPURLResponse)?.statusCode == 200,
                       let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        healthy = body["status"] as? String == "ok" && body["macInstanceId"] as? String == config.instanceID && body["updateOwner"] as? String == "macos-app"
                    }
                }
                if healthy {
                    if try recovery.confirm(root: root, installedBuild: build, request: command, runtime: runtime, healthy: healthy) { self.recovery = nil }
                    // If installation aborted, the old app is usable; retain intent for a later retry.
                    prepared = false; needsRecovery = false; installationPending = false
                    log("restored request=\(command.id) running=\(recovery.wasRunning) target=\(recovery.targetBuild) confirmed=\(self.recovery == nil)")
                    return
                }
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        try await stopService()
        log("recovery failed readiness; pending intent retained")
        throw ConfigurationError("The updated server could not start. Your settings and database are preserved. Resolve the problem in server.log, then choose Retry Update Recovery.")
    }
    func updater(_ updater: SPUUpdater, mayPerform updateCheck: SPUUpdateCheck) throws {
        if controlsLocked || needsRecovery { throw ConfigurationError("Finish update recovery before checking for another update.") }
    }
    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        do { try retainIntent(item) } catch { fail(error) }
    }
    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock handler: @escaping () -> Void) -> Bool {
        install(item, handler: handler); return true
    }
    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem, untilInvokingBlock handler: @escaping () -> Void) -> Bool {
        install(item, handler: handler); return true
    }
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        guard recovery != nil else { onChange?(); return }
        Task {
            while busy { try? await Task.sleep(for: .milliseconds(100)) }
            do { try await restore() } catch { fail(error) }
        }
    }
}
#endif
