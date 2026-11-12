import type { Pool } from "pg";
import type { Block } from "@dispatch/shared";
import type { PromptSource } from "../agents/acp/prompt-source.js";
import { SlackRetryError, type SlackApp } from "./slack-app.js";
import type { SlackAnswers } from "./slack-answers.js";
import {
  ACTION,
  SLACK_LIMITS,
  plain,
  type SlackBlock,
} from "./slack-blocks.js";

/**
 * The return path for a Slack thread reply: when the agent the reply was
 * routed to answers it, its final response goes back into that thread.
 *
 * Correlation is explicit provenance only. #1445 turns a person's thread
 * reply into a Dispatch user post; `recordFollowUp` writes a row naming that
 * post. A response is sent back only when its turn's stored prompt names the
 * post — never by timing — and only from the exact agent and conversation
 * the post went to. Answers to questions/forms are not mirrored: the ask's
 * own Slack message already shows them answered.
 */

/** Section text is plain_text (no mrkdwn/@channel/link injection), ≤3000 each. */
export const REPLY_MAX_CHARS = 8000;
/** Give up on a queued reply Slack would not take after this long. */
const GIVE_UP_MS = 60 * 60 * 1000;
/** …or after this many real (non rate-limit) send failures. */
const MAX_ATTEMPTS = 5;

export type ResponseSettled = {
  agentId: string;
  /** The response's block: the turn block, or a split response's own block. */
  blockId: string;
  /** The prompt this response answers (`responsePrompt ?? prompt`). */
  prompt: PromptSource | undefined;
  /**
   * Assistant text after the response's last tool call, from the turn's own
   * rows; "" when nothing was said after it. Progress before a tool call is
   * never a reply, so an empty value sends nothing (fail closed).
   */
  finalText: string;
  outcome: "ok" | "error" | "interrupted";
};

type ReplyRow = {
  post_block_id: string;
  binding_generation: string;
  channel_id: string;
  thread_ts: string;
  message_ts: string;
  agent_id: string;
  response_block_id: string | null;
  outcome: "reply" | "error" | null;
  reply_text: string | null;
  attempts: number;
  created_at: Date;
};

type PlaceRow = { id: string; stream_id: string; thread_id: string | null };

/** Split on paragraph, then line, then hard boundaries; each ≤ max. */
export function chunkText(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max / 2) cut = window.lastIndexOf("\n");
    if (cut < max / 2) cut = window.lastIndexOf(" ");
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function replyMessage(input: {
  agentName: string;
  context?: string;
  text: string;
  openUrl: string;
}): { text: string; blocks: SlackBlock[] } {
  const clipped = input.text.length > REPLY_MAX_CHARS;
  const body = clipped
    ? `${input.text.slice(0, REPLY_MAX_CHARS - 1).trimEnd()}…`
    : input.text;
  const blocks: SlackBlock[] = [
    {
      type: "context",
      elements: [
        plain(
          [`${input.agentName} replied`, input.context]
            .filter(Boolean)
            .join(" · "),
          SLACK_LIMITS.sectionText
        ),
      ],
    },
    ...chunkText(body, SLACK_LIMITS.sectionText).map((chunk) => ({
      type: "section",
      text: plain(chunk, SLACK_LIMITS.sectionText),
    })),
  ];
  if (clipped)
    blocks.push({
      type: "context",
      elements: [plain("The reply continues in Dispatch.", 200)],
    });
  blocks.push(openActions(input.openUrl));
  return {
    text: `${input.agentName}: ${body.slice(0, 2900)}`,
    blocks,
  };
}

export function errorMessage(input: {
  agentName: string;
  context?: string;
  openUrl: string;
}): { text: string; blocks: SlackBlock[] } {
  const text = `${input.agentName} stopped with an error before replying. Open Dispatch to see what happened.`;
  return {
    text,
    blocks: [
      {
        type: "context",
        elements: [
          plain(
            [input.agentName, input.context].filter(Boolean).join(" · "),
            SLACK_LIMITS.sectionText
          ),
        ],
      },
      { type: "section", text: plain(text, SLACK_LIMITS.sectionText) },
      openActions(input.openUrl),
    ],
  };
}

