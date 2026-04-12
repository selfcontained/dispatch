import crypto from "node:crypto";
import type { Pool } from "pg";
import bcrypt from "bcryptjs";

import { getSetting, setSetting } from "./db/settings.js";

const BCRYPT_COST = 12;
const SESSION_TTL_DAYS = 30;

// SHA-256 is safe here because session tokens are random UUIDs (122 bits of entropy).
// Do not reuse this for user-supplied or low-entropy values.
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createMcpScopeToken(secret: string, scope: string): string {
  const payload = Buffer.from(scope, "utf-8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(scope).digest("base64url");
  return `${payload}.${signature}`;
}

function validateMcpScopeToken(secret: string, token: string, expectedScope: string): boolean {
  const expected = createMcpScopeToken(secret, expectedScope);
  const actualBuffer = Buffer.from(token, "utf-8");
  const expectedBuffer = Buffer.from(expected, "utf-8");
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export async function isPasswordSet(pool: Pool): Promise<boolean> {
  return (await getSetting(pool, "password_hash")) !== null;
}

export async function setPassword(pool: Pool, password: string): Promise<void> {
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  await setSetting(pool, "password_hash", hash);
}

export async function verifyPassword(pool: Pool, password: string): Promise<boolean> {
  const hash = await getSetting(pool, "password_hash");
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

export async function createSession(pool: Pool): Promise<string> {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    "INSERT INTO sessions (token, expires_at) VALUES ($1, $2)",
    [hashToken(token), expiresAt]
  );
  return token;
}

export async function validateSession(pool: Pool, token: string): Promise<boolean> {
  const hashed = hashToken(token);
  // Single query checks both hashed and legacy plaintext tokens to avoid timing side-channel
  const result = await pool.query(
    "SELECT token FROM sessions WHERE (token = $1 OR token = $2) AND expires_at > NOW() LIMIT 1",
    [hashed, token]
  );
  if ((result.rowCount ?? 0) === 0) return false;

  // Upgrade legacy plaintext token to hashed in-place
  const matched = result.rows[0].token as string;
  if (matched !== hashed) {
    await pool.query("UPDATE sessions SET token = $1 WHERE token = $2", [hashed, matched]);
  }
  return true;
}

export async function deleteSession(pool: Pool, token: string): Promise<void> {
  await pool.query("DELETE FROM sessions WHERE token = $1 OR token = $2", [hashToken(token), token]);
}

export async function deleteAllSessions(pool: Pool): Promise<void> {
  await pool.query("DELETE FROM sessions");
}

export async function changePassword(
  pool: Pool,
  currentPassword: string,
  newPassword: string
): Promise<boolean> {
  const valid = await verifyPassword(pool, currentPassword);
  if (!valid) return false;
  await setPassword(pool, newPassword);
  return true;
}

export async function cleanExpiredSessions(pool: Pool): Promise<void> {
  await pool.query("DELETE FROM sessions WHERE expires_at <= NOW()");
}

/**
 * Returns a stable auth token for agent-to-server communication, persisted in the settings table.
 * Generated automatically on first run and reused across restarts.
 */
export async function getOrCreateAuthToken(pool: Pool): Promise<string> {
  const stored = await getSetting(pool, "auth_token");
  if (stored) return stored;

  const token = crypto.randomBytes(32).toString("hex");
  await setSetting(pool, "auth_token", token);
  return token;
}

export function isMcpRoute(url: string): boolean {
  return url === "/api/mcp" || url.startsWith("/api/mcp/");
}

export function isScopedMcpRoute(url: string): boolean {
  return /^\/api\/mcp\/[^/]+$/.test(url) || /^\/api\/mcp\/jobs\/[^/]+\/[^/]+$/.test(url);
}

export function shouldAcceptApiBearerToken(url: string, token: string, serverAuthToken: string): boolean {
  return token === serverAuthToken;
}

export function createAgentMcpToken(secret: string, agentId: string): string {
  return createMcpScopeToken(secret, `agent:${agentId}`);
}

export function validateAgentMcpToken(secret: string, token: string, agentId: string): boolean {
  return validateMcpScopeToken(secret, token, `agent:${agentId}`);
}

export function createJobMcpToken(secret: string, runId: string, agentId: string): string {
  return createMcpScopeToken(secret, `job:${runId}:${agentId}`);
}

export function validateJobMcpToken(secret: string, token: string, runId: string, agentId: string): boolean {
  return validateMcpScopeToken(secret, token, `job:${runId}:${agentId}`);
}

/**
 * Returns a stable cookie-signing secret, persisted in the settings table.
 * Generated automatically on first run and reused across restarts.
 */
export async function getOrCreateCookieSecret(pool: Pool): Promise<string> {
  const stored = await getSetting(pool, "cookie_secret");
  if (stored) return stored;

  const secret = crypto.randomBytes(32).toString("hex");
  await setSetting(pool, "cookie_secret", secret);
  return secret;
}
