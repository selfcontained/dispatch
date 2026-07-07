import type { Pool } from "pg";

import { getSetting, setSetting } from "../db/settings.js";

const PROVIDER_QUOTA_TRACKING_ENABLED_KEY = "provider_quota_tracking_enabled";

export async function isProviderQuotaTrackingEnabled(
  pool: Pool
): Promise<boolean> {
  const raw = await getSetting(pool, PROVIDER_QUOTA_TRACKING_ENABLED_KEY);
  return raw !== "false";
}

export async function setProviderQuotaTrackingEnabled(
  pool: Pool,
  enabled: boolean
): Promise<void> {
  await setSetting(pool, PROVIDER_QUOTA_TRACKING_ENABLED_KEY, String(enabled));
}
