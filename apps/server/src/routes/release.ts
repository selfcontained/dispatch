import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { Pool } from "pg";

import type { AgentManager, AgentRecord } from "../agents/manager.js";
import {
  getEnabledAgentTypes,
  isCliAgentType,
} from "../agent-type-settings.js";
import { getReleaseUpdateAgentId } from "../auth.js";
import {
  GitHubApiError,
  isReleaseAuthoringEnabled,
} from "../server/release-helpers.js";
import { getSetting, setSetting } from "../db/settings.js";
import { readReleaseStore } from "../release-store.js";
import {
  inspectAssistedUpdateMetadata,
  isAssistedUpdateRequired,
} from "../release-metadata.js";
import {
  computeReleaseInfo,
  type ComputeReleaseInfoDeps,
} from "../release-info.js";
import {
  AUTOMATIC_UPDATE_MODES,
  isValidMode,
  readAutomaticUpdateMode,
  writeAutomaticUpdateMode,
  type AutoCheckRuntime,
} from "../release-auto-check.js";
import {
  buildAssistedUpdateContext,
  applyAssistedPhase,
  attachAssistedAgent,
  runAndRecordChecks,
} from "../assisted-update.js";
import {
  readAssistedUpdateState,
  clearAssistedUpdateState,
  isTerminalPhase,
  type AssistedPhase,
  type AssistedUpdateState,
} from "../assisted-update-store.js";
import type { UpdateMigrationManifest } from "../update-migrations.js";
import type { GitHubReleaseListItem } from "../server/release-helpers.js";
import {
  evaluatePendingMigrations,
  toSummary,
  type PendingMigrationSummary,
} from "../update-migrations-evaluator.js";

/**
 * Per-viewer admin enrichment for /api/v1/release/info. Excluded from the
 * shared snapshot because it depends on the requesting user's GitHub repo
 * permission. Sees no auth context — the caller passes the precomputed
 * isAdmin flag so we don't hit gh twice in one request.
 */
async function computeAdminExtras(input: {
  isAdmin: boolean;
  compareTag: string | null;
  serverDir: string;
}): Promise<{
  unreleasedCount: number;
  commits: Array<{ sha: string; subject: string }>;
  refMissing: boolean;
}> {
  if (!input.isAdmin || !input.compareTag) {
    return { unreleasedCount: 0, commits: [], refMissing: false };
  }
  const refCheck = await runCommand(
    "git",
    ["-C", input.serverDir, "rev-parse", "--verify", input.compareTag],
    { allowedExitCodes: [0, 128] }
  );
  if (refCheck.exitCode !== 0) {
    return { unreleasedCount: 0, commits: [], refMissing: true };
  }
  const countResult = await runCommand("git", [
    "-C",
    input.serverDir,
    "rev-list",
    `${input.compareTag}..origin/main`,
    "--count",
  ]);
  const unreleasedCount = Number(countResult.stdout) || 0;
  if (unreleasedCount === 0) {
    return { unreleasedCount: 0, commits: [], refMissing: false };
  }
  const logResult = await runCommand("git", [
    "-C",
    input.serverDir,
    "log",
    `${input.compareTag}..origin/main`,
    "--no-merges",
    "--format=%H\t%s",
    "--max-count=20",
  ]);
  const commits = logResult.stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const tab = line.indexOf("\t");
      return {
        sha: line.slice(0, tab).slice(0, 7),
        subject: line.slice(tab + 1),
      };
    });
  return { unreleasedCount, commits, refMissing: false };
}
import { runCommand } from "../shared/lib/run-command.js";
import type {
  ReleaseJob,
  ReleaseProgress,
  ReleaseStreamClient,
  ReleaseStreamEvent,
  ReleaseVersionType,
} from "../server/release-runtime.js";
import { RELEASE_VERSION_TYPES } from "../server/release-runtime.js";

const RELEASE_CHANNEL_KEY = "release_channel";
const VALID_CHANNELS = ["stable", "latest"] as const;
type ReleaseChannel = (typeof VALID_CHANNELS)[number];

