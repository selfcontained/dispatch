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
import type { UpdateMigrationManifest } from "./update-migrations.js";
import { markMigrationsApplied } from "./applied-migrations-store.js";
import { clearEvaluatorCache } from "./update-migrations-evaluator.js";
import { fixedRuntimePath } from "./server/release-helpers.js";

export type StartAssistedUpdateInput = {
  tag: string;
  fromTag: string | null;
  /**
   * Either `metadata` (legacy single-block release-scoped run) or
   * `migrations` (preferred manifest-driven run, CRU-146) is required.
   */
  metadata?: AssistedUpdateMetadata;
  migrations?: UpdateMigrationManifest[];
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
  const migrations = input.migrations ?? null;
  const metadata = input.metadata ?? null;
  if (!migrations && !metadata) {
    throw new Error(
      "buildAssistedUpdateContext requires either migrations or metadata"
    );
  }
  const requiredChecks: string[] = migrations
    ? unionMigrationChecks(migrations)
    : normalizeRequiredChecks(metadata!);
  // Always prove the running executable's version, even when no manifest
  // asks for it. Manifests can't name this check yet (pre-v0.33 runtimes
  // reject unknown check names at parse time), and release.json-based
  // checks alone false-green when a pinned service entrypoint restarts back
  // into the old binary.
  if (!requiredChecks.includes("running_version")) {
    requiredChecks.push("running_version");
  }

  const state: AssistedUpdateState = {
    tag: input.tag,
    fromTag: input.fromTag,
    metadata,
    migrations,
    requiredChecks,
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

  // Intentionally NOT persisted here. If `agentManager.createAgent` later
  // fails in `release/assisted/launch`, a state file with `agentId: null`
  // would be left behind and `rehydrateActiveAssistedJob` would resurrect
  // it on next boot/reconnect as a phantom in-flight run with no owner.
  // The launch endpoint persists state via `attachAssistedAgent` once the
  // agent is created — that's the first durable write.

  const prompt = renderAssistedPrompt(
    state,
    baseUrl,
    input.serverDir,
    input.recovery
  );
  return { state, prompt };
}

function unionMigrationChecks(migrations: UpdateMigrationManifest[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const m of migrations) {
    for (const c of m.validation.requiredChecks) {
      if (seen.has(c)) continue;
      seen.add(c);
      ordered.push(c);
    }
  }
  return ordered;
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

/**
 * First durable persistence of the assisted-update state. Called by the
 * launch endpoint AFTER `agentManager.createAgent` succeeds, so a failed
 * createAgent can never leave a phantom record on disk that
 * `rehydrateActiveAssistedJob` would resurrect at boot.
 *
 * This is the single point where state.agentId transitions from null to a
 * real agent id; subsequent updates flow through `applyAssistedPhase`.
 */
export async function attachAssistedAgent(
  state: AssistedUpdateState,
  agentId: string
): Promise<AssistedUpdateState> {
  state.agentId = agentId;
  state.updatedAt = new Date().toISOString();
  await writeAssistedUpdateState(state);
  return state;
}

/**
 * Run the run's `requiredChecks` set and return their results. The
 * orchestrator persists results onto state so operators can see exactly
 * what passed before the framework marked the job successful. When the run
 * is migrations-driven (CRU-146) and every check passes, mark each pending
 * migration ID applied locally so the next `release/info` poll picks the
 * change up.
 */
export async function runAndRecordChecks(
  state: AssistedUpdateState,
  ctx: CheckContext
): Promise<AssistedUpdateState> {
  // Enforce running_version at check-run time as well as launch time: a run
  // launched by an older server (whose state.requiredChecks predates the
  // check) is often validated by the freshly restarted target binary — this
  // code — so appending here closes the gap for in-flight upgrades.
  const names = state.requiredChecks.includes("running_version")
    ? state.requiredChecks
    : [...state.requiredChecks, "running_version"];
  const results = await runRequiredChecks(names, ctx);
  state.checks = results;
  state.updatedAt = new Date().toISOString();
  await writeAssistedUpdateState(state);
  const allPassed = results.every((r) => r.ok);
  if (!allPassed) {
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

  // Migrations-driven success path: record every pending migration ID as
  // applied, atomically, before reporting success upstream. The whole
  // pending set is marked together — v1 is all-or-nothing per the issue.
  if (state.migrations && state.migrations.length > 0) {
    const ids = state.migrations.map((m) => m.id);
    try {
      await markMigrationsApplied(ids, state.tag);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const transition = await applyAssistedPhase({
        token: state.token,
        phase: "blocked",
        error: `failed to record migration apply state: ${message}`,
      });
      return transition.ok ? transition.state : state;
    }
    // Force the next `release/info` poll to re-evaluate so applied IDs
    // disappear from `pendingMigrations`.
    clearEvaluatorCache();
  }
  return state;
}

export { isAssistedUpdateRequired };

function renderAssistedPrompt(
  state: AssistedUpdateState,
  baseUrl: string,
  serverDir: string,
  recovery: AssistedRecoveryContext
): string {
  const { tag, fromTag, requiredChecks, token, migrations, metadata } = state;
  const checksList =
    requiredChecks.length > 0
      ? requiredChecks.map((c) => `  - ${c}`).join("\n")
      : "  (none)";
  const platform = `${process.platform}/${process.arch}`;
  const phaseUrl = `${baseUrl.replace(/\/$/, "")}/api/v1/release/assisted/phase`;
  const modeLabel = migrations
    ? `migration-driven (${migrations.length} pending)`
    : (metadata?.mode ?? "unknown");

  const migrationSections =
    migrations && migrations.length > 0
      ? renderMigrationSections(migrations)
      : renderLegacyMetadataSections(metadata);

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
    `- mode: ${modeLabel}`,
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
    `- Edit a service definition only when a pending migration explicitly identifies it as supported and user-owned. Otherwise stop and report the required operator action; never invent a service, elevate privileges, or alter a system-owned definition.`,
    `- Treat release.json as the last confirmed healthy release; inspect release-candidate.json when an activation was interrupted.`,
    `- Restore service availability before deeper diagnosis.`,
    ``,
    `## Service architecture and recovery model`,
    ``,
    `- Dispatch runs from the fixed executable at \`${fixedRuntimePath(serverDir)}\`.`,
    `- The managed update endpoint verifies a release artifact, atomically replaces that executable, retains an adjacent .previous rollback file, then restarts the service.`,
    `- A newly healthy target promotes release-candidate.json into release.json.`,
    ``,
    `## Rollback recovery`,
    ``,
    `- Prefer the managed endpoint first. Use manual recovery only after it fails or the service does not restart cleanly.`,
    `- Manual rollback sequence: replace the fixed executable with its adjacent .previous file, then run the service restart command.`,
    `- Validate service health with ${recovery.healthEndpoint} before reporting \`rollback\` or continuing diagnosis.`,
    ``,
    migrationSections,
    `## Required checks (must all pass before reporting "validate" → "done")`,
    ``,
    checksList,
    ``,
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

function renderMigrationSections(
  migrations: UpdateMigrationManifest[]
): string {
  const sections: string[] = [
    `## Pending migrations`,
    ``,
    `This run includes ${migrations.length} pending migration${
      migrations.length === 1 ? "" : "s"
    }. Treat them as one ordered plan: walk each in order, evaluate the`,
    `\`alreadySatisfied\` condition first, perform the migration only if it`,
    `is not already satisfied, then continue to the next. The framework`,
    `runs the union of every \`validation.requiredChecks\` after you report`,
    `\`validate\`, and only marks all migrations applied when every check`,
    `passes. If validation fails, none of this run's migrations are marked`,
    `applied — the operator can re-run the assisted flow.`,
    ``,
  ];

  migrations.forEach((m, idx) => {
    const heading = `### Migration ${idx + 1}/${migrations.length}: ${m.title} (id: \`${m.id}\`)`;
    sections.push(heading, ``);
    sections.push(`**Summary**`, ``, m.summary.trim(), ``);
    sections.push(
      `**Already satisfied?**`,
      ``,
      m.alreadySatisfied.description.trim(),
      ``
    );
    sections.push(
      `**Instructions**`,
      ``,
      ...m.instructions.map((step) => `- ${step}`),
      ``
    );
    if (m.validation.requiredChecks.length > 0) {
      sections.push(
        `**Validation checks for this migration**`,
        ``,
        ...m.validation.requiredChecks.map((c) => `- ${c}`),
        ``
      );
    }
    if (m.rollback.length > 0) {
      sections.push(
        `**Rollback**`,
        ``,
        ...m.rollback.map((step) => `- ${step}`),
        ``
      );
    }
  });

  return sections.join("\n");
}

function renderLegacyMetadataSections(
  metadata: AssistedUpdateMetadata | null
): string {
  if (!metadata) return "";
  const sections: string[] = [
    `## Title`,
    ``,
    metadata.title,
    ``,
    `## Summary`,
    ``,
    metadata.summary,
    ``,
  ];
  if (metadata.instructions) {
    sections.push(`## Instructions`, ``, metadata.instructions, ``);
  }
  if (metadata.rollbackGuidance) {
    sections.push(`## Rollback guidance`, ``, metadata.rollbackGuidance, ``);
  }
  return sections.join("\n");
}
