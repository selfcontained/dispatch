import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  HarnessPlanSpend,
  HarnessPlanWindow,
  HarnessProviderPlan,
  HarnessProviderUsageReport,
} from "@dispatch/shared";

import { discoverCodexRolloutFiles } from "../codex-sessions.js";

type ProviderUsageOptions = {
  now?: Date;
  homeDir?: string;
  read?: (file: string) => Promise<string>;
  codexFiles?: () => Promise<string[]>;
  modifiedAt?: (file: string) => Promise<number>;
  fetchUsage?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /**
   * Claude Code's login as it sits in the macOS Keychain: the same JSON the
   * credentials file holds elsewhere. Defaults to the real Keychain, except
   * under an injected `read`, so a test never reaches the host's login.
   */
  readKeychain?: () => Promise<string>;
  /** Told why a refresh failed. Never given a token or a provider body. */
  log?: { warn: (fields: Record<string, unknown>, message: string) => void };
};

type JsonObject = Record<string, unknown>;
type RolloutCache = Map<
  string,
  { modifiedAt: number; report: HarnessProviderPlan }
>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function percent(value: unknown): number | null {
  const number = finiteNumber(value);
  return number === null ? null : Math.max(0, Math.min(100, number));
}

function planName(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  return raw
    .split(/[_-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function durationLabel(minutes: number | null, fallback: string): string {
  if (minutes === null || minutes <= 0) return fallback;
  if (minutes % 10_080 === 0) {
    const weeks = minutes / 10_080;
    return weeks === 1 ? "Weekly" : `${weeks}-week`;
  }
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

function window(
  id: string,
  label: string,
  usedPercent: unknown,
  resetsAt: unknown
): HarnessPlanWindow | null {
  const used = percent(usedPercent);
  if (used === null) return null;
  return {
    id,
    label,
    usedPercent: used,
    resetsAt:
      typeof resetsAt === "number"
        ? new Date(resetsAt * 1_000).toISOString()
        : text(resetsAt),
  };
}

function parseMoney(value: unknown): number | null {
  const money = object(value);
  const amount = finiteNumber(money?.amount_minor);
  const exponent = finiteNumber(money?.exponent);
  if (amount === null || exponent === null) return null;
  return amount / 10 ** exponent;
}

export function parseClaudeProviderUsage(raw: string): HarnessProviderPlan {
  try {
    const root = object(JSON.parse(raw));
    const cache = object(root?.cachedUsageUtilization);
    const utilization = object(cache?.utilization);
    const limits = Array.isArray(utilization?.limits) ? utilization.limits : [];
    const windows: HarnessPlanWindow[] = [];

    for (const value of limits) {
      const limit = object(value);
      const kind = text(limit?.kind);
      const scope = object(limit?.scope);
      const model = object(scope?.model);
      const modelName = text(model?.display_name);
      const label =
        kind === "session"
          ? "5-hour"
          : kind === "weekly_all"
            ? "Weekly"
            : kind === "weekly_scoped" && modelName
              ? `${modelName} weekly`
              : planName(kind);
      const item =
        kind && label
          ? window(
              kind + (modelName ? `:${modelName}` : ""),
              label,
              limit?.percent,
              limit?.resets_at
            )
          : null;
      if (item) windows.push(item);
    }

    if (windows.length === 0) {
      const fiveHour = object(utilization?.five_hour);
      const weekly = object(utilization?.seven_day);
      const first = window(
        "session",
        "5-hour",
        fiveHour?.utilization,
        fiveHour?.resets_at
      );
      const second = window(
        "weekly_all",
        "Weekly",
        weekly?.utilization,
        weekly?.resets_at
      );
      if (first) windows.push(first);
      if (second) windows.push(second);
    }

    const spendValue = object(utilization?.spend);
    const used = parseMoney(spendValue?.used);
    const limit = parseMoney(spendValue?.limit);
    const currency = text(object(spendValue?.used)?.currency);
    const spend: HarnessPlanSpend | undefined =
      used !== null && limit !== null && currency
        ? { used, limit, currency }
        : undefined;

    const fetchedAtMs = finiteNumber(cache?.fetchedAtMs);
    return {
      engineId: "claude",
      plan: null,
      observedAt:
        fetchedAtMs === null ? null : new Date(fetchedAtMs).toISOString(),
      windows,
      ...(spend ? { spend } : {}),
      ...(windows.length === 0 && !spend
        ? { unavailableReason: "No Claude plan utilization is cached yet." }
        : {}),
    };
  } catch {
    return {
      engineId: "claude",
      plan: null,
      observedAt: null,
      windows: [],
      unavailableReason: "No Claude plan utilization is cached yet.",
    };
  }
}

type CodexRateLimits = {
  timestamp: string | null;
  value: JsonObject;
};

export function parseCodexProviderUsage(raw: string): HarnessProviderPlan {
  let latest: CodexRateLimits | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = object(JSON.parse(line));
      if (entry?.type !== "event_msg") continue;
      const payload = object(entry.payload);
      const limits = object(payload?.rate_limits);
      if (payload?.type === "token_count" && limits) {
        const timestamp = text(entry.timestamp);
        if (
          !latest ||
          observationTime(timestamp) >= observationTime(latest.timestamp)
        ) {
          latest = { timestamp, value: limits };
        }
      }
    } catch {
      continue;
    }
  }

  if (!latest) {
    return {
      engineId: "codex",
      plan: null,
      observedAt: null,
      windows: [],
      unavailableReason: "No Codex plan utilization has been reported yet.",
    };
  }

  const windows: HarnessPlanWindow[] = [];
  for (const [id, fallback] of [
    ["primary", "Primary limit"],
    ["secondary", "Secondary limit"],
  ] as const) {
    const value = object(latest.value[id]);
    const minutes = finiteNumber(value?.window_minutes);
    const item = window(
      id,
      durationLabel(minutes, fallback),
      value?.used_percent,
      value?.resets_at
    );
    if (item) windows.push(item);
  }

  return {
    engineId: "codex",
    plan: planName(latest.value.plan_type),
    observedAt: latest.timestamp,
    windows,
    ...(windows.length === 0
      ? {
          unavailableReason: "No Codex plan utilization has been reported yet.",
        }
      : {}),
  };
}

function unavailable(
  engineId: "gemini" | "opencode",
  reason: string
): HarnessProviderPlan {
  return {
    engineId,
    plan: null,
    observedAt: null,
    windows: [],
    unavailableReason: reason,
  };
}

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** The Keychain item Claude Code keeps its login in on macOS. */
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

type RefreshFailureReason =
  | "not_signed_in"
  | "login_expired"
  | "login_rejected"
  | "request_failed"
  | "http_error"
  | "no_usage_reported"
  | "unexpected";

const COULD_NOT_REFRESH =
  "Could not refresh Claude plan usage. Open /usage in Claude Code to refresh its local report.";
const RENEW_LOGIN =
  "Claude Code's login on this machine has expired, so plan usage cannot be refreshed. It renews the next time Claude Code runs; then refresh.";

/** What the dialog says for each way a refresh can fail. */
const REFRESH_FAILURE_TEXT: Record<RefreshFailureReason, string> = {
  not_signed_in:
    "Claude Code is not signed in with a subscription on this machine, so plan usage cannot be refreshed.",
  login_expired: RENEW_LOGIN,
  login_rejected: RENEW_LOGIN,
  request_failed: COULD_NOT_REFRESH,
  http_error: COULD_NOT_REFRESH,
  no_usage_reported: COULD_NOT_REFRESH,
  unexpected: COULD_NOT_REFRESH,
};

class RefreshFailure extends Error {
  constructor(
    readonly reason: RefreshFailureReason,
    readonly detail?: string
  ) {
    super(reason);
  }
}

function readMacKeychain(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        CLAUDE_KEYCHAIN_SERVICE,
        "-a",
        os.userInfo().username,
        "-w",
      ],
      { timeout: 5_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) reject(new Error("keychain read failed"));
        else resolve(stdout);
      }
    );
  });
}

