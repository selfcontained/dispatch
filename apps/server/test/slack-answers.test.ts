import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Pool } from "pg";
import { StreamService, type StreamAgent } from "../src/chat/service.js";
import {
  SlackAnswers,
  stableUuid,
} from "../src/notifications/slack-answers.js";
import { SlackApp } from "../src/notifications/slack-app.js";
import { setSetting, deleteSetting, getSetting } from "../src/db/settings.js";
import type {
  SlackBinding,
  SlackInbound,
} from "../src/notifications/slack-app.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";
import { QuestionAlerts } from "../src/notifications/question-alerts.js";
import { notifyForm } from "../src/notifications/notify-form.js";
import type { AgentRecord } from "../src/agents/manager.js";

const A = "agt_slack_asker";
const binding: SlackBinding = {
  generation: "gen-1",
  enabledAt: "2000-01-01T00:00:00Z",
  teamId: "T1",
  teamName: "Team",
  appId: "A1",
  channelId: "C1",
  channelName: "dispatch",
  baseUrl: "http://lan:6767",
  botUserId: "UBOT",
};
let pool: Pool;
let live = true;
/** Holds engine pickup so the in-flight ("sending") state is observable. */
let gate: Promise<void> | null = null;
const injected: string[] = [];

function fakeSlack() {
  const calls = {
    posted: [] as Array<{ text: string; blocks: any[]; ts: string }>,
    updated: [] as Array<{ ts: string; text: string; blocks: any[] }>,
    ephemeral: [] as Array<{ user: string; text: string; threadTs?: string }>,
    views: [] as Array<{ trigger: string; view: any }>,
  };
  let ts = 100;
  const app = {
    recordCallbackStage: () => {},
    settings: async () => ({ missingLinkScopes: [] }),
    currentBinding: async () => binding,
    setInboundHandler: () => {},
    postBlocks: async (input: { text: string; blocks: any[] }) => {
      const t = `${ts++}.000`;
      calls.posted.push({ ...input, ts: t });
      return { channelId: "C1", timestamp: t, generation: binding.generation };
    },
    updateMessage: async (t: string, text: string, blocks: any[]) => {
      calls.updated.push({ ts: t, text, blocks });
    },
    postEphemeral: async (user: string, text: string, threadTs?: string) => {
      calls.ephemeral.push({ user, text, threadTs });
    },
    openView: async (trigger: string, view: any) => {
      calls.views.push({ trigger, view });
    },
  } as unknown as SlackApp;
  return { app, calls };
}

function build() {
  const agents: Record<string, StreamAgent> = {
    [A]: { id: A, name: "builder-7", filesDir: null, status: "running" },
  };
  const svc = new StreamService({
    pool,
    publishUiEvent: () => {},
    getAgent: async (id) => agents[id] ?? null,
    filesRoot: "/files-root",
    delivery: {
      access: async () =>
        live
          ? { mode: "live" as const }
          : { mode: "inert" as const, message: "Agent stopped." },
      inject: async (_agentId, text) => {
        if (gate) await gate;
        injected.push(text);
      },
      held: () => false,
      activeTurn: () => false,
      commands: () => [],
      cancel: async () => {},
    },
  });
  const slack = fakeSlack();
  const answers = new SlackAnswers(
    pool,
    slack.app,
    () => svc,
    async (id) => agents[id]?.name ?? null
  );
  return { svc, answers, ...slack };
}

const interactive = (payload: Record<string, any>): SlackInbound => ({
  type: "interactive",
  payload: { api_app_id: "A1", team: { id: "T1" }, ...payload },
  binding,
  botUserId: "UBOT",
});
const click = (
  user: string,
  actionId: string,
  value: string,
  messageTs: string
) =>
  interactive({
    type: "block_actions",
    user: { id: user, username: user.toLowerCase() },
    trigger_id: "trig",
    container: { message_ts: messageTs, channel_id: "C1" },
    actions: [{ action_id: actionId, value }],
  });
