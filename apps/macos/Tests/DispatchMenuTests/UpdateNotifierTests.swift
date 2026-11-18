import AppKit
import DispatchCore
@testable import DispatchMenu
import XCTest
#if SPARKLE_UPDATES
import Sparkle
#endif

final class UpdateNotifierTests: XCTestCase {
    func testPostponementsReplaceByKind() {
        let notifier = UpdateNotifier()
        var delivered: [String: UpdateNotifier.Message] = [:]
        notifier.deliver = { message, completion in delivered[message.identifier] = message; completion(true) }
        for code in ["ACTIVITY_UNVERIFIED", "ATTEMPT_CHANGED", "BUSY", "DRAIN_TIMEOUT", "BUSY_AFTER_FENCE", "HOSTS_NOT_QUIESCED", "HOSTS_RUNNING"] {
            let body = RecoveryDeferral(code: code, reasons: []).errorDescription!
            let message = UpdateNotifier.Message.postponed(body)
            XCTAssertEqual(message.kind, .postponed)
            XCTAssertEqual(message.title, "Update postponed")
            XCTAssertEqual(message.body, body)
            notifier.notify(message)
        }
        notifier.notify(.postponed("Agents stayed busy"))
        XCTAssertEqual(delivered.count, 1)
        XCTAssertEqual(delivered["dispatch.update.postponed"]?.body, "Agents stayed busy")
    }

    func testPermissionDeniedOrUnavailableUsesFallback() {
        let notifier = UpdateNotifier()
        let fallback = expectation(description: "nonactivating fallback")
        let message = UpdateNotifier.Message.postponed("No work interrupted")
        notifier.deliver = { _, completion in completion(false) }
        notifier.fallback = { value in XCTAssertEqual(value, message); fallback.fulfill() }
        notifier.notify(message)
        wait(for: [fallback], timeout: 2)
    }

    #if SPARKLE_UPDATES
    @MainActor func testPostponementDoesNotActivateOrOpenWindow() {
        _ = NSApplication.shared
        let notifier = UpdateNotifier.shared
        let original = notifier.deliver
        defer { notifier.deliver = original }
        var messages: [UpdateNotifier.Message] = []
        notifier.deliver = { message, completion in messages.append(message); completion(true) }
        let driver = UpdateUserDriver(hostBundle: Bundle.main, delegate: nil)
        var activations = 0
        driver.activateApp = { activations += 1 }
        for code in ["ACTIVITY_UNVERIFIED", "ATTEMPT_CHANGED"] + Array(RecoveryDeferral.codes).sorted() {
            driver.preparing()
            driver.postponed(RecoveryDeferral(code: code, reasons: []).errorDescription!)
            XCTAssertNil(driver.progress)
        }
        driver.retryExhausted("Agents stayed busy")
        XCTAssertEqual(messages.count, 8)
        XCTAssertEqual(activations, 0)
        XCTAssertNil(driver.progress)
    }
    #endif
}
