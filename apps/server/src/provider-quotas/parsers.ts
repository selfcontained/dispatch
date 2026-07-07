import type {
  ProviderQuotaProvider,
  ProviderQuotaSnapshot,
  ProviderQuotaStatus,
} from "./types.js";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asDate(value: unknown): Date | null {
  const raw = asString(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function percentFromWindow(window: JsonObject): number | null {
  const direct =
    asNumber(window.used_percent) ??
    asNumber(window.percent_used) ??
    asNumber(window.usage_percent) ??
    asNumber(window.utilization) ??
    asNumber(window.percent);
  if (direct !== null) return direct > 1 ? direct : direct * 100;

  const used =
    asNumber(window.used) ??
    asNumber(window.usage) ??
    asNumber(window.current) ??
    asNumber(window.consumed);
  const limit =
    asNumber(window.limit) ??
    asNumber(window.max) ??
    asNumber(window.total) ??
    asNumber(window.quota);
  if (used !== null && limit !== null && limit > 0) {
    return (used / limit) * 100;
  }
  return null;
}

function windowMinutes(window: JsonObject): number | null {
  const minutes =
    asNumber(window.window_minutes) ??
    asNumber(window.period_minutes) ??
    asNumber(window.duration_minutes);
  if (minutes !== null) return Math.round(minutes);

  const seconds =
    asNumber(window.window_seconds) ??
    asNumber(window.period_seconds) ??
    asNumber(window.duration_seconds) ??
    asNumber(window.limit_window_seconds);
  return seconds !== null ? Math.round(seconds / 60) : null;
}

function resetDate(window: JsonObject): Date | null {
  const absolute =
    asDate(window.resets_at) ??
    asDate(window.reset_at) ??
    asDate(window.reset_time) ??
    asDate(window.ends_at);
  if (absolute) return absolute;

  const resetAfterSeconds = asNumber(window.reset_after_seconds);
  if (resetAfterSeconds !== null) {
    return new Date(Date.now() + resetAfterSeconds * 1000);
  }

  const numericReset =
    asNumber(window.reset_at) ??
    asNumber(window.reset_time) ??
    asNumber(window.ends_at);
  if (numericReset !== null) {
    return new Date(
      numericReset > 10_000_000_000 ? numericReset : numericReset * 1000
    );
  }

  return null;
}

function pushWindow(
  output: ProviderQuotaSnapshot[],
  input: {
    provider: ProviderQuotaProvider;
    source: string;
    accountLabel: string | null;
    accountId: string | null;
    windowId: string;
    title: string;
    window: JsonObject;
    fetchedAt: Date;
    status?: ProviderQuotaStatus;
    error?: string | null;
  }
) {
  output.push({
    provider: input.provider,
    accountLabel: input.accountLabel,
    accountId: input.accountId,
    source: input.source,
    windowId: input.windowId,
    title: input.title,
    usedPercent: percentFromWindow(input.window),
    windowMinutes: windowMinutes(input.window),
    resetsAt: resetDate(input.window),
    fetchedAt: input.fetchedAt,
    status: input.status ?? "ok",
    error: input.error ?? null,
  });
}

function titleFromWindowId(id: string): string {
  return id
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function bucketEntries(value: unknown): Array<[string, JsonObject]> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index): Array<[string, JsonObject]> => {
      if (!isObject(entry)) return [];
      const id =
        asString(entry.id) ??
        asString(entry.name) ??
        asString(entry.model) ??
        asString(entry.bucket) ??
        String(index + 1);
      return [[id, entry]];
    });
  }
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(
    ([id, entry]): Array<[string, JsonObject]> =>
      isObject(entry) ? [[id, entry]] : []
  );
}

function pushNestedBuckets(
  output: ProviderQuotaSnapshot[],
  input: {
    provider: ProviderQuotaProvider;
    source: string;
    accountLabel: string | null;
    accountId: string | null;
    parentWindowId: string;
    parentTitle: string;
    window: JsonObject;
    fetchedAt: Date;
  }
) {
  const buckets =
    input.window.buckets ??
    input.window.bucket_breakdown ??
    input.window.breakdown ??
    input.window.children;
  for (const [bucketId, bucket] of bucketEntries(buckets)) {
    const windowId = `${input.parentWindowId}:${bucketId}`;
    const title =
      asString(bucket.title) ??
      asString(bucket.label) ??
      asString(bucket.model) ??
      titleFromWindowId(bucketId);
    pushWindow(output, {
      provider: input.provider,
      source: input.source,
      accountLabel: input.accountLabel,
      accountId: input.accountId,
      windowId,
      title: `${input.parentTitle} / ${title}`,
      window: bucket,
      fetchedAt: input.fetchedAt,
    });
  }
}

