/**
 * Detects whether the Dispatch plugin is installed in Claude Code / Codex and
 * whether a newer version is available, then (on request) applies the update.
 *
 * Deliberately shells out to the real CLIs for everything, including
 * detection — `claude plugin list --json` / `codex plugin list --json` and
 * their `marketplace list --json` counterparts are the CLI's own resolution
 * of config scope, `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, and install location,
 * so there's no private-file format to keep in sync by hand (contrast
 * hand-parsing settings.json / config.toml, which the sibling install-nudge
 * idea found broke on parse-format drift). `runCommand` inherits
 * `process.env` unless overridden, so CLAUDE_CONFIG_DIR/CODEX_HOME set on the
 * server process reach the CLI the same way they would from a shell.
 *
 * Every read path fails open: a spawn error, non-zero exit, or malformed
 * JSON is reported as "nothing to show" (not installed / no update), never
 * as a false "update available" — a detector that's silently broken and
 * nags everyone is worse than one that occasionally misses.
 *
 * The ordering trap (verified against both CLIs, see the plugin-update-detection
 * brain idea): `codex plugin add` installs from the marketplace *snapshot*,
 * so upgrading requires `marketplace upgrade` before `plugin add` — running
 * `plugin add` alone reinstalls from the stale snapshot, a silent no-op that
 * reports success. `applyPluginUpdate` always runs the marketplace refresh
 * first, for both CLIs, and never offers a path that skips it.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";

import { runCommand, type CommandRunner } from "./lib/run-command.js";

export const PLUGIN_CLI_AGENT_TYPES = ["claude", "codex"] as const;
export type PluginCliAgentType = (typeof PLUGIN_CLI_AGENT_TYPES)[number];

export function isPluginCliAgentType(
  value: unknown
): value is PluginCliAgentType {
  return (
    typeof value === "string" &&
    (PLUGIN_CLI_AGENT_TYPES as readonly string[]).includes(value)
  );
}

export type PluginStatus = {
  agentType: PluginCliAgentType;
  installed: boolean;
  enabled: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
};

export type PluginUpdateResult = {
  status: PluginStatus;
  ranCommands: string[];
  error: string | null;
};

const PLUGIN_ID = "dispatch@dispatch";
const MARKETPLACE_NAME = "dispatch";
// Marketplace refresh does a git fetch against a real remote; installed/update
// commands can also touch the network. Generous but bounded.
const CLI_TIMEOUT_MS = 30_000;

function notInstalled(agentType: PluginCliAgentType): PluginStatus {
  return {
    agentType,
    installed: false,
    enabled: false,
    currentVersion: null,
    latestVersion: null,
    updateAvailable: false,
  };
}

/** Parses a "x.y.z" (optionally "vx.y.z") version string; missing/garbage segments read as 0. */
function parseVersion(v: string): [number, number, number] {
  const cleaned = v.startsWith("v") ? v.slice(1) : v;
  const parts = cleaned.split(".").map((p) => Number.parseInt(p, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function isVersionNewer(a: string, b: string): boolean {
  const [aMajor, aMinor, aPatch] = parseVersion(a);
  const [bMajor, bMinor, bPatch] = parseVersion(b);
  if (aMajor !== bMajor) return aMajor > bMajor;
  if (aMinor !== bMinor) return aMinor > bMinor;
  return aPatch > bPatch;
}

async function readManifestVersion(
  marketplaceRoot: string,
  manifestSubdir: ".claude-plugin" | ".codex-plugin"
): Promise<string | null> {
  try {
    const raw = await readFile(
      path.join(
        marketplaceRoot,
        "plugins",
        "dispatch",
        manifestSubdir,
        "plugin.json"
      ),
      "utf8"
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

async function checkClaude(
  claudeBin: string,
  run: CommandRunner
): Promise<PluginStatus> {
  const listResult = await run(claudeBin, ["plugin", "list", "--json"], {
    timeoutMs: CLI_TIMEOUT_MS,
  });
  if (listResult.exitCode !== 0) return notInstalled("claude");

  const installed = JSON.parse(listResult.stdout) as Array<{
    id?: unknown;
    version?: unknown;
    enabled?: unknown;
  }>;
  const entry = installed.find((p) => p.id === PLUGIN_ID);
  if (!entry) return notInstalled("claude");

  const currentVersion =
    typeof entry.version === "string" ? entry.version : null;
  const enabled = entry.enabled === true;

  // Best-effort refresh of the marketplace snapshot so `latestVersion`
  // reflects the real upstream, not whatever was last cloned. A git fetch,
  // not an install — safe to run on every check. If it fails we fall back
  // to whatever's already on disk from a previous refresh.
  await run(claudeBin, ["plugin", "marketplace", "update", MARKETPLACE_NAME], {
    timeoutMs: CLI_TIMEOUT_MS,
  }).catch(() => null);

  let latestVersion: string | null = null;
  const marketplaceListResult = await run(
    claudeBin,
    ["plugin", "marketplace", "list", "--json"],
    { timeoutMs: CLI_TIMEOUT_MS }
  ).catch(() => null);
  if (marketplaceListResult && marketplaceListResult.exitCode === 0) {
    try {
      const marketplaces = JSON.parse(marketplaceListResult.stdout) as Array<{
        name?: unknown;
        installLocation?: unknown;
      }>;
      const mkt = marketplaces.find((m) => m.name === MARKETPLACE_NAME);
      if (mkt && typeof mkt.installLocation === "string") {
        latestVersion = await readManifestVersion(
          mkt.installLocation,
          ".claude-plugin"
        );
      }
    } catch {
      latestVersion = null;
    }
  }

  return {
    agentType: "claude",
    installed: true,
    enabled,
    currentVersion,
    latestVersion,
    updateAvailable:
      currentVersion !== null &&
      latestVersion !== null &&
      isVersionNewer(latestVersion, currentVersion),
  };
}

async function checkCodex(
  codexBin: string,
  run: CommandRunner
): Promise<PluginStatus> {
  const listResult = await run(codexBin, ["plugin", "list", "--json"], {
    timeoutMs: CLI_TIMEOUT_MS,
  });
  if (listResult.exitCode !== 0) return notInstalled("codex");

  let entry:
    | { pluginId?: unknown; version?: unknown; enabled?: unknown }
    | undefined;
  try {
    const parsed = JSON.parse(listResult.stdout) as {
      installed?: Array<{
        pluginId?: unknown;
        version?: unknown;
        enabled?: unknown;
      }>;
    };
    entry = parsed.installed?.find((p) => p.pluginId === PLUGIN_ID);
  } catch {
    return notInstalled("codex");
  }
  if (!entry) return notInstalled("codex");

  const currentVersion =
    typeof entry.version === "string" ? entry.version : null;
  const enabled = entry.enabled === true;

  // Best-effort refresh — see checkClaude for why this is safe to always run.
  await run(
    codexBin,
    ["plugin", "marketplace", "upgrade", MARKETPLACE_NAME, "--json"],
    { timeoutMs: CLI_TIMEOUT_MS }
  ).catch(() => null);

  let latestVersion: string | null = null;
  const marketplaceListResult = await run(
    codexBin,
    ["plugin", "marketplace", "list", "--json"],
    { timeoutMs: CLI_TIMEOUT_MS }
  ).catch(() => null);
  if (marketplaceListResult && marketplaceListResult.exitCode === 0) {
    try {
      const parsed = JSON.parse(marketplaceListResult.stdout) as {
        marketplaces?: Array<{ name?: unknown; root?: unknown }>;
      };
      const mkt = parsed.marketplaces?.find((m) => m.name === MARKETPLACE_NAME);
      if (mkt && typeof mkt.root === "string") {
        latestVersion = await readManifestVersion(mkt.root, ".codex-plugin");
      }
    } catch {
      latestVersion = null;
    }
  }

  return {
    agentType: "codex",
    installed: true,
    enabled,
    currentVersion,
    latestVersion,
    updateAvailable:
      currentVersion !== null &&
      latestVersion !== null &&
      isVersionNewer(latestVersion, currentVersion),
  };
}

/** Detects install state and update availability. Never throws — fails open to `notInstalled`. */
export async function checkPluginStatus(
  agentType: PluginCliAgentType,
  bin: string,
  commandRunner: CommandRunner = runCommand
): Promise<PluginStatus> {
  try {
    return agentType === "claude"
      ? await checkClaude(bin, commandRunner)
      : await checkCodex(bin, commandRunner);
  } catch {
    return notInstalled(agentType);
  }
}

/**
 * Applies the update in the verified safe order — marketplace refresh THEN
 * plugin update/add — for both CLIs, then re-checks so the caller gets a
 * fresh status back (the affordance clears without a second round trip).
 */
export async function applyPluginUpdate(
  agentType: PluginCliAgentType,
  bin: string,
  commandRunner: CommandRunner = runCommand
): Promise<PluginUpdateResult> {
  const ranCommands: string[] = [];
  try {
    if (agentType === "claude") {
      const marketplaceArgs = [
        "plugin",
        "marketplace",
        "update",
        MARKETPLACE_NAME,
      ];
      ranCommands.push([bin, ...marketplaceArgs].join(" "));
      const marketplaceResult = await commandRunner(bin, marketplaceArgs, {
        timeoutMs: CLI_TIMEOUT_MS,
      });
      if (marketplaceResult.exitCode !== 0) {
        return {
          status: await checkPluginStatus(agentType, bin, commandRunner),
          ranCommands,
          error:
            marketplaceResult.stderr.trim() ||
            "Failed to refresh the dispatch marketplace.",
        };
      }

      const updateArgs = ["plugin", "update", PLUGIN_ID, "-y"];
      ranCommands.push([bin, ...updateArgs].join(" "));
      const updateResult = await commandRunner(bin, updateArgs, {
        timeoutMs: CLI_TIMEOUT_MS,
      });
      if (updateResult.exitCode !== 0) {
        return {
          status: await checkPluginStatus(agentType, bin, commandRunner),
          ranCommands,
          error: updateResult.stderr.trim() || "Failed to update the plugin.",
        };
      }
    } else {
      const marketplaceArgs = [
        "plugin",
        "marketplace",
        "upgrade",
        MARKETPLACE_NAME,
        "--json",
      ];
      ranCommands.push([bin, ...marketplaceArgs].join(" "));
      const marketplaceResult = await commandRunner(bin, marketplaceArgs, {
        timeoutMs: CLI_TIMEOUT_MS,
      });
      if (marketplaceResult.exitCode !== 0) {
        return {
          status: await checkPluginStatus(agentType, bin, commandRunner),
          ranCommands,
          error:
            marketplaceResult.stderr.trim() ||
            "Failed to refresh the dispatch marketplace.",
        };
      }

      // Ordering trap: `plugin add` installs from the marketplace snapshot
      // above, not from upstream directly. Never run this without the
      // upgrade step immediately before it, or it silently reinstalls the
      // stale snapshot while reporting success.
      const addArgs = ["plugin", "add", PLUGIN_ID];
      ranCommands.push([bin, ...addArgs].join(" "));
      const addResult = await commandRunner(bin, addArgs, {
        timeoutMs: CLI_TIMEOUT_MS,
      });
      if (addResult.exitCode !== 0) {
        return {
          status: await checkPluginStatus(agentType, bin, commandRunner),
          ranCommands,
          error: addResult.stderr.trim() || "Failed to update the plugin.",
        };
      }
    }

    return {
      status: await checkPluginStatus(agentType, bin, commandRunner),
      ranCommands,
      error: null,
    };
  } catch (err) {
    return {
      status: await checkPluginStatus(agentType, bin, commandRunner).catch(() =>
        notInstalled(agentType)
      ),
      ranCommands,
      error: err instanceof Error ? err.message : "Plugin update failed.",
    };
  }
}