type ReleaseRouteDeps = {
  pool: Pool;
  appLog: FastifyBaseLogger;
  config: { authToken: string };
  serverDir: string;
  agentManager: AgentManager;
  worktreeLocationKey: string;
  validWorktreeLocations: readonly string[];
  getActiveReleaseJob: () => ReleaseJob | null;
  setActiveReleaseJob: (job: ReleaseJob | null) => void;
  getActiveAssistedUpdateLaunch: () => boolean;
  setActiveAssistedUpdateLaunch: (active: boolean) => void;
  releaseStreamClients: Set<ReleaseStreamClient>;
  getAppVersionInfo: () => Promise<{
    releaseTag: string | null;
    version: string | null;
    gitSha: string | null;
    releaseNotes: string | null;
    releaseUrl: string | null;
  }>;
  getGitHubRepo: () => Promise<string>;
  compareSemver: (a: string, b: string) => number;
  fetchGitHubReleases: () => Promise<GitHubReleaseListItem[]>;
  checkIsAdmin: () => Promise<boolean>;
  fetchReleaseMetadata: (tag: string) => Promise<{
    tag: string;
    publishedAt: string;
    url: string;
    body?: string | null;
  } | null>;
  fetchLatestReleaseMetadata: (tag: string) => Promise<{
    tag: string;
    publishedAt: string;
    url: string;
    body?: string | null;
  } | null>;
  dispatchBaseUrl: () => string;
  dispatchHealthUrl: () => string;
  defaultServiceRestartCommand: () => string;
  buildAssistedUpdatePrompt: (input: {
    tag: string;
    currentTag: string | null;
  }) => string;
  hasActiveAssistedUpdateAgent: () => Promise<boolean>;
  broadcastReleaseEvent: (event: ReleaseStreamEvent) => void;
  sendReleaseEventToClient: (
    clientId: string,
    event: ReleaseStreamEvent
  ) => void;
  appendReleaseLog: (job: ReleaseJob, line: string) => void;
  rehydrateActiveAssistedJob: () => Promise<void>;
  runReleaseJob: (job: ReleaseJob) => Promise<void>;
  runUpdateJob: (job: ReleaseJob) => Promise<void>;
  getBearerToken: (request: {
    headers: { authorization?: string };
  }) => string | null;
  publishUiEvent: (event: unknown) => void;
  withStreamFlag: <T extends AgentRecord>(
    agent: T
  ) => T & { hasStream: boolean };
  handleAgentError: (reply: FastifyReply, error: unknown) => FastifyReply;
  autoCheck: AutoCheckRuntime;
};

