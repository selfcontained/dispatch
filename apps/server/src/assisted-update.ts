import os from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";

const MAX_NOTE_BYTES = 4096;

function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function clampNote(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return s.length > MAX_NOTE_BYTES ? s.slice(0, MAX_NOTE_BYTES) : s;
}
import {
  isAssistedUpdateRequired,
  normalizeRequiredChecks,
  type AssistedUpdateMetadata,
} from "./release-metadata.js";
import {
  ASSISTED_PHASES,
  isLegalTransition,
  isTerminalPhase,
  readAssistedUpdateState,
  writeAssistedUpdateState,
  type AssistedPhase,
  type AssistedUpdateState,
} from "./assisted-update-store.js";
import { runRequiredChecks, type CheckContext } from "./release-checks.js";

export type StartAssistedUpdateInput = {
  tag: string;
  fromTag: string | null;
  metadata: AssistedUpdateMetadata;
};

export type AssistedAgentContext = {
  state: AssistedUpdateState;
  /** Pre-rendered prompt the agent receives as its initial instruction. */
  prompt: string;
  /** Where the agent should run — defaults to ~/.dispatch/server. */
  cwd: string;
};

const DEFAULT_SERVER_DIR =
  process.env.DISPATCH_SERVER_DIR ??
  // We intentionally avoid pulling node:path here so this module is easy to
  // import in unit tests; the orchestrator passes an explicit cwd anyway.
  `${os.homedir()}/.dispatch/server`;

export async function buildAssistedUpdateContext(
  input: StartAssistedUpdateInput,
  baseUrl: string
): Promise<AssistedAgentContext> {
  const state: AssistedUpdateState = {
    tag: input.tag,
    fromTag: input.fromTag,
    metadata: input.metadata,
    requiredChecks: normalizeRequiredChecks(input.metadata),
    phase: "inspect",
    token: randomBytes(24).toString("base64url"),
    agentId: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    checks: [],
    notes: {},
  };
  await writeAssistedUpdateState(state);

  const prompt = renderAssistedPrompt(state, baseUrl);
  return { state, prompt, cwd: DEFAULT_SERVER_DIR };
}

/**
 * Apply a phase transition reported by the running agent. Validates the
 * transition (cannot move backward, cannot leave a terminal state) and
 * persists state so an operator can see what was reached even if the agent
 * crashes.
 */
export async function applyAssistedPhase(input: {
  token: string;
  phase: AssistedPhase;
  note?: string;
  error?: string;
}): Promise<
  { ok: true; state: AssistedUpdateState } | { ok: false; reason: string }
> {
  const state = await readAssistedUpdateState();
  if (!state) return { ok: false, reason: "no active assisted update" };
  if (!tokensEqual(state.token, input.token))
    return { ok: false, reason: "invalid token" };
  if (!ASSISTED_PHASES.includes(input.phase)) {
    return { ok: false, reason: `unknown phase: ${input.phase}` };
  }
  if (!isLegalTransition(state.phase, input.phase)) {
    return {
      ok: false,
      reason: `illegal transition ${state.phase} -> ${input.phase}`,
    };
  }
  state.phase = input.phase;
  state.updatedAt = new Date().toISOString();
  // Cap the per-phase strings before they hit disk + SSE replay so a
  // misbehaving agent can't bloat ~/.dispatch/assisted-update.json or
  // every snapshot reconnect.
  const note = clampNote(input.note);
  const error = clampNote(input.error);
  if (note) state.notes[input.phase] = note;
  if (error) state.error = error;
  if (isTerminalPhase(input.phase)) {
    state.completedAt = state.completedAt ?? new Date().toISOString();
  }
  await writeAssistedUpdateState(state);
  return { ok: true, state };
}

export async function attachAssistedAgent(
  token: string,
  agentId: string
): Promise<AssistedUpdateState | null> {
  const state = await readAssistedUpdateState();
  if (!state || !tokensEqual(state.token, token)) return null;
  state.agentId = agentId;
  state.updatedAt = new Date().toISOString();
  await writeAssistedUpdateState(state);
  return state;
}

/**
 * Run the metadata's `requiredChecks` set and return their results. The
 * orchestrator persists results onto state so operators can see exactly what
 * passed before the framework marked the job successful.
 */
export async function runAndRecordChecks(
  state: AssistedUpdateState,
  ctx: CheckContext
): Promise<AssistedUpdateState> {
  const results = await runRequiredChecks(state.requiredChecks, ctx);
  state.checks = results;
  state.updatedAt = new Date().toISOString();
  const allPassed = results.every((r) => r.ok);
  if (!allPassed && state.phase !== "rollback" && state.phase !== "blocked") {
    state.phase = "blocked";
    state.error = state.error ?? "one or more required checks failed";
    state.completedAt = state.completedAt ?? new Date().toISOString();
  }
  await writeAssistedUpdateState(state);
  return state;
}

export { isAssistedUpdateRequired };

function renderAssistedPrompt(
  state: AssistedUpdateState,
  baseUrl: string
): string {
  const { metadata, tag, fromTag, requiredChecks, token } = state;
  const checksList =
    requiredChecks.length > 0
      ? requiredChecks.map((c) => `  - ${c}`).join("\n")
      : "  (none)";
  const platform = `${process.platform}/${process.arch}`;
  const phaseUrl = `${baseUrl.replace(/\/$/, "")}/api/v1/release/update/assisted/phase`;

  return [
    `# Assisted release update`,
    ``,
    `You have been launched as an update agent for the Dispatch service.`,
    `Your job is to perform a migration-driven upgrade and report structured`,
    `phases back to the release job so an operator can see progress.`,
    ``,
    `## Release context`,
    ``,
    `- target: ${tag}`,
    `- installed: ${fromTag ?? "(unknown)"}`,
    `- platform: ${platform}`,
    `- service dir: ${DEFAULT_SERVER_DIR}`,
    `- mode: ${metadata.mode}`,
    ``,
    `## Title`,
    ``,
    metadata.title,
    ``,
    `## Summary`,
    ``,
    metadata.summary,
    ``,
    metadata.instructions
      ? `## Instructions\n\n${metadata.instructions}\n`
      : "",
    `## Required checks (must all pass before reporting "validate" → "done")`,
    ``,
    checksList,
    ``,
    metadata.rollbackGuidance
      ? `## Rollback guidance\n\n${metadata.rollbackGuidance}\n`
      : "",
    `## Phase reporting`,
    ``,
    `Move through these phases in order, reporting each one BEFORE you start it:`,
    ``,
    `  inspect → prepare → apply → restarting → validate → done`,
    ``,
    `If you cannot proceed, report \`blocked\` with a reason. If you have to`,
    `revert state, report \`rollback\`. Reaching a terminal phase ends the run.`,
    ``,
    `Report a phase by POSTing to:`,
    ``,
    `  ${phaseUrl}`,
    ``,
    `with body: { "token": "${token}", "phase": "<name>", "note": "<short note>" }`,
    ``,
    `If you fail, include an "error" field describing why. The framework will`,
    `re-run the configured \`requiredChecks\` after you report \`validate\`,`,
    `and will only mark the release successful if all of them pass.`,
    ``,
    `Begin by reporting phase=inspect with a brief note about the current`,
    `install state.`,
    ``,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}
