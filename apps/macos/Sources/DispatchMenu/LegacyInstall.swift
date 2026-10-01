import AppKit
import DispatchCore

/// The pre-release app used another bundle identifier, so Sparkle cannot update it in place
/// and this app cannot unregister its service through SMAppService. Quit it, boot out its
/// LaunchAgent, then hand the data over to `LegacyMigration`.
enum LegacyInstall {
    static let bundleIdentifier = "dev.bradharris.dispatch.preview"
    static let serviceLabel = "dev.bradharris.dispatch.preview.server"

    /// Returns whether the old server was running.
    @MainActor static func migrate() async throws -> Bool {
        let migration = LegacyMigration()
        let runtime = ServiceRuntime.read(root: migration.legacy)
        let wasRunning = runtime?.isActive == true && runtime?.phase != "stopping"
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
        apps.forEach { $0.terminate() }
        for _ in 0..<50 where apps.contains(where: { !$0.isTerminated }) { try await Task.sleep(for: .milliseconds(100)) }
        apps.filter { !$0.isTerminated }.forEach { $0.forceTerminate() }
        let binaries = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/Postgres")
        return try await Task.detached {
            try migration.run(wasRunning: wasRunning, stopService: stopService,
                              renameDatabase: { try LocalDatabase(root: $0, binaries: binaries).migrateLegacyRole() })
        }.value
    }

    /// The supervisor stops its worker and database on SIGTERM; agent hosts are detached.
    private static func stopService(root: URL) throws {
        let launchctl = Process()
        launchctl.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        launchctl.arguments = ["bootout", "gui/\(getuid())/\(serviceLabel)"]
        launchctl.standardOutput = FileHandle.nullDevice
        launchctl.standardError = FileHandle.nullDevice
        try launchctl.run()
        launchctl.waitUntilExit() // Fails harmlessly when the service is not loaded.
        let deadline = Date(timeIntervalSinceNow: 70)
        while Date() < deadline {
            if LegacyMigration.serviceStopped(root: root) { return }
            Thread.sleep(forTimeInterval: 0.1)
        }
        throw ConfigurationError("Dispatch could not stop the previous version's server to move your data. Nothing was changed. Quit and reopen Dispatch to try again.")
    }
}
