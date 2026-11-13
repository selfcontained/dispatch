import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { PromptSource } from "../src/agents/acp/prompt-source.js";
import { StreamService, type StreamAgent } from "../src/chat/service.js";
import {
  SlackAnswers,
  stableUuid,
} from "../src/notifications/slack-answers.js";
import { QuestionAlerts } from "../src/notifications/question-alerts.js";
import { notifyForm } from "../src/notifications/notify-form.js";
import type { AgentRecord } from "../src/agents/manager.js";
import {
  SlackApiError,
  SlackDeliveryUnknownError,
  SlackRetryError,
  type SlackApp,
  type SlackBinding,
  type SlackInbound,
} from "../src/notifications/slack-app.js";
import {
  REPLY_MAX_CHARS,
  SlackThreadReplies,
} from "../src/notifications/slack-thread-replies.js";
import { answeredPrompts } from "../src/chat/service.js";
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
const injected: string[] = [];

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
    uploads: [] as Array<{ name: string; bytes: number }>,
    /** Granted bot scopes; null = unknown (treated as allowed). */
    scopes: null as string[] | null,
    throttled: false,
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
      // Mirrors SlackApp's 1 msg/s guard right after a rejected post.
      if (calls.throttled) throw new SlackRetryError(1000);
      const fail = calls.failNext.shift();
      if (fail) {
        calls.throttled = true;
        throw fail;
      }
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
    waitForSendSlot: async () => {
      calls.throttled = false;
    },
    hasScope: (scope: string) =>
      calls.scopes ? calls.scopes.includes(scope) : null,
    uploadImage: async (bytes: Uint8Array, name: string) => {
      calls.uploads.push({ name, bytes: bytes.byteLength });
      return `F_${name}`;
    },
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
    delivery: {
      access: async () =>
        live
          ? { mode: "live" as const }
          : { mode: "inert" as const, message: "Agent stopped." },
      inject: async (_agentId, text) => {
        injected.push(text);
      },
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
  lastReplies = replies;
  const reply = (agentId: string, replyTo: string, message: string) =>
    replies.reply(
      { id: agentId, name: agents[agentId]?.name },
      {
        replyTo,
        message,
      }
    );
  return { svc, answers, replies, calls, settle, reply };
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

/** The agent's words as Slack renders them (the markdown body). */
const sectionText = (p: Posted) =>
  p.blocks
    .filter((b) => b.type === "markdown")
    .map((b) => b.text)
    .join("\n\n");

beforeAll(async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir("/tmp/dogfood-slack-cdc9-test", { recursive: true });
  await writeFile(png, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  await writeFile(fakePng, "secret notes, not an image");
  await writeFile("/tmp/dogfood-slack-cdc9-test/secret.txt", "secret");
  const { symlink, rm } = await import("node:fs/promises");
  await rm(linkPng, { force: true });
  await symlink("/tmp/dogfood-slack-cdc9-test/secret.txt", linkPng);
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
  injected.length = 0;
  await pool.query(
    `DELETE FROM slack_thread_replies; DELETE FROM slack_thread_reply_sends; DELETE FROM slack_messages; DELETE FROM slack_answerers;
     DELETE FROM slack_inbound; DELETE FROM question_notifications; DELETE FROM agent_stream_events;
     DELETE FROM blocks`
  );
  await allow("U1");
});

const png = "/tmp/dogfood-slack-cdc9-test/shot.png";
const fakePng = "/tmp/dogfood-slack-cdc9-test/notes.png";
const linkPng = "/tmp/dogfood-slack-cdc9-test/link.png";
/** notify({ replyTo, images }) for the most recently built harness. */
const replyWith = (
  _reply: unknown,
  agentId: string,
  replyTo: string,
  message: string,
  images: string[]
) =>
  lastReplies!.reply(
    { id: agentId, name: agentId === A ? "builder-7" : "reviewer-2" },
    { replyTo, message, images }
  );
let lastReplies: SlackThreadReplies | null = null;

/** A Slack follow-up from U1 under a fresh notify parent for `agentId`. */
async function followUp(answers: SlackAnswers, agentId: string, text: string) {
  const parent = await notifyParent(answers, agentId);
  await answers.handle(threadReply("U1", parent, text));
  return { parent, post: await slackPost(text) };
}

describe("notify({ replyTo }): the agent answers in the Slack thread", () => {
  it("posts the agent's own markdown into the originating thread, in the shared layout", async () => {
    const { answers, calls, reply } = build();
    const { parent, post } = await followUp(answers, A, "bump the timeout?");
    const result = await reply(
      A,
      post.id,
      "Done: timeout is now **30s**. <!channel>\n```\nTIMEOUT_MS=30000\n```\nSee [the PR](https://example.com/pr/1)."
    );
    expect(result).toEqual({ sent: true });
    expect(calls.posted).toHaveLength(1);
    const posted = calls.posted[0]!;
    expect(posted.threadTs).toBe(parent);
    const head = posted.blocks[0].elements[0];
    expect(head.type).toBe("mrkdwn");
    expect(head.text).toBe("*builder-7* replied");
    const footer = posted.blocks.at(-1).elements[0].text;
    expect(footer).toMatch(
      /^<http:\/\/lan:6767\/agents\/[^|]+block=[^|]+\|View in Dispatch> · Private link: opens on your LAN or VPN$/
    );
    expect(footer).toContain(`block=${post.id}`);
    expect(posted.text).toContain(`block=${post.id}`);
    const body = sectionText(posted);
    expect(body).toContain("**30s**");
    expect(body).toContain("```\nTIMEOUT_MS=30000\n```");
    expect(body).toContain("[the PR](https://example.com/pr/1)");
    expect(body).not.toContain("<!channel>");
    expect(posted.text).not.toContain("<!channel>");
    const { rows } = await pool.query(
      `SELECT sent_at, slack_ts FROM slack_thread_reply_sends`
    );
    expect(rows[0].slack_ts).toBe(posted.ts);
    expect(rows[0].sent_at).toBeTruthy();
    // Our own reply echoing back as a bot message is ignored: no loop.
    await answers.handle(threadReply("UBOT", parent, "echo", { bot_id: "B1" }));
    expect(
      (await pool.query(`SELECT 1 FROM slack_thread_replies`)).rowCount
    ).toBe(1);
  });

  it("only the agent the message went to may answer, and only Slack follow-ups qualify", async () => {
    const { svc, answers, calls, reply } = build();
    const { post } = await followUp(answers, A, "for A only");
    // Another agent naming A's Slack message.
    expect((await reply(B, post.id, "hijack")).sent).toBe(false);
    // A Dispatch-only post.
    const local = await svc.sendUserPost(A, { to: A, text: "local" });
    expect((await reply(A, local.block.id, "x")).sent).toBe(false);
    // A made-up id.
    expect(
      (await reply(A, "00000000-0000-4000-8000-000000000000", "x")).sent
    ).toBe(false);
    // A thread reply recorded as an answer is not a follow-up.
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
    await answers.handle(threadReply("U1", calls.posted.at(-1)!.ts, "sqlite"));
    const answerId = ((await svc.store.getById(q.id))!.state as any).answer
      .blockId;
    calls.posted.length = 0;
    const refused = await reply(A, answerId, "ok sqlite");
    expect(refused.sent).toBe(false);
    expect(refused.reason).toMatch(/Slack thread/);
    expect(calls.posted).toHaveLength(0);
  });

  it("never reaches a stale audience: rebound, removed parent or deleted post", async () => {
    const { answers, calls, reply } = build();
    const one = await followUp(answers, A, "one");
    const two = await followUp(answers, A, "two");
    const three = await followUp(answers, A, "three");
    await pool.query(`DELETE FROM slack_messages WHERE message_ts=$1`, [
      two.parent,
    ]);
    expect((await reply(A, two.post.id, "r2")).reason).toMatch(
      /no longer linked/
    );
    await pool.query(`DELETE FROM blocks WHERE id=$1`, [three.post.id]);
    expect((await reply(A, three.post.id, "r3")).sent).toBe(false);
    binding = { ...binding, generation: "gen-2", channelId: "C9" };
    expect((await reply(A, one.post.id, "r1")).reason).toMatch(
      /no longer linked/
    );
    binding = null as unknown as SlackBinding;
    expect((await reply(A, one.post.id, "r1")).reason).toMatch(
      /isn't connected/
    );
    expect(calls.posted).toHaveLength(0);
  });

  it("several replies are fine, but identical text is never posted twice", async () => {
    const { answers, calls, reply } = build();
    const { post } = await followUp(answers, A, "status?");
    expect((await reply(A, post.id, "Starting now.")).sent).toBe(true);
    expect((await reply(A, post.id, "Done.")).sent).toBe(true);
    const again = await reply(A, post.id, "Done.");
    expect(again).toMatchObject({ sent: false });
    expect(again.reason).toMatch(/already sent this exact reply/);
    expect(calls.posted.map(sectionText)).toEqual(["Starting now.", "Done."]);
  });

  it("at most once: an unclear Slack outcome is reported and never resent", async () => {
    const { answers, calls, reply } = build();
    const { post } = await followUp(answers, A, "deploy?");
    calls.failNext.push(new SlackDeliveryUnknownError("timeout"));
    const first = await reply(A, post.id, "Deployed.");
    expect(first.sent).toBe(false);
    expect(first.reason).toMatch(/may or may not have posted/);
    const again = await reply(A, post.id, "Deployed.");
    expect(again.reason).toMatch(/may already have posted/);
    expect(calls.posted).toHaveLength(0);
  });

  it("two identical calls racing each other post once", async () => {
    const { answers, calls, reply } = build();
    const { post } = await followUp(answers, A, "race me");
    const results = await Promise.all([
      reply(A, post.id, "Same words."),
      reply(A, post.id, "Same words."),
      reply(A, post.id, "Same words."),
    ]);
    expect(results.filter((r) => r.sent)).toHaveLength(1);
    expect(calls.posted.map(sectionText)).toEqual(["Same words."]);
  });

  it("a definite failure leaves nothing behind, so the agent can retry once", async () => {
    const { answers, calls, reply } = build();
    const { post } = await followUp(answers, A, "retry me");
    calls.failNext.push(new Error("channel_not_found"));
    expect((await reply(A, post.id, "Here you go.")).reason).toMatch(
      /rejected/
    );
    // Straight away, the local 1 msg/s guard still holds it back…
    expect((await reply(A, post.id, "Here you go.")).reason).toMatch(
      /rate limited/
    );
    calls.throttled = false; // …a second later it goes through, once.
    expect((await reply(A, post.id, "Here you go.")).sent).toBe(true);
    expect(calls.posted.map(sectionText)).toEqual(["Here you go."]);
  });

  it("nothing is sent unless the attempt is durably recorded first", async () => {
    const { answers, replies, calls, reply } = build();
    const { post } = await followUp(answers, A, "careful");
    const real = (replies as any).pool as Pool;
    (replies as any).pool = {
      query: (sql: string, params?: unknown[]) =>
        /INSERT INTO slack_thread_reply_sends/.test(sql)
          ? Promise.reject(new Error("db blip"))
          : real.query(sql, params),
    };
    expect((await reply(A, post.id, "x")).reason).toMatch(/couldn't record/);
    expect(calls.posted).toHaveLength(0);
  });

  it("caps long replies within Slack's markdown limit and points to Dispatch for the rest", async () => {
    const { answers, replies, calls } = build();
    const { post } = await followUp(answers, A, "write it up");
    // Past the tool's 4000-char schema cap, straight through the service.
    await replies.reply(
      { id: A, name: "builder-7" },
      { replyTo: post.id, message: "word ".repeat(2500) }
    );
    const posted = calls.posted[0]!;
    expect(sectionText(posted).length).toBeLessThanOrEqual(REPLY_MAX_CHARS);
    expect(JSON.stringify(posted)).toMatch(/continues in Dispatch/);
    expect(posted.text.length).toBeLessThanOrEqual(3000);
  });

  it("shows images inline via uploaded Slack files, alongside the words", async () => {
    const { answers, calls, reply } = build();
    const { post } = await followUp(answers, A, "screenshot?");
    const result = await replyWith(reply, A, post.id, "Here it is.", [png]);
    expect(result).toEqual({ sent: true });
    expect(calls.uploads).toEqual([{ name: "shot.png", bytes: 8 }]);
    const posted = calls.posted[0]!;
    expect(posted.blocks.map((b: any) => b.type)).toEqual([
      "context",
      "markdown",
      "image",
      "context",
    ]);
    expect(posted.blocks[2]).toMatchObject({
      slack_file: { id: "F_shot.png" },
      alt_text: "shot.png",
    });
  });

  it("an image Slack is still processing is shown once it's ready: the same reply is posted again, once", async () => {
    const { answers, calls, reply } = build();
    const { post } = await followUp(answers, A, "screenshot?");
    calls.failNext.push(
      new SlackApiError({
        error: "invalid_blocks",
        errors: ["invalid slack file [json-pointer:/blocks/2/slack_file]"],
      })
    );
    const result = await replyWith(reply, A, post.id, "Here it is.", [png]);
    expect(result).toEqual({ sent: true });
    expect(calls.posted).toHaveLength(1);
    expect(calls.posted[0]!.blocks.map((b: any) => b.type)).toContain("image");
  });

  it("same file name with new image bytes is a new reply, not a duplicate", async () => {
    const { answers, calls } = build();
    const { post } = await followUp(answers, A, "chart?");
    const { writeFile } = await import("node:fs/promises");
    const chart = "/tmp/dogfood-slack-cdc9-test/chart.png";
    await writeFile(chart, new Uint8Array([137, 80, 78, 71, 1]));
    expect((await replyWith(null, A, post.id, "Chart:", [chart])).sent).toBe(
      true
    );
    await writeFile(chart, new Uint8Array([137, 80, 78, 71, 2]));
    expect((await replyWith(null, A, post.id, "Chart:", [chart])).sent).toBe(
      true
    );
    expect(calls.posted).toHaveLength(2);
  });

  it("images: bad paths refuse the message; a missing scope or Slack rejection still sends the words", async () => {
    const { answers, calls, reply } = build();
    const { post } = await followUp(answers, A, "pics");
    expect(
      (await replyWith(reply, A, post.id, "x", ["relative.png"])).reason
    ).toMatch(/absolute/);
    expect(
      (await replyWith(reply, A, post.id, "x", ["/etc/hosts"])).reason
    ).toMatch(/png, jpg or gif/);
    // Named .png but not an image, or a .png symlink to another file.
    expect((await replyWith(reply, A, post.id, "x", [fakePng])).reason).toMatch(
      /Not a png, jpg or gif/
    );
    expect((await replyWith(reply, A, post.id, "x", [linkPng])).reason).toMatch(
      /png, jpg or gif images only/
    );
    expect(calls.posted).toHaveLength(0);
    calls.scopes = ["chat:write"];
    const noScope = await replyWith(reply, A, post.id, "words only", [png]);
    expect(noScope.sent).toBe(true);
    expect(noScope.note).toMatch(/files:write/);
    expect(calls.uploads).toHaveLength(0);
    calls.scopes = null;
    calls.failNext.push(new SlackApiError({ error: "invalid_blocks" }));
    const rejected = await replyWith(reply, A, post.id, "second try", [png]);
    expect(rejected).toMatchObject({
      sent: true,
      note: expect.stringMatching(
        /rejected the message with them \(invalid_blocks\)/
      ),
    });
    expect(calls.posted.map((p) => p.blocks.map((b: any) => b.type))).toEqual([
      ["context", "markdown", "context"],
      ["context", "markdown", "context"],
    ]);
  });

  it("nothing is mirrored automatically: a turn's final output never reaches Slack", async () => {
    const { svc, answers, calls, settle } = build();
    const { post } = await followUp(answers, A, "anything?");
    await runTurn(
      svc,
      A,
      chatPrompt([post.id], { streamId: post.stream_id, threadId: null }),
      [
        { assistant: "Let me look." },
        { tool: "grep" },
        { assistant: "All good, see the diff above." },
      ]
    );
    await settle();
    expect(calls.posted).toHaveLength(0);
  });

  it("tells the agent how to answer in Slack, only for Slack follow-ups", async () => {
    const { svc, answers } = build();
    const { post } = await followUp(answers, A, "ping from slack");
    const slack = injected.find((t) => t.includes("ping from slack"))!;
    expect(slack).toContain(`notify({ replyTo: "${post.id}"`);
    await svc.sendUserPost(A, { to: A, text: "ping from dispatch" });
    const local = injected.find((t) => t.includes("ping from dispatch"))!;
    expect(local).not.toContain("notify({ replyTo");
  });
});

describe("questions asked while working on a Slack follow-up", () => {
  it("go into the same thread at once, answerable there, and suppress the 5-minute alert", async () => {
    const { svc, answers, calls, settle } = build();
    const { parent, post } = await followUp(answers, A, "deploy it");
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
    ]);
    expect(calls.posted.map((p) => p.threadTs)).toEqual([parent]);
    const ask = calls.posted[0]!;
    expect(JSON.stringify(ask)).toMatch(/Which environment\?/);
    expect(JSON.stringify(ask)).not.toMatch(/unanswered for 5 minutes/);
    const alert = await pool.query(
      `SELECT sent_at, slack_message_ts FROM question_notifications WHERE block_id=$1`,
      [askId]
    );
    expect(alert.rows[0]).toMatchObject({ slack_message_ts: ask.ts });
    expect(alert.rows[0].sent_at).toBeTruthy();
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
    expect(
      ((await svc.store.getById(askId))!.state as any).answer
    ).toMatchObject({ value: "staging", external: { userId: "U1" } });
  });

  it("are not posted for turns that did not come from Slack, or by another agent", async () => {
    const { svc, answers, calls, settle } = build();
    const { post } = await followUp(answers, A, "for A");
    const local = await svc.sendUserPost(A, { to: A, text: "local" });
    const ask = async () => {
      await svc.post(A, {
        text: "Proceed?",
        question: { options: [{ label: "yes" }] },
      });
      await settle();
    };
    await runTurn(svc, A, chatPrompt([local.block.id]), [{ during: ask }]);
    await runTurn(svc, B, chatPrompt([post.id]), [
      {
        during: async () => {
          await svc.post(B, {
            text: "B asks",
            question: { options: [{ label: "y" }] },
          });
          await settle();
        },
      },
    ]);
    expect(calls.posted).toHaveLength(0);
    expect(
      (await pool.query(`SELECT 1 FROM question_notifications`)).rowCount
    ).toBe(0);
  });

  it("are placed by the turn's recorded prompts, split-aware", () => {
    const chat = (id: string) => chatPrompt([id]);
    // Before a split: the prompt plus steered posts, minus a pending pickup.
    expect(
      answeredPrompts({
        state: "started",
        prompt: chat("a"),
        steering: [
          { source: chat("b"), at: "", receiptId: "rb" },
          { source: chat("c"), at: "", receiptId: "rc" },
        ],
        pendingResponse: { receiptId: "rc", source: chat("c") },
      } as any).map((p: any) => p.chatMessageId)
    ).toEqual(["a", "b"]);
    // After a split onto b: only b and what was steered after it.
    expect(
      answeredPrompts({
        state: "started",
        prompt: chat("a"),
        steering: [
          { source: chat("b"), at: "", receiptId: "rb" },
          { source: chat("d"), at: "", receiptId: "rd" },
        ],
        responseReceipts: ["rb"],
        responsePrompt: chat("b"),
      } as any).map((p: any) => p.chatMessageId)
    ).toEqual(["b", "d"]);
  });
});

