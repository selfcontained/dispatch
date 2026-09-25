import { execFile } from "node:child_process";
import { open, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  PlanSpend,
  PlanWindow,
  ProviderPlan,
  ProviderPlansResponse,
} from "@dispatch/shared";

/**
 * How much of their subscription plans the engines' logins have used: the
 * 5-hour and weekly windows, and spend where the plan has it.
 *
 * Claude: Anthropic's OAuth usage endpoint, called with the token Claude
 * Code is already signed in with (its credentials file, or the macOS
 * Keychain). The token is used as found and never refreshed: refresh tokens
 * rotate, so spending one would sign Claude Code out. Falls back to the
 * report Claude Code's own /usage cached in `.claude.json`.
 *
 * Codex: the newest `rate_limits` Codex wrote into a session rollout under
 * `$CODEX_HOME/sessions`, which it does on every model response.
 */

type JsonObject = Record<string, unknown>;

export type ProviderPlanOptions = {
  now?: Date;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  read?: (file: string) => Promise<string>;
  /** Newest Codex rollout files first. */
  codexFiles?: () => Promise<string[]>;
  /** The end of a rollout, where its newest events are. */
  readTail?: (file: string) => Promise<string>;
  fetchUsage?: typeof fetch;
  /** Claude Code's login as it sits in the macOS Keychain. */
  readKeychain?: () => Promise<string>;
  /** Told why a refresh failed. Never given a token or a provider body. */
  log?: { warn: (fields: Record<string, unknown>, message: string) => void };
};

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
): PlanWindow | null {
  const used = finiteNumber(usedPercent);
  if (used === null) return null;
  return {
    id,
    label,
    usedPercent: Math.max(0, Math.min(100, used)),
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

function observationTime(value: string | null): number {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

const NO_CLAUDE_REPORT = "No Claude plan usage has been reported yet.";
const NO_CODEX_REPORT = "No Codex plan usage has been reported yet.";

/** Claude's utilization, as the OAuth endpoint returns it or `.claude.json` caches it. */
export function parseClaudeUtilization(
  utilization: unknown,
  observedAt: string | null
): ProviderPlan {
  const root = object(utilization);
  const limits = Array.isArray(root?.limits) ? root.limits : [];
  const windows: PlanWindow[] = [];
  for (const value of limits) {
    const limit = object(value);
    const kind = text(limit?.kind);
    const modelName = text(object(object(limit?.scope)?.model)?.display_name);
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
    const fiveHour = object(root?.five_hour);
    const weekly = object(root?.seven_day);
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
  const spendValue = object(root?.spend);
  const used = parseMoney(spendValue?.used);
  const limit = parseMoney(spendValue?.limit);
  const currency = text(object(spendValue?.used)?.currency);
  const spend: PlanSpend | undefined =
    used !== null && limit !== null && currency
      ? { used, limit, currency }
      : undefined;
  return {
    engine: "claude",
    plan: null,
    observedAt,
    windows,
    ...(spend ? { spend } : {}),
    ...(windows.length === 0 && !spend
      ? { unavailableReason: NO_CLAUDE_REPORT }
      : {}),
  };
}

/** The report Claude Code's interactive /usage left in `.claude.json`. */
export function parseClaudeCache(raw: string): ProviderPlan {
  try {
    const cache = object(object(JSON.parse(raw))?.cachedUsageUtilization);
    const fetchedAtMs = finiteNumber(cache?.fetchedAtMs);
    return parseClaudeUtilization(
      cache?.utilization,
      fetchedAtMs === null ? null : new Date(fetchedAtMs).toISOString()
    );
  } catch {
    return parseClaudeUtilization(null, null);
  }
}

/** The newest `rate_limits` in a Codex rollout (JSONL). */
export function parseCodexRollout(raw: string): ProviderPlan {
  let latest: { timestamp: string | null; value: JsonObject } | null = null;
  for (const line of raw.split("\n")) {
    if (!line.includes("rate_limits")) continue;
    try {
      const entry = object(JSON.parse(line));
      if (entry?.type !== "event_msg") continue;
      const payload = object(entry.payload);
      const limits = object(payload?.rate_limits);
      if (payload?.type !== "token_count" || !limits) continue;
      const timestamp = text(entry.timestamp);
      if (
        !latest ||
        observationTime(timestamp) >= observationTime(latest.timestamp)
      ) {
        latest = { timestamp, value: limits };
      }
    } catch {
      // A partial first line (the tail starts mid-line) or a corrupt one.
    }
  }
  if (!latest) {
    return {
      engine: "codex",
      plan: null,
      observedAt: null,
      windows: [],
      unavailableReason: NO_CODEX_REPORT,
    };
  }
  const windows: PlanWindow[] = [];
  for (const [id, fallback] of [
    ["primary", "Primary limit"],
    ["secondary", "Secondary limit"],
  ] as const) {
    const value = object(latest.value[id]);
    const item = window(
      id,
      durationLabel(finiteNumber(value?.window_minutes), fallback),
      value?.used_percent,
      value?.resets_at
    );
    if (item) windows.push(item);
  }
  return {
    engine: "codex",
    plan: planName(latest.value.plan_type),
    observedAt: latest.timestamp,
    windows,
    ...(windows.length === 0 ? { unavailableReason: NO_CODEX_REPORT } : {}),
  };
}

/** How many of the newest rollouts are read looking for a report. */
const CODEX_ROLLOUTS_READ = 12;
/** Rate limits come with every model response; the end of a file has the newest. */
const ROLLOUT_TAIL_BYTES = 512 * 1024;

function codexSessionsDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  return path.join(
    env.CODEX_HOME?.trim() || path.join(homeDir, ".codex"),
    "sessions"
  );
}

/**
 * The newest rollouts, newest first. Codex files them under
 * `sessions/YYYY/MM/DD/`, so the newest are found by walking the date
 * directories in reverse and stopping once there are enough.
 */
async function newestCodexRollouts(root: string, limit: number) {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    names.sort().reverse();
    for (const name of names) {
      if (found.length >= limit) return;
      const full = path.join(dir, name);
      if (depth < 3) await walk(full, depth + 1);
      else if (name.endsWith(".jsonl")) found.push(full);
    }
  }
  await walk(root, 0);
  const withTimes = await Promise.all(
    found.map(async (file) => {
      try {
        return { file, at: (await stat(file)).mtimeMs };
      } catch {
        return { file, at: 0 };
      }
    })
  );
  return withTimes.sort((a, b) => b.at - a.at).map((f) => f.file);
}

async function readTail(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, ROLLOUT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function loadCodexPlan(
  options: ProviderPlanOptions,
  env: NodeJS.ProcessEnv,
  homeDir: string
): Promise<ProviderPlan> {
  const files = await (options.codexFiles
    ? options.codexFiles()
    : newestCodexRollouts(codexSessionsDir(env, homeDir), CODEX_ROLLOUTS_READ));
  for (const file of files) {
    try {
      const plan = parseCodexRollout(
        await (options.readTail ?? readTail)(file)
      );
      if (plan.windows.length > 0) return plan;
    } catch {
      // Unreadable: try the next one.
    }
  }
  return parseCodexRollout("");
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
  "Claude Code's login on this machine has expired, so plan usage cannot be refreshed. It renews the next time Claude Code runs.";

const REFRESH_FAILURE_TEXT: Record<RefreshFailureReason, string> = {
  not_signed_in:
    "Claude Code is not signed in with a subscription on this machine.",
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

async function readClaudeLogin(
  options: ProviderPlanOptions,
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
  // Under an injected `read` (tests) the real Keychain is never reached.
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
      return { token, expiresAt: finiteNumber(oauth?.expiresAt) };
    } catch {
      // Absent or unreadable: try the next place the login can live.
    }
  }
  throw new RefreshFailure("not_signed_in");
}

/** `.claude.json` sits in the home directory itself, or in CLAUDE_CONFIG_DIR. */
export function claudeConfigPath(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return path.join(env.CLAUDE_CONFIG_DIR?.trim() || homeDir, ".claude.json");
}

async function loadClaudePlan(
  options: ProviderPlanOptions,
  env: NodeJS.ProcessEnv,
  homeDir: string,
  now: Date
): Promise<ProviderPlan> {
  const read = options.read ?? ((file: string) => readFile(file, "utf8"));
  let claude: ProviderPlan;
  try {
    claude = parseClaudeCache(await read(claudeConfigPath(homeDir, env)));
  } catch {
    claude = parseClaudeCache("");
  }
  // A cache under a minute old is fresh enough; otherwise ask Anthropic.
  if (now.valueOf() - observationTime(claude.observedAt) <= 60_000) {
    return claude;
  }
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
    const live = parseClaudeUtilization(
      await response.json(),
      now.toISOString()
    );
    if (!live.windows.length && !live.spend) {
      throw new RefreshFailure("no_usage_reported");
    }
    return live;
  } catch (error) {
    const failure =
      error instanceof RefreshFailure
        ? error
        : new RefreshFailure("unexpected");
    options.log?.warn(
      {
        reason: failure.reason,
        ...(failure.detail ? { detail: failure.detail } : {}),
      },
      "could not refresh Claude plan usage"
    );
    return {
      ...claude,
      unavailableReason: REFRESH_FAILURE_TEXT[failure.reason],
    };
  }
}

export async function loadProviderPlans(
  options: ProviderPlanOptions = {}
): Promise<ProviderPlansResponse> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const [claude, codex] = await Promise.all([
    loadClaudePlan(options, env, homeDir, now),
    loadCodexPlan(options, env, homeDir),
  ]);
  return { checkedAt: now.toISOString(), providers: [claude, codex] };
}

/** A forced refresh still reuses a report this young: a guard on the provider. */
const FORCE_REFRESH_FLOOR_MS = 5_000;

/**
 * Cached for a minute; `force` (the dialog's Refresh) asks again unless the
 * last answer is only seconds old. A failed Claude refresh keeps the last
 * good windows and adds the reason.
 */
export function createProviderPlansReporter(
  options: Omit<ProviderPlanOptions, "now"> = {},
  cacheMs = 60_000
): (request?: { force?: boolean }) => Promise<ProviderPlansResponse> {
  let cached: { loadedAt: number; report: ProviderPlansResponse } | null = null;
  let pending: Promise<ProviderPlansResponse> | null = null;
  return async (request = {}) => {
    const now = Date.now();
    if (
      cached &&
      now - cached.loadedAt < (request.force ? FORCE_REFRESH_FLOOR_MS : cacheMs)
    ) {
      return cached.report;
    }
    if (pending) return pending;
    pending = loadProviderPlans(options)
      .then((report) => {
        const previous = cached?.report.providers[0];
        const claude = report.providers[0]!;
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
        cached = { loadedAt: Date.now(), report };
        return report;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}
