import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  BlockExternalOrigin,
  BlockFormData,
  BlockQuestionData,
  StreamAnswerResponse,
  StreamPostResponse,
} from "@dispatch/shared";
import type { SlackApp, SlackBinding, SlackInbound } from "./slack-app.js";
import {
  ACTION,
  FORM_CALLBACK,
  FREEFORM_CALLBACK,
  clip,
  formMessage,
  formModal,
  freeformModal,
  parseFormSubmission,
  plain,
  questionMessage,
  settledMessage,
  deliveryPhrase,
  type AskContext,
  type DeliveryShown,
} from "./slack-blocks.js";
import type {
  AnswerInput,
  SubmitInput,
  UserPostInput,
} from "../chat/service.js";

/** The existing Dispatch write paths; Slack never gets a parallel one. */
export type AnswerWriter = {
  answerQuestion(
    streamId: string,
    blockId: string,
    input: AnswerInput
  ): Promise<StreamAnswerResponse>;
  submitForm(
    streamId: string,
    blockId: string,
    input: SubmitInput
  ): Promise<StreamAnswerResponse>;
  sendUserPost(
    streamId: string,
    input: UserPostInput
  ): Promise<StreamPostResponse>;
};

export type AskAlert = {
  block_id: string;
  binding_generation: string;
  agent_id: string;
  stream_id: string;
  thread_id: string | null;
  text: string;
  kind?: string;
  data: unknown;
  name: string;
};

type MessageRow = {
  id: string;
  binding_generation: string;
  channel_id: string;
  message_ts: string;
  kind: "question" | "form" | "notify" | "link";
  agent_id: string | null;
  stream_id: string | null;
  thread_id: string | null;
  block_id: string | null;
  data_hash: string | null;
};
type AskRow = {
  id: string;
  kind: string;
  stream_id: string;
  thread_id: string | null;
  text: string;
  data: Record<string, any> | null;
  state: Record<string, any> | null;
  author_agent_id: string | null;
  to_agent_id: string | null;
};
export type SlackAnswerer = {
  id: string;
  /** Immutable Slack user id; the handle is user-chosen and can change. */
  userId: string;
  displayName: string;
  status: "pending" | "allowed";
  createdAt: string;
  allowedAt: string | null;
};

const LINK_ACTION = "dispatch_link";
const LINK_TTL_MINUTES = 10;

