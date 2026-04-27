import os from "node:os";
import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type {
  AssistedUpdateMetadata,
  RequiredCheckName,
} from "./release-metadata.js";
import type { CheckResult } from "./release-checks.js";
import type { UpdateMigrationManifest } from "./update-migrations.js";

export const ASSISTED_PHASES = [
  "inspect",
  "prepare",
  "apply",
  "restarting",
  "validate",
  "done",
  "rollback",
  "blocked",
  "failed",
] as const;
export type AssistedPhase = (typeof ASSISTED_PHASES)[number];

/**
 * Phase order used for "the agent must move forward, not backward" guards.
 * `rollback`, `blocked`, and `failed` are terminal/sideways and may be
 * reached from any earlier phase.
 */
const FORWARD_ORDER: AssistedPhase[] = [
  "inspect",
  "prepare",
  "apply",
  "restarting",
  "validate",
  "done",
];

const TERMINAL: AssistedPhase[] = ["done", "rollback", "blocked", "failed"];

export type AssistedUpdateState = {
  tag: string;
  fromTag: string | null;
  /**
   * Legacy release-scoped assisted-update metadata. Set on runs gated by
   * the `dispatch-update` block in the release body. Mutually exclusive
   * with `migrations` — exactly one of the two drives a given run.
   */
  metadata: AssistedUpdateMetadata | null;
  /**
   * Ordered pending migration manifests snapshotted at launch time. New
   * preferred path (CRU-146). When set, drives prompt rendering and the
   * apply-on-success bookkeeping. When null, the run falls back to
   * `metadata` for the legacy single-block flow.
   */
  migrations: UpdateMigrationManifest[] | null;
  requiredChecks: RequiredCheckName[];
  phase: AssistedPhase;
  /** Random nonce; the launched agent uses this to authenticate phase POSTs. */
  token: string;
  agentId: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
  checks: CheckResult[];
  /** Short structured notes the agent has emitted, keyed by phase. */
  notes: Partial<Record<AssistedPhase, string>>;
};

export const ASSISTED_UPDATE_STORE_PATH = path.join(
  os.homedir(),
  ".dispatch",
  "assisted-update.json"
);

export async function readAssistedUpdateState(): Promise<AssistedUpdateState | null> {
  try {
    const raw = await readFile(ASSISTED_UPDATE_STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as AssistedUpdateState;
    // Light sanity check; missing fields means the file is from an older
    // version and should be ignored rather than crashing the boot.
    if (
      typeof parsed.tag !== "string" ||
      typeof parsed.phase !== "string" ||
      typeof parsed.token !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeAssistedUpdateState(
  state: AssistedUpdateState
): Promise<void> {
  await mkdir(path.dirname(ASSISTED_UPDATE_STORE_PATH), { recursive: true });
  const tmp = `${ASSISTED_UPDATE_STORE_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  await rename(tmp, ASSISTED_UPDATE_STORE_PATH);
}

export async function clearAssistedUpdateState(): Promise<void> {
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(ASSISTED_UPDATE_STORE_PATH);
  } catch {
    // best effort
  }
}

/**
 * Validate that `next` is a legal transition from `current`. Forward moves
 * along FORWARD_ORDER are allowed (skipping is allowed — e.g., the agent may
 * jump straight from `inspect` to `failed` if it can't proceed). Terminal
 * states cannot transition further.
 */
export function isLegalTransition(
  current: AssistedPhase,
  next: AssistedPhase
): boolean {
  if (current === next) return true;
  if (TERMINAL.includes(current)) return false;
  if (TERMINAL.includes(next)) return true;
  const ci = FORWARD_ORDER.indexOf(current);
  const ni = FORWARD_ORDER.indexOf(next);
  if (ci === -1 || ni === -1) return false;
  return ni > ci;
}

// `phase` accepts any string so callers holding the broader ReleasePhase
// union (server.ts) don't need an extra cast — the membership check is
// what determines the answer, and unknown phases correctly return false.
export function isTerminalPhase(phase: string): boolean {
  return (TERMINAL as readonly string[]).includes(phase);
}
