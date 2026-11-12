import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Block } from "@dispatch/shared";
import type { PromptSource } from "../agents/acp/prompt-source.js";
import type { NotifyInput, NotifyResult } from "../shared/mcp/server.js";
import {
  SlackDeliveryUnknownError,
  SlackRetryError,
  type SlackApp,
} from "./slack-app.js";
import type { SlackAnswers } from "./slack-answers.js";
import {
  ACTION,
  SLACK_LIMITS,
  plain,
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

/** Section text is plain_text (no mrkdwn/@channel/link injection), ≤3000 each. */
export const REPLY_MAX_CHARS = 8000;
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

  private async place(blockId: string): Promise<PlaceRow | null> {
    const { rows } = await this.pool.query<PlaceRow>(
      `SELECT id, stream_id, thread_id FROM blocks WHERE id = $1`,
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
    input: Pick<NotifyInput, "message" | "title"> & { replyTo: string }
  ): Promise<NotifyResult> {
    const [row] = await this.provenance([input.replyTo], agent.id);
    if (!row)
      return {
        sent: false,
        reason:
          "replyTo must be the id of a message that reached you from a Slack thread. Nothing was sent.",
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
    const text = [input.title?.trim(), input.message.trim()]
      .filter(Boolean)
      .join("\n\n");
    const hash = sha(text);
    const prior = await this.pool.query<{ sent_at: Date | null }>(
      `SELECT sent_at FROM slack_thread_reply_sends
       WHERE post_block_id = $1 AND message_hash = $2 LIMIT 1`,
      [row.post_block_id, hash]
    );
    if (prior.rows[0])
      return {
        sent: false,
        reason: prior.rows[0].sent_at
          ? "You already sent this exact reply to that Slack thread. Not sent again."
          : "An identical reply may already have posted (Slack's response was unclear). Not sent again.",
      };
    // Durable before Slack sees it: if this can't be recorded, nothing is sent.
    const sendId = randomUUID();
    try {
      await this.pool.query(
        `INSERT INTO slack_thread_reply_sends(id, post_block_id, agent_id, message_hash)
         VALUES ($1, $2, $3, $4)`,
        [sendId, row.post_block_id, agent.id, hash]
      );
    } catch {
      return {
        sent: false,
        reason:
          "Dispatch couldn't record the reply. Nothing was sent; try again.",
      };
    }
    const binding = (await this.app.currentBinding())!;
    const name = agent.name || (await this.agentName(agent.id)) || agent.id;
    const message = replyMessage({
      agentName: name,
      context: row.stream_id.startsWith("tsk_")
        ? `Task ${row.stream_id}`
        : undefined,
      text,
      openUrl: this.answers.openUrl(binding.baseUrl, {
        block_id: row.post_block_id,
        thread_id: row.thread_id,
        stream_id: row.stream_id,
        agent_id: agent.id,
      }),
    });
    try {
      const sent = await this.app.postBlocks(
        { ...message, threadTs: row.thread_ts },
        row.binding_generation
      );
      await this.pool
        .query(
          `UPDATE slack_thread_reply_sends SET sent_at = now(), slack_ts = $2 WHERE id = $1`,
          [sendId, sent.timestamp]
        )
        .catch(() => {}); // Still blocks an identical resend; never resent.
      return { sent: true };
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
   * A question/form the agent posts while working on a Slack follow-up goes
   * into that thread now, as interactive Block Kit, instead of the 5-minute
   * channel alert. Correlation: the open turn's recorded prompts name the
   * post, and the ask is in the same conversation as the turn and the post.
   */
  async agentAsked(agentId: string, block: Block) {
    if (block.kind !== "question" && block.kind !== "form") return;
    if (block.toAgentId || (block.data as any)?.parentHandled) return;
    const turn = await this.currentTurn(agentId);
    if (!turn?.blockId) return;
    const rows = await this.provenance(promptIds(turn.prompts), agentId);
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
}
