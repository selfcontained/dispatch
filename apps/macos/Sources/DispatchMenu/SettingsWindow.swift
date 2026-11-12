import AppKit
import DispatchCore
import CryptoKit

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
    private let tabs = NSTabViewController()
    private let login = NSSwitch()
    private let serverLogin = NSSwitch()
    private let statusDot = NSImageView()
    private let statusLabel = NSTextField(wrappingLabelWithString: "")
    private let urlField = NSTextField(wrappingLabelWithString: "")
    private let startStop = NSButton(title: "Start Server", target: nil, action: nil)
    private let approvalRow = NSStackView()
    private let approval = NSButton(title: "Allow in System Settings…", target: nil, action: nil)
    /// Save/apply feedback, shown beside the server status and beside each Save button.
    private let savedMessage = FeedbackLabel()
    private var saveFeedback: [FeedbackLabel] = []
    private let databaseKind = Form.value()
    private var databaseRows: [NSView] = []
    private var databaseValues: [NSTextField] = []
    private let databaseEmpty = Form.note("A private database is created when Dispatch first starts.")
    private let channel = NSPopUpButton(frame: .zero, pullsDown: false)
    var updateChannels: (get: () -> UpdateChannel, set: (UpdateChannel) -> Void) = (get: { UpdateChannel.current() }, set: { $0.save() })
    private var saveButtons: [NSButton] = []
    private let certificateStatus = Form.value()
    private let certificateDetails = Form.value()
    private let fingerprintToggle = NSButton(title: "Show", target: nil, action: nil)
    private var fingerprintRow: NSView?
    private var trustButtons: [NSButton] = []

    init(configuration: Configuration) {
        self.configuration = configuration; displayedURL = configuration.serverURL; fields = SetupFields(configuration: configuration)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 560), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Dispatch Settings"; window.isReleasedWhenClosed = false
        window.toolbarStyle = .preference
        window.autorecalculatesKeyViewLoop = true
        super.init(window: window)
        tabs.tabStyle = .toolbar
        tabs.transitionOptions = []
        tabs.canPropagateSelectedChildViewControllerTitle = false
        addSection("General", symbol: "gearshape", generalPage())
        addSection("Network", symbol: "network", networkPage())
        addSection("Database", symbol: "cylinder.split.1x2", databasePage())
        addSection("About", symbol: "info.circle", aboutPage())
        window.contentViewController = tabs
        window.title = "Dispatch Settings"
        window.setContentSize(NSSize(width: 600, height: 560))
        window.contentMinSize = NSSize(width: 520, height: 420)
        updateDetails(configuration)
        refreshChannel()
        if configuration.databaseURL.isEmpty { selectSection(named: "Network") }
        window.center()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    // MARK: Sections

    var sectionCount: Int { tabs.tabViewItems.count }
    func sectionTitle(at index: Int) -> String { tabs.tabViewItems[index].label }
    func selectSection(at index: Int) { tabs.selectedTabViewItemIndex = index }
    func selectSection(named title: String) {
        if let index = tabs.tabViewItems.firstIndex(where: { $0.label == title }) { selectSection(at: index) }
    }
    var selectedSectionTitle: String? { tabs.tabViewItems.indices.contains(tabs.selectedTabViewItemIndex) ? tabs.tabViewItems[tabs.selectedTabViewItemIndex].label : nil }

    private func addSection(_ title: String, symbol: String, _ page: NSView) {
        let controller = NSViewController(); controller.view = page
        let item = NSTabViewItem(viewController: controller)
        item.label = title; item.identifier = title
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
        tabs.addTabViewItem(item)
    }

    private func generalPage() -> NSView {
        statusDot.image = NSImage(systemSymbolName: "circle.fill", accessibilityDescription: nil)
        statusDot.symbolConfiguration = .init(pointSize: 8, weight: .regular)
        statusDot.setAccessibilityElement(false)
        statusLabel.textColor = .secondaryLabelColor
        startStop.target = self; startStop.action = #selector(toggleServer)
        startStop.setContentCompressionResistancePriority(.required, for: .horizontal)
        let identity = Form.vstack([Form.title("Dispatch", size: 15), Form.hstack([statusDot, statusLabel], spacing: 5)], spacing: 2)
        identity.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        statusLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let header = Form.hstack([Brand.iconView(size: 40), identity, Form.spacer(), startStop], spacing: 12)
        let copyButton = NSButton(image: NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: "Copy URL")!, target: self, action: #selector(copyURL))
        copyButton.bezelStyle = .inline; copyButton.isBordered = false; copyButton.toolTip = "Copy URL"
        urlField.isSelectable = true
        // Login Items approval is OS-owned; this only routes the user there.
        let warning = NSImageView(image: NSImage(systemSymbolName: "exclamationmark.triangle.fill", accessibilityDescription: "Needs attention")!)
        warning.contentTintColor = .systemOrange
        let approvalText = NSTextField(labelWithString: "Allow in Login Items to run the server.")
        approvalText.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        approvalText.lineBreakMode = .byTruncatingTail
        approval.target = self; approval.action = #selector(allowService)
        approval.setContentCompressionResistancePriority(.required, for: .horizontal)
        approvalRow.setViews([warning, approvalText, Form.spacer(), approval], in: .leading)
        approvalRow.orientation = .horizontal; approvalRow.spacing = 6; approvalRow.alignment = .centerY
        login.target = self; login.action = #selector(changeLogin)
        serverLogin.target = self; serverLogin.action = #selector(changeServerLogin)
        return Form.page([
            Form.section(nil, [header, Form.valueRow("Address", urlField, copyButton), approvalRow], footerLabel: savedMessage),
            Form.section("Startup", [Form.row("Show in menu bar at login", login), Form.row("Start server at login", serverLogin)]),
        ])
    }

    private func networkPage() -> NSView {
        certificateDetails.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        certificateDetails.textColor = .secondaryLabelColor
        certificateDetails.isHidden = true
        fingerprintToggle.bezelStyle = .inline; fingerprintToggle.controlSize = .small
        fingerprintToggle.target = self; fingerprintToggle.action = #selector(toggleFingerprint)
        fingerprintToggle.setAccessibilityLabel("Show certificate fingerprint")
        let fingerprint = Form.vstack([Form.row("Fingerprint", fingerprintToggle), certificateDetails], spacing: 6)
        fingerprint.arrangedSubviews.forEach { $0.widthAnchor.constraint(equalTo: fingerprint.widthAnchor).isActive = true }
        fingerprintRow = fingerprint
        trustButtons = [button("Export Apple Trust Profile…", #selector(exportProfile)), button("Export CA Certificate…", #selector(exportCertificate)), button("Trust Instructions…", #selector(openTrustInstructions))]
        let trustActions = Form.vstack([Form.actions(Array(trustButtons.prefix(2))), Form.actions([trustButtons[2]])], spacing: 8)
        trustActions.arrangedSubviews.forEach { $0.widthAnchor.constraint(equalTo: trustActions.widthAnchor).isActive = true }
        return Form.page([
            Form.section("Addresses", [fields.view, fields.portRow, saveRow()], footer: "Other devices need an address on your network."),
            Form.section("HTTPS Certificate", [Form.valueRow("Local CA", certificateStatus), fingerprint, trustActions],
                         footer: "Trust the CA once per device. It survives address changes and renewals."),
        ])
    }

    private func databasePage() -> NSView {
        databaseRows = [Form.valueRow("Type", databaseKind)]
        for title in ["Host", "Port", "Database", "User"] {
            let value = Form.value(); databaseValues.append(value)
            databaseRows.append(Form.valueRow(title, value))
        }
        let empty = Form.vstack([databaseEmpty]); databaseRows.append(empty)
        databaseEmpty.widthAnchor.constraint(equalTo: empty.widthAnchor).isActive = true
        return Form.page([
            Form.section("Current Database", databaseRows + [Form.actions([button("Copy Connection URL", #selector(copyDatabaseURL))])]),
            Form.section("Connection", [fields.databaseView, saveRow()], footer: "Dispatch manages a private database unless you use your own."),
        ])
    }

    private func aboutPage() -> NSView {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Development"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "local"
        let versionLabel = NSTextField(labelWithString: "Version \(version) (\(build))"); versionLabel.textColor = .secondaryLabelColor
        versionLabel.isSelectable = true
        let header = Form.hstack([Brand.iconView(size: 40), Form.vstack([Form.title("Dispatch", size: 15), versionLabel], spacing: 2)], spacing: 12)
        channel.addItems(withTitles: UpdateChannel.allCases.map(\.title))
        channel.target = self; channel.action = #selector(changeChannel)
        channel.setAccessibilityLabel("Update channel")
        let path = Form.value(AppPaths.root.path)
        return Form.page([
            Form.section(nil, [header]),
            Form.section("Updates", [Form.row("Channel", channel)], footer: "Stable gets promoted releases. Preview gets every release."),
            Form.section("Data", [Form.valueRow("Location", path), Form.actions([button("Copy Path", #selector(copyDataPath)), button("Show in Finder", #selector(showData))])],
                         footer: "Your database, sessions, settings, and logs."),
        ])
    }

    // MARK: State

    private func saveRow() -> NSStackView {
        let save = button("Save", #selector(saveSettings)); saveButtons.append(save)
        let feedback = FeedbackLabel(); saveFeedback.append(feedback)
        feedback.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return Form.actions([save], feedback: feedback)
    }
    private func setSavedMessage(_ text: String) {
        savedMessage.stringValue = text
        for label in saveFeedback { label.stringValue = text }
    }
    func didSave(_ configuration: Configuration) {
        self.configuration = configuration
        setSavedMessage("Settings saved.")
    }
    func update(configuration: Configuration, runningConfiguration: Configuration?, displayURL: URL? = nil, canControlServer: Bool = true, canSave: Bool = true, status: String, active: Bool, loginEnabled: Bool, canChangeLogin: Bool, needsApproval: Bool, busy: Bool, serverAtLogin: Bool, stopping: Bool = false) {
        self.configuration = configuration
        updateDetails(runningConfiguration ?? configuration)
        displayedURL = displayURL ?? (runningConfiguration ?? configuration).serverURL
        urlField.stringValue = displayedURL.absoluteString
        statusLabel.stringValue = status
        statusLabel.setAccessibilityLabel("Server status: \(status)")
        statusDot.contentTintColor = Brand.color(Self.tone(status))
        startStop.title = stopping ? "Stopping…" : active ? "Stop Server" : "Start Server"; startStop.isEnabled = canControlServer && !busy && !stopping
        // The server's next step is the dominant action only when it is stopped.
        startStop.bezelColor = !active && !stopping && startStop.isEnabled ? .controlAccentColor : nil
        login.state = loginEnabled ? .on : .off; login.isEnabled = canChangeLogin && !busy
        serverLogin.state = serverAtLogin ? .on : .off; serverLogin.isEnabled = canChangeLogin && !busy
        approvalRow.isHidden = !needsApproval
        fields.setEnabled(canSave && !busy)
        for save in saveButtons { save.isEnabled = canSave && !busy }
        let certificate = try? Data(contentsOf: AppPaths.root.appendingPathComponent("tls/ca/cert.cer"))
        certificateDetails.stringValue = certificate.map { "CA SHA-256\n" + SHA256.hash(data: $0).map { String(format: "%02X", $0) }.joined(separator: ":") } ?? "Certificate not created yet."
        certificateStatus.stringValue = certificate == nil ? "Created when the server first starts" : "Ready to trust"
        fingerprintRow?.isHidden = certificate == nil
        for button in trustButtons { button.isEnabled = certificate != nil && canSave && !busy }
        trustButtons.last?.isEnabled = certificate != nil && active && displayedURL.scheme == "https"
        if let running = runningConfiguration, active && (running.port != configuration.port || running.bindHosts != configuration.bindHosts || running.databaseURL != configuration.databaseURL || running.localTLS != configuration.localTLS) {
            setSavedMessage("Saved changes will apply the next time you start the server.")
        } else if active { setSavedMessage("") }
    }
    static func tone(_ status: String) -> Brand.Tone {
        switch status {
        case "Running": return .good
        case "Starting…", "Stopping…", "Checking…", "Moving your data…", "Needs permission in System Settings": return .pending
        case "Stopped", "Not configured": return .neutral
        default: return .attention
        }
    }
    private func updateDetails(_ config: Configuration) {
        displayedDatabaseURL = config.databaseURL
        if let url = URLComponents(string: config.databaseURL), let host = url.host {
            databaseKind.stringValue = config.usesManagedDatabase ? "Managed by Dispatch" : "External PostgreSQL"
            for (field, value) in zip(databaseValues, [host, String(url.port ?? 5432), String(url.path.dropFirst()), url.user ?? ""]) { field.stringValue = value }
            for (index, row) in databaseRows.enumerated() { row.isHidden = index == databaseRows.count - 1 }
        } else {
            for (index, row) in databaseRows.enumerated() { row.isHidden = index != databaseRows.count - 1 }
        }
    }
    private func button(_ title: String, _ action: Selector) -> NSButton { NSButton(title: title, target: self, action: action) }
    private func copy(_ text: String) { copyText(text) }
    func refreshChannel() { channel.selectItem(at: UpdateChannel.allCases.firstIndex(of: updateChannels.get()) ?? 0) }
    @objc private func changeChannel() { updateChannels.set(UpdateChannel.allCases[max(channel.indexOfSelectedItem, 0)]) }
    @objc private func changeLogin() { onLoginChange?() }
    @objc private func changeServerLogin() { onServerLoginChange?(serverLogin.state == .on) }
    @objc private func saveSettings() { onSave?(fields) }
    @objc private func toggleServer() { onStartStop?() }
    @objc private func allowService() { onApproval?() }
    @objc private func showData() { onDataFolder?() }
    @objc private func toggleFingerprint() {
        certificateDetails.isHidden.toggle()
        fingerprintToggle.title = certificateDetails.isHidden ? "Show" : "Hide"
        fingerprintToggle.setAccessibilityLabel(certificateDetails.isHidden ? "Show certificate fingerprint" : "Hide certificate fingerprint")
    }
    @objc private func copyURL() { copy(displayedURL.absoluteString) }
    @objc private func copyDatabaseURL() { copy(displayedDatabaseURL) }
    @objc private func copyDataPath() { copy(AppPaths.root.path) }
    @objc private func openTrustInstructions() { NSWorkspace.shared.open(displayedURL.appendingPathComponent("trust")) }
    @objc private func exportProfile() { exportTrustFile("trust.mobileconfig", name: "dispatch.mobileconfig") }
    @objc private func exportCertificate() { exportTrustFile("cert.cer", name: "dispatch-ca.cer") }
    private func exportTrustFile(_ source: String, name: String) {
        guard let window else { return }
        let panel = NSSavePanel(); panel.nameFieldStringValue = name
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let destination = panel.url else { return }
            do {
                let data = try Data(contentsOf: AppPaths.root.appendingPathComponent("tls/ca/" + source))
                try data.write(to: destination, options: .atomic)
            } catch {
                let alert = NSAlert(error: error); alert.beginSheetModal(for: window)
            }
        }
    }
}
