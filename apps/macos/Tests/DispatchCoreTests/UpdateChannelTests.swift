import DispatchCore
import XCTest

final class UpdateChannelTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let name = "UpdateChannelTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        addTeardownBlock { defaults.removePersistentDomain(forName: name) }
        return defaults
    }

    func testBuildDefaultAppliesUntilAChannelIsSaved() {
        let store = defaults()
        XCTAssertEqual(UpdateChannel.current(defaults: store, buildDefault: "preview"), .preview)
        XCTAssertEqual(UpdateChannel.current(defaults: store, buildDefault: nil), .stable)
        XCTAssertEqual(UpdateChannel.current(defaults: store, buildDefault: "nightly"), .stable)
        UpdateChannel.stable.save(defaults: store)
        XCTAssertEqual(UpdateChannel.current(defaults: store, buildDefault: "preview"), .stable)
    }

    func testOnlyPreviewAllowsTheTaggedChannel() {
        XCTAssertEqual(UpdateChannel.preview.sparkleChannels, ["preview"])
        XCTAssertEqual(UpdateChannel.stable.sparkleChannels, [])
    }
}
