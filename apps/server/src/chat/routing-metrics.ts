/** Standard, nonregional Decisions estimate. Not billing; rates verified 2026-11-08. */
export const ROUTING_RATES = {
  date: "2026-11-08",
  uncachedInputPerMillion: 0.1,
  cachedInputPerMillion: 0.01,
  cacheWritePerMillion: 0.125,
  outputPerMillion: 0,
  source: "https://developers.openai.com/api/docs/guides/decisions",
  cacheSource: "https://developers.openai.com/api/docs/pricing",
};
const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function estimateRoutingUsd(usage: unknown): number | null {
  const u = obj(usage);
  const details = obj(u.input_tokens_details);
  if (
    !count(u.input_tokens) ||
    !count(details.cached_tokens) ||
    !count(details.cache_write_tokens) ||
    details.cached_tokens + details.cache_write_tokens > u.input_tokens
  )
    return null;
  return (
    ((u.input_tokens - details.cached_tokens - details.cache_write_tokens) *
      ROUTING_RATES.uncachedInputPerMillion +
      details.cached_tokens * ROUTING_RATES.cachedInputPerMillion +
      details.cache_write_tokens * ROUTING_RATES.cacheWritePerMillion) /
    1_000_000
  );
}
export function durationSummary(values: number[]) {
  const sorted = values
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  const n = sorted.length;
  return {
    n,
    medianMs: n
      ? (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.ceil((n - 1) / 2)]!) / 2
      : null,
    p95Ms: n ? sorted[Math.ceil(n * 0.95) - 1]! : null,
    maxMs: n ? sorted[n - 1]! : null,
  };
}
export function summarizeRouting(
  records: { status: string; result: unknown }[]
) {
  const attempts = records.filter((r) => !r.status.startsWith("skipped"));
  const results = attempts.map((r) => obj(r.result));
  const costs = results.map((r) => estimateRoutingUsd(r.usage));
  const known = costs.filter((v): v is number => v !== null);
  const durations = (key: string) =>
    results
      .map((r) => r[key])
      .filter((v): v is number => typeof v === "number");
  return {
    retainedReservations: attempts.length,
    failures: attempts.filter((r) => !["ok", "pending"].includes(r.status))
      .length,
    timeouts: attempts.filter((r) => r.status === "timeout").length,
    skipped: records.length - attempts.length,
    provider: durationSummary(durations("latencyMs")),
    activeRouting: durationSummary(
      results
        .filter((r) => r.mode === "active")
        .map((r) => r.totalRoutingDelayMs)
        .filter((v): v is number => typeof v === "number")
    ),
    estimatedUsd:
      known.length && known.length === costs.length
        ? known.reduce((a, b) => a + b, 0)
        : null,
    knownEstimatedUsd: known.length ? known.reduce((a, b) => a + b, 0) : null,
    pricedCalls: known.length,
    unknownCostCalls: costs.length - known.length,
    rates: ROUTING_RATES,
  };
}
