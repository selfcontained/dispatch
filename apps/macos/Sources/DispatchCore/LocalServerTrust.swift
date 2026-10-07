import Foundation
import Security

/// Trust only this installation's CA for its own health check, without modifying
/// device trust or accepting invalid certificates/hostnames.
public final class LocalServerTrust: NSObject, URLSessionDelegate {
    /// Update recovery and its probe must use the same scoped trust as the menu.
    public static func isHealthy(configuration: Configuration, root: URL) async -> Bool {
        let url = configuration.serverURL.appendingPathComponent("api/v1/health")
        let session = URLSession(configuration: .ephemeral,
                                 delegate: url.scheme == "https" ? LocalServerTrust(root: root) : nil,
                                 delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1; request.cachePolicy = .reloadIgnoringLocalCacheData
        guard let (data, response) = try? await session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return body["status"] as? String == "ok" && body["macInstanceId"] as? String == configuration.instanceID && body["updateOwner"] as? String == "macos-app"
    }
    private let certificate: SecCertificate?
    public init(root: URL) {
        certificate = (try? Data(contentsOf: root.appendingPathComponent("tls/ca/cert.cer"))).flatMap {
            SecCertificateCreateWithData(nil, $0 as CFData)
        }
    }
    public func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                           completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust, let certificate else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        SecTrustSetAnchorCertificates(trust, [certificate] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        SecTrustSetNetworkFetchAllowed(trust, false)
        if SecTrustEvaluateWithError(trust, nil) {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else { completionHandler(.cancelAuthenticationChallenge, nil) }
    }
}
