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
};

type JsonObject = Record<string, unknown>;

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
        latest = { timestamp: text(entry.timestamp), value: limits };
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
  options: ProviderUsageOptions = {}
): Promise<HarnessProviderUsageReport> {
  const read = options.read ?? ((file: string) => readFile(file, "utf8"));
  const modifiedAt =
    options.modifiedAt ?? (async (file: string) => (await stat(file)).mtimeMs);
  const files = await (options.codexFiles ?? discoverCodexRolloutFiles)();
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
      codex = parseCodexProviderUsage(await read(candidate.file));
      if (codex.windows.length > 0) break;
    } catch {
      continue;
    }
  }

  let claude: HarnessProviderPlan;
  try {
    claude = parseClaudeProviderUsage(
      await read(claudeConfigPath(options.homeDir ?? os.homedir()))
    );
  } catch {
    claude = parseClaudeProviderUsage("");
  }

  const now = options.now ?? new Date();
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

export function createHarnessProviderUsageReporter(
  options: Omit<ProviderUsageOptions, "now"> = {},
  cacheMs = 60_000
): () => Promise<HarnessProviderUsageReport> {
  let cached: { expiresAt: number; report: HarnessProviderUsageReport } | null =
    null;
  return async () => {
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.report;
    const report = await loadHarnessProviderUsage(options);
    cached = { expiresAt: now + cacheMs, report };
    return report;
  };
}
