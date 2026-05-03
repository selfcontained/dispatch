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
import { getSetting, setSetting } from "../db/settings.js";
import { readReleaseStore } from "../release-store.js";
import {
  inspectAssistedUpdateMetadata,
  isAssistedUpdateRequired,
  type AssistedUpdateMetadata,
} from "../release-metadata.js";
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
import {
  evaluatePendingMigrations,
  toSummary,
  type PendingMigrationSummary,
} from "../update-migrations-evaluator.js";
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
  parseGhJson: <T>(stdout: string) => T;
  compareSemver: (a: string, b: string) => number;
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
};

export async function registerReleaseRoutes(
  app: FastifyInstance,
  deps: ReleaseRouteDeps
): Promise<void> {
  const getReleaseStreamClientId = (request: FastifyRequest): string | null => {
    const header = request.headers["x-dispatch-release-client-id"];
    if (typeof header !== "string") return null;
    const trimmed = header.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const emitInfoProgress = (
    clientId: string | null,
    progress: ReleaseProgress | null
  ): void => {
    if (!clientId) return;
    deps.sendReleaseEventToClient(clientId, {
      type: "info-progress",
      progress,
    });
  };

  app.get("/api/v1/app/version", async () => {
    return deps.getAppVersionInfo();
  });

  app.get("/api/v1/release/status", async () => {
    const record = await readReleaseStore();
    return { tag: record?.tag ?? null, deployedAt: record?.deployedAt ?? null };
  });

  app.get("/api/v1/release/info", async (request, reply) => {
    const releaseStreamClientId = getReleaseStreamClientId(request);
    emitInfoProgress(releaseStreamClientId, {
      step: "fetching-tags",
      label: "Fetching release tags",
      detail: "Checking origin for the latest available releases.",
    });
    try {
      await runCommand("git", [
        "-C",
        deps.serverDir,
        "fetch",
        "origin",
        "--tags",
        "--quiet",
      ]);

      const record = await readReleaseStore();
      const currentTag = record?.tag ?? null;
      const isAdmin = await deps.checkIsAdmin();
      const channelRaw = await getSetting(deps.pool, RELEASE_CHANNEL_KEY);
      const channel = channelRaw === "latest" ? "latest" : "stable";

      let latestTag: string | null = null;
      let absoluteLatestTag: string | null = null;
      try {
        emitInfoProgress(releaseStreamClientId, {
          step: "loading-release-list",
          label: "Looking up latest release",
          detail: `Selecting the newest ${channel} release from GitHub.`,
        });
        const repo = await deps.getGitHubRepo();
        const ghResult = await runCommand("gh", [
          "release",
          "list",
          "--repo",
          repo,
          "--limit",
          "10",
          "--json",
          "tagName,isPrerelease",
        ]);
        const allReleases = deps.parseGhJson<
          Array<{ tagName: string; isPrerelease: boolean }>
        >(ghResult.stdout);
        absoluteLatestTag = allReleases[0]?.tagName ?? null;
        latestTag =
          channel === "stable"
            ? (allReleases.find((r) => !r.isPrerelease)?.tagName ?? null)
            : (allReleases[0]?.tagName ?? null);
      } catch {
        const tagsResult = await runCommand("git", [
          "-C",
          deps.serverDir,
          "tag",
          "--sort=-version:refname",
        ]);
        const fallbackTag =
          tagsResult.stdout.split("\n").find((t) => t.startsWith("v")) ?? null;
        latestTag = fallbackTag;
        absoluteLatestTag = fallbackTag;
      }

      const updateAvailable = !!(
        currentTag &&
        latestTag &&
        deps.compareSemver(latestTag, currentTag) > 0
      );

      let latestRelease: {
        tag: string;
        publishedAt: string;
        url: string;
      } | null = null;
      let assistedMetadata: AssistedUpdateMetadata | null = null;
      let assistedMetadataError: string | null = null;
      if (latestTag && updateAvailable) {
        emitInfoProgress(releaseStreamClientId, {
          step: "loading-release-notes",
          label: `Inspecting ${latestTag}`,
          detail: "Loading release metadata and assisted-update requirements.",
        });
        const fullRelease = await deps.fetchLatestReleaseMetadata(latestTag);
        latestRelease = fullRelease
          ? {
              tag: fullRelease.tag,
              publishedAt: fullRelease.publishedAt,
              url: fullRelease.url,
            }
          : null;
        const inspected = inspectAssistedUpdateMetadata(
          fullRelease?.body ?? null
        );
        if (inspected.state === "invalid") {
          assistedMetadataError = inspected.error;
        } else if (inspected.state === "valid") {
          assistedMetadata = inspected.metadata;
        }
      }
      if (assistedMetadataError) {
        return reply.code(500).send({
          error: `Latest release has malformed assisted-update metadata: ${assistedMetadataError}`,
        });
      }

      let pendingMigrations: PendingMigrationSummary[] = [];
      let migrationsError: string | null = null;
      if (latestTag && updateAvailable && isAdmin) {
        try {
          const repo = await deps.getGitHubRepo();
          const evaluation = await evaluatePendingMigrations(latestTag, {
            repo,
            onProgress: ({ message, bytesReceived, totalBytes }) => {
              emitInfoProgress(releaseStreamClientId, {
                step:
                  bytesReceived !== undefined
                    ? "downloading-release-package"
                    : "inspecting-release-package",
                label:
                  bytesReceived !== undefined
                    ? "Downloading release package"
                    : "Inspecting release package",
                detail: message,
                bytesReceived: bytesReceived ?? null,
                totalBytes: totalBytes ?? null,
              });
            },
          });
          pendingMigrations = evaluation.pending.map((m) =>
            toSummary(m.manifest)
          );
          if (evaluation.errors.length > 0) {
            migrationsError = evaluation.errors
              .map((e) => `${e.filename}: ${e.error}`)
              .join("; ");
          }
        } catch (err) {
          migrationsError =
            err instanceof Error ? err.message : "migration evaluation failed";
          request.log.error(
            { err, tag: latestTag },
            "release/info: migration evaluation failed; UI will surface error and offer standard update fallback"
          );
        }
      }
      const assistedRequired =
        pendingMigrations.length > 0 ||
        (migrationsError !== null && updateAvailable) ||
        isAssistedUpdateRequired(assistedMetadata, currentTag);

      let unreleasedCount = 0;
      let commits: Array<{ sha: string; subject: string }> = [];
      let refMissing = false;
      const compareTag = absoluteLatestTag ?? currentTag;
      if (isAdmin && compareTag) {
        const refCheck = await runCommand(
          "git",
          ["-C", deps.serverDir, "rev-parse", "--verify", compareTag],
          { allowedExitCodes: [0, 128] }
        );
        if (refCheck.exitCode !== 0) {
          refMissing = true;
        } else {
          const countResult = await runCommand("git", [
            "-C",
            deps.serverDir,
            "rev-list",
            `${compareTag}..origin/main`,
            "--count",
          ]);
          unreleasedCount = Number(countResult.stdout) || 0;
          if (unreleasedCount > 0) {
            const logResult = await runCommand("git", [
              "-C",
              deps.serverDir,
              "log",
              `${compareTag}..origin/main`,
              "--no-merges",
              "--format=%H\t%s",
              "--max-count=20",
            ]);
            commits = logResult.stdout
              .split("\n")
              .filter((line) => line.trim())
              .map((line) => {
                const tab = line.indexOf("\t");
                return {
                  sha: line.slice(0, tab).slice(0, 7),
                  subject: line.slice(tab + 1),
                };
              });
          }
        }
      }

      return {
        currentTag,
        channel,
        isAdmin,
        latestTag,
        updateAvailable,
        latestRelease,
        unreleasedCount,
        commits,
        refMissing,
        assisted: assistedMetadata,
        assistedRequired,
        pendingMigrations,
        migrationsError,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return reply.code(500).send({ error: message });
    } finally {
      emitInfoProgress(releaseStreamClientId, null);
    }
  });

  app.get("/api/v1/release/channel", async () => {
    const raw = await getSetting(deps.pool, RELEASE_CHANNEL_KEY);
    const channel: ReleaseChannel = raw === "latest" ? "latest" : "stable";
    return { channel };
  });

  app.post("/api/v1/release/channel", async (request, reply) => {
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
    return { channel: body.channel };
  });

  app.get("/api/v1/release/admin-check", async () => {
    return { isAdmin: await deps.checkIsAdmin() };
  });

  app.post("/api/v1/release/promote", async (request, reply) => {
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
      ]);
      return { ok: true, tag: body.tag };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/api/v1/releases", async (_, reply) => {
    try {
      const repo = await deps.getGitHubRepo();
      const result = await runCommand("gh", [
        "release",
        "list",
        "--repo",
        repo,
        "--limit",
        "10",
        "--json",
        "tagName,publishedAt,isPrerelease",
      ]);
      const releases = deps.parseGhJson<
        Array<{ tagName: string; publishedAt: string; isPrerelease: boolean }>
      >(result.stdout);
      return {
        releases: releases.map((r) => ({
          tag: r.tagName,
          publishedAt: r.publishedAt,
          isPrerelease: r.isPrerelease,
          url: `https://github.com/${repo}/releases/tag/${r.tagName}`,
        })),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return reply.code(500).send({ error: message });
    }
  });

  app.post("/api/v1/release", async (request, reply) => {
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
      return reply
        .code(409)
        .send({ error: "A release is already in progress." });
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
  });

  app.post("/api/v1/release/update", async (request, reply) => {
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
        return reply
          .code(403)
          .send({ error: "Invalid assisted update token." });
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

      const targetMeta = await deps.fetchReleaseMetadata(tag);
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
  });

  app.post("/api/v1/release/assisted/launch", async (request, reply) => {
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
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[release/assisted/launch] migration evaluation failed for ${body.tag}, falling back to legacy metadata: ${message}`
        );
      }

      const targetMeta = await deps.fetchReleaseMetadata(body.tag);
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
  });

  app.post("/api/v1/release/assisted/phase", async (request, reply) => {
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
  });

  app.get("/api/v1/release/assisted/state", async () => {
    return { state: await readAssistedUpdateState() };
  });

  app.delete("/api/v1/release/assisted/state", async () => {
    await clearAssistedUpdateState();
    const activeReleaseJob = deps.getActiveReleaseJob();
    if (activeReleaseJob?.jobType === "update-assisted") {
      deps.setActiveReleaseJob(null);
    }
    return { ok: true };
  });

  app.get("/api/v1/release/stream", async (request, reply) => {
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
  });
}