const threadReply = (
  user: string,
  threadTs: string,
  text: string,
  extra: Record<string, unknown> = {},
  eventId = `Ev${Math.random()}`
): SlackInbound => ({
  type: "events_api",
  payload: {
    api_app_id: "A1",
    team_id: "T1",
    event_id: eventId,
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

async function unanswered(svc: StreamService, id: string) {
  const s = (await svc.store.getById(id))!.state as any;
  return !s?.answer && !s?.submission && !s?.cancellation;
}

async function linkUser(answers: SlackAnswers, calls: any, user: string) {
  await answers.createLink();
  const link = calls.posted.at(-1);
  const nonce = link.blocks[1].elements[0].value;
  await answers.handle(click(user, "dispatch_link", nonce, link.ts));
  const pending = (await answers.answerers()).find(
    (a) => a.displayName === `@${user.toLowerCase()}`
  )!;
  await answers.allow(pending.id);
}

async function ask(
  svc: StreamService,
  answers: SlackAnswers,
  calls: any,
  input: Record<string, unknown>
) {
  const posted = await svc.post(A, { text: "Which database?", ...input });
  const block = (await svc.store.getById(posted.id))!;
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
  const message = calls.posted.at(-1);
  const actions = message.blocks.find(
    (b: any) => b.type === "actions"
  ).elements;
  return { block, message, actions };
}

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
  await pool.query(
    `INSERT INTO agents (id, name, cwd, status) VALUES ($1, 'builder-7', '/tmp', 'running')`,
    [A]
  );
});
afterAll(teardownTestDb);
beforeEach(async () => {
  live = true;
  gate = null;
  injected.length = 0;
  await pool.query(
    "DELETE FROM slack_messages; DELETE FROM slack_answerers; DELETE FROM slack_link_claims; DELETE FROM slack_inbound; DELETE FROM blocks"
  );
});

describe("answerer binding", () => {
  it("persists a real Socket Mode link claim and pending identity before explicit Allow", async () => {
    let posted: any;
    const socket = {
      close: vi.fn(),
      send: vi.fn(),
      onmessage: null,
      onclose: null,
      onerror: null,
    } as unknown as WebSocket;
    const transport = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("auth.test"))
        return Response.json({ ok: true, team_id: "T1", user_id: "UBOT" });
      if (url.endsWith("apps.connections.open"))
        return Response.json({
          ok: true,
          url: `wss://wss.slack.com/link?app_id=${"b".repeat(64)}`,
        });
      if (url.endsWith("chat.postMessage"))
        posted = JSON.parse(String(init?.body));
      return Response.json({ ok: true, ts: "123.456" });
    });
    await setSetting(
      pool,
      "slack_app_binding",
      JSON.stringify({
        binding: { ...binding, appId: "b".repeat(64) },
        credentials: { botToken: "xoxb-fixture", appToken: "xapp-fixture" },
      })
    );
    const storedBinding = await getSetting(pool, "slack_app_binding");
    const app = new SlackApp(pool, transport as typeof fetch, () => {
      queueMicrotask(() =>
        socket.onmessage?.({
          data: JSON.stringify({
            type: "hello",
            connection_info: { app_id: "A1" },
            num_connections: 1,
          }),
        } as MessageEvent)
      );
      return socket;
    });
    const answers = new SlackAnswers(
      pool,
      app,
      () => null as never,
      async () => null
    );
    answers.start();
    try {
      await app.start();
      expect(await app.currentBinding()).toMatchObject({
        appId: "A1",
        generation: binding.generation,
      });
      await answers.createLink();
      const nonce = posted.blocks[1].elements[0].value;
      const deliver = () =>
        socket.onmessage!({
          data: JSON.stringify({
            type: "interactive",
            envelope_id: "db-link-fixture",
            accepts_response_payload: false,
            payload: {
              type: "block_actions",
              api_app_id: "A1",
              team: { id: "T1" },
              user: { id: "U_SOCKET", username: "socketmember", team_id: "T1" },
              channel: { id: "C1" },
              container: {
                type: "message",
                channel_id: "C1",
                message_ts: "123.456",
                is_ephemeral: false,
              },
              actions: [
                {
                  type: "button",
                  action_id: "dispatch_link",
                  value: nonce,
                  block_id: "link",
                  action_ts: "124.567",
                },
              ],
            },
          }),
        } as MessageEvent);
      deliver();
      await vi.waitFor(async () =>
        expect(await answers.answerers()).toMatchObject([
          { userId: "U_SOCKET", status: "pending" },
        ])
      );
      expect(socket.send).toHaveBeenCalledWith(
        JSON.stringify({ envelope_id: "db-link-fixture" })
      );
      expect((await app.settings()).callbackDiagnostic?.stage).toBe(
        "link_pending"
      );
      const { rows } = await pool.query(
        "SELECT used_at IS NOT NULL AS used FROM slack_link_claims"
      );
      expect(rows).toEqual([{ used: true }]);
      deliver();
      await vi.waitFor(async () =>
        expect((await app.settings()).callbackDiagnostic?.stage).toBe(
          "link_expired"
        )
      );
      const identities = await answers.answerers();
      expect(identities).toHaveLength(1);
      expect(identities[0]!.status).toBe("pending");
      await answers.allow(identities[0]!.id);
      expect(await answers.answerers()).toMatchObject([
        { userId: "U_SOCKET", status: "allowed" },
      ]);
      await app.start();
      expect(await app.currentBinding()).toMatchObject({
        appId: "A1",
        generation: binding.generation,
      });
      expect(await getSetting(pool, "slack_app_binding")).toBe(storedBinding);
      expect(await answers.answerers()).toMatchObject([
        { userId: "U_SOCKET", status: "allowed" },
      ]);
    } finally {
      answers.stop();
      app.stop();
      await deleteSetting(pool, "slack_app_binding");
    }
  });

  it("is nobody by default; a one-time claim stays pending until the owner allows it", async () => {
    const { svc, answers, calls } = build();
    const q = await ask(svc, answers, calls, {
      question: { options: [{ label: "Postgres" }] },
    });
    await answers.handle(
      click("U1", q.actions[0].action_id, q.actions[0].value, q.message.ts)
    );
    expect(calls.ephemeral.at(-1)!.text).toMatch(/not linked/);
    expect(await unanswered(svc, q.block.id)).toBe(true);

    await answers.createLink();
    const link = calls.posted.at(-1)!;
    const nonce = link.blocks[1].elements[0].value;
    await answers.handle(click("U1", "dispatch_link", nonce, link.ts));
    expect(await answers.answerers()).toMatchObject([
      { displayName: "@u1", status: "pending" },
    ]);
    // Pending grants nothing.
    await answers.handle(
      click("U1", q.actions[0].action_id, q.actions[0].value, q.message.ts)
    );
    expect(await unanswered(svc, q.block.id)).toBe(true);
    // Single use: a second clicker gets nothing.
    await answers.handle(click("U2", "dispatch_link", nonce, link.ts));
    expect(calls.ephemeral.at(-1)!.text).toMatch(/expired or was already used/);
    expect(await answers.answerers()).toHaveLength(1);
    // Only the hash is stored.
    const { rows } = await pool.query(
      "SELECT nonce_hash FROM slack_link_claims"
    );
    expect(rows[0].nonce_hash).not.toContain(nonce);
  });

  it("rejects cross-team claims without consuming the link and never renames an allowed identity", async () => {
    const { answers, calls } = build();
    await answers.createLink();
    const link = calls.posted.at(-1)!;
    const nonce = link.blocks[1].elements[0].value;
    const guest = click("UX", "dispatch_link", nonce, link.ts);
    guest.payload.user.team_id = "T_OTHER";
    await answers.handle(guest);
    expect(calls.ephemeral.at(-1)!.text).toMatch(/Only members of Team/);
    expect(await answers.answerers()).toEqual([]);
    const member = click("U1", "dispatch_link", nonce, link.ts);
    member.payload.user.team_id = "T1";
    await answers.handle(member);
    const [pending] = await answers.answerers();
    expect(pending).toMatchObject({
      userId: "U1",
      displayName: "@u1",
      status: "pending",
    });
    await answers.allow(pending!.id);

    await answers.createLink();
    const again = calls.posted.at(-1)!;
    const renamed = click(
      "U1",
      "dispatch_link",
      again.blocks[1].elements[0].value,
      again.ts
    );
    renamed.payload.user.username = "bradharris";
    await answers.handle(renamed);
    expect(await answers.answerers()).toMatchObject([
      { userId: "U1", displayName: "@u1", status: "allowed" },
    ]);
    expect(calls.ephemeral.at(-1)!.text).toMatch(/already linked/);
  });

  it("expired links bind nobody and revoke removes access", async () => {
    const { svc, answers, calls } = build();
    await answers.createLink();
    await pool.query(
      "UPDATE slack_link_claims SET expires_at=now()-interval '1 second'"
    );
    const link = calls.posted.at(-1)!;
    await answers.handle(
      click("U1", "dispatch_link", link.blocks[1].elements[0].value, link.ts)
    );
    expect(await answers.answerers()).toEqual([]);

    await linkUser(answers, calls, "U1");
    const [row] = await answers.answerers();
    await answers.revoke(row!.id);
    const q = await ask(svc, answers, calls, {
      question: { options: [{ label: "Postgres" }] },
    });
    await answers.handle(
      click("U1", q.actions[0].action_id, q.actions[0].value, q.message.ts)
    );
    expect(await unanswered(svc, q.block.id)).toBe(true);
  });
});

