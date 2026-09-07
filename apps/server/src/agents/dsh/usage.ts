import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  HARNESS_USAGE_PROVIDERS,
  isHarnessBudgetProvider,
  type HarnessTokenCounts,
  type HarnessUsageProvider,
  type HarnessUsageResponse,
  type UsageBudgets,
} from "@dispatch/shared";

import { fetchCodexUsage } from "./codex-usage.js";
import { readCodexGrant, readGrantKeys } from "./credentials.js";
import { resolveExecutable, type DriverLogger } from "./driver.js";
import { listSessionLogs, readSessionLog } from "./session-log.js";
import {
  BillingStatusError,
  PROVIDER_DEADLINE_MS,
  readJson,
  type FetchLike,
} from "./usage-http.js";

export type { FetchLike } from "./usage-http.js";

/**
 * What the provider keys the harness runs on have been used for: the
 * provider's own billing where a key can read it, the prepaid balance
 * where one exists, and Dispatch's own count from the session logs.
 */

/** The providers the usage dialog lists. */
const PROVIDERS = HARNESS_USAGE_PROVIDERS;

/** dsh names the same provider "deepseek-official" on its default route. */
const PROVIDER_ALIASES: Record<string, string> = {
  "deepseek-official": "deepseek",
};

export function monthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** OpenAI's costs API: needs an organization Admin key, not the API key. */
export async function fetchOpenAiCosts(
  adminKey: string,
  since: Date,
  fetchFn: FetchLike,
  signal: AbortSignal = AbortSignal.timeout(PROVIDER_DEADLINE_MS)
): Promise<number> {
  let total = 0;
  let page: string | null = null;
  for (let i = 0; i < 4; i += 1) {
    const url = new URL("https://api.openai.com/v1/organization/costs");
    url.searchParams.set(
      "start_time",
      String(Math.floor(since.getTime() / 1000))
    );
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");
    if (page) url.searchParams.set("page", page);
    const res = await fetchFn(url.toString(), {
      headers: { Authorization: `Bearer ${adminKey}` },
      signal,
    });
    if (!res.ok) {
      throw new BillingStatusError(`OpenAI costs API answered ${res.status}`);
    }
    const body = await readJson<{
      data?: {
        results?: { amount?: { value?: number; currency?: string } }[];
      }[];
      has_more?: boolean;
      next_page?: string | null;
    }>(res, "OpenAI costs API");
    for (const bucket of body.data ?? []) {
      for (const result of bucket.results ?? []) {
        const value = result.amount?.value;
        if (typeof value === "number") total += value;
      }
    }
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }
  return total;
}

/**
 * Anthropic's cost report: an Admin key, or a personal key not scoped to a
 * workspace. Amounts are decimal strings in cents.
 */
export async function fetchAnthropicCosts(
  key: string,
  since: Date,
  fetchFn: FetchLike,
  signal: AbortSignal = AbortSignal.timeout(PROVIDER_DEADLINE_MS)
): Promise<number> {
  let cents = 0;
  let page: string | null = null;
  for (let i = 0; i < 4; i += 1) {
    const url = new URL(
      "https://api.anthropic.com/v1/organizations/cost_report"
    );
    url.searchParams.set("starting_at", since.toISOString());
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");
    if (page) url.searchParams.set("page", page);
    const res = await fetchFn(url.toString(), {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal,
    });
    if (!res.ok) {
      throw new BillingStatusError(
        res.status === 401 || res.status === 403
          ? `Anthropic cost report answered ${res.status}: the key needs org-level access (set ANTHROPIC_ADMIN_KEY).`
          : `Anthropic cost report answered ${res.status}.`
      );
    }
    const body = await readJson<{
      data?: { results?: { amount?: string | number; currency?: string }[] }[];
      has_more?: boolean;
      next_page?: string | null;
    }>(res, "Anthropic cost report");
    for (const bucket of body.data ?? []) {
      for (const result of bucket.results ?? []) {
        const value = Number(result.amount);
        if (Number.isFinite(value)) cents += value;
      }
    }
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }
  return cents / 100;
}