function getReleaseStreamClientId(request: FastifyRequest): string | null {
  const header = request.headers["x-dispatch-release-client-id"];
  if (typeof header !== "string") return null;
  const trimmed = header.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function emitInfoProgress(
  deps: ReleaseRouteDeps,
  clientId: string | null,
  progress: ReleaseProgress | null
): void {
  if (!clientId) return;
  deps.sendReleaseEventToClient(clientId, {
    type: "info-progress",
    progress,
  });
}

async function handleAppVersion(deps: ReleaseRouteDeps) {
  return deps.getAppVersionInfo();
}

async function handleReleaseStatus() {
  const record = await readReleaseStore();
  return { tag: record?.tag ?? null, deployedAt: record?.deployedAt ?? null };
}

async function handleReleaseInfo(
  deps: ReleaseRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const computeDeps: ComputeReleaseInfoDeps = {
    pool: deps.pool,
    serverDir: deps.serverDir,
    getGitHubRepo: deps.getGitHubRepo,
    compareSemver: deps.compareSemver,
    fetchGitHubReleases: deps.fetchGitHubReleases,
    getAppVersionInfo: async () => {
      const info = await deps.getAppVersionInfo();
      return { version: info.version };
    },
    fetchLatestReleaseMetadata: deps.fetchLatestReleaseMetadata,
  };

  const releaseStreamClientId = getReleaseStreamClientId(request);
  const result = await computeReleaseInfo(computeDeps, {
    logger: request.log,
    onProgress: (progress) =>
      emitInfoProgress(deps, releaseStreamClientId, progress),
  });
  if (!result.ok) {
    return reply.code(500).send({ error: result.error });
  }
  const { snapshot } = result;
  request.log.info(
    {
      currentTag: snapshot.currentTag,
      latestTag: snapshot.latestTag,
      updateAvailable: snapshot.updateAvailable,
      channel: snapshot.channel,
      releaseStreamClientId,
    },
    "release/info: computed release availability"
  );

  // Write-through into the auto-check cache so the toast/cached-info
  // endpoint reflects the freshest classification the operator just saw —
  // EXCEPT when an apply for this exact tag is in flight. In that case
  // re-populating would broadcast `release.cached_info_changed` to every
  // connected client and re-advertise the in-flight tag as "available",
  // undoing the clear-on-apply protection. The requesting client still
  // gets the fresh data in the response body either way.
  const activeJob = deps.getActiveReleaseJob();
  const isApplyingSnapshotTag =
    activeJob !== null &&
    (activeJob.jobType === "update" ||
      activeJob.jobType === "update-assisted") &&
    activeJob.tag !== null &&
    activeJob.tag === snapshot.latestTag &&
    !isTerminalPhase(activeJob.phase as AssistedPhase);
  if (!isApplyingSnapshotTag) {
    deps.autoCheck.setSnapshotForWriteThrough(snapshot);
  }

  const isAdmin = await deps.checkIsAdmin();
  const extras = await computeAdminExtras({
    isAdmin,
    compareTag: snapshot.absoluteLatestTag ?? snapshot.currentTag,
    serverDir: deps.serverDir,
  });

  return {
    currentTag: snapshot.currentTag,
    channel: snapshot.channel,
    isAdmin,
    latestTag: snapshot.latestTag,
    updateAvailable: snapshot.updateAvailable,
    latestRelease: snapshot.latestRelease,
    unreleasedCount: extras.unreleasedCount,
    commits: extras.commits,
    refMissing: extras.refMissing,
    assisted: snapshot.assisted,
    assistedRequired: snapshot.assistedRequired,
    pendingMigrations: snapshot.pendingMigrations,
    migrationsError: snapshot.migrationsError,
  };
}

async function handleCachedInfo(deps: ReleaseRouteDeps) {
  const snapshot = deps.autoCheck.getSnapshot();
  return { snapshot };
}

async function handleAutoUpdateModeGet(deps: ReleaseRouteDeps) {
  const mode = await readAutomaticUpdateMode(deps.pool);
  return { mode };
}

async function handleAutoUpdateModeSet(
  deps: ReleaseRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const body = request.body as { mode?: unknown } | undefined;
  if (!isValidMode(body?.mode)) {
    return reply.code(400).send({
      error: `mode must be one of: ${AUTOMATIC_UPDATE_MODES.join(", ")}`,
    });
  }
  const nextMode = body!.mode as never;
  await writeAutomaticUpdateMode(deps.pool, nextMode);
  // Flipping into "check" mode is an explicit "I want to know about
  // updates" signal — fire a check immediately rather than waiting up
  // to 6h for the next interval. The auto-check runtime's single
  // flight handles overlap if a check is already running.
  if (nextMode === "check") {
    void deps.autoCheck.runAutoCheckOnce("mode-enabled");
  }
  return { mode: body!.mode };
}

async function handleChannelGet(deps: ReleaseRouteDeps) {
  const raw = await getSetting(deps.pool, RELEASE_CHANNEL_KEY);
  const channel: ReleaseChannel = raw === "latest" ? "latest" : "stable";
  return { channel };
}

async function handleChannelSet(
  deps: ReleaseRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const body = request.body as { channel?: unknown } | undefined;
  if (
    !body?.channel ||
    !VALID_CHANNELS.includes(body.channel as ReleaseChannel)
  ) {
    return reply.code(400).send({
      error: `channel must be one of: ${VALID_CHANNELS.join(", ")}`,
    });
  }
  await setSetting(deps.pool, RELEASE_CHANNEL_KEY, body.channel as string);
  // The cached snapshot was computed for the previous channel; it's
  // stale the moment the operator switches. Fire an immediate
  // background check for the new channel so the page (and toast)
  // pick up the right state without waiting up to 6h for the next
  // interval. Fire-and-forget — the broadcast on completion drives
  // the UI, the HTTP response just confirms the setting persisted.
  void deps.autoCheck.runAutoCheckOnce("channel-change");
  return { channel: body.channel };
}

async function handleAdminCheck(deps: ReleaseRouteDeps) {
  return { isAdmin: await deps.checkIsAdmin() };
}

async function handlePromote(
  deps: ReleaseRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const isAdmin = await deps.checkIsAdmin();
  if (!isAdmin) {
    return reply.code(403).send({ error: "Admin access required" });
  }
  const body = request.body as { tag?: unknown } | undefined;
  if (
    !body?.tag ||
    typeof body.tag !== "string" ||
    !/^v\d+\.\d+\.\d+$/.test(body.tag)
  ) {
    return reply.code(400).send({
      error: "tag is required and must be a semver tag (e.g. v0.11.18)",
    });
  }
  try {
    const repo = await deps.getGitHubRepo();
    await runCommand("gh", [
      "release",
      "edit",
      body.tag,
      "--repo",
      repo,
      "--prerelease=false",
      "--latest",
    ]);
    return { ok: true, tag: body.tag };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return reply.code(500).send({ error: message });
  }
}

async function handleListReleases(
  deps: ReleaseRouteDeps,
  _request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    const releases = await deps.fetchGitHubReleases();
    return {
      releases: releases.map((r) => ({
        tag: r.tag,
        publishedAt: r.publishedAt,
        isPrerelease: r.prerelease,
        url: r.url,
      })),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return reply.code(500).send({ error: message });
  }
}

async function handleCreateRelease(
  deps: ReleaseRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!isReleaseAuthoringEnabled()) {
    return reply.code(403).send({
      error:
        "Release authoring is disabled. Set DISPATCH_RELEASE_AUTHORING=1 on a maintainer installation.",
    });
  }
  const body = request.body as { versionType?: unknown } | undefined;
  if (
    !body?.versionType ||
    !RELEASE_VERSION_TYPES.includes(body.versionType as ReleaseVersionType)
  ) {
    return reply.code(400).send({
      error: `versionType must be one of: ${RELEASE_VERSION_TYPES.join(", ")}`,
    });
  }
  if (
    deps.getActiveReleaseJob() &&
    !isTerminalPhase(deps.getActiveReleaseJob()!.phase as AssistedPhase)
  ) {
    return reply.code(409).send({ error: "A release is already in progress." });
  }
  try {
    await runCommand("gh", ["--version"]);
  } catch {
    return reply.code(422).send({
      error:
        "GitHub CLI (gh) is not available. Install it from https://cli.github.com",
    });
  }
  const job: ReleaseJob = {
    jobType: "create",
    versionType: body.versionType as ReleaseVersionType,
    phase: "preflight",
    startedAt: new Date().toISOString(),
    log: [],
    runUrl: null,
    tag: null,
    error: null,
    progress: null,
  };
  deps.setActiveReleaseJob(job);
  void deps.runReleaseJob(job);
  return reply.code(202).send({ ok: true });
}

