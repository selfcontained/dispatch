import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { PromptSource } from "../src/agents/acp/prompt-source.js";
import { StreamService, type StreamAgent } from "../src/chat/service.js";
import { SlackAnswers } from "../src/notifications/slack-answers.js";
import {
  SlackDeliveryUnknownError,
  SlackRetryError,
  type SlackApp,
  type SlackBinding,
  type SlackInbound,
} from "../src/notifications/slack-app.js";
import {
  REPLY_MAX_CHARS,
  SlackThreadReplies,
  chunkText,
} from "../src/notifications/slack-thread-replies.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

const A = "agt_slack_reply_a";
const B = "agt_slack_reply_b";
let binding: SlackBinding;
const freshBinding = (): SlackBinding => ({
  generation: "gen-1",
  enabledAt: "2000-01-01T00:00:00Z",
  teamId: "T1",
  teamName: "Team",
  appId: "A1",
  channelId: "C1",
  channelName: "dispatch",
  baseUrl: "http://lan:6767",
  botUserId: "UBOT",
});
let pool: Pool;
let live = true;
let seq = 1;

type Posted = { text: string; blocks: any[]; ts: string; threadTs?: string };

function build() {
  const agents: Record<string, StreamAgent> = {
    [A]: { id: A, name: "builder-7", filesDir: null, status: "running" },
    [B]: { id: B, name: "reviewer-2", filesDir: null, status: "running" },
  };
  const calls = {
    posted: [] as Posted[],
    updated: [] as Array<{ ts: string; text: string }>,
    ephemeral: [] as Array<{ user: string; text: string; threadTs?: string }>,
    failNext: [] as Error[],
    /** Runs inside postBlocks before it returns (to stage races). */
    duringPost: [] as Array<() => Promise<void>>,
  };
  let ts = 100;
  const app = {
    currentBinding: async () => binding,
    setInboundHandler: () => {},
    postBlocks: async (
      input: { text: string; blocks: any[]; threadTs?: string },
      expected?: string
    ) => {
      if (expected && expected !== binding.generation)
        throw new Error("Slack destination changed");
      const fail = calls.failNext.shift();
      if (fail) throw fail;
      const t = `${ts++}.000`;
      calls.posted.push({ ...input, ts: t });
      const during = calls.duringPost.shift();
      if (during) await during();
      return { channelId: "C1", timestamp: t, generation: binding.generation };
    },
    updateMessage: async (t: string, text: string) => {
      calls.updated.push({ ts: t, text });
    },
    postEphemeral: async (user: string, text: string, threadTs?: string) => {
      calls.ephemeral.push({ user, text, threadTs });
    },
    openView: async () => {},
  } as unknown as SlackApp;

  let pending: Promise<void> = Promise.resolve();
  const settle = () => pending;
  // eslint-disable-next-line prefer-const
  let replies: SlackThreadReplies;
  const svc = new StreamService({
    pool,
    publishUiEvent: () => {},
    getAgent: async (id) => agents[id] ?? null,
    filesRoot: "/files-root",
    onAgentAsk: (agentId, block) =>
      (pending = replies.agentAsked(agentId, block)),
    onResponseSettled: (input) => (pending = replies.responseSettled(input)),
    delivery: {
      access: async () =>
        live
          ? { mode: "live" as const }
          : { mode: "inert" as const, message: "Agent stopped." },
      inject: async () => {},
      held: () => false,
      activeTurn: () => false,
      commands: () => [],
      cancel: async () => {},
    },
  });
  const name = async (id: string) => agents[id]?.name ?? null;
  const answers = new SlackAnswers(pool, app, () => svc, name);
  replies = new SlackThreadReplies(pool, app, answers, name, (id) =>
    svc.currentTurn(id)
  );
  /** A fresh relay over the same DB/Slack: what a server restart looks like. */
  const restart = () =>
    new SlackThreadReplies(pool, app, answers, name, (id) =>
      svc.currentTurn(id)
    );
  return { svc, answers, replies, calls, settle, restart };
}

const threadReply = (
  user: string,
  threadTs: string,
  text: string,
  extra: Record<string, unknown> = {}
): SlackInbound => ({
  type: "events_api",
  payload: {
    api_app_id: "A1",
    team_id: "T1",
    event_id: `Ev${Math.random()}`,
    event: {
      type: "message",
      channel: "C1",
      user,
      text,
      ts: `${Math.random()}`,
      thread_ts: threadTs,
      ...extra,
    },
  },
  binding,
  botUserId: "UBOT",
});

async function allow(user: string) {
  await pool.query(
    `INSERT INTO slack_answerers(id,binding_generation,team_id,user_id,display_name,status)
     VALUES (gen_random_uuid(),$1,'T1',$2,$3,'allowed')`,
    [binding.generation, user, `@${user.toLowerCase()}`]
  );
}

/** A notify parent for `agentId`, as the notify tool records it. */
async function notifyParent(
  answers: SlackAnswers,
  agentId: string,
  ts = `${500 + seq++}.000`
) {
  await answers.recordNotify(
    { channelId: "C1", timestamp: ts, generation: binding.generation },
    agentId
  );
  return ts;
}

