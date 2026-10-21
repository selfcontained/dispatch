import Foundation

extension NativeRecoveryStore {
    /// Recovery copies exist only for an unfinished update. Once the service handoff
    /// is handled, discard terminal transactions, including the current backup. Keep
    /// the root journal/quarantine receipts; unknown or unfinished data is not pruned.
    @discardableResult
    public func pruneHistory() throws -> Int {
        try initialize()
        let lease = try RecoveryLease(directory.appendingPathComponent("transaction.lock"))
        defer { withExtendedLifetime(lease) {} }
        guard let current = try read(), current.terminal,
              handoff(for: current)?.handled == true else { return 0 }
        var removed = 0
        var deferred = false
        for url in try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            guard UUID(uuidString: url.lastPathComponent) != nil else { continue }
            do {
                guard try fm.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType == .typeDirectory else { continue }
                let manifest = url.appendingPathComponent("manifest.json")
                guard let attrs = try? fm.attributesOfItem(atPath: manifest.path),
                      attrs[.type] as? FileAttributeType == .typeRegular,
                      (attrs[.size] as? NSNumber)?.intValue ?? Int.max <= 1024 * 1024,
                      let data = try? Data(contentsOf: manifest),
                      let journal = try? JSONDecoder().decode(NativeRecoveryJournal.self, from: data),
                      journal.id == url.lastPathComponent, journal.instanceID == current.instanceID,
                      journal.appPath == current.appPath, journal.terminal else { continue }
                // A completed rollback no longer needs either displaced copy. Remove the
                // manifest last so an interrupted cleanup can discover and retry the rest.
                for artifact in [directory.appendingPathComponent("failed-state-" + journal.id),
                                 URL(fileURLWithPath: journal.appPath + ".failed-" + journal.id)] {
                    if fm.fileExists(atPath: artifact.path) { try fm.removeItem(at: artifact) }
                }
                for child in try fm.contentsOfDirectory(at: url, includingPropertiesForKeys: nil) where child.lastPathComponent != "manifest.json" {
                    try fm.removeItem(at: child)
                }
                try fm.removeItem(at: manifest)
                try fm.removeItem(at: url)
                removed += 1
            } catch { deferred = true }
        }
        if deferred { throw ConfigurationError("Some completed update artifacts could not be removed; cleanup will retry.") }
        return removed
    }
}

/// Sparkle normally removes its installer workspace on exit. Dispatch may have to
/// boot out that installer to defer a busy update, bypassing its normal exit path.
/// Clean only the Installation workspace, while the updater is idle and launchd
/// proves neither installer nor progress agent exists. Never touch resumable data.
public struct SparkleInstallationCache {
    public let directory: URL
    public init(caches: URL, bundleIdentifier: String) throws {
        guard !bundleIdentifier.isEmpty, bundleIdentifier != ".", bundleIdentifier != "..",
              !bundleIdentifier.contains("/"), !bundleIdentifier.hasSuffix(".app") else {
            throw ConfigurationError("Invalid updater cache identifier.")
        }
        directory = caches.appendingPathComponent(bundleIdentifier, isDirectory: true)
            .appendingPathComponent("org.sparkle-project.Sparkle/Installation", isDirectory: true)
    }
    @discardableResult
    public func prune(installerAbsent: () -> Bool) throws -> Int {
        let fm = FileManager.default
        guard directory.resolvingSymlinksInPath() == directory.standardizedFileURL else {
            throw ConfigurationError("Updater cache paths cannot contain symbolic links.")
        }
        guard installerAbsent(), fm.fileExists(atPath: directory.path) else { return 0 }
        let started = Date()
        var removed = 0
        for url in try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            let attrs = try fm.attributesOfItem(atPath: url.path)
            guard attrs[.type] as? FileAttributeType == .typeDirectory,
                  let modified = attrs[.modificationDate] as? Date, modified <= started else { continue }
            // Recheck before every removal; an unknown launchctl result is not absence.
            guard installerAbsent() else { break }
            try fm.removeItem(at: url)
            removed += 1
        }
        return removed
    }
}