function openActions(url: string): SlackBlock {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: ACTION.open,
        text: plain("Open in Dispatch", SLACK_LIMITS.buttonText),
        url,
      },
    ],
  };
}

const promptIds = (prompt: PromptSource | undefined | null) =>
  prompt?.source === "chat"
    ? (prompt.chatMessageIds ?? [prompt.chatMessageId])
    : [];

export class SlackThreadReplies {
  private timer?: ReturnType<typeof setInterval>;
  private flushing = false;
  /**
   * Sent (post id → Slack ts), but recording that failed. Never sent again;
   * each flush retries the record until it lands.
   */
  private sentUnrecorded = new Map<string, string>();
  constructor(
    private pool: Pool,
    private app: SlackApp,
    private answers: Pick<SlackAnswers, "openUrl" | "postAsk">,
    private agentName: (agentId: string) => Promise<string | null>,
    /** The agent's open turn: its current block and the prompt it answers. */
    private currentTurn: (
      agentId: string
    ) => Promise<{ blockId: string | null; prompt: PromptSource } | null>
  ) {}

  start() {
    this.timer = setInterval(() => {
      void this.flush().catch(() => {});
    }, 15000);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
  }

  /** The newest unclaimed Slack follow-ups this response's prompt names. */
  private async followUps(agentId: string, prompt: PromptSource | undefined) {
    const ids = promptIds(prompt).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (!ids.length) return [];
    const { rows } = await this.pool.query<
      ReplyRow & { stream_id: string; thread_id: string | null }
    >(
      `SELECT r.*, p.stream_id, p.thread_id FROM slack_thread_replies r
       JOIN blocks p ON p.id = r.post_block_id
       WHERE r.post_block_id = ANY($1::uuid[]) AND r.agent_id = $2
       ORDER BY r.created_at`,
      [ids, agentId]
    );
    return rows;
  }

  private async place(blockId: string): Promise<PlaceRow | null> {
    const { rows } = await this.pool.query<PlaceRow>(
      `SELECT id, stream_id, thread_id FROM blocks WHERE id = $1`,
      [blockId]
    );
    return rows[0] ?? null;
  }

  /** Queue the response for the Slack thread its prompt came from, once. */
  async responseSettled(input: ResponseSettled) {
    // A cut turn may be retried; leave the follow-up for whichever turn answers it.
    if (input.outcome === "interrupted") return;
    const rows = await this.followUps(input.agentId, input.prompt);
    const text = input.finalText.trim();
    const outcome = input.outcome === "error" ? "error" : "reply";
    // An empty reply sends nothing; the inbound ack was the receipt.
    if (outcome === "reply" && !text) return;
    // A real reply supersedes an earlier error notice for the same post
    // (e.g. the person retried the failed turn); nothing else re-claims.
    const open = rows.filter(
      (r) =>
        !r.response_block_id ||
        (outcome === "reply" &&
          r.outcome === "error" &&
          r.response_block_id !== input.blockId)
    );
    if (!open.length) return;
    const target = open[open.length - 1]!;
    // Same agent, same conversation the person wrote into; anywhere else
    // (a re-route, another thread) sends nothing.
    const response = await this.pool.query<
      PlaceRow & { author_agent_id: string | null }
    >(
      `SELECT id, stream_id, thread_id, author_agent_id FROM blocks WHERE id = $1`,
      [input.blockId]
    );
    const place = response.rows[0];
    if (
      !place ||
      place.author_agent_id !== input.agentId ||
      place.stream_id !== target.stream_id ||
      place.thread_id !== target.thread_id
    )
      return;
    // Claim every follow-up this response covers; only the newest is sent to.
    await this.pool.query(
      `UPDATE slack_thread_replies SET response_block_id = $1,
         outcome = CASE WHEN post_block_id = $3 THEN $4 ELSE NULL END,
         reply_text = CASE WHEN post_block_id = $3 THEN $5 ELSE NULL END,
         next_attempt_at = now(), queued_at = now(), attempts = 0,
         gave_up_at = NULL, slack_reply_ts = NULL,
         sent_at = CASE WHEN post_block_id = $3 THEN NULL ELSE now() END
       WHERE post_block_id = ANY($2::uuid[])
         AND (response_block_id IS NULL
           OR ($4 = 'reply' AND outcome = 'error' AND response_block_id <> $1))`,
      [
        input.blockId,
        open.map((r) => r.post_block_id),
        target.post_block_id,
        outcome,
        outcome === "reply" ? text : null,
      ]
    );
    await this.flush();
  }

