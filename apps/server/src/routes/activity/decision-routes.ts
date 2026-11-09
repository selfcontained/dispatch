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
    const [routing, steering, mergeRisk] = await Promise.all([
      read("routing_shadow_records"),
      read("steering_decision_records"),
      read("merge_risk_decision_records"),
    ]);
    reply.header("Cache-Control", "no-store");
    return {
      routing: summarizeDecisions(routing, "routing"),
      steering: summarizeDecisions(steering, "steering"),
      mergeRisk: summarizeMergeRisk(mergeRisk),
      retentionDays: 14,
      retainedLimit: 2000,
    };
  });
}
