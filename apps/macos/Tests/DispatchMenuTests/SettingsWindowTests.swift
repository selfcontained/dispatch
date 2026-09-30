import AppKit
import DispatchCore
@testable import DispatchMenu
import XCTest

final class SettingsWindowTests: XCTestCase {
    @MainActor func testExternalServerUsesExactURLAndDisablesUnavailableActions() throws {
        _ = NSApplication.shared
        let controller = SettingsWindowController(configuration: Configuration())
        let url = URL(string: "http://127.0.0.1:51243")!
        controller.update(configuration: Configuration(), runningConfiguration: nil, displayURL: url,
                          canControlServer: false, canSave: false, status: "Running", active: true,
                          loginEnabled: false, canChangeLogin: false, needsApproval: false, busy: false, serverAtLogin: false)
        let view = try XCTUnwrap(controller.window?.contentView)
        let tabs = try XCTUnwrap(view.subviews.first as? NSTabView)
        tabs.selectTabViewItem(at: 0)
        func descendants(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + descendants($0) } }
        XCTAssertTrue(descendants(view).compactMap { $0 as? NSTextField }.contains { $0.stringValue == url.absoluteString })
        let buttons = descendants(view).compactMap { $0 as? NSButton }
        XCTAssertFalse(try XCTUnwrap(buttons.first { $0.title == "Stop Server" }).isEnabled)
        var copied: String?
        controller.copyText = { copied = $0 }
        try XCTUnwrap(buttons.first { $0.toolTip == "Copy URL" }).performClick(nil)
        XCTAssertEqual(copied, url.absoluteString)
        tabs.selectTabViewItem(at: 1)
        XCTAssertEqual(tabs.selectedTabViewItem?.label, "Network")
        XCTAssertFalse(try XCTUnwrap(descendants(view).compactMap { $0 as? NSButton }.first { $0.title == "Save" }).isEnabled)
    }

    @MainActor func testSettingsKeepSavingStartupAndRunningStateIndependent() throws {
        _ = NSApplication.shared
        let config = Configuration(databaseURL: "postgres://localhost/preview", hosts: ["127.0.0.1", "::1"])
        let controller = SettingsWindowController(configuration: config)
        controller.update(configuration: config, runningConfiguration: config, status: "Running", active: true, loginEnabled: false, canChangeLogin: true, needsApproval: false, busy: false, serverAtLogin: false)
        let view = try XCTUnwrap(controller.window?.contentView)
        let tabs = try XCTUnwrap(view.subviews.first as? NSTabView)
        func descendants(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + descendants($0) } }
        var startStops = 0
        var startup: Bool?
        var saved: [String]?
        controller.onStartStop = { startStops += 1 }
        controller.onServerLoginChange = { startup = $0 }
        controller.onSave = { saved = $0.selectedHosts }
        tabs.selectTabViewItem(at: 0)
        let login = try XCTUnwrap(descendants(view).compactMap { $0 as? NSButton }.first { $0.title == "Start server at login" })
        login.performClick(nil)
        XCTAssertEqual(startup, true)
        XCTAssertEqual(startStops, 0)
        XCTAssertTrue(descendants(view).compactMap { $0 as? NSPopUpButton }.isEmpty)
        tabs.selectTabViewItem(at: 1)
        let save = try XCTUnwrap(descendants(view).compactMap { $0 as? NSButton }.first { $0.title == "Save" })
        XCTAssertTrue(save.isEnabled)
        save.performClick(nil)
        XCTAssertEqual(Set(saved ?? []), Set(config.bindHosts))
        XCTAssertEqual(startStops, 0)
        tabs.selectTabViewItem(at: 0)
        let stop = try XCTUnwrap(descendants(view).compactMap { $0 as? NSButton }.first { $0.title == "Stop Server" })
        stop.performClick(nil)
        XCTAssertEqual(startStops, 1)
        XCTAssertEqual(startup, true)
        tabs.selectTabViewItem(at: 2)
        XCTAssertEqual(descendants(view).compactMap { $0 as? NSSecureTextField }.count, 1, "Only the editable external connection URL remains")
        tabs.selectTabViewItem(at: 3)
        XCTAssertEqual(descendants(view).compactMap { $0 as? NSButton }.filter { $0.title == "Copy Path" }.count, 1)
    }
    @MainActor func testStoppingDisablesServerAction() throws {
        _ = NSApplication.shared
        let controller = SettingsWindowController(configuration: Configuration())
        controller.update(configuration: Configuration(), runningConfiguration: nil, status: "Stopping…", active: true, loginEnabled: false, canChangeLogin: true, needsApproval: false, busy: false, serverAtLogin: false, stopping: true)
        let view = try XCTUnwrap(controller.window?.contentView)
        func descendants(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + descendants($0) } }
        try XCTUnwrap(view.subviews.first as? NSTabView).selectTabViewItem(at: 0)
        let button = try XCTUnwrap(descendants(view).compactMap { $0 as? NSButton }.first { $0.title == "Stopping…" })
        XCTAssertFalse(button.isEnabled)
    }

    @MainActor func testMenuLogoHasTemplateRepresentations() throws {
        let resources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources")
        let image = try XCTUnwrap(dispatchStatusIcon(resources: resources))
        XCTAssertTrue(image.isTemplate)
        XCTAssertEqual(image.size, NSSize(width: 18, height: 18))
        XCTAssertEqual(image.representations.map { $0.pixelsWide }, [18, 36])
    }

    @MainActor func testNetworkChoicesPrioritizeIPv4LoopbackAndPreserveSavedIPv6() {
        _ = NSApplication.shared
        func descendants(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + descendants($0) } }
        let fields = SetupFields(configuration: Configuration())
        let addresses = descendants(fields.view).compactMap { ($0 as? NSButton)?.identifier?.rawValue }
        XCTAssertEqual(addresses.first, "127.0.0.1")
        XCTAssertFalse(addresses.contains("::1"))
        let existing = SetupFields(configuration: Configuration(hosts: ["::1"]))
        XCTAssertEqual(existing.selectedHosts, ["::1"], "Do not silently change existing explicitly saved IPv6 bindings")
    }

}
