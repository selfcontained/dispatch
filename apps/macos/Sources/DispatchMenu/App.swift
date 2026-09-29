import AppKit
import DispatchCore
import ServiceManagement

@MainActor
final class MenuController: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var configuration = Configuration()
    private var configurationError: String?
    private var externalURL: URL?
    private var ready = false
    private var openWhenReady = false
    private var checking = false
    private var changingService = false
    private var validationServer: Process?
    private var registered: Bool {
        PreviewPaths.testRoot != nil ? validationServer?.isRunning == true : service.status == .enabled || service.status == .requiresApproval
    }
    private var status = "Checking server…"
    private let service = SMAppService.agent(plistName: "dev.bradharris.dispatch.preview.server.plist")
    private let preferences = UserDefaults.standard
    private var browserID: String? { preferences.string(forKey: "browserBundleIdentifier") }
    private var serverURL: URL { externalURL ?? configuration.serverURL }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            if let value = ProcessInfo.processInfo.environment["DISPATCH_MENU_VALIDATION_URL"] {
                externalURL = try validationURL(value)
            } else if FileManager.default.fileExists(atPath: PreviewPaths.configuration.path) {
                configuration = try Configuration.read(from: PreviewPaths.configuration)
            }
        } catch {
            configurationError = error.localizedDescription
        }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(systemSymbolName: "arrow.triangle.branch", accessibilityDescription: "Dispatch Preview")
        statusItem.button?.toolTip = "Dispatch Preview"
        rebuildMenu()
        refresh()
        if externalURL == nil && configuration.databaseURL.isEmpty && configurationError == nil {
            DispatchQueue.main.async { self.configure() }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func menuWillOpen(_ menu: NSMenu) { rebuildMenuContents(menu); refresh() }

    private func item(_ title: String, _ action: Selector?, enabled: Bool = true) -> NSMenuItem {
        let result = NSMenuItem(title: title, action: action, keyEquivalent: "")
        result.target = self
        result.isEnabled = enabled
        return result
    }

    private func rebuildMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = self
        rebuildMenuContents(menu)
        statusItem.menu = menu
    }

    private func rebuildMenuContents(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.addItem(item("Dispatch Preview", nil, enabled: false))
        menu.addItem(item(status, nil, enabled: false))
        menu.addItem(.separator())
        menu.addItem(item("Open Dispatch", #selector(openDispatch), enabled: ready))
        let browsers = item("Open in Browser", nil)
        let browserMenu = NSMenu()
        browserMenu.autoenablesItems = false
        let system = item("System Default", #selector(selectBrowser))
        system.state = browserID == nil ? .on : .off
        browserMenu.addItem(system)
        browserMenu.addItem(.separator())
        var foundSelected = browserID == nil
        var seen = Set<String>()
        for url in NSWorkspace.shared.urlsForApplications(toOpen: URL(string: "https://example.com")!).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            guard let id = Bundle(url: url)?.bundleIdentifier, seen.insert(id).inserted else { continue }
            let browser = item(url.deletingPathExtension().lastPathComponent, #selector(selectBrowser))
            browser.representedObject = id
            browser.state = browserID == id ? .on : .off
            foundSelected = foundSelected || browserID == id
            browserMenu.addItem(browser)
        }
        if !foundSelected { browserMenu.addItem(item("Selected browser is unavailable", nil, enabled: false)) }
        browsers.submenu = browserMenu
        menu.addItem(browsers)
        menu.addItem(.separator())
        if externalURL == nil {
            menu.addItem(item("Set Up Preview…", #selector(configure), enabled: !changingService))
            menu.addItem(item("Start Server", #selector(startServer), enabled: !registered && !changingService))
            menu.addItem(item("Stop Server…", #selector(stopServer), enabled: registered && !changingService))
            if service.status == .requiresApproval {
                menu.addItem(item("Allow Background Service…", #selector(openLoginSettings)))
            }
            let login = item("Open Menu at Login", #selector(toggleLogin), enabled: PreviewPaths.testRoot == nil)
            login.state = SMAppService.mainApp.status == .enabled ? .on : .off
            menu.addItem(login)
            menu.addItem(item("Show Server Log", #selector(showLog)))
            menu.addItem(item("Show Data Folder", #selector(showDataFolder)))
        } else {
            menu.addItem(item("Connected to development server", nil, enabled: false))
        }
        menu.addItem(item("About This Preview…", #selector(about)))
        menu.addItem(.separator())
        menu.addItem(item("Quit Menu (Keep Server Running)", #selector(quit), enabled: !changingService))
    }

    private func refresh() {
        guard !checking, !changingService else { return }
        if let error = configurationError {
            ready = false
            status = "Configuration needs attention"
            statusItem.button?.toolTip = error
            rebuildMenu()
            return
        }
        if externalURL == nil && configuration.databaseURL.isEmpty {
            ready = false
            status = "Setup required — Set Up Preview…"
            rebuildMenu()
            return
        }
        checking = true
        let endpoint = serverURL.appendingPathComponent("api/v1/health")
        let expectedInstance = configuration.instanceID
        let isExternal = externalURL != nil
        Task {
            var healthy = false
            var wrongInstance = false
            do {
                var request = URLRequest(url: endpoint)
                request.timeoutInterval = 2
                request.cachePolicy = .reloadIgnoringLocalCacheData
                let (data, response) = try await URLSession.shared.data(for: request)
                let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                let matches = isExternal || (body?["macInstanceId"] as? String == expectedInstance && body?["updateOwner"] as? String == "macos-app")
                healthy = (response as? HTTPURLResponse)?.statusCode == 200 && body?["status"] as? String == "ok" && matches
                wrongInstance = !matches
            } catch { /* The service may still be starting, or deliberately stopped. */ }
            ready = healthy
            checking = false
            if healthy { status = "Running · \(serverURL.host!):\(serverURL.port!)" }
            else if wrongInstance { status = "Port is used by another server" }
            else if externalURL != nil { status = "Development server unavailable" }
            else if service.status == .requiresApproval { status = "Background service needs approval" }
            else if service.status == .enabled { status = "Server not ready — check log" }
            else { status = "Server stopped" }
            statusItem.button?.toolTip = "Dispatch Preview — \(status)"
            rebuildMenu()
            if healthy && openWhenReady { openWhenReady = false; openDispatch() }
        }
    }

    @objc private func selectBrowser(_ sender: NSMenuItem) {
        if let id = sender.representedObject as? String { preferences.set(id, forKey: "browserBundleIdentifier") }
        else { preferences.removeObject(forKey: "browserBundleIdentifier") }
        rebuildMenu()
    }

    @objc private func openDispatch() {
        guard ready else { return }
        guard let id = browserID else {
            if !NSWorkspace.shared.open(serverURL) { showError("The system browser could not open Dispatch.") }
            return
        }
        guard let application = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) else {
            showError("Your selected browser is no longer installed. Choose another browser in Open in Browser.")
            return
        }
        NSWorkspace.shared.open([serverURL], withApplicationAt: application, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if let error { Task { @MainActor in self.showError(error.localizedDescription) } }
        }
    }

    @objc private func configure() {
        guard externalURL == nil, !changingService else { return }
        guard !registered else {
            showError("Stop the preview server before changing its configuration.")
            return
        }
        let alert = NSAlert()
        alert.messageText = "Set up Dispatch Preview"
        alert.informativeText = "Dispatch will create a private local database for you. No database installation or connection details are needed. Your regular Dispatch data stays separate."
        alert.addButton(withTitle: "Start Dispatch")
        alert.addButton(withTitle: "Cancel")
        let fields = SetupFields(configuration: configuration)
        alert.accessoryView = fields.view
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        do {
            try requireInstalledApp()
            guard let number = Int(fields.port.stringValue), (1024...65535).contains(number), number != 6767 else {
                throw ConfigurationError("Choose a server port between 1024 and 65535 other than 6767.")
            }
            if fields.external.state == .on {
                let candidate = Configuration(port: number, databaseURL: fields.database.stringValue.trimmingCharacters(in: .whitespacesAndNewlines), instanceID: configuration.instanceID)
                try candidate.save(to: PreviewPaths.configuration)
                configuration = candidate
                configurationError = nil
                openWhenReady = true
                startServer()
                return
            }
            changingService = true
            ready = false
            status = "Setting up local database…"
            rebuildMenu()
            let progress = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 120), styleMask: [.titled], backing: .buffered, defer: false)
            progress.isReleasedWhenClosed = false
            progress.title = "Setting up Dispatch"
            let label = NSTextField(labelWithString: "Creating your private local database…")
            label.frame = NSRect(x: 24, y: 64, width: 380, height: 24)
            let spinner = NSProgressIndicator(frame: NSRect(x: 24, y: 28, width: 372, height: 16))
            spinner.style = .bar
            spinner.isIndeterminate = true
            spinner.startAnimation(nil)
            progress.contentView?.addSubview(label)
            progress.contentView?.addSubview(spinner)
            progress.center()
            progress.makeKeyAndOrderFront(nil)
            let instance = configuration.instanceID
            let bundle = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/Postgres")
            Task {
                do {
                    let candidate = try await Task.detached {
                        let database = LocalDatabase(binaries: bundle)
                        let candidate = try database.configuration(port: number, instanceID: instance)
                        try database.start(candidate)
                        try database.stop()
                        try candidate.save(to: PreviewPaths.configuration)
                        return candidate
                    }.value
                    configuration = candidate
                    configurationError = nil
                    changingService = false
                    progress.close()
                    openWhenReady = true
                    startServer()
                } catch {
                    changingService = false
                    progress.close()
                    refresh()
                    showError(error.localizedDescription)
                }
            }
        } catch { showError(error.localizedDescription) }
    }

    private func requireInstalledApp() throws {
        if PreviewPaths.testRoot != nil { return }
        guard Bundle.main.bundleURL.path.hasPrefix("/Applications/") || Bundle.main.bundleURL.path.hasPrefix(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path + "/") else {
            throw ConfigurationError("Move Dispatch Preview to Applications, open it there, and choose Set Up Preview to continue.")
        }
    }

    @objc private func startServer() {
        guard externalURL == nil, !changingService else { return }
        if configuration.databaseURL.isEmpty { configure(); return }
        do {
            configuration = try Configuration.read(from: PreviewPaths.configuration)
            try requireInstalledApp()
            if let root = PreviewPaths.testRoot {
                let process = Process()
                process.executableURL = Bundle.main.executableURL
                process.arguments = ["--server", "--isolated-test", root.path]
                try process.run()
                validationServer = process
            } else {
                try service.register()
            }
            configurationError = nil
            refresh()
        } catch { showError(error.localizedDescription) }
    }

    @objc private func stopServer() {
        guard externalURL == nil, !changingService else { return }
        let alert = NSAlert()
        alert.messageText = "Stop the Dispatch preview server?"
        alert.informativeText = "The browser will disconnect. " + (configuration.usesManagedDatabase ? "The private local database will stop too. " : "") + "Running agent hosts remain alive, but tools that need the server may fail until you start it again. The server will also stop launching at login."
        alert.addButton(withTitle: "Stop Server")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        changingService = true
        rebuildMenu()
        Task {
            do {
                if let process = validationServer {
                    if process.isRunning { process.terminate() }
                    await Task.detached { process.waitUntilExit() }.value
                    validationServer = nil
                } else { try await service.unregister() }
            }
            catch { showError(error.localizedDescription) }
            changingService = false
            refresh()
        }
    }

    @objc private func toggleLogin() {
        guard externalURL == nil, PreviewPaths.testRoot == nil else { return }
        Task {
            do {
                if SMAppService.mainApp.status == .enabled { try await SMAppService.mainApp.unregister() }
                else { try SMAppService.mainApp.register() }
                if SMAppService.mainApp.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
                rebuildMenu()
            } catch { showError(error.localizedDescription) }
        }
    }

    @objc private func openLoginSettings() { SMAppService.openSystemSettingsLoginItems() }
    @objc private func showDataFolder() { NSWorkspace.shared.open(PreviewPaths.root) }
    @objc private func showLog() {
        if FileManager.default.fileExists(atPath: PreviewPaths.log.path) {
            NSWorkspace.shared.activateFileViewerSelecting([PreviewPaths.log])
        } else { showError("No server log yet. Configure and start the preview server first.") }
    }
    @objc private func about() {
        let alert = NSAlert()
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "development"
        alert.messageText = "Dispatch Preview \(version)"
        alert.informativeText = "A menu bar home for Dispatch. Open Dispatch uses your chosen browser.\n\nUpdates are manual in this preview. Before replacing the app, finish active agents and stop the server. Sparkle updates and migration from an existing service are planned separately.\n\nQuitting this menu leaves the background server running."
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
    @objc private func quit() {
        if let process = validationServer, process.isRunning { process.terminate(); process.waitUntilExit() }
        NSApp.terminate(nil)
    }
    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Dispatch Preview"
        alert.informativeText = message
        alert.alertStyle = .warning
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}


@MainActor
final class SetupFields: NSObject {
    let view = NSStackView()
    let port: NSTextField
    let database: NSSecureTextField
    let external = NSButton(checkboxWithTitle: "Use an existing database (advanced)", target: nil, action: nil)
    private let databaseLabel = NSTextField(labelWithString: "Dedicated PostgreSQL connection URL")
    private let hint = NSTextField(wrappingLabelWithString: "Your database is stored privately on this Mac and kept when you quit or update the app.")

    init(configuration: Configuration) {
        port = NSTextField(string: String(configuration.port))
        database = NSSecureTextField(string: configuration.usesManagedDatabase ? "" : configuration.databaseURL)
        super.init()
        external.state = !configuration.databaseURL.isEmpty && !configuration.usesManagedDatabase ? .on : .off
        external.target = self
        external.action = #selector(toggle)
        port.setAccessibilityLabel("Server port")
        database.setAccessibilityLabel("PostgreSQL connection URL")
        database.placeholderString = "postgres://user:password@localhost/dispatch_preview"
        view.orientation = .vertical
        view.alignment = .leading
        view.spacing = 8
        for field in [hint, NSTextField(labelWithString: "Server port"), port, external, databaseLabel, database] {
            view.addArrangedSubview(field)
            field.widthAnchor.constraint(equalToConstant: 430).isActive = true
        }
        view.frame = NSRect(x: 0, y: 0, width: 430, height: 200)
        toggle()
    }

    @objc private func toggle() {
        let advanced = external.state == .on
        database.isHidden = !advanced
        databaseLabel.isHidden = !advanced
        hint.stringValue = advanced
            ? "Use a dedicated preview database. Dispatch will run migrations there; do not use your regular Dispatch database."
            : "Your database is stored privately on this Mac and kept when you quit or update the app."
    }
}

@main
struct DispatchMenuApp {
    @MainActor static func main() {
        if let index = CommandLine.arguments.firstIndex(of: "--isolated-test") {
            do {
                guard CommandLine.arguments.indices.contains(index + 1) else { throw ConfigurationError("Missing isolated test directory.") }
                try PreviewPaths.enableIsolatedTest(root: CommandLine.arguments[index + 1])
            } catch { fputs("Dispatch Preview: \(error.localizedDescription)\n", stderr); exit(1) }
        }
        if CommandLine.arguments.contains("--server") {
            do { try runServer() }
            catch { fputs("Dispatch Preview: \(error.localizedDescription)\n", stderr); exit(1) }
        } else {
            let app = NSApplication.shared
            let controller = MenuController()
            app.delegate = controller
            app.setActivationPolicy(.accessory)
            app.run()
        }
    }
}
