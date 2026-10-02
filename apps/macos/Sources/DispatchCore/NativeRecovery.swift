import Foundation
import Darwin
import CryptoKit

/// Kept beside, never inside, the mutable instance directory or replaceable app.
/// Phase owners: the menu writes `preparing` → `backedUp` → `activating` and may abort
/// only from `preparing`/`backedUp` (`abortPreparation`); the retained helper writes
/// every later phase (probation, commit, restore, rollback, expiry abort). Service
/// intent completion is recorded only through the handoff record (`RecoveryHandoff.swift`).
public struct NativeRecoveryJournal: Codable, Equatable {
    public enum Phase: String, Codable { case staged, preparing, backedUp, activating, probation, committed, restoring, rolledBack, aborted, recoveryRequired }
    public var id: String
    public var nonce: String
    public var instanceID: String
    public var appPath: String
    public var oldBuild: String
    public var targetBuild: String
    public var targetIdentity: String
    public var wasRunning: Bool
    public var phase: Phase = .preparing
    public var deadline: Date
    public var error: String?
    public var appDigest: String?
    public var stateDigest: String?
    public var restoreStarted = false
    public var restoredApp = false
    public var restoredState = false
    public var rollbackProbationStarted = false
    public var menuBuild: String?
    /// When Sparkle was allowed to stage this target. Database-open evidence after this
    /// moment from the target build forbids an app-only rollback.
    public var stagedAt: Date?
    /// Set when Sparkle installed the target while the menu was gone and the helper put
    /// the old app back. Not a failed trial: no quarantine, no preference replay, and the
    /// same artifact may be offered again.
    public var interruptedInstall: Bool?
    /// The authenticated feed declaration accepted when this target was staged.
    public var declaredProtocol: Int?
    public var terminal: Bool { [.committed, .rolledBack, .aborted].contains(phase) }
    /// The startup gate. While Sparkle may install the target (`staged`), the old build
    /// keeps running ordinarily and every other build is fenced. Protocol 1 builds honor
    /// this before opening PostgreSQL; any other phase admits only nonce-bearing workers.
    public func permitsOrdinaryStart(build: String) -> Bool { terminal || (phase == .staged && build == oldBuild) }
    public init(instanceID: String, appPath: String, oldBuild: String, targetBuild: String, targetIdentity: String, wasRunning: Bool) {
        id = UUID().uuidString; nonce = UUID().uuidString
        self.instanceID = instanceID; self.appPath = appPath; self.oldBuild = oldBuild
        self.targetBuild = targetBuild; self.targetIdentity = targetIdentity; self.wasRunning = wasRunning
        deadline = Date(timeIntervalSinceNow: 1800)
    }
}

public final class RecoveryLease {
    private let fd: Int32
    public init(_ path: URL) throws {
        fd = open(path.path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw ConfigurationError("Cannot open recovery lock.") }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            close(fd); throw ConfigurationError("Dispatch recovery is already in use.")
        }
    }
    deinit { close(fd) }
}

public enum RecoveryCommand {
    /// Output goes to a private file, avoiding pipe-buffer deadlocks. Never include
    /// credentials in arguments or exception text. All external tools are bounded.
    @discardableResult public static func run(_ executable: URL, _ args: [String], environment: [String: String] = [:], timeout: TimeInterval = 120) throws -> String {
        let (status, output) = try execute(executable, args, environment: environment, timeout: timeout)
        guard status == 0 else { throw ConfigurationError("Recovery tool \(executable.lastPathComponent) failed or timed out. Recovery copies were retained.") }
        return output
    }
    /// For tools whose specific exit status is the answer. A launch failure reports -1.
    public static func status(_ executable: URL, _ args: [String], timeout: TimeInterval = 120) -> (Int32, String) {
        (try? execute(executable, args, environment: [:], timeout: timeout)) ?? (-1, "")
    }
    private static func execute(_ executable: URL, _ args: [String], environment: [String: String], timeout: TimeInterval) throws -> (Int32, String) {
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-recovery-\(UUID().uuidString)")
        guard FileManager.default.createFile(atPath: output.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw ConfigurationError("Cannot create recovery tool output.") }
        defer { try? FileManager.default.removeItem(at: output) }
        let handle = try FileHandle(forWritingTo: output)
        defer { try? handle.close() }
        let process = Process(); process.executableURL = executable; process.arguments = args
        process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": FileManager.default.homeDirectoryForCurrentUser.path, "LC_ALL": "C"].merging(environment) { _, value in value }
        process.standardInput = FileHandle.nullDevice; process.standardOutput = handle; process.standardError = handle
        try process.run()
        let deadline = Date(timeIntervalSinceNow: timeout)
        while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        if process.isRunning { process.terminate(); Thread.sleep(forTimeInterval: 0.2); if process.isRunning { kill(process.processIdentifier, SIGKILL) } }
        process.waitUntilExit()
        // A timed-out tool was signaled, so its status is never a meaningful exit code.
        return (process.terminationReason == .uncaughtSignal ? -1 : process.terminationStatus, String(decoding: try Data(contentsOf: output), as: UTF8.self))
    }
}

