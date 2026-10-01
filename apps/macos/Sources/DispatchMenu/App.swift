import AppKit
import DispatchCore
import ServiceManagement

@MainActor
final class MenuController: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var settings: SettingsWindowController?
    private var configuration = Configuration()
    private var configurationError: String?
    private var externalURL: URL?
    private var runtime: ServiceRuntime?
    private var legacyActiveConfiguration: Configuration?
    private var ready = false
    private var checking = false
    private var changingService = false
    private var validationServer: Process?
    private var status = "Checking…"
    #if SPARKLE_UPDATES
    private var appUpdater: AppUpdater?
    #endif
    /// A pre-release install is being moved to the release identity.
    private var migrating = false
    /// Blocks setup until a failed migration is retried, so it never creates a second database.
    private var migrationError: String?
    /// The pre-migration running state, replayed until the new service acknowledges it.
    private var pendingRestore: ServiceRequest?
    private var restoreSaved = Date.distantPast
    private var updateBusy: Bool {
        #if SPARKLE_UPDATES
        return appUpdater?.controlsLocked == true
        #else
        return false
        #endif
    }
    private var controlsLocked: Bool { migrating || migrationError != nil || updateBusy }
    private let service = SMAppService.agent(plistName: "dev.bradharris.dispatch.mac.server.plist")
    private var stopping: Bool { runtime?.phase == "stopping" }
    private var active: Bool { runtime?.isActive == true || ready }
    private var serverURL: URL { externalURL ?? runtime?.configuration?.serverURL ?? legacyActiveConfiguration?.serverURL ?? configuration.serverURL }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard ProcessInfo.processInfo.environment["DISPATCH_MENU_VALIDATION_URL"] == nil, AppPaths.testRoot == nil, LegacyMigration().pending else {
            finishLaunching(); return
        }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = dispatchStatusIcon()
        migrating = true; status = "Moving your data…"; rebuildMenu()
        Task {
            do {
                try requireInstalledApp()
                pendingRestore = try LegacyMigration().restoreRequest(wasRunning: try await LegacyInstall.migrate())
            } catch { migrationError = error.localizedDescription }
            migrating = false
            finishLaunching()
        }
    }
    private func finishLaunching() {
        do {
            if let value = ProcessInfo.processInfo.environment["DISPATCH_MENU_VALIDATION_URL"] { externalURL = try validationURL(value) }
            else if FileManager.default.fileExists(atPath: AppPaths.configuration.path) { configuration = try Configuration.read(from: AppPaths.configuration) }
        } catch { configurationError = error.localizedDescription }
        if let migrationError { configurationError = migrationError }
        if statusItem == nil {
            statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            statusItem.button?.image = dispatchStatusIcon()
        }
        rebuildMenu()
        refresh()
        if externalURL == nil && configuration.databaseURL.isEmpty && migrationError == nil { DispatchQueue.main.async { self.showSettings() } }
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in Task { @MainActor in self?.refresh() } }
        // Standard responder actions support copying/pasting in native settings fields.
        let main = NSMenu()
        let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        edit.submenu = NSMenu(title: "Edit")
        for (title, action, key) in [("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.submenu?.addItem(NSMenuItem(title: title, action: NSSelectorFromString(action), keyEquivalent: key))
        }
        main.addItem(edit)
        NSApp.mainMenu = main
        // Register an idle service once, so choosing login startup later only
        // changes a preference. It does not start a server on this launch; a migrated
        // pre-release install restores its previous state through `replayRestore`.
        // Save a migrated restore before registering, so the new supervisor's first loop sees it.
        replayRestore()
        if externalURL == nil && AppPaths.testRoot == nil && migrationError == nil && service.status.needsRegistration && !FileManager.default.fileExists(atPath: UpdateRecovery.path(root: AppPaths.root).path) {
            do {
                try requireInstalledApp()
                if pendingRestore == nil { try ServiceRequest(start: false).save() }
                try service.register()
            } catch { configurationError = error.localizedDescription }
        }
        #if SPARKLE_UPDATES
        if externalURL == nil && AppPaths.testRoot == nil {
            let updater = AppUpdater(service: service)
            updater.wasRunning = { [weak self] in self?.ready == true || (ServiceRuntime.read()?.isActive == true && ServiceRuntime.read()?.phase != "stopping") }
            updater.onChange = { [weak self] in self?.rebuildMenu() }
            updater.onError = { [weak self] message in self?.showError(message) }
            appUpdater = updater
            Task { await updater.start(); refresh() }
        }
        #endif
    }
    func menuWillOpen(_ menu: NSMenu) { rebuildMenuContents(menu); refresh() }
    private func item(_ title: String, _ action: Selector?, enabled: Bool = true) -> NSMenuItem {
        let result = NSMenuItem(title: title, action: action, keyEquivalent: "")
        result.target = self; result.isEnabled = enabled
        return result
    }
    private func rebuildMenu() {
        let menu = NSMenu(); menu.autoenablesItems = false; menu.delegate = self
        rebuildMenuContents(menu); statusItem.menu = menu; updateSettings()
    }
    private func rebuildMenuContents(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.addItem(item(status, nil, enabled: false))
        menu.addItem(item("Open Dispatch", #selector(openDispatch), enabled: ready))
        let address = item(serverURL.absoluteString, #selector(copyURL))
        address.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: "Copy URL")
        address.toolTip = "Copy address"
        menu.addItem(address)
        if externalURL == nil { menu.addItem(item(stopping ? "Stopping…" : active ? "Stop Server" : "Start Server", active ? #selector(stopServer) : #selector(startServer), enabled: !changingService && !stopping && !controlsLocked)) }
        menu.addItem(.separator())
        let settingsItem = item("Settings…", #selector(showSettings)); settingsItem.keyEquivalent = ","
        menu.addItem(settingsItem)
        #if SPARKLE_UPDATES
        if let updater = appUpdater {
            menu.addItem(item(updater.busy ? "Updating…" : "Check for Updates…", #selector(checkForUpdates), enabled: updater.canCheck))
            let automatic = item("Install Updates Automatically", #selector(toggleAutomaticUpdates), enabled: !controlsLocked)
            automatic.state = updater.automatic ? .on : .off
            menu.addItem(automatic)
            if updater.needsRecovery { menu.addItem(item("Retry Update Recovery", #selector(retryUpdate), enabled: !updater.busy)) }
        }
        #endif
        menu.addItem(item("Quit Dispatch", #selector(quit), enabled: !changingService && !migrating && !updateBusy))
    }
    private func refresh() {
        guard !checking, !migrating else { return }
        if externalURL == nil {
            if let saved = try? Configuration.read(from: AppPaths.configuration) { configuration = saved; configurationError = nil }
            runtime = ServiceRuntime.read()
            if runtime != nil { legacyActiveConfiguration = nil }
        }
        if let error = configurationError { status = error; ready = false; rebuildMenu(); return }
        if configuration.databaseURL.isEmpty && externalURL == nil { status = "Not configured"; ready = false; rebuildMenu(); return }
        checking = true
        let url = serverURL
        let checkedConfiguration = runtime?.configuration ?? legacyActiveConfiguration ?? configuration
        let expected = checkedConfiguration.instanceID
        Task {
            var healthy = false
            do {
                var request = URLRequest(url: url.appendingPathComponent("api/v1/health")); request.timeoutInterval = 1; request.cachePolicy = .reloadIgnoringLocalCacheData
                let (data, response) = try await URLSession.shared.data(for: request)
                let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                healthy = (response as? HTTPURLResponse)?.statusCode == 200 && body?["status"] as? String == "ok" && (externalURL != nil || (body?["macInstanceId"] as? String == expected && body?["updateOwner"] as? String == "macos-app"))
            } catch {}
            if healthy && runtime == nil { legacyActiveConfiguration = checkedConfiguration }
            ready = healthy; checking = false
            if runtime?.phase == "stopping" { status = "Stopping…" }
            else if healthy { status = "Running" }
            else if runtime?.isActive == true { status = "Starting…" }
            else if service.status == .requiresApproval { status = "Needs permission in System Settings" }
            else { status = "Stopped" }
            statusItem.button?.toolTip = "Dispatch — \(status)"
            replayRestore()
            rebuildMenu()
        }
    }
    @objc private func copyURL() {
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(serverURL.absoluteString, forType: .string)
    }
    @objc private func openDispatch() {
        guard ready else { return }
        if !NSWorkspace.shared.open(serverURL) { showError("Your default browser could not open Dispatch.") }
    }
    @objc private func showSettings() {
        if settings == nil {
            settings = SettingsWindowController(configuration: configuration)
            settings?.onLoginChange = { [weak self] in self?.toggleLogin() }
            settings?.onServerLoginChange = { [weak self] enabled in
                do { try StartupPreferences(startServerAtLogin: enabled).save() }
                catch { self?.showError(error.localizedDescription) }
                self?.updateSettings()
            }
            settings?.onSave = { [weak self] fields in self?.saveConfiguration(fields) }
            settings?.onApproval = { SMAppService.openSystemSettingsLoginItems() }
            settings?.onDataFolder = { NSWorkspace.shared.open(AppPaths.root) }
            settings?.onStartStop = { [weak self] in
                guard let self else { return }
                if self.active { self.stopServer() } else { self.startServer() }
            }
        }
        updateSettings(); settings?.showWindow(nil); NSApp.activate(ignoringOtherApps: true); settings?.window?.makeKeyAndOrderFront(nil)
    }
    private func updateSettings() {
        settings?.update(configuration: configuration, runningConfiguration: runtime?.configuration ?? legacyActiveConfiguration, displayURL: serverURL, canControlServer: externalURL == nil && !controlsLocked, canSave: externalURL == nil && !controlsLocked, status: status, active: active,
                         loginEnabled: SMAppService.mainApp.status == .enabled, canChangeLogin: externalURL == nil && AppPaths.testRoot == nil && !controlsLocked,
                         needsApproval: service.status == .requiresApproval, busy: changingService,
                         serverAtLogin: StartupPreferences.read().startServerAtLogin, stopping: stopping)
    }
    private func saveConfiguration(_ fields: SetupFields) {
        guard externalURL == nil, !changingService, !controlsLocked else { return }
        do {
            guard let port = Int(fields.port.stringValue) else { throw ConfigurationError("Enter a valid port number.") }
            var candidate: Configuration
            if fields.external.state == .on {
                candidate = Configuration(port: port, databaseURL: fields.database.stringValue.trimmingCharacters(in: .whitespacesAndNewlines), instanceID: configuration.instanceID)
            } else if let local = try? Configuration.read(from: AppPaths.root.appendingPathComponent("local-database.json")) {
                candidate = local; candidate.port = port; candidate.instanceID = configuration.instanceID
            } else {
                let database = LocalDatabase(binaries: Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/Postgres"))
                candidate = try database.configuration(port: port, instanceID: configuration.instanceID)
            }
            candidate.hosts = fields.selectedHosts
            try candidate.save(to: AppPaths.configuration)
            configuration = candidate; configurationError = nil
            settings?.didSave(candidate)
            refresh()
        } catch { showError(error.localizedDescription) }
    }
    private func requireInstalledApp() throws {
        if AppPaths.testRoot != nil { return }
        guard Bundle.main.bundleURL.path.hasPrefix("/Applications/") || Bundle.main.bundleURL.path.hasPrefix(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path + "/") else {
            throw ConfigurationError("Move Dispatch to Applications and open it there.")
        }
    }
    @objc private func startServer() {
        guard !changingService, !stopping, !controlsLocked, externalURL == nil else { return }
        if configuration.databaseURL.isEmpty { showSettings(); return }
        sendServiceCommand(start: true)
    }
    @objc private func stopServer() {
        guard !changingService, !stopping, !controlsLocked, externalURL == nil else { return }
        sendServiceCommand(start: false)
    }
    /// Re-saves the migrated running state until the supervisor takes it (requests expire
    /// after 60 seconds, and Login Items approval can take longer), then clears the
    /// migration once it is acknowledged and, for a running server, healthy.
    private func replayRestore() {
        guard let request = pendingRestore, migrationError == nil else { return }
        let runtime = ServiceRuntime.read()
        if runtime?.acknowledges(request) == true && (!request.start || ready) {
            LegacyMigration().complete(); pendingRestore = nil
        } else if runtime?.requestID != request.id && Date().timeIntervalSince(restoreSaved) > 30 {
            do { try request.refreshed().save(); restoreSaved = Date() }
            catch { configurationError = error.localizedDescription }
        }
    }
    private func sendServiceCommand(start: Bool) {
        // An explicit command supersedes the migrated running state.
        if pendingRestore != nil { LegacyMigration().complete(); pendingRestore = nil }
        changingService = true; rebuildMenu()
        Task {
            defer { changingService = false; refresh() }
            do {
                try requireInstalledApp()
                let command = ServiceRequest(start: start)
                try command.save()
                if let root = AppPaths.testRoot {
                    if validationServer?.isRunning != true {
                        let process = Process(); process.executableURL = roleExecutable("Dispatch Service")
                        process.arguments = ["--server", "--isolated-test", root.path]
                        try process.run(); validationServer = process
                    }
                } else if ServiceRuntime.read() == nil {
                    // Migrate an earlier service registration. Its running agents
                    // remain detached; only the owned API/database are stopped.
                    if service.status == .enabled { try await service.unregister() }
                    try service.register()
                    if service.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems(); return }
                }
                for _ in 0..<120 {
                    try await Task.sleep(nanoseconds: 250_000_000)
                    if ServiceRuntime.read()?.requestID == command.id { return }
                }
                throw ConfigurationError("The server did not respond. Check its log in the Dispatch data folder.")
            } catch { showError(error.localizedDescription) }
        }
    }
    @objc private func toggleLogin() {
        guard AppPaths.testRoot == nil, externalURL == nil, !changingService, !controlsLocked else { return }
        changingService = true; rebuildMenu()
        Task {
            defer { changingService = false; rebuildMenu() }
            do {
                if SMAppService.mainApp.status == .enabled { try await SMAppService.mainApp.unregister() }
                else { try SMAppService.mainApp.register() }
                if SMAppService.mainApp.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
            } catch { showError(error.localizedDescription) }
        }
    }
    @objc private func quit() {
        if let process = validationServer, process.isRunning { process.terminate(); process.waitUntilExit() }
        NSApp.terminate(nil)
    }
    #if SPARKLE_UPDATES
    @objc private func checkForUpdates() { appUpdater?.check() }
    @objc private func toggleAutomaticUpdates() {
        if let updater = appUpdater { updater.setAutomatic(!updater.automatic) }
    }
    @objc private func retryUpdate() { Task { await appUpdater?.retry(); refresh() } }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let updater = appUpdater, updater.requiresTerminationHandoff else { return .terminateNow }
        Task { NSApp.reply(toApplicationShouldTerminate: await updater.prepareTermination()) }
        return .terminateLater
    }
    #endif
    private func showError(_ message: String) {
        let alert = NSAlert(); alert.messageText = "Dispatch"; alert.informativeText = message; alert.alertStyle = .warning
        NSApp.activate(ignoringOtherApps: true); alert.runModal()
    }
}

@main
struct DispatchMenuApp {
    @MainActor static func main() {
        if let index = CommandLine.arguments.firstIndex(of: "--isolated-test") {
            do {
                guard CommandLine.arguments.indices.contains(index + 1) else { throw ConfigurationError("Missing isolated test directory.") }
                try AppPaths.enableIsolatedTest(root: CommandLine.arguments[index + 1])
            } catch { fputs("Dispatch: \(error.localizedDescription)\n", stderr); exit(1) }
        }
        if CommandLine.arguments.contains("--worker") {
            do { try runServer() }
            catch { fputs("Dispatch: \(error.localizedDescription)\n", stderr); exit(1) }
        } else if CommandLine.arguments.contains("--server") {
            do { try runServiceSupervisor() }
            catch { fputs("Dispatch: \(error.localizedDescription)\n", stderr); exit(1) }
        } else {
            #if SPARKLE_PROBE
            if Bundle.main.object(forInfoDictionaryKey: "DispatchSparkleProbeRoot") != nil {
                runSparkleProbe()
                return
            }
            #endif
            let app = NSApplication.shared
            let controller = MenuController()
            app.delegate = controller
            app.setActivationPolicy(.accessory)
            app.run()
        }
    }
}
