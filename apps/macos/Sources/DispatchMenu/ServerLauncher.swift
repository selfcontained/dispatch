import Darwin
import DispatchCore
import Foundation

/// launchd starts this mode; exec keeps the service PID attached to the server.
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
    let argument = strdup(executable.path)!
    defer { free(argument) }
    var arguments: [UnsafeMutablePointer<CChar>?] = [argument, nil]
    execv(executable.path, &arguments)
    throw ConfigurationError("Cannot launch the bundled server (errno \(errno)).")
}
