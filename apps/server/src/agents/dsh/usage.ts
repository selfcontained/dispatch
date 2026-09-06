import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  HarnessTokenCounts,
  HarnessUsageProvider,
  HarnessUsageResponse,
} from "@dispatch/shared";

import { listSessionLogs, readSessionLog } from "./session-log.js";

/**
 * What the provider keys the harness runs on have been used for: the
 * provider's own billing where a key can read it, the prepaid balance
 * where one exists, and Dispatch's own count from the session logs.
 */

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

/** dsh provider route id → its key, label, and what its billing API offers. */
const PROVIDERS: {
  id: string;
  label: string;
  keyEnv: string;
  /** Model catalog file in pi-ai's data dir. */
  catalog: string;
}[] = [
  {
    id: "openai",
    label: "OpenAI",
    keyEnv: "OPENAI_API_KEY",
    catalog: "openai",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    keyEnv: "DEEPSEEK_API_KEY",
    catalog: "deepseek",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    keyEnv: "ANTHROPIC_API_KEY",
    catalog: "anthropic",
  },
  {
    id: "google",
    label: "Google",
    keyEnv: "GEMINI_API_KEY",
    catalog: "google",
  },
];

/** dsh names the same provider "deepseek-official" on its default route. */
const PROVIDER_ALIASES: Record<string, string> = {
  "deepseek-official": "deepseek",
};

export function budgetFor(env: NodeJS.ProcessEnv, id: string): number | null {
  const raw =
    env[`DISPATCH_USAGE_BUDGET_${id.toUpperCase().replace(/-/g, "_")}`];
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function monthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const TIMEOUT_MS = 10_000;

/** OpenAI's costs API: needs an organization Admin key, not the API key. */
export async function fetchOpenAiCosts(
  adminKey: string,
  since: Date,
  fetchFn: FetchLike
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`OpenAI costs API answered ${res.status}`);
    }
    const body = (await res.json()) as {
      data?: {
        results?: { amount?: { value?: number; currency?: string } }[];
      }[];
      has_more?: boolean;
      next_page?: string | null;
    };
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
  fetchFn: FetchLike
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(
        res.status === 401 || res.status === 403
          ? `Anthropic cost report answered ${res.status}: the key needs org-level access (set ANTHROPIC_ADMIN_KEY).`
          : `Anthropic cost report answered ${res.status}`
      );
    }
    const body = (await res.json()) as {
      data?: { results?: { amount?: string | number; currency?: string }[] }[];
      has_more?: boolean;
      next_page?: string | null;
    };
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
  fetchFn: FetchLike
): Promise<NonNullable<HarnessUsageProvider["balance"]>> {
  const res = await fetchFn("https://api.deepseek.com/user/balance", {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`DeepSeek balance API answered ${res.status}`);
  const body = (await res.json()) as {
    is_available?: boolean;
    balance_infos?: {
      currency?: string;
      total_balance?: string | number;
      granted_balance?: string | number;
      topped_up_balance?: string | number;
    }[];
  };
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
 * layout we do not recognise means "no prices", never an error.
 */
export async function loadPriceTable(dshBin: string): Promise<PriceTable> {
  const table: PriceTable = new Map();
  let dir: string;
  try {
    dir = path.dirname(await realpath(dshBin));
  } catch {
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
  if (!pkgDir) return table;
  const data = path.join(
    pkgDir,
    "node_modules",
    "@earendil-works",
    "pi-ai",
    "dist",
    "providers",
    "data"
  );
  let files: string[];
  try {
    files = await readdir(data);
  } catch {
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

export function priceOf(
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

/**
 * Sum the `assistant/message` usage of every session log touched since
 * `since`, per provider and model. Chunks carry the same usage as their
 * message and are skipped, so nothing is counted twice.
 */
export async function loggedUsage(
  dshHome: string,
  since: Date
): Promise<Accum> {
  const accum: Accum = new Map();
  for (const file of await listSessionLogs(dshHome)) {
    try {
      const info = await stat(file);
      if (info.mtimeMs < since.getTime()) continue;
      const log = await readSessionLog(file);
      for (const event of log.events) {
        if (event.type !== "assistant/message") continue;
        if (typeof event.time === "number" && event.time < since.getTime()) {
          continue;
        }
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
    } catch {
      // A torn or foreign file is skipped, not fatal.
    }
  }
  return accum;
}

// ---- report --------------------------------------------------------------

export type UsageDeps = {
  env: NodeJS.ProcessEnv;
  dshHome: string;
  dshBin: string;
  fetchFn?: FetchLike;
  now?: () => Date;
};

export async function buildUsageReport(
  deps: UsageDeps
): Promise<HarnessUsageResponse> {
  const now = deps.now?.() ?? new Date();
  const since = monthStartUtc(now);
  const fetchFn = deps.fetchFn ?? (fetch as unknown as FetchLike);
  const [table, logged] = await Promise.all([
    loadPriceTable(deps.dshBin),
    loggedUsage(deps.dshHome, since),
  ]);
  const providers: HarnessUsageProvider[] = [];
  for (const spec of PROVIDERS) {
    if (!deps.env[spec.keyEnv]) continue;
    const row: HarnessUsageProvider = {
      id: spec.id,
      label: spec.label,
      keyEnv: spec.keyEnv,
      budgetUsd: budgetFor(deps.env, spec.id),
      logged: {
        since: since.toISOString(),
        tokens: zero(),
        usd: null,
        models: [],
      },
    };
    // Logged usage under this provider and its aliases.
    let priced = true;
    let usd = 0;
    for (const [provider, byModel] of logged) {
      if ((PROVIDER_ALIASES[provider] ?? provider) !== spec.id) continue;
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
    try {
      if (spec.id === "openai") {
        const admin = deps.env.OPENAI_ADMIN_KEY;
        if (admin) {
          row.billed = {
            usd: await fetchOpenAiCosts(admin, since, fetchFn),
            since: since.toISOString(),
            source: "openai-costs",
          };
        } else {
          row.error =
            "Set OPENAI_ADMIN_KEY to read OpenAI's billed cost; the API key cannot.";
        }
      } else if (spec.id === "deepseek") {
        row.balance = await fetchDeepSeekBalance(
          deps.env[spec.keyEnv]!,
          fetchFn
        );
      } else if (spec.id === "anthropic") {
        const key = deps.env.ANTHROPIC_ADMIN_KEY ?? deps.env[spec.keyEnv]!;
        row.billed = {
          usd: await fetchAnthropicCosts(key, since, fetchFn),
          since: since.toISOString(),
          source: "anthropic-cost-report",
        };
      }
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
    }
    providers.push(row);
  }
  return {
    generatedAt: now.toISOString(),
    monthStart: since.toISOString(),
    providers,
  };
}

const CACHE_TTL_MS = 60_000;

/** The report, refreshed at most once a minute: billing APIs are slow and rate-limited. */
export function createUsageReporter(
  deps: UsageDeps
): () => Promise<HarnessUsageResponse> {
  let cached: { at: number; report: HarnessUsageResponse } | null = null;
  let inFlight: Promise<HarnessUsageResponse> | null = null;
  return async () => {
    const now = Date.now();
    if (cached && now - cached.at < CACHE_TTL_MS) return cached.report;
    if (inFlight) return inFlight;
    inFlight = buildUsageReport(deps)
      .then((report) => {
        cached = { at: Date.now(), report };
        return report;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
