import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { Pool } from "pg";
import { isMacAppManaged, MAC_APP_UPDATE_MESSAGE } from "../update-owner.js";

import {
  createAuthoringRemoteRefresher,
  isReleaseAuthoringEnabled,
  resolveAuthoringRepoDir,
} from "../server/release-helpers.js";
import { setSetting } from "../db/settings.js";
import { readReleaseStore } from "../release-store.js";
import {
  computeReleaseInfo,
  readReleaseChannel,
  RELEASE_CHANNEL_KEY,
  RELEASE_CHANNELS,
  type ComputeReleaseInfoDeps,
  type ReleaseChannel,
} from "../release-info.js";
import {
  AUTOMATIC_UPDATE_MODES,
  isValidMode,
  readAutomaticUpdateMode,
  writeAutomaticUpdateMode,
  type AutoCheckRuntime,
} from "../release-auto-check.js";
import type { GitHubReleaseListItem } from "../server/release-helpers.js";
/**
 * Per-viewer admin enrichment for /api/v1/release/info. Excluded from the
 * shared snapshot because it depends on the requesting user's GitHub repo
 * permission. Sees no auth context — the caller passes the precomputed
 * isAdmin flag so we don't hit gh twice in one request.
 *
 * Runs against the authoring checkout (DISPATCH_RELEASE_AUTHORING_REPO_DIR,
 * falling back to serverDir), the same checkout the release job uses — the
 * server's runtime dir may be git-free or pinned to a release tag. A fetch
 * failure is reported as fetchError, never as zero unreleased commits: the
 * dispatched release workflow builds current origin/main regardless of what
 * a stale local checkout shows. The fetch is coalesced/TTL'd via
 * authoringRemoteRefresher, and the client-facing fetchError is a fixed
 * message — git stderr can carry paths and remote/credential details, so
 * the raw error goes to the server log only.
 */
const AUTHORING_FETCH_ERROR_MESSAGE =
  "Unable to refresh origin/main in the authoring checkout. See the server log for details.";

export const authoringRemoteRefresher =
  createAuthoringRemoteRefresher(runCommand);