export async function fetchDeepSeekBalance(
  key: string,
  fetchFn: FetchLike,
  signal: AbortSignal = AbortSignal.timeout(PROVIDER_DEADLINE_MS)
): Promise<NonNullable<HarnessUsageProvider["balance"]>> {
  const res = await fetchFn("https://api.deepseek.com/user/balance", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal,
  });
  if (!res.ok)
    throw new BillingStatusError(
      `DeepSeek balance API answered ${res.status}.`
    );
  const body = await readJson<{
    is_available?: boolean;
    balance_infos?: {
      currency?: string;
      total_balance?: string | number;
      granted_balance?: string | number;
      topped_up_balance?: string | number;
    }[];
  }>(res, "DeepSeek balance API");
  const info =
    body.balance_infos?.find((b) => b.currency === "USD") ??
    body.balance_infos?.[0];
  const num = (v: string | number | undefined) => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    currency: info?.currency ?? "USD",
    total: num(info?.total_balance),
    granted: num(info?.granted_balance),
    toppedUp: num(info?.topped_up_balance),
    available: body.is_available !== false,
  };
}

// ---- prices --------------------------------------------------------------

/** USD per million tokens, as pi-ai's catalog lists them. */
export type ModelPrice = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
export type PriceTable = Map<string, ModelPrice>; // "provider/model"

/**
 * dsh prices its models through pi-ai's catalog, which ships beside the
 * binary. Walk up from the executable to the dsh package and read it; a
 * layout we do not recognize means "no prices", never an error.
 */
export async function loadPriceTable(
  dshBin: string,
  env: NodeJS.ProcessEnv = process.env,
  logger?: DriverLogger
): Promise<PriceTable> {
  const table: PriceTable = new Map();
  // The configured value is usually a bare command name; walk PATH the
  // way the child spawn does, then follow the symlink to the package.
  let dir: string;
  try {
    dir = path.dirname(await realpath(await resolveExecutable(dshBin, env)));
  } catch (err) {
    logger?.warn({ err, dshBin }, "dsh price table: binary not found");
    return table;
  }
  let pkgDir: string | null = null;
  for (let i = 0; i < 6 && dir !== path.dirname(dir); i += 1) {
    try {
      const pkg = JSON.parse(
        await readFile(path.join(dir, "package.json"), "utf8")
      ) as { name?: string };
      if (pkg.name === "@deepseek-ai/dsh") {
        pkgDir = dir;
        break;
      }
    } catch {
      // keep climbing
    }
    dir = path.dirname(dir);
  }
  if (!pkgDir) {
    logger?.warn({ dshBin }, "dsh price table: dsh package not found");
    return table;
  }
  // pi-ai's location depends on the package manager (nested under dsh for
  // npm, a sibling under .pnpm, hoisted for bun). Node's resolution roots
  // from the dsh package cover every layout; its package.json is checked
  // directly because pi-ai's `exports` map does not expose it.
  const require = createRequire(path.join(pkgDir, "package.json"));
  let data: string | null = null;
  for (const root of require.resolve.paths("@earendil-works/pi-ai") ?? []) {
    const candidate = path.join(root, "@earendil-works", "pi-ai");
    try {
      await stat(path.join(candidate, "package.json"));
      data = path.join(candidate, "dist", "providers", "data");
      break;
    } catch {
      // not in this root
    }
  }
  if (!data) {
    logger?.warn({ pkgDir }, "dsh price table: pi-ai not found beside dsh");
    return table;
  }
  let files: string[];
  try {
    files = await readdir(data);
  } catch (err) {
    logger?.warn({ err, data }, "dsh price table: catalog dir missing");
    return table;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(
        await readFile(path.join(data, file), "utf8")
      ) as Record<
        string,
        Record<string, { provider?: string; cost?: Partial<ModelPrice> }>
      >;
      for (const models of Object.values(parsed)) {
        for (const [id, model] of Object.entries(models)) {
          const provider = model.provider ?? file.replace(/\.json$/, "");
          const cost = model.cost;
          if (!cost) continue;
          table.set(`${provider}/${id}`, {
            input: cost.input ?? 0,
            output: cost.output ?? 0,
            cacheRead: cost.cacheRead ?? 0,
            cacheWrite: cost.cacheWrite ?? 0,
          });
        }
      }
    } catch {
      // one bad file does not spoil the table
    }
  }
  return table;
}

function priceOf(
  table: PriceTable,
  provider: string,
  model: string
): ModelPrice | null {
  const canonical = PROVIDER_ALIASES[provider] ?? provider;
  return (
    table.get(`${provider}/${model}`) ??
    table.get(`${canonical}/${model}`) ??
    null
  );
}

export function costUsd(tokens: HarnessTokenCounts, price: ModelPrice): number {
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWrite * price.cacheWrite) /
    1_000_000
  );
}

// ---- logs ----------------------------------------------------------------

type Accum = Map<string, Map<string, HarnessTokenCounts>>; // provider → model → tokens

function zero(): HarnessTokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function add(into: HarnessTokenCounts, from: HarnessTokenCounts): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
}

