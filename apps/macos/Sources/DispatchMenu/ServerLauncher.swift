import Darwin
import DispatchCore
import Foundation

/// launchd starts this mode; managed databases are supervised with the server.
/// ACP hosts have their own sessions and are not stopped with the menu app.
func runServer() throws -> Never {
    let root = PreviewPaths.root
    let serverDirectory = root.appendingPathComponent("server", isDirectory: true)
    try FileManager.default.createDirectory(at: serverDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let log = open(PreviewPaths.log.path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
    guard log >= 0 else { throw ConfigurationError("Cannot open the preview server log.") }
    _ = dup2(log, STDOUT_FILENO)
    _ = dup2(log, STDERR_FILENO)
    if log > STDERR_FILENO { close(log) }
    var config = try Configuration.read(from: PreviewPaths.configuration)
    let managedDatabase: LocalDatabase?
    if config.usesManagedDatabase {
        let database = LocalDatabase(binaries: Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/Postgres"))
        config = try database.configuration(port: config.port, instanceID: config.instanceID)
        try config.save(to: PreviewPaths.configuration)
        managedDatabase = database
    } else { managedDatabase = nil }
    let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/dispatch")
    guard FileManager.default.isExecutableFile(atPath: executable.path) else {
        throw ConfigurationError("The bundled Dispatch server is missing. Download a complete preview app.")
    }

    // Never inherit another Dispatch instance's state, credentials, TLS, or test seams.
    for key in ProcessInfo.processInfo.environment.keys where key.hasPrefix("DISPATCH_") || ["DATABASE_URL", "TLS_CERT", "TLS_KEY", "PORT", "HOST", "DOTENV_CONFIG_PATH"].contains(key) {
        unsetenv(key)
    }
    let environment = [
        "DATABASE_URL": config.databaseURL,
        "DISPATCH_HOST": "127.0.0.1",
        "DISPATCH_PORT": String(config.port),
        "DISPATCH_STATE_DIR": root.path,
        "DISPATCH_SERVER_DIR": serverDirectory.path,
        "DISPATCH_RUNTIME_PATH": executable.path,
        "DISPATCH_UPDATE_OWNER": "macos-app",
        "DISPATCH_MAC_INSTANCE_ID": config.instanceID,
        "DISPATCH_AGENT_RUNTIME": "acp",
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    ]
    for (key, value) in environment { setenv(key, value, 1) }
    if let shell = getpwuid(getuid())?.pointee.pw_shell { setenv("SHELL", shell, 1) }
    guard chdir(serverDirectory.path) == 0 else { throw ConfigurationError("Cannot open the preview state directory.") }
    if let database = managedDatabase {
        let termination = ServerTermination()
        try database.start(config)
        defer { try? database.stop() }
        if termination.requested { try database.stop(); exit(0) }
        let server = Process()
        server.executableURL = executable
        server.environment = ProcessInfo.processInfo.environment
        server.standardOutput = FileHandle.standardOutput
        server.standardError = FileHandle.standardError
        try termination.launch(server)
        let status = try termination.waitForExitAndCleanUp { try database.stop() }
        exit(status)
    }
    let argument = strdup(executable.path)!
    defer { free(argument) }
    var arguments: [UnsafeMutablePointer<CChar>?] = [argument, nil]
    execv(executable.path, &arguments)
    throw ConfigurationError("Cannot launch the bundled server (errno \(errno)).")
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
        guard !stopping else { return }
        stopping = true
        guard let child = process, child.isRunning else { return }
        child.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + gracePeriod) { [weak self, weak child] in
            guard let self, let child else { return }
            self.lock.lock()
            defer { self.lock.unlock() }
            guard self.process === child, child.isRunning else { return }
            // Kill only our API child, never its group or detached agent hosts.
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
