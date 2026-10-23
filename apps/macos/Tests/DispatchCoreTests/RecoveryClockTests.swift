import Foundation
import XCTest
@testable import DispatchCore

final class RecoveryClockTests: XCTestCase {
    func testWorkerLogIsPrivateBoundedAndTruncatedPerRun() throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-probation-\(UUID().uuidString).log")
        defer { try? FileManager.default.removeItem(at: path) }
        let log = try RecoveryWorkerLog(url: path)
        try log.pipe.fileHandleForWriting.write(contentsOf: Data(repeating: 65, count: 2 * 1024 * 1024))
        log.close()
        XCTAssertEqual(try Data(contentsOf: path).count, 1024 * 1024)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: path.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        let next = try RecoveryWorkerLog(url: path)
        try next.pipe.fileHandleForWriting.write(contentsOf: Data("next run".utf8))
        next.close()
        XCTAssertEqual(try String(contentsOf: path), "next run")
    }
    func testToolTimeoutIsDistinctFromNonzeroExit() throws {
        XCTAssertThrowsError(try RecoveryCommand.run(URL(fileURLWithPath: "/bin/sleep"), ["5"], timeout: 0.05)) {
            XCTAssertTrue($0 is RecoveryCommandTimeout)
        }
        XCTAssertThrowsError(try RecoveryCommand.run(URL(fileURLWithPath: "/usr/bin/false"), [])) {
            XCTAssertFalse($0 is RecoveryCommandTimeout)
        }
    }
    func testToolBoundUsesInjectedAwakeClock() throws {
        var elapsed: TimeInterval = 0
        XCTAssertThrowsError(try RecoveryCommand.run(URL(fileURLWithPath: "/bin/sleep"), ["5"], timeout: 2, awake: { elapsed += 1; return elapsed })) {
            XCTAssertTrue($0 is RecoveryCommandTimeout)
        }
    }
    func testDeadlineAddsOnlySleepAndCanPersistExtension() throws {
        let start = Date(timeIntervalSince1970: 1000)
        var tracker = RecoveryDeadline(continuous: 10, awake: 10)
        var deadline = start.addingTimeInterval(180)
        XCTAssertFalse(tracker.rearm(&deadline, continuous: 15, awake: 15))
        XCTAssertTrue(tracker.rearm(&deadline, continuous: 3616, awake: 16))
        XCTAssertEqual(deadline, start.addingTimeInterval(3780))
        XCTAssertFalse(tracker.rearm(&deadline, continuous: 3617, awake: 17))
    }
    func testWallClockCorrectionsNeverExtendDeadline() {
        // The deadline tracker never reads the wall clock: forward then backward corrections
        // while awake leave the persisted bound unchanged.
        let start = Date(timeIntervalSince1970: 1000)
        var tracker = RecoveryDeadline(continuous: 0, awake: 0)
        var deadline = start.addingTimeInterval(180)
        XCTAssertFalse(tracker.rearm(&deadline, continuous: 1, awake: 1))
        XCTAssertFalse(tracker.rearm(&deadline, continuous: 2, awake: 2))
        XCTAssertEqual(deadline, start.addingTimeInterval(180))
        var watch = HelperWatch()
        let bound = start.addingTimeInterval(180)
        XCTAssertEqual(watch.decide(now: start, deadline: bound, helperAlive: true, continuous: 0, awake: 0), .wait)
        XCTAssertEqual(watch.decide(now: start.addingTimeInterval(3601), deadline: bound, helperAlive: true, continuous: 1, awake: 1), .fail, "A forward wall correction is not sleep")
    }
    func testHelperWatchToleratesSleepBeforeJournalExtensionWithoutCountingItTwice() {
        let start = Date(timeIntervalSince1970: 1000)
        var watch = HelperWatch()
        let deadline = start.addingTimeInterval(180)
        XCTAssertEqual(watch.decide(now: start, deadline: deadline, helperAlive: true, continuous: 0, awake: 0), .wait)
        XCTAssertEqual(watch.decide(now: start.addingTimeInterval(3601), deadline: deadline, helperAlive: true, continuous: 3601, awake: 1), .wait)
        XCTAssertEqual(watch.decide(now: start.addingTimeInterval(3602), deadline: deadline.addingTimeInterval(3600), helperAlive: true, continuous: 3602, awake: 2), .wait)
        XCTAssertEqual(watch.decide(now: start.addingTimeInterval(3900), deadline: deadline.addingTimeInterval(3600), helperAlive: true, continuous: 3900, awake: 300), .fail)
    }
    func testReadinessRearmsAndReportsPersistableDeadlineAcrossSleep() async throws {
        let start = Date(timeIntervalSince1970: 1000)
        var wall: TimeInterval = 0
        var awake: TimeInterval = 0
        var saved: Date?
        try await RecoveryProtocol.awaitReadiness(deadline: start.addingTimeInterval(180), workerRunning: { true }, menuReady: { wall > 0 }, serverReady: { true }, now: { start.addingTimeInterval(wall) }, continuous: { wall }, awake: { awake }, rearmed: { saved = $0 }, wait: { wall = 3601; awake = 1 })
        XCTAssertEqual(saved, start.addingTimeInterval(3780))
    }
    func testOnlyDarkWakeHoldsBackgroundUpdates() {
        XCTAssertFalse(SystemPower.inDarkWake(15), "Full wake, including a sleeping display in clamshell mode")
        XCTAssertFalse(SystemPower.inDarkWake(0x03))
        XCTAssertTrue(SystemPower.inDarkWake(0x09), "Maintenance DarkWake: CPU and network without graphics")
        XCTAssertTrue(SystemPower.inDarkWake(0x01))
        XCTAssertFalse(SystemPower.inDarkWake(nil), "Unknown capabilities never hold an update")
        XCTAssertFalse(SystemPower.inDarkWake(0))
        XCTAssertNotNil(SystemPower.capabilities())
        XCTAssertFalse(SystemPower.inDarkWake(), "The test host is fully awake")
    }
}
