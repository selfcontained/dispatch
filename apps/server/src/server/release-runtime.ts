import path from "node:path";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import type { Pool } from "pg";

import type { AppConfig } from "../config.js";
import type {
  AssistedPhase,
  AssistedUpdateState,
} from "../assisted-update-store.js";
import type { ReleaseLogStreamProcessor } from "../release-log-stream.js";
import { releaseNotesMarkdown } from "../generated/runtime-assets.js";

type RunCommand = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    allowedExitCodes?: number[];
    timeoutMs?: number;
  }
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export const RELEASE_VERSION_TYPES = ["patch", "minor", "major"] as const;
export type ReleaseVersionType = (typeof RELEASE_VERSION_TYPES)[number];
type CreatePhase = "preflight" | "triggering" | "watching" | "done" | "failed";
type UpdatePhase = "fetching" | "deploying" | "restarting" | "done" | "failed";
type AssistedReleasePhase = AssistedPhase;
type ReleasePhase = CreatePhase | UpdatePhase | AssistedReleasePhase;

type CommonReleaseJobFields = {
  startedAt: string;
  log: string[];
  runUrl: string | null;
  tag: string | null;
  error: string | null;
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
  | { type: "phase"; phase: ReleasePhase; error?: string }
  | { type: "runUrl"; url: string }
  | { type: "tag"; tag: string }
  | { type: "assisted"; state: AssistedUpdateState };

type GitHubReleaseMetadata = {
  tag: string;
  publishedAt: string;
  url: string;
  body?: string | null;
};

type CreateReleaseRuntimeDeps = {
  pool: Pool;
  config: AppConfig;
  serverDir: string;
  appRootDir: string;
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
    onProgress: (input: { message: string }) => void;
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

export function createReleaseRuntime(deps: CreateReleaseRuntimeDeps) {
  let activeReleaseJob: ReleaseJob | null = null;
  let activeAssistedUpdateLaunch = false;
  const releaseStreamClients = new Set<NodeJS.WritableStream>();
  let cachedIsAdmin: boolean | null = null;

  async function getAppVersionInfo(): Promise<{
    releaseTag: string | null;
    version: string | null;
    gitSha: string | null;
    releaseNotes: string | null;
    releaseUrl: string | null;
  }> {
    const record = await deps.readReleaseStore().catch(() => null);

    let version: string | null = null;
    try {
      const packageJson = JSON.parse(
        await readFile(path.join(deps.appRootDir, "package.json"), "utf8")
      ) as { version?: unknown };
      if (
        typeof packageJson.version === "string" &&
        packageJson.version.trim()
      ) {
        version = packageJson.version.trim();
      }
    } catch {}

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

  function defaultServiceRestartCommand(): string {
    return process.platform === "linux"
      ? "systemctl --user restart dispatch"
      : "launchctl kickstart -k gui/$(id -u)/com.dispatch.server";
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
        client.write(payload);
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

  async function getGitHubRepo(): Promise<string> {
    try {
      const result = await deps.runCommand("git", [
        "-C",
        deps.serverDir,
        "remote",
        "get-url",
        "origin",
      ]);
      const url = result.stdout;
      const match = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
      if (match?.[1]) {
        return match[1];
      }
    } catch {}
    return "selfcontained/dispatch";
  }

  async function checkIsAdmin(): Promise<boolean> {
    if (cachedIsAdmin !== null) return cachedIsAdmin;
    try {
      await deps.runCommand("gh", ["--version"]);
      const repo = await getGitHubRepo();
      const result = await deps.runCommand("gh", [
        "repo",
        "view",
        repo,
        "--json",
        "viewerPermission",
        "--jq",
        ".viewerPermission",
      ]);
      cachedIsAdmin = result.stdout.trim() === "ADMIN";
    } catch {
      cachedIsAdmin = false;
    }
    return cachedIsAdmin;
  }

  function parseGhJson<T>(stdout: string): T {
    const trimmed = stdout.trim();
    if (!trimmed) throw new Error("GitHub CLI returned empty output");
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      throw new Error("Failed to parse GitHub CLI output");
    }
  }

  function compareSemver(a: string, b: string): number {
    const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
    const pa = parse(a);
    const pb = parse(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  async function fetchReleaseMetadata(
    tag: string
  ): Promise<GitHubReleaseMetadata | null> {
    try {
      const repo = await getGitHubRepo();
      const result = await deps.runCommand("gh", [
        "release",
        "view",
        tag,
        "--repo",
        repo,
        "--json",
        "tagName,publishedAt,url,body",
      ]);
      const data = JSON.parse(result.stdout) as {
        tagName: string;
        publishedAt: string;
        url: string;
        body?: string | null;
      };
      return {
        tag: data.tagName,
        publishedAt: data.publishedAt,
        url: data.url,
        body: typeof data.body === "string" ? data.body.trim() : null,
      };
    } catch {
      return null;
    }
  }

  async function fetchLatestReleaseMetadata(
    tag: string
  ): Promise<GitHubReleaseMetadata | null> {
    return fetchReleaseMetadata(tag);
  }

  async function deployFromArtifact(
    job: ReleaseJob,
    tag: string
  ): Promise<boolean> {
    let repo: string;
    try {
      repo = await getGitHubRepo();
    } catch {
      appendReleaseLog(
        job,
        "could not resolve GitHub repo, skipping artifact download"
      );
      return false;
    }

    let cached: { path: string };
    try {
      cached = await deps.ensureCachedTarball({
        tag,
        repo,
        onProgress: ({ message }) => appendReleaseLog(job, message),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendReleaseLog(job, `release artifact download failed: ${message}`);
      return false;
    }

    appendReleaseLog(job, `==> checking out ${tag} (for version metadata)`);
    await deps.runCommand("git", ["-C", deps.serverDir, "checkout", tag]);

    appendReleaseLog(job, "==> validating artifact contents");
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
    return true;
  }

  function currentReleaseBinaryGlob(): string {
    const platform =
      process.platform === "darwin"
        ? "darwin"
        : process.platform === "linux"
          ? "linux"
          : null;
    if (!platform) {
      throw new Error(
        `Unsupported platform for Bun release binary: ${process.platform}`
      );
    }

    const arch =
      process.arch === "arm64"
        ? "arm64"
        : process.arch === "x64"
          ? "x64"
          : null;
    if (!arch) {
      throw new Error(
        `Unsupported architecture for Bun release binary: ${process.arch}`
      );
    }

    return `dist/bun/dispatch-*-bun-${platform}-${arch}`;
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

  async function assertCommandOnPath(
    job: ReleaseJob,
    command: string,
    purpose: string
  ): Promise<void> {
    const quotedCommand = `'${command.replace(/'/g, `'\\''`)}'`;
    const result = await deps.runCommand(
      "bash",
      ["-lc", `command -v -- ${quotedCommand} >/dev/null 2>&1`],
      { cwd: deps.serverDir, allowedExitCodes: [0, 1] }
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `${command} is required to ${purpose}, but was not found on PATH`
      );
    }

    appendReleaseLog(job, `==> found ${command} on PATH`);
  }

  async function deployTag(job: ReleaseJob, tag: string): Promise<void> {
    setReleasePhase(job, "deploying");
    appendReleaseLog(job, `==> deploying ${tag}`);

    const usedArtifact = await deployFromArtifact(job, tag);

    if (!usedArtifact) {
      appendReleaseLog(job, "==> falling back to build from source");
      appendReleaseLog(job, `==> checking out ${tag}`);
      await deps.runCommand("git", ["-C", deps.serverDir, "checkout", tag]);
      await assertCommandOnPath(job, "pnpm", "build Dispatch from source");
      appendReleaseLog(job, "==> installing dependencies");
      await streamProcess(
        "pnpm",
        ["install", "--frozen-lockfile"],
        { cwd: deps.serverDir },
        job
      );
      appendReleaseLog(job, "==> building from source");
      await streamProcess(
        "pnpm",
        ["run", "build:bun"],
        { cwd: deps.serverDir },
        job
      );
    }

    await assertCurrentReleaseBinary(job);
    await deps.writeReleaseStore({ tag, deployedAt: new Date().toISOString() });
    appendReleaseLog(job, `==> wrote release record for ${tag}`);
    setReleasePhase(job, "restarting");
    appendReleaseLog(job, "==> restarting service");

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
      await deps.runCommand("git", [
        "-C",
        deps.serverDir,
        "fetch",
        "--tags",
        "--quiet",
      ]);

      try {
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

  return {
    RELEASE_VERSION_TYPES,
    getAppVersionInfo,
    getActiveReleaseJob: () => activeReleaseJob,
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
    appendReleaseLog,
    runUpdateJob,
    runReleaseJob,
    getGitHubRepo,
    checkIsAdmin,
    parseGhJson,
    compareSemver,
    fetchReleaseMetadata,
    fetchLatestReleaseMetadata,
  };
}