public final class NativeRecoveryStore {
    public let root: URL
    public let directory: URL
    public let fm = FileManager.default
    public var journalURL: URL { directory.appendingPathComponent("journal.json") }
    public init(root: URL) {
        self.root = root.standardizedFileURL
        directory = root.deletingLastPathComponent().appendingPathComponent(root.lastPathComponent + "-recovery", isDirectory: true)
    }
    public func initialize() throws {
        guard root.resolvingSymlinksInPath().path == root.standardizedFileURL.path,
              directory.resolvingSymlinksInPath().path == directory.standardizedFileURL.path else { throw ConfigurationError("Recovery paths cannot contain symbolic links.") }
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    }
    public func read() throws -> NativeRecoveryJournal? {
        var info = stat()
        if lstat(journalURL.path, &info) != 0 {
            if errno == ENOENT { return nil }
            throw ConfigurationError("Cannot inspect recovery journal; startup is blocked.")
        }
        let fd = open(journalURL.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw ConfigurationError("Recovery journal must be a private regular file.") }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_mode & 0o077 == 0, info.st_uid == getuid(), info.st_size <= 1024 * 1024 else {
            throw ConfigurationError("Recovery journal must be private, user-owned, and bounded.")
        }
        let j = try JSONDecoder().decode(NativeRecoveryJournal.self, from: file.readToEnd() ?? Data())
        guard UUID(uuidString: j.id) != nil, UUID(uuidString: j.nonce) != nil,
              j.appPath.hasPrefix("/"), URL(fileURLWithPath: j.appPath).pathExtension == "app", !j.oldBuild.isEmpty, !j.targetBuild.isEmpty else { throw ConfigurationError("Invalid recovery journal; startup is blocked.") }
        return j
    }
    public func save(_ journal: NativeRecoveryJournal) throws {
        if fm.fileExists(atPath: transaction(journal).path) {
            try Self.durableJSON(journal, to: transaction(journal).appendingPathComponent("manifest.json"))
        }
        try Self.durableJSON(journal, to: journalURL)
    }
    public static func durableJSON<T: Encodable>(_ value: T, to url: URL) throws {
        let temp = url.deletingLastPathComponent().appendingPathComponent(".journal-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: temp) }
        let fd = open(temp.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw ConfigurationError("Cannot persist recovery journal.") }
        let file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        try file.write(contentsOf: JSONEncoder().encode(value)); try file.synchronize()
        guard rename(temp.path, url.path) == 0 else { throw ConfigurationError("Cannot replace recovery journal.") }
        try syncDirectory(url.deletingLastPathComponent())
    }
    public static func syncDirectory(_ url: URL) throws {
        let fd = open(url.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard fd >= 0 else { throw ConfigurationError("Cannot flush recovery directory.") }
        defer { close(fd) }
        guard fsync(fd) == 0 else { throw ConfigurationError("Cannot flush recovery directory.") }
    }
    public func transaction(_ j: NativeRecoveryJournal) -> URL { directory.appendingPathComponent(j.id, isDirectory: true) }
    public func requireStopped() throws -> [RecoveryLease] {
        if !fm.fileExists(atPath: root.path) { return [] }
        let leases = try ["service.lock", "database.lock", "recovery-worker.lock"].map { try RecoveryLease(root.appendingPathComponent($0)) }
        guard !fm.fileExists(atPath: root.appendingPathComponent("postgres/postmaster.pid").path) else { throw ConfigurationError("The managed database has not stopped cleanly.") }
        return leases
    }
    public static func build(of app: URL) throws -> String {
        guard let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")), let build = info["CFBundleVersion"] as? String else { throw ConfigurationError("Cannot identify the installed app.") }
        return build
    }
    public static func requireCompatibleApp(_ app: URL) throws {
        guard (NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))?["DispatchRecoveryProtocol"] as? NSNumber)?.intValue == 1 else {
            throw ConfigurationError("This app does not declare the required write-fenced recovery protocol. Install a compatible release through an operator-managed enrollment first.")
        }
    }
    public static func verifySignedApp(_ app: URL) throws {
        try RecoveryCommand.run(URL(fileURLWithPath: "/usr/bin/codesign"), ["--verify", "--deep", "--strict", app.path])
    }
    /// App symlinks must remain within its signed tree; state symlinks are unsupported.
    /// Hash contents, relative names, permissions, and link targets. Reject special files.
    public static func digest(_ tree: URL, app: Bool = false) throws -> String {
        let fm = FileManager.default
        guard let files = fm.enumerator(atPath: tree.path) else { throw ConfigurationError("Cannot inspect recovery data.") }
        var paths = [String](); for case let relative as String in files { paths.append(relative) }
        var hash = SHA256()
        for name in paths.sorted() {
            let url = tree.appendingPathComponent(name)
            let attrs = try fm.attributesOfItem(atPath: url.path)
            let type = attrs[.type] as? FileAttributeType
            hash.update(data: Data("\(name)\u{0}\(type?.rawValue ?? "unknown")\u{0}\(attrs[.posixPermissions] ?? 0)\u{0}\(type == .typeRegular ? (attrs[.size] as? NSNumber)?.int64Value ?? 0 : 0)\u{0}".utf8))
            switch type {
            case .typeDirectory: hash.update(data: Data("directory".utf8))
            case .typeRegular:
                let file = try FileHandle(forReadingFrom: url); defer { try? file.close() }
                while let data = try file.read(upToCount: 1024 * 1024), !data.isEmpty { hash.update(data: data) }
            case .typeSymbolicLink:
                guard app, url.resolvingSymlinksInPath().path.hasPrefix(tree.path + "/") else { throw ConfigurationError("Recovery does not support external state links: \(name).") }
                hash.update(data: Data(try fm.destinationOfSymbolicLink(atPath: url.path).utf8))
            default: throw ConfigurationError("Recovery does not support special state files: \(name). Stop all hosts before retrying.")
            }
            hash.update(data: Data([0]))
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    public func copy(_ source: URL, _ destination: URL) throws {
        guard !fm.fileExists(atPath: destination.path) else { throw ConfigurationError("Recovery destination already exists; retained for inspection.") }
        try RecoveryCommand.run(URL(fileURLWithPath: "/usr/bin/ditto"), ["--noqtn", source.path, destination.path], timeout: 1800)
    }
    public func backup(_ j: inout NativeRecoveryJournal, verifyCluster: (URL, URL) throws -> Void = NativeRecoveryStore.verifyCluster) throws {
        guard j.phase == .preparing else { throw ConfigurationError("Recovery is not in preparation.") }
        let leases = try requireStopped(); defer { withExtendedLifetime(leases) {} }
        let config = try Configuration.read(from: root.appendingPathComponent("configuration.json"))
        guard config.usesManagedDatabase, config.instanceID == j.instanceID else { throw ConfigurationError("Automatic recovery supports only this app's private managed PostgreSQL 17 cluster. External databases require operator recovery.") }
        let app = URL(fileURLWithPath: j.appPath)
        try Self.verifySignedApp(app)
        guard try Self.build(of: app) == j.oldBuild else { throw ConfigurationError("Installed app changed before backup.") }
        let appHash = try Self.digest(app, app: true)
        let stateHash = try Self.digest(root)
        // Three state copies (snapshot, restore test, failed state) plus two app copies.
        let size = try allocatedSize(root) * 3 + allocatedSize(app) * 2 + 256 * 1024 * 1024
        let available = try directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage ?? 0
        guard available > size else { throw ConfigurationError("Insufficient free disk space for a verified update recovery point. Free space and retry.") }
        let tx = transaction(j)
        let previous = tx.appendingPathComponent("previous.app")
        if j.appDigest != nil {
            // Staged: the app snapshot was taken before Sparkle could stage an installer.
            guard j.appDigest == appHash, fm.fileExists(atPath: previous.path) else { throw ConfigurationError("The installed app changed after update protection was staged.") }
        } else {
            try fm.createDirectory(at: tx, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            try copy(app, previous)
        }
        try copy(root, tx.appendingPathComponent("state"))
        guard try Self.digest(previous, app: true) == appHash else { throw ConfigurationError("App recovery backup did not verify.") }
        guard try Self.digest(tx.appendingPathComponent("state")) == stateHash else { throw ConfigurationError("State recovery backup did not verify.") }
        try verifyCluster(tx.appendingPathComponent("state"), tx.appendingPathComponent("previous.app"))
        try Self.flushTree(tx)
        j.appDigest = appHash; j.stateDigest = stateHash; j.phase = .backedUp
        try save(j)
    }
    public static func flushTree(_ tree: URL) throws {
        guard let files = FileManager.default.enumerator(at: tree, includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey]) else { throw ConfigurationError("Cannot flush recovery snapshot.") }
        var directories = [tree]
        for case let url as URL in files {
            let info = try url.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey])
            if info.isSymbolicLink == true { continue }
            if info.isDirectory == true { directories.append(url) }
            if info.isRegularFile == true {
                let file = try FileHandle(forWritingTo: url); try file.synchronize(); try file.close()
            }
        }
        for url in directories.reversed() { try syncDirectory(url) }
    }
    private func allocatedSize(_ path: URL) throws -> Int64 {
        guard let files = fm.enumerator(at: path, includingPropertiesForKeys: [.fileSizeKey]) else { throw ConfigurationError("Cannot measure recovery size.") }
        var total: Int64 = 0
        for case let url as URL in files { total += Int64(try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) }
        return total
    }
    public func verifyBackup(_ j: NativeRecoveryJournal) throws {
        let tx = transaction(j)
        guard let a = j.appDigest, let s = j.stateDigest,
              try Self.digest(tx.appendingPathComponent("previous.app"), app: true) == a,
              try Self.digest(tx.appendingPathComponent("state")) == s else { throw ConfigurationError("Recovery backup is missing or damaged. No live data was replaced.") }
        try Self.verifySignedApp(tx.appendingPathComponent("previous.app"))
    }
    /// Journaled two-rename switches: failed copies are created once, never overwritten.
    /// A crash after either rename is recovered from existence plus the staged digest.
    public func restore(_ j: inout NativeRecoveryJournal, verifyCluster: (URL, URL) throws -> Void = NativeRecoveryStore.verifyCluster) throws {
        guard !j.terminal, [.activating, .probation, .restoring].contains(j.phase) else { throw ConfigurationError("Automatic restoration is only allowed before commit.") }
        let leases = try requireStopped(); defer { withExtendedLifetime(leases) {} }
        try verifyBackup(j)
        let tx = transaction(j)
        if !j.restoreStarted {
            try verifyCluster(tx.appendingPathComponent("state"), tx.appendingPathComponent("previous.app"))
            j.restoreStarted = true; j.phase = .restoring; j.deadline = Date(timeIntervalSinceNow: 1800); try save(j)
            try Self.durableJSON(["identity": j.targetIdentity, "build": j.targetBuild, "reason": j.error ?? "Readiness failed"], to: directory.appendingPathComponent("quarantine.json"))
        }
        if !j.restoredApp {
            try switchCopy(source: tx.appendingPathComponent("previous.app"), live: URL(fileURLWithPath: j.appPath), failed: URL(fileURLWithPath: j.appPath + ".failed-" + j.id), expected: j.appDigest!, app: true)
            j.restoredApp = true; try save(j)
        }
        if !j.restoredState {
            try switchCopy(source: tx.appendingPathComponent("state"), live: root, failed: directory.appendingPathComponent("failed-state-" + j.id), expected: j.stateDigest!, app: false)
            j.restoredState = true; try save(j)
        }
    }
    func switchCopy(source: URL, live: URL, failed: URL, expected: String, app: Bool) throws {
        let stage = live.deletingLastPathComponent().appendingPathComponent(".\(live.lastPathComponent)-restore")
        if fm.fileExists(atPath: failed.path), fm.fileExists(atPath: live.path) {
            guard try Self.digest(live, app: app) == expected else { throw ConfigurationError("Interrupted restore has unexpected live contents; operator recovery is required.") }
            return
        }
        if !fm.fileExists(atPath: stage.path) { try copy(source, stage) }
        guard try Self.digest(stage, app: app) == expected else { throw ConfigurationError("Restore staging verification failed.") }
        if !fm.fileExists(atPath: failed.path) { try fm.moveItem(at: live, to: failed); try Self.syncDirectory(live.deletingLastPathComponent()); try Self.syncDirectory(failed.deletingLastPathComponent()) }
        try Self.flushTree(stage)
        try fm.moveItem(at: stage, to: live); try Self.syncDirectory(live.deletingLastPathComponent())
    }
    public static func verifyCluster(state: URL, app: URL) throws {
        let fm = FileManager.default
        let source = state.appendingPathComponent("postgres")
        guard (try String(contentsOf: source.appendingPathComponent("PG_VERSION"))).trimmingCharacters(in: .whitespacesAndNewlines) == "17",
              !fm.fileExists(atPath: source.appendingPathComponent("postmaster.pid").path),
              !fm.fileExists(atPath: source.appendingPathComponent("standby.signal").path),
              !fm.fileExists(atPath: source.appendingPathComponent("recovery.signal").path) else { throw ConfigurationError("Recovery requires a stopped PostgreSQL 17 cluster.") }
        let config = try Configuration.read(from: state.appendingPathComponent("local-database.json"))
        guard config.usesManagedDatabase else { throw ConfigurationError("External database restoration is unsupported.") }
        let binaries = app.appendingPathComponent("Contents/Helpers/Postgres/bin")
        let control = try RecoveryCommand.run(binaries.appendingPathComponent("pg_controldata"), [source.path])
        guard control.contains("shut down"), !control.contains("in production") else { throw ConfigurationError("PostgreSQL did not shut down cleanly; installation is blocked.") }
        let validation = state.deletingLastPathComponent().appendingPathComponent("verify-\(UUID().uuidString)")
        try RecoveryCommand.run(URL(fileURLWithPath: "/usr/bin/ditto"), [source.path, validation.path], timeout: 1800)
        var stopped = false
        defer { if stopped { try? fm.removeItem(at: validation) } }
        // Validation uses owned minimal configuration, never archived include directives,
        // recovery hooks, tablespaces, or a configured external data_directory.
        try Data("listen_addresses = '127.0.0.1'\nunix_socket_directories = ''\n".utf8).write(to: validation.appendingPathComponent("postgresql.conf"))
        try Data().write(to: validation.appendingPathComponent("postgresql.auto.conf"))
        try Data("host all all 127.0.0.1/32 scram-sha-256\n".utf8).write(to: validation.appendingPathComponent("pg_hba.conf"))
        let port = try LocalDatabase.availablePort()
        let pgctl = binaries.appendingPathComponent("pg_ctl")
        let url = URLComponents(string: config.databaseURL)!
        // Overrides prevent archived configuration from connecting to another cluster,
        // creating sockets elsewhere, loading preload hooks, or archiving external WAL.
        do {
            try RecoveryCommand.run(pgctl, ["-D", validation.path, "-l", validation.appendingPathComponent("validation.log").path, "-w", "-t", "30", "-o", "-h 127.0.0.1 -p \(port) -k '' -c shared_preload_libraries='' -c archive_mode=off -c ssl=off", "start"], timeout: 40)
            let env = ["PGHOST": "127.0.0.1", "PGPORT": String(port), "PGUSER": LocalDatabase.role, "PGPASSWORD": url.password!, "PGDATABASE": LocalDatabase.role, "PGCONNECT_TIMEOUT": "5"]
            let psql = binaries.appendingPathComponent("psql")
            let actual = try RecoveryCommand.run(psql, ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", "SHOW data_directory"], environment: env).trimmingCharacters(in: .whitespacesAndNewlines)
            guard URL(fileURLWithPath: actual).resolvingSymlinksInPath().path == validation.resolvingSymlinksInPath().path else { throw ConfigurationError("Recovery validation reached the wrong database.") }
            try RecoveryCommand.run(psql, ["-X", "-v", "ON_ERROR_STOP=1", "-c", "BEGIN; SELECT count(*) FROM pgmigrations; CREATE TEMP TABLE dispatch_recovery_probe (value text); INSERT INTO dispatch_recovery_probe VALUES ('verified'); SELECT value FROM dispatch_recovery_probe; ROLLBACK;"], environment: env)
            try RecoveryCommand.run(pgctl, ["-D", validation.path, "-m", "fast", "-w", "-t", "30", "stop"], timeout: 40); stopped = true
        } catch {
            if (try? RecoveryCommand.run(pgctl, ["-D", validation.path, "-m", "fast", "-w", "-t", "30", "stop"], timeout: 40)) != nil { stopped = true }
            throw error
        }
    }
}
