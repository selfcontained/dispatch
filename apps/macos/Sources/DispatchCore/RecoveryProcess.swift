import Foundation
import Darwin

/// PID plus kernel start time and executable path, so recovery never signals a
/// reused PID or a different installation. Only explicitly enrolled children/menu
/// processes write these private records; process-name scans are never used.
public struct RecoveryProcess: Codable {
    public let transactionId: String
    public let build: String
    public let pid: Int32
    public let startedSeconds: UInt64
    public let startedMicroseconds: UInt64
    public let executable: String
    public static func current(transaction: NativeRecoveryJournal, build: String) throws -> Self {
        var info = proc_bsdinfo()
        guard proc_pidinfo(getpid(), PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) > 0,
              let path = path(getpid()) else { throw ConfigurationError("Cannot establish recovery process identity.") }
        return Self(transactionId: transaction.id, build: build, pid: getpid(), startedSeconds: info.pbi_start_tvsec, startedMicroseconds: info.pbi_start_tvusec, executable: path)
    }
    private static func path(_ pid: Int32) -> String? {
        var buffer = [CChar](repeating: 0, count: 4096)
        guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
        return String(cString: buffer)
    }
    public var identity: ProcessIdentity { ProcessIdentity(pid: pid, startedSeconds: startedSeconds, startedMicroseconds: startedMicroseconds, executable: executable) }
    public var matches: Bool {
        var info = proc_bsdinfo()
        return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) > 0 && info.pbi_start_tvsec == startedSeconds && info.pbi_start_tvusec == startedMicroseconds && Self.path(pid) == executable
    }
    public func stop(expectedExecutable: URL, transaction: NativeRecoveryJournal) throws {
        guard transactionId == transaction.id, executable == expectedExecutable.path else { throw ConfigurationError("Recovery process identity does not match this installation.") }
        guard matches else { return }
        guard kill(pid, SIGTERM) == 0 else { throw ConfigurationError("Cannot stop the recovery process.") }
        let deadline = Date(timeIntervalSinceNow: 55)
        while matches && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        guard !matches else { throw ConfigurationError("The recovery process did not stop; automatic restoration is blocked.") }
    }
}

/// Kernel start time plus executable path: a reused PID never matches.
public struct ProcessIdentity: Codable, Equatable {
    public let pid: Int32
    public let startedSeconds: UInt64
    public let startedMicroseconds: UInt64
    public let executable: String
    public static func live(_ pid: Int32) -> Self? {
        var info = proc_bsdinfo()
        var buffer = [CChar](repeating: 0, count: 4096)
        guard pid > 0, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) > 0,
              proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
        return Self(pid: pid, startedSeconds: info.pbi_start_tvsec, startedMicroseconds: info.pbi_start_tvusec, executable: String(cString: buffer))
    }
}
