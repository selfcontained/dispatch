import Darwin
import Foundation
import XCTest
@testable import DispatchCore

final class LocalServerTrustTests: XCTestCase {
    func testRecoveryHealthUsesInstallationCAWithoutSystemTrust() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-recovery-tls-\(UUID())")
        let ca = root.appendingPathComponent("tls/ca")
        try FileManager.default.createDirectory(at: ca, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        func openssl(_ arguments: [String]) throws {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/openssl")
            process.arguments = arguments; process.currentDirectoryURL = root
            process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
            try process.run(); process.waitUntilExit()
            XCTAssertEqual(process.terminationStatus, 0)
        }
        try Data("[req]\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n".utf8).write(to: root.appendingPathComponent("ca.cnf"))
        try openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2", "-subj", "/CN=Isolated recovery test", "-config", "ca.cnf", "-keyout", "ca-key.pem", "-out", "ca.pem"])
        try openssl(["x509", "-in", "ca.pem", "-outform", "DER", "-out", "tls/ca/cert.cer"])
        try openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", "server-key.pem", "-out", "server.csr"])
        try Data("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n".utf8).write(to: root.appendingPathComponent("server.cnf"))
        try openssl(["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca-key.pem", "-CAcreateserial", "-days", "2", "-sha256", "-extfile", "server.cnf", "-out", "server.pem"])

        let listener = socket(AF_INET, SOCK_STREAM, 0)
        guard listener >= 0 else { throw ConfigurationError("Cannot allocate test port") }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        var size = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(listener, $0, &size) } }
        close(listener)
        XCTAssertEqual(bound, 0); XCTAssertEqual(named, 0)
        let configuration = Configuration(port: Int(UInt16(bigEndian: address.sin_port)), instanceID: "recovery-test", localTLS: true)
        let healthFile = root.appendingPathComponent("api/v1/health")
        try FileManager.default.createDirectory(at: healthFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        func writeHealth(instance: String) throws {
            try JSONSerialization.data(withJSONObject: ["status": "ok", "macInstanceId": instance, "updateOwner": "macos-app"]).write(to: healthFile)
        }
        try writeHealth(instance: configuration.instanceID)
        let server = Process()
        server.executableURL = URL(fileURLWithPath: "/usr/bin/openssl")
        server.arguments = ["s_server", "-accept", "\(configuration.port)", "-cert", "server.pem", "-key", "server-key.pem", "-quiet", "-WWW"]
        server.currentDirectoryURL = root
        server.standardInput = Pipe(); server.standardOutput = FileHandle.nullDevice; server.standardError = FileHandle.nullDevice
        try server.run()
        defer { if server.isRunning { server.terminate() }; server.waitUntilExit() }
        var healthy = false
        for _ in 0..<30 {
            healthy = await LocalServerTrust.isHealthy(configuration: configuration, root: root)
            if healthy { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertTrue(healthy, "Update recovery must accept its private CA without installing it in system trust")
        do {
            _ = try await URLSession.shared.data(from: configuration.serverURL.appendingPathComponent("api/v1/health"))
            XCTFail("The generated test CA must not be trusted by URLSession.shared")
        } catch { }
        let recovery = UpdateRecovery(wasRunning: true, targetBuild: "2")
        try recovery.save(root: root)
        let request = ServiceRequest(start: true)
        XCTAssertTrue(try recovery.completeRestoration(root: root, installedBuild: "2", request: request, runtime: ServiceRuntime(phase: "running", requestID: request.id), healthy: healthy))
        try writeHealth(instance: "another-installation")
        let wrongInstance = await LocalServerTrust.isHealthy(configuration: configuration, root: root)
        XCTAssertFalse(wrongInstance)
        let missingCA = await LocalServerTrust.isHealthy(configuration: configuration, root: root.appendingPathComponent("unknown-installation"))
        XCTAssertFalse(missingCA)
    }
}
