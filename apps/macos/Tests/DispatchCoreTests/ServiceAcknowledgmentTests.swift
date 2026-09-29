import XCTest
@testable import DispatchCore

final class ServiceAcknowledgmentTests: XCTestCase {
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