async function computeAdminExtras(input: {
  isAdmin: boolean;
  compareTag: string | null;
  authoringRepoDir: string;
  log: FastifyBaseLogger;
}): Promise<{
  unreleasedCount: number;
  commits: Array<{ sha: string; subject: string }>;
  refMissing: boolean;
  fetchError: string | null;
}> {
  if (!input.isAdmin || !input.compareTag) {
    return {
      unreleasedCount: 0,
      commits: [],
      refMissing: false,
      fetchError: null,
    };
  }
  const fetchResult = await authoringRemoteRefresher.refresh(
    input.authoringRepoDir
  );
  if (!fetchResult.ok) {
    input.log.warn(
      { err: fetchResult.error, authoringRepoDir: input.authoringRepoDir },
      "release/info: authoring checkout fetch failed"
    );
    return {
      unreleasedCount: 0,
      commits: [],
      refMissing: false,
      fetchError: AUTHORING_FETCH_ERROR_MESSAGE,
    };
  }
  const refCheck = await runCommand(
    "git",
    ["-C", input.authoringRepoDir, "rev-parse", "--verify", input.compareTag],
    { allowedExitCodes: [0, 128] }
  );
  if (refCheck.exitCode !== 0) {
    return {
      unreleasedCount: 0,
      commits: [],
      refMissing: true,
      fetchError: null,
    };
  }
  const countResult = await runCommand("git", [
    "-C",
    input.authoringRepoDir,
    "rev-list",
    `${input.compareTag}..origin/main`,
    "--count",
  ]);
  const unreleasedCount = Number(countResult.stdout) || 0;
  if (unreleasedCount === 0) {
    return {
      unreleasedCount: 0,
      commits: [],
      refMissing: false,
      fetchError: null,
    };
  }
  const logResult = await runCommand("git", [
    "-C",
    input.authoringRepoDir,
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
  return { unreleasedCount, commits, refMissing: false, fetchError: null };
}
import { runCommand } from "../shared/lib/run-command.js";
import type {
  CreateJob,
  ReleaseJob,
  ReleaseJobKind,
  ReleaseProgress,
  ReleaseStreamClient,
  ReleaseStreamEvent,
  ReleaseVersionType,
  UpdateJob,
} from "../server/release-runtime.js";
import { RELEASE_VERSION_TYPES } from "../server/release-runtime.js";
import { isTerminalReleasePhase } from "../server/release-wire.js";
import type { PublishUiEvent } from "../server/ui-events.js";

type ReleaseRouteDeps = {
  pool: Pool;
  appLog: FastifyBaseLogger;
  serverDir: string;
  getActiveCreateJob: () => CreateJob | null;
  setActiveCreateJob: (job: CreateJob | null) => void;
  getActiveUpdateJob: () => UpdateJob | null;
  setActiveUpdateJob: (job: UpdateJob | null) => void;
  hasActiveCreateJob: () => boolean;
  hasActiveUpdateJob: () => boolean;
  releaseCreateStreamClients: Set<ReleaseStreamClient>;
  releaseUpdateStreamClients: Set<ReleaseStreamClient>;
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
  fetchLatestReleaseMetadata: (tag: string) => Promise<{
    tag: string;
    publishedAt: string;
    url: string;
    body?: string | null;
  } | null>;
  broadcastReleaseEvent: (
    kind: ReleaseJobKind,
    event: ReleaseStreamEvent
  ) => void;
  sendReleaseEventToClient: (
    clientId: string,
    event: ReleaseStreamEvent
  ) => void;
  runReleaseJob: (job: ReleaseJob) => Promise<void>;
  runUpdateJob: (job: ReleaseJob) => Promise<void>;
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
  const version = await deps.getAppVersionInfo();
  return {
    ...version,
    ...(isMacAppManaged() ? { updateOwner: "macos-app" } : {}),
  };
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
  const activeUpdateJob = deps.getActiveUpdateJob();
  const isApplyingSnapshotTag =
    activeUpdateJob !== null &&
    activeUpdateJob.tag !== null &&
    activeUpdateJob.tag === snapshot.latestTag &&
    !isTerminalReleasePhase(activeUpdateJob.phase);
  if (!isApplyingSnapshotTag) {
    deps.autoCheck.setSnapshotForWriteThrough(snapshot);
  }

  const isAdmin = await deps.checkIsAdmin();
  const extras = await computeAdminExtras({
    isAdmin,
    compareTag: snapshot.absoluteLatestTag ?? snapshot.currentTag,
    authoringRepoDir: resolveAuthoringRepoDir(deps.serverDir),
    log: request.log,
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
    unreleasedFetchError: extras.fetchError,
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
  return { channel: await readReleaseChannel(deps.pool) };
}

async function handleChannelSet(
  deps: ReleaseRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const body = request.body as { channel?: unknown } | undefined;
  if (
    !body?.channel ||
    !RELEASE_CHANNELS.includes(body.channel as ReleaseChannel)
  ) {
    return reply.code(400).send({
      error: `channel must be one of: ${RELEASE_CHANNELS.join(", ")}`,
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
      error: "tag is required and must be a semver tag (e.g. v1.0.0)",
    });
  }
  try {
    const repo = await deps.getGitHubRepo();
    // Promotion also moves the macOS appcast entry to stable, which needs the
    // workflow's Cloudflare credentials; it clears the prerelease flag last.
    await runCommand("gh", [
      "workflow",
      "run",
      "promote-release.yml",
      "--repo",
      repo,
      "--ref",
      "main",
      "--field",
      `tag=${body.tag}`,
    ]);
    // Started, not finished: the client watches the release list for the
    // prerelease flag to clear.
    return reply.code(202).send({
      ok: true,
      tag: body.tag,
      workflowUrl: `https://github.com/${repo}/actions/workflows/promote-release.yml`,
    });
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
  if (deps.hasActiveCreateJob()) {
    return reply.code(409).send({ error: "A release is already in progress." });
  }
  // An update job ends by restarting the server — starting a release
  // build during that window would get killed mid-run (possibly
  // mid version-bump/push) with no clean way to surface that to the
  // admin. This is a one-way gate: an in-flight release must not block
  // an update apply (that's the point of the separate job slots), but
  // an in-flight update legitimately blocks starting a release.
  if (deps.hasActiveUpdateJob()) {
    return reply.code(409).send({
      error: "An update is in progress; the server is about to restart.",
    });
  }
  try {
    await runCommand("gh", ["--version"]);
  } catch {
    return reply.code(422).send({
      error:
        "GitHub CLI (gh) is not available. Install it from https://cli.github.com",
    });
  }
  const job: CreateJob = {
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
  deps.setActiveCreateJob(job);
  void deps.runReleaseJob(job);
  return reply.code(202).send({ ok: true });
}

async function handleUpdate(
  deps: ReleaseRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (isMacAppManaged()) {
    return reply
      .code(409)
      .send({ error: "MAC_APP_MANAGED", message: MAC_APP_UPDATE_MESSAGE });
  }
  const body = request.body as { tag?: unknown } | undefined;
  if (
    !body?.tag ||
    typeof body.tag !== "string" ||
    !/^v\d+\.\d+\.\d+$/.test(body.tag)
  ) {
    return reply.code(400).send({
      error: "tag is required and must be a semver tag (e.g. v1.0.0)",
    });
  }
  const tag = body.tag;
  if (deps.hasActiveUpdateJob()) {
    return reply.code(409).send({ error: "An update is already in progress." });
  }

  const job: UpdateJob = {
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
  deps.setActiveUpdateJob(job);
  void deps.runUpdateJob(job);
  return reply.code(202).send({ ok: true });
}

async function handleReleaseStream(
  deps: ReleaseRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  kind: ReleaseJobKind
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
  const clients =
    kind === "create"
      ? deps.releaseCreateStreamClients
      : deps.releaseUpdateStreamClients;
  clients.add(client);
  const heartbeat = setInterval(() => {
    stream.write(": keepalive\n\n");
  }, 20_000);

  let snapshotJob: ReleaseJob | null;
  if (kind === "create") {
    snapshotJob = deps.getActiveCreateJob();
  } else {
    snapshotJob = deps.getActiveUpdateJob();
  }
  const snapshot: ReleaseStreamEvent = { type: "snapshot", job: snapshotJob };
  stream.write(`data: ${JSON.stringify(snapshot)}\n\n`);

  stream.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(client);
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
  app.get("/api/v1/release/create/stream", (req, reply) =>
    handleReleaseStream(deps, req, reply, "create")
  );
  app.get("/api/v1/release/update/stream", (req, reply) =>
    handleReleaseStream(deps, req, reply, "update")
  );
}