/** Per-file totals, keyed by path; valid while size and mtime match. */
export type LogUsageCache = Map<
  string,
  { size: number; mtimeMs: number; partial: boolean; byProvider: Accum }
>;

function usageOfLog(
  events: { type: string; time?: number; data?: Record<string, unknown> }[],
  since: Date
): Accum {
  const accum: Accum = new Map();
  for (const event of events) {
    if (event.type !== "assistant/message") continue;
    if (typeof event.time === "number" && event.time < since.getTime())
      continue;
    const data = event.data ?? {};
    const usage = data.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    const message = data.message as
      | { source?: { provider?: string; model?: string } }
      | undefined;
    const provider = message?.source?.provider ?? "unknown";
    const model = message?.source?.model ?? "unknown";
    const n = (v: unknown) => (typeof v === "number" ? v : 0);
    const counts: HarnessTokenCounts = {
      input: n(usage.inputTokens),
      output: n(usage.outputTokens),
      cacheRead: n(usage.cacheReadTokens),
      cacheWrite: n(usage.cacheWriteTokens),
    };
    const byModel = accum.get(provider) ?? new Map();
    accum.set(provider, byModel);
    const current = byModel.get(model) ?? zero();
    byModel.set(model, current);
    add(current, counts);
  }
  return accum;
}

/**
 * Sum the `assistant/message` usage of every session log touched since
 * `since`, per provider and model. Chunks carry the same usage as their
 * message and are skipped, so nothing is counted twice. A log whose size
 * and mtime have not changed since the last scan is not decoded again.
 */
export async function loggedUsage(
  dshHome: string,
  since: Date,
  cache: LogUsageCache = new Map()
): Promise<{ usage: Accum; partial: boolean }> {
  const total: Accum = new Map();
  let partial = false;
  const seen = new Set<string>();
  for (const file of await listSessionLogs(dshHome)) {
    try {
      const info = await stat(file);
      if (info.mtimeMs < since.getTime()) continue;
      seen.add(file);
      let entry = cache.get(file);
      if (
        !entry ||
        entry.mtimeMs !== info.mtimeMs ||
        entry.size !== info.size
      ) {
        const log = await readSessionLog(file);
        entry = {
          size: log.size,
          mtimeMs: log.mtimeMs,
          partial: log.partial,
          byProvider: usageOfLog(log.events, since),
        };
        cache.set(file, entry);
      }
      if (entry.partial) partial = true;
      for (const [provider, byModel] of entry.byProvider) {
        const target = total.get(provider) ?? new Map();
        total.set(provider, target);
        for (const [model, tokens] of byModel) {
          const current = target.get(model) ?? zero();
          target.set(model, current);
          add(current, tokens);
        }
      }
    } catch {
      // A torn or foreign file is skipped, not fatal.
    }
  }
  for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);
  return { usage: total, partial };
}

// ---- report --------------------------------------------------------------

export type UsageDeps = {
  env: NodeJS.ProcessEnv;
  dshHome: string;
  dshBin: string;
  /** Monthly budgets from Settings (usage-budget-settings.ts). */
  budgets: () => Promise<UsageBudgets>;
  fetchFn?: FetchLike;
  now?: () => Date;
  logger?: DriverLogger;
  /** Per-file totals kept between reports; the reporter owns one. */
  logCache?: LogUsageCache;
};

