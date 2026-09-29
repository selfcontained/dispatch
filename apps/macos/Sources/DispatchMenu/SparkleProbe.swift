#if SPARKLE_PROBE
import AppKit
import DispatchCore
import Sparkle
import ServiceManagement

private struct ProbeUpdateState: Codable {
    let wasRunning: Bool
    let targetBuild: String
}

/// Opt-in harness. Service mode requires a unique identity and explicit marker.
/// Neither mode uses the installed Dispatch service or user data.
@MainActor
private final class SparkleProbe: NSObject, NSApplicationDelegate, SPUUpdaterDelegate {
    private var updater: SPUStandardUpdaterController!
    private var supervisor: Process?
    private var terminationSignal: DispatchSourceSignal?
    private var stopping = false
    private var stopped = false
    private var restoreRequest: ServiceRequest?
    private var root: URL { PreviewPaths.root }
    private var build: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as! String }
    private var initialRunPreference: Bool { Bundle.main.object(forInfoDictionaryKey: "DispatchProbeRunning") as? Bool ?? true }
    private var service: SMAppService? {
        guard let label = Bundle.main.object(forInfoDictionaryKey: "DispatchProbeServiceLabel") as? String else { return nil }
        return SMAppService.agent(plistName: label + ".plist")
    }
    private var updateStatePath: URL { root.appendingPathComponent("probe-update-state.json") }
    private var shouldRun: Bool {
        if let data = try? Data(contentsOf: updateStatePath),
           let state = try? JSONDecoder().decode(ProbeUpdateState.self, from: data) {
            return state.wasRunning
        }
        return initialRunPreference
    }

    private func startOwnedService() async throws {
        let requestedStart = shouldRun
        if let service {
            if service.status == .notRegistered { try service.register() }
            if service.status == .requiresApproval {
                event("approval-required")
                SMAppService.openSystemSettingsLoginItems()
            }
            for _ in 0..<300 {
                if service.status == .enabled { break }
                try await Task.sleep(nanoseconds: 1_000_000_000)
            }
            guard service.status == .enabled else { throw ConfigurationError("Approve the isolated Sparkle test background item, then retry.") }
            let request = ServiceRequest(start: requestedStart)
            restoreRequest = request
            try request.save()
            event("restore-requested", request.id.uuidString)
            event("service-registered", Bundle.main.object(forInfoDictionaryKey: "DispatchProbeServiceLabel") as! String)
        } else {
            let request = ServiceRequest(start: requestedStart)
            restoreRequest = request
            try request.save()
            event("restore-requested", request.id.uuidString)
            let process = Process(); process.executableURL = Bundle.main.executableURL
            process.arguments = ["--server", "--isolated-test", root.path]
            try process.run(); supervisor = process
            event("supervisor-started", String(process.processIdentifier))
        }
        stopped = false
    }

    func event(_ name: String, _ details: String = "") {
        let record: [String: Any] = ["event": name, "build": build, "pid": ProcessInfo.processInfo.processIdentifier, "details": details, "time": Date().timeIntervalSince1970]
        guard let data = try? JSONSerialization.data(withJSONObject: record) else { return }
        let path = root.appendingPathComponent("sparkle-events.jsonl")
        if !FileManager.default.fileExists(atPath: path.path) { FileManager.default.createFile(atPath: path.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        if let file = try? FileHandle(forWritingTo: path) { defer { try? file.close() }; _ = try? file.seekToEnd(); try? file.write(contentsOf: data + Data([10])) }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler { NSApp.terminate(nil) }; source.resume(); terminationSignal = source
        Task {
            do {
                if CommandLine.arguments.contains("--probe-cleanup") {
                    if await stopOwnedService() { NSApp.terminate(nil) }
                    return
                }
                let port = Bundle.main.object(forInfoDictionaryKey: "DispatchProbePort") as! Int
                if !FileManager.default.fileExists(atPath: PreviewPaths.configuration.path) {
                    let database = LocalDatabase(binaries: Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/Postgres"))
                    let config = try database.configuration(port: port, instanceID: UUID().uuidString)
                    try config.save(to: PreviewPaths.configuration)
                    try StartupPreferences(startServerAtLogin: initialRunPreference).save()
                }
                try await startOwnedService()
                let config = try Configuration.read(from: PreviewPaths.configuration)
                var ready = false
                for _ in 0..<600 {
                    if let restoreRequest, ServiceRuntime.read()?.acknowledges(restoreRequest) == true {
                        if restoreRequest.start {
                            var request = URLRequest(url: config.serverURL.appendingPathComponent("api/v1/health")); request.timeoutInterval = 1
                            if let (data, _) = try? await URLSession.shared.data(for: request),
                               let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                               body["macInstanceId"] as? String == config.instanceID, body["status"] as? String == "ok" { ready = true; break }
                        } else { ready = true; break }
                    }
                    try await Task.sleep(nanoseconds: 100_000_000)
                }
                guard ready else { throw ConfigurationError("Probe service failed readiness") }
                event("restore-acknowledged", restoreRequest!.id.uuidString)
                event("ready", shouldRun ? "running" : "stopped")
                if let data = try? Data(contentsOf: updateStatePath),
                   let state = try? JSONDecoder().decode(ProbeUpdateState.self, from: data), state.targetBuild == build {
                    try FileManager.default.removeItem(at: updateStatePath)
                    event("upgrade-confirmed")
                }
                updater = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
                try updater.updater.start()
                if build == "1" {
                    while !FileManager.default.fileExists(atPath: root.appendingPathComponent("begin-update").path) { try await Task.sleep(nanoseconds: 100_000_000) }
                    event("checking")
                    updater.updater.checkForUpdatesInBackground()
                }
            } catch { event("error", error.localizedDescription); NSApp.terminate(nil) }
        }
    }

    private func stopOwnedService() async -> Bool {
        if stopped { return true }
        if stopping { return false }
        stopping = true
        defer { stopping = false }
        event("stopping-supervisor")
        if let service {
            do {
                if service.status != .notRegistered { try await service.unregister() }
                event("service-unregistered")
                var clean = false
                for _ in 0..<550 {
                    let databaseStopped = !FileManager.default.fileExists(atPath: root.appendingPathComponent("postgres/postmaster.pid").path)
                    if databaseStopped && (ServiceRuntime.read()?.phase == "stopped" || ServiceRuntime.read() == nil) { clean = true; break }
                    try await Task.sleep(nanoseconds: 100_000_000)
                }
                guard clean else { throw ConfigurationError("Service did not stop before the deadline") }
            } catch { event("error", error.localizedDescription); return false }
        }
        if let process = supervisor, process.isRunning {
            process.terminate()
            for _ in 0..<550 {
                if !process.isRunning { break }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            guard !process.isRunning else { event("error", "Supervisor exceeded stop deadline; cancelling termination"); return false }
            process.waitUntilExit()
        }
        stopped = true
        event("supervisor-stopped", FileManager.default.fileExists(atPath: root.appendingPathComponent("postgres/postmaster.pid").path) ? "database-still-running" : "database-stopped")
        return true
    }

    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock handler: @escaping () -> Void) -> Bool {
        event("update-downloaded", item.versionString)
        Task {
            do {
                let phase = ServiceRuntime.read()?.phase
                let state = ProbeUpdateState(wasRunning: phase == "running" || phase == "starting", targetBuild: item.versionString)
                try writePrivateJSON(state, to: updateStatePath)
                if await stopOwnedService() { event("installing"); handler() }
            } catch { event("error", error.localizedDescription) }
        }
        return true
    }
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        event("update-aborted", String(describing: error))
        if stopped {
            Task {
                do { try await startOwnedService(); event("service-restored-after-abort") }
                catch { event("error", error.localizedDescription) }
            }
        }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if stopped { return .terminateNow }
        Task { if await stopOwnedService() { NSApp.terminate(nil) } }
        return .terminateCancel
    }
}

@MainActor
func runSparkleProbe() {
    do {
        guard let path = Bundle.main.object(forInfoDictionaryKey: "DispatchSparkleProbeRoot") as? String,
              Bundle.main.bundleIdentifier?.hasPrefix("dev.bradharris.dispatch.sparkleprobe.") == true else { throw ConfigurationError("Invalid probe identity") }
        try PreviewPaths.enableIsolatedTest(root: path)
        if let label = Bundle.main.object(forInfoDictionaryKey: "DispatchProbeServiceLabel") as? String {
            let identity = Bundle.main.bundleIdentifier!
            let marker = PreviewPaths.root.appendingPathComponent("service-proof-approved")
            guard label == identity + ".server",
                  Bundle.main.bundleURL.path.hasPrefix("/Applications/Dispatch Sparkle Proof"),
                  (try? String(contentsOf: marker, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)) == identity else {
                throw ConfigurationError("Service proof requires an explicitly approved isolated test installation.")
            }
        }
        try FileManager.default.createDirectory(at: PreviewPaths.root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let app = NSApplication.shared
        let delegate = SparkleProbe()
        app.delegate = delegate; app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { app.run() }
    } catch { fputs("Sparkle probe: \(error.localizedDescription)\n", stderr); exit(1) }
}
#endif
