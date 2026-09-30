import AppKit
import DispatchCore

@MainActor
final class SettingsWindowController: NSWindowController {
    var onLoginChange: (() -> Void)?
    var onServerLoginChange: ((Bool) -> Void)?
    var onSave: ((SetupFields) -> Void)?
    var onApproval: (() -> Void)?
    var onDataFolder: (() -> Void)?
    var onStartStop: (() -> Void)?
    var copyText: (String) -> Void = { text in
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
    private let fields: SetupFields
    private var configuration: Configuration
    private var displayedDatabaseURL = ""
    private var displayedURL: URL
    private let login = NSButton(checkboxWithTitle: "Show Dispatch in the menu bar at login", target: nil, action: nil)
    private let serverLogin = NSButton(checkboxWithTitle: "Start server at login", target: nil, action: nil)
    private let statusLabel = NSTextField(labelWithString: "")
    private let urlField = NSTextField(string: "")
    private let startStop = NSButton(title: "Start Server", target: nil, action: nil)
    private let databaseDetails = NSTextField(wrappingLabelWithString: "")
    private let savedMessage = NSTextField(wrappingLabelWithString: "")
    private let approval = NSButton(title: "Allow in System Settings…", target: nil, action: nil)
    private var saveButtons: [NSButton] = []

    init(configuration: Configuration) {
        self.configuration = configuration; displayedURL = configuration.serverURL; fields = SetupFields(configuration: configuration)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 580, height: 620), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Dispatch Settings"; window.minSize = NSSize(width: 560, height: 480); window.isReleasedWhenClosed = false
        super.init(window: window)
        let tabs = NSTabView(); tabs.translatesAutoresizingMaskIntoConstraints = false
        window.contentView?.addSubview(tabs)
        if let content = window.contentView {
            NSLayoutConstraint.activate([tabs.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16), tabs.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16), tabs.topAnchor.constraint(equalTo: content.topAnchor, constant: 16), tabs.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16)])
        }
        login.target = self; login.action = #selector(changeLogin)
        serverLogin.target = self; serverLogin.action = #selector(changeServerLogin)
        urlField.isEditable = false; urlField.isSelectable = true; urlField.font = .systemFont(ofSize: 13)
        urlField.setAccessibilityLabel("Dispatch URL")
        let copyButton = NSButton(image: NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: "Copy URL")!, target: self, action: #selector(copyURL))
        copyButton.bezelStyle = .rounded; copyButton.toolTip = "Copy URL"
        let addressRow = row([urlField, copyButton]); urlField.widthAnchor.constraint(equalToConstant: 360).isActive = true
        startStop.target = self; startStop.action = #selector(toggleServer)
        approval.target = self; approval.action = #selector(allowService)
        savedMessage.textColor = .secondaryLabelColor; savedMessage.font = .systemFont(ofSize: 12)
        addTab("General", to: tabs, views: [
            card("Startup", [login, serverLogin]),
            card("Server", [row([statusLabel, startStop]), addressRow, approval, savedMessage]),
        ])
        addTab("Network", to: tabs, views: [card("Network", [fields.view, saveButton()])])
        databaseDetails.isSelectable = true; databaseDetails.font = .systemFont(ofSize: 12)
        addTab("Database", to: tabs, views: [
            card("Database", [databaseDetails, button("Copy Connection URL", #selector(copyDatabaseURL))]),
            card("Configuration", [fields.databaseView, saveButton()]),
        ])
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Development"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "local"
        let channel = Bundle.main.object(forInfoDictionaryKey: "DispatchUpdateChannel") as? String
        addTab("Support", to: tabs, views: [
            card("Dispatch", [heading("Version \(version)"), note("Build \(build)" + (channel.map { " · \($0)" } ?? ""))]),
            card("Dispatch Data", [note("Your database, sessions, settings, and logs."), pathLabel(PreviewPaths.root.path), row([button("Show in Finder", #selector(showData)), button("Copy Path", #selector(copyDataPath))])]),
        ])
        updateDetails(configuration)
        if configuration.databaseURL.isEmpty { tabs.selectTabViewItem(at: 1) }
        window.center()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    private func saveButton() -> NSButton {
        let save = button("Save", #selector(saveSettings)); saveButtons.append(save); return save
    }
    func didSave(_ configuration: Configuration) {
        self.configuration = configuration
        savedMessage.stringValue = "Settings saved."
    }
    func update(configuration: Configuration, runningConfiguration: Configuration?, displayURL: URL? = nil, canControlServer: Bool = true, canSave: Bool = true, status: String, active: Bool, loginEnabled: Bool, canChangeLogin: Bool, needsApproval: Bool, busy: Bool, serverAtLogin: Bool, stopping: Bool = false) {
        self.configuration = configuration
        updateDetails(runningConfiguration ?? configuration)
        displayedURL = displayURL ?? (runningConfiguration ?? configuration).serverURL
        urlField.stringValue = displayedURL.absoluteString
        statusLabel.stringValue = status
        statusLabel.textColor = status == "Running" ? .systemGreen : .secondaryLabelColor
        startStop.title = stopping ? "Stopping…" : active ? "Stop Server" : "Start Server"; startStop.isEnabled = canControlServer && !busy && !stopping
        login.state = loginEnabled ? .on : .off; login.isEnabled = canChangeLogin && !busy
        serverLogin.state = serverAtLogin ? .on : .off; serverLogin.isEnabled = canChangeLogin && !busy
        approval.isHidden = !needsApproval
        fields.setEnabled(canSave && !busy)
        for save in saveButtons { save.isEnabled = canSave && !busy }
        if let running = runningConfiguration, active && (running.port != configuration.port || running.bindHosts != configuration.bindHosts || running.databaseURL != configuration.databaseURL) {
            savedMessage.stringValue = "Saved changes will apply the next time you start the server."
        } else if active { savedMessage.stringValue = "" }
    }
    private func updateDetails(_ config: Configuration) {
        displayedDatabaseURL = config.databaseURL
        if let url = URLComponents(string: config.databaseURL), let host = url.host {
            databaseDetails.stringValue = "\(config.usesManagedDatabase ? "Managed by Dispatch" : "External PostgreSQL")\n\nHost: \(host)\nPort: \(url.port ?? 5432)\nDatabase: \(String(url.path.dropFirst()))\nUser: \(url.user ?? "")"
        } else { databaseDetails.stringValue = "A private database will be created when you start Dispatch." }
    }
    private func heading(_ title: String) -> NSTextField {
        let label = NSTextField(labelWithString: title)
        label.font = .boldSystemFont(ofSize: 14)
        return label
    }
    private func note(_ text: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.textColor = .secondaryLabelColor
        label.font = .systemFont(ofSize: 12)
        return label
    }
    private func pathLabel(_ text: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        label.isSelectable = true
        return label
    }
    private func button(_ title: String, _ action: Selector) -> NSButton { NSButton(title: title, target: self, action: action) }
    private func row(_ views: [NSView]) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.spacing = 8
        return stack
    }
    private func card(_ title: String, _ views: [NSView]) -> NSBox {
        let box = NSBox()
        box.title = ""
        box.boxType = .custom
        box.borderColor = .separatorColor
        box.borderWidth = 0.5
        box.cornerRadius = 8
        box.fillColor = .controlBackgroundColor
        let stack = NSStackView(views: [heading(title)] + views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        box.contentView = NSView()
        box.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: box.contentView!.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: box.contentView!.trailingAnchor, constant: -16),
            stack.topAnchor.constraint(equalTo: box.contentView!.topAnchor, constant: 14),
            stack.bottomAnchor.constraint(equalTo: box.contentView!.bottomAnchor, constant: -14),
        ])
        for view in views { view.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor).isActive = true }
        return box
    }
    private func addTab(_ title: String, to tabs: NSTabView, views: [NSView]) {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        let container = SettingsDocumentView()
        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)
        container.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = container
        NSLayoutConstraint.activate([
            container.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -20),
        ])
        for view in views { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        let tab = NSTabViewItem(identifier: title)
        tab.label = title
        tab.view = scroll
        tabs.addTabViewItem(tab)
    }
    private func copy(_ text: String) { copyText(text) }
    @objc private func changeLogin() { onLoginChange?() }
    @objc private func changeServerLogin() { onServerLoginChange?(serverLogin.state == .on) }
    @objc private func saveSettings() { onSave?(fields) }
    @objc private func toggleServer() { onStartStop?() }
    @objc private func allowService() { onApproval?() }
    @objc private func showData() { onDataFolder?() }
    @objc private func copyURL() { copy(displayedURL.absoluteString) }
    @objc private func copyDatabaseURL() { copy(displayedDatabaseURL) }
    @objc private func copyDataPath() { copy(PreviewPaths.root.path) }
}
private final class SettingsDocumentView: NSView { override var isFlipped: Bool { true } }
