import type { Pool } from "pg";
import type { ClassifySteering, SteeringOutcome } from "../agents/steering.js";
import type { RoutingSettings } from "./routing-settings.js";
import { BlockStore, isBlockId } from "./store.js";
import { requestRoutingDecision, SHADOW_MODEL } from "./routing-shadow.js";
import {
  selectSteeringChoice,
  STEERING_POLICY,
  STEERING_PROMPT_VERSION,
} from "./steering-policy.js";

type Input = Parameters<ClassifySteering>[0];

/** Bounded, recipient-validated evidence. Never persist prompt text in diagnostics. */
export async function steeringEvidence(pool: Pool, input: Input) {
  const acceptedIds = [...new Set(input.activeMessageIds)];
  const ids =
    acceptedIds.length > 8
      ? [acceptedIds[0]!, ...acceptedIds.slice(-7)]
      : acceptedIds;
  if (!ids.length || ![...ids, input.messageId].every(isBlockId)) return;
  const store = new BlockStore(pool);
  const incoming = await store.getById(input.messageId);
  const active = await Promise.all(ids.map((id) => store.getById(id)));
  const authorized = (
    b: Awaited<ReturnType<BlockStore["getById"]>>,
    allowLaunch = false
  ) => {
    if (!b || b.author.kind !== "user" || b.attachments.length) return false;
    if (b.kind === "launch")
      return allowLaunch && b.toAgentId === input.agentId;
    if (b.kind !== "text") return false;
    return (
      b.data?.mentions?.length
        ? b.data.mentions
        : b.data?.recipients?.length
          ? b.data.recipients
          : [b.toAgentId]
    ).includes(input.agentId);
  };
  if (
    !authorized(incoming) ||
    !incoming ||
    !active.every((b) => authorized(b, true))
  )
    return;
  if (incoming.replyTo) {
    const parent = await store.getById(incoming.replyTo);
    if (parent?.kind === "question" || parent?.kind === "form") return;
  }
  const recent = await pool.query<{ text: string }>(
    `SELECT left(text, 1200) AS text FROM blocks WHERE stream_id=$1 AND thread_id IS NOT DISTINCT FROM $2::uuid
     AND author_kind='agent' AND author_agent_id=$3 AND origin='turn' AND kind='text'
     AND attachments='[]'::jsonb AND created_at <= $4 AND created_at >= $5 ORDER BY created_at DESC LIMIT 1`,
    [
      input.conversation.streamId,
      input.conversation.threadId,
      input.agentId,
      incoming.createdAt,
      active[0]!.createdAt,
    ]
  );
  const data = {
    current_request: active.slice(0, 1).map((b) => b!.text.slice(0, 1200)),
    accepted_followups: active.slice(1).map((b) => b!.text.slice(0, 700)),
    recent_agent_context: recent.rows[0]?.text ?? "",
    incoming_message: incoming.text.slice(0, 2000),
  };
  let serialized = JSON.stringify(data);
  while (Buffer.byteLength(serialized, "utf8") > 8192) {
    data.current_request = data.current_request.map((s) =>
      s.slice(0, Math.floor(s.length / 2))
    );
    data.accepted_followups = data.accepted_followups.map((s) =>
      s.slice(0, Math.floor(s.length / 2))
    );
    data.recent_agent_context = data.recent_agent_context.slice(
      0,
      Math.floor(data.recent_agent_context.length / 2)
    );
    data.incoming_message = data.incoming_message.slice(
      0,
      Math.floor(data.incoming_message.length / 2)
    );
    serialized = JSON.stringify(data);
  }
  return serialized;
}