  /**
   * A question/form the agent posts while answering a Slack follow-up goes
   * into that thread now, as interactive Block Kit, instead of the 5-minute
   * channel alert. Same correlation: the open turn's prompt names the post.
   */
  async agentAsked(agentId: string, block: Block) {
    if (block.kind !== "question" && block.kind !== "form") return;
    if (block.toAgentId || (block.data as any)?.parentHandled) return;
    const turn = await this.currentTurn(agentId);
    if (!turn?.blockId) return;
    const rows = await this.followUps(agentId, turn.prompt);
    const target = rows[rows.length - 1];
    if (!target) return;
    const turnPlace = await this.place(turn.blockId);
    if (
      !turnPlace ||
      turnPlace.stream_id !== target.stream_id ||
      turnPlace.thread_id !== target.thread_id ||
      block.streamId !== turnPlace.stream_id ||
      (block.threadId ?? null) !== turnPlace.thread_id
    )
      return;
    if (!(await this.parentLive(target))) return;
    const sent = await this.answers
      .postAsk({
        block_id: block.id,
        binding_generation: target.binding_generation,
        agent_id: agentId,
        stream_id: block.streamId,
        thread_id: block.threadId ?? null,
        text: block.text,
        kind: block.kind,
        data: block.data,
        name: (await this.agentName(agentId)) ?? agentId,
        threadTs: target.thread_ts,
      })
      .catch(() => false);
    if (!sent || sent === true) return; // The ordinary 5-minute alert still applies.
    // Already in front of the person: the delayed alert must not repeat it.
    await this.pool.query(
      `INSERT INTO question_notifications(block_id,binding_generation,due_at,next_attempt_at,sent_at,slack_channel_id,slack_message_ts)
       VALUES ($1,$2,now(),now(),now(),$3,$4)
       ON CONFLICT (block_id) DO UPDATE SET sent_at = COALESCE(question_notifications.sent_at, now())`,
      [block.id, sent.generation, sent.channelId, sent.timestamp]
    );
  }

  /** The Slack parent is still a live Dispatch message for this agent and binding. */
  private async parentLive(row: ReplyRow) {
    const binding = await this.app.currentBinding();
    if (
      !binding ||
      binding.generation !== row.binding_generation ||
      binding.channelId !== row.channel_id
    )
      return false;
    const parent = await this.pool.query(
      `SELECT 1 FROM slack_messages WHERE channel_id=$1 AND message_ts=$2
         AND binding_generation=$3 AND agent_id=$4`,
      [row.channel_id, row.thread_ts, row.binding_generation, row.agent_id]
    );
    return !!parent.rowCount;
  }

  /** Record a send; on failure remember it so it is retried, never resent. */
  private async markSent(postBlockId: string, ts: string) {
    try {
      await this.pool.query(
        `UPDATE slack_thread_replies SET sent_at = now(), slack_reply_ts = $2, reply_text = NULL
         WHERE post_block_id = $1`,
        [postBlockId, ts]
      );
      this.sentUnrecorded.delete(postBlockId);
    } catch {
      this.sentUnrecorded.set(postBlockId, ts);
    }
  }

