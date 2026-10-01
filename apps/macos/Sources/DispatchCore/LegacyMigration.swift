import Darwin
import Foundation

/// Moves a pre-release installation (`~/.dispatch-mac-preview`, role `dispatch_preview`)
/// to the release identity. Agent hosts keep running throughout: the folder is renamed in
/// place, so their sockets move with it, and the old path stays as a symlink for the
/// absolute paths they and the database still hold. Each step is safe to repeat.
public struct LegacyMigration: Sendable {
    public let legacy: URL
    public let root: URL
    private struct Marker: Codable { let wasRunning: Bool }
    private var marker: URL { root.appendingPathComponent("legacy-migration.json") }
    private var legacyMarker: URL { legacy.appendingPathComponent("legacy-migration.json") }

    public init(legacy: URL = AppPaths.legacyRoot, root: URL = AppPaths.root) {
        self.legacy = legacy; self.root = root
    }

    /// The old folder still holds data and the new one is absent, or an earlier run stopped partway.
    public var pending: Bool {
        (isDirectory(legacy) && !FileManager.default.fileExists(atPath: root.path))
            || FileManager.default.fileExists(atPath: marker.path)
    }

    /// Whether the old service's lease and managed database have both been released.
    public static func serviceStopped(root: URL) -> Bool {
        if FileManager.default.fileExists(atPath: root.appendingPathComponent("postgres/postmaster.pid").path) { return false }
        let file = root.appendingPathComponent("service.lock")
        if !FileManager.default.fileExists(atPath: file.path) { return true }
        let fd = open(file.path, O_RDWR | O_CLOEXEC | O_NOFOLLOW)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        return flock(fd, LOCK_EX | LOCK_NB) == 0
    }

    /// Returns whether the old server was running, so the caller can restore that state.
    /// `stopService` must stop the old service before returning; the move does not start
    /// until it succeeds. `renameDatabase` returns the managed URL once renamed, or nil.
    public func run(wasRunning: Bool, stopService: (URL) throws -> Void, renameDatabase: (URL) throws -> String?) throws -> Bool {
        if !FileManager.default.fileExists(atPath: root.path) {
            // Record intent before stopping anything, so a retry restores the original state.
            if !FileManager.default.fileExists(atPath: legacyMarker.path) {
                try writePrivateJSON(Marker(wasRunning: wasRunning), to: legacyMarker)
            }
            try stopService(legacy)
            try FileManager.default.createDirectory(at: root.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: legacy, to: root)
        }
        if (try? FileManager.default.destinationOfSymbolicLink(atPath: legacy.path)) == nil && !FileManager.default.fileExists(atPath: legacy.path) {
            try FileManager.default.createSymbolicLink(at: legacy, withDestinationURL: root)
        }
        _ = try renameDatabase(root)
        // configuration.json repeats the managed URL; local-database.json is canonical.
        let configurationURL = root.appendingPathComponent("configuration.json")
        if var configuration = try? JSONDecoder().decode(Configuration.self, from: Data(contentsOf: configurationURL)),
           configuration.usesManagedDatabase,
           let local = try? Configuration.read(from: root.appendingPathComponent("local-database.json")),
           configuration.databaseURL != local.databaseURL {
            configuration.databaseURL = local.databaseURL
            try configuration.save(to: configurationURL)
        }
        let recorded = (try? JSONDecoder().decode(Marker.self, from: Data(contentsOf: marker)))?.wasRunning ?? wasRunning
        try? FileManager.default.removeItem(at: marker)
        return recorded
    }

    private func isDirectory(_ url: URL) -> Bool {
        guard let values = try? url.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey]) else { return false }
        return values.isDirectory == true && values.isSymbolicLink != true
    }
}
