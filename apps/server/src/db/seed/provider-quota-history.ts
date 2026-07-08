import type { PoolClient } from "pg";

import { seedNow } from "./constants.js";

type QuotaSeedWindow = {
  provider: "codex" | "claude";
  accountLabel: string;
  accountId: string;
  windowId: string;
  title: string;
  kind: string;
  scope: string;
  windowSeconds: number;
  resetCycleHours: number;
  basePercent: number;
  amplitude: number;
  spikeEvery?: number;
  spikePercent?: number;
};

const WINDOWS: QuotaSeedWindow[] = [
  {
    provider: "codex",
    accountLabel: "dispatch-demo@example.com",
    accountId: "seed-codex-account",
    windowId: "primary_window",
    title: "Primary window",
    kind: "session",
    scope: "account",
    windowSeconds: 18_000,
    resetCycleHours: 5,
    basePercent: 34,
    amplitude: 28,
    spikeEvery: 6,
    spikePercent: 91,
  },
  {
    provider: "codex",
    accountLabel: "dispatch-demo@example.com",
    accountId: "seed-codex-account",
    windowId: "secondary_window",
    title: "Secondary window",
    kind: "weekly",
    scope: "account",
    windowSeconds: 604_800,
    resetCycleHours: 168,
    basePercent: 18,
    amplitude: 13,
  },
  {
    provider: "codex",
    accountLabel: "dispatch-demo@example.com",
    accountId: "seed-codex-account",
    windowId: "primary_window:gpt-5",
    title: "Primary window / GPT-5",
    kind: "session",
    scope: "model",
    windowSeconds: 18_000,
    resetCycleHours: 5,
    basePercent: 42,
    amplitude: 36,
    spikeEvery: 5,
    spikePercent: 96,
  },
  {
    provider: "claude",
    accountLabel: "Dispatch Demo",
    accountId: "seed-claude-org",
    windowId: "five_hour",
    title: "Five Hour",
    kind: "session",
    scope: "account",
    windowSeconds: 18_000,
    resetCycleHours: 5,
    basePercent: 39,
    amplitude: 34,
    spikeEvery: 7,
    spikePercent: 94,
  },
  {
    provider: "claude",
    accountLabel: "Dispatch Demo",
    accountId: "seed-claude-org",
    windowId: "seven_day",
    title: "Seven Day",
    kind: "weekly",
    scope: "account",
    windowSeconds: 604_800,
    resetCycleHours: 168,
    basePercent: 16,
    amplitude: 11,
  },
  {
    provider: "claude",
    accountLabel: "Dispatch Demo",
    accountId: "seed-claude-org",
    windowId: "limits:session:fable",
    title: "Model / Claude Fable",
    kind: "session",
    scope: "model",
    windowSeconds: 18_000,
    resetCycleHours: 5,
    basePercent: 24,
    amplitude: 22,
    spikeEvery: 8,
    spikePercent: 83,
  },
  {
    provider: "claude",
    accountLabel: "Dispatch Demo",
    accountId: "seed-claude-org",
    windowId: "limits:weekly_scoped:sonnet",
    title: "Model / Claude Sonnet",
    kind: "weekly",
    scope: "model",
    windowSeconds: 604_800,
    resetCycleHours: 168,
    basePercent: 28,
    amplitude: 19,
  },
];

function hoursAgo(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

function usageAt(window: QuotaSeedWindow, index: number): number {
  const wave = Math.sin(index * 0.9) * window.amplitude;
  const drift = (index % 9) * 2.4;
  const spiked =
    window.spikeEvery && index % window.spikeEvery === window.spikeEvery - 1;
  const used = spiked
    ? (window.spikePercent ?? 90) - (index % 3) * 2
    : window.basePercent + wave + drift;
  return Math.max(3, Math.min(99, Math.round(used * 10) / 10));
}

function nextResetAt(
  observedAt: Date,
  window: QuotaSeedWindow,
  index: number
): Date {
  const cycleMs = window.resetCycleHours * 60 * 60 * 1000;
  if (index % 10 === 0) {
    return new Date(observedAt.getTime() + cycleMs * 0.18);
  }
  return new Date(observedAt.getTime() + cycleMs * 0.72);
}

async function insertObservation(
  client: PoolClient,
  window: QuotaSeedWindow,
  observedAt: Date,
  usedPercent: number,
  resetsAt: Date
): Promise<void> {
  await client.query(
    `INSERT INTO provider_quota_observations (
       provider, account_label, account_id, source, window_id, title,
       kind, scope, observed_at, used_percent, resets_at, window_seconds,
       status, trigger, error
     ) VALUES ($1,$2,$3,'seed-demo',$4,$5,$6,$7,$8,$9,$10,$11,'ok','seed',NULL)`,
    [
      window.provider,
      window.accountLabel,
      window.accountId,
      window.windowId,
      window.title,
      window.kind,
      window.scope,
      observedAt,
      usedPercent,
      resetsAt,
      window.windowSeconds,
    ]
  );
}

async function upsertLatest(
  client: PoolClient,
  window: QuotaSeedWindow,
  observedAt: Date,
  usedPercent: number,
  resetsAt: Date
): Promise<void> {
  await client.query(
    `INSERT INTO provider_quota_snapshots (
       provider, account_label, account_id, source, window_id, title,
       used_percent, window_minutes, resets_at, fetched_at, status, error
     ) VALUES ($1,$2,$3,'seed-demo',$4,$5,$6,$7,$8,$9,'ok',NULL)
     ON CONFLICT (
       provider,
       (COALESCE(account_id, '')),
       (COALESCE(account_label, '')),
       window_id,
       source
     )
     DO UPDATE SET
       title = EXCLUDED.title,
       used_percent = EXCLUDED.used_percent,
       window_minutes = EXCLUDED.window_minutes,
       resets_at = EXCLUDED.resets_at,
       fetched_at = EXCLUDED.fetched_at,
       status = EXCLUDED.status,
       error = EXCLUDED.error,
       updated_at = NOW()`,
    [
      window.provider,
      window.accountLabel,
      window.accountId,
      window.windowId,
      window.title,
      usedPercent,
      Math.round(window.windowSeconds / 60),
      resetsAt,
      observedAt,
    ]
  );
}

export async function seedProviderQuotaHistory(
  client: PoolClient
): Promise<void> {
  const now = seedNow();
  for (const window of WINDOWS) {
    let latest: {
      observedAt: Date;
      usedPercent: number;
      resetsAt: Date;
    } | null = null;
    for (let i = 0; i < 36; i += 1) {
      const observedAt = hoursAgo(now, (35 - i) * 12);
      const usedPercent = usageAt(window, i);
      const resetsAt = nextResetAt(observedAt, window, i);
      await insertObservation(
        client,
        window,
        observedAt,
        usedPercent,
        resetsAt
      );
      latest = { observedAt, usedPercent, resetsAt };
    }
    if (latest) {
      await upsertLatest(
        client,
        window,
        latest.observedAt,
        latest.usedPercent,
        latest.resetsAt
      );
    }
  }
}
