import Foundation

/// One live Sparkle installation, including its postponed continuation. Recovery on disk
/// is separate: it can outlive this process, but must not identify a later update check.
@MainActor
public final class UpdateHandoff {
    public private(set) var intent: UpdateRecovery?
    public private(set) var active = false
    public private(set) var busy = false
    public private(set) var prepared = false
    private var continuation: (() -> Void)?

    public init() {}
    public func begin(_ value: UpdateRecovery) {
        guard !active else { return }
        intent = value; active = true; prepared = false
    }
    public func postpone(_ handler: @escaping () -> Void) { continuation = handler }
    public func prepare(save: (UpdateRecovery) throws -> Void, stop: () async throws -> Void) async throws {
        guard active, let intent else { throw ConfigurationError("No update installation is pending.") }
        guard !busy else { throw ConfigurationError("The update handoff is already in progress.") }
        if prepared { return }
        busy = true
        defer { busy = false }
        // Retain intent and continuation on either failure so Retry finishes this same cycle.
        try save(intent)
        try await stop()
        prepared = true
    }
    public func resume() {
        guard active, prepared, let handler = continuation else { return }
        continuation = nil
        handler()
    }
    @discardableResult
    public func abort() -> Bool {
        guard active else { return false }
        active = false; prepared = false; continuation = nil
        return true
    }
}
