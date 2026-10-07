import ServiceManagement
import XCTest
@testable import DispatchMenu

final class ServiceRegistrationTests: XCTestCase {
    func testFreshAndUnregisteredServicesNeedRegistration() {
        XCTAssertTrue(SMAppService.Status.notFound.needsRegistration)
        XCTAssertTrue(SMAppService.Status.notRegistered.needsRegistration)
        XCTAssertFalse(SMAppService.Status.enabled.needsRegistration)
        XCTAssertFalse(SMAppService.Status.requiresApproval.needsRegistration)
    }
}
