/**
 * Accepted upload extensions, as an `accept=""`-ready comma list.
 *
 * Kept in its own dependency-free lib module (no imports) so any consumer —
 * including ones loaded in a non-jsdom test environment — can use the list
 * without pulling in browser-only code (e.g. media-upload → api →
 * energy-metrics, which touches `document` at module load).
 */
export const STARTUP_FILE_ACCEPT =
  ".png,.jpg,.jpeg,.gif,.webp,.mp4,.pdf,.txt,.md,.json,.yaml,.yml,.toml,.csv,.log,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.go,.rs,.sh,.sql,.diff,.patch,.env,.ini,.cfg,.conf,.swift,.kt,.java,.c,.cpp,.h,.hpp,.rb,.php,.lua,.zig,.nim,.r,.m,.ex,.exs,.erl,.hs";
