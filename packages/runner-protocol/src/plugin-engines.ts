export const PLUGIN_ENGINES = ["claude", "codex"] as const;
export type PluginEngine = (typeof PLUGIN_ENGINES)[number];

export function isPluginEngine(value: unknown): value is PluginEngine {
  return (
    typeof value === "string" &&
    (PLUGIN_ENGINES as readonly string[]).includes(value)
  );
}
