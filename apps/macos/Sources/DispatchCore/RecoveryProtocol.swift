import Foundation
import Darwin
import CryptoKit

/// An authenticated server said active work prevents a safe boundary right now. Nothing
/// was stopped or fenced; the update is postponed, never forced and never a recovery.
public struct RecoveryDeferral: LocalizedError, Equatable {
    public static let codes: Set<String> = ["BUSY", "DRAIN_TIMEOUT", "BUSY_AFTER_FENCE", "HOSTS_NOT_QUIESCED", "HOSTS_RUNNING"]
    public let code: String
    public let reasons: [String]
    public init(code: String, reasons: [String]) { self.code = code; self.reasons = reasons }
    public var errorDescription: String? {
        "Dispatch postponed the update because agents are still working\(reasons.isEmpty ? "" : " (\(reasons.prefix(3).joined(separator: ", ")))"). It will retry when they are idle; no work was interrupted."
    }
}

/// This installation cannot be protected automatically. Installation is withdrawn,
/// not downgraded to an unprotected install; the message names the operator procedure.
public struct RecoveryRefusal: LocalizedError, Equatable {
    public let message: String
    /// Permanent refusals turn automatic installs off so the update is not re-staged.
    public let disablesAutomatic: Bool
    public init(_ message: String, disablesAutomatic: Bool = true) { self.message = message; self.disablesAutomatic = disablesAutomatic }
    public var errorDescription: String? { message }
}

