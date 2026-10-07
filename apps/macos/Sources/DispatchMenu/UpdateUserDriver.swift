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
    var cancelPendingInstall: (() async throws -> Void)?
    var checkActivity: (() async throws -> Bool)?
    var activityPollDelay: () async throws -> Void = { try await Task.sleep(for: .seconds(3)) }
    private var activityTask: Task<Void, Never>?
    private var abandonActivity: (() -> Void)?
    private var cancelActivity: (() -> Void)?
    private(set) var busyDeferral: String?
    var activateApp: () -> Void = { NSApp.activate(ignoringOtherApps: true) }

    /// A paused reason may outlive its cycle, but must not own a later check.
    private func dismissPreviousFeedback() {
        guard !handoffInProgress, !preparingHandoff else { return }
        progress?.close(); progress = nil
    }
    override func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
        busyDeferral = nil
        dismissPreviousFeedback()
        super.showUserInitiatedUpdateCheck(cancellation: cancellation)
    }

    override func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        showReadyPrompt(reply)
    }
    override func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
        dismissPreviousFeedback()
        busyDeferral = nil
        // Release notes, Skip, and Remind Me Later remain available while busy.
        super.showUpdateFound(with: appcastItem, state: state, reply: state.stage == .installing ? installationReply(reply) : reply)
    }
    private func showReadyPrompt(_ reply: @escaping (SPUUserUpdateChoice) -> Void, check: Bool = true) {
        super.showReady(toInstallAndRelaunch: installationReply(reply, check: check))
    }
    /// No install reply is sent while busy. Dismissing cancels this prompt once.
    func offerWhenIdle(reply: @escaping (SPUUserUpdateChoice) -> Void, offer: @escaping (Bool) -> Void) {
        guard let checkActivity else { offer(false); return }
        cancelActivity?()
        let window = UpdateProgressWindow()
        progress = window
        window.update(.checkingActivity)
        var answered = false
        var cancelling = false
        cancelActivity = { [weak self] in
            guard !answered, !cancelling, let self else { return }
            cancelling = true
            self.activityTask?.cancel(); self.activityTask = nil
            window.onClose = nil
            window.update(.cancelling)
            Task {
                do {
                    try await self.cancelPendingInstall?()
                    answered = true
                    self.cancelActivity = nil; self.abandonActivity = nil
                    window.close(); self.progress = nil
                    reply(.dismiss)
                } catch {
                    cancelling = false
                    window.update(.cancelFailed("Could not cancel the staged update. Choose Try again to retry cancellation, or close this window to leave the update pending. \(error.localizedDescription)"))
                    window.onClose = { [weak self] in
                        guard !answered else { return }
                        self?.abandonActivity?()
                        reply(.dismiss)
                    }
                    window.showWindow(nil)
                }
            }
        }

        abandonActivity = { [weak self] in
            guard !cancelling else { return }
            answered = true
            self?.activityTask?.cancel(); self?.activityTask = nil
            self?.cancelActivity = nil; self?.abandonActivity = nil
            window.onClose = nil; window.close(); self?.progress = nil
        }
        window.onAction = { [weak self] in self?.cancelActivity?() }
        window.onClose = { [weak self] in self?.cancelActivity?() }
        window.showWindow(nil)
        activityTask = Task { [weak self] in
            guard let self else { return }
            do {
                var waited = false
                var failures = 0
                while true {
                    do {
                        let busy = try await checkActivity()
                        try Task.checkCancellation()
                        failures = 0
                        if !busy { break }
                        waited = true
                        window.update(.waitingForAgents)
                    } catch {
                        try Task.checkCancellation()
                        failures += 1
                        guard error is URLError, failures < 3 else { throw error }
                        window.update(.checkingActivity)
                    }
                    try await self.activityPollDelay()
                }
                try Task.checkCancellation()
                guard !answered else { return }
                answered = true
                self.cancelActivity = nil; self.abandonActivity = nil; self.activityTask = nil
                window.onClose = nil; window.close(); self.progress = nil
                offer(waited)
            } catch is CancellationError { }
            catch {
                guard !answered else { return }
                window.update(.stopped("Could not check agent activity. Dismiss and try Check for Updates again. \(error.localizedDescription)"))
            }
        }
    }
    /// Withdrawing a busy installer closes Sparkle's connection intentionally.
    func beginUpdateCycle() { clearBusyDeferral() }
    func clearBusyDeferral() { busyDeferral = nil }
    func expectBusyDeferral(_ message: String) {
        busyDeferral = message
    }

    /// One reply per prompt, including reentrant callbacks while the quit is delayed.
    func installationReply(_ reply: @escaping (SPUUserUpdateChoice) -> Void, check: Bool = true) -> (SPUUserUpdateChoice) -> Void {
        var answered = false
        return { [weak self] choice in
            guard !answered else { return }
            answered = true
            guard choice == .install, let self else { reply(choice); return }
            if check, self.checkActivity != nil {
                self.hideSparklePrompt()
                self.offerWhenIdle(reply: reply) { [weak self] waited in
                    guard let self else { return }
                    // A long wait never installs without a fresh confirmation.
                    if waited { self.showReadyPrompt(reply, check: false) }
                    else { self.beginProgress(); reply(.install) }
                }
            } else {
                self.beginProgress(); reply(.install)
            }
        }
    }
    private func hideSparklePrompt() { super.dismissUpdateInstallation() }
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
        if progress == nil { beginProgress() }
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
        if busyDeferral != nil { acknowledgement(); return }
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
        abandonActivity?()
        super.dismissUpdateInstallation()
        if preparingHandoff || progress?.phase == .cancelling { return }
        handoffInProgress = false
        // A withdrawal may end Sparkle's cycle before the user reads its reason.
        if let progress, case .stopped = progress.phase { return }
        progress?.close(); progress = nil
    }
}
#endif
