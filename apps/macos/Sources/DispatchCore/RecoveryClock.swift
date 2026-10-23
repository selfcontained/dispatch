import Foundation
import Darwin
import IOKit.pwr_mgt

public enum RecoveryClock {
    public static func awake() -> TimeInterval { Double(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)) / 1_000_000_000 }
}

public struct RecoveryDeadline {
    private var wall: Date
    private var uptime: TimeInterval
    public init(now: Date = Date(), awake: TimeInterval = RecoveryClock.awake()) { wall = now; uptime = awake }
    @discardableResult public mutating func rearm(_ deadline: inout Date, now: Date = Date(), awake: TimeInterval = RecoveryClock.awake()) -> Bool {
        let sleep = now.timeIntervalSince(wall) - max(0, awake - uptime)
        wall = now; uptime = awake
        guard sleep > 1 else { return false }
        deadline.addTimeInterval(sleep); return true
    }
}

public final class RecoverySleepAssertion {
    private var id = IOPMAssertionID(0)
    public init() throws {
        guard IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), "Dispatch protected update" as CFString, &id) == kIOReturnSuccess else {
            throw ConfigurationError("Cannot prevent idle sleep during update recovery.")
        }
    }
    deinit { IOPMAssertionRelease(id) }
}
