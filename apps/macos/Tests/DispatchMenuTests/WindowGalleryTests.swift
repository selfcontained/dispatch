import AppKit
import DispatchCore
@testable import DispatchMenu
import XCTest

/// Renders the app-owned windows with fake callbacks into PNGs for design review.
/// Offscreen only: no installed app, service, or update state is touched.
/// Run with DISPATCH_WINDOW_GALLERY=<directory>.
final class WindowGalleryTests: XCTestCase {
    @MainActor private func render(_ window: NSWindow, _ name: String, dark: Bool, size: NSSize? = nil) throws {
        guard let directory = ProcessInfo.processInfo.environment["DISPATCH_WINDOW_GALLERY"] else { return }
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        if let size { window.setContentSize(size) }
        let frame = try XCTUnwrap(window.contentView?.superview)
        frame.layoutSubtreeIfNeeded(); frame.display()
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
        let bitmap = try XCTUnwrap(frame.bitmapImageRepForCachingDisplay(in: frame.bounds))
        frame.cacheDisplay(in: frame.bounds, to: bitmap)
        let url = URL(fileURLWithPath: directory).appendingPathComponent("\(name)-\(dark ? "dark" : "light").png")
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: url)
    }

    @MainActor func testRenderGallery() throws {
        guard ProcessInfo.processInfo.environment["DISPATCH_WINDOW_GALLERY"] != nil else { throw XCTSkip("Set DISPATCH_WINDOW_GALLERY to render") }
        _ = NSApplication.shared
        let oldRoot = AppPaths.testRoot
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("dispatch-gallery-\(UUID().uuidString)")
        AppPaths.testRoot = root
        let oldAddresses = SetupFields.interfaceAddresses
        // Documentation addresses only; previews never show this Mac's interfaces.
        SetupFields.interfaceAddresses = { ["192.0.2.24", "198.51.100.7", "2001:db8::24"] }
        let resources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources")
        Brand.icon = Brand.appIcon(resources: resources)
        defer { AppPaths.testRoot = oldRoot; SetupFields.interfaceAddresses = oldAddresses; try? FileManager.default.removeItem(at: root) }
        let config = Configuration(port: 6767, databaseURL: "postgres://dispatch@127.0.0.1:6543/dispatch", hosts: ["127.0.0.1"])
        for dark in [false, true] {
            let settings = SettingsWindowController(configuration: config)
            settings.update(configuration: config, runningConfiguration: config, displayURL: URL(string: "https://127.0.0.1:6767")!, status: "Running", active: true,
                            loginEnabled: true, canChangeLogin: true, needsApproval: false, busy: false, serverAtLogin: true)
            let window = try XCTUnwrap(settings.window)
            for index in 0..<settings.sectionCount {
                settings.selectSection(at: index)
                try render(window, "settings-\(index)-\(settings.sectionTitle(at: index).lowercased())", dark: dark)
            }
            settings.selectSection(at: 0)
            settings.update(configuration: config, runningConfiguration: nil, status: "Needs permission in System Settings", active: false,
                            loginEnabled: false, canChangeLogin: true, needsApproval: true, busy: false, serverAtLogin: false)
            try render(window, "settings-approval", dark: dark)
            try render(window, "settings-narrow", dark: dark, size: window.minSize)
            settings.close()

            let fresh = SettingsWindowController(configuration: Configuration())
            fresh.update(configuration: Configuration(), runningConfiguration: nil, status: "Not configured", active: false,
                         loginEnabled: false, canChangeLogin: true, needsApproval: false, busy: false, serverAtLogin: false)
            try render(try XCTUnwrap(fresh.window), "settings-first-run", dark: dark)
            fresh.close()

            let progress = UpdateProgressWindow()
            let phases: [(String, UpdateProgressWindow.Phase)] = [
                ("checking", .checkingActivity), ("waiting", .waitingForAgents), ("preparing", .preparing),
                ("restarting", .restarting), ("paused", .stopped("Couldn’t check agent activity. Try Check for Updates again. The request timed out.")),
                ("cancel-failed", .cancelFailed("Couldn’t cancel the staged update. Try again, or close this window to leave it pending. The operation couldn’t be completed.")),
            ]
            for (name, phase) in phases {
                progress.update(phase)
                try render(try XCTUnwrap(progress.window), "update-\(name)", dark: dark)
            }
            progress.update(.stopped("Agents are still working. Dispatch will retry automatically when agents are idle."))
            try render(try XCTUnwrap(progress.window), "update-postponed", dark: dark)
            progress.update(phases[4].1)
            func descendants(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + descendants($0) } }
            try XCTUnwrap(descendants(try XCTUnwrap(progress.window?.contentView)).compactMap { $0 as? NSButton }.first { $0.title == "Show Details" }).performClick(nil)
            try render(try XCTUnwrap(progress.window), "update-paused-details", dark: dark)
            progress.close()
        }
    }
}
