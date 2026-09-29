import AppKit
import Darwin
import DispatchCore

@MainActor
final class SetupFields: NSObject {
    let view = NSStackView()
    let databaseView = NSStackView()
    let port: NSTextField
    let database: NSSecureTextField
    let external = NSButton(checkboxWithTitle: "Use my own PostgreSQL database", target: nil, action: nil)
    private let databaseLabel = NSTextField(labelWithString: "Connection URL")
    private let addresses = NSStackView()
    private var choices: [NSButton] = []
    private let customAddress = NSTextField()
    var selectedHosts: [String] { choices.filter { $0.state == .on }.compactMap { $0.identifier?.rawValue } }

    init(configuration: Configuration) {
        port = NSTextField(string: String(configuration.port))
        database = NSSecureTextField(string: configuration.usesManagedDatabase ? "" : configuration.databaseURL)
        super.init()
        port.setAccessibilityLabel("Port")
        database.setAccessibilityLabel("PostgreSQL connection URL")
        database.placeholderString = "postgres://user:password@localhost/dispatch_app"
        external.state = !configuration.databaseURL.isEmpty && !configuration.usesManagedDatabase ? .on : .off
        external.target = self; external.action = #selector(toggleDatabase)
        for stack in [view, databaseView, addresses] { stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8 }
        let available = Set(Self.localAddresses().filter { $0 != "::1" } + configuration.bindHosts + ["127.0.0.1"])
        for address in ["127.0.0.1"] + available.filter({ $0 != "127.0.0.1" }).sorted() { addChoice(address, selected: configuration.bindHosts.contains(address)) }
        let note = NSTextField(wrappingLabelWithString: "Choose the addresses where Dispatch is available.")
        note.textColor = .secondaryLabelColor; note.font = .systemFont(ofSize: 12)
        customAddress.placeholderString = "Add another IP address"
        customAddress.setAccessibilityLabel("Additional IP address")
        let add = NSButton(title: "Add", target: self, action: #selector(addAddress))
        let custom = NSStackView(views: [customAddress, add]); custom.spacing = 8
        customAddress.widthAnchor.constraint(equalToConstant: 260).isActive = true
        for field in [note, addresses, custom, NSTextField(labelWithString: "Port"), port] { view.addArrangedSubview(field) }
        port.widthAnchor.constraint(equalToConstant: 110).isActive = true
        let hint = NSTextField(wrappingLabelWithString: "Dispatch manages a private database by default.")
        hint.textColor = .secondaryLabelColor; hint.font = .systemFont(ofSize: 12)
        for field in [hint, external, databaseLabel, database] { databaseView.addArrangedSubview(field) }
        database.widthAnchor.constraint(equalToConstant: 430).isActive = true
        toggleDatabase()
    }
    private func addChoice(_ address: String, selected: Bool) {
        let title = address == "127.0.0.1" ? "This Mac (127.0.0.1)" : address == "::1" ? "This Mac (::1)" : address
        let button = NSButton(checkboxWithTitle: title, target: nil, action: nil)
        button.identifier = NSUserInterfaceItemIdentifier(address); button.state = selected ? .on : .off
        choices.append(button); addresses.addArrangedSubview(button)
    }
    @objc private func addAddress() {
        let value = customAddress.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        var config = Configuration(databaseURL: "postgres://localhost/dispatch_preview", hosts: [value])
        // All-interface bindings are supported for older saved settings but not
        // offered as an alternative to selecting explicit addresses.
        config.host = nil
        guard (try? config.validate()) != nil else { NSSound.beep(); return }
        if let choice = choices.first(where: { $0.identifier?.rawValue == value }) { choice.state = .on }
        else { addChoice(value, selected: true) }
        customAddress.stringValue = ""
    }
    @objc private func toggleDatabase() {
        database.isHidden = external.state != .on; databaseLabel.isHidden = external.state != .on
    }
    private static func localAddresses() -> [String] {
        var first: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&first) == 0 else { return [] }
        defer { freeifaddrs(first) }
        var current = first
        var addresses = Set<String>()
        while let entry = current {
            defer { current = entry.pointee.ifa_next }
            guard let socket = entry.pointee.ifa_addr,
                  (entry.pointee.ifa_flags & UInt32(IFF_UP)) != 0,
                  socket.pointee.sa_family == UInt8(AF_INET) || socket.pointee.sa_family == UInt8(AF_INET6) else { continue }
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(socket, socklen_t(socket.pointee.sa_len), &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 {
                let value = String(cString: buffer)
                // Scoped link-local IPv6 addresses require interface-specific URL handling.
                if !value.contains("%") { addresses.insert(value) }
            }
        }
        return addresses.sorted()
    }

    func setEnabled(_ enabled: Bool) {
        for control in ([port, database, external, customAddress] as [NSControl]) + choices { control.isEnabled = enabled }
    }
}
