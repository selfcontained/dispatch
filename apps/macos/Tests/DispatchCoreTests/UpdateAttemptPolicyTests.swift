import Foundation
import XCTest
@testable import DispatchCore

final class UpdateAttemptPolicyTests: XCTestCase {
    private func state(running: Bool = true) -> UpdateAttemptState {
        UpdateAttemptState(intent: UpdateRecovery(wasRunning: running, targetBuild: "2"),
            journal: NativeRecoveryJournal(instanceID: "test", appPath: "/tmp/Test.app", oldBuild: "1", targetBuild: "2", targetIdentity: "signed", wasRunning: running),
            running: running, active: true, recoveryLocked: false)
    }

    @MainActor
    func testAutomaticBusyAndFailuresNeverAdvance() async throws {
        let policy = UpdateAttemptPolicy() // unknown resume is conservative
        let expected = state()
        for busy in [true, false] {
            var advanced = false
            do {
                try await policy.preflight(expected: expected, activity: {
                    if busy { return true }
                    throw URLError(.timedOut)
                }, current: { expected })
                advanced = true
            } catch { XCTAssertTrue(error is RecoveryDeferral) }
            XCTAssertFalse(advanced)
        }
    }

    @MainActor
    func testIdleIsAdvisoryAndStateMustStillMatchAfterAwait() async throws {
        let policy = UpdateAttemptPolicy()
        let expected = state()
        let changes: [(inout UpdateAttemptState) -> Void] = [
            { $0.active = false },
            { $0.journal?.id = "replaced-transaction" },
            { $0.journal?.targetIdentity = "other-artifact" },
            { $0.intent = UpdateRecovery(wasRunning: true, targetBuild: "3") },
            { $0.running = false },
            { $0.recoveryLocked = true },
            { $0.generation = UUID() }, // cycle completed/aborted during await
        ]
        for change in changes {
            var current = expected
            do {
                try await policy.preflight(expected: expected, activity: {
                    await Task.yield()
                    change(&current)
                    return false
                }, current: { current })
                XCTFail("Changed attempt must not reach the fence")
            } catch { XCTAssertEqual((error as? RecoveryDeferral)?.code, "ATTEMPT_CHANGED") }
        }
        try await policy.preflight(expected: expected, activity: { false }, current: { expected })
        let cancelled = Task { @MainActor in
            withUnsafeCurrentTask { $0?.cancel() }
            try await policy.preflight(expected: expected, activity: { false }, current: { expected })
        }
        do { try await cancelled.value; XCTFail("Cancelled attempt advanced") } catch {}
    }

    @MainActor
    func testExplicitOriginEndsAndDeferredRetriesAreAutomatic() async throws {
        var policy = UpdateAttemptPolicy()
        let expected = state()
        policy.begin(background: true, remoteInstall: true)
        XCTAssertTrue(policy.explicit)
        try await policy.preflight(expected: expected, activity: { XCTFail("Remote install is explicit"); return true }, current: { expected })
        policy.end()
        XCTAssertFalse(policy.explicit)
        policy.begin(background: true, remoteInstall: false)
        XCTAssertFalse(policy.explicit)
        policy.begin(background: false, remoteInstall: false)
        XCTAssertTrue(policy.explicit)
        policy.end()
        policy.userInstall()
        XCTAssertTrue(policy.explicit)
        policy.end()
        // No activity read for a deliberately stopped service: the caller still
        // runs the existing transaction-authenticated private readiness boundary.
        let stopped = state(running: false)
        try await policy.preflight(expected: stopped, activity: { XCTFail("Stopped path must not infer idle from failed network"); return true }, current: { stopped })
    }

    @MainActor
    func testCompletionAndAbortInvalidateOutstandingPreflight() async throws {
        for _ in 0..<2 { // completion and abort both call end()
            var policy = UpdateAttemptPolicy()
            var expected = state()
            expected.generation = policy.generation
            let readingPolicy = policy
            do {
                try await readingPolicy.preflight(expected: expected, activity: {
                    await Task.yield()
                    policy.end()
                    return false
                }, current: {
                    var value = expected; value.generation = policy.generation; return value
                })
                XCTFail("A completed or aborted cycle must not reach the fence")
            } catch { XCTAssertEqual((error as? RecoveryDeferral)?.code, "ATTEMPT_CHANGED") }
            policy.begin(background: true, remoteInstall: false)
            XCTAssertFalse(policy.explicit)
            XCTAssertNotEqual(policy.generation, expected.generation)
        }
    }

    func testDuplicateCallbacksLockedSessionsAndStaleTimers() throws {
        var schedule = UpdateDeferralSchedule()
        let now = Date(timeIntervalSince1970: 0)
        let first = try XCTUnwrap(schedule.schedule(after: now))
        XCTAssertEqual(schedule.schedule(after: now), first) // completion + withdrawal
        XCTAssertEqual(schedule.attempts, 1)
        for _ in 0..<20 {
            XCTAssertFalse(schedule.claim(first.id, eligible: false, now: now)) // busy/recovery/session
            XCTAssertEqual(schedule.schedule(after: now)?.id, first.id)
        }
        XCTAssertEqual(schedule.attempts, 1)
        XCTAssertTrue(schedule.claim(first.id, eligible: true, now: now))
        let second = try XCTUnwrap(schedule.schedule(after: now))
        XCTAssertFalse(schedule.claim(first.id, eligible: true, now: now))
        XCTAssertEqual(schedule.pending, second)
        for _ in 2...UpdateDeferralSchedule.maxAttempts {
            let pending = try XCTUnwrap(schedule.pending)
            XCTAssertTrue(schedule.claim(pending.id, eligible: true, now: now))
            _ = schedule.schedule(after: now)
        }
        XCTAssertNil(schedule.pending)
        XCTAssertEqual(schedule.attempts, UpdateDeferralSchedule.maxAttempts)
        schedule = UpdateDeferralSchedule() // clear/cancel or fresh hourly cycle
        XCTAssertFalse(schedule.claim(second.id, eligible: true, now: now))
        XCTAssertNotNil(schedule.schedule(after: now))
    }
}
