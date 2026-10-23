import Foundation
import Darwin
import IOKit.pwr_mgt

public enum RecoveryClock {
    public static func awake() -> TimeInterval { Double(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1_000_000_000 }
    /// Monotonic and counts sleep; wall-clock corrections never move it.
    public static func continuous() -> TimeInterval { Double(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)) / 1_000_000_000 }
}

/// Sleep is continuous minus awake time, so only real suspension extends a deadline.
public struct RecoveryDeadline {
    private var monotonic: TimeInterval
    private var uptime: TimeInterval
    public init(continuous: TimeInterval = RecoveryClock.continuous(), awake: TimeInterval = RecoveryClock.awake()) { monotonic = continuous; uptime = awake }
    @discardableResult public mutating func rearm(_ deadline: inout Date, continuous: TimeInterval = RecoveryClock.continuous(), awake: TimeInterval = RecoveryClock.awake()) -> Bool {
        let sleep = max(0, continuous - monotonic) - max(0, awake - uptime)
        monotonic = continuous; uptime = awake
        guard sleep > 1 else { return false }
        deadline.addTimeInterval(sleep); return true
    }
}

/// Best effort: awake-time bounds keep recovery correct across sleep, so a refused
/// assertion never blocks or strands a transaction.
public final class RecoverySleepAssertion {
    private var id = IOPMAssertionID(0)
    private let held: Bool
    public init() {
        held = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), "Dispatch protected update" as CFString, &id) == kIOReturnSuccess
    }
    deinit { if held { IOPMAssertionRelease(id) } }
}