async function unansweredForm(svc: StreamService, id: string) {
  const state = (await svc.store.getById(id))!.state as any;
  return !state?.submission && !state?.cancellation;
}

describe("notify({ form }) in a Slack thread", () => {
  const form = {
    fields: [
      {
        id: "version",
        label: "Version",
        type: "text" as const,
        required: true,
      },
    ],
  };
  const agentA = { id: A, name: "builder-7" } as AgentRecord;
  function harness() {
    const built = build();
    const alerts = new QuestionAlerts(
      pool,
      (alert) => built.answers.postAsk(alert),
      async () => binding
    );
    const deps = {
      pool,
      post: (agentId: string, input: any, opts: any) =>
        built.svc.post(agentId, input, opts),
      alerts,
      threads: built.replies,
    };
    return { ...built, alerts, deps };
  }
  const interactive = (payload: Record<string, any>): SlackInbound => ({
    type: "interactive",
    payload: { api_app_id: "A1", team: { id: "T1" }, ...payload },
    binding,
    botUserId: "UBOT",
  });
  /** Open the form's modal from its Slack message and submit it as U1. */
  async function submitInSlack(
    answers: SlackAnswers,
    message: Posted,
    version: string
  ) {
    const ref = message.blocks.find((b: any) => b.type === "actions")
      .elements[0].value;
    await answers.handle(
      interactive({
        type: "block_actions",
        user: { id: "U1", username: "u1" },
        trigger_id: "t",
        container: { message_ts: message.ts, channel_id: "C1" },
        actions: [{ action_id: "dispatch_form", value: ref }],
      })
    );
    const submission = interactive({
      type: "view_submission",
      user: { id: "U1" },
      view: {
        callback_id: "dispatch_form_modal",
        private_metadata: ref,
        state: { values: { f0: { value: { value: version } } } },
      },
    });
    expect(await answers.handle(submission)).toBeUndefined();
    await answers.handle(submission); // Slack redelivery
    return stableUuid(`slack-answer:${ref}`);
  }

  it("with replyTo, asks in that thread at once; the Slack submission settles the same form, reaches the agent once, and the agent can answer back there", async () => {
    const { svc, answers, calls, alerts, deps, reply } = harness();
    const { parent, post } = await followUp(answers, A, "ship it?");
    const before = injected.length;
    const result = await notifyForm(deps, agentA, {
      message: "Which version ships?",
      replyTo: post.id,
      form,
    });
    expect(result).toMatchObject({ sent: true, delivery: "sent" });
    const block = (await svc.store.getById(result.form!.id))!;
    // Durable in Dispatch as a reply to the Slack-origin post, for people.
    expect(block).toMatchObject({ kind: "form", toAgentId: null });
    expect(block.threadId).toBe(post.thread_id ?? post.id);
    expect(calls.posted.map((p) => p.threadTs)).toEqual([parent]);
    expect(JSON.stringify(calls.posted[0])).not.toMatch(/5 minutes/);
    // The reminder worker sees it as sent: no channel-root repeat.
    await pool.query(
      "UPDATE question_notifications SET next_attempt_at=now()-interval '1 second'"
    );
    await alerts.tick();
    expect(calls.posted).toHaveLength(1);

    const answerId = await submitInSlack(answers, calls.posted[0]!, "1.8.0");
    expect((await svc.store.getById(block.id))!.state).toMatchObject({
      submission: {
        values: { version: "1.8.0" },
        external: { source: "slack", userId: "U1" },
      },
    });
    const delivered = injected.slice(before);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("1.8.0");
    expect(delivered[0]).toContain(answerId);
    // The submission's id is a valid replyTo back into the same thread.
    expect(await reply(A, answerId, "Thanks, shipping 1.8.0.")).toEqual({
      sent: true,
    });
    expect(calls.posted.map((p) => p.threadTs)).toEqual([parent, parent]);
  });

  it("without replyTo during a Slack follow-up turn, posts once into that turn's thread", async () => {
    const { svc, answers, calls, deps, settle } = harness();
    const { parent, post } = await followUp(answers, A, "deploy it");
    let result: Awaited<ReturnType<typeof notifyForm>> | null = null;
    await runTurn(svc, A, chatPrompt([post.id]), [
      {
        during: async () => {
          result = await notifyForm(deps, agentA, {
            message: "Which version?",
            form,
          });
          await settle();
        },
      },
    ]);
    expect(result).toMatchObject({ sent: true, delivery: "sent" });
    expect(calls.posted.map((p) => p.threadTs)).toEqual([parent]);
  });

  it("a channel-root form's Slack answer can be acknowledged in a thread under that form", async () => {
    const { answers, calls, deps, reply } = harness();
    const result = await notifyForm(deps, agentA, {
      message: "Which version ships?",
      form,
    });
    expect(result.sent).toBe(true);
    const message = calls.posted[0]!;
    expect(message.threadTs).toBeUndefined();
    const answerId = await submitInSlack(answers, message, "2.0.0");
    expect(await reply(A, answerId, "Got it.")).toEqual({ sent: true });
    expect(calls.posted[1]!.threadTs).toBe(message.ts);
  });

  it("a failed threaded send stays durable and retries into the same thread, never the channel root", async () => {
    const { answers, calls, alerts, deps } = harness();
    const { parent, post } = await followUp(answers, A, "ship it?");
    calls.failNext.push(new Error("socket down"));
    const result = await notifyForm(deps, agentA, {
      message: "Which version ships?",
      replyTo: post.id,
      form,
    });
    expect(result).toMatchObject({ sent: false, delivery: "retrying" });
    expect(result.form?.id).toBeTruthy();
    calls.throttled = false;
    await pool.query("UPDATE question_notifications SET next_attempt_at=now()");
    await alerts.tick();
    expect(calls.posted.map((p) => p.threadTs)).toEqual([parent]);
  });

  /** Age every alert so a reminder worker scan would treat it as long overdue. */
  const overdue = () =>
    pool.query(
      `UPDATE blocks SET created_at=now()-interval '10 minutes';
       UPDATE question_notifications SET next_attempt_at=now()-interval '1 second',due_at=now()-interval '5 minutes',lease_until=NULL`
    );

  it("Slack reconnected before the immediate claim: not sent anywhere, never rerouted to the channel or new connection by the worker", async () => {
    const { svc, answers, calls, alerts, deps } = harness();
    const { post } = await followUp(answers, A, "ship it?");
    const rotating = {
      ...deps,
      alerts: {
        sendNow: async (id: string, thread?: any) => {
          binding = { ...binding, generation: "gen-2" };
          return alerts.sendNow(id, thread);
        },
      },
    };
    const result = await notifyForm(rotating, agentA, {
      message: "Which version ships?",
      replyTo: post.id,
      form,
    });
    expect(result).toMatchObject({ sent: false, delivery: "not_sent" });
    expect(result.reason).toMatch(/not sent anywhere else/);
    expect(await unansweredForm(svc, result.form!.id)).toBe(true);
    // New connection's worker, long after the reminder delay: still nothing.
    await overdue();
    await alerts.tick();
    await alerts.tick();
    expect(calls.posted).toHaveLength(0);
    // An explicit retry under the new connection is refused too.
    expect((await alerts.sendNow(result.form!.id)).delivery).toBe("not_sent");
    expect(calls.posted).toHaveLength(0);
  });

  it("a worker scan between creation and the immediate claim neither enrolls a channel reminder nor double-sends", async () => {
    const { answers, calls, alerts, deps } = harness();
    const { parent, post } = await followUp(answers, A, "ship it?");
    const racing = {
      ...deps,
      alerts: {
        sendNow: async (id: string, thread?: any) => {
          await overdue();
          await alerts.tick(); // the worker sees the form first
          return alerts.sendNow(id, thread);
        },
      },
    };
    const result = await notifyForm(racing, agentA, {
      message: "Which version ships?",
      replyTo: post.id,
      form,
    });
    expect(result.sent).toBe(true);
    await overdue();
    await alerts.tick();
    expect(calls.posted.map((p) => p.threadTs)).toEqual([parent]);
  });

  it("if the immediate send never runs, the worker delivers into the reserved thread once", async () => {
    const { answers, calls, alerts, deps } = harness();
    const { parent, post } = await followUp(answers, A, "ship it?");
    const crashed = {
      ...deps,
      alerts: {
        sendNow: async () => {
          throw new Error("db blip before the claim");
        },
      },
    };
    const result = await notifyForm(crashed, agentA, {
      message: "Which version ships?",
      replyTo: post.id,
      form,
    });
    expect(result).toMatchObject({ sent: false, delivery: "retrying" });
    await overdue();
    await alerts.tick();
    await overdue();
    await alerts.tick();
    expect(calls.posted.map((p) => p.threadTs)).toEqual([parent]);
  });

  it("a failed Slack-turn lookup fails the call with nothing created or sent", async () => {
    const { calls, deps } = harness();
    const failing = {
      ...deps,
      threads: {
        ...deps.threads,
        threadTarget: deps.threads.threadTarget.bind(deps.threads),
        turnThread: async () => {
          throw new Error("db blip");
        },
      },
    };
    await expect(
      notifyForm(failing as any, agentA, { message: "x", form })
    ).rejects.toThrow(/db blip/);
    expect(
      (await pool.query("SELECT 1 FROM blocks WHERE kind='form'")).rowCount
    ).toBe(0);
    expect(calls.posted).toHaveLength(0);
  });

  it("refuses before creating anything for a foreign, non-Slack or stale replyTo", async () => {
    const { svc, answers, calls, deps } = harness();
    const { post } = await followUp(answers, A, "for A only");
    const local = await svc.sendUserPost(A, { to: A, text: "local" });
    const count = async () =>
      (await pool.query("SELECT 1 FROM blocks WHERE kind='form'")).rowCount;
    for (const [agent, replyTo] of [
      [{ id: B, name: "reviewer-2" } as AgentRecord, post.id],
      [agentA, local.block.id],
      [agentA, "11111111-1111-4111-8111-111111111111"],
    ] as const) {
      const result = await notifyForm(deps, agent, {
        message: "x",
        replyTo,
        form,
      });
      expect(result.sent).toBe(false);
      expect(result.reason).toMatch(/Nothing was created/);
    }
    binding = { ...binding, generation: "gen-2" };
    const stale = await notifyForm(deps, agentA, {
      message: "x",
      replyTo: post.id,
      form,
    });
    expect(stale.reason).toMatch(/no longer linked/);
    expect(await count()).toBe(0);
    expect(calls.posted).toHaveLength(0);
  });
});