/** The Dispatch user post a Slack thread reply became. */
async function slackPost(text: string) {
  const { rows } = await pool.query(
    `SELECT id, stream_id, thread_id FROM blocks WHERE text=$1`,
    [text]
  );
  return rows[0] as { id: string; stream_id: string; thread_id: string | null };
}

const chatPrompt = (
  ids: string[],
  conversation?: { streamId: string; threadId: string | null }
): PromptSource => ({
  source: "chat",
  chatMessageId: ids[0]!,
  ...(ids.length > 1 ? { chatMessageIds: ids } : {}),
  userMessage: true,
  ...(conversation ? { conversation } : {}),
});

type Step =
  | { assistant: string }
  | { tool: string }
  | { during: (blockId: string) => Promise<void> };

/** Drive one turn through the service's real start/settle hooks. */
async function runTurn(
  svc: StreamService,
  agentId: string,
  prompt: PromptSource,
  steps: Step[],
  end: Record<string, unknown> = {},
  opts: { settle?: boolean } = {}
) {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO agent_stream_events (agent_id, seq, kind, payload)
     VALUES ($1, $2, 'turn', $3) RETURNING id`,
    [agentId, seq++, JSON.stringify({ state: "started", prompt })]
  );
  const id = Number(inserted.rows[0]!.id);
  const row = {
    id,
    agentId,
    seq: id,
    kind: "turn" as const,
    key: null,
    payload: { state: "started", prompt } as Record<string, unknown>,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const blockId = (await svc.recordTurnStarted({
    agentId,
    turnRow: row as never,
    prompt,
  }))!;
  await pool.query(
    `UPDATE agent_stream_events SET payload = payload || $2::jsonb WHERE id = $1`,
    [id, JSON.stringify({ blockId })]
  );
  for (const step of steps) {
    if ("during" in step) {
      await step.during(blockId);
    } else if ("tool" in step) {
      await pool.query(
        `INSERT INTO agent_stream_events (agent_id, seq, kind, key, payload)
         VALUES ($1, $2, 'tool_call', $3, $4)`,
        [
          agentId,
          seq++,
          `tc${seq}`,
          JSON.stringify({
            title: step.tool,
            status: "completed",
            toolKind: "execute",
            terminalOutput: "SECRET_TOKEN=abc123",
          }),
        ]
      );
    } else {
      await pool.query(
        `INSERT INTO agent_stream_events (agent_id, seq, kind, payload)
         VALUES ($1, $2, 'assistant', $3)`,
        [
          agentId,
          seq++,
          JSON.stringify({ text: step.assistant, streaming: false }),
        ]
      );
    }
  }
  const settled = opts.settle !== false;
  const payload = {
    state: settled ? "settled" : "started",
    blockId,
    prompt,
    ...end,
  };
  await pool.query(
    `UPDATE agent_stream_events SET payload = $2 WHERE id = $1`,
    [id, JSON.stringify(payload)]
  );
  const turnRow = { ...row, payload };
  await svc.recordTurnSettled({
    agentId,
    turnRow: turnRow as never,
    ...(settled ? {} : { frozen: true }),
  });
  return { blockId, turnRow };
}

const sectionText = (p: Posted) =>
  p.blocks
    .filter((b) => b.type === "section")
    .map((b) => b.text.text)
    .join("\n\n");

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  for (const [id, name] of [
    [A, "builder-7"],
    [B, "reviewer-2"],
  ])
    await pool.query(
      `INSERT INTO agents (id, name, cwd, status) VALUES ($1, $2, '/tmp', 'running')`,
      [id, name]
    );
});
afterAll(teardownTestDb);
beforeEach(async () => {
  live = true;
  binding = freshBinding();
  await pool.query(
    `DELETE FROM slack_thread_replies; DELETE FROM slack_messages; DELETE FROM slack_answerers;
     DELETE FROM slack_inbound; DELETE FROM question_notifications; DELETE FROM agent_stream_events;
     DELETE FROM blocks`
  );
  await allow("U1");
});

describe("Slack thread reply → agent → same Slack thread", () => {
  it("returns only the final reply, once, as plain text in the originating thread", async () => {
    const { svc, answers, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    await answers.handle(
      threadReply("U1", parent, "can you also bump the timeout?")
    );
    const post = await slackPost("can you also bump the timeout?");
    expect(calls.ephemeral.at(-1)!.text).toMatch(/Sent to builder-7/);

    const prompt = chatPrompt([post.id], {
      streamId: post.stream_id,
      threadId: post.thread_id,
    });
    const turn = await runTurn(svc, A, prompt, [
      { assistant: "Let me look at the config." },
      { tool: "grep timeout" },
      { assistant: "Done — timeout is now 30s (was 10s). <!channel> *bold*" },
    ]);
    await settle();

    expect(calls.posted).toHaveLength(1);
    const reply = calls.posted[0]!;
    expect(reply.threadTs).toBe(parent);
    expect(reply.blocks[0]).toMatchObject({
      type: "context",
      elements: [{ type: "plain_text", text: "builder-7 replied" }],
    });
    // Final words only: no lead-in narration, tool titles or tool output.
    expect(sectionText(reply)).toBe(
      "Done — timeout is now 30s (was 10s). <!channel> *bold*"
    );
    const json = JSON.stringify(reply);
    expect(json).not.toMatch(/Let me look|grep timeout|SECRET_TOKEN/);
    // Plain text everywhere: agent words are never parsed as mrkdwn.
    for (const b of reply.blocks.filter((b: any) => b.type === "section"))
      expect(b.text.type).toBe("plain_text");
    const open = reply.blocks.at(-1).elements[0];
    expect(open).toMatchObject({ action_id: "dispatch_open" });
    expect(open.url).toContain(`block=${turn.blockId}`);

    // Re-settling (reconnect replay) never sends twice.
    await svc.recordTurnSettled({ agentId: A, turnRow: turn.turnRow as never });
    await settle();
    expect(calls.posted).toHaveLength(1);
    const { rows } = await pool.query(
      `SELECT response_block_id, sent_at, reply_text FROM slack_thread_replies`
    );
    expect(rows[0]).toMatchObject({
      response_block_id: turn.blockId,
      reply_text: null,
    });
    expect(rows[0].sent_at).toBeTruthy();

    // Our own reply echoing back as a bot message is ignored: no loop.
    await answers.handle(
      threadReply("UBOT", parent, sectionText(reply), { bot_id: "B1" })
    );
    expect(
      (await pool.query(`SELECT 1 FROM slack_thread_replies`)).rowCount
    ).toBe(1);
  });

  it("fails closed: progress said only before the last tool call is never sent as a reply", async () => {
    const { svc, answers, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    await answers.handle(threadReply("U1", parent, "check prod"));
    const post = await slackPost("check prod");
    // Narration, then tools, then nothing more: not a final reply.
    await runTurn(svc, A, chatPrompt([post.id]), [
      { assistant: "Let me check the deploy logs first." },
      { tool: "tail logs" },
      { assistant: "Now the metrics." },
      { tool: "query metrics" },
    ]);
    await settle();
    expect(calls.posted).toHaveLength(0);
    // The Dispatch block still shows everything the agent said.
    const turnText = await pool.query(
      `SELECT text FROM blocks WHERE origin='turn' AND author_agent_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [A]
    );
    expect(turnText.rows[0].text).toMatch(/deploy logs[\s\S]*metrics/);
    // Left unclaimed: a later genuine final reply to the same post still goes out.
    await runTurn(svc, A, chatPrompt([post.id]), [
      { assistant: "Checking once more." },
      { tool: "tail logs" },
      { assistant: "Prod is healthy: error rate 0.1%." },
    ]);
    await settle();
    expect(calls.posted.map(sectionText)).toEqual([
      "Prod is healthy: error rate 0.1%.",
    ]);
  });

  it("a reply with no tool calls is the whole response", async () => {
    const { svc, answers, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    await answers.handle(threadReply("U1", parent, "quick?"));
    const post = await slackPost("quick?");
    await runTurn(svc, A, chatPrompt([post.id]), [
      { assistant: "Yes." },
      { assistant: "It ships Friday." },
    ]);
    await settle();
    expect(calls.posted.map(sectionText)).toEqual(["Yes.\n\nIt ships Friday."]);
  });

  it("routes per stored agent id across several agents and threads", async () => {
    const { svc, answers, calls, settle } = build();
    const pa = await notifyParent(answers, A);
    const pb = await notifyParent(answers, B);
    await answers.handle(threadReply("U1", pa, "for A"));
    await answers.handle(threadReply("U1", pb, "for B"));
    const postA = await slackPost("for A");
    const postB = await slackPost("for B");
    expect(postB.stream_id).toBe(B);

    await runTurn(svc, B, chatPrompt([postB.id]), [{ assistant: "B here" }]);
    await settle();
    await runTurn(svc, A, chatPrompt([postA.id]), [{ assistant: "A here" }]);
    await settle();
    expect(calls.posted.map((p) => [p.threadTs, sectionText(p)])).toEqual([
      [pb, "B here"],
      [pa, "A here"],
    ]);
  });

  it("never correlates by time: other prompts, other agents and other places send nothing", async () => {
    const { svc, answers, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    await answers.handle(threadReply("U1", parent, "status?"));
    const post = await slackPost("status?");

    // A turn from a Dispatch-only prompt right after the Slack message.
    const local = await svc.sendUserPost(A, { to: A, text: "local only" });
    await runTurn(svc, A, chatPrompt([local.block.id]), [
      { assistant: "local" },
    ]);
    // Another agent's turn naming the Slack post id.
    await runTurn(svc, B, chatPrompt([post.id]), [{ assistant: "B" }]);
    // A system/engine turn.
    await runTurn(svc, A, { source: "system", text: "tick" }, [
      { assistant: "sys" },
    ]);
    await settle();
    expect(calls.posted).toHaveLength(0);

    // The right agent, but the response landed in another conversation.
    const other = await svc.sendUserPost(A, { to: A, text: "other root" });
    const thread = await svc.sendUserPost(A, {
      to: A,
      text: "in a thread",
      replyTo: other.block.id,
    });
    // E.g. a routing policy placed it in another thread.
    await runTurn(svc, A, chatPrompt([post.id]), [
      {
        during: async (blockId) => {
          await pool.query(
            `UPDATE blocks SET thread_id=$2, reply_to=$3 WHERE id=$1`,
            [blockId, other.block.id, thread.block.id]
          );
        },
      },
      { assistant: "elsewhere" },
    ]);
    await settle();
    expect(calls.posted.map(sectionText)).toEqual([]);
    // Still eligible for a turn that does answer it in place.
    await runTurn(svc, A, chatPrompt([post.id]), [{ assistant: "in place" }]);
    await settle();
    expect(calls.posted.map(sectionText)).toEqual(["in place"]);
  });

  it("answers stay answers: a thread reply recorded as an answer is not mirrored", async () => {
    const { svc, answers, calls, settle } = build();
    const q = await svc.post(A, {
      text: "Which DB?",
      question: { options: [{ label: "Postgres" }], allowFreeform: true },
    });
    const block = (await svc.store.getById(q.id))!;
    await answers.postAsk({
      block_id: block.id,
      binding_generation: binding.generation,
      agent_id: A,
      stream_id: A,
      thread_id: null,
      text: block.text,
      kind: block.kind,
      data: block.data,
      name: "builder-7",
    });
    const askTs = calls.posted.at(-1)!.ts;
    calls.posted.length = 0;
    await answers.handle(threadReply("U1", askTs, "sqlite please"));
    const answered = (await svc.store.getById(q.id))!;
    const answerId = (answered.state as any).answer.blockId;
    await runTurn(svc, A, chatPrompt([answerId]), [{ assistant: "ok sqlite" }]);
    await settle();
    expect(calls.posted).toHaveLength(0);
    expect(
      (await pool.query(`SELECT 1 FROM slack_thread_replies`)).rowCount
    ).toBe(0);

    // A follow-up under a non-freeform ask is a message, and gets its reply.
    const q2 = await svc.post(A, {
      text: "Ship?",
      question: { options: [{ label: "Yes" }, { label: "No" }] },
    });
    const b2 = (await svc.store.getById(q2.id))!;
    await answers.postAsk({
      block_id: b2.id,
      binding_generation: binding.generation,
      agent_id: A,
      stream_id: A,
      thread_id: null,
      text: b2.text,
      kind: b2.kind,
      data: b2.data,
      name: "builder-7",
    });
    const ts2 = calls.posted.at(-1)!.ts;
    await answers.handle(threadReply("U1", ts2, "what breaks if yes?"));
    const follow = await slackPost("what breaks if yes?");
    expect(follow.thread_id).toBeTruthy();
    await runTurn(
      svc,
      A,
      chatPrompt([follow.id], {
        streamId: follow.stream_id,
        threadId: follow.thread_id,
      }),
      [{ assistant: "Nothing; migrations are additive." }]
    );
    await settle();
    expect(calls.posted.at(-1)).toMatchObject({ threadTs: ts2 });
    expect(sectionText(calls.posted.at(-1)!)).toBe(
      "Nothing; migrations are additive."
    );
  });

  it("stale binding, deleted parent or deleted post sends nothing to any audience", async () => {
    const { svc, answers, calls, settle } = build();
    const p1 = await notifyParent(answers, A);
    const p2 = await notifyParent(answers, A);
    const p3 = await notifyParent(answers, A);
    await answers.handle(threadReply("U1", p1, "one"));
    await answers.handle(threadReply("U1", p2, "two"));
    await answers.handle(threadReply("U1", p3, "three"));
    const [one, two, three] = await Promise.all([
      slackPost("one"),
      slackPost("two"),
      slackPost("three"),
    ]);
    await pool.query(`DELETE FROM slack_messages WHERE message_ts=$1`, [p2]);
    await runTurn(svc, A, chatPrompt([two.id]), [{ assistant: "r2" }]);
    await pool.query(`DELETE FROM blocks WHERE id=$1`, [three.id]);
    await runTurn(svc, A, chatPrompt([three.id]), [{ assistant: "r3" }]);
    // Rebound to a new installation/channel before the reply went out.
    binding = { ...binding, generation: "gen-2", channelId: "C9" };
    await runTurn(svc, A, chatPrompt([one.id]), [{ assistant: "r1" }]);
    await settle();
    expect(calls.posted).toHaveLength(0);
    const { rows } = await pool.query(
      `SELECT post_block_id, gave_up_at, reply_text FROM slack_thread_replies WHERE sent_at IS NULL`
    );
    for (const r of rows.filter((r) => r.post_block_id !== three.id)) {
      expect(r.gave_up_at).toBeTruthy();
      expect(r.reply_text).toBeNull();
    }
  });

  it("errors get one short notice; interrupted and empty replies send nothing", async () => {
    const { svc, answers, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    await answers.handle(threadReply("U1", parent, "try it"));
    const post = await slackPost("try it");

    await runTurn(svc, A, chatPrompt([post.id]), [{ assistant: "half" }], {
      stopReason: "cancelled",
    });
    await settle();
    await runTurn(svc, A, chatPrompt([post.id]), [{ tool: "ls" }]);
    await settle();
    expect(calls.posted).toHaveLength(0);

    await runTurn(svc, A, chatPrompt([post.id]), [{ assistant: "oops" }], {
      error: "Engine crashed",
    });
    await settle();
    expect(calls.posted).toHaveLength(1);
    expect(sectionText(calls.posted[0]!)).toMatch(
      /builder-7 stopped with an error before replying/
    );
    expect(JSON.stringify(calls.posted[0])).not.toMatch(/Engine crashed|oops/);
  });

  it("chunks long replies within Slack limits and points to Dispatch for the rest", async () => {
    const { svc, answers, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    await answers.handle(threadReply("U1", parent, "write it up"));
    const post = await slackPost("write it up");
    const para = `${"word ".repeat(500).trim()}.`;
    const long = Array.from({ length: 6 }, () => para).join("\n\n");
    await runTurn(svc, A, chatPrompt([post.id]), [{ assistant: long }]);
    await settle();
    const reply = calls.posted[0]!;
    const sections = reply.blocks.filter((b: any) => b.type === "section");
    expect(sections.length).toBeGreaterThan(1);
    for (const s of sections)
      expect(s.text.text.length).toBeLessThanOrEqual(3000);
    expect(sectionText(reply).length).toBeLessThanOrEqual(REPLY_MAX_CHARS + 10);
    expect(JSON.stringify(reply)).toMatch(/continues in Dispatch/);
    expect(reply.blocks.length).toBeLessThanOrEqual(50);
    expect(reply.text.length).toBeLessThanOrEqual(3000);
    expect(chunkText("a\n\nb", 3000)).toEqual(["a\n\nb"]);
  });

  it("retries Slack failures in order and batches several messages into one reply", async () => {
    const { svc, answers, replies, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    live = false; // Agent offline: recorded, said not delivered.
    await answers.handle(threadReply("U1", parent, "first"));
    await answers.handle(threadReply("U1", parent, "second"));
    expect(calls.ephemeral.at(-1)!.text).toMatch(/not delivered/i);
    live = true;
    const [first, second] = await Promise.all([
      slackPost("first"),
      slackPost("second"),
    ]);
    calls.failNext.push(new SlackRetryError(1000));
    await runTurn(svc, A, chatPrompt([first.id, second.id]), [
      { assistant: "both handled" },
    ]);
    await settle();
    expect(calls.posted).toHaveLength(0);

    // A later reply in the same thread must not jump ahead of it.
    await answers.handle(threadReply("U1", parent, "third"));
    const third = await slackPost("third");
    await runTurn(svc, A, chatPrompt([third.id]), [
      { assistant: "third done" },
    ]);
    await settle();
    expect(calls.posted).toHaveLength(0);

    await pool.query(`UPDATE slack_thread_replies SET next_attempt_at = now()`);
    await replies.flush();
    expect(calls.posted.map((p) => [p.threadTs, sectionText(p)])).toEqual([
      [parent, "both handled"],
      [parent, "third done"],
    ]);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM slack_thread_replies WHERE sent_at IS NOT NULL`
    );
    expect(rows[0].n).toBe(3);
  });

  it("gives up after an hour rather than replying to a stale thread", async () => {
    const { svc, answers, replies, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    await answers.handle(threadReply("U1", parent, "late"));
    const post = await slackPost("late");
    calls.failNext.push(new Error("network"));
    await runTurn(svc, A, chatPrompt([post.id]), [{ assistant: "late reply" }]);
    await settle();
    await pool.query(
      `UPDATE slack_thread_replies SET next_attempt_at = now(), queued_at = now() - interval '2 hours'`
    );
    await replies.flush();
    expect(calls.posted).toHaveLength(0);
    const { rows } = await pool.query(
      `SELECT gave_up_at, reply_text FROM slack_thread_replies`
    );
    expect(rows[0].gave_up_at).toBeTruthy();
    expect(rows[0].reply_text).toBeNull();
  });

  it("a turn that runs for hours still gets its reply: the window starts when it is queued", async () => {
    const { svc, answers, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    await answers.handle(threadReply("U1", parent, "big job"));
    const post = await slackPost("big job");
    await pool.query(
      `UPDATE slack_thread_replies SET created_at = now() - interval '3 hours'`
    );
    await runTurn(svc, A, chatPrompt([post.id]), [{ assistant: "finished" }]);
    await settle();
    expect(calls.posted.map(sectionText)).toEqual(["finished"]);
  });

  it("a momentarily missing binding keeps the reply queued; it sends once Slack is back", async () => {
    const { svc, answers, replies, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    await answers.handle(threadReply("U1", parent, "hello"));
    const post = await slackPost("hello");
    const saved = binding;
    binding = null as unknown as SlackBinding;
    await runTurn(svc, A, chatPrompt([post.id]), [{ assistant: "hi back" }]);
    await settle();
    expect(calls.posted).toHaveLength(0);
    const queued = await pool.query(
      `SELECT gave_up_at, reply_text FROM slack_thread_replies`
    );
    expect(queued.rows[0]).toMatchObject({
      gave_up_at: null,
      reply_text: "hi back",
    });
    binding = saved;
    await replies.flush();
    expect(calls.posted.map(sectionText)).toEqual(["hi back"]);
  });

  it("a failing thread holds back only its own thread, and gives up after a few real failures", async () => {
    const { svc, answers, replies, calls, settle } = build();
    const p1 = await notifyParent(answers, A);
    const p2 = await notifyParent(answers, B);
    await answers.handle(threadReply("U1", p1, "x1"));
    await answers.handle(threadReply("U1", p2, "x2"));
    const [x1, x2] = await Promise.all([slackPost("x1"), slackPost("x2")]);
    // Both queued while Slack is unavailable, then due in the same pass.
    const saved = binding;
    binding = null as unknown as SlackBinding;
    await runTurn(svc, A, chatPrompt([x1.id]), [{ assistant: "r1" }]);
    await settle();
    await runTurn(svc, B, chatPrompt([x2.id]), [{ assistant: "r2" }]);
    await settle();
    binding = saved;
    calls.failNext.push(new Error("invalid_blocks"));
    await replies.flush();
    // Thread p1 failed and is backing off; p2 went out in the same pass.
    expect(calls.posted.map((p) => [p.threadTs, sectionText(p)])).toEqual([
      [p2, "r2"],
    ]);
    for (let i = 0; i < 6; i += 1) {
      calls.failNext.push(new Error("invalid_blocks"));
      await pool.query(
        `UPDATE slack_thread_replies SET next_attempt_at = now() WHERE sent_at IS NULL`
      );
      await replies.flush();
    }
    const { rows } = await pool.query(
      `SELECT attempts, gave_up_at, reply_text FROM slack_thread_replies WHERE post_block_id=$1`,
      [x1.id]
    );
    expect(rows[0].attempts).toBe(5);
    expect(rows[0].gave_up_at).toBeTruthy();
    expect(rows[0].reply_text).toBeNull();
    expect(calls.posted).toHaveLength(1);
  });

  it("the local rate limiter never counts as a failed attempt", async () => {
    const { svc, answers, replies, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    await answers.handle(threadReply("U1", parent, "rl"));
    const post = await slackPost("rl");
    for (let i = 0; i < 7; i += 1)
      calls.failNext.push(new SlackRetryError(1000));
    await runTurn(svc, A, chatPrompt([post.id]), [{ assistant: "eventually" }]);
    await settle();
    for (let i = 0; i < 7; i += 1) {
      await pool.query(
        `UPDATE slack_thread_replies SET next_attempt_at = now()`
      );
      await replies.flush();
    }
    expect(calls.posted.map(sectionText)).toEqual(["eventually"]);
    const { rows } = await pool.query(
      `SELECT attempts FROM slack_thread_replies`
    );
    expect(rows[0].attempts).toBe(0);
  });

  it("a successful retry after an error notice still sends the real reply, once", async () => {
    const { svc, answers, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    await answers.handle(threadReply("U1", parent, "flaky"));
    const post = await slackPost("flaky");
    await runTurn(svc, A, chatPrompt([post.id]), [{ assistant: "x" }], {
      error: "overloaded",
      retry: "open",
    });
    await settle();
    const retried = await runTurn(svc, A, chatPrompt([post.id]), [
      { assistant: "worked this time" },
    ]);
    await settle();
    expect(calls.posted.map(sectionText)).toEqual([
      expect.stringMatching(/stopped with an error/),
      "worked this time",
    ]);
    // Re-settling either response doesn't send anything again.
    await svc.recordTurnSettled({
      agentId: A,
      turnRow: retried.turnRow as never,
    });
    await settle();
    expect(calls.posted).toHaveLength(2);
  });

  it("a failed write after Slack accepted the reply never resends it", async () => {
    const { svc, answers, replies, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    await answers.handle(threadReply("U1", parent, "once"));
    const post = await slackPost("once");
    const real = (replies as any).pool as Pool;
    let failed = false;
    (replies as any).pool = {
      query: (sql: string, params?: unknown[]) => {
        if (!failed && /SET sent_at = now\(\), slack_reply_ts/.test(sql)) {
          failed = true;
          return Promise.reject(new Error("db blip"));
        }
        return real.query(sql, params);
      },
    };
    await runTurn(svc, A, chatPrompt([post.id]), [{ assistant: "only once" }]);
    await settle();
    expect(failed).toBe(true);
    for (let i = 0; i < 3; i += 1) {
      await real.query(
        `UPDATE slack_thread_replies SET next_attempt_at = now()`
      );
      await replies.flush();
    }
    expect(calls.posted.map(sectionText)).toEqual(["only once"]);
    // The record was retried on a later flush and landed with the Slack ts.
    const { rows } = await real.query(
      `SELECT sent_at, slack_reply_ts, reply_text FROM slack_thread_replies`
    );
    expect(rows[0].sent_at).toBeTruthy();
    expect(rows[0].slack_reply_ts).toBe(calls.posted[0]!.ts);
    expect(rows[0].reply_text).toBeNull();
    expect((replies as any).sentUnrecorded.size).toBe(0);
  });

  it("at most once: a send interrupted by a restart is never resent", async () => {
    const { svc, answers, replies, calls, settle, restart } = build();
    const parent = await notifyParent(answers, A);
    await answers.handle(threadReply("U1", parent, "one"));
    const post = await slackPost("one");
    // Slack accepts it, then the record write fails and the process dies.
    const real = (replies as any).pool as Pool;
    (replies as any).pool = {
      query: (sql: string, params?: unknown[]) =>
        /SET sent_at = now\(\), slack_reply_ts/.test(sql)
          ? Promise.reject(new Error("db down"))
          : real.query(sql, params),
    };
    await runTurn(svc, A, chatPrompt([post.id]), [{ assistant: "sent once" }]);
    await settle();
    expect(calls.posted).toHaveLength(1);
    const after = restart();
    await real.query(`UPDATE slack_thread_replies SET next_attempt_at = now()`);
    await after.flush();
    await after.flush();
    expect(calls.posted).toHaveLength(1);
    const { rows } = await real.query(
      `SELECT sending_at, sent_at, gave_up_at, reply_text FROM slack_thread_replies`
    );
    expect(rows[0].sending_at).toBeTruthy();
    expect(rows[0].sent_at).toBeNull();
    expect(rows[0].gave_up_at).toBeTruthy();
    expect(rows[0].reply_text).toBeNull();
  });

  it("at most once: a send whose outcome is unknown is never retried", async () => {
    const { svc, answers, replies, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    await answers.handle(threadReply("U1", parent, "two"));
    const post = await slackPost("two");
    calls.failNext.push(new SlackDeliveryUnknownError("timeout"));
    await runTurn(svc, A, chatPrompt([post.id]), [{ assistant: "maybe" }]);
    await settle();
    await pool.query(`UPDATE slack_thread_replies SET next_attempt_at = now()`);
    await replies.flush();
    expect(calls.posted).toHaveLength(0);
    const { rows } = await pool.query(
      `SELECT gave_up_at, attempts FROM slack_thread_replies`
    );
    expect(rows[0].gave_up_at).toBeTruthy();
  });

  it("nothing is sent unless the sending mark is durably written first", async () => {
    const { svc, answers, replies, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    await answers.handle(threadReply("U1", parent, "three"));
    const post = await slackPost("three");
    const real = (replies as any).pool as Pool;
    let blocked = true;
    (replies as any).pool = {
      query: (sql: string, params?: unknown[]) =>
        blocked && /SET sending_at = now\(\)/.test(sql)
          ? Promise.reject(new Error("db blip"))
          : real.query(sql, params),
    };
    await runTurn(svc, A, chatPrompt([post.id]), [{ assistant: "careful" }]);
    await settle();
    expect(calls.posted).toHaveLength(0);
    blocked = false;
    await replies.flush();
    expect(calls.posted.map(sectionText)).toEqual(["careful"]);
  });

  it("a reply superseding an error notice mid-send is still sent, and recorded against the right claim", async () => {
    const { svc, answers, replies, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    await answers.handle(threadReply("U1", parent, "race"));
    const post = await slackPost("race");
    let retried: Promise<unknown> = Promise.resolve();
    // While Slack is accepting the error notice, the retried turn settles.
    calls.duringPost.push(async () => {
      retried = runTurn(svc, A, chatPrompt([post.id]), [
        { assistant: "the real answer" },
      ]);
      await retried;
      // Its re-claim lands while the error notice is still being sent.
      await settle();
      const { rows } = await pool.query(
        `SELECT outcome FROM slack_thread_replies`
      );
      expect(rows[0].outcome).toBe("reply");
    });
    await runTurn(svc, A, chatPrompt([post.id]), [{ assistant: "x" }], {
      error: "overloaded",
      retry: "open",
    });
    await settle();
    await retried;
    await settle();
    await pool.query(`UPDATE slack_thread_replies SET next_attempt_at = now()`);
    await replies.flush();
    const { rows } = await pool.query(
      `SELECT outcome, sent_at, slack_reply_ts FROM slack_thread_replies`
    );
    expect(calls.posted.map(sectionText)).toEqual([
      expect.stringMatching(/stopped with an error/),
      "the real answer",
    ]);
    expect(rows[0].outcome).toBe("reply");
    expect(rows[0].slack_reply_ts).toBe(calls.posted[1]!.ts);
  });

  it("a Slack message steered into a same-conversation turn is answered even without its own response split", async () => {
    const { svc, answers, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    const local = await svc.sendUserPost(A, { to: A, text: "local start" });
    await answers.handle(threadReply("U1", parent, "and also this"));
    const post = await slackPost("and also this");
    await runTurn(
      svc,
      A,
      chatPrompt([local.block.id]),
      [{ assistant: "Covered both." }],
      {
        steering: [
          { source: chatPrompt([post.id]), at: new Date().toISOString() },
        ],
      }
    );
    await settle();
    expect(calls.posted.map((p) => [p.threadTs, sectionText(p)])).toEqual([
      [parent, "Covered both."],
    ]);
  });

  it("a pickup whose own response is about to start is left for that response", async () => {
    const { svc, answers, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    const local = await svc.sendUserPost(A, { to: A, text: "first ask" });
    await answers.handle(threadReply("U1", parent, "next ask"));
    const post = await slackPost("next ask");
    const pending = chatPrompt([post.id]);
    await runTurn(
      svc,
      A,
      chatPrompt([local.block.id]),
      [{ assistant: "Answer to the first." }],
      {
        steering: [
          { source: pending, at: new Date().toISOString(), receiptId: "r1" },
        ],
        pendingResponse: { receiptId: "r1", source: pending },
      },
      { settle: false }
    );
    await settle();
    expect(calls.posted).toHaveLength(0);
    const { rows } = await pool.query(
      `SELECT response_block_id FROM slack_thread_replies`
    );
    expect(rows[0].response_block_id).toBeNull();
  });

  it("a definite failure whose sending mark can't be cleared is retried, not dropped", async () => {
    const { svc, answers, replies, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    await answers.handle(threadReply("U1", parent, "blip"));
    const post = await slackPost("blip");
    const real = (replies as any).pool as Pool;
    let blocked = true;
    (replies as any).pool = {
      query: (sql: string, params?: unknown[]) =>
        blocked && /attempts = attempts \+ \$3, sending_at = NULL/.test(sql)
          ? Promise.reject(new Error("db blip"))
          : real.query(sql, params),
    };
    calls.failNext.push(new Error("channel_not_found"));
    await runTurn(svc, A, chatPrompt([post.id]), [{ assistant: "after blip" }]);
    await settle();
    expect(calls.posted).toHaveLength(0);
    blocked = false;
    await replies.flush(); // clears the mark
    await real.query(`UPDATE slack_thread_replies SET next_attempt_at = now()`);
    await replies.flush(); // sends
    expect(calls.posted.map(sectionText)).toEqual(["after blip"]);
    const { rows } = await real.query(
      `SELECT gave_up_at, sent_at FROM slack_thread_replies`
    );
    expect(rows[0].gave_up_at).toBeNull();
    expect(rows[0].sent_at).toBeTruthy();
  });

  it("a later split response never answers an earlier Slack prompt whose own response was empty", async () => {
    const { svc, answers, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    await answers.handle(threadReply("U1", parent, "slack A"));
    const a = await slackPost("slack A");
    const b = await svc.sendUserPost(A, { to: A, text: "local B" });
    const bPrompt = chatPrompt([b.block.id]);
    // Response 1 (to A) said nothing after its tools; B was steered in and
    // split off its own response, which answers B.
    await runTurn(svc, A, chatPrompt([a.id]), [{ assistant: "Answer to B." }], {
      steering: [
        { source: bPrompt, at: new Date().toISOString(), receiptId: "rB" },
      ],
      responseReceipts: ["rB"],
      responsePrompt: bPrompt,
    });
    await settle();
    expect(calls.posted).toHaveLength(0);
    const { rows } = await pool.query(
      `SELECT response_block_id FROM slack_thread_replies`
    );
    expect(rows[0].response_block_id).toBeNull();
  });

  it("a steering split relays the finished response it froze", async () => {
    const { svc, answers, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    await answers.handle(threadReply("U1", parent, "quick q"));
    const post = await slackPost("quick q");
    await runTurn(
      svc,
      A,
      chatPrompt([post.id]),
      [{ assistant: "quick a" }],
      {},
      {
        settle: false,
      }
    );
    await settle();
    expect(calls.posted.map(sectionText)).toEqual(["quick a"]);
  });
});

describe("questions asked while answering a Slack follow-up", () => {
  it("go into the same thread at once, answerable there, and suppress the 5-minute alert", async () => {
    const { svc, answers, calls, settle } = build();
    const parent = await notifyParent(answers, A);
    await answers.handle(threadReply("U1", parent, "deploy it"));
    const post = await slackPost("deploy it");
    let askId = "";
    await runTurn(svc, A, chatPrompt([post.id]), [
      {
        during: async () => {
          const q = await svc.post(A, {
            text: "Which environment?",
            question: { options: [{ label: "staging" }, { label: "prod" }] },
          });
          askId = q.id;
          await settle();
        },
      },
      { assistant: "Waiting on your environment choice." },
    ]);
    await settle();
    expect(calls.posted.map((p) => p.threadTs)).toEqual([parent, parent]);
    const ask = calls.posted[0]!;
    expect(JSON.stringify(ask)).toMatch(/Which environment\?/);
    expect(JSON.stringify(ask)).not.toMatch(/unanswered for 5 minutes/);
    const alert = await pool.query(
      `SELECT sent_at, slack_message_ts FROM question_notifications WHERE block_id=$1`,
      [askId]
    );
    expect(alert.rows[0]).toMatchObject({ slack_message_ts: ask.ts });
    expect(alert.rows[0].sent_at).toBeTruthy();

    // A button click on the in-thread ask records the linked user's answer.
    const button = ask.blocks
      .find((b: any) => b.type === "actions")
      .elements.find((e: any) => e.text.text === "staging");
    await answers.handle({
      type: "interactive",
      payload: {
        api_app_id: "A1",
        team: { id: "T1" },
        type: "block_actions",
        user: { id: "U1", username: "u1" },
        trigger_id: "t",
        container: { message_ts: ask.ts, channel_id: "C1" },
        actions: [{ action_id: button.action_id, value: button.value }],
      },
      binding,
      botUserId: "UBOT",
    });
    const answered = (await svc.store.getById(askId))!;
    expect((answered.state as any).answer).toMatchObject({
      value: "staging",
      external: { userId: "U1" },
    });
  });

  it("are not posted for turns that did not come from Slack", async () => {
    const { svc, calls, settle } = build();
    const local = await svc.sendUserPost(A, { to: A, text: "local" });
    await runTurn(svc, A, chatPrompt([local.block.id]), [
      {
        during: async () => {
          await svc.post(A, {
            text: "Proceed?",
            question: { options: [{ label: "yes" }] },
          });
          await settle();
        },
      },
    ]);
    await settle();
    expect(calls.posted).toHaveLength(0);
    expect(
      (await pool.query(`SELECT 1 FROM question_notifications`)).rowCount
    ).toBe(0);
  });
});
