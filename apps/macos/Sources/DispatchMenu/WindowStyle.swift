import AppKit

/// Shared presentation for app-owned windows: the existing Dispatch icon and
/// green, plus native grouped-form building blocks. No behavior lives here.
@MainActor
enum Brand {
    /// The icon green, used only for status marks; text stays system-colored for contrast.
    static let green = NSColor(srgbRed: 0x14 / 255, green: 0xB9 / 255, blue: 0x81 / 255, alpha: 1)
    static var icon: NSImage = appIcon()

    static func appIcon(resources: URL? = Bundle.main.resourceURL) -> NSImage {
        if let url = resources?.appendingPathComponent("Dispatch.icns"), let image = NSImage(contentsOf: url) { return image }
        return NSApp?.applicationIconImage ?? NSImage(named: NSImage.applicationIconName) ?? NSImage()
    }

    static func iconView(size: CGFloat) -> NSImageView {
        let view = NSImageView(image: icon)
        view.imageScaling = .scaleProportionallyUpOrDown
        view.translatesAutoresizingMaskIntoConstraints = false
        view.widthAnchor.constraint(equalToConstant: size).isActive = true
        view.heightAnchor.constraint(equalToConstant: size).isActive = true
        view.setAccessibilityElement(false)
        return view
    }

    /// Status tone for a server/update state. Color is never the only signal; the text names the state.
    enum Tone { case good, pending, attention, neutral }
    static func color(_ tone: Tone) -> NSColor {
        switch tone {
        case .good: return green
        case .pending: return .systemOrange
        case .attention: return .systemRed
        case .neutral: return .tertiaryLabelColor
        }
    }
}

