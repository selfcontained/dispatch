import Darwin
import DispatchCore
import Foundation
@testable import DispatchMenu
import XCTest

final class ServiceSupervisorTests: XCTestCase {
    private func stubbornWorker() -> (Process, Pipe) {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sh")
        child.arguments = ["-c", "trap '' TERM; printf ready; while :; do :; done"]
        let ready = Pipe(); child.standardOutput = ready
        return (child, ready)
    }

    func testHeartbeatFailureStopsAndReapsOwnedWorker() throws {
        struct FailedWrite: Error {}
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try Configuration(databaseURL: "postgres://localhost/preview").save(to: root.appendingPathComponent("configuration.json"))
        let (worker, ready) = stubbornWorker()
        let termination = ServerTermination(gracePeriod: 0.15, installSignalHandlers: false)
        XCTAssertThrowsError(try runServiceSupervisor(root: root, termination: termination, makeWorker: { worker }, saveState: { _ in
            XCTAssertEqual(ready.fileHandleForReading.readData(ofLength: 5), Data("ready".utf8))
            throw FailedWrite()
        }))
        XCTAssertFalse(worker.isRunning)
        XCTAssertEqual(worker.terminationReason, .uncaughtSignal)
        XCTAssertEqual(worker.terminationStatus, SIGKILL)
        let lock = open(root.appendingPathComponent("service.lock").path, O_RDWR)
        defer { close(lock) }
        XCTAssertEqual(flock(lock, LOCK_EX | LOCK_NB), 0, "Worker is reaped before ownership is released")
    }

    func testManualStopEscalatesWithoutStoppingCoordinatorOrReplacement() throws {
        let termination = ServerTermination(gracePeriod: 0.15, installSignalHandlers: false)
        let (worker, ready) = stubbornWorker()
        try termination.launch(worker)
        XCTAssertEqual(ready.fileHandleForReading.readData(ofLength: 5), Data("ready".utf8))
        termination.stopChild()
        termination.stopChild()
        _ = try termination.waitForExitAndCleanUp {}
        XCTAssertFalse(termination.requested)
        XCTAssertEqual(worker.terminationStatus, SIGKILL)
        let next = Process(); next.executableURL = URL(fileURLWithPath: "/bin/sleep"); next.arguments = ["10"]
        try termination.launch(next)
        Thread.sleep(forTimeInterval: 0.3)
        XCTAssertTrue(next.isRunning, "Expired deadlines cannot target the replacement worker")
        termination.stopChild()
        _ = try termination.waitForExitAndCleanUp {}
        XCTAssertFalse(next.isRunning)
        XCTAssertFalse(termination.requested)
    }

    func testLoginPreferenceAndManualCommandsAreIndependent() throws {
        let root = URL(fileURLWithPath: "/tmp/dispatch-macos-test-supervisor-\(UUID().uuidString)")
        let app = root.appendingPathComponent("Test.app/Contents")
        let binary = Bundle(for: Self.self).bundleURL.deletingLastPathComponent().appendingPathComponent("DispatchMenu")
        guard FileManager.default.isExecutableFile(atPath: binary.path) else { throw XCTSkip("Menu binary unavailable") }
        try FileManager.default.createDirectory(at: app.appendingPathComponent("MacOS"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: app.appendingPathComponent("Helpers"), withIntermediateDirectories: true)
        let executable = app.appendingPathComponent("MacOS/DispatchMenu")
        try FileManager.default.copyItem(at: binary, to: executable)
        let helper = app.appendingPathComponent("Helpers/dispatch")
        try Data("#!/bin/sh\necho started >> \"$DISPATCH_STATE_DIR/starts\"\ntrap 'exit 0' TERM INT\nwhile :; do sleep 0.1; done\n".utf8).write(to: helper)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
        let config = Configuration(port: 17668, databaseURL: "postgres://localhost/preview")
        try config.save(to: root.appendingPathComponent("configuration.json"))
        try StartupPreferences(startServerAtLogin: false).save(root: root)
        func launch() throws -> Process {
            let process = Process(); process.executableURL = executable
            process.arguments = ["--server", "--isolated-test", root.path]
            try process.run(); return process
        }
        let service = try launch()
        defer {
            if service.isRunning { service.terminate(); service.waitUntilExit() }
            try? FileManager.default.removeItem(at: root)
        }
        func wait(_ predicate: () -> Bool) throws {
            let deadline = Date(timeIntervalSinceNow: 8)
            while !predicate() && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
            XCTAssertTrue(predicate())
        }
        try wait { ServiceRuntime.read(root: root)?.phase == "stopped" }
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("starts").path))
        let start = ServiceRequest(start: true); try start.save(root: root)
        try wait { FileManager.default.fileExists(atPath: root.appendingPathComponent("starts").path) }
        try StartupPreferences(startServerAtLogin: true).save(root: root)
        Thread.sleep(forTimeInterval: 0.6)
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("starts")), "started\n")
        let stop = ServiceRequest(start: false); try stop.save(root: root)
        try wait { let state = ServiceRuntime.read(root: root); return state?.requestID == stop.id && state?.phase == "stopped" }
        XCTAssertTrue(StartupPreferences.read(root: root).startServerAtLogin)
        var changed = config; changed.port = 17669; changed.hosts = ["127.0.0.1", "::1"]
        try changed.save(to: root.appendingPathComponent("configuration.json"))
        Thread.sleep(forTimeInterval: 0.6)
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("starts")), "started\n")
        service.terminate(); service.waitUntilExit()
        let loggedIn = try launch()
        defer { if loggedIn.isRunning { loggedIn.terminate(); loggedIn.waitUntilExit() } }
        try wait { (try? String(contentsOf: root.appendingPathComponent("starts"))) == "started\nstarted\n" }
        XCTAssertEqual(ServiceRuntime.read(root: root)?.configuration?.port, 17669)
        try StartupPreferences(startServerAtLogin: false).save(root: root)
        Thread.sleep(forTimeInterval: 0.6)
        XCTAssertTrue(loggedIn.isRunning)
        XCTAssertTrue(ServiceRuntime.read(root: root)?.isActive == true)
    }
}
