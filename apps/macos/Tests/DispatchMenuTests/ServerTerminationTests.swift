import Darwin
import DispatchCore
import Foundation
@testable import DispatchMenu
import XCTest

final class ServerTerminationTests: XCTestCase {
    func testUnresponsiveAPIIsReapedBeforeDatabaseShutdown() throws {
        guard let path = ProcessInfo.processInfo.environment["DISPATCH_TEST_POSTGRES_BUNDLE"] else {
            throw XCTSkip("Requires the bundled PostgreSQL runtime.")
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-stop-test-\(UUID().uuidString)")
        let database = LocalDatabase(root: root, binaries: URL(fileURLWithPath: path))
        defer { try? database.stop(); try? FileManager.default.removeItem(at: root) }
        let config = try database.configuration(port: 6768, instanceID: UUID().uuidString)
        try database.start(config)

        let unrelated = Process()
        unrelated.executableURL = URL(fileURLWithPath: "/bin/sleep")
        unrelated.arguments = ["30"]
        try unrelated.run()
        defer { if unrelated.isRunning { unrelated.terminate() }; unrelated.waitUntilExit() }

        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sh")
        child.arguments = ["-c", "trap '' TERM; printf ready; while :; do :; done"]
        let ready = Pipe()
        child.standardOutput = ready
        let supervisor = ServerTermination(gracePeriod: 0.2, installSignalHandlers: false)
        try supervisor.launch(child)
        defer { if child.isRunning { _ = kill(child.processIdentifier, SIGKILL); child.waitUntilExit() } }
        XCTAssertEqual(ready.fileHandleForReading.readData(ofLength: 5), Data("ready".utf8))
        let started = Date()
        supervisor.requestStop()
        supervisor.requestStop() // Repeated signals must not extend the grace period.
        var cleanedUp = false
        let result = try supervisor.waitForExitAndCleanUp {
            XCTAssertFalse(child.isRunning)
            try database.stop()
            cleanedUp = true
        }
        XCTAssertEqual(result, 0)
        XCTAssertTrue(cleanedUp)
        XCTAssertEqual(child.terminationReason, .uncaughtSignal)
        XCTAssertEqual(child.terminationStatus, SIGKILL)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("postgres/postmaster.pid").path))
        XCTAssertTrue(unrelated.isRunning, "Shutdown must not signal unrelated processes or the process group")
    }
}