/**
 * The signed-in CLI's subscription token. Claude Code keeps its login in
 * `.credentials.json` on Linux and in the login Keychain on macOS, where the
 * file does not exist at all; reading only the file meant a macOS host could
 * never refresh and showed whatever the interactive `/usage` last cached.
 *
 * The access token is used as found. Its refresh token is never exchanged
 * here: refresh tokens rotate, so spending one would sign Claude Code itself
 * out. An expired login renews the next time the CLI runs.
 */
async function readClaudeLogin(
  options: ProviderUsageOptions,
  read: (file: string) => Promise<string>,
  homeDir: string,
  env: NodeJS.ProcessEnv
): Promise<{ token: string; expiresAt: number | null }> {
  const sources: (() => Promise<string>)[] = [
    () =>
      read(
        path.join(
          env.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDir, ".claude"),
          ".credentials.json"
        )
      ),
  ];
  const readKeychain =
    options.readKeychain ?? (options.read ? undefined : readMacKeychain);
  if ((options.platform ?? process.platform) === "darwin" && readKeychain) {
    sources.push(readKeychain);
  }
  for (const source of sources) {
    try {
      const oauth = object(object(JSON.parse(await source()))?.claudeAiOauth);
      const token = text(oauth?.accessToken);
      if (!token) continue;
      const expiresAt =
        typeof oauth?.expiresAt === "number" && Number.isFinite(oauth.expiresAt)
          ? oauth.expiresAt
          : null;
      return { token, expiresAt };
    } catch {
      // Absent or unreadable: try the next place the login can live.
    }
  }
  throw new RefreshFailure("not_signed_in");
}

