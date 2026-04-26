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
  /**
   * Host-level recovery context the framework prompt embeds inline so
   * the agent has one canonical instruction set (no need to stitch a
   * separate recovery skeleton on top). All values come from server.ts;
   * this module never reads env or process state.
   */
  recovery: AssistedRecoveryContext;
};

export type AssistedRecoveryContext = {
  /** e.g. "systemctl --user restart dispatch" or launchctl kickstart. */
  serviceCommand: string;
  /** Local health endpoint URL the agent can curl to verify recovery. */
  healthEndpoint: string;
  /** Path to the main service log on disk. */
  serviceLogPath: string;
  /** Path the failed-deploy summary gets written to. */
  failureLogPath: string;
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

  const prompt = renderAssistedPrompt(
    state,
    baseUrl,
    input.serverDir,
    input.recovery
  );
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
  await writeAssistedUpdateState(state);
  const allPassed = results.every((r) => r.ok);
  if (allPassed) return state;

  // Route the failed-checks → blocked transition through the canonical
  // helper so it goes through `isLegalTransition` (no-op when state is
  // already terminal at rollback/blocked/failed) and the same
  // persist + completedAt stamping every other phase change uses.
  const transition = await applyAssistedPhase({
    token: state.token,
    phase: "blocked",
    error: "one or more required checks failed",
  });
  return transition.ok ? transition.state : state;
}

export { isAssistedUpdateRequired };

function renderAssistedPrompt(
  state: AssistedUpdateState,
  baseUrl: string,
  serverDir: string,
  recovery: AssistedRecoveryContext
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
    `Primary objective:`,
    `1. Update Dispatch to ${tag}.`,
    `2. If restart or health fails, restore the Dispatch service first.`,
    `3. After service is healthy again, diagnose what went wrong and leave a concise report in the terminal.`,
    ``,
    `## Release context`,
    ``,
    `- target: ${tag}`,
    `- installed: ${fromTag ?? "(unknown)"}`,
    `- platform: ${platform}`,
    `- service dir: ${serverDir}`,
    `- mode: ${metadata.mode}`,
    `- health endpoint: ${recovery.healthEndpoint}`,
    `- service restart command: ${recovery.serviceCommand}`,
    `- main service log: ${recovery.serviceLogPath}`,
    `- failure log path: ${recovery.failureLogPath}`,
    `- API base URL env: $DISPATCH_API_URL`,
    `- Bearer token env: $DISPATCH_RELEASE_UPDATE_TOKEN`,
    ``,
    `## Guardrails`,
    ``,
    `- Operate on ${serverDir}, not the user's development worktree.`,
    `- Do not edit secrets or .env unless explicitly required to restore service and you can explain why.`,
    `- Do not make source-code changes as part of the recovery path unless absolutely necessary.`,
    `- Do not assume release.json points to a healthy rollback target after a failed deploy; confirm the last healthy tag from git/service history before rolling back.`,
    `- Restore service availability before deeper diagnosis.`,
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
    `Suggested per-phase work:`,
    `- inspect: capture current repo/tag/service state and confirm the install is recoverable.`,
    `- prepare: line up artifacts and any migration-specific scaffolding from "Instructions".`,
    `- apply: invoke the managed update endpoint, e.g.`,
    `    \`curl -sf -X POST "$DISPATCH_API_URL/api/v1/release/update" -H "Content-Type: application/json" -H "Authorization: Bearer $DISPATCH_RELEASE_UPDATE_TOKEN" -d '{"tag":"${tag}"}'\``,
    `- restarting: wait for the service to come back via the health endpoint.`,
    `- validate: run the metadata's "Required checks" against the new install (the framework will re-run them server-side too).`,
    ``,
    `If you cannot proceed, report \`blocked\` with a reason. If you have to`,
    `revert state, report \`rollback\` after restoring service to the last`,
    `confirmed healthy tag. Reaching a terminal phase ends the run.`,
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
