import { createHash, randomUUID } from "node:crypto";
import { imageBlocks, loadImages, sendWithImages } from "./slack-images.js";
import type { Pool } from "pg";
import type { Block } from "@dispatch/shared";
import type { PromptSource } from "../agents/acp/prompt-source.js";
import type { NotifyInput, NotifyResult } from "../shared/mcp/server.js";
import {
  SlackAuthError,
  SlackDeliveryUnknownError,
  SlackRetryError,
  type SlackApp,
} from "./slack-app.js";
import type { SlackAnswers } from "./slack-answers.js";
import {
  MARKDOWN_MAX,
  dispatchMessage,
  noteLine,
  type SlackBlock,
} from "./slack-blocks.js";

/**
 * The return path for a Slack thread reply, by explicit agent choice.
 *
 * #1445 turns a person's Slack thread reply into a Dispatch user post and
 * records it in `slack_thread_replies`. The agent that post went to may
 * answer in that same thread by calling `notify({ replyTo: <post id> })`;
 * nothing is mirrored automatically, so only words the agent wrote for the
 * Slack reader ever reach Slack. The reply is checked against the stored
 * provenance (the caller is that agent, same Slack installation/channel,
 * parent message still live) and sent at most once: a send that may have
 * reached Slack is never repeated with identical text.
 *
 * Questions/forms the agent asks while working on such a post are the other
 * explicit act that goes into the thread (see `agentAsked`).
 */

/** Agent replies render as Slack markdown (formatting, real links), capped. */
export const REPLY_MAX_CHARS = MARKDOWN_MAX;
type PlaceRow = {
  id: string;
  stream_id: string;
  thread_id: string | null;
  kind: string;
};

export function replyMessage(input: {
  agentName: string;
  text: string;
  openUrl: string;
  images?: SlackBlock[];
}): { text: string; blocks: SlackBlock[] } {
  const clipped = input.text.length > REPLY_MAX_CHARS;
  return dispatchMessage({
    header: { agentName: input.agentName },
    body: input.text,
    bodyMax: REPLY_MAX_CHARS,
    media: input.images,
    notes: clipped ? [noteLine("The reply continues in Dispatch.")] : [],
    openUrl: input.openUrl,
    summary: input.text,
  });
}

type ProvenanceRow = {
  post_block_id: string;
  binding_generation: string;
  channel_id: string;
  thread_ts: string;
  agent_id: string;
  stream_id: string;
  thread_id: string | null;
};

const promptIds = (prompts: Array<PromptSource | undefined | null>) => [
  ...new Set(
    prompts.flatMap((prompt) =>
      prompt?.source === "chat"
        ? (prompt.chatMessageIds ?? [prompt.chatMessageId])
        : []
    )
  ),
];
/** A live Slack thread an agent may ask in, and the Dispatch post it came from. */
export type ThreadTarget = {
  postId: string;
  streamId: string;
  threadId: string | null;
  threadTs: string;
  generation: string;
};
const toTarget = (row: ProvenanceRow): ThreadTarget => ({
  postId: row.post_block_id,
  streamId: row.stream_id,
  threadId: row.thread_id,
  threadTs: row.thread_ts,
  generation: row.binding_generation,
});
/** The open turn's Slack thread and its Dispatch conversation. */
export type TurnThread = {
  target: ThreadTarget;
  streamId: string;
  threadId: string | null;
};
type AskShape = Pick<
  Block,
  "kind" | "toAgentId" | "data" | "streamId" | "threadId"
>;
const isHumanAsk = (block: AskShape) =>
  (block.kind === "question" || block.kind === "form") &&
  !block.toAgentId &&
  !(block.data as any)?.parentHandled;
/** The turn's thread, if this ask is a human ask in the turn's conversation. Pure. */
export function inTurnThread(
  turn: TurnThread | null,
  block: AskShape
): ThreadTarget | null {
  if (!turn || !isHumanAsk(block)) return null;
  if (
    block.streamId !== turn.streamId ||
    (block.threadId ?? null) !== turn.threadId
  )
    return null;
  return turn.target;
}
const isUuid = (id: string) => /^[0-9a-f-]{36}$/i.test(id);
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

export class SlackThreadReplies {
  constructor(
    private pool: Pool,
    private app: SlackApp,
    private answers: Pick<SlackAnswers, "openUrl" | "postAsk">,
    private agentName: (agentId: string) => Promise<string | null>,
    /** The agent's open turn: its current block and the prompts it answers. */
    private currentTurn: (
      agentId: string
    ) => Promise<{ blockId: string | null; prompts: PromptSource[] } | null>
  ) {}

  private async provenance(postIds: string[], agentId: string) {
    const ids = postIds.filter(isUuid);
    if (!ids.length) return [];
    const { rows } = await this.pool.query<ProvenanceRow>(
      `SELECT r.post_block_id, r.binding_generation, r.channel_id, r.thread_ts,
              r.agent_id, p.stream_id, p.thread_id
       FROM slack_thread_replies r JOIN blocks p ON p.id = r.post_block_id
       WHERE r.post_block_id = ANY($1::uuid[]) AND r.agent_id = $2
       ORDER BY r.created_at`,
      [ids, agentId]
    );
    return rows;
  }

