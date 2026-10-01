import Foundation
import Security

/// Trust only this installation's CA for its own health check, without modifying
/// device trust or accepting invalid certificates/hostnames.
public final class LocalServerTrust: NSObject, URLSessionDelegate {
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