/**
 * Claude Code's state file, `.claude.json`, sits in the home directory
 * itself (or in `CLAUDE_CONFIG_DIR` when that is set), not under `~/.claude/`,
 * which holds sessions and settings.
 */
export function claudeConfigPath(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(configDir || homeDir, ".claude.json");
}

export async function loadHarnessProviderUsage(
  options: ProviderUsageOptions = {},
  rollouts: RolloutCache = new Map()
): Promise<HarnessProviderUsageReport> {
  const read = options.read ?? ((file: string) => readFile(file, "utf8"));
  const modifiedAt =
    options.modifiedAt ?? (async (file: string) => (await stat(file)).mtimeMs);
  const files = await (options.codexFiles ?? discoverCodexRolloutFiles)();
  const present = new Set(files);
  for (const file of rollouts.keys())
    if (!present.has(file)) rollouts.delete(file);
  const candidates = await Promise.all(
    files.map(async (file) => {
      try {
        return { file, modifiedAt: await modifiedAt(file) };
      } catch {
        return null;
      }
    })
  );
  candidates.sort((a, b) => (b?.modifiedAt ?? 0) - (a?.modifiedAt ?? 0));

  let codex = parseCodexProviderUsage("");
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const cached = rollouts.get(candidate.file);
      const report =
        cached?.modifiedAt === candidate.modifiedAt
          ? cached.report
          : parseCodexProviderUsage(await read(candidate.file));
      rollouts.set(candidate.file, {
        modifiedAt: candidate.modifiedAt,
        report,
      });
      if (
        report.windows.length > 0 &&
        (codex.windows.length === 0 ||
          observationTime(report.observedAt) >
            observationTime(codex.observedAt))
      ) {
        codex = report;
      }
    } catch {
      continue;
    }
  }

  let claude: HarnessProviderPlan;
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  try {
    claude = parseClaudeProviderUsage(
      await read(claudeConfigPath(homeDir, env))
    );
  } catch {
    claude = parseClaudeProviderUsage("");
  }

  // ACP sessions do not refresh Claude Code's interactive /usage cache.
  // Read the signed-in CLI's token only for this fixed provider endpoint;
  // never return credentials or provider error bodies to the browser.
  if (now.valueOf() - observationTime(claude.observedAt) > 60_000) {
    try {
      const login = await readClaudeLogin(options, read, homeDir, env);
      if (login.expiresAt !== null && login.expiresAt <= now.valueOf()) {
        throw new RefreshFailure("login_expired");
      }
      let response: Response;
      try {
        response = await (options.fetchUsage ?? fetch)(CLAUDE_USAGE_URL, {
          headers: {
            Authorization: `Bearer ${login.token}`,
            "anthropic-beta": "oauth-2025-04-20",
          },
          signal: AbortSignal.timeout(5_000),
          redirect: "error",
        });
      } catch (error) {
        throw new RefreshFailure(
          "request_failed",
          error instanceof Error ? error.name : undefined
        );
      }
      if (!response.ok) {
        throw new RefreshFailure(
          response.status === 401 || response.status === 403
            ? "login_rejected"
            : "http_error",
          String(response.status)
        );
      }
      const live = parseClaudeProviderUsage(
        JSON.stringify({
          cachedUsageUtilization: {
            fetchedAtMs: now.valueOf(),
            utilization: await response.json(),
          },
        })
      );
      if (!live.windows.length && !live.spend)
        throw new RefreshFailure("no_usage_reported");
      claude = live;
    } catch (error) {
      const failure =
        error instanceof RefreshFailure
          ? error
          : new RefreshFailure("unexpected");
      // The reason and, at most, an HTTP status or an error's class name.
      options.log?.warn(
        {
          reason: failure.reason,
          ...(failure.detail ? { detail: failure.detail } : {}),
        },
        "could not refresh Claude plan usage"
      );
      claude.unavailableReason = REFRESH_FAILURE_TEXT[failure.reason];
    }
  }
  return {
    checkedAt: now.toISOString(),
    providers: [
      claude,
      codex,
      unavailable(
        "gemini",
        "Gemini CLI does not expose plan limits to Dispatch."
      ),
      unavailable(
        "opencode",
        "OpenCode plan limits depend on its configured provider."
      ),
    ],
  };
}

