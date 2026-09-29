import AppKit
import DispatchCore
@testable import DispatchMenu
import XCTest

final class SetupFieldsTests: XCTestCase {
    @MainActor func testDefaultSetupNeedsNoCredentialsAndAdvancedToggleWorks() throws {
        _ = NSApplication.shared
        let fields = SetupFields(configuration: Configuration())
        XCTAssertEqual(fields.external.state, .off)
        XCTAssertTrue(fields.database.isHidden)
        XCTAssertEqual(fields.port.stringValue, "6768")
        fields.external.performClick(nil)
        XCTAssertEqual(fields.external.state, .on)
        XCTAssertFalse(fields.database.isHidden)
        fields.database.stringValue = "postgres://localhost/preview"
        fields.external.performClick(nil)
        XCTAssertTrue(fields.database.isHidden)
        fields.external.performClick(nil)
        XCTAssertEqual(fields.database.stringValue, "postgres://localhost/preview")
        fields.external.performClick(nil)
        // Render the actual AppKit controls after exercising both toggle directions.
        if let path = ProcessInfo.processInfo.environment["DISPATCH_TEST_SETUP_SCREENSHOT"] {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
            window.title = "Set up Dispatch Preview"
            window.contentView?.addSubview(fields.view)
            fields.view.frame.origin = NSPoint(x: 24, y: 40)
            fields.view.layoutSubtreeIfNeeded()
            let view = window.contentView!
            let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds)!
            view.cacheDisplay(in: view.bounds, to: bitmap)
            try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
        }
    }

    @MainActor func testExistingExternalConfigurationStaysAdvanced() {
        _ = NSApplication.shared
        let fields = SetupFields(configuration: Configuration(databaseURL: "postgres://localhost/preview"))
        XCTAssertEqual(fields.external.state, .on)
        XCTAssertFalse(fields.database.isHidden)
        XCTAssertEqual(fields.database.stringValue, "postgres://localhost/preview")
    }
}
