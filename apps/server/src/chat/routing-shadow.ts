import { ROUTING_INSTRUCTIONS } from "./routing-policy.js";
import { summarizeRouting } from "./routing-metrics.js";
import type { Pool } from "pg";
import type { Block, RoutingPending } from "@dispatch/shared";
import type { PromptSource } from "../agents/acp/prompt-source.js";
import type { StreamEventRow } from "../agents/acp/stream-store.js";
import { BlockStore, isBlockId } from "./store.js";

export const SHADOW_MODEL = "gpt-6-luna";
export const SHADOW_PROMPT_VERSION = "root-first-side-threads-v3";
const CHOICES = [
  "initiating_discussion",
  "home_root",
  "keep_existing_default",
] as const;
type Choice = (typeof CHOICES)[number];
export type ShadowConfig = {
  enabled: boolean;
  mode?: "off" | "shadow" | "active";
  apiKey: string;
  dailyCap: number;
};
export function routingShadowConfig(
  env: NodeJS.ProcessEnv = process.env
): ShadowConfig {
  const cap = Number(env.DISPATCH_ROUTING_SHADOW_DAILY_CAP ?? 25);
  const explicitMode = env.DISPATCH_ROUTING_MODE;
  const mode =
    explicitMode !== undefined
      ? explicitMode === "shadow" || explicitMode === "active"
        ? explicitMode
        : "off"
      : env.DISPATCH_ROUTING_SHADOW_ENABLED === "1"
        ? "shadow"
        : "off";
  return {
    enabled: mode !== "off",
    mode,
    apiKey: env.DISPATCH_DECISIONS_API_KEY?.trim() ?? "",
    dailyCap: Number.isInteger(cap) && cap >= 0 && cap <= 100 ? cap : 0,
  };
}
export type ShadowInput = {
  agentId: string;
  turnRow: StreamEventRow;
  prompt: PromptSource;
  placement: {
    streamId: string;
    threadId: string | null;
    replyTo: string | null;
  };
};
type RoutingOutcomeDiagnostics = {
  totalRoutingDelayMs?: number;
  actualPlacement?: ShadowInput["placement"];
  outcome?: "accepted" | "default" | "timeout" | "cancelled";
  acceptedPlacement?: ShadowInput["placement"];
};
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const choice = (value: unknown): value is Choice =>
  CHOICES.includes(value as Choice);
const probability = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;

/** Whitelist fields; never retain raw provider output or error messages. */
export function parseShadowResponse(raw: unknown) {
  const response = object(raw);
  if (
    !response ||
    !Array.isArray(response.answers) ||
    response.answers.length !== 1
  )
    throw new Error("malformed");
  const answer = object(response.answers[0]);
  if (answer?.type === "refusal" || answer?.refusal) throw new Error("refusal");
  if (
    answer?.type !== "choice" ||
    answer.name !== "destination" ||
    !choice(answer.choice)
  )
    throw new Error("malformed");
  const probabilities: { value: Choice; probability: number }[] = [];
  if (answer.probabilities !== undefined) {
    if (!Array.isArray(answer.probabilities) || answer.probabilities.length > 3)
      throw new Error("malformed");
    for (const entry of answer.probabilities) {
      const p = object(entry);
      if (
        !p ||
        !choice(p.value) ||
        !probability(p.probability) ||
        probabilities.some((v) => v.value === p.value)
      )
        throw new Error("malformed");
      probabilities.push({ value: p.value, probability: p.probability });
    }
  }
  const usage: Record<string, number | Record<string, number> | boolean> = {};
  let usageInvalid = response.usage !== undefined && !object(response.usage);
  const rawUsage = object(response.usage) ?? {};
  const tokenCount = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  for (const key of ["input_tokens", "output_tokens", "total_tokens"]) {
    if (key in rawUsage && !tokenCount(rawUsage[key])) usageInvalid = true;
  }
  if ("input_tokens_details" in rawUsage) {
    const cache = object(rawUsage.input_tokens_details);
    if (
      !cache ||
      !tokenCount(cache.cached_tokens) ||
      !tokenCount(cache.cache_write_tokens)
    )
      usageInvalid = true;
  }
  for (const [key, value] of Object.entries(object(response.usage) ?? {})) {
    if (
      ["input_tokens", "output_tokens", "total_tokens"].includes(key) &&
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0
    )
      usage[key] = value;
  }
  const details = object(object(response.usage)?.input_tokens_details);
  if (details) {
    const safe: Record<string, number> = {};
    for (const key of ["cached_tokens", "cache_write_tokens"]) {
      const value = details[key];
      if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
      )
        safe[key] = value;
    }
    usage.input_tokens_details = safe;
  }
  if (usageInvalid) usage.invalid = true;
  return {
    choice: answer.choice,
    probabilities,
    ...(probability(answer.confidence)
      ? { confidence: answer.confidence }
      : {}),
    usage,
  };
}

