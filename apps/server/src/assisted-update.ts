import { randomBytes } from "node:crypto";
import { tokensEqual } from "./auth.js";
import { sanitizeAgentString } from "./shared/lib/agent-strings.js";
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
  /**
   * The directory the launched agent will run in. Owned by the caller
   * (server.ts) so this module stays a pure orchestrator with no
   * environment lookups of its own.
   */
  serverDir: string;
};

export type AssistedAgentContext = {
  state: AssistedUpdateState;
  /** Pre-rendered prompt the agent receives as its initial instruction. */
  prompt: string;
};

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

  const prompt = renderAssistedPrompt(state, baseUrl, input.serverDir);
  return { state, prompt };
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
  // Sanitize the per-phase strings before they hit disk + SSE replay so
  // a misbehaving agent can't bloat ~/.dispatch/assisted-update.json,
  // every snapshot reconnect, or the operator log line projection in
  // server.ts. The single sanitization point covers all consumers.
  const note = sanitizeAgentString(input.note);
  const error = sanitizeAgentString(input.error);
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
  baseUrl: string,
  serverDir: string
): string {
  const { metadata, tag, fromTag, requiredChecks, token } = state;
  const checksList =
    requiredChecks.length > 0
      ? requiredChecks.map((c) => `  - ${c}`).join("\n")
      : "  (none)";
  const platform = `${process.platform}/${process.arch}`;
  const phaseUrl = `${baseUrl.replace(/\/$/, "")}/api/v1/release/assisted/phase`;

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
    `- service dir: ${serverDir}`,
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