async function handleUpdate(
  deps: ReleaseRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const body = request.body as { tag?: unknown; force?: unknown } | undefined;
  const bearerToken = deps.getBearerToken(request);
  if (
    !body?.tag ||
    typeof body.tag !== "string" ||
    !/^v\d+\.\d+\.\d+$/.test(body.tag)
  ) {
    return reply.code(400).send({
      error: "tag is required and must be a semver tag (e.g. v0.2.31)",
    });
  }
  const tag = body.tag;
  const force = body.force === true;
  const releaseUpdateAgentId = bearerToken
    ? getReleaseUpdateAgentId(deps.config.authToken, bearerToken)
    : null;

  if (releaseUpdateAgentId) {
    const agent = await deps.agentManager.getAgent(releaseUpdateAgentId);
    if (
      !agent ||
      agent.role !== "assisted_update" ||
      agent.cwd !== deps.serverDir
    ) {
      return reply.code(403).send({ error: "Invalid assisted update token." });
    }
    const assistedState = await readAssistedUpdateState().catch(() => null);
    if (assistedState && assistedState.tag !== tag) {
      return reply.code(403).send({
        error:
          "Assisted update token is bound to a different tag. Launch a fresh assisted update for this tag.",
      });
    }
  }

  const activeReleaseJob = deps.getActiveReleaseJob();
  if (
    activeReleaseJob &&
    !isTerminalPhase(activeReleaseJob.phase as AssistedPhase)
  ) {
    const isAssistedTakeover =
      releaseUpdateAgentId !== null &&
      activeReleaseJob.jobType === "update-assisted" &&
      activeReleaseJob.assisted?.agentId === releaseUpdateAgentId &&
      activeReleaseJob.tag === tag;
    if (!isAssistedTakeover) {
      return reply
        .code(409)
        .send({ error: "A release or update is already in progress." });
    }
  }

  if (!releaseUpdateAgentId) {
    const installed = await readReleaseStore().catch(() => null);
    let pendingMigrationsForGate: PendingMigrationSummary[];
    try {
      const repo = await deps.getGitHubRepo();
      const evaluation = await evaluatePendingMigrations(tag, { repo });
      pendingMigrationsForGate = evaluation.pending.map((m) =>
        toSummary(m.manifest)
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.warn(
        { err, tag, force },
        "release/update: migration evaluation failed"
      );
      if (!force) {
        return reply.code(503).send({
          error: "MIGRATION_EVALUATION_UNAVAILABLE",
          message: `Could not evaluate update migrations for ${tag}: ${message}. Retry once the underlying issue clears, or pass force=true to skip the check.`,
        });
      }
      pendingMigrationsForGate = [];
    }
    if (pendingMigrationsForGate.length > 0 && !force) {
      return reply.code(409).send({
        error: "ASSISTED_UPDATE_REQUIRED",
        message:
          "This release has unapplied migrations. POST to /api/v1/release/assisted/launch instead, or pass force=true to override.",
        pendingMigrations: pendingMigrationsForGate,
      });
    }

    let targetMeta;
    try {
      targetMeta = await deps.fetchReleaseMetadata(tag);
    } catch (err) {
      if (err instanceof GitHubApiError) {
        return reply.code(503).send({
          error: "GITHUB_API_UNAVAILABLE",
          message: `GitHub API unavailable (status ${err.status}); set GITHUB_TOKEN or retry later.`,
        });
      }
      throw err;
    }
    const inspected = inspectAssistedUpdateMetadata(targetMeta?.body ?? null);
    if (inspected.state === "invalid") {
      return reply.code(409).send({
        error: "ASSISTED_UPDATE_METADATA_INVALID",
        message: `Target release has malformed assisted-update metadata: ${inspected.error}`,
      });
    }
    const targetAssisted =
      inspected.state === "valid" ? inspected.metadata : null;
    if (
      isAssistedUpdateRequired(targetAssisted, installed?.tag ?? null) &&
      !force
    ) {
      return reply.code(409).send({
        error: "ASSISTED_UPDATE_REQUIRED",
        message:
          "This release requires the assisted update flow. POST to /api/v1/release/assisted/launch instead, or pass force=true to override.",
        assisted: targetAssisted,
      });
    }
    if (
      force &&
      (pendingMigrationsForGate.length > 0 ||
        isAssistedUpdateRequired(targetAssisted, installed?.tag ?? null))
    ) {
      request.log.warn(
        {
          tag,
          pendingMigrationCount: pendingMigrationsForGate.length,
          assistedMode: targetAssisted?.mode ?? null,
        },
        "release/update: force=true bypassing assisted-update gate"
      );
    }
  }

  const job: ReleaseJob = {
    jobType: "update",
    versionType: null,
    phase: "fetching",
    startedAt: new Date().toISOString(),
    log: [],
    runUrl: null,
    tag,
    error: null,
    progress: null,
  };
  deps.setActiveReleaseJob(job);
  void deps.runUpdateJob(job);
  return reply.code(202).send({ ok: true });
}

async function handleAssistedLaunch(
  deps: ReleaseRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const body = request.body as { tag?: unknown } | undefined;
  if (
    !body?.tag ||
    typeof body.tag !== "string" ||
    !/^v\d+\.\d+\.\d+$/.test(body.tag)
  ) {
    return reply.code(400).send({
      error: "tag is required and must be a semver tag (e.g. v0.2.31)",
    });
  }

  const enabledAgentTypes = await getEnabledAgentTypes(deps.pool);
  const assistedType = enabledAgentTypes.find(isCliAgentType);
  if (!assistedType) {
    return reply.code(422).send({
      error:
        "No CLI agent types are enabled. Enable Codex, Claude, or OpenCode first.",
    });
  }

  const activeReleaseJob = deps.getActiveReleaseJob();
  if (
    activeReleaseJob &&
    !isTerminalPhase(activeReleaseJob.phase as AssistedPhase)
  ) {
    return reply
      .code(409)
      .send({ error: "A release or update is already in progress." });
  }
  if (deps.getActiveAssistedUpdateLaunch()) {
    return reply.code(409).send({
      error:
        "An assisted update agent is already being created for the production checkout.",
    });
  }

  deps.setActiveAssistedUpdateLaunch(true);
  try {
    if (await deps.hasActiveAssistedUpdateAgent()) {
      return reply.code(409).send({
        error:
          "An assisted update agent is already active for the production checkout.",
      });
    }

    const record = await readReleaseStore().catch(() => null);
    const worktreeLocationRaw = await getSetting(
      deps.pool,
      deps.worktreeLocationKey
    );
    const worktreeLocation =
      worktreeLocationRaw &&
      deps.validWorktreeLocations.includes(worktreeLocationRaw)
        ? worktreeLocationRaw
        : "sibling";

    let pendingMigrationManifests: UpdateMigrationManifest[] = [];
    try {
      const repo = await deps.getGitHubRepo();
      const evaluation = await evaluatePendingMigrations(body.tag, { repo });
      if (evaluation.errors.length > 0) {
        return reply.code(409).send({
          error: "ASSISTED_UPDATE_MIGRATIONS_INVALID",
          message: `Target release has malformed migration manifests: ${evaluation.errors
            .map((e) => `${e.filename}: ${e.error}`)
            .join("; ")}`,
        });
      }
      pendingMigrationManifests = evaluation.pending.map((m) => m.manifest);
    } catch (err) {
      request.log.warn(
        { tag: body.tag, err },
        "Migration evaluation failed, falling back to legacy metadata"
      );
    }

    let targetMeta;
    try {
      targetMeta = await deps.fetchReleaseMetadata(body.tag);
    } catch (err) {
      if (err instanceof GitHubApiError) {
        return reply.code(503).send({
          error: "GITHUB_API_UNAVAILABLE",
          message: `GitHub API unavailable (status ${err.status}); set GITHUB_TOKEN or retry later.`,
        });
      }
      throw err;
    }
    const inspected = inspectAssistedUpdateMetadata(targetMeta?.body ?? null);
    if (
      pendingMigrationManifests.length === 0 &&
      inspected.state === "invalid"
    ) {
      return reply.code(409).send({
        error: "ASSISTED_UPDATE_METADATA_INVALID",
        message: `Target release has malformed assisted-update metadata: ${inspected.error}`,
      });
    }

    const assistedMeta =
      inspected.state === "valid" ? inspected.metadata : null;
    let assistedState: AssistedUpdateState | null = null;
    let assistedToken: string | null = null;
    let initialPrompt: string;
    if (pendingMigrationManifests.length > 0 || assistedMeta) {
      const ctx = await buildAssistedUpdateContext(
        {
          tag: body.tag,
          fromTag: record?.tag ?? null,
          migrations:
            pendingMigrationManifests.length > 0
              ? pendingMigrationManifests
              : undefined,
          metadata:
            pendingMigrationManifests.length === 0 && assistedMeta
              ? assistedMeta
              : undefined,
          serverDir: deps.serverDir,
          recovery: {
            serviceCommand: deps.defaultServiceRestartCommand(),
            healthEndpoint: deps.dispatchHealthUrl(),
            serviceLogPath: "~/.dispatch/logs/dispatch.log",
            failureLogPath: "~/.dispatch/logs/last-release-failure.log",
          },
        },
        deps.dispatchBaseUrl()
      );
      assistedState = ctx.state;
      assistedToken = ctx.state.token;
      initialPrompt = ctx.prompt;
    } else {
      initialPrompt = deps.buildAssistedUpdatePrompt({
        tag: body.tag,
        currentTag: record?.tag ?? null,
      });
    }

    const agent = await deps.agentManager.createAgent({
      name: `update-${body.tag}`,
      type: assistedType,
      role: "assisted_update",
      cwd: deps.serverDir,
      fullAccess: true,
      useWorktree: false,
      worktreeLocation: worktreeLocation as "sibling" | "nested",
      initialPrompt,
    });

    if (assistedState && assistedToken) {
      await attachAssistedAgent(assistedState, agent.id);
      const launchLog = [
        `==> assisted update launched for ${body.tag}`,
        `==> agent: ${agent.id}`,
      ];
      if (pendingMigrationManifests.length > 0) {
        launchLog.push(
          `==> migrations: ${pendingMigrationManifests
            .map((m) => m.id)
            .join(", ")}`
        );
      } else if (assistedMeta) {
        launchLog.push(`==> mode: ${assistedMeta.mode}`);
      }
      deps.setActiveReleaseJob({
        jobType: "update-assisted",
        versionType: null,
        phase: "inspect",
        startedAt: new Date().toISOString(),
        log: launchLog,
        runUrl: null,
        tag: body.tag,
        error: null,
        progress: null,
        assisted: { ...assistedState, agentId: agent.id },
      });
      deps.broadcastReleaseEvent({
        type: "assisted",
        state: { ...assistedState, agentId: agent.id },
      });
    }

    deps.publishUiEvent({
      type: "agent.upsert",
      agent: deps.withStreamFlag(agent),
    });
    return reply
      .code(201)
      .send({ agent: deps.withStreamFlag(agent), assisted: assistedState });
  } catch (error) {
    return deps.handleAgentError(reply, error);
  } finally {
    deps.setActiveAssistedUpdateLaunch(false);
  }
}

async function handleAssistedPhase(
  deps: ReleaseRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const body = request.body as
    | { token?: unknown; phase?: unknown; note?: unknown; error?: unknown }
    | undefined;
  if (!body?.token || typeof body.token !== "string") {
    return reply.code(400).send({ error: "token is required" });
  }
  if (!body.phase || typeof body.phase !== "string") {
    return reply.code(400).send({ error: "phase is required" });
  }
  const result = await applyAssistedPhase({
    token: body.token,
    phase: body.phase as AssistedPhase,
    note: typeof body.note === "string" ? body.note : undefined,
    error: typeof body.error === "string" ? body.error : undefined,
  });
  if (!result.ok) {
    return reply.code(409).send({ error: result.reason });
  }

  const activeReleaseJob = deps.getActiveReleaseJob();
  if (activeReleaseJob && activeReleaseJob.jobType === "update-assisted") {
    activeReleaseJob.phase = result.state.phase;
    activeReleaseJob.assisted = result.state;
    if (result.state.error) activeReleaseJob.error = result.state.error;
    const persistedNote = result.state.notes[result.state.phase];
    const summary = persistedNote
      ? `==> phase ${result.state.phase}: ${persistedNote}`
      : `==> phase ${result.state.phase}`;
    deps.appendReleaseLog(activeReleaseJob, summary);
    deps.broadcastReleaseEvent({
      type: "phase",
      phase: activeReleaseJob.phase,
    });
    deps.broadcastReleaseEvent({ type: "assisted", state: result.state });
  }

  if (result.state.phase === "validate") {
    const post = await runAndRecordChecks(result.state, {
      serverDir: deps.serverDir,
      targetTag: result.state.tag,
      healthUrl: deps.dispatchHealthUrl(),
    });
    const activeJob = deps.getActiveReleaseJob();
    if (activeJob && activeJob.jobType === "update-assisted") {
      activeJob.phase = post.phase;
      activeJob.assisted = post;
      if (post.error) activeJob.error = post.error;
      for (const check of post.checks) {
        deps.appendReleaseLog(
          activeJob,
          `  - ${check.ok ? "✓" : "✗"} ${check.name}: ${check.message}`
        );
      }
      deps.broadcastReleaseEvent({ type: "phase", phase: activeJob.phase });
      deps.broadcastReleaseEvent({ type: "assisted", state: post });
    }
  }

  return reply.code(200).send({ ok: true, state: result.state });
}

async function handleAssistedStateGet() {
  return { state: await readAssistedUpdateState() };
}

async function handleAssistedStateClear(deps: ReleaseRouteDeps) {
  await clearAssistedUpdateState();
  const activeReleaseJob = deps.getActiveReleaseJob();
  if (activeReleaseJob?.jobType === "update-assisted") {
    deps.setActiveReleaseJob(null);
  }
  return { ok: true };
}

async function handleReleaseStream(
  deps: ReleaseRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const clientId =
    typeof request.query === "object" &&
    request.query !== null &&
    "clientId" in request.query &&
    typeof request.query.clientId === "string" &&
    request.query.clientId.trim().length > 0
      ? request.query.clientId.trim()
      : "default";
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.hijack();

  const stream = reply.raw;
  const client = { clientId, stream };
  deps.releaseStreamClients.add(client);
  const heartbeat = setInterval(() => {
    stream.write(": keepalive\n\n");
  }, 20_000);

  await deps.rehydrateActiveAssistedJob();

  let snapshotJob = deps.getActiveReleaseJob();
  if (snapshotJob && snapshotJob.jobType === "update-assisted") {
    const persisted = await readAssistedUpdateState();
    if (persisted) {
      snapshotJob = { ...snapshotJob, assisted: persisted };
    }
  }
  const snapshot: ReleaseStreamEvent = { type: "snapshot", job: snapshotJob };
  stream.write(`data: ${JSON.stringify(snapshot)}\n\n`);

  stream.on("close", () => {
    clearInterval(heartbeat);
    deps.releaseStreamClients.delete(client);
  });
}

export async function registerReleaseRoutes(
  app: FastifyInstance,
  deps: ReleaseRouteDeps
): Promise<void> {
  app.get("/api/v1/app/version", () => handleAppVersion(deps));
  app.get("/api/v1/release/status", () => handleReleaseStatus());
  app.get("/api/v1/release/info", (req, reply) =>
    handleReleaseInfo(deps, req, reply)
  );
  app.get("/api/v1/release/cached-info", () => handleCachedInfo(deps));
  app.get("/api/v1/release/auto-update-mode", () =>
    handleAutoUpdateModeGet(deps)
  );
  app.post("/api/v1/release/auto-update-mode", (req, reply) =>
    handleAutoUpdateModeSet(deps, req, reply)
  );
  app.get("/api/v1/release/channel", () => handleChannelGet(deps));
  app.post("/api/v1/release/channel", (req, reply) =>
    handleChannelSet(deps, req, reply)
  );
  app.get("/api/v1/release/admin-check", () => handleAdminCheck(deps));
  app.post("/api/v1/release/promote", (req, reply) =>
    handlePromote(deps, req, reply)
  );
  app.get("/api/v1/releases", (req, reply) =>
    handleListReleases(deps, req, reply)
  );
  app.post("/api/v1/release", (req, reply) =>
    handleCreateRelease(deps, req, reply)
  );
  app.post("/api/v1/release/update", (req, reply) =>
    handleUpdate(deps, req, reply)
  );
  app.post("/api/v1/release/assisted/launch", (req, reply) =>
    handleAssistedLaunch(deps, req, reply)
  );
  app.post("/api/v1/release/assisted/phase", (req, reply) =>
    handleAssistedPhase(deps, req, reply)
  );
  app.get("/api/v1/release/assisted/state", () => handleAssistedStateGet());
  app.delete("/api/v1/release/assisted/state", () =>
    handleAssistedStateClear(deps)
  );
  app.get("/api/v1/release/stream", (req, reply) =>
    handleReleaseStream(deps, req, reply)
  );
}
