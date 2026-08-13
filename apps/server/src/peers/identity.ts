import crypto from "node:crypto";
import type { Pool } from "pg";

import { getSetting, setSetting } from "../db/settings.js";

/**
 * Durable identity for this Dispatch instance, used in peer pairing and
 * qualified agent addresses. Distinct from the cosmetic, user-editable
 * `instance_name` in routes/system.ts — this one is unique and never shown
 * for vanity purposes.
 */
const INSTANCE_ID_KEY = "instance_id";

export async function getOrCreateInstanceId(pool: Pool): Promise<string> {
  const stored = await getSetting(pool, INSTANCE_ID_KEY);
  if (stored) return stored;
  const id = `inst_${crypto.randomBytes(6).toString("hex")}`;
  await setSetting(pool, INSTANCE_ID_KEY, id);
  return id;
}
