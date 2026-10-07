import Foundation
import DispatchCore
import XCTest

final class RecoveryReadinessTests: XCTestCase {
    func testHealthyUpdateFinishesWithoutAnObservationDelay() async throws {
        let start = Date()
        var polls = 0
        var sleeps = 0
        try await RecoveryProtocol.awaitReadiness(
            deadline: start.addingTimeInterval(180), workerRunning: { true }, menuReady: { true },
            serverReady: { polls += 1; return true }, now: { start }, wait: { sleeps += 1 })
        XCTAssertEqual(polls, 1)
        XCTAssertEqual(sleeps, 0)
    }

    func testWaitsForBothMenuAcknowledgmentAndAuthenticatedServerReadiness() async throws {
        let start = Date()
        var elapsed: TimeInterval = 0
        var serverPolls = 0
        try await RecoveryProtocol.awaitReadiness(
            deadline: start.addingTimeInterval(180), workerRunning: { true }, menuReady: { elapsed >= 2 },
            serverReady: { serverPolls += 1; return elapsed >= 3 },
            now: { start.addingTimeInterval(elapsed) }, wait: { elapsed += 1 })
        XCTAssertEqual(elapsed, 3)
        XCTAssertEqual(serverPolls, 2)
    }

    func testWorkerExitDuringReadinessCannotCommit() async {
        var running = true
        do {
            try await RecoveryProtocol.awaitReadiness(
                deadline: Date().addingTimeInterval(180), workerRunning: { running }, menuReady: { true },
                serverReady: { running = false; return true }, wait: { XCTFail("Exited worker must fail immediately") })
            XCTFail("An exited worker must fail readiness")
        } catch { XCTAssertTrue(error.localizedDescription.contains("exited before readiness")) }
    }

    func testExpiredDeadlineCannotBeOverriddenByALateReadinessResponse() async {
        let start = Date()
        var now = start
        do {
            try await RecoveryProtocol.awaitReadiness(
                deadline: start.addingTimeInterval(3), workerRunning: { true }, menuReady: { true },
                serverReady: { now = start.addingTimeInterval(4); return true }, now: { now },
                wait: { XCTFail("Deadline already expired") })
            XCTFail("Late readiness must not commit")
        } catch { XCTAssertTrue(error.localizedDescription.contains("failed write-fenced readiness")) }
    }

    func testNeverReadyAndMenuExitDuringProofRemainBounded() async {
        for menuExitsDuringProof in [false, true] {
            let start = Date()
            var elapsed: TimeInterval = 0
            var menuAlive = true
            do {
                try await RecoveryProtocol.awaitReadiness(
                    deadline: start.addingTimeInterval(3), workerRunning: { true }, menuReady: { menuAlive },
                    serverReady: {
                        if menuExitsDuringProof { menuAlive = false; return true }
                        return false
                    }, now: { start.addingTimeInterval(elapsed) }, wait: { elapsed += 1 })
                XCTFail("Missing readiness must not commit")
            } catch { XCTAssertTrue(error.localizedDescription.contains("failed write-fenced readiness")) }
            XCTAssertEqual(elapsed, 3)
        }
    }
}