  private async giveUp(postBlockId: string) {
    await this.pool.query(
      `UPDATE slack_thread_replies SET gave_up_at = now(), reply_text = NULL WHERE post_block_id = $1`,
      [postBlockId]
    );
  }

  /** Send queued replies in order; Slack failures retry with backoff, then give up. */
  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const { rows } = await this.pool.query<
        ReplyRow & { due: boolean; expired: boolean }
      >(
        `SELECT *, next_attempt_at <= now() AS due,
           queued_at < now() - ($1 * interval '1 millisecond') AS expired
         FROM slack_thread_replies
         WHERE response_block_id IS NOT NULL AND outcome IS NOT NULL
           AND sent_at IS NULL AND gave_up_at IS NULL
         ORDER BY created_at LIMIT 50`,
        [GIVE_UP_MS]
      );
      // Order is per Slack thread: a reply backing off holds back only
      // newer replies in its own thread, never other threads or agents.
      const held = new Set<string>();
      for (const row of rows) {
        const thread = `${row.channel_id}:${row.thread_ts}`;
        if (held.has(thread)) continue;
        const unrecorded = this.sentUnrecorded.get(row.post_block_id);
        if (unrecorded !== undefined) {
          await this.markSent(row.post_block_id, unrecorded);
          continue;
        }
        if (row.expired || row.attempts >= MAX_ATTEMPTS) {
          await this.giveUp(row.post_block_id);
          continue;
        }
        if (!row.due) {
          held.add(thread);
          continue;
        }
        const binding = await this.app.currentBinding();
        // Not connected right now (startup, brief disconnect): keep it
        // queued until the window closes; nothing is lost or retargeted.
        if (!binding) return;
        // Rebound to another installation/channel, or the parent is gone.
        if (!(await this.parentLive(row))) {
          await this.giveUp(row.post_block_id);
          continue;
        }
        const [post, response] = await Promise.all([
          this.place(row.post_block_id),
          this.place(row.response_block_id!),
        ]);
        const name = await this.agentName(row.agent_id);
        if (!post || !response || !name) {
          await this.giveUp(row.post_block_id);
          continue;
        }
        const openUrl = this.answers.openUrl(binding.baseUrl, {
          block_id: response.id,
          thread_id: response.thread_id,
          stream_id: response.stream_id,
          agent_id: row.agent_id,
        });
        const context = response.stream_id.startsWith("tsk_")
          ? `Task ${response.stream_id}`
          : undefined;
        const message =
          row.outcome === "error"
            ? errorMessage({ agentName: name, context, openUrl })
            : replyMessage({
                agentName: name,
                context,
                text: row.reply_text ?? "",
                openUrl,
              });
        let sent: { timestamp: string };
        try {
          sent = await this.app.postBlocks(
            { ...message, threadTs: row.thread_ts },
            row.binding_generation
          );
        } catch (error) {
          const limited = error instanceof SlackRetryError;
          const wait = limited
            ? Math.max(1, error.retryAfterMs / 1000)
            : Math.min(900, 15 * 2 ** Math.min(row.attempts, 6));
          // The local 1 msg/s limiter isn't a failure: it doesn't count.
          await this.pool.query(
            `UPDATE slack_thread_replies SET attempts = attempts + $3,
               next_attempt_at = now() + ($2 * interval '1 second')
             WHERE post_block_id = $1`,
            [row.post_block_id, wait, limited ? 0 : 1]
          );
          if (limited) {
            const t = setTimeout(
              () => void this.flush().catch(() => {}),
              wait * 1000 + 50
            );
            t.unref?.();
            return; // Every send hits the same limiter; try again shortly.
          }
          held.add(thread);
          continue;
        }
        // Slack has it now. A failed bookkeeping write must never resend.
        await this.markSent(row.post_block_id, sent.timestamp);
      }
    } finally {
      this.flushing = false;
    }
  }
}
