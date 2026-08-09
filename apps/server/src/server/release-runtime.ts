import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";

import type { Pool } from "pg";

import type { AppConfig } from "../config.js";
import type {
  AssistedPhase,
  AssistedUpdateState,
} from "../assisted-update-store.js";
import type { ReleaseLogStreamProcessor } from "../release-log-stream.js";
import {
  writeReleaseCandidate,
  type ReleaseCandidate,
} from "../release-candidate-store.js";
import {
  gitSha as embeddedGitSha,
  packageVersion,
  releaseNotesMarkdown,
} from "../generated/runtime-assets.js";
import {
  fetchGitHubReleases,
  type RunCommand,
  parseGhJson,
  compareSemver,
  defaultServiceRestartCommand,
  getGitHubRepo as getGitHubRepoImpl,
  createCheckIsAdmin,
  fetchReleaseMetadata as fetchReleaseMetadataImpl,
  fixedRuntimePath,
  isReleaseAuthoringEnabled,
  resolveAuthoringRepoDir,
} from "./release-helpers.js";
import { errorMessage } from "../shared/lib/error-message.js";
import { verifyAndStageRuntime } from "./release-artifact.js";

// Wire types (job, phases, stream events) live in release-wire.ts so the
// web client can import them without pulling in this module's runtime
// dependency graph. Re-exported here for server-side importers.
import {
  RELEASE_VERSION_TYPES,
  type ReleasePhase,
  type ReleaseProgress,
  type ReleaseJob,
  type ReleaseStreamEvent,
  type ReleaseVersionType,
} from "./release-wire.js";

export { RELEASE_VERSION_TYPES };
export type {
  CreatePhase,
  UpdatePhase,
  AssistedReleasePhase,
  ReleasePhase,
  ReleaseProgress,
  ReleaseJob,
  ReleaseStreamEvent,
  ReleaseVersionType,
} from "./release-wire.js";

export type ReleaseJobKind = "create" | "update";

export type ReleaseStreamClient = {
  clientId: string;
  stream: NodeJS.WritableStream;
};

type CreateReleaseRuntimeDeps = {
  pool: Pool;
  config: AppConfig;
  serverDir: string;
  runCommand: RunCommand;
  readReleaseStore: () => Promise<{ tag: string; deployedAt: string } | null>;
  writeReleaseStore: (record: {
    tag: string;
    deployedAt: string;
  }) => Promise<void>;
  readAssistedUpdateState: () => Promise<AssistedUpdateState | null>;
  isTerminalPhase: (phase: AssistedPhase) => boolean;
  ensureCachedTarball: (input: {
    tag: string;
    repo: string;
    onProgress: (input: {
      message: string;
      bytesReceived?: number;
      totalBytes?: number | null;
    }) => void;
  }) => Promise<{ path: string }>;
  pruneCacheExcept: (tags: string[]) => Promise<void>;
  unlinkCachedTarball: (tag: string) => Promise<void>;
  createReleaseLogStreamProcessor: (
    sinks: {
      append: (line: string) => void;
      replace: (line: string) => void;
      rewind: (count: number) => void;
    },
    onLine?: (line: string) => void
  ) => ReleaseLogStreamProcessor;
  /** Kept injectable so artifact activation can be tested without a service manager. */
  restartService?: () => void;
  writeReleaseCandidate?: (candidate: ReleaseCandidate) => Promise<void>;
};

export type CreateJob = Extract<ReleaseJob, { jobType: "create" }>;
export type UpdateJob = Extract<
  ReleaseJob,
  { jobType: "update" | "update-assisted" }
>;

function kindOf(job: ReleaseJob): ReleaseJobKind {
  return job.jobType === "create" ? "create" : "update";
}

