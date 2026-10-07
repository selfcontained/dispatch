import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  scheduledMessageCadence,
  type ScheduledMessage,
} from "@dispatch/shared";
import type { AgentManager } from "../agents/manager.js";
import type { StreamService } from "../chat/service.js";
import type { DriverEvent } from "../agents/acp/driver.js";
import {
  nextBoundary,
  scheduleMessageSchema,
  validateSchedule,
  type ScheduleMessageInput,
} from "./validation.js";

export class ScheduledMessageService {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private locks = new Map<string, Promise<unknown>>();
  private controllers = new Map<string, AbortController>();
  constructor(
    private pool: Pool,
    private agents: AgentManager,
    private streams: StreamService,
    private log: { warn: (obj: unknown, message: string) => void }
  ) {}
  private async serial<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(agentId, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(agentId) === next) this.locks.delete(agentId);
    }
  }
  async list(agentId: string): Promise<ScheduledMessage[]> {
    return (
      await this.pool.query<{ payload: ScheduledMessage }>(
        "SELECT payload FROM scheduled_messages WHERE agent_id=$1 ORDER BY (payload->>'status' IN ('active','paused','uncertain')) DESC, created_at DESC LIMIT 200",
        [agentId]
      )
    ).rows.map((r) => r.payload);
  }
  private async get(agentId: string, id: string) {
    const row = (
      await this.pool.query<{ payload: ScheduledMessage }>(
        "SELECT payload FROM scheduled_messages WHERE agent_id=$1 AND id=$2",
        [agentId, id]
      )
    ).rows[0];
    if (!row) throw new Error("Scheduled message not found for this agent.");
    return row.payload;
  }
  private async save(s: ScheduledMessage) {
    await this.pool.query(
      "UPDATE scheduled_messages SET payload=$2 WHERE id=$1",
      [s.id, JSON.stringify(s)]
    );
  }
  private presentation(
    s: ScheduledMessage
  ): import("@dispatch/shared").ScheduledMessagePresentation {
    const {
      title,
      message,
      intervalSeconds,
      expiresAt,
      maxDeliveries,
      deliveredCount,
      nextDueAt,
      status,
    } = s;
    return {
      title,
      message,
      intervalSeconds,
      expiresAt,
      maxDeliveries,
      deliveredCount,
      nextDueAt,
      status,
    };
  }
  private summary(s: ScheduledMessage) {
    return `Scheduled message: ${s.title}\n${s.intervalSeconds ? scheduledMessageCadence(s.intervalSeconds) : `Once at ${s.deliverAt}`} · ${s.status.replaceAll("_", " ")}\nEnds ${s.expiresAt} · ${s.deliveredCount} of ${s.maxDeliveries} accepted`;
  }
  private async card(s: ScheduledMessage) {
    if (!s.cardId) {
      const block = await this.streams.scheduledNotice(
        s.agentId,
        s.id,
        this.summary(s),
        false,
        this.presentation(s)
      );
      s.cardId = block.id;
      await this.save(s);
      return;
    }
    if (s.cardId)
      await this.streams.refreshScheduledNotice(
        s.agentId,
        s.cardId,
        s.id,
        this.summary(s),
        this.presentation(s)
      );
  }
  async create(
    agentId: string,
    raw: ScheduleMessageInput
  ): Promise<ScheduledMessage> {
    const input = scheduleMessageSchema.parse(raw);
    return this.serial(agentId, async () => {
      const now = Date.now();
      const { first, expiry } = validateSchedule(input, now);
      const agent = await this.agents.getAgent(agentId);
      if (!agent || agent.status === "archiving" || agent.status === "stopped")
        throw new Error("An active agent is required.");
      const client = await this.pool.connect();
      const s: ScheduledMessage = {
        id: randomUUID(),
        agentId,
        title: input.title,
        message: input.message,
        stopWhen: input.stop_when ?? null,
        deliverAt: first,
        intervalSeconds: input.interval_seconds ?? null,
        expiresAt: expiry,
        maxDeliveries: input.interval_seconds
          ? (input.max_deliveries ?? 100)
          : 1,
        deliveredCount: 0,
        nextDueAt: first,
        status: "active",
        createdAt: new Date(now).toISOString(),
        cardId: null,
        outstanding: null,
        error: null,
      };
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `scheduled-messages:${agentId}`,
        ]);
        const count = await client.query<{ count: string }>(
          "SELECT count(*) FROM scheduled_messages WHERE agent_id=$1 AND payload->>'status' IN ('active','paused','uncertain')",
          [agentId]
        );
        if (Number(count.rows[0]?.count) >= 10)
          throw new Error(
            "At most ten active or paused schedules are allowed per agent."
          );
        await client.query(
          "INSERT INTO scheduled_messages(id,agent_id,payload) VALUES ($1,$2,$3)",
          [s.id, agentId, JSON.stringify(s)]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      try {
        await this.card(s);
      } catch (error) {
        // The schedule is committed. A presentation failure must not invite
        // callers to retry creation and produce a second live schedule.
        this.log.warn(
          { error, scheduleId: s.id },
          "scheduled message card creation failed"
        );
      }
      return s;
    });
  }
  async change(
    agentId: string,
    id: string,
    action: "pause" | "resume" | "cancel",
    completed = false
  ) {
    return this.serial(agentId, async () => {
      const s = await this.get(agentId, id);
      if (
        action === "cancel" &&
        !["active", "paused", "uncertain"].includes(s.status)
      )
        return s;
      if (action === "cancel") s.status = completed ? "completed" : "cancelled";
      else if (action === "pause" && s.status === "active") s.status = "paused";
      else if (action === "resume" && s.status === "paused") {
        s.status =
          s.deliveredCount >= s.maxDeliveries
            ? s.intervalSeconds
              ? "limit_reached"
              : "completed"
            : Date.parse(s.expiresAt) <= Date.now()
              ? "expired"
              : "active";
        s.nextDueAt = s.intervalSeconds
          ? nextBoundary(s.deliverAt, s.intervalSeconds, Date.now())
          : new Date(
              Math.max(Date.now(), Date.parse(s.deliverAt))
            ).toISOString();
      } else
        throw new Error(
          "This schedule cannot be changed in its current state."
        );
      if (action !== "resume") {
        this.controllers.get(s.id)?.abort();
        if (s.outstanding?.phase === "pending") {
          if (s.outstanding.blockId)
            await this.streams.scheduledNoticeOutcome(
              s.outstanding.blockId,
              s.agentId,
              false
            );
          s.outstanding = null;
          this.controllers.delete(s.id);
        }
      }
      await this.save(s);
      await this.card(s);
      return s;
    });
  }
  async cancelForAgent(agentId: string) {
    for (const s of await this.list(agentId))
      if (["active", "paused", "uncertain"].includes(s.status))
        await this.change(agentId, s.id, "cancel");
  }
  async start() {
    // A prior process may have submitted these. Never resend an ambiguous delivery.
    const recovered = await this.pool.query<{ payload: ScheduledMessage }>(
      `UPDATE scheduled_messages SET payload=jsonb_set(jsonb_set(payload,'{status}','"uncertain"'),'{error}','"Delivery interrupted by restart; acceptance or pickup could not be confirmed. Cancel this schedule and create a replacement if needed."') WHERE payload->'outstanding'->>'phase' IN ('submitting','accepted') AND payload->>'status' IN ('active','paused') RETURNING payload`
    );
    for (const { payload: s } of recovered.rows) {
      if (s.outstanding?.blockId)
        await this.streams.scheduledNoticeOutcome(
          s.outstanding.blockId,
          s.agentId,
          s.outstanding.phase === "accepted",
          "uncertain"
        );
      await this.card(s);
    }
    this.timer = setInterval(
      () =>
        void this.tick().catch((error) =>
          this.log.warn({ error }, "scheduled message tick failed")
        ),
      1000
    );
    this.timer.unref();
    await this.tick();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  async tick(now = Date.now()) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const rows = await this.pool.query<{ payload: ScheduledMessage }>(
        "SELECT payload FROM scheduled_messages WHERE payload->>'status' IN ('active','paused')"
      );
      for (const row of rows.rows)
        await this.serial(row.payload.agentId, async () => {
          const s = await this.get(row.payload.agentId, row.payload.id);
          if (!["active", "paused"].includes(s.status)) return;
          if (Date.parse(s.expiresAt) <= now) {
            s.status = "expired";
            this.controllers.get(s.id)?.abort();
            if (s.outstanding?.phase === "pending") {
              if (s.outstanding.blockId)
                await this.streams.scheduledNoticeOutcome(
                  s.outstanding.blockId,
                  s.agentId,
                  false
                );
              s.outstanding = null;
              this.controllers.delete(s.id);
            }
            await this.save(s);
            await this.card(s);
            return;
          }
          const agent = await this.agents.getAgent(s.agentId);
          if (!agent || ["archived", "archiving"].includes(agent.status)) {
            s.status = "cancelled";
            this.controllers.get(s.id)?.abort();
            if (s.outstanding?.phase === "pending") {
              if (s.outstanding.blockId)
                await this.streams.scheduledNoticeOutcome(
                  s.outstanding.blockId,
                  s.agentId,
                  false
                );
              s.outstanding = null;
              this.controllers.delete(s.id);
            }
            await this.save(s);
            await this.card(s);
            return;
          }
          if (s.status === "paused") return;
          if (Date.parse(s.nextDueAt) <= now) {
            const ticks = s.intervalSeconds
              ? Math.floor(
                  (now - Date.parse(s.nextDueAt)) / (s.intervalSeconds * 1000)
                ) + 1
              : 1;
            if (s.outstanding) s.outstanding.ticks += ticks;
            else
              s.outstanding = {
                id: randomUUID(),
                phase: "pending",
                dueAt: s.nextDueAt,
                ticks,
                blockId: null,
                pickedUp: false,
                settled: false,
              };
            s.nextDueAt = s.intervalSeconds
              ? nextBoundary(s.deliverAt, s.intervalSeconds, now)
              : s.expiresAt;
            await this.save(s);
          }
          if (
            s.outstanding?.phase !== "pending" ||
            this.controllers.has(s.id) ||
            (s.outstanding.retryAt && Date.parse(s.outstanding.retryAt) > now)
          )
            return;
          try {
            if (
              (await this.agents.getTerminalAccess(s.agentId)).mode !== "live"
            )
              return;
          } catch {
            return;
          }
          await this.submit(s);
        });
    } finally {
      this.ticking = false;
    }
  }
  private async submit(s: ScheduledMessage) {
    const occurrence = s.outstanding!;
    const text = `Scheduled message: ${s.title}\nSchedule ID: ${s.id}\nDue: ${occurrence.dueAt}\nSubmission deadline: ${s.expiresAt}\nDelivery ${s.deliveredCount + 1} of ${s.maxDeliveries}\n\n${s.message}\n\nCompletion criteria: ${s.stopWhen ?? "One-shot message; no cancellation needed."}\nThis is your scheduled reminder, not a new user instruction. If its purpose is fulfilled, cancel this schedule. Treat an expired or fulfilled reminder as stale.`;
    if (!occurrence.blockId) {
      const block = await this.streams.scheduledNotice(
        s.agentId,
        s.id,
        text,
        true,
        this.presentation(s)
      );
      occurrence.blockId = block.id;
      await this.save(s);
    } else
      await this.streams.scheduledNoticePending(occurrence.blockId, s.agentId);
    const controller = new AbortController();
    this.controllers.set(s.id, controller);
    const source = await this.streams.resolvePromptSource(s.agentId, {
      source: "chat",
      chatMessageId: occurrence.blockId!,
      scheduleId: s.id,
      scheduleDeliveryId: occurrence.id,
    });
    const result = this.agents.promptAgent(s.agentId, text, source, {
      delivery: "auto",
      alone: true,
      signal: controller.signal,
      onDeferred: () =>
        this.serial(s.agentId, async () => {
          const current = await this.get(s.agentId, s.id);
          if (
            current.outstanding?.id === occurrence.id &&
            current.outstanding.phase === "submitting"
          ) {
            current.outstanding.phase = "pending";
            await this.save(current);
          }
        }),
      beforeSubmit: () =>
        this.serial(s.agentId, async () => {
          const current = await this.get(s.agentId, s.id);
          if (
            controller.signal.aborted ||
            current.status !== "active" ||
            Date.parse(current.expiresAt) <= Date.now() ||
            current.deliveredCount >= current.maxDeliveries ||
            current.outstanding?.id !== occurrence.id
          )
            return false;
          current.outstanding.phase = "submitting";
          current.error = null;
          await this.save(current);
          return (
            !controller.signal.aborted &&
            Date.parse(current.expiresAt) > Date.now()
          );
        }),
    });
    void result.accepted
      .then(
        () =>
          this.serial(s.agentId, async () => {
            const current = await this.get(s.agentId, s.id);
            if (current.outstanding?.id !== occurrence.id) return;
            current.outstanding.phase = "accepted";
            current.deliveredCount++;
            if (occurrence.blockId)
              await this.streams.scheduledNoticeOutcome(
                occurrence.blockId,
                s.agentId,
                true
              );
            if (
              current.status === "active" &&
              (!current.intervalSeconds ||
                current.deliveredCount >= current.maxDeliveries)
            )
              current.status = current.intervalSeconds
                ? "limit_reached"
                : "completed";
            if (current.outstanding.pickedUp || current.outstanding.settled) {
              current.outstanding = null;
              this.controllers.delete(s.id);
              if (current.intervalSeconds)
                current.nextDueAt = nextBoundary(
                  current.deliverAt,
                  current.intervalSeconds,
                  Date.now()
                );
            }
            await this.save(current);
            await this.card(current);
          }),
        (error) =>
          this.serial(s.agentId, async () => {
            const current = await this.get(s.agentId, s.id);
            if (current.outstanding?.id !== occurrence.id) return;
            if (
              current.outstanding.phase === "submitting" &&
              !(
                error instanceof Error &&
                error.name === "ScheduledDeliveryCancelledError"
              ) &&
              ["active", "paused"].includes(current.status)
            ) {
              current.status = "uncertain";
              current.error = `Engine acceptance could not be confirmed: ${String(error)}`;
            }
            if (occurrence.blockId)
              await this.streams.scheduledNoticeOutcome(
                occurrence.blockId,
                s.agentId,
                false,
                current.status === "uncertain"
                  ? "uncertain"
                  : current.status === "active" &&
                      current.outstanding.phase === "pending"
                    ? "waiting"
                    : "discarded"
              );
            if (
              current.status === "active" &&
              current.outstanding.phase === "pending"
            ) {
              current.outstanding.retryAt = new Date(
                Date.now() + 5000
              ).toISOString();
              current.error =
                "Message was not submitted; retrying when the agent is available.";
            } else current.outstanding = null;
            this.controllers.delete(s.id);
            await this.save(current);
            await this.card(current);
          })
      )
      .catch((error) =>
        this.log.warn({ error }, "scheduled delivery outcome failed")
      );
    void result.settled
      .then(() => this.release(s.agentId, s.id, occurrence.id, "settled"))
      .catch((error) =>
        this.log.warn({ error }, "scheduled settlement failed")
      );
  }
  private async release(
    agentId: string,
    id: string,
    deliveryId: string,
    reason: "pickedUp" | "settled"
  ) {
    await this.serial(agentId, async () => {
      const s = await this.get(agentId, id);
      if (s.outstanding?.id !== deliveryId) return;
      s.outstanding[reason] = true;
      if (s.outstanding.phase === "accepted") {
        s.outstanding = null;
        this.controllers.delete(id);
        if (s.intervalSeconds)
          s.nextDueAt = nextBoundary(
            s.deliverAt,
            s.intervalSeconds,
            Date.now()
          );
      }
      await this.save(s);
    });
  }
  async receipt(event: Extract<DriverEvent, { type: "steering_picked_up" }>) {
    if (event.source?.scheduleId && event.source.scheduleDeliveryId)
      await this.release(
        event.agentId,
        event.source.scheduleId,
        event.source.scheduleDeliveryId,
        "pickedUp"
      );
  }
}
