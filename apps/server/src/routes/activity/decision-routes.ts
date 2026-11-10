import type { FastifyInstance } from "fastify";
import type { ActivityRouteDeps } from "./shared.js";
import {
  summarizeDecisions,
  summarizeMergeRisk,
} from "../../chat/decision-metrics.js";

export async function registerActivityDecisionRoutes(
  app: FastifyInstance,
  deps: ActivityRouteDeps
) {
  app.get("/api/v1/activity/decisions", async (request, reply) => {
    const range = deps.timeRangeClause(
      deps.parseActivityQuery(request.query as Record<string, unknown>),
      "created_at"
    );
    const attemptRange = deps.timeRangeClause(
      deps.parseActivityQuery(request.query as Record<string, unknown>),
      "attempted_at"
    );
    const read = async (
      table:
        | "routing_shadow_records"
        | "steering_decision_records"
        | "merge_risk_decision_records"
    ) =>
      (
        await deps.pool.query<{
          status: string;
          result: Record<string, unknown>;
        }>(
          `SELECT status,result FROM ${table} WHERE created_at >= now() - interval '14 days' ${range.clause.replace(/^WHERE /, "AND ")} ORDER BY created_at DESC LIMIT 2000`,
          range.params
        )
      ).rows;
    const [routing, steering, mergeRisk, explanations] = await Promise.all([
      read("routing_shadow_records"),
      read("steering_decision_records"),
      read("merge_risk_decision_records"),
      deps.pool.query<{
        result: { estimatedUsd?: number | null };
      }>(
        `SELECT result FROM (
          SELECT attempt AS result,(attempt->>'attemptedAt')::timestamptz AS attempted_at
          FROM merge_risk_explanations CROSS JOIN LATERAL jsonb_array_elements(coalesce(result->'attempts','[]'::jsonb)) AS attempt
          WHERE attempt ? 'attemptedAt'
        ) attempts WHERE attempted_at >= now() - interval '14 days' ${attemptRange.clause.replace(/^WHERE /, "AND ")} ORDER BY attempted_at DESC LIMIT 2000`,
        attemptRange.params
      ),
    ]);
    reply.header("Cache-Control", "no-store");
    return {
      routing: summarizeDecisions(routing, "routing"),
      steering: summarizeDecisions(steering, "steering"),
      mergeRisk: {
        ...summarizeMergeRisk(mergeRisk),
        explanations: (() => {
          const attempts = explanations.rows.map((row) => row.result);
          const priced = attempts.filter(
            (a) =>
              typeof a.estimatedUsd === "number" &&
              Number.isFinite(a.estimatedUsd)
          );
          return {
            attempts: attempts.length,
            knownEstimatedUsd: priced.reduce(
              (sum, a) => sum + a.estimatedUsd!,
              0
            ),
            unknownCostCalls: attempts.length - priced.length,
          };
        })(),
      },
      retentionDays: 14,
      retainedLimit: 2000,
    };
  });
}
