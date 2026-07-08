import { spawn } from "node:child_process";
import { readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

import type { Pool } from "pg";

import type { AppConfig } from "../config.js";
import type {
  AssistedPhase,
  AssistedUpdateState,
} from "../assisted-update-store.js";
import type { ReleaseLogStreamProcessor } from "../release-log-stream.js";
import {
  packageVersion,
  releaseNotesMarkdown,
} from "../generated/runtime-assets.js";
import {
  type RunCommand,
  parseGhJson,
  compareSemver,
  currentReleaseBinaryGlob,
  defaultServiceRestartCommand,
  getGitHubRepo as getGitHubRepoImpl,
  checkIsAdmin as checkIsAdminImpl,
  fetchReleaseMetadata as fetchReleaseMetadataImpl,
} from "./release-helpers.js";

export const RELEASE_VERSION_TYPES = ["patch", "minor", "major"] as const;
export type ReleaseVersionType = (typeof RELEASE_VERSION_TYPES)[number];
type CreatePhase = "preflight" | "triggering" | "watching" | "done" | "failed";
type UpdatePhase = "fetching" | "deploying" | "restarting" | "done" | "failed";
type AssistedReleasePhase = AssistedPhase;
type ReleasePhase = CreatePhase | UpdatePhase | AssistedReleasePhase;
export type ReleaseProgress = {
  step: string;
  label: string;
  detail?: string | null;
  bytesReceived?: number | null;
  totalBytes?: number | null;
};

type CommonReleaseJobFields = {
  startedAt: string;
  log: string[];
  runUrl: string | null;
  tag: string | null;
  error: string | null;
  progress: ReleaseProgress | null;
};

export type ReleaseJob =
  | (CommonReleaseJobFields & {
      jobType: "create";
      versionType: ReleaseVersionType;
      phase: CreatePhase;
    })
  | (CommonReleaseJobFields & {
      jobType: "update";
      versionType: null;
      phase: UpdatePhase;
    })
  | (CommonReleaseJobFields & {
      jobType: "update-assisted";
      versionType: null;
      phase: AssistedReleasePhase;
      assisted: AssistedUpdateState;
    });

export type ReleaseStreamEvent =
  | { type: "snapshot"; job: ReleaseJob | null }
  | { type: "log"; line: string }
  | { type: "log.replace"; line: string }
  | { type: "log.rewind"; count: number }
  | { type: "progress"; progress: ReleaseProgress | null }
  | { type: "info-progress"; progress: ReleaseProgress | null }
  | { type: "phase"; phase: ReleasePhase; error?: string }
  | { type: "runUrl"; url: string }
  | { type: "tag"; tag: string }
  | { type: "assisted"; state: AssistedUpdateState };

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
};

export function pruneReleaseBinaries(
  serverDir: string,
  keepTag: string
): number {
  const bunDir = path.join(serverDir, "dist/bun");
  const version = keepTag.replace(/^v/, "");
  let removed = 0;

  try {
    for (const entry of readdirSync(bunDir)) {
      if (!entry.startsWith("dispatch-")) continue;
      if (entry.startsWith(`dispatch-${version}-bun-`)) continue;
      try {
        unlinkSync(path.join(bunDir, entry));
        removed += 1;
      } catch {}
    }
  } catch {}

  return removed;
}

