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
 * as a false "update available". But fail-open only governs what the *user*
 * sees — internally each check also reports whether it was a confident
 * "checked, genuinely absent" or a `probeFailed` "couldn't tell" (see
 * `checkPluginStatusInternal`), so `createPluginStatusChecker`'s cache can
 * retry a probe failure soon instead of pinning it for the same TTL as a
 * real answer, and so failures get logged instead of vanishing silently.
 *
 * The ordering trap (verified against both CLIs, see the plugin-update-detection
 * brain idea): `codex plugin add` installs from the marketplace *snapshot*,
 * so upgrading requires `marketplace upgrade` before `plugin add` — running
 * `plugin add` alone reinstalls from the stale snapshot, a silent no-op that
 * reports success. `applyPluginUpdate` always runs the marketplace refresh
 * first, for both CLIs, and never offers a path that skips it. That
 * invariant only holds *within* one call, though — a concurrent check or a
 * second update for the same agent type can still race the same on-disk
 * clone, which is what `createPluginStatusChecker`'s per-agent-type
 * serialization closes.
 */
import path from "node:path";
import { readFile } from "node:fs/promises";

import { PLUGIN_AGENT_TYPES } from "./agent-types.js";
import type { PluginAgentType } from "./agent-types.js";
import { compareSemver } from "./lib/compare-semver.js";
import { runCommand, type CommandRunner } from "./lib/run-command.js";

export { PLUGIN_AGENT_TYPES };
export type { PluginAgentType };

export function isPluginAgentType(value: unknown): value is PluginAgentType {
  return (
    typeof value === "string" &&
    (PLUGIN_AGENT_TYPES as readonly string[]).includes(value)
  );
}

