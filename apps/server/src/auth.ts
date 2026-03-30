import crypto from "node:crypto";
import type { Pool } from "pg";
import bcrypt from "bcryptjs";

import { getSetting, setSetting } from "./db/settings.js";

const BCRYPT_COST = 12;
const SESSION_TTL_DAYS = 30;

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
    [token, expiresAt]
  );
  return token;
}

export async function validateSession(pool: Pool, token: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM sessions WHERE token = $1 AND expires_at > NOW()",
    [token]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteSession(pool: Pool, token: string): Promise<void> {
  await pool.query("DELETE FROM sessions WHERE token = $1", [token]);
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
 * Returns a stable cookie-signing secret, persisted in the settings table.
 * If COOKIE_SECRET env var is set, that value is used (and persisted).
 * Otherwise, the DB value is returned — or a new one is generated on first run.
 */
export async function getOrCreateCookieSecret(pool: Pool): Promise<string> {
  const envSecret = process.env.COOKIE_SECRET;
  const stored = await getSetting(pool, "cookie_secret");

  if (envSecret) {
    if (stored !== envSecret) {
      await setSetting(pool, "cookie_secret", envSecret);
    }
    return envSecret;
  }

  if (stored) return stored;

  const secret = crypto.randomUUID();
  await setSetting(pool, "cookie_secret", secret);
  return secret;
}