function observationTime(value: string | null): number {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/** A forced refresh still reuses a report this young: a guard on the provider, not a cache. */
const FORCE_REFRESH_FLOOR_MS = 5_000;

export function createHarnessProviderUsageReporter(
  options: Omit<ProviderUsageOptions, "now"> = {},
  cacheMs = 60_000
): (request?: { force?: boolean }) => Promise<HarnessProviderUsageReport> {
  let cached: {
    loadedAt: number;
    expiresAt: number;
    report: HarnessProviderUsageReport;
  } | null = null;
  let pending: Promise<HarnessProviderUsageReport> | null = null;
  const rollouts: RolloutCache = new Map();
  return async (request = {}) => {
    const now = Date.now();
    // The Refresh button asks for a real attempt. Without `force` a click
    // inside the cache window was answered from memory and looked broken.
    const fresh =
      cached !== null &&
      (request.force
        ? now - cached.loadedAt < FORCE_REFRESH_FLOOR_MS
        : cached.expiresAt > now);
    if (cached && fresh) return cached.report;
    if (pending) return pending;
    pending = loadHarnessProviderUsage(options, rollouts)
      .then((report) => {
        // A transient provider failure must not replace a successfully fetched
        // report with the older interactive cache on disk.
        const previous = cached?.report.providers.find(
          (item) => item.engineId === "claude"
        );
        const claude = report.providers[0];
        if (
          previous &&
          claude.unavailableReason &&
          observationTime(previous.observedAt) >
            observationTime(claude.observedAt)
        ) {
          report.providers[0] = {
            ...previous,
            unavailableReason: claude.unavailableReason,
          };
        }
        const loadedAt = Date.now();
        cached = { loadedAt, expiresAt: loadedAt + cacheMs, report };
        return report;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}