describe("choice answers", () => {
  it("maps the opaque value to the stored option, attributes the Slack user and settles the message", async () => {
    const { svc, answers, calls } = build();
    await linkUser(answers, calls, "U1");
    const q = await ask(svc, answers, calls, {
      question: {
        options: [{ label: "Postgres", value: "pg-14" }, { label: "SQLite" }],
      },
    });
    expect(JSON.stringify(q.message.blocks)).not.toContain("pg-14");
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const quietFrom = calls.ephemeral.length;
    await answers.handle(
      click("U1", q.actions[0].action_id, q.actions[0].value, q.message.ts)
    );
    const answered = (await svc.store.getById(q.block.id))!;
    expect(answered.state).toMatchObject({
      answer: {
        value: "pg-14",
        label: "Postgres",
        by: { kind: "user" },
        external: {
          source: "slack",
          teamId: "T1",
          userId: "U1",
          displayName: "@u1",
        },
      },
    });
    const reply = (await svc.store.getById(
      (answered.state as any).answer.blockId
    ))!;
    expect(reply.id).toBe(
      stableUuid(`slack-answer:${q.actions[0].value.split(":")[0]}`)
    );
    expect(reply.author).toEqual({ kind: "user" });
    expect(reply.data).toMatchObject({ external: { userId: "U1" } });
    // Success is quiet: no private receipt; the settled message says it all.
    expect(calls.ephemeral.slice(quietFrom)).toEqual([]);
    // Returned before the engine took it: in flight, never "delivered".
    const settled = calls.updated.find((u) => u.ts === q.message.ts)!;
    // Who answered and with what; routine delivery progress isn't shown.
    expect(settled.text).toContain('@u1 answered "Postgres"');
    expect(settled.text).not.toMatch(/recorded|sending|delivered|in Slack/);
    expect(settled.blocks.some((b: any) => b.type === "actions")).toBe(false);
    // Same footer as the ask it replaced.
    expect(settled.blocks.at(-1)).toEqual(q.message.blocks.at(-1));
    // Still in flight: reconcile leaves it alone.
    await answers.reconcile();
    expect(calls.updated.filter((u) => u.ts === q.message.ts)).toHaveLength(1);
    // Once the engine takes it, the Slack message is re-rendered once.
    release();
    await svc.waitForInFlightDeliveries(1000);
    expect(injected.at(-1)).toContain(
      "from: user via Slack (@u1, linked identity"
    );
    // The agent can follow up in the question's Slack thread.
    expect(injected.at(-1)).toContain(
      `Answered in Slack: they read only Slack`
    );
    expect(injected.at(-1)).toContain(`notify({ replyTo: "${reply.id}"`);
    const returnPath = await pool.query(
      `SELECT thread_ts, agent_id FROM slack_thread_replies WHERE post_block_id=$1`,
      [reply.id]
    );
    expect(returnPath.rows).toEqual([
      { thread_ts: q.message.ts, agent_id: q.block.streamId },
    ]);
    for (let i = 0; i < 50; i++) {
      if ((await svc.store.getById(reply.id))!.delivered !== null) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await answers.reconcile();
    await answers.reconcile();
    const renders = calls.updated.filter((u) => u.ts === q.message.ts);
    expect(renders).toHaveLength(2);
    expect(renders[1]!.text).toContain('@u1 answered "Postgres"');
    expect(renders[1]!.text).not.toMatch(/hasn't received/);
    expect(calls.ephemeral.slice(quietFrom)).toEqual([]);
  });

  it("an answer that fails to record leaves no return path behind", async () => {
    const { svc, answers, calls } = build();
    await linkUser(answers, calls, "U1");
    const q = await ask(svc, answers, calls, {
      question: { options: [{ label: "Postgres" }] },
    });
    const writer = (answers as any).writer.bind(answers);
    (answers as any).writer = () => ({
      ...writer(),
      answerQuestion: async () => {
        throw new Error("write failed");
      },
    });
    await answers.handle(
      click("U1", q.actions[0].action_id, q.actions[0].value, q.message.ts)
    );
    const answerId = stableUuid(
      `slack-answer:${q.actions[0].value.split(":")[0]}`
    );
    expect(await svc.store.getById(answerId)).toBeFalsy();
    const paths = await pool.query(
      "SELECT 1 FROM slack_thread_replies WHERE post_block_id=$1",
      [answerId]
    );
    expect(paths.rowCount).toBe(0);
  });

  it("duplicate, racing and retried clicks yield one answer", async () => {
    const { svc, answers, calls } = build();
    await linkUser(answers, calls, "U1");
    await linkUser(answers, calls, "U2");
    const q = await ask(svc, answers, calls, {
      question: { options: [{ label: "Postgres" }, { label: "SQLite" }] },
    });
    await Promise.all([
      answers.handle(
        click("U1", q.actions[0].action_id, q.actions[0].value, q.message.ts)
      ),
      answers.handle(
        click("U2", q.actions[1].action_id, q.actions[1].value, q.message.ts)
      ),
      answers.handle(
        click("U1", q.actions[0].action_id, q.actions[0].value, q.message.ts)
      ),
    ]);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM blocks WHERE reply_to=$1",
      [q.block.id]
    );
    expect(rows[0].n).toBe(1);
    // The losing clicks don't remove the winner's return path.
    const answerId = ((await svc.store.getById(q.block.id))!.state as any)
      .answer.blockId;
    const paths = await pool.query(
      "SELECT post_block_id FROM slack_thread_replies WHERE thread_ts=$1",
      [q.message.ts]
    );
    expect(paths.rows).toEqual([{ post_block_id: answerId }]);
    // The winning click gets no receipt; only the two losers hear back.
    expect(calls.ephemeral.filter((e) => /^Recorded/.test(e.text))).toEqual([]);
    const winner = ((await svc.store.getById(q.block.id))!.state as any).answer
      .external.userId;
    const repeats = calls.ephemeral.filter((e) => /^Already/.test(e.text));
    expect(repeats).toHaveLength(2);
    // The winner's own repeat says it counted; anyone else's says it didn't.
    for (const e of repeats)
      expect(e.text).toBe(
        e.user === winner
          ? "Already recorded your answer — nothing more to do."
          : "Already answered — your input was not recorded."
      );
    const own = winner === "U1" ? q.actions[0] : q.actions[1];
    await answers.handle(click(winner, own.action_id, own.value, q.message.ts));
    expect(calls.ephemeral.at(-1)!.text).toBe(
      "Already recorded your answer — nothing more to do."
    );
  });

  it("rejects forged indexes, mismatched action ids and refs replayed from another message", async () => {
    const { svc, answers, calls } = build();
    await linkUser(answers, calls, "U1");
    const q = await ask(svc, answers, calls, {
      question: { options: [{ label: "Postgres" }, { label: "SQLite" }] },
    });
    const ref = q.actions[0].value.split(":")[0];
    await answers.handle(
      click("U1", "dispatch_option:5", `${ref}:5`, q.message.ts)
    );
    await answers.handle(
      click("U1", "dispatch_option:0", `${ref}:1`, q.message.ts)
    );
    await answers.handle(
      click("U1", "dispatch_option:0", `${ref}:0`, "999.000")
    );
    await answers.handle(
      click("U1", "dispatch_option:0", `not-a-ref:0`, q.message.ts)
    );
    expect(await unanswered(svc, q.block.id)).toBe(true);
    expect(calls.ephemeral.slice(-4).map((e) => e.text)).toEqual([
      "That choice isn't valid for this question.",
      "That choice isn't valid for this question.",
      "This message is no longer linked to Dispatch.",
      "This message is no longer linked to Dispatch.",
    ]);
  });

  it("rejects stale (changed), cancelled and wrong-generation asks", async () => {
    const { svc, answers, calls } = build();
    await linkUser(answers, calls, "U1");
    const changed = await ask(svc, answers, calls, {
      question: { options: [{ label: "A" }] },
    });
    await pool.query(
      `UPDATE blocks SET data='{"options":[{"label":"B"}]}' WHERE id=$1`,
      [changed.block.id]
    );
    await answers.handle(
      click(
        "U1",
        changed.actions[0].action_id,
        changed.actions[0].value,
        changed.message.ts
      )
    );
    expect(calls.ephemeral.at(-1)!.text).toMatch(/changed since it was sent/);

    const cancelled = await ask(svc, answers, calls, {
      question: { options: [{ label: "A" }] },
    });
    await svc.setState(
      A,
      cancelled.block.id,
      { cancellation: true },
      { kind: "agent", agentId: A }
    );
    await answers.handle(
      click(
        "U1",
        cancelled.actions[0].action_id,
        cancelled.actions[0].value,
        cancelled.message.ts
      )
    );
    expect(calls.ephemeral.at(-1)!.text).toMatch(/withdrawn/);

    await pool.query("UPDATE slack_messages SET binding_generation='old'");
    const fresh = await ask(svc, answers, calls, {
      question: { options: [{ label: "A" }] },
    });
    await pool.query(
      "UPDATE slack_messages SET binding_generation='old' WHERE block_id=$1",
      [fresh.block.id]
    );
    await answers.handle(
      click(
        "U1",
        fresh.actions[0].action_id,
        fresh.actions[0].value,
        fresh.message.ts
      )
    );
    expect(await unanswered(svc, fresh.block.id)).toBe(true);
  });

  it("answers approval-style questions from a linked user just like Dispatch (no question gating)", async () => {
    const { svc, answers, calls } = build();
    await linkUser(answers, calls, "U1");
    const q = await ask(svc, answers, calls, {
      text: "Merge PR #42 and cut the release?",
      question: { options: [{ label: "Merge" }, { label: "Hold" }] },
    });
    expect(q.actions.map((e: any) => e.action_id)).toEqual([
      "dispatch_option:0",
      "dispatch_option:1",
    ]);
    await answers.handle(
      click("U1", q.actions[0].action_id, q.actions[0].value, q.message.ts)
    );
    const answered = (await svc.store.getById(q.block.id))!;
    expect(answered.state).toMatchObject({
      answer: {
        value: "Merge",
        by: { kind: "user" },
        external: { userId: "U1" },
      },
    });
    await svc.waitForInFlightDeliveries(1000);
    expect(injected.at(-1)).toContain(
      "from: user via Slack (@u1, linked identity)"
    );
    expect(injected.at(-1)).not.toMatch(/not an agent or approval/);
  });

  it("records durably and shows not delivered (no auto-resume promise) when the agent is offline", async () => {
    const { svc, answers, calls } = build();
    await linkUser(answers, calls, "U1");
    const q = await ask(svc, answers, calls, {
      question: { options: [{ label: "Postgres" }] },
    });
    live = false;
    const quietFrom = calls.ephemeral.length;
    await answers.handle(
      click("U1", q.actions[0].action_id, q.actions[0].value, q.message.ts)
    );
    const answered = (await svc.store.getById(q.block.id))!;
    const reply = (await svc.store.getById(
      (answered.state as any).answer.blockId
    ))!;
    expect(reply.delivered).toBe(false);
    // The actionable "not delivered" lives on the settled message itself, so
    // no duplicate private receipt.
    expect(calls.ephemeral.slice(quietFrom)).toEqual([]);
    expect(calls.updated.at(-1)!.text).toContain(
      "the agent hasn't received it yet — retry in Dispatch"
    );
    // A manual retry that succeeds updates Slack once.
    await pool.query("UPDATE blocks SET delivered=true WHERE id=$1", [
      reply.id,
    ]);
    await answers.reconcile();
    await answers.reconcile();
    const renders = calls.updated.filter((u) => u.ts === q.message.ts);
    expect(renders).toHaveLength(2);
    expect(renders[1]!.text).not.toMatch(/hasn't received/);
    expect(calls.updated.at(-1)!.text).not.toMatch(/picked up|resumed/);
  });
});

describe("forms via modal", () => {
  const form = {
    title: "Release",
    fields: [
      { id: "version", label: "Version", type: "text", required: true },
      { id: "pct", label: "Rollout %", type: "number", required: true },
      {
        id: "ch",
        label: "Channel",
        type: "select",
        options: [{ label: "Stable", value: "s" }],
      },
      { id: "ok", label: "Notify", type: "checkbox" },
    ],
  };
  const submit = (user: string, ref: string, values: Record<string, any>) =>
    interactive({
      type: "view_submission",
      user: { id: user },
      view: {
        callback_id: "dispatch_form_modal",
        private_metadata: ref,
        state: { values },
      },
    });

  it("opens a modal, returns inline validation errors, then records typed values with provenance", async () => {
    const { svc, answers, calls } = build();
    await linkUser(answers, calls, "U1");
    const q = await ask(svc, answers, calls, { form });
    await answers.handle(
      click("U1", "dispatch_form", q.actions[0].value, q.message.ts)
    );
    expect(calls.views.at(-1)!.view.callback_id).toBe("dispatch_form_modal");
    const ref = q.actions[0].value;
    const quietFrom = calls.ephemeral.length;
    expect(
      await answers.handle(submit("U1", ref, { f1: { value: { value: "x" } } }))
    ).toEqual({
      response_action: "errors",
      errors: { f0: "Required.", f1: "Enter a number." },
    });
    expect(await unanswered(svc, q.block.id)).toBe(true);
    expect(
      await answers.handle(
        submit("U1", ref, {
          f0: { value: { value: "1.8.0" } },
          f1: { value: { value: "25" } },
          f2: { value: { selected_option: { value: "0" } } },
          f3: { value: { selected_options: [{ value: "on" }] } },
        })
      )
    ).toBeUndefined();
    expect((await svc.store.getById(q.block.id))!.state).toMatchObject({
      submission: {
        values: { version: "1.8.0", pct: 25, ch: "s", ok: true },
        external: { userId: "U1" },
      },
    });
    // The modal closing is the acknowledgment; the message settles in place.
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.ephemeral.slice(quietFrom)).toEqual([]);
    expect(calls.updated.at(-1)!.ts).toBe(q.message.ts);
    expect(calls.updated.at(-1)!.text).toContain("@u1 submitted the form");
    // Same layout as the ask: header, the form's title and text, footer.
    const settled = calls.updated.at(-1)!.blocks;
    expect(settled.map((b: any) => b.type)).toEqual([
      "section",
      "markdown",
      "context",
      "context",
    ]);
    expect(settled[0].text.text).toBe("*_builder-7_*");
    expect(settled[1]).toEqual(q.message.blocks[1]);
    expect(settled[1].text).toContain("**Release**");
    expect(settled.at(-1)).toEqual(q.message.blocks.at(-1));
    expect(settled.at(-1).elements[0].text).toMatch(/\|View in Dispatch>$/);
  });

  it("unlinked or stale submissions keep the modal open with the reason", async () => {
    const { svc, answers, calls } = build();
    const q = await ask(svc, answers, calls, { form });
    const result: any = await answers.handle(
      submit("U9", q.actions[0].value, {})
    );
    expect(result.response_action).toBe("update");
    expect(JSON.stringify(result.view)).toMatch(/not linked/);
  });
});

describe("notify({ form }) end to end", () => {
  const form = {
    fields: [
      {
        id: "version",
        label: "Version",
        type: "text" as const,
        required: true,
      },
      { id: "notes", label: "Notes", type: "textarea" as const },
    ],
  };
  const submit = (user: string, ref: string, values: Record<string, any>) =>
    interactive({
      type: "view_submission",
      user: { id: user },
      view: {
        callback_id: "dispatch_form_modal",
        private_metadata: ref,
        state: { values },
      },
    });
  const setup = () => {
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
      threads: {
        threadTarget: async () => ({ ok: false as const, reason: "n/a" }),
        turnThread: async () => null,
      },
    };
    return { ...built, alerts, deps };
  };
  const agent = { id: A, name: "builder-7" } as AgentRecord;

  it("creates the form, alerts Slack at once, and one modal submit reaches the agent once", async () => {
    const { svc, answers, calls, alerts, deps } = setup();
    await linkUser(answers, calls, "U1");
    const before = calls.posted.length;
    const result = await notifyForm(deps, agent, {
      message: "Which version ships?",
      title: "Release",
      form,
    });
    expect(result).toMatchObject({ sent: true, delivery: "sent" });
    const block = (await svc.store.getById(result.form!.id))!;
    expect(block).toMatchObject({ kind: "form", streamId: A, toAgentId: null });
    expect(block.data).toMatchObject({ title: "Release" });
    expect(calls.posted.length).toBe(before + 1);
    const message = calls.posted.at(-1)!;
    expect(JSON.stringify(message.blocks)).not.toMatch(/5 minutes/);
    // The delayed worker sees the recorded success and stays quiet.
    await pool.query(
      "UPDATE question_notifications SET next_attempt_at=now()-interval '1 second'"
    );
    await alerts.tick();
    expect(calls.posted.length).toBe(before + 1);

    const ref = message.blocks.find((b: any) => b.type === "actions")
      .elements[0].value;
    await answers.handle(click("U1", "dispatch_form", ref, message.ts));
    expect(calls.views.at(-1)!.view.callback_id).toBe("dispatch_form_modal");
    // Required field enforced by the same modal validation.
    expect(await answers.handle(submit("U1", ref, {}))).toMatchObject({
      response_action: "errors",
    });
    expect(injected).toHaveLength(0);
    const quietFrom = calls.ephemeral.length;
    const values = { f0: { value: { value: "1.8.0" } } };
    expect(await answers.handle(submit("U1", ref, values))).toBeUndefined();
    // A redelivered submission records nothing new.
    await answers.handle(submit("U1", ref, values));
    expect((await svc.store.getById(block.id))!.state).toMatchObject({
      submission: {
        values: { version: "1.8.0" },
        external: { source: "slack", userId: "U1" },
      },
    });
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain("1.8.0");
    expect(calls.ephemeral.slice(quietFrom)).toEqual([]);
  });

  it("keeps the form usable in Dispatch and says so when Slack fails", async () => {
    const { svc, calls, deps } = setup();
    const failing = {
      ...deps,
      alerts: new QuestionAlerts(
        pool,
        async () => {
          throw new Error("socket down");
        },
        async () => binding
      ),
    };
    const result = await notifyForm(failing, agent, {
      message: "Which version ships?",
      form,
    });
    expect(result).toMatchObject({ sent: false, delivery: "retrying" });
    expect(result.reason).toMatch(/open in Dispatch/);
    expect(await unanswered(svc, result.form!.id)).toBe(true);
  });

  it("refuses for a child agent before creating anything", async () => {
    const { deps } = setup();
    await pool.query(
      `INSERT INTO agents (id, name, cwd, status, parent_agent_id) VALUES ('agt_notify_child','kid','/tmp','running',$1) ON CONFLICT DO NOTHING`,
      [A]
    );
    const result = await notifyForm(
      deps,
      { id: "agt_notify_child", name: "kid" } as AgentRecord,
      { message: "x", form }
    );
    expect(result).toMatchObject({ sent: false });
    expect(result.form).toBeUndefined();
    const { rowCount } = await pool.query(
      "SELECT 1 FROM blocks WHERE author_agent_id='agt_notify_child'"
    );
    expect(rowCount).toBe(0);
  });
});

