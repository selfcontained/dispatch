// Test-only probe: run a real Sparkle SPUUpdater information check against
// the host bundle's SUFeedURL and print what Sparkle hands to the app.
// Built and driven by test_macos_appcast.py when DISPATCH_SPARKLE_SDK is set.
import AppKit
import Sparkle

final class Probe: NSObject, SPUUpdaterDelegate {
    func allowedChannels(for updater: SPUUpdater) -> Set<String> { ["preview"] }
    func updater(_ updater: SPUUpdater, didFinishLoading appcast: SUAppcast) {
        print("feed status=\(appcast.signingValidationStatus.rawValue)")
        for item in appcast.items {
            let keys = item.propertiesDictionary.keys.map { "\($0)" }.filter { !$0.hasPrefix("sparkle:") }.sorted()
            print("item \(item.versionString) recovery=\(item.propertiesDictionary["dispatch:recoveryProtocol"] as? String ?? "-") keys=\(keys.joined(separator: ","))")
        }
    }
    func updater(_ updater: SPUUpdater, didFinishUpdateCycleFor check: SPUUpdateCheck, error: Error?) {
        print("error=\((error as NSError?)?.code.description ?? "none")")
        exit(0)
    }
}

let host = Bundle(path: CommandLine.arguments[1])!
let probe = Probe()
let updater = SPUUpdater(hostBundle: host, applicationBundle: host,
                         userDriver: SPUStandardUserDriver(hostBundle: host, delegate: nil), delegate: probe)
do { try updater.start() } catch { print("start failed: \(error)"); exit(2) }
updater.checkForUpdateInformation()
DispatchQueue.main.asyncAfter(deadline: .now() + 30) { print("timeout"); exit(3) }
NSApplication.shared.run()
