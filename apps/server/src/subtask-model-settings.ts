import type { Pool } from "pg";

import { getSetting, setSetting } from "./db/settings.js";

/**
 * Whether a persona or subagent launched without an explicit model drops to a
 * cheaper tier in the same provider family. On by default: a reviewer reads a
 * diff that already exists, which is not the work the top tier is bought for.
 *
 * An explicit `model` at the call site always wins, so this only ever changes
 * launches that expressed no preference. Read once per launch, like the
 * guidance flags, and composed at launch, so a flip only affects agents
 * started afterwards.
 *
 * Unset reads as on; an explicit `"false"` is honoured.
 */
const SUBTASK_MODEL_DOWNSHIFT_KEY = "subtask_model_downshift";

export async function isSubtaskModelDownshiftEnabled(
  pool: Pool
): Promise<boolean> {
  return (await getSetting(pool, SUBTASK_MODEL_DOWNSHIFT_KEY)) !== "false";
}

export async function setSubtaskModelDownshiftEnabled(
  pool: Pool,
  enabled: boolean
): Promise<void> {
  await setSetting(
    pool,
    SUBTASK_MODEL_DOWNSHIFT_KEY,
    enabled ? "true" : "false"
  );
}
