import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { StreamService, type StreamAgent } from "../src/chat/service.js";
import {
  SlackAnswers,
  stableUuid,
} from "../src/notifications/slack-answers.js";
import type {
  SlackApp,
  SlackBinding,
  SlackInbound,
} from "../src/notifications/slack-app.js";
import { runTestMigrations, setupTestDb, teardownTestDb } from "./db/setup.js";

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
    // Returned before the engine took it: in flight, never "delivered".
    expect(calls.ephemeral.at(-1)!.text).toBe(
      'Recorded "Postgres" · sending to builder-7 — delivery status is in Dispatch.'
    );
    const settled = calls.updated.find((u) => u.ts === q.message.ts)!;
    expect(settled.text).toContain("Answered by @u1 in Slack");
    expect(settled.text).toContain("sending to the agent");
    expect(
      settled.blocks
        .find((b: any) => b.type === "actions")
        .elements.map((e: any) => e.action_id)
    ).toEqual(["dispatch_open"]);
    // Still in flight: reconcile leaves it alone.
    await answers.reconcile();
    expect(calls.updated.filter((u) => u.ts === q.message.ts)).toHaveLength(1);
    // Once the engine takes it, the Slack message is re-rendered once.
    release();
    await svc.waitForInFlightDeliveries(1000);
    expect(injected.at(-1)).toContain(
      "from: user via Slack (@u1, linked identity"
    );
    for (let i = 0; i < 50; i++) {
      if ((await svc.store.getById(reply.id))!.delivered !== null) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await answers.reconcile();
    await answers.reconcile();
    const renders = calls.updated.filter((u) => u.ts === q.message.ts);
    expect(renders).toHaveLength(2);
    expect(renders[1]!.text).toContain("delivered to the agent");
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
    const recorded = calls.ephemeral.filter((e) => /^Recorded/.test(e.text));
    expect(recorded).toHaveLength(1);
    const winner = recorded[0]!.user;
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

  it("rejects stale (changed), cancelled, wrong-generation and Dispatch-only asks", async () => {
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

    const gated = await ask(svc, answers, calls, {
      question: { options: [{ label: "Merge" }], dispatchOnly: true },
    });
    expect(gated.actions.map((e: any) => e.action_id)).toEqual([
      "dispatch_open",
    ]);
    const ref = await pool.query(
      "SELECT id FROM slack_messages WHERE block_id=$1",
      [gated.block.id]
    );
    await answers.handle(
      click("U1", "dispatch_option:0", `${ref.rows[0].id}:0`, gated.message.ts)
    );
    expect(calls.ephemeral.at(-1)!.text).toMatch(/answer in Dispatch/);
    await answers.handle(threadReply("U1", gated.message.ts, "yes merge it"));
    expect(calls.ephemeral.at(-1)!.text).toMatch(/answer in Dispatch/);
    expect(await unanswered(svc, gated.block.id)).toBe(true);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM blocks WHERE reply_to=$1",
      [gated.block.id]
    );
    expect(rows[0].n).toBe(0);

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

  it("records durably and says not delivered (no auto-resume promise) when the agent is offline", async () => {
    const { svc, answers, calls } = build();
    await linkUser(answers, calls, "U1");
    const q = await ask(svc, answers, calls, {
      question: { options: [{ label: "Postgres" }] },
    });
    live = false;
    await answers.handle(
      click("U1", q.actions[0].action_id, q.actions[0].value, q.message.ts)
    );
    const answered = (await svc.store.getById(q.block.id))!;
    const reply = (await svc.store.getById(
      (answered.state as any).answer.blockId
    ))!;
    expect(reply.delivered).toBe(false);
    expect(calls.ephemeral.at(-1)!.text).toBe(
      'Recorded "Postgres" · not delivered to builder-7 yet — open Dispatch to retry.'
    );
    expect(calls.updated.at(-1)!.text).toContain(
      "not delivered to the agent yet — open Dispatch to retry"
    );
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
    await answers.handle(event);
    await answers.handle(event);
    const answered = (await svc.store.getById(q.block.id))!;
    expect((answered.state as any).answer).toMatchObject({
      value: "Use <CockroachDB> docs",
      external: { userId: "U1" },
    });
    expect(
      calls.ephemeral.filter((e) => /Recorded as your answer/.test(e.text))
    ).toHaveLength(1);
    expect(calls.ephemeral.at(-1)!.threadTs).toBe(q.message.ts);
  });

  it("is an ordinary follow-up message (not an answer) for non-freeform or answered asks and notify threads", async () => {
    const { svc, answers, calls } = build();
    await linkUser(answers, calls, "U1");
    const q = await ask(svc, answers, calls, {
      question: { options: [{ label: "Postgres" }] },
    });
    await answers.handle(threadReply("U1", q.message.ts, "why not sqlite?"));
    expect(await unanswered(svc, q.block.id)).toBe(true);
    const { rows } = await pool.query(
      "SELECT id, text, to_agent_id, reply_to, data FROM blocks WHERE reply_to=$1",
      [q.block.id]
    );
    expect(rows).toMatchObject([
      {
        text: "why not sqlite?",
        to_agent_id: A,
        data: { external: { userId: "U1" } },
      },
    ]);
    expect(calls.ephemeral.at(-1)!.text).toMatch(
      /as a message \(not an answer\)/
    );

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
    await svc.answerQuestion(A, q.block.id, { value: "A" });
    await answers.reconcile();
    await answers.reconcile();
    const updates = calls.updated.filter((u) => u.ts === q.message.ts);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.text).toContain("Answered by the owner in Dispatch");
  });
});