/// Authenticated, installation-scoped recovery API. Ordinary health is insufficient.
public enum RecoveryProtocol {
    /// Advisory, authenticated check. The installation fence remains authoritative.
    public static func updateBusy(root: URL) async throws -> Bool {
        let config = try Configuration.read(from: root.appendingPathComponent("configuration.json"))
        guard let token = AppControlToken.read(root: root) else { throw ConfigurationError("Cannot check agent activity. Start the Dispatch server and try again.") }
        let challenge = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        var components = URLComponents(url: config.serverURL.appendingPathComponent(String(prefix.dropFirst()) + "status"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "challenge", value: challenge)]
        var request = URLRequest(url: components.url!)
        request.timeoutInterval = 10
        request.setValue("Dispatch-Recovery \(token)", forHTTPHeaderField: "Authorization")
        let session = URLSession(configuration: .ephemeral, delegate: LocalServerTrust(root: root), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              var body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let proof = body.removeValue(forKey: "proof") as? String,
              try verifyProof(proof, body: body, key: token, route: "status", challenge: challenge, nonce: nil),
              let instance = body["instance"] as? [String: Any], instance["macInstanceId"] as? String == config.instanceID else {
            throw ConfigurationError("Cannot verify agent activity. Check that the Dispatch server is running and try again.")
        }
        // Older servers do not expose activity; their installation fence still guards updates.
        return body["busy"] as? Bool ?? false
    }

    public static let prefix = "/api/v1/system/update-recovery/"
    public static func canonical(_ body: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self)
    }
    public static func verifyProof(_ proof: String, body: [String: Any], key: String, route: String, challenge: String, nonce: String?) throws -> Bool {
        guard proof.count == 64 else { return false }
        var bytes = [UInt8](); var index = proof.startIndex
        while index < proof.endIndex {
            let end = proof.index(index, offsetBy: 2)
            guard let byte = UInt8(proof[index..<end], radix: 16) else { return false }
            bytes.append(byte); index = end
        }
        let secret: [String: Any] = nonce.map { ["nonce": $0] } ?? [:]
        let payload = try "dispatch-recovery-v1\n\(prefix + route)\n\(challenge)\n\(canonical(body))\n\(canonical(secret))"
        return HMAC<SHA256>.isValidAuthenticationCode(bytes, authenticating: Data(payload.utf8), using: SymmetricKey(data: Data(key.utf8)))
    }
    public static func request(_ action: String, journal: NativeRecoveryJournal, root: URL) async throws -> [String: Any] {
        let config = try Configuration.read(from: root.appendingPathComponent("configuration.json"))
        guard let token = AppControlToken.read(root: root) else { throw ConfigurationError("Start Dispatch once before preparing a protected update.") }
        let session = URLSession(configuration: .ephemeral, delegate: LocalServerTrust(root: root), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let name = action == "prepare" || action == "abort" ? "fence" : action
        let challenge = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        var request = URLRequest(url: config.serverURL.appendingPathComponent(String(prefix.dropFirst()) + name))
        request.httpMethod = action == "abort" ? "DELETE" : "POST"
        request.timeoutInterval = action == "prepare" ? 60 : 10
        request.setValue("Dispatch-Recovery \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var input: [String: Any] = ["transactionId": journal.id, "challenge": challenge]
        if action == "prepare" { input["leaseMs"] = 600000 }
        if action == "readiness" {
            guard let version = NSDictionary(contentsOf: URL(fileURLWithPath: journal.appPath).appendingPathComponent("Contents/Info.plist"))?["CFBundleShortVersionString"] as? String else { throw ConfigurationError("Cannot identify recovery app version.") }
            input["nonce"] = journal.nonce; input["instanceId"] = journal.instanceID; input["expectedVersion"] = version
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: input)
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        return try authenticated(status: status, data: data, action: action, key: token, challenge: challenge, journal: journal)
    }
    /// Failure bodies are signed without the readiness nonce. Only a verified 409 with
    /// a known activity code is a deferral; anything else fails closed.
    public static func authenticated(status: Int, data: Data, action: String, key: String, challenge: String, journal: NativeRecoveryJournal) throws -> [String: Any] {
        let name = action == "prepare" || action == "abort" ? "fence" : action
        let success = [200, 202].contains(status)
        guard var body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let proof = body.removeValue(forKey: "proof") as? String,
              try verifyProof(proof, body: body, key: key, route: action == "abort" ? "fence-abort" : name, challenge: challenge, nonce: success && action == "readiness" ? journal.nonce : nil) else {
            throw ConfigurationError("The server could not prove a safe update boundary. Older servers need recovery enrollment first.")
        }
        guard success else {
            if status == 409, let code = body["code"] as? String, RecoveryDeferral.codes.contains(code) {
                throw RecoveryDeferral(code: code, reasons: (body["reasons"] as? [String]) ?? (body["liveHosts"] as? [String]) ?? [])
            }
            throw ConfigurationError("The server refused the update boundary (\(body["code"] as? String ?? "status \(status)")).")
        }
        if action != "abort" {
            guard body["transactionId"] as? String == journal.id,
                  let identity = body["instance"] as? [String: Any], identity["macInstanceId"] as? String == journal.instanceID else {
                throw ConfigurationError("Recovery response belongs to a different transaction or instance.")
            }
        }
        return body
    }
    /// Match the server's POSIX real paths, including macOS /var -> /private/var.
    /// Foundation's URL normalization sometimes removes /private again, so compare
    /// realpath strings rather than URL.path prefixes from different producers.
    public static func acceptsInventory(_ paths: [String], root: URL) -> Bool {
        func canonical(_ url: URL) -> String? {
            var ancestor = url.standardizedFileURL
            var suffix = [String]()
            while true {
                if let resolved = ancestor.withUnsafeFileSystemRepresentation({ value in value.flatMap { realpath($0, nil) } }) {
                    defer { free(resolved) }
                    return String(cString: resolved) + (suffix.isEmpty ? "" : "/" + suffix.reversed().joined(separator: "/"))
                }
                guard errno == ENOENT, ancestor.path != "/" else { return nil }
                suffix.append(ancestor.lastPathComponent); ancestor.deleteLastPathComponent()
            }
        }
        guard !paths.isEmpty, let owned = canonical(root) else { return false }
        return paths.allSatisfy { value in
            guard value.hasPrefix("/"), let path = canonical(URL(fileURLWithPath: value)) else { return false }
            return path == owned || path.hasPrefix(owned + "/")
        }
    }
    public static func prepare(_ journal: NativeRecoveryJournal, root: URL) async throws {
        let body = try await request(journal.wasRunning ? "prepare" : "readiness", journal: journal, root: root)
        guard body["hostsStopped"] as? Bool == true,
              let paths = body["statePaths"] as? [String], acceptsInventory(paths, root: root),
              journal.wasRunning ? body["mode"] as? String == "fenced" : body["ready"] as? Bool == true else {
            throw ConfigurationError("Recovery requires stopped idle hosts and Dispatch-owned state inside the private Mac data directory. External state requires operator recovery.")
        }
    }
    /// Commit as soon as the live menu and authenticated, write-fenced server
    /// prove readiness. The deadline bounds startup; it is not a minimum delay.
    public static func awaitReadiness(
        deadline: Date,
        workerRunning: () -> Bool,
        menuReady: () -> Bool,
        serverReady: () async -> Bool,
        now: () -> Date = Date.init,
        wait: () async throws -> Void = { try await Task.sleep(for: .seconds(1)) }
    ) async throws {
        while now() < deadline {
            guard workerRunning() else { throw ConfigurationError("The probation server exited before readiness.") }
            if menuReady(), await serverReady() {
                // The proof request suspends: neither an exited process nor an
                // expired startup deadline may be accepted on its return.
                guard workerRunning() else { throw ConfigurationError("The probation server exited before readiness.") }
                guard now() < deadline else { break }
                if menuReady() { return }
            }
            try await wait()
        }
        throw ConfigurationError("The app/server failed write-fenced readiness probation.")
    }
    public static func ready(_ journal: NativeRecoveryJournal, root: URL, build: String) async -> Bool {
        guard let body = try? await request("readiness", journal: journal, root: root) else { return false }
        return body["ready"] as? Bool == true && body["macBuild"] as? String == build && body["hostsStopped"] as? Bool == true
    }
}

public enum RecoveryEnrollment {
    public static func enroll(store: NativeRecoveryStore, app: URL, journal: NativeRecoveryJournal) throws {
        try store.initialize()
        let helper = store.directory.appendingPathComponent("DispatchRecovery")
        let source = app.appendingPathComponent("Contents/Helpers/DispatchRecovery")
        // Never replace a pinned helper during an unfinished transaction.
        if let previous = try store.read(), !previous.terminal { throw ConfigurationError("Finish the pending native recovery before starting another update.") }
        try RecoveryCommand.run(URL(fileURLWithPath: "/usr/bin/codesign"), ["--verify", "--strict", source.path])
        let stage = store.directory.appendingPathComponent(".helper-\(UUID().uuidString)")
        try store.copy(source, stage)
        guard rename(stage.path, helper.path) == 0 else { throw ConfigurationError("Cannot retain the signed recovery launcher.") }
        try NativeRecoveryStore.syncDirectory(store.directory)
        try FileManager.default.createDirectory(at: plistURL(instanceID: journal.instanceID).deletingLastPathComponent(), withIntermediateDirectories: true)
        let label = label(instanceID: journal.instanceID)
        let plist = plistURL(instanceID: journal.instanceID)
        let body: [String: Any] = ["Label": label, "ProgramArguments": [helper.path, "watch", store.root.path], "RunAtLoad": true, "StartInterval": 30, "ProcessType": "Background", "ExitTimeOut": 60, "ThrottleInterval": 10]
        let data = try PropertyListSerialization.data(fromPropertyList: body, format: .xml, options: 0)
        try data.write(to: plist, options: .atomic); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: plist.path)
        try store.save(journal)
        let launchctl = URL(fileURLWithPath: "/bin/launchctl")
        let domain = "gui/\(getuid())"
        // A pre-existing launcher already points to this fixed retained location.
        if (try? RecoveryCommand.run(launchctl, ["print", "\(domain)/\(label)"])) == nil {
            try RecoveryCommand.run(launchctl, ["bootstrap", domain, plist.path])
        }
        try RecoveryCommand.run(launchctl, ["kickstart", "\(domain)/\(label)"])
    }
    public static func label(instanceID: String) -> String { "dev.bradharris.dispatch.recovery.\(instanceID.lowercased())" }
    public static func plistURL(instanceID: String) -> URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/\(label(instanceID: instanceID)).plist")
    }
    /// Bounded: one kickstart request. Callers limit how many they make.
    public static func kickstart(instanceID: String) throws {
        let launchctl = URL(fileURLWithPath: "/bin/launchctl")
        let target = "gui/\(getuid())/\(label(instanceID: instanceID))"
        if (try? RecoveryCommand.run(launchctl, ["print", target], timeout: 10)) == nil {
            try RecoveryCommand.run(launchctl, ["bootstrap", "gui/\(getuid())", plistURL(instanceID: instanceID).path], timeout: 10)
        }
        try RecoveryCommand.run(launchctl, ["kickstart", target], timeout: 10)
    }
    /// Called by the helper itself once the handoff is handled. The plist goes first so
    /// a bootout that terminates this process cannot leave a launcher behind.
    public static func retire(instanceID: String, plist: URL? = nil, unload: (String) -> Void = { target in
        _ = try? RecoveryCommand.run(URL(fileURLWithPath: "/bin/launchctl"), ["bootout", target], timeout: 10)
    }) throws {
        let plist = plist ?? plistURL(instanceID: instanceID)
        if FileManager.default.fileExists(atPath: plist.path) { try FileManager.default.removeItem(at: plist) }
        unload("gui/\(getuid())/\(label(instanceID: instanceID))")
    }
    /// Bounded synchronous wait for the helper to acknowledge this transaction.
    public static func awaitAcknowledgment(store: NativeRecoveryStore, journal: NativeRecoveryJournal, timeout: TimeInterval = 10, sleep: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }) -> Bool {
        let deadline = Date(timeIntervalSinceNow: timeout)
        while !acknowledged(store: store, journal: journal) {
            guard Date() < deadline else { return false }
            sleep(0.1)
        }
        return true
    }
    public static func acknowledged(store: NativeRecoveryStore, journal: NativeRecoveryJournal) -> Bool {
        guard let data = try? Data(contentsOf: store.directory.appendingPathComponent("helper-ready.json")),
              let value = try? JSONDecoder().decode([String: String].self, from: data) else { return false }
        return value["transactionId"] == journal.id
    }
    public static func menuAcknowledgment(store: NativeRecoveryStore, build: String) throws {
        guard let j = try store.read(), !j.permitsOrdinaryStart(build: build) else { return }
        try NativeRecoveryStore.durableJSON(RecoveryProcess.current(transaction: j, build: build), to: store.directory.appendingPathComponent("menu-ready.json"))
    }
}
