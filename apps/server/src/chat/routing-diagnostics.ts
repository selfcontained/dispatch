import type { Block, RoutingDiagnostic } from "@dispatch/shared";
import type { Queryable } from "./store.js";
import { routingCost } from "./routing-metrics.js";
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const choices = ["initiating_discussion", "home_root", "keep_existing_default"];
const probability = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
export function routingDiagnostic(row: {
  turn_id: number;
  agent_id: string;
  status: string;
  explicit_thread: boolean;
  placement: unknown;
  result: unknown;
}): RoutingDiagnostic | null {
  const r = obj(row.result);
  if (r.mode !== "active" && r.mode !== "shadow") return null;
  const status = [
    "pending",
    "ok",
    "timeout",
    "provider_error",
    "malformed",
    "refusal",
    "error",
    "interrupted",
    "skipped_daily_cap",
    "skipped_concurrency",
  ].includes(row.status)
    ? row.status
    : "error";
  const placement =
    r.mode === "active" ? obj(r.actualPlacement) : obj(row.placement);
  const actual =
    typeof placement.streamId !== "string"
      ? "Unknown"
      : typeof placement.threadId === "string"
        ? "Thread"
        : placement.threadId === null
          ? "Root"
          : "Unknown";
  const probabilities = Array.isArray(r.probabilities)
    ? r.probabilities.slice(0, 3).flatMap((p) => {
        const entry = obj(p);
        return choices.includes(String(entry.value)) &&
          probability(entry.probability)
          ? [{ value: String(entry.value), probability: entry.probability }]
          : [];
      })
    : [];
  const choice = choices.includes(String(r.choice))
    ? (r.choice as RoutingDiagnostic["choice"])
    : undefined;
  const certain =
    probabilities.some((p) => p.value === choice && p.probability >= 0.8) &&
    probability(r.confidence) &&
    r.confidence >= 0.8;
  const reason =
    status === "pending"
      ? "Decision pending"
      : status !== "ok"
        ? ({
            timeout: "Timeout fallback",
            provider_error: "Provider error fallback",
            skipped_daily_cap: "Daily limit fallback",
            skipped_concurrency: "Concurrency limit fallback",
            interrupted: "Interrupted fallback",
            refusal: "Provider refusal fallback",
            malformed: "Invalid response fallback",
          }[status] ?? "Provider error fallback")
        : r.mode === "shadow"
          ? "Shadow only; default preserved"
          : row.explicit_thread
            ? "Explicit route preserved"
            : !certain
              ? "Below threshold; default preserved"
              : choice === "keep_existing_default"
                ? "Model chose existing default"
                : r.candidate === true && actual !== "Unknown"
                  ? "Recommendation applied"
                  : "Default preserved";
  const cost = routingCost(r.usage);
  return {
    turnId: Number(row.turn_id),
    agentId: row.agent_id,
    mode: r.mode,
    status,
    actual,
    reason,
    choice,
    probabilities,
    ...(probability(r.confidence) ? { confidence: r.confidence } : {}),
    ...(typeof r.latencyMs === "number" &&
    Number.isFinite(r.latencyMs) &&
    r.latencyMs >= 0
      ? { latencyMs: r.latencyMs }
      : {}),
    ...(cost.basis !== "unknown"
      ? { inputTokens: obj(r.usage).input_tokens as number }
      : {}),
    ...(cost.basis === "cache-aware"
      ? {
          cachedReadTokens: obj(obj(r.usage).input_tokens_details)
            .cached_tokens as number,
          cacheWriteTokens: obj(obj(r.usage).input_tokens_details)
            .cache_write_tokens as number,
        }
      : {}),
    costUsd: cost.usd,
    costBasis: cost.basis,
  };
}
/** One bounded lookup for the visible page, including openers whose answer lives in a thread. */
export async function attachRoutingDiagnostics(db: Queryable, blocks: Block[]) {
  for (const b of blocks) delete b.routing;
  if (!blocks.length) return;
  const rows = await db.query<{
    block_id: string;
    turn_id: number;
    agent_id: string;
    status: string;
    explicit_thread: boolean;
    placement: unknown;
    result: unknown;
  }>(
    `SELECT b.id AS block_id, r.turn_id, r.agent_id, r.status, r.explicit_thread, r.placement, r.result
     FROM blocks b JOIN routing_shadow_records r ON
       ((b.author_kind = 'user' AND r.message_ids ? b.id::text
         AND (b.to_agent_id = r.agent_id OR b.data->'mentions' ? r.agent_id OR b.data->'recipients' ? r.agent_id))
        OR (b.author_kind = 'agent' AND b.author_agent_id = r.agent_id AND b.origin = 'turn'
            AND b.data->>'turnEventId' = r.turn_id::text))
     WHERE b.id = ANY($1::uuid[]) AND r.created_at >= now() - interval '14 days'
     ORDER BY r.turn_id LIMIT 2000`,
    [blocks.map((b) => b.id)]
  );
  const byId = new Map(blocks.map((b) => [b.id, b]));
  for (const row of rows.rows) {
    const diagnostic = routingDiagnostic(row);
    const block = byId.get(row.block_id);
    if (block && diagnostic) (block.routing ??= []).push(diagnostic);
  }
}