/** Only plain user text already delivered to this agent in the initiating discussion. */
export async function shadowEvidence(pool: Pool, input: ShadowInput) {
  const source = input.prompt;
  if (source.source !== "chat" || !source.userMessage || source.awaited)
    return null;
  const ids = source.chatMessageIds ?? [source.chatMessageId];
  if (!ids.length || ids.length > 4 || !ids.every(isBlockId)) return null;
  const store = new BlockStore(pool);
  const openers = await Promise.all(ids.map((id) => store.getById(id)));
  const first = openers[0];
  const authorized = (
    b: Block | null
  ): b is Extract<Block, { kind: "text" }> & { author: { kind: "user" } } =>
    !!b &&
    b.author.kind === "user" &&
    b.kind === "text" &&
    (b.data?.mentions?.length
      ? b.data.mentions
      : b.data?.recipients?.length
        ? b.data.recipients
        : b.toAgentId
          ? [b.toAgentId]
          : []
    ).includes(input.agentId);
  if (
    !authorized(first) ||
    !openers.every(
      (b) =>
        authorized(b) &&
        b.streamId === first.streamId &&
        b.threadId === first.threadId
    )
  )
    return null;
  for (const opener of openers) {
    if (!opener?.replyTo) continue;
    const parent = await store.getById(opener.replyTo);
    // Any reply to an ask is excluded, even when answer state changed later.
    if (parent?.kind === "question" || parent?.kind === "form") return null;
  }
  const nearby = await pool.query<{
    id: string;
    text: string;
    author_kind: string;
  }>(
    `SELECT id, left(text, 500) AS text, author_kind FROM blocks
     WHERE stream_id = $1 AND thread_id IS NOT DISTINCT FROM $2::uuid
       AND kind = 'text' AND attachments = '[]'::jsonb
       AND (author_kind = 'user' OR (author_kind = 'agent' AND author_agent_id = $3 AND origin = 'turn'))
       AND (to_agent_id = $3 OR (author_kind = 'agent' AND author_agent_id = $3 AND to_agent_id IS NULL))
       AND (COALESCE(jsonb_array_length(data->'mentions'), 0) = 0 OR data->'mentions' ? $3)
       AND (COALESCE(jsonb_array_length(data->'recipients'), 0) = 0 OR data->'recipients' ? $3)
       AND created_at < $4 AND NOT (id = ANY($5::uuid[]))
       AND NOT EXISTS (SELECT 1 FROM blocks parent WHERE parent.id = blocks.reply_to AND parent.kind IN ('question', 'form'))
     ORDER BY created_at DESC, id DESC LIMIT 3`,
    [first.streamId, first.threadId, input.agentId, first.createdAt, ids]
  );
  // No attachment captions, agent/tool output, file content, or cross-stream context.
  const incoming = openers.map((b) =>
    b!.attachments.length
      ? "[message with attachments omitted]"
      : b!.text.slice(0, 1000)
  );
  let anchor: string | undefined;
  if (first.threadId) {
    const root = await store.getById(first.threadId);
    if (
      (authorized(root) ||
        (root?.kind === "text" &&
          root.author.kind === "agent" &&
          root.author.agentId === input.agentId &&
          root.origin === "turn")) &&
      root.streamId === first.streamId &&
      !root.attachments.length
    )
      anchor = root.text.slice(0, 500);
  }
  const data = {
    incoming,
    anchor,
    nearby: nearby.rows.map((r) => ({
      role: r.author_kind === "agent" ? "assistant" : "user",
      text: r.text,
    })),
    hasInitiatingDiscussion: true,
  };
  let serialized = JSON.stringify(data);
  while (Buffer.byteLength(serialized, "utf8") > 8192) {
    data.incoming = data.incoming.map((text) =>
      text.slice(0, Math.floor(text.length / 2))
    );
    data.nearby = data.nearby.map((entry) => ({
      ...entry,
      text: entry.text.slice(0, Math.floor(entry.text.length / 2)),
    }));
    data.anchor = data.anchor?.slice(0, Math.floor(data.anchor.length / 2));
    serialized = JSON.stringify(data);
  }
  return {
    messageIds: ids,
    explicitThread:
      !!first.threadId ||
      !!source.answerIn ||
      /\b(?:reply|answer|respond|post)\b.{0,35}\b(?:home root|main stream|top level|at root)\b/i.test(
        first.text
      ),
    target: {
      streamId: first.streamId,
      threadId: first.threadId ?? first.id,
      replyTo: first.id,
    },
    input: serialized,
  };
}

