import type { DecisionMetrics, MergeRiskMetrics } from "@dispatch/shared";

export function summarizeMergeRisk(
  records: { status: string; result: Record<string, unknown> }[]
): MergeRiskMetrics {
  const attempts = records.filter((r) => !r.status.startsWith("skipped"));
  const verdict = (name: string) =>
    attempts.filter((r) => r.status === "ok" && r.result.verdict === name)
      .length;
  const costs = attempts.map((r) => routingCost(r.result.usage).usd);
  const durations = durationSummary(
    attempts
      .map((r) => r.result.latencyMs)
      .filter((v): v is number => typeof v === "number")
  );
  return {
    attempts: attempts.length,
    routine: verdict("routine"),
    humanReview: verdict("human_review"),
    abstain: verdict("abstain"),
    failures: attempts.filter((r) => !["ok", "pending"].includes(r.status))
      .length,
    skipped: records.length - attempts.length,
    medianMs: durations.medianMs,
    p95Ms: durations.p95Ms,
    knownEstimatedUsd: costs.reduce<number>(
      (sum, cost) => sum + (cost ?? 0),
      0
    ),
    unknownCostCalls: costs.filter((v) => v === null).length,
  };
}
import { durationSummary, routingCost } from "./routing-metrics.js";

export function summarizeDecisions(
  records: { status: string; result: Record<string, unknown> }[],
  kind: "routing" | "steering"
): DecisionMetrics {
  const attempts = records.filter((r) => !r.status.startsWith("skipped"));
  const outcome = (name: string) =>
    attempts.filter((r) => r.result.outcome === name).length;
  const costs = attempts.map((r) => routingCost(r.result.usage).usd);
  const durations = durationSummary(
    attempts
      .map((r) => r.result.latencyMs)
      .filter((v): v is number => typeof v === "number")
  );
  const steered = outcome("steered");
  const queued = outcome("queued");
  return {
    attempts: attempts.length,
    pending: attempts.filter((r) => r.status === "pending").length,
    applied:
      kind === "routing"
        ? attempts.filter((r) => r.result.applied === true).length
        : steered + queued,
    steered,
    queued,
    defaults:
      kind === "routing"
        ? attempts.filter((r) => r.result.applied !== true && r.status === "ok")
            .length
        : outcome("default"),
    expired: outcome("expired"),
    overridden: outcome("overridden"),
    failures: attempts.filter((r) => !["ok", "pending"].includes(r.status))
      .length,
    skipped: records.length - attempts.length,
    medianMs: durations.medianMs,
    p95Ms: durations.p95Ms,
    knownEstimatedUsd: costs.reduce<number>(
      (sum, cost) => sum + (cost ?? 0),
      0
    ),
    unknownCostCalls: costs.filter((v) => v === null).length,
  };
}
