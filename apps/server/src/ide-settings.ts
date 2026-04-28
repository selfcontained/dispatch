import type { Pool } from "pg";

import { getSetting, setSetting } from "./db/settings.js";

export const IDE_TYPES = ["vscode", "cursor"] as const;
export type IdeType = (typeof IDE_TYPES)[number];

const ENABLED_IDES_KEY = "enabled_ides";

function isIdeType(value: unknown): value is IdeType {
  return typeof value === "string" && IDE_TYPES.includes(value as IdeType);
}

export function sanitizeEnabledIdes(value: unknown): IdeType[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isIdeType)
    .filter((type, index, types) => types.indexOf(type) === index);
}

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