export async function buildUsageReport(
  deps: UsageDeps
): Promise<HarnessUsageResponse> {
  const now = deps.now?.() ?? new Date();
  const since = monthStartUtc(now);
  const fetchFn = deps.fetchFn ?? (fetch as unknown as FetchLike);
  const [table, logged, budgets, grants] = await Promise.all([
    loadPriceTable(deps.dshBin, deps.env, deps.logger),
    loggedUsage(deps.dshHome, since, deps.logCache),
    deps.budgets(),
    readGrantKeys(deps.dshHome),
  ]);
  const providers: HarnessUsageProvider[] = [];
  /** Logged usage under this provider id and its aliases, priced where the table can. */
  const foldLogged = (row: HarnessUsageProvider) => {
    let priced = true;
    let usd = 0;
    for (const [provider, byModel] of logged.usage) {
      if ((PROVIDER_ALIASES[provider] ?? provider) !== row.id) continue;
      for (const [model, tokens] of byModel) {
        add(row.logged.tokens, tokens);
        const price = priceOf(table, provider, model);
        const modelUsd = price ? costUsd(tokens, price) : null;
        if (modelUsd === null) priced = false;
        else usd += modelUsd;
        row.logged.models.push({ model, tokens, usd: modelUsd });
      }
    }
    row.logged.usd =
      row.logged.models.length > 0 && priced ? usd : priced ? 0 : null;
    row.logged.models.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  };
  for (const spec of PROVIDERS) {
    // A key is authenticated by the env, a plan by its stored sign-in.
    const authenticated =
      spec.auth.kind === "key"
        ? !!deps.env[spec.auth.env]
        : grants.has(spec.auth.record);
    // A dollar budget applies to metered keys only.
    const budgetUsd = isHarnessBudgetProvider(spec)
      ? (budgets[spec.id] ?? null)
      : null;
    // A row for every route that can run, and for a budget set without a key.
    if (!authenticated && budgetUsd === null) continue;
    const row: HarnessUsageProvider = {
      id: spec.id,
      label: spec.label,
      auth: spec.auth,
      authenticated,
      budgetUsd,
      logged: {
        since: since.toISOString(),
        tokens: zero(),
        usd: null,
        models: [],
      },
    };
    foldLogged(row);
    if (!authenticated && spec.auth.kind === "key") {
      row.error = `${spec.auth.env} is not set in the server environment.`;
    }
    providers.push(row);
  }
  // The billing calls are independent and can each take a while: run them
  // together under one deadline apiece, so the report costs one provider's
  // wait, not the sum. What a provider actually answered stays in the log;
  // the client sees a fixed sentence per failure.
  await Promise.all(
    providers
      .filter((row) => row.authenticated)
      .map(async (row) => {
        const signal = AbortSignal.timeout(PROVIDER_DEADLINE_MS);
        try {
          if (row.auth.kind === "grant") {
            // The one plan today; a second grant route gets its own client here.
            if (row.id !== "openai-codex") return;
            const grant = await readCodexGrant(deps.dshHome);
            if (!grant) {
              throw new BillingStatusError(
                "The ChatGPT sign-in is not in the credential store any more."
              );
            }
            row.subscription = await fetchCodexUsage(
              grant,
              fetchFn,
              signal,
              now
            );
            return;
          }
          const key = deps.env[row.auth.env]!;
          if (row.id === "openai") {
            const admin = deps.env.OPENAI_ADMIN_KEY;
            if (!admin) {
              row.error =
                "Set OPENAI_ADMIN_KEY to read OpenAI's billed cost; the API key cannot.";
              return;
            }
            row.billed = {
              usd: await fetchOpenAiCosts(admin, since, fetchFn, signal),
              since: since.toISOString(),
              source: "openai-costs",
            };
          } else if (row.id === "deepseek") {
            row.balance = await fetchDeepSeekBalance(key, fetchFn, signal);
          } else if (row.id === "anthropic") {
            row.billed = {
              usd: await fetchAnthropicCosts(
                deps.env.ANTHROPIC_ADMIN_KEY ?? key,
                since,
                fetchFn,
                signal
              ),
              since: since.toISOString(),
              source: "anthropic-cost-report",
            };
          }
        } catch (err) {
          deps.logger?.warn(
            { err, provider: row.id },
            "usage: provider billing call failed"
          );
          row.error = describeBillingFailure(row.label, err);
        }
      })
  );
  return {
    generatedAt: now.toISOString(),
    monthStart: since.toISOString(),
    providers,
    ...(logged.partial ? { partial: true } : {}),
  };
}

/** Messages written for the user pass through; anything else becomes one fixed line. */
function describeBillingFailure(label: string, err: unknown): string {
  if (err instanceof BillingStatusError) return err.message;
  if (err instanceof Error && err.name === "TimeoutError") {
    return `${label} did not answer within ${PROVIDER_DEADLINE_MS / 1000}s.`;
  }
  return `Could not reach ${label}.`;
}

const CACHE_TTL_MS = 60_000;

/**
 * The report, refreshed at most once a minute. A report past its age is
 * still returned at once while a fresh one is built behind it, so a slow
 * billing API never freezes the dialog; the first call has to wait.
 */
export function createUsageReporter(
  deps: UsageDeps
): () => Promise<HarnessUsageResponse> {
  const logCache: LogUsageCache = deps.logCache ?? new Map();
  let cached: { at: number; report: HarnessUsageResponse } | null = null;
  let inFlight: Promise<HarnessUsageResponse> | null = null;
  const refresh = () => {
    if (inFlight) return inFlight;
    inFlight = buildUsageReport({ ...deps, logCache })
      .then((report) => {
        cached = { at: Date.now(), report };
        return report;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  return async () => {
    if (!cached) return refresh();
    if (Date.now() - cached.at >= CACHE_TTL_MS) {
      refresh().catch(() => {});
    }
    return cached.report;
  };
}
