import type { Pool } from "pg";
import type { AgentType, Effort } from "@dispatch/shared";
import { getSetting, setSetting } from "./db/settings.js";
import { validateAgentEffort } from "./shared/agent-effort.js";

const KEY = "default_effort";
/** Missing row preserves medium; JSON null explicitly delegates to CLI settings. */
export async function getDefaultEffort(pool: Pool): Promise<Effort | null> {
  const raw = await getSetting(pool, KEY);
  return raw === null
    ? "medium"
    : validateAgentEffort("claude", JSON.parse(raw));
}
export async function setDefaultEffort(
  pool: Pool,
  value: unknown
): Promise<Effort | null> {
  if (value === undefined)
    throw new Error("effort is required; use null to let CLI settings decide.");
  const effort = validateAgentEffort("claude", value);
  await setSetting(pool, KEY, JSON.stringify(effort));
  return effort;
}
export async function resolveAgentEffort(
  pool: Pool,
  type: AgentType,
  requested: unknown
): Promise<Effort | null> {
  const explicit = validateAgentEffort(type, requested);
  // OpenCode has no equivalent; the app default only applies to supported runtimes.
  if (explicit !== null || type === "opencode") return explicit;
  return validateAgentEffort(type, await getDefaultEffort(pool));
}
