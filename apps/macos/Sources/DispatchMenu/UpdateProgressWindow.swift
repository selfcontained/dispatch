import AppKit

/// Feedback for the protected handoff, which can delay Sparkle's quit request.
@MainActor
final class UpdateProgressWindow: NSWindowController, NSWindowDelegate {
    enum Phase: Equatable {
        case checkingActivity, waitingForAgents, cancelling, preparing, restarting, stopped(String), cancelFailed(String)
    }
    var onAction: (() -> Void)?
    var onClose: (() -> Void)?
    private let content = NSStackView()
    private(set) var phase: Phase = .preparing
    private let heading = NSTextField(labelWithString: "")
    private let detail = NSTextField(wrappingLabelWithString: "")
    private let spinner = NSProgressIndicator()
    private let dismiss = NSButton(title: "Dismiss", target: nil, action: nil)

    init() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 190), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Updating Dispatch"
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self
        heading.font = .boldSystemFont(ofSize: 16)
        detail.textColor = .secondaryLabelColor
        spinner.style = .spinning; spinner.controlSize = .small
        spinner.setAccessibilityLabel("Update in progress")
        dismiss.target = self; dismiss.action = #selector(dismissProgress)
        let status = NSStackView(views: [spinner, heading]); status.spacing = 12
        [status, detail, dismiss].forEach { content.addArrangedSubview($0) }
        content.orientation = .vertical; content.alignment = .leading; content.spacing = 16
        content.translatesAutoresizingMaskIntoConstraints = false
        window.contentView?.addSubview(content)
        if let view = window.contentView {
            NSLayoutConstraint.activate([
                content.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
                content.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
                content.topAnchor.constraint(equalTo: view.topAnchor, constant: 24),
                content.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -24),
                detail.widthAnchor.constraint(equalTo: content.widthAnchor),
            ])
        }
        window.center()
        update(.preparing)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func update(_ phase: Phase) {
        self.phase = phase
        switch phase {
        case .checkingActivity:
            heading.stringValue = "Checking agent activity…"
            detail.stringValue = "Dispatch checks for active work before offering installation."
        case .waitingForAgents:
            heading.stringValue = "Waiting for agents to finish"
            detail.stringValue = "Agents or background tasks are still working. This window checks automatically and will ask you to confirm installation when work is idle. Cancel update cancels this attempt without interrupting agents. Future update checks stay enabled."
        case .cancelling:
            heading.stringValue = "Cancelling update…"
            detail.stringValue = "Dispatch is removing the pending installer. Agents can keep working."
        case .preparing:
            heading.stringValue = "Preparing update…"
            detail.stringValue = "Dispatch is preparing a recovery point and stopping the server safely. It will restart when the update is ready."
        case .restarting:
            heading.stringValue = "Restarting Dispatch…"
            detail.stringValue = "The update is ready. Dispatch will briefly close, then notify you when the update finishes."
        case .stopped(let message), .cancelFailed(let message):
            heading.stringValue = "Update paused"
            detail.stringValue = message
        }
        let stopped: Bool
        switch phase {
        case .stopped, .cancelFailed, .waitingForAgents, .checkingActivity: stopped = true
        default: stopped = false
        }
        switch phase {
        case .checkingActivity, .waitingForAgents: dismiss.title = "Cancel update"
        case .cancelFailed: dismiss.title = "Try again"
        default: dismiss.title = "Dismiss"
        }
        dismiss.isHidden = !stopped
        let failed: Bool
        switch phase { case .stopped, .cancelFailed: failed = true; default: failed = false }
        spinner.isHidden = failed
        if failed { spinner.stopAnimation(nil) } else { spinner.startAnimation(nil) }
        window?.styleMask = stopped ? [.titled, .closable] : [.titled]
        content.layoutSubtreeIfNeeded()
        window?.setContentSize(NSSize(width: 460, height: max(190, content.fittingSize.height + 48)))
    }
    func windowWillClose(_ notification: Notification) { onClose?() }
    @objc private func dismissProgress() { if let onAction { onAction() } else { close() } }
}