/** Postgres lock serializes dedupe, fleet concurrency, and UTC daily reservations. */
export class RoutingShadowStore {
  constructor(
    readonly pool: Pool,
    private readonly onChanged?: (streamId: string) => void
  ) {}
  async changed(turnId: number) {
    if (!this.onChanged) return;
    const streams = await this.pool.query<{ stream_id: string }>(
      `WITH record AS (SELECT message_ids, placement, result FROM routing_shadow_records WHERE turn_id = $1 AND turn_id > 0)
       SELECT DISTINCT stream_id FROM (
         SELECT b.stream_id FROM record r CROSS JOIN LATERAL jsonb_array_elements_text(r.message_ids) m(id)
           JOIN blocks b ON b.id = m.id::uuid
         UNION ALL
         SELECT COALESCE(result->'actualPlacement'->>'streamId', placement->>'streamId') FROM record
       ) affected WHERE stream_id IS NOT NULL`,
      [turnId]
    );
    for (const row of streams.rows) this.onChanged(row.stream_id);
  }
  async prune() {
    await this.pool.query(
      "UPDATE routing_shadow_records SET status = 'interrupted' WHERE status = 'pending' AND created_at < now() - interval '10 seconds'"
    );
    await this.pool
      .query(`DELETE FROM routing_shadow_records WHERE created_at < now() - interval '14 days'
      OR turn_id IN (SELECT turn_id FROM routing_shadow_records ORDER BY created_at DESC, turn_id DESC OFFSET 2000)`);
    await this.pool.query(
      `DELETE FROM routing_shadow_daily WHERE day < (now() AT TIME ZONE 'UTC')::date - 2`
    );
  }
  async reserve(
    input: ShadowInput,
    evidence: { messageIds: string[]; explicitThread: boolean },
    cap: number,
    mode: string = "shadow"
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(719394021)");
      const marker = await client.query(
        `UPDATE agent_stream_events SET routing_shadow_observed = true WHERE id = $1 AND NOT routing_shadow_observed RETURNING id`,
        [input.turnRow.id]
      );
      if (input.turnRow.id > 0 && !marker.rowCount) {
        await client.query("COMMIT");
        return null;
      }
      await client.query(
        `INSERT INTO routing_shadow_daily(day) VALUES ((now() AT TIME ZONE 'UTC')::date) ON CONFLICT DO NOTHING`
      );
      const calls = await client.query<{ calls: number }>(
        `SELECT calls FROM routing_shadow_daily WHERE day = (now() AT TIME ZONE 'UTC')::date`
      );
      const active = await client.query(
        `SELECT 1 FROM routing_shadow_records WHERE status = 'pending' AND created_at > now() - interval '10 seconds' LIMIT 2`
      );
      const status =
        calls.rows[0]!.calls >= cap
          ? "skipped_daily_cap"
          : active.rowCount! >= 2
            ? "skipped_concurrency"
            : "pending";
      await client.query(
        `INSERT INTO routing_shadow_records(turn_id,agent_id,message_ids,placement,explicit_thread,status,model,prompt_version,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          input.turnRow.id,
          input.agentId,
          JSON.stringify(evidence.messageIds),
          JSON.stringify(input.placement),
          evidence.explicitThread,
          status,
          SHADOW_MODEL,
          SHADOW_PROMPT_VERSION,
          JSON.stringify({ mode }),
        ]
      );
      if (status === "pending")
        await client.query(
          `UPDATE routing_shadow_daily SET calls = calls + 1 WHERE day = (now() AT TIME ZONE 'UTC')::date`
        );
      await client.query("COMMIT");
      return status;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async finish(turnId: number, status: string, result: unknown) {
    await this.pool.query(
      `UPDATE routing_shadow_records SET status = CASE WHEN result->>'outcome' IN ('timeout', 'cancelled') OR $3::jsonb->>'outcome' IN ('timeout', 'cancelled') THEN 'timeout' ELSE $2 END, result = $3::jsonb || result WHERE turn_id = $1`,
      [turnId, status, JSON.stringify(result)]
    );
    void this.changed(turnId).catch(() => {});
  }
  async summary() {
    const records = await this.pool.query<{ status: string; result: unknown }>(
      "SELECT status,result FROM routing_shadow_records WHERE created_at >= now() - interval '14 days' ORDER BY created_at DESC LIMIT 2000"
    );
    const calls = await this.pool.query<{ calls: number }>(
      "SELECT calls FROM routing_shadow_daily WHERE day = (now() AT TIME ZONE 'UTC')::date"
    );
    return {
      ...summarizeRouting(records.rows),
      todayReservations: calls.rows[0]?.calls ?? 0,
    };
  }
  async read(before?: number) {
    await this.prune();
    const rows = await this.pool.query(
      `SELECT * FROM routing_shadow_records WHERE ($1::bigint IS NULL OR turn_id < $1) ORDER BY turn_id DESC LIMIT 200`,
      [before ?? null]
    );
    return rows.rows;
  }
}

export async function requestRoutingDecision(
  apiKey: string,
  evidence: string,
  transport: typeof fetch = fetch,
  signal?: AbortSignal,
  timeoutMs = 3000
) {
  const started = Date.now();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  let status = "error";
  let result: Record<string, unknown> = {};
  try {
    const response = await transport("https://api.openai.com/v1/decisions", {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: SHADOW_MODEL,
        input: evidence,
        questions: [
          {
            type: "choice",
            name: "destination",
            instructions: ROUTING_INSTRUCTIONS,
            choices: [
              {
                value: "initiating_discussion",
                description:
                  "Answer a narrow contained side question in the initiating discussion.",
              },
              {
                value: "home_root",
                description:
                  "Answer the primary task conversation at the agent home root (default).",
              },
              {
                value: "keep_existing_default",
                description:
                  "Keep the existing destination; uncertain or insufficient evidence.",
              },
            ],
          },
        ],
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      status = "provider_error";
      result = { httpStatus: response.status };
    } else {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("malformed");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 16384) throw new Error("malformed");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      result = parseShadowResponse(
        JSON.parse(Buffer.concat(chunks).toString("utf8"))
      );
      status = "ok";
    }
  } catch (error) {
    status = controller.signal.aborted
      ? "timeout"
      : error instanceof Error &&
          ["malformed", "refusal"].includes(error.message)
        ? error.message
        : "error";
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
  return { status, result: { ...result, latencyMs: Date.now() - started } };
}

export class RoutingShadow {
  // Retained only while startup work can still finish after its deadline.
  private readonly activeDiagnostics = new Map<
    number,
    RoutingOutcomeDiagnostics
  >();
  private readonly controllers = new Map<
    number,
    { agentId: string; controller: AbortController }
  >();
  cancel(agentId: string, turnId?: number) {
    for (const [id, entry] of this.controllers)
      if (
        entry.agentId === agentId &&
        (turnId === undefined || id === turnId)
      ) {
        entry.controller.abort("cancelled");
        const pending = this.pendingTurns.get(id);
        this.pendingTurns.delete(id);
        if (pending) this.notifyPending(pending.streamId);
      }
  }
  private readonly pendingTurns = new Map<number, RoutingPending>();
  private notifyPending(streamId: string) {
    try {
      this.onPending?.(streamId, this.pending(streamId));
    } catch {
      /* Optional UI evidence cannot affect routing. */
    }
  }
  cancelAll() {
    for (const { controller } of this.controllers.values())
      controller.abort("cancelled");
    const streams = new Set(
      [...this.pendingTurns.values()].map((p) => p.streamId)
    );
    this.pendingTurns.clear();
    for (const streamId of streams) this.notifyPending(streamId);
  }
  pending(streamId: string) {
    return [...this.pendingTurns.values()].filter(
      (p) => p.streamId === streamId
    );
  }
  constructor(
    private readonly config: ShadowConfig | (() => Promise<ShadowConfig>),
    private readonly store: RoutingShadowStore,
    private readonly transport: typeof fetch = fetch,
    private readonly timeoutMs = 3000,
    private readonly onPending?: (
      streamId: string,
      pending: RoutingPending[]
    ) => void
  ) {}
  private async configuration() {
    return typeof this.config === "function" ? this.config() : this.config;
  }
  observe(input: ShadowInput): void {
    void this.route(input).catch(() => {});
  }
  /** Total active deadline includes configuration, evidence, reservation, provider and persistence. */
  async route(
    input: ShadowInput
  ): Promise<ShadowInput["placement"] | undefined> {
    const routeStarted = Date.now();
    const diagnostics: RoutingOutcomeDiagnostics = {};
    this.activeDiagnostics.set(input.turnRow.id, diagnostics);
    const controller = new AbortController();
    this.controllers.set(input.turnRow.id, {
      agentId: input.agentId,
      controller,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(undefined), {
        once: true,
      });
      timer = setTimeout(() => {
        controller.abort("timeout");
        resolve(undefined);
      }, this.timeoutMs);
    });
    const task = (async () => {
      const config = await this.configuration();
      if (controller.signal.aborted || !config.enabled || !config.apiKey)
        return;
      if (config.mode !== "active") {
        void this.run(input, config).catch(() => {});
        return;
      }
      return this.run(
        input,
        config,
        controller.signal,
        diagnostics,
        routeStarted
      );
    })()
      .catch(() => undefined)
      .finally(() => {
        this.activeDiagnostics.delete(input.turnRow.id);
      });
    try {
      const selected = await Promise.race([task, deadline]);
      // Only the race winner is accepted; a provider candidate may finish persisting later.
      diagnostics.outcome = selected
        ? "accepted"
        : controller.signal.aborted
          ? controller.signal.reason === "cancelled"
            ? "cancelled"
            : "timeout"
          : "default";
      if (selected) diagnostics.acceptedPlacement = selected;
      return selected;
    } finally {
      clearTimeout(timer);
      const pending = this.pendingTurns.get(input.turnRow.id);
      this.pendingTurns.delete(input.turnRow.id);
      if (pending) this.notifyPending(pending.streamId);
      this.controllers.delete(input.turnRow.id);
      diagnostics.totalRoutingDelayMs = Date.now() - routeStarted;
      void this.store.pool
        .query(
          "UPDATE routing_shadow_records SET status = CASE WHEN $2::jsonb->>'outcome' IN ('timeout', 'cancelled') THEN 'timeout' ELSE status END, result = result || $2::jsonb WHERE turn_id = $1 AND result->>'mode' = 'active'",
          [
            input.turnRow.id,
            JSON.stringify({
              totalRoutingDelayMs: diagnostics.totalRoutingDelayMs,
              outcome: diagnostics.outcome,
              ...(diagnostics.acceptedPlacement
                ? { acceptedPlacement: diagnostics.acceptedPlacement }
                : {}),
            }),
          ]
        )
        .then(() => this.store.changed(input.turnRow.id))
        .catch(() => {});
    }
  }
  private async run(
    input: ShadowInput,
    config: ShadowConfig,
    signal?: AbortSignal,
    diagnostics: RoutingOutcomeDiagnostics = {},
    routeStarted = Date.now()
  ): Promise<ShadowInput["placement"] | undefined> {
    const evidence = await shadowEvidence(this.store.pool, input);
    if (!evidence || signal?.aborted) return;
    if (config.mode === "active") {
      const conversation = input.prompt.conversation ?? input.placement;
      this.pendingTurns.set(input.turnRow.id, {
        turnId: input.turnRow.id,
        agentId: input.agentId,
        messageIds: evidence.messageIds,
        startedAt: routeStarted,
        deadlineAt: routeStarted + this.timeoutMs,
        streamId: conversation.streamId,
        threadId: conversation.threadId,
      });
      this.notifyPending(conversation.streamId);
    }
    await this.store.prune();
    if (signal?.aborted) return;
    const reservation = await this.store.reserve(
      input,
      evidence,
      config.dailyCap,
      config.mode ?? "shadow"
    );
    if (reservation !== "pending") return;
    if (signal?.aborted) {
      await this.store.finish(input.turnRow.id, "timeout", {
        mode: config.mode ?? "shadow",
        ...diagnostics,
      });
      return;
    }
    const decision = await requestRoutingDecision(
      config.apiKey,
      evidence.input,
      this.transport,
      signal,
      this.timeoutMs
    );
    let selected: ShadowInput["placement"] | undefined;
    const result = decision.result as Record<string, unknown>;
    const probabilities = result.probabilities as
      | { value: string; probability: number }[]
      | undefined;
    const certain =
      probabilities?.some(
        (p) => p.value === result.choice && p.probability >= 0.8
      ) &&
      typeof result.confidence === "number" &&
      result.confidence >= 0.8;
    if (
      config.mode === "active" &&
      !signal?.aborted &&
      decision.status === "ok" &&
      !evidence.explicitThread &&
      certain
    ) {
      if (result.choice === "initiating_discussion") selected = evidence.target;
      if (result.choice === "home_root")
        selected = { streamId: input.agentId, threadId: null, replyTo: null };
    }
    await this.store.finish(
      input.turnRow.id,
      signal?.aborted ? "timeout" : decision.status,
      {
        ...result,
        mode: config.mode ?? "shadow",
        candidate: !!selected && !signal?.aborted,
        applied: false,
        ...diagnostics,
      }
    );
    return signal?.aborted ? undefined : selected;
  }
  frozen(turnId: number, placement: ShadowInput["placement"]) {
    const diagnostics = this.activeDiagnostics.get(turnId);
    if (diagnostics) diagnostics.actualPlacement = placement;
    void this.store.pool
      .query(
        "UPDATE routing_shadow_records SET result = result || jsonb_build_object('actualPlacement', $2::jsonb, 'applied', placement <> $2::jsonb) WHERE turn_id = $1 AND result->>'mode' = 'active'",
        [turnId, JSON.stringify(placement)]
      )
      .then(() => this.store.changed(turnId))
      .catch(() => {});
  }
  /** Explicit Settings button; synthetic data only, including when mode is off. */
  async checkConnection() {
    const config = await this.configuration();
    if (!config.apiKey) return { status: "unconfigured" };
    const id = -Number(
      (
        await this.store.pool.query(
          "SELECT nextval('routing_shadow_synthetic_ids') AS id"
        )
      ).rows[0].id
    );
    const input = {
      agentId: "synthetic_connection_check",
      turnRow: { id },
      placement: { streamId: "synthetic", threadId: null, replyTo: null },
    } as ShadowInput;
    await this.store.prune();
    const reservation = await this.store.reserve(
      input,
      { messageIds: [], explicitThread: false },
      config.dailyCap,
      "connection_check"
    );
    if (reservation !== "pending") return { status: reservation };
    const decision = await requestRoutingDecision(
      config.apiKey,
      JSON.stringify({
        incoming: ["Why did you choose that approach?"],
        anchor: "Please explain the implementation.",
        nearby: ["I chose it to reduce complexity."],
        hasInitiatingDiscussion: true,
      }),
      this.transport,
      undefined,
      this.timeoutMs
    );
    await this.store.finish(id, decision.status, {
      ...decision.result,
      mode: "connection_check",
    });
    return decision;
  }
}