  /**
   * What an explicit replyTo may name: any message that reached the agent
   * from a Slack thread (a thread reply, a question answer or a form
   * submission), or the agent's own question/form as posted in Slack. Each
   * resolves to its thread's root ts, never a reply's own ts: Slack threads
   * under the parent message.
   */
  private async replyProvenance(replyTo: string, agentId: string) {
    const [incoming] = await this.provenance([replyTo], agentId);
    if (incoming) return incoming;
    if (!isUuid(replyTo)) return undefined;
    const { rows } = await this.pool.query<ProvenanceRow>(
      `SELECT m.block_id AS post_block_id, m.binding_generation, m.channel_id,
              COALESCE(m.thread_ts, m.message_ts) AS thread_ts, m.agent_id,
              p.stream_id, p.thread_id
       FROM slack_messages m JOIN blocks p ON p.id = m.block_id
       WHERE m.block_id = $1::uuid AND m.agent_id = $2
         AND m.kind IN ('question', 'form')
       ORDER BY m.created_at DESC LIMIT 1`,
      [replyTo, agentId]
    );
    return rows[0];
  }

  private async place(blockId: string): Promise<PlaceRow | null> {
    const { rows } = await this.pool.query<PlaceRow>(
      `SELECT id, stream_id, thread_id, kind FROM blocks WHERE id = $1`,
      [blockId]
    );
    return rows[0] ?? null;
  }

