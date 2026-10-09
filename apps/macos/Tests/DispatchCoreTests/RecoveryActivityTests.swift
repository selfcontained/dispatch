import Darwin
import Foundation
import XCTest
@testable import DispatchCore

final class RecoveryActivityTests: XCTestCase {
    func testRecoveryUsesRunningPortAndRejectsCorruptSnapshot() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-recovery-config-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let saved = Configuration(port: 15001, databaseURL: "postgres://localhost/isolated")
        var running = saved
        running.port = 15002
        try saved.save(to: root.appendingPathComponent("configuration.json"))
        XCTAssertEqual(try RecoveryProtocol.serverConfiguration(root: root), saved)
        let snapshot = root.appendingPathComponent("running-configuration.json")
        try running.save(to: snapshot)
        XCTAssertEqual(try RecoveryProtocol.serverConfiguration(root: root), running)
        try Data("invalid".utf8).write(to: snapshot)
        XCTAssertThrowsError(try RecoveryProtocol.serverConfiguration(root: root))
    }

    func testActivityUsesRunningConfigurationAfterSettingsChange() async throws {
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
        let configuration = Configuration(port: Int(UInt16(bigEndian: address.sin_port)), databaseURL: "postgres://test@127.0.0.1/isolated", instanceID: UUID().uuidString, localTLS: true)
        try configuration.save(to: root.appendingPathComponent("configuration.json"))
        try configuration.save(to: root.appendingPathComponent("running-configuration.json"))
        var saved = configuration
        // Settings may reload a pre-HTTPS local-database.json while the worker
        // has already upgraded its active configuration to HTTPS.
        saved.localTLS = nil
        saved.hosts = ["127.0.0.1", "192.168.1.210"]
        try saved.save(to: root.appendingPathComponent("configuration.json"))
        let token = try AppControlToken.create(root: root)
        let serverModules = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("server/node_modules/fastify").path
        let script = """
        const fastify = require('\(serverModules)');
        const { readFileSync } = require('node:fs');
        const { createHmac } = require('node:crypto');
        const app = fastify({https: {cert: readFileSync('server.pem'), key: readFileSync('server-key.pem')}});
        app.get('/api/v1/system/update-recovery/status', (req, res) => {
          if (req.headers.authorization !== 'Dispatch-Recovery \(token)') return res.code(401).send({});
          const challenge = new URL(req.url, 'https://localhost').searchParams.get('challenge');
          const body = {busy: false, instance: {macInstanceId: '\(configuration.instanceID)'}};
          const payload = 'dispatch-recovery-v1\\n/api/v1/system/update-recovery/status\\n' + challenge + '\\n' + JSON.stringify(body) + '\\n{}';
          const proof = createHmac('sha256', '\(token)').update(payload).digest('hex');
          return {...body, proof};
        });
        app.listen({port: \(configuration.port), host: '127.0.0.1'}).then(() => require('node:fs').writeFileSync('ready', 'ready'));
        """
        try Data(script.utf8).write(to: root.appendingPathComponent("server.cjs"))
        let server = Process()
        server.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        server.arguments = ["bun", "server.cjs"]
        server.currentDirectoryURL = root
        server.standardOutput = FileHandle.nullDevice; server.standardError = FileHandle.nullDevice
        try server.run()
        defer { if server.isRunning { server.terminate() }; server.waitUntilExit() }
        for _ in 0..<50 {
            if FileManager.default.fileExists(atPath: root.appendingPathComponent("ready").path) { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("ready").path), "The isolated HTTPS server must start")
        let busy = try await RecoveryProtocol.updateBusy(root: root)
        XCTAssertFalse(busy)
        // Legacy installations without a worker snapshot still use saved settings.
        try FileManager.default.removeItem(at: root.appendingPathComponent("running-configuration.json"))
        try configuration.save(to: root.appendingPathComponent("configuration.json"))
        let legacyBusy = try await RecoveryProtocol.updateBusy(root: root)
        XCTAssertFalse(legacyBusy)
    }
}
