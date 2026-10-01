import Foundation
import UserNotifications

/// Tells the user an update finished after Sparkle relaunches the app. The menu app has
/// no window, so without this an update looks like the app quietly disappeared.
final class UpdateNotifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = UpdateNotifier()

    func notifyUpdated(serverRunning: Bool) {
        // UNUserNotificationCenter requires a real app bundle.
        guard Bundle.main.bundleIdentifier != nil else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        let content = UNMutableNotificationContent()
        content.title = version.map { "Dispatch updated to \($0)" } ?? "Dispatch updated"
        content.body = serverRunning ? "The server restarted and is running." : "The update is installed."
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            center.add(UNNotificationRequest(identifier: "dispatch.update.completed", content: content, trigger: nil))
        }
    }

    // A menu bar app can count as frontmost; show the banner anyway.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
