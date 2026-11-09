/** Aggregate diagnostics only; does not expose messages or credentials. */
export type DecisionMetrics = {
  attempts: number;
  pending: number;
  applied: number;
  steered: number;
  queued: number;
  defaults: number;
  expired: number;
  overridden: number;
  failures: number;
  skipped: number;
  medianMs: number | null;
  p95Ms: number | null;
  knownEstimatedUsd: number;
  unknownCostCalls: number;
};
/** Merge-risk recommendations are verdicts, not deliveries. */
export type MergeRiskMetrics = {
  attempts: number;
  routine: number;
  humanReview: number;
  abstain: number;
  failures: number;
  skipped: number;
  medianMs: number | null;
  p95Ms: number | null;
  knownEstimatedUsd: number;
  unknownCostCalls: number;
};
export type DecisionsMetricsResponse = {
  routing: DecisionMetrics;
  steering: DecisionMetrics;
  mergeRisk: MergeRiskMetrics;
  retentionDays: number;
  retainedLimit: number;
};
