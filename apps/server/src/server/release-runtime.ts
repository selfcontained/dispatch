import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isMacAppManaged, MAC_APP_UPDATE_MESSAGE } from "../update-owner.js";

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
  getGitHubRepo as getGitHubRepoImpl,
  createCheckIsAdmin,
  fetchReleaseMetadata as fetchReleaseMetadataImpl,
  fixedRuntimePath,
  isReleaseAuthoringEnabled,
  resolveAuthoringRepoDir,
  serviceName,
} from "./release-helpers.js";
import { errorMessage } from "../shared/lib/error-message.js";
import { verifyAndStageRuntime } from "./release-artifact.js";

// Wire types (job, phases, stream events) live in release-wire.ts so the
// web client can import them without pulling in this module's runtime
// dependency graph. Re-exported here for server-side importers.
import {
  RELEASE_VERSION_TYPES,
  isTerminalReleasePhase,
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
  serverDir: string;
  runCommand: RunCommand;
  readReleaseStore: () => Promise<{ tag: string; deployedAt: string } | null>;
  writeReleaseStore: (record: {
    tag: string;
    deployedAt: string;
  }) => Promise<void>;
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
  /** Reject an update before staging if the service manager would kill agent hosts. */
  checkHostSurvival?: () => Promise<void>;
  writeReleaseCandidate?: (candidate: ReleaseCandidate) => Promise<void>;
};

export type CreateJob = Extract<ReleaseJob, { jobType: "create" }>;
export type UpdateJob = Extract<ReleaseJob, { jobType: "update" }>;

function kindOf(job: ReleaseJob): ReleaseJobKind {
  return job.jobType === "create" ? "create" : "update";
}

/** A Linux service restart must leave the host processes in its cgroup alive. */
export async function assertHostSurvivalOnRestart(
  platform: string,
  runCommand: RunCommand
): Promise<void> {
  if (platform !== "linux") return;
  const unit = `${serviceName(platform)}.service`;
  let loaded: string;
  try {
    loaded = (
      await runCommand("systemctl", ["--user", "show", unit, "-p", "KillMode"])
    ).stdout.trim();
  } catch {
    throw new Error(
      `Cannot verify that the Dispatch service preserves agent hosts. Add KillMode=process to ${unit} before updating.`
    );
  }
  if (loaded !== "KillMode=process") {
    throw new Error(
      `Dispatch service restart is unsafe for running agents (${loaded || "KillMode unavailable"}). Load KillMode=process before updating.`
    );
  }
}

export function createReleaseRuntime(deps: CreateReleaseRuntimeDeps) {
  // Release creation (admin "Releases" page) and update application
  // (all-users "Updates" page) are unrelated operations that happen to
  // share a lot of plumbing. Each gets its own active-job slot and its
  // own SSE client set so one can never block, or leak progress into,
  // the other — see the "kind"-scoped broadcast helpers below.
  let activeCreateJob: CreateJob | null = null;
  let activeUpdateJob: UpdateJob | null = null;
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
        spawn("systemctl", ["--user", "restart", serviceName()], {
          detached: true,
          stdio: "ignore",
        }).unref();
        return;
      }
      const uid = process.getuid?.() ?? 501;
      spawn("launchctl", ["kickstart", "-k", `gui/${uid}/${serviceName()}`], {
        detached: true,
        stdio: "ignore",
      }).unref();
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

    // Refuse before replacing the live executable if a restart would kill
    // agent hosts. An injected check replaces the real one outright; `??`
    // would fall through to systemctl whenever a stub returns undefined.
    await (deps.checkHostSurvival
      ? deps.checkHostSurvival()
      : assertHostSurvivalOnRestart(process.platform, deps.runCommand));

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
      if (isMacAppManaged()) throw new Error(MAC_APP_UPDATE_MESSAGE);
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
    return !isTerminalReleasePhase(activeUpdateJob.phase);
  }

  function hasActiveCreateJob(): boolean {
    if (!activeCreateJob) return false;
    return !isTerminalReleasePhase(activeCreateJob.phase);
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
    releaseCreateStreamClients,
    releaseUpdateStreamClients,
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
