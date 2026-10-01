import DispatchCore
import Foundation
import XCTest

final class ConfigurationTests: XCTestCase {
    func testPreviewCannotTargetProductionOrOverrideDatabase() throws {
        for url in [
            "postgres://localhost/dispatch", "postgres://localhost/%64ispatch",
            "postgres://localhost/postgres", "postgres://localhost/preview?dbname=dispatch",
            "postgres://localhost/preview?host=elsewhere", "https://localhost/preview",
            "postgres://localhost/", "postgres://localhost/preview#fragment",
            "postgres://dispatch@localhost/.", "postgres://dispatch@localhost/..",
            "postgres://dispatch@localhost/%2e", "postgres://dispatch@localhost/%2e%2e",
            "postgres://dispatch@localhost/.%2E", "postgres://dispatch@localhost/%2E.",
        ] {
            XCTAssertThrowsError(try Configuration(databaseURL: url).validate(), url)
        }
        for port in [0, 80, 6767, 65536] {
            XCTAssertThrowsError(try Configuration(port: port, databaseURL: "postgres://localhost/preview").validate())
        }
        try Configuration(databaseURL: "postgresql://user:pass@localhost/preview?sslmode=require").validate()
    }

    func testNetworkBindingAndBrowserAddresses() throws {
        let legacy = Configuration(databaseURL: "postgres://localhost/preview")
        XCTAssertEqual(legacy.bindHost, "127.0.0.1")
        for (host, expected) in [("0.0.0.0", "https://127.0.0.1:6768"), ("192.168.1.23", "https://192.168.1.23:6768"), ("100.100.1.2", "https://100.100.1.2:6768"), ("::", "https://[::1]:6768"), ("::1", "https://[::1]:6768")] {
            let config = Configuration(databaseURL: "postgres://localhost/preview", host: host)
            try config.validate()
            XCTAssertEqual(config.serverURL.absoluteString, expected)
            XCTAssertEqual(try JSONDecoder().decode(Configuration.self, from: JSONEncoder().encode(config)), config)
        }
        for host in ["", "example.com", "127.0.0.1:8000", "http://localhost", "999.1.1.1", "127.0.0.1\n"] {
            XCTAssertThrowsError(try Configuration(databaseURL: "postgres://localhost/preview", host: host).validate())
        }
    }

    func testLegacyHTTPConfigurationRemainsReadable() throws {
        let data = Data("{\"port\":6768,\"databaseURL\":\"postgres://localhost/preview\",\"instanceID\":\"00000000-0000-0000-0000-000000000001\"}".utf8)
        var config = try JSONDecoder().decode(Configuration.self, from: data)
        XCTAssertNil(config.localTLS)
        XCTAssertEqual(config.serverURL.scheme, "http")
        config.localTLS = true
        XCTAssertEqual(config.serverURL.scheme, "https")
    }

    func testPrivateConfigurationRoundTripAndReplacement() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("configuration.json")
        var config = Configuration(databaseURL: "postgres://localhost/preview")
        try config.save(to: file)
        XCTAssertEqual(try Configuration.read(from: file), config)
        config.port = 7788
        try config.save(to: file)
        XCTAssertEqual(try Configuration.read(from: file), config)
        let permissions = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int
        XCTAssertEqual(permissions, 0o600)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["configuration.json"])
    }

    func testValidationModeOnlyAcceptsIsolatedLoopback() throws {
        for value in ["http://127.0.0.1:6767", "https://127.0.0.1:8000", "http://example.com:8000", "http://127.0.0.1", "http://user:pass@127.0.0.1:8000", "http://127.0.0.1:8000/path"] {
            XCTAssertThrowsError(try validationURL(value), value)
        }
        XCTAssertEqual(try validationURL("http://127.0.0.1:8000").port, 8000)
    }
}