export function createReleaseRuntime(deps: CreateReleaseRuntimeDeps) {
  // Release creation (admin "Releases" page) and update application
  // (all-users "Updates" page) are unrelated operations that happen to
  // share a lot of plumbing. Each gets its own active-job slot and its
  // own SSE client set so one can never block, or leak progress into,
  // the other — see the "kind"-scoped broadcast helpers below.
  let activeCreateJob: CreateJob | null = null;
  let activeUpdateJob: UpdateJob | null = null;
  let activeAssistedUpdateLaunch = false;
  const releaseCreateStreamClients = new Set<ReleaseStreamClient>();
  const releaseUpdateStreamClients = new Set<ReleaseStreamClient>();
  const clientsForKind = (kind: ReleaseJobKind): Set<ReleaseStreamClient> =>
    kind === "create" ? releaseCreateStreamClients : releaseUpdateStreamClients;
  const getGitHubRepo = getGitHubRepoImpl;
  const checkIsAdmin = createCheckIsAdmin(deps.runCommand, deps.serverDir);
  const fetchReleaseMetadata = fetchReleaseMetadataImpl;
  const restartService =
    deps.restartService ??
    (() => {
      if (process.platform === "linux") {
        spawn("systemctl", ["--user", "restart", "dispatch"], {
          detached: true,
          stdio: "ignore",
        }).unref();
        return;
      }
      const uid = process.getuid?.() ?? 501;
      spawn(
        "launchctl",
        ["kickstart", "-k", `gui/${uid}/com.dispatch.server`],
        {
          detached: true,
          stdio: "ignore",
        }
      ).unref();
    });
  const recordReleaseCandidate =
    deps.writeReleaseCandidate ?? writeReleaseCandidate;

  async function getAppVersionInfo(): Promise<{
    releaseTag: string | null;
    version: string | null;
    gitSha: string | null;
    releaseNotes: string | null;
    releaseUrl: string | null;
  }> {
    const record = await deps.readReleaseStore().catch(() => null);

    // packageVersion is baked in at build time by
    // scripts/generate-server-runtime-assets.mjs from the workspace
    // package.json. It survives the Bun --compile VFS where reading
    // package.json from disk does not.
    const version = packageVersion.trim() || null;

    const gitSha = embeddedGitSha?.trim() || null;

    const releaseTag = record?.tag ?? null;
    const releaseNotes = releaseNotesMarkdown.trim() || null;
    const releaseUrl = releaseTag
      ? `https://github.com/${await getGitHubRepo()}/releases/tag/${releaseTag}`
      : null;

    return {
      releaseTag,
      version,
      gitSha,
      releaseNotes,
      releaseUrl,
    };
  }

  async function rehydrateActiveAssistedJob(): Promise<void> {
    if (activeUpdateJob) return;
    const state = await deps.readAssistedUpdateState().catch(() => null);
    if (!state || deps.isTerminalPhase(state.phase)) return;
    activeUpdateJob = {
      jobType: "update-assisted",
      versionType: null,
      phase: state.phase,
      startedAt: state.startedAt,
      log: [`==> resumed from on-disk state at phase ${state.phase}`],
      runUrl: null,
      tag: state.tag,
      error: state.error,
      progress: null,
      assisted: state,
    };
  }

  function dispatchHealthUrl(): string {
    return `${dispatchBaseUrl()}/api/v1/health`;
  }

  function dispatchBaseUrl(): string {
    const protocol = deps.config.tls ? "https" : "http";
    return `${protocol}://127.0.0.1:${deps.config.port}`;
  }

  async function hasActiveAssistedUpdateAgent(): Promise<boolean> {
    const result = await deps.pool.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM agents
        WHERE deleted_at IS NULL
          AND role = 'assisted_update'
          AND cwd = $1
          AND status IN ('creating', 'running', 'stopping', 'unknown')
      `,
      [deps.serverDir]
    );
    return Number(result.rows[0]?.count ?? "0") > 0;
  }

  function buildAssistedUpdatePrompt(input: {
    tag: string;
    currentTag: string | null;
  }): string {
    const serviceCommand = defaultServiceRestartCommand();

    return `
You are running an assisted Dispatch update on the host machine.

Primary objective:
1. Update Dispatch to ${input.tag}.
2. If restart or health fails, restore the Dispatch service first.
3. After service is healthy again, diagnose what went wrong and leave a concise report in the terminal.

Update details:
- Current recorded tag in release.json: ${input.currentTag ?? "unknown"}
- Target tag: ${input.tag}
- Production installation root: ${deps.serverDir}
- Health endpoint: ${dispatchHealthUrl()}
- Dispatch API base URL: $DISPATCH_API_URL
- Dispatch API update token env: $DISPATCH_RELEASE_UPDATE_TOKEN
- Main service log: ~/.dispatch/logs/dispatch.log
- Failure log path: ~/.dispatch/logs/last-release-failure.log
- Service restart command: ${serviceCommand}

Guardrails:
- Operate on ${deps.serverDir}, not the user's development worktree.
- Do not edit secrets or .env unless explicitly required to restore service and you can explain why.
- Do not make source-code changes as part of the recovery path unless absolutely necessary.
- Treat release.json as the last confirmed healthy release; inspect release-candidate.json when an activation was interrupted.
- Prefer rollback to the last confirmed healthy tag over speculative fixes if the service does not come back.
- Restore service availability before deeper diagnosis.

Service architecture and recovery model:
- Dispatch runs from one fixed compiled binary at ${fixedRuntimePath(deps.serverDir)}.
- Updates extract and verify a release artifact, atomically replace that path, retain ${fixedRuntimePath(deps.serverDir)}.previous for rollback, then restart.
- A newly healthy target promotes release-candidate.json into release.json.

Rollback recovery:
- Prefer the managed endpoint first. Use manual recovery only after it fails or the service does not restart cleanly.
- Manual rollback sequence: atomically replace ${fixedRuntimePath(deps.serverDir)} with ${fixedRuntimePath(deps.serverDir)}.previous, then run the service restart command.
- Validate service health with ${dispatchHealthUrl()} before reporting success.

Suggested workflow:
1. Capture the current repo/tag/service state.
2. Trigger the existing managed Dispatch update flow first by calling the built-in update endpoint the UI uses with the provided bearer token, for example:
   \`curl -sf -X POST "$DISPATCH_API_URL/api/v1/release/update" -H "Content-Type: application/json" -H "Authorization: Bearer $DISPATCH_RELEASE_UPDATE_TOKEN" -d '{"tag":"${input.tag}"}'\`
3. Monitor restart and health until success or failure is clear.
4. If the managed flow request fails or the service does not come back, inspect launchd/systemd state and recent logs before deciding on recovery.
5. Reuse existing Dispatch service scripts/commands where they already encode the normal update behavior; do not manually reproduce the normal update sequence unless the managed path has already failed and you are in explicit recovery mode.
6. Retry one clean restart if that is the safest next step.
7. If still broken, identify the last confirmed healthy tag from repo/service history, roll back to it, and verify health.
8. Summarize outcome, root cause, commands run, and any remaining risk.
`.trim();
  }

  function broadcastReleaseEvent(
    kind: ReleaseJobKind,
    event: ReleaseStreamEvent
  ): void {
    const clients = clientsForKind(kind);
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      try {
        client.stream.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  }

  function sendReleaseEventToClient(
    clientId: string,
    event: ReleaseStreamEvent
  ): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const clients of [
      releaseCreateStreamClients,
      releaseUpdateStreamClients,
    ]) {
      for (const client of clients) {
        if (client.clientId !== clientId) continue;
        try {
          client.stream.write(payload);
        } catch {
          clients.delete(client);
        }
      }
    }
  }

  function appendReleaseLog(job: ReleaseJob, line: string): void {
    job.log.push(line);
    broadcastReleaseEvent(kindOf(job), { type: "log", line });
  }

  function replaceReleaseLog(job: ReleaseJob, line: string): void {
    if (job.log.length > 0) {
      job.log[job.log.length - 1] = line;
    } else {
      job.log.push(line);
    }
    broadcastReleaseEvent(kindOf(job), { type: "log.replace", line });
  }

  function rewindReleaseLog(job: ReleaseJob, count: number): void {
    const actual = Math.min(count, job.log.length);
    if (actual > 0) {
      job.log.splice(-actual);
      broadcastReleaseEvent(kindOf(job), { type: "log.rewind", count: actual });
    }
  }

  function setReleasePhase(
    job: ReleaseJob,
    phase: ReleasePhase,
    error?: string
  ): void {
    job.phase = phase;
    broadcastReleaseEvent(kindOf(job), { type: "phase", phase, error });
  }

  function setReleaseProgress(
    job: ReleaseJob,
    progress: ReleaseProgress | null
  ): void {
    job.progress = progress;
    broadcastReleaseEvent(kindOf(job), { type: "progress", progress });
  }

  function streamProcess(
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string> },
    job: ReleaseJob,
    onLine?: (line: string) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const processor = deps.createReleaseLogStreamProcessor(
        {
          append: (line) => appendReleaseLog(job, line),
          replace: (line) => replaceReleaseLog(job, line),
          rewind: (count) => rewindReleaseLog(job, count),
        },
        onLine
      );

      const processChunk = (chunk: Buffer): void => {
        processor.push(chunk);
      };

      child.stdout.on("data", processChunk);
      child.stderr.on("data", processChunk);

      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        processor.finish();
        if (code !== 0) {
          reject(new Error(`Process exited with code ${code}`));
        } else {
          resolve();
        }
      });
    });
  }

  async function deployFromArtifact(
    job: ReleaseJob,
    tag: string
  ): Promise<void> {
    const repo = await getGitHubRepo();

    const cached = await deps.ensureCachedTarball({
      tag,
      repo,
      onProgress: ({ message, bytesReceived, totalBytes }) => {
        appendReleaseLog(job, message);
        setReleaseProgress(job, {
          step:
            bytesReceived !== undefined
              ? "downloading-artifact"
              : "preparing-artifact",
          label:
            bytesReceived !== undefined
              ? "Downloading release package"
              : "Preparing release package",
          detail: message,
          bytesReceived: bytesReceived ?? null,
          totalBytes: totalBytes ?? null,
        });
      },
    });

    appendReleaseLog(job, "==> validating artifact contents");
    setReleaseProgress(job, {
      step: "validating-artifact",
      label: "Validating release package",
      detail: "Inspecting the downloaded artifact before extraction.",
    });
    appendReleaseLog(job, "==> staging verified runtime executable");
    setReleaseProgress(job, {
      step: "extracting-artifact",
      label: "Installing release executable",
      detail: "Extracting and verifying the pre-built executable.",
    });
    try {
      await verifyAndStageRuntime({
        tarballPath: cached.path,
        tag,
        livePath: fixedRuntimePath(deps.serverDir),
        runCommand: deps.runCommand,
      });
    } catch (err) {
      await deps.unlinkCachedTarball(tag);
      appendReleaseLog(
        job,
        `==> activation failed for ${tag} — removed cache entry; next attempt will re-download`
      );
      throw err;
    }

    appendReleaseLog(
      job,
      "==> deployed from pre-built artifact (no build needed)"
    );
    await deps.pruneCacheExcept([tag]);
  }

  async function assertCurrentReleaseBinary(job: ReleaseJob): Promise<void> {
    const livePath = fixedRuntimePath(deps.serverDir);
    const stats = await lstat(livePath).catch(() => null);
    if (!stats?.isFile()) {
      throw new Error(`Expected live Dispatch executable at ${livePath}`);
    }
    appendReleaseLog(job, `==> activated runtime binary ${livePath}`);
  }

  async function deployTag(job: ReleaseJob, tag: string): Promise<void> {
    setReleasePhase(job, "deploying");
    appendReleaseLog(job, `==> deploying ${tag}`);

    await deployFromArtifact(job, tag);

    setReleaseProgress(job, {
      step: "verifying-runtime",
      label: "Verifying runtime",
      detail: "Checking the installed release binary before restart.",
    });
    await assertCurrentReleaseBinary(job);
    const prior = await deps.readReleaseStore().catch(() => null);
    await recordReleaseCandidate({
      tag,
      previousTag: prior?.tag ?? null,
      activatedAt: new Date().toISOString(),
    });
    setReleaseProgress(job, {
      step: "recording-release",
      label: "Recording deployed version",
      detail: `Saving ${tag} as the active release.`,
    });
    appendReleaseLog(
      job,
      `==> activated ${tag}; it will be recorded after health confirmation`
    );
    setReleasePhase(job, "restarting");
    appendReleaseLog(job, "==> restarting service");
    setReleaseProgress(job, {
      step: "restarting-service",
      label: "Restarting Dispatch",
      detail: "Waiting for the service to come back on the new version.",
    });

    restartService();
  }

  async function runUpdateJob(job: ReleaseJob): Promise<void> {
    try {
      const tag = job.tag!;
      setReleasePhase(job, "fetching");
      appendReleaseLog(job, `==> confirming release ${tag}`);
      setReleaseProgress(job, {
        step: "fetching-tags",
        label: "Confirming release",
        detail: "Checking GitHub Releases before update.",
      });
      const metadata = await fetchReleaseMetadata(tag);
      if (!metadata) {
        throw new Error(`Release ${tag} was not found on GitHub`);
      }

      await deployTag(job, tag);
    } catch (err) {
      const error = errorMessage(err);
      if (activeUpdateJob) {
        activeUpdateJob.error = error;
      }
      setReleaseProgress(job, null);
      setReleasePhase(job, "failed", error);
    }
  }

  async function runReleaseJob(job: ReleaseJob): Promise<void> {
    try {
      if (!isReleaseAuthoringEnabled()) {
        throw new Error(
          "Release authoring is disabled (set DISPATCH_RELEASE_AUTHORING=1)"
        );
      }
      const authoringRepoDir = resolveAuthoringRepoDir(deps.serverDir);
      setReleasePhase(job, "preflight");
      try {
        await deps.runCommand("gh", ["--version"]);
      } catch {
        throw new Error(
          "GitHub CLI (gh) is not available. Install it from https://cli.github.com"
        );
      }

      const repo = await getGitHubRepo();
      setReleasePhase(job, "triggering");
      appendReleaseLog(
        job,
        `==> triggering release workflow (version: ${job.versionType})`
      );

      try {
        await deps.runCommand("gh", [
          "workflow",
          "run",
          "release.yml",
          "--repo",
          repo,
          "--field",
          `version=${job.versionType}`,
        ]);
      } catch (err) {
        throw new Error(`Failed to trigger workflow: ${errorMessage(err)}`);
      }

      await new Promise((r) => setTimeout(r, 3000));
      const runIdResult = await deps.runCommand("gh", [
        "run",
        "list",
        "--repo",
        repo,
        "--workflow",
        "release.yml",
        "--limit",
        "1",
        "--json",
        "databaseId",
        "--jq",
        ".[0].databaseId",
      ]);
      const runId = runIdResult.stdout.trim();
      if (!runId) {
        throw new Error("Could not determine GitHub Actions run ID");
      }

      const runUrl = `https://github.com/${repo}/actions/runs/${runId}`;
      job.runUrl = runUrl;
      broadcastReleaseEvent("create", { type: "runUrl", url: runUrl });
      appendReleaseLog(job, `==> watching run ${runId}`);
      appendReleaseLog(job, `    ${runUrl}`);

      setReleasePhase(job, "watching");
      try {
        await streamProcess(
          "gh",
          ["run", "watch", runId, "--repo", repo],
          { env: { GH_FORCE_TTY: "120" } },
          job
        );
      } catch {
        throw new Error(`GitHub Actions workflow failed. See ${runUrl}`);
      }

      await deps.runCommand("git", [
        "-C",
        authoringRepoDir,
        "fetch",
        "--tags",
        "--quiet",
      ]);
      const tagsResult = await deps.runCommand("git", [
        "-C",
        authoringRepoDir,
        "tag",
        "--sort=-version:refname",
      ]);
      const tag =
        tagsResult.stdout.split("\n").find((t) => t.startsWith("v")) ?? "";
      if (!tag) {
        throw new Error(
          "Could not determine release tag after workflow completed"
        );
      }

      job.tag = tag;
      broadcastReleaseEvent("create", { type: "tag", tag });
      appendReleaseLog(job, `==> release ${tag} created successfully`);
      setReleasePhase(job, "done");
    } catch (err) {
      const error = errorMessage(err);
      if (activeCreateJob) {
        activeCreateJob.error = error;
      }
      setReleasePhase(job, "failed", error);
    }
  }

  function hasActiveUpdateJob(): boolean {
    if (!activeUpdateJob) return false;
    return !deps.isTerminalPhase(activeUpdateJob.phase as AssistedPhase);
  }

  function hasActiveCreateJob(): boolean {
    if (!activeCreateJob) return false;
    return !deps.isTerminalPhase(activeCreateJob.phase as AssistedPhase);
  }

  return {
    RELEASE_VERSION_TYPES,
    getAppVersionInfo,
    getActiveCreateJob: () => activeCreateJob,
    setActiveCreateJob: (job: CreateJob | null) => {
      activeCreateJob = job;
    },
    getActiveUpdateJob: () => activeUpdateJob,
    setActiveUpdateJob: (job: UpdateJob | null) => {
      activeUpdateJob = job;
    },
    hasActiveUpdateJob,
    hasActiveCreateJob,
    getActiveAssistedUpdateLaunch: () => activeAssistedUpdateLaunch,
    setActiveAssistedUpdateLaunch: (active: boolean) => {
      activeAssistedUpdateLaunch = active;
    },
    releaseCreateStreamClients,
    releaseUpdateStreamClients,
    rehydrateActiveAssistedJob,
    dispatchHealthUrl,
    dispatchBaseUrl,
    defaultServiceRestartCommand,
    hasActiveAssistedUpdateAgent,
    buildAssistedUpdatePrompt,
    broadcastReleaseEvent,
    sendReleaseEventToClient,
    appendReleaseLog,
    runUpdateJob,
    runReleaseJob,
    getGitHubRepo,
    checkIsAdmin,
    parseGhJson,
    compareSemver,
    fetchReleaseMetadata,
    fetchGitHubReleases,
    fetchLatestReleaseMetadata: fetchReleaseMetadata,
  };
}
