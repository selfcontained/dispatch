export const PLUGIN_ENGINES = ["claude", "codex"] as const;
export type PluginEngine = (typeof PLUGIN_ENGINES)[number];

export function isPluginEngine(value: unknown): value is PluginEngine {
  return (
    typeof value === "string" &&
    (PLUGIN_ENGINES as readonly string[]).includes(value)
  );
}

export const PLUGIN_ID = "dispatch@dispatch";
export type PluginStatus = {
  agentType: PluginEngine;
  installed: boolean;
  enabled: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  /** Present when the installed-plugin probe could not be trusted. */
  detectionError?: string;
};

export type PluginUpdateResult = {
  status: PluginStatus;
  ranCommands: string[];
  error: string | null;
  /** Mirrors CheckOutcome.probeFailed for the re-check this result carries — see createPluginStatusChecker's `update`. */
  probeFailed: boolean;
};

export type PluginStatusChecker = {
  getStatus: (
    agentType: PluginEngine,
    opts?: { forceRefresh?: boolean }
  ) => Promise<PluginStatus>;
  update: (agentType: PluginEngine) => Promise<PluginUpdateResult>;
  install: (agentType: PluginEngine) => Promise<PluginUpdateResult>;
};
