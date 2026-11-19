import Foundation
import UserNotifications

/// Tells the user an update finished after Sparkle relaunches the app. The menu app has
/// no window, so without this an update looks like the app quietly disappeared.
final class UpdateNotifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = UpdateNotifier()

    struct Message: Equatable {
        enum Kind: String { case postponed, completed }
        let kind: Kind
        let title: String
        let body: String
        var identifier: String { "dispatch.update.\(kind.rawValue)" }
        static func postponed(_ body: String) -> Message {
            Message(kind: .postponed, title: "Update postponed", body: body)
        }
    }

    // Injectable transport keeps permission and replacement behavior testable without
    // touching the user's Notification Center.
    var deliver: (Message, @escaping (Bool) -> Void) -> Void = { message, completion in
        guard Bundle.main.bundleURL.pathExtension == "app", Bundle.main.bundleIdentifier != nil else {
            completion(false); return
        }
        let center = UNUserNotificationCenter.current()
        center.delegate = UpdateNotifier.shared
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { completion(false); return }
            let content = UNMutableNotificationContent()
            content.title = message.title; content.body = message.body
            // Delivered notifications also need removing: add replaces pending requests.
            center.removeDeliveredNotifications(withIdentifiers: [message.identifier])
            center.add(UNNotificationRequest(identifier: message.identifier, content: content, trigger: nil)) { error in
                completion(error == nil)
            }
        }
    }
    var fallback: ((Message) -> Void)?
    var onOpen: (() -> Void)?

    func notify(_ message: Message) {
        deliver(message) { [weak self] delivered in
            guard !delivered else { return }
            DispatchQueue.main.async { self?.fallback?(message) }
        }
    }
    func notifyUpdated(serverRunning: Bool) {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        notify(Message(kind: .completed,
                       title: version.map { "Dispatch updated to \($0)" } ?? "Dispatch updated",
                       body: serverRunning ? "The server restarted and is running." : "The update is installed."))
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        DispatchQueue.main.async { self.onOpen?(); completionHandler() }
    }

    // A menu bar app can count as frontmost; show the banner anyway.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
