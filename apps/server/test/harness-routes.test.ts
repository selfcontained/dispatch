import { beforeEach, describe, expect, it } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp();

async function authedGet(url: string) {
  const cookie = await ctx.sessionCookie();
  return ctx.app.inject({ method: "GET", url, headers: { cookie } });
}

async function createAgent(name: string): Promise<string> {
  const cookie = await ctx.sessionCookie();
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/agents",
    headers: { cookie, "content-type": "application/json" },
    payload: { cwd: "/tmp", useWorktree: false, name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().agent.id as string;
}

let agentId: string;

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM agent_stream_events");
  await ctx.pool.query("DELETE FROM agent_chat_messages");
  await ctx.pool.query("DELETE FROM agents");
  agentId = await createAgent("Harnessed");
});

describe("GET /api/v1/agents/:id/harness/turns", () => {
  it("404s for an unknown agent and 400s for a bad limit", async () => {
    expect(
      (await authedGet("/api/v1/agents/agt_nope/harness/turns")).statusCode
    ).toBe(404);
    expect(
      (await authedGet(`/api/v1/agents/${agentId}/harness/turns?limit=abc`))
        .statusCode
    ).toBe(400);
  });

  it("returns assembled turns with the chat prompt joined", async () => {
    const chat = await ctx.pool.query<{ id: string }>(
      `INSERT INTO agent_chat_messages (id, agent_id, author_kind, kind, text, attachments, delivered)
       VALUES (gen_random_uuid(), $1, 'user', 'reply', 'look please', '[]'::jsonb, true)
       RETURNING id`,
      [agentId]
    );
    const chatId = chat.rows[0].id;
    await ctx.pool.query(
      `INSERT INTO agent_stream_events (agent_id, seq, kind, payload) VALUES
        ($1, 1, 'turn', $2::jsonb),
        ($1, 2, 'tool_call', '{"toolKind":"execute","title":"bash","status":"completed","locations":[],"diff":null,"terminalOutput":"ok\\n"}'),
        ($1, 3, 'assistant', '{"text":"hi","streaming":false}')`,
      [
        agentId,
        JSON.stringify({
          state: "settled",
          prompt: { source: "chat", chatMessageId: chatId },
          stopReason: "end_turn",
          endedAt: new Date().toISOString(),
        }),
      ]
    );
    const res = await authedGet(`/api/v1/agents/${agentId}/harness/turns`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      turns: {
        prompt: { source: string; text: string };
        trace: { finalResult?: string; steps: { kind: string }[] };
        result: { text: string; streaming: boolean } | null;
      }[];
    };
    expect(body.turns).toHaveLength(1);
    expect(body.turns[0].prompt).toMatchObject({
      source: "chat",
      text: "look please",
    });
    expect(body.turns[0].trace.finalResult).toBe("ok");
    expect(body.turns[0].trace.steps.map((s) => s.kind)).toEqual(["execute"]);
    expect(body.turns[0].result).toEqual({ text: "hi", streaming: false });
  });
});
