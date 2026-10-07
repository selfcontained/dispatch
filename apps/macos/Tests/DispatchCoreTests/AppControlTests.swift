import Foundation
import XCTest
@testable import DispatchCore

final class AppControlTests: XCTestCase {
    func testTokenIsFreshPerLaunchAndPrivate() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-control-test-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let first = try AppControlToken.create(root: root)
        XCTAssertEqual(first.count, 64)
        XCTAssertEqual(AppControlToken.read(root: root), first)
        let attributes = try FileManager.default.attributesOfItem(atPath: AppControlToken.path(root: root).path)
        XCTAssertEqual(attributes[.posixPermissions] as? Int, 0o600)
        let second = try AppControlToken.create(root: root)
        XCTAssertNotEqual(first, second)
        XCTAssertEqual(AppControlToken.read(root: root), second)
    }
    func testStateSendsEveryFieldWithExplicitNulls() throws {
        let state = AppUpdateState(version: "1.0.1", phase: .idle, availableVersion: nil, checkedAt: nil, error: nil, automatic: false)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: state.encoded()) as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["version", "phase", "availableVersion", "checkedAt", "error", "automatic"])
        XCTAssertTrue(body["availableVersion"] is NSNull)
        XCTAssertTrue(body["checkedAt"] is NSNull)
        XCTAssertEqual(body["phase"] as? String, "idle")

        let checked = Date(timeIntervalSince1970: 1_790_000_000)
        let found = AppUpdateState(version: "1.0.1", phase: .error, availableVersion: "1.0.2", checkedAt: checked, error: "Offline", automatic: true)
        let foundBody = try XCTUnwrap(JSONSerialization.jsonObject(with: found.encoded()) as? [String: Any])
        XCTAssertEqual(foundBody["availableVersion"] as? String, "1.0.2")
        XCTAssertEqual(foundBody["checkedAt"] as? String, checked.ISO8601Format())
        XCTAssertEqual(foundBody["error"] as? String, "Offline")
    }
    /// Reports fired back to back (checking, then idle) must not overlap, and the
    /// last one sent must carry the final state.
    @MainActor
    func testSenderNeverOverlapsAndEndsOnLatestState() async throws {
        var current = "checking"
        var sent: [String] = []
        var inFlight = 0
        var maxInFlight = 0
        let sender = LatestOnlySender {
            inFlight += 1; maxInFlight = max(maxInFlight, inFlight)
            let value = current
            try? await Task.sleep(for: .milliseconds(20))
            sent.append(value)
            inFlight -= 1
        }
        sender.request()
        while inFlight == 0 { await Task.yield() }
        current = "idle"; sender.request()
        sender.request()
        for _ in 0..<100 where sent.last != "idle" || inFlight > 0 { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(maxInFlight, 1)
        XCTAssertEqual(sent.last, "idle")
        // The two requests made during the first send collapse into one.
        XCTAssertEqual(sent.count, 2)
    }
    func testParsesControlStreamLines() {
        XCTAssertEqual(AppControlEvent(line: #"data: {"type":"ready"}"#), .ready)
        XCTAssertEqual(AppControlEvent(line: #"data: {"type":"command","id":"x","action":"install"}"#), .command("install"))
        XCTAssertNil(AppControlEvent(line: ": keepalive"))
        XCTAssertNil(AppControlEvent(line: ""))
        XCTAssertNil(AppControlEvent(line: #"data: {"type":"command"}"#))
        XCTAssertNil(AppControlEvent(line: #"data: {"type":"other"}"#))
        XCTAssertNil(AppControlEvent(line: "data: not json"))
    }
}
