#if SPARKLE_UPDATES
import AppKit
import Sparkle

/// Keep Sparkle's release notes/download UI, replacing its install prompt with
/// visible feedback before handing control back to Sparkle or the recovery hook.
@MainActor
final class UpdateUserDriver: SPUStandardUserDriver {
    private(set) var progress: UpdateProgressWindow?
    private(set) var handoffInProgress = false
    private var preparingHandoff = false
    private var pendingInstallerError: String?
    var activateApp: () -> Void = { NSApp.activate(ignoringOtherApps: true) }

    /// A paused reason may outlive its cycle, but must not own a later check.
    private func dismissPreviousFeedback() {
        guard !handoffInProgress, !preparingHandoff else { return }
        progress?.close(); progress = nil
    }
    override func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
        dismissPreviousFeedback()
        super.showUserInitiatedUpdateCheck(cancellation: cancellation)
    }

    override func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        super.showReady(toInstallAndRelaunch: installationReply(reply))
    }
    override func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
        dismissPreviousFeedback()
        // Sparkle can also offer an already-staged update directly in its alert.
        super.showUpdateFound(with: appcastItem, state: state, reply: state.stage == .installing ? installationReply(reply) : reply)
    }
    /// One reply per prompt, including reentrant callbacks while the quit is delayed.
    func installationReply(_ reply: @escaping (SPUUserUpdateChoice) -> Void) -> (SPUUserUpdateChoice) -> Void {
        var answered = false
        return { [weak self] choice in
            guard !answered else { return }
            answered = true
            if choice == .install { self?.beginProgress() }
            reply(choice)
        }
    }
    private func beginProgress() {
        super.dismissUpdateInstallation()
        progress?.close()
        let window = UpdateProgressWindow()
        progress = window
        handoffInProgress = true
        pendingInstallerError = nil
        window.onClose = { [weak self] in self?.progress = nil }
        window.showWindow(nil)
    }
    func preparing() {
        guard let progress else { return }
        handoffInProgress = true; preparingHandoff = true
        progress.update(.preparing)
    }
    func restarting() {
        preparingHandoff = false
        if let pendingInstallerError { stopped(pendingInstallerError) }
        else if handoffInProgress { progress?.update(.restarting) }
    }
    /// Also runs on failure/withdrawal, so a deferred installer error cannot be lost.
    func preparationFinished() {
        preparingHandoff = false
        if let pendingInstallerError { stopped(pendingInstallerError) }
    }
    /// Returns true when the reason is shown here, avoiding a duplicate modal alert.
    @discardableResult
    func stopped(_ message: String) -> Bool {
        guard handoffInProgress, let progress else { return false }
        handoffInProgress = false; preparingHandoff = false; pendingInstallerError = nil
        progress.update(.stopped(message))
        activateApp()
        progress.showWindow(nil)
        return true
    }
    /// The same deferred update can exhaust its retries after its handoff ended.
    func retryExhausted(_ message: String) {
        if stopped(message) { return }
        guard let progress, case .stopped = progress.phase else { return }
        progress.update(.stopped(message)); activateApp(); progress.showWindow(nil)
    }
    override func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) {
        // The standard driver closes its window when quit is delayed. Our window
        // stays visible; only the protected handoff may announce a restart.
        if !handoffInProgress {
            super.showInstallingUpdate(withApplicationTerminated: applicationTerminated, retryTerminatingApplication: retryTerminatingApplication)
        }
    }
    override func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
        if handleHandoffError(error.localizedDescription) { acknowledgement() }
        else { super.showUpdaterError(error, acknowledgement: acknowledgement) }
    }
    /// Installer callbacks do not settle Dispatch's asynchronous preparation.
    /// Keep its controls locked until AppUpdater reports a terminal result.
    @discardableResult
    func handleHandoffError(_ message: String) -> Bool {
        guard handoffInProgress else { return false }
        if preparingHandoff { pendingInstallerError = message; return true }
        return stopped(message)
    }
    override func showUpdateInFocus() {
        if handoffInProgress, let progress { progress.showWindow(nil) } else { super.showUpdateInFocus() }
    }
    override func dismissUpdateInstallation() {
        super.dismissUpdateInstallation()
        if preparingHandoff { return }
        handoffInProgress = false
        // A withdrawal may end Sparkle's cycle before the user reads its reason.
        if let progress, case .stopped = progress.phase { return }
        progress?.close(); progress = nil
    }
}
#endif
