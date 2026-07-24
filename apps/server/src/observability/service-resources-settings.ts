import type { Pool } from "pg";

import { getSetting, setSetting } from "../db/settings.js";

export const SERVICE_RESOURCES_COLLECTION_KEY =
  "service_resources_collection_enabled";

export async function readServiceResourcesCollectionEnabled(
  pool: Pool
): Promise<boolean> {
  return (await getSetting(pool, SERVICE_RESOURCES_COLLECTION_KEY)) === "true";
}

export async function writeServiceResourcesCollectionEnabled(
  pool: Pool,
  enabled: boolean
): Promise<void> {
  await setSetting(
    pool,
    SERVICE_RESOURCES_COLLECTION_KEY,
    enabled ? "true" : "false"
  );
}
