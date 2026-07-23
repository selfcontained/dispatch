import crypto from "node:crypto";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRecord } from "../src/agents/manager.js";
import {
  cleanupBrowserExtensionData,
  registerBrowserExtensionRoutes,
} from "../src/routes/browser-extension.js";
import { useInjectApp } from "./helpers/inject-app.js";

const ctx = useInjectApp();
let pairingClientIndex = 1;

async function createPairing(deviceName = "Chrome on test machine") {
  const remoteAddress = `127.0.0.${pairingClientIndex++}`;
  const response = await ctx.app.inject({
    method: "POST",
    url: "/api/v1/auth/browser-extension/pairings",
    remoteAddress,
    payload: {
      deviceName,
      dispatchUrl: "http://127.0.0.1:6767",
    },
  });
  expect(response.statusCode).toBe(200);
  return {
    ...response.json<{
      pairingId: string;
      pairingSecret: string;
      code: string;
      verificationPath: string;
      expiresAt: string;
    }>(),
    remoteAddress,
  };
}

async function approveAndExchange(deviceName?: string) {
  const pairing = await createPairing(deviceName);
  const cookie = await ctx.sessionCookie();
  const approval = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/browser-extension/pairings/${pairing.pairingId}/approve`,
    remoteAddress: pairing.remoteAddress,
    headers: { cookie },
    payload: { code: pairing.code },
  });
  expect(approval.statusCode).toBe(200);

  const exchange = await ctx.app.inject({
    method: "POST",
    url: `/api/v1/auth/browser-extension/pairings/${pairing.pairingId}/exchange`,
    payload: { pairingSecret: pairing.pairingSecret },
  });
  expect(exchange.statusCode).toBe(200);
  const body = exchange.json<{ status: "approved"; token: string }>();
  expect(body.status).toBe("approved");
  expect(body.token).toBeTruthy();
  const tokenResult = await ctx.pool.query<{ token_id: string }>(
    "SELECT token_id FROM browser_extension_pairings WHERE id = $1",
    [pairing.pairingId]
  );
  return {
    ...pairing,
    token: body.token,
    tokenId: tokenResult.rows[0].token_id,
  };
}

function submissionPayload(clientSubmissionId = crypto.randomUUID()) {
  return {
    clientSubmissionId,
    agentId: "agt_running",
    comment: "The spacing collapses here.",
    page: { url: "http://localhost:3000/checkout", title: "Checkout" },
    element: {
      tagName: "section",
      selector: "main > section.checkout-summary",
      text: "Order summary",
    },
  };
}

async function createSubmissionTestApp(
  sendAgentPrompt: (agentId: string, prompt: string) => Promise<void>,
  opts: {
    mediaRoot?: string;
    publishUiEvent?: (event: { type: string; agentId: string }) => void;
  } = {}
) {
  const app = Fastify({ logger: false });
  const runningAgent = {
    id: "agt_running",
    status: "running",
  } as AgentRecord;
  await registerBrowserExtensionRoutes(app, {
    pool: ctx.pool,
    agentManager: {
      getAgent: async (agentId) =>
        agentId === runningAgent.id ? runningAgent : null,
      listAgents: async () => [runningAgent],
    },
    sendAgentPrompt,
    mediaRoot: opts.mediaRoot,
    publishUiEvent: opts.publishUiEvent,
  });
  return app;
}

// Smallest valid 1x1 PNG; its bytes start with the PNG signature the route checks.
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

beforeEach(async () => {
  await ctx.pool.query("DELETE FROM browser_feedback_submissions");
  await ctx.pool.query("DELETE FROM browser_extension_pairings");
  await ctx.pool.query("DELETE FROM browser_extension_tokens");
  await ctx.pool.query("DELETE FROM agents");
});

describe("browser extension pairing", () => {
  it("creates a public pairing while storing only secret hashes", async () => {
    const pairing = await createPairing();

    expect(pairing.pairingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(pairing.pairingSecret.length).toBeGreaterThanOrEqual(32);
    expect(pairing.code).toMatch(/^\d{6}$/);
    expect(pairing.verificationPath).toBe(
      `/settings/connections?browserExtensionPairing=${pairing.pairingId}&code=${pairing.code}`
    );
    expect(new Date(pairing.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const stored = await ctx.pool.query<{
      pairing_secret_hash: string;
      code_hash: string;
    }>(
      `SELECT pairing_secret_hash, code_hash
         FROM browser_extension_pairings WHERE id = $1`,
      [pairing.pairingId]
    );
    expect(stored.rows[0].pairing_secret_hash).not.toBe(pairing.pairingSecret);
    expect(stored.rows[0].code_hash).not.toBe(pairing.code);
  });

  it("removes expired pairing secrets and old feedback records", async () => {
    const expired = await createPairing("Expired Chrome");
    const current = await createPairing("Current Chrome");
    await ctx.pool.query(
      `UPDATE browser_extension_pairings
          SET expires_at = now() - interval '1 second',
              token_ciphertext = 'ciphertext',
              token_iv = 'iv',
              token_auth_tag = 'tag'
        WHERE id = $1`,
      [expired.pairingId]
    );
    await ctx.pool.query(
      `INSERT INTO browser_feedback_submissions
         (id, client_submission_id, agent_id, comment, page_context,
          element_context, created_at)
       VALUES
         ($1, $1, 'agt_old', 'Old feedback', '{}'::jsonb, '{}'::jsonb,
          now() - interval '91 days'),
         ($2, $2, 'agt_current', 'Current feedback', '{}'::jsonb, '{}'::jsonb,
          now())`,
      [crypto.randomUUID(), crypto.randomUUID()]
    );

    await cleanupBrowserExtensionData(ctx.pool);

    const pairings = await ctx.pool.query<{ id: string }>(
      "SELECT id FROM browser_extension_pairings ORDER BY id"
    );
    expect(pairings.rows.map((row) => row.id)).toEqual([current.pairingId]);
    const submissions = await ctx.pool.query<{ comment: string }>(
      "SELECT comment FROM browser_feedback_submissions"
    );
    expect(submissions.rows).toEqual([{ comment: "Current feedback" }]);
  });

  it("stays pending until session-authenticated approval, then exchanges once", async () => {
    const pairing = await createPairing();
    const pending = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/auth/browser-extension/pairings/${pairing.pairingId}/exchange`,
      payload: { pairingSecret: pairing.pairingSecret },
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toEqual({ status: "pending" });

    const unauthenticatedApproval = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/browser-extension/pairings/${pairing.pairingId}/approve`,
      remoteAddress: pairing.remoteAddress,
      payload: { code: pairing.code },
    });
    expect(unauthenticatedApproval.statusCode).toBe(401);

    const cookie = await ctx.sessionCookie();
    const approval = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/browser-extension/pairings/${pairing.pairingId}/approve`,
      remoteAddress: pairing.remoteAddress,
      headers: { cookie },
      payload: { code: pairing.code },
    });
    expect(approval.statusCode).toBe(200);

    const exchange = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/auth/browser-extension/pairings/${pairing.pairingId}/exchange`,
      payload: { pairingSecret: pairing.pairingSecret },
    });
    expect(exchange.statusCode).toBe(200);
    const approved = exchange.json<{ status: string; token: string }>();
    expect(approved.status).toBe("approved");
    expect(approved.token.length).toBeGreaterThanOrEqual(32);

    const tokenRow = await ctx.pool.query<{ token_hash: string }>(
      "SELECT token_hash FROM browser_extension_tokens"
    );
    expect(tokenRow.rows[0].token_hash).not.toBe(approved.token);

    const repeated = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/auth/browser-extension/pairings/${pairing.pairingId}/exchange`,
      payload: { pairingSecret: pairing.pairingSecret },
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual({
      status: "approved",
      token: approved.token,
    });
  });

  it("rejects invalid, incorrect, and expired pairing credentials", async () => {
    const invalidId = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/auth/browser-extension/pairings/not-a-uuid/exchange",
      payload: { pairingSecret: "x".repeat(32) },
    });
    expect(invalidId.statusCode).toBe(400);

    const pairing = await createPairing();
    const wrongSecret = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/auth/browser-extension/pairings/${pairing.pairingId}/exchange`,
      payload: { pairingSecret: "x".repeat(32) },
    });
    expect(wrongSecret.statusCode).toBe(401);

    const cookie = await ctx.sessionCookie();
    const wrongCode = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/browser-extension/pairings/${pairing.pairingId}/approve`,
      remoteAddress: pairing.remoteAddress,
      headers: { cookie },
      payload: { code: pairing.code === "000000" ? "000001" : "000000" },
    });
    expect(wrongCode.statusCode).toBe(404);

    await ctx.pool.query(
      "UPDATE browser_extension_pairings SET expires_at = now() - interval '1 second' WHERE id = $1",
      [pairing.pairingId]
    );
    const expiredExchange = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/auth/browser-extension/pairings/${pairing.pairingId}/exchange`,
      payload: { pairingSecret: pairing.pairingSecret },
    });
    expect(expiredExchange.statusCode).toBe(401);
    const expiredApproval = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/browser-extension/pairings/${pairing.pairingId}/approve`,
      remoteAddress: pairing.remoteAddress,
      headers: { cookie },
      payload: { code: pairing.code },
    });
    expect(expiredApproval.statusCode).toBe(404);
  });
});

