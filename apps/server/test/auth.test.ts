import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { Pool } from "pg";

import { setupTestDb, teardownTestDb, runTestMigrations } from "./db/setup.js";
import {
  isPasswordSet,
  setPassword,
  verifyPassword,
  createSession,
  validateSession,
  deleteSession,
  deleteAllSessions,
  changePassword,
  cleanExpiredSessions,
  getOrCreateAuthToken,
  getOrCreateCookieSecret,
  createAgentMcpToken,
  validateAgentMcpToken,
  createJobMcpToken,
  validateJobMcpToken,
} from "../src/auth.js";

let pool: Pool;

beforeAll(async () => {
  pool = await setupTestDb();
  await runTestMigrations();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  // Clean state between tests
  await pool.query("DELETE FROM sessions");
  await pool.query("DELETE FROM settings WHERE key LIKE 'password_%' OR key = 'auth_token' OR key = 'cookie_secret'");
});

describe("password management", () => {
  it("reports no password set on fresh DB", async () => {
    expect(await isPasswordSet(pool)).toBe(false);
  });

  it("sets and verifies a password", async () => {
    await setPassword(pool, "hunter2");
    expect(await isPasswordSet(pool)).toBe(true);
    expect(await verifyPassword(pool, "hunter2")).toBe(true);
    expect(await verifyPassword(pool, "wrong")).toBe(false);
  });

  it("verifyPassword returns false when no password is set", async () => {
    expect(await verifyPassword(pool, "anything")).toBe(false);
  });

  it("changePassword succeeds with correct current password", async () => {
    await setPassword(pool, "old-pass");
    const result = await changePassword(pool, "old-pass", "new-pass");
    expect(result).toBe(true);
    expect(await verifyPassword(pool, "new-pass")).toBe(true);
    expect(await verifyPassword(pool, "old-pass")).toBe(false);
  });

  it("changePassword fails with wrong current password", async () => {
    await setPassword(pool, "correct");
    const result = await changePassword(pool, "wrong", "new-pass");
    expect(result).toBe(false);
    // Original password still works
    expect(await verifyPassword(pool, "correct")).toBe(true);
  });
});

describe("session management", () => {
  it("creates and validates a session", async () => {
    const token = await createSession(pool);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    expect(await validateSession(pool, token)).toBe(true);
  });

  it("rejects an invalid session token", async () => {
    expect(await validateSession(pool, "bogus-token")).toBe(false);
  });

  it("deletes a specific session", async () => {
    const token = await createSession(pool);
    expect(await validateSession(pool, token)).toBe(true);

    await deleteSession(pool, token);
    expect(await validateSession(pool, token)).toBe(false);
  });

  it("deleteAllSessions clears every session", async () => {
    const t1 = await createSession(pool);
    const t2 = await createSession(pool);
    expect(await validateSession(pool, t1)).toBe(true);
    expect(await validateSession(pool, t2)).toBe(true);

    await deleteAllSessions(pool);
    expect(await validateSession(pool, t1)).toBe(false);
    expect(await validateSession(pool, t2)).toBe(false);
  });

  it("cleanExpiredSessions removes only expired sessions", async () => {
    const active = await createSession(pool);

    // Manually insert an expired session
    const crypto = await import("node:crypto");
    const expiredToken = crypto.randomUUID();
    const hashed = crypto.createHash("sha256").update(expiredToken).digest("hex");
    await pool.query(
      "INSERT INTO sessions (token, expires_at) VALUES ($1, NOW() - INTERVAL '1 day')",
      [hashed]
    );

    await cleanExpiredSessions(pool);

    // Active session still valid
    expect(await validateSession(pool, active)).toBe(true);
    // Expired session gone
    expect(await validateSession(pool, expiredToken)).toBe(false);
  });
});

describe("auth token and cookie secret", () => {
  it("generates a stable auth token", async () => {
    const token1 = await getOrCreateAuthToken(pool);
    const token2 = await getOrCreateAuthToken(pool);
    expect(token1).toBe(token2);
    expect(token1.length).toBe(64); // 32 bytes hex
  });

  it("generates a stable cookie secret", async () => {
    const secret1 = await getOrCreateCookieSecret(pool);
    const secret2 = await getOrCreateCookieSecret(pool);
    expect(secret1).toBe(secret2);
    expect(secret1.length).toBe(64);
  });

  it("auth token and cookie secret are different values", async () => {
    const token = await getOrCreateAuthToken(pool);
    const secret = await getOrCreateCookieSecret(pool);
    expect(token).not.toBe(secret);
  });

  it("creates agent-scoped MCP tokens that only validate for that agent", async () => {
    const secret = await getOrCreateAuthToken(pool);
    const token = createAgentMcpToken(secret, "agt_123456abcdef");

    expect(validateAgentMcpToken(secret, token, "agt_123456abcdef")).toBe(true);
    expect(validateAgentMcpToken(secret, token, "agt_otheragent")).toBe(false);
  });

  it("creates job-scoped MCP tokens that bind both run and agent", async () => {
    const secret = await getOrCreateAuthToken(pool);
    const token = createJobMcpToken(secret, "run_123", "agt_123456abcdef");

    expect(validateJobMcpToken(secret, token, "run_123", "agt_123456abcdef")).toBe(true);
    expect(validateJobMcpToken(secret, token, "run_other", "agt_123456abcdef")).toBe(false);
    expect(validateJobMcpToken(secret, token, "run_123", "agt_otheragent")).toBe(false);
  });
});