export type PluginStatus = {
  agentType: PluginAgentType;
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

/** Minimal pino-shaped logger — matches `app.log.warn(obj, msg)` without importing Fastify's type into shared/. */
export type PluginStatusLogger = {
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

const noopLogger: PluginStatusLogger = { warn: () => {} };

const PLUGIN_ID = "dispatch@dispatch";
const MARKETPLACE_NAME = "dispatch";
// `plugin list` is a local read (no network) — short. `marketplace list` is
// also local. `marketplace update`/`upgrade` does a real `git fetch` against
// a real remote, so it gets the most room, but it's also the one call in
// each check that's explicitly best-effort (falls back to whatever's
// already on disk on failure), so a slow/unreachable remote can't turn a
// single status check into the ~90s worst case a flat 30s-per-call budget
// would allow.
const LOCAL_TIMEOUT_MS = 10_000;
const MARKETPLACE_REFRESH_TIMEOUT_MS = 15_000;

function notInstalled(agentType: PluginAgentType): PluginStatus {
  return {
    agentType,
    installed: false,
    enabled: false,
    currentVersion: null,
    latestVersion: null,
    updateAvailable: false,
  };
}

type StepResult =
  | { stdout: string; error?: undefined }
  | { stdout?: undefined; error: string };

function stepFailed(r: StepResult): r is { stdout?: undefined; error: string } {
  return r.error !== undefined;
}

/**
 * Runs one CLI call and turns a rejection into a plain result instead of a
 * thrown error. `runCommand` rejects on any non-zero exit code (its default
 * `allowedExitCodes` is `[0]`) as well as on spawn errors and timeouts, so
 * `exitCode` is never anything but 0 on the resolved path — there is no
 * "resolved with a failing exit code" branch to check for.
 */
async function runStep(
  run: CommandRunner,
  bin: string,
  args: string[],
  timeoutMs: number
): Promise<StepResult> {
  try {
    const result = await run(bin, args, { timeoutMs });
    return { stdout: result.stdout };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
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

/** `checkPluginStatusInternal`'s result: the status to show, plus whether it's a confident answer or a fail-open guess. */
type CheckOutcome = {
  status: PluginStatus;
  /**
   * True only when the check itself couldn't be trusted (a CLI spawn error,
   * a timeout, or `--json` output that didn't parse) — never true just
   * because the plugin genuinely isn't installed. The caching layer uses
   * this to avoid pinning a transient failure at the same TTL as a real
   * answer.
   */
  probeFailed: boolean;
};

function updateAvailable(
  status: Pick<PluginStatus, "enabled" | "currentVersion" | "latestVersion">
): boolean {
  return (
    status.enabled &&
    status.currentVersion !== null &&
    status.latestVersion !== null &&
    compareSemver(status.latestVersion, status.currentVersion) > 0
  );
}

async function readLatestVersion(
  run: CommandRunner,
  bin: string,
  agentType: PluginAgentType,
  refreshMarketplace: boolean,
  logger: PluginStatusLogger
): Promise<string | null> {
  if (refreshMarketplace) {
    // Best-effort: a git fetch that fails just means we fall back to
    // whatever was already on disk from a previous refresh. Not fatal to
    // the check as a whole.
    const refresh = await runStep(
      run,
      bin,
      agentType === "claude"
        ? ["plugin", "marketplace", "update", MARKETPLACE_NAME]
        : ["plugin", "marketplace", "upgrade", MARKETPLACE_NAME, "--json"],
      MARKETPLACE_REFRESH_TIMEOUT_MS
    );
    if (stepFailed(refresh)) {
      logger.warn(
        { err: refresh.error, agentType },
        "plugin marketplace refresh failed; reading last known snapshot"
      );
    }
  }

  const listResult = await runStep(
    run,
    bin,
    ["plugin", "marketplace", "list", "--json"],
    LOCAL_TIMEOUT_MS
  );
  if (stepFailed(listResult)) {
    logger.warn(
      { err: listResult.error, agentType },
      "plugin marketplace list failed; latest version unknown"
    );
    return null;
  }

  try {
    if (agentType === "claude") {
      const marketplaces = JSON.parse(listResult.stdout) as Array<{
        name?: unknown;
        installLocation?: unknown;
      }>;
      const mkt = marketplaces.find((m) => m.name === MARKETPLACE_NAME);
      if (!mkt || typeof mkt.installLocation !== "string") return null;
      return await readManifestVersion(mkt.installLocation, ".claude-plugin");
    }
    const parsed = JSON.parse(listResult.stdout) as {
      marketplaces?: Array<{ name?: unknown; root?: unknown }>;
    };
    const mkt = parsed.marketplaces?.find((m) => m.name === MARKETPLACE_NAME);
    if (!mkt || typeof mkt.root !== "string") return null;
    return await readManifestVersion(mkt.root, ".codex-plugin");
  } catch (err) {
    logger.warn(
      { err, agentType },
      "plugin marketplace list output didn't parse; latest version unknown"
    );
    return null;
  }
}

async function checkClaude(
  bin: string,
  run: CommandRunner,
  refreshMarketplace: boolean,
  logger: PluginStatusLogger
): Promise<CheckOutcome> {
  const listResult = await runStep(
    run,
    bin,
    ["plugin", "list", "--json"],
    LOCAL_TIMEOUT_MS
  );
  if (stepFailed(listResult)) {
    logger.warn(
      { err: listResult.error },
      "claude plugin list failed; reporting not installed"
    );
    return { status: notInstalled("claude"), probeFailed: true };
  }

  let installed: Array<{ id?: unknown; version?: unknown; enabled?: unknown }>;
  try {
    installed = JSON.parse(listResult.stdout);
  } catch (err) {
    logger.warn(
      { err },
      "claude plugin list output didn't parse; reporting not installed"
    );
    return { status: notInstalled("claude"), probeFailed: true };
  }

  const entry = installed.find((p) => p.id === PLUGIN_ID);
  if (!entry) return { status: notInstalled("claude"), probeFailed: false };

  const currentVersion =
    typeof entry.version === "string" ? entry.version : null;
  const enabled = entry.enabled === true;
  const latestVersion = await readLatestVersion(
    run,
    bin,
    "claude",
    refreshMarketplace,
    logger
  );

  const partial = { enabled, currentVersion, latestVersion };
  return {
    status: {
      agentType: "claude",
      installed: true,
      enabled,
      currentVersion,
      latestVersion,
      updateAvailable: updateAvailable(partial),
    },
    probeFailed: false,
  };
}

async function checkCodex(
  bin: string,
  run: CommandRunner,
  refreshMarketplace: boolean,
  logger: PluginStatusLogger
): Promise<CheckOutcome> {
  const listResult = await runStep(
    run,
    bin,
    ["plugin", "list", "--json"],
    LOCAL_TIMEOUT_MS
  );
  if (stepFailed(listResult)) {
    logger.warn(
      { err: listResult.error },
      "codex plugin list failed; reporting not installed"
    );
    return { status: notInstalled("codex"), probeFailed: true };
  }

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
  } catch (err) {
    logger.warn(
      { err },
      "codex plugin list output didn't parse; reporting not installed"
    );
    return { status: notInstalled("codex"), probeFailed: true };
  }
  if (!entry) return { status: notInstalled("codex"), probeFailed: false };

  const currentVersion =
    typeof entry.version === "string" ? entry.version : null;
  const enabled = entry.enabled === true;
  const latestVersion = await readLatestVersion(
    run,
    bin,
    "codex",
    refreshMarketplace,
    logger
  );

  const partial = { enabled, currentVersion, latestVersion };
  return {
    status: {
      agentType: "codex",
      installed: true,
      enabled,
      currentVersion,
      latestVersion,
      updateAvailable: updateAvailable(partial),
    },
    probeFailed: false,
  };
}

async function checkPluginStatusInternal(
  agentType: PluginAgentType,
  bin: string,
  commandRunner: CommandRunner,
  refreshMarketplace: boolean,
  logger: PluginStatusLogger
): Promise<CheckOutcome> {
  try {
    return agentType === "claude"
      ? await checkClaude(bin, commandRunner, refreshMarketplace, logger)
      : await checkCodex(bin, commandRunner, refreshMarketplace, logger);
  } catch (err) {
    logger.warn(
      { err, agentType },
      "plugin status check threw; reporting not installed"
    );
    return { status: notInstalled(agentType), probeFailed: true };
  }
}

/** Detects install state and update availability. Never throws — fails open to "not installed". */
export async function checkPluginStatus(
  agentType: PluginAgentType,
  bin: string,
  commandRunner: CommandRunner = runCommand,
  logger: PluginStatusLogger = noopLogger
): Promise<PluginStatus> {
  const outcome = await checkPluginStatusInternal(
    agentType,
    bin,
    commandRunner,
    true,
    logger
  );
  return outcome.status;
}

/**
 * Applies the update in the verified safe order — marketplace refresh THEN
 * plugin update/add — for both CLIs, then re-checks so the caller gets a
 * fresh status back (the affordance clears without a second round trip).
 * The re-check skips its own marketplace refresh: the step above just did
 * one, and refreshing again would both double the network round trip and
 * risk comparing the just-installed version against a snapshot newer than
 * the one it was actually installed from.
 */
export async function applyPluginUpdate(
  agentType: PluginAgentType,
  bin: string,
  commandRunner: CommandRunner = runCommand,
  logger: PluginStatusLogger = noopLogger
): Promise<PluginUpdateResult> {
  const steps: Array<{
    friendlyError: string;
    args: string[];
    timeoutMs: number;
  }> =
    agentType === "claude"
      ? [
          {
            friendlyError: "Failed to refresh the dispatch marketplace.",
            args: ["plugin", "marketplace", "update", MARKETPLACE_NAME],
            timeoutMs: MARKETPLACE_REFRESH_TIMEOUT_MS,
          },
          {
            friendlyError: "Failed to update the plugin.",
            args: ["plugin", "update", PLUGIN_ID, "-y"],
            timeoutMs: LOCAL_TIMEOUT_MS,
          },
        ]
      : [
          {
            friendlyError: "Failed to refresh the dispatch marketplace.",
            args: [
              "plugin",
              "marketplace",
              "upgrade",
              MARKETPLACE_NAME,
              "--json",
            ],
            timeoutMs: MARKETPLACE_REFRESH_TIMEOUT_MS,
          },
          {
            // Ordering trap: this must never run without the marketplace
            // refresh immediately above it having actually completed — see
            // the module docblock. Structuring both CLIs' steps as one
            // ordered array with no shared "run just this step" helper is
            // what keeps that structurally true here.
            friendlyError: "Failed to update the plugin.",
            args: ["plugin", "add", PLUGIN_ID],
            timeoutMs: LOCAL_TIMEOUT_MS,
          },
        ];

  const ranCommands: string[] = [];
  for (const step of steps) {
    ranCommands.push(step.args.join(" "));
    const result = await runStep(commandRunner, bin, step.args, step.timeoutMs);
    if (stepFailed(result)) {
      logger.warn(
        { err: result.error, agentType, step: step.args.join(" ") },
        "plugin update step failed"
      );
      // Re-check with a fresh refresh: if the marketplace-refresh step
      // itself is what failed, the on-disk snapshot may still be stale, and
      // we don't otherwise know whether it happened.
      const outcome = await checkPluginStatusInternal(
        agentType,
        bin,
        commandRunner,
        true,
        logger
      );
      return { status: outcome.status, ranCommands, error: step.friendlyError };
    }
  }

  // Both steps succeeded, so the marketplace was just refreshed by the first
  // one — re-refreshing here would double the network round trip and risk
  // comparing the just-installed version against a snapshot newer than the
  // one it was actually installed from.
  const outcome = await checkPluginStatusInternal(
    agentType,
    bin,
    commandRunner,
    false,
    logger
  );
  return { status: outcome.status, ranCommands, error: null };
}

export type PluginStatusChecker = {
  getStatus: (
    agentType: PluginAgentType,
    opts?: { forceRefresh?: boolean }
  ) => Promise<PluginStatus>;
  update: (agentType: PluginAgentType) => Promise<PluginUpdateResult>;
};

// A real answer is cached for an hour (each check does a git fetch, so
// that's the cost being amortized). A probe failure — the CLI timed out, the
// binary wasn't on PATH, `--json` output didn't parse — is cached for only a
// minute, so a transient blip doesn't silence the nudge until a server
// restart the way a flat TTL would.
const SUCCESS_TTL_MS = 60 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;

/**
 * Owns the status cache and the per-agent-type serialization — the seam
 * this belongs at, not in the route handler, since both are properties of
 * "checking/updating the plugin" (expensive, and touches a shared on-disk
 * clone) rather than of HTTP. Modeled on `createCheckIsAdmin` in
 * server/release-helpers.ts, the existing example of a closure-cached shell
 * check in this codebase.
 *
 * `getStatus` and `update` for the same `agentType` share one in-flight
 * promise chain, so a check can never run concurrently with an update (or
 * with another check) against the same on-disk marketplace clone — closing
 * the window where a concurrent `marketplace upgrade` rewrites the snapshot
 * directory out from under a `plugin add`/`plugin update` reading it, or
 * under a `readManifestVersion` read.
 */
export function createPluginStatusChecker(deps: {
  binFor: (agentType: PluginAgentType) => string;
  commandRunner?: CommandRunner;
  logger?: PluginStatusLogger;
  now?: () => number;
}): PluginStatusChecker {
  const run = deps.commandRunner ?? runCommand;
  const logger = deps.logger ?? noopLogger;
  const now = deps.now ?? Date.now;
  const cache = new Map<
    PluginAgentType,
    { status: PluginStatus; expiresAt: number }
  >();
  const inFlight = new Map<PluginAgentType, Promise<unknown>>();

  function serialize<T>(
    agentType: PluginAgentType,
    fn: () => Promise<T>
  ): Promise<T> {
    const prev = inFlight.get(agentType) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    inFlight.set(
      agentType,
      next.then(
        () => {},
        () => {}
      )
    );
    return next;
  }

  async function getStatus(
    agentType: PluginAgentType,
    opts: { forceRefresh?: boolean } = {}
  ): Promise<PluginStatus> {
    const cached = cache.get(agentType);
    if (!opts.forceRefresh && cached && now() < cached.expiresAt) {
      return cached.status;
    }
    return await serialize(agentType, async () => {
      // Another caller may have refreshed the cache while this one waited
      // for the per-agent-type lock — recheck before spawning again.
      const fresh = cache.get(agentType);
      if (!opts.forceRefresh && fresh && now() < fresh.expiresAt) {
        return fresh.status;
      }
      const outcome = await checkPluginStatusInternal(
        agentType,
        deps.binFor(agentType),
        run,
        true,
        logger
      );
      cache.set(agentType, {
        status: outcome.status,
        expiresAt:
          now() + (outcome.probeFailed ? FAILURE_TTL_MS : SUCCESS_TTL_MS),
      });
      return outcome.status;
    });
  }

  async function update(
    agentType: PluginAgentType
  ): Promise<PluginUpdateResult> {
    return await serialize(agentType, async () => {
      const result = await applyPluginUpdate(
        agentType,
        deps.binFor(agentType),
        run,
        logger
      );
      cache.set(agentType, {
        status: result.status,
        expiresAt: now() + SUCCESS_TTL_MS,
      });
      return result;
    });
  }

  return { getStatus, update };
}
