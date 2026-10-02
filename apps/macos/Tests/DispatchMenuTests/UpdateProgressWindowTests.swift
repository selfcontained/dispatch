import AppKit
@testable import DispatchMenu
import XCTest
#if SPARKLE_UPDATES
import Sparkle
#endif

final class UpdateProgressWindowTests: XCTestCase {
    @MainActor private func descendants(_ view: NSView) -> [NSView] {
        view.subviews.flatMap { [$0] + descendants($0) }
    }
    @MainActor private func capture(_ controller: NSWindowController, name: String) throws {
        guard let directory = ProcessInfo.processInfo.environment["DISPATCH_UPDATE_SCREENSHOTS"] else { return }
        let window = try XCTUnwrap(controller.window)
        window.contentView?.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.15))
        let capture = Process()
        capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        capture.arguments = ["-x", "-l", "\(window.windowNumber)", URL(fileURLWithPath: directory).appendingPathComponent("\(name).png").path]
        try capture.run(); capture.waitUntilExit()
        XCTAssertEqual(capture.terminationStatus, 0)

    }
    @MainActor func testProgressHasNoActionsUntilStoppedAndCanBeDismissed() throws {
        _ = NSApplication.shared
        let controller = UpdateProgressWindow()
        defer { controller.close() }
        controller.showWindow(nil)
        let view = try XCTUnwrap(controller.window?.contentView)
        let controls = descendants(view)
        XCTAssertTrue(controls.compactMap { $0 as? NSButton }.allSatisfy(\.isHidden))
        XCTAssertFalse(try XCTUnwrap(controller.window).styleMask.contains(.closable))
        XCTAssertTrue(controls.compactMap { $0 as? NSTextField }.contains { $0.stringValue == "Preparing update…" })
        try capture(controller, name: "preparing")
        controller.update(.restarting)
        XCTAssertTrue(controls.compactMap { $0 as? NSTextField }.contains { $0.stringValue == "Restarting Dispatch…" })
        try capture(controller, name: "restarting")
        controller.update(.stopped(String(repeating: "Long recovery explanation. ", count: 30)))
        view.layoutSubtreeIfNeeded()
        let detail = try XCTUnwrap(controls.compactMap { $0 as? NSTextField }.first { $0.stringValue.hasPrefix("Long recovery") })
        XCTAssertGreaterThan(detail.frame.minY, 0, "Long errors must fit in the resized window")
        controller.update(.stopped("Agents are still working. Dispatch will retry automatically when agents are idle."))
        XCTAssertTrue(controls.compactMap { $0 as? NSProgressIndicator }.allSatisfy(\.isHidden))
        let dismiss = try XCTUnwrap(controls.compactMap { $0 as? NSButton }.first { !$0.isHidden })
        XCTAssertEqual(dismiss.title, "Dismiss")
        try capture(controller, name: "paused")
        dismiss.performClick(nil)
        XCTAssertFalse(try XCTUnwrap(controller.window).isVisible)
    }
    #if SPARKLE_UPDATES
    @MainActor func testSparkleInstallClickImmediatelyReplacesPromptAndRepliesOnce() throws {
        _ = NSApplication.shared
        let driver = UpdateUserDriver(hostBundle: .main, delegate: nil)
        defer { driver.progress?.close(); driver.dismissUpdateInstallation() }
        var replies = 0
        driver.showReady(toInstallAndRelaunch: { choice in
            XCTAssertEqual(choice, .install)
            // Progress must already be visible when Sparkle receives the reply.
            XCTAssertEqual(driver.progress?.phase, .preparing)
            XCTAssertTrue(driver.progress?.window?.isVisible == true)
            replies += 1
        })
        let button = try XCTUnwrap(NSApp.windows.compactMap(\.contentView).flatMap(descendants).compactMap { $0 as? NSButton }.first { $0.accessibilityIdentifier() == "SUStatusInstallAndRelaunch" })
        let oldWindow = try XCTUnwrap(button.window)
        try capture(try XCTUnwrap(oldWindow.windowController), name: "before-install")
        button.performClick(nil)
        XCTAssertEqual(replies, 1)
        XCTAssertFalse(oldWindow.isVisible)
        button.performClick(nil)
        XCTAssertEqual(replies, 1)
        driver.showInstallingUpdate(withApplicationTerminated: false, retryTerminatingApplication: { XCTFail("Must not retry termination") })
        XCTAssertTrue(driver.progress?.window?.isVisible == true)
        driver.restarting()
        XCTAssertEqual(driver.progress?.phase, .restarting)
        var acknowledged = false
        driver.showUpdaterError(NSError(domain: "UpdateTest", code: 1, userInfo: [NSLocalizedDescriptionKey: "Installer failed"]), acknowledgement: { acknowledged = true })
        XCTAssertTrue(acknowledged)
        XCTAssertEqual(driver.progress?.phase, .stopped("Installer failed"))
        driver.preparing()
        driver.stopped("Preparation failed. Open the Dispatch menu and choose Retry Update Recovery.")
        driver.dismissUpdateInstallation()
        XCTAssertTrue(driver.progress?.window?.isVisible == true, "Ending Sparkle's cycle must retain the failure reason")
        try capture(try XCTUnwrap(driver.progress), name: "failed")
        driver.progress?.close()
        XCTAssertNil(driver.progress, "Dismissing must release the old failure window")
    }
    @MainActor func testPausedFeedbackActivatesAndDoesNotCaptureLaterCycles() throws {
        _ = NSApplication.shared
        let driver = UpdateUserDriver(hostBundle: .main, delegate: nil)
        defer { driver.progress?.close(); driver.dismissUpdateInstallation() }
        var activations = 0
        driver.activateApp = { activations += 1 }
        driver.installationReply { _ in }(.install)
        XCTAssertTrue(driver.stopped("Preparation failed"))
        XCTAssertEqual(activations, 1)
        XCTAssertFalse(driver.handoffInProgress)
        driver.dismissUpdateInstallation()
        XCTAssertFalse(driver.handleHandoffError("Unrelated feed failure"))
        XCTAssertFalse(driver.stopped("Unrelated recovery failure"))
        XCTAssertEqual(driver.progress?.phase, .stopped("Preparation failed"))
        driver.retryExhausted("Retries exhausted. Choose Check for Updates when agents are idle.")
        XCTAssertEqual(driver.progress?.phase, .stopped("Retries exhausted. Choose Check for Updates when agents are idle."))
        XCTAssertFalse(driver.handoffInProgress)
        driver.showUserInitiatedUpdateCheck(cancellation: {})
        XCTAssertNil(driver.progress, "A new check clears the old paused feedback")
        driver.dismissUpdateInstallation()
    }
    @MainActor func testInstallerErrorDuringPreparationKeepsControlsLockedUntilSettled() throws {
        _ = NSApplication.shared
        let driver = UpdateUserDriver(hostBundle: .main, delegate: nil)
        driver.activateApp = {}
        defer { driver.progress?.close(); driver.dismissUpdateInstallation() }
        driver.installationReply { _ in }(.install)
        driver.preparing()
        var acknowledged = false
        driver.showUpdaterError(NSError(domain: "UpdateTest", code: 1, userInfo: [NSLocalizedDescriptionKey: "Installer timed out"]), acknowledgement: { acknowledged = true })
        XCTAssertTrue(acknowledged)
        driver.dismissUpdateInstallation()
        let progress = try XCTUnwrap(driver.progress)
        XCTAssertEqual(progress.phase, .preparing)
        let controls = descendants(try XCTUnwrap(progress.window?.contentView))
        XCTAssertTrue(controls.compactMap { $0 as? NSButton }.allSatisfy(\.isHidden))
        XCTAssertFalse(try XCTUnwrap(progress.window).styleMask.contains(.closable))
        try capture(progress, name: "installer-error-during-preparation")
        driver.restarting()
        XCTAssertEqual(progress.phase, .stopped("Installer timed out"), "Preparation settling must surface the error rather than claim a restart")
        driver.preparationFinished()
        XCTAssertFalse(driver.handoffInProgress)
        try capture(progress, name: "installer-error-after-preparation")
        // A definitive preparation failure supersedes the earlier installer message.
        driver.preparing()
        XCTAssertTrue(driver.handleHandoffError("Another installer error"))
        driver.stopped("Could not stop the server. Choose Retry Update Recovery.")
        driver.preparationFinished()
        XCTAssertEqual(progress.phase, .stopped("Could not stop the server. Choose Retry Update Recovery."))
    }
    @MainActor func testRepeatedAndReentrantRepliesDoNotRestartInstallation() {
        _ = NSApplication.shared
        let driver = UpdateUserDriver(hostBundle: .main, delegate: nil)
        defer { driver.dismissUpdateInstallation() }
        var reply: ((SPUUserUpdateChoice) -> Void)!
        var calls = 0
        reply = driver.installationReply { _ in calls += 1; reply(.install) }
        reply(.install); reply(.install)
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(driver.progress?.phase, .preparing)
        driver.dismissUpdateInstallation()
        XCTAssertNil(driver.progress)
        let dismiss = driver.installationReply { choice in XCTAssertEqual(choice, .dismiss) }
        dismiss(.dismiss)
        XCTAssertNil(driver.progress, "Dismissing must not start progress")
    }
    #endif
}