  /** The Slack parent is still a live Dispatch message for this agent and binding. */
  private async parentLive(row: ProvenanceRow) {
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

  /**
   * `notify({ replyTo })`: post the agent's own words into the Slack thread
   * the named post came from. Synchronous, with an honest result: the agent
   * sees whether it was sent, refused, or possibly sent.
   */
  async reply(
    agent: { id: string; name?: string | null },
    input: Pick<NotifyInput, "message" | "title" | "images"> & {
      replyTo: string;
    }
  ): Promise<NotifyResult> {
    const row = await this.replyProvenance(input.replyTo, agent.id);
    if (!row)
      return {
        sent: false,
        reason:
          "replyTo must be the id of a message that reached you from Slack, or of your own question or form shown in Slack. Nothing was sent.",
      };
    if (!(await this.app.currentBinding()))
      return {
        sent: false,
        reason: "Slack isn't connected right now. Nothing was sent.",
      };
    if (!(await this.parentLive(row)))
      return {
        sent: false,
        reason:
          "That Slack thread is no longer linked to this Dispatch (Slack was reconnected or the message removed). Nothing was sent; reply in Dispatch instead.",
      };
    const loaded = await loadImages(input.images);
    if ("error" in loaded)
      return { sent: false, reason: `${loaded.error} Nothing was sent.` };
    const title = input.title?.trim();
    const text = [title ? `**${title}**` : undefined, input.message.trim()]
      .filter(Boolean)
      .join("\n\n");
    const hash = sha(
      JSON.stringify([text, loaded.images.map((i) => i.digest)])
    );
    // Durable before Slack sees it, and claimed atomically: the unique
    // (post, text) key means two identical calls can't both send. If this
    // can't be recorded, nothing is sent.
    const sendId = randomUUID();
    try {
      const claimed = await this.pool.query(
        `INSERT INTO slack_thread_reply_sends(id, post_block_id, agent_id, message_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (post_block_id, message_hash) DO NOTHING RETURNING id`,
        [sendId, row.post_block_id, agent.id, hash]
      );
      if (!claimed.rowCount) {
        const prior = await this.pool.query<{ sent_at: Date | null }>(
          `SELECT sent_at FROM slack_thread_reply_sends
           WHERE post_block_id = $1 AND message_hash = $2`,
          [row.post_block_id, hash]
        );
        return {
          sent: false,
          reason: prior.rows[0]?.sent_at
            ? "You already sent this exact reply to that Slack thread. Not sent again."
            : "An identical reply is being sent, may already have posted, or an earlier failed attempt couldn't be cleared. Not sent again; rephrase if you need to try once more.",
        };
      }
    } catch {
      return {
        sent: false,
        reason:
          "Dispatch couldn't record the reply. Nothing was sent; try again.",
      };
    }
    const binding = (await this.app.currentBinding())!;
    const name = agent.name || (await this.agentName(agent.id)) || agent.id;
    const pictures = await imageBlocks(this.app, loaded.images);
    const compose = (images: SlackBlock[]) =>
      replyMessage({
        agentName: name,
        text,
        openUrl: this.answers.openUrl(binding.baseUrl, {
          block_id: row.post_block_id,
          thread_id: row.thread_id,
          stream_id: row.stream_id,
          agent_id: agent.id,
        }),
        images,
      });
    let note = pictures.skipped;
    try {
      const result = await sendWithImages(this.app, pictures.blocks, (images) =>
        this.app.postBlocks(
          { ...compose(images), threadTs: row.thread_ts, username: name },
          row.binding_generation
        )
      );
      const sent = result.sent;
      note = result.note ?? note;
      await this.pool
        .query(
          `UPDATE slack_thread_reply_sends SET sent_at = now(), slack_ts = $2 WHERE id = $1`,
          [sendId, sent.timestamp]
        )
        .catch(() => {}); // Still blocks an identical resend; never resent.
      return note ? { sent: true, note } : { sent: true };
    } catch (error) {
      if (error instanceof SlackDeliveryUnknownError)
        // May be in Slack: keep the record so identical text is never resent.
        return {
          sent: false,
          reason:
            "Slack's response was unclear, so the reply may or may not have posted. It won't be resent; don't repeat it.",
        };
      // Definitely not posted: forget the attempt so the agent may retry.
      await this.pool
        .query(`DELETE FROM slack_thread_reply_sends WHERE id = $1`, [sendId])
        .catch(() => {});
      if (error instanceof SlackRetryError)
        return { sent: false, reason: "Slack rate limited. Retry shortly." };
      return {
        sent: false,
        reason: "Slack rejected the reply. Check the connection in Settings.",
      };
    }
  }

  /**
   * The Slack thread `notify({ replyTo, form })` asks in: the same checks as
   * a text reply (the caller is the agent the post went to, same Slack
   * installation/channel, parent still live), before anything is created.
   */
  async threadTarget(
    agentId: string,
    replyTo: string
  ): Promise<
    { ok: true; target: ThreadTarget } | { ok: false; reason: string }
  > {
    const row = await this.replyProvenance(replyTo, agentId);
    if (!row)
      return {
        ok: false,
        reason:
          "replyTo must be the id of a message that reached you from Slack, or of your own question or form shown in Slack. Nothing was created.",
      };
    if (!(await this.parentLive(row)))
      return {
        ok: false,
        reason:
          "That Slack thread is no longer linked to this Dispatch (Slack was reconnected or the message removed). Nothing was created; ask with post instead.",
      };
    return { ok: true, target: toTarget(row) };
  }

  /**
   * The Slack thread the agent's open turn answers, and where in Dispatch
   * that turn lives. All lookups happen here, so callers can decide where a
   * new ask belongs with `inTurnThread` without touching the database again.
   */
  async turnThread(agentId: string): Promise<TurnThread | null> {
    const turn = await this.currentTurn(agentId);
    if (!turn?.blockId) return null;
    const rows = await this.provenance(promptIds(turn.prompts), agentId);
    const target = rows[rows.length - 1];
    if (!target) return null;
    const turnPlace = await this.place(turn.blockId);
    if (!turnPlace) return null;
    const at = (p: { stream_id: string; thread_id: string | null }) =>
      turnPlace.stream_id === p.stream_id &&
      turnPlace.thread_id === p.thread_id;
    if (!at(target)) {
      // A Slack answer lives under its question, while the turn it starts
      // resumes where the question was asked: that is the same conversation.
      const asked = target.thread_id
        ? await this.place(target.thread_id)
        : null;
      if (!asked || (asked.kind !== "question" && asked.kind !== "form"))
        return null;
      if (!at(asked)) return null;
    }
    if (!(await this.parentLive(target))) return null;
    return {
      target: toTarget(target),
      streamId: turnPlace.stream_id,
      threadId: turnPlace.thread_id,
    };
  }

  /**
   * The Slack thread a question/form belongs in because the agent asked it
   * while working on a Slack follow-up: the open turn's recorded prompts name
   * the post, and the ask is in the same conversation as the turn and post.
   */
  async turnTarget(
    agentId: string,
    block: Pick<Block, "kind" | "toAgentId" | "data" | "streamId" | "threadId">
  ): Promise<ThreadTarget | null> {
    if (!isHumanAsk(block)) return null;
    return inTurnThread(await this.turnThread(agentId), block);
  }

  /**
   * A question/form the agent posts while working on a Slack follow-up goes
   * into that thread now, as interactive Block Kit, instead of the 5-minute
   * channel alert. Correlation: the open turn's recorded prompts name the
   * post, and the ask is in the same conversation as the turn and the post.
   */
  async agentAsked(agentId: string, block: Block) {
    const target = await this.turnTarget(agentId, block);
    if (!target) return;
    const sent = await this.answers
      .postAsk({
        block_id: block.id,
        binding_generation: target.generation,
        agent_id: agentId,
        stream_id: block.streamId,
        thread_id: block.threadId ?? null,
        text: block.text,
        kind: block.kind,
        data: block.data,
        name: (await this.agentName(agentId)) ?? agentId,
        threadTs: target.threadTs,
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
}
