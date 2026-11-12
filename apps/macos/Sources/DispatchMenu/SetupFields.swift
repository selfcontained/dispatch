import AppKit
import Darwin
import DispatchCore

@MainActor
final class SetupFields: NSObject {
    /// Address choices plus the add-address row.
    let view = NSStackView()
    let portRow: NSStackView
    /// External database toggle and its connection URL.
    let databaseView = NSStackView()
    /// Interface discovery; replaceable so rendered previews never show real host addresses.
    static var interfaceAddresses: () -> [String] = localAddresses
    let port: NSTextField
    let database: NSSecureTextField
    let external = NSSwitch()
    private(set) var externalRow: NSStackView!
    private let databaseLabel = NSTextField(labelWithString: "Connection URL")
    private let addresses = NSStackView()
    private var choices: [NSSwitch] = []
    private let customAddress = NSTextField()
    var selectedHosts: [String] { choices.filter { $0.state == .on }.compactMap { $0.identifier?.rawValue } }

    init(configuration: Configuration) {
        port = NSTextField(string: String(configuration.port))
        database = NSSecureTextField(string: configuration.usesManagedDatabase ? "" : configuration.databaseURL)
        portRow = Form.row("Port", port)
        super.init()
        port.setAccessibilityLabel("Port")
        database.setAccessibilityLabel("PostgreSQL connection URL")
        database.placeholderString = "postgres://user:password@localhost/dispatch_app"
        externalRow = Form.row("Use my own PostgreSQL database", external)
        external.state = !configuration.databaseURL.isEmpty && !configuration.usesManagedDatabase ? .on : .off
        external.target = self; external.action = #selector(toggleDatabase)
        for stack in [view, databaseView, addresses] { stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10 }
        let available = Set(Self.interfaceAddresses().filter { $0 != "::1" } + configuration.bindHosts + ["127.0.0.1"])
        for address in ["127.0.0.1"] + available.filter({ $0 != "127.0.0.1" }).sorted() { addChoice(address, selected: configuration.bindHosts.contains(address)) }
        customAddress.placeholderString = "Add another IP address"
        customAddress.setAccessibilityLabel("Additional IP address")
        let add = NSButton(title: "Add", target: self, action: #selector(addAddress))
        add.setAccessibilityLabel("Add IP address")
        let custom = Form.hstack([customAddress, add])
        customAddress.widthAnchor.constraint(greaterThanOrEqualToConstant: 180).isActive = true
        customAddress.setContentHuggingPriority(.defaultLow, for: .horizontal)
        for field in [addresses, custom] {
            view.addArrangedSubview(field)
            field.widthAnchor.constraint(equalTo: view.widthAnchor).isActive = true
        }
        port.alignment = .right
        port.widthAnchor.constraint(equalToConstant: 90).isActive = true
        databaseLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        let urlRow = Form.hstack([databaseLabel, database])
        database.setContentHuggingPriority(.defaultLow, for: .horizontal)
        for field in [externalRow!, urlRow] {
            databaseView.addArrangedSubview(field)
            field.widthAnchor.constraint(equalTo: databaseView.widthAnchor).isActive = true
        }
        toggleDatabase()
    }
    private func addChoice(_ address: String, selected: Bool) {
        let title = address == "127.0.0.1" ? "This Mac (127.0.0.1)" : address == "::1" ? "This Mac (::1)" : address
        let toggle = NSSwitch()
        toggle.identifier = NSUserInterfaceItemIdentifier(address); toggle.state = selected ? .on : .off
        choices.append(toggle)
        let row = Form.row(title, toggle)
        addresses.addArrangedSubview(row)
        row.widthAnchor.constraint(equalTo: addresses.widthAnchor).isActive = true
    }
    @objc private func addAddress() {
        let value = customAddress.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        var config = Configuration(databaseURL: "postgres://localhost/dispatch_mac", hosts: [value])
        // All-interface bindings are supported for older saved settings but not
        // offered as an alternative to selecting explicit addresses.
        config.host = nil
        guard (try? config.validate()) != nil else { NSSound.beep(); return }
        if let choice = choices.first(where: { $0.identifier?.rawValue == value }) { choice.state = .on }
        else { addChoice(value, selected: true) }
        customAddress.stringValue = ""
    }
    @objc private func toggleDatabase() {
        let hidden = external.state != .on
        database.isHidden = hidden; databaseLabel.isHidden = hidden; database.superview?.isHidden = hidden
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
