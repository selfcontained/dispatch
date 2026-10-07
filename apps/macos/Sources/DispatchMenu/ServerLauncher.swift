import Darwin
import DispatchCore
import Foundation

/// launchd starts this mode; managed databases are supervised with the server.
/// ACP hosts have their own sessions and are not stopped with the menu app.
func runServer() throws -> Never {
    let root = AppPaths.root
    let recoveryStore = NativeRecoveryStore(root: root)
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
    // Staged updates fence every build but the old one; evidence precedes any DB open.
    let recoveryJournal = try recoveryStore.admitWorker(build: build, environment: ProcessInfo.processInfo.environment)
    let recoveryLease = try RecoveryLease(root.appendingPathComponent("recovery-worker.lock"))
    defer { withExtendedLifetime(recoveryLease) {} }
    if let journal = recoveryJournal {
        try NativeRecoveryStore.durableJSON(RecoveryProcess.current(transaction: journal, build: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"), to: recoveryStore.directory.appendingPathComponent("worker.json"))
    }
    let serverDirectory = root.appendingPathComponent("server", isDirectory: true)
    try FileManager.default.createDirectory(at: serverDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let log = open(AppPaths.log.path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
    guard log >= 0 else { throw ConfigurationError("Cannot open the server log.") }
    _ = dup2(log, STDOUT_FILENO)
    _ = dup2(log, STDERR_FILENO)
    if log > STDERR_FILENO { close(log) }
    var config = try Configuration.read(from: AppPaths.configuration)
    let requested = config
    let managedDatabase: LocalDatabase?
    if config.usesManagedDatabase {
        let database = LocalDatabase(binaries: Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/Postgres"))
        let hosts = config.bindHosts
        config = try database.configuration(port: config.port, instanceID: config.instanceID)
        config.hosts = hosts
        managedDatabase = database
    } else { managedDatabase = nil }
    config.localTLS = true
    // Persist first-time database reconciliation only if the user has not saved
    // a newer configuration while this worker was starting.
    if (try? Configuration.read(from: AppPaths.configuration)) == requested {
        try config.save(to: AppPaths.configuration)
    }
    try config.save(to: root.appendingPathComponent("running-configuration.json"))
    let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/dispatch")
    guard FileManager.default.isExecutableFile(atPath: executable.path) else {
        throw ConfigurationError("The bundled Dispatch server is missing. Download a complete Dispatch app.")
    }

    // Never inherit another Dispatch instance's state, credentials, TLS, or test seams.
    for key in ProcessInfo.processInfo.environment.keys where key.hasPrefix("DISPATCH_") || ["DATABASE_URL", "TLS_CERT", "TLS_KEY", "TLS_CA", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "PORT", "HOST", "DOTENV_CONFIG_PATH"].contains(key) {
        unsetenv(key)
    }
    // A fresh token per launch: the menu app re-reads it each time it reconnects.
    let controlToken = try AppControlToken.create(root: root)
    let environment = [
        "DISPATCH_MAC_APP_TOKEN": controlToken,
        "DATABASE_URL": config.databaseURL,
        "DISPATCH_HOST": config.bindHost,
        "DISPATCH_LISTEN_HOSTS": config.bindHosts.joined(separator: ","),
        "DISPATCH_PORT": String(config.port),
        "DISPATCH_STATE_DIR": root.path,
        "DISPATCH_SERVER_DIR": serverDirectory.path,
        "DISPATCH_RUNTIME_PATH": executable.path,
        "DISPATCH_UPDATE_OWNER": "macos-app",
        "DISPATCH_MAC_INSTANCE_ID": config.instanceID,
        "DISPATCH_MAC_BUILD": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0",
        "DISPATCH_LOCAL_TLS": "1",
        "TLS_CA": root.appendingPathComponent("tls/ca/cert.pem").path,
        "NODE_EXTRA_CA_CERTS": root.appendingPathComponent("tls/ca/cert.pem").path,
        "DISPATCH_AGENT_RUNTIME": "acp",
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    ]
    for (key, value) in environment { setenv(key, value, 1) }
    if let journal = recoveryJournal {
        setenv("DISPATCH_RECOVERY_PROBATION", "1", 1)
        setenv("DISPATCH_RECOVERY_TRANSACTION_ID", journal.id, 1)
        setenv("DISPATCH_RECOVERY_NONCE", journal.nonce, 1)
        setenv("DISPATCH_RECOVERY_INSTANCE_ID", journal.instanceID, 1)
        setenv("DISPATCH_RECOVERY_EXPECTED_VERSION", Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0", 1)
    }
    #if SPARKLE_PROBE
    if Bundle.main.bundleIdentifier?.hasPrefix("dev.bradharris.dispatch.sparkleprobe.") == true,
       AppPaths.testRoot == root,
       root.lastPathComponent.hasPrefix("dispatch-macos-test-sparkle-service-"),
       FileManager.default.fileExists(atPath: root.appendingPathComponent("live-agent-proof").path) {
        let command = ["/usr/bin/python3", root.appendingPathComponent("fake-acp.py").path]
        let encoded = try JSONEncoder().encode(command)
        setenv("DISPATCH_ACP_ADAPTER_COMMAND", String(decoding: encoded, as: UTF8.self), 1)
        // Agent creation also checks the CLI path before the ACP adapter runs.
        setenv("DISPATCH_CLAUDE_BIN", root.appendingPathComponent("fake-acp.py").path, 1)
    }
    #endif
    if let shell = getpwuid(getuid())?.pointee.pw_shell { setenv("SHELL", shell, 1) }
    guard chdir(serverDirectory.path) == 0 else { throw ConfigurationError("Cannot open the data directory.") }
    let termination = ServerTermination()
    // Initialize before launching the server so Bun and agent children can load
    // NODE_EXTRA_CA_CERTS at process startup, including the first installation.
    let certificates = Process()
    certificates.executableURL = executable
    certificates.arguments = ["init-local-tls"]
    certificates.environment = ProcessInfo.processInfo.environment
    certificates.standardOutput = FileHandle.standardOutput
    certificates.standardError = FileHandle.standardError
    try termination.launch(certificates)
    let certificateStatus = try termination.waitForExitAndCleanUp {}
    guard !termination.requested else { exit(0) }
    guard certificateStatus == 0 else { throw ConfigurationError("Could not initialize HTTPS certificates. Check the server log.") }
    try managedDatabase?.start(config)
    // Postmaster identity proves later that a running cluster belongs to this build.
    try? recoveryStore.recordPostmaster(build: build)
    if termination.requested { try managedDatabase?.stop(); exit(0) }
    let server = Process()
    server.executableURL = executable
    server.environment = ProcessInfo.processInfo.environment
    server.standardOutput = FileHandle.standardOutput
    server.standardError = FileHandle.standardError
    do {
        try termination.launch(server)
        let status = try termination.waitForExitAndCleanUp { try managedDatabase?.stop() }
        exit(status)
    } catch {
        try? managedDatabase?.stop()
        throw error
    }

}

/// Signal handlers execute off the thread waiting for the child. Keep launch and
/// cancellation atomic so a stop during database startup never launches the API.
final class ServerTermination {
    // Ten seconds for the API plus pg_ctl's 30-second stop leaves 20 seconds
    // inside launchd's 60-second ExitTimeOut for dispatch/reaping overhead.
    private let gracePeriod: TimeInterval
    private let lock = NSLock()
    private var stopping = false
    private var process: Process?
    private weak var stoppingChild: Process?
    private var sources: [DispatchSourceSignal] = []
    var requested: Bool { lock.lock(); defer { lock.unlock() }; return stopping }

    init(gracePeriod: TimeInterval = 10, installSignalHandlers: Bool = true) {
        self.gracePeriod = gracePeriod
        guard installSignalHandlers else { return }
        for number in [SIGTERM, SIGINT] {
            signal(number) { _ in }
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
            source.setEventHandler { [weak self] in self?.requestStop() }
            source.resume()
            sources.append(source)
        }
    }

    func requestStop() {
        lock.lock()
        defer { lock.unlock() }
        stopping = true
        stopChildLocked()
    }

    /// Stops this child without shutting down the coordinator. Repeated requests
    /// share one deadline; its timer can never target a replacement child.
    func stopChild() {
        lock.lock()
        defer { lock.unlock() }
        stopChildLocked()
    }

    private func stopChildLocked() {
        guard let child = process, child.isRunning, stoppingChild !== child else { return }
        stoppingChild = child
        child.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + gracePeriod) { [weak self, weak child] in
            guard let self, let child else { return }
            self.lock.lock()
            defer { self.lock.unlock() }
            guard self.process === child, child.isRunning else { return }
            // Kill only our owned child, never a process group or detached agents.
            _ = Darwin.kill(child.processIdentifier, SIGKILL)
        }
    }

    func waitForExitAndCleanUp(_ cleanup: () throws -> Void) throws -> Int32 {
        lock.lock()
        let child = process
        lock.unlock()
        guard let child else { throw ConfigurationError("No owned server process to wait for.") }
        child.waitUntilExit()
        // Remove ownership before cleanup so an outstanding deadline cannot act
        // on this PID after reaping (including a subsequently reused PID).
        lock.lock()
        process = nil
        stoppingChild = nil
        let stopped = stopping
        lock.unlock()
        try cleanup()
        return stopped ? 0 : child.terminationStatus
    }

    func launch(_ child: Process) throws {
        lock.lock()
        defer { lock.unlock() }
        guard !stopping else { throw ConfigurationError("Server startup was cancelled.") }
        try child.run()
        process = child
    }
}
