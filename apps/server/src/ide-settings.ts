import type { Pool } from "pg";

import { getSetting, setSetting } from "./db/settings.js";
import { sanitizeEnabledIdes, type IdeType } from "./shared/ide-types.js";

export {
  IDE_TYPES,
  sanitizeEnabledIdes,
  type IdeType,
} from "./shared/ide-types.js";

const ENABLED_IDES_KEY = "enabled_ides";

export async function getEnabledIdes(pool: Pool): Promise<IdeType[]> {
  const raw = await getSetting(pool, ENABLED_IDES_KEY);
  if (!raw) {
    return [];
  }

  try {
    return sanitizeEnabledIdes(JSON.parse(raw));
  } catch {
    return [];
  }
}

export async function setEnabledIdes(
  pool: Pool,
  ides: IdeType[]
): Promise<IdeType[]> {
  const sanitized = sanitizeEnabledIdes(ides);
  await setSetting(pool, ENABLED_IDES_KEY, JSON.stringify(sanitized));
  return sanitized;
}