function pushCreditWindows(
  output: ProviderQuotaSnapshot[],
  input: {
    provider: ProviderQuotaProvider;
    source: string;
    accountLabel: string | null;
    accountId: string | null;
    credits: unknown;
    fetchedAt: Date;
  }
) {
  for (const [creditId, credit] of bucketEntries(input.credits)) {
    const windowId = `credits:${creditId}`;
    pushWindow(output, {
      provider: input.provider,
      source: input.source,
      accountLabel: input.accountLabel,
      accountId: input.accountId,
      windowId,
      title:
        asString(credit.title) ??
        asString(credit.label) ??
        asString(credit.model) ??
        `Credits / ${titleFromWindowId(creditId)}`,
      window: credit,
      fetchedAt: input.fetchedAt,
    });
    pushNestedBuckets(output, {
      provider: input.provider,
      source: input.source,
      accountLabel: input.accountLabel,
      accountId: input.accountId,
      parentWindowId: windowId,
      parentTitle:
        asString(credit.title) ??
        asString(credit.label) ??
        titleFromWindowId(windowId),
      window: credit,
      fetchedAt: input.fetchedAt,
    });
  }
}

export function parseCodexUsageResponse(
  payload: unknown,
  options?: {
    accountId?: string | null;
    accountLabel?: string | null;
    fetchedAt?: Date;
  }
): ProviderQuotaSnapshot[] {
  const fetchedAt = options?.fetchedAt ?? new Date();
  const root = isObject(payload) ? payload : {};
  const rateLimit = isObject(root.rate_limit) ? root.rate_limit : root;
  const snapshots: ProviderQuotaSnapshot[] = [];

  const primary = isObject(rateLimit.primary_window)
    ? rateLimit.primary_window
    : null;
  if (primary) {
    const accountId =
      options?.accountId ??
      asString(root.account_id) ??
      asString(root.accountId);
    const title = "Primary window";
    pushWindow(snapshots, {
      provider: "codex",
      source: "chatgpt-wham",
      accountLabel: options?.accountLabel ?? null,
      accountId,
      windowId: "primary_window",
      title,
      window: primary,
      fetchedAt,
    });
    pushNestedBuckets(snapshots, {
      provider: "codex",
      source: "chatgpt-wham",
      accountLabel: options?.accountLabel ?? null,
      accountId,
      parentWindowId: "primary_window",
      parentTitle: title,
      window: primary,
      fetchedAt,
    });
  }

  const secondary = isObject(rateLimit.secondary_window)
    ? rateLimit.secondary_window
    : null;
  if (secondary) {
    const accountId =
      options?.accountId ??
      asString(root.account_id) ??
      asString(root.accountId);
    const title = "Secondary window";
    pushWindow(snapshots, {
      provider: "codex",
      source: "chatgpt-wham",
      accountLabel: options?.accountLabel ?? null,
      accountId,
      windowId: "secondary_window",
      title,
      window: secondary,
      fetchedAt,
    });
    pushNestedBuckets(snapshots, {
      provider: "codex",
      source: "chatgpt-wham",
      accountLabel: options?.accountLabel ?? null,
      accountId,
      parentWindowId: "secondary_window",
      parentTitle: title,
      window: secondary,
      fetchedAt,
    });
  }

  const additional = Array.isArray(rateLimit.additional_rate_limits)
    ? rateLimit.additional_rate_limits
    : [];
  additional.forEach((entry, index) => {
    if (!isObject(entry)) return;
    const windowId =
      asString(entry.id) ??
      asString(entry.name) ??
      asString(entry.model) ??
      `additional_${index + 1}`;
    const accountId =
      options?.accountId ??
      asString(root.account_id) ??
      asString(root.accountId);
    const title = asString(entry.title) ?? titleFromWindowId(windowId);
    pushWindow(snapshots, {
      provider: "codex",
      source: "chatgpt-wham",
      accountLabel: options?.accountLabel ?? null,
      accountId,
      windowId,
      title,
      window: entry,
      fetchedAt,
    });
    pushNestedBuckets(snapshots, {
      provider: "codex",
      source: "chatgpt-wham",
      accountLabel: options?.accountLabel ?? null,
      accountId,
      parentWindowId: windowId,
      parentTitle: title,
      window: entry,
      fetchedAt,
    });
  });

  pushCreditWindows(snapshots, {
    provider: "codex",
    source: "chatgpt-wham",
    accountLabel: options?.accountLabel ?? null,
    accountId:
      options?.accountId ??
      asString(root.account_id) ??
      asString(root.accountId),
    credits: root.credits,
    fetchedAt,
  });

  return snapshots;
}

