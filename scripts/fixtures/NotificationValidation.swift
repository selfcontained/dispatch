import AppKit
import UserNotifications

/// Standalone debug hook: links only the shipping notifier, never AppPaths or services.
@MainActor
final class NotificationValidation: NSObject, NSApplicationDelegate {
    private var status: NSStatusItem!
    private var menu: NSMenu!
    private var fallbackItem: NSMenuItem!
    private var sequence = 0
    private let bodies = [
        "Dispatch postponed the automatic update because it could not verify agent activity. It will retry automatically; no work was interrupted.",
        "Dispatch postponed the update because its preparation state changed. It will retry automatically; no work was interrupted.",
        "Dispatch postponed the update because agents are still working. It will retry when they are idle; no work was interrupted.",
        "Dispatch postponed the update because agents stayed busy. Choose Check for Updates when work is idle."
    ]
    func applicationDidFinishLaunching(_ notification: Notification) {
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status.button?.title = "Dispatch Test"
        status.button?.image = NSImage(systemSymbolName: "bell", accessibilityDescription: "Notification validation")
        menu = NSMenu()
        let names = ["Verification failed", "Preparation changed", "Agents busy", "Retries exhausted", "Update completed", "Repeat postponement", "Simulate unavailable delivery"]
        for (index, name) in names.enumerated() {
            let item = NSMenuItem(title: "Send: \(name) (in 5 seconds)", action: #selector(send(_:)), keyEquivalent: "")
            item.tag = index; item.target = self; menu.addItem(item)
        }
        fallbackItem = NSMenuItem(title: "No fallback message", action: nil, keyEquivalent: "")
        menu.addItem(.separator()); menu.addItem(fallbackItem)
        let quit = NSMenuItem(title: "Quit test", action: #selector(quitTest), keyEquivalent: "q")
        quit.target = self; menu.addItem(quit)
        status.menu = menu
        UpdateNotifier.shared.fallback = { [weak self] message in
            self?.fallbackItem.title = "\(message.title): \(message.body)"
            self?.status.button?.toolTip = message.body
            self?.log("fallback \(message.identifier)")
        }
        UpdateNotifier.shared.onOpen = { [weak self] in
            self?.log("notification clicked: opening menu")
            self?.status.button?.performClick(nil)
        }
        log("ready: sandboxed notification-only app")
    }
    private func log(_ text: String) { print(text); fflush(stdout) }
    @objc private func send(_ sender: NSMenuItem) {
        let kind = sender.tag
        sequence += 1
        let repeatNumber = sequence
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [self] in
            let before = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "unknown"
            if kind == 4 { UpdateNotifier.shared.notifyUpdated(serverRunning: true) }
            else {
                let body = kind < 4 ? bodies[kind] : "Dispatch postponed the update because agents are still working (manual repeat \(repeatNumber)). It will retry when they are idle; no work was interrupted."
                if kind == 6 {
                    // Exercise the real fallback branch without changing OS permission.
                    let deliver = UpdateNotifier.shared.deliver
                    UpdateNotifier.shared.deliver = { _, done in done(false) }
                    UpdateNotifier.shared.notify(.postponed(body))
                    UpdateNotifier.shared.deliver = deliver
                } else { UpdateNotifier.shared.notify(.postponed(body)) }
            }
            log("sent case=\(kind) focusBefore=\(before)")
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [self] in
                log("focusAfter=\(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "unknown") visibleWindows=\(NSApp.windows.filter(\.isVisible).count)")
            }
        }
    }
    @objc private func quitTest() { NSApp.terminate(nil) }
}

@main struct NotificationValidationApp {
    @MainActor static func main() {
        if CommandLine.arguments.contains("--clear-notifications") {
            let center = UNUserNotificationCenter.current()
            center.removeAllPendingNotificationRequests(); center.removeAllDeliveredNotifications()
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 1))
            return
        }
        let app = NSApplication.shared
        let controller = NotificationValidation()
        app.delegate = controller; app.setActivationPolicy(.accessory); app.run()
    }
}
