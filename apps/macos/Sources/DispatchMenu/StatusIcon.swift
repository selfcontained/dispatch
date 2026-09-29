import AppKit

/// AppKit tints template artwork for light/dark menu bars and selected items.
func dispatchStatusIcon(resources: URL? = Bundle.main.resourceURL) -> NSImage? {
    guard let resources else { return nil }
    let image = NSImage(size: NSSize(width: 18, height: 18))
    for name in ["DispatchMenuTemplate.png", "DispatchMenuTemplate@2x.png"] {
        if let data = try? Data(contentsOf: resources.appendingPathComponent(name)),
           let representation = NSBitmapImageRep(data: data) {
            representation.size = image.size
            image.addRepresentation(representation)
        }
    }
    guard !image.representations.isEmpty else { return NSImage(systemSymbolName: "arrow.triangle.branch", accessibilityDescription: "Dispatch") }
    image.isTemplate = true
    image.accessibilityDescription = "Dispatch"
    return image
}
