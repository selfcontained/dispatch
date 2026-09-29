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
    let config = try Configuration.read(from: PreviewPaths.configuration)
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
    if config.usesManagedDatabase {
        let database = LocalDatabase(binaries: Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/Postgres"))
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
        server.waitUntilExit()
        try database.stop()
        exit(termination.requested ? 0 : server.terminationStatus)
    }
    let argument = strdup(executable.path)!
    defer { free(argument) }
    var arguments: [UnsafeMutablePointer<CChar>?] = [argument, nil]
    execv(executable.path, &arguments)
    throw ConfigurationError("Cannot launch the bundled server (errno \(errno)).")
}

/// Signal handlers execute off the thread waiting for the child. Keep launch and
/// cancellation atomic so a stop during database startup never launches the API.
private final class ServerTermination {
    private let lock = NSLock()
    private var stopping = false
    private var process: Process?
    private var sources: [DispatchSourceSignal] = []
    var requested: Bool { lock.lock(); defer { lock.unlock() }; return stopping }

    init() {
        for number in [SIGTERM, SIGINT] {
            signal(number) { _ in }
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
            source.setEventHandler { [weak self] in
                guard let self else { return }
                self.lock.lock()
                defer { self.lock.unlock() }
                self.stopping = true
                if let process = self.process, process.isRunning { process.terminate() }
            }
            source.resume()
            sources.append(source)
        }
    }

    func launch(_ child: Process) throws {
        lock.lock()
        defer { lock.unlock() }
        guard !stopping else { throw ConfigurationError("Server startup was cancelled.") }
        try child.run()
        process = child
    }
}
