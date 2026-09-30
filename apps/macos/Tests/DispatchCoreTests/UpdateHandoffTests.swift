import Foundation
import XCTest
@testable import DispatchCore

@MainActor
final class UpdateHandoffTests: XCTestCase {
    enum Failure: Error { case disk, unregister, timeout }

    func testSaveFailureRetainsContinuationAndRetryFinishesSameInstallation() async throws {
        let handoff = UpdateHandoff()
        let intent = UpdateRecovery(wasRunning: true, targetBuild: "2")
        var resumed = 0
        var stops = 0
        handoff.begin(intent)
        handoff.postpone { resumed += 1 }
        do {
            try await handoff.prepare(save: { _ in throw Failure.disk }, stop: { stops += 1 })
            XCTFail("Expected save failure")
        } catch {}
        XCTAssertTrue(handoff.active)
        XCTAssertFalse(handoff.busy)
        XCTAssertFalse(handoff.prepared)
        XCTAssertEqual(stops, 0)
        handoff.resume()
        XCTAssertEqual(resumed, 0)
        // A second callback must not capture a different server state for this cycle.
        handoff.begin(UpdateRecovery(wasRunning: false, targetBuild: "3"))
        try await handoff.prepare(save: { XCTAssertEqual($0, intent) }, stop: { stops += 1 })
        handoff.resume(); handoff.resume()
        XCTAssertEqual(stops, 1)
        XCTAssertEqual(resumed, 1)
    }

    func testStopFailuresCanRetryWithoutRestoringOrLosingContinuation() async throws {
        for failure in [Failure.unregister, Failure.timeout] {
            let handoff = UpdateHandoff()
            var resumed = false
            handoff.begin(UpdateRecovery(wasRunning: false, targetBuild: "2"))
            handoff.postpone { resumed = true }
            do {
                try await handoff.prepare(save: { _ in }, stop: { throw failure })
                XCTFail("Expected stop failure")
            } catch {}
            XCTAssertTrue(handoff.active)
            XCTAssertFalse(handoff.busy)
            XCTAssertFalse(handoff.prepared)
            XCTAssertFalse(resumed)
            try await handoff.prepare(save: { _ in }, stop: {})
            handoff.resume()
            XCTAssertTrue(resumed)
        }
    }

    func testAbortRecoveryIsNotReplayedByLaterChecksOrLaunch() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-update-test-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let handoff = UpdateHandoff()
        let intent = UpdateRecovery(wasRunning: true, targetBuild: "2")
        var resumed = false
        handoff.begin(intent)
        handoff.postpone { resumed = true }
        try await handoff.prepare(save: { try $0.save(root: root) }, stop: {})
        XCTAssertTrue(handoff.abort())
        handoff.resume()
        XCTAssertFalse(resumed)
        let restore = ServiceRequest(start: true)
        XCTAssertFalse(try intent.completeRestoration(root: root, installedBuild: "1", request: restore,
            runtime: ServiceRuntime(phase: "running", requestID: restore.id), healthy: true))
        // The user stops the restored old build. Neither unrelated abort nor relaunch
        // supplies any pending state that could overwrite that later decision.
        let userStop = ServiceRequest(start: false)
        try userStop.save(root: root)
        XCTAssertFalse(handoff.abort())
        XCTAssertNil(try UpdateRecovery.read(root: root))
        XCTAssertEqual(try ServiceRequest.take(root: root)?.id, userStop.id)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("app-update-history.json").path))
    }
}