/** A UUID derived from a key, so Slack redeliveries/double clicks reuse one block id. */
export function stableUuid(key: string) {
  const h = createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function askHash(text: string, data: unknown) {
  return createHash("sha256")
    .update(JSON.stringify([text ?? "", data ?? null]))
    .digest("hex");
}
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

/** Slack escapes &, <, > in message text; keep the person's words otherwise verbatim. */
export function slackTextToPlain(text: string) {
  return text
    .replace(/<([^<>|]+)\|([^<>]+)>/g, "$2")
    .replace(/<([^<>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Tell the person who already answered that it counted; others that theirs didn't. */
function settledReason(
  state: AskRow["state"],
  origin: BlockExternalOrigin | null
) {
  if (state?.cancellation)
    return "This was withdrawn — your input was not recorded.";
  const by = (state?.answer ?? state?.submission)?.external;
  if (origin && by?.userId === origin.userId && by?.teamId === origin.teamId)
    return "Already recorded your answer — nothing more to do.";
  return "Already answered — your input was not recorded.";
}

const shownDelivery = (delivered: boolean | null | undefined): DeliveryShown =>
  delivered === true
    ? "delivered"
    : delivered === false
      ? "not_delivered"
      : "sending";

const isOpen = (state: AskRow["state"]) =>
  !state?.answer && !state?.submission && !state?.cancellation;

function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/already answered|already submitted|block with that id/i.test(message))
    return "Already answered — your input was not recorded.";
  if (/canceled|cancelled/i.test(message))
    return "This was withdrawn — your input was not recorded.";
  if (/required|must|does not match|number/i.test(message))
    return `Not recorded: ${clip(message, 300)}`;
  return "Dispatch couldn't record that. Open Dispatch to answer.";
}

export class SlackAnswers {
  private timer?: ReturnType<typeof setInterval>;
  private reconciling = false;
  constructor(
    private pool: Pool,
    private app: SlackApp,
    private writer: () => AnswerWriter,
    private agentName: (agentId: string) => Promise<string | null>
  ) {}

  start() {
    this.app.setInboundHandler(
      (inbound) => this.handle(inbound),
      () => void this.reconcile().catch(() => {})
    );
    this.timer = setInterval(() => {
      void this.reconcile().catch(() => {});
    }, 15000);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
  }

  // ── outbound ─────────────────────────────────────────────

  openUrl(
    baseUrl: string,
    alert: Pick<AskAlert, "block_id" | "thread_id" | "stream_id" | "agent_id">
  ) {
    const params = new URLSearchParams({ block: alert.block_id });
    if (alert.thread_id) params.set("thread", alert.thread_id);
    if (alert.stream_id.startsWith("tsk_")) params.set("task", alert.stream_id);
    const agent = alert.stream_id.startsWith("tsk_")
      ? alert.agent_id
      : alert.stream_id;
    return `${baseUrl}/agents/${encodeURIComponent(agent)}?${params}`;
  }

  private context(
    binding: SlackBinding,
    row: {
      block_id: string;
      thread_id: string | null;
      stream_id: string;
      agent_id: string;
    },
    name: string,
    text: string,
    ref: string,
    headline?: string
  ): AskContext {
    return {
      ref,
      agentName: name,
      context: row.stream_id.startsWith("tsk_")
        ? `Task ${row.stream_id}`
        : undefined,
      text,
      openUrl: this.openUrl(binding.baseUrl, row),
      ...(headline ? { headline } : {}),
    };
  }

  /** The delayed question/form alert, now as interactive Block Kit. */
  async postAsk(alert: AskAlert) {
    const binding = await this.app.currentBinding();
    if (!binding || binding.generation !== alert.binding_generation)
      return false;
    const ref = randomUUID();
    const kind = alert.kind === "form" ? "form" : "question";
    const data = (alert.data ?? {}) as Record<string, any>;
    const ctx = this.context(
      binding,
      alert,
      alert.name || alert.agent_id,
      alert.text,
      ref,
      "unanswered for 5 minutes"
    );
    const message =
      kind === "form"
        ? formMessage(data as BlockFormData, ctx)
        : questionMessage(data as BlockQuestionData, ctx);
    const sent = await this.app.postBlocks(message, alert.binding_generation);
    await this.pool.query(
      `INSERT INTO slack_messages(id,binding_generation,channel_id,message_ts,kind,agent_id,stream_id,thread_id,block_id,data_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [
        ref,
        sent.generation,
        sent.channelId,
        sent.timestamp,
        kind,
        alert.agent_id,
        alert.stream_id,
        alert.thread_id,
        alert.block_id,
        askHash(alert.text, alert.data),
      ]
    );
    return sent;
  }

  /** Record a notify message so thread replies reach that agent's home. */
  async recordNotify(
    sent: { channelId: string; timestamp: string; generation: string },
    agentId: string
  ) {
    await this.pool.query(
      `INSERT INTO slack_messages(id,binding_generation,channel_id,message_ts,kind,agent_id,stream_id)
       VALUES ($1,$2,$3,$4,'notify',$5,$5) ON CONFLICT DO NOTHING`,
      [randomUUID(), sent.generation, sent.channelId, sent.timestamp, agentId]
    );
  }

  // ── answerer binding ─────────────────────────────────────

  async createLink() {
    const binding = await this.app.currentBinding();
    if (!binding) throw new Error("Connect Slack first.");
    const nonce = randomBytes(24).toString("base64url");
    await this.pool.query(
      `INSERT INTO slack_link_claims(nonce_hash,binding_generation,expires_at)
       VALUES ($1,$2,now() + ($3 * interval '1 minute'))`,
      [sha(nonce), binding.generation, LINK_TTL_MINUTES]
    );
    const text = `Link a Slack account to answer Dispatch questions here. Expires in ${LINK_TTL_MINUTES} minutes; the Dispatch owner must then allow it in Settings.`;
    const sent = await this.app.postBlocks(
      {
        text,
        blocks: [
          { type: "section", text: plain(text, 3000) },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                action_id: LINK_ACTION,
                text: plain("Link my account", 75),
                value: nonce,
              },
            ],
          },
        ],
      },
      binding.generation
    );
    await this.pool.query(
      `INSERT INTO slack_messages(id,binding_generation,channel_id,message_ts,kind)
       VALUES ($1,$2,$3,$4,'link')`,
      [randomUUID(), sent.generation, sent.channelId, sent.timestamp]
    );
    return { expiresInMinutes: LINK_TTL_MINUTES };
  }

  async answerers(): Promise<SlackAnswerer[]> {
    const binding = await this.app.currentBinding();
    if (!binding) return [];
    const { rows } = await this.pool.query(
      `SELECT id, user_id, display_name, status, created_at, allowed_at FROM slack_answerers
       WHERE binding_generation=$1 AND team_id=$2 ORDER BY created_at`,
      [binding.generation, binding.teamId]
    );
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      displayName: r.display_name,
      status: r.status,
      createdAt: new Date(r.created_at).toISOString(),
      allowedAt: r.allowed_at ? new Date(r.allowed_at).toISOString() : null,
    }));
  }
  async allow(id: string) {
    const binding = await this.app.currentBinding();
    if (!binding) throw new Error("Connect Slack first.");
    const { rowCount } = await this.pool.query(
      `UPDATE slack_answerers SET status='allowed', allowed_at=now()
       WHERE id::text=$1 AND binding_generation=$2 AND status='pending'`,
      [id, binding.generation]
    );
    if (!rowCount) throw new Error("That link request is no longer pending.");
  }
  async revoke(id: string) {
    await this.pool.query(`DELETE FROM slack_answerers WHERE id::text=$1`, [
      id,
    ]);
  }

  private async answerer(binding: SlackBinding, userId: unknown) {
    if (typeof userId !== "string") return null;
    const { rows } = await this.pool.query(
      `SELECT display_name FROM slack_answerers
       WHERE binding_generation=$1 AND team_id=$2 AND user_id=$3 AND status='allowed'`,
      [binding.generation, binding.teamId, userId]
    );
    if (!rows[0]) return null;
    const origin: BlockExternalOrigin = {
      source: "slack",
      teamId: binding.teamId,
      userId,
      displayName: rows[0].display_name,
    };
    return origin;
  }

  // ── inbound ──────────────────────────────────────────────

  async handle(inbound: SlackInbound): Promise<Record<string, unknown> | void> {
    const { payload, binding } = inbound;
    if (inbound.type === "events_api") return this.onEvent(inbound);
    if (payload.type === "block_actions")
      return this.onAction(binding, payload);
    if (payload.type === "view_submission")
      return this.onSubmit(binding, payload);
  }

  private async once(key: string) {
    const { rowCount } = await this.pool.query(
      `INSERT INTO slack_inbound(key) VALUES ($1) ON CONFLICT DO NOTHING`,
      [key]
    );
    return rowCount === 1;
  }

  private async row(binding: SlackBinding, ref: unknown) {
    if (typeof ref !== "string" || !/^[0-9a-f-]{36}$/i.test(ref)) return null;
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT * FROM slack_messages WHERE id=$1 AND binding_generation=$2 AND channel_id=$3`,
      [ref, binding.generation, binding.channelId]
    );
    return rows[0] ?? null;
  }
  private async ask(blockId: string) {
    const { rows } = await this.pool.query<AskRow>(
      `SELECT id, kind, stream_id, thread_id, text, data, state, author_agent_id, to_agent_id
       FROM blocks WHERE id=$1`,
      [blockId]
    );
    return rows[0] ?? null;
  }

  /** Every write-time check, against the stored original. */
  private async resolve(
    binding: SlackBinding,
    ref: unknown,
    userId: unknown,
    kind: "question" | "form"
  ): Promise<
    | { ok: true; row: MessageRow; ask: AskRow; origin: BlockExternalOrigin }
    | { ok: false; reason: string }
  > {
    const origin = await this.answerer(binding, userId);
    if (!origin)
      return {
        ok: false,
        reason:
          "You're not linked to answer for this Dispatch. Ask its owner to link you in Settings.",
      };
    const row = await this.row(binding, ref);
    if (!row || row.kind !== kind || !row.block_id)
      return {
        ok: false,
        reason: "This message is no longer linked to Dispatch.",
      };
    const ask = await this.ask(row.block_id);
    if (!ask || ask.kind !== kind || ask.author_agent_id !== row.agent_id)
      return {
        ok: false,
        reason: "This question no longer exists in Dispatch.",
      };
    if (!isOpen(ask.state))
      return { ok: false, reason: settledReason(ask.state, origin) };
    if (row.data_hash && row.data_hash !== askHash(ask.text, ask.data))
      return {
        ok: false,
        reason:
          "This question changed since it was sent. Open Dispatch to answer.",
      };
    if (ask.data?.parentHandled || ask.to_agent_id)
      return {
        ok: false,
        reason: "This is handled by another agent. Open Dispatch to see it.",
      };
    return { ok: true, row, ask, origin };
  }

  /** A write lost a race: if this same person's answer won, say so. */
  private async failureText(
    error: unknown,
    askId: string,
    origin: BlockExternalOrigin
  ) {
    const now = await this.ask(askId).catch(() => null);
    if (now && !isOpen(now.state)) return settledReason(now.state, origin);
    return errorText(error);
  }

  private deliveryText(name: string, delivered: boolean | null) {
    return deliveryPhrase(name, shownDelivery(delivered));
  }

  private async onAction(binding: SlackBinding, payload: Record<string, any>) {
    const action = payload.actions?.[0];
    const userId = payload.user?.id;
    if (!action || typeof userId !== "string") return;
    const actionId: string = String(action.action_id ?? "");
    const threadTs = payload.container?.message_ts;
    const reply = (text: string) =>
      this.app.postEphemeral(userId, text).catch(() => {});

    if (actionId === ACTION.open) return;
    if (actionId === LINK_ACTION)
      return this.onLinkClick(binding, payload, action.value, threadTs);

    const [ref, index] = String(action.value ?? "").split(":");
    const kind = actionId === ACTION.form ? "form" : "question";
    const resolved = await this.resolve(binding, ref, userId, kind);
    if (!resolved.ok) return reply(resolved.reason);
    const { row, ask, origin } = resolved;
    // The click must come from the very message this ref was posted as.
    if (payload.container?.message_ts !== row.message_ts)
      return reply("This message is no longer linked to Dispatch.");
    const name = (await this.agentName(row.agent_id!)) ?? row.agent_id!;

    if (actionId === ACTION.freeform || actionId === ACTION.form) {
      if (actionId === ACTION.freeform && !ask.data?.allowFreeform)
        return reply("This question takes one of the listed options.");
      const view =
        actionId === ACTION.form
          ? formModal(ask.data as BlockFormData, row.id, `${name} asks`)
          : freeformModal(row.id, ask.text || "Answer");
      if (!view)
        return reply("Slack can't show this form. Open Dispatch to answer.");
      if (typeof payload.trigger_id !== "string") return;
      await this.app
        .openView(payload.trigger_id, view)
        .catch(() =>
          reply("Slack couldn't open the form. Open Dispatch to answer.")
        );
      return;
    }

    if (!actionId.startsWith(`${ACTION.option}:`)) return;
    // Opaque value → stored option; the action id must agree with it.
    if (!/^\d+$/.test(index ?? "") || actionId !== `${ACTION.option}:${index}`)
      return reply("That choice isn't valid for this question.");
    const option = (ask.data as BlockQuestionData).options?.[Number(index)];
    if (!option) return reply("That choice isn't valid for this question.");
    try {
      const result = await this.writer().answerQuestion(ask.stream_id, ask.id, {
        id: stableUuid(`slack-answer:${row.id}`),
        value: option.value ?? option.label,
        external: origin,
      });
      await reply(
        `Recorded "${option.label}" · ${this.deliveryText(name, result.delivered)}.`
      );
    } catch (error) {
      await reply(await this.failureText(error, ask.id, origin));
    }
    await this.reconcile().catch(() => {});
  }

  private async onSubmit(binding: SlackBinding, payload: Record<string, any>) {
    const view = payload.view ?? {};
    const userId = payload.user?.id;
    const callback = view.callback_id;
    if (callback !== FREEFORM_CALLBACK && callback !== FORM_CALLBACK) return;
    const kind = callback === FORM_CALLBACK ? "form" : "question";
    const resolved = await this.resolve(
      binding,
      view.private_metadata,
      userId,
      kind
    );
    const errorsFor = (message: string) => ({
      response_action: "errors",
      errors: { [kind === "form" ? "f0" : "answer"]: clip(message, 150) },
    });
    if (!resolved.ok) {
      // Modal stays open with the reason; nothing recorded.
      if (kind === "question") return errorsFor(resolved.reason);
      return {
        response_action: "update",
        view: {
          type: "modal",
          title: plain("Not recorded", 24),
          close: plain("Close", 24),
          blocks: [{ type: "section", text: plain(resolved.reason, 3000) }],
        },
      };
    }
    const { row, ask, origin } = resolved;
    const name = (await this.agentName(row.agent_id!)) ?? row.agent_id!;
    const state = (view.state?.values ?? {}) as Record<string, any>;
    try {
      let result: StreamAnswerResponse;
      if (kind === "form") {
        const parsed = parseFormSubmission(ask.data as BlockFormData, state);
        if ("errors" in parsed)
          return { response_action: "errors", errors: parsed.errors };
        result = await this.writer().submitForm(ask.stream_id, ask.id, {
          id: stableUuid(`slack-answer:${row.id}`),
          values: parsed.values,
          external: origin,
        });
      } else {
        const value = String(state.answer?.value?.value ?? "").trim();
        if (!value) return errorsFor("Type an answer.");
        result = await this.writer().answerQuestion(ask.stream_id, ask.id, {
          id: stableUuid(`slack-answer:${row.id}`),
          value,
          external: origin,
        });
      }
      void this.app
        .postEphemeral(
          userId,
          `Recorded your ${kind === "form" ? "form" : "answer"} · ${this.deliveryText(name, result.delivered)}.`
        )
        .catch(() => {});
      void this.reconcile().catch(() => {});
    } catch (error) {
      return errorsFor(await this.failureText(error, ask.id, origin));
    }
  }

  private async onLinkClick(
    binding: SlackBinding,
    payload: Record<string, any>,
    nonce: unknown,
    messageTs: unknown
  ) {
    const user = payload.user ?? {};
    if (typeof nonce !== "string" || typeof user.id !== "string") return;
    // Only members of the bound workspace may claim (no Slack Connect
    // guests); a rejected click doesn't consume the one-time link.
    if (typeof user.team_id === "string" && user.team_id !== binding.teamId) {
      await this.app
        .postEphemeral(
          user.id,
          `Only members of ${binding.teamName} can link an account to this Dispatch.`
        )
        .catch(() => {});
      return;
    }
    const claimed = await this.pool.query(
      `UPDATE slack_link_claims SET used_at=now()
       WHERE nonce_hash=$1 AND binding_generation=$2 AND used_at IS NULL AND expires_at>now()`,
      [sha(nonce), binding.generation]
    );
    if (!claimed.rowCount) {
      await this.app
        .postEphemeral(
          user.id,
          "This link expired or was already used. Ask the Dispatch owner for a new one."
        )
        .catch(() => {});
      return;
    }
    const handle = String(user.username || user.name || "Slack user").slice(
      0,
      80
    );
    const displayName = `@${handle.replace(/^@/, "")}`;
    // An allowed identity's label never changes without a fresh Allow.
    const stored = await this.pool.query(
      `INSERT INTO slack_answerers(id,binding_generation,team_id,user_id,display_name,status)
       VALUES ($1,$2,$3,$4,$5,'pending')
       ON CONFLICT (binding_generation,team_id,user_id) DO UPDATE SET display_name=EXCLUDED.display_name
       WHERE slack_answerers.status='pending'`,
      [randomUUID(), binding.generation, binding.teamId, user.id, displayName]
    );
    if (!stored.rowCount) {
      await this.app
        .postEphemeral(
          user.id,
          "You're already linked to answer for this Dispatch."
        )
        .catch(() => {});
      return;
    }
    const text = `Link request from ${displayName} received. It takes effect only after the Dispatch owner allows it in Settings.`;
    if (typeof messageTs === "string")
      await this.app
        .updateMessage(messageTs, text, [
          { type: "section", text: plain(text, 3000) },
        ])
        .catch(() => {});
    await this.app
      .postEphemeral(
        user.id,
        "Request sent. You can answer once the Dispatch owner allows it."
      )
      .catch(() => {});
  }

  private async onEvent(inbound: SlackInbound) {
    const { payload, binding, botUserId } = inbound;
    const event = payload.event ?? {};
    // Only plain new thread replies by people. Edits/deletes/joins arrive as
    // subtypes; bots (including our own echoes) carry bot_id.
    if (
      event.type !== "message" ||
      event.subtype ||
      event.bot_id ||
      typeof event.user !== "string" ||
      event.user === botUserId ||
      typeof event.thread_ts !== "string" ||
      event.thread_ts === event.ts ||
      event.channel !== binding.channelId ||
      typeof event.text !== "string"
    )
      return;
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT * FROM slack_messages WHERE channel_id=$1 AND message_ts=$2 AND binding_generation=$3`,
      [event.channel, event.thread_ts, binding.generation]
    );
    const row = rows[0];
    if (!row || row.kind === "link" || !row.agent_id || !row.stream_id) return;
    const key =
      typeof payload.event_id === "string"
        ? payload.event_id
        : `${event.channel}:${event.ts}`;
    if (!(await this.once(`event:${key}`))) return;
    const reply = (text: string) =>
      this.app.postEphemeral(event.user, text, event.thread_ts).catch(() => {});
    const origin = await this.answerer(binding, event.user);
    if (!origin) {
      if (await this.once(`notice:${event.thread_ts}:${event.user}`))
        await reply(
          "You're not linked to answer for this Dispatch, so this reply wasn't sent. Ask its owner to link you in Settings."
        );
      return;
    }
    const text = slackTextToPlain(event.text).trim();
    if (!text) return;
    const id = stableUuid(`slack-message:${event.channel}:${event.ts}`);
    const name = (await this.agentName(row.agent_id)) ?? row.agent_id;
    const ask = row.block_id ? await this.ask(row.block_id) : null;
    if (row.block_id && !ask)
      return reply("This question no longer exists in Dispatch.");
    try {
      if (
        ask &&
        ask.kind === "question" &&
        ask.data?.allowFreeform &&
        isOpen(ask.state) &&
        !ask.to_agent_id &&
        (!row.data_hash || row.data_hash === askHash(ask.text, ask.data))
      ) {
        const result = await this.writer().answerQuestion(
          ask.stream_id,
          ask.id,
          {
            id,
            value: text,
            external: origin,
          }
        );
        await reply(
          `Recorded as your answer · ${this.deliveryText(name, result.delivered)}.`
        );
        await this.reconcile().catch(() => {});
        return;
      }
      const result = await this.writer().sendUserPost(
        ask?.stream_id ?? row.stream_id,
        {
          id,
          to: row.agent_id,
          text,
          replyTo: ask?.id ?? null,
          resolveMentions: false,
          allowInert: true,
          external: origin,
        }
      );
      await reply(
        `Sent to ${name} as a message${ask ? " (not an answer)" : ""} · ${this.deliveryText(name, result.delivered === false ? false : null)}.`
      );
    } catch (error) {
      await reply(errorText(error));
    }
  }

  // ── reconcile ────────────────────────────────────────────

  /** Replace buttons on Slack messages whose ask settled anywhere. */
  async reconcile() {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const binding = await this.app.currentBinding();
      if (!binding) return;
      const { rows } = await this.pool.query<
        MessageRow & { text: string; data: any; state: any; ask_kind: string }
      >(
        `SELECT m.*, b.text, b.data, b.state, b.kind AS ask_kind FROM slack_messages m
         JOIN blocks b ON b.id=m.block_id
         LEFT JOIN blocks r ON r.id = COALESCE(b.state->'answer'->>'blockId', b.state->'submission'->>'blockId')::uuid
         WHERE m.binding_generation=$1
           AND (b.state->'answer' IS NOT NULL OR b.state->'submission' IS NOT NULL OR b.state->'cancellation' IS NOT NULL)
           AND (m.settled_at IS NULL
             -- Re-render once an in-flight reply's delivery settles.
             OR (m.shown_delivery='sending' AND r.delivered IS NOT NULL)
             -- …and once a manual retry in Dispatch succeeds.
             OR (m.shown_delivery='not_delivered' AND r.delivered IS TRUE))
         ORDER BY m.created_at LIMIT 20`,
        [binding.generation]
      );
      for (const row of rows) {
        const name = (await this.agentName(row.agent_id!)) ?? row.agent_id!;
        const ctx = this.context(
          binding,
          {
            block_id: row.block_id!,
            thread_id: row.thread_id,
            stream_id: row.stream_id!,
            agent_id: row.agent_id!,
          },
          name,
          row.text,
          row.id
        );
        const done = row.state.answer ?? row.state.submission;
        let outcome: Parameters<typeof settledMessage>[1];
        if (row.state.cancellation) {
          outcome = {
            kind: "cancelled",
            reason: row.state.cancellation.reason,
          };
        } else if (!done?.blockId) {
          outcome = { kind: "error", message: `Closed by ${name}.` };
        } else {
          const delivered = await this.pool.query(
            `SELECT delivered FROM blocks WHERE id=$1`,
            [done.blockId]
          );
          outcome = {
            kind: "answered",
            by: done.external?.displayName ?? "the owner",
            via: done.external ? "slack" : "dispatch",
            summary: row.state.answer
              ? `"${clip(String(row.state.answer.label ?? row.state.answer.value), 200)}"`
              : `${Object.keys(row.state.submission.values ?? {}).length} field(s) submitted`,
            delivery: shownDelivery(delivered.rows[0]?.delivered),
          };
        }
        const message = settledMessage(ctx, outcome);
        try {
          await this.app.updateMessage(
            row.message_ts,
            message.text,
            message.blocks
          );
          await this.pool.query(
            `UPDATE slack_messages SET settled_at=COALESCE(settled_at, now()), shown_delivery=$2 WHERE id=$1`,
            [row.id, outcome.kind === "answered" ? outcome.delivery : null]
          );
        } catch {
          break; // Slack unavailable/rate limited: retry next pass.
        }
      }
      await this.pool.query(
        `DELETE FROM slack_inbound WHERE created_at < now() - interval '7 days'`
      );
    } finally {
      this.reconciling = false;
    }
  }
}
