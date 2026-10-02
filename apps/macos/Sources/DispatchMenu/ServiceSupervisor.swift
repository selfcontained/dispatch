import Darwin
import DispatchCore
import Foundation

/// The packaged app ships this binary under one name per role so Activity Monitor can
/// tell them apart. Unpackaged builds (tests, `swift run`) fall back to the main executable.
func roleExecutable(_ name: String) -> URL? {
    guard let main = Bundle.main.executableURL else { return nil }
    let sibling = main.deletingLastPathComponent().appendingPathComponent(name)
    return FileManager.default.isExecutableFile(atPath: sibling.path) ? sibling : main
}

/// An idle login service accepts explicit commands; the server runs in a separate
/// owned worker. Startup preference changes never signal either process.
func runServiceSupervisor(
    root: URL = AppPaths.root,
    termination: ServerTermination = ServerTermination(gracePeriod: 50),
    makeWorker: (() -> Process)? = nil,
    saveState: ((ServiceRuntime) throws -> Void)? = nil,
    build: String = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
) throws {
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let fd = open(root.appendingPathComponent("service.lock").path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
    guard fd >= 0, flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw ConfigurationError("Dispatch is already running.") }
    defer { close(fd) }
    var desired = StartupPreferences.read(root: root).startServerAtLogin && FileManager.default.fileExists(atPath: root.appendingPathComponent("configuration.json").path)
    var state = ServiceRuntime(phase: "stopped")
    var child: Process?
    var stopping = false
    var nextStart = Date.distantPast
    var lastWrite = Date.distantPast
    let activePath = root.appendingPathComponent("running-configuration.json")
    // Runs for normal shutdown AND every thrown error, before releasing the lock.
    defer {
        termination.requestStop()
        _ = try? termination.waitForExitAndCleanUp {}
        try? ServiceRuntime(phase: "stopped").save(root: root)
        try? FileManager.default.removeItem(at: activePath)
    }
    while !termination.requested {
        if let command = ServiceRequest.take(root: root) {
            desired = command.start
            state.requestID = command.id
            if !desired, let child, child.isRunning {
                termination.stopChild()
                stopping = true
                state.phase = "stopping"
            }
        }
        if let current = child, !current.isRunning {
            _ = try termination.waitForExitAndCleanUp {}
            child = nil
            stopping = false
            state.phase = "stopped"
            state.configuration = nil
            try? FileManager.default.removeItem(at: activePath)
            nextStart = Date(timeIntervalSinceNow: 2)
        }
        let recovery = try NativeRecoveryStore(root: root).read()
        if desired && child == nil && Date() >= nextStart && (recovery?.permitsOrdinaryStart(build: build) ?? true) {
            let worker: Process
            if let makeWorker { worker = makeWorker() }
            else {
                worker = Process()
                worker.executableURL = roleExecutable("Dispatch Worker")
                worker.arguments = ["--worker"]
                if let testRoot = AppPaths.testRoot { worker.arguments! += ["--isolated-test", testRoot.path] }
            }
            try? FileManager.default.removeItem(at: activePath)
            try termination.launch(worker)
            child = worker
            state.phase = "starting"
            state.configuration = try? Configuration.read(from: root.appendingPathComponent("configuration.json"))
        }
        if child != nil && !stopping, let active = try? Configuration.read(from: activePath) {
            state.configuration = active
            state.phase = "running"
        }
        if Date().timeIntervalSince(lastWrite) >= 0.5 {
            if let saveState { try saveState(state) } else { try state.save(root: root) }
            lastWrite = Date()
        }
        Thread.sleep(forTimeInterval: 0.1)
    }
}