export function parseClaudeUsageResponse(
  payload: unknown,
  options?: {
    accountId?: string | null;
    accountLabel?: string | null;
    source?: string;
    fetchedAt?: Date;
  }
): ProviderQuotaSnapshot[] {
  const fetchedAt = options?.fetchedAt ?? new Date();
  const root = isObject(payload) ? payload : {};
  const snapshots: ProviderQuotaSnapshot[] = [];
  const accountId =
    options?.accountId ??
    asString(root.account_id) ??
    asString(root.organization_id);
  const accountLabel =
    options?.accountLabel ??
    asString(root.account_name) ??
    asString(root.organization_name);
  const source = options?.source ?? "anthropic-oauth";

  for (const windowId of [
    "five_hour",
    "seven_day",
    "seven_day_oauth_apps",
    "seven_day_sonnet",
    "seven_day_opus",
    "seven_day_cowork",
    "seven_day_omelette",
    "seven_day_routines",
    "iguana_necktie",
  ]) {
    const window = isObject(root[windowId]) ? root[windowId] : null;
    if (!window) continue;
    pushWindow(snapshots, {
      provider: "claude",
      source,
      accountLabel: accountLabel ?? null,
      accountId: accountId ?? null,
      windowId,
      title: titleFromWindowId(windowId),
      window,
      fetchedAt,
    });
  }

  const limits = isObject(root.limits) ? root.limits : null;
  if (Array.isArray(root.limits)) {
    root.limits.forEach((entry, index) => {
      if (!isObject(entry)) return;
      const scope = isObject(entry.scope) ? entry.scope : {};
      const model = isObject(scope.model) ? scope.model : {};
      const modelName =
        asString(model.display_name) ??
        asString(model.name) ??
        asString(scope.model) ??
        null;
      const group = asString(entry.group) ?? asString(entry.kind);
      const windowId =
        asString(entry.id) ??
        [asString(entry.kind), group, modelName]
          .filter(Boolean)
          .join(":")
          .toLowerCase()
          .replace(/[^a-z0-9:]+/g, "_") ??
        `limit_${index + 1}`;
      const title = [
        titleFromWindowId(group ?? `Limit ${index + 1}`),
        modelName,
      ]
        .filter(Boolean)
        .join(" / ");
      pushWindow(snapshots, {
        provider: "claude",
        source,
        accountLabel: accountLabel ?? null,
        accountId: accountId ?? null,
        windowId: `limits:${windowId}`,
        title,
        window: entry,
        fetchedAt,
      });
    });
  } else if (limits) {
    Object.entries(limits).forEach(([windowId, window]) => {
      if (!isObject(window)) return;
      pushWindow(snapshots, {
        provider: "claude",
        source,
        accountLabel: accountLabel ?? null,
        accountId: accountId ?? null,
        windowId,
        title: titleFromWindowId(windowId),
        window,
        fetchedAt,
      });
    });
  }

  return snapshots;
}

export function unavailableSnapshot(input: {
  provider: ProviderQuotaProvider;
  source: string;
  windowId?: string;
  title?: string;
  error: string;
  fetchedAt?: Date;
}): ProviderQuotaSnapshot {
  return {
    provider: input.provider,
    accountLabel: null,
    accountId: null,
    source: input.source,
    windowId: input.windowId ?? "account",
    title: input.title ?? "Account quota",
    usedPercent: null,
    windowMinutes: null,
    resetsAt: null,
    fetchedAt: input.fetchedAt ?? new Date(),
    status: "unavailable",
    error: input.error,
  };
}