export class SteeringDecisions {
  constructor(
    private readonly pool: Pool,
    private readonly settings: RoutingSettings,
    private readonly transport: typeof fetch = fetch,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  private async reserve(input: Input, cap: number) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(719394022)");
      await client.query(
        "UPDATE steering_decision_records SET status='interrupted' WHERE status='pending' AND created_at < now() - interval '10 seconds'"
      );
      await client.query(
        "INSERT INTO steering_decision_daily(day) VALUES((now() AT TIME ZONE 'UTC')::date) ON CONFLICT DO NOTHING"
      );
      const daily = await client.query<{ calls: number }>(
        "SELECT calls FROM steering_decision_daily WHERE day=(now() AT TIME ZONE 'UTC')::date"
      );
      const pending = await client.query(
        "SELECT 1 FROM steering_decision_records WHERE status='pending' LIMIT 2"
      );
      const status =
        daily.rows[0]!.calls >= cap
          ? "skipped_daily_cap"
          : pending.rowCount! >= 2
            ? "skipped_concurrency"
            : "pending";
      const record = await client.query<{ id: string }>(
        `INSERT INTO steering_decision_records(agent_id,message_id,turn_seq,status,prompt_version,result) VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          input.agentId,
          input.messageId,
          input.turnSeq,
          status,
          STEERING_PROMPT_VERSION,
          JSON.stringify({
            model: SHADOW_MODEL,
            defaultSteers: input.defaultSteers,
          }),
        ]
      );
      if (record.rowCount && status === "pending")
        await client.query(
          "UPDATE steering_decision_daily SET calls=calls+1 WHERE day=(now() AT TIME ZONE 'UTC')::date"
        );
      await client.query("COMMIT");
      return record.rows[0] && status === "pending"
        ? record.rows[0].id
        : undefined;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  classify: ClassifySteering = async (input) => {
    const config = await this.settings.configuration();
    if (!config.steeringEnabled || !config.apiKey || input.signal.aborted)
      return;
    const evidence = await steeringEvidence(this.pool, input);
    if (!evidence || input.signal.aborted || !this.settings.isCurrent(config))
      return;
    const cap = Number(this.env.DISPATCH_STEERING_DAILY_CAP ?? 25);
    const id = await this.reserve(
      input,
      Number.isInteger(cap) && cap >= 0 && cap <= 100 ? cap : 0
    );
    if (!id) return;
    // Evidence reads and the reservation lock can outlive an opt-out or key
    // removal. Recheck after the final await before handing evidence to fetch.
    if (!this.settings.isCurrent(config)) {
      await this.pool.query(
        "UPDATE steering_decision_records SET status='skipped_config_changed',result=result || $2::jsonb WHERE id=$1",
        [
          id,
          JSON.stringify({
            selected: "keep_existing_default",
            outcome: "default",
          }),
        ]
      );
      return;
    }
    const started = Date.now();
    const decision = input.signal.aborted
      ? { status: "timeout", result: {} }
      : await requestRoutingDecision(
          config.apiKey,
          evidence,
          this.transport,
          input.signal,
          2500,
          STEERING_POLICY
        );
    const result = decision.result as Record<string, unknown>;
    const choice = selectSteeringChoice(decision.status, result);
    await this.pool.query(
      "UPDATE steering_decision_records SET status=$2,result=result || $3::jsonb WHERE id=$1",
      [
        id,
        decision.status,
        JSON.stringify({
          ...result,
          selected: choice,
          decisionDelayMs: Date.now() - started,
        }),
      ]
    );
    let finished = false;
    return {
      choice,
      valid: () => this.settings.isCurrent(config) && !input.signal.aborted,
      finish: (outcome: SteeringOutcome) => {
        if (finished && outcome !== "overridden") return;
        finished = true;
        void this.pool
          .query(
            "UPDATE steering_decision_records SET result=result || $2::jsonb WHERE id=$1",
            [id, JSON.stringify({ outcome })]
          )
          .catch(() => {});
      },
    };
  };

  async prune() {
    await this.pool.query(
      "DELETE FROM steering_decision_records WHERE created_at < now() - interval '14 days' OR id IN (SELECT id FROM steering_decision_records ORDER BY created_at DESC,id DESC OFFSET 2000)"
    );
    await this.pool.query(
      "DELETE FROM steering_decision_daily WHERE day < (now() AT TIME ZONE 'UTC')::date - 2"
    );
  }
}
