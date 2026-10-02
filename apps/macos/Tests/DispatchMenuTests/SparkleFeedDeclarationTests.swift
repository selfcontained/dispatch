#if SPARKLE_UPDATES
import CryptoKit
import DispatchCore
import Foundation
import Sparkle
import XCTest
@testable import DispatchMenu

/// Drives the real Sparkle 2.10 SDK (the same pinned version v1.0.1 embeds) through a
/// signed, namespaced feed: Sparkle's own signature check and SUAppcast parser decide
/// what reaches `shouldProceedWithUpdate`, where the native declaration gate runs.
final class SparkleFeedDeclarationTests: XCTestCase {
    private final class SilentDriver: NSObject, SPUUserDriver {
        func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
            reply(SUUpdatePermissionResponse(automaticUpdateChecks: false, sendSystemProfile: false))
        }
        func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {}
        func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) { reply(.dismiss) }
        func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}
        func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {}
        func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) { acknowledgement() }
        func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) { acknowledgement() }
        func showDownloadInitiated(cancellation: @escaping () -> Void) { cancellation() }
        func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {}
        func showDownloadDidReceiveData(ofLength length: UInt64) {}
        func showDownloadDidStartExtractingUpdate() {}
        func showExtractionReceivedProgress(_ progress: Double) {}
        func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) { reply(.dismiss) }
        func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) {}
        func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) { acknowledgement() }
        func dismissUpdateInstallation() {}
    }
    /// Runs AppUpdater's own declaration gate, the first step of its veto.
    private final class Gate: NSObject, SPUUpdaterDelegate {
        let host: Bundle
        var reached: [String?] = []
        var refused: [String] = []
        var cycleError: NSError?
        let finished: XCTestExpectation
        init(host: Bundle, finished: XCTestExpectation) { self.host = host; self.finished = finished }
        func updater(_ updater: SPUUpdater, shouldProceedWithUpdate item: SUAppcastItem, updateCheck: SPUUpdateCheck) throws {
            reached.append(item.propertiesDictionary[RecoveryTargetDeclaration.protocolKey] as? String)
            do { try AppUpdater.declarationGate(item, host: host) }
            catch { refused.append(error.localizedDescription); throw error }
        }
        func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor updateCheck: SPUUpdateCheck, error: Error?) {
            cycleError = error as NSError?; finished.fulfill()
        }
    }
    private var base: URL!
    private var key: Curve25519.Signing.PrivateKey!
    private var bundleIDs: [String] = []
    private var server: Process?
    private var port = 0
    override func setUpWithError() throws {
        guard let sdk = ProcessInfo.processInfo.environment["DISPATCH_SPARKLE_SDK"] else { throw XCTSkip("Sparkle SDK not configured") }
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: sdk + "/bin/sign_update"))
        base = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-feed-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        key = Curve25519.Signing.PrivateKey()
        // Sparkle only fetches feeds over http(s); serve fixtures from loopback.
        port = try LocalDatabase.availablePort()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", base.path]
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        try process.run(); server = process
        let deadline = Date(timeIntervalSinceNow: 10)
        while Date() < deadline {
            if (try? Data(contentsOf: URL(string: "http://127.0.0.1:\(port)/")!)) != nil { return }
            Thread.sleep(forTimeInterval: 0.1)
        }
        XCTFail("fixture server did not start")
    }
    override func tearDown() {
        if let server, server.isRunning { server.terminate(); server.waitUntilExit() }
        if let base { try? FileManager.default.removeItem(at: base) }
        for id in bundleIDs { UserDefaults.standard.removePersistentDomain(forName: id) }
    }
    private func feed(_ itemChildren: String, sign: Bool) throws -> URL {
        let xml = """
        <?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dispatch="\(RecoveryTargetDeclaration.namespace)">
          <channel>
            <title>Dispatch</title>
            <item>
              <title>2.0</title>
              <sparkle:version>2</sparkle:version>
              <sparkle:shortVersionString>2.0</sparkle:shortVersionString>
              \(itemChildren)
              <enclosure url="https://example.invalid/Dispatch-2.zip" length="1" type="application/octet-stream" sparkle:edSignature="\(Data(repeating: 1, count: 64).base64EncodedString())"/>
            </item>
          </channel>
        </rss>
        """
        let url = base.appendingPathComponent("appcast-\(UUID().uuidString).xml")
        try Data(xml.utf8).write(to: url)
        if sign {
            let keyFile = base.appendingPathComponent("ed-key")
            try Data(key.rawRepresentation.base64EncodedString().utf8).write(to: keyFile)
            let sdk = ProcessInfo.processInfo.environment["DISPATCH_SPARKLE_SDK"]!
            try RecoveryCommand.run(URL(fileURLWithPath: sdk + "/bin/sign_update"), ["--ed-key-file", keyFile.path, url.path], timeout: 30)
            XCTAssertTrue(try String(contentsOf: url).contains("sparkle-signatures"), "Official sign_update embeds the feed signature")
        }
        return url
    }
    private func host(feed: URL, requireSignedFeed: Bool) throws -> Bundle {
        let id = "dev.bradharris.dispatch.feedtest.\(UUID().uuidString.lowercased())"
        bundleIDs.append(id)
        let app = base.appendingPathComponent("\(id).app/Contents")
        try FileManager.default.createDirectory(at: app.appendingPathComponent("MacOS"), withIntermediateDirectories: true)
        let plist: [String: Any] = [
            "CFBundleIdentifier": id, "CFBundleName": "FeedTest", "CFBundlePackageType": "APPL",
            "CFBundleVersion": "1", "CFBundleShortVersionString": "1.0", "CFBundleExecutable": "FeedTest",
            "SUFeedURL": "http://127.0.0.1:\(port)/\(feed.lastPathComponent)", "SUPublicEDKey": key.publicKey.rawRepresentation.base64EncodedString(),
            "SURequireSignedFeed": requireSignedFeed, "SUVerifyUpdateBeforeExtraction": true,
            "SUSignedFeedFailureExpirationInterval": 0, "SUEnableAutomaticChecks": false,
            "DispatchRecoveryProtocol": 1,
        ]
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0).write(to: app.appendingPathComponent("Info.plist"))
        return try XCTUnwrap(Bundle(url: app.deletingLastPathComponent()))
    }
    private func run(_ children: String, sign: Bool = true, requireSignedFeed: Bool = true, tamper: Bool = false) throws -> Gate {
        let url = try feed(children, sign: sign)
        if tamper {
            let text = try String(contentsOf: url).replacingOccurrences(of: "<title>2.0</title>", with: "<title>2.0 altered</title>")
            try Data(text.utf8).write(to: url)
        }
        let bundle = try host(feed: url, requireSignedFeed: requireSignedFeed)
        let finished = expectation(description: "cycle")
        let gate = Gate(host: bundle, finished: finished)
        let driver = SilentDriver()
        let updater = SPUUpdater(hostBundle: bundle, applicationBundle: bundle, userDriver: driver, delegate: gate)
        try updater.start()
        updater.checkForUpdates()
        wait(for: [finished], timeout: 30)
        withExtendedLifetime((driver, updater)) {}
        return gate
    }
    private func chain(_ error: NSError?) -> String {
        var parts: [String] = []; var next = error
        while let current = next { parts.append(current.localizedDescription); next = current.userInfo[NSUnderlyingErrorKey] as? NSError }
        return parts.joined(separator: " | ")
    }
    private let declared = "<dispatch:recoveryProtocol>1</dispatch:recoveryProtocol>"

    func testSignedNamespacedDeclarationReachesTheVetoAndPasses() throws {
        let gate = try run(declared)
        XCTAssertEqual(gate.reached, ["1"], "Sparkle keys the element by its qualified name")
        XCTAssertEqual(gate.refused, [])
    }
    func testMissingOrMalformedDeclarationIsRefusedAtTheVeto() throws {
        for children in ["", "<dispatch:recoveryProtocol>2</dispatch:recoveryProtocol>", "<dispatch:recoveryProtocol>yes</dispatch:recoveryProtocol>",
                         "<dispatch:recoveryProtocol></dispatch:recoveryProtocol>", "<dispatch:recoveryProtocol value=\"1\"/>",
                         "<other:recoveryProtocol xmlns:other=\"\(RecoveryTargetDeclaration.namespace)\">1</other:recoveryProtocol>"] {
            let gate = try run(children)
            XCTAssertEqual(gate.reached.count, 1, children)
            XCTAssertEqual(gate.refused.count, 1, "must refuse: \(children)")
            XCTAssertNotNil(gate.cycleError, children)
        }
    }
    func testUnsignedOrAlteredFeedNeverReachesTheVeto() throws {
        let unsigned = try run(declared, sign: false)
        XCTAssertEqual(unsigned.reached, [], "SURequireSignedFeed rejects an unsigned feed before items exist")
        XCTAssertTrue(chain(unsigned.cycleError).contains("EdDSA public key"), chain(unsigned.cycleError))
        let altered = try run(declared, tamper: true)
        XCTAssertEqual(altered.reached, [], "A modified signed feed fails verification")
        XCTAssertTrue(chain(altered.cycleError).contains("EdDSA signature does not match"), chain(altered.cycleError))
    }
    func testBuildWithoutSignedFeedRequirementNeverTrustsTheDeclaration() throws {
        let gate = try run(declared, requireSignedFeed: false)
        XCTAssertEqual(gate.reached, ["1"])
        XCTAssertEqual(gate.refused.count, 1)
    }
}
#endif
