import Foundation

/// Which releases this install follows. The appcast tags preview builds with
/// `<sparkle:channel>preview</sparkle:channel>`; promoting a release removes the
/// tag. Stable apps allow no extra channels, so they only see promoted builds.
public enum UpdateChannel: String, CaseIterable, Sendable {
    case stable, preview

    public static let defaultsKey = "DispatchUpdateChannel"
    /// Info.plist key the build sets; used until the person picks a channel.
    public static let infoKey = "DispatchDefaultUpdateChannel"

    public static func current(defaults: UserDefaults = .standard, buildDefault: String? = Bundle.main.object(forInfoDictionaryKey: infoKey) as? String) -> UpdateChannel {
        defaults.string(forKey: defaultsKey).flatMap(UpdateChannel.init(rawValue:))
            ?? buildDefault.flatMap(UpdateChannel.init(rawValue:))
            ?? .stable
    }

    public func save(defaults: UserDefaults = .standard) { defaults.set(rawValue, forKey: Self.defaultsKey) }

    /// Channels Sparkle may offer beyond the default, untagged one.
    public var sparkleChannels: Set<String> { self == .preview ? [Self.preview.rawValue] : [] }

    public var title: String { self == .preview ? "Preview" : "Stable" }
}
