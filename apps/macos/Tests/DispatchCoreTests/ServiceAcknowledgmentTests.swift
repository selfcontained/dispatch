import XCTest
@testable import DispatchCore

final class ServiceAcknowledgmentTests: XCTestCase {
    func testRefreshSurvivesReadWriteRemoveInterleaving() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-request-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        for start in [true, false] {
            let original = ServiceRequest(start: start)
            try original.save(root: root)
            let path = root.appendingPathComponent("service-request.json")
            // Pause take() after reading A, publish refreshed B, then let the
            // consumer remove the pathname and acknowledge its snapshot A.
            let snapshot = try Data(contentsOf: path)
            let refreshed = original.refreshed(at: original.created.addingTimeInterval(1))
            try refreshed.save(root: root)
            XCTAssertGreaterThan(refreshed.created, original.created)
            try FileManager.default.removeItem(at: path)
            let consumed = try JSONDecoder().decode(ServiceRequest.self, from: snapshot)
            XCTAssertEqual(consumed.id, refreshed.id)
            XCTAssertEqual(consumed.start, refreshed.start)
            XCTAssertTrue(ServiceRuntime(phase: start ? "running" : "stopped", requestID: consumed.id).acknowledges(refreshed))
            XCTAssertNil(ServiceRequest.take(root: root))
        }
    }

    func testRestoreRequiresExactRequestAndPhase() {
        for start in [true, false] {
            let request = ServiceRequest(start: start)
            let phase = start ? "running" : "stopped"
            XCTAssertFalse(ServiceRuntime(phase: phase).acknowledges(request))
            XCTAssertFalse(ServiceRuntime(phase: phase, requestID: UUID()).acknowledges(request))
            XCTAssertFalse(ServiceRuntime(phase: "starting", requestID: request.id).acknowledges(request))
            XCTAssertTrue(ServiceRuntime(phase: phase, requestID: request.id).acknowledges(request))
        }
    }
}