@MainActor
enum Form {
    static func title(_ text: String, size: CGFloat = 13) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: size, weight: .semibold)
        label.setAccessibilityRole(.staticText)
        return label
    }
    static func note(_ text: String = "") -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.textColor = .secondaryLabelColor
        label.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        return label
    }
    static func value(_ text: String = "") -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.isSelectable = true
        return label
    }
    static func hstack(_ views: [NSView], spacing: CGFloat = 8) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .horizontal; stack.spacing = spacing; stack.alignment = .centerY
        return stack
    }
    static func vstack(_ views: [NSView], spacing: CGFloat = 8) -> NSStackView {
        let stack = NSStackView(views: views)
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = spacing
        return stack
    }
    static func spacer() -> NSView {
        let view = NSView()
        view.setContentHuggingPriority(.init(1), for: .horizontal)
        view.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        return view
    }
    /// Every form row: label on the leading edge, control(s) on the trailing edge.
    static func row(_ label: String, _ controls: NSView...) -> NSStackView {
        let text = NSTextField(labelWithString: label)
        text.setContentCompressionResistancePriority(.required, for: .horizontal)
        text.setContentHuggingPriority(.required, for: .horizontal)
        for case let control as NSControl in controls where control.accessibilityLabel() == nil { control.setAccessibilityLabel(label) }
        return hstack([text, spacer()] + controls)
    }
    /// A read-only value row; the value truncates in the middle rather than pushing controls out.
    static func valueRow(_ label: String, _ value: NSTextField, _ accessories: NSView...) -> NSStackView {
        value.alignment = .right; value.textColor = .secondaryLabelColor
        value.maximumNumberOfLines = 1; value.lineBreakMode = .byTruncatingMiddle
        value.cell?.truncatesLastVisibleLine = true
        value.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        value.setAccessibilityLabel(label)
        let text = NSTextField(labelWithString: label)
        text.setContentCompressionResistancePriority(.required, for: .horizontal)
        return hstack([text, spacer(), value] + accessories)
    }
    /// Trailing action row, optionally with feedback text on the leading side.
    static func actions(_ buttons: [NSView], feedback: NSTextField? = nil) -> NSStackView {
        hstack((feedback.map { [$0] } ?? []) + [spacer()] + buttons)
    }
    /// Pads a view by the group's content inset so titles and footers line up with row text.
    static func inset(_ view: NSView) -> NSView {
        let wrapper = NSView()
        view.translatesAutoresizingMaskIntoConstraints = false
        wrapper.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: wrapper.leadingAnchor, constant: groupInset),
            view.trailingAnchor.constraint(equalTo: wrapper.trailingAnchor, constant: -groupInset),
            view.topAnchor.constraint(equalTo: wrapper.topAnchor), view.bottomAnchor.constraint(equalTo: wrapper.bottomAnchor),
        ])
        return wrapper
    }
    static let groupInset: CGFloat = 14
    /// A rounded group, like a System Settings form section, separating its rows with hairlines.
    static func group(_ rows: [NSView]) -> NSBox {
        let box = NSBox()
        box.boxType = .custom; box.titlePosition = .noTitle
        box.borderColor = .separatorColor; box.borderWidth = 0.5; box.cornerRadius = 10
        box.fillColor = .controlBackgroundColor
        box.contentViewMargins = .zero
        var arranged: [NSView] = []
        for (index, row) in rows.enumerated() {
            if index > 0 { let line = NSBox(); line.boxType = .separator; arranged.append(line) }
            arranged.append(row)
        }
        let stack = GroupStack(views: arranged)
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 10, left: groupInset, bottom: 10, right: groupInset)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView(); box.contentView = content
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor), stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor), stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        for view in arranged { view.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -2 * groupInset).isActive = true }
        // Rows share one height so labels, switches and buttons line up across groups.
        for view in rows where view is NSStackView && (view as! NSStackView).orientation == .horizontal { view.heightAnchor.constraint(greaterThanOrEqualToConstant: 24).isActive = true }
        return box
    }
    /// Section title, group, and an optional footer, all on one leading edge.
    static func section(_ title: String?, _ rows: [NSView], footer: String? = nil, footerLabel: FeedbackLabel? = nil) -> NSStackView {
        var views: [NSView] = []
        if let title { views.append(inset(self.title(title))) }
        views.append(group(rows))
        if let footerLabel {
            let wrapper = inset(footerLabel); footerLabel.container = wrapper; views.append(wrapper)
        } else if let footer { views.append(inset(note(footer))) }
        let stack = vstack(views, spacing: 6)
        for view in views { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        return stack
    }
    /// A scrolling page of sections, so short or narrow windows never clip actions.
    static func page(_ sections: [NSView]) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true; scroll.drawsBackground = false
        let container = FlippedView()
        container.translatesAutoresizingMaskIntoConstraints = false
        let stack = vstack(sections, spacing: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stack)
        scroll.documentView = container
        NSLayoutConstraint.activate([
            container.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -20),
        ])
        for view in sections { view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true }
        return scroll
    }
}

/// Hides a hairline whenever the row after it (or every row before it) is hidden,
/// so conditional rows never leave stray separators.
final class GroupStack: NSStackView {
    override func layout() {
        var seenVisible = false
        for (index, view) in arrangedSubviews.enumerated() {
            guard let line = view as? NSBox, line.boxType == .separator else { if !view.isHidden { seenVisible = true }; continue }
            let next = arrangedSubviews.dropFirst(index + 1).first { !($0 is NSBox && ($0 as! NSBox).boxType == .separator) && !$0.isHidden }
            let hide = !seenVisible || next == nil
            if line.isHidden != hide { line.isHidden = hide }
        }
        super.layout()
    }
}

/// Feedback text that collapses (with its inset wrapper) whenever it is empty.
final class FeedbackLabel: NSTextField {
    convenience init() {
        self.init(wrappingLabelWithString: "")
        textColor = .secondaryLabelColor; font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        isHidden = true
    }
    /// A padding wrapper that should collapse along with the text.
    weak var container: NSView? { didSet { container?.isHidden = stringValue.isEmpty } }
    override var stringValue: String {
        didSet { isHidden = stringValue.isEmpty; container?.isHidden = stringValue.isEmpty }
    }
}

final class FlippedView: NSView { override var isFlipped: Bool { true } }