describe("browser extension connection management", () => {
  it("lists and independently revokes active paired browsers", async () => {
    const first = await approveAndExchange("Chrome profile one");
    const second = await approveAndExchange("Chrome profile two");

    const unauthenticated = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/browser-extension/connections",
    });
    expect(unauthenticated.statusCode).toBe(401);

    const used = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/browser-extension/agents",
      headers: { authorization: `Bearer ${first.token}` },
    });
    expect(used.statusCode).toBe(200);

    const cookie = await ctx.sessionCookie();
    const list = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/browser-extension/connections",
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{
      connections: Array<{
        id: string;
        deviceName: string;
        createdAt: string;
        expiresAt: string;
        lastUsedAt: string | null;
      }>;
    }>();
    expect(body.connections).toHaveLength(2);
    expect(body.connections.map((connection) => connection.deviceName)).toEqual(
      expect.arrayContaining(["Chrome profile one", "Chrome profile two"])
    );
    expect(
      body.connections.find((connection) => connection.id === first.tokenId)
    ).toMatchObject({
      deviceName: "Chrome profile one",
      lastUsedAt: expect.any(String),
    });
    expect(
      body.connections.find((connection) => connection.id === second.tokenId)
    ).toMatchObject({
      deviceName: "Chrome profile two",
      lastUsedAt: null,
    });
    expect(body.connections[0]).not.toHaveProperty("tokenHash");
    expect(body.connections[0]).not.toHaveProperty("scopes");

    const revoke = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/browser-extension/connections/${first.tokenId}`,
      headers: { cookie },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toEqual({ ok: true });

    const firstAfterRevoke = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/browser-extension/agents",
      headers: { authorization: `Bearer ${first.token}` },
    });
    const secondAfterRevoke = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/browser-extension/agents",
      headers: { authorization: `Bearer ${second.token}` },
    });
    expect(firstAfterRevoke.statusCode).toBe(401);
    expect(secondAfterRevoke.statusCode).toBe(200);

    const remaining = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/browser-extension/connections",
      headers: { cookie },
    });
    expect(
      remaining.json<{ connections: Array<{ id: string }> }>().connections
    ).toEqual([expect.objectContaining({ id: second.tokenId })]);
  });

  it("validates connection ids and returns not found for stale entries", async () => {
    const cookie = await ctx.sessionCookie();
    const invalid = await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/browser-extension/connections/not-a-uuid",
      headers: { cookie },
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/browser-extension/connections/00000000-0000-4000-8000-000000000000",
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("browser extension scoped API", () => {
  it("keeps multiple browser pairings independently authorized", async () => {
    const first = await approveAndExchange("Chrome profile one");
    const second = await approveAndExchange("Chrome profile two");
    expect(first.token).not.toBe(second.token);

    for (const token of [first.token, second.token]) {
      const response = await ctx.app.inject({
        method: "GET",
        url: "/api/v1/browser-extension/agents",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
    }

    await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/browser-extension/token",
      headers: { authorization: `Bearer ${first.token}` },
    });

    const firstAfterRevoke = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/browser-extension/agents",
      headers: { authorization: `Bearer ${first.token}` },
    });
    const secondAfterRevoke = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/browser-extension/agents",
      headers: { authorization: `Bearer ${second.token}` },
    });
    expect(firstAfterRevoke.statusCode).toBe(401);
    expect(secondAfterRevoke.statusCode).toBe(200);
  });

  it("revokes the scoped token when the extension disconnects", async () => {
    const { token } = await approveAndExchange();
    const revoke = await ctx.app.inject({
      method: "DELETE",
      url: "/api/v1/browser-extension/token",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toEqual({ ok: true });

    const afterRevoke = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/browser-extension/agents",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it("lists only sanitized running agents and rejects the master token", async () => {
    await ctx.pool.query(
      `INSERT INTO agents
         (id, name, type, role, status, cwd, worktree_branch, latest_event_type,
          latest_event_message, latest_event_updated_at)
       VALUES
         ('agt_running', 'Running agent', 'codex', 'standard', 'running',
          '/secret/repo', 'feature/browser', 'working', 'Building extension',
          now()),
         ('agt_stopped', 'Stopped agent', 'codex', 'standard', 'stopped',
          '/other/repo', null, null, null, null),
         ('agt_review', 'Review agent', 'codex', 'review', 'running',
          '/secret/repo', 'feature/browser', 'working', 'Reviewing', now())`
    );
    const { token } = await approveAndExchange();

    const masterToken = await ctx.pool.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'auth_token'"
    );
    const rejected = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/browser-extension/agents",
      headers: { authorization: `Bearer ${masterToken.rows[0].value}` },
    });
    expect(rejected.statusCode).toBe(401);

    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/browser-extension/agents",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ agents: Array<Record<string, unknown>> }>();
    // Only the running standard agent — the stopped one and the running review
    // agent are both excluded.
    expect(body.agents).toHaveLength(1);
    expect(body.agents.map((agent) => agent.id)).toEqual(["agt_running"]);
    expect(body.agents[0]).toMatchObject({
      id: "agt_running",
      name: "Running agent",
      status: "running",
      branch: "feature/browser",
      latestEvent: { type: "working", message: "Building extension" },
    });
    expect(body.agents[0]).not.toHaveProperty("cwd");
    expect(body.agents[0]).not.toHaveProperty("tmuxSession");
  });

  it("persists a failed submission when prompt injection is unavailable", async () => {
    await ctx.pool.query(
      `INSERT INTO agents (id, name, type, status, cwd)
       VALUES ('agt_running', 'Running agent', 'codex', 'running', '/tmp/repo')`
    );
    const { token } = await approveAndExchange();
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/browser-extension/submissions",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        clientSubmissionId: crypto.randomUUID(),
        agentId: "agt_running",
        comment: "The spacing collapses here.",
        page: { url: "http://localhost:3000/checkout", title: "Checkout" },
        element: {
          tagName: "section",
          selector: "main > section.checkout-summary",
          xpath: "//*[@data-testid='checkout-summary']",
          text: "Order summary",
          outerHtml:
            '<section class="checkout-summary">Order summary</section>',
          ancestors: [
            {
              depth: 1,
              tagName: "main",
              selector: "main",
              id: null,
              classes: ["checkout"],
              role: "main",
              accessibleName: "Checkout",
              text: "Order summary Place order",
            },
          ],
          nearbyElements: [
            {
              depth: 1,
              tagName: "button",
              selector: "button.place-order",
              id: null,
              classes: ["place-order"],
              role: null,
              accessibleName: "Place order",
              text: "Place order",
              relation: "next-sibling",
              relativeToDepth: 0,
            },
          ],
          searchHints: [
            'data-testid="checkout-summary"',
            'text: "Order summary"',
          ],
        },
      },
    });

    expect(response.statusCode).toBe(502);
    const body = response.json<{
      submissionId: string;
      status: string;
      error: string;
    }>();
    expect(body.status).toBe("failed");
    expect(body.error).toBe("Prompt delivery failed.");
    expect(body.error).not.toContain("terminal session");
    const stored = await ctx.pool.query<{
      delivery_status: string;
      delivery_error: string;
      comment: string;
      page_context: { url: string };
      element_context: {
        xpath: string;
        ancestors: Array<{ accessibleName: string }>;
        nearbyElements: Array<{ relation: string; text: string }>;
        searchHints: string[];
      };
    }>(
      `SELECT delivery_status, delivery_error, comment, page_context, element_context
         FROM browser_feedback_submissions WHERE id = $1`,
      [body.submissionId]
    );
    expect(stored.rows[0]).toMatchObject({
      delivery_status: "failed",
      delivery_error:
        "Agent has no active terminal session — prompt cannot be delivered.",
      comment: "The spacing collapses here.",
      page_context: { url: "http://localhost:3000/checkout" },
      element_context: {
        xpath: "//*[@data-testid='checkout-summary']",
        ancestors: [{ accessibleName: "Checkout" }],
        nearbyElements: [{ relation: "next-sibling", text: "Place order" }],
        searchHints: [
          'data-testid="checkout-summary"',
          'text: "Order summary"',
        ],
      },
    });
  });

  it("reconciles a successful duplicate retry without redelivering", async () => {
    const { token } = await approveAndExchange();
    const sendAgentPrompt = vi.fn(async () => undefined);
    const app = await createSubmissionTestApp(sendAgentPrompt);
    const payload = submissionPayload();

    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/browser-extension/submissions",
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
      expect(first.statusCode).toBe(200);

      // Simulate the extension losing the successful response and retrying the
      // same logical submission with its retained client id.
      const retry = await app.inject({
        method: "POST",
        url: "/api/v1/browser-extension/submissions",
        headers: { authorization: `Bearer ${token}` },
        payload,
      });

      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual(first.json());
      expect(sendAgentPrompt).toHaveBeenCalledTimes(1);
      const stored = await ctx.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM browser_feedback_submissions
          WHERE client_submission_id = $1`,
        [payload.clientSubmissionId]
      );
      expect(stored.rows[0].count).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("returns pending for a concurrent duplicate without redelivering", async () => {
    const { token } = await approveAndExchange();
    let markDeliveryStarted!: () => void;
    let releaseDelivery!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const deliveryBlocked = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const sendAgentPrompt = vi.fn(async () => {
      markDeliveryStarted();
      await deliveryBlocked;
    });
    const app = await createSubmissionTestApp(sendAgentPrompt);
    const payload = submissionPayload();

    try {
      const firstResponse = app.inject({
        method: "POST",
        url: "/api/v1/browser-extension/submissions",
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
      await deliveryStarted;

      const concurrent = await app.inject({
        method: "POST",
        url: "/api/v1/browser-extension/submissions",
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
      expect(concurrent.statusCode).toBe(202);
      expect(concurrent.json()).toMatchObject({ status: "pending" });

      releaseDelivery();
      const delivered = await firstResponse;
      expect(delivered.statusCode).toBe(200);
      expect(concurrent.json<{ submissionId: string }>().submissionId).toBe(
        delivered.json<{ submissionId: string }>().submissionId
      );
      expect(sendAgentPrompt).toHaveBeenCalledTimes(1);
    } finally {
      releaseDelivery();
      await app.close();
    }
  });

  it("stores an attached screenshot as media and links it in the prompt", async () => {
    await ctx.pool.query(
      `INSERT INTO agents (id, name, type, status, cwd)
       VALUES ('agt_running', 'Running agent', 'codex', 'running', '/tmp/repo')`
    );
    const { token } = await approveAndExchange();
    const mediaRoot = await mkdtemp(path.join(os.tmpdir(), "dispatch-media-"));
    const prompts: string[] = [];
    const events: Array<{ type: string; agentId: string }> = [];
    const app = await createSubmissionTestApp(
      async (_agentId, prompt) => {
        prompts.push(prompt);
      },
      { mediaRoot, publishUiEvent: (event) => events.push(event) }
    );

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/browser-extension/submissions",
        headers: { authorization: `Bearer ${token}` },
        payload: { ...submissionPayload(), screenshot: ONE_PIXEL_PNG_BASE64 },
      });
      expect(response.statusCode).toBe(200);

      const media = await ctx.pool.query<{
        file_name: string;
        source: string;
        size_bytes: number;
      }>(
        `SELECT file_name, source, size_bytes FROM media WHERE agent_id = $1`,
        ["agt_running"]
      );
      expect(media.rows).toHaveLength(1);
      expect(media.rows[0].source).toBe("screenshot");
      expect(media.rows[0].file_name).toMatch(/^browser-selection-.*\.png$/);
      expect(media.rows[0].size_bytes).toBeGreaterThan(0);

      const savedPath = path.join(
        mediaRoot,
        "agt_running",
        media.rows[0].file_name
      );
      await expect(stat(savedPath)).resolves.toBeDefined();

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(savedPath);
      expect(events).toContainEqual({
        type: "media.changed",
        agentId: "agt_running",
      });
    } finally {
      await app.close();
    }
  });

  it("ignores an attached screenshot that is not a PNG", async () => {
    await ctx.pool.query(
      `INSERT INTO agents (id, name, type, status, cwd)
       VALUES ('agt_running', 'Running agent', 'codex', 'running', '/tmp/repo')`
    );
    const { token } = await approveAndExchange();
    const mediaRoot = await mkdtemp(path.join(os.tmpdir(), "dispatch-media-"));
    const prompts: string[] = [];
    const app = await createSubmissionTestApp(
      async (_agentId, prompt) => {
        prompts.push(prompt);
      },
      { mediaRoot }
    );

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/browser-extension/submissions",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          ...submissionPayload(),
          screenshot: Buffer.from("not a png").toString("base64"),
        },
      });
      expect(response.statusCode).toBe(200);
      const media = await ctx.pool.query(
        `SELECT 1 FROM media WHERE agent_id = $1`,
        ["agt_running"]
      );
      expect(media.rows).toHaveLength(0);
      expect(prompts[0]).not.toContain("is saved at:");
    } finally {
      await app.close();
    }
  });

  it("gives concurrent screenshots distinct filenames and files", async () => {
    await ctx.pool.query(
      `INSERT INTO agents (id, name, type, status, cwd)
       VALUES ('agt_running', 'Running agent', 'codex', 'running', '/tmp/repo')`
    );
    const { token } = await approveAndExchange();
    const mediaRoot = await mkdtemp(path.join(os.tmpdir(), "dispatch-media-"));
    const prompts: string[] = [];
    const app = await createSubmissionTestApp(
      async (_agentId, prompt) => {
        prompts.push(prompt);
      },
      { mediaRoot }
    );

    try {
      const [first, second] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/v1/browser-extension/submissions",
          headers: { authorization: `Bearer ${token}` },
          payload: { ...submissionPayload(), screenshot: ONE_PIXEL_PNG_BASE64 },
        }),
        app.inject({
          method: "POST",
          url: "/api/v1/browser-extension/submissions",
          headers: { authorization: `Bearer ${token}` },
          payload: { ...submissionPayload(), screenshot: ONE_PIXEL_PNG_BASE64 },
        }),
      ]);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);

      const media = await ctx.pool.query<{ file_name: string }>(
        `SELECT file_name FROM media WHERE agent_id = $1 ORDER BY id`,
        ["agt_running"]
      );
      const fileNames = media.rows.map((row) => row.file_name);
      expect(fileNames).toHaveLength(2);
      expect(new Set(fileNames).size).toBe(2);
      for (const fileName of fileNames) {
        await expect(
          stat(path.join(mediaRoot, "agt_running", fileName))
        ).resolves.toBeDefined();
        expect(prompts.some((p) => p.includes(fileName))).toBe(true);
      }
    } finally {
      await app.close();
    }
  });

  it("prunes expired browser-feedback screenshots but keeps fresh/other media", async () => {
    await ctx.pool.query(
      `INSERT INTO agents (id, name, type, status, cwd)
       VALUES ('agt_running', 'Running agent', 'codex', 'running', '/tmp/repo')`
    );
    const mediaRoot = await mkdtemp(path.join(os.tmpdir(), "dispatch-media-"));
    const agentDir = path.join(mediaRoot, "agt_running");
    await mkdir(agentDir, { recursive: true });

    const staleName = `browser-selection-old-${crypto.randomUUID()}.png`;
    const freshName = `browser-selection-new-${crypto.randomUUID()}.png`;
    const uploadName = "user-upload.png"; // not a browser-feedback screenshot
    for (const name of [staleName, freshName, uploadName]) {
      await writeFile(path.join(agentDir, name), Buffer.from("x"));
    }
    await ctx.pool.query(
      `INSERT INTO media (agent_id, file_name, source, size_bytes, created_at)
       VALUES
         ('agt_running', $1, 'screenshot', 1, now() - interval '91 days'),
         ('agt_running', $2, 'screenshot', 1, now()),
         ('agt_running', $3, 'screenshot', 1, now() - interval '91 days')`,
      [staleName, freshName, uploadName]
    );

    await cleanupBrowserExtensionData(ctx.pool, mediaRoot);

    const remaining = await ctx.pool.query<{ file_name: string }>(
      `SELECT file_name FROM media WHERE agent_id = $1 ORDER BY file_name`,
      ["agt_running"]
    );
    const names = remaining.rows.map((row) => row.file_name);
    expect(names).toContain(freshName);
    expect(names).toContain(uploadName);
    expect(names).not.toContain(staleName);

    await expect(stat(path.join(agentDir, staleName))).rejects.toThrow();
    await expect(stat(path.join(agentDir, freshName))).resolves.toBeDefined();
  });

  it("requires a UUID client submission id", async () => {
    const { token } = await approveAndExchange();
    const { clientSubmissionId: _clientSubmissionId, ...payload } =
      submissionPayload();
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/browser-extension/submissions",
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

    expect(response.statusCode).toBe(400);
    const count = await ctx.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM browser_feedback_submissions"
    );
    expect(count.rows[0].count).toBe(0);
  });

  it("rejects oversized untrusted context before delivery", async () => {
    const { token } = await approveAndExchange();
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/browser-extension/submissions",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        clientSubmissionId: crypto.randomUUID(),
        agentId: "agt_running",
        comment: "x".repeat(10_001),
        page: { url: "http://localhost:3000" },
        element: { tagName: "div", selector: "div" },
      },
    });
    expect(response.statusCode).toBe(400);
    const count = await ctx.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM browser_feedback_submissions"
    );
    expect(count.rows[0].count).toBe(0);
  });
});
