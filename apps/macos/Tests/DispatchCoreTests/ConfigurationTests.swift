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
        ] {
            XCTAssertThrowsError(try Configuration(databaseURL: url).validate(), url)
        }
        for port in [0, 80, 6767, 65536] {
            XCTAssertThrowsError(try Configuration(port: port, databaseURL: "postgres://localhost/preview").validate())
        }
        try Configuration(databaseURL: "postgresql://user:pass@localhost/preview?sslmode=require").validate()
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
