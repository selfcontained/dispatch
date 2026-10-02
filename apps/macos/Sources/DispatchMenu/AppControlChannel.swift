import DispatchCore
import Foundation

/// Holds the menu app's SSE connection to its own server, so the web app can check
/// for and install updates. Commands arrive on the stream; state goes back by POST.
@MainActor
final class AppControlChannel {
    var onCommand: ((String) -> Void)?
    /// The current update state, reported on connect and after each change.
    var state: () -> AppUpdateState? = { nil }
    /// The server's URL while it is healthy; nil while stopped or starting.
    var serverURL: () -> URL? = { nil }
    private let root: URL
    private var task: Task<Void, Never>?
    private var connection: (url: URL, token: String, session: URLSession)?
    private lazy var reporter = LatestOnlySender { [weak self] in await self?.sendState() }

    init(root: URL = AppPaths.root) { self.root = root }

    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            while !Task.isCancelled {
                await self?.connectOnce()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    /// Sends the current state if connected. Failures are dropped: the next
    /// connection reports again.
    func report() { if connection != nil { reporter.request() } }

    private func sendState() async {
        guard let connection, let state = state(), let body = try? state.encoded() else { return }
        var request = URLRequest(url: connection.url.appendingPathComponent("api/v1/mac-app/state"))
        request.httpMethod = "POST"
        request.httpBody = body
        request.timeoutInterval = 5
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        _ = try? await connection.session.data(for: request)
    }

    private func connectOnce() async {
        guard let url = serverURL(), let token = AppControlToken.read(root: root) else { return }
        var request = URLRequest(url: url.appendingPathComponent("api/v1/mac-app/control"))
        // The server sends a keepalive every 20 seconds.
        request.timeoutInterval = 60
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let session = Self.session(for: url, root: root)
        defer { connection = nil; session.invalidateAndCancel() }
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
            for try await line in bytes.lines {
                switch AppControlEvent(line: line) {
                case .ready: connection = (url, token, session); report()
                case .command(let action): onCommand?(action)
                case nil: break
                }
            }
        } catch {}
    }

    private static func session(for url: URL, root: URL) -> URLSession {
        URLSession(configuration: .ephemeral, delegate: url.scheme == "https" ? LocalServerTrust(root: root) : nil, delegateQueue: nil)
    }
}
