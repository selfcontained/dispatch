import crypto from "node:crypto";
import type { Pool } from "pg";
import bcrypt from "bcryptjs";

const BCRYPT_COST = 12;
const SESSION_TTL_DAYS = 30;

export async function isPasswordSet(pool: Pool): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM settings WHERE key = 'password_hash'"
  );
  return (result.rowCount ?? 0) > 0;
}

export async function setPassword(pool: Pool, password: string): Promise<void> {
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  await pool.query(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ('password_hash', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [hash]
  );
}

export async function verifyPassword(pool: Pool, password: string): Promise<boolean> {
  const result = await pool.query<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'password_hash'"
  );
  if (result.rowCount === 0) return false;
  return bcrypt.compare(password, result.rows[0].value);
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
