import Foundation
import XCTest
@testable import DispatchCore

final class UpdateRecoveryTests: XCTestCase {
    func testConfirmationRequiresExactRequestTargetAndHealth() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-update-test-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let state = UpdateRecovery(wasRunning: true, targetBuild: "123.1")
        try state.save(root: root)
        XCTAssertEqual(try UpdateRecovery.read(root: root), state)
        let request = ServiceRequest(start: true)
        let runtime = ServiceRuntime(phase: "running", requestID: request.id)
        XCTAssertThrowsError(try state.completeRestoration(root: root, installedBuild: "123.1", request: request, runtime: runtime, healthy: false))
        XCTAssertThrowsError(try state.completeRestoration(root: root, installedBuild: "123.1", request: request, runtime: ServiceRuntime(phase: "running", requestID: UUID()), healthy: true))
        XCTAssertEqual(try UpdateRecovery.read(root: root), state)
        XCTAssertTrue(try state.completeRestoration(root: root, installedBuild: "123.1", request: request, runtime: runtime, healthy: true))
        XCTAssertNil(try UpdateRecovery.read(root: root))
    }
    func testStoppedIntentRequiresStoppedAcknowledgment() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-update-test-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let state = UpdateRecovery(wasRunning: false, targetBuild: "2")
        try state.save(root: root)
        let wrong = ServiceRequest(start: true)
        XCTAssertThrowsError(try state.completeRestoration(root: root, installedBuild: "2", request: wrong, runtime: ServiceRuntime(phase: "running", requestID: wrong.id), healthy: true))
        let right = ServiceRequest(start: false)
        XCTAssertTrue(try state.completeRestoration(root: root, installedBuild: "2", request: right, runtime: ServiceRuntime(phase: "stopped", requestID: right.id), healthy: false))
    }
    func testInvalidRecoveryRecordIsNotSilentlyDiscarded() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-update-test-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("{}".utf8).write(to: UpdateRecovery.path(root: root))
        XCTAssertThrowsError(try UpdateRecovery.read(root: root))
        XCTAssertTrue(FileManager.default.fileExists(atPath: UpdateRecovery.path(root: root).path))
    }
}
