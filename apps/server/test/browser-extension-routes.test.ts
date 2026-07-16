import crypto from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { cleanupBrowserExtensionData } from "../src/routes/browser-extension.js";
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
         (id, agent_id, comment, page_context, element_context, created_at)
       VALUES
         ($1, 'agt_old', 'Old feedback', '{}'::jsonb, '{}'::jsonb,
          now() - interval '91 days'),
         ($2, 'agt_current', 'Current feedback', '{}'::jsonb, '{}'::jsonb,
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
         (id, name, type, status, cwd, worktree_branch, latest_event_type,
          latest_event_message, latest_event_updated_at)
       VALUES
         ('agt_running', 'Running agent', 'codex', 'running', '/secret/repo',
          'feature/browser', 'working', 'Building extension', now()),
         ('agt_stopped', 'Stopped agent', 'codex', 'stopped', '/other/repo',
          null, null, null, null)`
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
    expect(body.agents).toHaveLength(1);
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
    const body = response.json<{ submissionId: string; status: string }>();
    expect(body.status).toBe("failed");
    const stored = await ctx.pool.query<{
      delivery_status: string;
      comment: string;
      page_context: { url: string };
      element_context: {
        xpath: string;
        ancestors: Array<{ accessibleName: string }>;
        nearbyElements: Array<{ relation: string; text: string }>;
        searchHints: string[];
      };
    }>(
      `SELECT delivery_status, comment, page_context, element_context
         FROM browser_feedback_submissions WHERE id = $1`,
      [body.submissionId]
    );
    expect(stored.rows[0]).toMatchObject({
      delivery_status: "failed",
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

  it("rejects oversized untrusted context before delivery", async () => {
    const { token } = await approveAndExchange();
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/browser-extension/submissions",
      headers: { authorization: `Bearer ${token}` },
      payload: {
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