describe("thread replies", () => {
  it("answers an open freeform question once; redelivered events don't duplicate", async () => {
    const { svc, answers, calls } = build();
    await linkUser(answers, calls, "U1");
    const q = await ask(svc, answers, calls, {
      question: { options: [{ label: "Postgres" }], allowFreeform: true },
    });
    const event = threadReply(
      "U1",
      q.message.ts,
      "Use &lt;CockroachDB&gt; <https://x.y|docs>",
      {},
      "Ev1"
    );
    const quietFrom = calls.ephemeral.length;
    await answers.handle(event);
    await answers.handle(event);
    const answered = (await svc.store.getById(q.block.id))!;
    expect((answered.state as any).answer).toMatchObject({
      value: "Use <CockroachDB> docs",
      external: { userId: "U1" },
    });
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM blocks WHERE reply_to=$1",
      [q.block.id]
    );
    expect(rows[0].n).toBe(1);
    expect(calls.ephemeral.slice(quietFrom)).toEqual([]);
    expect(calls.updated.at(-1)!.ts).toBe(q.message.ts);
  });

  it("is an ordinary follow-up message (not an answer) for non-freeform or answered asks and notify threads", async () => {
    const { svc, answers, calls } = build();
    await linkUser(answers, calls, "U1");
    const q = await ask(svc, answers, calls, {
      question: { options: [{ label: "Postgres" }] },
    });
    const quietFrom = calls.ephemeral.length;
    await answers.handle(threadReply("U1", q.message.ts, "why not sqlite?"));
    await answers.handle(threadReply("U1", q.message.ts, "or duckdb?"));
    expect(await unanswered(svc, q.block.id)).toBe(true);
    const { rows } = await pool.query(
      "SELECT id, text, to_agent_id, reply_to, data FROM blocks WHERE reply_to=$1 ORDER BY created_at",
      [q.block.id]
    );
    expect(rows).toMatchObject([
      {
        text: "why not sqlite?",
        to_agent_id: A,
        data: { external: { userId: "U1" } },
      },
      { text: "or duckdb?", to_agent_id: A },
    ]);
    // An open question could be mistaken as answered: said once, then quiet.
    expect(calls.ephemeral.slice(quietFrom)).toEqual([
      {
        user: "U1",
        threadTs: q.message.ts,
        text: "Sent to builder-7 as a message — it wasn't recorded as an answer.",
      },
    ]);
    // Another person replying under the same open question hears it once too.
    await linkUser(answers, calls, "U2");
    const u2From = calls.ephemeral.length;
    await answers.handle(threadReply("U2", q.message.ts, "+1 sqlite"));
    await answers.handle(threadReply("U2", q.message.ts, "seriously"));
    expect(calls.ephemeral.slice(u2From).map((e) => [e.user, e.text])).toEqual([
      [
        "U2",
        "Sent to builder-7 as a message — it wasn't recorded as an answer.",
      ],
    ]);
    // Undelivered under an open ask: only the actionable failure, not both.
    live = false;
    const failFrom = calls.ephemeral.length;
    await answers.handle(threadReply("U1", q.message.ts, "still there?"));
    expect(calls.ephemeral.slice(failFrom).map((e) => e.text)).toEqual([
      "Sent to builder-7 as a message (not an answer) · not delivered to builder-7 yet — open Dispatch to retry.",
    ]);
    live = true;

    // Once the question is settled, follow-ups in its thread are quiet too.
    await answers.handle(
      click("U1", q.actions[0].action_id, q.actions[0].value, q.message.ts)
    );
    const afterAnswer = calls.ephemeral.length;
    await answers.handle(threadReply("U1", q.message.ts, "thanks"));
    expect(calls.ephemeral.slice(afterAnswer)).toEqual([]);

    await answers.recordNotify(
      { channelId: "C1", timestamp: "500.000", generation: "gen-1" },
      A
    );
    await answers.handle(threadReply("U1", "500.000", "on it?"));
    const home = await pool.query(
      "SELECT stream_id, to_agent_id, reply_to FROM blocks WHERE text='on it?'"
    );
    expect(home.rows).toEqual([
      { stream_id: A, to_agent_id: A, reply_to: null },
    ]);
    // A routine follow-up in a notify thread: no receipt.
    expect(calls.ephemeral.slice(afterAnswer)).toEqual([]);
  });

  it("retries the not-an-answer notice on the next reply if Slack failed to show it", async () => {
    const { svc, answers, calls, app } = build();
    await linkUser(answers, calls, "U1");
    const q = await ask(svc, answers, calls, {
      question: { options: [{ label: "Postgres" }] },
    });
    const real = app.postEphemeral.bind(app);
    let fail = true;
    (app as any).postEphemeral = async (...args: [string, string, string?]) => {
      if (fail) {
        fail = false;
        throw new Error("slack down");
      }
      return real(...args);
    };
    const quietFrom = calls.ephemeral.length;
    await answers.handle(threadReply("U1", q.message.ts, "why not sqlite?"));
    expect(calls.ephemeral.slice(quietFrom)).toEqual([]);
    await answers.handle(threadReply("U1", q.message.ts, "or duckdb?"));
    await answers.handle(threadReply("U1", q.message.ts, "hello?"));
    expect(calls.ephemeral.slice(quietFrom).map((e) => e.text)).toEqual([
      "Sent to builder-7 as a message — it wasn't recorded as an answer.",
    ]);
  });

  it("still tells the sender when a follow-up wasn't delivered", async () => {
    const { answers, calls } = build();
    await linkUser(answers, calls, "U1");
    await answers.recordNotify(
      { channelId: "C1", timestamp: "600.000", generation: "gen-1" },
      A
    );
    live = false;
    const quietFrom = calls.ephemeral.length;
    await answers.handle(threadReply("U1", "600.000", "you there?"));
    const { rows } = await pool.query(
      "SELECT delivered FROM blocks WHERE text='you there?'"
    );
    expect(rows).toEqual([{ delivered: false }]);
    expect(calls.ephemeral.slice(quietFrom)).toEqual([
      {
        user: "U1",
        threadTs: "600.000",
        text: "Sent to builder-7 as a message · not delivered to builder-7 yet — open Dispatch to retry.",
      },
    ]);
  });

  it("ignores bots, self echoes, edits/deletes, other channels and unknown threads; notices unlinked users once", async () => {
    const { svc, answers, calls } = build();
    await linkUser(answers, calls, "U1");
    const q = await ask(svc, answers, calls, {
      question: { options: [{ label: "A" }], allowFreeform: true },
    });
    const before = calls.ephemeral.length;
    await answers.handle(threadReply("UBOT", q.message.ts, "echo"));
    await answers.handle(
      threadReply("U1", q.message.ts, "bot", { bot_id: "B9" })
    );
    await answers.handle(
      threadReply("U1", q.message.ts, "edit", { subtype: "message_changed" })
    );
    await answers.handle(
      threadReply("U1", q.message.ts, "del", { subtype: "message_deleted" })
    );
    await answers.handle(
      threadReply("U1", q.message.ts, "elsewhere", { channel: "C2" })
    );
    await answers.handle(threadReply("U1", "424242.000", "not ours"));
    expect(calls.ephemeral.length).toBe(before);
    expect(await unanswered(svc, q.block.id)).toBe(true);
    await answers.handle(threadReply("U7", q.message.ts, "me too"));
    await answers.handle(threadReply("U7", q.message.ts, "hello?"));
    expect(calls.ephemeral.slice(before).map((e) => e.text)).toEqual([
      "You're not linked to answer for this Dispatch, so this reply wasn't sent. Ask its owner to link you in Settings.",
    ]);
  });
});

describe("reconcile", () => {
  it("replaces buttons on asks answered in Dispatch, once", async () => {
    const { svc, answers, calls } = build();
    const q = await ask(svc, answers, calls, {
      question: { options: [{ label: "A" }] },
    });
    const { reply } = await svc.answerQuestion(A, q.block.id, { value: "A" });
    // Settle delivery first so only the "answered" render is under test
    // (the sending → delivered re-render is covered above).
    await svc.waitForInFlightDeliveries(1000);
    for (let i = 0; i < 50; i++) {
      if ((await svc.store.getById(reply.id))!.delivered !== null) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await answers.reconcile();
    await answers.reconcile();
    const updates = calls.updated.filter((u) => u.ts === q.message.ts);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.text).toContain('the owner answered "A"');
    expect(updates[0]!.text).not.toMatch(/recorded|delivered|in Dispatch:/);
  });
});