export function createReleaseRuntime(deps: CreateReleaseRuntimeDeps) {
  let activeReleaseJob: ReleaseJob | null = null;
  let activeAssistedUpdateLaunch = false;
  const releaseStreamClients = new Set<ReleaseStreamClient>();
  const getGitHubRepo = () =>
    getGitHubRepoImpl(deps.runCommand, deps.serverDir);
  const checkIsAdmin = () => checkIsAdminImpl(deps.runCommand, deps.serverDir);
  const fetchReleaseMetadata = (tag: string) =>
    fetchReleaseMetadataImpl(deps.runCommand, deps.serverDir, tag);

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

    let gitSha: string | null = null;
    try {
      const gitResult = await deps.runCommand(
        "git",
        ["rev-parse", "--short=12", "HEAD"],
        {
          allowedExitCodes: [0, 128],
          cwd: process.env.DISPATCH_REPO_ROOT ?? process.cwd(),
        }
      );
      if (gitResult.exitCode === 0) {
        gitSha = gitResult.stdout.trim() || null;
      }
    } catch {}

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
    if (activeReleaseJob) return;
    const state = await deps.readAssistedUpdateState().catch(() => null);
    if (!state || deps.isTerminalPhase(state.phase)) return;
    activeReleaseJob = {
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
- Production checkout: ${deps.serverDir}
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
- Do not assume release.json points to a healthy rollback target after a failed deploy; confirm the last healthy tag from git/service history before rolling back.
- Prefer rollback to the last confirmed healthy tag over speculative fixes if the service does not come back.
- Restore service availability before deeper diagnosis.

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

  function broadcastReleaseEvent(event: ReleaseStreamEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of releaseStreamClients) {
      try {
        client.stream.write(payload);
      } catch {
        releaseStreamClients.delete(client);
      }
    }
  }

  function sendReleaseEventToClient(
    clientId: string,
    event: ReleaseStreamEvent
  ): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of releaseStreamClients) {
      if (client.clientId !== clientId) continue;
      try {
        client.stream.write(payload);
      } catch {
        releaseStreamClients.delete(client);
      }
    }
  }

  function appendReleaseLog(job: ReleaseJob, line: string): void {
    job.log.push(line);
    broadcastReleaseEvent({ type: "log", line });
  }

  function replaceReleaseLog(job: ReleaseJob, line: string): void {
    if (job.log.length > 0) {
      job.log[job.log.length - 1] = line;
    } else {
      job.log.push(line);
    }
    broadcastReleaseEvent({ type: "log.replace", line });
  }

  function rewindReleaseLog(job: ReleaseJob, count: number): void {
    const actual = Math.min(count, job.log.length);
    if (actual > 0) {
      job.log.splice(-actual);
      broadcastReleaseEvent({ type: "log.rewind", count: actual });
    }
  }

  function setReleasePhase(
    job: ReleaseJob,
    phase: ReleasePhase,
    error?: string
  ): void {
    job.phase = phase;
    broadcastReleaseEvent({ type: "phase", phase, error });
  }

  function setReleaseProgress(
    job: ReleaseJob,
    progress: ReleaseProgress | null
  ): void {
    job.progress = progress;
    broadcastReleaseEvent({ type: "progress", progress });
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

    appendReleaseLog(job, `==> checking out ${tag} (for version metadata)`);
    setReleaseProgress(job, {
      step: "checking-out-tag",
      label: `Loading ${tag}`,
      detail: "Checking out the target release for validation.",
    });
    await deps.runCommand("git", ["-C", deps.serverDir, "checkout", tag]);

    appendReleaseLog(job, "==> validating artifact contents");
    setReleaseProgress(job, {
      step: "validating-artifact",
      label: "Validating release package",
      detail: "Inspecting the downloaded artifact before extraction.",
    });
    let listing: Awaited<ReturnType<RunCommand>>;
    try {
      listing = await deps.runCommand("tar", ["tzf", cached.path]);
    } catch (err) {
      await deps.unlinkCachedTarball(tag);
      appendReleaseLog(
        job,
        `==> cache entry for ${tag} was corrupt — removed; next attempt will re-download`
      );
      throw err;
    }
    const unsafeEntries = listing.stdout
      .split("\n")
      .filter((entry) => entry.startsWith("/") || entry.includes("../"));
    if (unsafeEntries.length > 0) {
      throw new Error(
        `Release artifact contains unsafe paths: ${unsafeEntries.slice(0, 5).join(", ")}`
      );
    }

    appendReleaseLog(job, "==> extracting pre-built artifact");
    setReleaseProgress(job, {
      step: "extracting-artifact",
      label: "Installing release package",
      detail: "Extracting the pre-built release into the install directory.",
    });
    try {
      await deps.runCommand("tar", [
        "xzf",
        cached.path,
        "--no-same-owner",
        "-C",
        deps.serverDir,
      ]);
    } catch (err) {
      await deps.unlinkCachedTarball(tag);
      appendReleaseLog(
        job,
        `==> extraction failed for ${tag} — removed cache entry; next attempt will re-download`
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
    const globPattern = currentReleaseBinaryGlob();
    const result = await deps.runCommand(
      "bash",
      [
        "-lc",
        `set -euo pipefail; shopt -s nullglob; matches=(${globPattern}); if [ "\${#matches[@]}" -eq 0 ]; then exit 1; fi; printf '%s\n' "\${matches[0]}"`,
      ],
      { cwd: deps.serverDir, allowedExitCodes: [0, 1] }
    );

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw new Error(
        `Expected compiled Bun binary matching ${globPattern} after deploy/build, but none was found`
      );
    }

    appendReleaseLog(
      job,
      `==> verified runtime binary ${result.stdout.trim()}`
    );
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
    setReleaseProgress(job, {
      step: "recording-release",
      label: "Recording deployed version",
      detail: `Saving ${tag} as the active release.`,
    });
    await deps.writeReleaseStore({ tag, deployedAt: new Date().toISOString() });
    appendReleaseLog(job, `==> wrote release record for ${tag}`);
    setReleasePhase(job, "restarting");
    appendReleaseLog(job, "==> restarting service");
    setReleaseProgress(job, {
      step: "restarting-service",
      label: "Restarting Dispatch",
      detail: "Waiting for the service to come back on the new version.",
    });

    if (process.platform === "linux") {
      spawn("systemctl", ["--user", "restart", "dispatch"], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else {
      const uid = process.getuid?.() ?? 501;
      spawn(
        "launchctl",
        ["kickstart", "-k", `gui/${uid}/com.dispatch.server`],
        {
          detached: true,
          stdio: "ignore",
        }
      ).unref();
    }
  }

  async function runUpdateJob(job: ReleaseJob): Promise<void> {
    try {
      const tag = job.tag!;
      setReleasePhase(job, "fetching");
      appendReleaseLog(job, "==> fetching tags from origin");
      setReleaseProgress(job, {
        step: "fetching-tags",
        label: "Fetching release tags",
        detail: "Checking the latest tags from origin before update.",
      });
      await deps.runCommand("git", [
        "-C",
        deps.serverDir,
        "fetch",
        "--tags",
        "--quiet",
      ]);

      try {
        setReleaseProgress(job, {
          step: "resolving-tag",
          label: `Resolving ${tag}`,
          detail: "Confirming the requested tag exists locally.",
        });
        await deps.runCommand("git", [
          "-C",
          deps.serverDir,
          "rev-parse",
          "--verify",
          tag,
        ]);
      } catch {
        throw new Error(`Tag ${tag} not found after fetching`);
      }

      await deployTag(job, tag);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (activeReleaseJob) {
        activeReleaseJob.error = error;
      }
      setReleaseProgress(job, null);
      setReleasePhase(job, "failed", error);
    }
  }

  async function runReleaseJob(job: ReleaseJob): Promise<void> {
    try {
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
        throw new Error(
          `Failed to trigger workflow: ${err instanceof Error ? err.message : String(err)}`
        );
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
      broadcastReleaseEvent({ type: "runUrl", url: runUrl });
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
        deps.serverDir,
        "fetch",
        "--tags",
        "--quiet",
      ]);
      const tagsResult = await deps.runCommand("git", [
        "-C",
        deps.serverDir,
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
      broadcastReleaseEvent({ type: "tag", tag });
      appendReleaseLog(job, `==> release ${tag} created successfully`);
      setReleasePhase(job, "done");
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (activeReleaseJob) {
        activeReleaseJob.error = error;
      }
      setReleasePhase(job, "failed", error);
    }
  }

  function hasActiveUpdateJob(): boolean {
    if (!activeReleaseJob) return false;
    if (
      activeReleaseJob.jobType !== "update" &&
      activeReleaseJob.jobType !== "update-assisted"
    ) {
      return false;
    }
    return !deps.isTerminalPhase(activeReleaseJob.phase as AssistedPhase);
  }

  return {
    RELEASE_VERSION_TYPES,
    getAppVersionInfo,
    getActiveReleaseJob: () => activeReleaseJob,
    hasActiveUpdateJob,
    setActiveReleaseJob: (job: ReleaseJob | null) => {
      activeReleaseJob = job;
    },
    getActiveAssistedUpdateLaunch: () => activeAssistedUpdateLaunch,
    setActiveAssistedUpdateLaunch: (active: boolean) => {
      activeAssistedUpdateLaunch = active;
    },
    releaseStreamClients,
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
    fetchLatestReleaseMetadata: fetchReleaseMetadata,
  };
}
