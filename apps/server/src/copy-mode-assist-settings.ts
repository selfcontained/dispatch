import type { Pool } from "pg";

import { getSetting } from "./db/settings.js";

export const COPY_MODE_ASSIST_ENABLED_KEY = "copy_mode_assist_enabled";

export function parseBooleanSetting(
  value: string | null,
  defaultValue: boolean
): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return defaultValue;
}

export async function getCopyModeAssistEnabled(pool: Pool): Promise<boolean> {
  return parseBooleanSetting(
    await getSetting(pool, COPY_MODE_ASSIST_ENABLED_KEY),
    false
  );
}
