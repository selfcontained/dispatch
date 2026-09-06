import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants, zstdCompressSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";

import { useInjectApp } from "./helpers/inject-app.js";

const dshHome = await mkdtemp(path.join(os.tmpdir(), "dsh-home-"));
const ctx = useInjectApp({ env: { DISPATCH_DSH_HOME: dshHome } });

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
    // No harness runs in this app: the queue is empty, and present.
    expect((res.json() as { queued: unknown[] }).queued).toEqual([]);
  });
});

describe("POST /api/v1/agents/:id/harness/interrupt", () => {
  it("409s when nothing is running and 404s for an unknown agent", async () => {
    const cookie = await ctx.sessionCookie();
    const idle = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/harness/interrupt`,
      headers: { cookie },
    });
    expect(idle.statusCode).toBe(409);
    const missing = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/agents/agt_nope/harness/interrupt`,
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("harness queue routes", () => {
  it("404 when the message is not queued, and for an unknown agent", async () => {
    const cookie = await ctx.sessionCookie();
    const sendNow = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/harness/queue/not-queued/send-now`,
      headers: { cookie },
    });
    expect(sendNow.statusCode).toBe(404);
    expect(sendNow.json().error).toMatch(/no longer queued/);
    const remove = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/agents/${agentId}/harness/queue/not-queued`,
      headers: { cookie },
    });
    expect(remove.statusCode).toBe(404);
    const missing = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/agents/agt_nope/harness/queue/x`,
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("Agent not found.");
  });
});

describe("GET /api/v1/agents/:id/harness/subagents/:sessionId", () => {
  const CHILD = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
  const frame = (text: string) =>
    zstdCompressSync(text, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });

  it("serves a child session of this agent and refuses anyone else's", async () => {
    await ctx.pool.query(
      "UPDATE agents SET cli_session_id = $2 WHERE id = $1",
      [agentId, "parent-session"]
    );
    const dir = path.join(dshHome, "sessions", "--w--", CHILD);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "session.jsonl.zstd"),
      Buffer.concat([
        frame(
          `{"type":"session","version":0,"id":"${CHILD}","cwd":"/w","parentSession":"parent-session","origin":"subagent","delegationDepth":1}\n`
        ),
        frame(
          '{"type":"subagent/descriptor","seq":0,"time":1000,"data":{"label":"Look around"}}\n' +
            '{"type":"user/message","seq":1,"time":1001,"data":{"content":[{"type":"text","text":"look"}]}}\n' +
            '{"type":"assistant/message","seq":2,"time":1002,"data":{"message":{"role":"assistant","content":[{"type":"text","text":"Nothing here."}]}}}\n' +
            '{"type":"turn/end","seq":3,"time":1003,"data":{"turn":1,"reason":{"kind":"completed"}}}\n'
        ),
      ])
    );
    const res = await authedGet(
      `/api/v1/agents/${agentId}/harness/subagents/${CHILD}`
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      subagent: {
        label: string;
        status: string;
        turns: { result: { text: string } }[];
      };
    };
    expect(body.subagent.label).toBe("Look around");
    expect(body.subagent.status).toBe("finished");
    expect(body.subagent.turns[0].result.text).toBe("Nothing here.");

    // Another agent (a different parent session) cannot read it.
    const other = await createAgent("Other");
    expect(
      (await authedGet(`/api/v1/agents/${other}/harness/subagents/${CHILD}`))
        .statusCode
    ).toBe(404);
    expect(
      (
        await authedGet(
          `/api/v1/agents/${agentId}/harness/subagents/00000000-0000-4000-8000-000000000000`
        )
      ).statusCode
    ).toBe(404);
    expect(
      (await authedGet(`/api/v1/agents/${agentId}/harness/subagents/../etc`))
        .statusCode
    ).toBe(404);
  });
});
