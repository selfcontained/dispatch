import AppKit

/// Feedback for the protected handoff, which can delay Sparkle's quit request.
/// Copy says what the user needs to know; updater internals stay behind Show Details.
@MainActor
final class UpdateProgressWindow: NSWindowController, NSWindowDelegate {
    enum Phase: Equatable {
        case checkingActivity, waitingForAgents, cancelling, preparing, restarting, stopped(String), cancelFailed(String)
    }
    /// The phase's own action: postpone while waiting, retry cancellation after it failed,
    /// or acknowledge a stopped update. Closing the window always remains available
    /// whenever any button is shown.
    var onAction: (() -> Void)?
    var onClose: (() -> Void)?
    private let content = NSStackView()
    private(set) var phase: Phase = .preparing
    private let heading = NSTextField(labelWithString: "")
    private let detail = NSTextField(wrappingLabelWithString: "")
    private let technical = NSTextField(wrappingLabelWithString: "")
    private let spinner = NSProgressIndicator()
    private let primary = NSButton(title: "OK", target: nil, action: nil)
    private let secondary = NSButton(title: "Try Again", target: nil, action: nil)
    private let detailsToggle = NSButton(title: "Show Details", target: nil, action: nil)
    private let actions: NSStackView
    private static let width: CGFloat = 460

    init() {
        actions = Form.actions([])
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: Self.width, height: 160), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Updating Dispatch"
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self
        // Same arrangement as a native alert: app icon, status, then actions.
        heading.font = .systemFont(ofSize: 15, weight: .semibold)
        heading.lineBreakMode = .byWordWrapping; heading.maximumNumberOfLines = 0
        detail.font = .systemFont(ofSize: 13); detail.textColor = .secondaryLabelColor
        technical.font = .systemFont(ofSize: NSFont.smallSystemFontSize); technical.textColor = .secondaryLabelColor
        technical.isSelectable = true; technical.isHidden = true
        technical.setAccessibilityLabel("Update details")
        spinner.style = .spinning; spinner.controlSize = .small
        spinner.setAccessibilityLabel("Update in progress")
        primary.target = self; primary.action = #selector(primaryAction)
        secondary.target = self; secondary.action = #selector(secondaryAction)
        detailsToggle.bezelStyle = .inline; detailsToggle.controlSize = .small
        detailsToggle.target = self; detailsToggle.action = #selector(toggleDetails)
        actions.setViews([detailsToggle, Form.spacer(), secondary, primary], in: .leading)
        let status = Form.hstack([heading, spinner], spacing: 10)
        let text = Form.vstack([status, detail, technical], spacing: 6)
        text.setCustomSpacing(10, after: detail)
        status.widthAnchor.constraint(lessThanOrEqualTo: text.widthAnchor).isActive = true
        detail.widthAnchor.constraint(equalTo: text.widthAnchor).isActive = true
        technical.widthAnchor.constraint(equalTo: text.widthAnchor).isActive = true
        let body = Form.hstack([Brand.iconView(size: 64), text], spacing: 20)
        body.alignment = .top
        [body, actions].forEach { content.addArrangedSubview($0) }
        content.orientation = .vertical; content.alignment = .leading; content.spacing = 24
        content.translatesAutoresizingMaskIntoConstraints = false
        window.contentView?.addSubview(content)
        if let view = window.contentView {
            NSLayoutConstraint.activate([
                content.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
                content.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
                content.topAnchor.constraint(equalTo: view.topAnchor, constant: 24),
                content.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -24),
                body.widthAnchor.constraint(equalTo: content.widthAnchor),
                text.widthAnchor.constraint(equalTo: content.widthAnchor, constant: -84),
                actions.widthAnchor.constraint(equalTo: content.widthAnchor),
            ])
        }
        window.center()
        update(.preparing)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func update(_ phase: Phase) {
        self.phase = phase
        var details = ""
        var primaryTitle: String?
        var secondaryTitle: String?
        switch phase {
        case .checkingActivity:
            heading.stringValue = "Checking agent activity…"
            detail.stringValue = "Dispatch installs updates only when agents are idle."
            primaryTitle = "Install Later"
        case .waitingForAgents:
            heading.stringValue = "Waiting for agents to finish"
            detail.stringValue = "Dispatch will ask you to install once agents are idle."
            primaryTitle = "Install Later"
        case .cancelling:
            heading.stringValue = "Postponing update…"
            detail.stringValue = "Agents keep working."
        case .preparing:
            heading.stringValue = "Preparing update…"
            detail.stringValue = "Saving a recovery point and stopping the server safely."
        case .restarting:
            heading.stringValue = "Restarting Dispatch…"
            detail.stringValue = "Dispatch will close briefly and notify you when it’s done."
        case .stopped(let message) where message.contains("retry automatically"):
            heading.stringValue = "Update postponed"
            detail.stringValue = "Agents are still working. Dispatch will try again when they’re idle."
            primaryTitle = "OK"
        case .stopped(let message):
            heading.stringValue = "Update didn’t install"
            detail.stringValue = "You can try again later from the Dispatch menu."
            details = message; primaryTitle = "OK"
        case .cancelFailed(let message):
            // Quitting runs the protected handoff, which may install, withdraw, or block the quit.
            heading.stringValue = "Couldn’t postpone the update"
            detail.stringValue = "The update is still pending. Dispatch will check that it’s safe to install when you quit."
            details = message; primaryTitle = "OK"; secondaryTitle = "Try Again"
        }
        technical.stringValue = details
        if details.isEmpty { technical.isHidden = true }
        detailsToggle.isHidden = details.isEmpty
        detailsToggle.title = technical.isHidden ? "Show Details" : "Hide Details"
        primary.title = primaryTitle ?? ""; primary.isHidden = primaryTitle == nil
        secondary.title = secondaryTitle ?? ""; secondary.isHidden = secondaryTitle == nil
        // Return/Escape acknowledge or postpone; nothing retries from the keyboard by accident.
        primary.keyEquivalent = primaryTitle == "OK" ? "\r" : "\u{1b}"
        actions.isHidden = primaryTitle == nil
        window?.setAccessibilityLabel("Updating Dispatch: \(heading.stringValue)")
        let failed: Bool
        switch phase { case .stopped, .cancelFailed: failed = true; default: failed = false }
        spinner.isHidden = failed
        if failed { spinner.stopAnimation(nil) } else { spinner.startAnimation(nil) }
        // Every state with an action can also be closed; protected handoff phases cannot.
        window?.styleMask = primaryTitle != nil ? [.titled, .closable] : [.titled]
        resize()
    }
    private func resize() {
        content.layoutSubtreeIfNeeded()
        window?.setContentSize(NSSize(width: Self.width, height: max(140, content.fittingSize.height + 48)))
    }
    func windowWillClose(_ notification: Notification) { onClose?() }
    @objc private func primaryAction() {
        // After a failed cancellation, OK keeps the update pending: the same as closing.
        if case .cancelFailed = phase { close(); return }
        if let onAction { onAction() } else { close() }
    }
    @objc private func secondaryAction() { onAction?() }
    @objc private func toggleDetails() {
        technical.isHidden.toggle()
        detailsToggle.title = technical.isHidden ? "Show Details" : "Hide Details"
        resize()
    }
}
